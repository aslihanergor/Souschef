// The boot must not act on a state row the sign-in answer contradicts.
//
// `GET /api/state` answers from whichever namespace the SERVER resolved — the account when the
// session cookie checks out, the device otherwise — and says which in `kind`. `/api/auth/me` is a
// separate request that can disagree with it: it times out, or the session lookup blips
// on one query and not the other (`api/_session.js` returns null on a DB error). `init` runs the two
// concurrently, and `syncOnLoad` used to act on whatever the state read returned:
//
//   - signed-out answer + account row → a browser showing the sign-in wall was handed the account's
//     channels, and the next brand-new account signed in on it uploaded them as its own;
//   - signed-in answer + device row → a signed-in user's channels were replaced by the device's stale
//     copy, or with no device row her list was uploaded into the anonymous device row.
//
// `_readOwnRow` already refused this for "Use saved copy". The boot is the other reader.
//
// THE REFUSAL IS DIRECTION-AWARE:
//   - SIGNED IN, the DEVICE answered → nothing in that answer is hers: refuse everything (c4-c7, c5c).
//   - WALLED, the ACCOUNT answered → the cookie is valid. Refuse only PULLING the account into this
//     browser (c1, c3). Uploading this browser's own copy to that account — the no-row claim and the
//     dirty push — is what the next healthy boot does anyway; refusing it would only defer it, and the
//     deferral loses data (c2, c2b, c2c, c2d).
//
// These run the REAL app.js through the harness against the REAL `createStateHandler` over one shared
// fake store, so "what the account row holds afterwards" is observed, not inferred from requests.
//
// FIXTURE SIZING, because two guards stopping the same input pin neither: FIVE writes follow the state
// read — the apply and its re-base (c1, c4), the no-row claim (c2, c5a), the dirty reconcile (c5b), the
// dirty push (c2b, c5c), the grant of standing (c6, c4b) — plus the row-existence record (c7, c7b). Each
// test is built to reach one of them, though a test that observes the end state can see more than one:
// c6b checks that local is kept, so an apply leaking through reds it as well as a leak of standing.
//
// CONTROLS, which pass with or without the refusal: c2, c2b, c2c and c2d — they pin uploads a walled
// boot must keep making — plus c8–c10c, c14, c15a and c15b. c10c is what stops a
// fix that refuses every signed-out answer; c8 and c14 pin that both requests start together and that
// the boot waits for the sign-in answer; c15a/c15b pin that waiting adds no way to lose those uploads.
// c13 is NOT a control: without the refusal its walled browser holds all
// six synced keys. It pins that one sign-in answer decides both the check and the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';
import { createStateHandler } from '../api/state.js';
import { fakeDb, fakeReq, fakeRes, toCharUS } from '../test-helpers/handler.mjs';

const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const BOB_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE = { accountId: ALICE_ID, email: 'alice@example.com' };
const BOB = { accountId: BOB_ID, email: 'bob@example.com' };

const chans = (id) => [{ id, name: `${id} name`, keyword: '', source: 'youtube' }];
const settle = () => new Promise((r) => setImmediate(r));
const lowerKeys = (h = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

// Every synced key carries a value on the row, so "this key was not written" cannot pass merely
// because the row never offered it.
const ALICE_ROW = {
  channels: chans('UC_alice'),
  done: ['alice-done'],
  archive: [{ id: 'alice-archived', source: 'youtube' }],
  theme: 'dark',
  shorts: 'false',
  groups: { assignments: {}, groups: {}, unfiled: [] },
};
const SYNCED = ['focus_channels', 'focus_done', 'focus_archive', 'focus_theme', 'focus_include_shorts', 'focus_groups'];

/** An app wired to the real state handler. `me` is what /api/auth/me does: an account (200),
 *  401, or 'abort' — or an ARRAY of those, answered in order, one per request (c13). `stateSession`
 *  is what the STATE handler resolves — settable, so a blip can end after the boot read.
 *  `stateFails` answers the boot's GET with a 500 at once (c14). `order` holds one boot request until
 *  the other has answered and settled. */
function rig({ sql = fakeDb(), store = {}, me, stateSession, order = 'natural', search = '', stripKind = false, stateFails = false }) {
  let session = stateSession;
  const handler = createStateHandler({ db: () => sql, sessionAccount: async () => session });
  const app = createApp({ store: { focus_device_id: DEVICE_ID, ...store }, search });
  const puts = [];
  const meQueue = Array.isArray(me) ? [...me] : null;
  let releaseMe = () => {}, releaseState = () => {}, meAnswered, stateAnswered;
  const meGate = order === 'state-first' ? new Promise((r) => { releaseMe = r; }) : null;
  const stateGate = order === 'me-first' ? new Promise((r) => { releaseState = r; }) : null;
  const meDone = new Promise((r) => { meAnswered = r; });
  const stateDone = new Promise((r) => { stateAnswered = r; });
  app.setFetch(async (url, init) => {
    const method = init.method || 'GET';
    if (url.includes('/api/auth/me')) {
      if (meGate) await meGate;
      const answer = meQueue ? (meQueue.length > 1 ? meQueue.shift() : meQueue[0]) : me;
      try {
        if (answer === 'abort') { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
        if (answer === 401) return { ok: false, status: 401, json: async () => ({ error: 'not signed in' }) };
        return { ok: true, status: 200, json: async () => ({ email: answer.email }) };
      } finally { meAnswered(); }
    }
    if (url.includes('/api/auth/logout')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.includes('/api/state')) {
      if (method === 'GET' && stateGate) await stateGate;
      if (method === 'GET' && stateFails) { stateAnswered(); return { ok: false, status: 500, json: async () => ({ error: 'read failed' }) }; }
      const res = fakeRes();
      await handler(fakeReq({ method, headers: lowerKeys(init.headers), body: init.body ?? null }), res);
      if (method === 'PUT') puts.push(JSON.parse(init.body));
      const body = JSON.parse(JSON.stringify(res.body ?? {}));
      if (method === 'GET') { if (stripKind) delete body.kind; stateAnswered(); }
      return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => body };
    }
    if (url.includes('/api/feed')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
    throw new Error(`unrouted request: ${url}`);
  });
  // The held request is released only once the OTHER one has answered. That wait is BOUNDED, and the
  // bound is an assertion, not a convenience: a boot that issues the two requests one after the other
  // never sends the second while the first is held, so an unbounded wait deadlocks, node CANCELS the
  // test instead of failing it — "this proved nothing". That is the shape of
  // init awaiting checkAuth before starting syncOnLoad. Bounded, the same defect is
  // a named failure, and init's claim that the boot waits for the slower request, not the sum, is pinned.
  const answeredWhileHeld = async (done, held, release) => {
    let arrived = false;
    done.then(() => { arrived = true; });
    for (let i = 0; i < 50 && !arrived; i++) await settle();
    if (!arrived) release();   // let the stranded boot finish rather than leave it pending
    assert.ok(arrived, `the boot did not answer the ${held === 'me' ? 'state read' : 'sign-in check'} while the `
      + `${held === 'me' ? 'sign-in check' : 'state read'} was held — the two boot requests must start together`);
  };
  const boot = async () => {
    const booting = app.ctx.init();
    if (order === 'state-first') { await answeredWhileHeld(stateDone, 'me', releaseMe); for (let i = 0; i < 3; i++) await settle(); releaseMe(); }
    if (order === 'me-first') { await answeredWhileHeld(meDone, 'state', releaseState); for (let i = 0; i < 3; i++) await settle(); releaseState(); }
    await booting;
    await drain(app);
  };
  return { app, sql, puts, boot, endBlip: (s) => { session = s; } };
}
async function drain(app) { for (let i = 0; i < 6; i++) { app.runTimers(4); await settle(); } }
const statePuts = (puts) => puts.filter((p) => 'state' in p);
const ids = (raw) => (raw == null ? raw : JSON.parse(raw).map((c) => c.id));
const rowIds = (row) => (row ? (row.state.channels || []).map((c) => c.id) : null);

// ── Criteria 1–3: a walled browser is not handed the account's data ─────────────────

for (const [label, me] of [['aborts', 'abort'], ['answers a definite 401', 401]]) {
  test(`[BUG-063] c1${me === 'abort' ? 'a' : 'b'}: a walled boot is not handed the account row when the sign-in check ${label}`, async () => {
    const r = rig({ sql: fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] }), me, stateSession: ALICE, search: '?auth=ok' });
    await r.boot();
    assert.deepEqual([...r.app.visibleViews()], ['view-landing'], 'guard: the browser is walled');
    for (const k of SYNCED) {
      assert.equal(r.app.get(k), null, `${k} was written into a walled browser: ${r.app.get(k)}`);
    }
    assert.equal(r.app.get('focus_rev'), null, 'and it must not be based on a row it may not hold');
  });
}

test('[BUG-063] c1c: a walled browser that already holds data is not handed the account row either', async () => {
  // c1a and c1b start from a FRESH store, and c2-c2d take the
  // no-row claim or the dirty branch, so a pull guard that fired only for an EMPTY store would pass
  // all of them — while a walled browser holding data must
  // "still receive nothing". Unguarded, this is the leak with a signed-out visitor's channels in place:
  // the walled browser takes Alice's row, and the next brand-new account adopts it.
  // Not dirty, and the account has a row, so neither upload can fire and only the pull is under test.
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });
  const visitor = { focus_channels: JSON.stringify(chans('UC_legacy')), focus_done: JSON.stringify(['legacy-done']) };
  const rowBefore = JSON.stringify(sql.get('account', ALICE_ID).state);
  const walled = rig({ sql, store: visitor, me: 'abort', stateSession: ALICE, search: '?auth=ok' });
  await walled.boot();
  assert.deepEqual([...walled.app.visibleViews()], ['view-landing'], 'guard: the browser is walled');
  assert.equal(JSON.stringify(sql.get('account', ALICE_ID).state), rowBefore, 'guard: nothing was uploaded, so only the pull could act');
  for (const k of SYNCED) {
    assert.equal(walled.app.get(k), visitor[k] ?? null, `${k} was replaced by the account row in a walled browser: ${walled.app.get(k)}`);
  }
  assert.equal(walled.app.get('focus_rev'), null, 'and it must not be based on a row it does not hold');
  const bob = rig({ sql, store: Object.fromEntries(walled.app.store), me: BOB, stateSession: BOB, search: '?auth=ok' });
  await bob.boot();
  const bobRow = sql.get('account', BOB_ID);
  assert.ok(!(rowIds(bobRow) || []).includes('UC_alice') && !((bobRow && bobRow.state.done) || []).includes('alice-done'),
    `Bob's new account inherited Alice's data: ${JSON.stringify(bobRow && bobRow.state)}`);
});

test('[BUG-063] c2: a walled boot still uploads this browser\'s own copy to the account behind the cookie', async () => {
  // The OPPOSITE rule — "a walled boot claims nothing" — costs data. The
  // claim sends THIS BROWSER's copy to the account the valid cookie names, which is exactly what the
  // next healthy boot does moments later, so refusing it protects nothing; it only DEFERS the
  // adoption, and the deferral loses a signed-out browser's channels when another device creates the
  // row first (c2c). Only PULLING the account into a walled browser is the leak (c1, c3).
  // The no-row branch, not the apply: the account has no row and local holds channels. Analytics must
  // still leave — the wall's own metric rides them.
  const r = rig({ store: { focus_channels: JSON.stringify(chans('UC_local')) }, me: 'abort', stateSession: ALICE });
  await r.boot();
  assert.deepEqual([...r.app.visibleViews()], ['view-landing'], 'guard: the browser is walled');
  assert.deepEqual(rowIds(r.sql.get('account', ALICE_ID)), ['UC_local'],
    'the adoption main performs on this boot must still happen');
  assert.ok(r.puts.some((p) => (p.events || []).some((e) => e.name === 'landing_view')),
    'analytics still go out on a walled boot');
});

/** A store holding every key Alice's row holds, plus `extra` channels she has not pushed yet. */
function aliceStoreWith(extra, sql, more = {}) {
  return {
    focus_channels: JSON.stringify([...ALICE_ROW.channels, ...extra]),
    focus_done: JSON.stringify(ALICE_ROW.done),
    focus_archive: JSON.stringify(ALICE_ROW.archive),
    focus_theme: ALICE_ROW.theme,
    focus_include_shorts: ALICE_ROW.shorts,
    focus_groups: JSON.stringify(ALICE_ROW.groups),
    focus_rev: toCharUS(sql.get('account', ALICE_ID).updated_at),
    focus_was_authed: '1',
    ...more,
  };
}

test('[BUG-063] c2b: a walled boot still uploads un-pushed work to the account behind the cookie', async () => {
  // The dirty keep-local push — the fifth write after the state read, reached here for a
  // contradicted answer. Walled, it sends this browser's un-pushed work to its
  // own account under its own base; deferring it would lose the work when the session
  // ends before the next healthy boot (c2d).
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });
  const r = rig({ sql, store: aliceStoreWith(chans('UC_unpushed'), sql, { focus_dirty: '1' }), me: 'abort', stateSession: ALICE });
  await r.boot();
  assert.deepEqual([...r.app.visibleViews()], ['view-landing'], 'guard: the browser is walled');
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_unpushed'], 'the un-pushed work must reach the account');
  assert.equal(r.app.get('focus_dirty'), null, 'and stop being marked un-pushed');
});

test('[BUG-063] c3: a new account signed in after the walled boot does not inherit the account row', async () => {
  // The harm, measured end to end: Bob's own first boot on the browser Alice's row reached.
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });
  const walled = rig({ sql, me: 'abort', stateSession: ALICE, search: '?auth=ok' });
  await walled.boot();
  const bob = rig({ sql, store: Object.fromEntries(walled.app.store), me: BOB, stateSession: BOB, search: '?auth=ok' });
  await bob.boot();
  assert.equal(sql.get('account', BOB_ID), undefined,
    `Bob's new account was created holding ${JSON.stringify(rowIds(sql.get('account', BOB_ID)))}`);
});

test('[BUG-063] c2c: a walled first sign-in keeps a signed-out browser\'s channels when another device creates the row first', async () => {
  // A browser holding channels
  // from before sign-in was mandatory, walled on the magic-link boot, then the same person adds a
  // channel on their phone — which creates the account row — and comes back. Refusing the walled
  // claim would leave the row to the phone, and the next boot would pull it over the old channels.
  const sql = fakeDb();
  const legacy = rig({ sql, store: { focus_channels: JSON.stringify(chans('UC_legacy')) }, me: 'abort', stateSession: ALICE, search: '?auth=ok' });
  await legacy.boot();
  const phone = rig({ sql, store: { focus_device_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, me: ALICE, stateSession: ALICE });
  await phone.boot();
  phone.app.ctx.saveChannels([...JSON.parse(phone.app.get('focus_channels') || '[]'), ...chans('UC_phone')]);
  await drain(phone.app);
  const back = rig({ sql, store: Object.fromEntries(legacy.app.store), me: ALICE, stateSession: ALICE });
  await back.boot();
  assert.deepEqual([...rowIds(sql.get('account', ALICE_ID))].sort(), ['UC_legacy', 'UC_phone'],
    'the account must hold both the old channels and the one added on the phone');
  assert.deepEqual([...ids(back.app.get('focus_channels'))].sort(), ['UC_legacy', 'UC_phone'], 'and so must the browser');
});

test('[BUG-063] c2d: un-pushed work from a walled boot survives the session ending before the next boot', async () => {
  // The consequence of deferring c2b's push: walled with un-pushed work, then a boot whose
  // session has ended saves that work into the DEVICE row and clears dirty, and the next sign-in pulls
  // the account row over it. It needs two abnormal boots.
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });
  const walled = rig({ sql, store: aliceStoreWith(chans('UC_unpushed'), sql, { focus_dirty: '1' }), me: 'abort', stateSession: ALICE });
  await walled.boot();
  const ended = rig({ sql, store: Object.fromEntries(walled.app.store), me: 401, stateSession: null });
  await ended.boot();
  const back = rig({ sql, store: Object.fromEntries(ended.app.store), me: ALICE, stateSession: ALICE, search: '?auth=ok' });
  await back.boot();
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_unpushed'], 'the work must have reached the account');
});

// ── Criteria 4–7: a signed-in user whose state read resolved to the device ──────────

/** Alice is signed in and her store is her own current copy, based on her account row. The boot's
 *  state read hits a session blip and resolves to this browser's DEVICE namespace. */
function blipRig({ deviceState = undefined, store = {}, omit = [] } = {}) {
  const users = [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }];
  if (deviceState) users.push({ kind: 'device', id: DEVICE_ID, state: deviceState });
  const sql = fakeDb({ users });
  const aliceRev = toCharUS(sql.get('account', ALICE_ID).updated_at);
  const local = {
    focus_channels: JSON.stringify(chans('UC_alice_local')),
    focus_done: JSON.stringify(['alice-local-done']),
    focus_archive: JSON.stringify([]),
    focus_theme: 'dark',
    focus_include_shorts: 'false',
    focus_groups: JSON.stringify({ assignments: {}, groups: {}, unfiled: [] }),
    focus_rev: aliceRev,
    focus_was_authed: '1',
    ...store,
  };
  for (const k of omit) delete local[k];
  const r = rig({ sql, store: local, me: ALICE, stateSession: null });
  return { ...r, local, aliceRev };
}
const STALE_DEVICE = { channels: chans('UC_stale_device'), done: ['stale-done'], archive: [], theme: 'light', shorts: 'true', groups: null };

test('[BUG-102] c4: a signed-in boot does not apply a device row, nor re-base onto it', async () => {
  const r = blipRig({ deviceState: STALE_DEVICE });
  await r.boot();
  for (const k of SYNCED) {
    assert.equal(r.app.get(k), r.local[k], `${k} was replaced by the device row: ${r.app.get(k)}`);
  }
  assert.equal(r.app.get('focus_rev'), r.aliceRev, 'the base must stay on the account row');
});

test('[BUG-102] c4b: a signed-in browser holding nothing gains neither the device row nor standing', async () => {
  // Every blipRig seeds Alice's local copy, so a refusal that
  // fired only when local HOLDS data would pass every other test. On an empty browser the pull is still
  // stopped further down, so what leaks is STANDING: a later tap claims state from a document that never
  // read its own row. Unguarded, the device row is simply applied. A fresh browser, on its first sign-in.
  // "Not written FROM THE ROW", not "null": the boot writes `focus_include_shorts: 'true'` on an empty
  // browser whatever the server holds (measured with a device row saying 'false', and with none), so
  // every value below differs from what an empty browser writes for itself.
  const device = { channels: chans('UC_stale_device'), done: ['stale-done'], archive: [{ id: 'stale-archived', source: 'youtube' }],
    theme: 'light', shorts: 'false', groups: { assignments: { p1: 'g_stale' }, groups: {}, unfiled: [] } };
  const offered = { focus_channels: JSON.stringify(device.channels), focus_done: JSON.stringify(device.done),
    focus_archive: JSON.stringify(device.archive), focus_theme: device.theme, focus_include_shorts: device.shorts,
    focus_groups: JSON.stringify(device.groups) };
  const sql = fakeDb({ users: [
    { kind: 'account', id: ALICE_ID, state: ALICE_ROW },
    { kind: 'device', id: DEVICE_ID, state: device },
  ] });
  const r = rig({ sql, me: ALICE, stateSession: null });
  await r.boot();
  for (const k of SYNCED) assert.notEqual(r.app.get(k), offered[k], `${k} was written from the device row: ${r.app.get(k)}`);
  assert.equal(r.app.get('focus_rev'), null, 'and nothing may be based on it');
  r.endBlip(ALICE);                       // every request after the boot read is healthy
  r.puts.length = 0;
  assert.equal(r.app.click(r.app.themeOpt('light')), 1, 'guard: the theme control is wired');
  await drain(r.app);
  assert.deepEqual(statePuts(r.puts).map((p) => (p.state.channels || []).map((c) => c.id)), [],
    'the tap claimed state on a document with no standing');
});

test('[BUG-102] c5a: a signed-in boot answered "no device row" uploads nothing into the device namespace', async () => {
  const r = blipRig();
  await r.boot();
  assert.deepEqual(statePuts(r.puts).map((p) => p.state.channels.map((c) => c.id)), [],
    "the account's list was pushed while the device namespace was answering");
  assert.equal(r.sql.get('device', DEVICE_ID), undefined, 'so no device row may exist afterwards');
});

test('[BUG-102] c5b: a dirty store equal to the contradicting row keeps dirty and does not take its rev', async () => {
  // The quiet reconcile: "local is byte-identical to the row, so nothing is un-pushed". True of a row
  // this browser may write to; a statement about the WRONG row, so it may not clear dirty or re-base.
  // Every synced key matches across the two sides — `sameSyncedState` compares the union of keys, so a
  // key that differed would read as "different" and pin nothing. `focus_groups` is ABSENT locally and
  // null on the row, and still counts as matching: c5b fails without the refusal, which it
  // can only do by reaching the reconcile.
  const same = { channels: chans('UC_alice_local'), done: ['alice-local-done'], archive: [], theme: 'dark', shorts: 'false', groups: null };
  const r = blipRig({ deviceState: same, store: { focus_dirty: '1' }, omit: ['focus_groups'] });
  await r.boot();
  assert.equal(r.app.get('focus_dirty'), '1', 'dirty was cleared on the strength of a device row');
  assert.equal(r.app.get('focus_rev'), r.aliceRev, 'and the base must not move onto the device row');
});

test('[BUG-102] c5c: a signed-in boot answered by the device does not push un-pushed work, and keeps it marked', async () => {
  // The dirty keep-local push in the OTHER direction. The work is this user's own, but the answer came
  // from the device namespace, and main's push landed there too and was refused behind "Not syncing" —
  // a notice whose action replaces the work. Keeping `dirty` set is what lets the next healthy boot push it.
  const r = blipRig({ deviceState: STALE_DEVICE, store: {
    focus_channels: JSON.stringify([...chans('UC_alice_local'), ...chans('UC_unpushed')]), focus_dirty: '1' } });
  await r.boot();
  assert.deepEqual(statePuts(r.puts).map((p) => p.state.channels.map((c) => c.id)), [],
    'un-pushed work was pushed on an answer from the device namespace');
  assert.equal(r.app.get('focus_dirty'), '1', 'the work must stay marked for the next healthy boot');
  assert.equal(r.app.get('focus_channels'), r.local.focus_channels, 'and stay on the device');
});

test('[BUG-102] c6a: a contradicted answer grants no standing — a later tap does not claim state', async () => {
  const r = blipRig({ deviceState: STALE_DEVICE });
  await r.boot();
  r.endBlip(ALICE);                       // every request after the boot read is healthy
  r.puts.length = 0;
  assert.equal(r.app.click(r.app.themeOpt('light')), 1, 'guard: the theme control is wired');
  await drain(r.app);
  assert.equal(r.app.get('focus_dirty'), null, 'a browser that never read its own row cannot know it is ahead');
  assert.deepEqual(statePuts(r.puts).map((p) => p.state.channels.map((c) => c.id)), [],
    'the tap claimed state on a document with no standing');
});

test('[BUG-102] c6b: after a contradicted answer, sign-out refuses instead of offering the destructive warning', async () => {
  const r = blipRig({ deviceState: STALE_DEVICE });
  await r.boot();
  r.endBlip(ALICE);
  const rowBefore = JSON.stringify(r.sql.get('account', ALICE_ID).state);
  r.app.toasts.length = 0;
  await r.app.ctx.signOut();
  for (let i = 0; i < 4; i++) await settle();
  assert.ok(r.app.el('acct-signout-confirm').classList.contains('hidden'),
    `the warning whose second press discards local data was shown; toasts: ${JSON.stringify(r.app.toasts)}`);
  assert.ok(r.app.toasts.includes("Not signed out — couldn't save your changes"),
    `expected the recoverable refusal; toasts: ${JSON.stringify(r.app.toasts)}`);
  assert.equal(r.app.get('focus_channels'), r.local.focus_channels, 'local is kept');
  assert.equal(JSON.stringify(r.sql.get('account', ALICE_ID).state), rowBefore, 'and the account row is untouched');
});

test('[BUG-102] c7: after a contradicted answer, whether a row exists stays unknown', async () => {
  // Damage a key the device row does NOT carry, so the damage survives the boot on either code and
  // the notice shows either way — only the COPY can differ, and it differs only on `_serverRowSeen`.
  const r = blipRig({ deviceState: { channels: chans('UC_stale_device') }, store: { focus_archive: '' } });
  await r.boot();
  assert.equal(r.app.el('damaged-notice-setup').classList.contains('hidden'), false, 'guard: the store is damaged and the notice shows');
  assert.match(r.app.el('damaged-notice-setup-text').textContent, /We couldn't reach your account/,
    'the notice claimed to know whether a row exists');
});

test('[BUG-102] c7b: with no device row either, the notice still does not claim there is no saved copy', async () => {
  // c7 seeds a device row, so the only wrong copy it can produce
  // is the ROW copy, and "not the no-row copy" cannot fail there. Here the device namespace
  // has no row: unguarded, the boot records "no row", says "There's no saved copy to restore from" and
  // hides the repair — while the account HAS one. `focus_archive: ''` damages the store, so the notice
  // shows either way and the no-row claim is stopped; what differs is what the notice says.
  const r = blipRig({ store: { focus_archive: '' } });
  await r.boot();
  assert.equal(r.app.el('damaged-notice-setup').classList.contains('hidden'), false, 'guard: the store is damaged and the notice shows');
  const text = r.app.el('damaged-notice-setup-text').textContent;
  assert.doesNotMatch(text, /There's no saved copy/, 'the notice asserted no saved copy exists, from the device namespace');
  assert.match(text, /We couldn't reach your account/, 'it must say the account could not be checked');
});

// ── Criteria 8–10: controls — the fix must not refuse a legitimate user ─────────────────────────

for (const order of ['state-first', 'me-first']) {
  test(`[BUG-063] c8${order === 'state-first' ? 'a' : 'b'}: a signed-in user gets her own row whichever boot request answers first (${order})`, async () => {
    // state-first is the one that matters: a check that reads `_authEmail` without waiting for the
    // sign-in answer refuses her own row here and boots her onto an empty setup screen.
    const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });
    const r = rig({ sql, me: ALICE, stateSession: ALICE, order });
    await r.boot();
    assert.deepEqual(ids(r.app.get('focus_channels')), ['UC_alice'], 'her own row must be applied');
    assert.equal(r.app.get('focus_rev'), toCharUS(sql.get('account', ALICE_ID).updated_at), 'and based on');
    assert.deepEqual([...r.app.visibleViews()], ['view-feed'], 'she lands on her feed');
    r.puts.length = 0;
    r.app.click(r.app.themeOpt('light'));
    await drain(r.app);
    assert.equal(statePuts(r.puts).length, 1, 'and the document has standing: a tap syncs');
  });
}

test('[BUG-063] c9: an answer that does not say which namespace answered is still applied (Asli: "only a wrong label")', async () => {
  // A deliberate decision, pinned so tightening it cannot land silently: the real server labels every
  // answer (test/sync-conflict.test.mjs), so refusing an unlabelled one has to be a deliberate change.
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });
  const r = rig({ sql, me: ALICE, stateSession: ALICE, stripKind: true });
  await r.boot();
  assert.deepEqual(ids(r.app.get('focus_channels')), ['UC_alice']);
  assert.equal(r.app.get('focus_rev'), toCharUS(sql.get('account', ALICE_ID).updated_at));
});

test('[BUG-063] c10a: an ordinary signed-in boot applies its row', async () => {
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });
  const r = rig({ sql, me: ALICE, stateSession: ALICE });
  await r.boot();
  for (const k of SYNCED) assert.notEqual(r.app.get(k), null, `${k} was not applied`);
  assert.deepEqual(ids(r.app.get('focus_channels')), ['UC_alice']);
});

test('[BUG-063] c10b: a signed-out browser\'s channels are still adopted by a new account ([TASK-084] criterion 4)', async () => {
  const sql = fakeDb();
  const legacy = { focus_channels: JSON.stringify(chans('UC_legacy')), focus_done: JSON.stringify(['legacy-done']) };
  const walled = rig({ sql, store: legacy, me: 401, stateSession: null });
  await walled.boot();
  const alice = rig({ sql, store: Object.fromEntries(walled.app.store), me: ALICE, stateSession: ALICE, search: '?auth=ok' });
  await alice.boot();
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_legacy'], 'the promised adoption on first sign-in');
});

test('[BUG-063] c10c: a signed-out browser is still handed its own device row', async () => {
  // A control. c8-c10b are all signed-in or do their real work on a signed-in
  // boot, so a fix that refused EVERY signed-out answer would pass them.
  const sql = fakeDb({ users: [{ kind: 'device', id: DEVICE_ID, state: { channels: chans('UC_device'), done: ['device-done'] } }] });
  const r = rig({ sql, me: 401, stateSession: null });
  await r.boot();
  assert.deepEqual([...r.app.visibleViews()], ['view-landing'], 'guard: signed out, so walled');
  assert.deepEqual(ids(r.app.get('focus_channels')), ['UC_device'], 'the device namespace is this browser\'s own, and must still apply');
});

// ── c13–c14: one sign-in answer, and the boot waits for it ───────────────────────────────────────

test('[BUG-063] c13: one boot asks who is signed in exactly once, so the check and the screen cannot disagree', async () => {
  // `init` handing syncOnLoad a SECOND checkAuth() rather than the same
  // promise reproduces the original leak end to end — the check
  // deciding on one answer and the screen on another. Here the two answers would disagree: the first
  // request times out, any second one says Alice.
  const r = rig({ sql: fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] }), me: ['abort', ALICE], stateSession: ALICE, search: '?auth=ok' });
  await r.boot();
  assert.equal(r.app.urls().filter((u) => u.includes('/api/auth/me')).length, 1, 'the boot must ask exactly once');
  assert.deepEqual([...r.app.visibleViews()], ['view-landing'], 'the one answer walled the browser');
  // Every synced key and the base, not only channels: a leak of the other five would pass a
  // check that read `focus_channels` alone.
  for (const k of SYNCED) {
    assert.equal(r.app.get(k), null, `and the check agreed with it: nothing was handed over, but ${k} holds ${r.app.get(k)}`);
  }
});

test('[BUG-063] c14: the boot waits for the sign-in answer even when the state read fails at once', async () => {
  // Pins `init` awaiting the sign-in answer directly, rather than through unrelated
  // assertions that depend on microtask counts. syncOnLoad returns early on a failed read WITHOUT
  // reaching its own await, so only init's wait stops the screen being decided before sign-in resolves.
  const r = rig({ store: { focus_channels: JSON.stringify(chans('UC_alice')), focus_was_authed: '1' }, me: ALICE, stateSession: ALICE, order: 'state-first', stateFails: true });
  await r.boot();
  assert.deepEqual([...r.app.visibleViews()], ['view-feed'], 'a signed-in user whose state read failed still reaches her feed');
  assert.ok(r.app.el('btn-feed-manage').listeners.length > 0, 'and the app is wired');
});

// ── A sign-in check that throws after answering must not cost the boot's uploads ─────────────────
//
// syncOnLoad's wait for the sign-in answer is WRAPPED: checkAuth settles `_authEmail` first, then reads
// and writes `focus_was_authed`, and either can throw (a full store, a browser refusing site data).
// Whether init rejects and which view shows cannot tell whether the wrap is there, because init
// rejects here either way. What
// the wrap preserves is the UPLOAD. These assert that, and deliberately not the rejection: a later fix
// that lets init survive a storage throw must not have to edit them.

test('[BUG-063] c15a: a signed-in boot whose sign-in check throws after answering still pushes un-pushed work', async () => {
  // A first sign-in on this browser (no `focus_was_authed`) with a full store: checkAuth's write of the
  // flag throws once the answer is known.
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });
  const store = aliceStoreWith(chans('UC_unpushed'), sql, { focus_dirty: '1' });
  delete store.focus_was_authed;
  const r = rig({ sql, store, me: ALICE, stateSession: ALICE });
  let threw = 0;
  r.app.failSetItem((k) => k === 'focus_was_authed' && ++threw > 0);
  await r.app.ctx.init().catch(() => {});
  await drain(r.app);
  assert.ok(threw > 0, "guard: the sign-in check's storage write threw during the boot");
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_unpushed'], 'the un-pushed work must still reach the account');
});

test('[BUG-063] c15b: a walled boot whose sign-in check throws after answering still uploads this browser\'s channels', async () => {
  // Walled (the check aborts), and the browser refuses the READ of `focus_was_authed`, so checkAuth
  // throws after settling a signed-out answer. The account has no row and local holds channels: c2's
  // adoption, which must still happen on this boot.
  const sql = fakeDb();
  const r = rig({ sql, store: { focus_channels: JSON.stringify(chans('UC_legacy')) }, me: 'abort', stateSession: ALICE });
  let threw = 0;
  r.app.failGetItem((k) => k === 'focus_was_authed' && ++threw > 0);
  await r.app.ctx.init().catch(() => {});
  await drain(r.app);
  assert.ok(threw > 0, 'guard: the sign-in check\'s storage read threw during the boot');
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_legacy'], 'this browser\'s channels must still reach the account');
});
