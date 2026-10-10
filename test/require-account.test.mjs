// A signed-in page's save must never be written into the anonymous device namespace.
//
// `api/_session.js` answers null for an expired session AND for a database error, and `resolveOwner` then
// addresses the DEVICE namespace, so without this guard a signed-in page's save that met either one was written
// into a device row and answered 200 — and the page re-based onto that row. One
// such save wedged sync behind "Not syncing" across reloads, and Use saved copy discarded both changes.
//
// WHAT THIS FILE STAGES, and what it does not. Every fixture here makes the lookup RESOLVE to no
// session: it succeeds and finds nothing. A lookup that ERRORS is a different answer, and
// conflating the two costs a change the unguarded code keeps — so the tests that stage a throw live in
// test/require-account-r2.test.mjs and reach the real `api/_session.js`. Read "no session" below literally; nothing here
// makes the database fail.
//
// The fix: a state-carrying push from a signed-in page sends `X-Require-Account: 1`, and the server
// answers 412 instead of downgrading it. Sign-out's own save is EXEMPT:
// with the guard on it, a user whose session has ended can never sign
// out, and after a reload the walled browser keeps their data.
//
// The server tests run the real `createStateHandler` over the fake store; everything else runs the REAL
// app.js through the harness against that same handler, so "what the rows hold afterwards" is observed.
//
// CONTROLS, green without the guard: c2, c3, c6a–c6f, c7, c12a and c12b. c7 is answered by a
// CANNED 412 rather than the handler, so it pins the client's reaction whatever the server does; the
// c6 cases pin where the header must NOT appear, which unchanged code satisfies trivially — each one
// asserts the push it inspects was actually sent, so a silence cannot pass for an absence. The unguarded path
// (no header, no session → the device namespace, as today) is pinned by "device state round-trips on the
// anonymous path" in test/state-handler.test.mjs.
//
// c1e pins a session answer without an account id, c7 that a refusal does not keep `focus_dirty`,
// c15a that a refusal is re-sent when the page goes away, and c16a–c16c that the next boot after a
// refusal is an ordinary one. c1c/c1d pin a refused save
// carrying no user data, c12c sign-out's retry, c15b–c15e that only a refusal is re-sent.
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
const STALE_BASE = '2026-01-01T00:00:00.000000';

const chans = (...xs) => xs.map((id) => ({ id, name: `${id} name`, keyword: '', source: 'youtube' }));
const settle = () => new Promise((r) => setImmediate(r));
const lowerKeys = (h = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const ids = (raw) => (raw == null ? raw : JSON.parse(raw).map((c) => c.id));
const rowIds = (row) => (row ? (row.state.channels || []).map((c) => c.id) : null);
const notSyncing = (app) => app.toasts.filter((t) => t.startsWith('Not syncing'));
const EVENT = () => ({ name: 'view', props: {}, section: 'feed', ts: Date.now() });

const ALICE_ROW = { channels: chans('UC_alice'), done: ['alice-done'], archive: [], theme: 'dark', shorts: 'false' };
const BOB_ROW = { channels: chans('UC_bob'), done: ['bob-done'], archive: [], theme: 'light', shorts: 'true' };
/** Another device writes the account row, so a base read before it is stale. */
function bumpRow(sql, id = ALICE_ID) {
  const row = sql.get('account', id);
  row.updated_at = new Date(new Date(row.updated_at).getTime() + 5000);
}

/** Alice's own current copy, based on her account row — what a healthy signed-in browser holds. */
function aliceStore(sql, more = {}) {
  return {
    focus_channels: JSON.stringify(ALICE_ROW.channels),
    focus_done: JSON.stringify(ALICE_ROW.done),
    focus_archive: '[]',
    focus_theme: ALICE_ROW.theme,
    focus_include_shorts: ALICE_ROW.shorts,
    focus_rev: toCharUS(sql.get('account', ALICE_ID).updated_at),
    focus_was_authed: '1',
    ...more,
  };
}

/** An app wired to the real state handler.
 *  `me`       what /api/auth/me does: an account (200), 401, or 'abort'.
 *  `session`  what the state handler resolves; `setSession` changes it for every later request.
 *  `noSessionStatePuts(n)` the next n STATE-CARRYING PUTs resolve to NO SESSION — the lookup succeeds
 *                        and finds nothing. It never throws; a lookup that errors is a different file.
 *  `refuseStatePuts(on)` state-carrying PUTs get a canned 412 without reaching the handler (c7).
 *  `stateReadFails`     the boot's GET answers 500. */
function rig({ sql = fakeDb(), store = {}, me = ALICE, session = ALICE, stateReadFails = false } = {}) {
  let current = session;
  let noSessionPuts = 0;
  let refuse = false;
  let beforeNextSave = null;   // one-shot: runs as the next non-keepalive state PUT arrives, before it is answered
  const statuses = [];         // every /api/state answer: { method, carriesState, keepalive, status, body }
  const app = createApp({ store: { focus_device_id: DEVICE_ID, ...store } });
  app.setFetch(async (url, init) => {
    const method = init.method || 'GET';
    if (url.includes('/api/auth/me')) {
      if (me === 'abort') { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
      if (me === 401) return { ok: false, status: 401, json: async () => ({ error: 'not signed in' }) };
      return { ok: true, status: 200, json: async () => ({ email: me.email }) };
    }
    if (url.includes('/api/auth/logout')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.includes('/api/state')) {
      if (method === 'GET' && stateReadFails) return { ok: false, status: 500, json: async () => ({ error: 'read failed' }) };
      const carriesState = method === 'PUT' && 'state' in JSON.parse(init.body);
      if (carriesState && !init.keepalive && beforeNextSave) { const fn = beforeNextSave; beforeNextSave = null; fn(); for (let i = 0; i < 4; i++) await settle(); }
      if (carriesState && refuse) {
        statuses.push({ method, carriesState, keepalive: !!init.keepalive, status: 412, body: { error: 'account required' } });
        return { ok: false, status: 412, json: async () => ({ error: 'account required' }) };
      }
      let resolved = current;
      if (carriesState && noSessionPuts > 0) { noSessionPuts--; resolved = null; }
      // One handler per request, so each request's session answer is fixed at the moment it arrives.
      const handler = createStateHandler({ db: () => sql, sessionAccount: async () => resolved });
      const res = fakeRes();
      await handler(fakeReq({ method, headers: lowerKeys(init.headers), body: init.body ?? null }), res);
      const body = JSON.parse(JSON.stringify(res.body ?? {}));
      statuses.push({ method, carriesState, keepalive: !!init.keepalive, status: res.statusCode, body });
      return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => body };
    }
    if (url.includes('/api/feed')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
    throw new Error(`unrouted request: ${url}`);
  });
  const boot = async () => { await app.ctx.init(); await drain(app); };
  return {
    app, sql, boot, statuses,
    setSession: (s) => { current = s; },
    noSessionStatePuts: (n = 1) => { noSessionPuts = n; },
    refuseStatePuts: (on) => { refuse = on; },
    beforeNextSave: (fn) => { beforeNextSave = fn; },
  };
}
async function drain(app) { for (let i = 0; i < 6; i++) { app.runTimers(4); await settle(); } }

/** Every state-carrying PUT this app sent from request index `from` on, with lower-cased headers. */
function statePuts(app, from = 0) {
  return app.requests.slice(from)
    .filter((r) => r.url.includes('/api/state') && r.init.method === 'PUT' && 'state' in JSON.parse(r.init.body))
    .map((r) => ({ headers: lowerKeys(r.init.headers), body: JSON.parse(r.init.body), keepalive: !!r.init.keepalive }));
}
/** Every PUT (state-carrying or not) from index `from` on. */
function allPuts(app, from = 0) {
  return app.requests.slice(from)
    .filter((r) => r.url.includes('/api/state') && r.init.method === 'PUT')
    .map((r) => ({ headers: lowerKeys(r.init.headers), body: JSON.parse(r.init.body) }));
}
const seeded = () => fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });

// ── Criteria 1–3: the server ────────────────────────────────────────────────────────────────────

for (const [label, users] of [
  ['with no device row', []],
  ['when a device row already exists for that id', [{ kind: 'device', id: DEVICE_ID, state: { channels: chans('UC_old_anon'), done: [] } }]],
]) {
  test(`[BUG-039] c1${users.length ? 'b' : 'a'}: a state PUT requiring an account with no session is refused 412 and writes nothing, ${label}`, async () => {
    const sql = fakeDb({ users });
    const rowsBefore = JSON.stringify(sql.rows);
    const handler = createStateHandler({ db: () => sql, sessionAccount: async () => null });
    const res = fakeRes();
    await handler(fakeReq({
      method: 'PUT',
      // A base IS declared: without one, "hands back no base" could not fail
      // for a refusal that echoed the request's own base back.
      headers: { 'x-device-id': DEVICE_ID, 'x-require-account': '1', 'x-state-rev': STALE_BASE },
      body: { uid: DEVICE_ID, state: { channels: chans('UC_alice'), done: ['alice-done'] }, events: [EVENT()] },
    }), res);
    assert.equal(res.statusCode, 412, `answered ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.rev, undefined, 'a refusal must hand back no base to re-base onto');
    assert.equal(res.body.updatedAt, undefined, 'a refusal must not read as a stored or discarded write');
    assert.equal(JSON.stringify(sql.rows), rowsBefore, 'the users store changed');
    assert.equal(sql.events.length, 0, `events were recorded: ${JSON.stringify(sql.events)}`);
  });
}

for (const [label, withRow] of [['with no device row', false], ['when a device row\'s base matches the one declared', true]]) {
  test(`[BUG-039] c1${withRow ? 'd' : 'c'}: a refused state PUT carrying NO user data writes nothing either, ${label}`, async () => {
    // Every refused fixture above carries channels, so a
    // refusal scoped to the user-data branch would pass them all — and a "clear everything" save that
    // found no session would then be discarded (200, updatedAt null), lose its unsaved mark, and come back on reload.
    // With a device row whose base matches, the unguarded code EMPTIES that row: the data-less branch updates in place.
    const users = withRow ? [{ kind: 'device', id: DEVICE_ID, state: { channels: chans('UC_old_anon'), done: [] } }] : [];
    const sql = fakeDb({ users });
    const base = withRow ? toCharUS(sql.get('device', DEVICE_ID).updated_at) : STALE_BASE;
    const rowsBefore = JSON.stringify(sql.rows);
    const handler = createStateHandler({ db: () => sql, sessionAccount: async () => null });
    const res = fakeRes();
    await handler(fakeReq({
      method: 'PUT',
      headers: { 'x-device-id': DEVICE_ID, 'x-require-account': '1', 'x-state-rev': base },
      body: { uid: DEVICE_ID, state: { channels: [], done: [], archive: [] } },
    }), res);
    assert.equal(res.statusCode, 412, `answered ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(JSON.stringify(sql.rows), rowsBefore, withRow ? 'the device row was emptied' : 'the users store changed');
  });
}

test('[BUG-039] c1e: a session answer without an account id is refused like no session at all', async () => {
  // If the refusal reads `!account` while resolveOwner sends a request to the device
  // namespace unless `account.accountId` is set, a truthy answer without an id is written to a device row
  // despite the header. Unreachable through today's sessionAccount (its join always returns an id); pinned so
  // the two conditions cannot drift apart.
  const sql = fakeDb();
  const handler = createStateHandler({ db: () => sql, sessionAccount: async () => ({ email: 'alice@example.com' }) });
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID, 'x-require-account': '1' },
    body: { uid: DEVICE_ID, state: { channels: chans('UC_alice'), done: [] } },
  }), res);
  assert.equal(res.statusCode, 412, `answered ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(sql.rows.length, 0, `a row was written: ${JSON.stringify(sql.rows)}`);
});

test('[BUG-039] c2: with a valid session the header changes nothing — the account row is written as without it', async () => {
  const mine = { channels: chans('UC_mine'), done: ['d1'] };
  const outcomes = [];
  for (const headers of [{ 'x-device-id': DEVICE_ID }, { 'x-device-id': DEVICE_ID, 'x-require-account': '1' }]) {
    const sql = fakeDb();
    const handler = createStateHandler({ db: () => sql, sessionAccount: async () => ALICE });
    const res = fakeRes();
    await handler(fakeReq({ method: 'PUT', headers, body: { uid: DEVICE_ID, state: mine } }), res);
    outcomes.push({ status: res.statusCode, revIsString: typeof res.body.rev === 'string', stored: JSON.stringify(sql.get('account', ALICE_ID)?.state), device: sql.get('device', DEVICE_ID) });
  }
  assert.deepEqual(outcomes[1], outcomes[0], `the header changed a signed-in write: ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes[0].status, 200, 'guard: the write itself succeeds');
  assert.equal(outcomes[0].stored, JSON.stringify(mine), 'guard: and lands in the account row');
});

test('[BUG-039] c3: an analytics-only PUT with the header and no session is unaffected — 200, events recorded, no row', async () => {
  const sql = fakeDb();
  const handler = createStateHandler({ db: () => sql, sessionAccount: async () => null });
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID, 'x-require-account': '1' },
    body: { uid: DEVICE_ID, events: [EVENT()] },
  }), res);
  assert.equal(res.statusCode, 200, `answered ${res.statusCode}`);
  assert.equal(sql.events.length, 1, 'its events must still be recorded');
  assert.equal(sql.rows.length, 0, 'and no row created');
});

// ── Criterion 5: a signed-in page's state-carrying pushes declare it ────────────────────────────

test('[BUG-039] c5a: the debounced save from a signed-in page sends X-Require-Account', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  const from = r.app.requests.length;
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  const puts = statePuts(r.app, from);
  assert.ok(puts.length, 'guard: the save was sent');
  for (const p of puts) assert.equal(p.headers['x-require-account'], '1', `a signed-in save went out without the header: ${JSON.stringify(p.headers)}`);
});

test('[BUG-039] c5b: the unload save from a signed-in page sends X-Require-Account', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  const from = r.app.requests.length;
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  r.app.ctx.flushPush();
  await settle();
  const flush = statePuts(r.app, from).filter((p) => p.keepalive);
  assert.equal(flush.length, 1, 'guard: the unload flush carried state');
  assert.equal(flush[0].headers['x-require-account'], '1', `the unload save went out without the header: ${JSON.stringify(flush[0].headers)}`);
});

test('[BUG-039] c5c: the boot\'s no-row claim from a signed-in page sends X-Require-Account', async () => {
  const r = rig({ store: { focus_channels: JSON.stringify(chans('UC_local')) } });
  await r.boot();
  assert.deepEqual(rowIds(r.sql.get('account', ALICE_ID)), ['UC_local'], 'guard: the claim ran and landed');
  const puts = statePuts(r.app);
  assert.ok(puts.length, 'guard: a state push was sent');
  assert.equal(puts[0].headers['x-require-account'], '1', `the claim went out without the header: ${JSON.stringify(puts[0].headers)}`);
});

test('[BUG-039] c5d: the boot\'s dirty push from a signed-in page sends X-Require-Account', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql, { focus_channels: JSON.stringify(chans('UC_alice', 'UC_unpushed')), focus_dirty: '1' }) });
  await r.boot();
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_unpushed'], 'guard: the dirty push ran and landed');
  const puts = statePuts(r.app);
  assert.equal(puts[0].headers['x-require-account'], '1', `the dirty push went out without the header: ${JSON.stringify(puts[0].headers)}`);
});

test('[BUG-039] c5e: the save after a refused one still sends X-Require-Account, against the same base', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  const base = r.app.get('focus_rev');
  const from = r.app.requests.length;
  r.noSessionStatePuts(1);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  r.app.ctx.addDone('d2');
  await drain(r.app);
  const puts = statePuts(r.app, from);
  assert.ok(puts.length >= 2, `guard: both saves were sent (${puts.length})`);
  const next = puts[1];
  assert.equal(next.headers['x-require-account'], '1', `the save after a refusal went out without the header: ${JSON.stringify(next.headers)}`);
  assert.equal(next.headers['x-state-rev'], base, 'and against the base the refused save declared, not one it was handed');
});

// ── Criterion 6: where the header must NOT appear ───────────────────────────────────────────────

test('[BUG-039] c6a: an analytics-only push from a signed-in page carries no X-Require-Account', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  const from = r.app.requests.length;
  r.app.ctx.track('view', {}, 'feed');
  await drain(r.app);
  const puts = allPuts(r.app, from);
  assert.ok(puts.length && puts.every((p) => !('state' in p.body)), 'guard: an analytics-only push was sent');
  for (const p of puts) assert.equal(p.headers['x-require-account'], undefined, 'an analytics-only push declared an account');
});

test('[BUG-039] c6b: a push downgraded for lack of standing carries no X-Require-Account', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql), stateReadFails: true });
  await r.boot();
  const from = r.app.requests.length;
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  const puts = allPuts(r.app, from);
  assert.ok(puts.length, 'guard: the save still sent its analytics');
  assert.ok(puts.every((p) => !('state' in p.body)), 'guard: without standing nothing claims state');
  for (const p of puts) assert.equal(p.headers['x-require-account'], undefined, 'a downgraded push declared an account');
});

test('[BUG-039] c6c: a push downgraded for a damaged store carries no X-Require-Account', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  r.app.set('focus_done', '{not json');
  const from = r.app.requests.length;
  await r.app.ctx.pushNow();
  const puts = allPuts(r.app, from);
  assert.equal(puts.length, 1, 'guard: the push was sent');
  assert.ok(!('state' in puts[0].body), 'guard: a damaged store claims no state');
  assert.equal(puts[0].headers['x-require-account'], undefined, 'a push downgraded for damage declared an account');
});

for (const [label, me, session, kind] of [
  ['a signed-out browser', 401, null, 'device'],
  ['a walled browser answered by its account', 'abort', ALICE, 'account'],
]) {
  test(`[BUG-039] c6${kind === 'device' ? 'd' : 'e'}: ${label} claims without X-Require-Account`, async () => {
    // With a base: a store without one lets a "signed in" term widened to
    // `_authEmail || base` pass — the header would then ride a signed-out page's claim and refuse it.
    const r = rig({ store: { focus_channels: JSON.stringify(chans('UC_local')), focus_rev: STALE_BASE }, me, session });
    await r.boot();
    assert.deepEqual([...r.app.visibleViews()], ['view-landing'], 'guard: the browser is walled');
    assert.deepEqual(rowIds(r.sql.get(kind, kind === 'account' ? ALICE_ID : DEVICE_ID)), ['UC_local'], `guard: the claim ran and landed in the ${kind} row`);
    const puts = statePuts(r.app);
    assert.ok(puts.length, 'guard: a state push was sent');
    for (const p of puts) assert.equal(p.headers['x-require-account'], undefined, `${label} declared an account`);
  });
}

test('[BUG-039] c6f: sign-out\'s own save carries no X-Require-Account', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_last')]);
  const from = r.app.requests.length;
  await r.app.ctx.signOut();
  await drain(r.app);
  const puts = statePuts(r.app, from);
  assert.ok(puts.length, 'guard: sign-out saved state');
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_last'], 'guard: and the save landed');
  assert.ok(r.app.navigations.includes('/app'), 'guard: and sign-out completed');
  for (const p of puts) assert.equal(p.headers['x-require-account'], undefined, `sign-out's save declared an account: ${JSON.stringify(p.headers)}`);
});

// ── What a 412 leaves behind ───────────────────────────────────────────────────────

test('[BUG-039] c7: a refused save is not marked unsaved across a reload, keeps its base and events, says nothing, and the next save still goes', async () => {
  // `focus_dirty` must NOT stay '1' after a refusal. If it did,
  // the flag would survive the reload, and when the next boot is not this account's healthy one — another
  // account signing in through a link, a stale second tab, a row that appeared meanwhile — syncOnLoad's dirty
  // branch pushes the stale copy instead of loading the row and stops behind "Not syncing". A refusal is
  // owed within the page instead (c15a–c15e), never across a reload by itself (c16a–c16c).
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  const base = r.app.get('focus_rev');
  r.app.ctx.track('view', {}, 'feed');
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  const events = r.app.get('focus_events');
  assert.ok(events && JSON.parse(events).length, 'guard: events are buffered before the save');
  r.refuseStatePuts(true);
  const from = r.app.requests.length;
  r.app.advance(1600);                       // the 1.5s save, and NOT the 3s analytics flush
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(statePuts(r.app, from).length, 1, 'guard: exactly the save was sent, and refused');
  assert.equal(r.app.get('focus_dirty'), null, 'a refused save must not stay marked unsaved across a reload');
  assert.equal(r.app.get('focus_rev'), base, 'a refused save must not move the base');
  assert.equal(r.app.get('focus_events'), events, 'a refused save must not drop the events it carried');
  assert.deepEqual([...r.app.toasts], [], `a refused save must say nothing (TASK-089 owns telling the user): ${JSON.stringify(r.app.toasts)}`);
  // NOT TREATED AS SUCCESS — the half c15a owns, and it CANNOT be pinned from here.
  //
  // An assertion here that fired the unload flush and checked that something went out, on the theory
  // that only the owed debt could have triggered it, could not fail: `flushPush`'s trigger is
  // `_pushTimer || _evtTimer || _readEvents().length || _refusalOwed`, and this test's own guard three
  // lines above REQUIRES buffered events — so the flush fires whatever the debt holds, and the payload
  // carries state because `_stateOutstanding` is still true after a refusal. Dropping
  // `_refusalOwed = true` would leave it green. The two assertions are mutually
  // exclusive in one fixture — the events check needs events pending, the debt check needs nothing
  // pending — so the fixture cannot be sized for both.
  //
  // What DOES pin it: c15a ("even with nothing else pending") for the debt, and this test's own
  // "must not drop the events it carried" for the other spelling of treated-as-success, the one that
  // returns ok and drains the buffer.
  r.refuseStatePuts(false);
  const next = r.app.requests.length;
  r.app.ctx.addDone('d2');
  await drain(r.app);
  const puts = statePuts(r.app, next);
  assert.ok(puts.length, 'a refusal must not halt the next save');
  assert.equal(puts[0].headers['x-state-rev'], base, 'and the next save declares the same base');
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'], 'and lands the refused change with it');
});

// ── A refusal is owed within the page, and only a refusal ─────────

test('[BUG-039] c15a: a refused change is re-sent when the page goes away, even with nothing else pending', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  r.refuseStatePuts(true);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);                           // the save is refused; the analytics flush drains the events
  assert.ok(r.statuses.some((s) => s.carriesState && s.status === 412), 'guard: the save was refused');
  assert.equal(r.app.get('focus_events'), null, 'guard: nothing else is pending — no buffered events');
  r.refuseStatePuts(false);
  const from = r.app.requests.length;
  r.app.ctx.flushPush();
  for (let i = 0; i < 4; i++) await settle();
  const flush = statePuts(r.app, from).filter((p) => p.keepalive);
  assert.equal(flush.length, 1, 'a change a refusal left owed must be re-sent when the page goes away');
  assert.equal(flush[0].headers['x-require-account'], '1', 'and still declare the account');
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'], 'and land');
});

// The three cases below are why the re-send is keyed on a REFUSAL rather than on "any state still owed".
// The broad version has a cost: a halted page re-raises "Not syncing" on every tab
// switch, and a discarded theme-only save sends a no-op save on every one.

test('[BUG-039] c15b: a page halted by a real 409 sends nothing and says nothing when it goes away', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  bumpRow(sql);                                 // another device wrote
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  assert.ok(notSyncing(r.app).length, 'guard: the page is halted');
  const reqs = r.app.requests.length, toasts = r.app.toasts.length;
  r.app.ctx.flushPush();
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(r.app.requests.length, reqs, 'a halted page sent a request when it went away');
  assert.equal(r.app.toasts.length, toasts, 'a halted page re-raised its notice when it went away');
});

test('[BUG-039] c15c: a discarded theme-only save sends nothing when the page goes away', async () => {
  const r = rig({ store: { focus_was_authed: '1' } });   // an account with no row
  await r.boot();
  r.app.set('focus_theme', 'light');
  r.app.ctx.schedulePush();                     // a theme tap
  await drain(r.app);
  assert.ok(r.statuses.some((s) => s.carriesState && s.status === 200 && s.body.updatedAt === null), 'guard: the save was discarded');
  const reqs = r.app.requests.length;
  r.app.ctx.flushPush();
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(r.app.requests.length, reqs, 'a discarded save was re-sent when the page went away');
});

test('[BUG-039] c15d: a refusal later settled by a 409 sends nothing and says nothing when the page goes away', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  r.refuseStatePuts(true);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  r.refuseStatePuts(false);
  bumpRow(sql);                                 // another device wrote meanwhile
  r.app.ctx.addDone('d2');
  await drain(r.app);
  assert.ok(r.statuses.some((s) => s.carriesState && s.status === 409), 'guard: the re-send was refused as stale');
  const reqs = r.app.requests.length, toasts = r.app.toasts.length;
  r.app.ctx.flushPush();
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(r.app.requests.length, reqs, 'a settled refusal was re-sent when the page went away');
  assert.equal(r.app.toasts.length, toasts, 'and re-raised the notice');
});

test('[BUG-039] c15e: a refusal later settled by a discard sends nothing when the page goes away', async () => {
  const r = rig({ store: { focus_was_authed: '1' } });   // an account with no row
  await r.boot();
  r.refuseStatePuts(true);
  r.app.set('focus_theme', 'light');
  r.app.ctx.schedulePush();
  await drain(r.app);
  r.refuseStatePuts(false);
  r.app.ctx.schedulePush();                     // the next save: data-less, no row, so discarded
  await drain(r.app);
  assert.ok(r.statuses.some((s) => s.carriesState && s.status === 200 && s.body.updatedAt === null), 'guard: the re-send was discarded');
  const reqs = r.app.requests.length;
  r.app.ctx.flushPush();
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(r.app.requests.length, reqs, 'a settled refusal was re-sent when the page went away');
});

test('[BUG-039] c15f: a refusal later settled by an accepted save sends nothing when the page goes away', async () => {
  // The owed flag must be
  // settled by an ACCEPTED save, or a page that had recovered would re-send its whole state on every tab switch.
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  r.refuseStatePuts(true);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  r.refuseStatePuts(false);
  r.app.ctx.addDone('d2');
  await drain(r.app);
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'], 'guard: the re-send landed');
  const reqs = r.app.requests.length;
  r.app.ctx.flushPush();
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(r.app.requests.length, reqs, 'a settled refusal was re-sent when the page went away');
});

// ── Criteria 8–11: end to end ───────────────────────────────────────────────────────────────────

test('[BUG-039] c8a: one save that finds no session creates no device row, and the next healthy save lands both changes', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  r.noSessionStatePuts(1);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  assert.equal(sql.get('device', DEVICE_ID), undefined, `the save that found no session was written into a device row: ${JSON.stringify(sql.get('device', DEVICE_ID)?.state)}`);
  r.app.ctx.addDone('d2');
  await drain(r.app);
  const row = sql.get('account', ALICE_ID).state;
  assert.deepEqual(rowIds({ state: row }), ['UC_alice', 'UC_new'], 'the change whose save found no session must reach the account');
  assert.deepEqual(row.done, ['alice-done', 'd2'], 'and so must the next one');
  assert.deepEqual(notSyncing(r.app), [], '"Not syncing" must not appear');
});

// c8b–c8d: the page goes away (pagehide → flushPush) and reloads. A reload WITHOUT the page going away
// would rely on the unsaved mark surviving, which is
// what c7 forbids. A reload in a browser fires pagehide; an app killed outright may not.
async function noSessionCloseReload({ sql, store, change }) {
  const r = rig({ sql, store });
  await r.boot();
  r.noSessionStatePuts(1);
  change(r.app.ctx);
  await drain(r.app);
  assert.ok(r.statuses.some((s) => s.carriesState && s.status === 412), 'guard: the save was refused');
  r.app.ctx.flushPush();                        // the page goes away
  for (let i = 0; i < 4; i++) await settle();
  const back = rig({ sql, store: Object.fromEntries(r.app.store) });
  await back.boot();
  return { r, back };
}

test('[BUG-039] c8b: one save that finds no session, then the page closes and reloads — the change lands in the account', async () => {
  const sql = seeded();
  const { r, back } = await noSessionCloseReload({ sql, store: aliceStore(sql), change: (ctx) => ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]) });
  assert.equal(sql.get('device', DEVICE_ID), undefined, 'the save that found no session was written into a device row');
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'], 'the change must land in the account');
  assert.deepEqual(ids(back.app.get('focus_channels')), ['UC_alice', 'UC_new'], 'and stay on the device');
  // BOTH pages: the notice must not appear "at any point".
  assert.deepEqual([...notSyncing(r.app), ...notSyncing(back.app)], [], '"Not syncing" must not appear on either page');
});

test('[BUG-039] c8c: with a legacy device row, one save that finds no session, then the page closes and reloads — the change lands', async () => {
  // Without the guard this change is kept (a 409 keeps the unsaved mark), and a refusal that
  // is simply not carried across the reload would lose it. The re-send on close is what keeps it.
  const legacy = { channels: chans('UC_old_anon'), done: [] };
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }, { kind: 'device', id: DEVICE_ID, state: legacy }] });
  const deviceBefore = JSON.stringify(sql.get('device', DEVICE_ID));
  const { r, back } = await noSessionCloseReload({ sql, store: aliceStore(sql), change: (ctx) => ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]) });
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'], 'the change must land in the account');
  assert.deepEqual(ids(back.app.get('focus_channels')), ['UC_alice', 'UC_new'], 'and stay on the device');
  assert.equal(JSON.stringify(sql.get('device', DEVICE_ID)), deviceBefore, 'the legacy device row changed');
  assert.deepEqual([...notSyncing(r.app), ...notSyncing(back.app)], [], '"Not syncing" must not appear');
});

test('[BUG-039] c8d: clearing every channel, one save that finds no session, then the page closes and reloads — the clear lands', async () => {
  // A save carrying NO user data. If it were not refused
  // it would be discarded (200, updatedAt null) and the channel would come back on the reload.
  const only = { channels: chans('UC_only'), done: [], archive: [], theme: 'dark', shorts: 'false' };
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: only }] });
  const store = { ...aliceStore(sql), focus_channels: JSON.stringify(only.channels), focus_done: '[]' };
  const { r, back } = await noSessionCloseReload({ sql, store, change: (ctx) => ctx.saveChannels([]) });
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), [], 'the clear must land in the account');
  assert.deepEqual(ids(back.app.get('focus_channels')), [], 'and the channel must not come back');
  // BOTH PAGES, not `back` alone: routing a 412 into
  // the halt branch raises the notice on the ORIGINAL page, and a check on `back` alone
  // would stay green.
  // The notice appears where the refusal happened, so that is where it has to be read.
  assert.deepEqual([...notSyncing(r.app), ...notSyncing(back.app)], [],
    '"Not syncing" must not appear on either page');
});

test('[BUG-039] c9: with a legacy device row, a save that finds no session shows no "Not syncing" and leaves that row alone', async () => {
  const legacy = { channels: chans('UC_old_anon'), done: [] };
  const sql = fakeDb({ users: [
    { kind: 'account', id: ALICE_ID, state: ALICE_ROW },
    { kind: 'device', id: DEVICE_ID, state: legacy },
  ] });
  const deviceBefore = JSON.stringify(sql.get('device', DEVICE_ID));
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  r.noSessionStatePuts(1);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  assert.equal(JSON.stringify(sql.get('device', DEVICE_ID)), deviceBefore, 'the legacy device row changed');
  assert.deepEqual(notSyncing(r.app), [], `a no-session answer must not raise "Not syncing": ${JSON.stringify(r.app.toasts)}`);
});

test('[BUG-039] c10: after the account is deleted elsewhere, a save from the still-open page creates no device row', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  sql.rows.splice(sql.rows.findIndex((row) => row.kind === 'account'), 1);   // deleted on another device…
  r.setSession(null);                                                         // …which cascades the session
  const from = r.app.requests.length;
  r.app.ctx.addDone('d2');
  await drain(r.app);
  assert.ok(statePuts(r.app, from).length, 'guard: the page tried to save');
  assert.equal(sql.get('device', DEVICE_ID), undefined,
    `the deleted account was re-created in a device row: ${JSON.stringify(sql.get('device', DEVICE_ID)?.state)}`);
});

test('[BUG-039] c11: with the session gone, the unload save creates no device row', async () => {
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  r.setSession(null);
  const from = r.app.requests.length;
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_late')]);
  r.app.ctx.flushPush();
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(statePuts(r.app, from).filter((p) => p.keepalive).length, 1, 'guard: the unload flush carried state');
  assert.equal(sql.get('device', DEVICE_ID), undefined,
    `the unload save was written into a device row: ${JSON.stringify(sql.get('device', DEVICE_ID)?.state)}`);
});

test('[BUG-039] c11b: an unload save fired while sign-out\'s own save is in flight still carries X-Require-Account', async () => {
  // An exemption built as a module-level flag (anything
  // while sign-out runs goes unguarded) passes every other test, because during sign-out's own state save
  // a flush is analytics-only whenever a push holds the queue WITH a base. A flush
  // carries state during sign-out whenever that is not so — a page with no base yet (this fixture), or a
  // sign-out whose save is analytics-only because it had nothing to save.
  // Here: signed in on an account with no row, holding nothing at boot, then a channel added after
  // the session ended — refused, so still owed and still base-less.
  const r = rig();
  await r.boot();
  assert.equal(r.app.get('focus_rev'), null, 'guard: the page has no base');
  r.setSession(null);
  r.app.ctx.saveChannels(chans('UC_first'));
  await drain(r.app);
  assert.ok(r.statuses.some((s) => s.carriesState && s.status === 412), 'guard: the change was refused, so it is still owed');
  r.app.ctx.track('view', {}, 'feed');       // something for the flush to carry, so it fires
  const from = r.app.requests.length;
  r.beforeNextSave(() => r.app.ctx.flushPush());
  await r.app.ctx.signOut();
  await drain(r.app);
  const flush = statePuts(r.app, from).filter((p) => p.keepalive);
  assert.equal(flush.length, 1, 'guard: the unload save fired during sign-out and carried state');
  assert.equal(flush[0].headers['x-require-account'], '1',
    `an unload save during sign-out went unguarded — the exemption leaked past sign-out's own save: ${JSON.stringify(flush[0].headers)}`);
  assert.ok(r.app.navigations.includes('/app'), `and sign-out must still complete: ${JSON.stringify(r.app.toasts)}`);
});

// ── Sign-out is unchanged (the exemption) ─────────────────────────────────────────
//
// Without the guard: sign-out completes, its save lands in a
// device row the id rotation then orphans, and the account row is
// untouched. The device row is asserted because it is the observable proof that sign-out's save was
// NOT refused — a guarded sign-out writes nothing, refuses, and keeps the departing user's data.

for (const [label, late] of [['with a late change', true], ['with nothing pending', false]]) {
  test(`[BUG-039] c12${late ? 'a' : 'b'}: after the session ends mid-page, sign-out completes as on main, ${label}`, async () => {
    const sql = seeded();
    const rowBefore = JSON.stringify(sql.get('account', ALICE_ID).state);
    const r = rig({ sql, store: aliceStore(sql) });
    await r.boot();
    r.setSession(null);
    if (late) {
      r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_late')]);
      await drain(r.app);
    }
    const from = r.app.requests.length;
    await r.app.ctx.signOut();
    await drain(r.app);
    assert.ok(r.app.navigations.includes('/app'), `sign-out did not complete: ${JSON.stringify(r.app.toasts)}`);
    assert.equal(r.app.get('focus_channels'), null, 'local was not cleared');
    assert.notEqual(r.app.get('focus_device_id'), DEVICE_ID, 'the device id was not rotated');
    const puts = statePuts(r.app, from);
    assert.ok(puts.length, 'guard: sign-out saved state');
    for (const p of puts) assert.equal(p.headers['x-require-account'], undefined, 'sign-out\'s save declared an account');
    assert.equal(JSON.stringify(sql.get('account', ALICE_ID).state), rowBefore, 'the account row changed');
    assert.deepEqual(rowIds(sql.get('device', DEVICE_ID)), late ? ['UC_alice', 'UC_late'] : ['UC_alice'],
      'sign-out\'s save must land where it does on main — it was refused instead');
  });
}

test('[BUG-039] c12c: after the session ends, sign-out\'s RETRY is exempt too', async () => {
  // Not only sign-out's first attempt. A change landing
  // while that save is in flight — routine; the async /api/group resolve does it — makes it unconfirmed,
  // so the loop retries, and a retry that carried the header would be refused and stop the sign-out.
  const sql = seeded();
  const r = rig({ sql, store: aliceStore(sql) });
  await r.boot();
  r.setSession(null);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_late')]);
  const from = r.app.requests.length;
  r.beforeNextSave(() => r.app.ctx.addDone('d-mid'));    // lands while sign-out's first save is in flight
  await r.app.ctx.signOut();
  await drain(r.app);
  const puts = statePuts(r.app, from).filter((p) => !p.keepalive);
  assert.ok(puts.length >= 2, `guard: sign-out retried (${puts.length} state saves)`);
  for (const p of puts) assert.equal(p.headers['x-require-account'], undefined, `a sign-out retry declared an account: ${JSON.stringify(p.headers)}`);
  assert.ok(r.app.navigations.includes('/app'), `sign-out did not complete: ${JSON.stringify(r.app.toasts)}`);
});

// ── After a refusal, the next boot is an ordinary boot ─
//
// The page closes WITHOUT going away cleanly (no flushPush), so nothing re-sends: these pin that a refusal
// alone leaves nothing behind for the next boot to act on. If it left `focus_dirty` set,
// syncOnLoad's dirty branch would push the previous copy instead of loading the row, and stop behind "Not
// syncing".

test('[BUG-039] c16a: a save that finds no session, then a different account signs in here — that account loads its own row', async () => {
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }, { kind: 'account', id: BOB_ID, state: BOB_ROW }] });
  const alice = rig({ sql, store: aliceStore(sql) });
  await alice.boot();
  alice.noSessionStatePuts(1);
  alice.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(alice.app);
  assert.ok(alice.statuses.some((s) => s.carriesState && s.status === 412), 'guard: the save was refused');
  const bobBefore = JSON.stringify(sql.get('account', BOB_ID).state);
  const bob = rig({ sql, store: Object.fromEntries(alice.app.store), me: BOB, session: BOB });   // a link opened here
  await bob.boot();
  assert.deepEqual(ids(bob.app.get('focus_channels')), ['UC_bob'], `Bob was shown another account's channels: ${bob.app.get('focus_channels')}`);
  assert.deepEqual(notSyncing(bob.app), [], '"Not syncing" must not appear for Bob');
  assert.equal(JSON.stringify(sql.get('account', BOB_ID).state), bobBefore, 'Bob\'s row changed');
});

test('[BUG-039] c16b: the session ends mid-page, a change is refused, then a different account signs in here — that account loads its own row', async () => {
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }, { kind: 'account', id: BOB_ID, state: BOB_ROW }] });
  const alice = rig({ sql, store: aliceStore(sql) });
  await alice.boot();
  alice.setSession(null);
  alice.app.ctx.addDone('late-done');
  await drain(alice.app);
  assert.ok(alice.statuses.some((s) => s.carriesState && s.status === 412), 'guard: the change was refused');
  const bobBefore = JSON.stringify(sql.get('account', BOB_ID).state);
  const bob = rig({ sql, store: Object.fromEntries(alice.app.store), me: BOB, session: BOB });
  await bob.boot();
  assert.deepEqual(JSON.parse(bob.app.get('focus_done')), ['bob-done'], `Bob was shown another account's read marks: ${bob.app.get('focus_done')}`);
  assert.deepEqual(notSyncing(bob.app), [], '"Not syncing" must not appear for Bob');
  assert.equal(JSON.stringify(sql.get('account', BOB_ID).state), bobBefore, 'Bob\'s row changed');
});

test('[BUG-039] c16c: an account with no row refuses a theme tap, then its row appears elsewhere — the reload loads that row', async () => {
  const sql = fakeDb();
  const r = rig({ sql, store: { focus_was_authed: '1' } });
  await r.boot();
  r.noSessionStatePuts(1);
  r.app.set('focus_theme', 'light');
  r.app.ctx.schedulePush();                     // a theme tap
  await drain(r.app);
  assert.ok(r.statuses.some((s) => s.carriesState && s.status === 412), 'guard: the tap was refused');
  sql.rows.push({ kind: 'account', id: ALICE_ID, state: { channels: chans('UC_phone'), done: ['phone-done'] }, updated_at: new Date('2026-01-01T01:00:00.000Z') });
  const back = rig({ sql, store: Object.fromEntries(r.app.store) });
  await back.boot();
  assert.deepEqual(ids(back.app.get('focus_channels')), ['UC_phone'], `the reload did not load the account's row: ${back.app.get('focus_channels')}`);
  assert.deepEqual(notSyncing(back.app), [], '"Not syncing" must not appear');
});
