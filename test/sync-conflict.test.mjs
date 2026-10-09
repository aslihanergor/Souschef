// BUG-047 attempt 4 — refuse a stale write. The SERVER half.
//
// Sync moves from last-write-wins to refuse-a-stale-write. The client echoes an opaque `rev` token
// it can only have obtained from a pull it applied or a push the server accepted; the server writes
// only if the row still carries that rev, and otherwise writes NOTHING and answers 409.
//
// Every assertion here is on the ROW, not on the status code. Attempt 2 reached review green with a
// 409 branch that was dead code — asserting the status proves the handler decided something, never
// that the user's channels survived. `snapshot()` before/after is the claim.
//
// Two write paths, not one. `api/state.js` upserts when the state carries user data and bare-UPDATEs
// when it does not, and BOTH replace the whole blob. The BUG-057 control (2026-08-23) measured an
// empty browser's blob landing through the UPDATE branch onto a populated row, so a guard on the
// upsert alone would leave the measured wipe path open while criterion 1 read as met.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateHandler } from '../api/state.js';
import { fakeDb, fakeReq, fakeRes, snapshot } from '../test-helpers/handler.mjs';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID  = '22222222-2222-4222-8222-222222222222';
const SESSION    = { accountId: ACCOUNT_ID, email: 'a@example.com' };

// What the victim stands to lose.
const VICTIM = { channels: [{ id: 'UCvictim', name: 'Victim channel', source: 'youtube' }], done: ['v1', 'v2'] };
// What an intruding client would write over it. Carries user data, so it takes the UPSERT path.
const INTRUDER = { channels: [{ id: 'UCintruder', name: 'Intruder', source: 'youtube' }], done: [] };
// Prefs only — no channels/done/archive, so it takes the bare-UPDATE path (BUG-052 / BUG-057).
const PREFS_ONLY = { channels: [], done: [], archive: [], theme: 'dark', shorts: null, groups: null };

function mk({ users = [{ kind: 'account', id: ACCOUNT_ID, state: VICTIM }], account = SESSION } = {}) {
  const sql = fakeDb({ users });
  return { sql, handler: createStateHandler({ db: () => sql, sessionAccount: async () => account }) };
}
const row = (sql, id = ACCOUNT_ID, kind = 'account') => sql.rows.find((r) => r.kind === kind && r.id === id);

async function get({ sql, handler }, headers = {}) {
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', headers: { 'x-device-id': DEVICE_ID, ...headers } }), res);
  return res;
}
async function put({ sql, handler }, body, headers = {}) {
  const res = fakeRes();
  await handler(fakeReq({ method: 'PUT', body, headers: { 'x-device-id': DEVICE_ID, ...headers } }), res);
  return res;
}

test('S1 GET hands back a rev for an existing row, and none when there is no row', async () => {
  const a = mk();
  const hit = await get(a);
  assert.equal(hit.statusCode, 200);
  assert.equal(typeof hit.body.rev, 'string', 'the client cannot declare a base it was never given');
  assert.match(hit.body.rev, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);

  const empty = mk({ users: [] });
  const miss = await get(empty);
  assert.equal(miss.body.state, null);
  assert.equal(miss.body.rev, null, 'no row → no base');
});

test('S2 a MATCHING rev writes, and the response carries the NEW rev', async () => {
  const a = mk();
  const { rev } = (await get(a)).body;
  const res = await put(a, { state: INTRUDER }, { 'x-state-rev': rev });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(row(a.sql).state, INTRUDER, 'a client that read the row may write it');
  assert.equal(typeof res.body.rev, 'string');
  assert.notEqual(res.body.rev, rev, 'the base must advance, or the next write replays a stale one');
});

test('S3 a STALE rev writes NOTHING and answers 409 — the row is byte-identical', async () => {
  const a = mk();
  const before = snapshot(row(a.sql));
  const res = await put(a, { state: INTRUDER }, { 'x-state-rev': '2020-01-01T00:00:00.000000' });
  assert.equal(res.statusCode, 409);
  assert.equal(snapshot(row(a.sql)), before, 'THE ROW IS THE CLAIM, not the status code');
});

test('S4 NO rev on an EXISTING row is refused — create is allowed, overwrite never is', async () => {
  // Punch-list item 1: `SK.rev` is acquired only by an applied pull or an accepted push, so the
  // first push after deploy has no rev — and that is the dangerous one. Attempt 3 accepted it
  // unconditionally, which is the whole bug surviving its own fix.
  const a = mk();
  const before = snapshot(row(a.sql));
  const res = await put(a, { state: INTRUDER });
  assert.equal(res.statusCode, 409);
  assert.equal(snapshot(row(a.sql)), before);
});

test('S5 NO rev and NO row still CREATES — adopt-on-login survives', async () => {
  const a = mk({ users: [] });
  const res = await put(a, { state: INTRUDER });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(row(a.sql).state, INTRUDER, 'claiming your own feed on first sign-in must work');
});

test('S6 a prefs-only PUT with no row creates nothing and says so (BUG-052 preserved, BUG-057)', async () => {
  const a = mk({ users: [] });
  const res = await put(a, { state: PREFS_ONLY });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.updatedAt, null, 'the client must be able to tell nothing was stored');
  assert.equal(a.sql.rows.length, 0, 'an empty browser must not manufacture a row');
});

test('S7 a prefs-only PUT with a STALE rev cannot empty a populated row', async () => {
  // The exact shape the BUG-057 control measured: local channels [], a populated account row,
  // 200 OK, row silently emptied. This is the branch that did it.
  const a = mk();
  const before = snapshot(row(a.sql));
  const res = await put(a, { state: PREFS_ONLY }, { 'x-state-rev': '2020-01-01T00:00:00.000000' });
  assert.equal(res.statusCode, 409);
  assert.equal(snapshot(row(a.sql)), before, 'channels and done must survive');
});

test('S8 a matching rev on the prefs-only path still writes (a real clear must sync)', async () => {
  // The mirror of S7, and it is why the guard cannot simply refuse every empty state: removing every
  // channel is a real action that has to reach the server.
  const a = mk();
  const { rev } = (await get(a)).body;
  const res = await put(a, { state: PREFS_ONLY }, { 'x-state-rev': rev });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(row(a.sql).state.channels, [], 'a deliberate clear by a client that read the row');
});

test('S9 a rev taken from a real response matches on the NEXT write (the round-trip risk)', async () => {
  // `timestamptz::text` renders through session GUCs, so a naive token can drift between two Neon
  // HTTP requests and 409 EVERY write. The rev must survive read → echo → compare.
  const a = mk();
  let { rev } = (await get(a)).body;
  for (let i = 0; i < 3; i++) {
    // Non-vacuity guard. Without it `rev` is `undefined` at every step, every write is accepted for
    // reasons unrelated to the token, and the loop asserts nothing at all — the [BUG-091] shape.
    assert.equal(typeof rev, 'string', `round ${i} must carry a real base, not undefined`);
    const res = await put(a, { state: { ...INTRUDER, done: [`v${i}`] } }, { 'x-state-rev': rev });
    assert.equal(res.statusCode, 200, `write ${i} must be accepted`);
    rev = res.body.rev;
  }
  assert.deepEqual(row(a.sql).state.done, ['v2']);
});

test('S10 a 409 does not strand the analytics riding on it', async () => {
  const a = mk();
  const res = await put(a, {
    state: INTRUDER,
    events: [{ name: 'view', section: 'feed', ts: Date.now() }],
  }, { 'x-state-rev': '2020-01-01T00:00:00.000000' });
  assert.equal(res.statusCode, 409);
  assert.equal(a.sql.events.length > 0, true, 'events are attributed independently of the state row');
});

test('S11 the namespace isolation BUG-019 closed is untouched by any of this', async () => {
  // An anonymous request naming an account id still cannot reach it, rev or no rev.
  const a = mk({ account: null });
  const before = snapshot(row(a.sql));
  await put(a, { state: INTRUDER, uid: ACCOUNT_ID }, { 'x-device-id': ACCOUNT_ID });
  assert.equal(snapshot(row(a.sql)), before, 'the account row must be unreachable from the device namespace');
});

test('S12 a 409 hands back NO rev — a refusal must not re-base the client', async () => {
  // Criterion 4: the base is refreshed only by a pull the client applied or a push the server
  // accepted. A 409 is neither. Returning the current rev here would let a client re-base from a
  // refusal and retry immediately — which is the overwrite this whole mechanism exists to prevent,
  // re-armed through the error path. Cheap to add, invisible to review, so it is pinned.
  const a = mk();
  const res = await put(a, { state: INTRUDER }, { 'x-state-rev': '2020-01-01T00:00:00.000000' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.rev, undefined, 'a refusal must not hand the client a fresh base');
  assert.equal(res.body.updatedAt, undefined);
});

test('S13 a rev is ignored entirely on an events-only PUT', async () => {
  // An events-only PUT claims no state, so it has no base to be stale. If a rev could refuse one,
  // a halted client would also stop reporting analytics — blinding the metric on exactly the
  // sessions worth measuring.
  const a = mk();
  const before = snapshot(row(a.sql));
  const res = await put(a, { events: [{ name: 'view', section: 'feed', ts: Date.now() }] },
    { 'x-state-rev': '2020-01-01T00:00:00.000000' });
  assert.equal(res.statusCode, 200, 'analytics must ride through a stale base');
  assert.equal(snapshot(row(a.sql)), before, 'and must still not touch the row');
  assert.equal(a.sql.events.length > 0, true);
});

test('S14 a prefs-only PUT with NO rev cannot empty a populated row either', async () => {
  // The sibling of S7, and the gap M4 exposed: S7 covered a STALE base, nothing covered NO base.
  // Both reach the same bare-UPDATE branch, and it is the branch the BUG-057 control measured an
  // empty browser emptying a real row through. A guard that only catches the stale case leaves the
  // commoner one — a browser that never read the row at all — wide open.
  const a = mk();
  const before = snapshot(row(a.sql));
  const res = await put(a, { state: PREFS_ONLY });
  assert.equal(res.statusCode, 409, 'no base means no standing to replace a row');
  assert.equal(snapshot(row(a.sql)), before, 'channels and done must survive');
});

test('S15 a rev is honoured through surrounding whitespace', async () => {
  // The trim in readRev is deliberate: the token crosses a proxy, and a spurious space would
  // otherwise refuse every write from a client that is perfectly up to date — total sync failure
  // from a stray character, which is the same total-failure class as the ::text drift in item 7.
  const a = mk();
  const { rev } = (await get(a)).body;
  const res = await put(a, { state: INTRUDER }, { 'x-state-rev': `  ${rev}  ` });
  assert.equal(res.statusCode, 200, 'a padded but correct base is still correct');
  assert.deepEqual(row(a.sql).state, INTRUDER);
});

test('S16 GET says WHICH NAMESPACE answered, on both of them', async () => {
  // Fix B's server half. api/_session.js returns null on a DB blip as well as on expiry, so a
  // signed-in client's GET can silently resolve to the device namespace. The response used to carry
  // nothing the client could check that against.
  const seeded = [
    { kind: 'account', id: ACCOUNT_ID, state: { channels: [{ id: 'UCacct' }] } },
    { kind: 'device', id: DEVICE_ID, state: { channels: [{ id: 'UCdev' }] } },
  ];
  const a = await get(mk({ users: seeded }));
  assert.equal(a.body.kind, 'account', 'a session resolves to the account namespace, and says so');
  assert.ok(JSON.stringify(a.body.state).includes('UCacct'), 'guard: it really is the account row');

  const d = await get(mk({ users: seeded, account: null }));
  assert.equal(d.body.kind, 'device', 'and without one it resolves to the device namespace');
  assert.ok(JSON.stringify(d.body.state).includes('UCdev'), 'guard: it really is the device row');

  // Also on the EMPTY answer: a client with no row still needs to know which namespace has none.
  const e = await get(mk({ users: [], account: null }));
  assert.equal(e.body.state, null);
  assert.equal(e.body.kind, 'device', 'the no-row answer names its namespace too');
});

test('S17 (R21) a base that is not a STRING is no base at all', async () => {
  // readRev's `typeof raw === 'string'` term was uncovered. Node's header parsing hands a repeated
  // header back as an ARRAY, and `['x'].trim` does not exist — so a loosened readRev either throws
  // (500 on every write) or, worse, lets a non-string through to a comparison that can never match.
  //
  // The rule the type check protects: anything absent, empty or not a string is "no base declared",
  // which is a WEAKER claim and never a stronger one. So a malformed header can cost a client its
  // write; it must never earn it one. Asserted on the STORED ROW, not on the status code.
  for (const bad of [['a', 'b'], 42, {}, true, '', '   ']) {
    const a = mk();
    const before = snapshot(row(a.sql));
    const res = await put(a, { state: INTRUDER }, { 'x-state-rev': bad });
    assert.equal(res.statusCode, 409, `a ${JSON.stringify(bad)} base must not be honoured`);
    assert.equal(snapshot(row(a.sql)), before, 'and the victim row must be byte-identical');
  }
});

test('S18 a malformed base may still CREATE — "no base" is weaker, never stronger', async () => {
  // The rule readRev's type check exists to protect, asserted on the OUTCOME rather than the type.
  // Anything absent, empty or not a string is "no base declared", and a no-base write may create but
  // never overwrite. So a client sending a mangled header must still be able to claim an empty
  // namespace — refusing it there would be a denial of service to a client that has done nothing
  // wrong, which is the consequence review round 4's R21 predicted.
  const empty = mk({ users: [] });
  const res = await put(empty, { state: INTRUDER }, { 'x-state-rev': ['a', 'b'] });
  assert.equal(res.statusCode, 200, 'a malformed base must not stop a legitimate CREATE');
  assert.ok(row(empty.sql), 'and the row must actually exist afterwards');
});
