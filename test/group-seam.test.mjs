// The client↔server seam for topic `size`.
//
// `size` is PRODUCED in app.js and CONSUMED in api/_group.js, and the only thing joining them is
// `const groups = body?.groups` in api/group.js. A client-only test and a
// server-only test can both pass while the two disagree, which is the failure test/push-intent.test.mjs
// was written about. For example, rewriting that handler line to
// `(body?.groups || []).map(g => ({ id: g.id, label: g.label }))` — the exact shape a future hardening
// pass would take — would leave every other test green while the feature was dead in production.
//
// So this test drives the REAL handler with the REAL browser's request body, and the only fake is
// Anthropic itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';
import { fakeReq, fakeRes } from '../test-helpers/handler.mjs';
import { createGroupHandler } from '../api/group.js';

// The endpoint is signed-in only, so this file presents a confirmed session: these tests are
// about what a signed-in caller's request does, and the gate itself is covered in signed-in-gate.test.mjs.
// The DEFAULT export is
// covered by test/group-default-export.test.mjs.
const handler = createGroupHandler({
  db: () => ({}),
  sessionAccount: async () => ({ accountId: 'acct-test', email: 'test@example.com' }),
});
import { MAX_TOPIC_BULLETS } from '../api/_group.js';

// Lever A: posts reach the model as positional INDICES, never their real ids, so a fake
// reply must answer in the same language. Computed from the batch rather than hard-coded — a
// hand-written index is lever A's own failure mode (a valid index pointing at the wrong post).
const idOf = o => (typeof o === 'string' ? o : o.id);
const idx = (batch, ...ids) => ids.map(id => {
  const n = batch.map(idOf).indexOf(id);
  assert.notEqual(n, -1, `the batch sent holds no post '${id}'`);
  return String(n);
});

const EXISTING = {
  assignments: { a1: 'g_us_politics', a2: 'g_us_politics', a3: 'g_us_politics' },
  groups: { g_us_politics: { label: 'US Politics', summary: ['established'] } },
  updatedAt: 1753000000000,
};
const NEW_POST = { id: 'new1', source: 'twitter', text: 'Senate advances the spending bill' };

// What the model returns: the new post correctly assigned to the existing topic. Alone in its batch,
// so it is a singleton — and only the `size` the client sent can save it from the bucket.
const MODEL_REPLY = {
  content: [{
    type: 'tool_use',
    name: 'emit_groups',
    input: { groups: [{ label: 'US Politics', summary: ['a hearing'], item_ids: idx([NEW_POST], 'new1') }] },
  }],
};

// Capture exactly what app.js puts on the wire — no hand-written body.
async function realClientRequestBody() {
  const app = createApp({ store: { focus_groups: JSON.stringify(EXISTING) } });
  let body = null;
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ groups: null }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  await app.ctx.updateGroupsForFeed([NEW_POST]);
  assert.ok(body, 'the client issued a classify request');
  return body;
}

test("the browser's own request body survives the handler and spares the singleton", async () => {
  const body = await realClientRequestBody();
  // Sanity: this is the real thing, and the topic really is populated.
  assert.equal(body.groups[0].size, 3);

  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => MODEL_REPLY });
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    const res = fakeRes();
    await handler(fakeReq({ method: 'POST', body }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.groups.map(g => g.label), ['US Politics'],
      'the post stays under its topic — the size reached collapseSingletons through the handler');
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
});

// ── The topic's own bullets cross the same seam, and same-label groups fold ──
// The existing bullets are PRODUCED in app.js and CONSUMED in api/_group.js, joined only by
// `const groups = body?.groups`. And the prompt asks the model to reuse existing labels, so one
// response can legitimately hold TWO groups under one — which mergeGroups' loop would collapse onto
// a single id, the second overwriting the first and deleting a bullet about a live post.

const AI_STATE = {
  assignments: { a1: 'g_ai_news', a2: 'g_ai_news' },
  groups: { g_ai_news: { label: 'AI news', summary: ['an established point'] } },
  updatedAt: 1753000000000,
};
const TWO_NEW = [
  { id: 'new1', source: 'twitter', text: 'A new model shipped today' },
  { id: 'new2', source: 'twitter', text: 'A lab raised a round' },
];
const TWO_SAME_LABEL = {
  content: [{
    type: 'tool_use',
    name: 'emit_groups',
    input: {
      groups: [
        { label: 'AI news', summary: ['a model shipped'], item_ids: idx(TWO_NEW, 'new1') },
        { label: 'AI news', summary: ['a lab raised money'], item_ids: idx(TWO_NEW, 'new2') },
      ],
    },
  }],
};

// Boot ANY cached state against a programmable /api/group; return the request body and the cache
// afterwards.
async function bootState(state, reply) {
  const app = createApp({ store: { focus_groups: JSON.stringify(state) } });
  let body = null;
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => reply };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  await app.ctx.updateGroupsForFeed(TWO_NEW);
  assert.ok(body, 'the client issued a classify request');
  return { body, cached: JSON.parse(app.get('focus_groups')) };
}

// The tests below all use the one AI_STATE fixture.
const bootWithReply = reply => bootState(AI_STATE, reply);

// Run the real endpoint against a stubbed Anthropic, capturing what it sent upstream.
async function runRealHandler(body, modelReply) {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  let sentUpstream = null;
  globalThis.fetch = async (_url, init) => {
    sentUpstream = init.body;
    return { ok: true, status: 200, json: async () => modelReply };
  };
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    const res = fakeRes();
    await handler(fakeReq({ method: 'POST', body }), res);
    return { res, sentUpstream };
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
}

// A cached bullet must NOT travel the whole path into the Anthropic request body: that journey is
// exactly what makes the bullet
// deletable. But the FIRST half is deliberately pinned too:
// the browser still sends its bullets, because the server needs them to restore afterwards.
// Only the last hop is withheld. Pinning both halves is what distinguishes "the server withholds them"
// from "the client stopped sending them", which would be a different change with the same symptom.
test("the topic's own bullets are SENT by the browser and withheld from the model", async () => {
  const { body } = await bootWithReply({ groups: null });
  assert.deepEqual(body.groups[0].summary, ['an established point'], 'the browser really sends them');
  const { sentUpstream } = await runRealHandler(body, TWO_SAME_LABEL);
  assert.ok(
    !String(sentUpstream).includes('an established point'),
    'but the bullet stops at api/group.js — it never reaches the Anthropic request body',
  );
  // Read the EXISTING-TOPICS BLOCK, not the raw body. An assertion of the form
  // `String(sentUpstream).includes('AI news')` CANNOT FAIL: `sentUpstream` is the whole
  // serialised request and `SYSTEM_PROMPT` itself contains "AI news" as an example label
  // (`api/_group.js:150`) — with the entire existing-topics block removed,
  // or with the label redacted to `- (redacted)`, it would still pass.
  const block = JSON.parse(sentUpstream).messages[0].content
    .split('Existing topics')[1].split('\n\nposts = ')[0];
  assert.match(block, /^- AI news$/m,
    'the label DOES reach the block, so the model can still assign posts to the topic');
});

test('two groups under one label reach the browser as one topic with BOTH bullets', async () => {
  const { body } = await bootWithReply({ groups: null });
  const { res } = await runRealHandler(body, TWO_SAME_LABEL);
  assert.equal(res.statusCode, 200);
  // Folded server-side, so the client never sees a duplicate label.
  assert.deepEqual(res.body.groups.map(g => g.label), ['AI news'], 'one group, not two');
  // The cached bullet is now restored alongside the model's two, instead of being
  // superseded by them. The fold guard this test exists for is untouched — one group, both new
  // bullets present — and the third entry is the bug's fix showing through the same seam.
  assert.deepEqual(res.body.groups[0].summary, ['a model shipped', 'a lab raised money', 'an established point']);

  // And the browser, fed that real response, caches both bullets under the existing topic.
  const { cached } = await bootWithReply(res.body);
  assert.deepEqual(cached.groups.g_ai_news.summary, ['a model shipped', 'a lab raised money', 'an established point'],
    'NEITHER bullet was dropped on the way into the cache');
  assert.equal(cached.assignments.new1, 'g_ai_news');
  assert.equal(cached.assignments.new2, 'g_ai_news');
});

// ── The two sides disagree on what "same topic" MEANS ──
// If the server matches labels by exact string while the browser's `groupIdFor` (app.js:81) lowercases and
// collapses every non-[a-z0-9] run to `_`, then "AI news" and "AI News" are TWO topics to the server
// and ONE to the browser. An exact-string fold therefore lets both through, both key to g_ai_news,
// and mergeGroups' loop lets the second overwrite the first — deleting a bullet about a post still
// unread in the feed.
//
// It bites hardest when a spared singleton is
// one of the colliders:
//   folded -> the singleton's bullet is parked in "Everything else" and survives
//   spared -> the singleton keeps its label, where the second group overwrites it: GONE
const TWO_CASE_VARIANT_LABELS = {
  content: [{
    type: 'tool_use',
    name: 'emit_groups',
    input: {
      groups: [
        { label: 'AI news', summary: ['a model shipped'], item_ids: idx(TWO_NEW, 'new1') },
        { label: 'AI News', summary: ['a lab raised money'], item_ids: idx(TWO_NEW, 'new2') },
      ],
    },
  }],
};

test('two labels differing only in CASE reach the browser as one topic with BOTH bullets', async () => {
  const { body } = await bootWithReply({ groups: null });
  const { res } = await runRealHandler(body, TWO_CASE_VARIANT_LABELS);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.groups.length, 1, 'folded server-side — the browser never sees the collision');
  // The cached bullet is now restored alongside the model's two, instead of being
  // superseded by them. The fold guard this test exists for is untouched — one group, both new
  // bullets present — and the third entry is the bug's fix showing through the same seam.
  assert.deepEqual(res.body.groups[0].summary, ['a model shipped', 'a lab raised money', 'an established point']);

  // The load-bearing half: fed that real response, the browser keeps both bullets on one tile.
  const { cached } = await bootWithReply(res.body);
  assert.deepEqual(cached.groups.g_ai_news.summary, ['a model shipped', 'a lab raised money', 'an established point'],
    'NEITHER bullet was dropped — this is the bullet main preserves and the branch destroyed');
  assert.equal(cached.assignments.new1, 'g_ai_news');
  assert.equal(cached.assignments.new2, 'g_ai_news');
});

test('a singleton is spared when the model re-cases the existing topic label', async () => {
  // The cached topic is "AI news" (2 unread). ONE new post arrives — so it is genuinely a singleton,
  // the only thing that can save it is the sparing term, and the model answers "AI NEWS". Same tile
  // to the browser, so it must join that topic rather than the bucket. This is the plain
  // "singleton sparing silently does not apply" half of the same mismatch.
  const app = createApp({ store: { focus_groups: JSON.stringify(AI_STATE) } });
  let body = null;
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ groups: null }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  await app.ctx.updateGroupsForFeed([TWO_NEW[0]]);
  assert.equal(body.items.length, 1, 'genuinely a singleton batch — otherwise the fold never applies');

  const recased = {
    content: [{
      type: 'tool_use',
      name: 'emit_groups',
      input: { groups: [{ label: 'AI NEWS', summary: ['a model shipped'], item_ids: idx([TWO_NEW[0]], 'new1') }] },
    }],
  };
  const { res } = await runRealHandler(body, recased);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.groups.map(g => g.label), ['AI NEWS'],
    'the post joined its topic instead of being bucketed');
});

// ── End to end: the browser's cache is where the bullets die ───
//
// The server-only tests in test/group.test.mjs assert what /api/group RETURNS. That is not the
// damage. The damage is `mergeGroups` (app.js:100) writing that response over the cache, replacing a
// topic's whole summary — so the claim "a bullet describing an unread post was destroyed" can only
// be proven by driving the REAL browser, through the REAL handler, and reading the cache after.
//
// app.js still replaces on merge, which is exactly why it has to be exercised: the
// repair is server-side and must survive an unchanged, still-replacing client.

// Three cached topics: one the model will answer for, one it will forget posts into, and one it
// never mentions at all — the last must be left untouched, asserted here
// through the real endpoint rather than against a hand-written response.
const BUCKET_STATE = {
  assignments: {
    a1: 'g_ai_news', a2: 'g_ai_news',
    b1: 'g_everything_else', b2: 'g_everything_else',
    c1: 'g_us_politics', c2: 'g_us_politics',
  },
  groups: {
    g_ai_news: { label: 'AI news', summary: ['an established point'] },
    g_everything_else: { label: 'Everything else', summary: ['a stray thought', 'another stray'] },
    g_us_politics: { label: 'US Politics', summary: ['the spending bill stalled', 'two senators retired'] },
  },
  updatedAt: 1753000000000,
};

// The client stores nothing for the bucket, by design, so there is no
// `cached.assignments.new2 === 'g_everything_else'` to assert.
//
// The protection is SERVER-side — `restoreCachedBullets` putting a topic's cached
// bullets back on a group the model was never shown. So the
// assertion is on the RESPONSE, which is the layer that actually holds it.
//
// There is deliberately no opening assertion that "the browser really sends the bucket bullets up",
// and the reason matters. `updateGroupsForFeed` has exactly ONE call site — inside
// `renderFeedResults`, after `dropCachedBucket` — so a current client can never put a bucket in that
// request. `bootState` calls it directly and skips the sweep, so such an assertion would go on
// passing while describing a state production cannot reach, and would still pass with the
// sweep deleted outright. That is an assertion against its own fixture, the failure this file exists about.
//
// What the browser does send is asserted where it can be asserted honestly — render-driven, in
// `test/group-unfiled.test.mjs` ("the cached bucket is never offered to the model again"). Here the
// legacy body is built EXPLICITLY, because what this test is for is the server's defence of it.
test('BUG-070 end to end: a forgotten id does not blank the bucket bullets in the RESPONSE', async () => {
  const { body } = await bootState(BUCKET_STATE, { groups: null });

  // A request as an OLD client would have sent it: the bucket offered as an existing topic, carrying
  // the bullets only the client has. This is exactly what `restoreCachedBullets` must not blank —
  // and it still arrives from devices that have not picked up the new app.js yet.
  const withBucket = body.groups.find(g => g.id === 'g_everything_else')
    || { id: 'g_everything_else', label: 'Everything else', size: 2 };
  withBucket.summary = ['a stray thought', 'another stray'];
  body.groups = [...body.groups.filter(g => g.id !== 'g_everything_else'), withBucket];

  // The model assigns new1 and simply forgets new2 → validatePartition manufactures the bucket.
  const forgetful = {
    content: [{
      type: 'tool_use',
      name: 'emit_groups',
      input: { groups: [{ label: 'AI news', summary: ['a model shipped'], item_ids: idx(TWO_NEW, 'new1') }] },
    }],
  };
  const { res } = await runRealHandler(body, forgetful);
  assert.equal(res.statusCode, 200);

  const bucket = res.body.groups.find(g => g.label === 'Everything else');
  assert.ok(bucket, 'the server still sweeps the forgotten post into a bucket — TASK-096 changed the client, not this');
  assert.ok(bucket.item_ids.includes('new2'), 'the forgotten post was still swept in');
  assert.deepEqual(bucket.summary, ['a stray thought', 'another stray'],
    "and the topic's cached bullets were restored onto it, not blanked — BUG-070's actual protection");

  // And the browser stores none of it.
  const { cached } = await bootState(BUCKET_STATE, res.body);
  assert.equal(Object.hasOwn(cached.assignments, 'new2'), false,
    'the client keeps no assignment for a bucketed post, so it is re-classified next time');
  // Through the real endpoint: a topic the model never
  // mentioned is not in the response at all, so nothing may touch it.
  assert.deepEqual(cached.groups.g_us_politics.summary,
    ['the spending bill stalled', 'two senators retired'],
    'a topic the model returned no group for is byte-identical');
});

test('BUG-073 end to end: the cache keeps the bullets the model was never shown', async () => {
  const cachedBullets = Array.from({ length: MAX_TOPIC_BULLETS + 4 }, (_, i) => `cached bullet ${i + 1}`);
  const state = {
    assignments: Object.fromEntries(cachedBullets.map((_, i) => [`a${i}`, 'g_ai_news'])),
    groups: { g_ai_news: { label: 'AI news', summary: cachedBullets } },
    updatedAt: 1753000000000,
  };
  const { body } = await bootState(state, { groups: null });
  assert.equal(body.groups[0].summary.length, MAX_TOPIC_BULLETS + 4, 'the browser sends all of them');

  const revision = {
    content: [{
      type: 'tool_use',
      name: 'emit_groups',
      input: { groups: [{ label: 'AI news', summary: ['rev A', 'rev B'], item_ids: idx(TWO_NEW, 'new1', 'new2') }] },
    }],
  };
  const { res, sentUpstream } = await runRealHandler(body, revision);
  // Both directions are asserted, and that matters: a
  // positive assertion is needed
  // to prove `sentUpstream` is not null, so that the negative cannot pass vacuously. No
  // bullet goes up at all, so the bullets cannot serve as that non-vacuity guard —
  // and without one the test passes just as happily against a request that never fired.
  // The LABEL is the thing that still reaches the prompt, so it does the job — but read it
  // out of the BLOCK, not the raw body. `String(sentUpstream).includes('AI news')` does prove
  // non-nullity (a null body stringifies to 'null'), yet it proves that and nothing else:
  // `SYSTEM_PROMPT` carries "AI news" as an example label, so the message it prints is a claim the
  // assertion never checks.
  const block = JSON.parse(sentUpstream).messages[0].content
    .split('Existing topics')[1].split('\n\nposts = ')[0];
  assert.match(block, /^- AI news$/m,
    'the request really went upstream and the block really carried the topic label');
  for (const b of cachedBullets) {
    assert.ok(!String(sentUpstream).includes(b), `the model never saw "${b}"`);
  }

  const { cached } = await bootState(state, res.body);
  assert.deepEqual(cached.groups.g_ai_news.summary,
    ['rev A', 'rev B', ...cachedBullets],
    'EVERY cached bullet survived a client that still replaces the summary wholesale');
});


// ── Indices go upstream, real ids come back ─────────────────────
// The index alias is SERVER-SIDE — the browser's request and the browser's response are unchanged,
// and only the billed Anthropic prompt shrinks. That is a claim about two boundaries at once, so it
// can only be proven where both are real: the browser's own request body, through the real handler,
// with Anthropic the only fake. A mapping bug here files a post under the WRONG topic silently, so
// the downstream half asserts the ids that actually reached the browser's cache.
test('lever A: indices go upstream and the browser gets its own post ids back', async () => {
  const { body } = await bootWithReply({ groups: null });
  const reply = {
    content: [{
      type: 'tool_use',
      name: 'emit_groups',
      input: {
        groups: [{
          label: 'AI news',
          summary: ['a model shipped'],
          item_ids: idx(TWO_NEW, 'new1', 'new2'),
        }],
      },
    }],
  };
  const { res, sentUpstream } = await runRealHandler(body, reply);
  assert.equal(res.statusCode, 200);

  // Upstream: the real ids are gone, replaced by positions.
  assert.ok(!String(sentUpstream).includes('new1'), 'no real post id reached the billed prompt');
  assert.ok(!String(sentUpstream).includes('new2'), 'nor the second one');
  // The USER MESSAGE, not the raw body: the posts array is embedded as a JSON *string*, so its
  // quotes are escaped one level and a substring check against the body never matches. The two
  // negatives above would pass regardless, so this positive control has to actually be one.
  const upstreamMsg = JSON.parse(sentUpstream).messages[0].content;
  assert.ok(upstreamMsg.includes('"id":"0"'), 'the post went up as its position instead');

  // Downstream: the client contract is untouched, and the ids survive into the real cache.
  assert.deepEqual([...res.body.groups[0].item_ids].sort(), ['new1', 'new2'],
    'the alias was reversed before the response left the server');
  const { cached } = await bootState(AI_STATE, res.body);
  assert.equal(cached.assignments.new1, 'g_ai_news', 'and the browser filed it under the right topic');
  assert.equal(cached.assignments.new2, 'g_ai_news');
});
