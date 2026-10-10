// An analytics event is stored ONCE, however many times it is sent.
//
// The defect has three causes and they are not independent: events-only and unload saves skip
// pushNow's in-flight latch, so two saves can carry the same buffer; a closing document never reads
// its answers, so the buffer survives into the next boot and is sent again; and `_dropSentEvents(n)`
// removes by COUNT, so the second answer deletes entries that were never sent. Measured on a real
// first-boot sign-in: 4 copies, and one real `refresh` destroyed.
//
// These tests assert on WHAT IS STORED — `sql.eventRows` in the fake database, driven by the real
// `createStateHandler` — never on which function ran. A fake that records event inserts as a log
// of calls cannot ask "stored once" at all.
//
// c5a (no id written into an entry already buffered), c6b, c7 and r1 (the fallback that keeps a
// mis-ordered deploy counting twice, not zero) guard the de-duplication's own hazards, not the
// original defect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../test-helpers/app-harness.mjs';
import { createStateHandler } from '../api/state.js';
import { fakeDb, fakeReq, fakeRes } from '../test-helpers/handler.mjs';
import { sanitizeEvents, normalizeEvent, MAX_EVENTS_PER_BATCH } from '../api/_events.js';

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = { accountId: ACCOUNT_ID, email: 'new@example.com' };
const UUID = '7f3a9c11-2b4d-4e6f-8a1b-5c7d9e0f1a2b';
const settle = () => new Promise((r) => setImmediate(r));
const lowerKeys = (h = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
// RECENT, deliberately: `clampTs` rewrites any ts more than 30 days old to the server's own clock, so
// a fixture dated in the past cannot be found again by its ts.
const TS = Date.now() - 1000;

/** An app whose /api/state reaches the REAL handler over one fake store — so a client-side question
 *  ("was this event sent twice") and a server-side one ("how many rows are there") are the same test.
 *  `deaf`: PUT answers never arrive, which is what a document being closed sees — the request still
 *  reaches the server, and `_dropSentEvents` never runs. */
function rig({ sql = fakeDb(), store = {}, search = '?auth=ok', deaf = false } = {}) {
  const puts = [];
  let holding = false;
  const held = [];
  const app = createApp({ store: { focus_device_id: DEVICE_ID, ...store }, search });
  app.setFetch(async (url, init) => {
    const method = init.method || 'GET';
    if (url.includes('/api/auth/me')) return ok({ email: ACCOUNT.email });
    if (url.includes('/api/state')) {
      if (method === 'PUT') puts.push(JSON.parse(init.body));
      const handler = createStateHandler({ db: () => sql, sessionAccount: async () => ACCOUNT });
      const res = fakeRes();
      await handler(fakeReq({ method, headers: lowerKeys(init.headers), body: init.body ?? null }), res);
      const body = JSON.parse(JSON.stringify(res.body ?? {}));
      const answer = { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => body };
      if (method === 'PUT' && deaf) return new Promise(() => {});
      if (method === 'PUT' && holding) return new Promise((r) => held.push(() => r(answer)));
      return answer;
    }
    if (url.includes('/api/feed')) return ok({ items: [] });
    if (url.includes('/api/group')) return ok({ groups: null });
    return ok({});
  });
  return {
    app, sql, puts,
    hold: (on) => { holding = on; },
    release: () => { held.splice(0).forEach((f) => f()); },
  };
}

/** Boot without firing any timer, so a test decides itself when the 3s analytics save leaves. */
async function bootQuiet(app) {
  await app.ctx.init();
  for (let i = 0; i < 10; i++) await settle();
}
async function rest(n = 6) { for (let i = 0; i < n; i++) await settle(); }
/** A tab closing: the browser sets hidden and fires visibilitychange, THEN pagehide. Both reach
 *  flushPush, which is why one close sends two copies. */
function closeTab(app) {
  app.setVisibility('hidden');
  const v = app.fireDocument('visibilitychange');
  const p = app.fireWindow('pagehide');
  assert.ok(v >= 1 && p >= 1, 'guard: both unload listeners are wired, or this test closes nothing');
}
const buffer = (app) => JSON.parse(app.get('focus_events') || '[]');

test('[BUG-123] c1 every buffered event carries a distinct id, and a re-send carries the SAME id', async () => {
  const { app, puts } = rig({ deaf: true });
  await bootQuiet(app);
  app.advance(3000);                   // the analytics save leaves; its answer never arrives
  await rest();
  closeTab(app);                       // two more copies of the same buffer
  await rest();
  assert.ok(puts.length >= 2, `guard: this test needs overlapping saves, got ${puts.length}`);
  const batches = puts.map((p) => (p.events || []).map((e) => e.id));
  for (const ids of batches) {
    assert.ok(ids.length > 0, 'guard: every save here carries events');
    assert.ok(ids.every((id) => typeof id === 'string' && id.length >= 8), `every event carries an id: ${JSON.stringify(ids)}`);
    assert.equal(new Set(ids).size, ids.length, 'ids within one batch are distinct');
  }
  assert.deepEqual(batches[1], batches[0], 'a re-send of the same events carries the same ids');
  assert.ok(buffer(app).every((e) => typeof e.id === 'string'), 'the buffer itself carries the ids');
});

test('[BUG-123] c2 a first boot whose tab closes with a save in flight stores signin and tour_start ONCE', async () => {
  const sql = fakeDb();
  const first = rig({ sql, deaf: true });
  await bootQuiet(first.app);
  const buffered = buffer(first.app).map((e) => e.name);
  assert.deepEqual(buffered, ['signin', 'session_start', 'view', 'tour_start'],
    'guard: this is the live record\'s batch');
  first.app.advance(3000);
  await rest();
  closeTab(first.app);
  await rest();
  assert.ok(first.puts.length >= 3, `guard: the close must add its two copies, got ${first.puts.length} saves`);
  // The next boot over the same storage — the buffer survived, because no answer was ever read.
  const second = rig({ sql, store: Object.fromEntries(first.app.store), search: '' });
  await bootQuiet(second.app);
  second.app.advance(3000);
  await rest(10);
  assert.equal(sql.eventCount('signin'), 1, 'the sign-in is stored once (measured at 4 before the fix)');
  assert.equal(sql.eventCount('tour_start'), 1, 'the tour start is stored once — the funnel reads this');
  assert.equal(sql.eventCount('session_start'), 2,
    'two real boots stay two rows — de-duplication must not merge distinct events');
  assert.equal(buffer(second.app).length, 0, 'and the buffer drained');
});

test('[BUG-123] c3 an event tracked while two saves are in flight is not deleted and reaches the server', async () => {
  const { app, sql, hold, release } = rig({});
  await bootQuiet(app);
  hold(true);
  app.advance(3000);                    // save A leaves, held
  await rest();
  app.setVisibility('hidden');
  app.fireDocument('visibilitychange'); // save B leaves, held — same events, no latch
  await rest();
  app.setVisibility('visible');
  app.ctx.track('refresh', {}, 'feed'); // a REAL event, arriving while both are in flight
  release();                            // both answer 200; the second drop is the destructive one
  await rest(10);
  hold(false);
  app.advance(3000);
  await rest(10);
  assert.equal(sql.eventCount('refresh'), 1,
    'an event tracked mid-flight must still reach the server (drop-by-count deletes it unsent)');
});

test('[BUG-123] c4 a save carries at most one batch, and the rest follow on the next save', async () => {
  const { app, sql, puts } = rig({});
  await bootQuiet(app);
  for (let i = 0; i < 150; i++) app.ctx.track('mark_done', { n: i }, 'feed');
  app.advance(3000);
  await rest(10);
  const biggest = Math.max(...puts.map((p) => (p.events || []).length));
  assert.ok(biggest <= MAX_EVENTS_PER_BATCH,
    `a save carried ${biggest} events; the server keeps ${MAX_EVENTS_PER_BATCH} and the client drops them all`);
  app.advance(3000);                     // the leftovers ride the re-armed timer
  await rest(10);
  assert.equal(sql.eventCount('mark_done'), 150, 'every event reached the table, none silently dropped');
  assert.equal(buffer(app).length, 0, 'and the buffer drained');
});

test('[BUG-123] c5a an entry already in the buffer is never rewritten — no id is added to it', async () => {
  const legacy = { name: 'view', props: {}, section: 'feed', ts: TS };
  const { app } = rig({ store: { focus_events: JSON.stringify([legacy]) }, deaf: true });
  await bootQuiet(app);
  app.advance(3000);
  await rest();
  assert.deepEqual({ ...buffer(app)[0] }, legacy,
    'a pre-deploy entry must go out untouched — two refusal tests assert this buffer is byte-identical');
});

test('[BUG-123] c5b a pre-deploy entry with no id is still delivered, stored, and dropped from the buffer', async () => {
  const legacy = { name: 'view', props: {}, section: 'feed', ts: TS };
  const { app, sql } = rig({ store: { focus_events: JSON.stringify([legacy]) } });
  await bootQuiet(app);
  app.advance(3000);
  await rest(10);
  const row = sql.eventRows.find((r) => r.ts === legacy.ts);
  assert.ok(row, 'the legacy entry was delivered');
  assert.equal(row.client_id, null, 'and stored with no client id — it cannot be de-duplicated, by design');
  assert.ok(!buffer(app).some((e) => e.ts === legacy.ts),
    'a delivered entry with no id must still leave the buffer, or it re-ships forever');
});

// ── The server side, driven directly ─────────────────────────────────────────
async function put(sql, events, { session = ACCOUNT, headers = {}, body = {} } = {}) {
  const handler = createStateHandler({ db: () => sql, sessionAccount: async () => session });
  const res = fakeRes();
  await handler(fakeReq({
    method: 'PUT',
    headers: { 'x-device-id': DEVICE_ID, ...headers },
    body: { uid: DEVICE_ID, events, ...body },
  }), res);
  return res;
}
const evt = (id, name = 'view') => ({ name, section: 'feed', props: {}, ts: TS, id });

test('[BUG-123] c6a the same id twice in one batch stores one row', async () => {
  const sql = fakeDb();
  const res = await put(sql, [evt(UUID), evt(UUID)]);
  assert.equal(res.statusCode, 200);
  assert.equal(sql.eventCount('view'), 1, 'one event, sent twice in one batch, is one row');
});

test('[BUG-123] c6b two different ids store two rows, and a missing id is never rejected', async () => {
  const sql = fakeDb();
  await put(sql, [evt(UUID), evt('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'), { name: 'refresh', section: 'feed', props: {}, ts: TS + 1 }]);
  assert.equal(sql.eventCount('view'), 2, 'two distinct events stay two rows');
  assert.equal(sql.eventCount('refresh'), 1, 'an event with no id is stored, never dropped');
  assert.equal(sql.eventRows.find((r) => r.name === 'refresh').client_id, null);
});

test('[BUG-123] c6c the same batch delivered twice stores each event once', async () => {
  const sql = fakeDb();
  await put(sql, [evt(UUID)]);
  await put(sql, [evt(UUID)]);            // the re-send a closing page guarantees
  assert.equal(sql.eventCount('view'), 1, 'the second delivery of the same event adds nothing');
});

test('[BUG-123] c7 a 412 stores nothing, a 409 still stores, and attribute-on-login still stamps rows', async () => {
  const refused = fakeDb();
  const res = await put(refused, [evt(UUID)], {
    session: null,
    headers: { 'x-require-account': '1' },
    body: { state: { channels: [] } },
  });
  assert.equal(res.statusCode, 412);
  assert.equal(refused.eventRows.length, 0, 'a refused save stores no events — the client keeps and re-sends them');

  const anon = fakeDb();
  await put(anon, [evt(UUID)], { session: null });
  assert.equal(anon.eventRows[0].account_id, null, 'guard: the row starts anonymous');
  await put(anon, [evt('1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', 'refresh')]);
  assert.ok(anon.eventRows.every((r) => r.account_id === ACCOUNT_ID),
    'attribute-on-login still claims this device\'s earlier anonymous rows');
});

test('[BUG-123] r1 a server whose migration has NOT run still stores events — twice, never zero', async () => {
  const sql = fakeDb({ eventsIndex: false });
  const res = await put(sql, [evt(UUID)]);
  assert.equal(res.statusCode, 200);
  // WHICH PATH RAN, not just how many rows. Without this the test passes whether the fallback fired or
  // the primary insert simply succeeded — so a tidy-up of the fake that stopped staging the failure
  // would retire the deploy-order guard's only coverage in silence.
  // The fallback statement does not name client_id, so real Postgres stores NULL there.
  assert.equal(sql.eventRows[0].client_id, null, 'the row came from the fallback insert, which names no client_id');
  await put(sql, [evt(UUID)]);
  assert.equal(sql.eventCount('view'), 2,
    'without the index the insert cannot skip repeats — it must fall back to a plain insert, not lose the batch');
});

test('[BUG-123] c8 the migration adds client_id and its unique index, both idempotently', () => {
  const src = fs.readFileSync(new URL('../scripts/init-db.mjs', import.meta.url), 'utf8');
  assert.match(src, /alter table events\s+add column if not exists client_id/i,
    'the column is added with `if not exists`, so re-running the migration is safe');
  assert.match(src, /create unique index if not exists events_client_id_key\s+on events \(client_id\)/i,
    'and the unique index the ON CONFLICT target needs, by the name the fallback error names');
});

test('[BUG-123] c6d a batch mixing a repeat with a NEW event stores the repeat once and the new one too', async () => {
  const sql = fakeDb();
  await put(sql, [evt(UUID)]);
  // The shape EVERY real re-send has: a closing page's buffer, plus whatever was tracked since.
  // Without the conflict clause this is a 23505 that rejects the WHOLE statement, so the new event is
  // lost at 200 — measured against a real Postgres.
  // Neither c6a (sanitizeEvents drops the repeat first) nor c6c (one row either way) can fail
  // for it, so this is the test that pins the clause.
  await put(sql, [evt(UUID), evt('4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d', 'refresh')]);
  assert.equal(sql.eventCount('view'), 1, 'the repeat is still one row');
  assert.equal(sql.eventCount('refresh'), 1, 'and the new event beside it was NOT lost with the batch');
});

test('[BUG-123] c6e a stored row carries the SANITISED values, not whatever the client sent', async () => {
  const sql = fakeDb();
  await put(sql, [
    { name: 'evil_hack', section: 'feed', props: {}, ts: TS, id: '2b3c4d5e-6f70-4a8b-8c9d-0e1f2a3b4c5d' },
    { name: 'view', section: 'x'.repeat(400), props: { big: 'y'.repeat(2000) }, ts: TS, id: UUID },
  ]);
  assert.equal(sql.eventCount('evil_hack'), 0, 'an unallowlisted name never reaches the table');
  const row = sql.eventRows.find((r) => r.name === 'view');
  assert.equal(row.section.length, 120, 'the section is clamped');
  assert.deepEqual(row.props, {}, 'oversized props are dropped, the event kept');
});

test('[BUG-123] r2 a server whose migration has NOT run at all still stores events', async () => {
  // The ORDINARY deploy order: a merge deploys the code, `init-db --prod` is run by hand. The table
  // then has no client_id column and Postgres answers 42703 — not the 42P10 that r1 stages, which is
  // the narrower "column present, index missing". A fallback matching only
  // 42P10 lets the case it exists for fall through to `catch { /* swallow */ }` and every event is
  // dropped at 200. The SQLSTATEs were measured against a real
  // Postgres.
  const sql = fakeDb({ eventsClientIdColumn: false, eventsIndex: false });
  const res = await put(sql, [evt(UUID)]);
  assert.equal(res.statusCode, 200);
  assert.equal(sql.eventCount('view'), 1, 'the fallback stored it — losing every event silently is the failure this guards');
  assert.equal(sql.eventRows[0].client_id, null, 'and stored no client_id, which that table has no column for');
  await put(sql, [evt(UUID)]);
  assert.equal(sql.eventCount('view'), 2, 'un-migrated, a repeat is counted twice — the deliberate direction: twice, never zero');
});

test('[BUG-123] r1b the fallback survives a driver that loses the error code, and one that rewords it', async () => {
  // Both terms of the guard are load-bearing on their own; a "simplification" to one is invisible
  // otherwise.
  for (const [label, err] of [
    ['code lost, message intact', Object.assign(new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification'), {})],
    ['code intact, message reworded', Object.assign(new Error('translated database error'), { code: '42P10' })],
    ['column error, code lost', Object.assign(new Error('column "client_id" of relation "events" does not exist'), {})],
  ]) {
    const sql = fakeDb();
    const real = sql;
    let first = true;
    const wrapped = (strings, ...values) => {
      const text = String(strings.raw ? strings.raw.join('?') : strings);
      if (first && /insert into events/.test(text) && /client_id/.test(text)) { first = false; return Promise.reject(err); }
      return real(strings, ...values);
    };
    Object.assign(wrapped, real);
    const handler = createStateHandler({ db: () => wrapped, sessionAccount: async () => ACCOUNT });
    const res = fakeRes();
    await handler(fakeReq({ method: 'PUT', headers: { 'x-device-id': DEVICE_ID }, body: { uid: DEVICE_ID, events: [evt(UUID)] } }), res);
    assert.equal(res.statusCode, 200, label);
    assert.equal(real.eventCount('view'), 1, `${label}: the batch must still be stored, not swallowed`);
  }
});

test('[BUG-123] r1c an ordinary database failure is NOT retried by the fallback', async () => {
  // The guard's NARROWNESS is protective: without this test, a fallback
  // that fires for every error passes the whole suite.
  // The harm is specific — a blip AFTER the insert commits would re-insert the batch with client_id
  // stripped, since the fallback names no such column, so the duplicates carry NULL ids and can never
  // be de-duplicated or even found again. Exactly the damage this task exists to remove, made permanent.
  const sql = fakeDb();
  let attempts = 0;
  const wrapped = (strings, ...values) => {
    const text = String(strings.raw ? strings.raw.join('?') : strings);
    if (/insert into events/.test(text)) {
      attempts += 1;
      return Promise.reject(Object.assign(new Error('connection terminated unexpectedly'), { code: '08006' }));
    }
    return sql(strings, ...values);
  };
  Object.assign(wrapped, sql);
  const handler = createStateHandler({ db: () => wrapped, sessionAccount: async () => ACCOUNT });
  const res = fakeRes();
  await handler(fakeReq({ method: 'PUT', headers: { 'x-device-id': DEVICE_ID }, body: { uid: DEVICE_ID, events: [evt(UUID)] } }), res);
  assert.equal(attempts, 1, 'a non-schema error is rethrown, never retried as a plain insert');
  assert.equal(res.statusCode, 200, 'and analytics still cannot fail the state sync');
});

test('[BUG-123] c8b the migration adds the column BEFORE the index that needs it', () => {
  // Two independent regexes say both statements exist and neither says which comes first — so
  // swapping them would go unnoticed, and every database whose events table
  // predates this change (production) would throw on the index and abort the rest of the migration.
  const src = fs.readFileSync(new URL('../scripts/init-db.mjs', import.meta.url), 'utf8');
  const col = src.indexOf('add column if not exists client_id');
  const idx = src.indexOf('create unique index if not exists events_client_id_key');
  assert.ok(col !== -1 && idx !== -1, 'guard: both statements are present');
  assert.ok(col < idx, 'the column must be created before the index on it');
});

test('[BUG-123] c3b a 409 drops only the events it carried, not those that arrived mid-flight', async () => {
  // TWO overlapping saves, because with only one in flight a count-based drop and an entry-based drop
  // remove exactly the same entries, and restoring drop-by-count on the 409 branch
  // would go unnoticed. The defect needs the second
  // answer to arrive after the first has already drained the buffer.
  const app = createApp({ store: { focus_device_id: DEVICE_ID }, search: '' });
  const held = [];
  let puts = 0;
  app.setFetch(async (url, init) => {
    if (url.includes('/api/auth/me')) return ok({ email: ACCOUNT.email });
    if (url.includes('/api/state') && (init.method || 'GET') === 'PUT') {
      const nth = ++puts;
      // First save is accepted; the second — the unload copy carrying the SAME events — is refused.
      const answer = nth === 1
        ? { ok: true, status: 200, json: async () => ({ updatedAt: null, rev: null }) }
        : { ok: false, status: 409, json: async () => ({ error: 'stale state' }) };
      return new Promise((r) => held.push(() => r(answer)));
    }
    if (url.includes('/api/state')) return ok({ state: null, updatedAt: null, kind: 'account' });
    if (url.includes('/api/feed')) return ok({ items: [] });
    return ok({});
  });
  await bootQuiet(app);
  app.advance(3000);                       // save A leaves, held
  await rest();
  app.setVisibility('hidden');
  app.fireDocument('visibilitychange');    // save B leaves with the same events, held
  await rest();
  assert.equal(held.length, 2, 'guard: two saves are in flight carrying the same events');
  held.shift()();                          // A is accepted and drains the buffer
  await rest(6);
  app.setVisibility('visible');
  app.ctx.track('refresh', {}, 'feed');    // arrives AFTER A drained, BEFORE B is answered
  held.shift()();                          // B is refused — 409 still ingests, so it drops what it sent
  await rest(10);
  assert.ok(buffer(app).some((e) => e.name === 'refresh'),
    'an event tracked while a refused save was in flight must stay buffered, not be dropped by count');
});

test('[BUG-123] c4b a save the server accepted still reports ok when the buffer write throws', async () => {
  // `_dropSentEvents` runs inside `_pushNow`'s try, so a throwing setItem (quota, private window,
  // blocked site data) would turn an ACCEPTED save into {ok:false} — which signOut reads as a failure.
  // The 100-event cap makes `setItem` the common branch, so this is not a rare path.
  //
  // A LEFTOVER IS REQUIRED. Dropping the only buffered entry
  // takes the `removeItem` branch — so the staged setItem failure would never fire and
  // an unguarded write would pass. An event must arrive WHILE the save is in flight.
  const { app, hold, release } = rig({ store: { focus_channels: JSON.stringify([{ id: 'UC1', name: 'One' }]) }, search: '' });
  await bootQuiet(app);
  app.advance(3000);
  await rest(10);                                  // the boot's own events drain first
  hold(true);
  app.ctx.track('refresh', {}, 'feed');
  const inFlight = app.ctx.pushNow({});            // carries [refresh], held open
  await rest();
  app.ctx.track('archive', {}, 'feed');            // arrives mid-flight, so a leftover survives the drop
  app.failSetItem((k) => k === 'focus_events');    // and writing that leftover back throws
  release();
  const answer = await inFlight;
  app.failSetItem(null);
  assert.equal(answer.ok, true, 'the server accepted this save; a failed buffer write must not report otherwise');
});

test('[BUG-123] c1b ids are still minted where crypto.randomUUID is missing', async () => {
  // `_eventId`'s own comment names the embedded-webview case; this executes that branch.
  // An event with no id is counted but can never be
  // de-duplicated, so the fallback generator has to produce something the server accepts.
  const { app } = rig({ deaf: true });
  app.ctx.crypto = {};                     // a browser that offers no randomUUID
  await bootQuiet(app);
  const ids = buffer(app).map((e) => e.id);
  assert.ok(ids.length > 0, 'guard: the boot buffered events');
  assert.ok(ids.every((id) => normalizeEvent({ name: 'view', ts: TS, id }, TS).id === id.toLowerCase()),
    `every fallback id must pass the server's own validator: ${JSON.stringify(ids)}`);
  assert.equal(new Set(ids).size, ids.length, 'and they are distinct');
});

// ── The event normaliser ─────────────────────────────────────────────────────
test('[BUG-123] n1 normalizeEvent keeps a valid id and drops a malformed one without dropping the event', () => {
  const now = 1757000000000;
  assert.equal(normalizeEvent({ name: 'view', ts: now, id: UUID }, now).id, UUID);
  assert.equal(normalizeEvent({ name: 'view', ts: now, id: 'not-a-uuid' }, now).id, null,
    'a malformed id is discarded — the event is still counted, it just cannot be de-duplicated');
  assert.equal(normalizeEvent({ name: 'view', ts: now, id: { evil: true } }, now).id, null);
  assert.equal(normalizeEvent({ name: 'view', ts: now }, now).id, null);
  // ANCHORING: unanchored, the check reads "contains a uuid", so two padded spellings of one id
  // become two rows.
  assert.equal(normalizeEvent({ name: 'view', ts: now, id: `  ${UUID}` }, now).id, null, 'padded');
  assert.equal(normalizeEvent({ name: 'view', ts: now, id: `${UUID}-extra` }, now).id, null, 'suffixed');
  assert.equal(normalizeEvent({ name: 'view', ts: now, id: `id=${UUID};` }, now).id, null, 'embedded');
  // CASE: one id in two spellings is one event, or the de-duplication it exists for does not
  // happen.
  assert.equal(normalizeEvent({ name: 'view', ts: now, id: UUID.toUpperCase() }, now).id, UUID);
  assert.equal(normalizeEvent({ name: 'view', ts: now, id: UUID }, now).name, 'view', 'guard: still an event');
});

test('[BUG-123] n2 sanitizeEvents drops a repeated id inside one batch, keeping the first', () => {
  const now = 1757000000000;
  const out = sanitizeEvents([
    { name: 'view', section: 'feed', ts: now, id: UUID },
    { name: 'refresh', section: 'feed', ts: now + 1, id: UUID },
    { name: 'archive', section: 'feed', ts: now + 2, id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' },
    { name: 'mark_done', section: 'feed', ts: now + 3 },
    { name: 'mark_done', section: 'feed', ts: now + 4 },
  ], now);
  assert.deepEqual(out.map((e) => e.name), ['view', 'archive', 'mark_done', 'mark_done'],
    'one id is one event; entries without an id are untouched');
});
