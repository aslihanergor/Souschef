import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidUid, withinSizeCap, hasUserData, resolveSync } from '../api/_state.js';

// ── isValidUid ─────────────────────────────────────────────────────────────
test('isValidUid accepts a canonical UUID (case-insensitive)', () => {
  assert.equal(isValidUid('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true);
  assert.equal(isValidUid('3F2504E0-4F89-41D3-9A0C-0305E82C3301'), true);
});
test('isValidUid rejects non-UUIDs and non-strings', () => {
  assert.equal(isValidUid('not-a-uuid'), false);
  assert.equal(isValidUid(''), false);
  assert.equal(isValidUid(null), false);
  assert.equal(isValidUid(123), false);
  assert.equal(isValidUid('3f2504e0-4f89-41d3-9a0c-0305e82c330'), false); // one char short
});

// ── withinSizeCap ──────────────────────────────────────────────────────────
test('withinSizeCap is true under the cap, false over it', () => {
  assert.equal(withinSizeCap({ a: 1 }, 1024), true);
  assert.equal(withinSizeCap({ blob: 'x'.repeat(2000) }, 1024), false);
});
test('withinSizeCap: a realistic empty state fits the default cap', () => {
  assert.equal(withinSizeCap({ channels: [], done: [], archive: [] }), true);
});

// ── hasUserData ────────────────────────────────────────────────────────────
test('hasUserData: true when the user has curated something', () => {
  assert.equal(hasUserData({ channels: [{ id: 'c1' }], done: [], archive: [] }), true);
  assert.equal(hasUserData({ done: ['v1'] }), true);
  assert.equal(hasUserData({ archive: [{ id: 'a1' }] }), true);
});
test('hasUserData: prefs-only / empty does not count', () => {
  assert.equal(hasUserData({ channels: [], done: [], archive: [], theme: 'dark' }), false);
  assert.equal(hasUserData({}), false);
  assert.equal(hasUserData(null), false);
});

// ── resolveSync (the claim/merge decision) ─────────────────────────────────
test('resolveSync: no server row → claim local, push when local has data', () => {
  const local = { channels: [{ id: 'c1' }], done: [], archive: [] };
  assert.deepEqual(resolveSync({ local, server: null }), { state: local, push: true });
});
test('resolveSync: no server row + empty local → no push', () => {
  const local = { channels: [], done: [], archive: [] };
  assert.deepEqual(resolveSync({ local, server: null }), { state: local, push: false });
});
test('resolveSync: server row exists → server wins, no push', () => {
  const local = { channels: [{ id: 'c1' }], done: [], archive: [] };
  const server = {
    state: { channels: [{ id: 's1' }], done: ['v'], archive: [] },
    updatedAt: '2026-07-08T00:00:00Z',
  };
  assert.deepEqual(resolveSync({ local, server }), { state: server.state, push: false });
});
test('resolveSync: server row exists but is empty → still server wins (a cleared account)', () => {
  const local = { channels: [{ id: 'c1' }], done: [], archive: [] };
  const server = { state: { channels: [], done: [], archive: [] }, updatedAt: '2026-07-08T00:00:00Z' };
  assert.deepEqual(resolveSync({ local, server }), { state: server.state, push: false });
});
