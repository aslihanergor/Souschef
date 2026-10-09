import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseUploads, parseDurations, isoDurationToSeconds, isShort, parseRssFeed, SHORTS_MAX_SECONDS,
} from '../api/_youtube.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx  = f => readFileSync(join(here, 'fixtures', f), 'utf8');
const fxj = f => JSON.parse(fx(f));

// ── playlistItems -> feed items ───────────────────────────────────────────────

test('parseUploads maps playlistItems to { videoId, title, published }', () => {
  const items = parseUploads(fxj('uploads.json'));
  assert.ok(items.length >= 20, `expected >=20 items, got ${items.length}`);
  assert.equal(items[0].videoId, 'LgbyEFILLJI');
  assert.equal(items[0].title, '$1 vs $10,000 Cake');
  assert.match(items[0].published, /^2026-/);
  assert.ok(items.every(i => i.videoId && typeof i.title === 'string'));
});

test('parseUploads returns [] on empty input', () => {
  assert.deepEqual(parseUploads({ items: [] }), []);
  assert.deepEqual(parseUploads({}), []);
});

// ── durations & Shorts classification ─────────────────────────────────────────

test('isoDurationToSeconds parses ISO 8601 durations', () => {
  assert.equal(isoDurationToSeconds('PT49S'), 49);
  assert.equal(isoDurationToSeconds('PT3M'), 180);
  assert.equal(isoDurationToSeconds('PT1H2M3S'), 3723);
  assert.equal(isoDurationToSeconds('PT35M1S'), 2101);
  assert.equal(isoDurationToSeconds('nonsense'), null);
});

test('parseDurations maps videos.list to { videoId: seconds }', () => {
  const d = parseDurations(fxj('videos.json'));
  assert.equal(d['LgbyEFILLJI'], 49);
  assert.ok(Object.keys(d).length >= 20);
});

test('isShort classifies by the threshold (<=180s)', () => {
  assert.equal(isShort(49), true);
  assert.equal(isShort(SHORTS_MAX_SECONDS), true);
  assert.equal(isShort(SHORTS_MAX_SECONDS + 1), false);
  assert.equal(isShort(2101), false);
  assert.equal(isShort(null), false);
});

// ── RSS fallback parsing + /shorts/ detection ─────────────────────────────────

test('parseRssFeed extracts items and detects Shorts via the /shorts/ link', () => {
  const items = parseRssFeed(fx('rss-feed.xml'));
  assert.ok(items.length >= 12, `expected >=12 entries, got ${items.length}`);
  assert.equal(items[0].videoId, 'LgbyEFILLJI');
  assert.equal(items[0].title, '$1 vs $10,000 Cake');
  assert.equal(items[0].isShort, true);
  assert.ok(items.filter(i => i.isShort).length >= 8, 'expected several Shorts');
  assert.ok(items.some(i => i.isShort === false), 'expected at least one non-Short');
});

test('parseRssFeed returns [] on empty/garbage', () => {
  assert.deepEqual(parseRssFeed(''), []);
  assert.deepEqual(parseRssFeed('<feed></feed>'), []);
});
