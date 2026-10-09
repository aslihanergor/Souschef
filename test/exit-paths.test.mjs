// Exit-path regression tests (CHR-033, from BUG-017).
//
// Every HIGH finding across BUG-017's eight review rounds lived in signOut/deleteAccount/pushNow,
// and none of it had a test — the suite covered pure functions and the EXIT_DISPOSITION map, so a
// no-op clearLocalIdentity() stayed green. These run the REAL app.js in a fake browser
// (test-helpers/app-harness.mjs) and assert on observable output: what the store holds afterwards,
// what requests went out, where the page navigated.
//
// One test per bug that actually shipped. Each was checked to FAIL against the implementation that
// contained the bug — a regression test that never went red is decoration.
//
// Known NOT pinned, stated rather than papered over: removing the `_signingOut` re-entrancy guard
// leaves this suite green, because the seal already blocks the second call's push. The guard is
// belt-and-braces; no honest test reds on it. Everything else here was mutation-verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, SIGNED_IN } from '../test-helpers/app-harness.mjs';

const KEYS = ['focus_channels', 'focus_done', 'focus_archive', 'focus_groups',
              'focus_tweet_cache', 'focus_last_feed_load', 'focus_last_view',
              'focus_dirty', 'focus_events', 'focus_landing_seen', 'focus_include_shorts',
              // [TASK-092] review round 1 (L8): the tour record clears on exit, and SIGNED_IN seeds it so this can fail.
              'focus_tour'];

/** Respond per URL; anything unmatched throws, so an unexpected request fails loudly.
 *  Function values receive the request `init`, so a fixture can answer GET and PUT differently — see
 *  `stateRead` below. */
function routes(map) {
  return async (url, init) => {
    for (const [frag, res] of Object.entries(map)) {
      if (url.includes(frag)) return typeof res === 'function' ? res(init || {}) : res;
    }
    throw new Error(`unrouted request: ${url}`);
  };
}
const OK = { ok: true, status: 200, json: async () => ({}) };
const FAIL = { ok: false, status: 500, json: async () => ({}) };

// ── Standing (BUG-056) ──────────────────────────────────────────────────────
// A push may only claim state on a document that ASKED the server what it holds and got an answer.
// Every real document does: init() awaits syncOnLoad() and wireApp() connects the mutating controls
// only afterwards, so no user tap can precede the read. Tests that jump straight to signOut() were
// modelling a browser that cannot exist, and once standing became load-bearing they stopped saving
// anything — which is a fixture omission, not a requirement change. The tests below whose subject is
// a state push therefore boot first; the ones about seals, re-entrancy and refusals do not need to.
//
// The row read is EMPTY on purpose: applySyncedState is a no-op over it and no adopt push fires, so
// booting adds the FACT of a successful read and nothing else — no extra request to perturb a count,
// no local state overwritten behind a fixture's back.
const READ_OK = { ok: true, status: 200, json: async () => ({ state: {}, updatedAt: '2026-01-01T00:00:00.000Z' }) };
/** GET /api/state answers READ_OK (conferring standing); PUT answers `put`. */
const stateRead = (put) => (init) =>
  ((init.method || 'GET') === 'PUT' ? (typeof put === 'function' ? put() : put) : READ_OK);

test('a clean sign-out clears the previous user, keeps theme, and rotates the device id', async () => {
  const app = createApp({ store: SIGNED_IN, fetch: routes({ '/api/state': stateRead(OK), '/api/auth/logout': OK }) });
  const before = app.get('focus_device_id');
  await app.ctx.syncOnLoad();   // standing — without it this test signs out WITHOUT ever saving

  await app.ctx.signOut();

  // The half the name promises and this fixture used to skip entirely: a CLEAN sign-out saves first.
  // Without the boot above, the sign-out is events-only and this test is a duplicate of B4 wearing
  // the canonical name. (Review round 1, M1.)
  assert.ok(app.requests.some(r => r.url.includes('/api/state') && (r.init.method || 'GET') === 'PUT'
                                   && 'state' in JSON.parse(r.init.body)),
    'a clean sign-out must SAVE before it clears');
  for (const k of KEYS) assert.equal(app.get(k), null, `${k} should be cleared`);
  assert.equal(app.get('focus_theme'), 'dark', 'theme is deliberately kept');
  assert.equal(app.get('focus_was_authed'), '1', 'wasAuthed must survive for the signout metric');
  assert.notEqual(app.get('focus_device_id'), before, 'device id must rotate');
  assert.match(app.get('focus_device_id'), /^[0-9a-f-]{36}$/, 'rotated id is a uuid');
  assert.deepEqual(app.navigations, ['/app']);
});

test('a failed save refuses the sign-out BEFORE ending the session', async () => {
  // The ordering is the design: refusing after the session is gone leaves a browser that is signed
  // out while still holding the previous user's channels — BUG-017 itself.
  const app = createApp({ store: SIGNED_IN, fetch: routes({ '/api/state': stateRead(FAIL), '/api/auth/logout': OK }) });
  await app.ctx.syncOnLoad();   // standing: this browser read its row, so it has something to save

  await app.ctx.signOut();

  assert.ok(app.get('focus_channels'), 'local state must survive a refused sign-out');
  assert.equal(app.get('focus_device_id'), SIGNED_IN.focus_device_id, 'id must NOT rotate');
  // Requirement change, annotated deliberately. This asserted `dirty === '1'` when the branch was
  // written ("keep local and retry on the next boot"). Review round 9 demonstrated, with a red test
  // and an isolation control, that setting it turns a refused sign-out into a cross-account leak:
  // syncOnLoad reads dirty === '1' as "push local up" and returns without applySyncedState, so the
  // NEXT account to sign in never gets its row pulled down and inherits this user's channels — the
  // second symptom of the very bug this task closes. The flag must not be set here.
  assert.equal(app.get('focus_dirty'), null, 'must NOT mark dirty — see the note above (R9-H2)');
  assert.ok(!app.urls().some(u => u.includes('/api/auth/logout')),
    'the session must not be ended when we could not save');
  assert.deepEqual(app.navigations, [], 'no navigation — the user stays signed in');
});

test('a failed retry after a successful first push does NOT wipe local state', async () => {
  // R8-H3. `push = {ok: push.ok || retry.ok}` inside a branch already requiring push.ok is a
  // tautology, so a failed retry became invisible and the newest mutation was wiped from both sides.
  const app = createApp({ store: SIGNED_IN });
  let n = 0;
  app.setFetch(routes({
    '/api/state': stateRead(() => {
      n++;
      if (n === 1) { app.ctx.schedulePush(); return OK; } // a mutation lands mid-flight → !confirmed
      return FAIL;                                        // the retry fails
    }),
    '/api/auth/logout': OK,
  }));
  await app.ctx.syncOnLoad();   // standing; `n` still counts PUTs only, so the retry maths is unchanged

  await app.ctx.signOut();

  assert.ok(app.get('focus_channels'), 'the newest state was never confirmed — must not be wiped');
  assert.equal(app.get('focus_device_id'), SIGNED_IN.focus_device_id);
  assert.deepEqual(app.navigations, []);
});

test('a mutation landing mid-push is re-sent, not mistaken for a failure', async () => {
  // The other side of the same coin (R6-H1): gating on `confirmed` without a retry made a healthy
  // 200 read as a failure, which kept the previous user's state and skipped rotation.
  const app = createApp({ store: SIGNED_IN });
  let n = 0;
  app.setFetch(routes({
    '/api/state': stateRead(() => { n++; if (n === 1) app.ctx.schedulePush(); return OK; }),
    '/api/auth/logout': OK,
  }));
  await app.ctx.syncOnLoad();   // standing; `n` still counts PUTs only

  await app.ctx.signOut();

  assert.ok(n >= 2, 'the mid-flight mutation should have triggered a retry');
  assert.equal(app.get('focus_channels'), null, 'a confirmed save must proceed to clear');
  assert.notEqual(app.get('focus_device_id'), SIGNED_IN.focus_device_id);
  assert.deepEqual(app.navigations, ['/app']);
});

test('a logout that does not answer 200 refuses and leaves everything intact', async () => {
  const app = createApp({ store: SIGNED_IN, fetch: routes({ '/api/state': OK, '/api/auth/logout': FAIL }) });

  await app.ctx.signOut();

  assert.ok(app.get('focus_channels'), 'the cookie was never cleared — we are still signed in');
  assert.equal(app.get('focus_device_id'), SIGNED_IN.focus_device_id);
  assert.deepEqual(app.navigations, []);
});

test('a failed save with nothing to lose still signs out cleanly', async () => {
  // Refusing here would strand a user with an empty browser and no way to leave.
  //
  // What this exercises changed under TASK-084 R1-H2 and the name no longer says it out loud: with
  // nothing to save, signOut's push is now events-only, so the failing request is an analytics
  // flush rather than a state save. The claim is unaffected — the refusal branch is gated on
  // _hasUserData, which is false either way — but do not read this as still covering "a state PUT
  // failed". The state-carrying half is the test above.
  const empty = { focus_device_id: SIGNED_IN.focus_device_id, focus_theme: 'light', focus_was_authed: '1' };
  const app = createApp({ store: empty, fetch: routes({ '/api/state': FAIL, '/api/auth/logout': OK }) });

  await app.ctx.signOut();

  assert.notEqual(app.get('focus_device_id'), empty.focus_device_id, 'device id must still rotate');
  assert.deepEqual(app.navigations, ['/app']);
});

test('a refused sign-out does not release a seal taken by a delete in flight', async () => {
  // R8-H1. signOut's early refusal called unsealPushes(), but it had not sealed — the only seal it
  // could clear was deleteAccount's. A re-armed timer then fired mid-delete and wrote the state
  // into a device row that rotation orphaned permanently.
  const app = createApp({ store: SIGNED_IN, fetch: routes({ '/api/state': FAIL, '/api/auth/logout': OK }) });
  app.ctx.cancelPendingPushes({ sealed: true });   // stand in for the in-flight deleteAccount

  await app.ctx.signOut();
  const before = app.requests.length;
  await app.ctx.pushNow();                          // must still be sealed → no request

  assert.equal(app.requests.length, before, 'the seal must still hold after another exit refused');
});

test('a failed delete releases its own seal so syncing resumes', async () => {
  // R4-H1. `_leaving` was a one-way latch: after a failed delete every later push returned early,
  // silently, and the next sign-out then took the non-clearing branch.
  const app = createApp({ store: SIGNED_IN, fetch: routes({ '/api/auth/delete': FAIL, '/api/state': OK }) });

  await app.ctx.deleteAccount();
  assert.ok(app.get('focus_channels'), 'a failed delete must not destroy anything');

  const before = app.requests.length;
  await app.ctx.pushNow();

  assert.ok(app.requests.length > before, 'sync must resume after a failed delete');
});

test('a successful delete clears local state and rotates the device id', async () => {
  const app = createApp({ store: SIGNED_IN, fetch: routes({ '/api/auth/delete': OK }) });

  await app.ctx.deleteAccount();

  for (const k of KEYS) assert.equal(app.get(k), null, `${k} should be cleared`);
  assert.notEqual(app.get('focus_device_id'), SIGNED_IN.focus_device_id);
  assert.deepEqual(app.navigations, ['/app']);
  const del = app.requests.find(r => r.url.includes('/api/auth/delete'));
  assert.equal(del.init.headers['X-Device-Id'], SIGNED_IN.focus_device_id,
    'the PRE-rotation id must be sent, or the server deletes the wrong row');
});

test('retry exhaustion refuses: a 200 that never confirms is not a save', async () => {
  // Pins the crux decision of rounds 6-8: the gate is `confirmed`, NOT `ok`. Here the server always
  // answers 200 but a mutation lands during every attempt, so the newest state never reaches it.
  // Gating on `ok` would read this as success and wipe the browser. Without this test, changing
  // `!push.confirmed` to `!push.ok` leaves the whole suite green (review round 9 proved that).
  const app = createApp({ store: SIGNED_IN });
  let attempts = 0;
  app.setFetch(routes({
    '/api/state': stateRead(() => { attempts++; app.ctx.schedulePush(); return OK; }),  // always races
    '/api/auth/logout': OK,
  }));
  await app.ctx.syncOnLoad();   // standing; `attempts` still counts PUTs only

  await app.ctx.signOut();

  assert.equal(attempts, 3, 'the retry is bounded at 3 attempts — no spin');
  assert.ok(app.get('focus_channels'), 'never confirmed → must not wipe');
  assert.equal(app.get('focus_device_id'), SIGNED_IN.focus_device_id, 'id must not rotate');
  assert.ok(!app.urls().some(u => u.includes('/api/auth/logout')), 'the session must stay live');
});

test('a clean sign-out clears the dirty flag', async () => {
  // dirty is set AFTER the boot, not seeded before it: booting with dirty already set takes
  // syncOnLoad's dirty branch, whose push confirms and clears the flag on the way past — so the
  // assertion below would pass without signOut doing anything at all.
  const app = createApp({ store: SIGNED_IN,
                          fetch: routes({ '/api/state': stateRead(OK), '/api/auth/logout': OK }) });
  await app.ctx.syncOnLoad();
  app.set('focus_dirty', '1');
  assert.equal(app.get('focus_dirty'), '1', 'guard: the flag this test is about is actually set');

  await app.ctx.signOut();
  assert.equal(app.get('focus_dirty'), null, 'dirty must not outlive the state it describes');
});

test('a refused sign-out does not ITSELF mark state dirty (it does not close BUG-047)', async () => {
  // Narrow on purpose, and the name says so. This pins one thing: the refusal branch must not add
  // `dirty` of its own accord (review R9-H2 — it used to, which turned a refusal into a
  // cross-account leak even for a user who had mutated nothing).
  //
  // It does NOT show the cross-account leak is closed, and an earlier version of this test was
  // named as if it did. That name was false for every refusal a real user can produce: the refusal
  // is *reached* by an unsynced mutation, and any ordinary mutation already set `dirty` via
  // schedulePush(). Reproduced with A adding a channel, sign-out refused, B signing in → A's
  // channels land in B's account. The real fix is owner-stamping in syncOnLoad — BUG-047.
  // This fixture deliberately has no prior `dirty`, which is exactly why it isolates the branch.
  const app = createApp({ store: SIGNED_IN, fetch: routes({ '/api/state': stateRead(FAIL), '/api/auth/logout': OK }) });
  await app.ctx.syncOnLoad();   // standing, so the failing PUT below is a real refusal

  await app.ctx.signOut();
  assert.ok(app.get('focus_channels'), 'guard: the refusal kept A local');

  const puts = [];
  app.setFetch(async (url, init) => {
    if (url.includes('/api/state') && (init.method || 'GET') === 'PUT') { puts.push(JSON.parse(init.body)); return OK; }
    if (url.includes('/api/state')) {
      return { ok: true, status: 200, json: async () => ({ state: { channels: [{ id: 'UC_B' }], done: ['b1'], archive: [] }, updatedAt: 1 }) };
    }
    throw new Error(`unrouted: ${url}`);
  });
  await app.ctx.syncOnLoad();                  // B's session is now the one in play
  await new Promise(r => setImmediate(r));

  assert.ok(!puts.some(p => JSON.stringify(p.state ?? {}).includes('UC_prev')),
    "A's channels must never be uploaded into B's account");
  assert.ok((app.get('focus_channels') || '').includes('UC_B'),
    "B's own state must be pulled down, not replaced by A's");
});

test('a failed delete does not release a seal held by an in-flight sign-out', async () => {
  // R9-H1. Both buttons live in the same drawer, so the exits can overlap. Releasing another exit's
  // seal lets a timer fire mid-exit and write the departing state into a device row.
  const app = createApp({ store: SIGNED_IN });
  let releaseLogout;
  app.setFetch(async (url, init) => {
    if (url.includes('/api/state')) return (init.method || 'GET') === 'PUT' ? OK : READ_OK;
    if (url.includes('/api/auth/logout')) return new Promise(res => { releaseLogout = () => res(OK); });
    if (url.includes('/api/auth/delete')) return FAIL;
    throw new Error(`unrouted: ${url}`);
  });
  await app.ctx.syncOnLoad();   // standing, or the sign-out refuses before it reaches the logout

  const out = app.ctx.signOut();                       // seals, then hangs on logout
  for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r));
  assert.ok(app.urls().some(u => u.includes('/api/auth/logout')), 'guard: sign-out is past its seal');

  await app.ctx.deleteAccount();                       // fails, and must NOT unseal sign-out's seal

  const before = app.requests.length;
  await app.ctx.pushNow();
  assert.equal(app.requests.length, before, 'the seal must survive another exit failing');

  releaseLogout(); await out;
});

test('a sign-out that throws does not release a seal held by an in-flight delete', async () => {
  // R9-H3. The wrapper's catch used to reset _leaving unconditionally; _signOut can throw before it
  // ever seals.
  //
  // INSTRUMENT RE-POINTED by [BUG-051] (Asli, 2026-09-10), and the assertion below is untouched.
  // This used to force the throw with a corrupt `focus_channels`, because collectSyncedState()
  // parsed raw localStorage. It no longer throws there — `syncedDamaged()` short-circuits ahead of
  // it — so the fixture stopped producing a throw and the test PASSED WHILE EXERCISING NOTHING.
  // Verified vacuous before changing it, rather than assumed. `failGetItem` models the other real
  // cause the original comment already implied: a browser blocking site data, which refuses reads.
  // `_statePending()` is the first getItem `_signOut` reaches, and it is before the seal.
  const app = createApp({ store: SIGNED_IN });
  app.failGetItem(k => k === 'focus_dirty');
  let releaseDelete;
  app.setFetch(async (url) => {
    if (url.includes('/api/auth/delete')) return new Promise(res => { releaseDelete = () => res(OK); });
    if (url.includes('/api/state')) return OK;
    throw new Error(`unrouted: ${url}`);
  });

  const del = app.ctx.deleteAccount();                 // seals, then hangs
  await new Promise(r => setImmediate(r));
  await app.ctx.signOut();                             // throws on the corrupt JSON

  // NON-VACUITY GUARD (independent battery, O05). Without this the test cannot tell whether its own
  // instrument fired: disabling `failGetItem` entirely left it 18/18 green, which is the exact
  // vacuity class the re-point was made to fix. The wrapper's catch is the only thing that raises
  // this toast, so seeing it is proof the throw happened.
  assert.ok(app.toasts.some(t => /couldn.t sign out/i.test(String(t))),
    `the instrument must actually have thrown; toasts: ${JSON.stringify(app.toasts)}`);

  app.failGetItem(null);                                            // repair, to isolate the seal
  const before = app.requests.length;
  await app.ctx.pushNow();
  assert.equal(app.requests.length, before, 'a throwing sign-out must not unseal the delete');

  releaseDelete(); await del;
});

test('a push refused by the seal reports failure, so an exit cannot mistake it for a save', async () => {
  // pushNow's early return under `_leaving` must be {ok:false}. Reading a skipped push as success
  // is catastrophic and silent: sign-out would wipe the browser and rotate the id having issued
  // ZERO state PUTs. Mutating that return to {ok:true,confirmed:true} previously left the whole
  // suite green (review round 10).
  const app = createApp({ store: SIGNED_IN, fetch: routes({ '/api/state': stateRead(OK), '/api/auth/logout': OK }) });
  await app.ctx.syncOnLoad();                        // standing, so a suppressed push is not the reason
  app.ctx.cancelPendingPushes({ sealed: true });     // an exit is already in flight

  const res = await app.ctx.pushNow();
  // Field-by-field, not deepEqual: objects built inside the vm carry that realm's Object.prototype,
  // so a strict structural compare fails on prototype identity alone. See the harness header.
  assert.equal(res.ok, false, 'a sealed push must report ok:false');
  assert.equal(res.confirmed, false, 'and confirmed:false');

  const before = app.requests.length;
  await app.ctx.signOut();
  assert.equal(app.requests.length, before, 'guard: the seal really did suppress the network');
  assert.ok(app.get('focus_channels'), 'a skipped push must never authorise a wipe');
  assert.equal(app.get('focus_device_id'), SIGNED_IN.focus_device_id, 'nor a rotation');
});

test('a concurrent sign-out issues no requests', async () => {
  const app = createApp({ store: SIGNED_IN });
  let releaseLogout;
  app.setFetch(async (url, init) => {
    if (url.includes('/api/state')) return (init.method || 'GET') === 'PUT' ? OK : READ_OK;
    if (url.includes('/api/auth/logout')) return new Promise(res => { releaseLogout = () => res(OK); });
    throw new Error(`unrouted: ${url}`);
  });
  await app.ctx.syncOnLoad();   // standing, or the sign-out refuses before it reaches the logout

  const first = app.ctx.signOut();
  for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r));
  const before = app.requests.length;
  await app.ctx.signOut();                             // must not start a second exit
  assert.equal(app.requests.length, before, 'a concurrent sign-out must issue no requests');

  releaseLogout(); await first;
});

test('deleteAccount seals BEFORE its request, so a flush cannot write mid-delete', async () => {
  // Reproduced in review round 1 (H2): a queued push landing during the delete re-inserted the
  // state being deleted into a device row that rotation then orphaned.
  const app = createApp({ store: SIGNED_IN });
  let releaseDelete;
  app.setFetch(async (url) => {
    if (url.includes('/api/auth/delete')) return new Promise(res => { releaseDelete = () => res(OK); });
    if (url.includes('/api/state')) return OK;
    throw new Error(`unrouted: ${url}`);
  });

  const del = app.ctx.deleteAccount();
  await new Promise(r => setImmediate(r));
  const before = app.requests.length;
  app.ctx.flushPush();                                 // what pagehide/visibilitychange would do
  await new Promise(r => setImmediate(r));
  assert.equal(app.requests.length, before, 'no push may escape once the delete is sealed');

  releaseDelete(); await del;
});

test('keepalive is opt-in: interactive pushes are uncapped, the unload flush is not', async () => {
  // R5-H1. keepalive caps the request body at 64KiB and answers a network error over it, which the
  // bare catch swallowed — so sync died silently for exactly the users with the most to lose.
  const app = createApp({ store: SIGNED_IN, fetch: routes({ '/api/state': OK }) });

  await app.ctx.pushNow();
  assert.equal(app.requests.at(-1).init.keepalive, false, 'interactive push must not be capped');

  app.set('focus_dirty', '1');
  app.ctx.schedulePush();
  app.ctx.flushPush();
  await new Promise(r => setImmediate(r));
  assert.equal(app.requests.at(-1).init.keepalive, true, 'the unload flush must outlive the page');
});
