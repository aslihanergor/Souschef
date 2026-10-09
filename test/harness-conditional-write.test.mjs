// Probing the fake BEFORE building on it (BUG-047, attempt 4).
//
// Attempt 3 built a refuse-a-stale-write mechanism on a fake that could not express one: it read the
// `on conflict` TARGET and threw the ACTION away, so `do update … where <guard>` was applied as an
// unconditional overwrite. Criterion 1's test would have gone green against an implementation
// guarding nothing. A reviewer also showed the fake returned `rev` and `updatedAt` byte-identical,
// so a client echoing the wrong field passed a test written to catch precisely that.
//
// These tests are the control for both. They drive the fake directly with the SQL shapes the handler
// emits, and they exist so that "the guard bit" is a measured property of the instrument rather than
// a claim in its header — the failure mode CLAUDE.md's "your instrument may be lying" family names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, toCharUS } from '../test-helpers/handler.mjs';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const SEED = { channels: [{ id: 'UCkeep', name: 'Keep me', source: 'youtube' }], done: ['v1'] };
const INTRUDER = { channels: [], done: [] };

const seeded = () => fakeDb({ users: [{ kind: 'account', id: ACCOUNT_ID, state: SEED }] });
const readRow = (sql) => sql`
  select state, updated_at, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as rev from users
  where id = ${ACCOUNT_ID} and kind = ${'account'}`;

const upsert = (sql, state, base) => sql`
  insert into users (kind, id, state, updated_at)
  values (${'account'}, ${ACCOUNT_ID}, ${JSON.stringify(state)}::jsonb, now())
  on conflict (kind, id) do update set state = excluded.state, updated_at = now()
  where to_char(users.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') = ${base}
  returning updated_at, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as rev`;

test('the fake reads back a rev, and it is NOT the same string as updatedAt', async () => {
  const sql = seeded();
  const [row] = await readRow(sql);
  assert.equal(typeof row.rev, 'string');
  assert.match(row.rev, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/, 'Postgres to_char shape');
  // The whole point: a client that echoes `updatedAt` where it should echo `rev` must NOT match.
  assert.notEqual(row.rev, row.updated_at.toISOString());
});

test('a MATCHING rev updates the row', async () => {
  const sql = seeded();
  const [{ rev }] = await readRow(sql);
  const out = await upsert(sql, INTRUDER, rev);
  assert.equal(out.length, 1, 'a matching guard must write');
  assert.deepEqual(sql.rows[0].state, INTRUDER);
  assert.equal(out[0].rev, toCharUS(sql.rows[0].updated_at), 'the new rev is returned');
});

test('a STALE rev writes nothing and leaves the row byte-identical', async () => {
  const sql = seeded();
  const before = JSON.stringify(sql.rows[0]);
  const out = await upsert(sql, INTRUDER, '2020-01-01T00:00:00.000000');
  assert.equal(out.length, 0, 'zero rows is what the handler turns into a 409');
  assert.equal(JSON.stringify(sql.rows[0]), before, 'the row must be untouched');
});

test('CONTROL: with the guard removed the same write DOES overwrite', async () => {
  // Proves the previous test fails for the right reason — the guard, not some other refusal.
  const sql = seeded();
  await sql`
    insert into users (kind, id, state, updated_at)
    values (${'account'}, ${ACCOUNT_ID}, ${JSON.stringify(INTRUDER)}::jsonb, now())
    on conflict (kind, id) do update set state = excluded.state, updated_at = now()
    returning updated_at`;
  assert.deepEqual(sql.rows[0].state, INTRUDER, 'unguarded upsert overwrites — the original defect');
});

test('do nothing: creates when absent, never overwrites when present', async () => {
  const sql = seeded();
  const before = JSON.stringify(sql.rows[0]);
  const blocked = await sql`
    insert into users (kind, id, state, updated_at)
    values (${'account'}, ${ACCOUNT_ID}, ${JSON.stringify(INTRUDER)}::jsonb, now())
    on conflict (kind, id) do nothing returning updated_at`;
  assert.equal(blocked.length, 0);
  assert.equal(JSON.stringify(sql.rows[0]), before);

  const FRESH = '33333333-3333-4333-8333-333333333333';
  const made = await sql`
    insert into users (kind, id, state, updated_at)
    values (${'account'}, ${FRESH}, ${JSON.stringify(SEED)}::jsonb, now())
    on conflict (kind, id) do nothing returning updated_at`;
  assert.equal(made.length, 1, 'create is always allowed');
});

test('the no-user-data UPDATE path takes the guard too', async () => {
  // The branch the BUG-057 control showed an empty browser's blob actually lands through.
  const sql = seeded();
  const before = JSON.stringify(sql.rows[0]);
  const stale = await sql`
    update users set state = ${JSON.stringify(INTRUDER)}::jsonb, updated_at = now()
    where kind = ${'account'} and id = ${ACCOUNT_ID}
      and to_char(users.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') = ${'2020-01-01T00:00:00.000000'}
    returning updated_at, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as rev`;
  assert.equal(stale.length, 0, 'a stale base must not empty the row');
  assert.equal(JSON.stringify(sql.rows[0]), before);
});

test('an unrecognised guard shape THROWS rather than pretending to match', () => {
  const sql = seeded();
  // Synchronous on purpose: the fake refuses while PARSING, before it can pretend anything ran.
  assert.throws(
    () => sql`
      insert into users (kind, id, state, updated_at)
      values (${'account'}, ${ACCOUNT_ID}, ${JSON.stringify(INTRUDER)}::jsonb, now())
      on conflict (kind, id) do update set state = excluded.state
      where users.state ->> 'nonsense' = ${'x'} returning updated_at`,
    /unrecognised conditional-write guard/,
  );
});

// ── R18/R19: the canonical rev expression, and an instrument that can see it drift ──────────────
//
// Review round 4 found the guard above pinned nothing about the EXPRESSION. The fake matched
// `to_char(users.updated_at, '<anything>')` and rendered the token with its own `toCharUS`
// regardless, so the read could ask for one spelling and the write for another — or either could
// drop the `at time zone 'UTC'` that makes the token GUC-stable — and the fake would hand back
// matching strings and stay green. `REV_FORMAT` was exported and never imported: dead code standing
// in for a guarantee.
//
// These three tests are what makes it a guarantee. The first pins the SHIPPING statements to the
// constant; the other two are controls showing the instrument now refuses what it used to serve.
import { createStateHandler } from '../api/state.js';
import { REV_EXPR, REV_EXPR_QUALIFIED } from '../api/_state.js';
import { fakeReq, fakeRes } from '../test-helpers/handler.mjs';

const sqlText = (s) => s.replace(/\s+/g, ' ').toLowerCase();

test('R18 every rev the HANDLER asks for is the canonical expression — read and write', async () => {
  const sql = seeded();
  const handler = createStateHandler({ db: () => sql, sessionAccount: async () => ({ accountId: ACCOUNT_ID }) });
  const headers = { 'x-device-id': ACCOUNT_ID };

  // A GET (the read), then a PUT declaring the base it returned (the guarded write), then a PUT
  // with no base (the create-only write) — all three rev-bearing statements the handler can emit.
  const get = fakeRes();
  await handler(fakeReq({ method: 'GET', headers }), get);
  const put = fakeRes();
  await handler(fakeReq({ method: 'PUT', headers: { ...headers, 'x-state-rev': get.body.rev }, body: { state: SEED } }), put);
  const create = fakeRes();
  await handler(fakeReq({ method: 'PUT', headers, body: { state: SEED } }), create);

  const revBearing = sql.queries.filter((q) => / as rev\b/.test(q.text));
  assert.ok(revBearing.length >= 3, `expected read + both writes to ask for a rev, got ${revBearing.length}`);
  for (const q of revBearing) {
    assert.ok(q.text.includes(sqlText(REV_EXPR)),
      `a rev rendered in a non-canonical expression:\n  ${q.text}`);
  }
  // And the guard itself — the one place the column must be table-qualified.
  const guarded = sql.queries.filter((q) => q.text.includes(' = ?') && / where to_char/.test(q.text));
  assert.ok(guarded.length >= 1, 'the guarded write must have run');
  for (const q of guarded) {
    assert.ok(q.text.includes(sqlText(REV_EXPR_QUALIFIED)),
      `a guard in a non-canonical expression:\n  ${q.text}`);
  }
});

test('R19 CONTROL: the fake REFUSES a rev asked for in any other spelling', async () => {
  const sql = seeded();
  // The exact expression that shipped before this round — explicit format, but no `at time zone`,
  // so the token renders through the session TimeZone GUC. The old fake served this silently.
  await assert.rejects(
    async () => sql`
      select state, updated_at, to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as rev from users
      where id = ${ACCOUNT_ID} and kind = ${'account'}`,
    /NON-CANONICAL/,
    'a divergent rev expression must fail loudly, not be rendered with the fake’s own format');
});

test('R19 CONTROL: the fake REFUSES a guard asked for in any other spelling', async () => {
  const sql = seeded();
  await assert.rejects(
    async () => sql`
      insert into users (kind, id, state, updated_at)
      values (${'account'}, ${ACCOUNT_ID}, ${JSON.stringify(INTRUDER)}::jsonb, now())
      on conflict (kind, id) do update set state = excluded.state, updated_at = now()
      where to_char(users.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') = ${'x'}
      returning updated_at, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as rev`,
    /unrecognised conditional-write guard/,
    'a divergent guard must fail loudly rather than being applied as if it matched');
});
