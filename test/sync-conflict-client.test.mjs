// BUG-047 attempt 4 — the CLIENT half. Stage A: the base, and what may refresh it.
//
// The rule the whole design hangs on: **the base is refreshed only by a pull the client actually
// APPLIED, or a push the server actually ACCEPTED — never by a GET it merely read.** The dirty
// branch pulls nothing, so it must not re-base; if it did it would re-arm the exact overwrite this
// fixes, which is why criterion 4 exists and why it is mutation-verified.
//
// Assertions are on observable output — what the store holds, what went out on the wire — never on
// "was this function called". Objects built inside the vm carry that realm's prototypes, so
// deepEqual from node:assert/strict fails on structurally identical values; compare fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';
import { EXIT_DISPOSITION } from '../lib/pure.js';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const REV_A = '2026-01-01T00:00:01.000000';
const REV_B = '2026-01-01T00:00:02.000000';
const ROW = { channels: [{ id: 'UCrow', name: 'From the row', source: 'youtube' }], done: ['v1'] };
// A DIFFERENT row, for the tests that need the server's copy to be distinguishable from local.
const OTHER_ROW = { channels: [{ id: 'UCother', name: 'Another device wrote this', source: 'youtube' }], done: [] };
const MINE = JSON.stringify([{ id: 'UCmine', name: 'My Channel', keyword: '', source: 'youtube' }]);

/** An app plus the PUTs it sent, each with the rev header it declared. */
function mk({ store = {}, get = null, putStatus = 200, putBody = null, putThrows = false } = {}) {
  const puts = [];
  const app = createApp({ store: { focus_device_id: DEVICE_ID, ...store } });
  app.setFetch(async (url, init) => {
    const method = init?.method || 'GET';
    if (url.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (url.includes('/api/state') && method === 'PUT') {
      puts.push({ body: init.body, rev: init.headers?.['X-State-Rev'] ?? null });
      if (putThrows) throw new Error('offline');
      return {
        ok: putStatus >= 200 && putStatus < 300,
        status: putStatus,
        json: async () => putBody ?? { updatedAt: '2026-01-01T00:00:02.000Z', rev: REV_B },
      };
    }
    if (url.includes('/api/state')) {
      return { ok: true, status: 200, json: async () => get ?? { state: null, updatedAt: null, rev: null } };
    }
    if (url.includes('/api/auth/logout')) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error(`unrouted: ${url}`);
  });
  return { app, puts };
}
const settle = () => new Promise((r) => setImmediate(r));

test('C1 a pull that is APPLIED stores the base it came from', async () => {
  const { app } = mk({ get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A } });
  await app.ctx.syncOnLoad();
  await settle();
  assert.equal(app.get('focus_rev'), REV_A, 'the applied row is what local is now based on');
  assert.ok(app.get('focus_channels').includes('UCrow'), 'guard: the pull really was applied');
});

test('C2 a boot that finds NO row stores no base', async () => {
  // No local user data on purpose, so syncOnLoad's adopt push does NOT fire and the GET is the only
  // thing that could set a base. With channels present the adopt push runs, the server accepts it and
  // re-bases legitimately — a correct outcome that would hide what this test is actually about.
  const { app } = mk();
  await app.ctx.syncOnLoad();
  await settle();
  assert.equal(app.get('focus_rev'), null, 'a client cannot be based on a row that does not exist');
});

test('C3 the dirty branch pulls nothing, so it must NOT re-base', async () => {
  // Criterion 4, and the single line that would re-arm the whole bug. The row is READ here and
  // deliberately not applied: local is ahead (BUG-015), so it is pushed instead. Re-basing from that
  // read would let this client overwrite a row it never looked at.
  // The PUT is made to FAIL on purpose. The dirty branch both reads and pushes, and an accepted push
  // re-bases legitimately — which overwrites the very evidence this test exists to look for. With the
  // push failing, the ONLY thing that could set a base is the read, so the assertion below can
  // finally see it. (Found by mutation M10 surviving: the guard was never actually observed.)
  const { app } = mk({
    store: { focus_channels: MINE, focus_dirty: '1' },
    get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A },
    putThrows: true,
  });
  await app.ctx.syncOnLoad();
  await settle();
  // Asserted against REV_A specifically — the value the GET carried. The dirty branch also PUSHES,
  // and an accepted push re-bases on purpose (criterion 4's other half), so `null` is the wrong
  // assertion: it would fail for a correct implementation. What must never happen is the READ
  // becoming the base.
  assert.equal(app.get('focus_rev'), null, 'a GET that was merely READ must not become a base');
  assert.ok(!app.get('focus_channels').includes('UCrow'), 'guard: the row must not have been applied');
});

test('C4 a push declares the base it holds', async () => {
  const { app, puts } = mk({ get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A } });
  await app.ctx.syncOnLoad();
  await settle();
  puts.length = 0;
  app.ctx.saveChannels([{ id: 'UCnew', name: 'New', source: 'youtube' }]);
  app.runTimers(4);
  await settle();
  assert.ok(puts.length >= 1, 'guard: nothing was sent at all');
  assert.equal(puts[0].rev, REV_A, 'the write must declare what it was based on');
});

test('C5 an ACCEPTED push re-bases from the response', async () => {
  const { app } = mk({ get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A } });
  await app.ctx.syncOnLoad();
  await settle();
  app.ctx.saveChannels([{ id: 'UCnew', name: 'New', source: 'youtube' }]);
  app.runTimers(4);
  await settle();
  assert.equal(app.get('focus_rev'), REV_B, 'the accepted write is the new base');
  assert.equal(app.get('focus_dirty'), null, 'and it confirmed, so dirty clears');
});

test('C6 BUG-057 — a write the server DISCARDED is not reported as saved', async () => {
  // 200 with updatedAt null: the server matched no row and stored nothing. Third outcome, neither
  // accepted nor refused.
  const { app } = mk({
    store: { focus_theme: 'dark' },
    putBody: { updatedAt: null, rev: null },
  });
  await app.ctx.syncOnLoad();
  await settle();
  const res = await app.ctx.pushNow();
  assert.equal(res.confirmed, false, 'nothing was stored, so nothing may be claimed');
  assert.equal(app.get('focus_rev'), null, 'a discarded write must not become a base');
});

test('C7 BUG-057 — dirty is CLEARED anyway, because leaving it set destroys data', async () => {
  // The counter-intuitive half, and the measurement behind it (2026-08-23): with dirty left set, a
  // later boot takes syncOnLoad's dirty branch, pushes an EMPTY blob over a row another device
  // created, and skips the pull. Replayed against the real handler that emptied a row holding
  // 1 channel + 2 done, at 200 OK, silently. `dirty` asserts "local is ahead of the server row" —
  // there is no row, so the claim is not merely useless, it is false and dangerous.
  const { app } = mk({
    store: { focus_theme: 'dark' },
    putBody: { updatedAt: null, rev: null },
  });
  await app.ctx.syncOnLoad();
  await settle();
  app.set('focus_dirty', '1');
  await app.ctx.pushNow();
  assert.equal(app.get('focus_dirty'), null, 'dirty must not survive a write against a row that does not exist');
});

test('C8 the base may not outlive the data it describes', async () => {
  // Criterion 9, as a pure invariant over the table rather than a scenario.
  //
  // The reason written here first was BACKWARDS and argued for the opposite of the line beneath it
  // (review round 4, claim-verification; the same error as the one in lib/pure.js, corrected there
  // too). "A dropped rev means an unconditional accept" is false: a write with no base can only ever
  // CREATE, so an emptied browser holding no rev is harmless. The hazard is a rev that SURVIVES and
  // still MATCHES — the exit wipes `channels` and leaves the row alone, so the stale rev is a valid,
  // current base for a row this browser has no business writing to, and the empty blob is ACCEPTED.
  // That is [BUG-047] returning through the exit path.
  assert.equal(EXIT_DISPOSITION.channels, 'clear', 'guard: the premise of this invariant changed');
  assert.equal(EXIT_DISPOSITION.rev, 'clear',
    'rev must not outlive the channels it is a version of');
});

test('C9 a response claiming a base while reporting nothing stored is not believed', async () => {
  // Defence in depth, and it is why the re-base is gated on ACCEPTED rather than on `r.ok`. This
  // response contradicts itself: "I stored nothing" and "here is your new version". Our own server
  // cannot produce it, which is exactly why the client must not lean on that — a proxy, a rollback,
  // or a later change to the handler can, and adopting a base for a row that does not exist hands
  // this client permission to overwrite whatever appears at that key next.
  const { app } = mk({
    store: { focus_theme: 'dark' },
    putBody: { updatedAt: null, rev: REV_B },
  });
  await app.ctx.syncOnLoad();
  await settle();
  await app.ctx.pushNow();
  assert.equal(app.get('focus_rev'), null, 'a write that stored nothing cannot be a base');
});

// ── Stage B: the halt, the notice, and the one action that resolves it ───────

const CONFLICT = { putStatus: 409, putBody: { error: 'stale state' } };
const pressAction = (app) => app.el('toast').querySelector('.toast-action').onclick();

/** A booted client that holds a base and has just been refused. */
async function halted(opts = {}) {
  const h = mk({
    store: { focus_channels: MINE },
    // `kind` is part of every real GET since fix B — a fixture without it is a body the server can
    // no longer produce, which is exactly the shape finding F is about.
    get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A, kind: 'device' },
    ...CONFLICT, ...opts,
  });
  await h.app.ctx.syncOnLoad();
  // Wire the controls, as a real boot does immediately after syncOnLoad. Needed because the sign-out
  // warning is resolved by a BUTTON, and a tap on an unwired button is silently a no-op that looks
  // exactly like a handler which correctly did nothing — the confusion BUG-017's re-verification
  // lost three clicks to. app.click() returning 0 is what catches it.
  h.app.ctx.wireApp();
  await settle();
  h.puts.length = 0;
  h.app.ctx.saveChannels([{ id: 'UCnew', name: 'New', source: 'youtube' }]);
  h.app.runTimers(4);
  await settle();
  return h;
}

test('C10 a 409 halts pushes — a later mutation sends nothing', async () => {
  // A leaked halt disables sync invisibly, which is worse than the bug. That is why it is in memory
  // only (a reload clears it) and why C12 pins that it keeps SAYING so.
  const { app, puts } = await halted();
  assert.equal(puts.length, 1, 'guard: the refused push must have gone out');
  puts.length = 0;
  app.ctx.saveChannels([{ id: 'UCanother', name: 'Another', source: 'youtube' }]);
  app.runTimers(4);
  await settle();
  assert.equal(puts.filter((p) => JSON.parse(p.body).state !== undefined).length, 0,
    'pushes must stop until the conflict is resolved');
});

test('C11 the refusal tells the user, and offers exactly one way out', async () => {
  const { app } = await halted();
  const said = app.toasts.join(' | ');
  assert.match(said, /not syncing/i, `nothing was said to the user — toasts: ${said}`);
  const btn = app.el('toast').querySelector('.toast-action');
  assert.ok(!btn.classList.contains('hidden'), 'the action must be visible, not merely wired');
  assert.match(btn.textContent, /saved copy/i);
});

test('C12 the halt keeps saying so — sync-paused is a state, not an event', async () => {
  // Punch-list item 6, found four times independently: the early return preceded the notice, so it
  // showed once, auto-hid at 5s, and every later push no-opped in silence.
  const { app } = await halted();
  const before = app.toasts.length;
  app.ctx.saveChannels([{ id: 'UCagain', name: 'Again', source: 'youtube' }]);
  app.runTimers(4);
  await settle();
  assert.ok(app.toasts.length > before, 'a later push while halted must re-show the notice');
});

test('C13 pressing the action resolves the conflict rather than restarting it', async () => {
  const { app, puts } = await halted();
  await pressAction(app);
  await settle();
  assert.ok(app.get('focus_channels').includes('UCrow'), "the server's copy is now on screen");
  assert.equal(app.get('focus_rev'), REV_A, 'and local is based on it');
  assert.equal(app.get('focus_dirty'), null, 'nothing is left claiming to be ahead');
  // The halt must actually lift: a resolution that leaves sync dead is the leaked halt by another
  // route, and a reload would re-show the same notice forever.
  puts.length = 0;
  app.ctx.saveChannels([{ id: 'UCafter', name: 'After', source: 'youtube' }]);
  app.runTimers(4);
  await settle();
  assert.ok(puts.length >= 1, 'sync must resume after the conflict is resolved');
});

test('C14 pushNow reports a REFUSAL only when the server actually refused', async () => {
  // The distinction the sign-out carve-out rests on: a 409 is DETERMINATE (this will never be
  // saved), a network failure is INDETERMINATE (a retry may work). Confusing them either signs a
  // user out with unsaved state or wedges sign-out forever. Both directions, on purpose.
  const { app } = await halted();
  const refused = await app.ctx.pushNow();
  assert.equal(refused.refused, true, 'a 409 is determinate');

  const b = mk({ store: { focus_channels: MINE }, putThrows: true });
  await b.app.ctx.syncOnLoad();
  await settle();
  const failed = await b.app.ctx.pushNow();
  assert.notEqual(failed.refused, true, 'a network failure must NOT read as a refusal');
});

test('C15 adopting when the row has vanished never drops the base', async () => {
  // Punch-list item 2. A base deleted while local data is kept IS the unconditional-overwrite state,
  // and it is reachable: the session can lapse between the refused PUT and the press, so the GET
  // resolves to an empty device namespace. Keep the base, keep the data, lift the halt.
  const { app } = await halted();
  app.setFetch(async (url, init) => {
    if ((init?.method || 'GET') === 'GET' && url.includes('/api/state')) {
      // `kind` matters here, and its absence made this test PASS FOR THE WRONG REASON once fix B
      // landed: an unlabelled row is refused before the vanished-row branch is ever reached, so the
      // assertions below were satisfied by a path this test is not about. It is the RIGHT namespace
      // that has no row — that is the case worth pinning.
      return { ok: true, status: 200, json: async () => ({ state: null, updatedAt: null, rev: null, kind: 'device' }) };
    }
    return { ok: true, status: 200, json: async () => ({ updatedAt: null, rev: null }) };
  });
  app.toasts.length = 0;
  await pressAction(app);
  await settle();
  assert.equal(app.get('focus_rev'), REV_A, 'the base must not be dropped');
  assert.ok(app.get('focus_channels').includes('UCnew'), 'and local work must not be destroyed');
  // MED-3: it used to do all of that in complete silence, then re-raise the same notice 1.5s later
  // via rearmPush — so the one escape the app offers appeared broken at the moment it was reached for.
  assert.ok(app.toasts.some((t) => /no saved copy/i.test(t)),
    `the press must be answered; toasts were ${JSON.stringify(app.toasts)}`);
});

test('C16 adopting cannot write behind an exit that is already under way', async () => {
  // Punch-list item 3: adoptServerCopy was the only user-state writer not gated by the exit seal and
  // the only sync fetch with no timeout, so a stalled GET could resolve after sign-out had wiped and
  // rotated — writing the departing account's channels back into the anonymous browser. BUG-017's
  // original leak, restored by the affordance built to fix a different one.
  const { app } = await halted();
  app.ctx.cancelPendingPushes({ sealed: true });
  const channelsAtSeal = app.get('focus_channels');
  const requestsAtSeal = app.urls().length;
  await pressAction(app);
  await settle();
  assert.equal(app.get('focus_channels'), channelsAtSeal, 'an exit is in flight — write nothing');
  // And issue nothing either. Checked separately because the post-await seal check alone satisfies
  // the assertion above, which left the PRE-await one unobserved — mutation M20 survived on exactly
  // that. A request that is merely discarded on return has still been sent, and its response can
  // still arrive after the exit has wiped and rotated.
  assert.equal(app.urls().length, requestsAtSeal, 'no request may be issued behind an exit');
});

test('C17 a refused push drains its events rather than re-shipping them forever', async () => {
  // The batch DID reach the server — api/state.js ingests events on the refusal path too, because
  // they are attributed independently of the state row. Returning before the drain leaves them
  // buffered, so every later flush re-sends the same batch and every metric double-counts for the
  // life of the halt. Recorded as open against attempt 3.
  const { app } = mk({
    store: {
      focus_channels: MINE,
      focus_events: JSON.stringify([{ name: 'view', section: 'feed', ts: 1753000000000 }]),
    },
    get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A },
    ...CONFLICT,
  });
  await app.ctx.syncOnLoad();
  await settle();
  assert.ok(app.get('focus_events'), 'guard: the fixture must start with something buffered');
  await app.ctx.pushNow();
  assert.equal(app.get('focus_events'), null, 'delivered events must not be re-sent on the next flush');
});

// ── Stage D: sign-out survives a halt, and still refuses a genuine failure ───
//
// Asli's decision, 2026-08-23. She was asked "You've made changes the app couldn't save. You tap
// Sign out. What should happen?" and SELECTED the option labelled "Let them out, but warn first",
// described as: "A confirm step naming the loss... Always escapable, and the destruction is chosen
// rather than silent."
//
// The wording above is the OPTION's, written by me — she chose it, she did not say it. An earlier
// version of this comment presented it inside quote marks as her own words, and quoted it a second,
// different way in a commit message, so the two could not both be verbatim. CLAUDE.md family 3 is
// explicit: a cited authorisation must be one Asli actually gave, because a fabricated citation
// reads exactly like a real one to every future reader — and it is load-bearing precisely where the
// rules demand a human decision. Corrected 2026-08-23 after review round 4 caught it.
//
// The decision itself OVERRIDES BUG-017's refuse-and-stay-recoverable, but only for
// the DETERMINATE case. A network failure is still indeterminate and still refuses, which is why
// these two tests are deliberately opposite and both must hold.

const signOutPanel = (app) => app.el('acct-signout-confirm');

test('C18 a halted sign-out warns and does NOT sign the user out', async () => {
  const { app } = await halted();
  await app.ctx.signOut();
  await settle();
  assert.ok(!signOutPanel(app).classList.contains('hidden'), 'the warning must be shown');
  assert.ok(app.get('focus_channels'), 'nothing may be destroyed before the user chooses');
  assert.equal(app.navigations.length, 0, 'and the sign-out must not have completed');
});

test('C19 confirming the warning completes the sign-out', async () => {
  const { app } = await halted();
  await app.ctx.signOut();
  await settle();
  assert.equal(app.click(app.el('acct-signout-go')), 1, 'guard: the confirm button was never wired');
  await settle();
  // The destruction is now CHOSEN. EXIT_DISPOSITION does the clearing; what matters here is that the
  // exit ran at all, because refusing forever is the wedge this decision exists to avoid.
  assert.equal(app.get('focus_channels'), null, 'the exit ran');
  assert.equal(app.get('focus_rev'), null, 'and the base did not outlive it');
});

test('C20 a NETWORK-failed sign-out still refuses — the opposite direction', async () => {
  // Criterion 6, unchanged by Asli's decision. A retry may yet work, so staying recoverable is still
  // right here. If this ever starts warning instead, un-pushed work is destroyed on a blip.
  const b = mk({ store: { focus_channels: MINE }, putThrows: true });
  await b.app.ctx.syncOnLoad();
  await settle();
  await b.app.ctx.signOut();
  await settle();
  assert.ok(signOutPanel(b.app).classList.contains('hidden'), 'a blip must not offer to destroy work');
  assert.match(b.app.toasts.join(' | '), /not signed out/i, 'it must say the save failed');
  assert.ok(b.app.get('focus_channels'), 'and keep the work');
});

test('C21 the warning does not linger into the next time the drawer is opened', async () => {
  // Same rule the delete confirm follows: a drawer that reopens mid-confirm is one stray tap from a
  // destruction the user has stopped intending.
  const { app } = await halted();
  await app.ctx.signOut();
  await settle();
  assert.ok(!signOutPanel(app).classList.contains('hidden'), 'guard: it must be open to begin with');
  app.ctx.closeProfile();
  assert.ok(signOutPanel(app).classList.contains('hidden'), 'closing the drawer collapses it');
});

// ── Stage C: read-modify-write ordering ─────────────────────────────────────
//
// Punch-list item 5, and the reason it is a rule change rather than an implementation slip: the
// conflict rule as scoped said which write WINS and was silent on ordering. The base is read per
// invocation, so two overlapping pushes declare the SAME base, the server accepts the first, and the
// second is refused — a single user on a single device gets a halt plus an affordance offering to
// discard their own newest state. Reachable from flushPush (whose trigger is truthy WHILE a push
// carrying those events is in flight), from _signOut, and from the independent 1.5s/3s timers.

const REV_C = '2026-01-01T00:00:03.000000';

/** An app whose PUTs take a couple of ticks to answer, so two can genuinely overlap — and which
 *  REFUSES a stale base exactly as the real handler does. Modelling the refusal is what makes C23
 *  decisive: a fake that accepts everything cannot produce the conflict the latch exists to prevent,
 *  so the test would pass with or without it. */
function racing({ gateState = false } = {}) {
  const puts = [];
  const revs = [REV_B, REV_C];
  let current = REV_A;
  let n = 0;
  // An EXPLICIT gate on the state PUT, for the one test that needs "did this wait for that" to be a
  // fact rather than a race. Without it, C24 asserted an exact interleaving of two promise chains
  // against a fake that hops setImmediate twice — one extra turn anywhere and it flips. Review round
  // 4 saw it fail once and could not reproduce it in ~55 attempts; whatever caused that, a test whose
  // result depends on scheduler turns is fragile by construction, and is fixed rather than re-run
  // until it agrees.
  let release;
  const gate = new Promise((r) => { release = r; });
  const app = createApp({ store: { focus_device_id: DEVICE_ID, focus_channels: MINE } });
  app.setFetch(async (url, init) => {
    const method = init?.method || 'GET';
    if (url.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (url.includes('/api/state') && method === 'PUT') {
      const body = JSON.parse(init.body);
      puts.push({ rev: init.headers?.['X-State-Rev'] ?? null, carriesState: body.state !== undefined });
      if (body.state === undefined) return { ok: true, status: 200, json: async () => ({ updatedAt: null, rev: null }) };
      const declared = init.headers?.['X-State-Rev'] ?? null;
      const mine = n++;
      if (gateState) await gate;
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      if (declared !== current) {
        return { ok: false, status: 409, json: async () => ({ error: 'stale state' }) };
      }
      current = revs[mine] ?? REV_C;
      return { ok: true, status: 200, json: async () => ({ updatedAt: 'later', rev: current }) };
    }
    if (url.includes('/api/state')) {
      return { ok: true, status: 200, json: async () => ({ state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A }) };
    }
    throw new Error(`unrouted: ${url}`);
  });
  return { app, puts, releaseState: () => release() };
}

test('C22 overlapping pushes do not declare the same base', async () => {
  const { app, puts } = racing();
  await app.ctx.syncOnLoad();
  await settle();
  puts.length = 0;

  const a = app.ctx.pushNow();
  const b = app.ctx.pushNow();     // issued while A is still in flight
  await Promise.all([a, b]);

  assert.equal(puts.length, 2, 'guard: the two pushes must both have gone out');
  assert.equal(puts[0].rev, REV_A, 'the first declares what the boot established');
  assert.equal(puts[1].rev, REV_B,
    'the second must declare the base the FIRST established, not the stale one it started with');
});

test('C23 a user racing themselves is never told their own copy is different', async () => {
  // The user-visible consequence of C22, and the reason it matters: without ordering, one person on
  // one device is offered a notice inviting them to discard their own newest work.
  const { app } = racing();
  await app.ctx.syncOnLoad();
  await settle();
  const before = app.toasts.length;
  await Promise.all([app.ctx.pushNow(), app.ctx.pushNow()]);
  assert.equal(app.toasts.length, before, `a self-race raised a conflict: ${app.toasts.join(' | ')}`);
});

test('C24 analytics are not made to queue behind a state push', async () => {
  // Events claim no state and have no base to be stale, so serialising them would buy nothing and
  // would delay the flush that exists to drain them.
  const { app, puts, releaseState } = racing({ gateState: true });
  await app.ctx.syncOnLoad();
  await settle();
  puts.length = 0;
  // "Did the events push wait for the state push" is now a FACT, not a race. The state PUT is held
  // open by an explicit gate this test controls, so if analytics were serialised behind it the events
  // push simply CANNOT settle until the gate is released — no scheduler turn can change that.
  // Completion is still not the observable (mutation M28 survived on exactly that confusion); what is
  // asserted is that the events push finished WHILE the state push was still outstanding.
  let stateDone = false;
  const state = app.ctx.pushNow().then(() => { stateDone = true; });
  const events = app.ctx.pushNow({ eventsOnly: true });
  const outcome = await Promise.race([
    events.then(() => 'events-settled'),
    new Promise((r) => setTimeout(() => r('events-blocked'), 300)),
  ]);
  assert.equal(outcome, 'events-settled', 'analytics must not be made to wait behind a state push');
  assert.equal(stateDone, false, 'guard: the state push really was still in flight');
  releaseState();
  await Promise.all([state, events]);
  assert.ok(puts.some((p) => !p.carriesState), 'guard: an events-only push must actually have gone out');
});

test('C25 a storage failure writing the base does not take down the boot', async () => {
  // Criterion 11, applied to the line THIS task added. Attempt 1 put collectSyncedState() outside the
  // try, so a corrupt key threw out of syncOnLoad, rejected the boot's Promise.all and left a blank
  // app where it used to self-heal. The re-base is a localStorage WRITE on the boot path — quota,
  // a private window, or a browser blocking site data all throw — so it inherits that risk exactly.
  // A base we failed to record is a client that declares none: it can still create, never overwrite.
  // Losing sync is survivable; losing the app is not.
  const { app } = mk({ get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A } });
  const real = app.ctx.localStorage.setItem.bind(app.ctx.localStorage);
  app.ctx.localStorage.setItem = (k, v) => {
    if (k === 'focus_rev') throw new Error('QuotaExceededError');
    return real(k, v);
  };
  await assert.doesNotReject(() => app.ctx.syncOnLoad(), 'the boot must survive a failed rev write');
  assert.ok(app.get('focus_channels').includes('UCrow'), 'and the pull that did succeed must stand');
});

// ── Fix A: the absorbing state ([BUG-047] review round 4, must-fix A) ───────────────────────────
//
// The defect these pin: `syncOnLoad`'s dirty branch returns before the re-base (correct — criterion
// 4), so the push it fires declares a stale base, is refused, and `dirty` is never cleared, because
// only a 200 clears it. The next boot repeats it identically, forever. The escape existed, but it
// destroyed the user's work — and that is not a tolerable price for the EVERYDAY trigger, which is
// not the rollout at all: the unload flush is a `keepalive` push that by design outlives the
// document, so the write LANDS and the response carrying the new rev is never read. Mark a video
// done, close the tab, reopen — sync dead. That is the app's core mobile interaction.
//
// A5 is the control that keeps A1 honest: the same boot shape, one channel different, must still
// refuse. Without it A1 would pass just as well against a mutant that clears `dirty` unconditionally.

/** The exact shape collectSyncedState() builds, so a row can be made byte-identical to local. */
const asRow = (channels, done = []) => ({ channels, done, archive: [], theme: null, shorts: null, groups: null });
const MINE_ARR = [{ id: 'UCmine', name: 'My Channel', keyword: '', source: 'youtube' }];

test('A1 a dirty boot whose row ALREADY matches local clears dirty and re-bases — no push, no notice', async () => {
  // The keepalive case exactly: the unload flush landed, the row holds this browser's own state, and
  // only the response (carrying the new rev) was lost. Nothing is genuinely un-pushed.
  const { app, puts } = mk({
    store: { focus_channels: MINE, focus_dirty: '1', focus_rev: REV_A },
    get: { state: asRow(MINE_ARR), updatedAt: '2026-01-01T00:00:02.000Z', rev: REV_B },
  });
  await app.ctx.syncOnLoad();
  await settle();
  assert.equal(app.get('focus_dirty'), null, 'nothing is un-pushed, so the claim that something is must go');
  assert.equal(app.get('focus_rev'), REV_B, 'local is a copy of THIS row, so it is based on it');
  assert.equal(puts.length, 0, 'writing identical bytes is a round trip that changes nothing');
  assert.equal(app.toasts.length, 0, 'and there is no conflict to tell the user about');
  assert.ok(app.get('focus_channels').includes('UCmine'), 'guard: local data is untouched');
});

test('A2 the reconciled boot can push again — the halt does not survive it', async () => {
  // The second half of the absorbing state: recovering `dirty` is worthless if the base is still the
  // stale one, because the very next mutation is refused and the app re-enters the halt.
  const { app, puts } = mk({
    store: { focus_channels: MINE, focus_dirty: '1', focus_rev: REV_A },
    get: { state: asRow(MINE_ARR), updatedAt: '2026-01-01T00:00:02.000Z', rev: REV_B },
  });
  await app.ctx.syncOnLoad();
  await settle();
  await app.ctx.pushNow();
  await settle();
  assert.equal(puts.length, 1, 'the mutation after reconciliation really did go out');
  assert.equal(puts[0].rev, REV_B, 'and it declared the row it is now based on, not the stale one');
});

test('A3 jsonb key REORDERING is not a difference', async () => {
  // Postgres `jsonb` does not preserve key order — it stores keys sorted by length then bytewise. So
  // the row read back is routinely a reordering of what this browser sent. A plain JSON.stringify
  // comparison passes against any hand-built fixture and then never fires once in production: green,
  // correct, and measuring the wrong quantity.
  //
  // The reordering has to be INSIDE a value, not at the top level: sameSyncedState compares
  // value-by-value per key, so a top-level reordering is invisible to it by construction. The first
  // version of this test reordered only the top level, passed for that reason, and let the mutation
  // that removes the sort survive — the "green, correct, and measuring the wrong quantity" shape,
  // caught by the battery rather than by re-reading it.
  const reorderedChannels = [{ source: 'youtube', keyword: '', name: 'My Channel', id: 'UCmine' }];
  const reordered = { groups: null, done: [], theme: null, archive: [], shorts: null, channels: reorderedChannels };
  const { app, puts } = mk({
    store: { focus_channels: MINE, focus_dirty: '1', focus_rev: REV_A },
    get: { state: reordered, updatedAt: '2026-01-01T00:00:02.000Z', rev: REV_B },
  });
  await app.ctx.syncOnLoad();
  await settle();
  assert.equal(app.get('focus_dirty'), null, 'the same state in a different key order is the same state');
  assert.equal(puts.length, 0);
});

test('A4 a boot with NO base at all still reconciles when the row matches', async () => {
  // `rev` absent rather than stale — the rollout shape, and what a browser that has never completed
  // a pull holds. Measured in round 4 as `dirty=1 rev=null` repeating identically over three boots.
  const { app, puts } = mk({
    store: { focus_channels: MINE, focus_dirty: '1' },
    get: { state: asRow(MINE_ARR), updatedAt: '2026-01-01T00:00:02.000Z', rev: REV_B },
  });
  await app.ctx.syncOnLoad();
  await settle();
  assert.equal(app.get('focus_dirty'), null);
  assert.equal(app.get('focus_rev'), REV_B, 'the base is acquired from a row local already equals');
  assert.equal(puts.length, 0);
});

test('A5 CONTROL: local genuinely AHEAD of the row still pushes, and is still refused', async () => {
  // Sized so only the guard under test can fire: identical to A1 except for one channel. If this
  // went quiet too, A1 would be passing against a mutant that clears `dirty` unconditionally — which
  // is the data-destroying direction, since the next boot would then pull the row down over the
  // un-pushed change.
  const { app, puts } = mk({
    store: { focus_channels: MINE, focus_dirty: '1', focus_rev: REV_A },
    get: { state: asRow([{ id: 'UCother', name: 'Someone else', keyword: '', source: 'youtube' }]), updatedAt: '2026-01-01T00:00:02.000Z', rev: REV_B },
    putStatus: 409,
    putBody: { error: 'stale state' },
  });
  await app.ctx.syncOnLoad();
  await settle();
  assert.equal(puts.length, 1, 'a genuinely un-pushed change must still be offered to the server');
  assert.equal(app.get('focus_dirty'), '1', 'and must stay marked un-pushed when the server refuses it');
  assert.ok(app.get('focus_channels').includes('UCmine'), 'local data survives the refusal');
});

// ── Fix B: adopting across namespaces ([BUG-047] review round 4, must-fix B) ────────────────────
//
// Found by the exit-paths reviewer and independently by data-safety. `api/_session.js` returns null
// on a DB BLIP as well as on expiry, so the adopt GET can silently resolve to the DEVICE namespace
// while the user is signed in — and the response carried no indication of which namespace answered.
// Reproduced in round 4: a signed-in user presses "Use saved copy", receives a stale anonymous
// snapshot, loses their un-pushed change, and their NEXT push writes their own curated list into the
// anonymous device row. That is this task's own subject, reached through the affordance built to
// fix it.
//
// The `updatedAt == null` branch showed the case had been CONSIDERED — it handles only the sub-case
// where the device namespace happens to be empty.

/** A halted client that has also completed a sign-in, so _authEmail is set. */
async function haltedSignedIn(opts = {}) {
  const h = mk({
    store: { focus_channels: MINE },
    get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A, kind: 'account' },
    ...CONFLICT, ...opts,
  });
  await h.app.ctx.checkAuth();
  await h.app.ctx.syncOnLoad();
  h.app.ctx.wireApp();
  await settle();
  h.puts.length = 0;
  h.app.ctx.saveChannels([{ id: 'UCnew', name: 'New', source: 'youtube' }]);
  h.app.runTimers(4);
  await settle();
  return h;
}

/** Point the NEXT GET /api/state at a specific body, leaving the other routes alone. */
function answerAdoptWith(app, body) {
  app.setFetch(async (url, init) => {
    const method = init?.method || 'GET';
    if (url.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (url.includes('/api/state') && method === 'PUT') return { ok: false, status: 409, json: async () => ({ error: 'stale state' }) };
    if (url.includes('/api/state')) return { ok: true, status: 200, json: async () => body };
    throw new Error(`unrouted: ${url}`);
  });
}

test('B1 a signed-in user is NOT handed the anonymous device row', async () => {
  // The session blip. The row that answers is real, populated and someone else's context entirely.
  const { app } = await haltedSignedIn();
  const before = app.get('focus_channels');
  answerAdoptWith(app, { state: { channels: [{ id: 'UCstranger', name: 'Not yours', source: 'youtube' }] }, updatedAt: '2026-01-01T00:00:05.000Z', rev: REV_B, kind: 'device' });
  await pressAction(app);
  await settle();
  assert.equal(app.get('focus_channels'), before, 'nothing from the other namespace may land');
  assert.ok(!String(app.get('focus_channels')).includes('UCstranger'), 'and specifically not that');
  assert.equal(app.get('focus_dirty'), '1', 'the change is still un-pushed, so it must still say so');
  assert.equal(app.get('focus_rev'), REV_A, 'and the base must not be taken from the wrong row');
  assert.ok(app.toasts.length, 'a refusal the user cannot see is indistinguishable from a dead button');
});

test('B2 CONTROL: the SAME press adopts when the namespace is the expected one', async () => {
  // Sized so only the namespace check can fire — identical to B1 but for `kind`. Without this, B1
  // would pass just as well against an adopt that never adopts anything.
  const { app } = await haltedSignedIn();
  answerAdoptWith(app, { state: { channels: [{ id: 'UCsaved', name: 'The saved copy', source: 'youtube' }] }, updatedAt: '2026-01-01T00:00:05.000Z', rev: REV_B, kind: 'account' });
  await pressAction(app);
  await settle();
  assert.ok(app.get('focus_channels').includes('UCsaved'), 'the right namespace must still adopt');
  assert.equal(app.get('focus_rev'), REV_B, 'and re-base onto the row it adopted');
  assert.equal(app.get('focus_dirty'), null, 'local is a copy of the row now, not ahead of it');
});

test('B3 an anonymous browser is NOT handed an account row either', async () => {
  // The reverse leak, and the one BUG-063 is about: _authEmail can be stale-null while the cookie is
  // still good. Adopting there pours an account's channels into a browser nobody has signed in on.
  const { app } = await halted();
  const before = app.get('focus_channels');
  answerAdoptWith(app, { state: { channels: [{ id: 'UCaccount', name: 'Someone’s account', source: 'youtube' }] }, updatedAt: '2026-01-01T00:00:05.000Z', rev: REV_B, kind: 'account' });
  await pressAction(app);
  await settle();
  assert.equal(app.get('focus_channels'), before, 'an anonymous browser adopts only the device row');
});

test('B4 a response that does not SAY which namespace answered is refused', async () => {
  // Fail safe. An absent `kind` is not evidence of the right namespace, and the whole finding is that
  // the client cannot tell them apart unaided. Refusing costs a visible "try again"; guessing costs
  // the user's data.
  const { app } = await haltedSignedIn();
  const before = app.get('focus_channels');
  answerAdoptWith(app, { state: { channels: [{ id: 'UCunknown', name: 'Unlabelled', source: 'youtube' }] }, updatedAt: '2026-01-01T00:00:05.000Z', rev: REV_B });
  await pressAction(app);
  await settle();
  assert.equal(app.get('focus_channels'), before, 'an unlabelled row is not adopted');
  assert.equal(app.get('focus_dirty'), '1');
});

// ── Fix C: a storage throw mid-adopt ([BUG-047] review round 4, must-fix C) ─────────────────────
//
// exit-paths HIGH-2. `applySyncedState` does six unguarded `setItem` calls and only the REPAINT was
// wrapped, so a throw on the third key left local half-replaced. `showToast` then calls the action as
// `onAction()` without awaiting, so the rejection was UNHANDLED and the toast hid as if it had
// worked. Measured in round 4: the user's channel gone, `dirty` still set, the base not re-based,
// and `toasts: []`. The function's own comment claimed "a failed resolution must leave NOTHING
// half-adopted" — a false claim sitting directly above the code that violated it.

test('CS1 a storage failure mid-adopt leaves NOTHING half-adopted, and says so', async () => {
  const { app } = await haltedSignedIn();
  const before = { channels: app.get('focus_channels'), done: app.get('focus_done'), archive: app.get('focus_archive') };
  answerAdoptWith(app, {
    state: { channels: [{ id: 'UCsaved', name: 'Saved', source: 'youtube' }], done: ['d1'], archive: [{ id: 'a1' }] },
    updatedAt: '2026-01-01T00:00:05.000Z', rev: REV_B, kind: 'account',
  });
  // Fail on the THIRD synced key, so the first two have already been written when it throws. A
  // failure on the first key would leave nothing to roll back and prove nothing.
  app.failSetItem((k) => k === 'focus_archive');
  await pressAction(app);
  await settle();
  assert.equal(app.get('focus_channels'), before.channels, 'a partial adopt must be rolled back, not kept');
  assert.equal(app.get('focus_done'), before.done, 'including the keys that DID succeed');
  assert.equal(app.get('focus_archive'), before.archive);
  assert.equal(app.get('focus_dirty'), '1', 'nothing was adopted, so local is still ahead');
  assert.equal(app.get('focus_rev'), REV_A, 'and must not be re-based onto a row it did not take');
  assert.ok(app.toasts.some((t) => /couldn.t|try again/i.test(t)),
    `the user must be told; toasts were ${JSON.stringify(app.toasts)}`);
});

test('CS2 CONTROL: the same adopt with storage working still adopts all six keys', async () => {
  // Sized so only the rollback can fire. Without this, CS1 passes against an adopt that never writes.
  const { app } = await haltedSignedIn();
  answerAdoptWith(app, {
    state: { channels: [{ id: 'UCsaved', name: 'Saved', source: 'youtube' }], done: ['d1'], archive: [{ id: 'a1' }] },
    updatedAt: '2026-01-01T00:00:05.000Z', rev: REV_B, kind: 'account',
  });
  await pressAction(app);
  await settle();
  assert.ok(app.get('focus_channels').includes('UCsaved'));
  assert.ok(app.get('focus_done').includes('d1'));
  assert.ok(app.get('focus_archive').includes('a1'));
  assert.equal(app.get('focus_rev'), REV_B);
  assert.equal(app.get('focus_dirty'), null);
});

test('CS3 a toast action that REJECTS is handled, not dropped on the floor', async () => {
  // The second half of C, and the reason the failure above was silent rather than loud: showToast
  // ran the action as a bare `onAction()`, so a rejected promise escaped into an unhandled rejection
  // and the toast hid as though the action had succeeded. Asserted on the process, because "was it
  // awaited" is not observable from the store.
  const { app } = mk();
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    app.ctx.showToast('anything', 'Do it', async () => { throw new Error('boom'); });
    await pressAction(app);
    await settle();
    await settle();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  assert.equal(seen.length, 0, `a rejected toast action must not escape; saw ${seen.map(String)}`);
});

// ── Fix E: the notice must be REACHABLE ([BUG-047] review round 4, must-fix E) ──────────────────
//
// claim-verification #17: punch-list item 6 was HALF closed while commit 8cdccf0 listed it as
// closed. The early-return ordering was fixed; the drawer-close re-show was never implemented, and
// `_showSyncConflict` had exactly two call sites, neither of them closeProfile.
//
// Measured in style.css this session: `.profile-panel` is z-index 61 and `.toast` is z-index 60, so
// the drawer paints OVER the notice. The drawer also contains the theme toggle, which makes it the
// likeliest way to raise a conflict in the first place — so the most probable route to a halt is the
// one where the user never sees it. That matters more than it would otherwise, because Asli's "no
// second button" decision is conditional on the notice being reachable.

test('E1 closing the drawer re-shows the notice while sync is still halted', async () => {
  const { app } = await halted();
  app.ctx.openProfile();
  // Cleared AFTER the open, deliberately: a re-show moved into openProfile would satisfy this test
  // otherwise, and a notice raised while the drawer is open is exactly the one the drawer covers.
  app.toasts.length = 0;
  app.ctx.closeProfile();
  await settle();
  assert.ok(app.toasts.length >= 1, 'a notice the drawer painted over must come back when it closes');
  assert.ok(app.toasts.some((t) => /not syncing/i.test(t)),
    `and it must be the sync notice; toasts were ${JSON.stringify(app.toasts)}`);
});

test('E2 CONTROL: closing the drawer on a HEALTHY client says nothing', async () => {
  // Sized so only the halt can fire. Without this, E1 passes against a closeProfile that toasts
  // unconditionally — which would train the user to ignore it.
  const { app } = mk({ get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A, kind: 'device' } });
  await app.ctx.syncOnLoad();
  await settle();
  app.toasts.length = 0;
  app.ctx.openProfile();
  app.ctx.closeProfile();
  await settle();
  assert.equal(app.toasts.length, 0, 'nothing is wrong, so nothing may be said');
});

test('E3 the notice comes back on EVERY drawer close, not just the first', async () => {
  // Sync-paused is a STATE. The toast auto-hides at 5s, so a re-show that fires once is the same
  // "appeared once, then silence" defect the early-return ordering already had.
  const { app } = await halted();
  app.ctx.openProfile(); app.ctx.closeProfile();
  await settle();
  app.ctx.openProfile();
  app.toasts.length = 0;
  app.ctx.closeProfile();
  await settle();
  assert.ok(app.toasts.some((t) => /not syncing/i.test(t)), 'the second close must say it too');
});

// ── Phase 2: the guards review round 4 found UNPINNED ───────────────────────────────────────────
//
// Each of these SURVIVED an independent mutation. The code was right; nothing would have noticed if
// it stopped being. That distinction matters more than a bug count: a guard nothing watches is a
// guard that will be deleted by a future refactor with a green suite as its evidence.

test('G1 (R1) the POST-await seal: an exit beginning DURING the adopt GET writes nothing', async () => {
  // C16 sealed BEFORE pressing, so only the pre-await check ever fired and the duplicated post-await
  // one — the very window the duplication exists for, [BUG-017]'s original leak — was unobserved.
  // Here the exit begins while the GET is in flight, which only the second check can catch.
  const { app } = await haltedSignedIn();
  const before = app.get('focus_channels');
  app.setFetch(async (url, init) => {
    const method = init?.method || 'GET';
    if (url.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (url.includes('/api/state') && method === 'PUT') return { ok: false, status: 409, json: async () => ({ error: 'stale state' }) };
    if (url.includes('/api/state')) {
      // The exit starts here — after the request went out, before its answer is applied.
      app.ctx.cancelPendingPushes({ sealed: true });
      return { ok: true, status: 200, json: async () => ({ state: { channels: [{ id: 'UCsaved', name: 'Saved', source: 'youtube' }] }, updatedAt: '2026-01-01T00:00:05.000Z', rev: REV_B, kind: 'account' }) };
    }
    throw new Error(`unrouted: ${url}`);
  });
  await pressAction(app);
  await settle();
  assert.equal(app.get('focus_channels'), before, 'a response that lands behind an exit must not be applied');
  assert.equal(app.get('focus_rev'), REV_A, 'nor re-base the browser it is leaving');
});

test('G2 (R9) a 500 is INDETERMINATE — it must not halt sync nor report a refusal', async () => {
  // `r.status === 409` rather than `!r.ok`, and the difference is the whole determinate/indeterminate
  // split. Under `!r.ok` a 500 halts sync AND reports `refused`, so sign-out warns-and-destroys on an
  // error a retry would have survived.
  const { app, puts } = mk({
    store: { focus_channels: MINE },
    get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A, kind: 'device' },
    putStatus: 500, putBody: { error: 'write failed' },
  });
  await app.ctx.syncOnLoad();
  await settle();
  const r = await app.ctx.pushNow();
  assert.notEqual(r.refused, true, 'a 500 is not a refusal — a retry may yet work');
  assert.equal(app.toasts.length, 0, 'and it must not raise the conflict notice');
  // The halt is what makes it permanent, so check the NEXT push still goes out.
  puts.length = 0;
  await app.ctx.pushNow();
  assert.ok(puts.length >= 1, 'sync must not be halted by a server error');
});

test('G3 (R4) analytics still ride while sync is halted', async () => {
  // `_syncHalted && !eventsOnly`. Documented behaviour with zero coverage: halting the events too
  // blinds the metric on exactly the sessions worth measuring, and drops the buffer with them.
  const { app, puts } = await halted();
  puts.length = 0;
  app.ctx.track('view', 'feed');
  app.runTimers(4);
  await settle();
  assert.ok(puts.length >= 1, 'a halted client must keep reporting');
  assert.ok(puts.every((p) => JSON.parse(p.body).state === undefined), 'and those pushes claim no state');
});

test('G4 a push blocked by an EXIT must not report a refusal', async () => {
  // One of the scope's own verification rows, omitted by the round-4 battery: adding `refused: true`
  // to the `_leaving` early return survived the whole suite. It would make sign-out's second press
  // complete MID-DELETE — [BUG-017] H3's shape, arriving through the new affordance.
  const { app } = await halted();
  app.ctx.cancelPendingPushes({ sealed: true });
  const r = await app.ctx.pushNow();
  assert.equal(r.ok, false, 'guard: the push really was blocked');
  assert.notEqual(r.refused, true, 'blocked by our own exit is not "the server refused this"');
});

test('G5 (R2/R3) a push stays blocked while ANY exit still holds a seal', async () => {
  // R2 and R3 mutated the two terms of `_leaving || _heldSeals.size` separately and both survived,
  // because in today's code the two are EQUIVALENT: cancelPendingPushes sets both, and unsealPushes
  // clears `_leaving` only once the set is empty. No input can separate them, so no fixture can pin
  // them apart, and writing one that pretended to would be theatre.
  //
  // What IS pinnable is the behaviour the redundancy exists for — R8-H1's overlapping exits, where
  // sign-out's early refusal used to release deleteAccount's seal and let a timer fire mid-delete.
  //
  // REWRITTEN 2026-08-24, because the version that claimed the above could not observe it. Its
  // fixture was `halted()`, so `_syncHalted` was set and BOTH the seal branch and the halt branch
  // returned {ok:false} with no PUT; it asserted only those two facts, which cannot tell them apart.
  // Measured rather than argued — `mutations/BUG-047-G5-control.mjs` reintroduced both defects this
  // test names and the old G5 killed NEITHER (CTRL-A died to one pre-existing exit-paths test,
  // CTRL-B to six tests including G4). The file's "10 of 11 closed" tally had rested on it.
  //
  // Two things make it able to fail. The fixture is NOT halted, so the seal is the only guard that
  // can block this push (CLAUDE.md family 2: size the fixture so only the guard under test can
  // fire). And the block is followed by a POSITIVE CONTROL, because "nothing was sent" is satisfied
  // just as well by a client that can no longer send anything at all.
  const { app, puts } = mk({ store: { focus_channels: MINE } });
  await app.ctx.syncOnLoad();
  app.ctx.wireApp();
  await settle();
  puts.length = 0;

  const first = app.ctx.cancelPendingPushes({ sealed: true });
  const second = app.ctx.cancelPendingPushes({ sealed: true });   // a second exit overlaps
  app.ctx.unsealPushes(first);                                    // the first one finishes

  const blocked = await app.ctx.pushNow();
  assert.equal(blocked.ok, false, 'the second exit is still in flight — nothing may be written behind it');
  assert.notEqual(blocked.refused, true, 'and blocked by our own exit is not "the server refused this"');
  assert.equal(puts.length, 0, 'nothing may be sent, either');

  // The control. With the last seal released the very same call must reach the wire — otherwise the
  // three assertions above pass against a permanently wedged client, which is how the old G5 passed.
  const allowed = await app.ctx.pushNow();
  assert.equal(puts.length, 0, 'guard: still sealed, so this changed nothing');
  app.ctx.unsealPushes(second);
  const after = await app.ctx.pushNow();
  assert.equal(puts.length, 1, 'once the last exit releases, the same push reaches the wire');
  assert.equal(after.ok, true, 'and it is reported as a save');
  assert.equal(allowed.ok, false, 'guard: the middle call was still blocked');
});

test('G6 (R15) the base follows the DATA, as an invariant and not just on one branch', async () => {
  // Criterion 4 was pinned only for the dirty branch (C3). The rule is broader: a base may be
  // recorded ONLY where the row was actually applied. Here the pull-down branch runs and the base
  // must equal the row that was applied — before any push can muddy it.
  const { app } = mk({ get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A, kind: 'device' } });
  await app.ctx.syncOnLoad();
  await settle();
  assert.ok(app.get('focus_channels').includes('UCrow'), 'guard: the row really was applied');
  assert.equal(app.get('focus_rev'), REV_A, 'and the base is the row that was applied');

  // The other half of the same invariant: a GET whose body was read but NOT applied leaves no base.
  const notApplied = mk({
    store: { focus_channels: MINE, focus_dirty: '1' },
    get: { state: OTHER_ROW, updatedAt: '2026-01-01T00:00:09.000Z', rev: REV_B, kind: 'device' },
    ...CONFLICT,
  });
  await notApplied.app.ctx.syncOnLoad();
  await settle();
  assert.notEqual(notApplied.app.get('focus_rev'), REV_B, 'a row that was read and not applied is not a base');
});

test('G7 criterion 5, second half: a RELOAD without pressing re-shows the notice', async () => {
  // Pinned deliberately by the scope and by no test — no client test performed a second boot after a
  // halt. `_syncHalted` dies with the document, but `dirty` and the stale base survive it, so the
  // next boot must arrive at the same refusal rather than quietly giving up or quietly overwriting.
  const store = { focus_device_id: DEVICE_ID, focus_channels: MINE, focus_dirty: '1', focus_rev: REV_A };
  const second = mk({
    store,
    get: { state: OTHER_ROW, updatedAt: '2026-01-01T00:00:09.000Z', rev: REV_B, kind: 'device' },
    ...CONFLICT,
  });
  await second.app.ctx.syncOnLoad();
  await settle();
  assert.ok(second.app.toasts.some((t) => /not syncing/i.test(t)),
    `the reload must arrive at the same notice; toasts were ${JSON.stringify(second.app.toasts)}`);
  assert.equal(second.app.get('focus_dirty'), '1', 'and must still hold the un-pushed work');
  assert.ok(second.app.get('focus_channels').includes('UCmine'), 'which is still on the device');
});

test('G8 a boot that never learned what the server holds still reports, and claims nothing', async () => {
  // NOT the `!_stateLoaded` term of the queue bypass — that term is unreachable (see the comment on
  // it in app.js), and a test written to "cover" it could never fail. This asserts the BUG-056
  // behaviour that is real and reachable: a document whose boot GET failed holds a copy of nothing,
  // so its pushes carry no state and declare no base, and it must still deliver analytics.
  const { app, puts } = mk({ store: { focus_channels: MINE } });
  app.setFetch(async (url, init) => {
    const method = init?.method || 'GET';
    if (url.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (url.includes('/api/state') && method === 'PUT') {
      puts.push({ body: init.body, rev: init.headers?.['X-State-Rev'] ?? null });
      return { ok: true, status: 200, json: async () => ({ updatedAt: null, rev: null }) };
    }
    if (url.includes('/api/state')) return { ok: false, status: 500, json: async () => ({}) };  // the boot GET fails
    throw new Error(`unrouted: ${url}`);
  });
  await app.ctx.syncOnLoad();
  await settle();
  puts.length = 0;
  await app.ctx.pushNow();
  assert.ok(puts.length >= 1, 'an unloaded document must still be able to send');
  assert.equal(JSON.parse(puts[0].body).state, undefined, 'and what it sends claims no state');
  assert.equal(puts[0].rev, null, 'nor declares a base it never read');
});

test('H1 the notice is honest in BOTH directions, and is allowed the room to say it', async () => {
  // A condition of Asli's "no second button" decision (2026-08-23), not a copy preference. The
  // argument for having no second button is that DOING NOTHING is already the non-destructive
  // option — local data survives, only syncing stops. That is only true for the user if the notice
  // tells them so. The previous wording read as though the one button were the only move.
  //
  // And it must fit: `.toast-msg` is `white-space: nowrap; text-overflow: ellipsis`, so the default
  // pill is ONE TRUNCATED LINE and cannot carry two directions. Measured in style.css this session.
  const { app } = await halted();
  const said = app.toasts.join(' | ');
  assert.match(said, /not syncing/i, 'it still names the state');
  assert.match(said, /stay here/i, 'what happens if you do NOTHING — the safe half, said out loud');
  assert.match(said, /replaces them/i, 'and what happens if you press — the destructive half');
  assert.ok(app.el('toast').classList.contains('toast-wrap'),
    'a two-direction notice in a nowrap pill is a one-direction notice with an ellipsis');
});

test('H2 an ORDINARY toast is not left wrapped behind the notice', async () => {
  // The toast element is reused. Toggling the class only when true would leave every later toast
  // wrapped — a fix that quietly changes every other message in the app.
  const { app } = await halted();
  assert.ok(app.el('toast').classList.contains('toast-wrap'), 'guard: the notice really did wrap');
  app.ctx.showToast('Marked as done');
  assert.equal(app.el('toast').classList.contains('toast-wrap'), false,
    'the next ordinary toast must go back to the single-line pill');
});

// ── The exit push and the in-flight latch ([BUG-047]) ──────────────────────────────────────
//
// BUG-047 added a one-state-push-at-a-time latch (`_pushInFlight`), because the base is read per
// invocation: two overlapping pushes declare the SAME base, the server accepts the first, the row
// moves, and the second is refused — a single user on one device gets a halt and an affordance
// offering to discard their own newest state. `_signOut` is one of the three routes that made that
// reachable from one page, so the latch only does its job if sign-out actually respects it.
//
// A related sub-fix was built here TWICE and cut both times, and the reasoning is recorded in
// tasks/BUG-047.md so it is not re-picked blind: a hung PUT parks sign-out (round 4 MED-2), and
// both remedies for it — an AbortController on the PUT, and a deadline on sign-out's wait — were
// measured to be worse than the parking. See the comment in _pushNow. The parking is tracked on
// its own; main's PUT is unbounded too, so this task does not make it worse.

/**
 * A signed-in app holding channels, whose PUT the test drives, over a server that does the
 * conditional write this task exists for: a PUT declaring a base that no longer describes the row
 * is refused. (It does NOT model the base-less case — the real handler refuses that too, via
 * `on conflict do nothing`, and no test here exercises it.)
 */
function signOutRig(put) {
  const puts = [];
  let serverRev = REV_A;
  const app = createApp({
    store: { focus_device_id: DEVICE_ID, focus_channels: MINE, focus_rev: REV_A, focus_was_authed: '1' },
  });
  app.setFetch(async (url, init) => {
    const method = init?.method || 'GET';
    if (url.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (url.includes('/api/auth/logout')) return { ok: true, status: 200, json: async () => ({}) };
    if (url.includes('/api/state') && method === 'PUT') {
      const rec = { n: puts.length + 1, base: init.headers?.['X-State-Rev'] ?? null,
                    hasState: 'state' in JSON.parse(init.body) };
      puts.push(rec);
      return put(rec, {
        refuse: () => rec.base && rec.hasState && rec.base !== serverRev,
        commit: () => { serverRev = REV_B; return serverRev; },
      });
    }
    if (url.includes('/api/state')) return { ok: true, status: 200, json: async () => ({
      state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A, kind: 'account' }) };
    throw new Error(`unrouted: ${url}`);
  });
  return { app, puts };
}

test('J3 sign-out never issues a write that declares a base another write already used', async () => {
  // What the latch is FOR, asserted on the path that made it necessary. Two writes declaring the
  // same base means the server accepts one and refuses the other, and sign-out reading that 409
  // treats it as determinate and shows the panel whose second press discards local state. Measured
  // 2026-08-24 against a _signOut that skipped the queue: reachable with an ordinary background
  // save, no network fault required.
  // The background save must still be IN FLIGHT when sign-out is pressed, or there is no overlap
  // and this test pins nothing. Its first draft let it answer immediately, and the mutation written
  // to validate it was killed by a DIFFERENT test — caught 2026-08-24 by predicting the killer's
  // name before running the battery, not by re-reading the test.
  let release;
  const held = new Promise((r) => { release = r; });
  const { app, puts } = signOutRig(async (rec, srv) => {
    if (rec.n === 1) await held;           // the background write is still out when sign-out starts
    if (srv.refuse()) return { ok: false, status: 409, json: async () => ({ error: 'stale base' }) };
    const rev = rec.hasState ? srv.commit() : REV_A;
    return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-01T00:00:02.000Z', rev }) };
  });
  await app.ctx.checkAuth();               // a real boot resolves the sign-in before syncOnLoad decides ([BUG-063]) — setup-only edit, approved by Asli 2026-09-11: "yes to the 3 rigs"
  await app.ctx.syncOnLoad();
  await settle();
  const bg = app.ctx.pushNow();            // a routine background save, already in flight
  await settle();
  assert.equal(puts.length, 1, 'guard: the background write is out and unanswered');
  const so = app.ctx.signOut();            // pressed WHILE it is unanswered
  await settle(); await settle();
  release();                               // now it lands, and sign-out may proceed
  await Promise.allSettled([bg, so]);
  await settle(); await settle();
  const bases = puts.filter(p => p.hasState).map(p => p.base);
  assert.equal(new Set(bases).size, bases.length,
    `two writes declared the same base: ${JSON.stringify(bases)} — one of them must be refused`);
  assert.ok(puts.every(p => p.n === 1 || p.base === REV_B), 'the second write declares the version the first produced');
  assert.equal(app.get('focus_channels'), null, 'and the sign-out completes normally');
  assert.notEqual(app.get('focus_device_id'), DEVICE_ID, 'device id rotates on a clean sign-out');
});

test('C (round 5) a rollback that would exceed quota still leaves local byte-identical', async () => {
  // applySyncedState is all-or-nothing ONLY if its rollback cannot itself fail. It restores in
  // FORWARD order, so an early key can be put back while a LATER one still holds the server's
  // larger value — an intermediate total the original never reached. That setItem throws, a bare
  // catch swallows it, and local is left holding the SERVER's value for one key and its own for
  // another: a state neither side ever had. ([BUG-047] review round 5, C — reached independently
  // by two reviewers.)
  const pad = (n) => 'x'.repeat(n);
  const CH_O = JSON.stringify([{ id: 'UCmine', n: pad(280) }]);   // local channels: big
  const DN_O = JSON.stringify([pad(30)]);                          // local done: small
  const AR_O = JSON.stringify([pad(30)]);                          // local archive: small
  const app = createApp({ store: {
    focus_device_id: DEVICE_ID, focus_channels: CH_O, focus_done: DN_O, focus_archive: AR_O } });
  const SYNCED = ['focus_channels', 'focus_done', 'focus_archive', 'focus_theme', 'focus_include_shorts', 'focus_groups'];
  const CAP = CH_O.length + DN_O.length + AR_O.length + 20;        // the original state fits, barely
  app.failSetItem((k, v) => {
    let total = v.length;
    for (const key of SYNCED) { if (key !== k) { const cur = app.get(key); if (cur) total += cur.length; } }
    return total > CAP;                                            // a real quota: on the TOTAL
  });
  // The server's copy shrinks channels, grows done, and blows the cap on archive — so the adopt
  // fails with channels and done already replaced.
  assert.throws(() => app.ctx.applySyncedState({
    channels: [{ id: 'UCtheirs' }], done: [pad(200)], archive: [pad(300)] }),
    'guard: the adopt must fail, or this test proves nothing');
  assert.equal(app.get('focus_channels'), CH_O, 'channels restored exactly');
  assert.equal(app.get('focus_done'), DN_O, 'done restored exactly');
  assert.equal(app.get('focus_archive'), AR_O, 'archive restored exactly');
});

/** A booted, signed-in app whose PUTs are recorded; PUT #1 hangs so it stays in flight. */
function flushRig({ hangFirst = true } = {}) {
  const puts = [];
  let arrived; const firstOut = new Promise((r) => { arrived = r; });
  const app = createApp({ store: {
    focus_device_id: DEVICE_ID, focus_rev: REV_A,
    focus_channels: JSON.stringify([{ id: 'UCmine', name: 'Mine', source: 'youtube' }]) } });
  app.setFetch(async (url, init) => {
    const method = init?.method || 'GET';
    if (url.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (url.includes('/api/state') && method === 'PUT') {
      const rec = { n: puts.length + 1, base: init.headers?.['X-State-Rev'] ?? null,
                    keepalive: !!init.keepalive, hasState: 'state' in JSON.parse(init.body) };
      puts.push(rec);
      if (rec.n === 1 && hangFirst) { arrived(); return new Promise(() => {}); }
      arrived();
      return { ok: true, status: 200, json: async () => ({ updatedAt: '2026-01-01T00:00:02.000Z', rev: REV_B }) };
    }
    if (url.includes('/api/state')) return { ok: true, status: 200, json: async () => ({
      state: { channels: [{ id: 'UCmine', name: 'Mine', source: 'youtube' }] },
      updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A, kind: 'account' }) };
    throw new Error(`unrouted: ${url}`);
  });
  return { app, puts, firstOut };
}

test('[BUG-100] the unload flush claims no state while a write is already in flight', async () => {
  // The flush bypasses the latch by design — the page is going away and waiting means never
  // sending. But the base is read per invocation, so a flush firing while an interactive PUT is
  // still travelling declares the SAME base, and the server refuses one of them. If the interactive
  // one loses, a document that SURVIVES (visibilitychange fires on an ordinary tab switch) is left
  // halted, showing a notice whose action replaces local data.
  const { app, puts, firstOut } = flushRig();
  await app.ctx.checkAuth();            // a real boot resolves the sign-in before syncOnLoad decides ([BUG-063]) — setup-only edit, approved by Asli 2026-09-11: "yes to the 3 rigs"
  await app.ctx.syncOnLoad();
  await settle();
  puts.length = 0;
  app.ctx.schedulePush();               // a user mutation: arms the debounce, marks dirty
  app.ctx.pushNow().catch(() => {});    // the interactive save goes out and stays out
  await firstOut;
  await settle();
  assert.equal(puts.length, 1, 'guard: the interactive write is out and unanswered');
  app.ctx.flushPush();                  // tab backgrounded
  await settle(); await settle();
  const stateWrites = puts.filter((p) => p.hasState);
  assert.equal(stateWrites.length, 1,
    `only the in-flight write may claim state; bases were ${JSON.stringify(stateWrites.map(p => p.base))}`);
  const flush = puts.find((p) => p.keepalive);
  assert.ok(flush, 'the flush still goes out — it carries analytics, which must drain');
  assert.equal(flush.hasState, false, 'but it claims no state, so it has no base to be stale');
});

test('[BUG-100] CONTROL: with nothing in flight, the flush still carries state', async () => {
  // The fix must narrow the flush, not disable it. "Mark a video done, close the tab" depends on
  // this write landing.
  const { app, puts } = flushRig({ hangFirst: false });
  await app.ctx.checkAuth();            // a real boot resolves the sign-in before syncOnLoad decides ([BUG-063]) — setup-only edit, approved by Asli 2026-09-11: "yes to the 3 rigs"
  await app.ctx.syncOnLoad();
  await settle();
  puts.length = 0;
  app.ctx.schedulePush();
  app.ctx.flushPush();
  await settle(); await settle();
  const flush = puts.find((p) => p.keepalive);
  assert.ok(flush, 'the flush went out');
  assert.equal(flush.hasState, true, 'and carried the state, because nothing was racing it');
});

test('C2 CONTROL: when EVERY write is blocked, the rollback frees nothing and destroys nothing', async () => {
  // A private window or a browser blocking site data makes every setItem throw while removeItem
  // still works. The rollback frees only what the adopt actually wrote — nothing, here — so local
  // must come through untouched. A rollback that freed all six keys unconditionally would delete a
  // store the old code left alone, which is a worse bug than the one C fixes.
  const CH = JSON.stringify([{ id: 'UCmine', name: 'Mine' }]);
  const app = createApp({ store: { focus_device_id: DEVICE_ID, focus_channels: CH, focus_done: '["v1"]' } });
  app.failSetItem(() => true);
  assert.throws(() => app.ctx.applySyncedState({ channels: [{ id: 'UCtheirs' }], done: [] }),
    'guard: the adopt must fail');
  assert.equal(app.get('focus_channels'), CH, 'channels untouched');
  assert.equal(app.get('focus_done'), '["v1"]', 'done untouched');
});

test('D (round 5) a boot re-pushing over corrupt storage raises no unhandled rejection', async () => {
  // syncOnLoad's dirty branch falls through to an UN-AWAITED pushNow() when local and the row
  // differ. collectSyncedState() JSON.parses raw localStorage and is read OUTSIDE _pushNow's try,
  // so on corrupt storage that promise rejects with nobody holding it. The BOOT survives either way
  // (criterion 11, pinned separately) — which is exactly why this went unnoticed; the rejection is
  // still real, and on Node an unhandled one is fatal.
  const { app } = mk({
    store: { focus_channels: '{{{ not json', focus_dirty: '1' },
    get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A },
  });
  await app.ctx.syncOnLoad();
  await settle();
  // Give a rejection time to surface: node --test fails the file on an unhandled one, so the
  // absence of that failure IS this test's primary assertion.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(app.get('focus_channels'), '{{{ not json', 'corrupt local data is left untouched');
  assert.equal(app.get('focus_dirty'), '1', 'and still declared un-pushed, so a later boot retries');
});

test('G9 (R15) a boot whose PULL fails records no base, and does not take the app down', async () => {
  // The ordering, as a guard rather than an accident. A rev written BEFORE the apply leaves this
  // client based on a row it does not hold — and its next push, declaring a base that still MATCHES,
  // is then ACCEPTED and overwrites the row with the state that failed to replace it. Review round 4
  // found the ordering completely unpinned: G6 could not see it, because when the apply succeeds
  // both orders end identically.
  const { app, puts } = mk({ get: { state: ROW, updatedAt: '2026-01-01T00:00:01.000Z', rev: REV_A, kind: 'device' } });
  app.failSetItem((k) => k === 'focus_done');   // mid-apply, so some keys have already been written
  await app.ctx.syncOnLoad();                    // criterion 11: this must not throw
  await settle();
  assert.equal(app.get('focus_rev'), null, 'a pull that failed is not a base');
  // And the consequence that makes it matter: with no base, the next push can create but never
  // overwrite — so the row survives a client that never managed to read it.
  app.failSetItem(null);
  puts.length = 0;
  await app.ctx.pushNow();
  assert.equal(puts.length, 1, 'guard: a push really did go out');
  assert.equal(puts[0].rev, null, 'and it declared no base, so the server can only refuse it');
});

// ── Round 8: the four guards round 5 found unpinned and re-measured as STILL unpinned ───────────
//
// Round 5 listed seven such rows plus a vacuous G5. Re-measured 2026-08-24 against the branch as it
// stands after rounds 6/7 (`mutations/BUG-047-R8-guards.mjs`), because recorded evidence ages: S8 is
// now pinned by round 7's own D test, and X1's row overstated — thirteen tests notice it, just not
// R18, the one written for it. These four survived, each control-verified RED below.

test('B5 (round 8) the namespace check covers the EMPTY-row branch, not just the populated one', async () => {
  // Fix B was wired in ABOVE the `updatedAt == null` branch and its ordering was the whole guard —
  // yet nothing could see the ordering. B1-B4 all use a POPULATED row and C15 boots an ANONYMOUS
  // client, so no fixture reached an empty row in the WRONG namespace. Moving the check below that
  // branch — the defect's real shape, a guard present but no longer covering — survived the suite.
  //
  // It matters because that branch does not merely decline: it LIFTS the halt and rearms the push.
  // A signed-in user handed an empty DEVICE row would rearm and write their curated account list
  // into the anonymous row — this task's own bug, arriving through the affordance built to fix it.
  const { app } = await haltedSignedIn();
  const before = app.get('focus_channels');
  answerAdoptWith(app, { state: null, updatedAt: null, rev: null, kind: 'device' });
  await pressAction(app);
  await settle();
  assert.ok(app.toasts.some((t) => /try again/i.test(t)),
    `an empty row from the wrong namespace is refused, not treated as "no saved copy"; toasts were ${JSON.stringify(app.toasts)}`);
  assert.ok(!app.toasts.some((t) => /no saved copy/i.test(t)), 'and specifically not down the lift-the-halt branch');
  assert.equal(app.get('focus_channels'), before, 'local is untouched either way');
  // The halt must still be in force. This is the assertion the mutation dies to: the empty-row
  // branch clears `_syncHalted` and rearms, so a push would no longer report a refusal.
  const after = await app.ctx.pushNow();
  assert.equal(after.refused, true, 'the halt stands — a refused push, not a rearmed one');
});

test('B6 (round 8) CONTROL: the same empty row in the RIGHT namespace does lift the halt', async () => {
  // Sized so only the namespace check separates this from B5. Without it, B5 passes just as well
  // against a client that refuses every empty row, which would break the honest vanished-row case.
  const { app } = await haltedSignedIn();
  answerAdoptWith(app, { state: null, updatedAt: null, rev: null, kind: 'account' });
  await pressAction(app);
  await settle();
  assert.ok(app.toasts.some((t) => /no saved copy/i.test(t)),
    `the honest vanished-row case must still say so; toasts were ${JSON.stringify(app.toasts)}`);
  assert.equal(app.get('focus_rev'), REV_A, 'and must NOT drop the base — that IS the overwrite state');
});

test('L5 (round 8) THREE racing pushes each declare the base the one before it confirmed', async () => {
  // The latch is a `while`, not an `if`, and C22/C23 cannot tell those apart: they race exactly TWO
  // pushes, and with two contenders both spellings serialise identically. It takes a THIRD. Under
  // `if`, pushes 2 and 3 both wake on push 1's promise and both read the base at that instant, so
  // two writes go out declaring the SAME base — the second stale by construction.
  const { app } = mk({ store: { focus_channels: MINE } });
  await app.ctx.syncOnLoad();
  await settle();

  // Each PUT parks until released and answers with a rev nobody has declared yet, so "which base did
  // this push declare" is readable off the wire and a base repeated across two pushes is visible.
  const seen = [];
  const gates = [];
  app.setFetch(async (url, init) => {
    const method = init?.method || 'GET';
    if (url.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (url.includes('/api/state') && method === 'PUT') {
      const n = seen.length + 1;
      seen.push(init.headers?.['X-State-Rev'] ?? null);
      await new Promise((r) => gates.push(r));
      return { ok: true, status: 200, json: async () => ({ updatedAt: `2026-01-01T00:00:0${n}.000Z`, rev: `REV-R8-${n}` }) };
    }
    if (url.includes('/api/state')) return { ok: true, status: 200, json: async () => ({ state: null, updatedAt: null, rev: null, kind: 'device' }) };
    throw new Error(`unrouted: ${url}`);
  });

  const racing = Promise.all([app.ctx.pushNow(), app.ctx.pushNow(), app.ctx.pushNow()]);
  for (let i = 0; i < 3; i++) {
    for (let spin = 0; gates.length <= i && spin < 50; spin++) await settle();
    assert.equal(gates.length, i + 1, `push ${i + 1} must be the ONLY one on the wire at this point`);
    gates[i]();
    await settle();
  }
  await racing;

  assert.equal(seen.length, 3, 'guard: all three really did reach the wire');
  assert.equal(new Set(seen).size, 3,
    `no two pushes may declare the same base — the second would be stale. Bases were ${JSON.stringify(seen)}`);
});

test('K3 (round 8) a throw on the LAST key rolls back the ones CS1 never reaches', async () => {
  // "ALL SIX KEYS OR NONE" was pinned for two of six. CS1 fails on the THIRD key, so theme, shorts
  // and groups are never written before the throw and their rollback never runs — dropping them from
  // the rollback set entirely was a fully green mutation. Failing on the SIXTH key is what puts them
  // on the path: all five earlier keys are written, and every one must go back.
  const { app } = await haltedSignedIn({ store: { focus_channels: MINE, focus_theme: 'light', focus_include_shorts: 'false' } });
  const before = { theme: app.get('focus_theme'), shorts: app.get('focus_include_shorts'), channels: app.get('focus_channels') };
  answerAdoptWith(app, {
    state: {
      channels: [{ id: 'UCsaved', name: 'Saved', source: 'youtube' }], done: ['d1'], archive: [{ id: 'a1' }],
      theme: 'dark', shorts: 'true', groups: { t: ['x'] },
    },
    updatedAt: '2026-01-01T00:00:05.000Z', rev: REV_B, kind: 'account',
  });
  app.failSetItem((k) => k === 'focus_groups');   // the SIXTH and last key
  await pressAction(app);
  await settle();
  assert.equal(app.get('focus_theme'), before.theme, 'theme is written fourth and must be rolled back');
  assert.equal(app.get('focus_include_shorts'), before.shorts, 'shorts is written fifth and must be rolled back');
  assert.equal(app.get('focus_channels'), before.channels, 'and the earlier keys still roll back too');
  assert.equal(app.get('focus_rev'), REV_A, 'nothing landed, so nothing may re-base');
});

test('K4 (round 8) the rollback puts the THEME ATTRIBUTE back, not just the stored key', async () => {
  // The adopt repaints the page as well as writing the key. Deleting the attribute half of the
  // rollback survived the whole suite: local would report `light` while the page kept painting the
  // `dark` it had adopted and then abandoned — the visible half of a state neither side ever held.
  const { app } = await haltedSignedIn({ store: { focus_channels: MINE, focus_theme: 'light', focus_include_shorts: 'false' } });
  const html = app.ctx.document.documentElement;
  html.setAttribute('data-theme', 'light');
  answerAdoptWith(app, {
    state: {
      channels: [{ id: 'UCsaved', name: 'Saved', source: 'youtube' }], done: ['d1'], archive: [{ id: 'a1' }],
      theme: 'dark', shorts: 'true', groups: { t: ['x'] },
    },
    updatedAt: '2026-01-01T00:00:05.000Z', rev: REV_B, kind: 'account',
  });
  app.failSetItem((k) => k === 'focus_groups');   // fails AFTER the repaint has happened
  await pressAction(app);
  await settle();
  assert.equal(html.getAttribute('data-theme'), 'light',
    'the page must not keep painting a theme the rollback threw away');
  assert.equal(app.get('focus_theme'), 'light', 'guard: and the stored key agrees with it');
});
