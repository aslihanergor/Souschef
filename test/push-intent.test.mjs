// Who decides whether a PUT is claiming state — the caller, not the server.
//
// If pushNow sends `state: collectSyncedState()` on every push, whatever the push is for, then a
// boot whose GET failed (500, or the 2.5s abort) reaches track()'s 3s analytics flush holding an
// EMPTY browser, PUTs it, and the server — which cannot tell that apart from a deliberate "I removed
// every channel" clear — empties the signed-in account's row. Refusing to CREATE a row from an empty
// state covers only one direction; this is the destroying one, and it is the half with real user data behind it.
//
// The fix is a wire-level distinction the server can act on: an ABSENT `state` key means "analytics
// only". That makes it a two-party contract, so the tests that matter here are the CROSS-SEAM ones
// (X1, C7) — they take the real client's real request body and hand it to the real handler. A
// client-only test proving "no state key in the body" and a server-only test proving "a body with no
// state key writes nothing" can both pass while the two disagree about what absent means, and a seam
// defect is exactly what survives a green suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';
import { createStateHandler } from '../api/state.js';
import { hasUserData } from '../api/_state.js';
import { fakeDb, fakeReq, fakeRes, snapshot } from '../test-helpers/handler.mjs';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION = { accountId: ACCOUNT_ID, email: 'a@example.com' };
// What the user stands to lose. Byte-identical afterwards is the whole claim.
const VICTIM_STATE = { channels: [{ id: 'UCsecret', title: 'Private channel' }], done: ['v1'] };

// A channel whose name is NOT its id, so migrateChannelNames() leaves it alone and cannot set the
// dirty flag behind a fixture's back — which would quietly make the adoption test below vacuous.
const MINE = JSON.stringify([{ id: 'UCmine', name: 'My Channel', keyword: '', source: 'youtube' }]);
const BUFFERED = JSON.stringify([{ name: 'view', section: 'feed', ts: 1753000000000 }]);

const OK = { ok: true, status: 200, json: async () => ({}) };

// What PUT /api/state ACTUALLY answers.
//
// `{}` (the `OK` fixture above) is a body the real server can never
// produce. Used for a PUT, it makes a stale-pull regression invisible: dropping `!eventsOnly` from pushNow's
// `discarded` predicate passes every test, because `{}.updatedAt` is `undefined` rather than
// the explicit `null` every events-only PUT really returns. Under the real shape that mutant clears
// `dirty` on every analytics flush — telling the next boot the server is up to date and letting
// syncOnLoad pull a stale row down over un-pushed local changes.
//
// A fixture that no longer models the server is not a weaker test, it is a different one.
function putAnswer(raw) {
  let parsed = {};
  try { parsed = JSON.parse(raw) || {}; } catch { /* a non-JSON body is a 400 upstream */ }
  // An ABSENT `state` key is "analytics only" — the server touches no row and answers an explicit
  // null on BOTH fields. Present-and-an-object with real data is an accepted write.
  const eventsOnly = parsed.state === undefined;
  const body = eventsOnly
    ? { updatedAt: null, rev: null }
    : { updatedAt: '2026-08-02T18:36:40.000Z', rev: '2026-08-02T18:36:40.000000' };
  return { ok: true, status: 200, json: async () => body };
}
const NO_ROW = { ok: true, status: 200, json: async () => ({ state: null, updatedAt: null }) };
const GET_FAILS = { ok: false, status: 500, json: async () => ({}) };
// A healthy GET that finds the account's real row — the second boot in B2, and the only fixture here
// where the client is supposed to PULL rather than push.
//
// Deliberately NOT `VICTIM_STATE`, whose channel carries `title` and no `name`. That is fine for a
// fixture only ever stringified and compared server-side, but B2 RENDERS a pulled
// row: renderChannelRow → avatarHtml → avatarColor does `str.length` on `ch.name` and throws, which
// would kill the boot before any assertion ran. Same id so the row-identity guards still read, real shape
// so the render works.
const PULLED_STATE = { channels: [{ id: 'UCsecret', name: 'Private channel', source: 'youtube' }], done: ['v1'] };
const HAS_ROW = { ok: true, status: 200, json: async () => ({ state: PULLED_STATE, updatedAt: '2026-08-02T18:36:39.699Z' }) };

/** An app plus a live log of the PUT bodies it sent. `stateGet` is what GET /api/state answers.
 *  `putFails` makes every PUT answer 500 — needed only by B5, where a sign-out must refuse because
 *  it could not save real un-pushed work, and a succeeding PUT would make the refusal untestable. */
function mk({ store = {}, stateGet = NO_ROW, signedIn = true, putFails = false } = {}) {
  const puts = [];
  const app = createApp({ store: { focus_device_id: DEVICE_ID, ...store } });
  app.setFetch(async (url, init) => {
    const method = init.method || 'GET';
    if (url.includes('/api/auth/me')) {
      return signedIn
        ? { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) }
        : { ok: false, status: 401, json: async () => ({}) };
    }
    if (url.includes('/api/state') && method === 'PUT') {
      puts.push(init.body);
      return putFails ? { ok: false, status: 500, json: async () => ({}) } : putAnswer(init.body);
    }
    if (url.includes('/api/state')) return stateGet;
    if (url.includes('/api/auth/logout')) return OK;
    if (url.includes('/api/resolve-channel')) {
      return { ok: true, status: 200, json: async () => ({ name: 'Real Channel Name', avatarUrl: null }) };
    }
    throw new Error(`unrouted request: ${url}`);
  });
  return { app, puts };
}

const settle = () => new Promise((r) => setImmediate(r));
const carriesState = (raw) => 'state' in JSON.parse(raw);

/** Boot far enough to establish STANDING, then discard the boot's own traffic.
 *
 *  A push may only claim state on a document that asked the server what it holds and got an answer.
 *  Every real document does — init() awaits syncOnLoad(), and wireApp() connects the mutating
 *  controls only afterwards — so a fixture that jumps straight to a mutation was modelling a browser
 *  that cannot exist. The `puts.length = 0` matters as much as the boot: over a NO_ROW fixture with
 *  local content, syncOnLoad's adopt push fires and carries the very channels the test is about, so
 *  a later `carriesState(puts[0])` would read the ADOPT push and pass no matter what the subject
 *  did. */
async function standing(app, puts) {
  await app.ctx.syncOnLoad();
  await settle();
  puts.length = 0;
}

/** Replay a request body the real client produced against the real handler, over a seeded row.
 *  `before` is the WHOLE victim row, not just its state — a write that stored identical state but
 *  bumped updated_at would pass a state-only comparison while still having touched the row. */
async function replay(rawBody, { users = [{ kind: 'account', id: ACCOUNT_ID, state: VICTIM_STATE }], account = SESSION } = {}) {
  const sql = fakeDb({ users });
  const before = snapshot(sql.get('account', ACCOUNT_ID));
  const handler = createStateHandler({ db: () => sql, sessionAccount: async () => account });
  const res = fakeRes();
  await handler(fakeReq({ method: 'PUT', headers: { 'x-device-id': DEVICE_ID }, body: rawBody }), res);
  return { sql, res, before, after: snapshot(sql.get('account', ACCOUNT_ID)) };
}

// ── The cross-seam tests ────────────────────────────────────────────────────

test('X1 — the analytics flush of a boot that could not read its row leaves that row untouched', async () => {
  // End to end, in the one shape that actually shipped broken: the client builds the body, the
  // server writes the row. Nothing in between is faked.
  const { app, puts } = mk({ stateGet: GET_FAILS });

  await app.ctx.init();
  app.runTimers(4);                 // drain track()'s 3s flush
  await settle();

  assert.ok(puts.length >= 1, 'no PUT was issued, so this test proves nothing');
  assert.equal(app.get('focus_dirty'), null, 'guard: nothing in this boot marked state dirty');

  // Replay EVERY PUT the boot made, not just the first — one late state-carrying push is exactly
  // the failure this is here to catch, and `puts[0]` would sail past it.
  for (const raw of puts.slice(1)) {
    const r = await replay(raw);
    assert.equal(r.after, r.before, 'a later PUT in the same boot destroyed the account row');
  }
  const { sql, res, before, after } = await replay(puts[0]);
  assert.equal(res.statusCode, 200,
    'must be 200 — pushNow drops its sent events only on ok, so a non-2xx buffers them forever');
  assert.ok(before.includes('UCsecret'), 'guard: the victim row really was seeded with data to lose');
  assert.equal(after, before, "the boot ping destroyed the signed-in account's channels");
  assert.ok(sql.events.length >= 1, 'the events were dropped, so the metric this push exists for is blind');
});

test('C7 — signing out of a browser that could not read its row leaves that row untouched', async () => {
  // The likelier trigger, and the reason this is not just the analytics timer's problem: the failed
  // GET shows the user an empty app, so they sign out to fix it, and _signOut pushes unconditionally
  // (before it ever consults _hasUserData). Same empty state, same destroyed row, one click away.
  const { app, puts } = mk({ store: { focus_events: BUFFERED }, stateGet: GET_FAILS });

  // Boot first, or `stateGet: GET_FAILS` is dead configuration: signOut() issues no GET of its own,
  // so without this the test pins "empty store + clear dirty" rather than "a browser that could not
  // read its row", and would stay green if any boot-time side effect ever set dirty.
  await app.ctx.init();

  // Drain the boot's 3s analytics flush BEFORE signing out, because that is the real sequence — a
  // user is never quicker than three seconds. Without it this fixture never issues an events-only
  // push at all, so the property that keeps sign-out honest goes untested: `_stateOutstanding` is
  // cleared only by a CONFIRMED push and an events-only push can never confirm, so if the flush
  // ever latched it, it stays true for the life of the document, `_statePending()` is permanently
  // true, `nothingToSave` is permanently false, and sign-out claims state again. The
  // `if (!eventsOnly)` on that latch is what this pins.
  app.runTimers(4);
  await settle();
  assert.ok(puts.length >= 1, 'guard: the analytics flush never fired, so this fixture proves nothing');
  assert.ok(puts.every((p) => !carriesState(p)), 'guard: the boot flush itself claimed state');

  puts.length = 0;                     // the boot's own analytics flush is X1's subject, not this one
  assert.equal(app.get('focus_dirty'), null, 'guard: the failed boot left nothing pending');

  await app.ctx.signOut();

  assert.ok(puts.length >= 1, 'sign-out issued no PUT at all — the fixture, not the fix, is doing the work');
  assert.ok(puts.every((p) => !carriesState(p)), 'sign-out claimed state this browser never loaded');

  const { res, before, after } = await replay(puts[0]);
  assert.equal(res.statusCode, 200);
  assert.ok(before.includes('UCsecret'), 'guard: the victim row really was seeded with data to lose');
  assert.equal(after, before, "signing out destroyed the account's channels on the way past");
});

test('C7b — a sign-out that DOES have something to save still saves it', async () => {
  // The control for C7. Without it, "sign-out no longer destroys the row" is satisfied by a
  // sign-out that stopped saving anything at all, which is a worse bug wearing this one's clothes.
  // stateGet is NO_ROW, not GET_FAILS: a browser whose read failed has nothing it is
  // ALLOWED to save, which is C7's subject. "Has something to save" means standing plus data.
  const { app, puts } = mk({ store: { focus_channels: MINE } });
  await standing(app, puts);

  await app.ctx.signOut();

  assert.ok(puts.length >= 1, 'sign-out issued no PUT');
  assert.ok(carriesState(puts[0]), 'sign-out stopped saving real local state');
  assert.ok(JSON.stringify(JSON.parse(puts[0]).state.channels).includes('UCmine'));

  // No row seeded: this client booted on NO_ROW, so an insert is what its push is entitled to.
  const { sql } = await replay(puts[0], { users: [] });
  assert.ok(JSON.stringify(sql.get('account', ACCOUNT_ID).state).includes('UCmine'),
    'the state reached the client but never landed in the row');
});

test('X-NOROW — a browser that read NO row cannot overwrite one that appeared meanwhile', async () => {
  // The race the two replays above deliberately do not model, kept here as its own subject.
  // The client's boot GET honestly answered "no row"; between that read and its push, a row appeared —
  // another device, or another person signing in on this browser. Last-write-wins would let the push
  // flatten it. It cannot: the client holds no base, and an unbound write may create a row but never replace one.
  //
  // This is the seam version of sync-conflict.test.mjs S4. It matters separately because the client
  // and the server can each be individually correct about "no base" and still disagree about how one
  // is spelled on the wire.
  const { app, puts } = mk({ store: { focus_channels: MINE } });
  await standing(app, puts);

  app.ctx.saveChannels([{ id: 'UCnew', name: 'Added after the read', source: 'youtube' }]);
  app.runTimers(4);
  await settle();

  const withState = puts.filter(carriesState);
  assert.ok(withState.length >= 1, 'guard: the client sent no state at all, so nothing is proven');

  const r = await replay(withState[0]);   // a row DID appear in the meantime
  assert.equal(r.res.statusCode, 409, 'an unbound overwrite must be refused');
  assert.equal(r.after, r.before, "the other party's row must be byte-identical");
});

// ── The client's half ───────────────────────────────────────────────────────

test('C1 — every PUT from a boot that could not read its row is events-only', async () => {
  const { app, puts } = mk({ stateGet: GET_FAILS });

  await app.ctx.init();
  app.runTimers(4);
  await settle();

  // `every` on an empty array is true, and a boot that issues zero requests is exactly the vacuous
  // green the harness's missing AbortController used to produce. Count first.
  assert.ok(puts.length >= 1, 'no PUT was issued, so this test proves nothing');
  assert.ok(puts.every((p) => !carriesState(p)),
    `a PUT claimed state this browser never loaded: ${puts.find((p) => carriesState(p))}`);
});

test('C2 — an ordinary state push still carries the state', async () => {
  // The positive control. Everything below is about NOT sending state; without this, the whole
  // feature is satisfied by a client that never syncs again.
  const { app, puts } = mk({ store: { focus_channels: MINE } });
  await standing(app, puts);

  app.ctx.schedulePush();
  app.runTimers(4);
  await settle();

  assert.equal(puts.length, 1);
  assert.ok(carriesState(puts[0]), 'an ordinary push stopped carrying state');
  assert.ok(JSON.stringify(JSON.parse(puts[0]).state.channels).includes('UCmine'));
});

test('C3 — an unload flush with nothing pending but buffered events is events-only', async () => {
  const { app, puts } = mk({ store: { focus_events: BUFFERED } });
  assert.equal(app.get('focus_dirty'), null, 'guard: nothing is pending, which is what makes this case the case');

  app.ctx.flushPush();
  await settle();

  assert.equal(puts.length, 1);
  assert.ok(!carriesState(puts[0]), 'the unload flush claimed state nobody asked it to save');
});

test('C3b — an unload flush DURING an in-flight adopt push still carries the state', async () => {
  // The adopt push (syncOnLoad's no-row branch) is fire-and-forget and deliberately never sets
  // `dirty` — syncOnLoad reads dirty as "keep local, don't pull", which is the cross-account leak of
  // a sign-out refusal. So a flush that decided from `dirty` alone would drop a first sign-in's adoption
  // if the tab was closed while it was in flight. This is the test that refuses that inference.
  let releaseAdopt;
  const puts = [];
  const app = createApp({ store: { focus_device_id: DEVICE_ID, focus_channels: MINE, focus_events: BUFFERED } });
  app.setFetch(async (url, init) => {
    const method = init.method || 'GET';
    if (url.includes('/api/state') && method === 'PUT') {
      puts.push(init.body);
      if (puts.length === 1) return new Promise((res) => { releaseAdopt = () => res(OK); });
      return OK;
    }
    if (url.includes('/api/state')) return NO_ROW;
    throw new Error(`unrouted request: ${url}`);
  });

  await app.ctx.syncOnLoad();
  await settle();
  assert.equal(puts.length, 1, 'guard: the adopt push did not go out');
  assert.equal(app.get('focus_dirty'), null, 'guard: the adopt push must not have set dirty, or this proves nothing');

  app.ctx.flushPush();
  await settle();

  assert.equal(puts.length, 2, 'the unload flush did not fire');
  assert.ok(carriesState(puts[1]), 'the unload flush abandoned an adoption that was still in flight');
  releaseAdopt();
});

test('C4 — the adopt-on-login push still carries the state', async () => {
  // The tripwire for a tempting wrong fix: "omit state
  // when dirty !== '1'". The adopt branch calls pushNow() directly with dirty already CLEAR, so
  // that fix breaks first sign-in silently. The guard below is what keeps this test honest — if any
  // boot-time side effect sets dirty, the forbidden fix would pass here too.
  const { app, puts } = mk({ store: { focus_channels: MINE, focus_last_view: 'setup' } });

  await app.ctx.init();
  await settle();

  assert.equal(app.get('focus_dirty'), null, 'guard: this fixture must exercise the dirty-CLEAR adopt path');
  const adopt = puts.find((p) => JSON.stringify(JSON.parse(p).state ?? {}).includes('UCmine'));
  assert.ok(adopt, `first sign-in never uploaded its channels: ${JSON.stringify(puts)}`);
});

test('C5 — an events-only push does not clear the dirty flag, and a state push does', async () => {
  // dirty means "the server does not have my latest state". An events-only push did not send it, so
  // clearing here would make the next boot pull a stale row down over un-pushed local changes —
  // a stale pull.
  const { app, puts } = mk({ store: { focus_channels: MINE } });
  await standing(app, puts);
  app.set('focus_dirty', '1');

  await app.ctx.pushNow({ eventsOnly: true });
  assert.equal(app.get('focus_dirty'), '1', 'an events-only push cleared dirty for state it never sent');

  await app.ctx.pushNow();
  assert.equal(app.get('focus_dirty'), null, 'a real state push must still clear dirty');
});

// ── The `dirty` half of the decision — the term that carries every ordinary mutation ──
//
// `nothingToSave = !_hasUserData(...)` and
// `_statePending() = _stateOutstanding` would each leave the rest of the suite green while destroying user data.
// C3b/C5/C6 pin the NEW flag; these watch the older term it
// is OR'd with.

test('C8 — signing out right after removing every channel still SENDS the clear', async () => {
  // Removing every channel is a deliberate clear: local ends up empty, so _hasUserData is false and
  // an emptiness check alone reads it as "nothing to save". It is the opposite — it is the one empty
  // state that MUST reach the server. signOut cancels the queued push first (app.js:892), so its own
  // push is the only thing left to carry it; if it goes out events-only the clear is lost locally
  // AND on the server, and the deleted channels come back on the next sign-in.
  const { app, puts } = mk({ store: { focus_channels: MINE } });
  await standing(app, puts);

  app.ctx.saveChannels([]);
  assert.equal(app.get('focus_dirty'), '1', 'guard: the clear must be queued-but-unsent for this to mean anything');
  assert.equal(puts.length, 0, 'guard: the debounced push has not fired yet');

  await app.ctx.signOut();

  assert.ok(puts.length >= 1, 'sign-out issued no PUT at all');
  assert.ok(carriesState(puts[0]), 'the deliberate clear was never sent — the channels come back on the next sign-in');
  assert.deepEqual(JSON.parse(puts[0]).state.channels, [], 'the PUT carried state, but not the cleared channel list');
});

test('C9 — an unload flush of a scheduled-but-unfired mutation still carries the state', async () => {
  // What flushPush exists for: "so a quick action isn't lost". The mutation is in localStorage and
  // in `dirty`, but nothing is in flight, so a flush that consults only the in-flight flag drops it.
  const { app, puts } = mk({ store: { focus_channels: MINE, focus_events: BUFFERED } });
  await standing(app, puts);

  app.ctx.addDone('v9');
  assert.equal(app.get('focus_dirty'), '1', 'guard: a mutation is queued');

  app.ctx.flushPush();
  await settle();

  assert.ok(puts.length >= 1, 'the unload flush did not fire');
  assert.ok(carriesState(puts[0]), 'the unload flush abandoned a mutation that had never been sent');
  assert.ok(JSON.parse(puts[0]).state.done.includes('v9'), 'the flush carried state, but not the mark-done');
});

test('C6 — an events-only push still drops the events it sent', async () => {
  // The adjacent line most likely to be "tidied" from `r.ok` to `confirmed`. Under the new
  // confirmed, that would mean an events-only push never drains its buffer: every metric duplicates
  // on every flush forever.
  const { app } = mk({ store: { focus_events: BUFFERED } });

  await app.ctx.pushNow({ eventsOnly: true });

  assert.equal(app.get('focus_events'), null, 'the sent events stayed buffered and will re-ship forever');
});

// ── Standing, not intent ───────────────────────────────────────────
//
// The caller declares WHAT a push carries. That closes the three paths with nothing to
// claim, and can never close this one: a theme tap genuinely IS claiming state. The missing fact is
// whether the sender had any STANDING to claim it — a browser whose boot GET failed holds a copy of
// nothing and does not know it. `_stateLoaded` is that fact, and it is set by syncOnLoad in all three
// branches, because "no row", "dirty" and "applied" all mean the same thing here: this document
// learned what the server holds.
//
// Two halves, and they must ship together. Suppressing the push alone is WORSE than not suppressing: a
// suppressed push can never confirm, so `dirty` can never clear, so the next healthy boot's dirty
// branch pushes the same empty blob and never applies the row (B2).

test('B1 — a theme tap on a browser that could not read its row leaves that row untouched', async () => {
  // The production repro, through the control that actually caused it. `.theme-opt` is modelled in
  // the harness for this test alone; before that the theme route was the one mutation path no test
  // could fire, which is how a measured, reproduced bug had no coverage at all.
  const { app, puts } = mk({ stateGet: GET_FAILS });

  await app.ctx.init();
  assert.equal(app.click(app.themeOpt('dark')), 1,
    'the theme button was never wired, so this test taps nothing and would pass against anything');
  app.runTimers(4);
  await settle();

  assert.equal(app.get('focus_theme'), 'dark', 'guard: the tap really did mutate local state');
  assert.ok(puts.length >= 1, 'no PUT was issued, so this test proves nothing');

  // EVERY PUT, not just the first — one late state-carrying push is exactly the failure this catches.
  for (const raw of puts) {
    // Both halves: the row is untouched AND the key is absent. `state: null` is the forbidden wire
    // shape (app.js says "absent, never null") and 400s server-side, so a row-identity assertion
    // alone would stay green through a regression to it.
    assert.ok(!carriesState(raw), `a PUT claimed state this browser never loaded: ${raw}`);
    const r = await replay(raw);
    assert.ok(r.before.includes('UCsecret'), 'guard: the victim row really was seeded with data to lose');
    assert.equal(r.after, r.before, 'a tap on a browser that never loaded its row destroyed the account row');
  }
});

// Both outage shapes, because they red at DIFFERENT times and only the pair covers the change.
//
//   putFails: true  — /api/state is down for both verbs, so boot 1's push cannot confirm and `dirty`
//                     survives. RED without the suppression this file pins.
//   putFails: false — the GET failed but the PUT succeeded, so without suppression `confirmed` clears `dirty` and
//                     boot 2 is harmless. It is the case that turns dangerous the
//                     moment pushes are suppressed: a suppressed push can never confirm, so `dirty`
//                     can never clear. Pinned here so change 1 cannot ship without change 2.
for (const putFails of [true, false]) {
  test(`B2 — the boot AFTER the failed one does not finish the job (boot-1 PUT ${putFails ? 'fails' : 'succeeds'})`, async () => {
    const b1 = mk({ stateGet: GET_FAILS, putFails });
    await b1.app.ctx.init();
    assert.equal(b1.app.click(b1.app.themeOpt('dark')), 1, 'guard: the theme button was never wired');
    b1.app.runTimers(4);
    await settle();
    assert.equal(b1.app.get('focus_theme'), 'dark', 'guard: boot 1 really did mutate local state');

    // The SAME browser, rebooted — one physical store carried across two documents — healthy server.
    const b2 = mk({ store: Object.fromEntries(b1.app.store), stateGet: HAS_ROW });
    await b2.app.ctx.init();
    b2.app.runTimers(4);
    await settle();

    assert.ok(b2.puts.length >= 1, 'boot 2 issued no PUT, so this test proves nothing');
    for (const raw of b2.puts) {
      const r = await replay(raw);
      assert.ok(r.before.includes('UCsecret'), 'guard: the victim row really was seeded with data to lose');
      assert.equal(r.after, r.before,
        `the boot after the failed one destroyed the account row (boot-1 PUT ${putFails ? 'failed' : 'succeeded'})`);
    }
    // Both halves. Without this, B2 is satisfied by an app that stopped syncing in BOTH directions
    // and left the browser holding a claim it never resolved.
    assert.ok(String(b2.app.get('focus_channels')).includes('UCsecret'),
      'boot 2 never applied the server row — the browser is still holding an unresolved claim');
  });
}

test('B3 — a theme tap on a browser that DID read its row still saves', async () => {
  // The positive control. Without it, B1 and B2 are both satisfied by an app that has stopped saving
  // anything at all, which is a worse bug wearing this one's clothes.
  const { app, puts } = mk({ store: { focus_channels: MINE } });   // NO_ROW: the GET SUCCEEDED

  await app.ctx.init();
  await settle();
  puts.length = 0;                    // the adopt push is C4's subject, not this one
  assert.equal(app.click(app.themeOpt('dark')), 1, 'guard: the theme button was never wired');
  app.runTimers(4);
  await settle();

  const withState = puts.filter(carriesState);
  assert.ok(withState.length >= 1, 'a loaded browser stopped claiming state — the fix has broken syncing');
  assert.equal(JSON.parse(withState[0]).state.theme, 'dark', 'the push carried state, but not the theme change');

  // Replayed against a store with NO row, because that is what this client's boot actually read
  // (stateGet is NO_ROW above). Seeding a row here would model a browser writing over something it
  // never saw — which is refused by design, and would make this control fail for a
  // reason that has nothing to do with the theme tap it exists to prove. That race has its own
  // coverage: test/sync-conflict.test.mjs S4, and X-NOROW below.
  const r = await replay(withState[0], { users: [] });
  assert.notEqual(r.after, r.before, 'the state reached the server but never landed in the row');
  assert.ok(r.after.includes('"theme":"dark"'), 'the row does not hold the new theme');
});

test('B4 — signing out of an unloaded browser REFUSES, and destroys nothing', async () => {
  // Sign-out must NOT complete here on the
  // reasoning that a browser which never read its row holds only a stale mirror the server still has:
  // the code cannot know that, because it never read the row.
  // See B8 for the case that proves it. So there is no carve-out, and a browser holding data it could
  // not save refuses exactly as it does when a save fails:
  // signOut gains no new exit.
  const { app, puts } = mk({ store: { focus_channels: MINE, focus_events: BUFFERED }, stateGet: GET_FAILS });

  await app.ctx.init();
  app.runTimers(4);
  await settle();
  assert.equal(app.get('focus_dirty'), null, 'guard: nothing is pending, which is what makes this case the case');
  puts.length = 0;

  await app.ctx.signOut();

  assert.deepEqual(app.navigations, [], 'sign-out completed on a browser that could not save');
  assert.ok(String(app.get('focus_channels')).includes('UCmine'), 'the refusal destroyed the local state it exists to protect');
  assert.equal(app.get('focus_device_id'), DEVICE_ID, 'the device id must NOT rotate on a refusal');
  assert.equal(app.get('focus_dirty'), null, 'the refusal must not ITSELF mark dirty (R9-H2)');

  // …and it still must not have written the row on the way past.
  for (const raw of puts) {
    const r = await replay(raw);
    assert.ok(r.before.includes('UCsecret'), 'guard: the victim row really was seeded with data to lose');
    assert.equal(r.after, r.before, "signing out destroyed the account's channels on the way past");
  }
});

test('B8 — a channel added during the outage is not destroyed by signing out', async () => {
  // The regression test for a sign-out carve-out on unloaded browsers:
  // that design erased this channel from localStorage AND
  // never sent it. Data that existed nowhere else, gone on a sign-out.
  //
  // This is a real path — empty local store, existing account, failed read,
  // the app looks broken, so the user re-adds a channel — which is why it earns its own test rather
  // than living as a clause inside B4.
  const { app, puts } = mk({ stateGet: GET_FAILS });
  await app.ctx.init();
  await settle();

  app.ctx.saveChannels([{ id: 'UCnew', name: 'Channel I just added', source: 'youtube' }]);
  puts.length = 0;

  await app.ctx.signOut();

  const onTheWire = puts.some((p) => JSON.stringify(JSON.parse(p).state ?? {}).includes('UCnew'));
  const stillLocal = String(app.get('focus_channels') || '').includes('UCnew');
  assert.ok(onTheWire || stillLocal,
    `the only copy of the channel was destroyed: sent=${onTheWire} kept=${stillLocal}`);
});

// B5 runs BOTH ways on purpose. `putFails: true` alone pins the refusal
// for the WRONG reason — the failing PUT, not the suppression. The
// `putFails: false` row is the one that matters: the server is perfectly healthy and the client still
// cannot save, because it has no standing to.
for (const putFails of [true, false]) {
  test(`B5 — sign-out refuses when it could not save real un-pushed work (PUT ${putFails ? 'fails' : 'succeeds'})`, async () => {
    // `dirty` here came from an EARLIER, LOADED document whose push never landed, so local genuinely
    // IS ahead of the row. Refusing is the truthful answer and the recoverable one.
    const { app } = mk({ store: { focus_channels: MINE, focus_dirty: '1' }, stateGet: GET_FAILS, putFails });

    await app.ctx.init();
    await settle();
    assert.equal(app.get('focus_dirty'), '1', 'guard: this fixture must carry genuinely un-pushed work');

    await app.ctx.signOut();

    assert.deepEqual(app.navigations, [], 'sign-out completed despite failing to save real un-pushed work');
    assert.ok(String(app.get('focus_channels')).includes('UCmine'), 'the refusal destroyed the local state it exists to protect');
    assert.equal(app.get('focus_dirty'), '1', 'dirty must survive a refusal, or the next boot pulls a stale row down over it');
  });
}

test('B6 — a suppressed push still delivers and drains its events', async () => {
  // Suppression is not refusal. These are the boots where the instrumentation matters most, and
  // pushNow drops its sent events on `ok` — so a push that carried no state must still count as one.
  const { app, puts } = mk({ store: { focus_events: BUFFERED }, stateGet: GET_FAILS });

  await app.ctx.init();
  app.runTimers(4);
  await settle();

  assert.ok(puts.length >= 1, 'no PUT was issued, so this test proves nothing');
  assert.equal(app.get('focus_events'), null, 'the events stayed buffered — the metric that would reveal this goes blind');
  const { sql } = await replay(puts[0]);
  assert.ok(sql.events.length >= 1, 'the events never reached the server');
});

test('B7 — a bare pushNow() on an unloaded browser carries no state', async () => {
  // Why pushNow's dangerous `eventsOnly: false` default is tolerable: suppression
  // lives in ONE place, so today's four callers and tomorrow's inherit it without having to know.
  // A future call site added by someone who does not know the history is caught here.
  const { app, puts } = mk({ store: { focus_channels: MINE }, stateGet: GET_FAILS });

  await app.ctx.syncOnLoad();
  puts.length = 0;

  await app.ctx.pushNow();

  assert.equal(puts.length, 1, 'the bare push never went out, so this test proves nothing');
  assert.ok(!carriesState(puts[0]), 'a bare pushNow() claimed state this browser never loaded');
});

// ── The two hasUserData copies must agree ──────────────────────
// `_signOut`'s `nothingToSave` reads the CLIENT copy (app.js) to decide whether a sign-out sends
// state at all; `api/state.js` reads the SERVER copy (api/_state.js) to decide whether a PUT may
// create a row. The duplication is a risk: if the client copy drops its `archive`
// term,
// a user whose only content is archived then signs out with
// `nothingToSave === true`, the state is never sent, and clearLocalIdentity() wipes SK.archive —
// destroyed on both sides. Every term gets a fixture that is true through that term ALONE, so no
// single term can be deleted without a red.

const HAS_USER_DATA_FIXTURES = [
  ['channels alone',        { channels: [{ id: 'UC1' }], done: [], archive: [] },      true],
  ['done alone',            { channels: [], done: ['v1'], archive: [] },               true],
  ['archive alone',         { channels: [], done: [], archive: [{ id: 'v2' }] },       true],
  ['everything empty',      { channels: [], done: [], archive: [] },                   false],
  ['preferences only',      { theme: 'dark', shorts: 'true', groups: null },           false],
  ['an empty object',       {},                                                        false],
  ['null',                  null,                                                      false],
  ['keys absent entirely',  { theme: 'dark' },                                         false],
];

test('the client and server hasUserData agree, and every term is load-bearing', async () => {
  const { app } = mk();
  for (const [label, state, expected] of HAS_USER_DATA_FIXTURES) {
    assert.equal(app.ctx._hasUserData(state), expected, `client _hasUserData disagreed on: ${label}`);
    assert.equal(hasUserData(state), expected, `server hasUserData disagreed on: ${label}`);
  }
});
