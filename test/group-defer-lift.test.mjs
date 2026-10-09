// [BUG-092] — A POST THE READER CAN SEE MUST NOT BE REMOVED UNDER THEM.
//
// [TASK-096] made a classifier-unplaceable post render VISIBLE in the stream (it was held hidden on
// every load before, a fifth of the backlog for 4.4-10.3s). But such a post carries no assignment, so
// it is re-sent on every classify — and when one finally places it, `liftGroupedFromStream`
// in `liftGroupedFromStream` does a bare `card.remove()` 4-10s after the feed paints, mid-read, un-animated.
//
// The rule this file pins: **the lift applies only to cards the user has never seen.** At lift time a
// never-seen card still carries `grouping-pending` (`revealPendingText` runs AFTER the lift,
// both in `updateGroupsForFeed`'s tail), so that class IS the "has the user seen this" flag. A visible card stays
// and moves into its tile on the next feed load.
//
// These tests are only possible because of this task's deliverable 1: `remove()` was a no-op and
// `querySelectorAll` answered `[]`, so the lift was unobservable. See test/harness-dom.test.mjs.
//
// WHICH TESTS COULD RED BEFORE THE FIX, stated because a merely-red suite hides the one that passed
// for the wrong reason. CORRECTED after review round 1, which ran the whole file against main:
//   RED before the fix   — C1, C3, C3b, C3c, C4. The original note listed four and omitted C3c,
//                          because C3c was written AFTER the fix was already in and so was never
//                          present at the RED step. The omission was in the safe direction; it was
//                          still wrong in the one artefact whose job is completeness.
//   GREEN before the fix — C2, C5, C6, C7, C8. These guard defects only the FIX could introduce.
//   ADDED IN ROUND 2     — C1b, C1c, C4b, C5b. Each exists because a mutation review round 1 ran
//                          survived the whole suite: the guard's other term, the prototype-chain
//                          `in` defect, the drill-in's own count, and a clear gated on a clean load.
// Every test here is killed by a named mutation in mutations/BUG-092.mjs; none rests on the RED step
// alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';

// A post's publish time. RELATIVE to now, not an absolute constant ([BUG-098] review round 1):
// every post a live feed returns is inside `WINDOW_DAYS` by the server's clock, and the prune now
// treats an in-hand post older than that window as evidence the DEVICE's clock is wrong. A frozen
// 2025 timestamp made every fixture look like a broken clock — and would have drifted a suite that
// once passed into one that asserts the opposite, silently, as months went by.
const PUBLISHED = Date.now() - 2 * 86400_000;

const xPost = (id, text = `post ${id} says something`) => ({
  id, source: 'twitter', text, published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});

// One post already filed under a real topic, one the model examined and could not place. This is the
// exact state a reader holds when the bug fires: x1 lives in the tile, x2 is on screen being read.
const STICKY_STATE = () => ({
  assignments: { x1: 'g_ai_news' },
  groups: { g_ai_news: { label: 'AI news', summary: [{ text: 'a point about AI', item_ids: ['x1'] }] } },
  unfiled: ['x2'],
  updatedAt: PUBLISHED,
});
// The classify that finally places the sticky post — the moment the card disappears today.
const PLACES_X2 = [{ label: 'AI news', summary: ['x2 says a thing'], item_ids: ['x2'] }];

function boot({ store, reply = PLACES_X2 } = {}) {
// GROUPED VIEW SEEDED ([TASK-099]). Ungrouped is now the DEFAULT: every post renders into the
// chronological stream and an assigned one is merely HIDDEN, so a fixture with no view key exercises
// the plain feed — where tiles, the lift and the classify hold do not exist at all. This file's subject — [BUG-092]'s deferral — is
// unchanged, so the seed only states a precondition. ⚠️ UNLIKE the other seeded files, TWO
// assertions here DID have to change, and the earlier blanket claim that none did was false:
// C1/C1b/C6/C5c addressed cards by INDEX, and `children[0]` is now the hidden `.grouped-out` card
// rather than the post under test, so each was re-pointed at its card by `dataset.id`. Two of the
// four had gone DEAD as a result (measured: killed before [TASK-099], surviving after).
  const app = createApp({ store: { focus_group_view: 'on', ...(store ?? { focus_groups: JSON.stringify(STICKY_STATE()) }) } });
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

const render = (app, items, failed = []) =>
  app.ctx.renderFeedResults({ items, failed, cappedNames: [], totalChannels: items.length + failed.length });
// "In the stream" now means VISIBLE in the stream ([TASK-099] decision 1, Asli 2026-08-26: the lift
// HIDES rather than removes). A lifted card is still a `#feed` child carrying `.grouped-out`
// (display:none), so a raw `children` read reports a post the reader cannot see as present — the same
// mistake the four production counting selectors had to be corrected for. The assertions below are
// UNCHANGED; only what the instrument counts as "in the stream" moved, and it moved to match what a
// browser shows.
// [TASK-098]: `.card` is now REQUIRED rather than implied. Every child of `#feed` used to be a post
// card, so mapping over `children` and mapping over post cards were the same set; a `.topic-card` is
// now also a child, and it carries `data-gid` rather than `data-id` — so the un-narrowed version
// reported `undefined` in the middle of the stream. The QUESTION is unchanged: which posts are here.
const streamIds = app => app.el('feed').children
  .filter(c => c.classList.contains('card') && !c.classList.contains('grouped-out')).map(c => c.dataset.id);
const stateOf = app => JSON.parse(app.get('focus_groups') || '{"assignments":{},"groups":{}}');
// [TASK-098] RE-POINTED. A topic is a `.topic-card` in the stream now, not a `.group-card` tile in a
// `#group-grid` above it. The assertions below are unchanged — only where they look. The READERS got
// stronger in the move: the old tile was one `innerHTML` blob, so its count and bullets could only be
// scraped by regex over an unparsed string; the new card is appended nodes, so these are real queries.
const countOn = card => card?.querySelectorAll('.tc-count')[0]?.textContent;
// `.tc-bullets li` would be a TAG selector, which the harness refuses on purpose — read the list's
// own children instead.
const bulletsOn = card => [...(card.querySelectorAll('.tc-bullets')[0]?.children || [])].map(li => li.textContent);
const tileFor = (app, gid) => app.queryAll('#feed .topic-card').find(c => c.dataset.gid === gid);
// [TASK-098]: the drill-in is deleted (criterion 12). A topic's posts are ALWAYS on screen, on its
// card's rail — so there is nothing to open, and each post's Done/Archive live on its own slide.
// The QUESTION each of these answers is the one `#group-detail-list` used to answer: which posts does
// this topic actually show, and what happens when one of them leaves.
// [TASK-107]: the rail's first slide is the SUMMARY, which carries no `data-id` — so the raw map
// now leads with `undefined`. Filtered rather than re-worded: the question every caller asks is
// "which POSTS does this rail list, in what order", and that question is unchanged.
//
// ⚠️ WHAT THE FILTER COSTS, stated honestly after an independent audit found the original note here
// claiming it cost nothing. It drops only FALSY ids, so a summary that wrongly carried a `data-id`
// is truthy, survives, and reds every ordered deepEqual on its own — that case is safe, but NOT for
// the reason first written. What the filter genuinely hides is a summary appended in the wrong
// PLACE: unfiltered, a trailing `undefined` failed every ordered comparison here; filtered, only
// TASK-107 T1 and T6 look at where the summary sits.
const railIds  = (app, gid) => app.queryAll(`#feed .topic-card[data-gid="${gid}"] .tc-slide`).map(s => s.dataset.id).filter(Boolean);
const railPost = (app, gid, id) => app.queryAll(`#feed .topic-card[data-gid="${gid}"] .tc-slide[data-id="${id}"] .tc-post`)[0];
const doneIn = app => JSON.parse(app.get('focus_done') || '[]');
// renderFeedResults fires the classify without awaiting it. Every render-driven test also asserts the
// classify RAN, so a too-short settle fails loudly instead of passing as "nothing happened".
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };

// ── C1: the card survives its own classify (RED before the fix) ────────────────

test('BUG-092 C1: a post the reader can SEE is not removed when its classify places it', async () => {
  const { app, bodies } = boot();
  render(app, [xPost('x1'), xPost('x2')]);

  assert.deepEqual(streamIds(app), ['x2'], 'the sticky post is on screen, unheld; the filed one is in the tile');
  // BY ID, NOT BY INDEX. `children[0]` was x2's card only while an assigned post was SKIPPED at
  // render; under [TASK-099] it is x1's HIDDEN card, so this silently changed subject and the
  // assertion compared x1 with itself. Measured: KILLED before TASK-099, SURVIVED after.
  const cardOf = (id) => app.el('feed').children.find(c => c.dataset.id === id);
  const cardBefore = cardOf('x2');
  // Without this the identity assertion below passes VACUOUSLY when the lookup finds nothing at
  // either end: `undefined === undefined`. The index version could not fail this way, so the guard
  // arrives with the id-based lookup.
  assert.ok(cardBefore, 'guard: the sticky post must have a card to compare');

  await settle();
  assert.equal(bodies.length, 1, 'the classify actually ran');
  assert.equal(stateOf(app).assignments.x2, 'g_ai_news', 'and it placed the sticky post');

  assert.deepEqual(streamIds(app), ['x2'],
    'the card the reader was looking at is STILL THERE — this is the whole bug');
  assert.equal(cardOf('x2'), cardBefore,
    'and it is the same node, not a re-render that happens to look the same');
});

// ── C6: a never-seen post still lifts silently (GREEN before the fix; guard) ────

test('BUG-092 C6: a post the reader has never seen still lifts silently', async () => {
  // No `unfiled` record, so x2 is a first-pass post: held hidden, never seen, nothing to interrupt.
  const { app, bodies } = boot({
    store: { focus_groups: JSON.stringify({ ...STICKY_STATE(), unfiled: [] }) },
  });
  render(app, [xPost('x1'), xPost('x2')]);
  assert.equal(app.el('feed').children.find(c => c.dataset.id === 'x2').classList.contains('grouping-pending'), true,
    'a first-pass X post is held — that is [TASK-073] and it must survive this fix');

  await settle();
  assert.equal(bodies.length, 1, 'the classify ran');
  assert.deepEqual(streamIds(app), [],
    'a card the reader never saw is lifted out, exactly as before — the fix must not over-apply');
  // …and it must ARRIVE in its tile. Round 2 review: moving `_liftDeferred.add` into the remove
  // branch ("record everything we lifted") passes every other test, and puts the post in NEITHER
  // home — no card, no tile, badge blank, and checkEmpty then shows caught-up over an unread post.
  // That is this bug's own headline symptom plus a false done-state. The add belongs only on the
  // branch that KEEPS a card.
  assert.equal(countOn(tileFor(app, 'g_ai_news')), '2 posts',
    'the lifted post is in its tile, counted — a card that was removed is not "deferred"');
  assert.equal(app.el('feed-count').textContent, '2 new', 'and it is still counted as unread');
});

test('BUG-092 C1b: a post the classify could NOT place is revealed, never removed', async () => {
  // Guards the OTHER term of the rewritten guard. `liftGroupedFromStream` skips a card whose id is
  // not in `assignments`; drop that term and every held card is removed regardless — an unplaceable
  // post ends up in NEITHER home, which is BUG-092's own symptom arriving by a new route. Review
  // round 1 measured that mutation (E2) passing all 680 tests, because the battery only ever mutated
  // this line as a whole (M12/M13) and CLAUDE.md requires each TERM.
  const { app, bodies } = boot({
    store: { focus_groups: JSON.stringify({ ...STICKY_STATE(), unfiled: [] }) },
    reply: [{ label: 'AI news', summary: ['a point about AI'], item_ids: ['x2'] }], // x3 left unplaced
  });
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();

  assert.equal(bodies.length, 1, 'the classify ran');
  assert.equal(stateOf(app).assignments.x2, 'g_ai_news', 'the placeable post was placed');
  assert.equal(Object.hasOwn(stateOf(app).assignments, 'x3'), false, 'the other one was not');
  assert.deepEqual(streamIds(app), ['x3'],
    'the unplaceable post is still in the stream — revealed by revealPendingText, not removed');
  // BY ID, NOT BY INDEX. `children[0]` was x2's card only while an assigned post was SKIPPED at
  // render; under [TASK-099] it is x1's HIDDEN card, so this silently changed subject and the
  // assertion compared x1 with itself. Measured: KILLED before TASK-099, SURVIVED after.
  assert.equal(app.el('feed').children.find(c => c.dataset.id === 'x3').classList.contains('grouping-pending'), false,
    'and it is visible, not still held hidden');
});

test('BUG-092 C1c: a post whose id is "toString" is not swallowed by the prototype chain', async () => {
  // Pins a PRE-EXISTING guard this change made observable and load-bearing — `Object.hasOwn` rather
  // than `in`. `assignments` comes from JSON.parse, so `'toString' in assigned` is true for every
  // object, and a Substack card carries its remote `guid` as `dataset.id`. Before [BUG-092] no test
  // could reach this function at all, and its own comment said so; review round 1 pointed out the
  // comment was now false while the gap was still open. One fixture closes it.
  // The fixture must be a HELD card, and finding that out cost a wrong first attempt worth recording:
  // with a Substack post (never held) the `in` defect takes the DEFER branch instead of the remove
  // branch, so the card survives and the test passed under the mutation — decoration. The bug only
  // still destroys a card the user has not seen, so the post has to be a first-pass X one.
  const { app, bodies } = boot({
    store: { focus_groups: JSON.stringify({ ...STICKY_STATE(), unfiled: [] }) },
    reply: [{ label: 'AI news', summary: ['a point about AI'], item_ids: ['x2'] }], // 'toString' unplaced
  });
  render(app, [xPost('x2'), xPost('toString')]);
  await settle();

  assert.equal(bodies.length, 1, 'the classify ran');
  assert.equal(Object.hasOwn(stateOf(app).assignments, 'toString'), false,
    'the post carries no assignment, so nothing may lift it');
  assert.deepEqual(streamIds(app), ['toString'],
    'and it is still in the stream — `in` matches Object.prototype and would have removed the card');
});

// ── C3: the tile owns what it says (RED before the fix) ────────────────────────

test('BUG-092 C3: the tile counts only what it owns; the deferred post is not in it', async () => {
  const { app, bodies } = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  assert.equal(bodies.length, 1, 'the classify actually ran — without this the test is vacuous');
  assert.equal(stateOf(app).assignments.x2, 'g_ai_news', 'and it placed the visible post');
  const tile = tileFor(app, 'g_ai_news');
  assert.ok(tile, 'the topic still has a tile');
  assert.equal(countOn(tile), '1 post',
    'the tile counts x1 only — x2 is in the stream, and a post has ONE home at a time');
});

test('BUG-092 C3b: "Mark N done" marks what the tile says, leaving the stream card readable', async () => {
  const { app, bodies } = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  assert.equal(bodies.length, 1, 'the classify actually ran');
  assert.equal(stateOf(app).assignments.x2, 'g_ai_news', 'and it placed the visible post');

  app.ctx.markGroupDone('g_ai_news');
  app.runTimers();

  assert.deepEqual(doneIn(app), ['x1'],
    'clearing the tile marks the one post the tile claimed, not the one still on screen');
  assert.deepEqual(streamIds(app), ['x2'],
    'and the post the reader can see is untouched — it was never in that tile');
});

test('BUG-092 C3c: the tile still carries the SENTENCE about the deferred post', async () => {
  // The deliberate divergence, pinned so it cannot be "tidied away". A deferred post is excluded from
  // the tile's COUNT (it is on screen in the stream) but included in the unread set that decides which
  // BULLETS are live — because that is the same question `liveBullets` answers for the /api/group
  // payload, where under-reporting destroys the only restorable copy ([BUG-091]). Excluding it here
  // instead would make the sentence blink out of the tile and back on the next load.
  const { app } = boot({
    reply: [{
      label: 'AI news', item_ids: ['x2'],
      summary: [
        { text: 'a point about AI', item_ids: ['x1'] },
        { text: 'x2 says a thing', item_ids: ['x2'] },
      ],
    }],
  });
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  const tile = tileFor(app, 'g_ai_news');
  assert.equal(countOn(tile), '1 post', 'the tile owns one post…');
  assert.deepEqual(bulletsOn(tile), ['a point about AI', 'x2 says a thing'],
    '…and still shows the sentence for the deferred one, rather than dropping it for a load');
});

// ── C4: one home at a time (RED before the fix) ────────────────────────────────

test('BUG-092 C4: the topic rail does not list the deferred post', async () => {
  const { app, bodies } = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  assert.equal(bodies.length, 1, 'the classify actually ran');
  assert.equal(stateOf(app).assignments.x2, 'g_ai_news', 'and it placed the visible post');

  assert.deepEqual(railIds(app, 'g_ai_news'), ['x1'],
    'the rail shows what the header counts; x2 would otherwise be on screen twice — and under '
    + '[TASK-098] BOTH are on the same screen at once, so a double listing is now visible in one look '
    + 'rather than one drill-in away');
});

// ── C2: no double count (GREEN before the fix; guards the fix) ──────────────────

test('BUG-092 C2: placing a visible post does not move the badge', async () => {
  const { app, bodies } = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  const before = app.el('feed-count').textContent;
  assert.equal(before, '2 new', 'one card in the stream plus one post in the tile');

  await settle();
  assert.equal(bodies.length, 1, 'the classify actually ran — "nothing moved" is trivially true if it did not');
  assert.equal(stateOf(app).assignments.x2, 'g_ai_news', 'and it placed the visible post');
  assert.equal(app.el('feed-count').textContent, before,
    'the same two unread posts are still the same two — a deferred post counted as BOTH a stream '
    + 'card and a grouped post would read "3 new" over a screen showing two');
});

// ── C5: the next load moves it (GREEN before the fix; guards the clear) ─────────

test('BUG-092 C5: the next feed load moves the deferred post into its tile', async () => {
  const { app } = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  render(app, [xPost('x1'), xPost('x2')]); // a fresh load: pull-to-refresh, or reopening the app
  assert.deepEqual(streamIds(app), [],
    'the deferral lasts one session, not forever — the post has left the stream');
  assert.equal(countOn(tileFor(app, 'g_ai_news')), '2 posts',
    'and the tile now owns both, with no user action');
});

test('BUG-092 C5b: a load with a FAILED channel still moves the deferred post', async () => {
  // C5 only ever renders with `failed: []`, so gating the clear on a complete load (mimicking
  // syncGroupPrune, which legitimately is gated) survived every test in review round 1. An X 502 at
  // the plan's post cap is routine, so "the next load" must mean any load, not any clean one.
  const { app } = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  render(app, [xPost('x1'), xPost('x2')], ['a-dead-channel']);
  assert.deepEqual(streamIds(app), [], 'the post left the stream even though a channel failed');
  assert.equal(countOn(tileFor(app, 'g_ai_news')), '2 posts', 'and the tile owns both');
});

test('BUG-092 C4b: clearing the rail removes the card, counting only what it listed', async () => {
  // Pins the `finishGroupCardAction` call site specifically. M18 reverts the whole
  // visibleGroupUnreadIds body, so it cannot say WHICH converted site is covered — reverting this one
  // line alone survived review round 1. Symptom it permits: under [TASK-098] the topic card STAYS in
  // the stream over an empty rail, headed "1 post", counting the deferred post it never showed —
  // the same defect the drill-in used to express by staying open.
  const { app } = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  assert.equal(stateOf(app).assignments.x2, 'g_ai_news',
    'the classify placed the visible post — without a deferral this test cannot fail for its reason');
  assert.deepEqual(railIds(app, 'g_ai_news'), ['x1'], 'the rail lists one post');
  const post = railPost(app, 'g_ai_news', 'x1');
  assert.ok(post, 'guard: that post must be on the rail before it can be cleared');
  assert.equal(app.click(post.querySelectorAll('.btn-done')[0]), 1, 'guard: Done must be wired');
  app.runTimers();

  assert.equal(tileFor(app, 'g_ai_news'), undefined,
    'clearing the only listed post removes the topic card — the deferred post must not hold it open');
});

test('BUG-092 C5c: a render that does not rebuild the feed does NOT end the deferral', async () => {
  // The other direction from C5/C5b, and the one round 2 got wrong. A deferral names a card in
  // `#feed`; the zero-item paths (total failure, empty refresh) hide `#feed` via showLoadError /
  // showCaughtUp WITHOUT rebuilding it, so the card is still there. Clearing the set above those
  // returns — round 2's "fix" for a comment that was merely inaccurate — leaves the post counted
  // twice: once as a stream card, once as a grouped post. Measured "3 new" over two unread posts,
  // a double count neither main nor the original position had.
  const { app } = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.deepEqual(streamIds(app), ['x2'], 'a deferral is standing');
  const badge = app.el('feed-count').textContent;
  assert.equal(badge, '2 new', 'two unread posts: one on screen, one in the tile');

  render(app, [], ['a-dead-channel']); // every channel failed — #feed is hidden, not rebuilt
  app.ctx.updateCount();
  assert.equal(app.el('feed').children.filter(c => c.dataset.id === 'x2').length, 1,
    'the deferred card is still in the DOM, just hidden');
  assert.equal(app.el('feed-count').textContent, badge,
    'so it is still ONE unread post — clearing the deferral here counts it twice');
});

// ── C7: bullets are never destroyed (GREEN before the fix; LATENT guard) ────────

test('BUG-092 C7: a payload built while a deferral stands still forwards the deferred post as unread', async () => {
  // LATENT, and said plainly rather than dressed up as a live guard. `updateGroupsForFeed` is called
  // from exactly one place (`renderFeedResults`), which clears the deferred set when it rebuilds the
  // feed, before the classify runs — so in production a payload is NEVER built while a deferral
  // stands, and this state is unreachable today. It is driven directly here because the harm if it ever became reachable is
  // [BUG-091]'s verbatim: `existing[].summary` is the ONLY copy the server can restore cached bullets
  // from, so a deferred post filtered out of the unread set silently destroys its topic's summary.
  // This test is what makes "the exclusion is display-side only" a checked property instead of a
  // comment.
  // The fixture MUST carry a bullet linked to the DEFERRED post. Review round 1 found the original
  // version vacuous: its only bullet was a bare string, and a bullet with no `item_ids` is treated as
  // always-live by `bulletIsLive`, so `summary.length` was 1 whichever unread reader `liveBullets`
  // received. The battery's M19 moved `size` and `summary` together, so it died on `size` while the
  // destruction half went unexercised — CLAUDE.md §1's "green, correct, measuring the wrong
  // quantity", in the test whose stated job is guarding against exactly that.
  const { app, bodies } = boot({
    reply: [{
      label: 'AI news', item_ids: ['x2'],
      summary: [
        { text: 'a point about AI', item_ids: ['x1'] },
        { text: 'x2 says a thing', item_ids: ['x2'] },
      ],
    }],
  });
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  await app.ctx.updateGroupsForFeed([xPost('x1'), xPost('x2'), xPost('x3')]);
  assert.equal(bodies.length, 2, 'a second classify ran, with a genuinely new post to place');

  const topic = bodies[1].groups.find(g => g.label === 'AI news');
  assert.ok(topic, 'the existing topic was offered to the model');
  assert.equal(topic.size, 2,
    'the deferred post still counts toward the size that protects a real topic ([BUG-066])');
  // Assert the TEXT, not the count. This is the half that bites: filter the deferred post out of the
  // unread set here and the server never sees this sentence again, so it cannot restore it.
  const texts = topic.summary.map(b => (typeof b === 'string' ? b : b.text));
  assert.deepEqual(texts, ['a point about AI', 'x2 says a thing'],
    "the DEFERRED post's own sentence is still forwarded — the only copy restoreCachedBullets has");
});

// ── C8: nothing new is persisted (GREEN before the fix; guards the shape) ───────

test('BUG-092 C8: the deferral is in memory only and does not survive a reload', async () => {
  const { app } = boot();
  const keysBefore = new Set(app.store.keys());
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  // Against the ACTUAL SK inventory, not a name pattern. The pattern version was defeated by review
  // round 1 simply by naming the key `focus_group_hold` — criterion 8 violated, test green. SK is a
  // `const`, so the vm does not expose it; this list is transcribed from the `SK` object at the top of app.js and any key
  // outside it fails here, whatever it is called.
  const SK_KEYS = [
    'focus_channels', 'focus_done', 'focus_last_view', 'focus_theme', 'focus_include_shorts',
    'focus_last_feed_load', 'focus_tweet_cache', 'focus_archive', 'focus_device_id',
    'focus_landing_seen', 'focus_groups', 'focus_dirty', 'focus_events', 'focus_was_authed',
    'focus_group_view', // [TASK-099] — device-local grouped-view preference
  ];
  const added = [...app.store.keys()].filter(k => !keysBefore.has(k));
  assert.deepEqual(added.filter(k => !SK_KEYS.includes(k)), [],
    'no key outside the SK inventory: the exit paths clear BY that inventory, so a persisted set '
    + 'would silently escape clearLocalIdentity and need an EXIT_DISPOSITION decision');

  // A reload is a fresh boot over the same store — the deferral must be gone, not resurrected.
  const { app: reloaded } = boot({ store: Object.fromEntries(app.store) });
  render(reloaded, [xPost('x1'), xPost('x2')]);
  assert.deepEqual(streamIds(reloaded), [],
    'after a reload the post is in its tile, because nothing about the deferral persisted');
});

// ── The bullet recompute meets a deferral ([TASK-098], 2026-08-31) ────────────
//
// Asli's handset walk found that `finishGroupCardAction` never re-ran the bullet filter, so a card
// went on summarising posts its rail no longer held (T31). The fix recomputes them — and that put a
// SECOND caller on the divergence C3c above exists to protect, which nothing was watching.
//
// Written because the verification battery's H4 SURVIVED: swapping the recompute's unread source for
// `visibleGroupUnreadIds` — the plausible wrong answer, since that is what the rail itself lists —
// passed all 991 tests. C3c pins the divergence at BUILD time only, and no fixture combined a
// deferral with a rail action. The comment on the fix claims it reads "the SAME source a repaint
// reads"; this is what makes that claim falsifiable rather than decorative.
test('TASK-098 T32 (battery H4): a rail action does not drop the deferred post\'s sentence', async () => {
  const { app } = boot({
    store: {
      focus_group_view: 'on',
      focus_groups: JSON.stringify({
        assignments: { x1: 'g_ai_news', x3: 'g_ai_news' },
        groups: { g_ai_news: { label: 'AI news', summary: [] } },
        unfiled: ['x2'], updatedAt: PUBLISHED,
      }),
    },
    // x2 is on screen unfiled when the classify places it, which is what defers it. Three sentences,
    // one per post, so exactly one can fall and the others are not swept up with it.
    reply: [{
      label: 'AI news', item_ids: ['x2'],
      summary: [
        { text: 'a point about AI', item_ids: ['x1'] },
        { text: 'x2 says a thing', item_ids: ['x2'] },
        { text: 'a third point', item_ids: ['x3'] },
      ],
    }],
  });
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();

  const card = tileFor(app, 'g_ai_news');
  assert.ok(card, 'guard: the topic card must exist before its bullets mean anything');
  assert.deepEqual(railIds(app, 'g_ai_news'), ['x1', 'x3'],
    'guard: the rail lists the two undeferred posts — x2 is deferred, on screen in the stream');
  assert.deepEqual(bulletsOn(card), ['a point about AI', 'x2 says a thing', 'a third point'],
    'guard: all three sentences are live, including the deferred post\'s (C3c\'s divergence)');

  const done = app.queryAll('#feed .topic-card[data-gid="g_ai_news"] .tc-slide[data-id="x1"] .btn-done')[0];
  assert.ok(done, 'guard: x1\'s slide must carry a Done button');
  assert.equal(app.click(done), 1, 'guard: and it must be wired');
  app.runTimers(4);

  assert.deepEqual(railIds(app, 'g_ai_news'), ['x3'],
    'guard: x1 leaves the rail, and one post remains — so the card is NOT removed and the recompute '
    + 'actually runs. A fixture where the rail emptied would return early and pin nothing');
  assert.deepEqual(bulletsOn(tileFor(app, 'g_ai_news')), ['x2 says a thing', 'a third point'],
    'x1\'s sentence goes with x1, and the DEFERRED post\'s sentence stays. Recomputing from what the '
    + 'rail shows instead of from what the account holds unread would drop x2\'s line here and '
    + 'restore it on the next load — the blink [BUG-089] and [BUG-091] both record');
});
