// The sign-in wall and its measurement.
//
// Removing "Continue without an account" makes the landing the only way into the app. That is a
// product bet with no data behind it: we have never measured what share of visitors who see the
// welcome screen actually sign in, and once the skip is gone there is no unwalled population left
// to measure against. `landing_view` is the denominator of the one rate that can still be
// collected — saw the wall / got through it — so if it silently stops firing, the DAU drop this
// change is expected to cause becomes indistinguishable from real users bouncing off a wall.
//
// These boot the REAL app.js through test-helpers/app-harness.mjs. Note that the harness needs
// AbortController in its vm context to reach init() at all: syncOnLoad and
// checkAuth each build one on the first line of a try whose catch swallows everything, so without it both boot
// fetches die as "offline" and init() completes having issued zero requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../test-helpers/app-harness.mjs';
import { createStateHandler } from '../api/state.js';
import { fakeDb, fakeReq, fakeRes } from '../test-helpers/handler.mjs';

/** Boot the app with a working server, signed in or out. Anything unrouted throws. */
function bootWith({ signedIn, store = {}, search = '' } = {}) {
  const app = createApp({ store, search });
  app.setFetch(async (url, init) => {
    const method = init.method || 'GET';
    if (url.includes('/api/auth/me')) {
      return signedIn
        ? { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) }
        : { ok: false, status: 401, json: async () => ({}) };
    }
    if (url.includes('/api/state') && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ state: null, updatedAt: null }) };
    }
    if (url.includes('/api/state')) return { ok: true, status: 200, json: async () => ({ updatedAt: 1 }) };
    // Routed because the wiring tests assert on whether these fire AT ALL — see the wiring gate below.
    if (url.includes('/api/resolve-channel')) {
      return { ok: true, status: 200, json: async () => ({ name: 'Real Channel Name', avatarUrl: null }) };
    }
    if (url.includes('/api/connect/youtube/result')) {
      return { ok: true, status: 200, json: async () => ({ channels: [{ channelId: 'UCabc', name: 'Imported', avatarUrl: null }], truncated: false }) };
    }
    throw new Error(`unrouted request: ${url}`);
  });
  return app;
}

const bufferedNames = (app) => JSON.parse(app.get('focus_events') || '[]').map((e) => e.name);

// A channel whose NAME is still a raw UC id is what migrateChannelNames (app.js:2571) treats as
// broken, so seeding one makes the boot issue a /api/resolve-channel request we can observe.
const STALE_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const STALE_CHANNEL = JSON.stringify([{ id: STALE_ID, name: STALE_ID, keyword: '', source: 'youtube' }]);

test('a signed-out boot records exactly one landing_view', async () => {
  const app = bootWith({ signedIn: false });

  await app.ctx.init();

  const names = bufferedNames(app);
  assert.equal(names.filter((n) => n === 'landing_view').length, 1,
    `expected exactly one landing_view, got ${JSON.stringify(names)}`);
});

test('the landing_view actually reaches the server, not just localStorage', async () => {
  // An event that never leaves the browser measures nothing. This is the half that would have
  // shipped broken: the server drops any name outside EVENT_NAMES (api/_events.js) silently, so a
  // store-only assertion passes while the metric stays empty forever.
  const app = bootWith({ signedIn: false });

  await app.ctx.init();
  app.runTimers(4);                                  // drain track()'s 3s flush
  await new Promise((r) => setImmediate(r));

  const put = app.requests.find((r) => r.url.includes('/api/state') && (r.init.method || 'GET') === 'PUT');
  assert.ok(put, 'no PUT was issued, so no event could have been delivered');
  const sent = JSON.parse(put.init.body).events || [];
  assert.ok(sent.some((e) => e.name === 'landing_view'), 'landing_view was not in the PUT body');
  assert.equal(sent.find((e) => e.name === 'landing_view').section, 'landing');
});

test('landing_view survives the SERVER, not just the request body', async () => {
  // The test above proves the event leaves the browser. This proves it is still there after the
  // server has had it — the half that fails SILENTLY. normalizeEvent bins any name outside
  // EVENT_NAMES (api/_events.js), so deleting one line in that allowlist leaves the client emitting
  // it, the PUT carrying it, and the metric permanently empty, with every other test green.
  //
  // Cross-seam on purpose: the real boot's real body, handed to the real handler. A test that
  // asserted `EVENT_NAMES.has('landing_view')` would pass on a client that stopped emitting it.
  const app = bootWith({ signedIn: false });
  await app.ctx.init();
  app.runTimers(4);
  await new Promise((r) => setImmediate(r));

  const put = app.requests.find((r) => r.url.includes('/api/state') && (r.init.method || 'GET') === 'PUT');
  assert.ok(put, 'no PUT was issued, so nothing could be delivered');

  const sql = fakeDb();
  const handler = createStateHandler({ db: () => sql, sessionAccount: async () => null });
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': app.get('focus_device_id') },
    body: put.init.body,
  }), res);

  assert.equal(res.statusCode, 200, `the server rejected the boot ping: ${JSON.stringify(res.body)}`);
  const batch = sql.events.find((e) => e.batch);
  assert.ok(batch, 'the server ingested nothing at all');
  const stored = JSON.parse(batch.batch).map((e) => e.name);
  assert.ok(stored.includes('landing_view'),
    `the server dropped landing_view, so the wall's denominator is blind — stored ${JSON.stringify(stored)}`);
});

test('a signed-in boot records no landing_view — it never sees the wall', async () => {
  const app = bootWith({ signedIn: true });

  await app.ctx.init();

  assert.ok(!bufferedNames(app).includes('landing_view'),
    'a signed-in visitor is not shown the wall, so it must not be counted as having met it');
});

// ── No `?auth=` value may get an unauthenticated visitor past the wall ────────
// Found in live verification, not by a test: clicking a magic link twice (the second click gets
// `?auth=invalid`) showed "That sign-in link expired" AND dropped the visitor on the add-channel
// page, signed out — Settings read "anonymous". The boot guard was `!authParam && …`, and every
// `?auth=` value is truthy, so a FAILED sign-in skipped the wall.
//
// `ok` is tested too, and it is the more dangerous one: exempting it would have been the obvious
// narrow fix, and anyone can type /app?auth=ok in the address bar. The gate is the session, never
// the URL.

for (const value of ['invalid', 'ok', 'google_failed', 'google_unavailable']) {
  test(`?auth=${value} with no session still shows the wall`, async () => {
    const app = bootWith({ signedIn: false, search: `?auth=${value}` });

    await app.ctx.init();

    assert.equal(bufferedNames(app).filter((n) => n === 'landing_view').length, 1,
      `?auth=${value} let an unauthenticated visitor past the sign-in wall`);
    assert.deepEqual(app.visibleViews(), ['view-landing'],
      `?auth=${value} painted an app screen for an unauthenticated visitor`);
    assert.equal(app.get('focus_include_shorts'), null,
      `?auth=${value} wired the app for an unauthenticated visitor`);

    // The strip is pinned HERE, across all four values, because it is unconditional and precedes
    // every branch. Pinning it only on the `ok` path would leave moving it inside
    // `if (a === 'ok')` a fully green mutation, with the other three values re-toasting on every
    // reload forever.
    assert.ok(!app.ctx.location.search.includes('auth'),
      `?auth=${value} survived the landing, so every reload re-toasts: ${app.ctx.location.search}`);
  });
}

test('the expired-link toast action does not route a signed-out visitor into the app', async () => {
  // The wall's own error path, and the last route past it. "That sign-in link expired → Send a new
  // one" calling showView('view-setup') + initSetup() + openProfile() unconditionally would be
  // deliberate routing INTO the app — a bypass of the only gate.
  // The `!_authEmail` early return closes it, and the ?auth= tests above cannot see that guard:
  // they assert on the BOOT, and never invoke the
  // toast's callback.
  const app = bootWith({ signedIn: false, search: '?auth=invalid' });
  await app.ctx.init();

  const action = app.el('toast').querySelector('.toast-action');
  assert.equal(typeof action.onclick, 'function',
    'guard: the toast action was never wired, so this test proves nothing');

  action.onclick();

  assert.deepEqual(app.visibleViews(), ['view-landing'],
    'the expired-link toast walked a signed-out visitor into the app');
  assert.equal(app.get('focus_last_view'), null,
    'the expired-link toast recorded an app view for a signed-out visitor');
  assert.ok(app.el('landing-email').focused,
    'the toast should put the cursor in the wall\'s own email field — it IS the send-a-new-one form');
});

test('a real signed-in auth landing is NOT walled', async () => {
  // The other direction: the guard existed to stop the landing overriding the sign-in toast, so
  // removing it must not wall someone whose session actually resolved.
  const app = bootWith({ signedIn: true, search: '?auth=ok' });

  await app.ctx.init();

  assert.ok(!bufferedNames(app).includes('landing_view'),
    'a completed sign-in was sent back to the wall');
});

test('a signed-out visitor who dismissed the OLD skip still meets the wall', async () => {
  // The upgrade path for every existing anonymous user: they carry SK.landing = 'true' from
  // the old permanent per-device dismissal. If landingSeen still suppressed the landing they
  // would be locked out of signing in entirely, and would never be counted.
  const app = bootWith({ signedIn: false, store: { focus_landing_seen: 'true' } });

  await app.ctx.init();

  assert.equal(bufferedNames(app).filter((n) => n === 'landing_view').length, 1,
    'a previously-dismissed browser must still be walled, and still counted');
});

// ── The app is not WIRED until a session resolves ─────────────────────────────
// A wall that only HIDES the app is not a gate: with every handler wired on every boot and
// the drawer hidden by `transform`, four Tab presses from the landing reach
// #btn-drawer-manage and its listener calls showView('view-setup') with no session check.
// Gating which view is
// VISIBLE would leave the wall resting on CSS being correct (`display:none` leaves the tab order,
// `transform` does not).
//
// So init() wires nothing until _authEmail resolves. These tests come in PAIRS, because
// absence-only assertions are worthless here:
// mutating showView to `return;` — an app that renders nothing, ever — would leave them fully green.
// Every "the gate blocks it" test is therefore paired with a "the gate does not over-block it" one.
//
// The harness cannot see addEventListener, focus or the tab order — but it CAN see wireApp(),
// because wireApp's Shorts block writes SK.shorts on load (app.js, setShorts(...) at init time).
// So `focus_include_shorts` is a direct trace of the wiring having run, and it is the assertion
// that matters here.
//
// Asserting only /api/resolve-channel is not enough: it is issued by migrateChannelNames,
// a SIBLING statement inside the same `if (_authEmail)` block. That asserts the block ran, never
// that wireApp did. Moving wireApp() above the gate (all 14 drawer controls live behind the wall)
// would leave such a suite green. The request
// assertion is kept because it pins migrateChannelNames independently; the store assertion is what
// pins the wiring.

test('a signed-out boot wires nothing — the app is not built behind the wall', async () => {
  const app = bootWith({ signedIn: false, store: { focus_channels: STALE_CHANNEL } });

  await app.ctx.init();

  assert.equal(app.get('focus_include_shorts'), null,
    'wireApp() ran behind the sign-in wall: the Shorts control initialised, so every drawer, feed and import handler is live for an anonymous visitor');
  assert.ok(!app.urls().some((u) => u.includes('/api/resolve-channel')),
    `a walled visitor ran the app's boot work: ${JSON.stringify(app.urls())}`);

  // The two assertions above are both traces of ONE statement each — the Shorts block, and
  // migrateChannelNames (a sibling of the gate, not part of wireApp at all). Neither says anything
  // about the controls that actually matter, so hoisting wireDrawer() out of the gate —
  // with sign-out, export, delete and manage-channels live
  // behind the wall — would otherwise go unnoticed. The design argument for this gate is that it
  // is ALL-or-nothing; that is what this asserts.
  for (const id of ['acct-signout', 'acct-export', 'acct-delete-open', 'btn-drawer-manage', 'profile-btn']) {
    assert.equal(app.el(id).listeners.length, 0,
      `${id} was wired for a signed-out visitor — wireApp() is not all-or-nothing`);
  }
});

test('a signed-in boot DOES wire the app — the gate does not over-block', async () => {
  // Positive control. Without the store assertion, dropping wireApp() altogether passes — a
  // signed-in user gets a correctly rendered app in which nothing responds to a click.
  const app = bootWith({
    signedIn: true,
    store: { focus_channels: STALE_CHANNEL, focus_last_view: 'setup' },
  });

  await app.ctx.init();

  assert.equal(app.get('focus_include_shorts'), 'true',
    'wireApp() never ran for a signed-in user — the app rendered with no controls wired');
  assert.ok(app.urls().some((u) => u.includes('/api/resolve-channel')),
    `a signed-in boot skipped the app's boot work: ${JSON.stringify(app.urls())}`);

  // The other half of all-or-nothing: deleting wireDrawer() from wireApp() leaves the Settings
  // drawer dead for everyone, and the request assertion alone would stay green.
  for (const id of ['acct-signout', 'acct-export', 'acct-delete-open', 'btn-drawer-manage', 'profile-btn']) {
    assert.ok(app.el(id).listeners.length > 0,
      `${id} was never wired for a signed-in user — the control is dead`);
  }
});

test('a signed-out boot ends with the WALL on screen, not a blank page', async () => {
  // An analytics counter does not
  // check that the visitor can actually see the sign-in screen. Deleting showView's call
  // inside showLandingView() gives every signed-out visitor a blank page — landing_view still
  // fires, so the counter tests stay green. Readable because the harness memoises
  // elements.
  const app = bootWith({ signedIn: false });

  await app.ctx.init();

  assert.deepEqual(app.visibleViews(), ['view-landing'],
    'a signed-out boot did not leave the sign-in wall visible');
});

test('a signed-in boot ends inside the app, not on the wall', async () => {
  // Positive control for the test above: it must be possible to fail by showing the wall too much.
  const app = bootWith({ signedIn: true });

  await app.ctx.init();

  assert.deepEqual(app.visibleViews(), ['view-setup'],
    'a signed-in visitor with no channels should land on setup');
});

test('showView refuses a non-landing target while signed out', async () => {
  // Second layer behind the wiring gate. Even reached directly, a transition into the app while
  // signed out must not happen — showView coerces to the wall, which writes no lastView and fires
  // no `view` event (neither map in showView has a 'view-landing' key).
  const app = bootWith({ signedIn: false });
  await app.ctx.init();

  app.ctx.showView('view-setup');

  // What is ON SCREEN, asserted first and on purpose. The two assertions below it are side effects
  // written AFTER the DOM is updated, and the coercion suppresses both from wherever it sits — so
  // MOVING it below the render (the "present but ineffective" shape, not the "deleted" one) would paint
  // view-setup for a signed-out visitor with those two still green.
  assert.deepEqual(app.visibleViews(), ['view-landing'],
    'showView painted an app screen for a signed-out visitor');
  assert.equal(app.get('focus_last_view'), null,
    'showView let a signed-out visitor into the app');
  assert.ok(!bufferedNames(app).includes('view'),
    'a signed-out visitor recorded a view of an app screen');
});

test('showView still works for a signed-in visitor — the gate does not over-block', async () => {
  // Positive control. Without this, `function showView(id) { return; }` — an app that renders
  // nothing at all — passes the test above and the whole suite.
  const app = bootWith({ signedIn: true });

  await app.ctx.init();

  assert.equal(app.get('focus_last_view'), 'setup',
    'a signed-in boot with no channels must land on setup');
  assert.ok(bufferedNames(app).includes('view'),
    'a signed-in boot recorded no view event, so showView did nothing');
});

test('?import=youtube does not run the import flow behind the wall', async () => {
  // handleImportLanding() sits OUTSIDE the boot if/else (app.js:2722), so it ran on the landing
  // branch too — and the import modal is an overlay, not a .view, so showView never hides it. A
  // signed-out visitor returning from Google consent got the picker painted over the wall, and
  // confirmImport writes channels + schedules a push.
  const app = bootWith({ signedIn: false, search: '?import=youtube' });

  await app.ctx.init();

  assert.ok(!app.urls().some((u) => u.includes('/api/connect/youtube/result')),
    `the import flow ran for a walled visitor: ${JSON.stringify(app.urls())}`);
});

test('a signed-in ?import=youtube still runs — the gate does not over-block', async () => {
  // Positive control. Without this, an unconditional `return` in handleImportLanding passes.
  const app = bootWith({ signedIn: true, search: '?import=youtube' });

  await app.ctx.init();

  assert.ok(app.urls().some((u) => u.includes('/api/connect/youtube/result')),
    `a signed-in import was dropped: ${JSON.stringify(app.urls())}`);
});

// ── The wall must not claim you are signed in ────────────────────────────────
// handleAuthLanding() (app.js) reads only the URL, so /app?auth=ok toasted "Signed in" and the boot
// then rendered the sign-in wall underneath it. No access leaked — the gate is correct — the app
// simply told the visitor the opposite of what it was showing them.
//
// Two indistinguishable people reach the wall carrying `?auth=ok`: someone opening a stale, shared
// or hand-typed link, and someone whose sign-in really did succeed but whose
// /api/auth/me missed the 2.5s abort. So the copy states only what is observable — you are not
// signed in — and the retry exists for the second. (Rationale lives in app.js; not restated here,
// because the version that WAS restated here drifted into claiming a typed URL was impossible.)

const CONFIRMATION = 'Signed in';
const NOT_SIGNED_IN = /you.re not signed in/i;

test('?auth=ok with no session does not claim the visitor is signed in', async () => {
  const app = bootWith({ signedIn: false, search: '?auth=ok' });

  await app.ctx.init();

  assert.ok(app.toasts.length,
    'guard: no toast was recorded at all, so the absence below means nothing');
  assert.ok(!app.toasts.includes(CONFIRMATION),
    `the sign-in wall told a signed-out visitor they were signed in: ${JSON.stringify(app.toasts)}`);
});

test('?auth=ok with no session says what is actually observable, and shows it', async () => {
  // The paired half. "No 'Signed in'" is satisfied by deleting the branch outright, which leaves the
  // visitor on a bare wall with no account of why the link they clicked did nothing.
  const app = bootWith({ signedIn: false, search: '?auth=ok' });

  await app.ctx.init();

  assert.ok(app.toasts.some((t) => NOT_SIGNED_IN.test(t)),
    `a failed sign-in left the visitor with no explanation: ${JSON.stringify(app.toasts)}`);

  // DISPLAYED, not merely composed. `toasts` is fed by the .toast-msg write, which is the FIRST
  // thing showToast does — so without these two, deleting `classList.add('show')` leaves the whole
  // suite green while the visitor sees nothing, and hiding the action button leaves the remedy
  // unreachable while the test still calls onclick() directly.
  assert.ok(app.el('toast').classList.contains('show'),
    'the message was composed but never displayed — the visitor sees a bare wall');
  assert.ok(!app.el('toast').querySelector('.toast-action').classList.contains('hidden'),
    'the retry button was never revealed, so the remedy is unreachable');
});

test('?auth=ok WITH a session still confirms the sign-in, and shows it', async () => {
  // Positive control — the fix must not just delete the toast. Doubles as the proof that `toasts` is
  // populated at all: while it was a dead field this assertion could not pass.
  const app = bootWith({ signedIn: true, search: '?auth=ok' });

  await app.ctx.init();

  assert.ok(app.toasts.includes(CONFIRMATION),
    `a completed sign-in was not confirmed to the user: ${JSON.stringify(app.toasts)}`);
  assert.ok(app.el('toast').classList.contains('show'),
    'the confirmation was composed but never displayed');
});

test('the retry reloads and opens no app surface', async () => {
  const app = bootWith({ signedIn: false, search: '?auth=ok' });
  await app.ctx.init();

  const action = app.el('toast').querySelector('.toast-action');
  assert.equal(typeof action.onclick, 'function',
    'guard: the retry was never wired, so this test proves nothing');

  action.onclick();

  assert.ok(app.navigations.includes('reload'),
    `the retry did not reload, so it remedies nothing: ${JSON.stringify(app.navigations)}`);

  // This test used to assert visibleViews() and focus_last_view. Neither could fail: showView
  // coerces to the wall while signed out, and view-landing is in neither of its maps, so both were
  // already true BEFORE the click. Giving the callback the shape that lives 15 lines below it in
  // app.js — showView('view-setup'); initSetup(); openProfile() — would stay green while
  // the Settings drawer opened over the wall for a signed-out visitor.
  // These assert on state the callback can actually reach.
  assert.ok(!app.el('profile-panel').classList.contains('open'),
    'the retry opened the Settings drawer over the wall for a signed-out visitor');
  assert.ok(!app.el('profile-scrim').classList.contains('show'),
    'the retry raised the drawer scrim for a signed-out visitor');
  for (const id of ['acct-signout', 'acct-export', 'acct-delete-open', 'btn-drawer-manage', 'btn-add']) {
    assert.equal(app.el(id).listeners.length, 0,
      `${id} was wired by the retry — a signed-out visitor got a working app control`);
  }
});

test('a failed ?auth=ok strips the param, so the retry lands on a plain wall', async () => {
  // Why it matters HERE: the strip is what bounds the retry to one attempt. The strip itself is
  // pinned for all four values in the loop at the top of this section — this test alone cannot
  // pin it, because moving the strip inside `if (a === 'ok')` leaves every
  // other value unstripped while this stays green.
  const app = bootWith({ signedIn: false, search: '?auth=ok' });

  await app.ctx.init();

  assert.ok(!app.ctx.location.search.includes('auth'),
    `?auth= survived the landing, so a reload re-toasts: ${app.ctx.location.search}`);
});

test('the three failure values still explain themselves on the wall', async () => {
  // These messages
  // are CORRECT on the wall — they say why it is there — so a fix that silenced the toast wholesale
  // would be wrong in the opposite direction.
  //
  // The two Google expectations must be DISTINCT. With both as /google/i, swapping the two message
  // bodies would stay green — and google_unavailable (GOOGLE_CLIENT_ID unset) would then tell
  // the user "please try again", a remedy that cannot work.
  for (const [value, expected] of [
    ['invalid', /link expired/i],
    ['google_failed', /didn.t work/i],
    ['google_unavailable', /isn.t available/i],
  ]) {
    const app = bootWith({ signedIn: false, search: `?auth=${value}` });
    await app.ctx.init();

    assert.ok(app.toasts.some((t) => expected.test(t)),
      `?auth=${value} left a signed-out visitor with no explanation: ${JSON.stringify(app.toasts)}`);
  }
});

test('the Settings drawer is hidden with visibility, not transform alone', async () => {
  // A source-text assertion, and deliberately so: the harness has no focus, no tab order and no
  // stylesheet, so nothing else in this suite can tell that the drawer left the tab order. Losing
  // `visibility: hidden` is what put 14 focusable controls behind the sign-in wall, and it would
  // come back silently — the views would still look right in every screenshot.
  //
  // Both halves are asserted. Pinning only the base rule passes a half-edit that leaves the drawer
  // permanently invisible even when opened, which is the failure this fix could plausibly cause.
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const base = css.match(/\.profile-panel \{[^}]*\}/);
  const open = css.match(/\.profile-panel\.open \{[^}]*\}/);

  assert.ok(base && /visibility:\s*hidden/.test(base[0]),
    'the closed drawer is focusable again — `transform` alone leaves it in the tab order');
  assert.ok(open && /visibility:\s*visible/.test(open[0]),
    'the drawer can no longer be shown');
});
