// ONE STREAM. A TOPIC IS A CARD AMONG THE POSTS.
//
// Today `renderGroupGrid` paints collapsed tiles into `#group-grid` above a separate `#feed`, and a
// tile shows only a label and a count until it is tapped. A reader with 8 topics scrolls past 8
// closed tiles to reach one post and learns nothing from them without tapping each one. The split is
// structural cost too: the same feed is read in two places under two rules, which is where
// several counting and routing bugs lived.
//
// This file pins the replacement: `#topics-head` and `#group-grid` are gone, a topic renders as an
// always-expanded `.topic-card` INSIDE `#feed`, its posts sit on a horizontal rail as reduced cards
// carrying Archive/Done, and the drill-in is deleted outright.
//
// ── THE DOM CONTRACT THESE TESTS DEFINE ──────────────────────────────────────────────────────────
//   .topic-card[data-gid]              the card, inside #feed, WITHOUT `.card`
//     .tc-label                        the topic label
//     .tc-count                        "N posts"
//     button.tc-done                   "Mark all done"
//     .tc-rail > .tc-slide.tc-summary  slide one, the live summary — it sits inside the
//                                      rail and has no fixed 190px box
//                > ul.tc-bullets > li  the live summary itself, no fixed height any more
//                > .tc-empty           "No summary yet", `.hidden` unless the list painted nothing
//            > .tc-slide[data-id]      one slide per post the count claims
//       .tc-post                       the reduced post card, also WITHOUT `.card`
//         .btn-done / .btn-archive     reusing the app's existing action classes
//     .tc-dots > .tc-dot               one dot per slide
//
// Built as APPENDED NODES, not one `innerHTML` blob — the harness stores `innerHTML` as a string and
// never parses it, so a blob makes every routing decision here unassertable. Today's `.group-card`
// is exactly such a blob, which is why its label, count, buttons and bullets are pinned by nothing.
//
// ── THE VACUITY TRAP ─────────────────────────────────────────────────────────────────────────────
// T1-T13 each lead with an existence guard naming the value it read, so none of them can pass
// vacuously against a tree where no `.topic-card` exists. That matters because three behaviours
// hold even WITHOUT topic cards, for reasons that have nothing to do with them:
//     - the badge reads L + G, because an assigned post is rendered into `#feed` and hidden with
//       `.grouped-out`, so `updateCount` counts the stream once and adds `countGroupedUnread()`.
//       What T4 pins is that it STAYS L + G once topic cards enter `#feed` — the L + 2G failure
//       a nested card carrying `.card` would produce.
//     - `#caughtup` stays hidden on an all-grouped feed.
//     - grouping OFF returns every post visibly.
//   Written without their guards, T4/T5/T11 would be green with no topic card built and pin nothing.
//
// The pull-to-refresh / nested-scroll arbitration IS testable here: the harness records listeners,
// and a test can call them. `initPullToRefresh` attaches to `#view-feed`, which the harness memoises,
// and the pull's effect is `#feed-body`'s `style.transform` — real observable output, not "was a
// function called". T17-T19 below drive it.
//
// WHAT REMAINS UNTESTABLE, and needs a person on a handset: whether the arbitration FEELS
// right under a thumb — the thresholds, the rail's swipe, the 530px card, the 127px peek, and whether
// the bullet fade reads as deliberate rather than broken. A test can pin WHICH gesture wins; only a
// person can say whether the right one won.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../test-helpers/app-harness.mjs';

const APP_JS = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const INDEX_HTML = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');

// RELATIVE to now, never a frozen constant: the prune treats an in-hand post older than WINDOW_DAYS
// as evidence of a wrong device clock, so a fixed timestamp would drift a passing suite into one
// asserting the opposite as months go by.
const PUBLISHED = Date.now() - 2 * 86400_000;

const xPost = (id, text = `post ${id} says something about the topic`) => ({
  id, source: 'twitter', text, published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});
// Loose posts are YouTube on purpose: an unclassified X post is HELD (`.grouping-pending`) for
// 4.4-10.3s while it is classified, so using X for the "L" half would make the badge arithmetic depend on a
// timer rather than on the criterion. A video is never groupable and never held.
const ytPost = (id) => ({
  id, videoId: id, source: 'youtube', title: `video ${id}`, published: PUBLISHED,
  channel: { id: 'c3', name: 'A channel', source: 'youtube' },
});

// The gid a real classify would MINT for this label — `groupIdFor` derives it from the label, so a
// fixture inventing its own id seeds a group the endpoint's reply can never merge into.
const G_AI = 'g_ai_news';
const G_MKT = 'g_markets';
const AI_NEWS = {
  label: 'AI news',
  summary: [
    { text: 'a first point about AI', item_ids: ['x1'] },
    { text: 'a second point about AI', item_ids: ['x2'] },
  ],
};
const MARKETS = { label: 'Markets', summary: [{ text: 'a point about markets', item_ids: ['x3'] }] };

// `v: 2` (GROUP_STATE_VERSION) IS LOAD-BEARING, and its absence is silent. `migrateGroupSummaries`
// runs on every boot and clears every summary when `state.v < GROUP_STATE_VERSION` — so a fixture
// without it seeds bullets that are wiped before the first render, and the card paints an EMPTY
// 190px bullet box. Found by T18 needing a bullet to put a finger on; nothing else here had ever
// asserted a bullet, so the whole region was rendering blank behind a green suite.
const groupState = (over = {}) => JSON.stringify({
  assignments: {}, groups: {}, unfiled: [], updatedAt: PUBLISHED, v: 2, ...over,
});

/** Boot a browser with grouping ON unless told otherwise. */
function boot({ store = {}, reply = [], grouped = true, capped = false } = {}) {
  const app = createApp({
    store: {
      focus_device_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      focus_group_view: grouped ? 'on' : 'off',
      ...store,
    },
  });
  app.setFetch(async (url) => {
    if (String(url).includes('/api/group')) {
      return { ok: true, status: 200, json: async () => ({ groups: reply, capped }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return app;
}

const render = (app, items, failed = []) =>
  app.ctx.renderFeedResults({ items, failed, cappedNames: [], totalChannels: items.length + failed.length });

// renderFeedResults fires the classify without awaiting it.
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };

// ── Readers ───────────────────────────────────────────────────────────────────
const topicCards  = app => app.queryAll('#feed .topic-card');
const cardFor     = (app, gid) => topicCards(app).find(c => c.dataset.gid === gid);
const q           = (app, gid, sel) => app.queryAll(`#feed .topic-card[data-gid="${gid}"] ${sel}`);
const textOf      = (app, gid, sel) => q(app, gid, sel)[0]?.textContent;
// The rail's first slide is the SUMMARY, which carries no `data-id` — so the raw map
// now leads with `undefined`. Filtered rather than re-worded: the question every caller asks is
// "which POSTS does this rail list, in what order", and that question is unchanged.
//
// ⚠️ WHAT THE FILTER COSTS. It drops only FALSY ids, so a summary that wrongly carried a `data-id`
// is truthy, survives, and reds every ordered deepEqual on its own — that case is safe. What the
// filter genuinely hides is a summary appended in the wrong
// PLACE: unfiltered, a trailing `undefined` failed every ordered comparison here; filtered, only
// T1 and T6 look at where the summary sits.
const railIds     = (app, gid) => q(app, gid, '.tc-slide').map(s => s.dataset.id).filter(Boolean);
const bulletTexts = (app, gid) => [...(q(app, gid, '.tc-bullets')[0]?.children || [])].map(li => li.textContent);
const streamIds   = app => app.el('feed').children.map(c => c.dataset.id).filter(Boolean);
const plainCards  = app => app.queryAll('#feed .card:not(.removing):not(.grouped-out)');
const badge       = app => app.el('feed-count').textContent;
const headHidden  = app => app.el('videos-head').classList.contains('hidden');

// Everything a subtree renders, whichever way it was built. The harness keeps `innerHTML` as an
// unparsed STRING, so a negative assertion that only walks `children` would be satisfied by markup
// it never looked at. Walk both.
const deepHtml = (el) => {
  let out = `${String(el.innerHTML || '')} ${String(el.className || '')} ${String(el.textContent || '')}`;
  for (const c of el.children || []) out += ' ' + deepHtml(c);
  return out;
};

// A guard every test opens with. `assert(cards.length)` alone would report "expected 0 to be truthy",
// which says nothing about WHY; this names the tree it actually read.
function guardTopicCard(app, gid) {
  const card = cardFor(app, gid);
  assert.ok(card,
    `guard: a .topic-card[data-gid="${gid}"] must exist inside #feed before anything else here means `
    + `something. Found ${topicCards(app).length} topic cards; #feed holds [${streamIds(app).join(', ')}]. `
    + `On main this is 0 — topics are painted into #group-grid instead, which is what this task deletes.`);
  return card;
}

// ── one card in the stream, always expanded ───────────────────────────────────

test('TASK-098 T1 (C1,C2): a topic renders as one always-expanded card inside #feed', async () => {
  const app = boot({
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  const card = guardTopicCard(app, G_AI);
  assert.equal(textOf(app, G_AI, '.tc-label'), 'AI news',
    'the label must be readable without any tap');
  assert.equal(textOf(app, G_AI, '.tc-count'), '2 posts',
    'and so must the count');
  const markAll = q(app, G_AI, '.tc-done');
  assert.equal(markAll.length, 1,
    'and "Mark all done" must be present in the header, not behind an expand');
  assert.equal(markAll[0].type, 'button',
    'a real <button type="button">, so it is keyboard-reachable and cannot submit anything');
  assert.equal(markAll[0].textContent, 'Mark all done', 'labelled for what it does');
  assert.equal(card.classList.contains('expanded'), false,
    'there is no collapsed state to expand OUT of — `.expanded` must not appear on a topic card');
  assert.ok(!/g-caret|▾/.test(deepHtml(card)),
    'no caret: the card has no accordion affordance because it has no accordion');
  // The 190px bullet area is a THIRD of the card and nothing asserted it until the fixture bug above
  // rendered it permanently empty behind a green suite.
  assert.deepEqual(bulletTexts(app, G_AI), ['a first point about AI', 'a second point about AI'],
    'the summary must render — this is what the reader learns without tapping, and the whole reason '
    + 'a topic is worth being a card rather than a tile');
});

test('TASK-098 T2 (C3): the rail lists exactly the posts the count claims, in order', async () => {
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
      focus_done: JSON.stringify(['x2']),   // read, so the topic no longer claims it
    },
  });

  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();

  guardTopicCard(app, G_AI);
  // JSON round-trip, not deepEqual: values returned by app.js are built in the vm's realm and carry
  // ITS Array.prototype, so node:assert/strict compares prototypes and fails on structurally
  // identical arrays. Documented at the top of app-harness.mjs.
  const expected = JSON.parse(JSON.stringify(app.ctx.visibleGroupUnreadIds(G_AI)));
  assert.deepEqual(expected, ['x1', 'x3'],
    'guard: the fixture must leave exactly two unread posts, or the assertion below is untested');
  assert.deepEqual(railIds(app, G_AI), expected,
    'the rail must list visibleGroupUnreadIds(gid) exactly — same members, same order. A rail built '
    + 'from groupUnreadIds() instead would show a post the header count does not claim, which is '
    + '[BUG-029]\'s shape');
  assert.equal(textOf(app, G_AI, '.tc-count'), '2 posts',
    'and the header count must agree with the rail it sits above');
});

test('TASK-098 T3 (C4): a post inside the rail renders reduced', async () => {
  const app = boot({
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });

  render(app, [{
    ...xPost('x1', 'the post body that must be readable'),
    url: 'https://x.com/xacct/status/1',
    media: [{ url: 'https://pbs.twimg.com/media/a.jpg', width: 100, height: 100 }],
    quoted: { author: { name: 'Someone', handle: 'someone' }, text: 'a quoted post', url: 'https://x.com/someone/status/2' },
    isNew: true,
  }]);
  await settle();

  guardTopicCard(app, G_AI);
  // Indexed by id rather than by position — slide 0 is the summary now. The subject of
  // this test is what a POST slide renders, so it must name the post rather than take the first node.
  const slide = q(app, G_AI, '.tc-slide[data-id="x1"]')[0];
  assert.ok(slide, 'guard: the rail must hold a slide for x1');
  const html = deepHtml(slide);

  assert.ok(html.includes('the post body that must be readable'), 'the text must render');
  assert.ok(html.includes('xacct'), 'the @handle must render');
  assert.ok(html.includes('X acct'), 'the display name must render');
  assert.ok(html.includes('x.com/xacct/status/1'),
    'the X link is REQUIRED, not decorative: the rail is ~240px and a long post truncates, so '
    + 'without it a truncated post is a dead end (Asli, 2026-08-29)');
  assert.equal(q(app, G_AI, '.tc-slide .btn-done').length, 1, 'Done must be on the nested card');
  assert.equal(q(app, G_AI, '.tc-slide .btn-archive').length, 1, 'Archive must be on the nested card');

  // The fixture deliberately carries media, a quote and isNew, so these three are real exclusions
  // rather than assertions about an item that never had them.
  assert.ok(!html.includes('tweet-media'), 'no media element in a rail slide');
  assert.ok(!html.includes('tweet-quoted'), 'no quoted-tweet block in a rail slide');
  assert.ok(!html.includes('new-badge'), 'no "New" badge in a rail slide');
});

// ── the counting contract ─────────────────────────────────────────────────────

test('TASK-098 T4 (C5,C7): the badge reads L + G, not L + 2G, with topic cards in the stream', async () => {
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_MKT },
        groups: { [G_AI]: AI_NEWS, [G_MKT]: MARKETS },
      }),
    },
  });

  render(app, [ytPost('v1'), ytPost('v2'), xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();

  // The guard is the whole test. The badge reads "5 new" here — 2 stream cards + 3 grouped — even
  // with no topic cards, so without this the assertion below passes against a screen with no topic card on it at all.
  guardTopicCard(app, G_AI);
  guardTopicCard(app, G_MKT);

  assert.equal(badge(app), '5 new',
    'L=2 loose + G=3 grouped must read "5 new". "8 new" means a nested rail card carries `.card` and '
    + 'is counted by updateCount AND by countGroupedUnread (L + 2G); "7 new" means the topic cards '
    + 'themselves carry `.card` (L + G + T); "2 new" means the grouped half is not counted at all');
  assert.equal(plainCards(app).length, 2,
    'exactly the two loose videos may match `#feed .card:not(.removing):not(.grouped-out)` — the '
    + 'selector updateCount and checkEmpty both use. This is criterion 7 measured at its own formula');
});

test('TASK-098 T5 (C5): an all-grouped feed is not "caught up"', async () => {
  const app = boot({
    store: {
      focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }),
    },
  });

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  guardTopicCard(app, G_AI);   // main satisfies the rest of this test for unrelated reasons
  assert.equal(badge(app), '2 new', 'the two grouped posts are unread and must be counted');
  assert.equal(app.el('caughtup').classList.contains('hidden'), true,
    '"You\'re all caught up" must NOT show while the badge is non-zero — a feed whose posts are all '
    + 'grouped still has two posts to read');
});

test('TASK-098 T6 (C6): the "Posts" head shows on a feed of only topic cards', async () => {
  const app = boot({
    store: {
      focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }),
    },
  });

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  guardTopicCard(app, G_AI);
  assert.equal(plainCards(app).length, 0,
    'guard: every post here is grouped, so nothing may match the `.card` selector — this is the '
    + 'exact shape that makes the head vanish');
  assert.equal(headHidden(app), false,
    'the Posts head must be SHOWN. updateSectionHeads decides this by asking #feed for a '
    + '`.card:not(.removing):not(.grouping-pending):not(.grouped-out)`, and with criterion 7 in force '
    + 'a feed of only topic cards matches ZERO — so criteria 6 and 7 are unsatisfiable together '
    + 'until updateSectionHeads learns to count topic cards');
});

test('TASK-098 T7 (C7): neither a topic card nor its rail cards carry `.card`', async () => {
  const app = boot({
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });

  render(app, [xPost('x1')]);
  await settle();

  const card = guardTopicCard(app, G_AI);
  assert.equal(card.classList.contains('card'), false,
    'a topic card carrying `.card` would be counted by updateCount as a post (L + G + T)');

  const slide = q(app, G_AI, '.tc-slide')[0];
  assert.ok(slide, 'guard: the rail must hold a slide');
  const post = q(app, G_AI, '.tc-post')[0];
  assert.ok(post, 'guard: the slide must hold a reduced post card');
  assert.equal(post.classList.contains('card'), false,
    'THE RAIL LIVES INSIDE #feed. A nested card carrying `.card` is counted by updateCount AND by '
    + 'countGroupedUnread — a badge of L + 2G. renderItemCard/renderTweetCard set '
    + '`div.className = \'card\'`, so the reduced renderer must not reuse them wholesale');
  assert.equal(app.queryAll('#feed .tc-rail .card').length, 0,
    'and nothing anywhere in the rail may match `.card`');
});

// ── the data-writing paths ────────────────────────────────────────────────────

test('TASK-098 T8 (C8): "Mark all done" marks exactly that topic, removes the card, offers Undo', async () => {
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_MKT },
        groups: { [G_AI]: AI_NEWS, [G_MKT]: MARKETS },
      }),
    },
  });

  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();

  guardTopicCard(app, G_AI);
  guardTopicCard(app, G_MKT);
  const btn = q(app, G_AI, '.tc-done')[0];
  assert.equal(app.click(btn), 1,
    'guard: exactly one click handler must be wired. A tap on an unwired button is silently a no-op, '
    + 'indistinguishable from a handler that correctly did nothing ([BUG-017])');
  app.runTimers(4);

  assert.deepEqual(JSON.parse(app.get('focus_done') || '[]').sort(), ['x1', 'x2'],
    'exactly the topic\'s own posts are marked done — x3 belongs to Markets and must be untouched');
  assert.equal(cardFor(app, G_AI), undefined, 'the emptied topic card must be gone from the stream');
  assert.ok(cardFor(app, G_MKT), 'and the other topic must still be there');
  assert.ok(app.toasts.includes('Marked 2 done'),
    `the reader must be told what happened; toasts were ${JSON.stringify(app.toasts)}`);
  const undo = app.el('toast').querySelector('.toast-action');
  assert.equal(undo.textContent, 'Undo', 'and offered Undo by name');
  assert.equal(undo.classList.contains('hidden'), false, 'with the action actually revealed');
  // The offer is not the point — taking it is. This is a bulk write over posts the reader never saw
  // individually, so Undo is the only way back from a mistaken tap.
  undo.onclick();
  assert.deepEqual(JSON.parse(app.get('focus_done') || '[]'), [],
    'taking the Undo must un-mark every post it marked');
});

test('TASK-098 T9 (C9): Done on a rail post removes it and decrements the header count', async () => {
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
    },
  });

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();

  guardTopicCard(app, G_AI);
  assert.equal(textOf(app, G_AI, '.tc-count'), '2 posts', 'guard: the count starts at 2');
  const done = app.queryAll(`#feed .topic-card[data-gid="${G_AI}"] .tc-slide[data-id="x1"] .btn-done`)[0];
  assert.ok(done, 'guard: the slide for x1 must carry a Done button');
  assert.equal(app.click(done), 1, 'guard: Done must be wired');
  app.runTimers(4);

  assert.deepEqual(railIds(app, G_AI), ['x2'], 'x1 must leave the rail');
  assert.equal(textOf(app, G_AI, '.tc-count'), '1 post',
    'the header count must follow the rail — and singularise');
  // The dot row is a THIRD claim about the same number, and it was unpinned: the trim could pop the
  // local array and never touch the DOM, leaving a topic wearing a dot for every post it ever held.
  //
  // One post means TWO slides, because slide one is the summary, so the row keeps two dots (T6).
  // And the hint is currently gone from every card — see T3, which records that as provisional.
  assert.equal(q(app, G_AI, '.tc-dot').length, 2, 'one dot per remaining SLIDE, not per slide ever');
  assert.equal(q(app, G_AI, '.tc-hint').length, 0, 'and no hint — there is no longer one to keep');
  assert.deepEqual(JSON.parse(app.get('focus_done') || '[]'), ['x1'], 'and x1 must be recorded read');
});

test('TASK-098 T10 (C9): the last post leaving removes the card and leaves no hidden orphan', async () => {
  const app = boot({
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });

  render(app, [xPost('x1'), ytPost('v1')]);
  await settle();

  guardTopicCard(app, G_AI);
  const done = app.queryAll(`#feed .topic-card[data-gid="${G_AI}"] .tc-slide[data-id="x1"] .btn-done`)[0];
  assert.ok(done, 'guard: the slide for x1 must carry a Done button');
  assert.equal(app.click(done), 1, 'guard: Done must be wired');
  app.runTimers(4);

  assert.equal(cardFor(app, G_AI), undefined, 'the emptied topic card must be gone');
  assert.equal(streamIds(app).includes('x1'), false,
    'NO HIDDEN ORPHAN. The post has a second home — a `.grouped-out` card in the stream ([TASK-099] '
    + 'decision 1) — and a writer that takes it out of the rail must take that one too. Leaving it '
    + 'means setGroupedCardsHidden un-hides it on the next toggle and a post the reader marked done '
    + 'is back in the feed, counted as unread. That orphan is the upstream cause of [BUG-103]');
  assert.deepEqual(streamIds(app), ['v1'], 'only the loose video remains');
});

// ── the toggle still works ────────────────────────────────────────────────────

test('TASK-098 T11 (C10): turning grouping off returns every post to the stream, no reload', async () => {
  const app = boot({
    store: {
      focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }),
    },
  });

  render(app, [xPost('x1'), xPost('x2'), ytPost('v1')]);
  await settle();

  guardTopicCard(app, G_AI);   // without this, main passes: it has no topic cards to remove
  app.ctx.wireApp();
  assert.equal(app.click(app.el('toggle-grouping')), 1, 'guard: the switch must be wired');
  app.runTimers(4);

  assert.equal(topicCards(app).length, 0, 'no topic card may survive with grouping off');
  assert.deepEqual(
    app.queryAll('#feed .card:not(.grouped-out):not(.grouping-pending):not(.removing)').map(c => c.dataset.id).sort(),
    ['v1', 'x1', 'x2'],
    'every post returns to the chronological stream, VISIBLY, with no reload');
  assert.equal(badge(app), '3 new', 'and the badge counts each of them exactly once');
});

// ── the drill-in is gone ──────────────────────────────────────────────────────

test('TASK-098 T12 (C12): the drill-in is deleted, with no path that can open it', async () => {
  const app = boot({
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });

  render(app, [xPost('x1')]);
  await settle();

  guardTopicCard(app, G_AI);
  assert.equal(q(app, G_AI, '.g-see').length, 0, 'no "See all" control may render');
  assert.ok(!/See all/.test(deepHtml(cardFor(app, G_AI))), 'nor any "See all" text');
  assert.equal(typeof app.ctx.openGroupDetail, 'undefined',
    'openGroupDetail must not exist — a deleted view with a live opener is a path, not a deletion');
  assert.equal(typeof app.ctx.closeGroupDetail, 'undefined', 'nor closeGroupDetail');
  assert.ok(!INDEX_HTML.includes('id="group-detail"'), '#group-detail must be gone from the markup');
});

// ── the capped signal survives the grid ───────────────────────────────────────

test('TASK-098 T13 (C13): a capped classify still reaches the reader', async () => {
  const app = boot({
    capped: true,
    reply: [{ label: 'AI news', item_ids: ['x1', 'x2'], summary: [{ text: 'a point', item_ids: ['x1'] }] }],
  });

  render(app, [xPost('x1'), xPost('x2')]);
  await settle(10);
  app.runTimers(4);

  guardTopicCard(app, G_AI);
  assert.equal(app.el('group-note').classList.contains('hidden'), false,
    'renderGroupGrid:1162 is the ONLY site that reveals #group-note today, and this task deletes '
    + 'that function. Without a reveal in the new renderer, `_groupsCapped` is still set at app.js:927 '
    + 'and never read — silent truncation, which is exactly what the note exists to prevent');
});

test('TASK-098 T14 (C13): the note no longer claims the posts are "below"', () => {
  const m = INDEX_HTML.match(/id="group-note"[^>]*>([^<]*)</);
  assert.ok(m, 'guard: #group-note must still exist in the markup — criterion 13 keeps it');
  assert.ok(!/below/i.test(m[1]),
    `the note reads "${m[1].trim()}". In ONE STREAM there is no "below": ungrouped posts are `
    + 'interleaved in time order, so the sentence points at a layout that no longer exists');
  assert.ok(/time order|in the stream/i.test(m[1]),
    'it must say where they actually are');
  // MEANING, not vocabulary. Invert this sentence to "Every post WAS grouped
  // this time. They're in the stream, in time order." — announcing success at the exact moment
  // grouping was truncated — and both keyword checks above pass it. What matters is what the
  // reader is told, and a regex over nouns cannot see that.
  assert.ok(/weren't grouped|were not grouped|not all/i.test(m[1]),
    `the note must say some posts were NOT grouped; it reads "${m[1].trim()}"`);
  // And WHERE it sits. Moving it below #feed leaves every class, id and word intact while putting it
  // off-screen under a full feed — present but ineffective, the guard shape a delete-only check misses.
  assert.ok(INDEX_HTML.indexOf('id="group-note"') < INDEX_HTML.indexOf('id="feed"'),
    'the note must come BEFORE #feed in the markup, or on a real feed the reader never reaches it');
});

// ── the markup and the source ─────────────────────────────────────────────────

test('TASK-098 T15 (C1): #group-grid and #topics-head are gone from the markup', () => {
  assert.ok(!INDEX_HTML.includes('id="group-grid"'), '#group-grid must not exist');
  assert.ok(!INDEX_HTML.includes('id="topics-head"'), '#topics-head must not exist');
  assert.ok(INDEX_HTML.includes('id="videos-head"'),
    'guard: #videos-head must SURVIVE as the only head — this test must not pass by deleting both');
});

test('TASK-098 T16 (C2): the accordion is gone from the codebase', () => {
  assert.ok(!/toggleGroupCard/.test(APP_JS),
    'toggleGroupCard exists only to collapse tiles and does not survive an always-expanded card');
  assert.ok(!/classList\.(add|remove|toggle|contains)\(['"]expanded['"]/.test(APP_JS),
    'nor any `expanded` CLASS operation — the accordion state it drove. (Narrowed from `/\\.expanded/`, '
    + 'which also matched `u.expanded`, a field on X\'s URL entities and nothing to do with tiles.)');
  const code = APP_JS.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n');
  assert.ok(!/group-card/.test(code),
    'and `.group-card` itself is gone from live code — the tile the accordion collapsed. Comments '
    + 'are stripped first on purpose: the class is NAMED in a comment recording what was deleted and '
    + 'why, and a substring check cannot tell a reference from an epitaph');
  assert.ok(/renderFeedResults/.test(APP_JS),
    'guard: this test must not pass because app.js failed to load');
});


// ── gesture arbitration ───────────────────────────────────────────────────────
//
// The one genuinely new interaction, and the reason the fallback exists: a vertically-scrolling
// bullet box and a horizontally-scrolling rail, both inside a vertically-scrolling feed. Pull-to-
// refresh asked only "is the page at the top and is the finger moving down" — never what is UNDER
// the finger — so without arbitration, scrolling the bullets back up stretches the page and reloads.
//
// Driven through the REAL listeners on `#view-feed`, with REAL rendered nodes as drag targets, and
// asserted on `#feed-body`'s transform — what the reader would actually see move.

/** Fire a drag through the real handlers. `touchend` is NOT optional: it is what resets `pulling`,
 *  and without it state leaks from one drag into the next — which made a probe of this very code
 *  report rule (a) BROKEN when it was working. */
function drag(app, { from, to, target }) {
  const view = app.el('view-feed');
  const body = app.el('feed-body');
  const fire = (type, ev) => view.listeners.filter(l => l.type === type).forEach(l => l.fn(ev));
  const ev = (x, y) => ({ touches: [{ clientX: x, clientY: y }], target, preventDefault() { this._pd = true; } });
  body.style.transform = '';
  fire('touchstart', ev(from.x, from.y));
  const move = ev(to.x, to.y);
  fire('touchmove', move);
  const out = { transform: body.style.transform || '(untouched)', prevented: !!move._pd };
  fire('touchend', ev(to.x, to.y));
  return out;
}

async function bootWithTopic() {
  const app = boot({
    store: { focus_groups: groupState({ assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2'), ytPost('v1')]);
  await settle();
  guardTopicCard(app, G_AI);
  return app;
}

test('TASK-098 T17 (C11): the control — a downward drag on the feed still pulls', async () => {
  // THE NON-VACUITY GUARD for T18 and T19. Both assert that a gesture is REFUSED, and "refused" and
  // "the instrument cannot see a pull at all" are the same reading. This proves the difference.
  const app = await bootWithTopic();
  const card = app.queryAll('#feed .card')[0];
  assert.ok(card, 'guard: a plain stream card to start the drag on');

  const r = drag(app, { from: { x: 100, y: 100 }, to: { x: 100, y: 180 }, target: card });
  assert.equal(r.prevented, true, 'the page takes the gesture over the browser native pull');
  assert.equal(r.transform, 'translateY(40px)',
    '80px of finger travel at 0.5 resistance stretches the feed 40px — the value the reader sees');
});

test('TASK-098 T18 (C11): a drag inside a scrolled bullet box does not pull the page', async () => {
  const app = await bootWithTopic();
  const bullets = app.queryAll(`#feed .topic-card[data-gid="${G_AI}"] .tc-bullets`)[0];
  assert.ok(bullets, 'guard: the bullet box must exist');
  const li = bullets.children[0];
  assert.ok(li, 'guard: and hold a bullet to put the finger on');

  bullets.scrollTop = 57;   // the reader has scrolled down inside the box; it has somewhere to go up
  const r = drag(app, { from: { x: 100, y: 100 }, to: { x: 100, y: 180 }, target: li });

  assert.equal(r.transform, '(untouched)',
    'the gesture belongs to the bullet box. Stretching the page here is the defect criterion 11 '
    + 'forbids: the reader scrolls the summary back up and the feed reloads under them');
  assert.equal(r.prevented, false,
    'and the box keeps its own native scroll — preventDefault here would cancel the very scroll '
    + 'this guard is protecting');
});

test('TASK-098 T19 (C11): a horizontal swipe on the rail does not pull the page', async () => {
  const app = await bootWithTopic();
  const post = app.queryAll(`#feed .topic-card[data-gid="${G_AI}"] .tc-post`)[0];
  assert.ok(post, 'guard: a rail post to swipe on');

  // 140px across, 12px down — a real thumb never swipes exactly horizontally.
  const r = drag(app, { from: { x: 200, y: 100 }, to: { x: 60, y: 112 }, target: post });

  assert.equal(r.transform, 'translateY(0px)',
    'the rail is paging, not the page pulling. Note this differs from T18 by SIGNATURE as well as '
    + 'outcome: rule (a) bails at touchstart and never calls place(), rule (b) bails inside touchmove '
    + 'and springs back — so the two assertions pin DIFFERENT guards and neither can stand in for '
    + 'the other');
  assert.equal(r.prevented, false,
    'and preventDefault must not fire, or the handler deciding the rail should keep the gesture '
    + 'would cancel the rail scroll on its way past');
});

test('TASK-098 T20 (C-carousel): the dots are wired to the rail\'s own slides', async () => {
  // The defect this guards: `wireCarouselDots` once took TWO parameters and queried hardcoded
  // `.tweet-slide` / `.tweet-dot` (the in-tweet image carousel), so a
  // `'.tc-slide', '.tc-dot'` passed as a third and fourth argument were silently discarded by
  // JavaScript. Both lists came back empty, the observer watched nothing, and the first dot stayed
  // lit forever while the reader swiped — visible on screen, invisible to every other test.
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
    },
  });
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();

  guardTopicCard(app, G_AI);
  const slides = q(app, G_AI, '.tc-slide');
  // Four, not three — the summary is a page too. The assertions below are unchanged, and
  // they got STRONGER for free: "every slide must be watched" now includes the summary slide, which
  // is what makes dot 0 track it.
  assert.equal(slides.length, 4, 'guard: three posts plus the summary to page between');
  assert.equal(q(app, G_AI, '.tc-dot').length, 4, 'guard: and a dot each');

  const watching = app.observers.filter(io => slides.some(sl => io.observed.includes(sl)));
  assert.ok(watching.length > 0,
    `no IntersectionObserver was given a single rail slide to watch, so the dots cannot track the `
    + `carousel. ${app.observers.length} observer(s) were constructed, watching `
    + `[${app.observers.map(io => io.observed.length).join(', ')}] elements`);
  assert.ok(slides.every(sl => watching.some(io => io.observed.includes(sl))),
    'every slide must be watched — an observer given only some of them lights the wrong dot on the '
    + 'ones it missed');
});

// ── Gaps found by mutation testing ────────────────────────────────────────────────────────────────
// Each test below pins a defect that the tests above could not see.

test('TASK-098 T21 (battery G5): Undo after Mark-all brings the grouped posts back on screen', async () => {
  // THE WORST OF THEM. `markAllDone` repaints (every count is 0, so every topic card is destroyed);
  // only `undoMarkAll`'s own repaint rebuilds them. Drop that one line and Undo un-marks the posts in
  // storage and returns them to NOTHING on screen: their other home is a `.grouped-out` stream card
  // that stays hidden, while the badge counts them from storage. The reader sees "12 new" over twelve
  // posts visible nowhere, recoverable only by a pull-to-refresh. An exit path from a bulk write over
  // user data, and nothing else touches it — appbar's Undo guard is an UNGROUPED fixture.
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_MKT },
        groups: { [G_AI]: AI_NEWS, [G_MKT]: MARKETS },
      }),
    },
  });
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  assert.equal(topicCards(app).length, 2, 'guard: two topic cards before the bulk write');

  // NO `runTimers` BETWEEN THESE TWO CALLS. It fires every pending timer regardless of delay —
  // including the toast's 5s auto-hide, whose `hideToast` clears `_bulkDoneIds`, on which
  // `undoMarkAll` early-returns. Draining the queue here MANUFACTURES the expiry and the test then
  // measures a closed Undo window instead of the repaint. (The harness documents this as `runTimers`'
  // known blind spot; `advance` is the delay-aware driver. Both repaints below are synchronous, so
  // neither needs a clock at all.)
  app.ctx.markAllDone();
  assert.equal(topicCards(app).length, 0, 'guard: the bulk write cleared them');

  app.ctx.undoMarkAll();

  assert.deepEqual(JSON.parse(app.get('focus_done') || '[]'), [], 'guard: Undo really un-marked them');
  assert.equal(topicCards(app).length, 2,
    'both topic cards must come BACK. Un-marking a post that is then visible nowhere is worse than '
    + 'not offering Undo at all — the badge counts it and the reader cannot reach it');
  assert.equal(badge(app), '3 new', 'and the badge agrees with what is on screen again');
});

test('TASK-098 T22 (battery E4): reading the last post from a rail reaches "all caught up"', async () => {
  // The `checkEmpty()` in the empty-topic branch could be dropped with nothing failing: T10 keeps a
  // loose video in the feed, so no test ever Done-s the FINAL post of the whole feed from inside a
  // topic card. The reader clears their last post and the product's entire promise never appears.
  const app = boot({
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });
  render(app, [xPost('x1')]);          // NOTHING else in the feed — that is the point of the fixture
  await settle();

  guardTopicCard(app, G_AI);
  assert.equal(app.el('caughtup').classList.contains('hidden'), true, 'guard: not caught up yet');
  const done = app.queryAll(`#feed .topic-card[data-gid="${G_AI}"] .tc-slide[data-id="x1"] .btn-done`)[0];
  assert.equal(app.click(done), 1, 'guard: Done must be wired');
  app.runTimers(4);

  assert.equal(app.el('caughtup').classList.contains('hidden'), false,
    'clearing the last post — from a rail like anywhere else — must reach "You\'re all caught up"');
  assert.equal(badge(app), 'all caught up ✓');
});

test('TASK-098 T23 (battery B7/B8): a topic sits in its own chronological slot', async () => {
  // The HEADLINE claim of the task and it was pinned by nothing: `topicAnchor` could return null
  // unconditionally (every topic appended to the end) or match any assigned card rather than this
  // topic's, and the whole suite stayed green — because `streamIds` filters on `dataset.id`, which a
  // topic card deliberately does not carry, so no test read a topic card's POSITION at all.
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_MKT },
        groups: { [G_AI]: AI_NEWS, [G_MKT]: MARKETS },
      }),
    },
  });
  // x3 (Markets) is handed in FIRST, so the two topics anchor at different points in the stream —
  // sized so that "anchor at the first assigned card of ANY topic" gives a different answer from
  // "anchor at this topic's own".
  render(app, [xPost('x3'), xPost('x1'), xPost('x2')]);
  await settle();

  assert.equal(topicCards(app).length, 2, 'guard: both topics painted');
  const order = app.el('feed').children.map(c => c.dataset.gid || c.dataset.id);
  assert.deepEqual(order, [G_MKT, 'x3', G_AI, 'x1', 'x2'],
    'each topic card must sit immediately before the first card it owns — Markets ahead of x3, AI '
    + 'ahead of x1. Appending them instead puts every topic at the BOTTOM of the feed; anchoring on '
    + 'any assigned card puts both at the top, in count order. Both survived the suite');
});

test('TASK-098 T24 (battery A5): "Posts" does not head the caught-up screen', async () => {
  // `feedShown`'s `display !== 'none'` term survived. `showCaughtUp` hides #feed but does NOT destroy
  // its cards (Undo needs them), and #videos-head is a SIBLING of #feed — so without that term the
  // reader gets a "Posts" heading directly above "You're all caught up ✓", labelling nothing.
  const app = boot({ grouped: false });
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(headHidden(app), false, 'guard: the head shows while there are posts');

  app.ctx.markAllDone();
  app.runTimers(4);

  assert.equal(app.el('caughtup').classList.contains('hidden'), false, 'guard: the reader is caught up');
  assert.equal(app.el('feed').style.display, 'none', 'guard: #feed is hidden with its cards intact');
  assert.equal(headHidden(app), true,
    '"Posts" must not head a hidden feed — it would sit directly above the caught-up seal');
});

test('TASK-098 T25 (battery B2): a second paint does not stack duplicate topic cards', async () => {
  // The self-cleanup line was only half pinned: removing all but the FIRST topic card survived,
  // because proving the line exists needs only one topic, while the case its own comment describes —
  // a repaint over an already-painted feed — needs TWO topics AND two paints. Ship a partial slip and
  // the same topic renders twice, with two "Mark all done" buttons over one set of posts.
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_MKT },
        groups: { [G_AI]: AI_NEWS, [G_MKT]: MARKETS },
      }),
    },
  });
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  assert.equal(topicCards(app).length, 2, 'guard: two topics on the first paint');

  app.ctx.renderTopicCards();   // the background-classify path, straight in over a painted feed
  app.ctx.renderTopicCards();   // and again, because one repaint cannot show a partial cleanup

  assert.equal(topicCards(app).length, 2,
    'still two. Every repaint must clear ALL of its own cards first — clearing only the first leaves '
    + 'the rest stacking on every background classify');
  assert.deepEqual(topicCards(app).map(c => c.dataset.gid).sort(), [G_AI, G_MKT].sort(),
    'and one card per topic, not two of one');
});

// ── The CSS contract ─────────────────────────────────────────────────────────────────────────────
// Without these, a mutation to any of the topic card's CSS declarations passes the whole suite.
//
// This is a TEXT contract over `style.css`, which is weaker than rendering the page — it cannot see
// cascade, specificity or what a browser actually computes. It is here because the alternative was
// nothing, and because the repo already does exactly this for the hidden-id contract in docs.test.mjs.
// Scoped to the declarations whose failure is INVISIBLE IN A DESKTOP BROWSER AT DESK WIDTH but
// catastrophic on a handset — the rail not scrolling, the actions clipped out of a slide, the bulk
// control pushed off the card edge. How it LOOKS stays verify-by-looking; that is not what this pins.
const CSS = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const cssRule = (selector) => {
  const i = CSS.indexOf(selector + ' {');
  assert.ok(i >= 0, `guard: the rule "${selector}" must exist in style.css`);
  return CSS.slice(i, CSS.indexOf('}', i));
};

test('TASK-098 T26 (css): the topic card keeps the geometry the carousel depends on', () => {
  const card = cssRule('.topic-card');
  assert.match(card, /height:\s*530px/,
    'a FIXED height. `liveBullets` drops a bullet once its posts are read, so `auto` restructures the '
    + 'card under the reader\'s thumb mid-session — the precise defect the block comment forbids, and '
    + 'nothing enforced it');
  assert.match(card, /flex-direction:\s*column/,
    'header, rail and dots stack — THREE bands since [TASK-107] folded the bullets into the rail, '
    + 'where there were four. `row` puts them side by side in a 530px box either way');
  assert.match(card, /overflow:\s*hidden/, 'or the contents paint over the next card in the stream');
});

test('TASK-098 T27 (css): the rail can actually be swiped, and its posts can be acted on', () => {
  const rail = cssRule('.topic-card .tc-rail');
  assert.match(rail, /overflow-x:\s*auto/,
    'WITHOUT THIS THE RAIL DOES NOT SCROLL: a 12-post topic shows exactly one post forever, under a '
    + 'dot row still promising twelve');
  assert.match(rail, /scroll-snap-type:\s*x mandatory/, 'or it drifts between posts instead of paging');
  assert.match(rail, /flex:\s*1/, '`flex: 0` collapses the rail to nothing — the posts stop rendering at all');
  assert.match(rail, /min-height:\s*0/,
    'a flex child defaults to min-height:auto and refuses to shrink, so the rail overflows the fixed '
    + 'card and takes the dot row and the swipe hint out of the visible area with it');

  const text = cssRule('.topic-card .tc-text');
  assert.match(text, /min-height:\s*0/,
    'same rule, sharper consequence: without it a long post pushes Done and Archive out of the slide '
    + 'and they are clipped — the only way to clear a post from a topic disappears');
});

test('TASK-098 T28 (css): the header controls survive a long topic label', () => {
  const label = cssRule('.topic-card .tc-label');
  assert.match(label, /min-width:\s*0/,
    'an LLM writes these labels and they are not length-bounded. Without this the label refuses to '
    + 'shrink and pushes the count and "Mark all done" off the card edge, where they are clipped by '
    + 'the card\'s own overflow:hidden — a bulk control made unreachable by a long string');

  const done = cssRule('.topic-card .tc-done');
  assert.match(done, /min-height:\s*44px/,
    '[BUG-106]\'s standard, and this control is the same hazard class it was about: a bulk mark-read '
    + 'over every post in the topic. It was written at 34px under a comment CITING BUG-106 and '
    + 'missing its number — caught on the branch, before any deploy');
  assert.match(done, /background:\s*var\(--accent\)/,
    'or a destructive bulk control renders invisible and stays tappable');
});

test('TASK-098 T29 (css): the bullet box scrolls rather than silently truncating', () => {
  const bullets = cssRule('.topic-card .tc-bullets');
  // No fixed 190px height is asserted here. The height was a defect: a third of the
  // card spent on a box the summary was truncated inside. T5 of the summary-slide tests below asserts
  // its ABSENCE, so the number is still pinned — from the other side.
  assert.match(bullets, /flex:\s*1/,
    'the list fills its slide instead. `flex: none` collapses it to its content and the fade lands '
    + 'mid-card, back to promising more than it shows');
  assert.match(bullets, /overflow-y:\s*auto/,
    'WITHOUT THIS a summary past the slide height is unreachable while the fade below still promises '
    + 'more — silent truncation of the AI summary, the exact failure #group-note exists to prevent');
  assert.match(bullets, /-webkit-mask-image/, 'the fade is the only cue that more exist');
  assert.match(bullets, /\n\s+mask-image/,
    'and unprefixed too, or the cue is a webkit-only feature and Firefox gets a hard cut');
});

// ── Gaps found on a real handset ──────────────────────────────────────────────────────────────────
// Two defects that only showed on a phone. Both are in the SURGICAL DOM patch
// `finishGroupCardAction` performs after a rail action: it updates the header count, trims the dot
// row and drops the hint, and stops there.
//
// The dot COUNT falling is correct and is not the question; T20 asserts the observer WATCHES the
// slides and never fires it. The question neither asks is which dot is lit afterwards.

test('TASK-098 T30 (handset): the dot row still points at the right slide after a post leaves', async () => {
  // The symptom: mark a post done and the dot representing it stays lit below. The dot COUNT does
  // fall, which is why it reads
  // as intermittent — a glance at one topic looks right and the next looks stuck.
  //
  // The cause is a STALE CAPTURE, not a missing update. `wireCarouselDots` snapshots `slides` and
  // `dots` into arrays when the card is wired; `finishGroupCardAction` then removes a slide and pops
  // a dot from the DOM without re-wiring, so the observer keeps resolving `slides.indexOf(target)`
  // against an array that still holds the removed slide. Every index after the removal is off by
  // one, permanently — scrolling never corrects it.
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
    },
  });
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();

  guardTopicCard(app, G_AI);
  const slideFor = (id) => q(app, G_AI, '.tc-slide').find(s => s.dataset.id === id);
  const dotFlags = () => q(app, G_AI, '.tc-dot').map(d => d.classList.contains('active'));
  const scrollTo = (id) => {
    const target = slideFor(id);
    assert.ok(target, `guard: a slide for ${id} must be on the rail to scroll to it`);
    const watching = app.observers.filter(io => io.observed.includes(target));
    assert.ok(watching.length > 0, `guard: no observer is watching ${id}, so the dots cannot track it`);
    watching.forEach(io => io.cb([{ target, isIntersecting: true, intersectionRatio: 1 }]));
  };

  // Every count here gains one for the summary slide, and x2's INDEX gains one with it.
  // The defect this test pins is unchanged — a stale `slides` capture still lights the wrong dot, and
  // still by exactly one position, so the expected values below stay discriminating.
  assert.equal(q(app, G_AI, '.tc-slide').length, 4, 'guard: three posts plus the summary');
  assert.deepEqual(dotFlags(), [true, false, false, false], 'guard: the first dot starts lit');

  // The mechanism works before anything is removed — without this the test could pass by the dots
  // never moving at all, which is the defect T20 was written for.
  scrollTo('x2');
  assert.deepEqual(dotFlags(), [false, false, true, false],
    'guard: x2 is the THIRD slide now (summary, x1, x2), so the third dot lights');

  const done = app.queryAll(`#feed .topic-card[data-gid="${G_AI}"] .tc-slide[data-id="x1"] .btn-done`)[0];
  assert.equal(app.click(done), 1, 'guard: Done on the first slide must be wired');
  app.runTimers(4);

  assert.deepEqual(railIds(app, G_AI), ['x2', 'x3'], 'guard: x1 must leave the rail');
  assert.equal(q(app, G_AI, '.tc-dot').length, 3, 'guard: and the dot row must shrink to three');

  // x2 is now the SECOND slide, behind the summary. The reader looking at it must see the second dot.
  scrollTo('x2');
  assert.deepEqual(dotFlags(), [false, true, false],
    'the dot row must track the rail as it stands now: x2 is slide 1 after x1 left, so the second dot '
    + 'lights. A stale capture still holding x1\'s slide lights the THIRD — the reader sees the dot '
    + 'for a post they just removed still sitting there, which is what the handset walk reported');
});

test('TASK-098 T31 (handset): a bullet goes when its last post is read', async () => {
  // The symptom: the bullet points do not go away when a post is marked done; they stay the same.
  //
  // `liveBullets` is a render-time filter and is only ever called from `buildTopicCard`, so the
  // bullets are computed once when the card paints. `finishGroupCardAction` never re-runs it, and a
  // single Done does not repaint the card — so the list goes stale until a reload, a grouping toggle
  // or a background classify happens to rebuild it. Correct, then wrong, then quietly correct again.
  //
  // This is the behaviour `app.js`'s own bullet-builder comment describes
  // ("the count SHRINKS as you read"); this test is what makes that claim able to fail.
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
    },
  });
  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();

  guardTopicCard(app, G_AI);
  // AI_NEWS carries one bullet for x1 and one for x2; x3 has none. Sized so exactly one bullet can
  // fall — a fixture where every bullet dropped at once would pass on a renderer that simply blanked
  // the list.
  assert.deepEqual(bulletTexts(app, G_AI), ['a first point about AI', 'a second point about AI'],
    'guard: both bullets must be on screen before one can be shown to leave');

  const done = app.queryAll(`#feed .topic-card[data-gid="${G_AI}"] .tc-slide[data-id="x1"] .btn-done`)[0];
  assert.equal(app.click(done), 1, 'guard: Done on x1 must be wired');
  app.runTimers(4);

  assert.deepEqual(railIds(app, G_AI), ['x2', 'x3'], 'guard: x1 must leave the rail');
  assert.deepEqual(bulletTexts(app, G_AI), ['a second point about AI'],
    'x1 was the only post its first bullet described, so that bullet must go with it. Leaving it '
    + 'lets the card summarise posts its own rail no longer holds');
});

test('TASK-098 T33 (css): a cleared post fades out of the rail instead of blinking out', () => {
  // A post inside a topic gets the same vanishing effect other cards have when marked done.
  // `finishGroupCardAction` calls `slideOutCard`, which adds `.removing` and removes the node
  // 320ms later; the rule it needs has to be its own, because the reduced post deliberately carries
  // no `.card` and `.card.removing` therefore never reaches it.
  const slide = cssRule('.topic-card .tc-slide');
  assert.match(slide, /transition:\s*opacity[^;]*transform/,
    'the slide needs a transition at all — `.removing` on an untransitioned element is an instant '
    + 'jump, which is the blink being fixed');

  const removing = cssRule('.topic-card .tc-slide.removing');
  assert.match(removing, /opacity:\s*0/, 'a cleared post fades');
  assert.match(removing, /pointer-events:\s*none/,
    'and stops taking taps while it leaves — 320ms is long enough to double-tap Done on a post that '
    + 'is already going');
  assert.doesNotMatch(removing, /translateX/,
    'deliberately NOT `.card.removing`\'s horizontal slide: the rail\'s own axis is X, so a post '
    + 'sliding right reads as the carousel paging rather than the post being cleared');

  // ⚠️ A transform being PRESENT is not enough; something has to MOVE. A rule of `scale(.97)` with
  // no translate passes a presence check, and a 3% shrink over 200ms is not a perceptible
  // animation — green, correct, and measuring the wrong quantity.
  assert.match(removing, /translateY\(-?\d+px\)/,
    'the transform must MOVE the post, not merely scale it — a few percent of shrink is invisible '
    + 'at this size and leaves the blink the reader originally reported. Y rather than X because the '
    + 'rail scrolls on X and `overflow-y: hidden` (:1113) clips the lift instead of scrolling it');

  // THE CROSS-FILE COUPLING, which is the half neither file states on its own. `slideOutCard` waits
  // a hardcoded 320ms before removing the node; a transition longer than that is cut off mid-way and
  // the blink comes back. Both halves are asserted, so moving EITHER one alone reds this.
  const ms = /transition:\s*opacity\s+\.(\d+)s/.exec(slide);
  assert.ok(ms, 'guard: the transition duration must be readable to be compared');
  assert.ok(Number(ms[1]) * 100 <= 320,
    `the fade runs ${Number(ms[1]) * 100}ms but slideOutCard removes the node at 320ms — anything `
    + 'longer is truncated and the post disappears mid-fade');
  assert.match(APP_JS, /card\.remove\(\);\s*onDone\(\);\s*\},\s*320\)/,
    'and slideOutCard\'s 320ms is the number this rule was sized against — if it moves, this '
    + 'assertion is what tells you the CSS has to move with it');
});

// ══ THE SUMMARY IS THE RAIL'S FIRST SLIDE ════════════════════════════════════════════════════════
//
// The summary is not a fixed 190px band ABOVE the rail; it is the rail's FIRST SLIDE, so
// slide one is the bullets and slides 2..n+1 are the posts, unchanged. Card height, header and
// "Mark all done" do not move. The bullets go from 190px to 432px and the posts from 242px to 432px.
// Both new figures are CEILINGS, not constants: the card's content box is 528px (530 less its 2px
// border) and the head is 68px only while the topic label fits two lines — a label that wraps to
// four takes the rail to ~417px.
//
// ── THE DOM CONTRACT ────────────────────────────────────────────────────────────────────────────
//   .tc-rail > .tc-slide.tc-summary          slide one, FULL-BLEED, no data-id
//                > ul.tc-bullets             the live summary — no fixed height any more
//                > .tc-empty                 "No summary yet", `.hidden` unless the list is empty
//              > .tc-slide[data-id]          one slide per post, exactly as today
//   .tc-dots > .tc-dot                       n+1 dots, the summary's first

test('TASK-107 T1 (C1): the rail holds one slide per post PLUS the summary, summary first', async () => {
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
    },
  });

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  guardTopicCard(app, G_AI);

  const slides = q(app, G_AI, '.tc-slide');
  assert.equal(slides.length, 3,
    'two posts must produce THREE slides — the summary, then x1, then x2. On main this is 2, because '
    + 'the bullets are a band above the rail rather than a page inside it');
  assert.ok(slides[0].classList.contains('tc-summary'),
    'and the summary must be FIRST. DOM order is reading order for a screen reader, and it is what '
    + 'puts the thing you read to decide whether to open the posts ahead of the posts');
  assert.equal(slides[0].dataset.id, undefined,
    'the summary slide must carry NO data-id — [BUG-092]\'s guarantee is that every id on the rail is '
    + 'one the header count claims, and a summary is not a post');

  // C1's second half: the ids the rail lists are unchanged, in the same order as today.
  const expected = JSON.parse(JSON.stringify(app.ctx.visibleGroupUnreadIds(G_AI)));
  assert.deepEqual(railIds(app, G_AI), expected,
    'the POSTS on the rail must still be exactly what the header count claims, in the same order — '
    + 'adding a slide must not change which ids are reachable');
});

test('TASK-107 T2 (C2): the dot row gets one dot per slide, the summary\'s active at rest', async () => {
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
    },
  });

  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  guardTopicCard(app, G_AI);

  assert.equal(q(app, G_AI, '.tc-slide').length, 4, 'guard: three posts plus the summary');
  const dots = q(app, G_AI, '.tc-dot');
  assert.equal(dots.length, 4,
    'the dot row is a claim about how many pages the rail holds. Three posts now means FOUR pages, '
    + 'and a row promising three under a rail holding four is the defect the dots exist to prevent');
  assert.ok(dots[0].classList.contains('active'),
    'and the FIRST dot is active at rest, because the rail opens on the summary');
  assert.equal(dots.filter(d => d.classList.contains('active')).length, 1,
    'exactly one — two active dots is two claims about where the reader is');
});

test('TASK-107 T3: a one-post topic renders the same furniture as any other', async () => {
  // There is no "Swipe →" hint. It was the only element whose presence depended on the post count,
  // so it was the only thing making a one-post card look different from a three-post one, and the
  // dots carry the sideways cue alone. Its removal is provisional: it may come back on multi-post
  // cards.
  //
  // The carousel must be wired at one post, because there are two pages to move between.
  const app = boot({
    store: { focus_groups: groupState({ assignments: { x1: G_AI }, groups: { [G_AI]: AI_NEWS } }) },
  });

  render(app, [xPost('x1')]);
  await settle();
  guardTopicCard(app, G_AI);

  const slides = q(app, G_AI, '.tc-slide');
  assert.equal(slides.length, 2, 'guard: one post plus the summary is two slides');
  assert.equal(q(app, G_AI, '.tc-dot').length, 2, 'two pages, two dots — identical to any other card');
  assert.equal(q(app, G_AI, '.tc-hint').length, 0,
    'and NO hint, here or anywhere. A card that grows an extra label once it holds two posts is the '
    + 'inconsistency this removal exists to end');
  assert.ok(slides.every(sl => app.observers.some(io => io.observed.includes(sl))),
    'both slides must be watched, or the reader swipes to the summary and the dots do not follow — '
    + 'this was behind the same `n > 1` guard the hint used to sit behind');
});

test('TASK-107 T4 (css): slide one is a card, and its gutters are what make it one', () => {
  // The bullets sit in their own card like a post does, and a card needs a gutter on both sides,
  // so full-bleed to the card's right EDGE (`calc(100% + 14px)`) is the wrong target. Three variants,
  // MEASURED at 390px:
  //
  //   card, slide as-is        0px left gutter / 14px right / 4px of post 1   — lopsided
  //   card at post width       0px left / 74px right / 64px of post 1         — the rejected peek
  //   card, matched gutters   14px left / 14px right / 0px of post 1          — chosen
  //
  // A requirement change, not a test bent to fit new code.
  const summary = cssRule('.topic-card .tc-slide.tc-summary');
  assert.match(summary, /scroll-margin-left:\s*14px/,
    'THE LINE THE WHOLE THING TURNS ON. Without it this slide rests with the rail\'s left padding '
    + 'scrolled out of view and the bordered card sits FLUSH against the topic card\'s edge — 0px '
    + 'left against 14px right, measured, which reads as a misalignment rather than a card');
  const rail = cssRule('.topic-card .tc-rail');
  assert.doesNotMatch(rail, /scroll-padding-left/,
    'and it must NOT be on the rail, which is where it started. A rail-level gutter applies to every '
    + 'slide and leaves 5px of the PREVIOUS POST showing at each snap — Asli asked for nothing at all '
    + 'to the left of a post (2026-09-08). On the slide it is 0px, measured, and post slides go back '
    + 'to exactly what `main` does');
  assert.match(summary, /flex:\s*0 0 100%/,
    'with the rail snapping past its padding, `100%` IS the card width: it resolves against the '
    + 'content box, which is the visible box minus both gutters. The old `calc(100% + 14px)` reached '
    + 'the right edge, which is what a full-bleed page wants and a card does not');
  assert.match(summary, /margin-right:\s*10px/,
    'riding on top of the rail\'s 10px gap so post 1 clears the viewport completely — 0px, measured, '
    + 'where the previous value left a 4px sliver because it counted the right padding and not the gap');
  assert.match(summary, /max-width:\s*none/,
    'and the base `.tc-slide` caps every slide at `max-width: 86%`, which clamps the width above back '
    + 'to a peek — without this override the rule reads correct and does nothing');
  assert.match(summary, /flex-direction:\s*column/,
    'this slide stacks the list over its empty-state note; the base `.tc-slide` is a default-row '
    + 'flex box, which puts the note BESIDE the bullets in a column half the width');

  // THE CARD TREATMENT ITSELF, matched to `.tc-post` rather than merely similar to it. A summary that
  // drifts from the posts it describes is the thing this change was asked for to stop.
  const post = cssRule('.topic-card .tc-post');
  for (const [prop, re] of [['background', /background:\s*var\(--bg\)/],
                            ['border', /border:\s*1px solid var\(--line\)/],
                            ['border-radius', /border-radius:\s*14px/]]) {
    assert.match(post, re, `guard: .tc-post must still carry the ${prop} this is matched against`);
    assert.match(summary, re,
      `the summary card must carry the same ${prop} as a post card — Asli asked for "a post card but `
      + 'for bullet points", and a surface that only half-matches reads as a different component');
  }
  assert.match(summary, /overflow:\s*hidden/,
    'or the bullet list paints over the rounded corners the border just drew');
});

test('TASK-107 T5 (C5): the bullets lose their fixed height and keep their contents', async () => {
  const bullets = cssRule('.topic-card .tc-bullets');
  assert.doesNotMatch(bullets, /height:\s*190px/,
    'the 190px is the whole point of the task — a third of the card spent on a box the summary is '
    + 'truncated inside. It fills the slide now');
  assert.match(bullets, /overflow-y:\s*auto/,
    'the scroll and the fade STAY, for the rare summary that outgrows even 432px. They stop being '
    + 'the normal reading path and become the exception they were always meant to be');
  assert.match(bullets, /-webkit-mask-image/, 'the fade is still the cue for that exceptional case');
  // AND IT MUST ACTUALLY FADE. Both mask declarations can be present with a zero-length gradient,
  // which satisfies every "the fade exists" assertion while the summary cuts dead at the boundary.
  // Same shape as the T33 defect — a transform asserted to EXIST without asserting anything
  // MOVED.
  const stop = /mask-image:\s*linear-gradient\(to bottom, #000 calc\(100% - (\d+)px\)/.exec(bullets);
  assert.ok(stop, 'guard: the gradient stop must be readable to be compared');
  assert.ok(Number(stop[1]) > 0,
    `the mask fades over ${stop[1]}px, which is no fade at all — the declaration is present, the cue `
    + 'is gone, and a summary past the slide height cuts dead with nothing saying so');
  assert.match(bullets, /color:\s*var\(--ink-soft\)/,
    'the summary is the payload of the whole grouping feature; pointed at any token matching the '
    + 'surface behind it, the bullets render invisible inside a card that still looks correct');
  assert.match(bullets, /min-height:\s*0/,
    'the pair `.tc-rail` and `.tc-text` already carry, for the reason T27 gives: without it a flex '
    + 'child refuses to shrink, the list overflows the slide, and the fade lands somewhere other '
    + 'than the bottom of the visible box');

  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
    },
  });
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  const card = guardTopicCard(app, G_AI);

  assert.deepEqual(bulletTexts(app, G_AI), ['a first point about AI', 'a second point about AI'],
    'WHICH bullets show is untouched — `liveBullets` is the same filter over the same state, so '
    + '[BUG-089]\'s pruning and [BUG-091]\'s cached-bullet restore both still hold');
  // Checked rather than assumed: `group-bullets` and `group-defer-lift` both reach the
  // list with a CARD-SCOPED bare-class query, and in the harness such a query sees only
  // elements memoised by id and their subtrees. The `ul` sits deeper in the card but stays inside
  // it, so this must still resolve — if it does not, that is a harness finding, not a test to edit.
  assert.equal([...(card.querySelectorAll('.tc-bullets')[0]?.children || [])].length, 2,
    'the card-scoped bare-class reader the other two test files use must still find the list once it '
    + 'moves inside the rail');

  // THE NOTE MUST BE HIDDEN HERE. An always-visible "No summary yet" under a summary that is right
  // there is a permanently-visible element, and the
  // toggle that prevents it is one argument at one call site.
  const empty = q(app, G_AI, '.tc-empty');
  assert.equal(empty.length, 1, 'the note exists on every summary slide — it is toggled, not built');
  assert.ok(empty[0].classList.contains('hidden'),
    'and it is hidden whenever the list painted anything, or the card tells the reader it has no '
    + 'summary directly underneath the summary');
  assert.ok(!q(app, G_AI, '.tc-bullets')[0].classList.contains('hidden'),
    'and the list itself is NOT hidden when it has something to show — the two are exclusive, and '
    + 'hiding the wrong one blanks the summary');
});

test('TASK-107 T6 (C6): a Done leaves one dot per REMAINING slide, summary included', async () => {
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI, x3: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
    },
  });

  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  guardTopicCard(app, G_AI);
  assert.equal(q(app, G_AI, '.tc-dot').length, 4, 'guard: three posts plus the summary is four dots');

  const done = app.queryAll(`#feed .topic-card[data-gid="${G_AI}"] .tc-slide[data-id="x1"] .btn-done`)[0];
  assert.ok(done, 'guard: the slide for x1 must carry a Done button');
  assert.equal(app.click(done), 1, 'guard: Done must be wired');
  app.runTimers(4);

  assert.deepEqual(railIds(app, G_AI), ['x2', 'x3'], 'guard: x1 must leave the rail');
  assert.equal(q(app, G_AI, '.tc-slide').length, 3, 'two posts plus the summary');
  // `railIds` filters the summary out, so ONLY this pins that it is still slide 0 after a rail
  // action — the residual gap behind that filter. Without it, a Done that reordered
  // or re-appended the summary would pass every ordered assertion in two files.
  assert.ok(q(app, G_AI, '.tc-slide')[0].classList.contains('tc-summary'),
    'and the summary is still the FIRST page after a post leaves — the reader\'s place in the card '
    + 'must not move because they cleared something');
  assert.equal(q(app, G_AI, '.tc-dot').length, 3,
    '`finishGroupCardAction` counts POSTS and trims the dot row to that number, silently assuming '
    + 'dots == posts. With a summary dot it is off by one and every Done deletes a dot too many — a '
    + 'pre-existing line this change makes load-bearing, and it is invisible on a fresh render');
});

test('TASK-107 T7: a Done that leaves one post leaves the card looking like any other', async () => {
  // `remaining === 1` must not be a special branch in `finishGroupCardAction`: a card must not
  // restructure itself under the
  // reader's thumb just because a Done took it down to one post. With no hint the observable is
  // the dot row, which must be `remaining + 1` and carry no extra furniture.
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
    },
  });

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  guardTopicCard(app, G_AI);
  assert.equal(q(app, G_AI, '.tc-dot').length, 3, 'guard: two posts plus the summary is three dots');

  const done = app.queryAll(`#feed .topic-card[data-gid="${G_AI}"] .tc-slide[data-id="x1"] .btn-done`)[0];
  assert.ok(done, 'guard: the slide for x1 must carry a Done button');
  assert.equal(app.click(done), 1, 'guard: Done must be wired');
  app.runTimers(4);

  assert.deepEqual(railIds(app, G_AI), ['x2'], 'guard: one post left');
  assert.equal(q(app, G_AI, '.tc-dot').length, 2, 'one post plus the summary is two dots');
  assert.equal(q(app, G_AI, '.tc-hint').length, 0, 'and still no hint, as on a freshly built card');
  assert.ok(q(app, G_AI, '.tc-slide')[0].classList.contains('tc-summary'),
    'and the summary is still the opening page after the Done');
});

test('TASK-107 T8 (C8): unread posts with no live bullets keep slide one and say so', async () => {
  // The bullet names x1 ONLY, and x1 is already read — so `liveBullets` returns nothing while x2 is
  // still unread. This is the real shape of the case (read every post a bullet names), not an empty
  // summary array, which is the other way in.
  const app = boot({
    store: {
      focus_done: JSON.stringify(['x1']),
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI },
        groups: { [G_AI]: { label: 'AI news', summary: [{ text: 'a point about x1', item_ids: ['x1'] }] } },
      }),
    },
  });

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  guardTopicCard(app, G_AI);

  assert.deepEqual(railIds(app, G_AI), ['x2'], 'guard: one unread post');
  assert.deepEqual(bulletTexts(app, G_AI), [], 'guard: and no live bullet to show for it');

  const slides = q(app, G_AI, '.tc-slide');
  assert.equal(slides.length, 2,
    'the summary slide STAYS when it has nothing to say. Dropping it would change the dot count '
    + 'under the reader\'s thumb mid-session — the same defect the fixed 190px was chosen to avoid');
  assert.equal(q(app, G_AI, '.tc-dot').length, 2, 'so the dot row does not move either');

  const empty = q(app, G_AI, '.tc-empty');
  assert.equal(empty.length, 1, 'and the slide must say something rather than render blank');
  assert.equal(empty[0].textContent, 'No summary yet',
    'a blank full-bleed page reads as a broken card; this reads as a card whose summary has not '
    + 'arrived, which is what is actually true');
  assert.ok(!empty[0].classList.contains('hidden'), 'and it must be visible in this state');
  // MEASURED IN CHROME: `.tc-bullets` and `.tc-empty` both carry `flex: 1`, so an empty list still
  // claims HALF the page and the note is centred in the remaining half — a quarter of the page below
  // where it belongs, which is exact and does not move, unlike a pixel figure, which goes stale
  // the moment the box changes. Hiding the list gives
  // the note the whole page — measured back to 0.0px off-centre.
  assert.ok(q(app, G_AI, '.tc-bullets')[0].classList.contains('hidden'),
    'the empty list must yield its half of the slide, or the note is centred in the bottom half of '
    + 'a page that looks half-broken');

  // SIZED SO ONLY THE GUARD UNDER TEST CAN FIRE. The toggle reads `children.length > 0`; with the
  // two-bullet fixture T5 uses, `> 1` behaves identically and the off-by-one hides. One bullet is
  // the only count that separates them.
  const one = boot({
    store: {
      focus_groups: groupState({
        assignments: { x3: G_MKT }, groups: { [G_MKT]: MARKETS },
      }),
    },
  });
  render(one, [xPost('x3')]);
  await settle();
  guardTopicCard(one, G_MKT);
  assert.deepEqual(bulletTexts(one, G_MKT), ['a point about markets'], 'guard: exactly one live bullet');
  assert.ok(q(one, G_MKT, '.tc-empty')[0].classList.contains('hidden'),
    'one bullet is still a summary — `> 1` instead of `> 0` shows the note beside it');
});

test('TASK-107 T9 (C9): a Done that empties the summary raises the note, not a blank page', async () => {
  // CONVERGENCE, extended to the note. T31 pins that the BULLETS repaint after a Done; the note is
  // painted by the same call and would otherwise be a second renderer disagreeing with the first —
  // the card would go from a summary to a blank full-bleed page with nothing said about it.
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI },
        groups: { [G_AI]: { label: 'AI news', summary: [{ text: 'a point about x1', item_ids: ['x1'] }] } },
      }),
    },
  });

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  guardTopicCard(app, G_AI);
  assert.deepEqual(bulletTexts(app, G_AI), ['a point about x1'], 'guard: one live bullet before');
  assert.ok(q(app, G_AI, '.tc-empty')[0].classList.contains('hidden'), 'guard: and no note yet');

  const done = app.queryAll(`#feed .topic-card[data-gid="${G_AI}"] .tc-slide[data-id="x1"] .btn-done`)[0];
  assert.ok(done, 'guard: the slide for x1 must carry a Done button');
  assert.equal(app.click(done), 1, 'guard: Done must be wired');
  app.runTimers(4);

  assert.deepEqual(bulletTexts(app, G_AI), [], 'guard: reading x1 retires the only bullet naming it');
  assert.ok(!q(app, G_AI, '.tc-empty')[0].classList.contains('hidden'),
    'so the note must come up in the same repaint. Without it slide one is a blank full-bleed page, '
    + 'which reads as a broken card rather than a summary that has nothing left to say');
  assert.ok(q(app, G_AI, '.tc-bullets')[0].classList.contains('hidden'),
    'and the emptied list yields the slide in the same repaint, or the note comes up in the bottom '
    + 'half of it');
});


// ── CSS gaps found by mutation testing ────────────────────────────────────────────────────────────
// These pin the `style.css` declarations whose failure is invisible at desk width and ruinous on a
// handset, which
// is the bar `cssRule`'s own header sets. Pure appearance — where exactly the note sits inside its
// box — stays verify-by-looking and is NOT pinned here.

test('TASK-107 T10 (css): the empty-state note is legible, and is a rule at all', () => {
  // The whole rule was unpinned: no test called `cssRule('.topic-card .tc-empty')`, so renaming the
  // SELECTOR left it matching nothing and every assertion about the note stayed green — T5, T8 and
  // T9 pin that the string is in the DOM, never that it can be read.
  const empty = cssRule('.topic-card .tc-empty');
  assert.match(empty, /color:\s*var\(--ink-soft\)/,
    'THE WORST SURVIVOR, and it was shipped wrong: written with `--faint`, which measures 1.92:1 on '
    + '`--bg` in light and 3.70:1 in dark against AA\'s 4.5:1. Pointed at a token matching the '
    + 'surface behind it entirely, "No summary yet" paints in the background and slide one becomes '
    + 'the blank page criterion 8 exists to prevent — text present in the DOM the whole time. '
    + '`--ink-soft` is what the bullets this note stands in for already use');
  assert.match(empty, /display:\s*flex/, 'or the note cannot be centred at all');
  assert.match(empty, /align-items:\s*center/,
    'measured in Chrome: without the centring the note lands at the top of a 432px page, which is '
    + 'the half-broken look the list-hiding fix was measured against');
  assert.match(empty, /justify-content:\s*center/, 'same, on the other axis');
  assert.match(empty, /flex:\s*1/,
    'and it must CLAIM the page the hidden list gave up, or it collapses to its text and the '
    + 'centring above has nothing to centre within');
});

test('TASK-107 T11 (css): the rail declarations the summary card now rests on', () => {
  // NOT written by this task — which is the point. A diff shows what was added and never what it now
  // rests on, and `scroll-padding-left` is worth nothing without the padding it snaps past.
  const rail = cssRule('.topic-card .tc-rail');
  const pad = /padding:\s*0 (\d+)px/.exec(rail);
  assert.ok(pad, 'guard: the rail padding must be readable to be compared');
  assert.ok(Number(pad[1]) > 0,
    `the rail has ${pad[1]}px of horizontal padding, so the summary's \`scroll-margin-left\` has `
    + 'nothing to hold back: the bordered card sits flush against both card edges — the exact '
    + '0px-left misalignment that rule was written to fix, with the scroll-margin still declared');
  const gap = /gap:\s*(\d+)px/.exec(rail);
  assert.ok(gap && Number(gap[1]) > 0,
    'the summary\'s `margin-right` rides on top of this gap to clear post 1 completely. At gap 0 a '
    + 'sliver of post 1 is back beside the summary card — the peek that was measured and rejected');
  assert.match(rail, /-webkit-overflow-scrolling:\s*touch/,
    'without it an iOS swipe stops dead instead of coasting. Added by an EARLIER independent battery '
    + 'and still unpinned until this one; a handset-only failure, which is what this contract is for');
});

test('TASK-107 T12 (css): nothing later in the file quietly outranks the summary rule', () => {
  // THE SHAPE A TEXT CONTRACT STRUCTURALLY CANNOT SEE, converted into something it can. `cssRule`
  // returns the FIRST selector match, so appending `.topic-card .tc-slide { flex: 0 0 356px }` lower
  // in the file silently renders slide one at post width — the explicitly rejected 65px-peek variant
  // — while every assertion in T4 reads green, because those declarations are all still there.
  // This is the ordinary way the rule dies in real life: someone adds a `.tc-slide` tweak below it.
  const base = [...CSS.matchAll(/^\.topic-card \.tc-slide \{/gm)].map(m => m.index);
  assert.equal(base.length, 1,
    `a second bare \`.topic-card .tc-slide\` rule exists (${base.length} found). Equal specificity, `
    + 'so the later one wins on every declaration they share, and `cssRule` reads the first');
  const summary = CSS.indexOf('.topic-card .tc-slide.tc-summary {');
  assert.ok(summary > base[0],
    'and the summary rule must sit AFTER the base rule it overrides. Above it, the base `flex` and '
    + '`max-width: 86%` win and slide one is a post-width slide wearing a summary\'s class');
});


// ── Gaps found by correctness review ──────────────────────────────────────────────────────────────

test('TASK-107 T13: a rail with no post slides gets no carousel', async () => {
  // "A card only renders when counts[gid] > 0, so there are always at least two slides" IS FALSE,
  // and this is the state that proves it —
  // `counts` counts ASSIGNMENTS while a slide needs `items.get(id)` to resolve, and `items` comes
  // from `_lastFeedItems`. That is null after a caught-up boot and after a failed one (app.js:3566
  // already records the gap), so the rail can hold the summary ALONE while the header says "2 posts".
  //
  // Unguarded, the card paints a carousel pointing at a page that does not exist. Reached in the real app through
  // Archive → Remove, which re-reveals #feed and repaints topics with no feed behind them.
  const app = boot({
    store: {
      focus_groups: groupState({
        assignments: { x1: G_AI, x2: G_AI }, groups: { [G_AI]: AI_NEWS },
      }),
    },
  });

  // NO `render()`. That is the whole fixture: `_lastFeedItems` stays null, exactly as it does when a
  // boot ends caught-up or errors, and `renderTopicCards` is then reached from another surface.
  app.ctx.renderTopicCards();

  const card = guardTopicCard(app, G_AI);
  assert.equal(textOf(app, G_AI, '.tc-count'), '2 posts',
    'guard: the header still claims two posts, which is what makes the rail a lie rather than a blank');
  assert.equal(q(app, G_AI, '.tc-slide').length, 1,
    'guard: the summary is the only slide — every post was skipped because no item resolved');
  assert.ok(!app.observers.some(io => io.observed.includes(q(app, G_AI, '.tc-slide')[0])),
    'and no carousel is wired: an IntersectionObserver over a single slide is a dot row that can '
    + 'never change, watching a page that can never be left');
  assert.ok(card, 'guard: the card itself still renders — this is about the hint, not the card');
});

test('TASK-107 T14 (css): the summary is a page the rail can actually stop on', () => {
  // Set `scroll-snap-align: none` on the summary slide with every other declaration correct, and
  // under `scroll-snap-type: x mandatory` slide one is a page the rail can never rest on — the card
  // snaps straight past it to post 1 on load and the reader can never park on the summary. The
  // feature deleted outright, behind a green suite.
  //
  // T27 pins `scroll-snap-type` on the rail and stops there.
  const slide = cssRule('.topic-card .tc-slide');
  assert.match(slide, /scroll-snap-align:\s*start/,
    'the base rule is where every slide INCLUDING the summary gets its snap point — `.tc-summary` '
    + 'deliberately does not restate it, so this one declaration is what makes slide one reachable');
  const summary = cssRule('.topic-card .tc-slide.tc-summary');
  assert.doesNotMatch(summary, /scroll-snap-align/,
    'and the summary must NOT restate or override it — a second value here is the one-line way the '
    + 'opening page becomes unreachable while every other assertion stays green');
});


test('TASK-107 T15: the swipe hint is gone from the code, not merely unrendered', () => {
  // PINS THE CURRENT STATE, WHICH IS PROVISIONAL: the "Swipe →" label may come back on multi-post cards.
  //
  // It is asserted anyway because a half-removal is worse than either end state: leaving the builder
  // or the rule behind invites the label back by accident rather than by decision. If the label is
  // restored on multi-post cards, this test is what has to be deliberately changed to let
  // that happen — which is the point.
  assert.doesNotMatch(APP_JS, /tc-hint/,
    'no builder should still construct one; `finishGroupCardAction` used to remove it too, and both '
    + 'sites go together or the card grows a label again on some path');
  assert.ok(!CSS.includes('.tc-hint'),
    'and no rule should be left behind. A dead selector reads to the next person as a component that '
    + 'exists somewhere, which is how it comes back');
});
