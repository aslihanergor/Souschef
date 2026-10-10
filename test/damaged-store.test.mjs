// A store with an unreadable value makes the app READ-ONLY until it heals.
//
// Coercing unreadable values to empty at the READER and guarding only the PUSH is not enough:
// a coerced empty is indistinguishable from a genuinely empty store, and it flows into
// decisions the push guard never sees. So the predicate sits at the WRITE boundary and at every
// destructive decision, rather than being repeated per leak.
//
// MEASURED BASELINE, without the guard — each case booted signed-in with one
// key changed at a time. `views` is `visibleViews()`; `threw` is what escaped `init()`:
//
//   corrupt channels          []               SyntaxError                  ← blank page
//   corrupt done              []               SyntaxError                  ← blank page
//   corrupt archive           []               SyntaxError                  ← blank page
//   corrupt groups            []               SyntaxError                  ← blank page
//   non-array channels        []               TypeError .map               ← blank page
//   NULL ELEMENT in channels  []               TypeError .source            ← blank page
//   nameless channel          ["view-setup"]   TypeError .length            ← half-rendered
//   archived item, no channel ["view-archive"] TypeError .color             ← half-rendered
//   empty-string channels     ["view-setup"]   —                            ← laundered to "absent"
//   corrupt tweet_cache       ["view-setup"]   —                            ← survives
//
// Two of those rows are easy to miss: a `null` element blanks the boot outright, and the empty
// string does NOT blank it — it is silently read as absent, which launders damage into an empty
// store and is why the empty string is treated as a corrupt value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../test-helpers/app-harness.mjs';

// A signed-in browser whose every protected key is readable and NON-EMPTY where that matters.
// `focus_last_view` is deliberately NOT 'setup': the boot's view decision turns on `noContent || lastView ===
// 'setup'`, and seeding 'setup' makes both terms answer the same, so neither would be pinned.
const HEALTHY = {
  focus_device_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  focus_channels: JSON.stringify([{ id: 'UC_a', name: 'Alpha' }]),
  focus_done: JSON.stringify(['v1']),
  focus_archive: '[]',
  focus_groups: JSON.stringify({ assignments: { i1: 'g1' }, groups: { g1: { label: 'G' } }, updatedAt: 5, unfiled: [], v: 1 }),
  focus_tweet_cache: JSON.stringify({ UC_x: [{ id: 't1', text: 'kept' }] }),
  focus_last_view: 'feed',
  focus_theme: 'dark',
  focus_include_shorts: 'false',
};

// The four synced keys, each with a value that is readable and an EMPTY that a coerced read
// produces — so a test can tell "the real value" from "what a coercion would have invented".
const SYNCED = [
  ['focus_channels', '[{"id":"UC_a","name":"Alpha"}]'],
  ['focus_done', '["v1"]'],
  ['focus_archive', '[]'],
  ['focus_groups', '{"assignments":{},"groups":{}}'],
];

const CORRUPT = '[{"id":"UC_a","na';   // truncated mid-token, the original report's shape

/** A server that answers "no row yet". This still sets `_stateLoaded` — standing is established by
 *  getting an ANSWER, not by there being a row — so a push suppressed in these tests is suppressed
 *  by the damage guard and by nothing else. Sizing the fixture so only the guard under test can
 *  fire is the point; a row-bearing answer would also OVERWRITE the fixture via applySyncedState. */
const noRow = async (u, init = {}) => {
  u = String(u);
  if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
  // The PUT must answer like an ACCEPTED write. Answering it with the same no-row body makes the
  // client read `updatedAt: null` as DISCARDED — so every push reports failure and the
  // sign-out control below refuses on a perfectly healthy store, for a reason that has nothing to
  // do with damage. A fixture that manufactures
  // the condition under test reports a branch it never actually reached.
  if (u.includes('/api/state') && (init.method || 'GET') === 'PUT') {
    return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-put' }) };
  }
  if (u.includes('/api/state')) return { ok: true, status: 200, json: async () => ({ state: null, updatedAt: null, kind: 'account' }) };
  if (u.includes('/api/resolve-channel')) return { ok: true, status: 200, json: async () => ({ name: 'Resolved' }) };
  return { ok: true, status: 200, json: async () => ({ items: [] }) };
};

const boot = async (over = {}, fetch = noRow) => {
  const app = createApp({ store: { ...HEALTHY, ...over }, fetch });
  await app.ctx.init();
  return app;
};
const puts = (app) => app.requests
  .filter(r => r.url.includes('/api/state') && (r.init.method || 'GET') === 'PUT')
  .map(r => JSON.parse(r.init.body));
/** Everything the store holds, so a SECOND boot can be run over the first one's leavings. */
const snapshot = (app) => Object.fromEntries(app.store);
/** The rendered channel rows. `renderChannelList` appendChild()s an <li> per channel and sets the
 *  markup on the LI, so the list's own innerHTML is empty — reading that would have made both
 *  name-precedence tests pass for the wrong reason. */
const rows = (app) => app.el('channel-list').children.map(c => c.innerHTML).join('');
/** Settle the microtask queue so an un-awaited push resolves before we read the requests. */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

// ── No corrupt synced key blanks the boot ────────────────────────────────────
// The identity, not the length: "some view rendered" would pass on the feed, which is the wrong
// answer for a store whose channels cannot be read.

for (const [key] of SYNCED) {
  test(`c1 ${key}: a corrupt value renders setup instead of blanking the boot`, async () => {
    const app = createApp({
      store: { ...HEALTHY, focus_channels: '[]', focus_archive: '[]', [key]: CORRUPT },
      fetch: noRow,
    });
    await assert.doesNotReject(() => app.ctx.init(), `init() must survive a corrupt ${key}`);
    assert.deepEqual(app.visibleViews(), ['view-setup'], `corrupt ${key} must land on setup`);
  });
}

test('c1 non-array channels: a parseable wrong shape renders setup instead of blanking the boot', async () => {
  const app = createApp({ store: { ...HEALTHY, focus_channels: '{"a":1}', focus_archive: '[]' }, fetch: noRow });
  await assert.doesNotReject(() => app.ctx.init(), 'init() must survive a non-array channels');
  assert.deepEqual(app.visibleViews(), ['view-setup']);
});

test('c1 null element: a null inside the channels array does not blank the boot', async () => {
  // `getChannels`' map reads `ch.source` off every element.
  const app = createApp({ store: { ...HEALTHY, focus_channels: '[{"id":"UC_a","name":"A"},null]', focus_archive: '[]' }, fetch: noRow });
  await assert.doesNotReject(() => app.ctx.init(), 'init() must survive a null channel element');
  assert.deepEqual(app.visibleViews(), ['view-feed'], 'one readable channel is still content');
});

test('c1 nameless channel: a channel with no name renders setup without throwing', async () => {
  const app = createApp({ store: { ...HEALTHY, focus_channels: '[{"id":"UC_a"}]', focus_archive: '[]', focus_last_view: 'setup' }, fetch: noRow });
  await assert.doesNotReject(() => app.ctx.init(), 'avatarColor(undefined) must not take down the boot');
  assert.deepEqual(app.visibleViews(), ['view-setup']);
});

test('c1 [BUG-117]: an archived item carrying no channel renders without throwing', async () => {
  const app = createApp({ store: { ...HEALTHY, focus_channels: '[]', focus_archive: '[{"id":"a1"}]', focus_last_view: 'archive' }, fetch: noRow });
  await assert.doesNotReject(() => app.ctx.init(), 'avatarHtml(undefined) must not take down the boot');
  assert.deepEqual(app.visibleViews(), ['view-archive']);
});

// ── No coerced-empty value is ever PERSISTED ─────────────────────────────────
// Asserted on the STORED BYTES. Counting through `getChannels()` — the very
// function doing the coercing — could not see the drop this is written to catch.

test('c2 saveChannels: a write derived from a coerced read never reaches the store', async () => {
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  app.ctx.saveChannels([{ id: 'UC_new', name: 'New' }]);
  assert.equal(app.get('focus_channels'), CORRUPT, 'the damaged bytes must be left exactly as they were');
});

test('c2 addDone: a write derived from a coerced read never reaches the store', async () => {
  const app = await boot({ focus_done: CORRUPT });
  app.ctx.addDone('v2');
  assert.equal(app.get('focus_done'), CORRUPT);
});

test('c2 saveArchive: a write derived from a coerced read never reaches the store', async () => {
  const app = await boot({ focus_archive: CORRUPT });
  app.ctx.saveArchive([{ id: 'x1' }]);
  assert.equal(app.get('focus_archive'), CORRUPT);
});

test('c2 saveTweetCache: a write derived from a coerced read never reaches the store', async () => {
  const app = await boot({ focus_tweet_cache: CORRUPT });
  app.ctx.saveTweetCache({ UC_y: [{ id: 't2' }] });
  assert.equal(app.get('focus_tweet_cache'), CORRUPT);
});

test('c2 cross-key: damage in ONE key stops the writers that touch the OTHERS', async () => {
  // The whole point of moving the predicate to the write boundary. `done` is unreadable, so a push
  // built from this store would claim the account has no read marks — which makes a channel write
  // that ARMS that push just as destructive as writing `done` itself.
  const app = await boot({ focus_done: CORRUPT });
  const before = app.get('focus_channels');
  app.ctx.saveChannels([{ id: 'UC_new', name: 'New' }]);
  assert.equal(app.get('focus_channels'), before, 'a corrupt `done` must stop a channels write too');
});

// ── No coerced-empty value is ever PUSHED, for all FOUR keys ─────────────────
// A fixture on `channels` alone would let `done`, `archive` or `groups` be dropped from the
// unreadable set unnoticed. One test per key.
//
// Each also asserts a PUT still WENT OUT: refusing instead of downgrading
// takes analytics from 3 events to none, so a corrupt-store session stops reporting entirely.

for (const [key] of SYNCED) {
  test(`c3 ${key}: a push from a damaged store carries events but no state`, async () => {
    const app = await boot();
    app.ctx.track('view', {}, 'feed');
    const before = puts(app).length;
    app.set(key, CORRUPT);
    app.ctx.schedulePush();
    app.advance(2000);
    await settle();
    const sent = puts(app).slice(before);
    assert.equal(sent.length, 1, 'exactly one PUT — a downgrade, not a refusal');
    assert.ok(!('state' in sent[0]), `the body must omit \`state\` entirely when ${key} is unreadable`);
    // NON-VACUOUS on purpose. `assert.ok(Array.isArray(sent[0].events))` cannot
    // fail for ANY input: `_pushNow` always includes the key and `_readEvents()` always returns an
    // array, so blinding `_readEvents` to `[]` would stay green.
    // This seeds a real event and asserts THAT event rode the downgraded push.
    assert.ok(sent[0].events.some(e => e && e.name === 'view'),
      `the buffered event must ride the downgraded push: ${JSON.stringify(sent[0].events)}`);
  });
}

// ── The empty string is a corrupt value ──────────────────────────────────────

test('c4: an empty-string value is unreadable, not absent', async () => {
  // The residue of a quota-aborted write. `raw === null` reads it as "this key was never set", which
  // ends in an empty state PUT over a row holding the user's real channels.
  // Mutating the guard to `!raw` must red here.
  const app = await boot();
  const before = puts(app).length;
  app.set('focus_channels', '');
  app.ctx.schedulePush();
  app.advance(2000);
  await settle();
  const sent = puts(app).slice(before);
  assert.equal(sent.length, 1);
  assert.ok(!('state' in sent[0]), 'an empty string must suppress the state claim');
});

test('c4b: an ABSENT key is not damage — a fresh install must still be able to write', async () => {
  // The other direction, and it is load-bearing: treating absent as damage would make a brand-new
  // browser permanently read-only, which is a worse bug than the one being fixed.
  const app = createApp({ store: { focus_device_id: HEALTHY.focus_device_id, focus_last_view: 'feed' }, fetch: noRow });
  await app.ctx.init();
  app.ctx.saveChannels([{ id: 'UC_new', name: 'New' }]);
  assert.ok(String(app.get('focus_channels')).includes('UC_new'), 'a fresh store must accept writes');
});

// ── The reconcile branch does not clear dirty on an untrusted comparison ─────
// Across TWO boots, because the damage only becomes visible on the second one: a reconcile that
// clears `dirty` and re-bases lets the NEXT boot pull the row down over the damaged key.

test('c5: an untrusted comparison leaves dirty set and the base unchanged, across two boots', async () => {
  // FIXTURE SIZED SO ONLY THE GUARD UNDER TEST CAN FIRE: if the row held
  // channels that differed from local, `sameSyncedState` would answer false for a reason that had
  // nothing to do with the damage, and the test would pass whether or not the guard existed.
  //
  // The row below is byte-for-byte what a COERCING read of this store would produce: `done` is the
  // damaged key, so its coerced value is `[]`, and every other key matches local exactly. The
  // damage needs exactly that — an unguarded reconcile compares coerced empties to the row, MATCHES,
  // clears `dirty` and re-bases with no push, and the next boot overwrites the damaged key.
  const ROW = {
    state: {
      channels: JSON.parse(HEALTHY.focus_channels),
      done: [],                                  // what the damaged key coerces to
      archive: [],
      theme: 'dark',
      shorts: 'false',
      groups: JSON.parse(HEALTHY.focus_groups),
    },
    updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-server', kind: 'account',
  };
  const withRow = async (u, init = {}) => {
    u = String(u);
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state') && (init.method || 'GET') === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-02T00:00:00.000Z', rev: 'r-put' }) };
    }
    if (u.includes('/api/state')) return { ok: true, status: 200, json: async () => ROW };
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  const one = await boot({ focus_done: CORRUPT, focus_dirty: '1', focus_rev: 'r-local' }, withRow);
  await settle();
  assert.equal(one.get('focus_dirty'), '1', 'boot 1 must not clear dirty on a comparison it cannot trust');
  assert.equal(one.get('focus_rev'), 'r-local', 'and must not re-base on it');
  assert.equal(one.get('focus_done'), CORRUPT, 'and must not overwrite the damaged key');

  const two = createApp({ store: snapshot(one), fetch: withRow });
  await two.ctx.init();
  await settle();
  assert.equal(two.get('focus_done'), CORRUPT, 'boot 2 must not overwrite it either');
  assert.equal(two.get('focus_channels'), HEALTHY.focus_channels, "and must not replace local with the row's copy");
  assert.equal(two.get('focus_dirty'), '1', 'and dirty must still assert the un-pushed work');
});

// ── Sign-out refuses rather than wipes ───────────────────────────────────────

test('c6: sign-out on a damaged store refuses, navigates nowhere and keeps the bytes', async () => {
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  await app.ctx.signOut();
  assert.equal(app.get('focus_channels'), CORRUPT, 'the only copy of this data must survive');
  assert.equal(app.navigations.length, 0, 'a refused sign-out navigates nowhere');
  assert.ok(app.toasts.includes("Not signed out — couldn't save your changes"),
    `expected the refusal toast, got: ${JSON.stringify(app.toasts)}`);
});

test('c6b: sign-out still WORKS on a healthy store', async () => {
  // The non-vacuity control. Without it "sign-out refused" passes just as well on a guard that
  // refuses always, which would wedge the exit path.
  const app = await boot();
  await app.ctx.signOut();
  await settle();
  assert.equal(app.navigations.at(-1), '/app', 'a healthy sign-out must complete');
});

// ── exportData never hands over a confident empty backup ─────────────────────

const noServer = async (u) => {
  u = String(u);
  if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
  if (u.includes('/api/state') ) return { ok: false, status: 500, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ items: [] }) };
};

test('c7: an export from a damaged store is partial and SAYS so, never silently short', async () => {
  // Offering NO file would be wrong too: with one key of four damaged the user would get
  // nothing, where a file could still carry the channels and every read mark. Export is
  // the user's own preservation action. What is forbidden is a CONFIDENT EMPTY — a backup
  // whose damaged key is silently absent and is filed away as complete — so the fix is to name the
  // gap in the file, not to withhold the file.
  const app = createApp({ store: { ...HEALTHY, focus_channels: CORRUPT }, fetch: noServer });
  await app.ctx.exportData();
  const files = app.exports();
  assert.equal(files.length, 1, 'the readable three quarters must still reach the user');
  const payload = JSON.parse(files[0].text);
  assert.deepEqual(payload.unreadable, ['focus_channels'],
    'and the file must NAME what could not be read — that is what stops it being a confident empty');
  assert.deepEqual(payload.state.done, ['v1'], 'the readable keys must carry their real values');
  assert.deepEqual(payload.state.channels, [], 'and the damaged one degrades, declared rather than hidden');
});

test('c7c: a healthy export carries no `unreadable` key at all', async () => {
  // Non-vacuity for c7, and a guarantee that an ordinary export is byte-identical to what it was.
  const app = createApp({ store: HEALTHY, fetch: noServer });
  await app.ctx.exportData();
  const payload = JSON.parse(app.exports()[0].text);
  assert.equal('unreadable' in payload, false, 'a healthy export must not grow a new field');
});

test('c7b: a healthy export with no server still produces the local file', async () => {
  // Non-vacuity: proves the instrument can see an export, so c7's zero means something.
  const app = createApp({ store: HEALTHY, fetch: noServer });
  await app.ctx.exportData();
  const files = app.exports();
  assert.equal(files.length, 1, 'the offline fallback must still work');
  assert.ok(files[0].text.includes('UC_a'), 'and must carry the real channels');
});

// ── A read-time repair is never written back ─────────────────────────────────

test('c8: the display name for a nameless channel never reaches the store, across two boots', async () => {
  // A repair that falls through to `ch.id` MATCHES migrateChannelNames' broken-name
  // regex — so it would be persisted and re-pushed on every boot, forever.
  const stored = '[{"id":"UC_aaaaaaaaaaaaaaaaaaaaaa"}]';
  const one = await boot({ focus_channels: stored, focus_archive: '[]', focus_last_view: 'setup' });
  await settle();
  assert.equal(one.get('focus_channels'), stored, 'boot 1 must not write a display name back');

  const two = createApp({ store: snapshot(one), fetch: noRow });
  await two.ctx.init();
  await settle();
  assert.equal(two.get('focus_channels'), stored, 'boot 2 must not either');

  // AND the general path, not just migrateChannelNames'. The two boots above only cover one
  // route (a repair that matches the broken-name regex); routing ANY display
  // name into the object `getChannels` returns persists it the next time the user edits or removes
  // a different channel.
  //
  // Asserted on the absence of a `name` key rather than on byte identity, because `getChannels`
  // ALREADY adds `source` at read time and that one is written back — pre-existing, and now
  // documented honestly at the function (its old comment claimed "no data rewrite").
  one.ctx.saveChannels(one.ctx.getChannels());
  const after = JSON.parse(one.get('focus_channels'));
  assert.equal('name' in after[0], false,
    `a display name must never be persisted: ${one.get('focus_channels')}`);
});

// ── No channel is ever dropped ───────────────────────────────────────────────

test('c9: a non-object element is never DROPPED by a read/write round trip', async () => {
  // A dropping READ is invisible until something WRITES the result back, which is exactly how a
  // channel would be lost in the field: the user edits or removes a different channel, and
  // `saveChannels(getChannels()…)` persists the shortened array. Booting and counting alone
  // would not see the tempting `.filter(ch && typeof ch === 'object')` fix.
  // The element is not preserved verbatim — the round trip rewrites
  // `null` as `{"source":"youtube"}`, because `getChannels` adds the source default at read time
  // (documented at that function). What this
  // asserts is that the SLOT is never deleted: three in, three out.
  const stored = '[{"id":"UC_a","name":"Alpha"},null,{"id":"UC_b","name":"Beta"}]';
  const app = await boot({ focus_channels: stored, focus_archive: '[]', focus_last_view: 'setup' });
  await settle();
  assert.equal(JSON.parse(app.get('focus_channels')).length, 3, 'the boot alone must not drop it');
  app.ctx.saveChannels(app.ctx.getChannels());        // what every edit and removal does
  assert.equal(JSON.parse(app.get('focus_channels')).length, 3,
    'counted on the STORED value: a read that drops an element loses it on the next write');
});

// ── getTweetCache must not reset the cache ───────────────────────────────────

test('c10: a corrupt tweet cache reads as empty but is never overwritten by that empty', async () => {
  // For a pay-per-post source, persisting the reset erases every other channel's cached posts and
  // costs real money to refetch.
  const app = await boot({ focus_tweet_cache: CORRUPT });
  assert.deepEqual(Object.keys(app.ctx.getTweetCache()), [], 'the READ degrades to empty so rendering survives');
  app.ctx.saveTweetCache(app.ctx.getTweetCache());
  assert.equal(app.get('focus_tweet_cache'), CORRUPT, 'but the STORE keeps its bytes');
});

// ── Wrong-shaped-but-parseable is damage ─────────────────────────────────────

test('c11: a parseable non-array in focus_channels never reaches the server', async () => {
  // Without the guard this object is pushed verbatim and destroys
  // the row's real channels.
  const app = await boot();
  const before = puts(app).length;
  app.set('focus_channels', '{"a":1}');
  app.ctx.schedulePush();
  app.advance(2000);
  await settle();
  const sent = puts(app).slice(before);
  assert.equal(sent.length, 1);
  assert.ok(!('state' in sent[0]), 'a wrong shape must suppress the state claim like any other damage');
});

// ── Healthy state is byte-identical, and no repair fires ─────────────────────

test('c12: a healthy boot leaves every protected key byte-identical', async () => {
  const app = await boot();
  await settle();
  for (const k of ['focus_channels', 'focus_done', 'focus_archive', 'focus_groups', 'focus_tweet_cache']) {
    assert.equal(app.get(k), HEALTHY[k], `${k} must be untouched by a healthy boot`);
  }
});

test('c12b: a healthy push still carries the real state', async () => {
  const app = await boot();
  const before = puts(app).length;
  app.ctx.schedulePush();
  app.advance(2000);
  await settle();
  const sent = puts(app).slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state.channels[0].id, 'UC_a', 'the guard must not suppress a healthy claim');
  assert.deepEqual(sent[0].state.done, ['v1']);
});

test('c12c: a channel carrying BOTH name and title displays the name', async () => {
  // A precedence inversion shows the wrong name for every channel that has both.
  const app = await boot({ focus_channels: '[{"id":"UC_a","name":"RealName","title":"WrongTitle"}]', focus_last_view: 'setup' });
  const html = rows(app);
  assert.ok(html.includes('RealName'), 'the stored name must win');
  assert.ok(!html.includes('WrongTitle'), 'the title must not');
});

test('c12d: a channel with neither name nor title falls back to a readable label', async () => {
  // An empty final fallback renders a blank row and an empty avatar letter.
  const app = await boot({ focus_channels: '[{"id":"UC_a"}]', focus_archive: '[]', focus_last_view: 'setup' });
  const html = rows(app);
  assert.ok(html.includes('Channel'), `expected a fallback label, got: ${html.slice(0, 200)}`);
});

// ── The damaged-store notice ─────────────────────────────────────────────────
// Its purpose matters for what it must say. It is not a SAFETY
// control — the thing between the user and a destructive action. Under read-only the predicate
// already prevents the destruction, so this is a COMPREHENSION control: without it the user faces
// an app that looks empty and silently refuses to accept a new channel, which reads as "the app is
// broken" rather than "this device's copy is damaged".
//
// INLINE, not a toast, and that is settled precedent rather than preference: `_pushNow`'s halt
// guard records in app.js that a paused-sync condition "is a STATE, not an event, and the toast
// auto-hides at 5s", and a notice that appears once and then
// no-ops in silence leaves the user with no explanation.

const notice = (app, view = 'setup') => app.el(`damaged-notice-${view}`);
const noticeShown = (app, view = 'setup') => !notice(app, view).classList.contains('hidden');
const noticeText = (app, view = 'setup') => app.el(`damaged-notice-${view}-text`).textContent || '';

test('c13: the notice is PRESENT when a synced key is unreadable', async () => {
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  assert.ok(noticeShown(app), 'a damaged store must explain itself');
  assert.ok(noticeText(app).length > 0, 'and must actually say something');
});

test('c13b: the notice is ABSENT on a healthy store', async () => {
  // Both directions, because a notice that is always on is indistinguishable from one that is
  // always off, and only one of those is a bug you would notice.
  const app = await boot({ focus_channels: '[]', focus_archive: '[]' });
  assert.equal(noticeShown(app), false, 'a healthy store must say nothing');
});

test('c13c: a damaged TWEET CACHE raises no notice — it would over-promise', async () => {
  // The cache is device-local and is not in the account, so "restore it from your account" would be
  // false. It still blocks writes; it just does not claim the account can fix it.
  const app = await boot({ focus_tweet_cache: CORRUPT, focus_channels: '[]', focus_archive: '[]' });
  assert.equal(noticeShown(app), false, 'a device-local cache must not raise an account-restore notice');
});

test('c14: the notice survives a re-render — it is a state, not an event', async () => {
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  assert.ok(noticeShown(app), 'precondition: raised on the first render');
  app.ctx.renderChannelList();
  app.ctx.showView('view-setup');
  assert.ok(noticeShown(app), '[BUG-047] attempt 3 shipped a notice that appeared once and then went silent');
});

test('c14b: the notice clears once the key is readable again', async () => {
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  assert.ok(noticeShown(app), 'precondition: raised');
  app.set('focus_channels', '[]');
  app.ctx.showView('view-setup');
  assert.equal(noticeShown(app), false, 'a healed store must stop being told it is damaged');
});

test('c15: the notice action HEALS — the damaged key ends up holding the server value', async () => {
  const ROWSTATE = { channels: [{ id: 'UC_row', name: 'Row' }], done: ['v9'], archive: [], groups: null };
  const withRow = async (u, init = {}) => {
    u = String(u);
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state') && (init.method || 'GET') === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-02T00:00:00.000Z', rev: 'r-put' }) };
    }
    if (u.includes('/api/state')) {
      return { ok: true, status: 200, json: async () => ({ state: ROWSTATE, updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-server', kind: 'account' }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  // `dirty` set, which is the case that MATTERS: it is why the action cannot be "reload". With
  // dirty set, syncOnLoad takes the keep-local branch and never applies the row, so the damage
  // survives every reload — measured while reading the boot path, not assumed.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]', focus_dirty: '1' }, withRow);
  assert.equal(app.get('focus_channels'), CORRUPT, 'precondition: the reload-equivalent boot did NOT heal it');
  assert.ok(noticeShown(app), 'precondition: the notice is up');

  const ran = app.click(app.el('damaged-heal-setup'));
  assert.equal(ran, 1, 'the action must be WIRED — an unwired button is a silent no-op');
  await settle();

  assert.deepEqual(JSON.parse(app.get('focus_channels')), ROWSTATE.channels,
    'the stored bytes must now be the server copy — asserted on the store, not on a handler running');
  assert.equal(noticeShown(app), false, 'and the notice must clear itself');
});

test('c15b: healing a key the server row does NOT carry removes it rather than stranding the app', async () => {
  // `applySyncedState` writes each key only if the row HAS one, so a damaged `groups` against a row
  // whose groups are null would survive the adopt and leave the app read-only forever — the one
  // escape the notice offers would not work. Found by reading applySyncedState, not by a test
  // failing.
  const ROWSTATE = { channels: [], done: [], archive: [], groups: null };
  const withRow = async (u, init = {}) => {
    u = String(u);
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state') && (init.method || 'GET') === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-02T00:00:00.000Z', rev: 'r-put' }) };
    }
    if (u.includes('/api/state')) {
      return { ok: true, status: 200, json: async () => ({ state: ROWSTATE, updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-server', kind: 'account' }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  const app = await boot({ focus_groups: CORRUPT, focus_channels: '[]', focus_archive: '[]', focus_dirty: '1' }, withRow);
  assert.ok(noticeShown(app), 'precondition: a corrupt groups raises the notice');
  app.click(app.el('damaged-heal-setup'));
  await settle();
  assert.equal(app.get('focus_groups'), null, 'an unreadable key the row cannot replace must be removed');
  assert.equal(noticeShown(app), false, 'so the app becomes writable again');
  app.ctx.saveChannels([{ id: 'UC_new', name: 'New' }]);
  assert.ok(String(app.get('focus_channels')).includes('UC_new'), 'and writes actually work afterwards');
});

test('c16: a signed-in user with NO server row is not told their data is safe in their account', async () => {
  // It is not. The local copy is the only one there ever was, and it is unreadable.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });   // noRow answers updatedAt: null
  assert.ok(noticeShown(app), 'precondition: the notice is up');
  // Matches the whole word, not a three-alternation phrase: the narrow version is
  // a regex a copy edit could slip past while still promising the account has
  // it. Paired with c16b, which asserts the with-row copy DOES say "account", so this cannot pass
  // on a notice that never mentions anything.
  assert.ok(!/account/i.test(noticeText(app)),
    `the notice must not promise an account copy that does not exist: ${JSON.stringify(noticeText(app))}`);
  assert.equal(app.el('damaged-heal-setup').classList.contains('hidden'), true,
    'and must not offer a restore that cannot work');
});

test('c16b: WITH a server row the notice does say the account has a copy, and offers it', async () => {
  // Non-vacuity for c16: without this, "the notice never mentions the account" passes on a notice
  // that never mentions anything.
  const withRow = async (u, init = {}) => {
    u = String(u);
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state') && (init.method || 'GET') === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-02T00:00:00.000Z', rev: 'r-put' }) };
    }
    if (u.includes('/api/state')) {
      return { ok: true, status: 200, json: async () => ({ state: { channels: [], done: [], archive: [], groups: null }, updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-server', kind: 'account' }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]', focus_dirty: '1' }, withRow);
  assert.ok(/account/i.test(noticeText(app)), `expected the account copy to be offered: ${JSON.stringify(noticeText(app))}`);
  assert.equal(app.el('damaged-heal-setup').classList.contains('hidden'), false, 'and the action shown');
});

test('c10b: a damaged TWEET CACHE does not freeze the rest of the app', async () => {
  // The counterpart to c13c, and the reason the cache is outside the main predicate. It raises no
  // notice (device-local, so "restore from your account" would be false) — so if it ALSO blocked
  // every other writer, the user would face an app silently refusing writes with no explanation,
  // which is precisely the state the notice exists to prevent.
  const app = await boot({ focus_tweet_cache: CORRUPT });
  app.ctx.saveChannels([{ id: 'UC_new', name: 'New' }]);
  assert.ok(String(app.get('focus_channels')).includes('UC_new'), 'a corrupt cache must not stop a channels write');
  assert.equal(app.get('focus_tweet_cache'), CORRUPT, 'while still protecting its own bytes');
});

test('c13d: the notice appears on the FEED as well as setup', async () => {
  // "Wherever the degraded state is visible" — the setup screen and the feed both.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  app.ctx.showView('view-feed');
  assert.ok(noticeShown(app, 'feed'), 'the feed must explain it too');
  assert.ok(noticeText(app, 'feed').length > 0);
});

// ── Gaps found by mutation, closed ──────────────────────────────────────────
// Each of these pins a guard that a mutation showed nothing else covered.

test('c1g: a PARSEABLE non-array in focus_done does not blank the boot', async () => {
  // `new Set({a:1})` throws "is not iterable", so a wrong SHAPE is
  // just as fatal on the boot path as unparseable bytes — and the c1 fixtures were all unparseable,
  // so nothing pinned the shape half of the guard.
  const app = createApp({ store: { ...HEALTHY, focus_channels: '[]', focus_archive: '[]', focus_done: '{"a":1}' }, fetch: noRow });
  await assert.doesNotReject(() => app.ctx.init(), 'a non-array done must not take down the boot');
  assert.deepEqual(app.visibleViews(), ['view-setup']);
});

test('c10c: an ARRAY in the tweet cache is damage, not a cache', async () => {
  // `store[ch.id] = merged` on an array builds a hybrid that
  // re-serialises as an array, silently losing every keyed entry.
  const app = await boot({ focus_tweet_cache: '[1,2]' });
  // Compared field-by-field, not with deepEqual: objects built inside the vm carry that realm's
  // prototypes, so `assert.deepEqual` fails on structurally identical values (harness gotcha).
  const cache = app.ctx.getTweetCache();
  assert.equal(Array.isArray(cache), false, 'the read must degrade to an OBJECT, not to an array');
  assert.deepEqual(Object.keys(cache), [], 'and to an empty one');
  app.ctx.saveTweetCache({ UC_y: [{ id: 't2' }] });
  assert.equal(app.get('focus_tweet_cache'), '[1,2]', 'and the write must not persist over it');
});

test('c2b removeDone: the Undo path is guarded too', async () => {
  // `removeDone` rewrites the WHOLE done array from a read, exactly as addDone does,
  // so it needs its own test or the guard is unpinned.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  app.ctx.removeDone(['v1']);
  assert.equal(app.get('focus_done'), HEALTHY.focus_done, 'Undo must not rewrite done from a damaged store');
});

test('c2c saveGroupState: the write that fires with no user action at all is guarded', async () => {
  // The one most likely to land unnoticed: the async /api/group resolve calls this
  // on its own cadence, so it fires on a damaged store while the user is doing nothing.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  app.ctx.saveGroupState({ assignments: { x: 'g9' }, groups: { g9: { label: 'New' } }, unfiled: [] });
  assert.equal(app.get('focus_groups'), HEALTHY.focus_groups, 'a classify must not overwrite groups on a damaged store');
});

// ── Further damage classes and paths ────────────────────────────────────────

test('r1: the reconcile branch is guarded for EVERY damage class, not just unparseable bytes', async () => {
  // A DATA-LOSS path. Relying on
  // `collectSyncedState` THROWING inside syncOnLoad's try holds only for
  // unparseable bytes: `collectSyncedState` reads `getItem(k) || '[]'`, so the EMPTY STRING coerces
  // to `[]` and never throws. Measured without the explicit guard, with `focus_done: ''`,
  // `dirty: '1'` and a row byte-equal to a coercing read:
  //
  //     unparseable   dirty "1"   rev r-local    1 PUT     ← guarded
  //     empty string  dirty null  rev r-server   0 PUTs    ← the row overwrites the damaged key
  //     wrong shape   dirty "1"   rev r-local    1 PUT     ← safe only because sameSyncedState
  //                                                          happened to answer false
  const ROW = {
    state: { channels: JSON.parse(HEALTHY.focus_channels), done: [], archive: [],
             theme: 'dark', shorts: 'false', groups: JSON.parse(HEALTHY.focus_groups) },
    updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-server', kind: 'account',
  };
  const withRow = async (u, init = {}) => {
    u = String(u);
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state') && (init.method || 'GET') === 'PUT') return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-02T00:00:00.000Z', rev: 'r-put' }) };
    if (u.includes('/api/state')) return { ok: true, status: 200, json: async () => ROW };
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  // One case per damage class. The empty string is the one that regressed; the other two are the
  // controls that make this a discrimination rather than a single reading.
  for (const [label, val] of [['unparseable', '[{"a"'], ['empty string', ''], ['wrong shape', '{"a":1}']]) {
    const app = await boot({ focus_done: val, focus_dirty: '1', focus_rev: 'r-local' }, withRow);
    await settle();
    assert.equal(app.get('focus_dirty'), '1', `${label}: dirty must survive an untrusted comparison`);
    assert.equal(app.get('focus_rev'), 'r-local', `${label}: the base must not move`);
    assert.equal(app.get('focus_done'), val, `${label}: the damaged bytes must be left alone`);
    // ...and the boot must still have PUSHED. Marking the reconcile "done" in the catch would keep
    // `dirty` and the base correct while silently dropping the events-only push —
    // on the one branch the c3 fixtures never take.
    assert.ok(puts(app).length >= 1, `${label}: a damaged dirty boot must still drain analytics`);
  }
});

test('r2: with the server unreachable the notice claims nothing either way', async () => {
  // `_serverRowSeen` is TRI-state and its own comment says a boot whose GET failed "must not claim
  // either way" — but only two of the three states had a sentence, so the unknown state shipped the
  // no-row copy and asserted there is no saved copy. There may well be one.
  const offline = async (u) => {
    u = String(u);
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state')) throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' }, offline);
  assert.ok(noticeShown(app), 'the store is still damaged, so the notice still belongs');
  assert.ok(!/no saved copy|isn't saved|not saved/i.test(noticeText(app)),
    `must not assert an absence it never established: ${JSON.stringify(noticeText(app))}`);
  assert.equal(app.el('damaged-heal-setup').classList.contains('hidden'), false,
    'and must still offer the action, because trying is how you find out');
});

test('r3: the row-exists copy does not promise a copy of the DAMAGED key specifically', async () => {
  // `canHeal` means "a row exists", not "the row carries the key that is unreadable".
  // `applySyncedState` writes each key only if the row has one, so with a row whose `groups` is
  // null the "restore" deletes the damaged key rather than replacing it — under a sentence that
  // said the account had it. The copy must be true of what the action actually does.
  const ROW = { state: { channels: [], done: [], archive: [], groups: null },
    updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-server', kind: 'account' };
  const withRow = async (u, init = {}) => {
    u = String(u);
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state') && (init.method || 'GET') === 'PUT') return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-02T00:00:00.000Z', rev: 'r-put' }) };
    if (u.includes('/api/state')) return { ok: true, status: 200, json: async () => ROW };
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  const app = await boot({ focus_groups: CORRUPT, focus_channels: '[]', focus_archive: '[]', focus_dirty: '1' }, withRow);
  assert.ok(noticeShown(app));
  assert.ok(!/has a copy|your account has/i.test(noticeText(app)),
    `the account does not have this key: ${JSON.stringify(noticeText(app))}`);
  assert.ok(/account/i.test(noticeText(app)), 'but it must still name where the replacement comes from');
});

test('r4: every notice copy says that changes are paused', async () => {
  // The variant shown to the COMMON case (a row exists) omitted it, so the most likely damaged-store
  // user read a notice about restoring and nothing about why their taps did nothing.
  const rows = { true: null, false: null };
  const mk = (rowExists) => async (u, init = {}) => {
    u = String(u);
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state') && (init.method || 'GET') === 'PUT') return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-02T00:00:00.000Z', rev: 'r-put' }) };
    if (u.includes('/api/state')) return { ok: true, status: 200, json: async () => (rowExists
      ? { state: { channels: [], done: [], archive: [], groups: null }, updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r', kind: 'account' }
      : { state: null, updatedAt: null, kind: 'account' }) };
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  for (const rowExists of [true, false]) {
    const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]', focus_dirty: '1' }, mk(rowExists));
    assert.ok(/paused/i.test(noticeText(app)),
      `row=${rowExists}: the user must be told why their taps do nothing: ${JSON.stringify(noticeText(app))}`);
  }
  void rows;
});

test('r5: a refused write is never reported to the user as a success', async () => {
  // A false confirmation is worse than the silence the notice was built to fix: the user is told
  // "Marked done", the card slides away, and nothing was written. Measured on three paths.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  const before = app.get('focus_done');
  app.toasts.length = 0;
  const wrote = app.ctx.addDone('v-new');
  assert.equal(app.get('focus_done'), before, 'precondition: the write really was refused');
  assert.equal(wrote, false, 'a refused write must SAY it was refused, so its caller can too');
});

test('r6: the FEED notice element really exists in the markup', async () => {
  // `c13d` cannot pin this. The harness mints a stub for any
  // getElementById id, so `noticeShown(app, 'feed')` answers from a phantom whether the element is
  // in app/index.html or not.
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  for (const id of ['damaged-notice-feed', 'damaged-notice-feed-text', 'damaged-heal-feed',
                    'damaged-notice-setup', 'damaged-notice-setup-text', 'damaged-heal-setup',
                    'damaged-notice-archive', 'damaged-notice-archive-text', 'damaged-heal-archive']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `#${id} must exist in app/index.html`);
  }
  // And inside the right view, which the id alone does not establish.
  const feedView = html.slice(html.indexOf('id="view-feed"'), html.indexOf('id="view-archive"'));
  assert.ok(feedView.includes('damaged-notice-feed'), 'the feed notice must be inside #view-feed');
  const archiveView = html.slice(html.indexOf('id="view-archive"'));
  assert.ok(archiveView.includes('damaged-notice-archive'), 'and the archive notice inside #view-archive');
});

test('r7: a theme tap on a damaged store neither writes nor arms a push', async () => {
  // The only writes still reaching `schedulePush()` on a damaged store. Not merely unguarded: they
  // set `focus_dirty`, which syncOnLoad reads as "keep local, do NOT pull" — so a theme tap could
  // convert a store that would have AUTO-HEALED on the next clean boot into one that never does.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]', focus_last_view: 'setup' });
  assert.equal(app.get('focus_dirty'), null, 'precondition: nothing un-pushed yet');
  const ran = app.click(app.themeOpt('light'));
  assert.equal(ran, 1, 'precondition: the theme control is wired, so this is a real tap');
  assert.equal(app.get('focus_theme'), 'dark', 'the preference must not be written');
  assert.equal(app.get('focus_dirty'), null, 'and must not claim local is ahead of the row');
  assert.ok(app.toasts.some(t => /not saved/i.test(String(t))), 'and must say the tap did not take');
});

test('r8: an ordinary boot never deletes damaged bytes — only a consented repair does', async () => {
  // The repair sweep was on the boot path, so a routine pull silently `removeItem`d user bytes with
  // no action, no notice and nothing said.
  // A `focus_channels` holding `{"UC_a":{"name":"Alpha"}}` parses fine, still spells out a
  // readable channel name, and must not be deleted — manual recovery
  // works by reading exactly those bytes in devtools.
  const ROW = { state: { done: [], archive: [], groups: null },   // deliberately carries NO channels
    updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-server', kind: 'account' };
  const withRow = async (u, init = {}) => {
    u = String(u);
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state') && (init.method || 'GET') === 'PUT') return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-02T00:00:00.000Z', rev: 'r-put' }) };
    if (u.includes('/api/state')) return { ok: true, status: 200, json: async () => ROW };
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  const readable = '{"UC_a":{"name":"Alpha"},"UC_b":{"name":"Beta"}}';   // parses; wrong shape; human-readable
  const app = await boot({ focus_channels: readable, focus_archive: '[]', focus_last_view: 'setup' }, withRow);
  await settle();
  assert.equal(app.get('focus_channels'), readable,
    'a routine boot must not destroy the only recoverable artefact');
  assert.ok(noticeShown(app), 'it explains itself instead');

  // ...and the CONSENTED repair does clear it, so the app becomes writable again.
  app.click(app.el('damaged-heal-setup'));
  await settle();
  assert.equal(app.get('focus_channels'), null, 'the repair the user chose does clear it');
  app.ctx.saveChannels([{ id: 'UC_new', name: 'New' }]);
  assert.ok(String(app.get('focus_channels')).includes('UC_new'), 'and writes work afterwards');
});

test('c10d: a HEALTHY tweet cache is still written while a synced key is damaged', async () => {
  // An over-broad guard is invisible to `c10b`.
  // c10b damages the CACHE and checks a channels write; nothing exercised the reverse —
  // a readable cache while a synced key is damaged, which is the case that costs money. X is
  // pay-per-post, so blocking this makes the feed re-fetch every post on every load for as long
  // as read-only mode lasts.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  app.ctx.saveTweetCache({ UC_x: [{ id: 't9', text: 'fresh' }] });
  assert.ok(String(app.get('focus_tweet_cache')).includes('t9'),
    'the cache is device-local and never uploaded, so damage elsewhere must not block it');
});

// ── The targeted repair ──────────────────────────────────────────────────────
// The notice's action is not `adoptServerCopy`, which replaces EVERY key the row carries. With
// `dirty` set — and that IS the affected population, because a clean boot auto-heals — one tap
// would discard readable un-pushed work in the keys that were never damaged (50 read marks
// going to 0). The repair replaces only what is broken.

const ROWFULL = {
  state: { channels: [{ id: 'UC_row', name: 'Row' }], done: ['v-row'], archive: [], groups: null },
  updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-server', kind: 'account',
};
const rowFetch = (row = ROWFULL) => async (u, init = {}) => {
  u = String(u);
  if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
  if (u.includes('/api/state') && (init.method || 'GET') === 'PUT') return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-02T00:00:00.000Z', rev: 'r-put' }) };
  if (u.includes('/api/state')) return { ok: true, status: 200, json: async () => row };
  return { ok: true, status: 200, json: async () => ({ items: [] }) };
};

test('r9: the repair leaves READABLE un-pushed work alone', async () => {
  // The finding, inverted into a guarantee. `focus_channels` is unreadable; `focus_done` holds
  // three marks this device never managed to push. The row's `done` is a single different id, so a
  // wholesale adopt is directly observable as those three marks being replaced by it.
  const mine = JSON.stringify(['mine1', 'mine2', 'mine3']);
  const app = await boot({ focus_channels: CORRUPT, focus_done: mine, focus_archive: '[]', focus_dirty: '1' }, rowFetch());
  assert.ok(noticeShown(app), 'precondition: the notice is up');
  app.click(app.el('damaged-heal-setup'));
  await settle();

  assert.equal(app.get('focus_done'), mine, "un-pushed work in a key that was never damaged must survive");
  assert.deepEqual(JSON.parse(app.get('focus_channels')), ROWFULL.state.channels,
    'while the damaged key IS replaced from the row');
  assert.equal(app.get('focus_dirty'), '1',
    'and local is still ahead of the row, so dirty must stand — nothing was adopted');
  assert.equal(app.get('focus_rev'), null, 'nor may the base move: the base follows the DATA');
  assert.equal(noticeShown(app), false, 'the store is readable again');
});

test('r10: the repair clears a damaged key the row cannot replace, and nothing else', async () => {
  const mine = JSON.stringify(['mine1']);
  // The row carries no `groups`, so there is nothing to put there — clearing is the only repair.
  const app = await boot({ focus_groups: CORRUPT, focus_done: mine, focus_channels: '[]', focus_archive: '[]', focus_dirty: '1' }, rowFetch());
  app.click(app.el('damaged-heal-setup'));
  await settle();
  assert.equal(app.get('focus_groups'), null, 'the unreplaceable damaged key is cleared');
  assert.equal(app.get('focus_done'), mine, 'and the readable key is untouched');
  assert.equal(noticeShown(app), false, 'so the app is writable again');
  app.ctx.saveChannels([{ id: 'UC_new', name: 'New' }]);
  assert.ok(String(app.get('focus_channels')).includes('UC_new'), 'and writes actually work');
});

test('r11: a repair that cannot reach the server changes nothing at all', async () => {
  const mine = JSON.stringify(['mine1']);
  const offline = async (u) => {
    u = String(u);
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state')) throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  const app = await boot({ focus_channels: CORRUPT, focus_done: mine, focus_archive: '[]' }, offline);
  app.click(app.el('damaged-heal-setup'));
  await settle();
  assert.equal(app.get('focus_channels'), CORRUPT, 'a failed repair must leave the damaged bytes');
  assert.equal(app.get('focus_done'), mine, 'and everything else');
  assert.ok(noticeShown(app), 'and must keep saying so');
  assert.ok(app.toasts.some(t => /try again/i.test(String(t))), 'and tell the user to retry');
});

test('r12: the repair refuses a row from the wrong namespace', async () => {
  // The hardening `adoptServerCopy` carries must not be lost by the new path: `api/_session.js`
  // returns null on a DB blip as well as on expiry, so this GET can silently resolve to the DEVICE
  // namespace while the user is signed in.
  // `focus_dirty` so syncOnLoad takes the KEEP-LOCAL branch and never applies the row itself —
  // without it the boot would heal the store before the click, and this would pass on a store the repair
  // had never touched. (syncOnLoad checks `kind` too,
  // and refuses this device answer to a signed-in user at boot. `focus_dirty`
  // keeps this test independent of that boot check, so the click still exercises
  // only the repair's own refusal.)
  const wrongKind = { ...ROWFULL, kind: 'device' };
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]', focus_dirty: '1' }, rowFetch(wrongKind));
  app.click(app.el('damaged-heal-setup'));
  await settle();
  assert.equal(app.get('focus_channels'), CORRUPT, 'a response that does not SAY is refused, not guessed at');
  assert.ok(noticeShown(app));
});

test('r13: the notice appears on the ARCHIVE view too', async () => {
  // A refused un-archive showed nothing at all there — the silence the notice exists to prevent.
  const app = await boot({ focus_archive: CORRUPT, focus_channels: '[]' });
  app.ctx.showView('view-archive');
  assert.ok(noticeShown(app, 'archive'), 'the archive must explain it as well');
  assert.ok(/paused/i.test(noticeText(app, 'archive')));
});

test('r14: the repair and applySyncedState agree on which rows are acceptable', async () => {
  // The repair mirrors `applySyncedState`'s per-key acceptance, and two copies of a rule drift.
  // This pins them together: for a row whose every key is the WRONG type, neither path writes
  // anything, so a change to one that is not made to the other shows up here.
  const junk = { state: { channels: 'nope', done: 42, archive: {}, groups: [] },
    updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-server', kind: 'account' };
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]', focus_dirty: '1' }, rowFetch(junk));
  app.click(app.el('damaged-heal-setup'));
  await settle();
  assert.equal(app.get('focus_channels'), null,
    'a row value of the wrong type is not a replacement, so the damaged key is cleared instead');
  assert.equal(app.get('focus_archive'), '[]', 'and a readable key is never touched by a junk row');
});

test('r15: adopting the saved copy also clears a damaged key the row cannot replace', async () => {
  // The notice's action does not go through `adoptServerCopy`, so nothing else
  // exercises THAT path's own clearing. It still matters —
  // `adoptServerCopy` is the sync-conflict affordance and claims to leave the user on the saved
  // copy, so leaving them read-only afterwards would make "Using the saved copy" a false report.
  const ROW = { state: { channels: [{ id: 'UC_row', name: 'Row' }], done: [], archive: [], groups: null },
    updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r-server', kind: 'account' };
  const app = await boot({ focus_groups: CORRUPT, focus_channels: '[]', focus_archive: '[]', focus_dirty: '1' }, rowFetch(ROW));
  assert.equal(app.get('focus_groups'), CORRUPT, 'precondition: still damaged after the boot');
  await app.ctx.adoptServerCopy();
  await settle();
  assert.equal(app.get('focus_groups'), null, 'the adopt must leave nothing unreadable behind');
  assert.deepEqual(JSON.parse(app.get('focus_channels')), ROW.state.channels, 'and must have adopted the row');
  assert.equal(app.get('focus_dirty'), null, 'an adopt DOES clear dirty — unlike the targeted repair');
});

// ── Shape checks, mid-session damage and the way back to the feed ───────────

test('r16: a wrong-shaped focus_archive does not blank the boot', async () => {
  // Neutering the archive
  // shape check gives `visibleViews() === []` and `getArchive(...).map is not a function` —
  // a blank page. Every other archive fixture in the suite is UNPARSEABLE, so without this the SHAPE half of
  // the guard is pinned for `channels` and `done` and for neither of the other two.
  const app = createApp({ store: { ...HEALTHY, focus_channels: '[]', focus_archive: '{"a":1}' }, fetch: noRow });
  await assert.doesNotReject(() => app.ctx.init(), 'a non-array archive must not take down the boot');
  assert.deepEqual(app.visibleViews(), ['view-setup']);
});

test('r17: a wrong-shaped focus_groups is damage, and never reaches the row', async () => {
  // The same hole, milder: no blank page, but read-only lapses, the notice disappears, writes land
  // and `collectSyncedState` PUTs the wrong shape at the account row.
  const app = await boot({ focus_groups: '[]', focus_channels: '[]', focus_archive: '[]' });
  assert.ok(noticeShown(app), 'a parseable wrong shape is damage like any other');
  const before = puts(app).length;
  app.ctx.schedulePush();
  app.advance(2000);
  await settle();
  const sent = puts(app).slice(before);
  assert.equal(sent.length, 1);
  assert.ok(!('state' in sent[0]), 'and must not be uploaded');
});

test('r18: the repair action is wired on ALL THREE views, not just setup', async () => {
  // Nothing asserted the feed or archive buttons were connected to anything — a dead "Restore from
  // my account" on two of the three screens it appears on, which is indistinguishable from a
  // handler that correctly did nothing.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]' });
  for (const view of ['setup', 'feed', 'archive']) {
    assert.equal(app.el(`damaged-heal-${view}`).listeners.filter(l => l.type === 'click').length, 1,
      `#damaged-heal-${view} must be wired`);
  }
});

test('r19: the repair also clears a damaged TWEET CACHE', async () => {
  // The heal loop must span PROTECTED_KEYS, not just the synced four: narrowing it leaves a damaged
  // cache unrepairable for the life of the profile, so `saveTweetCache` is blocked forever and a
  // pay-per-post source is re-fetched on every load, permanently.
  const app = await boot({ focus_tweet_cache: CORRUPT, focus_channels: CORRUPT, focus_archive: '[]', focus_dirty: '1' }, rowFetch());
  app.click(app.el('damaged-heal-setup'));
  await settle();
  assert.equal(app.get('focus_tweet_cache'), null, 'the cache must be repaired too');
  app.ctx.saveTweetCache({ UC_z: [{ id: 't1' }] });
  assert.ok(String(app.get('focus_tweet_cache')).includes('t1'), 'and writable again afterwards');
});

test('r20: a channel whose name is the EMPTY STRING falls back rather than rendering blank', async () => {
  // `channelName`'s `&& c.name` guard. Without it an empty name is returned as-is: a blank row and
  // a blank avatar letter, which reads as a corrupted channel rather than an unnamed one.
  const app = await boot({ focus_channels: '[{"id":"UC_a","name":""}]', focus_archive: '[]', focus_last_view: 'setup' });
  assert.ok(rows(app).includes('Channel'), `expected the fallback, got: ${rows(app).slice(0, 200)}`);
});

test('r21: damage appearing MID-SESSION raises the notice on the next refused write', async () => {
  // Why `refuseWrite()` repaints at all. Every other repaint hangs off a view change or a channel
  // -list render, so nothing covered the case the notice most needs to handle: a healthy boot, a
  // quota-aborted write corrupting a key while the user reads, and then a tap. Without this the
  // toast says "Not saved" over a screen that never explains why — a
  // "button looks dead" failure with an extra step.
  const app = await boot({ focus_channels: '[{"id":"UC_a","name":"Alpha"}]', focus_archive: '[]' });
  app.ctx.showView('view-feed');
  assert.equal(noticeShown(app, 'feed'), false, 'precondition: a healthy session shows nothing');

  app.set('focus_done', '');            // the quota-abort residue, arriving mid-session
  app.ctx.addDone('v-new');             // a tap, with NO navigation and no list render

  assert.ok(noticeShown(app, 'feed'), 'the refusal itself must raise the explanation');
  assert.equal(app.get('focus_done'), '', 'and the write must still have been refused');
});

test('r22: after a repair the "Open my feed" button comes back', async () => {
  // The boot hides `#btn-go` because a damaged `focus_channels` reads as zero channels; the repair
  // restores them but never re-ran `toggleGoButton`, so the user is left on setup WITH their
  // channels listed and no way to reach the feed. `toggleGoButton()` sits beside
  // `renderChannelList()` at every other call site in the file; both repaint blocks omitted it.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]', focus_dirty: '1' }, rowFetch());
  assert.equal(app.el('btn-go').classList.contains('hidden'), true,
    'precondition: nothing readable, so the button is correctly hidden');

  app.click(app.el('damaged-heal-setup'));
  await settle();

  assert.ok(JSON.parse(app.get('focus_channels')).length > 0, 'precondition: the repair restored channels');
  assert.equal(app.el('btn-go').classList.contains('hidden'), false,
    'the way out of setup must come back with them');
});

test('r23: adopting the saved copy brings the button back too', async () => {
  // The same omission in `adoptServerCopy`, which the damaged-store notice makes reachable.
  const app = await boot({ focus_channels: CORRUPT, focus_archive: '[]', focus_dirty: '1' }, rowFetch());
  assert.equal(app.el('btn-go').classList.contains('hidden'), true, 'precondition');
  await app.ctx.adoptServerCopy();
  await settle();
  assert.equal(app.el('btn-go').classList.contains('hidden'), false,
    'the adopt affordance must leave a usable screen too');
});
