// A CATCH-ALL NAMED BY THE MODEL MUST STILL BE THE BUCKET.
//
// A post the classifier cannot place stays UNASSIGNED — readable in the stream and re-sent
// on every classify. That rule must not hang on one exact string: the prompt asks for a group labelled
// "Everything else", and if both sides recognise the bucket by that name only, then when the
// model calls it "Miscellaneous", the client stores it as a real topic, every post in the batch
// is assigned (and so never re-classified), and `unfiled` goes to 0.
//
// The labels below are the model's OWN catch-all names, HARD-CODED as literals rather than derived
// from the matcher — an assertion routed through the code it checks cannot fail.
// Sources: observed model output and the two captures in
// test/fixtures/group-truncated-tool-reply.json. The three observed names the rule does NOT catch are
// pinned in C3 as the stated limit, so a future widening has to be a decision, not a drift.
//
// WHICH TESTS FAIL WITHOUT THE MATCHER, declared because a merely-red suite hides the one that passed
// for the wrong reason:
//   RED without it   — C1, C1b, C2, C4, C5, C6.
//   GREEN without it — C3, BY DESIGN: it pins that topical names are left alone, which is true
//                      when nothing is matched at all. It exists to red a matcher that
//                      over-reaches.
//
// C2b and C5b pin behaviour that renaming only the first catch-all, or skipping one-post
// catch-alls, would break.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupItems, topicKey } from '../api/_group.js';
import { createGroupHandler } from '../api/group.js';

// The endpoint is signed-in only, so this file presents a confirmed session: these tests are
// about what a signed-in caller's request does, and the gate itself is covered in signed-in-gate.test.mjs.
// The DEFAULT export is
// covered by test/group-default-export.test.mjs.
const handler = createGroupHandler({
  db: () => ({}),
  sessionAccount: async () => ({ accountId: 'acct-test', email: 'test@example.com' }),
});
import { createApp } from '../test-helpers/app-harness.mjs';
import { fakeReq, fakeRes } from '../test-helpers/handler.mjs';

// Hard-coded, not imported: the bucket the client skips is `groupIdFor('Everything else')`
// (app.js), and that is the id these tests are about.
const BUCKET_LABEL = 'Everything else';
const BUCKET_KEY = 'g_everything_else';

const toolUse = groups => ({ content: [{ type: 'tool_use', name: 'emit_groups', input: { groups } }] });
const fakeResponse = body => ({ ok: true, status: 200, json: async () => body });
const posts = n => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, source: 'twitter', text: `post ${i} says a thing` }));
// Positions, not ids: the model sees `String(n)`.
const at = (...ns) => ns.map(String);
const run = (items, groups) => groupItems({ items, apiKey: 'k' }, async () => fakeResponse(toolUse(groups)));
const bucketsOf = res => res.groups.filter(g => topicKey(g.label) === BUCKET_KEY);
const allIds = res => res.groups.flatMap(g => g.item_ids);

// ── C1: every caught real label reaches the bucket ─────────────────────────────

const REAL_CAUGHT = [
  'Miscellaneous',                                      // the live dev row
  'Miscellaneous single reactions',                     // observed
  'Miscellaneous opinions without substantive content', // observed
  'Miscellaneous Reactions & Fragments',                // observed, capture-1
  'Other reactions and low-substance posts',            // observed
  'General Reactions & Context',                        // observed, capture-0
];

for (const label of REAL_CAUGHT) {
  test(`BUG-114 C1: the model's own catch-all "${label}" becomes the bucket`, async () => {
    const res = await run(posts(4), [
      { label: 'AI news', summary: ['a point'], item_ids: at(0, 1) },
      { label, summary: ['a fragment'], item_ids: at(2, 3) },
    ]);
    assert.ok(res, 'the classify succeeded');
    assert.ok(!res.groups.some(g => g.label === label), `no group survives under "${label}"`);
    const buckets = bucketsOf(res);
    assert.equal(buckets.length, 1, 'exactly one bucket');
    assert.equal(buckets[0].label, BUCKET_LABEL, 'labelled with the exact string the client skips');
    assert.deepEqual([...buckets[0].item_ids].sort(), ['x2', 'x3'], 'holding the catch-all posts');
    const ai = res.groups.find(g => g.label === 'AI news');
    assert.deepEqual(ai?.item_ids, ['x0', 'x1'], 'the real topic is untouched');
  });
}

// ── C1b: every word on the list, and the spellings a slug has to survive ─────────

test('BUG-114 C1b: every list word, as the first word, in any case or punctuation, is the bucket', async () => {
  const labels = [
    'Misc.', 'miscellaneous', 'OTHER', 'Others', 'General chatter', 'Assorted posts', 'Various updates',
    'Uncategorised', 'Uncategorized posts', 'Unsorted', 'Leftover posts', 'Leftovers',
    'everything else',
  ];
  for (const label of labels) {
    const res = await run(posts(4), [
      { label: 'AI news', summary: ['a point'], item_ids: at(0, 1) },
      { label, summary: [], item_ids: at(2, 3) },
    ]);
    const buckets = bucketsOf(res);
    assert.equal(buckets.length, 1, `"${label}" → exactly one bucket`);
    assert.deepEqual([...buckets[0].item_ids].sort(), ['x2', 'x3'], `"${label}" → its posts are in the bucket`);
  }
});

// ── C2: one bucket, never two ───────────────────────────────────────────────────

for (const order of ['bucket first', 'catch-all first']) {
  test(`BUG-114 C2: "Everything else" and "Miscellaneous" in one reply make ONE bucket (${order})`, async () => {
    const ee = { label: BUCKET_LABEL, summary: ['x2 says a thing'], item_ids: at(2) };
    const misc = { label: 'Miscellaneous', summary: ['a fragment'], item_ids: at(3, 4) };
    const res = await run(posts(5), [
      { label: 'AI news', summary: ['a point'], item_ids: at(0, 1) },
      ...(order === 'bucket first' ? [ee, misc] : [misc, ee]),
    ]);
    const buckets = bucketsOf(res);
    assert.equal(buckets.length, 1, 'exactly one group keys to the bucket');
    assert.deepEqual([...buckets[0].item_ids].sort(), ['x2', 'x3', 'x4'], 'holding both sets of posts');
    const ids = allIds(res);
    assert.equal(ids.length, 5, 'no post appears twice');
    assert.deepEqual([...new Set(ids)].sort(), ['x0', 'x1', 'x2', 'x3', 'x4'], 'an exact partition of the input');
  });
}

test('BUG-114 C2b: two DIFFERENT catch-alls in one reply both reach the one bucket', async () => {
  const res = await run(posts(6), [
    { label: 'AI news', summary: ['a point'], item_ids: at(0, 1) },
    { label: 'Miscellaneous', summary: ['a fragment'], item_ids: at(2, 3) },
    { label: 'Other stuff', summary: ['another'], item_ids: at(4, 5) },
  ]);
  const buckets = bucketsOf(res);
  assert.equal(buckets.length, 1, 'exactly one bucket');
  assert.deepEqual([...buckets[0].item_ids].sort(), ['x2', 'x3', 'x4', 'x5'], 'holding both catch-alls\' posts');
  assert.ok(!res.groups.some(g => g.label === 'Other stuff'), 'the second catch-all is not left as a topic');
});

// ── C3: topical names are left alone (GREEN before the fix, by design) ─────────────

test('BUG-114 C3: topical names, and the three stated misses, keep their own label', async () => {
  const labels = [
    'Generative AI',                        // "general" as a PREFIX of a word, not the word
    'Otherworldly art',                     // "other" likewise
    'Mixed martial arts',                   // "mixed" deliberately left off the list
    'Random walk theory',                   // "random" deliberately left off the list
    'AI & other news',                      // a list word, but not the FIRST word
    'Bare affirmations and bare agreement', // stated limit
    'Observations & Commentary',            // stated limit (capture-0)
    'Technology & Innovation Notes',        // stated limit (capture-1)
    // THREE words each, so `words.length > 2` passes and only the term under test can reject them. At two
    // words the length check rejects both first, and the fixture pins nothing.
    'Everything Apple announced',           // "everything" alone is not the bucket (C6)
    'Everything elsewhere today',           // nor is "everything" + a word that merely starts "else"
  ];
  for (const label of labels) {
    const res = await run(posts(4), [
      { label: 'AI news', summary: ['a point'], item_ids: at(0, 1) },
      { label, summary: ['a point'], item_ids: at(2, 3) },
    ]);
    const g = res.groups.find(x => x.label === label);
    assert.ok(g, `"${label}" survives as its own topic`);
    assert.deepEqual([...g.item_ids].sort(), ['x2', 'x3'], `"${label}" keeps its posts`);
    assert.equal(bucketsOf(res).length, 0, `"${label}" → no bucket`);
  }
});

// ── C4 / C5: end to end — the real app.js talking to the real handler ─────────────
//
// The harness's `/api/group` is answered by running `api/group.js` itself, so the request body is the
// one app.js built and the response is the one groupItems built. Only Anthropic is faked: `reply`
// receives the batch of ids in the order the client sent them (capItems keeps that order) and
// returns the model's groups, addressing posts by position.

const PUBLISHED = Date.now() - 2 * 86400_000;
const xPost = id => ({
  id, source: 'twitter', text: `post ${id} says something`, published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});
const pos = (batch, ...ids) => ids.map(id => {
  const n = batch.indexOf(id);
  assert.notEqual(n, -1, `the batch sent holds no post '${id}'`);
  return String(n);
});

async function withRealHandler(reply, fn) {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  let batch = null;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => toolUse(reply(batch)) });
  const answer = async (url, init) => {
    if (!String(url).includes('/api/group')) return { ok: true, status: 200, json: async () => ({}) };
    const body = JSON.parse(init.body);
    batch = body.items.map(i => i.id);
    const res = fakeRes();
    await handler(fakeReq({ method: 'POST', body }), res);
    return { ok: true, status: res.statusCode, json: async () => res.body };
  };
  try { return await fn(answer, () => batch); } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
}

const stateOf = app => JSON.parse(app.get('focus_groups') || '{"assignments":{},"groups":{}}');
const render = (app, items) =>
  app.ctx.renderFeedResults({ items, failed: [], cappedNames: [], totalChannels: items.length });
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
const streamIds = app => app.el('feed').children
  .filter(c => c.classList.contains('card') && !c.classList.contains('grouped-out')).map(c => c.dataset.id);
const cardFor = (app, id) => app.el('feed').children.find(c => c.dataset.id === id && !c.classList.contains('grouped-out'));

test('BUG-114 C4: posts the model files under "Miscellaneous" stay unassigned, unfiled, and in the stream', async () => {
  const items = ['x1', 'x2', 'x3', 'x4'].map(xPost);
  await withRealHandler(
    batch => [
      { label: 'AI news', summary: ['a point about AI'], item_ids: pos(batch, 'x1', 'x2') },
      { label: 'Miscellaneous', summary: ['a fragment'], item_ids: pos(batch, 'x3', 'x4') },
    ],
    async (answer, sent) => {
      const app = createApp({ store: { focus_group_view: 'on' } });
      app.setFetch(answer);
      render(app, items);
      await settle();
      assert.ok(sent(), 'guard: the classify ran through the real handler');

      const s = stateOf(app);
      assert.equal(s.assignments.x1, 'g_ai_news', 'guard: the real topic was stored');
      assert.ok(!Object.hasOwn(s.assignments, 'x3'), 'x3 has no assignment');
      assert.ok(!Object.hasOwn(s.assignments, 'x4'), 'x4 has no assignment');
      assert.ok(!Object.hasOwn(s.groups, 'g_miscellaneous'), 'no Miscellaneous topic is stored');
      assert.ok(!Object.hasOwn(s.groups, BUCKET_KEY), 'nor a bucket entry');
      assert.deepEqual([...s.unfiled].sort(), ['x3', 'x4'], 'both are recorded as unfiled');

      // The next render: the unfiled posts are ordinary cards in the stream, not held back.
      render(app, items);
      await settle();
      const stream = streamIds(app);
      for (const id of ['x3', 'x4']) {
        assert.ok(stream.includes(id), `${id} is in the stream`);
        assert.ok(!cardFor(app, id).classList.contains('grouping-pending'), `${id} is not held`);
      }
    },
  );
});

test('BUG-114 C5: an already-stuck Miscellaneous tile is left byte-identical, and new posts do not join it', async () => {
  const STUCK = {
    label: 'Miscellaneous',
    summary: [{ text: 'an old fragment', item_ids: ['m1'] }, { text: 'another', item_ids: ['m2'] }],
  };
  const cached = {
    assignments: { m1: 'g_miscellaneous', m2: 'g_miscellaneous' },
    groups: { g_miscellaneous: STUCK },
    unfiled: [],
    updatedAt: 1753000000000,
  };
  const items = ['m1', 'm2', 'n1', 'n2'].map(xPost);
  await withRealHandler(
    batch => [{ label: 'Miscellaneous', summary: ['new fragment'], item_ids: pos(batch, 'n1', 'n2') }],
    async (answer, sent) => {
      const app = createApp({ store: { focus_groups: JSON.stringify(cached) } });
      app.setFetch(answer);
      await app.ctx.updateGroupsForFeed(items);
      assert.deepEqual(sent(), ['n1', 'n2'], 'guard: only the new posts were classified');

      const s = stateOf(app);
      assert.ok(!Object.hasOwn(s.assignments, 'n1'), 'n1 does not join the stuck tile');
      assert.ok(!Object.hasOwn(s.assignments, 'n2'), 'n2 does not join the stuck tile');
      assert.equal(s.assignments.m1, 'g_miscellaneous', 'm1 keeps its assignment');
      assert.equal(s.assignments.m2, 'g_miscellaneous', 'm2 keeps its assignment');
      assert.equal(JSON.stringify(s.groups.g_miscellaneous), JSON.stringify(STUCK),
        'the stuck tile — label and bullets — is byte-identical');
      assert.deepEqual([...s.unfiled].sort(), ['n1', 'n2'], 'the new posts are recorded as unfiled');
    },
  );
});

test('BUG-114 C5b: on a stuck account, ONE new post the model files under "Miscellaneous" does not join the tile', async () => {
  // The stuck account's everyday case: a refresh brings a handful of posts and the model
  // files one under the existing catch-all. Alone in its group it is a singleton, and `collapseSingletons`
  // SPARES a singleton whose label matches a populated existing topic — so if the rename ever
  // skipped one-post groups, this post would be assigned into the stuck tile: the original bug.
  const STUCK = { label: 'Miscellaneous', summary: [{ text: 'an old fragment', item_ids: ['m1'] }] };
  const cached = {
    assignments: { m1: 'g_miscellaneous', m2: 'g_miscellaneous' },
    groups: { g_miscellaneous: STUCK },
    unfiled: [],
    updatedAt: 1753000000000,
  };
  const items = ['m1', 'm2', 'n1', 'n2', 'n3'].map(xPost);
  await withRealHandler(
    batch => [
      { label: 'AI news', summary: ['a point'], item_ids: pos(batch, 'n1', 'n2') },
      { label: 'Miscellaneous', summary: ['new fragment'], item_ids: pos(batch, 'n3') },
    ],
    async (answer, sent) => {
      const app = createApp({ store: { focus_groups: JSON.stringify(cached) } });
      let body = null;
      app.setFetch(async (url, init) => {
        if (String(url).includes('/api/group')) body = JSON.parse(init.body);
        return answer(url, init);
      });
      await app.ctx.updateGroupsForFeed(items);
      assert.deepEqual(sent(), ['n1', 'n2', 'n3'], 'guard: only the new posts were classified');
      const misc = body.groups.find(g => g.id === 'g_miscellaneous');
      assert.ok(misc && misc.size >= 1, 'guard: the stuck tile went up as a POPULATED topic, so the singleton would be spared');

      const s = stateOf(app);
      assert.equal(s.assignments.n1, 'g_ai_news', 'guard: the real topic was stored');
      assert.ok(!Object.hasOwn(s.assignments, 'n3'), 'n3 does not join the stuck tile');
      assert.equal(JSON.stringify(s.groups.g_miscellaneous), JSON.stringify(STUCK), 'the stuck tile is byte-identical');
      assert.ok(s.unfiled.includes('n3'), 'n3 is recorded as unfiled');
    },
  );
});

// ── C6: "Everything else" with words after it ──────
//
// The model's observed habit is to ELABORATE the name it was given ("Miscellaneous single reactions").
// If only the exact key is recognised, "Everything else — short reactions" becomes an ordinary topic and
// freezes its batch exactly as "Miscellaneous" does.

test('BUG-114 C6: a label that STARTS with "Everything else" is the bucket', async () => {
  for (const label of ['Everything else — short reactions', 'Everything else: fragments', 'everything else (misc)']) {
    const res = await run(posts(4), [
      { label: 'AI news', summary: ['a point'], item_ids: at(0, 1) },
      { label, summary: [], item_ids: at(2, 3) },
    ]);
    assert.ok(!res.groups.some(g => g.label === label), `no group survives under "${label}"`);
    const buckets = bucketsOf(res);
    assert.equal(buckets.length, 1, `"${label}" → exactly one bucket`);
    assert.deepEqual([...buckets[0].item_ids].sort(), ['x2', 'x3'], `"${label}" → its posts are in the bucket`);
  }
});
