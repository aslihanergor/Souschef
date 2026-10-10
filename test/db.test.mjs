// Pure helpers that answer "which database am I about to touch?". The danger they
// guard against isn't a bug in a query — it's a correct query run against the wrong database.
// Nothing here connects; these are string functions over a connection URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbHost, isProductionDb, resolveDatabaseUrl, PRODUCTION_DB_ENDPOINT } from '../api/_db.js';

const PROD_POOLED = `postgresql://u:p@${PRODUCTION_DB_ENDPOINT}-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require`;
const PROD_DIRECT = `postgresql://u:p@${PRODUCTION_DB_ENDPOINT}.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require`;
const BRANCH = 'postgresql://u:p@ep-dev-branch-000000-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

test('dbHost extracts the host, never the credentials', () => {
  assert.equal(dbHost(BRANCH), 'ep-dev-branch-000000-pooler.c-9.us-east-1.aws.neon.tech');
  assert.equal(dbHost(PROD_DIRECT), `${PRODUCTION_DB_ENDPOINT}.c-9.us-east-1.aws.neon.tech`);
  // the password must not survive into anything we print
  assert.ok(!dbHost(BRANCH).includes('p@'));
  assert.ok(!dbHost(BRANCH).includes(':p'));
});

test('dbHost returns null for junk rather than throwing', () => {
  assert.equal(dbHost(undefined), null);
  assert.equal(dbHost(''), null);
  assert.equal(dbHost('not a url'), null);
  assert.equal(dbHost(42), null);
});

test('isProductionDb recognises prod on BOTH the pooled and unpooled endpoint', () => {
  assert.equal(isProductionDb(PROD_POOLED), true);
  assert.equal(isProductionDb(PROD_DIRECT), true);
});

test('isProductionDb says false for a branch, and for nothing at all', () => {
  assert.equal(isProductionDb(BRANCH), false);
  assert.equal(isProductionDb(undefined), false);
  assert.equal(isProductionDb(''), false);
  assert.equal(isProductionDb(42), false);
});

// resolveDatabaseUrl. The Neon integration OWNS `DATABASE_URL` and points every Vercel
// environment at production; Vercel makes integration-managed vars read-only, so we can't repoint it
// per environment. Instead we own `DEV_DATABASE_URL` and prefer it — except in production, where
// honouring it would be a *worse* bug than the one we're fixing (prod writing to a dev branch).
test('resolveDatabaseUrl prefers DEV_DATABASE_URL when it is set', () => {
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: PROD_POOLED, DEV_DATABASE_URL: BRANCH }), BRANCH);
});

test('resolveDatabaseUrl falls back to DATABASE_URL when no override is set', () => {
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: PROD_POOLED }), PROD_POOLED);
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: PROD_POOLED, DEV_DATABASE_URL: '' }), PROD_POOLED);
});

// The load-bearing test: production must ignore the override even if someone sets it by mistake.
test('resolveDatabaseUrl IGNORES the override when VERCEL_ENV is production', () => {
  assert.equal(
    resolveDatabaseUrl({ VERCEL_ENV: 'production', DATABASE_URL: PROD_POOLED, DEV_DATABASE_URL: BRANCH }),
    PROD_POOLED,
  );
});

test('resolveDatabaseUrl honours the override on preview and on a plain local shell', () => {
  assert.equal(resolveDatabaseUrl({ VERCEL_ENV: 'preview', DATABASE_URL: PROD_POOLED, DEV_DATABASE_URL: BRANCH }), BRANCH);
  assert.equal(resolveDatabaseUrl({ VERCEL_ENV: 'development', DATABASE_URL: PROD_POOLED, DEV_DATABASE_URL: BRANCH }), BRANCH);
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: PROD_POOLED, DEV_DATABASE_URL: BRANCH }), BRANCH); // no VERCEL_ENV
});

test('resolveDatabaseUrl returns null when nothing is configured', () => {
  assert.equal(resolveDatabaseUrl({}), null);
  assert.equal(resolveDatabaseUrl({ VERCEL_ENV: 'production' }), null);
});

// The failure mode this exists to prevent: "unset" must never read as "safe to migrate".
// It reads as false above, so callers must check for a *missing* URL separately — which
// init-db.mjs does (it exits when DATABASE_URL is unset).
test('an unset URL is not production, but is also not a valid target', () => {
  assert.equal(isProductionDb(process.env.DEFINITELY_UNSET_VAR), false);
  assert.equal(dbHost(process.env.DEFINITELY_UNSET_VAR), null);
});

// scriptDatabaseTarget. A mutating script's `--prod` must SELECT production, not merely
// permit it: resolveDatabaseUrl() prefers DEV_DATABASE_URL on any laptop, so a guard built on it sent
// `--prod` to the dev branch with a normal-looking banner. Expected values are the fixture strings themselves, never computed through _db.js.
const PROD_HOST = `${PRODUCTION_DB_ENDPOINT}-pooler.c-9.us-east-1.aws.neon.tech`;
const BRANCH_HOST = 'ep-dev-branch-000000-pooler.c-9.us-east-1.aws.neon.tech';

test('CHR-016 c1: --prod targets DATABASE_URL even when DEV_DATABASE_URL is set', async () => {
  const { scriptDatabaseTarget } = await import('../api/_db.js');
  const t = scriptDatabaseTarget({ prod: true, env: { DATABASE_URL: PROD_POOLED, DEV_DATABASE_URL: BRANCH } });
  assert.equal(t.error, undefined);
  assert.equal(t.url, PROD_POOLED);
  assert.equal(t.host, PROD_HOST);
  assert.equal(t.isProd, true);
});

test('CHR-016 c2: --prod refuses a DATABASE_URL that is not production, and returns no URL', async () => {
  const { scriptDatabaseTarget } = await import('../api/_db.js');
  const t = scriptDatabaseTarget({ prod: true, env: { DATABASE_URL: BRANCH, DEV_DATABASE_URL: PROD_POOLED } });
  assert.equal(t.url, undefined);
  assert.match(t.error, /--prod/);
  assert.ok(t.error.includes(BRANCH_HOST), t.error);
});

test('CHR-016 c3: without --prod, a production target is refused (the TASK-064 guard kept)', async () => {
  const { scriptDatabaseTarget } = await import('../api/_db.js');
  const t = scriptDatabaseTarget({ prod: false, env: { DATABASE_URL: PROD_POOLED } });
  assert.equal(t.url, undefined);
  assert.match(t.error, /PRODUCTION/);
  assert.ok(t.error.includes(PROD_HOST), t.error);
});

test('CHR-016 c4: without --prod, the dev branch wins when both URLs are set', async () => {
  const { scriptDatabaseTarget } = await import('../api/_db.js');
  const t = scriptDatabaseTarget({ prod: false, env: { DATABASE_URL: PROD_POOLED, DEV_DATABASE_URL: BRANCH } });
  assert.equal(t.error, undefined);
  assert.equal(t.url, BRANCH);
  assert.equal(t.host, BRANCH_HOST);
  assert.equal(t.isProd, false);
});

test('CHR-016 c5: no URL at all is refused in both modes', async () => {
  const { scriptDatabaseTarget } = await import('../api/_db.js');
  for (const prod of [true, false]) {
    // DEV_DATABASE_URL alone must not satisfy --prod: production is DATABASE_URL or nothing.
    const t = scriptDatabaseTarget({ prod, env: prod ? { DEV_DATABASE_URL: BRANCH } : {} });
    assert.equal(t.url, undefined, `prod=${prod}`);
    assert.match(t.error, /No database configured/, `prod=${prod}`);
  }
});
