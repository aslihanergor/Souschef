// Transient handoff store for Connect-YouTube import. Security-sensitive bits — only
// the token *hash* is stored, reads are single-use, expired rows are refused — so they get unit
// tests with an injected fake `sql` (the DB itself is verified live).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken } from '../api/_auth.js';
import { stashImport, consumeImport } from '../api/_youtube_import.js';

// Minimal tagged-template stand-in for the neon `sql` runner: routes by the leading keyword,
// records calls, returns whatever the handler yields.
function fakeSql(handler = () => []) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(' ? ').replace(/\s+/g, ' ').trim().toLowerCase();
    calls.push({ text, values });
    return handler(text, values) || [];
  };
  sql.calls = calls;
  return sql;
}

test('stashImport persists the token HASH (never the raw token) + the list, and returns the raw token', async () => {
  let insertVals = null;
  const sql = fakeSql((text, values) => { if (text.startsWith('insert')) insertVals = values; return []; });
  const token = await stashImport(sql, [{ channelId: 'UC_A', name: 'A' }]);
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);
  // insert values → [token_hash, subscriptionsJson, expiresAt]
  assert.equal(insertVals[0], hashToken(token), 'stores the sha256, not the raw token');
  assert.notEqual(insertVals[0], token);
  assert.match(insertVals[1], /UC_A/, 'list serialized to JSON');
});

test('stashImport sweeps expired rows before inserting', async () => {
  const sql = fakeSql();
  await stashImport(sql, []);
  assert.ok(sql.calls.some(c => c.text.startsWith('delete from youtube_imports where expires_at')),
    'runs an expiry sweep');
});

test('consumeImport returns the list and deletes the row (single-use)', async () => {
  const sql = fakeSql(text => text.startsWith('delete from youtube_imports where token_hash')
    ? [{ subscriptions: [{ channelId: 'UC_A' }], expires_at: new Date(Date.now() + 60000).toISOString() }]
    : []);
  const out = await consumeImport(sql, 'raw-token');
  assert.deepEqual(out, [{ channelId: 'UC_A' }]);
  assert.ok(sql.calls.some(c => c.text.includes('delete from youtube_imports where token_hash')));
});

test('consumeImport returns null for an unknown token', async () => {
  assert.equal(await consumeImport(fakeSql(() => []), 'nope'), null);
});

test('consumeImport returns null for an expired row', async () => {
  const sql = fakeSql(() => [{ subscriptions: [{ channelId: 'UC_A' }], expires_at: new Date(Date.now() - 1000).toISOString() }]);
  assert.equal(await consumeImport(sql, 'raw'), null);
});

test('consumeImport short-circuits on a falsy token without querying', async () => {
  const sql = fakeSql(() => { throw new Error('should not query'); });
  assert.equal(await consumeImport(sql, ''), null);
  assert.equal(sql.calls.length, 0);
});
