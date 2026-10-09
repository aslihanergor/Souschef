// The first-run tour ([TASK-092]).
//
// Two layers, split the way the task's Cost section split them. The DECISIONS — whether a boot may
// start the tour, which cards survive the skip rule, what each button does to the record — are pure
// and live in lib/pure.js, so they are tested directly (P-series). Everything that decides whether the
// app stays USABLE — the layer going up and coming down, the four blockers, the hooks where a channel
// lands and a feed renders, suspension under the drawer and the picker, focus — runs the real app.js
// through the harness (A-series). Criterion numbers are the task file's.
//
// What this file cannot see without help: where things are placed (`getBoundingClientRect` answers
// zeros), the dim itself (a box-shadow), reduced motion (`matchMedia` always answers false), and Tab
// traversal (the stubs have no `matches`/`getClientRects` — A30b and A30c stub those, A30d and A30e the toast's query and
// focus). How those LOOK is criterion 17
// and the live half of 14; A29–A29e read placement from stubbed rects.
//
// CORRECTED after review round 1 (MED-3). This header used to say that which element a ring is on was
// visible through `#tour-ring`'s `data-target`. It was not: `data-target` is the CARD's key, so a ring on
// the wrong element — the gear instead of the topics switch, the Add button instead of Open my feed — kept
// every test green. `box()` below gives chosen elements a real rect, and A7c/A26 assert the ring's own
// position, which only the right element can produce.
//
// Pure functions are reached through the namespace rather than named imports on purpose: at the RED
// step a missing export must fail each test BY NAME, not the whole file at load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pure from '../lib/pure.js';
import { EVENT_NAMES } from '../api/_events.js';
import { createApp, SIGNED_IN } from '../test-helpers/app-harness.mjs';

// ── P: the pure decisions ───────────────────────────────────────────────────────────────────────

const START = { signedIn: true, stateLoaded: true, damaged: false, channels: 0, archived: 0, record: null };

test('[TASK-092] P1 a signed-in, loaded, healthy, empty account with no record may start (criterion 1)', () => {
  assert.equal(pure.shouldStartTour(START), true);
});

// Criterion 2 and Risk 2 — one test per term, so each term of the compound predicate is pinned alone
// (Known Pitfalls §2). Each fixture differs from START in exactly one field.
for (const [id, label, change] of [
  ['P2a', 'signed out', { signedIn: false }],
  ['P2b', 'the boot read failed or was refused', { stateLoaded: false }],
  ['P2c', 'the store is damaged', { damaged: true }],
  ['P2d', 'a channel exists', { channels: 1 }],
  ['P2e', 'an archived item exists', { archived: 1 }],
  ['P2f', 'a record is present', { record: JSON.stringify({ at: 'done' }) }],
  // Battery S7: a quota-aborted write leaves "" behind. Present-but-empty is still a record — reading it
  // as absent would restart the tour over it, the [BUG-052] shape one key over.
  ['P2g', 'the record is an empty string', { record: '' }],
]) {
  test(`[TASK-092] ${id} does not start when ${label} (criterion 2)`, () => {
    assert.equal(pure.shouldStartTour({ ...START, ...change }), false);
  });
}

const YT = { source: 'youtube', hasX: false, hasContent: false };

test('[TASK-092] P3 the setup part on the YouTube tab, with nothing added, has all four cards (criterion 9)', () => {
  assert.deepEqual(pure.tourCards('setup', YT), ['tabs', 'add', 'import', 'wait']);
});

test('[TASK-092] P4 Import is skipped on the X and Substack tabs (criterion 9)', () => {
  assert.deepEqual(pure.tourCards('setup', { ...YT, source: 'twitter' }), ['tabs', 'add', 'wait']);
  assert.deepEqual(pure.tourCards('setup', { ...YT, source: 'substack' }), ['tabs', 'add', 'wait']);
});

test('[TASK-092] P5 card 4 is skipped whenever "Open my feed" is showing (criterion 11, amendment 3)', () => {
  assert.deepEqual(pure.tourCards('setup', { ...YT, hasContent: true }), ['tabs', 'add', 'import']);
  assert.deepEqual(pure.tourCards('setup', { ...YT, source: 'twitter', hasContent: true }), ['tabs', 'add']);
});

test('[TASK-092] P6 the topics card is shown only when an X account is followed (criterion 9)', () => {
  assert.deepEqual(pure.tourCards('feed', YT), ['done', 'archive', 'gear', 'end']);
  assert.deepEqual(pure.tourCards('feed', { ...YT, hasX: true }), ['done', 'archive', 'topics', 'gear', 'end']);
});

const at = (card, extra = {}) => ({ at: 'setup', card, replay: false, ...extra });

test('[TASK-092] P7 Next and Back move within the setup part; Back on its first card does nothing (criterion 3)', () => {
  let r = at('tabs');
  r = pure.tourStep(r, 'next', YT).record;
  assert.equal(r.card, 'add');
  r = pure.tourStep(r, 'next', YT).record;
  assert.equal(r.card, 'import');
  r = pure.tourStep(r, 'next', YT).record;
  assert.equal(r.card, 'wait');
  assert.equal(pure.tourStep(r, 'back', YT).record.card, 'import');
  const first = at('tabs');
  const step = pure.tourStep(first, 'back', YT);
  assert.equal(step.record, first, 'Back on the first card returns the SAME record — nothing to write');
  assert.equal(step.emit, null);
});

test('[TASK-092] P8 Next from the last setup card goes to the tip only when that card is not the wait (criterion 11)', () => {
  const content = { ...YT, hasContent: true };
  assert.deepEqual(pure.tourStep(at('import'), 'next', content).record, { at: 'tip', replay: false });
  assert.deepEqual(pure.tourStep(at('add'), 'next', { ...content, source: 'twitter' }).record, { at: 'tip', replay: false });
  const wait = at('wait');
  assert.equal(pure.tourStep(wait, 'next', YT).record, wait, 'card 4 is left by OK, never by Next');
});

test('[TASK-092] P9 OK on card 4 waits for the first channel; OK elsewhere in setup does nothing (criterion 5)', () => {
  assert.deepEqual(pure.tourStep(at('wait'), 'ok', YT).record, { at: 'wait-channel', replay: false });
  const tabs = at('tabs');
  assert.equal(pure.tourStep(tabs, 'ok', YT).record, tabs);
});

test('[TASK-092] P10 Close ends the tour from any showing card and names the part and card (criterion 4)', () => {
  const feedCtx = { ...YT, hasX: true };
  for (const [rec, part, card] of [
    [at('add'), 'setup', 'add'],
    [{ at: 'tip', replay: true }, 'tip', 'tip'],
    [{ at: 'feed', card: 'gear', replay: false }, 'feed', 'gear'],
  ]) {
    const { record, emit } = pure.tourStep(rec, 'close', feedCtx);
    assert.deepEqual(record, { at: 'done' }, `close on ${part}`);
    assert.equal(emit.name, 'tour_close');
    assert.deepEqual(emit.props, { part, card, replay: rec.replay });
  }
  for (const rec of [{ at: 'wait-channel', replay: false }, { at: 'wait-feed', replay: false }, { at: 'done' }]) {
    const step = pure.tourStep(rec, 'close', YT);
    assert.equal(step.record, rec, `nothing is showing at ${rec.at}, so there is nothing to close`);
    assert.equal(step.emit, null);
  }
});

test('[TASK-092] P11 the first channel raises the tip from a setup card or the wait, and from nothing else (criterion 6)', () => {
  assert.deepEqual(pure.tourStep(at('add', { replay: true }), 'channel', YT).record, { at: 'tip', replay: true });
  assert.deepEqual(pure.tourStep({ at: 'wait-channel', replay: false }, 'channel', YT).record, { at: 'tip', replay: false });
  for (const rec of [{ at: 'tip', replay: false }, { at: 'wait-feed', replay: false }, { at: 'feed', card: 'done', replay: false }, { at: 'done' }]) {
    assert.equal(pure.tourStep(rec, 'channel', YT).record, rec, `a channel landing at ${rec.at} changes nothing`);
  }
  assert.equal(pure.tourStep(null, 'channel', YT).record, null, 'no record, no tour');
});

test('[TASK-092] P12 the tip ends in a wait for the feed, by OK or by tapping Open my feed (criterion 7)', () => {
  const tip = { at: 'tip', replay: false };
  assert.deepEqual(pure.tourStep(tip, 'ok', YT).record, { at: 'wait-feed', replay: false });
  assert.deepEqual(pure.tourStep(tip, 'go', YT).record, { at: 'wait-feed', replay: false });
  const done = { at: 'done' };
  assert.equal(pure.tourStep(done, 'go', YT).record, done);
  // Independent battery L26b: Back on the tip is disabled in the view, so the app cannot send it — but the
  // decision itself must still refuse to cross back over the channel the reader just added.
  assert.equal(pure.tourStep(tip, 'back', YT).record, tip, 'Back at the tip goes nowhere');
});

test('[TASK-092] P13 a feed render with a post starts the feed part only from the wait, never again (criterion 8)', () => {
  // Amendment 11 changed the requirement this asserts: the start now also needs the render to have a post, so the
  // context says so. The "never again" half is unchanged, and is asserted WITH a post so only the wait can stop it.
  const POSTS = { ...YT, feedHasPost: true };
  assert.deepEqual(pure.tourStep({ at: 'wait-feed', replay: true }, 'feed', POSTS).record, { at: 'feed', card: 'done', replay: true });
  for (const rec of [at('tabs'), { at: 'tip', replay: false }, { at: 'feed', card: 'archive', replay: false }, { at: 'done' }]) {
    assert.equal(pure.tourStep(rec, 'feed', POSTS).record, rec, `a render at ${rec.at} changes nothing`);
  }
});

test('[TASK-092] P13b a feed render with no post keeps the wait — caught up, or only the X-unavailable note (criterion 8, amendment 11)', () => {
  const wait = { at: 'wait-feed', replay: false };
  assert.equal(pure.tourStep(wait, 'feed', { ...YT, feedHasPost: false }).record, wait, 'an empty first feed does not start the feed part');
  assert.equal(pure.tourStep(wait, 'feed', YT).record, wait, 'nor does a render that does not say it has a post');
});

test('[TASK-092] P14 Next walks the feed part and the last card finishes the tour (criteria 3, 13)', () => {
  let r = { at: 'feed', card: 'done', replay: false };
  assert.equal(pure.tourStep(r, 'back', YT).record, r, 'Back on the first feed card never reaches the tip');
  const seen = [];
  const ctx = { ...YT, hasX: true };
  for (let i = 0; i < 4; i++) { r = pure.tourStep(r, 'next', ctx).record; seen.push(r.card); }
  assert.deepEqual(seen, ['archive', 'topics', 'gear', 'end']);
  const { record, emit } = pure.tourStep(r, 'next', ctx);
  assert.deepEqual(record, { at: 'done' });
  assert.deepEqual(emit, { name: 'tour_finish', props: { replay: false } });
});

test('[TASK-092] P15 each card reads as the UI & states table says, count recalculated per step (criteria 3, 9; amendment 1)', () => {
  assert.deepEqual(pure.tourView(at('tabs'), YT), {
    part: 'Setup', card: 'tabs', text: 'Pick where to add from: YouTube, X or Substack.',
    count: '1 of 4', backDisabled: true, main: 'Next', target: 'tabs',
  });
  assert.equal(pure.tourView(at('add'), YT).count, '2 of 4');
  assert.equal(pure.tourView(at('add'), { ...YT, source: 'twitter' }).count, '2 of 3',
    'the same record on another tab counts the cards that will show NOW');
  assert.equal(pure.tourView(at('add'), YT).backDisabled, false);
  assert.deepEqual(pure.tourView(at('wait'), YT), {
    part: 'Setup', card: 'wait', text: 'Add your first channel. “Open my feed” appears when you do.',
    count: '4 of 4', backDisabled: false, main: 'OK', target: null,
  });
  assert.equal(pure.tourView(at('import'), { ...YT, hasContent: true }).main, 'Next');
  assert.deepEqual(pure.tourView({ at: 'tip', replay: false }, YT), {
    part: 'Tip', card: 'tip', text: 'Your feed is ready. Tap here to open it, or OK to add more first.',
    count: '', backDisabled: true, main: 'OK', target: 'go',
  });
  assert.deepEqual(pure.tourView({ at: 'feed', card: 'done', replay: false }, YT), {
    part: 'Your feed', card: 'done', text: 'Done clears it. Your feed shrinks as you read.',
    count: '1 of 4', backDisabled: true, main: 'Next', target: 'done',
  });
  assert.deepEqual(pure.tourView({ at: 'feed', card: 'end', replay: false }, { ...YT, hasX: true }), {
    part: 'Your feed', card: 'end',
    text: 'When everything’s done you’ll see “You’re all caught up”. That’s the point.',
    count: '5 of 5', backDisabled: false, main: 'Done', target: null,
  });
  assert.equal(pure.tourView(at('import'), { ...YT, source: 'twitter' }).card, 'wait',
    'a card that no longer survives resolves to the next one that does');
  // Independent battery L11: with NO later survivor — card 4 on a replay with content — it resolves to the LAST
  // card that survives, not back to card 1.
  assert.deepEqual([pure.tourView(at('wait'), { ...YT, hasContent: true }).card, pure.tourView(at('wait'), { ...YT, hasContent: true }).count],
    ['import', '3 of 3']);
  for (const rec of [null, { at: 'wait-channel' }, { at: 'wait-feed' }, { at: 'done' }]) {
    assert.equal(pure.tourView(rec, YT), null, `nothing to show at ${rec && rec.at}`);
  }
});

test('[TASK-092] P16 an unreadable record reads as finished, so a damaged key fails to the plain app (criterion 15)', () => {
  assert.equal(pure.parseTourRecord(null), null, 'absent is not a record');
  assert.deepEqual(pure.parseTourRecord(JSON.stringify(at('add'))), at('add'));
  for (const raw of ['', 'not json', '[]', 'null', '{"at":"somewhere"}']) {
    assert.deepEqual(pure.parseTourRecord(raw), { at: 'done' }, `raw ${JSON.stringify(raw)}`);
  }
});

test('[TASK-092] P17 the record is cleared on exit and the three events are allowlisted (criteria 12, 13)', () => {
  assert.equal(pure.EXIT_DISPOSITION.tour, 'clear');
  for (const name of ['tour_start', 'tour_close', 'tour_finish']) {
    assert.ok(EVENT_NAMES.has(name), `${name} must be in EVENT_NAMES or the server bins it silently`);
  }
});

// ── A: the real app ─────────────────────────────────────────────────────────────────────────────

const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const settle = () => new Promise((r) => setImmediate(r));
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const YT_CHANNEL = { id: 'UCmine', name: 'My Channel', keyword: '', source: 'youtube', addedAt: Date.now() - 3600_000 };
const X_CHANNEL = { id: '111', name: 'Sam', handle: 'sam', keyword: '', source: 'twitter', addedAt: Date.now() - 3600_000 };
const TOUR_LAYER = ['tour', 'tour-ring', 'tour-block-top', 'tour-block-right', 'tour-block-bottom', 'tour-block-left'];

// What PUT /api/state really answers — the shape test/push-intent.test.mjs documents: an events-only
// body gets explicit nulls, a state write gets a version.
function putAnswer(raw) {
  const parsed = JSON.parse(raw) || {};
  return ok(parsed.state === undefined
    ? { updatedAt: null, rev: null }
    : { updatedAt: '2026-09-15T09:00:00.000Z', rev: '2026-09-15T09:00:00.000000' });
}

/** An app and the PUT bodies it sent. `stateGet`: 'no-row' (a brand-new account), 'fails' (500),
 *  'row' (an account with a channel), 'empty-row' (an account row with no content), or
 *  'device' (a signed-in boot answered from the device — refused, [BUG-102]). `feed`: 'posts',
 *  'empty', 'fails', and for X channels 'x-quota' (no cache → the X-unavailable note). */
function rig({ store = {}, signedIn = true, stateGet = 'no-row', search = '', feed = 'posts' } = {}) {
  const puts = [];
  let feedMode = feed;
  let feedHold = null;   // while set, every /api/feed request waits — "the feed is loading"
  let importHold = null; // while set, the YouTube import result waits — "back from Google, still loading"
  const app = createApp({ store: { focus_device_id: DEVICE_ID, ...store }, search });
  app.setFetch(async (url, init) => {
    const method = init.method || 'GET';
    if (url.includes('/api/auth/me')) {
      return signedIn ? ok({ email: 'new@example.com' }) : { ok: false, status: 401, json: async () => ({}) };
    }
    if (url.includes('/api/state') && method === 'PUT') { puts.push(JSON.parse(init.body)); return putAnswer(init.body); }
    if (url.includes('/api/state')) {
      if (stateGet === 'fails') return { ok: false, status: 500, json: async () => ({}) };
      if (stateGet === 'row') {
        return ok({ state: { channels: [YT_CHANNEL], done: ['d1'] }, updatedAt: '2026-09-15T08:00:00.000Z', rev: 'r1', kind: 'account' });
      }
      if (stateGet === 'empty-row') {
        // A row that EXISTS but holds nothing to read — say a theme chosen on another device first.
        return ok({ state: { channels: [], done: [], archive: [], theme: 'dark' }, updatedAt: '2026-09-15T08:00:00.000Z', rev: 'r1', kind: 'account' });
      }
      return ok({ state: null, updatedAt: null, kind: stateGet === 'device' ? 'device' : (signedIn ? 'account' : 'device') });
    }
    if (url.includes('/api/resolve-channel')) return ok({ channelId: 'UCnew', name: 'New Channel', avatarUrl: null });
    if (url.includes('/api/connect/youtube/result')) {
      if (importHold) await importHold;
      return ok({ channels: [{ channelId: 'UCimp', name: 'Imported', avatarUrl: null }], truncated: false });
    }
    if (url.includes('/api/group')) return ok({ groups: null });
    if (url.includes('/api/auth/logout')) return ok({ ok: true });
    if (url.includes('/api/feed')) {
      if (feedHold) await feedHold;
      if (feedMode === 'fails') return { ok: false, status: 502, json: async () => ({ error: 'feed fetch failed' }) };
      if (url.includes('source=twitter') && feedMode === 'x-quota') {
        return { ok: false, status: 429, json: async () => ({ error: 'quota', reason: 'quota' }) };
      }
      if (feedMode === 'empty' || url.includes('source=twitter')) return ok({ items: [] });
      return ok({ items: [
        { videoId: 'v1', title: 'First video', published: ago(60_000) },
        { videoId: 'v2', title: 'Second video', published: ago(120_000) },
      ] });
    }
    throw new Error(`unrouted request: ${url}`);
  });
  return {
    app, puts,
    setFeed: (m) => { feedMode = m; },
    /** Hold every feed request until the returned function is called. */
    holdFeed: () => {
      let release;
      feedHold = new Promise((r) => { release = r; });
      return () => { feedHold = null; release(); };
    },
    /** Hold the YouTube import result until the returned function is called. */
    holdImport: () => {
      let release;
      importHold = new Promise((r) => { release = r; });
      return () => { importHold = null; release(); };
    },
  };
}

/** Give an element a real-looking box, so placement is observable: the harness answers zeros for every
 *  rect, which makes every ring land in the same place and "which element is it on" unanswerable. */
function box(el, top, left = 16, width = 300, height = 40) {
  el.getBoundingClientRect = () => ({ top, left, width, height, right: left + width, bottom: top + height });
  return el;
}
/** Where the ring is drawn, as the top of the element it surrounds (the ring sits 6px outside it). */
const ringOn = (app) => parseFloat(app.el('tour-ring').style.top) + 6;

async function drain(app) { for (let i = 0; i < 6; i++) { app.runTimers(4); await settle(); } }
async function boot(app) { await app.ctx.init(); await drain(app); }
/** A reload: a fresh document over the same storage. */
function reload(app, opts = {}) { return rig({ ...opts, store: Object.fromEntries(app.store) }); }

const rec = (app) => JSON.parse(app.get('focus_tour'));
const shown = (app, id) => !app.el(id).classList.contains('hidden');
const card = (app) => (shown(app, 'tour') ? app.el('tour').dataset.card : null);
const eventsOf = (app, puts) => [...puts.flatMap((p) => p.events || []), ...JSON.parse(app.get('focus_events') || '[]')];
const named = (app, puts, name) => eventsOf(app, puts).filter((e) => e.name === name);
const statePuts = (puts) => puts.filter((p) => 'state' in p);
const click = (app, id) => app.click(app.el(id));

/** Everything a "the tour ended and nothing is left dimmed" claim covers (criteria 4, 15). */
function assertNoDim(app, why) {
  for (const id of TOUR_LAYER) assert.ok(!shown(app, id), `#${id} must be hidden — ${why}`);
  assert.ok(!app.ctx.document.body.classList.contains('tour-open'), `the scroll lock must be released — ${why}`);
}

async function addChannelByForm(app) {
  app.el('input-url').value = 'New Channel';
  await app.ctx.handleAddChannel();
  assert.equal(click(app, 'btn-confirm-add'), 1, 'guard: the confirm button is wired');
}

test('[TASK-092] A1 a new signed-in account boots onto setup with card 1 over the source tabs (criterion 1)', async () => {
  const { app, puts } = rig();
  await boot(app);
  assert.deepEqual(app.visibleViews(), ['view-setup']);
  assert.equal(card(app), 'tabs');
  assert.ok(shown(app, 'tour-ring'));
  assert.equal(app.el('tour-ring').dataset.target, 'tabs', 'the ring is for the source tabs');
  for (const id of ['tour-block-top', 'tour-block-right', 'tour-block-bottom', 'tour-block-left']) {
    assert.ok(shown(app, id), `#${id} is up — outside the cut-out takes no taps`);
  }
  assert.ok(app.ctx.document.body.classList.contains('tour-open'));
  assert.equal(app.el('tour-part').textContent, 'Setup');
  assert.equal(app.el('tour-text').textContent, 'Pick where to add from: YouTube, X or Substack.');
  assert.equal(app.el('tour-count').textContent, '1 of 4');
  assert.equal(app.el('tour-main').textContent, 'Next');
  assert.deepEqual(rec(app), { at: 'setup', card: 'tabs', replay: false });
  const starts = named(app, puts, 'tour_start');
  assert.equal(starts.length, 1, 'tour_start is buffered exactly once');
  assert.equal(starts[0].props.replay, false);
});

test('[TASK-092] A2a signed out, the tour is not even wired (criterion 2)', async () => {
  const { app, puts } = rig({ signedIn: false, store: { focus_tour: JSON.stringify(at('tabs')) } });
  await boot(app);
  assert.deepEqual(app.visibleViews(), ['view-landing']);
  assert.ok(!shown(app, 'tour'), 'never shown on the sign-in wall, even with a record saying a card is up');
  assert.equal(click(app, 'tour-main'), 0, 'the card controls are connected to nothing');
  assert.equal(click(app, 'tour-close'), 0);
  assert.equal(click(app, 'btn-drawer-tour'), 0, 'and neither is the replay row');
  assert.equal(named(app, puts, 'tour_start').length, 0);
});

for (const [id, label, opts] of [
  ['A2b', 'the boot read failed', { stateGet: 'fails' }],
  ['A2c', 'the boot read was refused (a signed-in boot answered by the device)', { stateGet: 'device' }],
  ['A2d', 'the store is damaged', { store: { focus_channels: '' } }],
  ['A2e', 'a channel exists', { store: { focus_channels: JSON.stringify([YT_CHANNEL]) } }],
  ['A2f', 'an archived item exists', { store: { focus_archive: JSON.stringify([{ id: 'a1', videoId: 'a1', title: 'Saved', published: ago(60_000), source: 'youtube' }]) } }],
  ['A2g', 'this device already holds a record', { store: { focus_tour: JSON.stringify({ at: 'done' }) } }],
]) {
  test(`[TASK-092] ${id} does not start when ${label} (criterion 2)`, async () => {
    const { app, puts } = rig(opts);
    await boot(app);
    assert.ok(!shown(app, 'tour'), 'no card');
    assert.equal(named(app, puts, 'tour_start').length, 0, 'no tour_start');
    if (!opts.store?.focus_tour) assert.equal(app.get('focus_tour'), null, 'and no record written');
    assert.equal(click(app, 'btn-drawer-tour'), 1, 'guard: this is a signed-in document, so the tour IS wired');
  });
}

test('[TASK-092] A3 Next and Back move through the setup cards; Back is disabled on card 1 (criterion 3)', async () => {
  const { app } = rig();
  await boot(app);
  assert.equal(app.el('tour-back').disabled, true, 'Back is disabled on the first card');
  click(app, 'tour-main');
  assert.equal(card(app), 'add');
  assert.equal(app.el('tour-count').textContent, '2 of 4');
  assert.equal(app.el('tour-back').disabled, false);
  assert.equal(app.el('tour-ring').dataset.target, 'add');
  click(app, 'tour-back');
  assert.equal(card(app), 'tabs');
  click(app, 'tour-back');
  assert.equal(card(app), 'tabs', 'Back on card 1 stays on card 1');
  click(app, 'tour-main'); click(app, 'tour-main'); click(app, 'tour-main');
  assert.equal(card(app), 'wait');
  assert.equal(app.el('tour-main').textContent, 'OK');
  assert.equal(app.el('tour-ring').dataset.target, '', 'card 4 points at nothing');
  click(app, 'tour-back');
  assert.equal(card(app), 'import');
  assert.equal(rec(app).card, 'import', 'each move is saved, so a navigation resumes the same card');
});

// Close and Escape, on a card of each part — the only way the dim can come down is one of these.
const ON_EACH_PART = [
  ['setup', {}, 'tabs'],
  ['tip', { store: { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'setup', focus_tour: JSON.stringify({ at: 'tip', replay: false }) } }, 'tip'],
  ['feed', { store: { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'feed', card: 'archive', replay: false }) } }, 'archive'],
];
for (const [part, opts, expected] of ON_EACH_PART) {
  test(`[TASK-092] A4 Close on the ${part} part ends the tour and leaves nothing dimmed (criterion 4)`, async () => {
    const { app, puts } = rig(opts);
    await boot(app);
    assert.equal(card(app), expected, 'guard: the card is up before Close');
    click(app, 'tour-close');
    assert.deepEqual(rec(app), { at: 'done' });
    assertNoDim(app, `after Close on ${part}`);
    const closes = named(app, puts, 'tour_close');
    assert.equal(closes.length, 1);
    assert.equal(closes[0].props.part, part);
    assert.equal(closes[0].props.card, expected);
  });

  test(`[TASK-092] A5 Escape on the ${part} part ends the tour the same way (criterion 4)`, async () => {
    const { app, puts } = rig(opts);
    await boot(app);
    assert.equal(card(app), expected, 'guard: the card is up before Escape');
    assert.ok(app.fireDocument('keydown', { key: 'Escape', preventDefault() {} }) > 0, 'guard: a keydown listener exists');
    assert.deepEqual(rec(app), { at: 'done' });
    assertNoDim(app, `after Escape on ${part}`);
    assert.equal(named(app, puts, 'tour_close').length, 1);
  });
}

// Stopped by TWO guards at once — the keydown handler's "is a card up" and tourStep's "is anything
// showing" — so this pins the behaviour and neither guard alone (author battery, T4 and D4). Each is
// pinned on its own by P10 and A15b.
test('[TASK-092] A5b Escape while the tour is waiting changes nothing (criterion 4)', async () => {
  const { app, puts } = rig({ store: { focus_tour: JSON.stringify({ at: 'wait-channel', replay: false }) } });
  await boot(app);
  app.fireDocument('keydown', { key: 'Escape', preventDefault() {} });
  assert.deepEqual(rec(app), { at: 'wait-channel', replay: false }, 'nothing is showing, so there is nothing to close');
  assert.equal(named(app, puts, 'tour_close').length, 0);
});

test('[TASK-092] A6 OK on card 4 lifts the dim and waits silently, across a reload (criterion 5, amendment 5)', async () => {
  const { app } = rig();
  await boot(app);
  click(app, 'tour-main'); click(app, 'tour-main'); click(app, 'tour-main');
  assert.equal(card(app), 'wait', 'guard');
  const toastsBefore = app.toasts.length;
  click(app, 'tour-main');
  assertNoDim(app, 'OK on card 4 lifts the backdrop so the channel can be added');
  assert.deepEqual(rec(app), { at: 'wait-channel', replay: false });
  await drain(app);
  assert.equal(app.toasts.length, toastsBefore, 'nothing announces the wait');
  assert.ok(shown(app, 'view-setup'), 'setup works normally underneath');

  const again = reload(app);
  await boot(again.app);
  assert.ok(!shown(again.app, 'tour'), 'a reload shows no card');
  assert.deepEqual(rec(again.app), { at: 'wait-channel', replay: false }, 'and keeps waiting');
  assert.equal(again.app.toasts.length, 0, 'and still says nothing');
});

test('[TASK-092] A7 the first channel added by the form while waiting raises the "Open my feed" tip (criterion 6)', async () => {
  const { app } = rig({ store: { focus_tour: JSON.stringify({ at: 'wait-channel', replay: false }) } });
  await boot(app);
  await addChannelByForm(app);
  assert.ok(shown(app, 'btn-go'), 'guard: the channel landed and Open my feed appeared');
  assert.equal(card(app), 'tip');
  assert.equal(app.el('tour-ring').dataset.target, 'go');
  assert.equal(app.el('tour-count').textContent, '');
  assert.equal(app.el('tour-back').disabled, true, 'the tip is the first card of its part');
  assert.equal(app.el('tour-main').textContent, 'OK');
  assert.deepEqual(rec(app), { at: 'tip', replay: false });
});

test('[TASK-092] A7b a channel added from inside card 2 ends the setup cards early (criterion 6)', async () => {
  const { app } = rig();
  await boot(app);
  click(app, 'tour-main');
  assert.equal(card(app), 'add', 'guard');
  app.el('input-url').value = 'New Channel';
  await app.ctx.handleAddChannel();
  assert.ok(app.el('add-form').classList.contains('hidden'), 'guard: Add swapped the form for the confirm panel');
  assert.equal(app.el('tour-ring').dataset.target, 'add', 'still on the add step');
  // WHICH element the highlight is on — the form or the confirm panel — is A7c's to pin. The first
  // version of this test fired a document click here and called that "the re-draw after the form is
  // hidden"; a resolve slower than that click's timers made the comment false, and `data-target` is the
  // card's key, which cannot tell the two apart (review round 1, MED-2/MED-3).
  click(app, 'btn-confirm-add');
  assert.equal(card(app), 'tip');
});

test('[TASK-092] A8 the first channel brought in by Import while waiting raises the tip after the picker closes (criterion 6)', async () => {
  const { app } = rig({ search: '?import=youtube', store: { focus_tour: JSON.stringify({ at: 'wait-channel', replay: false }) } });
  await boot(app);
  assert.ok(app.el('import-modal').classList.contains('open'), 'guard: the picker is open');
  // Not a suspension check: the record is only waiting, so there is nothing to draw either way
  // (author battery H10). A8b is the one that pins a card being held back by the picker.
  assert.ok(!shown(app, 'tour'), 'guard: waiting, so no card');
  const row = app.el('import-list').children[0];
  assert.equal(app.click(row), 1, 'guard: the imported row is selectable');
  click(app, 'import-add');
  assert.ok(!app.el('import-modal').classList.contains('open'), 'guard: the picker closed');
  assert.equal(card(app), 'tip');
  assert.equal(app.el('tour-ring').dataset.target, 'go');
});

test('[TASK-092] A8b the YouTube import round-trip resumes the card it left, after the picker (Risk 4, criterion 10)', async () => {
  const { app } = rig({ search: '?import=youtube', store: { focus_tour: JSON.stringify(at('import')) } });
  await boot(app);
  assert.ok(app.el('import-modal').classList.contains('open'), 'guard: back from Google with the picker open');
  assert.ok(!shown(app, 'tour'), 'the tour waits while the picker is open');
  click(app, 'import-cancel');
  assert.equal(card(app), 'import', 'and returns to the same card when it closes');
});

test('[TASK-092] A9 a channel added after the tour finished raises nothing (criterion 6)', async () => {
  const { app } = rig({ store: { focus_tour: JSON.stringify({ at: 'done' }) } });
  await boot(app);
  await addChannelByForm(app);
  assert.ok(shown(app, 'btn-go'), 'guard: the channel landed');
  assert.ok(!shown(app, 'tour'));
  assert.deepEqual(rec(app), { at: 'done' });
});

const AT_TIP = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'setup', focus_tour: JSON.stringify({ at: 'tip', replay: false }) };

test('[TASK-092] A10 OK on the tip lifts the dim and waits for the feed (criterion 7)', async () => {
  const { app } = rig({ store: AT_TIP });
  await boot(app);
  assert.equal(card(app), 'tip', 'guard');
  click(app, 'tour-main');
  assertNoDim(app, 'OK on the tip lifts the backdrop so more channels can be added');
  assert.deepEqual(rec(app), { at: 'wait-feed', replay: false });
  assert.deepEqual(app.visibleViews(), ['view-setup'], 'OK does not open the feed');
});

test('[TASK-092] A11 tapping Open my feed opens it; the feed part starts only once it has rendered, and never again (criteria 7, 8)', async () => {
  const { app } = rig({ store: AT_TIP });
  await boot(app);
  const opening = app.el('btn-go').onclick();
  assert.deepEqual(app.visibleViews(), ['view-feed'], 'the tap opens the feed');
  assert.deepEqual(rec(app), { at: 'wait-feed', replay: false });
  assert.ok(!shown(app, 'tour'), 'nothing is drawn while the feed is loading');
  await opening;
  await drain(app);
  assert.equal(card(app), 'done');
  assert.equal(app.el('tour-ring').dataset.target, 'done', 'Done is highlighted on a real post');
  assert.equal(app.el('tour-count').textContent, '1 of 4', 'no X account, so no topics card');
  assert.equal(app.el('tour-back').disabled, true, 'Back never reaches back across opening the feed');
  click(app, 'tour-main');
  assert.equal(card(app), 'archive');

  app.ctx.renderFeedResults(await app.ctx.loadFeed());
  await drain(app);
  assert.equal(card(app), 'archive', 'a refresh does not restart the feed part');
  click(app, 'tour-main');
  assert.equal(card(app), 'gear', 'topics skipped');
  assert.equal(app.el('tour-ring').dataset.target, 'gear');
});

test('[TASK-092] A12 a total load failure does not start the feed part; the next load that works does (criterion 8)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'wait-feed', replay: false }) };
  const { app, setFeed } = rig({ store, feed: 'fails' });
  await boot(app);
  assert.ok(!app.el('feed-error').classList.contains('hidden'), 'guard: this boot shows the load error');
  assert.ok(!shown(app, 'tour'), 'the tour never talks over an error');
  assert.deepEqual(rec(app), { at: 'wait-feed', replay: false });
  setFeed('posts');
  app.ctx.renderFeedResults(await app.ctx.loadFeed());
  await drain(app);
  assert.equal(card(app), 'done');
});

// A13 and A14 asserted the opposite until amendment 11 (Asli's handset walk, 2026-09-15: "A"): an empty first feed used
// to start the feed part with Done and Archive centred over "You're all caught up". Rewritten for the new requirement.
test('[TASK-092] A13 a caught-up first feed keeps waiting, silently; the first load with a post starts Done on it (criterion 8, amendment 11)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'wait-feed', replay: false }) };
  const { app, puts, setFeed } = rig({ store, feed: 'empty' });
  await boot(app);
  assert.ok(!app.el('caughtup').classList.contains('hidden'), 'guard: the caught-up screen');
  assertNoDim(app, 'no card over "You\'re all caught up"');
  assert.deepEqual(rec(app), { at: 'wait-feed', replay: false }, 'the tour is still waiting for a feed with a post');
  app.ctx.renderFeedResults(await app.ctx.loadFeed());   // a refresh that is still empty
  await drain(app);
  assert.ok(!shown(app, 'tour'), 'nor after a second empty render');
  setFeed('posts');
  app.ctx.renderFeedResults(await app.ctx.loadFeed());
  await drain(app);
  assert.equal(card(app), 'done', 'the first render with a post starts the feed part');
  assert.equal(app.el('tour-ring').dataset.target, 'done', 'with Done pointed at a real post');
  assert.equal(named(app, puts, 'tour_finish').length + named(app, puts, 'tour_close').length, 0, 'guard: nothing ended the run');
});

test('[TASK-092] A14 a first feed showing only the X-unavailable note keeps waiting too (amendment 11, superseding amendment 2)', async () => {
  const store = { focus_channels: JSON.stringify([X_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'wait-feed', replay: false }) };
  const { app } = rig({ store, feed: 'x-quota' });
  await boot(app);
  assert.ok(!app.el('feed-note').classList.contains('hidden'), 'guard: the X-unavailable note is showing');
  assertNoDim(app, 'no card over the note');
  assert.deepEqual(rec(app), { at: 'wait-feed', replay: false });
});

test('[TASK-092] A14b once the feed part has started, a feed emptied under it shows Done centred, with no highlight (criterion 9, amendment 11)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'feed', card: 'done', replay: false }) };
  const { app, setFeed } = rig({ store });
  await boot(app);
  assert.equal(app.el('tour-ring').dataset.target, 'done', 'guard: Done on a post');
  setFeed('empty');                                        // e.g. the reader cleared the last post
  app.ctx.renderFeedResults(await app.ctx.loadFeed());
  await drain(app);
  assert.ok(!app.el('caughtup').classList.contains('hidden'), 'guard: caught up now');
  assert.equal(card(app), 'done', 'the run carries on');
  assert.equal(app.el('tour-ring').dataset.target, '', 'centred, pointing at nothing');
  assert.ok(shown(app, 'tour-block-top'), 'the whole screen still takes no taps');
  click(app, 'tour-main');
  assert.equal(card(app), 'archive');
  assert.equal(app.el('tour-ring').dataset.target, '');
  click(app, 'tour-main');
  assert.equal(app.el('tour-ring').dataset.target, 'gear', 'the gear is highlighted as usual');
});

test('[TASK-092] A15 the Settings drawer suspends the tour and closing it brings back the same card (criterion 10)', async () => {
  const { app } = rig();
  await boot(app);
  click(app, 'tour-main');
  assert.equal(card(app), 'add', 'guard');
  click(app, 'profile-btn');
  assert.ok(app.el('profile-panel').classList.contains('open'), 'guard: the drawer opened');
  assertNoDim(app, 'the drawer is open');
  click(app, 'profile-close');
  assert.equal(card(app), 'add');
});

test('[TASK-092] A16 replay runs whatever the record says, from the drawer, as a replay (criterion 11)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'done' }) };
  const { app, puts } = rig({ store });
  await boot(app);
  assert.ok(!shown(app, 'tour'), 'guard: finished');
  click(app, 'btn-feed-manage');
  assert.equal(click(app, 'btn-drawer-tour'), 1, 'guard: the replay row is wired');
  assert.ok(!app.el('profile-panel').classList.contains('open'), 'it closes the drawer');
  assert.deepEqual(app.visibleViews(), ['view-setup'], 'shows setup');
  assert.equal(card(app), 'tabs', 'from card 1');
  assert.equal(app.el('tour-count').textContent, '1 of 3', 'card 4 is skipped with a channel present');
  const starts = named(app, puts, 'tour_start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].props.replay, true);
  click(app, 'tour-main'); click(app, 'tour-main'); click(app, 'tour-main');
  assert.equal(card(app), 'tip', 'the tip follows card 3');
});

test('[TASK-092] A16b replay with only an archived item also skips card 4 (amendment 3)', async () => {
  const store = { focus_archive: JSON.stringify([{ id: 'a1', videoId: 'a1', title: 'Saved', published: ago(60_000), source: 'youtube' }]), focus_tour: JSON.stringify({ at: 'done' }) };
  const { app } = rig({ store });
  await boot(app);
  click(app, 'btn-feed-manage');
  click(app, 'btn-drawer-tour');
  assert.equal(app.el('tour-count').textContent, '1 of 3');
});

test('[TASK-092] A17 no tour action sends state, and the record is not part of synced state (criterion 12)', async () => {
  const { app, puts } = rig();
  await boot(app);
  const putsBefore = puts.length;
  const before = statePuts(puts).length;
  assert.equal(app.get('focus_dirty'), null, 'guard: the boot left nothing un-pushed');
  click(app, 'tour-main');
  click(app, 'tour-back');
  click(app, 'tour-close');
  click(app, 'profile-btn');
  click(app, 'btn-drawer-tour');
  click(app, 'tour-main'); click(app, 'tour-main'); click(app, 'tour-main');
  click(app, 'tour-main');
  await drain(app);
  const sent = puts.slice(putsBefore).flatMap((p) => p.events || []).map((e) => e.name);
  assert.ok(sent.includes('tour_start') && sent.includes('tour_close'),
    `guard: the TOUR events rode a PUT, so the tour's own pushes were observable — sent ${JSON.stringify(sent)}`);
  assert.equal(statePuts(puts).length, before, 'but none of them carried state');
  assert.equal(app.get('focus_dirty'), null, 'and nothing was marked un-pushed');
  const synced = JSON.stringify(app.ctx.collectSyncedState());
  assert.ok(!/tour/.test(synced) && !Object.keys(app.ctx.collectSyncedState()).some((k) => /tour/.test(k)),
    'the record is device-local');
});

test('[TASK-092] A18 a reload mid-run resumes the same card without a second tour_start (criterion 13)', async () => {
  const first = rig();
  await boot(first.app);
  click(first.app, 'tour-main');
  await drain(first.app);
  const second = reload(first.app);
  await boot(second.app);
  assert.equal(card(second.app), 'add', 'the same card');
  // The first document's BUFFER is not counted: whatever it still held was copied into the second
  // document's storage by the reload, and is counted there.
  const total = first.puts.flatMap((p) => p.events || []).filter((e) => e.name === 'tour_start').length
    + second.puts.flatMap((p) => p.events || []).filter((e) => e.name === 'tour_start').length
    + JSON.parse(second.app.get('focus_events') || '[]').filter((e) => e.name === 'tour_start').length;
  assert.equal(total, 1);
});

test('[TASK-092] A19 finishing the feed part records tour_finish (criterion 13)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'feed', card: 'end', replay: false }) };
  const { app, puts } = rig({ store });
  await boot(app);
  assert.equal(card(app), 'end', 'guard');
  assert.equal(app.el('tour-main').textContent, 'Done');
  click(app, 'tour-main');
  assert.deepEqual(rec(app), { at: 'done' });
  assertNoDim(app, 'after Done on the last card');
  assert.equal(named(app, puts, 'tour_finish').length, 1);
});

test('[TASK-092] A20 focus moves to the card and comes back where it was when the tour ends (criterion 14)', async () => {
  const { app } = rig({ store: { focus_tour: JSON.stringify({ at: 'wait-channel', replay: false }) } });
  await boot(app);
  const input = app.el('input-url');
  input.focus();
  await addChannelByForm(app);
  assert.equal(card(app), 'tip', 'guard');
  // Compared by id, not by reference: a failed reference comparison between vm-realm stubs reports as
  // a test-code failure rather than an assertion, which a battery then has to second-guess.
  const doc = app.ctx.document;
  assert.equal(doc.activeElement.id, 'tour-main', 'focus is on the card\'s main button');
  click(app, 'tour-close');
  assert.equal(doc.activeElement.id, input.id, 'and returns to the add box on close');
});

test('[TASK-092] A20b each new card takes focus (criterion 14)', async () => {
  const { app } = rig();
  await boot(app);
  const doc = app.ctx.document;
  assert.equal(doc.activeElement.id, 'tour-main');
  app.el('input-url').focus();
  click(app, 'tour-main');
  assert.equal(doc.activeElement.id, 'tour-main', 'Next moves focus onto the new card');
});

test('[TASK-092] A20c a re-draw while a card is up does not forget where focus came from (criterion 14)', async () => {
  // Battery F3. The card is re-placed on every resize, scroll and tap — and each of those runs while
  // focus sits on the card's own button. Recapturing "where focus was" on a re-draw stores that button,
  // so closing would hand focus to an element inside the layer being hidden.
  const { app } = rig({ store: { focus_tour: JSON.stringify({ at: 'wait-channel', replay: false }) } });
  await boot(app);
  app.el('input-url').focus();
  await addChannelByForm(app);
  assert.equal(card(app), 'tip', 'guard');
  assert.ok(app.fireWindow('resize') > 0, 'guard: something re-places the card on resize');
  app.runTimers();
  assert.equal(app.ctx.document.activeElement.id, 'tour-main', 'guard: the re-draw ran with focus on the card');
  click(app, 'tour-close');
  assert.equal(app.ctx.document.activeElement.id, 'input-url');
});

test('[TASK-092] A15b Escape with the drawer open closes the drawer, not the tour behind it (criteria 4, 10)', async () => {
  // Battery D4. Sized so ONLY the keydown handler's "is a card up" guard can stop it: the record is on
  // a setup card, which tourStep would happily close.
  const { app } = rig();
  await boot(app);
  click(app, 'tour-main');
  click(app, 'profile-btn');
  assert.ok(app.el('profile-panel').classList.contains('open'), 'guard: the drawer is open over the tour');
  app.fireDocument('keydown', { key: 'Escape', preventDefault() {} });
  assert.ok(!app.el('profile-panel').classList.contains('open'), 'guard: Escape closed the drawer');
  assert.deepEqual(rec(app), { at: 'setup', card: 'add', replay: false }, 'the tour was not closed');
  assert.equal(card(app), 'add', 'and its card is back');
});

const FEED_AT = (card) => ({
  focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed',
  focus_tour: JSON.stringify({ at: 'feed', card, replay: false }),
});

test('[TASK-092] A22 leaving the feed by the drawer\'s Manage channels takes the feed card down (criterion 10)', async () => {
  // Battery H13. The only tour-free route off a screen while its dim is up: the gear card's highlight
  // takes the tap, the drawer suspends the card, and "Manage channels" closes the drawer — which
  // resumes the card on the feed — then shows setup. Only showView's redraw takes it back down.
  const { app } = rig({ store: FEED_AT('gear') });
  await boot(app);
  assert.equal(card(app), 'gear', 'guard');
  click(app, 'btn-feed-manage');
  click(app, 'btn-drawer-manage');
  assert.deepEqual(app.visibleViews(), ['view-setup'], 'guard: on setup now');
  assert.ok(!shown(app, 'tour'), 'no feed card over the setup screen');
  assert.deepEqual(rec(app), { at: 'feed', card: 'gear', replay: false }, 'and the run is kept for the feed');
});

test('[TASK-092] A23 reopening the feed mid-part draws no card while it loads (criterion 8)', async () => {
  // Battery H7. A feed render earlier in this document must not count for the NEXT load.
  const { app, holdFeed } = rig({ store: FEED_AT('gear') });
  await boot(app);
  click(app, 'btn-feed-manage');
  click(app, 'btn-drawer-manage');
  const release = holdFeed();
  const opening = app.el('btn-go').onclick();
  assert.deepEqual(app.visibleViews(), ['view-feed'], 'guard: the feed is open');
  assert.ok(app.el('feed-loading').style.display !== 'none', 'guard: and loading');
  assert.ok(!shown(app, 'tour'), 'no card over the loading screen');
  release();
  await opening;
  await drain(app);
  assert.equal(card(app), 'gear', 'the card comes back once the feed has rendered');
});

test('[TASK-092] A24 a reload mid-feed-part draws no card until this boot\'s feed has rendered (criterion 8)', async () => {
  // Battery H8. Every other test lets the load finish before looking.
  const { app, holdFeed } = rig({ store: FEED_AT('archive') });
  const release = holdFeed();
  const booting = app.ctx.init();
  for (let i = 0; i < 20 && !app.urls().some((u) => u.includes('/api/feed')); i++) await settle();
  assert.ok(app.urls().some((u) => u.includes('/api/feed')), 'guard: the boot is waiting on the feed');
  assert.deepEqual(app.visibleViews(), ['view-feed'], 'guard: on the feed');
  assert.ok(!shown(app, 'tour'), 'no card while it loads');
  release();
  await booting;
  await drain(app);
  assert.equal(card(app), 'archive');
});

test('[TASK-092] A13b a caught-up render after one with posts does not point Done at a stale card (criterion 9)', async () => {
  // Battery P1. The caught-up screen hides #feed but leaves the previous render's cards in it.
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'done' }) };
  const { app, setFeed } = rig({ store });
  await boot(app);
  assert.ok(app.queryAll('#feed .card').length > 0, 'guard: this document rendered posts');
  // A replay already on its Done card. Until amendment 11 this seeded the wait, which an empty render no longer
  // starts; the stale-card hazard this test pins only exists once the feed part is running.
  app.set('focus_tour', JSON.stringify({ at: 'feed', card: 'done', replay: true }));
  setFeed('empty');
  app.ctx.renderFeedResults(await app.ctx.loadFeed());
  await drain(app);
  assert.ok(app.queryAll('#feed .card').length > 0, 'guard: the old cards are still in the hidden #feed');
  assert.equal(card(app), 'done');
  assert.equal(app.el('tour-ring').dataset.target, '', 'Done is centred, not pointed at a card nobody can see');
});

test('[TASK-092] A21 a refused storage read at boot leaves no dim and a usable app (criterion 15)', async () => {
  const { app } = rig();
  app.failGetItem((k) => k === 'focus_tour');
  // An ASSERTION that the boot resolves, not a bare await: without tourBoot's guard the refused read rejects
  // init, and a bare await turns that into a crash rather than a failed claim (independent battery, crit. 15).
  await assert.doesNotReject(app.ctx.init(), 'a refused tour read must not reject the boot');
  await drain(app);
  assert.deepEqual(app.visibleViews(), ['view-setup'], 'the app still boots');
  assertNoDim(app, 'the record could not be read');
  app.failGetItem(null);
  await addChannelByForm(app);
  assert.ok(shown(app, 'btn-go'), 'and adding a channel still works');
});

test('[TASK-092] A21b a throw mid-tour tears the whole layer down (criterion 15)', async () => {
  const { app } = rig();
  await boot(app);
  assert.equal(card(app), 'tabs', 'guard');
  app.failSetItem((k) => k === 'focus_tour');
  click(app, 'tour-main');
  assertNoDim(app, 'the record could not be written');
  app.fireDocument('keydown', { key: 'Escape', preventDefault() {} });
  // `app.click` runs only the button's own listeners, so this is the no-capture-listener case. The browser's
  // order — the document's capture listener first, scheduling a re-draw — is A21c's (review round 1, HIGH-1).
  assertNoDim(app, 'and Escape afterwards does not bring it back');
});

// ── Review round 1 (independent claims review of 01ac516) ───────────────────────────────────────

for (const [label, id, before] of [
  ['Close', 'tour-close', 0],
  ['Next', 'tour-main', 0],
  ['Back', 'tour-back', 1],
]) {
  test(`[TASK-092] A21c a refused save on ${label}, with the tap's own re-draw, leaves no dim for good (Risk 1, review HIGH-1)`, async () => {
    // In a browser the document's capture-phase click listener runs BEFORE the button's handler and
    // schedules a re-draw. When the handler's save then throws, the teardown ran — but the record on
    // disk still says a card is up, so that scheduled re-draw put the card back, on every tap.
    // `app.click` fires only the element's own listeners, which is how A21b stayed green over this.
    const { app } = rig();
    await boot(app);
    for (let i = 0; i < before; i++) click(app, 'tour-main');
    assert.ok(shown(app, 'tour'), 'guard: a card is up');
    app.failSetItem((k) => k === 'focus_tour');
    assert.ok(app.fireDocument('click', {}) > 0, 'guard: the capture-phase listener exists and ran first');
    click(app, id);
    app.runTimers();
    assertNoDim(app, `after a refused save on ${label}`);
    app.ctx.showView('view-setup');
    app.fireWindow('resize');
    app.runTimers();
    assertNoDim(app, 'and nothing later in this document redraws it');
    // One more, so the count is odd: a guard that only takes down a card already UP would draw on one re-draw and
    // take it down on the next, and every even count above would still read no dim (review round 2, MED-A).
    app.ctx.showView('view-setup');
    assertNoDim(app, 'after an odd number of re-draws too');
    app.failSetItem(null);
    click(app, 'profile-btn');
    click(app, 'btn-drawer-tour');
    assert.equal(card(app), 'tabs', 'an explicit replay from Settings still tries again');
  });
}

test('[TASK-092] A2h does not start when the boot\'s pull-down of an existing row fails (Risk 2, review MED-1)', async () => {
  // The read answered, so the boot read "succeeded" — but the adopt rolled back (storage refused one
  // key), leaving local empty for an account whose row holds a channel.
  const { app, puts } = rig({ stateGet: 'row' });
  app.failSetItem((k) => k === 'focus_done');
  await boot(app);
  app.failSetItem(null);
  assert.equal(app.get('focus_channels'), null, 'guard: the adopt rolled back, so local looks like a new account');
  assert.ok(!shown(app, 'tour'), 'no new-user tour for an account that has a channel');
  assert.equal(named(app, puts, 'tour_start').length, 0);
  assert.equal(app.get('focus_tour'), null);
});

test('[TASK-092] A7c the add step\'s highlight moves to the confirm panel as it opens, and back on Cancel — no tap needed (Risk 3, review MED-2)', async () => {
  const { app } = rig();
  box(app.el('add-form'), 200);
  box(app.el('add-confirm'), 500, 16, 300, 260);
  await boot(app);
  click(app, 'tour-main');
  assert.equal(ringOn(app), 200, 'card 2 rings the add box');
  app.el('input-url').value = 'New Channel';
  await app.ctx.handleAddChannel();   // what both the Add button and Enter call
  assert.equal(ringOn(app), 500, 'the confirm panel is inside the cut-out the moment it shows');
  click(app, 'btn-confirm-cancel');
  assert.equal(ringOn(app), 200, 'and the add box again after Cancel');
});

test('[TASK-092] A26a each setup card rings its own control (criteria 1, 7; review MED-3)', async () => {
  const { app } = rig();
  box(app.el('source-toggle'), 120);
  box(app.el('add-form'), 200);
  box(app.el('btn-connect-youtube'), 260);
  box(app.el('btn-add'), 330);
  box(app.el('btn-go'), 700);
  await boot(app);
  assert.equal(ringOn(app), 120, 'card 1: the source tabs');
  click(app, 'tour-main');
  assert.equal(ringOn(app), 200, 'card 2: the add box');
  click(app, 'tour-main');
  assert.equal(ringOn(app), 260, 'card 3: Import');
  click(app, 'tour-main');
  click(app, 'tour-main');   // OK on card 4
  await addChannelByForm(app);
  assert.equal(card(app), 'tip', 'guard');
  assert.equal(ringOn(app), 700, 'the tip: Open my feed, not the Add button');
});

test('[TASK-092] A26b each feed card rings its own control, on the first post that is actually in the stream (criterion 9; review MED-3)', async () => {
  const { app } = rig({ store: FEED_AT('done') });
  box(app.el('btn-feed-manage'), 40, 330, 36, 36);
  box(app.el('toggle-grouping'), 44, 200, 60, 28);
  await boot(app);
  const cards = app.queryAll('#feed .card');
  assert.ok(cards.length >= 2, 'guard: two posts rendered');
  box(cards[0].querySelector('.btn-done'), 300);
  box(cards[0].querySelector('.btn-archive'), 310);
  box(cards[1].querySelector('.btn-done'), 600);
  app.fireWindow('resize');
  app.runTimers();
  assert.equal(ringOn(app), 300, 'Done on the first post');
  cards[0].classList.add('grouping-pending');   // held hidden while a classify runs
  app.fireWindow('resize');
  app.runTimers();
  assert.equal(ringOn(app), 600, 'a post held hidden is not in the stream, so the next one is used');
  cards[0].classList.remove('grouping-pending');
  cards[0].classList.add('grouped-out');         // lifted into a topic — independent battery T35b
  app.fireWindow('resize');
  app.runTimers();
  assert.equal(ringOn(app), 600, 'nor is a post lifted into a topic');
  cards[0].classList.remove('grouped-out');
  app.fireWindow('resize');
  app.runTimers();
  click(app, 'tour-main');
  assert.equal(ringOn(app), 310, 'Archive on that post');
  click(app, 'tour-main');
  assert.equal(card(app), 'gear', 'guard: no X account, no topics card');
  assert.equal(ringOn(app), 40, 'the Settings gear');
});

test('[TASK-092] A26c the topics card rings the topics switch, not the gear beside it (criterion 9; review MED-3)', async () => {
  const store = { focus_channels: JSON.stringify([X_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'feed', card: 'topics', replay: false }) };
  const { app } = rig({ store, feed: 'x-quota' });
  box(app.el('btn-feed-manage'), 40, 330, 36, 36);
  box(app.el('toggle-grouping'), 44, 200, 60, 28);
  await boot(app);
  assert.equal(card(app), 'topics', 'guard');
  assert.equal(ringOn(app), 44);
});

test('[TASK-092] A8c back from Google, no card is drawn while the subscriptions load (review L5)', async () => {
  const { app, holdImport } = rig({ search: '?import=youtube', store: { focus_tour: JSON.stringify(at('import')) } });
  const release = holdImport();
  const booting = app.ctx.init();
  for (let i = 0; i < 30 && !app.urls().some((u) => u.includes('/api/connect/youtube/result')); i++) await settle();
  assert.ok(app.urls().some((u) => u.includes('/api/connect/youtube/result')), 'guard: waiting on the import result');
  assert.ok(!shown(app, 'tour'), 'no card while the picker is still on its way');
  release();
  await booting;
  await drain(app);
  assert.ok(app.el('import-modal').classList.contains('open'), 'guard: the picker opened');
  assert.ok(!shown(app, 'tour'));
  click(app, 'import-cancel');
  assert.equal(card(app), 'import', 'the card comes back once the picker closes');
});

test('[TASK-092] A15c opening the drawer mid-tour leaves focus in the drawer (criterion 14; review L3)', async () => {
  const { app } = rig();
  await boot(app);
  click(app, 'profile-btn');
  assert.equal(app.ctx.document.activeElement.id, 'profile-panel', 'the suspended card does not pull focus back behind the drawer');
});

test('[TASK-092] A20d after a drawer round trip, closing the tour still returns focus to where it began (criterion 14; review L3)', async () => {
  const { app } = rig({ store: { focus_tour: JSON.stringify({ at: 'wait-channel', replay: false }) } });
  await boot(app);
  app.el('input-url').focus();
  await addChannelByForm(app);
  assert.equal(card(app), 'tip', 'guard');
  click(app, 'profile-btn');
  click(app, 'profile-close');
  assert.equal(card(app), 'tip', 'guard: the card is back');
  click(app, 'tour-close');
  assert.equal(app.ctx.document.activeElement.id, 'input-url');
});

test('[TASK-092] A16c replay on a feed-first boot leaves Open my feed working at the tip (criterion 11; review L4)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'done' }) };
  const { app } = rig({ store });
  await boot(app);
  click(app, 'btn-feed-manage');
  click(app, 'btn-drawer-tour');
  click(app, 'tour-main'); click(app, 'tour-main'); click(app, 'tour-main');
  assert.equal(card(app), 'tip', 'guard');
  assert.equal(typeof app.el('btn-go').onclick, 'function', 'the tip\'s button has a handler on a boot that never showed setup');
  assert.equal(click(app, 'btn-add'), 1, 'and setup\'s own controls are wired, so card 2 can actually add a channel (independent battery T51)');
  await app.el('btn-go').onclick();
  assert.deepEqual(app.visibleViews(), ['view-feed']);
});

test('[TASK-092] A25 a tour control missing from the page does not stop the rest of the app being wired (criterion 15; review L9)', async () => {
  const { app } = rig();
  const doc = app.ctx.document;
  const real = doc.getElementById;
  doc.getElementById = (id) => (id === 'tour-main' ? null : real(id));
  await assert.doesNotReject(app.ctx.init(), 'a broken tour control must not reject the boot');
  await drain(app);
  assert.deepEqual(app.visibleViews(), ['view-setup'], 'the app boots');
  assertNoDim(app, 'a broken tour fails to the plain app');
  assert.equal(click(app, 'btn-feed-manage'), 1, 'the feed gear is wired');
  assert.equal(click(app, 'btn-connect-youtube'), 1, 'Import is wired');
  assert.equal(click(app, 'import-add'), 1, 'the picker is wired');
});

// ── Independent battery, round 1 (blind battery of 01ac516) ─────────────────────────────────────

test('[TASK-092] A28 a re-draw while typing into card 2 does not pull focus out of the add box (Risk 3; independent T29)', async () => {
  // Every tap, scroll, resize and keyboard change re-draws the card. Only a NEW card may take focus;
  // re-drawing the same one while the reader types would make the add box it points at unusable.
  const { app } = rig();
  await boot(app);
  click(app, 'tour-main');
  assert.equal(card(app), 'add', 'guard');
  app.el('input-url').focus();
  app.fireWindow('resize');
  app.runTimers();
  app.ctx.setAddSource('youtube');   // a re-draw from the add flow itself
  assert.equal(app.ctx.document.activeElement.id, 'input-url');
});

test('[TASK-092] A29 placement: the four blockers frame the cut-out and the card sits below it when it fits (criterion 17 logic; independent T64, T65)', async () => {
  const { app } = rig();
  app.ctx.innerWidth = 390;
  app.ctx.innerHeight = 844;
  box(app.el('source-toggle'), 120, 16, 300, 40);
  app.el('tour-card').offsetHeight = 150;
  app.el('tour-card').offsetWidth = 290;
  await boot(app);
  const px = (id, prop) => parseFloat(app.el(id).style[prop]);
  // Cut-out: the control's box grown by 6px — x 10, y 114, w 312, h 52.
  assert.deepEqual([px('tour-ring', 'left'), px('tour-ring', 'top'), px('tour-ring', 'width'), px('tour-ring', 'height')], [10, 114, 312, 52]);
  assert.deepEqual([px('tour-block-top', 'top'), px('tour-block-top', 'height')], [0, 114], 'top blocker ends where the cut-out starts');
  assert.deepEqual([px('tour-block-bottom', 'top'), px('tour-block-bottom', 'height')], [166, 678], 'bottom blocker starts where it ends');
  assert.deepEqual([px('tour-block-left', 'left'), px('tour-block-left', 'width')], [0, 10], 'left blocker stops at its left edge');
  assert.deepEqual([px('tour-block-right', 'left'), px('tour-block-right', 'width')], [322, 68], 'right blocker starts at its right edge');
  assert.equal(app.el('tour-card').dataset.side, 'below');
  assert.equal(px('tour-card', 'top'), 180, '14px under the cut-out');
});

test('[TASK-092] A29b placement: a control too low for the card puts the card above it, and a scroll re-places (criterion 17 logic; independent T56, T65)', async () => {
  const { app } = rig();
  app.ctx.innerWidth = 390;
  app.ctx.innerHeight = 844;
  const tabs = box(app.el('source-toggle'), 760, 16, 300, 40);
  app.el('tour-card').offsetHeight = 150;
  app.el('tour-card').offsetWidth = 290;
  await boot(app);
  assert.equal(app.el('tour-card').dataset.side, 'above');
  assert.equal(parseFloat(app.el('tour-card').style.top), 754 - 14 - 150);
  box(tabs, 300, 16, 300, 40);
  assert.ok(app.fireWindow('scroll') > 0, 'guard: something listens for scroll');
  app.runTimers();
  assert.equal(ringOn(app), 300, 'the ring follows the control after a scroll');
  assert.equal(app.el('tour-card').dataset.side, 'below');
});

test('[TASK-092] A29c placement: with the keyboard open, fit is judged against what the reader can see (Risk 5; independent T66, T67)', async () => {
  const { app } = rig();
  app.ctx.innerWidth = 390;
  app.ctx.innerHeight = 844;
  app.ctx.visualViewport = { offsetTop: 200, height: 200, addEventListener() {} };
  box(app.el('source-toggle'), 250, 16, 300, 40);
  app.el('tour-card').offsetHeight = 120;
  app.el('tour-card').offsetWidth = 290;
  await boot(app);
  assert.equal(app.el('tour-card').dataset.side, 'above', 'the layout viewport has room below; the visible one does not');
  assert.equal(parseFloat(app.el('tour-card').style.top), 212, 'clamped to 12px inside the visible top, not the layout top');
});

test('[TASK-092] A29d a new card scrolls its control into view, and a re-draw of the same card does not (criterion 17 logic; independent T58)', async () => {
  const { app } = rig();
  let scrolled = 0;
  app.el('source-toggle').scrollIntoView = () => { scrolled++; };
  await boot(app);
  assert.equal(scrolled, 1, 'card 1 brought the tabs into view');
  app.fireWindow('resize');
  app.runTimers();
  assert.equal(scrolled, 1, 'a re-draw does not scroll again — that would fight the reader\'s own scrolling');
});

test('[TASK-092] A30 Tab stays inside a centred card: it cycles, wraps both ways and skips a disabled Back (criterion 14; independent T42–T44)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'feed', card: 'done', replay: false }) };   // the feed part already on Done: since amendment 11 an empty FIRST feed keeps waiting instead
  const { app } = rig({ store, feed: 'empty' });
  await boot(app);
  assert.equal(card(app), 'done', 'guard: the feed part on Done over an empty feed, centred, Back disabled');
  const doc = app.ctx.document;
  const tab = (shiftKey = false) => {
    let prevented = false;
    app.fireDocument('keydown', { key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
    assert.ok(prevented, 'the browser\'s own Tab is stopped');
    return doc.activeElement.id;
  };
  assert.equal(doc.activeElement.id, 'tour-main', 'guard');
  assert.equal(tab(), 'tour-close', 'Tab wraps from the last control to the first — the disabled Back is skipped');
  assert.equal(tab(), 'tour-main');
  assert.equal(tab(true), 'tour-close', 'Shift+Tab goes back');
  assert.equal(tab(true), 'tour-main', 'and wraps the other way');
  click(app, 'tour-main');
  assert.equal(doc.activeElement.id, 'tour-main', 'guard: card 2, Back now enabled');
  assert.equal(tab(), 'tour-back', 'an enabled Back joins the cycle');
  assert.ok(shown(app, 'tour'), 'and none of that tore the tour down');
});

test('[TASK-092] A31 switching the source tab mid-tour recounts the cards at once (amendment 1; independent T94)', async () => {
  const { app } = rig();
  await boot(app);
  assert.equal(app.el('tour-count').textContent, '1 of 4', 'guard');
  app.ctx.setAddSource('twitter');
  assert.equal(app.el('tour-count').textContent, '1 of 3', 'no Import card on the X tab');
  app.ctx.setAddSource('youtube');
  assert.equal(app.el('tour-count').textContent, '1 of 4');
});

test('[TASK-092] A32 a replay\'s close and finish are recorded as a replay (criterion 13; independent L35, L36, T13)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'done' }) };
  const { app, puts } = rig({ store });
  await boot(app);
  click(app, 'btn-feed-manage');
  click(app, 'btn-drawer-tour');
  click(app, 'tour-main');
  click(app, 'tour-close');
  const closes = named(app, puts, 'tour_close');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].props.replay, true, 'a Next along the way kept the replay flag');
  app.set('focus_tour', JSON.stringify({ at: 'feed', card: 'end', replay: true }));   // the same replay, later, on its last card
  app.ctx.showView('view-feed');   // the boot's render already happened in this document
  assert.equal(card(app), 'end', 'guard');
  click(app, 'tour-main');
  const finishes = named(app, puts, 'tour_finish');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].props.replay, true);
});

test('[TASK-092] A33 a setup card is never drawn over the feed, and a feed card never over setup (criterion 10; independent T22)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify(at('add')) };
  const { app } = rig({ store });
  await boot(app);
  assert.deepEqual(app.visibleViews(), ['view-feed'], 'guard: a record from setup, on the feed — e.g. left by another tab');
  assert.ok(!shown(app, 'tour'), 'the setup card waits for setup');
});

test('[TASK-092] A34 a second run returns focus to where IT began, not where the first one did (criterion 14; independent T27)', async () => {
  const { app } = rig({ store: { focus_tour: JSON.stringify({ at: 'wait-channel', replay: false }) } });
  await boot(app);
  app.el('input-url').focus();
  await addChannelByForm(app);
  click(app, 'tour-close');
  assert.equal(app.ctx.document.activeElement.id, 'input-url', 'guard: run 1 handed focus back');
  app.el('profile-btn').focus();
  click(app, 'profile-btn');
  click(app, 'btn-drawer-tour');
  assert.equal(card(app), 'tabs', 'guard: run 2 is up');
  click(app, 'tour-close');
  assert.equal(app.ctx.document.activeElement.id, 'profile-btn', 'run 2 began from the Settings gear');
});

test('[TASK-092] A35 tapping Done inside the cut-out moves the ring to the next post as the card slides out (criterion 9)', async () => {
  const { app } = rig({ store: FEED_AT('done') });
  await boot(app);
  const cards = app.queryAll('#feed .card');
  box(cards[0].querySelector('.btn-done'), 300);
  box(cards[1].querySelector('.btn-done'), 600);
  app.fireWindow('resize');
  app.runTimers();
  assert.equal(ringOn(app), 300, 'guard');
  app.fireDocument('click', {});                      // the capture listener runs first, as in a browser
  assert.ok(app.click(cards[0].querySelector('.btn-done')) > 0, 'guard: Done is wired');
  app.runTimers();
  assert.equal(ringOn(app), 600, 'the next post\'s Done, not the one that just left');
  assert.equal(card(app), 'done', 'the reader stays on the Done card');
});

test('[TASK-092] A36 replay from the middle of a run starts again from card 1 (criterion 11)', async () => {
  const { app, puts } = rig({ store: FEED_AT('gear') });
  await boot(app);
  assert.equal(card(app), 'gear', 'guard: mid-run');
  click(app, 'btn-feed-manage');
  click(app, 'btn-drawer-tour');
  assert.equal(card(app), 'tabs');
  assert.deepEqual(rec(app), { at: 'setup', card: 'tabs', replay: true });
  assert.equal(named(app, puts, 'tour_start').length, 1);
});

test('[TASK-092] A35b the ring re-places again once the slide-out has finished and the next post has moved up (criterion 9; independent T58)', async () => {
  const { app } = rig({ store: FEED_AT('done') });
  await boot(app);
  const cards = app.queryAll('#feed .card');
  box(cards[0].querySelector('.btn-done'), 300);
  const next = box(cards[1].querySelector('.btn-done'), 600);
  app.fireWindow('resize');
  app.advance(0);
  assert.equal(ringOn(app), 300, 'guard');
  app.fireDocument('click', {});
  app.click(cards[0].querySelector('.btn-done'));
  app.advance(0);
  assert.equal(ringOn(app), 600, 'the immediate re-draw skips the card that is sliding out');
  box(next, 300);                 // the slide-out (320ms) removes the card and the next post moves up
  app.advance(400);
  assert.equal(ringOn(app), 300, 'and the later re-draw follows it to where it now is');
});

test('[TASK-092] A37 sign-out clears the tour record (Risk 8; independent E8, X6)', async () => {
  const { app } = rig({ store: SIGNED_IN });
  assert.ok(app.get('focus_tour'), 'guard: the signed-in fixture really holds a tour record, so "cleared" can fail');
  await app.ctx.syncOnLoad();
  await app.ctx.signOut();
  assert.ok(app.navigations.length > 0 || app.get('focus_channels') === null, 'guard: the sign-out ran');
  assert.equal(app.get('focus_tour'), null, 'the next person on this browser gets their own tour');
});

// ── Review round 2 (blind claims review and independent battery of 095f4f5) ─────────────────────
// Each test below closes a survivor one of the two reviewers measured: the named mutation passed the whole
// suite. Where a test needs a DOM method the harness lacks (`matches`, `getClientRects`, a query honouring
// `:not(.hidden)`), it is stubbed here in the open, on the elements involved — the approach the independent
// battery's probes showed works, the way `box()` stubs a rect.

test('[TASK-092] A21d after a switch-off, one re-draw draws nothing, takes no focus and scrolls nothing (Risk 1; review round 2 MED-A, independent B07)', async () => {
  const { app } = rig();
  let scrolled = 0;
  await boot(app);
  click(app, 'tour-main');
  assert.equal(card(app), 'add', 'guard');
  app.el('add-form').scrollIntoView = () => { scrolled++; };
  app.failSetItem((k) => k === 'focus_tour');
  app.fireDocument('click', {});
  click(app, 'tour-close');
  app.runTimers();
  app.failSetItem(null);
  assertNoDim(app, 'guard: switched off');
  app.el('input-url').focus();
  app.ctx.setAddSource('youtube');   // ONE re-draw, from a tab tap: a guard honoured only while a card is up draws here
  assertNoDim(app, 'one re-draw after the switch-off');
  assert.equal(app.ctx.document.activeElement.id, 'input-url', 'the dead card did not take focus on its way past');
  assert.equal(scrolled, 0, 'and nothing scrolled toward a card nobody can see');
});

test('[TASK-092] A29e placement: on a scrolled page with the keyboard open, a card that fits below the control goes below (criterion 17 logic; independent C03)', async () => {
  const { app } = rig();
  app.ctx.innerWidth = 390;
  app.ctx.innerHeight = 844;
  app.ctx.visualViewport = { offsetTop: 300, height: 400, addEventListener() {} };   // the reader sees 300..700
  box(app.el('source-toggle'), 350, 16, 300, 40);
  app.el('tour-card').offsetHeight = 120;
  app.el('tour-card').offsetWidth = 290;
  await boot(app);
  // Cut-out 344..396; below needs 396 + 14 + 120 = 530, inside 700 - 12. Read as starting at 0, the
  // visible band ends at 400 and the card is sent above — then clamped onto its own control.
  assert.equal(app.el('tour-card').dataset.side, 'below');
  assert.equal(parseFloat(app.el('tour-card').style.top), 410);
});

// [BUG-124] Measured on Asli's iPhone (iOS 26.6.1 Safari, probes/bug-124-walk1-2026-09-26.log on the probe
// branch): opening the keyboard on card 2 scrolls the document 146px even under `body.tour-open`, and while it
// is scrolled a `position: fixed` element is drawn 146px ABOVE where `getBoundingClientRect` says the same
// coordinates are. The ring was re-placed at once from the add box's rect (177 → top 171) and its own rect then
// read 25. `#tour` is `position: fixed; inset: 0`, so its rect is where the fixed frame's origin sits in the
// frame rects are measured in — here -146. These stub exactly that and nothing else.
test('[BUG-124] B1 placement: with the fixed frame shifted by the keyboard, the ring and blockers land on the control, measured from #tour', async () => {
  const { app } = rig();
  app.ctx.innerWidth = 402;
  app.ctx.innerHeight = 714;
  app.ctx.visualViewport = { offsetTop: 146, height: 404, addEventListener() {} };
  app.el('tour-card').offsetHeight = 120;
  app.el('tour-card').offsetWidth = 290;
  await boot(app);
  click(app, 'tour-main');
  assert.equal(card(app), 'add', 'guard: card 2');
  box(app.el('add-form'), 177);                 // where the add box measures with the keyboard up
  box(app.el('tour'), -146, 0, 402, 714);       // where the fixed frame's origin measures
  app.fireWindow('resize');
  app.runTimers();
  const px = (id, prop) => parseFloat(app.el(id).style[prop]);
  // In the fixed frame the box is at 177 + 146 = 323 — where it was before the keyboard opened.
  assert.equal(px('tour-ring', 'top'), 317, 'the ring sits 6px above the box in the frame it is drawn in');
  assert.deepEqual([px('tour-block-top', 'top'), px('tour-block-top', 'height')], [0, 317], 'the top blocker ends where the cut-out starts');
  assert.equal(px('tour-block-bottom', 'top'), 369, 'the bottom blocker starts where the cut-out ends');
  assert.deepEqual([px('tour-block-left', 'top'), px('tour-block-right', 'top')], [317, 317], 'the side blockers flank the cut-out');
  // Fits below inside what the reader sees (146..550 in the fixed frame): 369 + 14 + 120 = 503 <= 538.
  assert.equal(app.el('tour-card').dataset.side, 'below');
  assert.equal(px('tour-card', 'top'), 383, 'the card sits under the box, not over the tabs');
});

// B1's 40px box and 120px card fit below in BOTH frames, so it cannot see the above/below decision (independent
// review 1, LOW-2: a mutation judging fit in the rect frame survived it). These are the phone's own numbers at 13966ms
// in the probe log: add box 104px tall at rect 177, card 127px, innerHeight 568, visualViewport 145.65625 + 404.
test('[BUG-124] B3 placement: on the logged phone state the card goes above the add box, inside what the reader sees', async () => {
  const { app } = rig();
  app.ctx.innerWidth = 402;
  app.ctx.innerHeight = 568;
  app.ctx.visualViewport = { offsetTop: 145.65625, height: 404, addEventListener() {} };
  app.el('tour-card').offsetHeight = 127;
  app.el('tour-card').offsetWidth = 290;
  await boot(app);
  click(app, 'tour-main');
  assert.equal(card(app), 'add', 'guard: card 2');
  box(app.el('add-form'), 177, 24, 354, 104);
  box(app.el('tour'), -146, 0, 402, 568);
  app.fireWindow('resize');
  app.runTimers();
  const px = (id, prop) => parseFloat(app.el(id).style[prop]);
  assert.equal(px('tour-ring', 'top'), 317, 'guard: the ring is in the fixed frame');
  // Below would need 317 + 116 + 14 + 127 = 574, past the visible bottom 549.66 - 12. Judged in the rect frame it
  // would fit (171 + 257 = 428) and the card would land 24px under the keyboard.
  assert.equal(app.el('tour-card').dataset.side, 'above');
  assert.equal(px('tour-card', 'top'), 176, 'directly above the box: 317 - 14 - 127, inside the visible top 157.66');
});

test('[BUG-124] B2 placement: a sideways shift of the fixed frame moves the ring and side blockers with it', async () => {
  const { app } = rig();
  app.ctx.innerWidth = 402;
  app.ctx.innerHeight = 714;
  app.el('tour-card').offsetHeight = 120;
  app.el('tour-card').offsetWidth = 290;
  box(app.el('source-toggle'), 120, 16, 300, 40);
  box(app.el('tour'), 0, -13, 402, 714);        // origin 13px left: pins the left term. Never seen on a device (scrollX 0 in every reading)
  await boot(app);
  assert.equal(card(app), 'tabs', 'guard: card 1');
  const px = (id, prop) => parseFloat(app.el(id).style[prop]);
  assert.equal(px('tour-ring', 'left'), 23, 'the ring sits 6px left of the control in the frame it is drawn in');
  assert.equal(px('tour-block-left', 'width'), 23, 'the left blocker stops at the cut-out');
  assert.equal(px('tour-block-right', 'left'), 335, 'the right blocker starts where the cut-out ends');
  assert.equal(px('tour-card', 'left'), 34, 'the card is centred under the control in the same frame: cx 23 + 156 = 179, minus half its 290px');
});

/** Card 2, its add form the target, with the three DOM methods the Tab ring reads stubbed on the form, the add
 *  box and the Add button. `extra` goes between them inside the form. */
async function card2WithFocusables(extra = []) {
  const { app } = rig();
  await boot(app);
  click(app, 'tour-main');
  assert.equal(card(app), 'add', 'guard');
  const form = app.el('add-form');
  const input = app.el('input-url');
  const add = app.el('btn-add');
  form.matches = () => false;
  form.getClientRects = () => [{}];
  for (const n of [input, add]) { n.matches = () => true; n.getClientRects = () => [{}]; }
  form.querySelectorAll = () => [input, ...extra, add];
  return app;
}
const tabKey = (app, shiftKey = false) => app.fireDocument('keydown', { key: 'Tab', shiftKey, preventDefault() {} });

test('[TASK-092] A30b Tab on a card with a highlight reaches the highlighted control (criterion 14; independent C07)', async () => {
  const app = await card2WithFocusables();
  assert.equal(app.ctx.document.activeElement.id, 'tour-main', 'guard: the last of the card\'s buttons');
  tabKey(app);
  assert.equal(app.ctx.document.activeElement.id, 'input-url', 'Tab wraps into the cut-out, not only round the card');
  tabKey(app);
  assert.equal(app.ctx.document.activeElement.id, 'btn-add');
  tabKey(app);
  assert.equal(app.ctx.document.activeElement.id, 'tour-back', 'and on to the card');
  assert.ok(shown(app, 'tour'), 'guard: the Tab handler did not throw and switch the tour off');
});

test('[TASK-092] A30c a control inside the highlight that is not rendered is skipped, not a Tab trap (criterion 14; independent C08)', async () => {
  // A browser refuses focus() on an element in a display:none subtree, so a ring that kept one would stop on it.
  const ghost = { id: 'ghost', matches: () => true, getClientRects: () => [], focus() {} };
  const app = await card2WithFocusables([ghost]);
  app.el('input-url').focus();
  tabKey(app);
  assert.equal(app.ctx.document.activeElement.id, 'btn-add', 'Tab moves past the control that is not drawn');
});

/** A centred Done card over an empty feed (Back disabled) with a toast raised. The toast's action query honours
 *  `:not(.hidden)` and its focus() is refused while hidden — what a browser does and the harness stub does not. */
async function centredWithToast(actionLabel) {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'feed', card: 'done', replay: false }) };   // as A30: since amendment 11 an empty first feed keeps waiting
  const { app } = rig({ store, feed: 'empty' });
  await boot(app);
  assert.equal(card(app), 'done', 'guard: centred card');
  const toast = app.el('toast');
  const realQuery = toast.querySelector;
  const action = realQuery('.toast-action');
  const seen = { actionFocused: false };
  action.focus = () => { if (!action.classList.contains('hidden')) seen.actionFocused = true; };
  toast.querySelector = (sel) => (sel === '.toast-action:not(.hidden)' ? (action.classList.contains('hidden') ? null : action) : realQuery(sel));
  if (actionLabel) app.ctx.showToast('Marked done', actionLabel, () => {});
  else app.ctx.showToast('Marked done');
  assert.ok(toast.classList.contains('show'), 'guard: the toast is up');
  assert.equal(app.ctx.document.activeElement.id, 'tour-main', 'guard: focus on the card');
  return { app, seen };
}

test('[TASK-092] A30d a toast\'s Undo, drawn above the dim, is reachable by Tab (criterion 14, Risk 3; independent C04)', async () => {
  const { app, seen } = await centredWithToast('Undo');
  tabKey(app);
  assert.ok(seen.actionFocused, 'Tab from the card\'s last button reaches the Undo');
});

test('[TASK-092] A30e a toast with no action does not put its hidden button in the Tab ring (criterion 14; independent C06)', async () => {
  const { app } = await centredWithToast(null);
  tabKey(app);
  assert.equal(app.ctx.document.activeElement.id, 'tour-close', 'Tab wraps to Close; it does not stall on a button nobody can see');
});

test('[TASK-092] A38 a new device whose account row exists but holds nothing still starts the tour (criterion 1; independent A03)', async () => {
  const { app } = rig({ stateGet: 'empty-row' });
  await boot(app);
  assert.equal(app.get('focus_theme'), 'dark', 'guard: the row WAS pulled down');
  assert.deepEqual(app.visibleViews(), ['view-setup'], 'guard: nothing to show, so setup');
  assert.equal(card(app), 'tabs', 'an applied row with no content is a new account, not a failed pull-down');
});

test('[TASK-092] A39 after a switch-off, a channel landing does not advance the abandoned run (criterion 15; independent B04)', async () => {
  const { app } = rig();
  await boot(app);
  assert.equal(card(app), 'tabs', 'guard');
  app.failSetItem((k) => k === 'focus_tour');
  click(app, 'tour-main');
  app.failSetItem(null);
  assertNoDim(app, 'guard: switched off');
  await addChannelByForm(app);
  assert.ok(shown(app, 'btn-go'), 'guard: the channel landed');
  assert.deepEqual(rec(app), { at: 'setup', card: 'tabs', replay: false },
    'the run is left where it stopped — a reload must not resume at a tip this document never showed');
});

test('[TASK-092] A40 "Show the tour" tapped while the boot is still loading the feed shows card 1 at once (criterion 11; independent B10)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'done' }) };
  const { app, holdFeed } = rig({ store });
  const release = holdFeed();
  const booting = app.ctx.init();
  for (let i = 0; i < 30 && !app.urls().some((u) => u.includes('/api/feed')); i++) await settle();
  assert.ok(app.urls().some((u) => u.includes('/api/feed')), 'guard: the boot is waiting on the feed');
  assert.equal(click(app, 'btn-feed-manage'), 1, 'guard: the gear is wired before the feed loads');
  click(app, 'btn-drawer-tour');
  assert.equal(card(app), 'tabs', 'the replay is drawn without waiting for the boot to finish');
  release();
  await booting;
});

test('[TASK-092] A21e a switch-off hands focus back to where the tour began, not to a button in the hidden layer (criteria 14, 15; review round 2 LOW-2)', async () => {
  const { app } = rig({ store: { focus_tour: JSON.stringify({ at: 'wait-channel', replay: false }) } });
  await boot(app);
  app.el('input-url').focus();
  await addChannelByForm(app);
  assert.equal(card(app), 'tip', 'guard');
  assert.equal(app.ctx.document.activeElement.id, 'tour-main', 'guard: the card took focus');
  app.failSetItem((k) => k === 'focus_tour');
  app.fireDocument('click', {});
  click(app, 'tour-close');
  app.runTimers();
  assertNoDim(app, 'guard: switched off');
  assert.equal(app.ctx.document.activeElement.id, 'input-url');
});

test('[TASK-092] A21f a switch-off while the drawer has suspended the card leaves focus in the drawer (criterion 14; review round 2 LOW-2)', async () => {
  // Sized so only "was a card SHOWING" can stop it: the tour holds where focus was before it began, the drawer
  // has taken the card down and owns focus, and then a tour event throws.
  const { app } = rig({ store: { focus_tour: JSON.stringify({ at: 'wait-channel', replay: false }) } });
  await boot(app);
  app.el('input-url').focus();
  await addChannelByForm(app);
  assert.equal(card(app), 'tip', 'guard');
  click(app, 'profile-btn');
  assert.ok(!shown(app, 'tour'), 'guard: the drawer suspended the card');
  const inDrawer = app.ctx.document.activeElement.id;
  assert.notEqual(inDrawer, 'input-url', 'guard: focus left the add box for the drawer');
  app.failGetItem((k) => k === 'focus_tour');
  app.ctx.tourApply('ok');
  app.failGetItem(null);
  assert.equal(app.ctx.document.activeElement.id, inDrawer, 'the throw did not pull focus out of the open drawer');
});

for (const missing of ['tour-main', 'btn-drawer-tour']) {
  test(`[TASK-092] A25b with #${missing} missing, the switched-off tour draws nothing and records no start (criterion 15; review round 2 LOW-1, independent C10)`, async () => {
    const { app, puts } = rig();
    const doc = app.ctx.document;
    const real = doc.getElementById;
    doc.getElementById = (id) => (id === missing ? null : real(id));
    await boot(app);
    assert.deepEqual(app.visibleViews(), ['view-setup'], 'guard: a new account, on setup');
    assertNoDim(app, 'a half-wired tour');
    assert.equal(app.get('focus_tour'), null, 'no record for a tour nobody will see');
    assert.equal(named(app, puts, 'tour_start').length, 0, 'and no tour_start in the funnel');
  });
}

test('[TASK-092] A34b a replay started from the feed\'s gear hands focus back to setup\'s gear, not to a control on a hidden screen (criterion 14; review round 2 LOW-2)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'done' }) };
  const { app } = rig({ store });
  await boot(app);
  app.el('btn-feed-manage').focus();
  click(app, 'btn-feed-manage');
  click(app, 'btn-drawer-tour');
  assert.deepEqual(app.visibleViews(), ['view-setup'], 'guard: the replay runs on setup');
  assert.equal(card(app), 'tabs', 'guard');
  click(app, 'tour-close');
  assert.equal(app.ctx.document.activeElement.id, 'profile-btn', 'the gear on the screen now showing, which opens the same drawer');
});

// ── The blind review of amendment 11, and amendment 12 (only a post visible in the stream counts) ─────────

test('[TASK-092] A13c a reload while waiting boots onto posts and starts the feed part on one, at boot (criterion 8; review of amendment 11, MED-2)', async () => {
  // The handset walk's own next step: the quiet channel left the tour waiting, the reader comes back after it posts.
  // Rewriting A13 and A14 for amendment 11 removed the only tests that booted a WAITING record onto posts.
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'wait-feed', replay: false }) };
  const { app } = rig({ store });
  await boot(app);
  assert.ok(app.queryAll('#feed .card:not(.grouped-out):not(.grouping-pending):not(.removing)').length > 0, 'guard: the boot put posts on screen');
  assert.equal(card(app), 'done', 'the waiting tour starts on this boot, not on some later refresh');
  assert.equal(app.el('tour-ring').dataset.target, 'done', 'with Done on a post');
});

test('[TASK-092] A14c a started feed part refreshed onto the X-unavailable note alone re-places its card centred (criterion 9; review of amendment 11, LOW-1)', async () => {
  const store = { focus_channels: JSON.stringify([YT_CHANNEL]), focus_last_view: 'feed', focus_tour: JSON.stringify({ at: 'feed', card: 'done', replay: false }) };
  const { app } = rig({ store });
  await boot(app);
  assert.equal(app.el('tour-ring').dataset.target, 'done', 'guard: Done on a post');
  app.ctx.renderFeedResults({ items: [], failed: [], cappedNames: [], limited: { quota: true, cap: false }, totalChannels: 1 });
  await drain(app);
  assert.ok(!app.el('feed-note').classList.contains('hidden'), 'guard: the note alone');
  assert.equal(card(app), 'done', 'the run carries on');
  assert.equal(app.el('tour-ring').dataset.target, '', 'centred — not still ringing the post the note branch just hid');
});

// Grouped view, for a replaying X reader: a render can hold posts while showing none in the stream.
const X_PUBLISHED = Date.now() - 2 * 86400_000;
const xPost = (id) => ({ id, source: 'twitter', text: `post ${id} says something`, published: X_PUBLISHED,
  channel: { id: '111', name: 'Sam', handle: 'sam', source: 'twitter' } });
const TOPIC = 'g_ai_news';
const groupsWith = (assignments) => JSON.stringify({
  assignments, groups: { [TOPIC]: { label: 'AI news', summary: [{ text: 'a point about AI', item_ids: Object.keys(assignments) }] } },
  unfiled: [], updatedAt: X_PUBLISHED,
});
const renderX = (app, items) => app.ctx.renderFeedResults({ items, failed: [], cappedNames: [], limited: { quota: false, cap: false }, totalChannels: 1 });
const loosePosts = (app) => app.queryAll('#feed .card:not(.grouped-out):not(.grouping-pending):not(.removing)');
const groupedWait = (assignments) => ({
  focus_channels: JSON.stringify([X_CHANNEL]), focus_last_view: 'feed',
  focus_tour: JSON.stringify({ at: 'wait-feed', replay: true }),
  focus_group_view: 'on', focus_groups: groupsWith(assignments),
});

test('[TASK-092] A14d grouping on, every post filed into a topic: the tour keeps waiting (criterion 8, amendment 12; review MED-1)', async () => {
  const { app } = rig({ store: groupedWait({ x1: TOPIC, x2: TOPIC }) });
  await boot(app);
  assert.deepEqual(rec(app), { at: 'wait-feed', replay: true }, 'guard: the boot feed was empty, still waiting');
  renderX(app, [xPost('x1'), xPost('x2')]);
  await drain(app);
  assert.equal(app.queryAll('#feed .card').length, 2, 'guard: both posts rendered into #feed');
  assert.equal(loosePosts(app).length, 0, 'guard: and both are filed into their topic, none loose in the stream');
  assertNoDim(app, 'no Done card with nothing in the stream to point at');
  assert.deepEqual(rec(app), { at: 'wait-feed', replay: true }, 'still waiting');
});

test('[TASK-092] A14e grouping on, new posts held while grouping runs: no card while they are held, the feed part starts once grouping releases them (criterion 8, amendment 12; review MED-1)', async () => {
  const { app } = rig({ store: groupedWait({}) });
  await boot(app);
  renderX(app, [xPost('x1'), xPost('x2')]);
  assert.equal(app.queryAll('#feed .card.grouping-pending').length, 2, 'guard: both held at render, before grouping answers');
  assert.ok(!shown(app, 'tour'), 'no card while every post is held');
  assert.deepEqual(rec(app), { at: 'wait-feed', replay: true }, 'still waiting at render');
  await drain(app);                                          // grouping answers with nothing, and releases them
  assert.ok(loosePosts(app).length > 0, 'guard: the posts are in the stream now');
  assert.equal(card(app), 'done', 'released posts start the feed part without a new render');
  assert.equal(app.el('tour-ring').dataset.target, 'done', 'on a post the reader can see');
});

test('[TASK-092] A14f grouping on and every post in a topic, then grouping switched off: the feed part starts on a post (criterion 8, amendment 12; review MED-1)', async () => {
  const { app } = rig({ store: groupedWait({ x1: TOPIC, x2: TOPIC }) });
  await boot(app);
  renderX(app, [xPost('x1'), xPost('x2')]);
  await drain(app);
  assert.ok(!shown(app, 'tour'), 'guard: waiting with everything in a topic');
  assert.equal(click(app, 'toggle-grouping'), 1, 'guard: the grouping switch is wired');
  assert.ok(loosePosts(app).length > 0, 'guard: switching grouping off put the posts in the stream');
  assert.equal(card(app), 'done', 'the tour notices without waiting for the next load');
  assert.equal(app.el('tour-ring').dataset.target, 'done');
});
