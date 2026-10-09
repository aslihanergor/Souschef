// A LOOKUP THAT ERRORS IS NOT A MISSING SESSION ([BUG-039], review round 2, option S2).
//
// The sibling file (test/require-account.test.mjs) stages one answer only: the session lookup
// succeeds and finds nothing. This file stages the OTHER one — the lookup throws — because review
// round 2 measured that treating them alike costs changes `main` keeps:
//
//   - data safety F1 (HIGH): a database outage answers null, the server 412s, the client clears the
//     unsaved mark, and the change made during the outage is lost along with any earlier unsynced
//     one. `main`'s 500 kept both.
//   - claims HIGH-1 / data safety F2: with a legacy device row, one such answer then a kill, a
//     failing unload save, or a real expiry, loses a change `main`'s 409 kept.
//   - claims HIGH-2: the unload save landing after the reloaded page read the row brings "Not
//     syncing" back, and Use saved copy then discards the later change.
//   - battery finding 1 / claims MED-1: an over-cap store's refused save loses its local copy,
//     because the refusal ran BEFORE the size check (30002 read marks → 1).
//
// S2: `api/_session.js` grows a `{ strict: true }` mode that rethrows a database error instead of
// flattening it to null; `api/state.js` asks for that mode, answers **503** when the lookup could
// not be made and keeps **412** for a lookup that found nothing — and both now sit BELOW the 400
// and 413 checks, so an over-cap state is answered 413 whatever the session says. Asli, 2026-09-12:
// "yes do S", then "yes" to S2.
//
// A 503 needs no client change, and that is the point rather than an omission: `_pushNow`
// special-cases 409 and 412 only, so every other failure already keeps `focus_dirty`, the base and
// the buffered events — exactly what an offline save does. Criterion 20 pins that it stays that way.
//
// WHAT RUNS WHERE. Criterion 17 drives the real `createStateHandler` over the fake store with an
// injected session function, so "what did the endpoint answer, and what did it touch" is direct.
// Criterion 18 unit-tests `api/_session.js` itself. Criteria 19–21 run the REAL app.js through the
// harness against the real handler AND the real `sessionAccount`, with the database error staged
// where it really happens — inside the sessions query — because a rig that fakes the resolver
// cannot show that the two answers are distinguishable at all.
//
// RED on 458be33 (the renamed 3a3566e, no S2): every test below tagged RED in its own comment.
// Criteria 22–23 are PINS, green here, shown able to fail by mutations/BUG-039-r2.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';
import { createStateHandler } from '../api/state.js';
import { sessionAccount } from '../api/_session.js';
import { hashToken } from '../api/_auth.js';
import { fakeDb, fakeReq, fakeRes, toCharUS } from '../test-helpers/handler.mjs';

const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const BOB_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE = { accountId: ALICE_ID, email: 'alice@example.com' };
const BOB = { accountId: BOB_ID, email: 'bob@example.com' };
const STALE_BASE = '2026-01-01T00:00:00.000000';
const TOKEN = 'alice-session-token';
const BOB_TOKEN = 'bob-session-token';
const COOKIE = `focus_session=${TOKEN}`;
const BOB_COOKIE = `focus_session=${BOB_TOKEN}`;
const FUTURE = new Date(Date.now() + 30 * 86400000);

const chans = (...xs) => xs.map((id) => ({ id, name: `${id} name`, keyword: '', source: 'youtube' }));
const settle = () => new Promise((r) => setImmediate(r));
const lowerKeys = (h = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const ids = (raw) => (raw == null ? raw : JSON.parse(raw).map((c) => c.id));
const rowIds = (row) => (row ? (row.state.channels || []).map((c) => c.id) : null);
const notSyncing = (app) => app.toasts.filter((t) => t.startsWith('Not syncing'));
const EVENT = () => ({ name: 'view', props: {}, section: 'feed', ts: Date.now() });

const ALICE_ROW = { channels: chans('UC_alice'), done: ['alice-done'], archive: [], theme: 'dark', shorts: 'false' };
const BOB_ROW = { channels: chans('UC_bob'), done: ['bob-done'], archive: [], theme: 'light', shorts: 'true' };
const seeded = () => fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });

/** The staged database error, as Neon reports one mid-request. */
const DB_DOWN = () => new Error('Error connecting to database: fetch failed');

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

// ── The sessions table, wrapped around fakeDb ────────────────────────────────────────────────────
//
// Deliberately a WRAPPER rather than a new branch inside test-helpers/handler.mjs. The real
// `sessionAccount` must run against something that answers its query, but `fakeDb`'s
// throw-on-anything-unrecognised property is the safety net the whole handler suite rests on, and
// widening it for one file's fixture would weaken it for every other. Everything this does not
// recognise still falls through to the real fake, and still throws there.
//
// `fail()` is read PER QUERY, so a test can arm the error for exactly one request and watch the
// next one succeed — which is the difference between "an outage" and "a blip" in the criteria below.
function withSessions(sql, {
  accounts = { [TOKEN]: ALICE }, expiresAt = FUTURE, fail = () => false, failWrite = () => false,
} = {}) {
  const state = { accounts, expiresAt, fail, failWrite, lookups: 0 };
  const wrapped = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase();
    // The 500 arm of criterion 20: the state write itself fails, which is what `main` already
    // answers when Neon drops a connection mid-write. Staged at the query rather than as a canned
    // status so it travels api/state.js's own catch.
    if (state.failWrite() && /^(insert into users|update users set state)/.test(text)) {
      return Promise.reject(DB_DOWN());
    }
    if (text.startsWith('select s.account_id')) {
      state.lookups += 1;
      if (state.fail()) return Promise.reject(DB_DOWN());
      const hit = Object.entries(state.accounts).find(([tok]) => hashToken(tok) === values[0]);
      if (!hit) return Promise.resolve([]);
      return Promise.resolve([{
        account_id: hit[1].accountId, expires_at: state.expiresAt, email: hit[1].email,
      }]);
    }
    return sql(strings, ...values);
  };
  for (const k of ['rows', 'events', 'usage', 'postsSeen', 'queries', 'get', 'postsFor', 'spendOn']) {
    wrapped[k] = sql[k];
  }
  wrapped.session = state;
  return wrapped;
}

// ── Criterion 17: the server ─────────────────────────────────────────────────────────────────────
//
// The session function is INJECTED here (the sibling file's pattern) so each case states one answer
// and nothing else moves. Criterion 19 runs the real resolver end to end; this asks the narrower
// question of what the endpoint does with each answer it can get.
// Behaves exactly as `api/_session.js` does under S2: a database error is flattened to null for a
// caller that did not ask about it, and rethrown for one that did.
//
// Deliberately NOT a resolver that throws unconditionally. That was the first spelling, and it made
// c17e–c17g fail on unchanged code — not because unchanged code mishandles those requests, but
// because it never asks for strict mode, so a bare throw states an answer it cannot receive. A
// fixture that no version of the code can satisfy measures the fixture. This one lets every case
// below run on BOTH trees, so the ones that must not change can be read as the controls they are.
const failingSession = async (_sql, _cookie, { strict = false } = {}) => {
  if (strict) throw DB_DOWN();
  return null;
};
const noSession = async () => null;

/** Put one state-carrying PUT through the handler. Returns the response and the store's before/after. */
async function put({ sql, session, headers = {}, body }) {
  const handler = createStateHandler({ db: () => sql, sessionAccount: session });
  const before = JSON.stringify(sql.rows);
  const eventsBefore = sql.events.length;
  const res = fakeRes();
  let escaped = null;
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID, 'x-require-account': '1', cookie: COOKIE, ...headers },
    body,
  }), res).catch((e) => { escaped = e; });
  return { res, before, after: JSON.stringify(sql.rows), eventsBefore, sql, escaped };
}

const STATE = { channels: chans('UC_new'), done: ['d1'] };

for (const [label, users] of [
  ['with no device row', []],
  ['with a device row already present', [{ kind: 'device', id: DEVICE_ID, state: { channels: chans('UC_old'), done: [] } }]],
]) {
  test(`[BUG-039] c17a: a lookup that ERRORS answers 503 and writes nothing, ${label}`, async () => {
    // RED on 458be33: the lookup error escapes the handler (nothing catches it), so `statusCode` is
    // null. On `main` before the guard it was flattened to null by _session.js and the save landed
    // in a device row.
    const sql = fakeDb({ users });
    const r = await put({ sql, session: failingSession, body: JSON.stringify({ uid: DEVICE_ID, state: STATE, events: [EVENT()] }) });
    assert.equal(r.res.statusCode, 503,
      `a lookup that could not be made must answer 503, not guess${r.escaped ? ` — the error escaped the handler instead: ${r.escaped.message}` : ''}`);
    assert.equal(r.res.body?.rev, undefined, 'a 503 carries no rev');
    assert.equal(r.res.body?.updatedAt, undefined, 'a 503 carries no updatedAt');
    assert.equal(r.after, r.before, 'the users store must be byte-identical after a 503');
    assert.equal(sql.events.length, r.eventsBefore,
      'no events may be recorded on a 503 — the client keeps them and sends them again');
  });
}

test('[BUG-039] c17b: a lookup that finds NO SESSION still answers 412, not 503', async () => {
  // CONTROL, green on 458be33. The two answers must stay distinguishable in both directions: a
  // mutation that answers 503 for everything passes c17a and dies here.
  const sql = fakeDb();
  const r = await put({ sql, session: noSession, body: JSON.stringify({ uid: DEVICE_ID, state: STATE }) });
  assert.equal(r.res.statusCode, 412, 'an expired or absent session is still a refusal, not an outage');
  assert.equal(r.after, r.before, 'and it still writes nothing');
});

for (const [name, session] of [['errors', failingSession], ['finds no session', noSession]]) {
  test(`[BUG-039] c17c: a state that is not an object is answered 400 BEFORE the refusal, when the lookup ${name}`, async () => {
    // RED on 458be33: the refusal runs first, so both answer 412. The order is not cosmetic — see
    // c17d, where it costs an over-cap store its local copy.
    const sql = fakeDb();
    const r = await put({ sql, session, body: JSON.stringify({ uid: DEVICE_ID, state: ['not', 'an', 'object'] }) });
    assert.equal(r.res.statusCode, 400,
      `a malformed state is malformed whatever the session says${r.escaped ? ` — the error escaped instead: ${r.escaped.message}` : ''}`);
  });

  test(`[BUG-039] c17d: an over-cap state is answered 413 BEFORE the refusal, when the lookup ${name}`, async () => {
    // RED on 458be33: both answer 412. THIS IS THE ORDER THAT COSTS DATA. Under C′ a 412 clears the
    // unsaved mark while a 413 keeps it, so a store over the cap whose session really ended had its
    // local copy replaced by the row on the next boot — measured at 30002 read marks → 1, where
    // `main` keeps them (battery finding 1, Risk 18). 19h/19i assert the outcome end to end.
    const sql = fakeDb();
    const huge = { channels: chans('UC_a'), done: Array.from({ length: 30000 }, (_, i) => `done-${i}-${'x'.repeat(20)}`) };
    const r = await put({ sql, session, body: JSON.stringify({ uid: DEVICE_ID, state: huge }) });
    assert.equal(r.res.statusCode, 413,
      `an over-cap state is over the cap whatever the session says${r.escaped ? ` — the error escaped instead: ${r.escaped.message}` : ''}`);
  });
}

test('[BUG-039] c17e: WITHOUT the header, a lookup error is answered exactly as today', async () => {
  // CONTROL. Old clients and signed-out pages declare nothing, so nothing changes for them: the
  // write still lands in the device namespace at 200. A guard that refused them would break
  // every page that never asked for the guarantee.
  const sql = fakeDb();
  const r = await put({
    sql, session: failingSession, headers: { 'x-require-account': undefined },
    body: JSON.stringify({ uid: DEVICE_ID, state: STATE }),
  });
  assert.equal(r.res.statusCode, 200,
    `an undeclared save is unchanged${r.escaped ? ` — the error escaped instead: ${r.escaped.message}` : ''}`);
  assert.deepEqual(rowIds(sql.get('device', DEVICE_ID)), ['UC_new'], 'and still writes the device namespace');
});

test('[BUG-039] c17f: an ANALYTICS-ONLY PUT is unaffected by a lookup error', async () => {
  // CONTROL. An events-only PUT claims no state, so it cannot land in the wrong row and has nothing
  // to refuse. Its events must still be ingested — a client whose sync is halted must not also stop
  // reporting, which is exactly when we most want to know.
  const sql = fakeDb();
  const r = await put({ sql, session: failingSession, body: JSON.stringify({ uid: DEVICE_ID, events: [EVENT()] }) });
  assert.equal(r.res.statusCode, 200,
    `analytics-only is unchanged${r.escaped ? ` — the error escaped instead: ${r.escaped.message}` : ''}`);
  assert.equal(sql.events.length, r.eventsBefore + 1, 'and its events are still recorded');
});

test('[BUG-039] c17g: a GET is answered exactly as today when the lookup errors', async () => {
  // CONTROL, and a SCOPE BOUNDARY. The boot read has the same conflation — a signed-in browser's GET
  // silently resolves to the device namespace — and that half is [BUG-120], deliberately not fixed
  // here. This pins that S2 did not change it by accident in either direction.
  const sql = fakeDb({ users: [{ kind: 'device', id: DEVICE_ID, state: { channels: chans('UC_dev'), done: [] } }] });
  const handler = createStateHandler({ db: () => sql, sessionAccount: failingSession });
  const res = fakeRes();
  let escaped = null;
  await handler(fakeReq({ method: 'GET', headers: { 'x-device-id': DEVICE_ID, cookie: COOKIE } }), res)
    .catch((e) => { escaped = e; });
  assert.equal(res.statusCode, 200,
    `the GET path is untouched by S2${escaped ? ` — the error escaped instead: ${escaped.message}` : ''}`);
  assert.equal(res.body?.kind, 'device', 'and still answers from the device namespace ([BUG-120])');
});

// ── Criterion 18: api/_session.js ────────────────────────────────────────────────────────────────

test('[BUG-039] c18a: with { strict: true } a database error RETHROWS', async () => {
  // RED on 458be33: the third argument does not exist, so the catch flattens the error to null and
  // the caller cannot tell "could not check" from "no session" — the whole defect, at its source.
  const sql = withSessions(fakeDb(), { fail: () => true });
  await assert.rejects(
    () => sessionAccount(sql, COOKIE, { strict: true }),
    /connecting to database/,
    'strict mode must let the caller see that the lookup could not be made',
  );
});

test('[BUG-039] c18b: WITHOUT the option a database error still answers null, as today', async () => {
  // CONTROL. `/api/auth/me`, `/api/feed` and `/api/auth/delete` all call this and none passes the
  // option; each must keep today's answer (Risk 21). A mutation that makes strict the default dies
  // here rather than in production.
  const sql = withSessions(fakeDb(), { fail: () => true });
  assert.equal(await sessionAccount(sql, COOKIE), null, 'the default is unchanged: a blip reads as signed-out');
});

test('[BUG-039] c18c: a healthy lookup answers the account in BOTH modes', async () => {
  // CONTROL, and a non-vacuity guard: c18a/c18b are only meaningful if this fixture can also succeed.
  const sql = withSessions(fakeDb());
  const lax = await sessionAccount(sql, COOKIE);
  const strict = await sessionAccount(sql, COOKIE, { strict: true });
  assert.equal(lax?.accountId, ALICE_ID);
  assert.equal(lax?.email, ALICE.email);
  assert.equal(strict?.accountId, ALICE_ID, 'strict mode changes only what happens on an ERROR');
  assert.equal(strict?.email, ALICE.email);
});

test('[BUG-039] c18d: an EXPIRED session answers null in both modes — an expiry is not an error', async () => {
  // CONTROL. The row is found and rejected on its own terms, so there is nothing to rethrow. This is
  // the case the client must keep treating as a refusal.
  const sql = withSessions(fakeDb(), { expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await sessionAccount(sql, COOKIE), null);
  assert.equal(await sessionAccount(sql, COOKIE, { strict: true }), null,
    'an expired session is a missing session, not a failed lookup');
});

test('[BUG-039] c18e: NO COOKIE answers null in both modes, without querying at all', async () => {
  // CONTROL, and it is why a cookie-less request can get a 412 but never a 503 FROM THIS FUNCTION
  // (blast radius item 4): the anonymous fast path returns before the database is touched, so there is
  // no error to have. The endpoint has a separate 503 for a missing store, which no cookie can avoid.
  const sql = withSessions(fakeDb(), { fail: () => true });
  assert.equal(await sessionAccount(sql, ''), null);
  assert.equal(await sessionAccount(sql, '', { strict: true }), null,
    'strict mode must not turn the anonymous fast path into a throw');
  assert.equal(await sessionAccount(sql, undefined, { strict: true }), null);
  assert.equal(sql.session.lookups, 0, 'no cookie must mean no database hit, in either mode');
});

test('[BUG-039] c18f: an UNKNOWN token answers null in both modes — the query ran and found nothing', async () => {
  // CONTROL, and the non-vacuity partner to c18e: this one PROVES the query is reached, so "0
  // lookups" there is a fact about the fast path rather than about a fixture that never queries.
  const sql = withSessions(fakeDb());
  assert.equal(await sessionAccount(sql, 'focus_session=nobody'), null);
  assert.equal(await sessionAccount(sql, 'focus_session=nobody', { strict: true }), null);
  assert.equal(sql.session.lookups, 2, 'both modes must have actually queried');
});

// ── Criterion 22: the page-close listeners reach the flush ───────────────────────────────────────
//
// PINS (green here; the harness half landed in 4de856e and is pinned in test/harness-dom.test.mjs).
// Until that commit nothing could fire either listener, so `window.addEventListener('pagehide',
// flushPush)` and the `visibilitychange` line beside it were deletable with a fully green suite —
// while every criterion about what a refused change owes turns on the page going away.

test('[BUG-039] c22a: firing pagehide runs the unload flush', async () => {
  const sql = seeded();
  const r = rig2({ sql, store: aliceStore(sql) });
  await r.boot();
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);   // pending, not yet debounced out
  const before = r.app.requests.length;
  const ran = r.app.fireWindow('pagehide');
  for (let i = 0; i < 4; i++) await settle();
  assert.ok(ran >= 1, 'app.js must have a pagehide listener to fire');
  assert.ok(r.app.requests.length > before, 'pagehide must flush the pending save');
  assert.ok(statePuts(r.app, before).some((p) => p.keepalive), 'and it must go as a keepalive PUT');
});

test('[BUG-039] c22b: visibilitychange flushes while HIDDEN, and not while visible', async () => {
  const sql = seeded();
  const r = rig2({ sql, store: aliceStore(sql) });
  await r.boot();
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  const before = r.app.requests.length;

  // Visible: an ordinary tab switch must NOT flush — the document usually survives it, and flushing
  // there sends a no-op save on every switch.
  r.app.setVisibility('visible');
  assert.ok(r.app.fireDocument('visibilitychange') >= 1, 'app.js must have a visibilitychange listener');
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(r.app.requests.length, before, 'a visible visibilitychange must send nothing');

  r.app.setVisibility('hidden');
  r.app.fireDocument('visibilitychange');
  for (let i = 0; i < 4; i++) await settle();
  assert.ok(r.app.requests.length > before, 'a hidden visibilitychange must flush the pending save');
});

// ── The end-to-end rig: the REAL app.js, the REAL handler, the REAL sessionAccount ───────────────
//
// The sibling file injects the session answer. This one does not: the database error is staged
// inside the sessions query, so it travels the whole path a real one takes — `api/_session.js`'s
// catch, whatever `api/state.js` asks for, the status on the wire, and `_pushNow`'s branches. A rig
// that faked the resolver could not show the two answers are distinguishable at all, which is the
// single question S2 turns on.
//
//   `errorNextStatePuts(n)` the next n STATE-CARRYING PUTs hit a database error in the lookup.
//   `endSession()`          the session row is gone — the lookup succeeds and finds nothing.
//   `offlineNextStatePuts(n)` the next n state-carrying PUTs fail at the network, as being offline does.
//   `failKeepalive(on)`     every keepalive PUT fails at the network (the 64 KiB cap, a killed app).
function rig2({ sql = fakeDb(), store = {}, me = ALICE, cookie = COOKIE, accounts, stateReadFails = false } = {}) {
  const ssql = withSessions(sql, {
    accounts: accounts ?? { [TOKEN]: ALICE, [BOB_TOKEN]: BOB },
    fail: () => failLookup,
    failWrite: () => failWriteNow,
  });
  let failLookup = false;
  let failWriteNow = false;
  let writePuts = 0;
  let errorPuts = 0;
  let outage = false;
  let offlinePuts = 0;
  let keepaliveFails = false;
  let currentCookie = cookie;
  let heldKeepalive = null;
  let beforeNextSave = null;   // one-shot: runs as the next non-keepalive state PUT arrives
  const statuses = [];
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
      // A boot whose read fails leaves the page with NO BASE, which c23-A26 needs: an unload flush
      // claims no state while another write is travelling WITH a base ([BUG-100]), so "no base" is
      // the one shape in which a flush and an ordinary save can both carry state at once.
      if (method === 'GET' && stateReadFails) return { ok: false, status: 500, json: async () => ({ error: 'read failed' }) };
      const carriesState = method === 'PUT' && 'state' in JSON.parse(init.body);
      // THIS request's fate is decided before any mid-flight hook runs. Otherwise a hook that arms a
      // failure for LATER saves retroactively fails the save it rode in on — which is the whole point
      // of c23-A17, where one save must be accepted and the next must fail.
      const failsOffline = carriesState && offlinePuts > 0;
      if (failsOffline) offlinePuts -= 1;
      if (carriesState && !init.keepalive && beforeNextSave) {
        const fn = beforeNextSave; beforeNextSave = null; fn(); for (let i = 0; i < 4; i++) await settle();
      }
      if (carriesState && init.keepalive && keepaliveFails) throw new Error('keepalive body too large');
      // The reload race (19g): hold this page's unload save until the test lets it go, so the
      // reloaded page provably reads the row FIRST. Without a gate the two are merely interleaved by
      // the event loop and the ordering the criterion names is never actually staged.
      if (carriesState && init.keepalive && heldKeepalive) await heldKeepalive;
      if (failsOffline) throw new Error('Failed to fetch');
      if (carriesState && (outage || errorPuts > 0)) { if (!outage) errorPuts -= 1; failLookup = true; }
      if (carriesState && writePuts > 0) { writePuts -= 1; failWriteNow = true; }
      const handler = createStateHandler({ db: () => ssql, sessionAccount });
      const res = fakeRes();
      const headers = lowerKeys(init.headers);
      if (currentCookie) headers.cookie = currentCookie;       // the browser attaches it, not the app
      try {
        await handler(fakeReq({ method, headers, body: init.body ?? null }), res);
      } finally { failLookup = false; failWriteNow = false; }
      const body = JSON.parse(JSON.stringify(res.body ?? {}));
      statuses.push({ method, carriesState, keepalive: !!init.keepalive, status: res.statusCode, body });
      return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => body };
    }
    if (url.includes('/api/feed')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
    throw new Error(`unrouted request: ${url}`);
  });
  const boot = async () => { await app.ctx.init(); await drain(app); };
  return {
    app, sql, ssql, boot, statuses,
    errorNextStatePuts: (n = 1) => { errorPuts = n; },
    /** The next n state-carrying PUTs fail at the WRITE — the 500 `main` already answers. */
    failWrite: (n = 1) => { writePuts = n; },
    /** Run `fn` as the next ordinary save arrives, before it is answered — a mid-flight mutation. */
    beforeNextSave: (fn) => { beforeNextSave = fn; },
    /** The database is down for every state-carrying PUT until this is turned back off. */
    setOutage: (on) => { outage = on; },
    offlineNextStatePuts: (n = 1) => { offlinePuts = n; },
    failKeepalive: (on) => { keepaliveFails = on; },
    endSession: () => { ssql.session.accounts = {}; },
    setCookie: (c) => { currentCookie = c; },
    /** The page goes away, the way a browser does it — `pagehide` → `flushPush`. */
    close: async () => { app.fireWindow('pagehide'); for (let i = 0; i < 4; i++) await settle(); },
    /** Fire `pagehide` and do NOT wait for its keepalive to be answered — the reload race (19g). */
    closeWithoutSettling: () => { app.fireWindow('pagehide'); },
    /** Block this page's next unload save until the returned function is called. */
    holdKeepalive: () => {
      let release;
      heldKeepalive = new Promise((r) => { release = r; });
      return () => { heldKeepalive = null; release(); };
    },
    statusesOf: (kind) => statuses.filter((s) => s.carriesState).map((s) => s.status).filter((s) => kind == null || s === kind),
  };
}
async function drain(app) { for (let i = 0; i < 6; i++) { app.runTimers(4); await settle(); } }

/** Every state-carrying PUT this app sent from request index `from` on, with lower-cased headers. */
function statePuts(app, from = 0) {
  return app.requests.slice(from)
    .filter((r) => r.url.includes('/api/state') && r.init.method === 'PUT' && 'state' in JSON.parse(r.init.body))
    .map((r) => ({ headers: lowerKeys(r.init.headers), body: JSON.parse(r.init.body), keepalive: !!r.init.keepalive }));
}

// ── Criterion 19: round 2's losses are kept ─────────────────────────────────────────────────────
//
// Each case ends with the change in the account row, and none of them shows "Not syncing". RED on
// 458be33 — there the lookup error reads as "no session", the server 412s and the client clears the
// unsaved mark, so the change survives only if the page goes away cleanly AND that keepalive lands.
// Every case below removes one of those two conditions.
//
// WHAT EACH CASE ACTUALLY ASSERTS, measured in review round 3 rather than implied by this header, which
// previously said "AND on the device" and "never appeared" for the whole set:
//   - the notice: c19a and c19g read it on BOTH pages; c19b, c19c, c19d, c19e and c19f read it on the
//     RELOADED page only, so a mutation that raises it on the original page dies to c19a alone.
//   - the device's own copy: asserted by c19a, c19b (via `landed`) and c19h/c19i (the read-mark count);
//     c19c–c19f assert the account row only.
//   - a device row's absence: asserted by c19a, c19b and c19d's legacy arm; the rest do not look.
//
// `main`'s behaviour for each is in tasks/BUG-039.md → the options table; this file asserts the
// outcome rather than the mechanism, so the same tests would hold for any option that keeps them.

/** The whole account row's channel ids, plus what the device is left holding. */
const landed = (sql, app) => ({
  row: rowIds(sql.get('account', ALICE_ID)),
  device: ids(app.get('focus_channels')),
  deviceRow: sql.get('device', DEVICE_ID) ? rowIds(sql.get('device', DEVICE_ID)) : null,
});

test('[BUG-039] c19a: an outage spanning the save AND the page going away, reopened after it — the change is kept', async () => {
  // data safety F1, the round-2 HIGH. The outage covers the debounced save and the unload save, so
  // nothing about the page's exit can rescue it: the change survives only if the unsaved mark does.
  const sql = seeded();
  const r = rig2({ sql, store: aliceStore(sql) });
  await r.boot();
  r.setOutage(true);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  assert.ok(r.statusesOf().includes(503), `guard: the save must be answered 503, got ${r.statusesOf()}`);
  assert.equal(r.app.get('focus_dirty'), '1', 'an outage must leave the change marked unsaved');
  await r.close();
  r.setOutage(false);
  const back = rig2({ sql, store: Object.fromEntries(r.app.store) });
  await back.boot();
  assert.deepEqual(landed(sql, back.app),
    { row: ['UC_alice', 'UC_new'], device: ['UC_alice', 'UC_new'], deviceRow: null },
    'the change made during the outage must reach the account once it is over');
  assert.deepEqual([...notSyncing(r.app), ...notSyncing(back.app)], [], '"Not syncing" must not appear');
});

test('[BUG-039] c19b: the same outage, but the app is KILLED rather than closed — the change is kept', async () => {
  // No `pagehide`: an app killed from the task switcher, or a crash. Nothing is re-sent, so the only
  // thing that can carry the change across is the unsaved mark on disk.
  const sql = seeded();
  const r = rig2({ sql, store: aliceStore(sql) });
  await r.boot();
  r.setOutage(true);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  r.setOutage(false);
  const back = rig2({ sql, store: Object.fromEntries(r.app.store) });   // killed: no close()
  await back.boot();
  assert.deepEqual(landed(sql, back.app),
    { row: ['UC_alice', 'UC_new'], device: ['UC_alice', 'UC_new'], deviceRow: null });
  assert.deepEqual(notSyncing(back.app), [], '"Not syncing" must not appear');
});

test('[BUG-039] c19c: an earlier change that failed OFFLINE, then the outage — both changes are kept', async () => {
  // The second half of F1: the refusal did not only lose the change made during the outage, it
  // cleared a mark that was already standing for an earlier one. `main`'s 500 kept both.
  const sql = seeded();
  const r = rig2({ sql, store: aliceStore(sql) });
  await r.boot();
  r.offlineNextStatePuts(1);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_first')]);
  await drain(r.app);
  assert.equal(r.app.get('focus_dirty'), '1', 'guard: the offline save left the change unsaved');
  r.setOutage(true);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_first'), ...chans('UC_second')]);
  await drain(r.app);
  await r.close();
  r.setOutage(false);
  const back = rig2({ sql, store: Object.fromEntries(r.app.store) });
  await back.boot();
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_first', 'UC_second'],
    'both the offline change and the outage change must reach the account');
  assert.deepEqual(notSyncing(back.app), [], '"Not syncing" must not appear');
});

for (const [label, users] of [
  ['without a legacy device row', []],
  ['with a legacy device row', [{ kind: 'device', id: DEVICE_ID, state: { channels: chans('UC_legacy'), done: [] } }]],
]) {
  test(`[BUG-039] c19d: ONE lookup error, then the app is killed — the change is kept, ${label}`, async () => {
    // claims HIGH-1 / data safety F2. With a legacy row `main`'s write 409'd and kept the change;
    // the first build lost it in both shapes.
    const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }, ...users] });
    const legacyBefore = users.length ? JSON.stringify(sql.get('device', DEVICE_ID).state) : null;
    const r = rig2({ sql, store: aliceStore(sql) });
    await r.boot();
    r.errorNextStatePuts(1);
    r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
    await drain(r.app);
    assert.equal(r.app.get('focus_dirty'), '1', 'a lookup error must leave the change marked unsaved');
    const back = rig2({ sql, store: Object.fromEntries(r.app.store) });   // killed
    await back.boot();
    assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'],
      'the change must reach the account');
    assert.deepEqual(notSyncing(back.app), [], '"Not syncing" must not appear');
    if (users.length) {
      assert.equal(JSON.stringify(sql.get('device', DEVICE_ID).state), legacyBefore,
        'the legacy device row must be left exactly as it was');
    }
  });

  test(`[BUG-039] c19e: ONE lookup error and then a FAILING unload save — the change is kept, ${label}`, async () => {
    // claims MED-1: the unload save is not a guarantee. It fails at the 64 KiB keepalive cap, and on
    // a connection that is already gone. A change owed only in memory dies with the page.
    const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }, ...users] });
    const r = rig2({ sql, store: aliceStore(sql) });
    await r.boot();
    r.errorNextStatePuts(1);
    r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
    await drain(r.app);
    r.failKeepalive(true);
    await r.close();                                   // the page goes away; the keepalive never lands
    const back = rig2({ sql, store: Object.fromEntries(r.app.store) });
    await back.boot();
    assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'],
      'a failing unload save must not be the only thing carrying the change');
    assert.deepEqual(notSyncing(back.app), [], '"Not syncing" must not appear');
  });
}

test('[BUG-039] c19f: a store OVER the 64 KiB keepalive cap, one lookup error, then the page goes away', async () => {
  // The same as c19e, named separately because it is the shape that actually occurs: the unload save
  // does not fail randomly, it fails because the body is too big to send as a keepalive. A curated
  // account reaches 64 KiB long before it reaches the 256 KiB state cap.
  const big = Array.from({ length: 2000 }, (_, i) => `done-${i}-${'x'.repeat(20)}`);
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: { ...ALICE_ROW, done: big } }] });
  const r = rig2({ sql, store: aliceStore(sql, { focus_done: JSON.stringify(big) }) });
  await r.boot();
  r.errorNextStatePuts(1);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  r.failKeepalive(true);                               // over 64 KiB: the browser refuses to send it
  await r.close();
  const back = rig2({ sql, store: Object.fromEntries(r.app.store) });
  await back.boot();
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'],
    'an over-cap store must not depend on a keepalive it cannot send');
  assert.deepEqual(notSyncing(back.app), [], '"Not syncing" must not appear');
});

test('[BUG-039] c19g: the reload race — the unload save lands AFTER the reloaded page read the row', async () => {
  // claims HIGH-2. Under the first build the unload save re-sent a refused change; if it landed after
  // the new page had already read the row, that page's base was stale and its next save 409'd —
  // "Not syncing" came back, and Use saved copy then discarded the newer change. A 503 leaves the
  // change on disk instead of in flight, so there is no second writer to race.
  const sql = seeded();
  const r = rig2({ sql, store: aliceStore(sql) });
  await r.boot();
  r.errorNextStatePuts(1);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  const release = r.holdKeepalive();                    // the old page's unload save is pinned open
  r.closeWithoutSettling();                            // pagehide fired; its keepalive cannot land yet
  const back = rig2({ sql, store: Object.fromEntries(r.app.store) });
  await back.boot();                                   // the new page reads the row FIRST — the race
  release();                                           // only now does the old page's save arrive
  for (let i = 0; i < 8; i++) await settle();
  back.app.ctx.addDone('after-reload');
  await drain(back.app);
  assert.ok(!r.statusesOf().includes(409) && !back.statusesOf().includes(409),
    `no save may be answered 409: old=${r.statusesOf()} new=${back.statusesOf()}`);
  assert.deepEqual([...notSyncing(r.app), ...notSyncing(back.app)], [], '"Not syncing" must not appear');
  const row = sql.get('account', ALICE_ID).state;
  assert.ok((row.done || []).includes('after-reload'),
    `a change made after the reload must survive: ${JSON.stringify(row.done)}`);
});

// ── 19h–19i: a store over the 256 KiB cap ───────────────────────────────────────────────────────
//
// This is Risk 18 and the reason S2 is not S. Under C′ a 412 CLEARS the unsaved mark while a 413
// KEEPS it, so with the refusal ahead of the size check an over-cap store was told "account
// required", dropped its mark, and had its whole local copy replaced by the row on the next boot —
// the independent battery measured 30002 read marks going to 1, where `main` keeps them. Moving the
// refusal below the 400/413 checks is the whole fix, and these two assert the outcome.
const OVER_CAP = Array.from({ length: 30000 }, (_, i) => `done-${i}-${'x'.repeat(20)}`);

// SEED THE ROW TOO, not just the store. The first spelling seeded only `focus_done` and the boot's
// ordinary sync replaced it with the account row before the test had staged anything — so it went on
// asserting "30001 read marks" against a page that held 2, and the criterion it named was never
// exercised. CLAUDE.md's rule ("the server row will erase it") is written for a RESTORE; it bites a
// seed identically. Caught because the test stayed red after the fix that was supposed to green it.
const overCapRow = () => fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: { ...ALICE_ROW, done: OVER_CAP } }] });
const overCapStore = (sql) => aliceStore(sql, { focus_done: JSON.stringify(OVER_CAP) });

test('[BUG-039] c19h: an OVER-CAP store, one lookup error, then close and reload — local is kept', async () => {
  const sql = overCapRow();
  const r = rig2({ sql, store: overCapStore(sql) });
  await r.boot();
  r.errorNextStatePuts(1);
  r.app.ctx.addDone('one-more');
  await drain(r.app);
  // POSITIVE, not the absence of a 412. Round 3 found the negative form could not fail for any input in
  // this fixture: the lookup here ERRORS, so the refusal's answer would be 503 rather than 412 whichever
  // side of the size check it sat on, and `!includes(412)` is satisfied either way. Asserting the 413 is
  // PRESENT does distinguish them — put the refusal back above the size check and this reads 503.
  assert.ok(r.statusesOf().includes(413),
    `an over-cap state must be answered on its SIZE, before any refusal: ${r.statusesOf()}`);
  await r.close();
  const back = rig2({ sql, store: Object.fromEntries(r.app.store) });
  await back.boot();
  const done = JSON.parse(back.app.get('focus_done'));
  assert.ok(done.length > 30000,
    `the local copy must survive: ${done.length} read marks left of ${OVER_CAP.length + 1}`);
  assert.equal(back.app.get('focus_dirty'), '1', 'and stay marked unsaved — it still has not been stored');
});

for (const [label, users] of [
  ['without a legacy device row', []],
  ['with a legacy device row', [{ kind: 'device', id: DEVICE_ID, state: { channels: chans('UC_legacy'), done: [] } }]],
]) {
  test(`[BUG-039] c19i: an OVER-CAP store whose session really ENDS, a walled reload, then signing back in, ${label}`, async () => {
    // The case the rescope's stop rule caught: here the session is genuinely gone, so the refusal is
    // correct — but the state is over the cap, so the server has something to say about it FIRST.
    const sql = fakeDb({
      users: [{ kind: 'account', id: ALICE_ID, state: { ...ALICE_ROW, done: OVER_CAP } }, ...users],
    });
    const r = rig2({ sql, store: overCapStore(sql) });
    await r.boot();
    r.endSession();
    r.app.ctx.addDone('one-more');
    await drain(r.app);
    assert.ok(!r.statusesOf().includes(412),
      `size outranks the refusal even when the session really ended: ${r.statusesOf()}`);
    await r.close();
    // The wall: no cookie, /api/auth/me says 401.
    const walled = rig2({ sql, store: Object.fromEntries(r.app.store), me: 401, cookie: null });
    await walled.boot();
    // Signing back in, on this same browser.
    const back = rig2({ sql, store: Object.fromEntries(walled.app.store) });
    await back.boot();
    const done = JSON.parse(back.app.get('focus_done'));
    assert.ok(done.length > 30000,
      `the local copy must never be replaced by the row: ${done.length} read marks left of ${OVER_CAP.length + 1}`);
    assert.equal(back.app.get('focus_dirty'), '1', 'and stay marked unsaved');
  });
}

// ── Criterion 20: a 503 is an ordinary failure, not a refusal ───────────────────────────────────

for (const [label, arm] of [
  ['503 (the lookup could not be made)', (r) => r.errorNextStatePuts(1)],
  ['500 (the write failed)', (r) => r.failWrite(1)],
]) {
  test(`[BUG-039] c20a: after a save answered ${label}, nothing is cleared and nothing is said`, async () => {
    // The 500 arm is the CONTROL: it is an answer `main` already gives and the client already
    // handles, so the two columns must be identical. A mutation that routes 503 into the 412 branch
    // passes the 500 arm and dies on the 503 one.
    const sql = seeded();
    const r = rig2({ sql, store: aliceStore(sql) });
    await r.boot();
    const rev = r.app.get('focus_rev');
    r.app.ctx.track('probe', {}, 'feed');                  // something in the events buffer
    await settle();
    const events = r.app.get('focus_events');
    arm(r);
    r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
    // `advance(1600)`, NOT `drain`. The save debounce is 1500ms and track()'s analytics flush is
    // 3000ms, so draining every timer fires the analytics push too — it succeeds, drains the buffer,
    // and "the events are still buffered" then reads null for a reason that has nothing to do with
    // the failed state save. That is a test measuring the wrong quantity, and it is what the 500
    // control caught. The virtual clock fires the save and leaves the analytics timer pending.
    r.app.advance(1600);
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(r.app.get('focus_dirty'), '1', 'the change stays marked unsaved');
    assert.equal(r.app.get('focus_rev'), rev, 'the base is unchanged');
    assert.equal(r.app.get('focus_events'), events, 'the buffered events are still buffered');
    assert.deepEqual(r.app.toasts, [], `nothing may be said to the user: ${JSON.stringify(r.app.toasts)}`);
    // Not halted: the next save must actually go out and land.
    r.app.ctx.addDone('d2');
    await drain(r.app);
    const row = sql.get('account', ALICE_ID).state;
    assert.deepEqual(rowIds({ state: row }), ['UC_alice', 'UC_new'], 'the next save must land the change');
    assert.deepEqual(row.done, ['alice-done', 'd2'], 'and the one after it');
    assert.equal(r.app.get('focus_dirty'), null, 'and clear the mark once it lands');
  });
}

test('[BUG-039] c20b: once a 503 has been settled by a healthy save, the page going away sends NOTHING', async () => {
  // A 503 must not arm the in-page debt a 412 arms (`_refusalOwed`). If it did, every tab switch
  // after an outage would re-send the whole state — review round 1 measured that widening and its
  // cost, and c15b–c15f in the sibling file pin it from the other side.
  const sql = seeded();
  const r = rig2({ sql, store: aliceStore(sql) });
  await r.boot();
  r.errorNextStatePuts(1);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  r.app.ctx.addDone('d2');
  await drain(r.app);                                    // settled: the change has landed
  const before = r.app.requests.length;
  await r.close();
  assert.equal(r.app.requests.length, before,
    'a settled 503 must leave nothing owed when the page goes away');
});

test('[BUG-039] c20c: sign-out right after a 503 completes on the FIRST press, with the change in the account', async () => {
  // Sign-out's own save is exempt from the header, so it can never be refused — but it CAN be
  // answered 503 if the lookup fails during it. This pins that the exit path is unchanged by S2.
  const sql = seeded();
  const r = rig2({ sql, store: aliceStore(sql) });
  await r.boot();
  r.errorNextStatePuts(1);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  await r.app.ctx.signOut();
  await drain(r.app);
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'],
    'sign-out must carry the change up with it');
  assert.equal(r.app.get('focus_channels'), null, 'and clear local');
  assert.ok(r.app.navigations.some((n) => String(n).includes('/app')),
    `sign-out must complete on the first press: ${JSON.stringify(r.app.navigations)}`);
});

// ── Criterion 21: a lookup error followed by someone else is what an OFFLINE save is today ──────
//
// Parity, asserted as parity: each sequence is run twice, identically, differing only in HOW the
// first save failed. The offline arm is the reference — it is `main`'s behaviour, unchanged by this
// task — so a deepEqual between the two says "this introduces no new user-visible outcome" without
// anyone having to write down what that outcome is. Risk 22.
async function afterFailedSave(how, nextEvent) {
  const sql = fakeDb({
    users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }, { kind: 'account', id: BOB_ID, state: BOB_ROW }],
  });
  const r = rig2({ sql, store: aliceStore(sql) });
  await r.boot();
  if (how === 'offline') r.offlineNextStatePuts(1); else r.errorNextStatePuts(1);
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  return nextEvent({ sql, r });
}

const observe = (app, sql) => ({
  channels: ids(app.get('focus_channels')),
  done: JSON.parse(app.get('focus_done') || 'null'),
  notSyncing: notSyncing(app),
  aliceRow: rowIds(sql.get('account', ALICE_ID)),
  bobRow: rowIds(sql.get('account', BOB_ID)),
  deviceRow: sql.get('device', DEVICE_ID) ? rowIds(sql.get('device', DEVICE_ID)) : null,
});

const SEQUENCES = {
  'another account signs in here': async ({ sql, r }) => {
    const bob = rig2({ sql, store: Object.fromEntries(r.app.store), me: BOB, cookie: BOB_COOKIE });
    await bob.boot();
    return observe(bob.app, sql);
  },
  'another device writes the row': async ({ sql, r }) => {
    const row = sql.get('account', ALICE_ID);
    row.state = { ...ALICE_ROW, done: [...ALICE_ROW.done, 'from-the-phone'] };
    row.updated_at = new Date(new Date(row.updated_at).getTime() + 5000);
    r.app.ctx.addDone('d2');
    await drain(r.app);
    return observe(r.app, sql);
  },
  "the account's row appears elsewhere": async ({ sql, r }) => {
    const back = rig2({ sql, store: Object.fromEntries(r.app.store) });
    await back.boot();
    return observe(back.app, sql);
  },
};

for (const [name, sequence] of Object.entries(SEQUENCES)) {
  test(`[BUG-039] c21: a lookup error then ${name} — identical to the same sequence after an OFFLINE save`, async () => {
    const offline = await afterFailedSave('offline', sequence);
    const lookupError = await afterFailedSave('error', sequence);
    assert.deepEqual(lookupError, offline,
      'a lookup error must leave the user exactly where an offline save leaves them:\n' +
      `  offline:      ${JSON.stringify(offline)}\n  lookup error: ${JSON.stringify(lookupError)}`);
  });
}

// ── Criterion 23: round 2's remaining gaps ──────────────────────────────────────────────────────
//
// PINS, every one green on 458be33. They exist because review round 2 found each of these guards
// completely unpinned — a mutation could remove it and the suite stayed green — not because the
// behaviour is wrong today. Each is shown able to fail by mutations/BUG-039-r2.mjs.

test('[BUG-039] c23-X04: a 412 on the UNLOAD save clears the mark, so the next account loads its own row', async () => {
  // Battery X04. The unload save takes the same 412 branch as an ordinary one, and nothing asserted
  // it: a mutation scoping the branch to non-keepalive pushes left `focus_dirty` set on the way out,
  // and the next boot — Bob's — would then push Alice's copy under Bob's session.
  const sql = fakeDb({
    users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }, { kind: 'account', id: BOB_ID, state: BOB_ROW }],
  });
  const alice = rig2({ sql, store: aliceStore(sql) });
  await alice.boot();
  alice.endSession();                                  // really ended, so the refusal is correct
  alice.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await alice.close();                                 // the change goes out on the unload save
  assert.ok(alice.statusesOf().includes(412), `guard: the unload save was refused: ${alice.statusesOf()}`);
  assert.equal(alice.app.get('focus_dirty'), null, 'a 412 on the way out must still clear the mark');
  const bobBefore = JSON.stringify(sql.get('account', BOB_ID).state);
  const bob = rig2({ sql, store: Object.fromEntries(alice.app.store), me: BOB, cookie: BOB_COOKIE });
  await bob.boot();
  assert.deepEqual(ids(bob.app.get('focus_channels')), ['UC_bob'],
    `Bob was shown another account's channels: ${bob.app.get('focus_channels')}`);
  assert.equal(JSON.stringify(sql.get('account', BOB_ID).state), bobBefore, "Bob's row changed");
  assert.deepEqual(notSyncing(bob.app), [], '"Not syncing" must not appear for Bob');
});

for (const value of ['true', 'yes', '0', '', '11']) {
  test(`[BUG-039] c23-S05: only the header value '1' declares — "${value}" does not`, async () => {
    // Battery S05. `=== '1'` was unpinned in the loosening direction: a mutation to a truthiness
    // check would refuse every old client that ever sends this header name, and nothing failed.
    const sql = fakeDb();
    const r = await put({
      sql, session: noSession, headers: { 'x-require-account': value },
      body: JSON.stringify({ uid: DEVICE_ID, state: STATE }),
    });
    assert.equal(r.res.statusCode, 200, `"${value}" is not a declaration and must be written as today`);
    assert.deepEqual(rowIds(sql.get('device', DEVICE_ID)), ['UC_new'], 'and land in the device namespace');
  });
}

test('[BUG-039] c23-P01: a session answer with an id but NO email still writes the account row', async () => {
  // Battery P01. The refusal keys on `account.accountId`, deliberately — exactly the condition under
  // which resolveOwner would not address the account. A mutation keying it on the email instead
  // would refuse every save from an account row whose email is null, and nothing asserted otherwise.
  const sql = fakeDb({ users: [{ kind: 'account', id: ALICE_ID, state: ALICE_ROW }] });
  const rev = toCharUS(sql.get('account', ALICE_ID).updated_at);
  const r = await put({
    sql, session: async () => ({ accountId: ALICE_ID }),
    headers: { 'x-state-rev': rev },
    body: JSON.stringify({ uid: DEVICE_ID, state: { ...ALICE_ROW, channels: chans('UC_alice', 'UC_new') } }),
  });
  assert.equal(r.res.statusCode, 200, 'an account with no email is still an account');
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'], 'and its row is written');
  assert.equal(sql.get('device', DEVICE_ID), undefined, 'with nothing in the device namespace');
});

test('[BUG-039] c23-A17: an accepted save settles the refusal even when a mid-flight change then fails', async () => {
  // Battery A17. c15f pins that an accepted save settles the debt; it does not pin the case where
  // that save is accepted but NOT confirmed, because a mutation landed while it was in flight. The
  // debt is settled by `accepted`, deliberately, and only this distinguishes the two.
  const sql = seeded();
  const r = rig2({ sql, store: aliceStore(sql) });
  await r.boot();
  r.errorNextStatePuts(0);
  r.offlineNextStatePuts(0);
  // A refusal, so something is owed.
  r.endSession();
  r.app.ctx.saveChannels([...ALICE_ROW.channels, ...chans('UC_new')]);
  await drain(r.app);
  assert.ok(r.statusesOf().includes(412), `guard: the save was refused: ${r.statusesOf()}`);
  // The session comes back; the next save is accepted, but a change lands while it is in flight — so it
  // is ACCEPTED and NOT CONFIRMED, which is the only state that tells the two spellings apart.
  r.ssql.session.accounts = { [TOKEN]: ALICE };
  // The hook makes the mid-flight change AND arms the failure for every save after this one, so the
  // save in flight is accepted while the change it raced is the one that fails.
  r.beforeNextSave(() => { r.app.ctx.addDone('mid-flight'); r.offlineNextStatePuts(9); });
  r.app.ctx.addDone('d2');
  await drain(r.app);
  assert.deepEqual(rowIds(sql.get('account', ALICE_ID)), ['UC_alice', 'UC_new'],
    'guard: the accepted save carried the owed change up');
  assert.equal(r.app.get('focus_dirty'), '1', 'guard: the mid-flight change failed and is still unsaved');
  // ...AND THAT MID-FLIGHT CHANGE THEN FAILS — the criterion's own words, and the half this test was
  // missing. With it succeeding instead, the follow-up save is accepted AND confirmed, which settles
  // the debt under `confirmed` too: the mutation that narrows `accepted` to `confirmed` (N22) survived
  // the first spelling of this test. A failed save leaves the page dirty but quiet — no timer, no
  // events — so the close is decided by the debt alone.
  r.offlineNextStatePuts(0);
  r.app.advance(4000);                                 // drain the analytics buffer so it cannot trigger
  for (let i = 0; i < 6; i++) await settle();
  const before = r.app.requests.length;
  await r.close();
  assert.deepEqual(statePuts(r.app, before), [],
    'an accepted save settles the debt even when it could not be confirmed — nothing is still owed');
});

test('[BUG-039] c23-A26: Use saved copy settles a refusal left owed on a HALTED page', async () => {
  // Battery A26 / round-1 mutation R13. A page can be both halted and owed, and `adoptServerCopy` is
  // the one action that resolves a halt — so it must drop the debt too, or the page keeps a flag that
  // outlives the thing it stood for.
  //
  // REACHING THAT STATE IS THE WHOLE TEST, and the first spelling did not. Refusing and then halting
  // does not work: the 409 branch clears `_refusalOwed` itself, so the adopt's clear is redundant and
  // R13 survived. It has to be the other order — a 412 answered AFTER a 409 — and `_pushNow`'s halt
  // gate returns before any fetch, so a push that STARTS while halted never reaches the server.
  //
  // The one route in is the unload flush: `pushNow` lets a keepalive SKIP the in-flight queue, so a
  // flush that passed the halt gate before the 409 landed is still in the air, and its 412 is
  // processed afterwards. That is the sequence below, and it is why the round-1 header's
  // "a halted page sends no state push that a 412 could refuse" is false — true of pushes that start
  // after the halt, not of one already in flight.
  // NO BASE, from a boot that READ SUCCESSFULLY and found no row — not from a failed read. Both leave
  // the page base-less, and only this one leaves it able to push at all: a failed read leaves
  // `_stateLoaded` false, and `_pushNow` then downgrades every push to analytics-only (BUG-056), so
  // no state save can be refused or halted. Measured, after the failed-read version sent nothing.
  //
  // The base matters because `flushPush` claims no state while another write is travelling WITH one
  // ([BUG-100]) — so with a base the flush is analytics-only and can never be refused, and "no base"
  // is the single shape where a flush and an ordinary save both carry state at the same moment.
  const sql = fakeDb();
  // And nothing to CLAIM, or the boot's first push creates the row and comes back with a base.
  const r = rig2({ sql, store: { focus_was_authed: '1' } });
  await r.boot();
  assert.equal(r.app.get('focus_rev'), null, 'guard: this page must hold no base');
  // Another device creates the account row. A no-base save against a row that already exists is
  // exactly what the server answers 409 — it may create, never overwrite.
  sql.rows.push({ kind: 'account', id: ALICE_ID, state: ALICE_ROW, updated_at: new Date('2026-02-01T00:00:00.000Z') });
  // As the save reaches the server: pin an unload flush open and send the page away, so the flush
  // starts and passes the halt gate while it is still clear.
  let release = null;
  r.beforeNextSave(() => {
    release = r.holdKeepalive();
    // Something must be PENDING or flushPush returns without sending: its trigger is a pending save
    // timer, a pending analytics timer, buffered events or an owed refusal — and at this instant the
    // save timer has already fired and the analytics buffer has already drained. A tracked event arms
    // it, and the payload is still state-carrying because a change is outstanding and there is no base.
    r.app.ctx.track('probe', {}, 'feed');
    r.app.fireWindow('pagehide');
  });
  r.app.ctx.saveChannels(chans('UC_mine'));
  await drain(r.app);
  assert.ok(r.statusesOf().includes(409), `guard: the page must be halted by a 409: ${r.statusesOf()}`);
  // The session ends only NOW — after the 409 and before the held flush is let go, so the ordinary
  // save is answered on its stale base and the flush on its missing session. Ending it earlier makes
  // BOTH requests 412 and the page is never halted at all.
  r.endSession();
  release();                                     // only now does the flush's PUT arrive — and it 412s
  for (let i = 0; i < 8; i++) await settle();
  assert.ok(r.statusesOf().includes(412),
    `guard: the unload save must be refused AFTER the halt: ${r.statusesOf()}`);
  // The page is halted AND owed. The user presses the one action that resolves a halt.
  r.ssql.session.accounts = { [TOKEN]: ALICE };
  await r.app.ctx.adoptServerCopy();
  await drain(r.app);
  r.app.advance(4000);                           // drain analytics so it cannot trigger the flush
  for (let i = 0; i < 6; i++) await settle();
  const before = r.app.requests.length;
  await r.close();
  assert.deepEqual(statePuts(r.app, before), [],
    'using the saved copy must settle what the refusal owed, not re-send the discarded change');
  // WHAT THIS DOES NOT PIN, measured rather than assumed. It does not kill round-1's mutation R13
  // (the clear deleted from adoptServerCopy). With the debt left set the close still fires the flush —
  // but the adopt has already cleared `dirty` and `_stateOutstanding`, so nothing is pending and the
  // payload degrades to ANALYTICS-ONLY. Asserting "no request at all" instead does not work either:
  // the adopt buffers its own event, so a request goes out on correct code too. The honest cost of
  // deleting that clear is one redundant analytics-only push in this narrow race, and R13 stays a
  // DECLARED survivor with that reasoning. See mutations/BUG-039-r1.mjs R13 for the full correction —
  // including the two earlier explanations, both of which were wrong in different directions.
});
