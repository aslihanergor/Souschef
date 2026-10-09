// /api/state handler tests (BUG-019 — IDOR: anonymous cross-account read/write).
//
// The vulnerability: with no session, `owner` came straight from a client-supplied id, and the
// `users` table had no way to tell an account row from a device row. Anyone holding another
// person's id read and overwrote their channels, done list and archive.
//
// These assert on stored state, not on responses alone — "a 4xx came back" is not the same claim
// as "the victim's data is untouched", and only the second one is worth anything here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateHandler } from '../api/state.js';
import { fakeDb, fakeReq, fakeRes, snapshot } from '../test-helpers/handler.mjs';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_DEVICE = '33333333-3333-4333-8333-333333333333';

const VICTIM_STATE = { channels: [{ id: 'UCsecret', title: 'Private channel' }], done: ['v1'] };

// Build a handler over a seeded fake store. `account` is what the session resolver returns:
// null = signed out (the vulnerable path), an object = signed in.
function handlerWith({ users = [], account = null } = {}) {
  const sql = fakeDb({ users });
  const handler = createStateHandler({ db: () => sql, sessionAccount: async () => account });
  return { handler, sql };
}

const accountRow = (state = VICTIM_STATE) => ({ kind: 'account', id: ACCOUNT_ID, state });
const deviceRow = (id = DEVICE_ID, state = { channels: [] }) => ({ kind: 'device', id, state });

// Read the row's current base, exactly as a real client does before it writes.
//
// Since [BUG-047] an existing row can only be overwritten by a client that declares the base it
// read: create is always allowed, overwrite never is. Tests below that write over a SEEDED row
// therefore have to read first — that is the precondition changing, not the assertion. Each such
// test keeps every assertion it had; only the missing read is added. The rule the change enforces
// has its own coverage in test/sync-conflict.test.mjs (S3, S4, S7).
async function baseOf(handler, headers) {
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', headers }), res);
  return res.body.rev;
}

// ── The account-row IDOR ────────────────────────────────────────────────────

test('no-session GET with a valid account id never returns that account row', async () => {
  const { handler } = handlerWith({ users: [accountRow()] });
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', query: { uid: ACCOUNT_ID } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.state, null, 'anonymous request read an account row');
});

test('the same GET with a valid session returns the real state', async () => {
  const { handler } = handlerWith({
    users: [accountRow()],
    account: { accountId: ACCOUNT_ID, email: 'a@example.com' },
  });
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', query: {} }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.state, VICTIM_STATE);
});

test('no-session PUT with a valid account id leaves that row byte-identical', async () => {
  const { handler, sql } = handlerWith({ users: [accountRow()] });
  const before = snapshot(sql.get('account', ACCOUNT_ID).state);

  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    body: { uid: ACCOUNT_ID, state: { channels: [{ id: 'UCevil', title: 'Injected' }], done: [] } },
  }), res);

  const after = snapshot(sql.get('account', ACCOUNT_ID).state);
  assert.equal(after, before, 'anonymous PUT modified an account row');
});

// The pair above only ever reaches the INSERT. Every fixture in this file carries real channels, so
// `hasUserData` is true and the `on conflict (kind, id)` upsert is the only statement exercised —
// which left BUG-052's second, DESTRUCTIVE statement (`update … where kind = ? and id = ?`) with no
// isolation coverage at all. Deleting `kind` from that WHERE was a 357/357-green mutation, and under
// it an anonymous PUT wipes any account row whose id the caller can name: the BUG-019 shape again,
// in a statement `grep "on conflict"` cannot find. Both directions, as above. (Round 5, H1.)

test('no-session EMPTY-state PUT with a valid account id leaves that row byte-identical', async () => {
  const { handler, sql } = handlerWith({ users: [accountRow()] });
  const before = snapshot(sql.get('account', ACCOUNT_ID).state);

  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    body: { uid: ACCOUNT_ID, state: { channels: [], done: [], archive: [] } },
  }), res);

  assert.equal(res.statusCode, 200);
  const after = snapshot(sql.get('account', ACCOUNT_ID).state);
  assert.equal(after, before,
    'an anonymous empty-state PUT reached across into the ACCOUNT namespace');
});

test('a signed-in EMPTY-state PUT does not clear a device row planted under the account id', async () => {
  // The mirror: the update branch must not reach out of the account namespace either. Only the
  // device row exists, so the correct statement matches nothing and returns 200 with no updatedAt.
  const { handler, sql } = handlerWith({
    users: [{ kind: 'device', id: ACCOUNT_ID, state: { channels: [{ id: 'UCplanted' }] } }],
    account: { accountId: ACCOUNT_ID, email: 'a@example.com' },
  });
  const before = snapshot(sql.get('device', ACCOUNT_ID).state);

  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: { state: { channels: [], done: [], archive: [] } },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.updatedAt, null, 'nothing should have been updated — no account row exists');
  assert.equal(snapshot(sql.get('device', ACCOUNT_ID).state), before,
    'a signed-in empty-state PUT cleared a DEVICE row sharing the account id');
});

test('an account id cannot resolve a device row planted under the same id', async () => {
  // The mirror image: an attacker pre-creates a device row keyed by a known account id, hoping
  // the signed-in read picks it up. Namespaces must isolate in both directions.
  const { handler } = handlerWith({
    users: [{ kind: 'device', id: ACCOUNT_ID, state: { channels: [{ id: 'UCplanted' }] } }],
    account: { accountId: ACCOUNT_ID, email: 'a@example.com' },
  });
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', query: {} }), res);

  assert.equal(res.body.state, null, 'signed-in read picked up a device row');
});

// ── The anonymous device path still works ───────────────────────────────────

test('device state round-trips on the anonymous path', async () => {
  const { handler, sql } = handlerWith();
  const mine = { channels: [{ id: 'UCmine', title: 'Mine' }], done: [] };

  const put = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: { uid: DEVICE_ID, state: mine },
  }), put);
  assert.equal(put.statusCode, 200);

  const get = fakeRes();
  await handler(fakeReq({ method: 'GET', headers: { 'x-device-id': DEVICE_ID }, query: {} }), get);
  assert.deepEqual(get.body.state, mine);
  assert.ok(sql.get('device', DEVICE_ID), 'the row was not stored in the device namespace');
});

test('one device cannot read another device row', async () => {
  const { handler } = handlerWith({ users: [deviceRow(DEVICE_ID, { channels: [{ id: 'UCtheirs' }] })] });
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', headers: { 'x-device-id': OTHER_DEVICE }, query: {} }), res);

  assert.equal(res.body.state, null);
});

// ── The signed-in gate ignores any client-supplied id ───────────────────────

test('a PUT with a session and a foreign uid writes to the session account row', async () => {
  const { handler, sql } = handlerWith({
    users: [accountRow({ channels: [], done: [] })],
    account: { accountId: ACCOUNT_ID, email: 'a@example.com' },
  });
  const mine = { channels: [{ id: 'UCmine' }], done: [] };
  // The session resolves the ACCOUNT row, so that is the row whose base this client reads — which is
  // itself part of what this test asserts: a foreign uid redirects neither the read nor the write.
  const rev = await baseOf(handler, { 'x-device-id': OTHER_DEVICE });

  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': OTHER_DEVICE, 'x-state-rev': rev },
    body: { uid: OTHER_DEVICE, state: mine },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(sql.get('account', ACCOUNT_ID).state, mine);
  assert.equal(sql.get('device', OTHER_DEVICE), undefined, 'state leaked into the foreign device row');
});

// ── The device id leaves the URL (CHR-007a) ─────────────────────────────────

test('GET resolves the device id from the X-Device-Id header, with no query param', async () => {
  const { handler } = handlerWith({ users: [deviceRow(DEVICE_ID, { channels: [{ id: 'UCmine' }] })] });
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', headers: { 'x-device-id': DEVICE_ID }, query: {} }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.state, { channels: [{ id: 'UCmine' }] });
});

test('PUT resolves the device id from the header when the body carries no uid', async () => {
  // FIXTURE CHANGED (TASK-084/BUG-052, 2026-07-31), not the assertion. This used to send
  // `{channels: [], done: []}` — an empty state, which no longer creates a row, so the assertion
  // below would have failed for a reason that has nothing to do with what this test is named for.
  // The claim here is OWNER RESOLUTION: that the header id, not the body uid, decides the row. A
  // fixture carrying real channels tests exactly that claim and nothing less. Declared in the task
  // scope before it went red, so it is a recorded requirement change rather than a test bent green.
  const { handler, sql } = handlerWith();
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: { state: { channels: [{ id: 'UCmine' }], done: [] } },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.ok(sql.get('device', DEVICE_ID), 'the header device id was not used as the owner');
});

test('GET still accepts the legacy ?uid for one release (accept-both deploy)', async () => {
  const { handler } = handlerWith({ users: [deviceRow(DEVICE_ID, { channels: [{ id: 'UClegacy' }] })] });
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', query: { uid: DEVICE_ID } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.state, { channels: [{ id: 'UClegacy' }] });
});

test('the header wins when a stale client sends both', async () => {
  const { handler } = handlerWith({
    users: [
      deviceRow(DEVICE_ID, { channels: [{ id: 'UCheader' }] }),
      deviceRow(OTHER_DEVICE, { channels: [{ id: 'UCquery' }] }),
    ],
  });
  const res = fakeRes();
  await handler(fakeReq({
    method: 'GET',
    headers: { 'x-device-id': DEVICE_ID },
    query: { uid: OTHER_DEVICE },
  }), res);

  assert.deepEqual(res.body.state, { channels: [{ id: 'UCheader' }] });
});

// ── An empty state must not manufacture a row (BUG-052) ─────────────────────
//
// track() flushes analytics on the shared /api/state PUT ~3s into every boot, and pushNow sends
// collectSyncedState() alongside them whether or not there is any state. So a signed-in boot on an
// empty browser wrote an EMPTY ACCOUNT ROW that nobody asked for — and a second browser holding
// real channels then signed in, saw a row exist, and pulled the empty one down over its own state.
// Measured before the fix in the app harness: 3 channels + 2 done -> 0 and 0.
//
// The fix restricts CREATION only. An empty row that already exists still wins on read, because a
// user who removes every channel must have that clear sync (test/state.test.mjs pins it as "a
// cleared account"). Getting this backwards would break a real user action, so both directions are
// asserted here.

test('a PUT with no user data does not create a row', async () => {
  const { handler, sql } = handlerWith();
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: { state: { channels: [], done: [], archive: [], theme: null, shorts: 'true', groups: null } },
  }), res);

  assert.equal(sql.get('device', DEVICE_ID), undefined, 'an empty state manufactured a row');
  assert.equal(res.statusCode, 200,
    'must still be 200 — pushNow drops its sent events only on ok, so a non-2xx buffers them forever');
});

test('a PUT with no user data DOES clear a row that already exists', async () => {
  // The deliberate case: the user removed every channel. Restricting creation must not strand it.
  const { handler, sql } = handlerWith({ users: [deviceRow(DEVICE_ID, { channels: [{ id: 'UCold' }], done: ['v1'] })] });
  // A user who removes every channel has been LOOKING at those channels, so their browser read the
  // row and holds its base. Modelling the read is what keeps this test about the clear.
  const rev = await baseOf(handler, { 'x-device-id': DEVICE_ID });
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID, 'x-state-rev': rev },
    body: { state: { channels: [], done: [], archive: [] } },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(sql.get('device', DEVICE_ID).state, { channels: [], done: [], archive: [] },
    'a deliberate clear must still sync');
});

test('analytics still ingest on a PUT that creates no row', async () => {
  // The whole reason an empty PUT happens at all is to carry events — an empty browser has no state
  // worth saving, only a usage ping. If suppressing the row write also dropped the events, every
  // metric would go blind for exactly the population that never curates anything.
  //
  // Uses a plain 'view' rather than a name introduced by another task, so this test depends on the
  // BUG-052 fix alone and nothing else.
  const { handler, sql } = handlerWith();
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: {
      state: { channels: [], done: [], archive: [] },
      events: [{ name: 'view', section: 'feed', ts: Date.now() }],
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(sql.get('device', DEVICE_ID), undefined, 'guard: no row was created');
  assert.equal(sql.events.length, 1, 'the events were dropped along with the row write');
  assert.equal(sql.events[0].deviceId, DEVICE_ID);
});

// ── The caller declares intent: an ABSENT state is events-only (TASK-084 R1-H2) ──
//
// BUG-052 above closed the CREATING direction. This is the destroying one, and it is the half with
// real user data behind it: pushNow sends collectSyncedState() on every push, so a boot whose GET
// failed (500, or the 2.5s abort) reaches the 3s analytics flush holding an empty browser and PUTs
// it — the row exists, so the update branch above runs and the account's channels are gone.
//
// The server cannot tell that apart from a deliberate "I removed every channel" clear: the two are
// byte-identical on the wire. So the CLIENT declares which one it means, by omitting the `state`
// key entirely when it is not claiming any state. Absent = "analytics only, don't touch my row".
//
// `null` is deliberately NOT the signal. Absent is something a client chooses; null is what a
// broken serializer produces, and answering 200 to it would let a client stop syncing forever while
// every response said OK.

test('a PUT that omits state leaves an existing account row byte-identical', async () => {
  // The whole row, not just .state — a write that stored the same state but bumped updated_at would
  // pass a state-only snapshot while still having touched the row.
  const { handler, sql } = handlerWith({
    users: [accountRow()],
    account: { accountId: ACCOUNT_ID, email: 'a@example.com' },
  });
  const before = snapshot(sql.get('account', ACCOUNT_ID));

  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: { uid: DEVICE_ID, events: [{ name: 'view', section: 'feed', ts: Date.now() }] },
  }), res);

  assert.equal(res.statusCode, 200,
    'must be 200 — pushNow drops its sent events only on ok, so a non-2xx buffers them forever');
  assert.equal(snapshot(sql.get('account', ACCOUNT_ID)), before,
    'an events-only PUT destroyed the account row it was never claiming to write');
  assert.ok(sql.events.length >= 1, 'the events were dropped along with the write we suppressed');
});

test('an events-only PUT still ingests and attributes analytics, and creates no row', async () => {
  // If suppressing the row write also dropped the events, every metric would go blind for exactly
  // the population this task creates: signed-in browsers that have not curated anything yet.
  const { handler, sql } = handlerWith({ account: { accountId: ACCOUNT_ID, email: 'a@example.com' } });
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: { uid: DEVICE_ID, events: [{ name: 'view', section: 'feed', ts: Date.now() }] },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(sql.get('account', ACCOUNT_ID), undefined, 'an events-only PUT manufactured a row');
  const inserted = sql.events.find((e) => e.batch);
  assert.ok(inserted, 'the events were not ingested');
  assert.equal(inserted.deviceId, DEVICE_ID, 'the device id was not attached to the events');
  assert.ok(sql.events.some((e) => e.attributed), 'the batch was never attributed to the account');
});

test('an explicit state: null is still a 400, not an events-only push', async () => {
  // Absent is a choice; null is a bug. Conflating them (a loose `== null`) would turn a broken
  // client into a silently non-syncing one.
  //
  // The session is load-bearing, not scenery: without it `resolveOwner` can only ever address the
  // DEVICE namespace, so the account-row snapshot below could not fire whatever the handler did.
  const { handler, sql } = handlerWith({
    users: [accountRow()],
    account: { accountId: ACCOUNT_ID, email: 'a@example.com' },
  });
  const before = snapshot(sql.get('account', ACCOUNT_ID));

  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: { uid: DEVICE_ID, state: null },
  }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(snapshot(sql.get('account', ACCOUNT_ID)), before,
    'a null state was written to the account row instead of being rejected');
});

test('a malformed body is still a 400 and ingests nothing', async () => {
  // A body the client did not mean as JSON is a client error, not an abstention. The Buffer case is
  // the one that actually regressed: Vercel's Node runtime hands the handler a raw Buffer for any
  // content-type it does not recognise, and a Buffer is `typeof 'object'` and not an array — so a
  // shape check built from those two tests waves it through, `body.state` is undefined, and it
  // answers 200. Measured: 400 before this change, 200 after, until the guard became a POSITIVE
  // plain-object check. That is exactly the failure the guard exists to prevent — a client whose
  // requests are broken stops syncing while every response says OK, and loses its events too
  // (pushNow drains them on `ok`).
  for (const body of ['{"uid":', [], Buffer.from('{"uid":"x","state":{"channels":[]}}'), 42]) {
    const { handler, sql } = handlerWith();
    const res = fakeRes();
    await handler(fakeReq({ method: 'PUT', headers: { 'x-device-id': DEVICE_ID }, body }), res);

    assert.equal(res.statusCode, 400, `a malformed body (${JSON.stringify(body)}) was accepted`);
    assert.equal(sql.get('device', DEVICE_ID), undefined, 'a malformed body wrote a row');
    // Deliberately no "and ingested no events" assertion: a body that does not parse cannot carry
    // parseable events either, so it could not fire under any mutation. The status is the claim.
  }
});

test('an events-only PUT with a junk uid is still 400 and ingests nothing', async () => {
  // The uid gate has to stay ahead of the events-only handling, or a request nobody can be
  // identified from still writes rows into the events table with both ids null.
  const { handler, sql } = handlerWith();
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': 'not-a-uuid' },
    body: { uid: 'not-a-uuid', events: [{ name: 'view', section: 'feed', ts: Date.now() }] },
  }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(sql.events.length, 0, 'events were ingested for an unidentifiable request');
});

// ── Behaviour that must survive the change ──────────────────────────────────

test('503 when the state store is unavailable, so the client stays on localStorage', async () => {
  const handler = createStateHandler({ db: () => null, sessionAccount: async () => null });
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', query: { uid: DEVICE_ID } }), res);

  assert.equal(res.statusCode, 503);
});

test('400 on a junk uid', async () => {
  const { handler } = handlerWith();
  const res = fakeRes();
  await handler(fakeReq({ method: 'GET', query: { uid: 'not-a-uuid' } }), res);

  assert.equal(res.statusCode, 400);
});

test('413 when the state exceeds the size cap', async () => {
  const { handler, sql } = handlerWith();
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: { state: { blob: 'x'.repeat(300 * 1024) } },
  }), res);

  assert.equal(res.statusCode, 413);
  assert.equal(sql.get('device', DEVICE_ID), undefined, 'an over-cap state was still written');
});

test('405 on an unsupported method', async () => {
  const { handler } = handlerWith();
  const res = fakeRes();
  await handler(fakeReq({ method: 'DELETE' }), res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET, PUT');
});

test('analytics ingestion still rides along on a PUT', async () => {
  const { handler, sql } = handlerWith({ account: { accountId: ACCOUNT_ID, email: 'a@example.com' } });
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: { state: { channels: [], done: [] }, events: [{ name: 'view', section: 'feed', ts: Date.now() }] },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(sql.events.length > 0, true, 'events were not ingested');
  assert.equal(sql.events[0].deviceId, DEVICE_ID, 'the device id was not attached to the events');
});

test('one PUT both stores the state and ingests the events', async () => {
  // The combination nothing covered (TASK-084 round 1, the third test-blindness HIGH). Every
  // neighbouring test proves one side or the failure of one side: the empty-state PUT proves events
  // survive a suppressed row write, and the on-fire test proves a broken events write cannot take
  // the state down. Neither proves the ordinary case — real channels AND analytics, both landing —
  // which is what nearly every PUT from a real signed-in session actually is.
  const { handler, sql } = handlerWith({ account: { accountId: ACCOUNT_ID, email: 'a@example.com' } });
  const mine = { channels: [{ id: 'UCmine', title: 'Mine' }], done: ['v1'], archive: [] };
  const res = fakeRes();

  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: { uid: DEVICE_ID, state: mine, events: [{ name: 'mark_done', section: 'feed', ts: Date.now() }] },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(sql.get('account', ACCOUNT_ID).state, mine, 'the state did not reach the row');
  assert.ok(res.body.updatedAt, 'a successful write must report an updatedAt');
  const batch = sql.events.find((e) => e.batch);
  assert.ok(batch, 'the events were dropped by a PUT that did store state');
  assert.deepEqual(JSON.parse(batch.batch).map((e) => e.name), ['mark_done']);
  assert.equal(batch.accountId, ACCOUNT_ID, 'the events were not attributed to the signed-in account');
});

test('a failing analytics write cannot fail the state write', async () => {
  // FIXTURE CHANGED (TASK-084/BUG-052, 2026-07-31), not the assertion — same reason as the header
  // test above. This asserts that a broken events write does not take the STATE write down with it,
  // which requires a state write to happen at all; an empty state now writes nothing, so the old
  // fixture made the final assertion unreachable. Real channels restore the conditions the claim
  // needs. Declared in the task scope before it went red.
  const store = fakeDb();
  const sql = (strings, ...values) => {
    if (strings.join('').includes('into events')) throw new Error('events table on fire');
    return store(strings, ...values);
  };
  Object.assign(sql, { get: store.get });
  const handler = createStateHandler({ db: () => sql, sessionAccount: async () => null });

  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID },
    body: {
      state: { channels: [{ id: 'UCmine' }], done: [] },
      events: [{ name: 'view', section: 'feed', ts: Date.now() }],
    },
  }), res);

  assert.equal(res.statusCode, 200, 'a broken analytics write took down the state sync');
  assert.ok(store.get('device', DEVICE_ID), 'the state itself was not stored');
});

// ── The admin gate (CHR-072 criterion 1) ────────────────────────────────────
// The X meter panel exposes per-account reading volume — a behavioural profile of a named person —
// so the 403 that keeps it owner-only is worth an assertion rather than a code read.
//
// It also pins the ORDER: the gate at api/state.js:44 runs before adminStats, so a non-owner never
// reaches a query. That is asserted DIRECTLY (`sql.queries.length === 0`) rather than inferred from
// the status code. The inference — fakeDb throws on unrecognised queries, so getting past the gate
// would return 500 rather than 403 — is true today and was all the first version of this test had,
// which made the name a claim the assertions did not carry. It would go quietly false the day the
// fake store learns these aggregates, which the task file explicitly contemplates. Asserting a
// query did NOT run is the "did a billable call go out" exception, not general call-recording.
test('GET ?admin=1 as a non-owner is 403, before any query reaches the database', async () => {
  const prev = process.env.ADMIN_EMAIL;
  process.env.ADMIN_EMAIL = 'owner@example.com';
  try {
    const { handler, sql } = handlerWith({
      account: { accountId: ACCOUNT_ID, email: 'someone-else@example.com' },
    });
    const res = fakeRes();
    await handler(fakeReq({ method: 'GET', query: { admin: '1' } }), res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'forbidden' });
    assert.equal(sql.queries.length, 0, `queries ran past the gate: ${JSON.stringify(sql.queries)}`);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = prev;
  }
});

test('GET ?admin=1 signed out is 403 (no session, no owner)', async () => {
  const prev = process.env.ADMIN_EMAIL;
  process.env.ADMIN_EMAIL = 'owner@example.com';
  try {
    const { handler, sql } = handlerWith({ account: null });
    const res = fakeRes();
    await handler(fakeReq({ method: 'GET', query: { admin: '1' }, headers: { 'x-device-id': DEVICE_ID } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(sql.queries.length, 0, `queries ran past the gate: ${JSON.stringify(sql.queries)}`);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = prev;
  }
});
