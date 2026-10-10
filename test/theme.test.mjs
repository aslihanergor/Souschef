// Light by default; the sign-in page always light.
//
// Two places decide the colour, and only a browser runs both:
//   1. the inline <head> script in app/index.html, which paints before anything is known — no session,
//      no row. It is NOT run by the app harness (that evaluates app.js only), so part H below runs it
//      straight from app/index.html in node:vm, extracted with the same anchor scripts/csp-hash.mjs uses.
//   2. showView, which knows the screen it is showing: the sign-in wall is always light, every other
//      screen shows the stored choice, else light. Part A drives the real app.js through the harness,
//      with the colour the head script WOULD have painted preset on <html> before the boot.
//
// Part C pins the CSP hash. Nothing did before this file: test/public-landing.test.mjs checks that `/`
// has no inline script and that 'unsafe-inline' stays out, never that vercel.json allows THIS script.
// A stale hash passes every other test and blocks the script in production, where the only symptom is
// the first frame painting light for someone who chose Dark.
//
// Nothing here may change what is STORED: the theme is a synced preference kept on sign-out
// (EXIT_DISPOSITION.theme = 'keep'), and this is about what is painted, never about the choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import * as pure from '../lib/pure.js';
import { createApp } from '../test-helpers/app-harness.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// ── H: the head script, run from disk ─────────────────────────────────────────────────────────────

// The same match scripts/csp-hash.mjs makes, so the text run here is the text the browser hashes.
const HEAD = read('app/index.html').match(/<script>([\s\S]*?Resolve theme[\s\S]*?)<\/script>/);

/** Run the head script against a fake page. `osDark` is what `prefers-color-scheme: dark` answers. */
function runHead({ store = {}, osDark = true, storageThrows = false } = {}) {
  const attrs = new Map();
  const localStorage = {
    getItem: (k) => {
      if (storageThrows) { const e = new Error('SecurityError'); e.name = 'SecurityError'; throw e; }
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
  };
  const ctx = {
    localStorage,
    matchMedia: (q) => ({ matches: osDark && /prefers-color-scheme:\s*dark/.test(q) }),
    document: { documentElement: {
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
    } },
  };
  vm.runInNewContext(HEAD[1], ctx);
  return attrs.has('data-theme') ? attrs.get('data-theme') : null;
}

test('H0 guard: the head script is found by the anchor csp-hash.mjs uses', () => {
  assert.ok(HEAD, 'no <script> containing "Resolve theme" in app/index.html — every H test would be vacuous');
  assert.match(HEAD[1], /data-theme/, 'the matched script does not set data-theme, so it is not the theme script');
});

test('H1: nothing stored paints light, even when the phone is in dark mode (criterion 1)', () => {
  assert.equal(runHead({ osDark: true }), 'light');
});

test('H2a guard: a stored Dark on a browser that was signed in last time paints dark (criterion 2)', () => {
  assert.equal(runHead({ store: { focus_theme: 'dark', focus_was_authed: '1' }, osDark: false }), 'dark');
});

test('H2b: a stored Dark on a browser that was NOT signed in last time paints light (criterion 2)', () => {
  // The sign-in wall's first frame: the likeliest screen on this browser is the wall, which is always light.
  assert.equal(runHead({ store: { focus_theme: 'dark' }, osDark: true }), 'light');
});

test('H2c: a stored value that is neither light nor dark paints light (criterion 2)', () => {
  assert.equal(runHead({ store: { focus_theme: 'purple', focus_was_authed: '1' }, osDark: true }), 'light');
});

test('H2d: storage that throws still paints light — set, not left unset (criterion 2)', () => {
  // Unset is NOT equivalent: style.css only has a data-theme="dark" block today, but "unset follows the
  // phone" is one media query away, and the requirement is light.
  assert.equal(runHead({ storageThrows: true, osDark: true }), 'light');
});

test('H2e guard: a stored Light paints light whatever the phone says (criterion 2)', () => {
  assert.equal(runHead({ store: { focus_theme: 'light', focus_was_authed: '1' }, osDark: true }), 'light');
});

// ── P: the rule showView applies ──────────────────────────────────────────────────────────────────

test('P1: themeForView — the sign-in wall is light whatever is stored', () => {
  assert.equal(typeof pure.themeForView, 'function', 'lib/pure.js exports no themeForView');
  assert.equal(pure.themeForView('view-landing', 'dark'), 'light');
  assert.equal(pure.themeForView('view-landing', 'light'), 'light');
});

test('P2: themeForView — other screens show the stored choice, else light', () => {
  assert.equal(typeof pure.themeForView, 'function', 'lib/pure.js exports no themeForView');
  assert.equal(pure.themeForView('view-feed', 'dark'), 'dark');
  assert.equal(pure.themeForView('view-setup', 'dark'), 'dark');
  assert.equal(pure.themeForView('view-archive', 'light'), 'light');
  for (const junk of [null, undefined, '', 'purple', 'Dark', ' dark']) {
    assert.equal(pure.themeForView('view-feed', junk), 'light', `stored ${JSON.stringify(junk)} must read as light`);
  }
});

// ── A: the real app ───────────────────────────────────────────────────────────────────────────────

const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const settle = () => new Promise((r) => setImmediate(r));
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

/** An app over `store`. `signedIn` decides /api/auth/me; `row` is the account row's state (null = none). */
function rig({ store = {}, signedIn = true, row = null } = {}) {
  const app = createApp({ store: { focus_device_id: DEVICE_ID, ...store } });
  app.setFetch(async (url, init = {}) => {
    const method = init.method || 'GET';
    if (url.includes('/api/auth/me')) {
      return signedIn ? ok({ email: 'reader@example.com' }) : { ok: false, status: 401, json: async () => ({}) };
    }
    if (url.includes('/api/state') && method === 'PUT') {
      const parsed = JSON.parse(init.body) || {};
      return ok(parsed.state === undefined
        ? { updatedAt: null, rev: null }
        : { updatedAt: '2026-09-26T09:00:00.000Z', rev: '2026-09-26T09:00:00.000000' });
    }
    if (url.includes('/api/state')) {
      return ok(row
        ? { state: row, updatedAt: '2026-09-26T08:00:00.000Z', rev: 'r1', kind: 'account' }
        : { state: null, updatedAt: null, kind: signedIn ? 'account' : 'device' });
    }
    if (url.includes('/api/feed')) return ok({ items: [] });
    if (url.includes('/api/group')) return ok({ groups: null });
    throw new Error(`unrouted request: ${url}`);
  });
  return app;
}
async function drain(app) { for (let i = 0; i < 6; i++) { app.runTimers(4); await settle(); } }
/** Boot, with `paint` preset on <html> — what the head script would have set before app.js ran. */
async function boot(app, paint) {
  if (paint) app.ctx.document.documentElement.setAttribute('data-theme', paint);
  await app.ctx.init();
  await drain(app);
}
const painted = (app) => app.ctx.document.documentElement.getAttribute('data-theme');
const lit = (app, t) => app.themeOpt(t).classList.contains('is-active');
const views = (app) => app.visibleViews().join(',');

test('A3: the sign-in wall is light when Dark is stored and the first paint was dark (criteria 3, 6)', async () => {
  // The first boot after a sign-out: focus_was_authed is still '1', so the head script painted Dark.
  const app = rig({ store: { focus_theme: 'dark', focus_was_authed: '1' }, signedIn: false });
  await boot(app, 'dark');
  assert.equal(views(app), 'view-landing', 'guard: the boot did not end on the sign-in wall');
  assert.equal(painted(app), 'light');
  assert.equal(app.get('focus_theme'), 'dark', 'the stored choice must not be touched');
});

test('A4: a signed-in boot shows the stored Dark with Dark highlighted, even after a light first paint (criteria 4, 6)', async () => {
  // The first boot after signing back in: focus_was_authed was removed by the walled boot, so the head
  // script painted light. The row carries no theme, so nothing from the sync repaints it either.
  const app = rig({ store: { focus_theme: 'dark' }, signedIn: true });
  await boot(app, 'light');
  assert.notEqual(views(app), 'view-landing', 'guard: a signed-in boot ended on the sign-in wall');
  assert.equal(views(app).split(',').length, 1, 'guard: exactly one view is showing');
  assert.equal(painted(app), 'dark');
  assert.equal(lit(app, 'dark'), true, 'the Dark button must be highlighted');
  assert.equal(lit(app, 'light'), false, 'the Light button must not be highlighted');
  assert.equal(app.get('focus_theme'), 'dark', 'the stored choice must not be touched');
});

test('A5: a signed-in boot with nothing stored is light with Light highlighted, even after a dark first paint (criteria 5, 6)', async () => {
  // Today's head script paints the phone's dark mode here; nothing afterwards corrects it.
  const app = rig({ store: {}, signedIn: true });
  await boot(app, 'dark');
  assert.notEqual(views(app), 'view-landing', 'guard: a signed-in boot ended on the sign-in wall');
  assert.equal(painted(app), 'light');
  assert.equal(lit(app, 'light'), true, 'the Light button must be highlighted');
  assert.equal(lit(app, 'dark'), false, 'the Dark button must not be highlighted');
  assert.equal(app.get('focus_theme'), null, 'nothing may be written for a reader who never chose');
});

test('A6 guard: a row carrying Dark is applied and the toggle agrees', async () => {
  const app = rig({ store: {}, signedIn: true, row: { channels: [], done: [], archive: [], theme: 'dark' } });
  await boot(app, 'light');
  assert.equal(app.get('focus_theme'), 'dark', 'guard: the row was not pulled down');
  assert.equal(painted(app), 'dark');
  assert.equal(lit(app, 'dark'), true);
});

test('A7 guard: after a tap on Light, a later view change stays light', async () => {
  const app = rig({ store: { focus_theme: 'dark', focus_was_authed: '1' }, signedIn: true });
  await boot(app, 'dark');
  assert.equal(app.click(app.themeOpt('light')), 1, 'guard: the Light button was never wired');
  assert.equal(app.get('focus_theme'), 'light', 'guard: the tap did not store Light');
  app.ctx.showView('view-archive');
  assert.equal(painted(app), 'light');
  assert.equal(lit(app, 'light'), true);
});

test('A8: showView survives a storage that throws on the theme read, and falls back to light (risk 3)', async () => {
  // showView is the path that decides whether the app is reachable at all; a throw from a
  // colour read would leave no screen showing.
  const app = rig({ store: { focus_theme: 'dark', focus_was_authed: '1' }, signedIn: true });
  await boot(app, 'dark');
  app.failGetItem((k) => k === 'focus_theme');
  assert.doesNotThrow(() => app.ctx.showView('view-setup'));
  assert.equal(views(app), 'view-setup', 'the requested view must still show');
  assert.equal(painted(app), 'light');
});

// ── C: the CSP hash ───────────────────────────────────────────────────────────────────────────────

test('C1: vercel.json allows exactly this head script by its sha256 (criterion 7)', () => {
  assert.ok(HEAD, 'guard: the head script was not found');
  const hash = 'sha256-' + crypto.createHash('sha256').update(HEAD[1], 'utf8').digest('base64');
  const csp = JSON.parse(read('vercel.json')).headers.flatMap((h) => h.headers)
    .filter((h) => h.key === 'Content-Security-Policy');
  assert.ok(csp.length > 0, 'guard: no Content-Security-Policy header in vercel.json');
  for (const h of csp) {
    const scriptSrc = h.value.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    assert.ok(scriptSrc, 'guard: a CSP header has no script-src');
    assert.ok(scriptSrc.includes(`'${hash}'`),
      `vercel.json's script-src does not allow the head script as it stands (${hash}). The browser will block ` +
      `it and paint the first frame without it. Run node scripts/csp-hash.mjs and paste the result.\n  ${scriptSrc}`);
  }
});

test('A9: a signed-out call for any screen is coerced to the wall, and the wall is still light (criterion 3)', async () => {
  // showView turns every signed-out request into the sign-in wall. The colour must
  // follow the screen actually SHOWN, not the one requested — a Dark reader asking for the feed while
  // signed out gets the wall, light.
  const app = rig({ store: { focus_theme: 'dark', focus_was_authed: '1' }, signedIn: false });
  await boot(app, 'dark');
  app.ctx.showView('view-feed');
  assert.equal(views(app), 'view-landing', 'guard: the signed-out request was not coerced to the wall');
  assert.equal(painted(app), 'light');
});
