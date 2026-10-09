// The client↔server seam for BUG-066 (review round 1, H2).
//
// `size` is PRODUCED in app.js and CONSUMED in api/_group.js, and the only thing joining them is
// `const groups = body?.groups` in api/group.js — a line no test touched. A client-only test and a
// server-only test can both pass while the two disagree, which is the failure test/push-intent.test.mjs
// was written about. Proven here rather than assumed: rewriting that handler line to
// `(body?.groups || []).map(g => ({ id: g.id, label: g.label }))` — the exact shape a future hardening
// pass would take — left the whole suite green while the fix was dead in production.
//
// So this test drives the REAL handler with the REAL browser's request body, and the only fake is
// Anthropic itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';
import { fakeReq, fakeRes } from '../test-helpers/handler.mjs';
import { createGroupHandler } from '../api/group.js';

// [BUG-130] made the endpoint signed-in only, so this file presents a confirmed session: these tests are
// about what a signed-in caller's request does, and the gate itself is covered in signed-in-gate.test.mjs.
// Only how the handler is built changed (the import above and this block); no assertion did (Asli,
// 2026-10-07: "yes to all three, go ahead"). The DEFAULT export, which these files used to run, is now
// covered by test/group-default-export.test.mjs (review round 1, H1).
const handler = createGroupHandler({
  db: () => ({}),
  sessionAccount: async () => ({ accountId: 'acct-test', email: 'test@example.com' }),
});
import { MAX_TOPIC_BULLETS } from '../api/_group.js';

// Lever A ([BUG-077]): posts reach the model as positional INDICES, never their real ids, so a fake
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

// ── BUG-067: the topic's own bullets cross the same seam, and same-label groups fold ──
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

// The BUG-066/067/068 tests below all use the one AI_STATE fixture.
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

// REWRITTEN for [BUG-091] (Asli, 2026-08-17). The old assertion was that a cached bullet survives
// the whole path into the Anthropic request body. That journey is exactly what makes the bullet
// deletable, so the requirement is inverted — but the FIRST half is unchanged and deliberately kept:
// the browser still sends its bullets, because the server still needs them to restore afterwards.
// Only the last hop is gone. Pinning both halves is what distinguishes "the server withholds them"
// from "the client stopped sending them", which would be a different change with the same symptom.
test("the topic's own bullets are SENT by the browser and withheld from the model", async () => {
  const { body } = await bootWithReply({ groups: null });
  assert.deepEqual(body.groups[0].summary, ['an established point'], 'the browser really sends them');
  const { sentUpstream } = await runRealHandler(body, TWO_SAME_LABEL);
  assert.ok(
    !String(sentUpstream).includes('an established point'),
    'but the bullet stops at api/group.js — it never reaches the Anthropic request body',
  );
  // Read the EXISTING-TOPICS BLOCK, not the raw body. The first version of this assertion was
  // `String(sentUpstream).includes('AI news')`, which CANNOT FAIL: `sentUpstream` is the whole
  // serialised request and `SYSTEM_PROMPT` itself contains "AI news" as an example label
  // (`api/_group.js:150`). Proved by review, twice — with the entire existing-topics block removed,
  // and with the label redacted to `- (redacted)`, this file still passed 8/0. It was added
  // specifically to stop a vacuous pass and was itself vacuous. (CLAUDE.md §1.)
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
  // [BUG-091]: the cached bullet is now restored alongside the model's two, instead of being
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

// ── BUG-068 (found in BUG-066 review round 2): the two sides disagree on what "same topic" MEANS ──
// The server matched labels by exact string; the browser's `groupIdFor` (app.js:81) lowercases and
// collapses every non-[a-z0-9] run to `_`. So "AI news" and "AI News" are TWO topics to the server
// and ONE to the browser. An exact-string fold therefore lets both through, both key to g_ai_news,
// and mergeGroups' loop lets the second overwrite the first — deleting a bullet about a post still
// unread in the feed.
//
// This is a REGRESSION against main, not merely an unfixed gap, and only when a spared singleton is
// one of the colliders. Measured 2026-08-06, real modules, same fixture, main vs this branch:
//   main   -> the singleton is FOLDED, so its bullet is parked in "Everything else" and survives
//   branch -> the singleton is SPARED under its label, where the second group overwrites it: GONE
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
  // [BUG-091]: the cached bullet is now restored alongside the model's two, instead of being
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
  // "BUG-066 silently does not apply" half of the same mismatch.
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

// ── BUG-070 + BUG-073, end to end: the browser's cache is where the bullets die ───
//
// The server-only tests in test/group.test.mjs assert what /api/group RETURNS. That is not the
// damage. The damage is `mergeGroups` (app.js:100) writing that response over the cache, replacing a
// topic's whole summary — so the claim "a bullet describing an unread post was destroyed" can only
// be proven by driving the REAL browser, through the REAL handler, and reading the cache after.
//
// app.js is deliberately NOT changed by this fix, which is exactly why it has to be exercised: the
// repair is server-side and must survive an unchanged, still-replacing client.

// Three cached topics: one the model will answer for, one it will forget posts into, and one it
// never mentions at all — the last is BUG-067's criterion 12, which until now was only ever asserted
// against a hand-written response and never through the real endpoint.
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

// REWRITTEN for [TASK-096] (requirement change confirmed by Asli in session, 2026-08-16 — see that
// task's review disposition). This test used to assert `cached.assignments.new2 ===
// 'g_everything_else'` — that the browser STORED the sweep. The client no longer stores anything for
// the bucket, by design, so that assertion now states a requirement we deliberately removed.
//
// BUG-070's protection was always SERVER-side — `restoreCachedBullets` putting a topic's cached
// bullets back on a group the model was never shown — and TASK-096 leaves it untouched. So the
// assertion moves onto the RESPONSE, which is the layer that actually holds it.
//
// The old opening assertion ("the browser really sends the bucket bullets up") is GONE rather than
// kept, and the reason matters. `updateGroupsForFeed` has exactly ONE call site — inside
// `renderFeedResults`, after `dropCachedBucket` — so a current client can never put a bucket in that
// request. `bootState` calls it directly and skips the sweep, so the assertion would have gone on
// passing while describing a state production cannot reach, and would have survived deleting the
// sweep outright. That is an assertion against its own fixture, the failure this file exists about.
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

  // [TASK-096]: and the browser stores none of it.
  const { cached } = await bootState(BUCKET_STATE, res.body);
  assert.equal(Object.hasOwn(cached.assignments, 'new2'), false,
    'the client keeps no assignment for a bucketed post, so it is re-classified next time');
  // BUG-067 criterion 12, through the real endpoint for the first time: a topic the model never
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
  // REWRITTEN for [BUG-091]. The both-directions structure is KEPT, and keeping it mattered: the
  // original's positive assertion ("the request carried the bullets inside the bound") existed only
  // to prove `sentUpstream` was not null, so that the negative could not pass vacuously. Under D no
  // bullet goes up at all, so that non-vacuity guard had to be replaced rather than deleted —
  // dropping it would leave a test that passes just as happily against a request that never fired.
  // The LABEL is the thing that still reaches the prompt, so it takes over the job — but read it
  // out of the BLOCK, not the raw body. `String(sentUpstream).includes('AI news')` does prove
  // non-nullity (a null body stringifies to 'null'), yet it proves that and nothing else:
  // `SYSTEM_PROMPT` carries "AI news" as an example label, so the message it prints is a claim the
  // assertion never checks. The sibling assertion in this file was vacuous for exactly that reason.
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


// ── BUG-077 lever A: indices go upstream, real ids come back ─────────────────────
// The lever is a SERVER-SIDE alias — the browser's request and the browser's response are unchanged,
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
