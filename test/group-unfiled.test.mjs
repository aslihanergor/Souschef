// LEFTOVERS ARE LEFT UNASSIGNED. The server still mints an "Everything else" group —
// denying the model a named sink makes it invent unstable substitutes — but the
// CLIENT stores nothing for it: no assignment, no `state.groups` entry, no tile, and no mention in
// the next classify's existing-topics block.
//
// These drive the REAL `mergeGroups` / `updateGroupsForFeed` / `renderFeedResults` through the
// app-harness: "is this card in the stream", "is it held
// hidden" and "did this post reach a billed API call" are routing decisions, not appearance.
//
// The observables, chosen deliberately:
//
//   • the stored `focus_groups` blob      — assignments, groups, and the sticky record
//   • the CAPTURED request body           — what the next billed call was actually offered
//   • `el('feed').children` + `dataset.id`— which cards the render put in the stream
//   • `grouping-pending`                  — whether a card was held back
//
// The harness's selector model answers `querySelectorAll('#feed .card')` from the tracked tree and `remove()`
// detaches, so the badge is real and `liftGroupedFromStream` / `revealPendingText` are directly
// assertable (see test/harness-dom.test.mjs). These tests assert through a SECOND
// render, which is a different and still-valid route to the same user-visible outcome — not because
// the direct one is impossible.
//
// Bucket identity comes from the server's own `EVERYTHING_ELSE` + `topicKey`, so a test cannot pass
// by agreeing with a copy of the label that has drifted from the one the server sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';
import { topicKey, EVERYTHING_ELSE } from '../api/_group.js';

// A post's publish time. RELATIVE to now, not an absolute constant:
// every post a live feed returns is inside `WINDOW_DAYS` by the server's clock, and the prune now
// treats an in-hand post older than that window as evidence the DEVICE's clock is wrong. A frozen
// 2025 timestamp made every fixture look like a broken clock — and would have drifted a suite that
// once passed into one that asserts the opposite, silently, as months went by.
const PUBLISHED = Date.now() - 2 * 86400_000;
const BUCKET_KEY = topicKey(EVERYTHING_ELSE); // 'g_everything_else'

const xPost = (id, text = `post ${id} says something`) => ({
  id, source: 'twitter', text, published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});
const ytPost = (id = 'v1') => ({
  id, videoId: id, source: 'youtube', title: 'A video', published: PUBLISHED,
  channel: { id: 'c3', name: 'A channel', source: 'youtube' },
});

// One post the model files under a real topic, one it dumps in the bucket. Sized so only the guard
// under test can fire: exactly one bucketed post, exactly one themed post, no singletons.
const FILED = { label: 'AI news', summary: ['a point about AI'], item_ids: ['x1'] };
const bucketed = (ids, label = EVERYTHING_ELSE) => ({ label, summary: ['x2 says a thing'], item_ids: ids });
const REPLY = [FILED, bucketed(['x2'])];

/**
 * Boot the app with a programmable /api/group.
 * `reply` is either the groups array, or (callNumber) => groups — so a test can make the SECOND
 * classify answer differently from the first, which is how the re-file cases are driven.
 */
// GROUPED VIEW SEEDED. Ungrouped is now the DEFAULT: every post renders into the
// chronological stream and an assigned one is merely HIDDEN, so a fixture with no view key exercises
// the plain feed — where tiles, the lift and the classify hold do not exist at all. This file's
// subject is what happens INSIDE the grouped view, which is unchanged, so only the precondition had
// to be stated. No assertion in this file was altered.
function boot({ store = {}, reply = REPLY } = {}) {
  const app = createApp({ store: { focus_group_view: 'on', ...store } });
  const bodies = [];
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      bodies.push(JSON.parse(init.body));
      const groups = typeof reply === 'function' ? reply(bodies.length) : reply;
      return { ok: true, status: 200, json: async () => ({ groups, capped: false }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return { app, bodies };
}

const stateOf = app => JSON.parse(app.get('focus_groups') || '{"assignments":{},"groups":{}}');
const render = (app, items, failed = []) =>
  app.ctx.renderFeedResults({ items, failed, cappedNames: [], totalChannels: items.length + failed.length });
// "In the stream" means VISIBLE in the stream (the lift
// HIDES rather than removes). A lifted card is still a `#feed` child carrying `.grouped-out`
// (display:none), so a raw `children` read reports a post the reader cannot see as present — the same
// mistake a production counting selector could make.
// `.card` is REQUIRED rather than implied. A `.topic-card` is
// also a child of `#feed`, and it carries `data-gid` rather than `data-id` — so an un-narrowed
// map over `children` reports `undefined` in the middle of the stream. The QUESTION is: which posts are here.
const streamIds = app => app.el('feed').children
  .filter(c => c.classList.contains('card') && !c.classList.contains('grouped-out')).map(c => c.dataset.id);
const cardFor = (app, id) => app.el('feed').children.find(c => c.dataset.id === id && !c.classList.contains('grouped-out'));
// renderFeedResults fires the classify without awaiting it, so a render-driven test has to let the
// microtask chain drain. Every such test also asserts the classify RAN, so a settle that was too
// short fails loudly instead of passing as "nothing was stored".
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };

// ── Criterion 1: the bucketed post is stored with no assignment ─────────────────

test('TASK-096 C1: a post the server bucketed is stored with NO assignment', async () => {
  const { app, bodies } = boot();
  await app.ctx.updateGroupsForFeed([xPost('x1'), xPost('x2')]);

  assert.equal(bodies.length, 1, 'the classify actually reached /api/group');
  const after = stateOf(app);
  assert.equal(after.assignments.x1, 'g_ai_news', 'the themed post is still filed');
  assert.equal(Object.hasOwn(after.assignments, 'x2'), false,
    'the bucketed post is left unassigned — that stored assignment is the whole of this task');
});

// ── Criterion 5: it reaches neither stored state, nor the grid, nor a later prompt ──

test('TASK-096 C5: the bucket gets no state.groups entry of its own', async () => {
  const { app } = boot();
  await app.ctx.updateGroupsForFeed([xPost('x1'), xPost('x2')]);

  const after = stateOf(app);
  assert.deepEqual(Object.keys(after.groups).sort(), ['g_ai_news'],
    'only the real topic is cached');
  assert.equal(Object.hasOwn(after.groups, BUCKET_KEY), false,
    'the group itself is skipped, not merely its assignments');
});

test('TASK-096 C5: no bucket tile is painted', async () => {
  const { app } = boot();
  await app.ctx.updateGroupsForFeed([xPost('x1'), xPost('x2')]);
  app.ctx.renderTopicCards();

  // Topics are cards in the stream, not tiles in a grid.
  const labels = app.queryAll('#feed .topic-card').map(c => c.dataset.gid);
  assert.ok(labels.includes('g_ai_news'), 'the real topic still gets a tile');
  assert.equal(labels.includes(BUCKET_KEY), false, 'no "Everything else" tile');
});

test('TASK-096 C5: the NEXT classify is not offered the bucket as an existing topic', async () => {
  const { app, bodies } = boot();
  const items = [xPost('x1'), xPost('x2')];
  await app.ctx.updateGroupsForFeed(items);
  await app.ctx.updateGroupsForFeed(items);

  // Reachability first, and it is not boilerplate: today the bucketed post carries an assignment, so
  // `updateGroupsForFeed` finds nothing new and never makes a second call — which is why this test
  // reds here before it reds on the leak. The leak assertion below only becomes reachable once C2
  // holds; it has to bite on its own (skip the assignments, keep the
  // group entry) rather than riding C2's failure.
  assert.equal(bodies.length, 2,
    'a second classify ran at all — a frozen post gives the model nothing to reconsider');
  const existing = bodies[1].groups;
  assert.ok(existing.some(g => g.label === 'AI news'), 'a real topic is still offered to the model');
  assert.equal(existing.some(g => topicKey(g.label) === BUCKET_KEY), false,
    'the bucket is never forwarded back as an existing topic — the leak that would quietly undo this task');
});

// ── Criterion 2: the unfiled post gets another chance, every classify ───────────

test('TASK-096 C2: the unfiled post is re-sent on the next classify; the filed one is not', async () => {
  const { app, bodies } = boot();
  const items = [xPost('x1'), xPost('x2')];
  await app.ctx.updateGroupsForFeed(items);
  await app.ctx.updateGroupsForFeed(items);

  assert.equal(bodies.length, 2,
    'a second classify ran at all — today the bucketed post is assigned, so nothing is left to send and this is the defect itself');
  assert.deepEqual(bodies[0].items.map(i => i.id).sort(), ['x1', 'x2'], 'both were new the first time');
  assert.deepEqual(bodies[1].items.map(i => i.id), ['x2'],
    'the post the model could not place is offered again; the one it filed is not re-sent');
});

// ── Criterion 6: bucket identity is the topicKey, never the raw label ───────────

for (const label of ['everything else', 'Everything Else', 'EVERYTHING ELSE']) {
  test(`TASK-096 C6: a bucket labelled "${label}" is skipped too`, async () => {
    const { app } = boot({ reply: [FILED, bucketed(['x2'], label)] });
    await app.ctx.updateGroupsForFeed([xPost('x1'), xPost('x2')]);

    const after = stateOf(app);
    assert.equal(Object.hasOwn(after.assignments, 'x2'), false,
      're-casing the label does not smuggle an assignment past the skip');
    assert.deepEqual(Object.keys(after.groups).sort(), ['g_ai_news'],
      're-casing the label does not smuggle a group entry past the skip');
  });
}

// ── Criterion 4: real topics are untouched ─────────────────────────────────────

test('TASK-096 C4: a themed topic still files its post, caches its bullets, and lifts it out of the stream', async () => {
  const { app, bodies } = boot();
  const items = [xPost('x1'), xPost('x2')];

  render(app, items);
  await settle();
  assert.equal(bodies.length, 1, 'the render fired a classify');

  const after = stateOf(app);
  assert.equal(after.assignments.x1, 'g_ai_news', 'the filed post keeps its assignment');
  assert.deepEqual(after.groups.g_ai_news.summary, ['a point about AI'],
    "the topic's bullets still cache");

  // The lift, by the route the harness can see: the NEXT render reads stored assignments and keeps
  // an already-filed groupable post out of the chronological stream.
  render(app, items);
  const ids = streamIds(app);
  assert.equal(ids.includes('x1'), false, 'the filed post lives in the grid, not the stream');
  assert.ok(ids.includes('x2'), 'the unfiled post is still in the stream');
});

// ── Criterion 3: the unfiled post stays readable in the chronological feed ──────

// NOTE ON WHAT THIS MEASURES: `renderFeedResults` does not sort — ordering is `loadFeed`'s job — and
// every fixture post here shares one `published`. So this asserts the render preserves the order it
// was handed and drops the right cards from it; it does NOT verify a chronological slot. Said plainly
// because the earlier name for this test claimed the latter, which is green, correct, and a different
// quantity from the one it named.
test('TASK-096 C3: the bucketed post stays in the stream, in the order the render was handed', async () => {
  const { app, bodies } = boot();
  const items = [xPost('x1'), xPost('x2'), ytPost('v1')];

  render(app, items);
  await settle();
  assert.equal(bodies.length, 1, 'the render fired a classify');

  render(app, items);
  assert.deepEqual(streamIds(app), ['x2', 'v1'],
    'the leftover reads in the stream alongside the YouTube post — not stranded in a tile');
});

// ── Criterion 7: a post already through a classify is not held hidden ───────────

test('TASK-096 C7: a sticky post renders immediately while a genuinely-new one is still held', () => {
  // x2 has already been through a classify and came back unplaceable; x9 has never been seen.
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify({
        assignments: {}, groups: {}, unfiled: ['x2'], updatedAt: PUBLISHED,
      }),
    },
  });

  render(app, [xPost('x2'), xPost('x9')]);

  const sticky = cardFor(app, 'x2');
  const fresh = cardFor(app, 'x9');
  assert.ok(sticky && fresh, 'both posts have cards in the stream');
  assert.equal(sticky.classList.contains('grouping-pending'), false,
    'a post that has already been through a classify is readable at once — it is not hidden again on every load');
  assert.equal(fresh.classList.contains('grouping-pending'), true,
    'a genuinely-new post is still held, which is what TASK-073 built the hold for');
});

// ── Criterion 8: the sticky record is recomputed and pruned ─────────────────────

test('TASK-096 C8: a classify records which posts it could not file', async () => {
  const { app } = boot();
  await app.ctx.updateGroupsForFeed([xPost('x1'), xPost('x2')]);

  const after = stateOf(app);
  assert.deepEqual(after.unfiled, ['x2'], 'the post that came back unplaceable is recorded');
  assert.equal((after.unfiled || []).includes('x1'), false, 'the filed post is not');
});

test('TASK-096 C8: a post the model later places leaves the sticky record', async () => {
  // First classify buckets x2; the second finds it a home.
  const { app } = boot({
    reply: n => (n === 1 ? REPLY : [{ label: 'AI news', summary: ['a point about AI'], item_ids: ['x1', 'x2'] }]),
  });
  const items = [xPost('x1'), xPost('x2')];
  await app.ctx.updateGroupsForFeed(items);
  await app.ctx.updateGroupsForFeed(items);

  const after = stateOf(app);
  assert.equal(after.assignments.x2, 'g_ai_news', 'the second classify placed it');
  assert.equal((after.unfiled || []).includes('x2'), false,
    'the record is recomputed each classify, so a placed post drops out of it');
});

test('TASK-096 C8: a sticky post that leaves the feed is pruned from the record', () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify({ assignments: {}, groups: {}, unfiled: ['x2'], updatedAt: PUBLISHED }),
    },
  });

  // A clean load whose feed no longer carries x2 — it aged out of the lookback window.
  render(app, [ytPost('v1')], []);

  assert.deepEqual(stateOf(app).unfiled, [],
    'the record cannot outlive its posts — it is pruned with assignments');
});

// ── C8 on the path that is NOT a clean load ───────────────────────────
// `syncGroupPrune`'s `unfiled` pass is gated on a complete load,
// but `updateGroupsForFeed` is not — so on a
// feed with one permanently-dead channel (a deleted YouTube channel, or X 502ing at the plan's post
// cap, which is routine) every load classifies and nothing ever prunes. A record that
// only carries forward is then monotonic and unbounded, on a SYNCED key: row-size pressure on
// the one record whose entire justification is that it stays small.
//
// Every other C8 test uses `failed = []`, the one condition under which the prune fires at all —
// fixtures sized so only the happy path can run.

test('TASK-096 C8: the record holds only posts still in the feed, even when a channel failed', async () => {
  const { app, bodies } = boot({
    store: {
      focus_groups: JSON.stringify({
        assignments: {}, groups: {}, unfiled: ['gone1', 'gone2'], updatedAt: PUBLISHED, v: 2,
      }),
    },
    reply: [bucketed(['x9'])],
  });

  render(app, [xPost('x9'), ytPost('v1')], ['a channel that failed to fetch']);
  await settle();

  assert.equal(bodies.length, 1, 'the classify ran despite the failed channel — that is the point');
  assert.deepEqual(stateOf(app).unfiled, ['x9'],
    'ids for posts no longer in the feed do not ride forward; the record stays bounded by the feed');
});

test('TASK-096 sweep: it seeds only swept posts that are actually in the feed', async () => {
  // A YouTube-only feed, so no classify runs and the sweep is the only writer; and a failed channel,
  // so the liveness prune cannot clean up after it either. What the sweep seeds is what is left.
  const { app, bodies } = boot({
    store: {
      focus_groups: JSON.stringify({
        assignments: { xOld: 'g_everything_else' },
        groups: { g_everything_else: { label: 'Everything else', summary: ['a stray thought'] } },
        unfiled: [], updatedAt: PUBLISHED, v: 2,
      }),
    },
  });

  render(app, [ytPost('v1')], ['a channel that failed to fetch']);
  await settle();

  assert.deepEqual(bodies, [], 'no classify ran, so nothing else could have written the record');
  assert.deepEqual(stateOf(app).unfiled, [],
    'a bucket member that has aged out of the feed is retired, not promoted into the record');
});

// ── A capped batch: posts the server never actually looked at ──────────────────
// `capBatch` (api/_group.js) keeps a PREFIX and flags `capped`, so on a backlog over MAX_ITEMS the
// tail is never shown to the model. Those posts come back in no group — indistinguishable, from the
// stored state alone, from a post the model considered and could not place. Recording them as
// unfiled would render them unheld on the next load and then yank them into a topic when a later
// classify finally reaches them: a visible flash, for exactly the posts that never
// had their turn.

test('TASK-096: a post the server never processed is not recorded as unplaceable', async () => {
  // The reply accounts for x1 and x2 and says nothing about x3 — the shape of a truncated batch.
  const { app } = boot({ reply: [FILED, bucketed(['x2'])] });
  await app.ctx.updateGroupsForFeed([xPost('x1'), xPost('x2'), xPost('x3')]);

  const after = stateOf(app);
  assert.deepEqual(after.unfiled, ['x2'],
    'only the post the model actually returned a verdict on is recorded');
});

test('TASK-096: a post the server never processed is still held on the next render', async () => {
  const { app } = boot({ reply: [FILED, bucketed(['x2'])] });
  const items = [xPost('x1'), xPost('x2'), xPost('x3')];
  await app.ctx.updateGroupsForFeed(items);

  render(app, items);
  assert.equal(cardFor(app, 'x2').classList.contains('grouping-pending'), false,
    'the genuinely-unplaceable post is readable at once');
  assert.equal(cardFor(app, 'x3').classList.contains('grouping-pending'), true,
    'the never-examined post keeps its hold — it has not had its turn yet');
});

// ── The cache an existing user is already holding ──────────────────────────────
// Skipping the bucket at merge time only governs cache written from NOW on. Every user upgrading
// into this change already has `g_everything_else` in `state.groups` with live assignments behind
// it, and `pruneGroupState` only drops a group once nothing is assigned to it — so without a sweep
// the tile keeps painting, its posts stay lifted out of the stream and un-reclassified, and
// `updateGroupsForFeed` keeps forwarding the bucket into the prompt as an existing topic, for up to
// the full 14-day lookback — the bucket leaking back into the prompt on a real device on day one.
//
// Not hypothetical: with only the merge-time skip in place, a browser booted in exactly this state
// still sends the bucket bullets up.
// The sweep is what closes it.
const LEGACY_BUCKET_STATE = {
  assignments: { x1: 'g_ai_news', x2: 'g_everything_else', x3: 'g_everything_else' },
  groups: {
    g_ai_news: { label: 'AI news', summary: ['an established point'] },
    g_everything_else: { label: 'Everything else', summary: ['x2 says a thing', 'x3 says another'] },
  },
  unfiled: [],
  updatedAt: PUBLISHED,
  v: 2,
};
const legacyItems = () => [xPost('x1'), xPost('x2'), xPost('x3')];

test('TASK-096 sweep: a bucket cached before this change is dropped from stored state', async () => {
  // A FAILED load. The ASSIGNMENT prune runs anyway — only the `unfiled` pass is
  // gated — so this fixture cannot isolate the sweep by switching the prune off. It isolates
  // it by leaving nothing for the prune to collect. On a complete load `pruneGroupState` collects
  // any group left with no members, so it would drop the bucket even if the sweep never touched
  // `state.groups` — two guards over one input, pinning neither.
  const { app } = boot({ store: { focus_groups: JSON.stringify(LEGACY_BUCKET_STATE) } });
  render(app, legacyItems(), ['a channel that failed to fetch']);
  await settle();

  const after = stateOf(app);
  assert.equal(Object.hasOwn(after.groups, BUCKET_KEY), false,
    'the stale bucket group is gone, not left to age out over 14 days');
  assert.equal(Object.hasOwn(after.assignments, 'x2'), false, 'its members are unassigned…');
  assert.equal(Object.hasOwn(after.assignments, 'x3'), false, '…all of them');
});

test('TASK-096 sweep: the swept posts return to the chronological stream, unheld', async () => {
  const { app } = boot({ store: { focus_groups: JSON.stringify(LEGACY_BUCKET_STATE) } });
  render(app, legacyItems());
  await settle();

  render(app, legacyItems());
  const ids = streamIds(app);
  assert.ok(ids.includes('x2') && ids.includes('x3'), 'both are readable in the feed again');
  assert.equal(ids.includes('x1'), false, 'the real topic still holds its post out of the stream');

  // They have already been through a classify — that is how they got bucketed — so the hold does
  // not apply to them. Without this they would blink out of a fifth of the feed on the upgrade load.
  for (const id of ['x2', 'x3']) {
    assert.equal(cardFor(app, id).classList.contains('grouping-pending'), false,
      `${id} is not held hidden: it was classified once already`);
  }
});

test('TASK-096 sweep: the cached bucket is never offered to the model again', async () => {
  const { app, bodies } = boot({ store: { focus_groups: JSON.stringify(LEGACY_BUCKET_STATE) } });
  render(app, legacyItems());
  await settle();

  assert.ok(bodies.length >= 1, 'a classify ran');
  const first = bodies[0];
  assert.equal(first.groups.some(g => topicKey(g.label) === BUCKET_KEY), false,
    'the stale bucket is not forwarded as an existing topic — the leak, arriving from cache');
  assert.ok(first.groups.some(g => g.label === 'AI news'), 'the real topic is still offered');
  assert.deepEqual(first.items.map(i => i.id).sort(), ['x2', 'x3'],
    'and the freed posts get the re-classify they have been denied since the day they were bucketed');
});

test('TASK-096 sweep: a real topic is untouched by it', async () => {
  // The classify DEGRADES here (`groups: null`), so nothing merges and the sweep is the only thing
  // that can have altered this state. With a successful reply the model's fresh bullets would
  // legitimately replace the cached ones, and this assertion would be measuring that
  // merge rather than the sweep — green, and about a different quantity.
  const { app } = boot({ store: { focus_groups: JSON.stringify(LEGACY_BUCKET_STATE) }, reply: null });
  render(app, legacyItems());
  await settle();

  const after = stateOf(app);
  assert.equal(after.assignments.x1, 'g_ai_news', 'its assignment survives');
  assert.deepEqual(after.groups.g_ai_news.summary, ['an established point'],
    'and its bullets are byte-identical — the sweep removes one group, not a cache');
});

test('TASK-096 sweep: an EMPTY cached bucket group is dropped too', () => {
  // The bucket entry with nothing assigned to it. Pins the second term of the sweep's guard: without
  // it the group survives, `updateGroupsForFeed` builds its existing-topics block from
  // `Object.entries(state.groups)`, and the label is offered back to the model with size 0 — the
  // same leak, just with an empty bucket.
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify({
        assignments: { x1: 'g_ai_news' },
        groups: {
          g_ai_news: { label: 'AI news', summary: ['an established point'] },
          g_everything_else: { label: 'Everything else', summary: ['a stray thought'] },
        },
        unfiled: [], updatedAt: PUBLISHED, v: 2,
      }),
    },
  });

  // A FAILED load, so `syncGroupPrune` is gated off and the sweep is the only thing that can drop
  // this group. On a clean load the prune collects any memberless group anyway, so a complete-load
  // fixture would pass whether or not the sweep handled this case at all — two guards over one
  // input, pinning neither. The failed load is also where it genuinely bites: the prune is skipped,
  // so without the sweep the label is offered to the model on exactly the loads nothing cleans up.
  render(app, [xPost('x1')], ['a channel that failed to fetch']);

  const after = stateOf(app);
  assert.equal(Object.hasOwn(after.groups, BUCKET_KEY), false, 'the empty bucket is dropped');
  assert.ok(Object.hasOwn(after.groups, 'g_ai_news'), 'the real topic is kept');
});

test('TASK-096 sweep: the swept posts are not held hidden on the upgrade load ITSELF', () => {
  // Asserted BEFORE the classify resolves — deliberately no `settle()`. That classify recomputes
  // `unfiled` from its own result, so a version of the sweep that seeds nothing looks identical a
  // few hundred milliseconds later. The seed exists for precisely this moment: the first paint after
  // the upgrade, where without it a fifth to a third of the backlog is hidden for the 4.4-10.3s the
  // classify takes, while the badge above it still counts every one of those cards.
  const { app } = boot({ store: { focus_groups: JSON.stringify(LEGACY_BUCKET_STATE) } });

  render(app, legacyItems());

  for (const id of ['x2', 'x3']) {
    assert.equal(cardFor(app, id).classList.contains('grouping-pending'), false,
      `${id} is readable the instant the upgrade load paints — it was classified long ago`);
  }
});

test('TASK-096 sweep: bucket assignments whose group entry is already gone are swept too', () => {
  // The half-state the sweep's second predicate term exists for: assignments pointing at a bucket
  // that is no longer in `state.groups`. Without that term the function returns early and those
  // posts stay filed under a topic that does not exist — invisible in the grid, and never
  // re-classified. Constructed directly, because no ordinary sequence produces it; that is what a
  // defensive term is for, and it is cheaper to pin than to argue about.
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify({
        assignments: { x2: 'g_everything_else' },
        groups: {}, unfiled: [], updatedAt: PUBLISHED, v: 2,
      }),
    },
  });

  render(app, [xPost('x2')], ['a channel that failed to fetch']);

  assert.equal(Object.hasOwn(stateOf(app).assignments, 'x2'), false,
    'the orphaned assignment is cleared, so the post returns to the stream and is re-classified');
});

test('TASK-096: an id that is both recorded and bucket-assigned appears once, not twice', () => {
  // A mixed-version fleet reaches this: a new device records `x2` as unfiled, an old device still
  // holding the bucket re-files it, and the row carries both. Without the dedupe the record grows a
  // duplicate on every such round.
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify({
        assignments: { x2: 'g_everything_else' },
        groups: { g_everything_else: { label: 'Everything else', summary: [] } },
        unfiled: ['x2'], updatedAt: PUBLISHED, v: 2,
      }),
    },
  });

  render(app, [xPost('x2')], ['a channel that failed to fetch']);

  assert.deepEqual(stateOf(app).unfiled, ['x2'], 'recorded once');
});

test('TASK-096 sweep: it still runs when the feed comes back empty', () => {
  // The caught-up branch returns before most of the render. A user whose feed is empty on the load
  // after upgrading would otherwise keep the stale bucket — and keep offering it to the model —
  // until some later load happens to have posts in it.
  const { app } = boot({ store: { focus_groups: JSON.stringify(LEGACY_BUCKET_STATE) } });

  render(app, [], []);

  assert.equal(Object.hasOwn(stateOf(app).groups, BUCKET_KEY), false,
    'the bucket is retired on a caught-up load too, not left waiting for a load with posts');
});

test('TASK-096 sweep: a total fetch failure does NOT sweep', () => {
  // The one render path where nothing is in hand: every channel failed. Deleting a bucket's
  // assignments here would be a write made on no evidence — the same reason syncGroupPrune is gated
  // on a complete load. It self-heals on the next load that actually returns something.
  const { app } = boot({ store: { focus_groups: JSON.stringify(LEGACY_BUCKET_STATE) } });

  app.ctx.renderFeedResults({ items: [], failed: ['c1', 'c2'], cappedNames: [], totalChannels: 2 });

  assert.ok(Object.hasOwn(stateOf(app).groups, BUCKET_KEY),
    'nothing is destroyed on a load that fetched nothing');
});

test('TASK-096 sweep: a cache with no bucket is not rewritten at all', () => {
  // A settled user, post-upgrade: one topic, its post still assigned, nothing new to classify. The
  // sweep must be a no-op here — writing unconditionally would schedulePush() a synced row on every
  // single boot, forever, for no change.
  const clean = {
    assignments: { x1: 'g_ai_news' },
    groups: { g_ai_news: { label: 'AI news', summary: ['an established point'] } },
    unfiled: [], updatedAt: PUBLISHED, v: 2,
  };
  //
  // The FIRST render of a legacy
  // record legitimately rewrites it once — that is the backfill stamping ages onto legacy assignments
  // and starting the epoch, and without that write those assignments could never age out at all. The
  // property worth pinning is not "never written"; it is "not written on every boot", which is
  // what arms a sync forever. So the comparison is render 1 vs render 2, where a sweep that
  // writes unconditionally still reds.
  const { app } = boot({ store: { focus_groups: JSON.stringify(clean) } });

  render(app, [xPost('x1')]);
  const settled = app.get('focus_groups');

  render(app, [xPost('x1')]);

  assert.equal(app.get('focus_groups'), settled,
    'byte-identical across two identical renders — a settled cache arms no needless sync');
});

// Kept despite reaching the same expression by the same route as the aged-out sibling above, because
// the fixture is the one a reader will ask about ("what happens when I read a leftover?") and the
// answer is not obvious from the other test. It is redundant coverage, not
// a separate guard: both fail on the same two defects.
test('TASK-096 C8: a sticky post that is marked done is pruned from the record', () => {
  const { app } = boot({
    store: {
      focus_done: JSON.stringify(['x2']),
      focus_groups: JSON.stringify({ assignments: {}, groups: {}, unfiled: ['x2'], updatedAt: PUBLISHED }),
    },
  });

  render(app, [xPost('x2')], []);

  assert.deepEqual(stateOf(app).unfiled, [],
    'a read post leaves the record, exactly as a read post leaves its assignment');
});
