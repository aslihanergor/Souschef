// `_pushNow` builds its request body OUTSIDE its try, so one malformed localStorage
// value makes the push REJECT rather than return a failure. Two callers hold no handler: the
// `schedulePush` debounce timer and `flushPush` from pagehide/visibilitychange. Sync then dies as an
// unhandled rejection while `focus_dirty` still asserts there is un-pushed work.
//
// Fixture note: `SIGNED_IN`'s archive entry is a bare `{id:'a1'}` which throws in `avatarHtml` when
// the boot lands on the ARCHIVE view. `focus_last_view: 'setup'` already prevents that,
// so the empty-archive override below is belt-and-braces rather than load-bearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, SIGNED_IN } from '../test-helpers/app-harness.mjs';

const BASE = { ...SIGNED_IN, focus_last_view: 'setup', focus_archive: '[]' };
const CORRUPT = '[{"id":"UC_a","na';
const ROW = { ok: true, status: 200, json: async () => ({ state: {}, updatedAt: '2026-01-01T00:00:00.000Z', rev: 'r1' }) };

const mk = async (url) => {
  const u = String(url);
  if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
  if (u.includes('/api/state')) return ROW;
  if (u.includes('/api/auth/logout')) return { ok: true, status: 200, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({}) };
};

async function boot(over = {}) {
  const app = createApp({ store: { ...BASE, ...over }, fetch: mk });
  await app.ctx.init();
  return app;
}
const statePuts = (app) => app.requests.filter(
  r => r.url.includes('/api/state') && (r.init.method || 'GET') === 'PUT');

/** Run `fn` watching for an unhandled rejection; returns it or null. */
async function watchRejections(fn) {
  let unhandled = null;
  const h = (e) => { unhandled = e; };
  process.on('unhandledRejection', h);
  try { await fn(); for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); }
  finally { process.off('unhandledRejection', h); }
  return unhandled;
}

// ── c1 / c2 — the two unguarded callers ──────────────────────────────────────
// Asserted SEPARATELY on purpose: one test cannot stand in for both.

test('c1: the schedulePush debounce timer does not reject on a corrupt store', async () => {
  const app = await boot();
  const unhandled = await watchRejections(async () => {
    app.set('focus_channels', CORRUPT);
    app.ctx.schedulePush();
    app.advance(2000);
  });
  assert.equal(unhandled, null,
    `the debounce timer rejected with nobody holding it: ${unhandled && unhandled.constructor.name}`);
  // This test originally also asserted the push was still ATTEMPTED, to stop the fix being made by
  // simply refusing to push. That assertion was MISCONCEIVED and is removed rather than weakened:
  // the throw happens while BUILDING the body, so there is no body to send and no request is
  // possible. `c6` covers the real concern properly — a HEALTHY store must still push, with the
  // channel array intact — which is where "did you just stop pushing" is actually observable.
});

test('c2: flushPush does not reject on a corrupt store', async () => {
  const app = await boot();
  const unhandled = await watchRejections(async () => {
    app.set('focus_channels', CORRUPT);
    app.ctx.schedulePush();          // arm the timer and set dirty, so statePending is true
    app.ctx.flushPush();             // the pagehide path, with eventsOnly resolving false
  });
  assert.equal(unhandled, null,
    `flushPush rejected with nobody holding it: ${unhandled && unhandled.constructor.name}`);
});

// ── c3 — the contract every caller is written against ────────────────────────

// A damaged-store push is downgraded to events-only instead of being
// refused — refusing takes such a session from 3 analytics events to
// none — so a PUT does go out and `ok` is legitimately true. The property this test exists for
// is that pushNow RESOLVES an outcome. `confirmed` is the field callers
// gate destructive decisions on, and it must still be false.
test('c3: pushNow resolves an outcome rather than rejecting', async () => {
  const app = await boot();
  app.set('focus_channels', CORRUPT);
  const before = statePuts(app).length;
  const r = await app.ctx.pushNow();
  assert.equal(typeof r, 'object', 'pushNow must resolve, not reject');
  assert.equal(r.confirmed, false, 'an events-only push can never confirm, so dirty is never cleared');
  const sent = statePuts(app).slice(before).map(q => JSON.parse(q.init.body));
  assert.equal(sent.length, 1, 'the push is downgraded, not refused');
  assert.ok(!('state' in sent[0]), 'and claims no state it could not read');
});

// ── c4 / c5 — properties that must hold AFTER the fix ───────────────────────
// I labelled these "controls" expecting them to pass on `main`. They do not: the unhandled rejection
// fails the test before their assertion is reached, so today they are unobservable rather than true.
// On `main` the property itself IS incidentally satisfied — measured this session, `focus_dirty`
// stays '1' after a rejected debounce — but only because nothing runs, not because anything protects
// it. After the fix the push actually executes and must leave both alone DELIBERATELY. Kept because
// that is the wrong way to go green here: swallowing state or draining the buffer would satisfy
// c1-c3 and break these.
//
// WHAT THEY DO NOT COVER: both exercise
// only the FAILED-body path, where execution returns before `confirmed` is computed or the event
// gate is reached. So neither pins the HEALTHY-path handling of `dirty` or the buffer.
// Do not read these as coverage of those lines.

test('c4: a push that could not build its body does not clear focus_dirty', async () => {
  const app = await boot();
  app.set('focus_channels', CORRUPT);
  app.ctx.schedulePush();
  assert.equal(app.get('focus_dirty'), '1', 'precondition: the mutation marked local dirty');
  await watchRejections(async () => { app.advance(2000); });
  assert.equal(app.get('focus_dirty'), '1',
    'dirty was cleared by a push that never carried state');
});

// The push DOES leave. The property — buffered analytics must never be lost
// on a damaged store — is protected not by "nothing was sent, so nothing
// was dropped" but by "they were sent, which is why they were dropped". Asserting delivery is strictly
// stronger than asserting the buffer stayed full.
test('c5: buffered events are DELIVERED, not lost, when the store is damaged', async () => {
  const app = await boot();
  app.ctx.track('view', {}, 'feed');
  const before = JSON.parse(app.get('focus_events') || '[]').length;
  assert.ok(before > 0, 'precondition: something is buffered');
  const sentBefore = statePuts(app).length;
  app.set('focus_channels', CORRUPT);
  await watchRejections(async () => { app.ctx.schedulePush(); app.advance(2000); });
  const sent = statePuts(app).slice(sentBefore).map(q => JSON.parse(q.init.body));
  assert.equal(sent.length, 1, 'a damaged store must still drain analytics');
  assert.ok(sent[0].events.length >= before, `the events must ride the push: ${JSON.stringify(sent[0].events)}`);
  assert.equal(JSON.parse(app.get('focus_events') || '[]').length, 0, 'and drain from the buffer once delivered');
});

// ── c6 — a healthy path must be byte-identical ───────────────────────────────
// Asserting a SHAPE — `puts.length > 0`, a `state` key, `channels.length === 1` — is not enough:
// the requirement is "same request count, same body, same headers", and reordering the body's keys
// would pass a shape check. So the wire bytes are pinned exactly.

test('c6: a healthy push is unchanged — exact count, exact wire bytes, exact headers', async () => {
  const app = await boot();
  const before = statePuts(app).length;
  app.ctx.schedulePush();
  app.advance(2000);
  for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

  const puts = statePuts(app);
  assert.equal(puts.length - before, 1, 'exactly ONE push per debounced mutation, not zero and not two');

  const put = puts[puts.length - 1];
  const body = JSON.parse(put.init.body);

  // KEY ORDER is part of the wire bytes. `{uid, ...state, events}` is what the server has always
  // received; a reordering changes the payload while every shape assertion stays green.
  assert.deepEqual(Object.keys(body), ['uid', 'state', 'events'],
    'the body key order changed — these are the wire bytes, not just a shape');
  assert.ok(Array.isArray(body.state.channels), 'state carries the real channel array');
  assert.equal(body.state.channels.length, 1, 'exactly what SIGNED_IN holds');
  assert.ok(typeof body.uid === 'string' && body.uid.length > 0, 'uid is carried, not dropped');

  // Headers. `X-State-Rev` is the base a state-claiming push is entitled to declare; dropping it
  // silently disables the server's staleness check.
  const h = put.init.headers || {};
  assert.equal(h['Content-Type'], 'application/json');
  assert.ok(h['X-Device-Id'], 'X-Device-Id must be sent');
  assert.equal(h['X-State-Rev'], 'r1', 'a state-claiming push declares the base it read');
});

// ── c7 — the exit path must NOT move ─────────────────────────────────────────
// The fixture needs the dirty flag. `nothingToSave = !_statePending() && !_hasUserData(collectSyncedState())`
// SHORT-CIRCUITS: with no dirty flag, `collectSyncedState()` is never evaluated there and signOut
// throws before it ever reaches `pushNow`. A fixture in that sub-case
// exercises none of the guarded code.
//
// Both sub-cases are now covered, because which one runs is decided by a flag the test must set.

test('c7a: signOut with un-pushed work reaches the changed code and still refuses', async () => {
  const app = await boot();
  app.set('focus_channels', CORRUPT);
  app.ctx.schedulePush();                     // sets focus_dirty — the state a rejected push leaves behind
  assert.equal(app.get('focus_dirty'), '1', 'precondition: this is the branch that reaches pushNow');
  const before = statePuts(app).length;

  await watchRejections(async () => { await app.ctx.signOut(); });

  assert.equal(app.get('focus_channels'), CORRUPT,
    'sign-out destroyed local data it could not read');
  assert.equal(app.navigations.length, 0,
    'sign-out navigated away on a store it could not save');
  // The guard lands sign-out on the
  // INDETERMINATE refusal rather than the wrapper catch's generic message. The requirement: the
  // refusal must SAY so, because a silent no-op makes the button look dead — and it must name
  // the actual reason, not "couldn't sign out — something went wrong". Accepting EITHER message
  // could not tell the two dispositions apart.
  assert.ok(app.toasts.some(t => /^Not signed out/.test(String(t))),
    `the refusal must SAY so — a silent no-op is the BUG-017 "button looks dead" shape. toasts: ${JSON.stringify(app.toasts)}`);
  // A push DOES reach the wire, carrying analytics and no state. What must never
  // reach it is a `state` claim built from a store that could not be read.
  const sent = statePuts(app).slice(before).map(q => JSON.parse(q.init.body));
  assert.ok(sent.every(b => !('state' in b)),
    `a body built from an unreadable store must not reach the wire: ${JSON.stringify(sent)}`);
});

test('c7b: signOut with nothing pending refuses the same way', async () => {
  // The short-circuit sub-case — the original c7. Kept, because it is the one that proves the
  // `!_statePending()` term is load-bearing, but no longer mistaken for coverage of the changed code.
  const app = await boot();
  app.set('focus_channels', CORRUPT);
  assert.equal(app.get('focus_dirty'), null, 'precondition: nothing pending, so nothingToSave short-circuits');

  await watchRejections(async () => { await app.ctx.signOut(); });

  assert.equal(app.get('focus_channels'), CORRUPT, 'sign-out destroyed local data');
  assert.equal(app.navigations.length, 0, 'sign-out navigated away');
});
