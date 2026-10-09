// [BUG-037] — `_pushNow` builds its request body OUTSIDE its try, so one malformed localStorage
// value makes the push REJECT rather than return a failure. Two callers hold no handler: the
// `schedulePush` debounce timer and `flushPush` from pagehide/visibilitychange. Sync then dies as an
// unhandled rejection while `focus_dirty` still asserts there is un-pushed work.
//
// Fixture note: `SIGNED_IN`'s archive entry is a bare `{id:'a1'}` which throws in `avatarHtml` when
// the boot lands on the ARCHIVE view ([BUG-117]). `focus_last_view: 'setup'` already prevents that,
// so the empty-archive override below is belt-and-braces rather than load-bearing — stated because
// the same override was justified with a false claim in BUG-051's first attempt.
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
// Asserted SEPARATELY on purpose: one test cannot stand in for both, and the criterion names both.

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

// AMENDED by [BUG-051] (Asli, 2026-09-10, asked as a named decision before the work began:
// "yes to all five"). `r.ok === false` was true here only because the body-build THREW and no
// request could leave. [BUG-051] downgrades a damaged-store push to events-only instead of
// refusing it — survivor E1 measured that refusing takes such a session from 3 analytics events to
// none — so a PUT does now go out and `ok` is legitimately true. The property this test exists for
// is unchanged and is still asserted: pushNow RESOLVES an outcome. `confirmed` is the field callers
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
// WHAT THEY DO NOT COVER, measured by the battery (mutations/BUG-037.mjs, M05/M06): both exercise
// only the FAILED-body path, where execution returns before `confirmed` is computed or the event
// gate is reached. So neither pins the HEALTHY-path handling of `dirty` or the buffer — M06 survives
// the whole suite. Do not read these as coverage of those lines.

test('c4: a push that could not build its body does not clear focus_dirty', async () => {
  const app = await boot();
  app.set('focus_channels', CORRUPT);
  app.ctx.schedulePush();
  assert.equal(app.get('focus_dirty'), '1', 'precondition: the mutation marked local dirty');
  await watchRejections(async () => { app.advance(2000); });
  assert.equal(app.get('focus_dirty'), '1',
    'dirty was cleared by a push that never carried state');
});

// AMENDED by [BUG-051], same authorisation as c3, and RENAMED because the old title would now be
// false: the push DOES leave. The property is the same one — buffered analytics must never be lost
// on a damaged store — but the mechanism that protects it flips from "nothing was sent, so nothing
// was dropped" to "they were sent, which is why they were dropped". Asserting delivery is strictly
// stronger than asserting the buffer stayed full: it is the difference survivor E1 names.
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
// STRENGTHENED after review (Asli, 2026-09-10: "strengthen the tests"). The original asserted a
// SHAPE — `puts.length > 0`, a `state` key, `channels.length === 1` — while criterion 6 names
// "same request count, same body, same headers". An independent battery reordered the body's keys
// and no test in 1149 noticed, so the wire bytes were pinned by nothing.

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
// STRENGTHENED after review. The original could not observe this change AT ALL, and two reviewers
// found it independently. `nothingToSave = !_statePending() && !_hasUserData(collectSyncedState())`
// SHORT-CIRCUITS: with no dirty flag, `collectSyncedState()` is never evaluated there and signOut
// throws before it ever reaches `pushNow`. The original fixture was exactly that sub-case — so it
// exercised none of the changed code, asserted no toast, and passed unmodified on `main`. Blinding
// the guard at app.js:2644 was killed by 12 pre-existing sign-out tests and NOT by c7.
//
// Both sub-cases are now covered, because which one runs is decided by a flag the test must set.

test('c7a: signOut with un-pushed work reaches the changed code and still refuses', async () => {
  const app = await boot();
  app.set('focus_channels', CORRUPT);
  app.ctx.schedulePush();                     // sets focus_dirty — the state BUG-037 leaves behind
  assert.equal(app.get('focus_dirty'), '1', 'precondition: this is the branch that reaches pushNow');
  const before = statePuts(app).length;

  await watchRejections(async () => { await app.ctx.signOut(); });

  assert.equal(app.get('focus_channels'), CORRUPT,
    'sign-out destroyed local data it could not read');
  assert.equal(app.navigations.length, 0,
    'sign-out navigated away on a store it could not save');
  // AMENDED by [BUG-051] (Asli, 2026-09-10, decision 4 of five: the guard lands sign-out on the
  // INDETERMINATE refusal rather than the wrapper catch's generic message). The requirement — the
  // refusal must SAY so, because a silent no-op is the [BUG-017] "button looks dead" shape — is
  // unchanged; only which true sentence the user reads has moved, from "couldn't sign out —
  // something went wrong" to a message that names the actual reason.
  // NARROWED after review: the first amendment accepted EITHER the new indeterminate refusal or
  // main's old wrapper-catch generic, so it could no longer tell the two dispositions apart —
  // widening an assertion while the comment claimed only the wording had moved.
  assert.ok(app.toasts.some(t => /^Not signed out/.test(String(t))),
    `the refusal must SAY so — a silent no-op is the BUG-017 "button looks dead" shape. toasts: ${JSON.stringify(app.toasts)}`);
  // Also amended: a push DOES reach the wire now, carrying analytics and no state. What must never
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
