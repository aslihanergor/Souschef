// A BULLET MUST DESCRIBE A POST THE READER CAN REACH.
//
// The card told two stories about itself. Header, rail and dots counted only the posts THIS render
// fetched; the bullet summary was filtered against every unread assignment the account holds. On
// a handset that read "6 posts" over 26 bullets, and "1 post"
// over 6 bullets on a topic with no backlog at all.
//
// The rule this file pins: A BULLET DESCRIBES A POST THE READER CAN
// REACH RIGHT NOW — on this card's rail, or visible in the chronological stream. That resolves all
// three cases with no special case for any:
//   • a post this render did not fetch is reachable nowhere      → its bullet goes    (B1, B2, B10)
//   • a deferred post is on screen in the stream                 → its bullet stays   (C3c, next door)
//   • the feed has not loaded, so nothing is known to be absent  → nothing is hidden  (B7)
//
// WHY THE WIDE SET STILL EXISTS. `unreadByGid` is deliberately wide because it is the
// same question `liveBullets` answers for the /api/group payload, where under-reporting DESTROYS the
// only restorable copy of a summary. The narrowing applies to the RENDER and nothing else.
// B4 is the guard on that and is the one test here whose failure means data loss.
//
// WHICH TESTS FAIL WITHOUT THE NARROWING:
//   fail without it — B1, B2, B8, B9, B10. These pin the defect itself.
//   pass without it — B4, B5, B6, B7. Each guards a defect only the narrowing could introduce.
//
// ⚠️ `group-defer-lift` C3c IS LOAD-BEARING HERE and is not duplicated. It
// asserts a deferred post keeps its bullet; `buildTopicCard` reads the narrowed
// set, so C3c is what catches the deferred branch LOSING its `reachable.add`.
//
// C3c does NOT catch "a narrowing applied ABOVE the `_liftDeferred` guard instead of below it":
// that is an equivalent mutant, because
// `_liftDeferred` is only ever filled from cards the same render put in `#feed` — so a deferred id
// is always in `inHand`. That invariant is load-bearing and stated nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';

// RELATIVE to now, never a frozen constant: `pruneGroupState` rule 3 treats an in-hand post older
// than the window as a broken device clock. DEFENSIVE HERE RATHER THAN LOAD-BEARING — with a frozen
// constant every test in this file still passes, so the drift risk is
// real for the suite at large but is not what these fixtures rest on.
const PUBLISHED = Date.now() - 2 * 86400_000;
const G = 'g_ai';

const xPost = (id) => ({
  id, source: 'twitter', text: `post ${id} says something`, published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});

// `v: 2` (GROUP_STATE_VERSION) IS LOAD-BEARING AND ITS ABSENCE IS SILENT — `migrateGroupSummaries`
// clears every summary below it, so a fixture without it seeds bullets that are wiped before the
// first render and the card paints EMPTY — the fixture would read
// `bullets=[]` and "prove" the defect absent.
const groupState = (over = {}) => JSON.stringify({
  assignments: {}, groups: {}, unfiled: [], updatedAt: PUBLISHED, v: 2, ...over,
});

// Three posts assigned to one topic, one bullet naming each. The fixture is SIZED so only the guard
// under test can fire: every bullet carries exactly one id, so nothing is kept alive by a second
// post, and no bullet is id-less (that is B9's separate case).
const AI = {
  label: 'AI',
  summary: [
    { text: 'about x1', item_ids: ['x1'] },
    { text: 'about x2', item_ids: ['x2'] },
    { text: 'about x3', item_ids: ['x3'] },
  ],
};
const THREE_ASSIGNED = { assignments: { x1: G, x2: G, x3: G }, groups: { [G]: AI } };

function boot({ store = {}, reply = [] } = {}) {
  const app = createApp({
    store: {
      focus_device_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      focus_group_view: 'on',
      focus_channels: JSON.stringify([{ id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' }]),
      ...store,
    },
  });
  const bodies = [];
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ groups: reply, capped: false }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return { app, bodies };
}

const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
const render = (app, items) =>
  app.ctx.renderFeedResults({ items, failed: [], cappedNames: [], totalChannels: 1 });

const q           = (app, sel) => app.queryAll(`#feed .topic-card[data-gid="${G}"] ${sel}`);
const cardFor     = app => app.queryAll('#feed .topic-card').find(c => c.dataset.gid === G);
const bulletTexts = app => [...(q(app, '.tc-bullets')[0]?.children || [])].map(li => li.textContent);
const countText   = app => q(app, '.tc-count')[0]?.textContent;
const railIds     = app => q(app, '.tc-slide').map(s => s.dataset.id).filter(Boolean);
// Visible in the stream: `.grouped-out` is display:none under hide-not-remove, so a raw
// children read reports a post the reader cannot see as present.
const streamIds   = app => app.el('feed').children
  .filter(c => c.classList.contains('card') && !c.classList.contains('grouped-out'))
  .map(c => c.dataset.id).filter(Boolean);

function guardCard(app) {
  const card = cardFor(app);
  assert.ok(card, `guard: a .topic-card[data-gid="${G}"] must exist before anything here means `
    + `something. Stream holds [${streamIds(app).join(', ')}]`);
  return card;
}

// ── B1: the defect itself ─────────────────────────────────────────────────────
test('BUG-113 B1: a card shows bullets only for the posts it fetched', async () => {
  // The handset's "1 post / 6 bullets", reproduced at "1 post / 3 bullets". x2 and x3 are assigned
  // and unread, but this render did not fetch them — so the reader cannot open them from anywhere.
  const { app } = boot({ store: { focus_groups: groupState(THREE_ASSIGNED) } });
  render(app, [xPost('x1')]);
  await settle();

  guardCard(app);
  assert.equal(countText(app), '1 post', 'precondition: the header counts only what was fetched');
  assert.deepEqual(bulletTexts(app), ['about x1'],
    'the summary must describe the post the card can open, and NOT the two it cannot — this is the '
    + 'defect: on the branch point it reads all three');
});

// ── B2: the invariant, not just the example ───────────────────────────────────
test('BUG-113 B2: every bullet names a post on the rail or visible in the stream', async () => {
  // Stated as the INVARIANT rather than as a second example, so a fix that happens to satisfy B1 by
  // some other route (say, truncating to the header count) still has to be right for the reason.
  const { app } = boot({ store: { focus_groups: groupState(THREE_ASSIGNED) } });
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  guardCard(app);
  // ⚠️ MEASURED LIMIT: under grouping ON every assigned post
  // carries `.grouped-out`, so `streamIds` contributes NOTHING here and `reachable` is the rail
  // alone. Deleting the stream term leaves this test green. The "or
  // visible in the stream" half of the rule is therefore pinned by `BUG-092 C3c`, not by this test.
  // The term stays because the rule has two halves and the assertion should read as the rule does.
  const reachable = new Set([...railIds(app), ...streamIds(app)]);
  const state = JSON.parse(app.get('focus_groups'));
  const byText = new Map((state.groups[G].summary || []).map(b => [b.text, b.item_ids || []]));
  for (const text of bulletTexts(app)) {
    const ids = byText.get(text) || [];
    assert.ok(ids.some(id => reachable.has(id)),
      `bullet ${JSON.stringify(text)} names ${JSON.stringify(ids)}, none of which the reader can `
      + `reach — reachable right now is [${[...reachable].join(', ')}]`);
  }
  assert.equal(bulletTexts(app).length, 2, 'and the two reachable posts do keep their bullets');
});

// ── B4: the payload stays WIDE — guards data loss ─────────────────────────────
test('BUG-113 B4: the /api/group payload still reports every unread post', async () => {
  // THE ONE TEST HERE WHOSE FAILURE MEANS DATA LOSS. `restoreCachedBullets` rebuilds a topic's
  // summary from exactly this field, and it is the only copy. Narrowing the render
  // must not narrow the payload: under-report here and the server replaces the summary with whatever
  // the model wrote about the new posts alone.
  const { app, bodies } = boot({ store: { focus_groups: groupState(THREE_ASSIGNED) } });
  render(app, [xPost('x1'), xPost('x9')]);   // x9 is unassigned, so a classify actually fires
  await settle();

  assert.ok(bodies.length >= 1, `a classify must have fired; bodies=${bodies.length}`);
  const sent = bodies[0].groups.find(g => g.id === G);
  assert.ok(sent, `the existing topic must be sent; got ${JSON.stringify(bodies[0].groups)}`);
  assert.equal(sent.size, 3,
    '`size` counts every unread assignment, not the one in hand — it is the protection a real topic '
    + 'gets ([BUG-066])');
  assert.deepEqual(sent.summary.map(b => b.text ?? b), ['about x1', 'about x2', 'about x3'],
    'and every live bullet goes up, including those for posts this render never fetched — this is '
    + 'the ONLY restorable copy ([BUG-091])');
});

// ── B5: neither Mark-all-done path moves ──────────────────────────────────────
test('BUG-113 B5: "Mark all done" still marks exactly what the header claims', async () => {
  // The per-card sweep takes what the tile
  // claimed and no more. Narrowing the bullets must not reach this.
  //
  // WHAT THIS TEST DOES AND DOES NOT PIN:
  // this fixture carries NO deferred post, so it cannot tell `visibleGroupUnreadIds` from
  // `reachableByGid` — swapping the sweep to the reachable set survives here and is killed by
  // `BUG-092 C3b`. Left un-duplicated deliberately: C3b already sizes its fixture so only that guard
  // can fire, and a second copy would pin nothing extra. What this test does pin is that an UNFETCHED
  // assignment is never swept, which C3b does not cover.
  const { app } = boot({ store: { focus_groups: groupState(THREE_ASSIGNED) } });
  render(app, [xPost('x1')]);
  await settle();

  guardCard(app);
  const btn = q(app, '.tc-done')[0];
  assert.equal(app.click(btn), 1,
    'guard: exactly one click handler must be wired — a tap on an unwired button is silently a '
    + 'no-op, indistinguishable from a handler that correctly did nothing ([BUG-017])');
  app.runTimers(4);

  assert.deepEqual(JSON.parse(app.get('focus_done') || '[]').sort(), ['x1'],
    'only the fetched post is marked; x2 and x3 were never the card\'s to clear');
  // ASSERTED ON x2/x3 ONLY: demanding the surviving key set be exactly ['x2','x3'] would red,
  // because `pruneGroupState`
  // sweeps a done assignment on the next prune pass rather than synchronously. That is prune
  // TIMING — a different question, and pinning it here would
  // make this test fail for a reason it does not care about.
  const state = JSON.parse(app.get('focus_groups'));
  for (const id of ['x2', 'x3']) {
    assert.ok(Object.hasOwn(state.assignments, id),
      `${id}'s assignment must survive — it is unread, merely unreachable this load, and the `
      + `per-card sweep was never entitled to it`);
  }
});

// ── B6: nothing is destroyed ──────────────────────────────────────────────────
test('BUG-113 B6: hiding a bullet does not delete it from storage', async () => {
  // The fix is a RENDER-TIME FILTER over untouched state, which is what makes being wrong here show
  // a bullet too many rather than destroy one. If this ever
  // reds, the filter has become a mutation and the whole safety argument is void.
  const { app } = boot({ store: { focus_groups: groupState(THREE_ASSIGNED) } });
  render(app, [xPost('x1')]);
  await settle();

  guardCard(app);
  const state = JSON.parse(app.get('focus_groups'));
  assert.deepEqual((state.groups[G].summary || []).map(b => b.text ?? b),
    ['about x1', 'about x2', 'about x3'],
    'all three bullets remain in storage while only one is painted');
  assert.deepEqual(Object.keys(state.assignments).sort(), ['x1', 'x2', 'x3'],
    'and all three assignments remain');
});

// ── B7: no feed, no narrowing ─────────────────────────────────────────────────
test('BUG-113 B7: with no feed loaded, nothing is hidden', async () => {
  // `_lastFeedItems === null` after a caught-up or failed boot, so `inHandGroupableIds()` answers
  // null and NOTHING is known to be absent. Absence is not evidence.
  // Painting topics without a feed render is the toggle's path.
  const { app } = boot({ store: { focus_groups: groupState(THREE_ASSIGNED) } });
  app.ctx.renderTopicCards();
  await settle();

  guardCard(app);
  assert.deepEqual(bulletTexts(app), ['about x1', 'about x2', 'about x3'],
    'every bullet still shows: with no feed there is no evidence any post is unreachable, and '
    + 'inferring it from absence is exactly what [BUG-098] cost');
});

// ── B8: one definition, not two ───────────────────────────────────────────────
test('BUG-113 B8: after a single Done the repaint uses the same set a full render would', async () => {
  // Two bullet loops reading different sets ARE two renderers — the T31 defect, where the card went
  // stale until something else happened to rebuild it. `finishGroupCardAction` repaints from
  // `groupGridCounts()`, so it must converge on what a repaint would paint, not define a third answer.
  const { app } = boot({ store: { focus_groups: groupState(THREE_ASSIGNED) } });
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  guardCard(app);
  assert.deepEqual(bulletTexts(app), ['about x1', 'about x2'], 'precondition: two reachable bullets');
  // `.btn-done` (app.js:1326), and NOT a tag selector — the harness refuses those on purpose, which
  // is how the first draft of this line failed rather than silently matching nothing.
  const doneBtn = q(app, '.tc-slide[data-id="x1"] .btn-done')[0];
  assert.ok(doneBtn, `guard: x1's slide must carry a Done control; rail=[${railIds(app).join(', ')}]`);
  assert.equal(app.click(doneBtn), 1, 'guard: exactly one handler wired on the slide Done');
  app.runTimers(4);

  assert.deepEqual(bulletTexts(app), ['about x2'],
    'x1 is read so its bullet goes, and x3 was never reachable so its bullet must not APPEAR on the '
    + 'repaint — on the branch point the repaint reads the wide set and x3 shows up here');
});

// ── B9: an id-less bullet always shows ────────────────────────────────────────
test('BUG-113 B9: a bullet naming no posts is never hidden', async () => {
  // `bulletIsLive`'s keep-forever default. An id we cannot resolve, or one the model never gave, is
  // not evidence a post was read — and deleting such a bullet is a summary-destroying failure,
  // worse than the bug being fixed. Narrowing must not acquire an opinion about it.
  const { app } = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G, x2: G },
        groups: { [G]: { label: 'AI', summary: ['a bullet with no ids', { text: 'about x2', item_ids: ['x2'] }] } },
      }),
    },
  });
  render(app, [xPost('x1')]);
  await settle();

  guardCard(app);
  assert.deepEqual(bulletTexts(app), ['a bullet with no ids'],
    'the id-less bullet survives while x2\'s — whose post was not fetched — does not');
});

// ── B10: it self-corrects ─────────────────────────────────────────────────────
test('BUG-113 B10: a hidden bullet returns when its post is fetched', async () => {
  // The reason this is safe to ship: the state is never touched, so a bullet hidden by a shallow
  // load comes back on the next load that reaches its post. Asserted across TWO renders in one
  // document, which is also the shape of a pull-to-refresh.
  const { app } = boot({ store: { focus_groups: groupState(THREE_ASSIGNED) } });
  render(app, [xPost('x1')]);
  await settle();
  guardCard(app);
  assert.deepEqual(bulletTexts(app), ['about x1'], 'first load reaches one post');

  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  guardCard(app);
  assert.deepEqual(bulletTexts(app), ['about x1', 'about x2', 'about x3'],
    'and a deeper load restores every bullet — nothing was destroyed to hide them');
});

// ── B11: the deferral `continue` is load-bearing ────────────────────────────────
test('BUG-113 B11: a topic whose only unread post is deferred paints no card at all', async () => {
  // Deleting the `continue` from the deferred branch — leaving the `reachable.add` in place —
  // is caught by nothing else.
  //
  // What ships if it is ever deleted: a deferred post falls through into `counts[gid]`, so a topic
  // whose only unread post is deferred paints a card reading "0 posts" with an EMPTY RAIL and a
  // bullet, sitting in the stream directly above the very post it describes. The reader sees the
  // post twice — once as a card, once as a phantom topic. `counts[gid] > 0` is the only thing
  // stopping it, and it also gates `paintableTileCount`, which decides whether the grouping switch
  // is inert.
  //
  // The narrowing RESTS on this guard, which is why it is pinned here.
  const { app } = boot({
    store: {
      focus_done: JSON.stringify(['x1']),
      focus_groups: groupState({
        assignments: { x1: G },
        groups: { [G]: { label: 'AI', summary: [{ text: 'about x2', item_ids: ['x2'] }] } },
        unfiled: ['x2'],
      }),
    },
    // The classify that finally places x2 — the moment it becomes assigned AND deferred, because it
    // is already on screen and must not be yanked out from under the reader.
    reply: [{ label: 'AI', item_ids: ['x2'], summary: [{ text: 'about x2', item_ids: ['x2'] }] }],
  });
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  assert.equal(streamIds(app).includes('x2'), true,
    'precondition: x2 is visible in the stream — that is what makes it deferred rather than lifted');
  assert.equal(cardFor(app), undefined,
    'and NO topic card paints: the group\'s only unread post is already on screen, so a card would '
    + 'claim "0 posts" over an empty rail and show the reader the same post twice');
});
