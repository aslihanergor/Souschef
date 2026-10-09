// Pure event-helper tests (TASK-070 analytics ingestion). Zero-dep node:test.
// Covers the validation/normalization that guards the hot /api/state PUT path and the
// owner (admin) gate. The DB write + client wiring are live-verified, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEvent, sanitizeEvents, clampTs, isOwner,
  MAX_EVENTS_PER_BATCH,
} from '../api/_events.js';

const NOW = 1_700_000_000_000; // fixed clock so timestamp assertions are deterministic

test('normalizeEvent keeps an allowlisted event verbatim', () => {
  const e = normalizeEvent({ name: 'mark_done', section: 'feed', props: { count: 3 }, ts: NOW }, NOW);
  // `id: null` is [BUG-123]'s added field, not a loosened assertion: an event carries an identity so a
  // re-send can be told from a second real action, and an input with none says so explicitly. The four
  // fields this test exists for still pass through untouched. Changed with Asli's decision, asked as A
  // (edit this assertion) or B (omit the key when null) — Asli, 2026-09-16: "A".
  assert.deepEqual(e, { name: 'mark_done', section: 'feed', props: { count: 3 }, ts: NOW, id: null });
});

test('normalizeEvent drops an unknown (non-allowlisted) event name', () => {
  assert.equal(normalizeEvent({ name: 'evil_hack', ts: NOW }, NOW), null);
});

test('normalizeEvent drops non-objects', () => {
  assert.equal(normalizeEvent(null, NOW), null);
  assert.equal(normalizeEvent('signin', NOW), null);
  assert.equal(normalizeEvent(42, NOW), null);
});

test('normalizeEvent coerces a missing props/section/ts', () => {
  const e = normalizeEvent({ name: 'refresh' }, NOW);
  assert.deepEqual(e.props, {});
  assert.equal(e.section, null);
  assert.equal(e.ts, NOW); // missing ts → now
});

test('normalizeEvent drops an array or non-object props to {}', () => {
  assert.deepEqual(normalizeEvent({ name: 'view', props: [1, 2], ts: NOW }, NOW).props, {});
  assert.deepEqual(normalizeEvent({ name: 'view', props: 'x', ts: NOW }, NOW).props, {});
});

test('normalizeEvent empties an oversized props (no content leak via a giant blob)', () => {
  const big = { blob: 'x'.repeat(2000) };
  const e = normalizeEvent({ name: 'view', props: big, ts: NOW }, NOW);
  assert.deepEqual(e.props, {});
});

test('normalizeEvent clamps a long section string', () => {
  const e = normalizeEvent({ name: 'view', section: 'a'.repeat(500), ts: NOW }, NOW);
  assert.equal(e.section.length, 120);
});

test('clampTs keeps an in-window client timestamp', () => {
  const t = NOW - 1000;
  assert.equal(clampTs(t, NOW), t);
});

test('clampTs rejects a far-future timestamp (clock skew / spoof)', () => {
  assert.equal(clampTs(NOW + 60 * 60 * 1000, NOW), NOW); // 1h ahead → now
});

test('clampTs rejects a far-past timestamp', () => {
  assert.equal(clampTs(NOW - 60 * 24 * 3600 * 1000, NOW), NOW); // 60d ago → now
});

test('clampTs falls back to now for a non-numeric ts', () => {
  assert.equal(clampTs('nope', NOW), NOW);
  assert.equal(clampTs(undefined, NOW), NOW);
});

test('sanitizeEvents rejects non-array input', () => {
  assert.deepEqual(sanitizeEvents(null, NOW), []);
  assert.deepEqual(sanitizeEvents({ name: 'refresh' }, NOW), []);
});

test('sanitizeEvents filters unknowns and junk, keeps the good ones', () => {
  const out = sanitizeEvents([{ name: 'refresh', ts: NOW }, { name: 'bad' }, 'x', null], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'refresh');
});

test('sanitizeEvents caps the batch size (abuse guard on the hot path)', () => {
  const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 50 }, () => ({ name: 'refresh', ts: NOW }));
  assert.equal(sanitizeEvents(many, NOW).length, MAX_EVENTS_PER_BATCH);
});

test('isOwner matches case-insensitively and trims', () => {
  assert.equal(isOwner('Me@Example.com', 'me@example.com'), true);
  assert.equal(isOwner(' me@example.com ', 'me@example.com'), true);
});

test('isOwner rejects a non-owner and any blank', () => {
  assert.equal(isOwner('other@example.com', 'me@example.com'), false);
  assert.equal(isOwner('', 'me@example.com'), false);
  assert.equal(isOwner('me@example.com', ''), false);
  assert.equal(isOwner(null, null), false);
});
