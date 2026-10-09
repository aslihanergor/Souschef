// WHICH SOURCES ARE GROUPED ([TASK-094]). Substack posts are no longer classified, held hidden or
// tiled; X posts are unchanged.
//
// These drive the REAL `renderFeedResults` through the app-harness — the first tests to render a
// feed at all — because the change's whole user-visible half is which cards the render holds back.
// The observables are deliberate:
//
//   • `el('feed').children` + `grouping-pending`  — the card, and whether it is held
//   • `countGroupedUnread()`                      — reads localStorage, not the DOM
//   • the stored `assignments`                    — what survived the prune
//   • `app.urls()`                                — whether a billed call went out at all
//
// NOT the "N new" badge — but the reason changed. It USED to be that `updateCount` counts
// `querySelectorAll('#feed .card')` and the harness answered `[]`, so the badge counted grouped
// posts only and read "1 new" where a browser read "2 new". [BUG-092] made that selector real, so
// the badge now matches a browser and asserting on it would be sound. It is still not asserted here
// because these tests are about WHICH CARDS a render routes where, and the badge is a coarser
// quantity than any criterion of [TASK-094] names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';

// A Substack id is the post URL — the shape that makes these the most expensive posts in a batch,
// and the reason the assignments map cannot be pruned by sniffing id shape.
const SUB_ID = 'https://foo.substack.com/p/a-long-post-slug';
// A post's publish time. RELATIVE to now, not an absolute constant ([BUG-098] review round 1):
// every post a live feed returns is inside `WINDOW_DAYS` by the server's clock, and the prune now
// treats an in-hand post older than that window as evidence the DEVICE's clock is wrong. A frozen
// 2025 timestamp made every fixture look like a broken clock — and would have drifted a suite that
// once passed into one that asserts the opposite, silently, as months went by.
const PUBLISHED = Date.now() - 2 * 86400_000;

const xPost = (id = 'x1') => ({
  id, source: 'twitter', text: 'Senate advances the spending bill', published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});
const ytPost = (id = 'v1') => ({
  id, videoId: id, source: 'youtube', title: 'A video', published: PUBLISHED,
  channel: { id: 'c3', name: 'A channel', source: 'youtube' },
});
const subPost = (id = SUB_ID) => ({
  id, source: 'substack', title: 'A long read', subtitle: 'a subtitle', preview: 'the first paragraph',
  url: id, author: 'An author', published: PUBLISHED,
  channel: { id: 'c2', name: 'Publication', source: 'substack' },
});

// One X post and one Substack post already filed under the same topic — the state a real user holds
// the moment this change ships.
const MIXED_STATE = {
  assignments: { x1: 'g_ai_news', [SUB_ID]: 'g_ai_news' },
  groups: { g_ai_news: { label: 'AI news', summary: ['an established point'] } },
  updatedAt: PUBLISHED,
};

// GROUPED VIEW SEEDED ([TASK-099]). Ungrouped is now the DEFAULT: every post renders into the
// chronological stream and an assigned one is merely HIDDEN, so a fixture with no view key exercises
// the plain feed — where tiles, the lift and the classify hold do not exist at all. This file's
// subject is what happens INSIDE the grouped view, which is unchanged, so only the precondition had
// to be stated. No assertion in this file was altered.
function boot(store = {}) {
  const app = createApp({ store: { focus_group_view: 'on', ...store } });
  app.setFetch(async (url) => {
    if (String(url).includes('/api/group')) return { ok: true, status: 200, json: async () => ({ groups: null }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return app;
}

// `failed` is what decides whether the liveness prune is allowed to run, so every test names it.
const render = (app, items, failed = []) =>
  app.ctx.renderFeedResults({ items, failed, cappedNames: [], totalChannels: items.length + failed.length });

// "In the stream" now means VISIBLE in the stream ([TASK-099] decision 1, Asli 2026-08-26: the lift
// HIDES rather than removes). A lifted card is still a `#feed` child carrying `.grouped-out`
// (display:none), so a raw `children` read reports a post the reader cannot see as present — the same
// mistake the four production counting selectors had to be corrected for. The assertions below are
// UNCHANGED; only what the instrument counts as "in the stream" moved, and it moved to match what a
// browser shows.
const cardFor = (app, id) => app.el('feed').children.find(c => c.dataset.id === id && !c.classList.contains('grouped-out'));
const groupRequests = app => app.urls().filter(u => u.includes('/api/group'));
const assignmentsIn = app => JSON.parse(app.get('focus_groups') || '{"assignments":{}}').assignments;

// ── The card the user sees ──────────────────────────────────────────────────────

test('a Substack post renders in the stream without the grouping-pending hold', () => {
  const app = boot();
  render(app, [xPost(), subPost()]);

  const sub = cardFor(app, SUB_ID);
  assert.ok(sub, 'the Substack post has a card in the chronological stream');
  assert.equal(sub.classList.contains('grouping-pending'), false,
    'the Substack card is readable immediately — it is not held back for a classify it takes no part in');

  // Same render, so this is not "the hold was removed for everyone": X still waits.
  const x = cardFor(app, 'x1');
  assert.ok(x, 'the X post also has a card');
  assert.equal(x.classList.contains('grouping-pending'), true,
    'the X card is still held until its classify returns');
});

// ── The billed call ─────────────────────────────────────────────────────────────

test('a feed whose only unread text is Substack issues no classify request', () => {
  const app = boot();
  render(app, [subPost()]);
  assert.deepEqual(groupRequests(app), [],
    'no /api/group call at all — not a call whose answer is discarded');
});

test('a mixed feed sends only the X posts to the classifier', () => {
  const app = boot();
  let body = null;
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ groups: null }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  render(app, [xPost(), subPost()]);
  assert.ok(body, 'a classify still runs for the X post');
  assert.deepEqual(body.items.map(i => i.id), ['x1'],
    'the Substack post never reaches the billed prompt');
});

// ── The prune: what happens to assignments a user already holds ─────────────────

// COST ACCEPTED AND WIDENED, tracked as [BUG-099] (Asli, 2026-08-22: "okay b is fine").
//
// It used to read "dropped on a clean feed load", and that is no longer true. A Substack post is not
// groupable, so it never enters the in-hand set and never receives a `postMeta` age — leaving
// `postMetaEpoch` as its only exit, up to a full window after the upgrade. TASK-094's accepted cost
// was ONE wrong render; it is now up to fourteen days of one, during which the tile counts a post the
// drill-in cannot show ([BUG-029]'s shape).
//
// Not fixed here on purpose: the pass that would fix it — delete an in-hand post's assignment once
// its source is no longer groupable — drew defects in two consecutive review rounds and was removed
// under the two-round tripwire. Both halves are asserted, so neither the survival nor the eventual
// collection can be mistaken for approval of the other.
test('a stale Substack assignment survives a clean load, and leaves once the window passes', () => {
  const app = boot({ focus_groups: JSON.stringify(MIXED_STATE) });
  render(app, [xPost(), subPost()], []);

  assert.deepEqual(Object.keys(assignmentsIn(app)).sort(), [SUB_ID, 'x1'].sort(),
    'the leftover survives the upgrade load — there is no positive evidence against it');
  // NOT counted, since [BUG-098] review round 1: the badge and caught-up now ask what this device
  // has IN HAND, and a Substack post is never groupable, so it never enters that set. That removes
  // the USER-VISIBLE half of [BUG-099] — the leftover costs storage for up to a window, but it can
  // no longer inflate the badge or hold "You're all caught up" out of reach.
  assert.equal(app.ctx.countGroupedUnread(), 1,
    'the leftover is held in storage but not counted against the reader');

  // The half that bounds it: age the epoch past the window and the leftover is collectable, so this
  // is a delay rather than the permanent record BUG-098's epoch exists to prevent.
  const aged = JSON.parse(app.get('focus_groups'));
  aged.postMetaEpoch = Math.floor((Date.now() - 20 * 86400_000) / 1000);
  app.set('focus_groups', JSON.stringify(aged));
  render(app, [xPost(), subPost()], []);

  assert.deepEqual(Object.keys(assignmentsIn(app)), ['x1'],
    'one window later it is gone, and the X assignment is untouched throughout');
});

// ACCEPTED COST, not an oversight — this test pins a weaker contract on purpose ([BUG-088]).
//
// An earlier build closed this case with an unconditional pass that deleted the assignment of any
// in-hand post whose source is no longer grouped. Two review rounds found defects in that one
// construct: a Substack `guid` colliding with an X post id un-assigned the real X post (a billed
// classify on EVERY render, forever), and the narrowed version still destroyed the whole topic —
// label and bullets, synced to every device — when the colliding X post was absent, which an X 502
// at the plan's post cap makes routine. Two consecutive rounds on one construct is CLAUDE.md's
// tripwire, so it was removed rather than patched again (Asli's yes, 2026-08-10).
//
// Assert BOTH halves. Asserting only the survival would read as approval of a bug; asserting only
// the correction would hide that a user really does see a wrong number in between.
// The FAILED-load half of the same accepted cost. What changed under [BUG-098] is that a failed load
// is no longer special: the gate is gone, so this asserts the same outcome as its sibling above and
// keeps its value for a different reason — an X 502 at the plan's post cap is routine, and this pins
// that a lost channel neither accelerates nor delays the leftover's departure.
test('a stale Substack assignment is unaffected by a channel failing', () => {
  const app = boot({ focus_groups: JSON.stringify(MIXED_STATE) });

  render(app, [xPost(), subPost()], ['Some channel']);
  assert.equal(app.ctx.countGroupedUnread(), 1,
    'the leftover survives in storage and stays uncounted, as on a clean load — [BUG-099]');
  assert.deepEqual(Object.keys(assignmentsIn(app)).sort(), [SUB_ID, 'x1'].sort());

  // The half that must never regress: a failed load must not DELETE anything either. Before
  // [BUG-098] the gate made this vacuous — the prune simply did not run. Now it runs and must reach
  // the same answer, which is a stronger claim than the one this test used to make.
  render(app, [xPost(), subPost()], ['Some channel']);
  assert.deepEqual(Object.keys(assignmentsIn(app)).sort(), [SUB_ID, 'x1'].sort(),
    'a second incomplete load still destroys nothing');
  assert.equal(app.ctx.countGroupedUnread(), 1);
});

// ── The guard the prune split must not break ────────────────────────────────────
// GREEN on main by construction — it pins TASK-068's bugfix, which this change moves the code
// around. Mutation-verified instead of RED-first: making the liveness pass unconditional must red it.

// ── Review round 1: an id is REMOTE TEXT, not a namespaced key ──────────────────
// A Substack id is `guid || url` taken verbatim from the publication's RSS (api/_substack.js:143),
// so the prune's premise — "this item's source is not grouped, therefore this id's assignment is
// invalid" — is only sound if ids are namespaced per source. They are not.

test('a Substack guid colliding with an X post id does not steal its assignment', () => {
  const COLLIDE = '1954112233445566778';           // shaped like a real X post id
  const app = boot({ focus_groups: JSON.stringify({
    assignments: { [COLLIDE]: 'g_ai_news' },
    groups: { g_ai_news: { label: 'AI news', summary: ['an established point'] } },
    updatedAt: PUBLISHED,
  }) });

  // A hostile or broken publication puts the X post's id in its own <guid>.
  render(app, [xPost(COLLIDE), subPost(COLLIDE)], []);

  assert.equal(assignmentsIn(app)[COLLIDE], 'g_ai_news',
    'the X post keeps its assignment — a non-groupable item may not delete a groupable one');
  // The real damage was cost, not just state: un-assigning makes the X post "new" again, so every
  // render buys a fresh billed classify, forever. main reaches steady state at zero.
  assert.deepEqual(groupRequests(app), [],
    'no classify: the X post never became new again');
});

test('a Substack guid naming an Object.prototype key arms no extra synced push', () => {
  const STATE = JSON.stringify({
    assignments: { x1: 'g_ai_news' },
    groups: { g_ai_news: { label: 'AI news', summary: ['an established point'] } },
    updatedAt: PUBLISHED,
  });
  // `state.assignments` comes from JSON.parse, so it inherits Object.prototype: `'toString' in …`
  // is ALWAYS true. A guid of `toString` made the prune report a change on every render, and every
  // change writes the whole synced row and arms a PUT — with no knowledge of the victim's data.
  const control = boot({ focus_groups: STATE });
  render(control, [xPost(), subPost('an-ordinary-guid')], []);

  const hostile = boot({ focus_groups: STATE });
  render(hostile, [xPost(), subPost('toString')], []);

  assert.equal(hostile.timers.length, control.timers.length,
    'a prototype-key guid arms no push the ordinary one does not');
});

// ── Review round 1: pin what this change made load-bearing but did not add ──────
// Each of these passes on the branch and dies under one named mutation. They exist because the
// original battery only mutated in the "restore Substack" direction — what was written, not what
// the writing came to rest on.

test('PIN: an already-grouped X post is not ALSO VISIBLE in the stream', () => {
  const app = boot({ focus_groups: JSON.stringify(MIXED_STATE) });
  render(app, [xPost(), subPost()], []);
  // ⚠️ THE MECHANISM THIS PINS CHANGED with [TASK-099] (Asli's decision 1, 2026-08-26: "the lift
  // HIDES, it does not remove"). The line this comment used to name —
  // `if (groupable && (item.id in assigned)) return;` — NO LONGER EXISTS: the skip was deleted, not
  // gated, because `renderFeedResults` has no lift and the skip WAS what emptied the stream.
  //
  // The PROPERTY is unchanged and still worth pinning: an already-grouped post must not be readable
  // in the chronological stream as well as in its tile. What changed is how: the card is rendered and
  // then marked `.grouped-out`, and `cardFor` excludes that class. The mutation that reds this today
  // is deleting `if (grouped && isGrouped()) card.classList.add('grouped-out')` in renderFeedResults —
  // which double-displays and double-counts every post, exactly as the old deletion did.
  //
  // Rewritten rather than left standing: a comment naming a mutation that cannot be applied reads as
  // coverage to every future reader and is the [TASK-096] false-citation shape.
  assert.equal(cardFor(app, 'x1'), undefined,
    'x1 lives in its tile, not in the chronological stream');
});

// REVERSED by [BUG-098], deliberately (Asli, 2026-08-22: "okay both yes"). This used to pin
// TASK-068's original prune: a post absent from a complete load lost its assignment. That rule is the
// bug — the evidence for absence is device-local (`tweetCache` is not synced and is cleared on
// sign-out) while the record is synced, so a cold cache returning its newest 20 posts deleted the
// bullets of everything older and PUT the loss to every device.
//
// The test is kept rather than deleted, inverted, because the old behaviour is the one a reader will
// expect and the one a future change is most likely to restore by accident.
test('PIN: a departed X post KEEPS its assignment — absence is not evidence ([BUG-098])', () => {
  const app = boot({ focus_groups: JSON.stringify({
    assignments: { x1: 'g_ai_news', x_gone: 'g_ai_news' },
    groups: { g_ai_news: { label: 'AI news', summary: ['an established point'] } },
    updatedAt: PUBLISHED,
  }) });
  render(app, [xPost('x1')], []);
  assert.deepEqual(Object.keys(assignmentsIn(app)).sort(), ['x1', 'x_gone'],
    'not being in this feed says nothing about whether the post is gone');
});

test('PIN: a YouTube video is never held hidden and never sent to the classifier', () => {
  const app = boot();
  let body = null;
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ groups: null }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  render(app, [xPost(), ytPost(), subPost()]);
  // isGroupableSource now gates three behaviours from one definition, so a future broadening is one
  // word. Mutation: `|| item.source === 'youtube'` — without this, every video would be held hidden
  // and its title shipped to the billed prompt, invisibly.
  const yt = cardFor(app, 'v1');
  assert.ok(yt, 'the video has a card');
  assert.equal(yt.classList.contains('grouping-pending'), false, 'and is never held hidden');
  assert.deepEqual(body.items.map(i => i.id), ['x1'], 'only the X post reaches the prompt');
});

test('GUARD: an X cluster keeps its assignments when its posts failed to fetch', () => {
  const app = boot({
    focus_groups: JSON.stringify({
      assignments: { x1: 'g_ai_news', x2: 'g_ai_news', [SUB_ID]: 'g_ai_news' },
      groups: { g_ai_news: { label: 'AI news', summary: ['an established point'] } },
      updatedAt: PUBLISHED,
    }),
  });

  // The X channel failed; only the Substack post came back this render.
  render(app, [subPost()], ['X acct']);

  const after = assignmentsIn(app);
  assert.equal(after.x1, 'g_ai_news', 'x1 does not die of mere absence');
  assert.equal(after.x2, 'g_ai_news', 'x2 does not die of mere absence');
  assert.ok(JSON.parse(app.get('focus_groups')).groups.g_ai_news,
    'and the topic itself survives to hold them');
});
