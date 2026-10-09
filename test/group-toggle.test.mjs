// [TASK-099] — UNGROUPED IS THE DEFAULT, AND GROUPING IS A CHOICE.
//
// Today grouping is unconditional: `renderFeedResults` skips every already-assigned groupable post
// when it builds the chronological stream (app.js), so a post that a classify has filed exists ONLY
// in its tile and the plain chronological feed the product promises is unreachable. Nobody chose
// that — the feed simply arrives reorganised — and everyone pays for it, because a genuinely-new X
// post is held hidden (`grouping-pending`) for 4.4-10.3s so it cannot flash under "Posts" and then
// be yanked into a tile.
//
// This file pins the reverse: every post renders into the stream, an assigned one additionally
// carries `.grouped-out` (display:none) ONLY while the reader has grouping on, and one switch in the
// feed appbar moves between the two views. The lift HIDES rather than removes (decision 1,
// 2026-08-26), which is what makes the toggle symmetric and idempotent — and which transfers a cost
// to every selector that counts `#feed` cards, because a hidden card is still in the DOM.
//
// WHICH TESTS COULD RED BEFORE THE FIX, stated because a merely-red suite hides the one that passed
// for the wrong reason (CLAUDE.md, Mutation batteries):
//
//   RED before the fix   — T1, T2, T3, T4, T5, T6, T7, T9, T10a, T10b, T10c, T12, T13, T14, T14b,
//                          T15. Sixteen of the SEVENTEEN that existed at the RED step; each fails on
//                          a criterion `main` violates today, and each names the value it read.
//
//   ADDED LATER, so they were never part of that accounting and this file now holds TWENTY-THREE:
//     T14c, T14d, T16 — after the mutation battery reported survivors. T14 exercised BOTH [BUG-103]
//                       guards at once, so either alone satisfied it and it pinned NEITHER.
//     T17, T18, T19   — after independent review found three defects (see tasks/TASK-099.md).
//   GREEN before the fix — T8 alone. It guards a defect that ONLY decision 1 can introduce: under
//                          hide-not-remove the hidden cards are still in `#feed`, so
//                          `liftGroupedFromStream` drops every one into `_liftDeferred`, the grid's
//                          `counts[gid] > 0` filter then removes every tile, and the grouped view
//                          collapses on the next background classify. It cannot fire on `main`,
//                          where those cards were removed outright and there is nothing to defer.
//                          Declared rather than quietly counted as coverage.
//
// NOT TESTABLE HERE, and deliberately (see the task's Verification section): criterion 11 (reduced
// motion), the switch's appearance, the bloom's timing and its 44px hit target at 375px. A desktop
// browser is the wrong instrument for all four and a resized desktop window is not a substitute —
// they go to Asli on a handset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, SIGNED_IN } from '../test-helpers/app-harness.mjs';

// RELATIVE to now, never a frozen constant: the prune treats an in-hand post older than WINDOW_DAYS
// as evidence of a wrong device clock, so a fixed 2025 timestamp would drift a passing suite into
// one asserting the opposite as months go by ([BUG-098] review round 1).
const PUBLISHED = Date.now() - 2 * 86400_000;

const xPost = (id, text = `post ${id} says something`) => ({
  id, source: 'twitter', text, published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});

const groupState = (over = {}) => JSON.stringify({
  assignments: {}, groups: {}, unfiled: [], updatedAt: PUBLISHED, ...over,
});

// The gid a real classify would MINT for this label. `groupIdFor` derives it from the label
// (app.js), so a fixture that invents its own id (`g1`) seeds a group the endpoint's reply can never
// merge into: the classify creates a SECOND tile alongside it and every count assertion reads the
// wrong one. Found at the RED step by a probe, because T8's prediction (GREEN before the fix) did not
// match its result — the mismatch was the fixture, not the criterion.
const G_AI = 'g_ai_news';
const AI_NEWS = { label: 'AI news', summary: [{ text: 'a point about AI', item_ids: ['x1'] }] };

/** Boot a browser. `grouped` seeds the device-local view key the way a reload would find it. */
function boot({ store = {}, reply = [], grouped = null } = {}) {
  const bodies = [];
  const app = createApp({
    store: {
      focus_device_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ...(grouped === null ? {} : { focus_group_view: grouped ? 'on' : 'off' }),
      ...store,
    },
  });
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

// Every card in the stream, hidden or not — the DOM truth.
// [TASK-098]: `.card` is now REQUIRED rather than implied. Every child of `#feed` used to be a post
// card, so mapping over `children` and mapping over post cards were the same set; a `.topic-card` is
// now also a child, and it carries `data-gid` rather than `data-id` — so the un-narrowed version
// reported `undefined` in the middle of the stream. The QUESTION is unchanged: which posts are here.
const streamIds = app => app.el('feed').children.filter(c => c.classList.contains('card')).map(c => c.dataset.id);
// What the READER can actually see. `.grouped-out` is this task's hide; `.grouping-pending` is
// [TASK-073]'s hold; `.removing` is a card mid-slide-out. A test that asserts on streamIds alone
// cannot tell "present and visible" from "present and hidden", which is the whole subject here.
const visibleIds = app =>
  app.queryAll('#feed .card:not(.grouped-out):not(.grouping-pending):not(.removing)').map(c => c.dataset.id);
const heldIds = app => app.queryAll('#feed .card.grouping-pending').map(c => c.dataset.id);
const badge = app => app.el('feed-count').textContent;
// [TASK-098] RE-POINTED. A topic is a `.topic-card` in the stream now, not a `.group-card` tile in a
// `#group-grid` above it. The assertions below are unchanged — only where they look. The READERS got
// stronger in the move: the old tile was one `innerHTML` blob, so its count and bullets could only be
// scraped by regex over an unparsed string; the new card is appended nodes, so these are real queries.
// `gridHidden` asked whether the GRID was hidden; with no grid, the same question — "is the
// reader being shown topics right now" — is whether any topic card is in the stream.
const gridHidden = app => app.queryAll('#feed .topic-card').length === 0;
const tileFor = (app, gid) => app.queryAll('#feed .topic-card').find(c => c.dataset.gid === gid);
// [TASK-098]: the drill-in is deleted (criterion 12). A topic's posts are ALWAYS on its card's rail,
// so there is nothing to open and nothing to close. `querySelectorAll`, not `querySelector`: the
// reduced post's buttons are real appended nodes now, and the element-scoped singular form answers
// with a memoised PHANTOM rather than the node the app wired.
const railPost = (app, gid, id) => app.queryAll(`#feed .topic-card[data-gid="${gid}"] .tc-slide[data-id="${id}"] .tc-post`)[0];
const actOnRail = (app, gid, id, cls) => {
  const post = railPost(app, gid, id);
  assert.ok(post, `guard: the rail must list ${id} before it can be acted on`);
  assert.equal(app.click(post.querySelectorAll(cls)[0]), 1, `guard: ${cls} must be wired`);
  app.runTimers(4);
};
const countOn = card => card?.querySelectorAll('.tc-count')[0]?.textContent;
const sw = app => app.el('toggle-grouping');
const events = app => JSON.parse(app.get('focus_events') || '[]');

// renderFeedResults fires the classify without awaiting it. Every render-driven test also asserts
// the classify RAN, so a too-short settle fails loudly instead of passing as "nothing happened".
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };

/** Wire the real controls, then tap the switch. Returns the number of handlers that ran.
 *  Asserted as 1 at every call site: a tap on an unwired button is silently a no-op, which is
 *  indistinguishable from a handler that correctly did nothing — the confusion [BUG-017]'s
 *  re-verification lost three sign-out clicks to. */
const tapSwitch = (app) => app.click(sw(app));

// ── Default: grouping OFF ─────────────────────────────────────────────────────

test('TASK-099 T1 (C1): OFF — a reload with assignments already in state shows every post, visibly', async () => {
  // The returning reader. Their assignments are already in synced state, so this is not an exotic
  // case: it is what every second load looks like once a classify has ever run.
  const { app } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });

  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);

  assert.deepEqual(streamIds(app), ['x1', 'x2', 'x3'],
    'an assigned post must still be RENDERED into the chronological stream while grouping is off');
  assert.deepEqual(visibleIds(app), ['x1', 'x2', 'x3'],
    'and it must be VISIBLE: on main this render produces an empty screen, because the two assigned '
    + 'posts are skipped outright and the third is held hidden by the classify hold');
  assert.equal(gridHidden(app), true,
    'the grid must not paint while grouping is off — the default view is the plain chronological feed');
});

test('TASK-099 T2 (C2): OFF — the badge counts the visible stream once, not twice', async () => {
  const ids = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
  const assignments = Object.fromEntries(ids.map(id => [id, G_AI]));
  const { app } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments, groups: { [G_AI]: AI_NEWS } }) },
  });

  render(app, ids.map(id => xPost(id)));

  // Both halves, and the first is what makes the second non-vacuous. On main the badge already
  // reads "6 new" — but over ZERO visible cards, because the count is 0 stream + 6 grouped. Asserting
  // the string alone would pass against exactly the screen this task exists to fix.
  assert.equal(visibleIds(app).length, 6, 'all six posts must be on screen');
  assert.equal(badge(app), '6 new',
    'six visible cards must read "6 new" — not "12 new", which is what an ungated countGroupedUnread '
    + 'adds on top of a stream that now holds the same six posts');
});

test('TASK-099 T3 (C3): OFF — reading everything reaches "You are all caught up"', async () => {
  const { app } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });

  render(app, [xPost('x1'), xPost('x2')]);
  const cards = app.queryAll('#feed .card:not(.grouped-out):not(.grouping-pending)');
  assert.equal(cards.length, 2, 'guard: both posts must be on screen before there is anything to read');

  cards.forEach(card => card.querySelector('.btn-done').listeners
    .filter(l => l.type === 'click').forEach(l => l.fn()));
  app.runTimers(4);

  assert.equal(app.el('caughtup').classList.contains('hidden'), false,
    'reading every visible post must reach the caught-up screen — the product\'s whole promise. '
    + 'With the count still adding grouped assignments on top, checkEmpty never fires and it never arrives');
  assert.equal(badge(app), 'all caught up ✓');
});

test('TASK-099 T4 (C4): OFF — no card is held hidden, at any point', async () => {
  // The hold exists to stop a brand-new post flashing under "Posts" and then being yanked into a
  // tile. While grouping is off NOTHING will ever yank it, so the hold protects against a flash that
  // cannot happen while costing the DEFAULT path 22-32% of the backlog, hidden for 4.4-10.3s.
  const { app, bodies } = boot({ grouped: false, reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }] });

  render(app, [xPost('x1')]);
  assert.deepEqual(heldIds(app), [],
    'a genuinely-new groupable post must render VISIBLE while grouping is off');
  assert.deepEqual(visibleIds(app), ['x1'], 'and be on screen immediately, not after the classify');

  await settle();
  assert.equal(bodies.length, 1, 'guard: the classify really ran, so this test is not asserting over a quiet render');
  assert.deepEqual(heldIds(app), [], 'and nothing is held after the classify either');
  assert.deepEqual(visibleIds(app), ['x1'],
    'the post stays in the stream: while off, a classify files it for later but does not move it');
});

// ── The toggle ────────────────────────────────────────────────────────────────

test('TASK-099 T5 (C5): ON — every assigned post leaves the visible stream for its tile', async () => {
  const { app } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  assert.deepEqual(visibleIds(app), ['x1', 'x2', 'x3'], 'guard: the reader starts in the plain feed');

  assert.equal(tapSwitch(app), 1, 'the switch was never wired, so this test taps nothing');

  // The posts have been on screen since the render — exactly the case [BUG-092]'s deferral refuses
  // for a BACKGROUND classify. A tap is bidden, so the rule is suspended for this path only.
  assert.deepEqual(visibleIds(app), ['x3'], 'only the unassigned post stays in the visible stream');
  assert.deepEqual(streamIds(app), ['x1', 'x2', 'x3'],
    'the grouped-out cards stay in the DOM — hide, not remove (decision 1), which is what makes the '
    + 'toggle symmetric and idempotent without a {force:true} carve-out');
  assert.equal(gridHidden(app), false, 'the grid paints');
  assert.equal(countOn(tileFor(app, G_AI)), '2 posts', 'the tile owns exactly the two it took');
});

test('TASK-099 T6 (C6): OFF again returns every post and empties the grid, with the badge right both ways', async () => {
  const { app } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  // NOT evidence for criterion 6's badge clause: the badge is INVARIANT under the toggle by
  // construction (the stream and the grid partition the unread set — see the note above T24,
  // and `mutations/TASK-099-item4.mjs` M2, a declared survivor). This pair still earns its place
  // by killing a COUNTING defect — the TASK-099 battery's M3 drops updateCount's `.grouped-out`
  // exclusion and this test catches it — but it cannot fail on a TOGGLE defect. Review finding 12.
  assert.equal(badge(app), '3 new', 'grouped: one stream card plus two in the tile');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  assert.deepEqual(visibleIds(app), ['x1', 'x2', 'x3'], 'every post is back on screen');
  assert.equal(gridHidden(app), true, 'and the grid is gone — leaving it painted strands the reader');
  assert.equal(badge(app), '3 new', 'ungrouped: three stream cards, counted once');
});

test('TASK-099 T7 (C7): the toggle is idempotent — ON/OFF/ON/OFF equals never touching it', async () => {
  const seed = () => ({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  const items = [xPost('x1'), xPost('x2'), xPost('x3')];

  const { app: control } = boot(seed());
  control.ctx.wireApp();
  render(control, items);

  const { app } = boot(seed());
  app.ctx.wireApp();
  render(app, items);
  for (let i = 0; i < 4; i++) assert.equal(tapSwitch(app), 1, `guard: tap ${i + 1} ran no handler`);

  assert.deepEqual(visibleIds(app), visibleIds(control),
    'four taps must leave exactly the screen no taps would have — a lift that removes cards cannot '
    + 'satisfy this, because nothing rebuilds them until the next feed render');
  assert.deepEqual(streamIds(app), streamIds(control), 'and the same DOM, not merely the same visible set');
  assert.equal(badge(app), badge(control));
  assert.equal(gridHidden(app), gridHidden(control));
});

test('TASK-099 T8 (C8): ON — a background classify does not empty the grid (two consecutive classifies)', async () => {
  // GREEN before the fix, and the one test here that is. It guards a defect ONLY decision 1 can
  // introduce: hidden cards are still `#feed .card`, so liftGroupedFromStream drops every one into
  // _liftDeferred, renderGroupGrid skips deferred ids when building `counts`, `counts[gid] > 0`
  // filters every tile out and the grid hides itself. Measured 2026-08-26: tile "3 posts" -> grid
  // empty, with a control confirming _liftDeferred was [] immediately before. It cannot fire on main,
  // where those cards were removed outright and there is nothing left to defer.
  //
  // TWO classifies. NOT because the collapse needs two: for a RETURNING reader — this fixture — the
  // hidden card exists before any classify runs, so the FIRST one already defers it and this test
  // fails at the guard below. Measured; commit 8eb9a48 corrects the task file's original "very next
  // background classify" wording, and this comment used to repeat the error that commit fixed.
  // The second classify stays because it is where a SAME-SESSION reader is hit.
  const { app, bodies } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
    reply: n => (n === 1
      ? [{ label: 'AI news', summary: ['x2 says a thing'], item_ids: ['x2'] }]
      : [{ label: 'AI news', summary: ['x3 says a thing'], item_ids: ['x3'] }]),
  });

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(bodies.length, 1, 'guard: the first classify ran');
  assert.equal(countOn(tileFor(app, G_AI)), '2 posts', 'guard: the first classify filed x2 into the tile');

  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  assert.equal(bodies.length, 2, 'guard: the second classify ran — without it this test asserts nothing');

  assert.equal(gridHidden(app), false,
    'the grouped view must survive a background classify: with the hidden cards falling into '
    + '_liftDeferred, every tile drops out of the grid and the reader loses the view they chose');
  assert.equal(countOn(tileFor(app, G_AI)), '3 posts', 'and the tile still owns all three');
});

// ── The switch and the shine ──────────────────────────────────────────────────

test('TASK-099 T9 (C9): the switch is inert until a topic would ACTUALLY paint a tile', async () => {
  // `Object.keys(getGroupState().groups).length > 0` is not the same question. renderGroupGrid needs
  // `counts[gid] > 0`, which also excludes done, archived, deferred and not-in-hand posts —
  // app.js states outright that "a topic with nothing reachable drops out of the grid entirely". A
  // switch that goes live over that offers the reader a view that would open empty: the same error
  // the design brief correctly avoided for the shine and then made here.
  const { app } = boot({
    grouped: false,
    store: {
      // `x_absent` is assigned but NOT in this render's items. [BUG-098] keeps such an assignment on
      // purpose — absence is not evidence the post is gone — so the topic survives the prune, which
      // is exactly what makes this fixture bite: the group EXISTS while owning nothing showable.
      // An archived post does not work here: prune rule 1 deletes its assignment and then drops the
      // emptied group, so `Object.keys(groups).length` is 0 and the WRONG live test agrees with the
      // right one by accident. Measured — the first version of this test survived M8.
      focus_groups: groupState({ assignments: { x_absent: G_AI }, groups: { [G_AI]: AI_NEWS } }),
    },
  });
  app.ctx.wireApp();

  render(app, [xPost('x2')]);

  assert.ok(Object.keys(JSON.parse(app.get('focus_groups')).groups).includes(G_AI),
    'guard: the topic must SURVIVE the prune, or this test passes because there are no groups at all '
    + 'rather than because the count is right');
  assert.equal(gridHidden(app), true, 'guard: the grid really would paint nothing');
  assert.equal(sw(app).getAttribute('aria-disabled'), 'true',
    'the group exists but owns nothing the reader can be shown, so the switch must stay inert rather '
    + 'than opening an empty view');
});

test('TASK-099 T10a (C10): the bloom fires when a classify places a post into a showable tile', async () => {
  const { app, bodies } = boot({
    grouped: false,
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();

  assert.equal(bodies.length, 1, 'guard: the classify ran');
  assert.equal(sw(app).getAttribute('aria-disabled'), 'false', 'the switch goes live — there is now a tile to show');
  assert.equal(sw(app).classList.contains('is-shining'), true,
    'a classify that gave a post a home the reader can be shown must announce it');
});

test('TASK-099 T10b (C10): no bloom on a quiet open — nothing new was classified', async () => {
  // The cache-only paint. `changed` is the wrong signal on its own, but this case does not even
  // reach it: updateGroupsForFeed returns early when newItems is empty. The switch must still be
  // LIVE — there is a real tile — and that half is what stops this test passing vacuously against a
  // switch that has no attributes at all.
  const { app, bodies } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();

  assert.equal(bodies.length, 0, 'guard: nothing was new, so no classify ran');
  assert.equal(sw(app).getAttribute('aria-disabled'), 'false', 'the switch is live: the tile is real and paintable');
  assert.equal(sw(app).classList.contains('is-shining'), false,
    'nothing new arrived, so there is nothing to announce — the bloom must not fire on a cache paint');
});

test('TASK-099 T10c (C10): no bloom when every post the classify placed was deferred', async () => {
  // The [BUG-047] G5 shape, and the reason the design fragment's version of this guard CANNOT FAIL:
  // it computes `showable` BEFORE the lift, and no newItems id can be in _liftDeferred at that point
  // (_liftDeferred only ever receives ids that ARE assignment keys, and is cleared each render). The
  // filter reads as protection and is vacuous by construction.
  //
  // Here x2 is a [TASK-096] sticky post: examined once, unplaceable, so rendered VISIBLE. When a
  // later classify finally places it, [BUG-092]'s deferral keeps it in the stream — so the tile
  // cannot show it, and announcing a topic over it would be a promise the grid does not keep.
  const { app, bodies } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS }, unfiled: ['x2'] }) },
    reply: [{ label: 'AI news', summary: ['x2 says a thing'], item_ids: ['x2'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  assert.equal(bodies.length, 1, 'guard: the classify ran');
  assert.deepEqual(visibleIds(app), ['x2'],
    'guard: the sticky post is still on screen — deferred, not lifted, exactly as [BUG-092] requires');
  assert.equal(sw(app).getAttribute('aria-disabled'), 'false', 'guard: the switch is live, so a bloom was possible');
  assert.equal(sw(app).classList.contains('is-shining'), false,
    'every post this classify placed was deferred, so the grid gained nothing the reader can open');
});

// ── State and side effects ────────────────────────────────────────────────────

test('TASK-099 T12 (C12): the view is device-local — it survives a reload and never reaches the wire', async () => {
  const { app } = boot({
    grouped: null,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  assert.equal(app.get('focus_group_view'), null, 'guard: a fresh browser has no view key — absent means ungrouped');
  // A paintable topic, so the switch is LIVE and the tap is not swallowed by the inert guard (C9).
  render(app, [xPost('x1'), xPost('x2')]);
  assert.equal(sw(app).getAttribute('aria-disabled'), 'false', 'guard: an inert switch would swallow the tap');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');

  assert.equal(app.get('focus_group_view'), 'on', 'the tap persists the choice');
  assert.equal(app.get('focus_dirty'), null,
    'a VIEW preference must never arm the sync: SK.dirty is what raises [BUG-047]\'s '
    + '"Not syncing — this device has changes the saved copy doesn\'t", and flipping a view must not');
  assert.deepEqual(app.toasts, [], 'and it must not tell the reader anything about syncing');
  for (const r of app.requests) {
    if (!r.url.includes('/api/state')) continue;
    assert.ok(!String(r.init.body || '').includes('focus_group_view'),
      `the view key reached the wire: ${r.init.body}`);
  }

  // A reload is a fresh boot over the same store.
  const { app: reloaded } = boot({ store: Object.fromEntries(app.store) });
  reloaded.ctx.wireApp();
  render(reloaded, [xPost('x1'), xPost('x2')]);
  assert.equal(sw(reloaded).getAttribute('aria-checked'), 'true', 'the same device comes back grouped');

  // A DIFFERENT device on the same account: same synced state, no view key.
  const { app: other } = boot({
    grouped: null,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  other.ctx.wireApp();
  render(other, [xPost('x1'), xPost('x2')]);
  assert.equal(sw(other).getAttribute('aria-checked'), 'false',
    'another device must be unaffected — the key is device-local, so ungrouped-first still holds there');
});

test('TASK-099 T13 (C13): signing out clears the view key', async () => {
  // Device-local means "not uploaded", NOT "survives account deletion". The default for a forgotten
  // key is to SURVIVE a sign-out, which is [BUG-017]'s exact shape — the next account on this
  // browser inheriting the previous person's setup.
  const app = createApp({
    store: { ...SIGNED_IN, focus_group_view: 'on' },
    fetch: async (url, init) => {
      if (String(url).includes('/api/state') && (init.method || 'GET') === 'PUT') return { ok: true, status: 200, json: async () => ({}) };
      if (String(url).includes('/api/state')) return { ok: true, status: 200, json: async () => ({ state: {}, updatedAt: '2026-01-01T00:00:00.000Z' }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(app.get('focus_group_view'), 'on', 'guard: the key really was seeded, so this assertion can fail');
  await app.ctx.syncOnLoad();

  await app.ctx.signOut();

  assert.equal(app.get('focus_group_view'), null, 'the view key must not outlive the account that chose it');
});

test('TASK-099 T14 (C14/BUG-103): ON — un-archiving a grouped post produces exactly one card', async () => {
  const { app } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle(); // let the classify finish, so the unassigned post is no longer held
  assert.equal(badge(app), '3 new', 'guard: one stream card plus two in the tile');
  assert.deepEqual(visibleIds(app), ['x3'], 'guard: grouped — only the unassigned post is on screen');

  // Archive x1 where a grouped post is now reachable: on its topic card's rail, with no drill-in to
  // open or close. That is [TASK-098]'s point — the post was always one tap away behind a view.
  actOnRail(app, G_AI, 'x1', '.btn-archive');

  // Un-archive it. The assignment OUTLIVES the archive — pruneGroupState rule 1 only fires at the
  // next syncGroupPrune, which runs from renderFeedResults, and no path from archiving to
  // un-archiving triggers a feed render.
  app.ctx.openArchiveView();
  const archCard = app.el('archive-feed').children.find(c => c.dataset.id === 'x1');
  assert.ok(archCard, 'guard: the post must actually be in the archive');
  archCard.querySelector('.btn-archive').listeners.filter(l => l.type === 'click').forEach(l => l.fn());
  app.runTimers(4);

  assert.equal(streamIds(app).filter(id => id === 'x1').length, 1,
    'exactly ONE card for the post. insertIntoFeed never checks whether a card for that id is already '
    + 'present, and under hide-not-remove one is — hidden. Measured on the design fragment: '
    + '#feed ids [x1, x2, x1], badge "5 new" over two real posts');
  assert.deepEqual(visibleIds(app), ['x3'],
    'and it is placed correctly for the CURRENT view: the reader is grouped, so it belongs in its tile');
  assert.equal(countOn(tileFor(app, G_AI)), '2 posts', 'the tile count is right again');
  // see the note on T6's badge above — invariant under the toggle; this pins the COUNT, not the flip
  assert.equal(badge(app), '3 new',
    'the badge must not double-count. On main today an un-archived grouped post sits in the '
    + 'chronological stream AND in its tile at once — measured, badge "3 new" over two real posts');
});

test('TASK-099 T14b (C14/BUG-103): OFF — un-archiving returns exactly one VISIBLE card', async () => {
  const { app } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2')]);
  assert.deepEqual(visibleIds(app), ['x1', 'x2'], 'guard: both posts are on screen while grouping is off');

  const card = app.el('feed').children.find(c => c.dataset.id === 'x1');
  card.querySelector('.btn-archive').listeners.filter(l => l.type === 'click').forEach(l => l.fn());
  app.runTimers(4);
  assert.deepEqual(visibleIds(app), ['x2'], 'guard: archiving really removed it from the stream');

  app.ctx.openArchiveView();
  const archCard = app.el('archive-feed').children.find(c => c.dataset.id === 'x1');
  assert.ok(archCard, 'guard: the post must actually be in the archive');
  archCard.querySelector('.btn-archive').listeners.filter(l => l.type === 'click').forEach(l => l.fn());
  app.runTimers(4);

  assert.equal(streamIds(app).filter(id => id === 'x1').length, 1, 'exactly one card for the post');
  assert.deepEqual(visibleIds(app).sort(), ['x1', 'x2'],
    'un-archiving into the ungrouped view returns a VISIBLE card, not one hidden behind its assignment');
  assert.equal(badge(app), '2 new', 'and the badge counts the two posts once each');
});

test('TASK-099 T15 (C15): every classify emits one group_classify event carrying both counts', async () => {
  // [CHR-012]'s one-line instrument. Every absolute backlog figure on record today is synthetic, so
  // this is the first real measurement of how big a groupable backlog actually gets. It is evidence
  // for TASK-099's own deferred N threshold — NOT, as an earlier version of this comment claimed, a
  // thing that unblocks [TASK-097] (scoped to re-sending stuck posts) or [TASK-090] (blocked on a
  // real 50-70-post corpus). Both numbers are already in hand where the classify starts.
  const { app, bodies } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
    reply: [{ label: 'AI news', summary: ['x2 says a thing'], item_ids: ['x2'] }],
  });

  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  assert.equal(bodies.length, 1, 'guard: the classify ran');

  const fired = events(app).filter(e => e.name === 'group_classify');
  assert.equal(fired.length, 1, 'exactly one event per classify — no more, no less');
  assert.equal(fired[0].section, 'group', 'filed under the group section, like every other grouping event');
  assert.equal(fired[0].props.new, 2, 'the genuinely-new posts this classify was asked to place (x2, x3)');
  assert.equal(fired[0].props.total, 3,
    'and the TOTAL groupable-unread backlog (x1, x2, x3) — without both numbers the ratio is '
    + 'unrecoverable and the event answers a different question');
});

// ── Guards the battery found unpinned ─────────────────────────────────────────
// Each of these exists because a mutation SURVIVED. The T14 pair is the sharper lesson: `insertIntoFeed`'s
// de-duplication and `archiveInGroup`'s cleanup each stop the same duplicate, so a test that exercises
// both pins NEITHER — CLAUDE.md's "size the fixture so only the guard under test can fire", measured
// rather than recited. T14 killed neither M13 nor M14 while reading as full coverage of [BUG-103].

test('TASK-099 T14c (C14/BUG-103): archiving from the rail leaves no card behind', async () => {
  // Pins archiveInGroup ALONE — the upstream cause. No insertIntoFeed involved, so its de-duplication
  // cannot stand in for this.
  const { app } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  assert.deepEqual(streamIds(app), ['x1', 'x2', 'x3'], 'guard: the hidden cards really are in the DOM');

  actOnRail(app, G_AI, 'x1', '.btn-archive');

  assert.equal(streamIds(app).filter(id => id === 'x1').length, 0,
    'the hidden stream card is a SECOND HOME for the post, so archiving must take it too — leaving it '
    + 'orphans a node that the next un-archive turns into a duplicate');
});

test('TASK-099 T14d (C14/BUG-103): insertIntoFeed never adds a second card for a post already there', async () => {
  // Pins insertIntoFeed ALONE — the safety net. Driven directly, because every reachable route to it
  // now goes through archiveInGroup, whose cleanup would mask this guard entirely.
  const { app } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  assert.equal(streamIds(app).filter(id => id === 'x1').length, 1, 'guard: exactly one (hidden) card to begin with');

  app.ctx.insertIntoFeed(xPost('x1'));

  assert.equal(streamIds(app).filter(id => id === 'x1').length, 1,
    'one card, not two: appending blind puts the post in the stream AND its tile at once');
  assert.deepEqual(visibleIds(app), ['x3'], 'and it is still placed for the grouped view');
  assert.equal(badge(app), '3 new', 'and the badge does not gain a phantom post');
});

test('TASK-099 T16 (re-pointed, [TASK-098]): "Posts" does not label a section showing nothing', async () => {
  // ⚠️ THE REQUIREMENT REVERSED, deliberately, and this test asserted the OLD half. It used to
  // demand that "Posts" HIDE when every stream card belongs to a tile — correct while the tiles sat
  // under their own "Topics" head above the feed. [TASK-098] criterion 6 makes "Posts" the only head
  // over ONE stream, so a feed of only topic cards must now SHOW it. That half is pinned by
  // group-topic-card T6. Rewritten rather than deleted, on Asli's call (2026-08-29), because this
  // test pinned something T6 cannot see.
  //
  // WHAT IT PINS NOW: the `:not(.grouped-out)` exclusion in `updateSectionHeads` — its original M1.
  // That exclusion went LOOSE in this task: the new condition is the `.card` term OR the
  // `.topic-card` term, so wherever topics paint the second satisfies it alone and the first cannot
  // be falsified. The fixture is sized so ONLY the `.card` term can answer, which is CLAUDE.md's
  // "size the fixture so only the guard under test can fire" applied to a guard this change weakened.
  //
  // The state is an assignment whose GROUP RECORD is absent — a pruned topic whose assignments have
  // not been swept yet. Measured before being written down: 0 topic cards, 1 `.grouped-out` card.
  const { app } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: {} }) },
  });
  render(app, [xPost('x1')]);
  await settle();

  assert.equal(app.queryAll('#feed .topic-card').length, 0,
    'guard: NO topic card may paint here, or the `.topic-card` term answers and the exclusion under '
    + 'test is unreachable');
  assert.equal(app.queryAll('#feed .card.grouped-out').length, 1,
    'guard: …while the post IS in the DOM, hidden — so the only thing that can show the head is the '
    + '`.card` term counting a card the reader cannot see');
  assert.deepEqual(visibleIds(app), [], 'guard: the screen really is empty');

  assert.equal(app.el('videos-head').classList.contains('hidden'), true,
    '"Posts" must not label a section with nothing under it. Dropping `:not(.grouped-out)` from '
    + 'updateSectionHeads shows the head over an empty screen');
});

// ── Review remediation, 2026-08-27 ────────────────────────────────────────────
// Both found by an independent reviewer driving the harness, and both are the SAME root cause the
// review named: the nine-site audit enumerated every selector that READS `#feed` and missed the
// WRITERS. Under hide-not-remove a post has two homes, so the question is not "who counts cards" but
// "who takes a post out of its tile".

test('TASK-099 T17: toggling the view on the caught-up screen does not resurrect the feed', async () => {
  // `markAllDone` deliberately does NOT destroy the cards — `showCaughtUp` only hides `#feed`, so
  // Undo can reveal them again. `applyGroupView` then called `closeGroupDetail()` unconditionally,
  // and that does `feed.style.display = ''`, so one tap un-hid a feed of already-read posts and
  // repainted the badge over "all caught up ✓".
  const { app } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();

  app.ctx.markAllDone();
  app.runTimers(4);
  assert.equal(app.el('caughtup').classList.contains('hidden'), false, 'guard: the reader is caught up');
  assert.equal(badge(app), 'all caught up ✓', 'guard: and the badge says so');
  assert.deepEqual(JSON.parse(app.get('focus_done')).sort(), ['x1', 'x2', 'x3'], 'guard: all three are read');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');

  assert.equal(app.el('caughtup').classList.contains('hidden'), false,
    'the caught-up screen must survive a view toggle — the posts are read either way');
  assert.equal(app.el('feed').style.display, 'none',
    '`#feed` is hidden ON PURPOSE here, with its cards still in the DOM for Undo; un-hiding it puts '
    + 'a screenful of already-read posts back in front of the reader');
  assert.equal(badge(app), 'all caught up ✓',
    'and the badge must not be repainted as "N new" from cards whose posts are all done');
});

test('TASK-099 T18: a post marked done on the rail does not come back when the view flips', async () => {
  // The THIRD writer ([TASK-074]'s per-post Done), absent from the nine-site audit entirely.
  // `markGroupDone` sweeps the hidden stream card and `archiveInGroup` was fixed to; this one was
  // not, so the orphan survived and `setGroupedCardsHidden` un-hid it on the next OFF.
  const { app } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  assert.equal(badge(app), '3 new', 'guard: one visible post plus two in the tile');

  actOnRail(app, G_AI, 'x1', '.btn-done');
  assert.deepEqual(JSON.parse(app.get('focus_done')), ['x1'], 'guard: the post really was marked done');
  assert.equal(badge(app), '2 new', 'guard: and the badge dropped');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');

  assert.equal(visibleIds(app).includes('x1'), false,
    'a post the reader explicitly marked done must not reappear in the chronological feed');
  assert.equal(badge(app), '2 new', 'and it must not be counted as unread again');
});

test('TASK-099 T19 (C4): toggling OFF mid-classify reveals the cards it was holding', async () => {
  // Criterion 4 says "no element carries `grouping-pending` at ANY point while off". `renderFeedResults`
  // gates the hold on `isGrouped()`, but a card held while ON stayed held after the reader flipped OFF —
  // only `updateGroupsForFeed`'s tail reveals it, up to 4.4-10.3s later. That is the exact hold this
  // task exists to stop the default path paying.
  const { app } = boot({ grouped: true });
  app.ctx.wireApp();
  // A classify that never resolves: the reader taps the switch while it is still in flight.
  app.setFetch((url) => String(url).includes('/api/group')
    ? new Promise(() => {})
    : Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.deepEqual(heldIds(app).sort(), ['x1', 'x2'], 'guard: both posts are held while the classify runs');

  // The switch is inert with no topics yet, so drive the view change the way the handler does.
  app.ctx.setGrouped(false);
  app.ctx.applyGroupView();

  assert.deepEqual(heldIds(app), [],
    'nothing may stay held once the reader is in the ungrouped view — the classify that would have '
    + 'revealed them has not come back yet, and may not for another 10 seconds');
  assert.deepEqual(visibleIds(app).sort(), ['x1', 'x2'], 'and both posts are readable');
});

test('TASK-099 T20: "Mark N done" takes the hidden stream cards with it', async () => {
  // `markGroupDone`'s stream-card lookup was DEAD CODE before this task (an assigned post had no
  // stream card at all) and `mutations/BUG-092.mjs` M32/M33 declare themselves survivors on exactly
  // that premise. [TASK-099] falsified it: every assigned post now has a hidden card, so the lookup
  // is the only thing stopping "Mark N done" leaving orphans that the next toggle un-hides as unread.
  // Measured by review: breaking the lookup survived all 847 tests.
  const { app } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  assert.deepEqual(streamIds(app), ['x1', 'x2', 'x3'], 'guard: the two filed posts are in the DOM, hidden');

  app.ctx.markGroupDone(G_AI);
  app.runTimers(4);
  assert.deepEqual(JSON.parse(app.get('focus_done')).sort(), ['x1', 'x2'], 'guard: both really were marked done');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  assert.deepEqual(visibleIds(app), ['x3'],
    'neither post may return to the chronological feed — they were read, and the hidden card is the '
    + 'only place they could come back from');
  assert.equal(badge(app), '1 new', 'and only the unread post is counted');
});

// ── The switch's own gate ─────────────────────────────────────────────────────
// Review finding 8: `T9` asserts the `aria-disabled` ATTRIBUTE and never the REFUSAL, so deleting
// the click handler's explicit guard survived all 851 tests — the tap went through on an inert
// switch and persisted `'on'`. CLAUDE.md's rule is to ATTACK the gate, not to check that the right
// view rendered; an advisory attribute is not a gate, the `return` under it is.

test('TASK-099 T21: a tap on an INERT switch is refused, not merely discouraged', async () => {
  // T9's fixture: the topic survives the prune while owning nothing showable, so the grid would
  // paint no tile and the switch is inert. `aria-disabled` is advisory — it stops no click in a real
  // browser — so the only thing standing between the reader and an empty grouped view is the guard
  // inside the handler. This test is GREEN BEFORE the change (the guard exists); it is here to be
  // killed by the mutation that deletes it, and is declared rather than counted as new coverage.
  const { app } = boot({
    grouped: false,
    store: {
      focus_groups: groupState({ assignments: { x_absent: G_AI }, groups: { [G_AI]: AI_NEWS } }),
    },
  });
  app.ctx.wireApp();

  render(app, [xPost('x2')]);

  assert.equal(sw(app).getAttribute('aria-disabled'), 'true',
    'guard: the switch must really be inert here, or the tap below is allowed to work and this test '
    + 'passes for the wrong reason');
  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired, so the refusal below is a no-op');

  assert.notEqual(app.get('focus_group_view'), 'on',
    'the tap must not persist the grouped view — a reader who taps an inert switch and reloads would '
    + 'otherwise come back into a view they were told they could not enter');
  assert.equal(gridHidden(app), true, 'and the reader must not be moved into a grid that paints nothing');
});

test('TASK-099 T22: while ON, the way out is always open — even with nothing left to group', async () => {
  // Review finding 9, DECIDED (Asli, 2026-08-27): "always allow turning off". `syncGroupingToggle`
  // computed `live` from `paintableTileCount()` alone, regardless of the switch's own state, so
  // "nothing to switch INTO" and "no way to switch OUT OF" were one state. A reader whose topics all
  // went done, archived or out-of-hand — or whose X posts stopped arriving at the plan's post cap
  // ([BUG-024], a 502 that reaches exactly this) — was left holding a dead switch in a view they did
  // not want. The cost of the fix was CHECKED, not assumed: `aria-disabled` gates only the click, the
  // classify runs eagerly regardless of view, and the key is device-local with no `schedulePush`, so
  // a toggle makes zero network calls and zero API spend.
  const { app } = boot({
    grouped: true,
    store: {
      focus_groups: groupState({ assignments: { x_absent: G_AI }, groups: { [G_AI]: AI_NEWS } }),
    },
  });
  app.ctx.wireApp();

  render(app, [xPost('x2')]);

  assert.ok(Object.keys(JSON.parse(app.get('focus_groups')).groups).includes(G_AI),
    'guard: the topic must survive the prune, or `live` is false for a reason this test is not about');
  assert.equal(gridHidden(app), true, 'guard: there really is nothing paintable to switch into');

  assert.equal(sw(app).getAttribute('aria-disabled'), 'false',
    'the reader is IN the grouped view, so the switch must stay operable whatever the grid holds — '
    + 'inert is for "nothing to switch into", never for "no way back"');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  assert.equal(app.get('focus_group_view'), 'off',
    'and the tap must actually get them out — the attribute is advisory, the refusal is the gate');
  assert.deepEqual(visibleIds(app), ['x2'], 'the plain chronological feed is what they land back on');
});

// ── Hide-not-remove, for the ONLY branch that can reach it ────────────────────
// Review finding 4: `liftGroupedFromStream`'s hide could revert to `remove()` with all 851 green.
// That line IS decision 1 (2026-08-26) — the property the whole toggle rests on. `T7`'s idempotence
// fixture starts OFF with assignments ALREADY in state, so its cards are never `grouping-pending`
// and never reach this branch; the only way in is a post that was unassigned when it rendered and
// was classified DURING the session. Nothing covered that, so the branch was free to change meaning.
//
// WHAT T23 DOES NOT PIN, measured by an independent battery 2026-08-27 and recorded so this test is
// not over-credited: it kills the hide->remove revert because `remove()` destroys the NODE, not
// because the class was wrong. A defect in this branch that only writes (or fails to write)
// `.grouped-out` is INVISIBLE here — `setGroupedCardsHidden()` recomputes that class from scratch on
// the very next line of `updateGroupsForFeed`'s tail, erasing it. Adding `.grouped-out` to the
// DEFERRAL branch — yanking a card the reader is mid-read, [BUG-092]'s exact subject — survives the
// whole suite for that reason. So "T23 covers decision 1" is too strong: it covers the node.

test('TASK-099 T23: a post classified MID-SESSION is hidden, not removed — so OFF gets it back', async () => {
  // GREEN BEFORE the change, like T21: the code already hides. This closes a coverage gap rather
  // than a defect, so it is declared here and proved by the mutation that reverts the hide — a green
  // T23 on its own is not evidence of anything.
  const { app, bodies } = boot({
    grouped: true,
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  // Neither post is assigned at render time. That is what makes x1 take the `grouping-pending` hold
  // and, once the classify places it, the pending branch of the lift — the branch under test. A
  // fixture that seeds the assignment lands in the DEFERRAL branch instead and pins nothing here.
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  assert.equal(bodies.length, 1, 'guard: the classify ran, so a post really was placed mid-session');
  assert.equal(JSON.parse(app.get('focus_groups')).assignments.x1, G_AI,
    'guard: x1 was placed by THIS session\'s classify, not by the fixture');

  assert.deepEqual(streamIds(app), ['x1', 'x2'],
    'the card must still BE there — removing it is the defect, and it looks identical to hiding it '
    + 'until the reader asks for the plain feed back');
  assert.deepEqual(visibleIds(app), ['x2'], 'and it must be hidden while grouping is on');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  assert.deepEqual(visibleIds(app), ['x1', 'x2'],
    'turning grouping off must return the post it filed — a removed card is not rebuilt until the '
    + 'next feed load, so the reader would be left staring at a stream missing posts they never read');
  assert.equal(badge(app), '2 new',
    'and the badge must count both. Unlike T6/T14 this one CAN fail: a removed card is gone from the '
    + 'stream and the OFF gate returns no grouped ids, so the post is counted nowhere at all');
});

// ── What the toggle repaints that is NOT invariant ────────────────────────────
// Review finding 12 is CONFIRMED and narrower than it first reads: the badge cannot fail on a toggle
// defect, because the stream and the grid PARTITION the unread set — an assigned, in-hand, unread
// post is a visible card while OFF and a tile entry while ON, contributing exactly one either way,
// and an out-of-hand assignment contributes nothing in both. Criterion 6's badge clause is therefore
// satisfied by arithmetic, and `T6`/`T14`'s badge lines cannot bite on a view flip. They are kept
// (they DO kill a counting defect — the TASK-099 battery's M3 drops updateCount's `.grouped-out`
// exclusion and T6 catches it) but they are not evidence for criterion 6, and are annotated as such.
//
// Measuring that claim found something the finding did not name. The SECTION HEADINGS are not
// invariant the way the badge is: "Posts" must vanish when the flip hides the last stream card and
// come back when it returns, and nothing asserted that. T16 was written for those headings but
// renders in grouped mode WITHOUT ever tapping the switch, so it pins the exclusion inside
// `updateSectionHeads` and nothing about the flip.
//
// Two things this test does NOT claim, both measured rather than reasoned (2026-08-27), because a
// first and a second prediction about it were both wrong:
//   - It does not pin `updateCount()`'s presence in `applyGroupView`. Dropping that call SURVIVES
//     even with this test, and so does removing `renderGroupGrid`'s own heading repaint. The repaint
//     is DOUBLY IMPLEMENTED — renderGroupGrid calls updateSectionHeads on all three of its exits and
//     applyGroupView then calls updateCount, which calls it again — so each site alone suffices and
//     no single-site mutation can be killed. Two guards masking each other pin neither.
//   - It is nonetheless NOT vacuous: neutering the mechanism both sites share kills it
//     (`mutations/TASK-099-item4.mjs` M3). What it pins is the OUTCOME the reader sees, which is the
//     right thing for it to assert; what it cannot pin is which of the two paths delivered it.

test('TASK-099 T24 (re-pointed, [TASK-098]): the one head stays correct across a view flip', async () => {
  // Re-pointed on Asli's call (2026-08-29). The original watched TWO headings trade places across the
  // toggle; [TASK-098] leaves one, and what it pins now is narrower — said plainly rather than dressed
  // up, because the honest limit is the interesting part:
  //
  //   THIS TEST CANNOT DETECT A DROPPED REPAINT, and no fixture can. Making the switch LIVE requires
  //   `paintableTileCount() > 0` ([TASK-099] T9's inertness rule), which means a topic that actually
  //   paints — so the grouped view has a topic card and the ungrouped view has the posts, and "Posts"
  //   is SHOWN either way. The answer is invariant, so `updateSectionHeads` failing to run during a
  //   flip is unobservable through the head. My first rewrite tried to dodge that with an assignment
  //   carrying no group record; the switch was inert for exactly the same reason and the test failed
  //   on its own guard, which is how the invariance was found rather than assumed.
  //
  //   What still bites: a head WRONG in either view. T16 above pins the empty-section direction;
  //   group-topic-card T6 pins the topic-cards-only direction. This one pins that a flip in either
  //   direction leaves neither of those broken — which is where the original two-heading version
  //   caught real defects, and the only part of it that survives one stream.
  const { app } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  const postsHead = () => !app.el('videos-head').classList.contains('hidden');
  assert.equal(postsHead(), true, 'guard: ungrouped, both posts are on screen under "Posts"');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  assert.equal(app.queryAll('#feed .topic-card').length, 1,
    'guard: the flip really did group them — otherwise the assertion below is about the OFF view twice');
  assert.deepEqual(visibleIds(app), [], 'guard: and every post card is hidden behind its topic card');
  assert.equal(postsHead(), true,
    '"Posts" heads a stream of topic cards too. Hiding it here is the criterion-6 defect: it asks '
    + '#feed for a `.card` the topic deliberately is not, and labels a full screen as empty');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  assert.equal(app.queryAll('#feed .topic-card').length, 0, 'guard: and back to the plain stream');
  assert.equal(postsHead(), true, 'and it still heads the posts it started over');
});

// ── The writer nobody followed: Undo ──────────────────────────────────────────
// Review round 2 (2026-08-27), and a direct continuation of round 1's root cause. Round 1 found the
// audit had enumerated the selectors that READ `#feed` and missed the WRITERS. The fix then
// enumerated the writers — and stopped at the Done action without following the UNDO that action
// offers. `markDoneInGroup` is the one writer whose Undo does not restore the second home; every
// sibling does (`markDone` calls insertIntoFeed, `markGroupDone` calls refreshFeed, `markAllDone`
// never destroys its cards). It takes `item` as a parameter and never uses it.

/** Press the Undo on the live toast. `btn.onclick` is what showToast assigns. */
const pressUndo = (app) => app.el('toast').querySelector('.toast-action').onclick();

/** Press Done on one post of G_AI's rail, the way [TASK-074]'s per-post control does. */
const doneOnRail = (app, id) => actOnRail(app, G_AI, id, '.btn-done');

test('TASK-099 T25: Undo after a rail Done returns the post to BOTH homes', async () => {
  const { app } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  assert.equal(badge(app), '3 new', 'guard: one visible post plus two in the tile');

  doneOnRail(app, 'x1');
  assert.deepEqual(JSON.parse(app.get('focus_done')), ['x1'], 'guard: the post really was marked done');

  pressUndo(app);
  app.runTimers(4);
  assert.deepEqual(JSON.parse(app.get('focus_done')), [], 'guard: Undo really un-marked it');

  assert.ok(streamIds(app).includes('x1'),
    'the hidden stream card must come back too. The Done destroyed it — correctly, that was the '
    + 'round-1 fix — so an Undo that only restores the tile leaves the post in NEITHER home');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  assert.ok(visibleIds(app).includes('x1'),
    'and it must be readable in the plain feed. In the DEFAULT ungrouped view the grid contributes '
    + 'nothing to the count, so a missing card is not merely invisible — the post is uncounted and '
    + 'unreachable until a pull-to-refresh, while still unread');
  assert.equal(badge(app), '3 new', 'the badge counts it again — Undo means the post is unread once more');
});


// ── Round-2 coverage gaps, all found by an independent mutation battery ───────
// None of the four below was a live defect: the code was already correct and NOTHING IN THE SUITE
// COULD TELL. Each is declared GREEN BEFORE, and each is proved to bite by `mutations/TASK-099-item6.mjs`.

test('TASK-099 T27 (C12): flipping the view never arms the sync — with a control that proves it could', async () => {
  // T12 asserts this too, and CANNOT FAIL: `schedulePush` writes SK.dirty only `if (_stateLoaded)`,
  // and T12 never calls `syncOnLoad`, so `focus_dirty === null` holds there no matter what
  // `setGrouped` does. Measured: adding `schedulePush()` to setGrouped survives the whole suite.
  // That is the [BUG-047] G5 shape — a guard present and ineffective — living in the TEST.
  // The group state is seeded into the SERVER ROW, not only into localStorage. `syncOnLoad` applies
  // the row over local state, so a fixture seeded only locally is ERASED by the very call this test
  // needs — the switch then goes inert for want of a tile and the tap is swallowed. That is
  // CLAUDE.md's "any local state you WRITE before a reload is provisional", which is written for the
  // RESTORE case and bites a SEEDED FIXTURE identically. Caught here by the aria-disabled guard.
  const SEEDED = groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } });
  const app = createApp({
    // `focus_channels` OVERRIDDEN, not inherited: SIGNED_IN carries a YouTube channel only, and the
    // prune drops an assignment whose post belongs to a channel the reader no longer follows — so
    // x1's assignment was swept during the render, the grid painted nothing and the switch went
    // inert. Diagnosed by probing the state after the render, not by reading the fixture.
    store: {
      ...SIGNED_IN,
      focus_channels: JSON.stringify([{ id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' }]),
      focus_groups: SEEDED,
    },
    fetch: async (url, init) => {
      if (String(url).includes('/api/state') && (init?.method || 'GET') === 'PUT') return { ok: true, status: 200, json: async () => ({}) };
      if (String(url).includes('/api/state')) return { ok: true, status: 200, json: async () => ({ state: { focus_groups: SEEDED }, updatedAt: '2026-01-01T00:00:00.000Z' }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  app.ctx.wireApp();
  await app.ctx.syncOnLoad();   // ← the precondition T12 lacks: without it SK.dirty is unreachable

  render(app, [xPost('x1'), xPost('x2')]);
  assert.equal(sw(app).getAttribute('aria-disabled'), 'false', 'guard: an inert switch would swallow the tap');

  // The RENDER legitimately arms the sync on its own: `syncGroupPrune` rewrites `focus_groups`, a
  // synced key, so `focus_dirty` is already "1" here. Measured — without this clear, the assertion
  // below reads the PRUNE's write and reports a confident failure about the toggle. Clear it so the
  // only thing that can arm the sync afterwards is the tap.
  assert.equal(app.get('focus_dirty'), '1', 'guard: the render armed it, which is correct and not what this test is about');
  app.store.delete('focus_dirty');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  assert.equal(app.get('focus_group_view'), 'on', 'guard: the tap really did flip the view');

  assert.equal(app.get('focus_dirty'), null,
    'a VIEW preference must never arm the sync: SK.dirty is what raises [BUG-047]\'s "Not syncing — '
    + 'this device has changes the saved copy doesn\'t", and flipping a view must never say that');

  // THE CONTROL. Without it the assertion above is the same vacuous check T12 makes. A genuinely
  // synced write in THIS fixture must set dirty — if it does not, _stateLoaded is off and the
  // assertion above proves nothing at all.
  app.ctx.addDone('ctrl');
  assert.equal(app.get('focus_dirty'), '1',
    'control: a synced write MUST arm the sync here, or this test is measuring an unloaded store '
    + 'rather than the view key');
});

test('TASK-099 T28 (C9): a tap repaints the switch, in both directions', async () => {
  // `applyGroupView` ends with `syncGroupingToggle()`, and deleting that call survived all 856 tests:
  // the key flipped, the feed reorganised, and the switch stayed visually off. The task said the
  // switch's appearance "cannot be tested at all" — true of the BLOOM, but `is-on` and `aria-checked`
  // are a class and an attribute on an element the harness memoises. Only the animation is untestable.
  const { app } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2')]);

  assert.equal(sw(app).classList.contains('is-on'), false, 'guard: it starts off, like the view');
  assert.equal(sw(app).getAttribute('aria-checked'), 'false', 'guard: and says so');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  assert.equal(sw(app).classList.contains('is-on'), true,
    'the knob must move with the view — a control that does not respond to a tap reads as broken, '
    + 'and the feed reorganising underneath an unmoved switch reads as a bug in the feed');
  assert.equal(sw(app).getAttribute('aria-checked'), 'true', 'and a screen reader must hear it too');

  assert.equal(tapSwitch(app), 1, 'guard: the switch was never wired');
  assert.equal(sw(app).classList.contains('is-on'), false, 'and back');
  assert.equal(sw(app).getAttribute('aria-checked'), 'false', 'and back');
});

test('TASK-099 T29 (C10): the bloom is consumed — once by the paint, once by the reader', async () => {
  const { app } = boot({
    grouped: false,
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();
  render(app, [xPost('x1')]);
  await settle();
  assert.equal(sw(app).classList.contains('is-shining'), true, 'guard: the bloom must have fired at all');

  // The animation runs three breaths and stops. Clear the class the way the end of the animation
  // leaves it, then give the switch another ordinary paint with nothing new to announce.
  sw(app).classList.remove('is-shining');
  render(app, [xPost('x1')]);
  await settle();
  assert.equal(sw(app).classList.contains('is-shining'), false,
    'a bloom already shown must not fire again on the next paint — `_shineArmed` is consumed BY the '
    + 'paint, or the switch pulses gold forever and the signal stops meaning "something is ready"');

  // And the other consumer: a tap means the reader has seen the news, whichever way they went.
  const { app: b } = boot({
    grouped: false,
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  b.ctx.wireApp();
  render(b, [xPost('x1')]);
  await settle();
  assert.equal(sw(b).classList.contains('is-shining'), true, 'guard: armed and shown');

  assert.equal(tapSwitch(b), 1, 'guard: the switch was never wired');
  assert.equal(sw(b).classList.contains('is-shining'), false, 'a tap consumes the bloom immediately');
  render(b, [xPost('x1')]);
  await settle();
  assert.equal(sw(b).classList.contains('is-shining'), false, 'and it does not return on the next paint');
});

test('TASK-099 T30 (C10): no bloom when the classify placed nothing NEW', async () => {
  // Criterion 10's FIRST clause. T10c pins the deferred term; the `Object.hasOwn` term was unpinned,
  // so the switch could bloom over a classify that placed none of the posts it was sent. This is the
  // realistic shape: the model echoes back an existing topic, described by a post it already owns.
  const { app, bodies } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
    reply: [{ label: 'AI news', summary: ['about x1, which this topic already had'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  assert.equal(bodies.length, 1, 'guard: the classify ran');
  assert.deepEqual(bodies[0].items.map(i => i.id), ['x2'], 'guard: x2 is the only NEW post it was sent');
  assert.equal(Object.hasOwn(JSON.parse(app.get('focus_groups')).assignments, 'x2'), false,
    'guard: and the reply placed it nowhere — that is the whole premise');
  assert.equal(sw(app).getAttribute('aria-disabled'), 'false',
    'guard: a tile IS paintable, so `live` is true and the bloom is free to fire — without this the '
    + 'assertion below passes because nothing could shine, not because nothing should');

  assert.equal(sw(app).classList.contains('is-shining'), false,
    'the bloom announces that topics gained something showable. A classify that placed none of the '
    + 'posts it was sent gained nothing, and a signal that fires anyway teaches the reader to ignore it');
});

// ── [TASK-101] The signals: progress on the toggle, the sentence at the ready moment ─────────────
//
// A SEPARATE accounting from TASK-099's above, kept separate on purpose — that list records which
// tests were RED before THAT fix, and appending to it would quietly make a true sentence false.
//
// All nine below are RED before TASK-101's code, and each fails for its own reason rather than
// because the elements are absent: `HIDDEN_IDS` now seeds `group-busy` and `group-ready-note`
// (test-helpers/app-harness.mjs), so an unwritten element reads as HIDDEN and every "is shown"
// assertion bites. That seeding was itself verified by a control — asserting "the bubble was shown"
// against a tree with neither element nor code PASSED before it and FAILS after (2026-08-27).
//
// NOT TESTABLE HERE, and deliberately (task Verification, steps 5-6): criteria 3 (survives a
// scroll), 4 (the reduced-motion pulse), 9 (translucency) and 8's non-modality. A desktop browser is
// the wrong instrument for the pulse and the bubble's fit; those go to Asli on a handset. Criterion
// 4's regression half is pinned by the style.css tripwire in test/docs.test.mjs instead.

// Must match app.js. Deliberately duplicated rather than plumbed through the harness: N9 asserts
// BOTH sides of the boundary, so a drift between the two values fails loudly on one of them rather
// than silently widening what the test claims to pin.
const READY_NOTE_MS = 6000;

const busyHidden = app => app.el('group-busy').classList.contains('hidden');
const noteShown = app => !app.el('group-ready-note').classList.contains('hidden');

/** Boot with a classify that HANGS until the returned `release()` is called, so "while the call is
 *  in flight" is an observable state rather than an instant this harness cannot stop inside. */
function bootGated({ store = {}, reply = [], grouped = false } = {}) {
  const bodies = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const app = createApp({
    store: {
      focus_device_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ...(grouped === null ? {} : { focus_group_view: grouped ? 'on' : 'off' }),
      ...store,
    },
  });
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      bodies.push(JSON.parse(init.body));
      await gate;
      return { ok: true, status: 200, json: async () => ({ groups: reply, capped: false }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return { app, bodies, release };
}

test('TASK-101 N1 (C2): the busy indicator is shown WHILE the classify is in flight, and hidden when it resolves', async () => {
  // Predicted killer of "delete showGroupBusy()": this test alone. Nothing else observes the
  // in-flight state — every other test in this file settles past it.
  const { app, bodies, release } = bootGated({
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();

  assert.equal(bodies.length, 1, 'guard: the classify actually started, so "in flight" is a real state here');
  assert.equal(busyHidden(app), false,
    'the indicator must be visible for the whole time /api/group is in flight — this is the signal '
    + 'the deleted pill used to carry, and the reader is staring at a 15-20s wait ([BUG-077])');

  release();
  await settle();

  assert.equal(busyHidden(app), true, 'and it must go away when the call resolves');
});

test('TASK-101 N2 (C2): the indicator is hidden on the DEGRADE path, not left spinning forever', async () => {
  // The `finally` at app.js:834 (it was :793 before this change added code above it — the number
  // was carried into this brand-new file without re-deriving it, and a review caught that).
  // Predicted killer of "hide only in the success branch": this test
  // alone — N1 releases a successful call and would stay green.
  // GATED, and that is not incidental. Written with an immediate rejection this test PASSED at the
  // RED step against code that shows nothing at all — the element ships hidden, so "hidden after a
  // failure" was true by construction. Hanging the call first makes it assert a TRANSITION (shown,
  // then hidden) instead of a resting state, which is the only form of it that can fail.
  const app = createApp({ store: { focus_device_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', focus_group_view: 'off' } });
  let asked = 0;
  let reject;
  const gate = new Promise((_, r) => { reject = r; });
  app.setFetch(async (url) => {
    if (String(url).includes('/api/group')) { asked++; await gate; }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();

  assert.equal(asked, 1, 'guard: the classify was attempted, rather than never running');
  assert.equal(busyHidden(app), false,
    'guard: the indicator IS up while the call is in flight — without this half, the assertion below '
    + 'is true of an app that never shows an indicator at all');

  reject(new Error('network down'));
  await settle();

  assert.equal(busyHidden(app), true,
    'a failed classify must clear the indicator — a signal that never stops IS the frozen-app '
    + 'impression this task exists to remove');
});

test('TASK-101 N3 (C5): the ready note appears when a classify places a post the reader can be shown', async () => {
  // The positive case. Predicted killer of "never show the note": this test.
  const { app, bodies } = boot({
    grouped: false,
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();

  assert.equal(bodies.length, 1, 'guard: the classify ran');
  assert.equal(sw(app).classList.contains('is-shining'), true,
    'guard: the bloom fired, so the note is being asked for at the SAME moment and not on some other trigger');
  assert.equal(noteShown(app), true,
    'the switch has never explained itself; this is the one moment the app says what it does');
});

test('TASK-101 N4 (C5): no note on a quiet open — nothing was classified', async () => {
  // Predicted killer of "show the note whenever syncGroupingToggle runs": this test. The cache-only
  // paint reaches syncGroupingToggle with a live switch and must stay silent.
  const { app, bodies } = boot({
    grouped: false,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();

  assert.equal(bodies.length, 0, 'guard: nothing was new, so no classify ran');
  assert.equal(sw(app).getAttribute('aria-disabled'), 'false',
    'guard: the switch IS live — so a note was possible here, and its absence is a decision rather than an accident');
  assert.equal(noteShown(app), false,
    'announcing "you can group your posts now" on every open is [BUG-086]\'s shape: a message that '
    + 'fires unconditionally stops being information');
});

test('TASK-101 N5 (C5): no note when every post the classify placed was DEFERRED', async () => {
  // ⚠️ THIS TEST PINS NOTHING, and that is a measured finding rather than a suspicion: it killed
  // ZERO of the 10 mutations in mutations/TASK-101.mjs. The reason is structural, and it is the
  // [BUG-047] G5 shape one level up — in the CRITERION rather than in the code.
  //
  // Deferral requires the GROUPED view: `_liftDeferred` is populated only by
  // `liftGroupedFromStream`, which `updateGroupsForFeed` calls only `if (isGrouped())`. The note
  // requires the UNGROUPED view (N6's gate). The two conditions are mutually exclusive, so
  // "a deferred placement must not raise the note" cannot fail — the gate already implies it, and
  // this fixture trips BOTH guards so it sizes out neither. CLAUDE.md: when two guards can stop the
  // same input, a test exercising both pins neither.
  //
  // KEPT rather than deleted, and declared rather than counted as coverage — the same call
  // [TASK-099] made for its criterion-6 badge clause. It documents the exclusion for the next reader
  // who wonders why criterion 5's third clause has no pin. The clause itself should come off the
  // note's half of criterion 5; that is a task-file amendment and is Asli's to approve.
  // Same fixture shape as T10c, and for the same reason: the grid gained nothing openable, so
  // promising a topic would be a promise it does not keep.
  const { app, bodies } = boot({
    grouped: true,
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS }, unfiled: ['x2'] }) },
    reply: [{ label: 'AI news', summary: ['x2 says a thing'], item_ids: ['x2'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  assert.equal(bodies.length, 1, 'guard: the classify ran');
  assert.equal(noteShown(app), false, 'nothing became openable, so there is nothing to announce');
});

test('TASK-101 N6 (C6): no note while grouping is already ON — it would be telling the reader something they did', async () => {
  // THE GATE THIS TASK ADDS. `syncGroupingToggle` blooms in BOTH views; the sentence must not.
  // Predicted killer of "delete the !isGrouped() gate": this test ALONE. N3 boots ungrouped and
  // stays green; N5 is grouped but never arms. Sized so only the gate can decide the outcome.
  const { app, bodies } = boot({
    grouped: true,
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();

  assert.equal(bodies.length, 1, 'guard: the classify ran');
  assert.equal(sw(app).classList.contains('is-shining'), true,
    'guard: the bloom DID fire here — so the note was armed and the gate is the only thing that can stop it');
  assert.equal(noteShown(app), false,
    '"you can group your posts by topic now" is nonsense to someone already reading the grouped view');
});

test('TASK-101 N7 (C7): a tap consumes the note, and it does not come back on the next paint', async () => {
  // The bloom's discipline, applied to the sentence. Predicted killer of "clear the flag but leave
  // the element shown": this test.
  const { app } = boot({
    grouped: false,
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();
  assert.equal(noteShown(app), true, 'guard: the note was shown at all');

  assert.equal(tapSwitch(app), 1, 'guard: the switch is WIRED — an unwired tap is silently a no-op');
  assert.equal(noteShown(app), false, 'the reader has now acted on the news; the sentence has done its job');

  app.ctx.syncGroupingToggle();
  assert.equal(noteShown(app), false, 'and it must not reappear on the next repaint of the control');
});

test('TASK-101 N8 (C7): a second classify RESTARTS the dismissal rather than letting the first timer cut it short', async () => {
  // Without a clearTimeout the first classify's timer is still pending, so the note vanishes at its
  // deadline even though a newer one just re-armed it. `advance` makes cancellation observable —
  // this test is only possible because of the delay-aware driver re-derived in 57f19a6.
  // Predicted killer of "re-arm without clearing the old timer": this test alone.
  const { app, bodies } = boot({
    grouped: false,
    reply: n => (n === 1
      ? [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }]
      : [{ label: 'AI news', summary: ['x2 says a thing'], item_ids: ['x2'] }]),
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();
  assert.equal(noteShown(app), true, 'guard: shown by the first classify');

  app.advance(3000);
  assert.equal(noteShown(app), true, 'guard: 3s in, still well inside the dismissal window');

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(bodies.length, 2, 'guard: a SECOND classify really ran');
  assert.equal(noteShown(app), true, 'guard: and it re-armed the note');

  // t=6100. The FIRST classify's timer came due at 6000; the restarted one is not due until 9000.
  // If the re-arm did not cancel the old timer, the note is gone here — cut short by a deadline that
  // belongs to news the reader has already been shown.
  app.advance(3100);
  assert.equal(noteShown(app), true,
    'the newer classify owns the dismissal — the first timer must have been cancelled, not left to '
    + 'fire under a sentence that was re-shown after it');

  app.advance(2900);
  assert.equal(noteShown(app), false, 'and the restarted deadline still arrives — it does not become permanent');
});

test('TASK-101 N9 (C8): the note dismisses itself, without the reader touching anything', async () => {
  // Predicted killer of "show it and never arm a timer": this test alone — every other note test
  // asserts within the visible window.
  const { app } = boot({
    grouped: false,
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();
  assert.equal(noteShown(app), true, 'guard: shown');

  app.advance(READY_NOTE_MS - 1);
  assert.equal(noteShown(app), true, 'it must still be readable one tick before its deadline');

  app.advance(1);
  assert.equal(noteShown(app), false, 'and gone on it — a sentence that never leaves becomes furniture');
});

// ── [TASK-101] round 2: what four independent reviews found ──────────────────────────────────────
// N10 pins a LIVE DEFECT (the note appearing on a paint that classified nothing). N11 and N12 close
// two "guard moved, not deleted" mutations that SURVIVED all 887 tests in an independent battery.

test('TASK-101 N10 (C5): an arm that could not be shown must NOT latch and fire on a later quiet paint', async () => {
  // THE DEFECT, found by an independent correctness review 2026-08-27. `_shineArmed` is set when a
  // classify places something, but consumed only inside `if (_shineArmed && live)`. Resolve a
  // classify while the switch is INERT and the arm survives — then any later render calls
  // `syncGroupingToggle` (app.js:3582, on EVERY render) and raises the sentence on a paint that
  // classified nothing. That is criterion 5's "not on a quiet open" clause, violated.
  // The author's comment claimed the note "inherits every guard criterion 10 already pins,
  // including not on a quiet open". It did not; this test is why that sentence is now false.
  // PREDICT: killed by nothing before the fix — it IS the fix. Killer after: this test alone.
  const { app, bodies, release } = bootGated({
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();
  assert.equal(bodies.length, 1, 'guard: the classify started');

  // Everything the classify is about becomes read WHILE it is in flight — the real route is tapping
  // "Mark all done" during the wait. No reload, so nothing sweeps this back.
  app.set('focus_done', JSON.stringify(['x1']));

  release();
  await settle();

  assert.equal(sw(app).getAttribute('aria-disabled'), 'true',
    'guard: the switch is INERT at this paint — every placed post is read, so no tile can paint');
  assert.equal(noteShown(app), false, 'guard: correctly withheld here — there is nothing to offer');

  // The reader taps Undo, so the posts are unread again and the switch goes live.
  app.set('focus_done', JSON.stringify([]));
  render(app, [xPost('x1')]);
  await settle();

  assert.equal(bodies.length, 1, 'guard: NO second classify ran — this is a quiet paint');
  assert.equal(noteShown(app), false,
    'a quiet render must not raise the sentence. Before the fix the arm latched through the inert '
    + 'paint and fired here, announcing new topics on a render that made no API call at all');
});

test('TASK-101 N11 (C2): a quiet open leaves the indicator hidden — it is raised BELOW the early return', async () => {
  // Independent mutation IM1 moves `showGroupBusy()` one line ABOVE
  // `if (newItems.length === 0) { ...; return; }`. That return is before the `try`, so the `finally`
  // never runs and the ring spins forever — on the MOST COMMON load, the one where nothing is new,
  // and in a sticky appbar it never scrolls away. IM1 survived all 887 tests.
  // Two phases on purpose: phase 1 proves the indicator can be shown and hidden at all, so phase 2's
  // assertion is a transition rather than the resting state N2 originally passed vacuously against.
  // PREDICT: killed by this test alone.
  const { app, bodies, release } = bootGated({
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();
  assert.equal(busyHidden(app), false, 'guard phase 1: a real classify raises the indicator');
  release();
  await settle();
  assert.equal(busyHidden(app), true, 'guard phase 1: and lowers it');

  render(app, [xPost('x1')]);          // x1 is assigned now → newItems is empty → early return
  await settle();

  assert.equal(bodies.length, 1, 'guard: no second classify — the early return was taken');
  assert.equal(busyHidden(app), true,
    'nothing was sent, so nothing may be announced as in flight: raised above the early return the '
    + 'ring would spin for the rest of the session with no request behind it');
});

test('TASK-101 N12 (C5): the sentence is withheld while the switch is inert, even though a classify placed a post', async () => {
  // Independent mutation IM7 calls `showReadyNote()` at the ARMING site, before `live` is known —
  // it survived all 887 tests. Offering "you can group your posts by topic now" beside a switch
  // carrying aria-disabled="true" is an offer for a view that cannot be opened.
  // Sized so ONLY the `live` term can decide: grouping is OFF (so the !isGrouped() gate passes) and
  // the classify DID place a post (so the arm is set) — the switch's inertness is the only thing left.
  // PREDICT: killed by this test alone.
  const { app, bodies, release } = bootGated({
    reply: [{ label: 'AI news', summary: ['x1 says a thing'], item_ids: ['x1'] }],
  });
  app.ctx.wireApp();

  render(app, [xPost('x1')]);
  await settle();
  app.set('focus_done', JSON.stringify(['x1']));
  release();
  await settle();

  assert.equal(bodies.length, 1, 'guard: the classify ran and placed x1');
  assert.equal(sw(app).getAttribute('aria-disabled'), 'true', 'guard: the switch really is inert');
  assert.equal(noteShown(app), false,
    'the offer must not be made when the view behind it would open empty');
});
