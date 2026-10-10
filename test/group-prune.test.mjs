// The assignment prune's evidence rule.
//
// `syncGroupPrune` used to delete an assignment whenever its id was absent from the feed in hand.
// **The evidence for that absence is device-local; the thing it deletes is synced.** `tweetCache` is
// excluded from `SYNCED_KEYS` and cleared on sign-out, while `focus_groups` is synced and pulled back
// down by `syncOnLoad` — so on a cold cache `api/feed.js` returns its newest 20 posts with no signal
// of any kind, and every older assignment was deleted, its bullets collected, and the loss PUT to
// every other device. The bullets destroyed describe posts the user has NOT read.
//
// So absence stops being evidence. Deletion now needs a POSITIVE reason, each of which is either
// synced or locally authoritative:
//
//   rule 1  the user handled it     — the id is in `done` or `archive` (both synced)
//   rule 2  the channel is gone     — the recorded `ch` is no longer in `getChannels()` (synced)
//   rule 3  the post aged out       — the recorded `at` is older than the window
//
// Rules 2 and 3 read `postMeta[id] = [at, ch]` (`at` in seconds), a sibling of `assignments` written
// where the post is in hand. An assignment with no entry is UNKNOWN, and unknown ages only from
// `postMetaEpoch` — one timestamp stamped at the first save under this code, so "unknown" is bounded
// rather than permanent. Without it a legacy assignment whose post had already left the feed could
// never be backfilled, never be reached by rule 2 and never age out, and would count in
// `countGroupedUnread()` forever — making "You're all caught up" permanently unreachable.
//
// **The feed may RESCUE, never CONDEMN.** A post in hand is live by definition, so rule 3 spares it.
// That is not absence sneaking back in: deleting still requires positive evidence from the record
// itself, and presence is only ever a veto over it.
//
// Ages are expressed RELATIVE to `Date.now()`, never as absolute constants: the harness runs the real
// clock with no injection point, so a hard-coded "recent" timestamp silently crosses the window
// boundary as months pass and the test starts asserting the opposite of what it was written for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';

const DAY = 86400_000;
const daysAgo = d => Date.now() - d * DAY;
const sec = ms => Math.floor(ms / 1000);

const C1 = { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' };
const C2 = { id: 'c2', name: 'Other acct', handle: 'other', source: 'twitter' };

const xPost = (id, { channel = C1, published = daysAgo(1), text = `post ${id}` } = {}) =>
  ({ id, source: 'twitter', text, published, channel });

// A record holding three assignments under one topic, each with a bullet naming it. Sized so a
// deletion is visible in BOTH halves — the assignment and the sentence describing it.
const threeAssigned = (extra = {}) => ({
  assignments: { x1: 'g_t', x2: 'g_t', x3: 'g_t' },
  groups: {
    g_t: {
      label: 'A topic',
      summary: [
        { text: 'about x1', item_ids: ['x1'] },
        { text: 'about x2', item_ids: ['x2'] },
        { text: 'about x3', item_ids: ['x3'] },
      ],
    },
  },
  unfiled: [],
  updatedAt: daysAgo(1),
  v: 2,
  ...extra,
});

const metaFor = (ids, { at = daysAgo(1), ch = 'c1' } = {}) =>
  Object.fromEntries(ids.map(id => [id, [sec(at), ch]]));

function boot({ store = {}, channels = [C1], reply = null } = {}) {
  const app = createApp({
    store: { focus_group_view: 'on', // grouping is off by default — see the note on boot() in group-defer-lift
             focus_device_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
             focus_channels: JSON.stringify(channels), ...store },
  });
  const puts = [];
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      return { ok: true, status: 200, json: async () => ({ groups: reply, capped: false }) };
    }
    if (String(url).includes('/api/state') && init?.method === 'PUT') {
      puts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return { app, puts };
}

const stateOf = app => JSON.parse(app.get('focus_groups') || '{"assignments":{},"groups":{}}');
const render = (app, items, failed = []) =>
  app.ctx.renderFeedResults({ items, failed, cappedNames: [], totalChannels: items.length + failed.length });
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
// One clock reading shared by a fixture and the post it must agree with.
const PINNED = daysAgo(1);
const bulletTexts = state => (state.groups.g_t?.summary || []).map(b => (typeof b === 'string' ? b : b.text));

// ── C1: the repro. A cold cache is not evidence that anything went away ───────

test('BUG-098 C1: a cold cache returning only the newest post keeps every older assignment', async () => {
  const { app } = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })) },
  });

  // What a cold `tweetCache` produces: no `sinceId`, so the shallow branch answers with the newest
  // post alone. x2 and x3 are simply not in hand — which used to read as "they are gone".
  render(app, [xPost('x1')]);
  await settle();

  const after = stateOf(app);
  assert.deepEqual(Object.keys(after.assignments).sort(), ['x1', 'x2', 'x3'],
    'every assignment survives — absence of a post is not evidence the post is gone');
  assert.deepEqual(bulletTexts(after).sort(), ['about x1', 'about x2', 'about x3'],
    'and so does every bullet describing an unread post');
});

test('BUG-098 C1b: the PUT that follows a cold-cache render carries no deletion', async () => {
  // `syncOnLoad` FIRST, and it is not decoration. `pushNow` sends `state` only once `_stateLoaded` is
  // true (a browser that never read the row has no standing to claim one), so without a
  // boot read every PUT here carries `{uid, events}` and nothing else — `puts.filter(p => p.state)`
  // would be structurally empty and the PUT half would be pinned by nothing.
  // Driving the real chain also makes this the path the defect takes: pull the row, render cold, push.
  const SEED = threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) });
  const { app, puts } = boot({ store: { focus_groups: JSON.stringify(SEED) } });
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/state') && init?.method === 'PUT') {
      puts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (String(url).includes('/api/state')) {
      return { ok: true, status: 200,
               json: async () => ({ updatedAt: new Date(daysAgo(1)).toISOString(), state: { groups: SEED } }) };
    }
    return { ok: true, status: 200, json: async () => ({ groups: null }) };
  });
  await app.ctx.syncOnLoad();

  render(app, [xPost('x1')]);
  await settle();
  app.runTimers();
  await settle();

  const pushed = puts.filter(p => p.state);
  assert.ok(pushed.length, 'a push carrying state actually went out — without this the rest is vacuous');
  assert.deepEqual(Object.keys(pushed.at(-1).state.groups.assignments).sort(), ['x1', 'x2', 'x3'],
    'the loss is not carried upward to every other device');
});

// ── C2: reading still prunes (rule 1) ────────────────────────────────────────

test('BUG-098 C2a: an assignment whose post is marked done is deleted', async () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })),
      focus_done: JSON.stringify(['x2']),
    },
  });

  render(app, [xPost('x1')]);
  await settle();

  const after = stateOf(app);
  assert.equal(Object.hasOwn(after.assignments, 'x2'), false, 'the read post loses its assignment');
  assert.deepEqual(Object.keys(after.assignments).sort(), ['x1', 'x3'], 'and only that one');
});

test('BUG-098 C2b: an assignment whose post is archived is deleted', async () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })),
      focus_archive: JSON.stringify([{ id: 'x3' }]),
    },
  });

  render(app, [xPost('x1')]);
  await settle();

  const after = stateOf(app);
  assert.equal(Object.hasOwn(after.assignments, 'x3'), false, 'the archived post loses its assignment');
  assert.deepEqual(Object.keys(after.assignments).sort(), ['x1', 'x2'], 'and only that one');
});

// ── C3: removing a channel prunes immediately, and caught-up is reachable ─────

test('BUG-098 C3: removing a channel drops its assignments', async () => {
  const { app } = boot({
    // x2 was assigned while c2 was still followed. The user has since removed c2, so `channels`
    // holds c1 alone — and `channels` is SYNCED, which is what makes this evidence and not a guess.
    channels: [C1],
    store: {
      focus_groups: JSON.stringify(threeAssigned({
        postMeta: { ...metaFor(['x1', 'x3'], { ch: 'c1' }), ...metaFor(['x2'], { ch: 'c2' }) },
      })),
    },
  });

  render(app, [xPost('x1')]);
  await settle();

  const after = stateOf(app);
  assert.equal(Object.hasOwn(after.assignments, 'x2'), false,
    "the removed channel's post is gone on the next render, not in 14 days");
  assert.deepEqual(Object.keys(after.assignments).sort(), ['x1', 'x3'], 'and its neighbours are untouched');
  assert.deepEqual(bulletTexts(after).sort(), ['about x1', 'about x3'], "and so is x2's bullet");
});

// This also passes under the old absence rule, by construction: there, x2 leaves by ABSENCE and
// the user reaches caught-up for the old reason. It cannot be made to discriminate — a post from a
// removed channel can never be in a feed, since `loadFeed` only fetches channels you still follow —
// so this pins the user-visible OUTCOME and rule 2's mechanism is pinned by C3 above.
// C8b and C9b are the same kind: they pin what must not
// change at all.
test('BUG-098 C3b: with the phantom gone, "You\'re all caught up" is reachable', async () => {
  const { app } = boot({
    channels: [C1],
    store: {
      focus_groups: JSON.stringify({
        assignments: { x1: 'g_t', x2: 'g_t' },
        groups: { g_t: { label: 'A topic', summary: [{ text: 'about x1', item_ids: ['x1'] }] } },
        unfiled: [], updatedAt: daysAgo(1), v: 2,
        postMeta: { ...metaFor(['x1'], { ch: 'c1' }), ...metaFor(['x2'], { ch: 'c2' }) },
      }),
    },
  });

  render(app, [xPost('x1')]);   // x1 is assigned, so it is lifted into the grid, not the stream
  await settle();

  // The user reads the last post they can actually see. A phantom assignment for the removed
  // channel's x2 would keep `countGroupedUnread()` at 1 and make caught-up unreachable —
  // the whole reason rule 2 exists rather than waiting for the window.
  app.ctx.addDone('x1');
  app.ctx.checkEmpty();

  assert.equal(app.ctx.countGroupedUnread(), 0, 'nothing unread is left in the grid');
  assert.equal(app.el('caughtup').classList.contains('hidden'), false, "the caught-up screen is shown");
});

// ── C4: ageing prunes, and the feed may rescue but never condemn ─────────────

test('BUG-098 C4: an assignment older than the window is deleted with no feed in hand', () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({
        postMeta: { ...metaFor(['x1', 'x2'], { at: daysAgo(2) }), ...metaFor(['x3'], { at: daysAgo(20) }) },
      })),
    },
  });

  // No feed at all — the prune is device-independent, so it needs nothing that loaded.
  app.ctx.syncGroupPrune([]);

  const after = stateOf(app);
  assert.equal(Object.hasOwn(after.assignments, 'x3'), false, 'the aged-out post loses its assignment');
  assert.deepEqual(Object.keys(after.assignments).sort(), ['x1', 'x2'], 'the in-window posts are kept');
});

test('BUG-098 C4b: an ageless assignment whose post IS in the feed is NOT deleted', () => {
  const { app } = boot({
    // No `postMeta` at all and an expired epoch, so every assignment here is collectable on age.
    store: { focus_groups: JSON.stringify(threeAssigned({ postMetaEpoch: sec(daysAgo(20)) })) },
  });

  // An in-hand post published 20 days ago is NOT a usable premise, twice over: the clock check
  // reads it — correctly — as a broken
  // DEVICE clock rather than an old post; and `stampPostMeta` gives every in-hand post a fresh `at`
  // before any rule sees it, so a stamped post can never be both in hand and aged.
  //
  // The veto's ONE reachable case is an in-hand post whose date will not parse: it gets no `at`, so
  // it ages from the epoch like any legacy record, and only PRESENCE can save it. The YouTube post
  // supplies the recent date that corroborates the clock — without it the whole pass is skipped and
  // this test would pass for the wrong reason.
  app.ctx.syncGroupPrune([
    xPost('x2', { published: 'not a date at all' }),
    { id: 'v1', source: 'youtube', title: 'A video', published: daysAgo(1),
      channel: { id: 'c9', name: 'A channel', source: 'youtube' } },
  ]);

  const after = stateOf(app);
  assert.equal(after.assignments.x2, 'g_t', 'the post the reader can see keeps its assignment');
  assert.deepEqual(Object.keys(after.assignments), ['x2'],
    'while the two nobody fetched age out from the epoch');
});

// ── C5: unknown is not evidence — but it is not permanent either ─────────────

test('BUG-098 C5a: an assignment with no postMeta is never deleted by the channel rule', () => {
  const { app } = boot({
    channels: [C1],
    // No `postMeta` at all — a legacy record written before this change existed.
    store: { focus_groups: JSON.stringify(threeAssigned({ postMetaEpoch: sec(daysAgo(1)) })) },
  });

  app.ctx.syncGroupPrune([]);

  assert.deepEqual(Object.keys(stateOf(app).assignments).sort(), ['x1', 'x2', 'x3'],
    'no recorded channel means UNKNOWN, and unknown is not evidence that the channel was removed');
});

test('BUG-098 C5b: with no epoch stamped, an ageless assignment is never deleted', () => {
  const { app } = boot({
    store: { focus_groups: JSON.stringify(threeAssigned()) }, // no postMeta, no epoch
  });

  app.ctx.syncGroupPrune([]);

  assert.deepEqual(Object.keys(stateOf(app).assignments).sort(), ['x1', 'x2', 'x3'],
    'the epoch starts a clock on the first save; it must not strike on the load that starts it');
  // …and the clock must actually START. This half is what makes the difference between stamping the
  // epoch on WRITE and defaulting it on READ observable at all: default it on read and it is never
  // persisted, so the record is re-dated on every boot and nothing can ever age out. Nothing else in
  // this fixture changes, so if the stamp does not mark the state dirty there is no save and no epoch.
  assert.ok(stateOf(app).postMetaEpoch > 0,
    'a record that arrived without an epoch leaves this pass carrying one');
});

test('BUG-098 C5c: once the epoch is older than the window, ageless assignments are deleted', () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({
        // x3 carries a real, in-window age. It is what keeps this test honest: without it every
        // assignment is expected to vanish, which is precisely what the OLD absence rule does to an
        // empty feed — the test would pass via the bug it was written to close.
        postMeta: metaFor(['x3'], { at: daysAgo(2) }),
        postMetaEpoch: sec(daysAgo(20)),
      })),
    },
  });

  app.ctx.syncGroupPrune([]);

  assert.deepEqual(Object.keys(stateOf(app).assignments), ['x3'],
    'a legacy assignment that had a full window to reappear and did not is finally collectable');
  assert.equal(Object.hasOwn(stateOf(app).assignments, 'x1'), false, 'and the ageless ones go');
});

test('BUG-098 C5d: an expired epoch never reaches an assignment the reader can see', async () => {
  const { app } = boot({
    // A legacy record — no `postMeta` at all — whose epoch has already run past the window. Every
    // assignment here is collectable on age alone; x2 is saved only because it is in this feed.
    store: { focus_groups: JSON.stringify(threeAssigned({ postMetaEpoch: sec(daysAgo(20)) })) },
  });

  const published = daysAgo(3);   // ONE clock reading: `daysAgo` calls Date.now() afresh, so a
  render(app, [xPost('x2', { published })]);   // fixture and an assertion that each call it can
  await settle();                              // straddle a second boundary and differ by one.

  // What actually spares x2 is the VETO, not the stamp-before-prune order: swapping the two calls
  // leaves every
  // test green, because rule 3 never reaches an in-hand post whatever its age says. The order is
  // still the right one — stamp before you judge — but it is defensive, not load-bearing.
  const after = stateOf(app);
  assert.equal(after.assignments.x2, 'g_t', 'the visible post survives its record\'s expired epoch');
  assert.deepEqual(after.postMeta.x2, [sec(published), 'c1'], 'because it was stamped first');
  assert.deepEqual(Object.keys(after.assignments), ['x2'], 'the two nobody has seen still age out');
});

// ── The display counts only what this device can reach ───────────────────────

// A topic is a `.topic-card` in the stream, built from appended nodes, so these are real queries
// rather than regexes over an unparsed `innerHTML` string.
const tileOf = (app, n = 0) => app.queryAll('#feed .topic-card')[n];
const countOn = card => card?.querySelectorAll('.tc-count')[0]?.textContent;

test('BUG-098 R1a: the badge counts only posts in hand, so caught-up is reachable', async () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })),
    },
  });

  // The cold-cache boot this whole task is about: three assignments survive (correctly), but only one
  // post came back. Counting all three told the reader there were 3 new posts over a screen showing
  // one, and reading that one still left the counter at 2 — "You're all caught up" unreachable for up
  // to a fortnight, which is the product's entire promise.
  render(app, [xPost('x1')]);
  await settle();

  assert.equal(app.ctx.countGroupedUnread(), 1, 'the two nobody fetched are held, not counted');

  app.ctx.addDone('x1');
  app.ctx.checkEmpty();
  assert.equal(app.el('caughtup').classList.contains('hidden'), false,
    'reading everything on screen reaches caught-up');
  // The record is untouched by any of this: x2 and x3 are still assigned, with their bullets. Being
  // uncounted is a DISPLAY decision — the whole point is that it is not a deletion. (x1 stays
  // assigned too: `addDone` records the read, and the next render's prune is what collects it.)
  const after = stateOf(app);
  assert.ok(Object.hasOwn(after.assignments, 'x2') && Object.hasOwn(after.assignments, 'x3'),
    'the posts it could not show are held, not destroyed');
  assert.equal(bulletTexts(after).length, 3, 'and every bullet survives');
});

test('BUG-098 R1b: a tile never claims more posts than the drill-in can show', async () => {
  const { app } = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })) },
  });

  render(app, [xPost('x1')]);
  await settle();
  app.ctx.renderTopicCards();

  // The count/content mismatch that must not regress:
  // a tile offering "See all 3 posts" and "Mark 3 done" while `openGroupDetail`, which renders from
  // `_lastFeedItems`, has one card to show.
  //
  // This pins the RE-paint, not the load paint: the explicit `renderGroupGrid()` above runs after
  // `settle()`, by which point `_lastFeedItems` is set whatever order `renderFeedResults` used. The
  // first paint — the one the user actually sees on load — is pinned by R2e instead, which reads the
  // grid synchronously. Saying which paint this
  // test covers is what stops the pair being read as one.
  assert.equal(countOn(tileOf(app)), '1 post', 'the tile counts what it can actually open');
  assert.equal(app.ctx.visibleGroupUnreadIds('g_t').length, 1, 'and the drill-in list agrees with it');
});

// ── A device with a wrong clock must not delete anything ─────────────────────

test('BUG-098 R1c: a fast device clock cannot age out in-window assignments', () => {
  const { app } = boot({
    // A device 20 days fast sees EVERYTHING as 20 days old — its own record and the feed alike. So
    // the ages here are what that device reads, and every one of them looks collectable.
    store: { focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3'], { at: daysAgo(20) }) })) },
  });

  // `at` comes from the server; `cutoff` comes from this device's clock, and nothing reconciles them.
  // A device 20 days fast sees every in-window assignment as aged and deletes it — with its bullets,
  // pushed to every other device. So the feed corroborates the clock: `api/feed.js` windows every
  // source server-side, so a post in hand is inside the window BY THE SERVER'S CLOCK. Here the newest
  // post in hand is 20 days old by the local clock, which is impossible for a live feed — so the
  // clock is wrong, and rule 3 must not run at all.
  app.ctx.syncGroupPrune([xPost('x9', { published: daysAgo(20) })]);

  assert.deepEqual(Object.keys(stateOf(app).assignments).sort(), ['x1', 'x2', 'x3'],
    'nothing is aged out on the word of a clock the feed contradicts');
});

// ── The order the record is refreshed in ─────────────────────────────────────

test('BUG-098 R1d: a stale recorded channel is refreshed before rule 2 reads it', () => {
  const { app } = boot({
    channels: [C2],   // the user follows c2; the record still says this post came from c1
    store: {
      focus_groups: JSON.stringify({
        assignments: { p1: 'g_t' },
        groups: { g_t: { label: 'A topic', summary: [{ text: 'about p1', item_ids: ['p1'] }] } },
        unfiled: [], updatedAt: daysAgo(1), v: 2,
        postMeta: { p1: [sec(daysAgo(2)), 'c1'] }, postMetaEpoch: sec(daysAgo(1)),
      }),
    },
  });

  // This is why `stampPostMeta` runs BEFORE `pruneGroupState`, and it is rule 2 that makes it matter,
  // not rule 3: the post is in hand from a channel the user still follows, so its `ch` is refreshed
  // and it survives. Prune first and rule 2 reads the stale `c1`, finds it absent from `getChannels()`,
  // and destroys the assignment and its bullet.
  app.ctx.syncGroupPrune([xPost('p1', { channel: C2, published: daysAgo(2) })]);

  const after = stateOf(app);
  assert.equal(after.assignments.p1, 'g_t', 'the post the reader can see keeps its assignment');
  assert.equal(after.postMeta.p1[1], 'c2', 'because its channel was corrected from the feed first');
  assert.equal((after.groups.g_t.summary || []).length, 1, 'and its bullet is intact');
});

// ── A failed load must not empty the sticky record ───────────────────────────

test('BUG-098 R1e: an X failure does not wipe the unfiled record', async () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify({
        assignments: {}, groups: {}, unfiled: ['s1', 's2', 's3'], updatedAt: daysAgo(1), v: 2,
        postMetaEpoch: sec(daysAgo(1)),
      }),
    },
  });

  // `unfiled` keeps the absence rule deliberately, and that was safe only while the whole prune was
  // gated on a complete load. Removing that gate for assignments left this pass running on failed
  // loads, where absence means "X 502'd at its post cap" — routine. Ungated, one failure wiped the
  // record and the next load held a fifth to a third of the backlog hidden behind `grouping-pending`
  // for seconds.
  render(app, [xPost('x1')], ['X acct']);
  await settle();

  assert.deepEqual(stateOf(app).unfiled, ['s1', 's2', 's3'],
    'an incomplete load is not evidence that a held post has gone');
});

test('BUG-098 R1f: an ISO-string published date — the only shape production sends — is parsed', async () => {
  const { app } = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMetaEpoch: sec(daysAgo(1)) })) },
  });

  // Every fixture in this suite passes `published` as epoch MILLIS, but `api/_twitter.js` sends
  // `tw.created_at` and `api/_youtube.js` sends `publishedAt` — ISO strings, always. So the branch
  // production runs on every single post had no test at all: making `Date.parse` return NaN left the
  // whole suite green. The failure it hides is not small — every `at` becomes null, every assignment
  // becomes ageless, and one window after the upgrade the epoch collects the lot in a single pass.
  const iso = new Date(daysAgo(3)).toISOString();
  render(app, [xPost('x2', { published: iso })]);
  await settle();

  assert.deepEqual(stateOf(app).postMeta.x2, [sec(Date.parse(iso)), 'c1'],
    'the ISO string is parsed to seconds, not discarded as unknown');
});

test('BUG-098 R1g: reading a post that is ON SCREEN still prunes it', async () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })),
      focus_done: JSON.stringify(['x1']),
    },
  });

  // Rule 1 was pinned only for posts that were NOT in hand — every fixture marked something done while
  // rendering a different post — so `done.has(id) && !inHandIds.has(id)` passed the whole suite. The
  // commonest real case is the opposite: you read a post that is right there on the screen.
  render(app, [xPost('x1')]);
  await settle();

  assert.equal(Object.hasOwn(stateOf(app).assignments, 'x1'), false,
    'the post you just read loses its assignment even though the feed still holds it');
});

// ── C6: postMeta cannot outlive its assignments ──────────────────────────────

test('BUG-098 C6: postMeta is pruned in the same pass as the assignment it describes', async () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })),
      focus_done: JSON.stringify(['x2']),
    },
  });

  render(app, [xPost('x1')]);
  await settle();

  const after = stateOf(app);
  assert.equal(Object.hasOwn(after.postMeta || {}, 'x2'), false,
    'or it becomes an unbounded synced record of its own — [BUG-076]\'s axis');
  assert.deepEqual(Object.keys(after.postMeta || {}).sort(), ['x1', 'x3']);
});

test('BUG-098 C6b: collecting an orphaned postMeta entry is PERSISTED, not just done in memory', () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify({
        assignments: { x1: 'g_t' },
        groups: { g_t: { label: 'A topic', summary: [{ text: 'about x1', item_ids: ['x1'] }] } },
        unfiled: [], updatedAt: daysAgo(1), v: 2,
        // x9's assignment left by another route — the bucket sweep is the live example —
        // leaving its age behind with nothing pointing at it.
        // `at` matches what `stampPostMeta` will compute for the post rendered below, so the stamp is
        // a no-op and the orphan sweep is the ONLY writer. Two writers would let a clock-boundary
        // re-stamp cause the save and quietly stop this test killing its mutation.
        postMeta: { x1: [sec(PINNED), 'c1'], x9: [sec(PINNED), 'c1'] },
        postMetaEpoch: sec(daysAgo(1)),
      }),
    },
  });

  app.ctx.syncGroupPrune([xPost('x1', { published: PINNED })]);

  // The assertion is on STORAGE, not on the returned object. A sweep that forgets to report its
  // change mutates a state nobody saves: the entry is gone from memory, still on disk, and back on
  // the next read — which looks identical to working until the record has grown for months.
  const after = stateOf(app);
  assert.deepEqual(Object.keys(after.postMeta).sort(), ['x1'], 'the orphan is gone from the stored row');
  assert.equal(after.assignments.x1, 'g_t', 'and the live assignment is untouched');
});

// ── C7: the reader is the only guard, on both round trips ────────────────────

const EPOCH_3D = sec(daysAgo(3));   // read once, for the same reason as C5d above
test('BUG-098 C7a: postMeta and postMetaEpoch survive a save/read round trip', () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({
        postMeta: metaFor(['x1', 'x2', 'x3']), postMetaEpoch: EPOCH_3D,
      })),
    },
  });

  // getGroupState NORMALISES rather than spreads, so a field it does not name is dropped on the very
  // next save — written by one function and silently gone by the following read, with the suite
  // green. That trap already cost `unfiled` once.
  const state = app.ctx.getGroupState();
  app.ctx.saveGroupState(state);

  const after = stateOf(app);
  assert.equal(Object.hasOwn(after, 'postMeta'), true, 'postMeta is declared in the reader');
  assert.deepEqual(Object.keys(after.postMeta).sort(), ['x1', 'x2', 'x3']);
  assert.equal(after.postMetaEpoch, EPOCH_3D, 'and the epoch is carried, not re-stamped');
});

test('BUG-098 C7b: postMeta survives a row pulled down from another device', () => {
  const { app } = boot({ store: {} });

  // `applySyncedState` writes the pulled blob VERBATIM and never normalises, so `getGroupState` is
  // the only guard on a record that arrived from another device — a field it does not name is lost
  // on this device's next local save, which is a different failure from C7a and needs its own pin.
  app.ctx.applySyncedState({
    groups: threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']), postMetaEpoch: EPOCH_3D }),
  });
  app.ctx.saveGroupState(app.ctx.getGroupState());

  const after = stateOf(app);
  assert.deepEqual(Object.keys(after.postMeta || {}).sort(), ['x1', 'x2', 'x3'],
    'the pulled record keeps its ages through a local save');
});

// ── C8: no feed-derived input is left in the assignment prune ────────────────

test('BUG-098 C8a: a failed channel no longer blocks the prune', async () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })),
      focus_done: JSON.stringify(['x2']),
    },
  });

  // The old gate switched the prune off whenever ANY channel failed, so one permanently-dead channel
  // disabled the only route by which assignments, emptied topics and dead bullets ever left storage.
  // Nothing is inferred from what loaded any more, so the gate has nothing left to protect.
  render(app, [xPost('x1')], ['a channel that failed to fetch']);
  await settle();

  assert.equal(Object.hasOwn(stateOf(app).assignments, 'x2'), false,
    'the read post is collected even on a load that lost a channel');
});

test('BUG-098 C8b: the unfiled record still leaves when its post is absent', async () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify({
        assignments: {}, groups: {}, unfiled: ['x9'], updatedAt: daysAgo(1), v: 2,
      }),
    },
  });

  // `unfiled` KEEPS the absence rule, deliberately. Dropping an id from it wrongly costs one post one
  // extra hidden moment, once; dropping an assignment wrongly destroys a synced cluster. The
  // asymmetry is the whole reason the two records are treated differently.
  render(app, [xPost('x1')]);
  await settle();

  assert.deepEqual(stateOf(app).unfiled, [], 'an id no feed has named is not held forever');
});

// ── C9: the guards that keep an empty answer from reading as a removal ───────

test('BUG-098 C9a: the channel rule cannot fire on an empty channel list', () => {
  const { app } = boot({
    channels: [],   // several known sync failures produce exactly this in production
    store: {
      focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3'], { ch: 'c1' }) })),
    },
  });

  app.ctx.syncGroupPrune([]);

  assert.deepEqual(Object.keys(stateOf(app).assignments).sort(), ['x1', 'x2', 'x3'],
    'an empty channel list is absence, not evidence of removal — the same mistake in a new place');
});

test('BUG-098 C9b: an empty feed prunes nothing, because the prune stays below the early return', async () => {
  const { app } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })),
      focus_done: JSON.stringify(['x2']),
    },
  });

  // `renderFeedResults` returns before `syncGroupPrune` when nothing loaded, which is what shields
  // the record while `channels` is transiently empty. That placement was accidental; the rules being
  // feed-independent now is exactly what would tempt someone to hoist the call to boot. Pinned so
  // that move reds instead of shipping.
  render(app, []);
  await settle();

  assert.deepEqual(Object.keys(stateOf(app).assignments).sort(), ['x1', 'x2', 'x3'],
    'a render with nothing in hand writes no deletion at all');
});

// ── C10: the backfill must not turn every render into a push ─────────────────

test('BUG-098 C10: a second identical render leaves the row byte-identical and pushes nothing', async () => {
  const { app, puts } = boot({
    store: {
      focus_groups: JSON.stringify(threeAssigned({
        postMeta: metaFor(['x1', 'x2', 'x3']), postMetaEpoch: sec(daysAgo(1)),
      })),
    },
  });

  // ONE post object, rendered twice. Building it twice reads the clock twice, and a render that
  // straddles a second boundary re-stamps `at` — measured at roughly 1 run in 500, which is enough to
  // make this test give two answers on identical code.
  const post = xPost('x1');
  render(app, [post]);
  await settle();
  app.runTimers();
  await settle();

  const settled = app.get('focus_groups');
  const putsBefore = puts.length;      // ALL puts, compared against all puts below — the first
                                       // version compared a filtered count against this one, so the
                                       // assertion that fired was not the one its message described.
  render(app, [post]);
  await settle();
  app.runTimers();
  await settle();

  assert.equal(app.get('focus_groups'), settled,
    'a backfill reporting "changed" when it stamped nothing new pushes on every render — churn on the '
    + 'one key [BUG-087] and [BUG-076] both live on');
  assert.equal(puts.length, putsBefore,
    'and no push of any kind goes out for a render that changed nothing');
});

// ── The backfill: where an age comes from in the first place ─────────────────

test('BUG-098 backfill: a classify records each assigned post\'s published date and channel', async () => {
  const published = daysAgo(2);
  const { app } = boot({
    store: { focus_groups: JSON.stringify({ assignments: {}, groups: {}, unfiled: [], updatedAt: 0, v: 2 }) },
    reply: [{ label: 'A topic', summary: ['a point'], item_ids: ['x1'] }],
  });

  // Two posts sent, one placed. Asserted through `updateGroupsForFeed` directly rather than a render,
  // because a render prunes afterwards and its orphan sweep would tidy away a wrongly-written entry
  // before any assertion could see it — the guard and the sweep would then mask each other and
  // neither would be pinned.
  await app.ctx.updateGroupsForFeed([xPost('x1', { published }), xPost('x_leftover', { published })]);

  const after = stateOf(app);
  assert.equal(after.assignments.x1, 'g_a_topic', 'the post was assigned');
  assert.deepEqual(after.postMeta.x1, [sec(published), 'c1'],
    'and its age and channel were recorded at the one moment both were in hand');
  assert.equal(Object.hasOwn(after.postMeta, 'x_leftover'), false,
    'the post the model could not place gets no entry — postMeta describes ASSIGNMENTS, and a map of '
    + 'every post in every feed would be bounded by nothing');
});

test('BUG-098 backfill: a legacy assignment whose post is in hand is stamped', async () => {
  const published = daysAgo(2);
  const { app } = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMetaEpoch: sec(daysAgo(1)) })) },
  });

  render(app, [xPost('x2', { published })]);
  await settle();

  const after = stateOf(app);
  assert.deepEqual(after.postMeta?.x2, [sec(published), 'c1'],
    'anything the user can still see self-heals within one window, so the epoch never reaches it');
  assert.equal(Object.hasOwn(after.postMeta || {}, 'x1'), false,
    'and a post NOT in hand is left unknown rather than guessed at');
});

test('BUG-098 backfill: a post with no assignment is never given an age', async () => {
  const { app } = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMetaEpoch: sec(daysAgo(1)) })) },
  });

  // `postMeta` describes assignments. Record one for a post nobody grouped and it becomes a synced
  // map of every post in every feed — growth on the key whose whole justification is staying small,
  // and bounded by nothing, since the prune only ever collects entries that HAD an assignment.
  render(app, [xPost('x2'), xPost('x_ungrouped')]);
  await settle();

  const after = stateOf(app);
  assert.equal(Object.hasOwn(after.postMeta, 'x_ungrouped'), false,
    'an ungrouped post leaves no trace in the record');
  assert.ok(Object.hasOwn(after.postMeta, 'x2'), 'while the assigned one is stamped');
});

test('BUG-098 backfill: an unparseable published date is recorded as UNKNOWN, never as zero', async () => {
  const { app } = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMetaEpoch: sec(daysAgo(1)) })) },
  });

  // `published` is remote text. Landing junk as 0 would make the post older than any cutoff, so a
  // publication returning a broken date would age out every one of its posts at once. The
  // `age > 0` guard in the prune happens to catch that too, which is exactly why this is asserted
  // HERE, on the stored value: two guards over one input pin neither.
  render(app, [xPost('x2', { published: 'not a date at all' })]);
  await settle();

  assert.deepEqual(stateOf(app).postMeta.x2, [null, 'c1'],
    'unknown age, known channel — so it ages from the epoch like any other ageless record');
});

// ── The escape hatch, the guard's edges, and the first paint ──────────────────
//
// The RECORD is split from the DISPLAY: assignments survive a cold cache
// while the badge, the tiles and the drill-in count only what this render has in hand. That
// split must not reach one function too far — into `markAllDone`, which is a WRITE
// answering "clear everything the account holds", not a display answering "what can I show".
// Otherwise an over-count that has an escape hatch becomes an under-count that has none —
// R2a pins that hatch.

test('BUG-098 R2a: Mark-all-done clears the whole account, not only what this device fetched', async () => {
  const { app } = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })) },
  });

  // The cold-cache render again: three assignments held, one post in hand.
  render(app, [xPost('x1')]);
  await settle();
  assert.equal(app.ctx.countGroupedUnread(), 1, 'the DISPLAY still counts only what it can show');

  app.ctx.markAllDone();

  // `markAllDone` unions the stream cards with the grouped-unread ids. An out-of-hand assignment is
  // in NEITHER set once that second half is filtered — it has no stream card, because this device
  // never fetched the post — so Mark-all silently skipped it and left it unread on every device
  // that had. "Mark all done" that does not mark all done is the worst shape available: it is the
  // one control whose whole promise is that nothing is left behind.
  assert.deepEqual(JSON.parse(app.get('focus_done')).sort(), ['x1', 'x2', 'x3'],
    'every unread assignment the ACCOUNT holds is marked, whatever this device fetched');
});

// R2c. R2a and R2b both boot `focus_group_view: 'on'`, so the protection above is
// pinned ONLY in the grouped view. Ungrouped is the DEFAULT, which means the one place that
// guarantee would go unasserted is the view almost every reader is actually in.
// The `!isGrouped()` gate can be moved one function down, out of
// `visibleGroupedUnreadIds` and into `groupedUnreadIds`, and every test above still passes — because
// they all run with grouping ON, where the gate is transparent. In the default view that move turns
// `markAllDone` into a write that silently skips every assignment this device did not fetch.
test('BUG-098 R2c / TASK-099: Mark-all-done clears the whole account in the DEFAULT ungrouped view too', async () => {
  const { app } = boot({
    store: {
      focus_group_view: 'off',
      focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })),
    },
  });

  render(app, [xPost('x1')]);
  await settle();

  // The guard that proves we are in the OFF regime at all. Ungrouped, the stream holds every post it
  // has, so the grid contributes NOTHING to the display count — if this read 1 the fixture never
  // left grouped mode and the assertion below would be R2a a second time.
  assert.equal(app.ctx.countGroupedUnread(), 0,
    'guard: the DISPLAY must be reading the ungrouped view, where the grid owns no part of the count');

  app.ctx.markAllDone();

  // The write must not inherit the view. x2 and x3 have no stream card here for the same reason they
  // had none in R2a — this device never fetched them — and the ungrouped gate is one function away
  // from swallowing them as well. "Mark all done" that does not mark all done is the worst shape
  // available: it is the one control whose whole promise is that nothing is left behind.
  assert.deepEqual(JSON.parse(app.get('focus_done')).sort(), ['x1', 'x2', 'x3'],
    'every unread assignment the ACCOUNT holds is marked, whatever view the reader happens to be in');
});

test('BUG-098 R2b: a device that fetched the posts agrees it is caught up', async () => {
  const SEED = threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) });
  const { app } = boot({ store: { focus_groups: JSON.stringify(SEED) } });
  render(app, [xPost('x1')]);
  await settle();
  app.ctx.markAllDone();

  // Both keys are synced, so this is what the next device pulls down — the device that DID fetch the
  // posts, and on which the bug is visible as "2 new" over a screen the other device had just
  // declared finished.
  //
  // Asserted on the STATE set, before any render. Two weaker versions were tried and both were
  // fixture fiction: passing the three done posts to `renderFeedResults` is a shape production never
  // produces (`loadFeed` filters `done` out through `hiddenSet` before this is called), and the
  // empty feed it really would produce makes the caught-up assertion VACUOUS — `renderFeedResults`
  // calls `showCaughtUp()` unconditionally on a zero-item render (`app.js:2740`), so it passes
  // whether or not Mark-all swept anything. The account-level question needs no feed at all.
  const b = boot({
    store: { focus_groups: app.get('focus_groups'), focus_done: app.get('focus_done') },
  });

  // Spread into THIS realm before comparing: the array comes back carrying the vm's prototypes, so a
  // bare `deepEqual` fails on a structurally identical `[]`.
  assert.deepEqual([...b.app.ctx.groupedUnreadIds()], [],
    'the account is clean everywhere, not just on the device that pressed the button');
});

test('BUG-098 R2c: one future-dated post cannot vouch for a clock the rest of the feed contradicts', () => {
  const { app } = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3'], { at: daysAgo(20) }) })) },
  });

  // `published` is remote text. `api/feed.js` and `mergeTweets` bound it BELOW — nothing older than
  // the window reaches the client — but nothing bounds it ABOVE, so one publication with a date in
  // the future sets `Math.max(...stamps)` to that date and the guard reads the clock as corroborated
  // on any device. Measured: a 20-days-fast device plus one future-dated item deleted the entire
  // cluster, bullets and all, and pushed the loss upward. A stamp the local clock says has not
  // happened yet is not evidence about the local clock; it is discarded.
  app.ctx.syncGroupPrune([
    xPost('x9', { published: daysAgo(20) }),
    xPost('x8', { published: Date.now() + 1 * DAY }),
  ]);

  assert.deepEqual(Object.keys(stateOf(app).assignments).sort(), ['x1', 'x2', 'x3'],
    'the impossible stamp is ignored and the contradicted clock is still distrusted');
});

test('BUG-098 R2d: the clock guard engages exactly at the window edge', () => {
  // The guard's THRESHOLD, pinned in both directions: the
  // only other test on it uses a 20-day skew, so nothing else says where it starts.
  //
  // It engages when the newest post in hand is itself older than the window — impossible for a live
  // feed, since every source is windowed to WINDOW_DAYS server-side (`api/feed.js`), so it means this
  // device's clock is wrong rather than the posts.
  const engaged = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3'], { at: daysAgo(20) }) })) },
  });
  engaged.app.ctx.syncGroupPrune([xPost('x9', { published: daysAgo(15) })]);
  assert.deepEqual(Object.keys(stateOf(engaged.app).assignments).sort(), ['x1', 'x2', 'x3'],
    'a feed whose newest post is already outside the window switches ageing off');

  // And it is silent below that edge — the clock is believed, and rule 3 deletes on its word.
  //
  // KNOWN LIMIT, accepted deliberately (the binary guard was chosen over a graded
  // cutoff): a device fast by LESS than the window still ages out in-window assignments and pushes
  // the loss, because the skew has to exceed `WINDOW - age of the newest post` before the feed can
  // contradict it. For example: 2 days fast, a post published 13 real days ago, its
  // assignment and bullet deleted and carried in the PUT. This assertion is that limit written down
  // where a future change has to look at it — not an endorsement of it.
  const silent = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3'], { at: daysAgo(20) }) })) },
  });
  silent.app.ctx.syncGroupPrune([xPost('x9', { published: daysAgo(13) })]);
  assert.deepEqual(Object.keys(stateOf(silent.app).assignments), [],
    'below the edge the clock is taken at its word');
});

test('BUG-098 R2e: the FIRST painted tile counts what this render has in hand', async () => {
  const { app } = boot({
    store: { focus_groups: JSON.stringify(threeAssigned({ postMeta: metaFor(['x1', 'x2', 'x3']) })) },
  });

  // Read the grid SYNCHRONOUSLY, with no `settle()` and no second `renderGroupGrid()` call. That is
  // the whole point: `_lastFeedItems = items` sits above the first paint, and only this pins that
  // ordering — with the assignment moved below the paint,
  // the first tile the user sees reads "3 posts" over one reachable post (on
  // the paint that happens at load). R1b cannot see it, because it calls `renderGroupGrid()` again
  // after `settle()`, by which point `_lastFeedItems` is set either way.
  render(app, [xPost('x1')]);

  assert.equal(countOn(tileOf(app)), '1 post', 'the grid is painted from THIS render, not the last one');
});
