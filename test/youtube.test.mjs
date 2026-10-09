import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ytFetch, isTransient, fetchRssXml, parseChannelResult, parseSearchResults } from '../api/_youtube.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = name => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

// ── parseChannelResult (channels.list — id/handle lookups) ────────────────────

test('parseChannelResult maps a channels.list item (by handle) to our shape', () => {
  const r = parseChannelResult(fx('channels-by-handle.json'));
  assert.equal(r.channelId, 'UCBJycsmduvYEL83R_U4JriQ');
  assert.equal(r.name, 'Marques Brownlee');
  assert.match(r.avatarUrl, /^https:\/\/yt3\.ggpht\.com\//);
});

test('parseChannelResult works the same for a by-id lookup', () => {
  const r = parseChannelResult(fx('channels-by-id.json'));
  assert.equal(r.channelId, 'UCBJycsmduvYEL83R_U4JriQ');
  assert.equal(r.name, 'Marques Brownlee');
});

test('parseChannelResult returns null when there are no items', () => {
  assert.equal(parseChannelResult({ items: [] }), null);
  assert.equal(parseChannelResult({}), null);
});

// ── parseSearchResults (search.list — plain-name lookups + alternatives) ──────

test('parseSearchResults maps search.list items, top result first', () => {
  const rs = parseSearchResults(fx('search-channel.json'));
  assert.equal(rs.length, 5);
  assert.equal(rs[0].channelId, 'UCBJycsmduvYEL83R_U4JriQ');
  assert.equal(rs[0].name, 'Marques Brownlee');
  assert.ok(rs.every(r => /^https:\/\/yt3\.ggpht\.com\//.test(r.avatarUrl)));
  assert.deepEqual(rs.map(r => r.name),
    ['Marques Brownlee', 'WVFRM Podcast', 'Auto Focus', 'The Studio', 'MKBHD Shorts']);
});

test('parseSearchResults respects the limit', () => {
  assert.equal(parseSearchResults(fx('search-channel.json'), 3).length, 3);
});

test('parseSearchResults returns [] when there are no items', () => {
  assert.deepEqual(parseSearchResults({ items: [] }), []);
  assert.deepEqual(parseSearchResults({}), []);
});

// ── ytFetch fallback trigger ──────────────────────────────────────────────────

test('ytFetch returns null when no API key is set (so the resolver falls back to scraping)', async () => {
  const saved = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  try {
    assert.equal(await ytFetch('channels', { id: 'UCBJycsmduvYEL83R_U4JriQ' }), null);
  } finally {
    if (saved !== undefined) process.env.YOUTUBE_API_KEY = saved;
  }
});

// ── ytFetch / fetchRssXml resilience: retry-with-backoff (BUG-004) ────────────
// The feed is Data-API-primary with an RSS fallback. A transient blip (429 rate-limit,
// 5xx, network error / timeout) shouldn't drop a channel on the first miss — retry with
// backoff. But a 403 is YouTube's REAL quota-exceeded answer: retrying just burns the
// deadline, so fail fast to the fallback. ytFetch keeps its null-on-failure contract (that's
// what triggers the fallback) and warns the status so a prod outage isn't diagnosed blind.
// Injected { fetchImpl, sleep, warn } drive these branches deterministically.

// Fake fetch replaying scripted outcomes: { status, json } / { status, text } (Response-like)
// or an Error (network failure / timeout — thrown). Records URLs; throws on an extra call.
function scriptedFetch(outcomes) {
  const calls = [];
  let i = 0;
  const impl = async (url) => {
    calls.push(url);
    if (i >= outcomes.length) throw new Error(`unexpected extra fetch (call #${calls.length})`);
    const o = outcomes[i++];
    if (o instanceof Error) throw o;
    return {
      ok: o.status >= 200 && o.status < 300,
      status: o.status,
      json: async () => o.json,
      text: async () => o.text,
    };
  };
  impl.calls = calls;
  return impl;
}

function recordingSleep() {
  const waits = [];
  const sleep = async ms => { waits.push(ms); };
  sleep.waits = waits;
  return sleep;
}

function recordingWarn() {
  const calls = [];
  const warn = (...a) => { calls.push(a.join(' ')); };
  warn.calls = calls;
  return warn;
}

test('isTransient (YouTube): 429 + 5xx are transient; 403 / other 4xx are real answers', () => {
  for (const s of [429, 500, 502, 503]) assert.equal(isTransient(s), true, `${s} should be transient`);
  for (const s of [400, 401, 403, 404]) assert.equal(isTransient(s), false, `${s} should be terminal`);
});

test('ytFetch retries a transient 503, then returns the JSON', async () => {
  process.env.YOUTUBE_API_KEY = 'test-key';
  const fetchImpl = scriptedFetch([{ status: 503 }, { status: 200, json: { items: [1] } }]);
  const sleep = recordingSleep(); const warn = recordingWarn();
  const out = await ytFetch('channels', { id: 'x' }, { fetchImpl, sleep, warn });
  assert.deepEqual(out, { items: [1] });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(sleep.waits.length, 1, 'one backoff between attempts');
  assert.equal(warn.calls.length, 0, 'no warn on eventual success');
});

test('ytFetch retries a 429 rate-limit (transient for YouTube), then returns the JSON', async () => {
  process.env.YOUTUBE_API_KEY = 'test-key';
  const fetchImpl = scriptedFetch([{ status: 429 }, { status: 200, json: { ok: true } }]);
  const sleep = recordingSleep(); const warn = recordingWarn();
  const out = await ytFetch('search', {}, { fetchImpl, sleep, warn });
  assert.deepEqual(out, { ok: true });
  assert.equal(fetchImpl.calls.length, 2);
});

test('ytFetch does NOT retry a 403 (quota is real): one call, returns null, warns the status', async () => {
  process.env.YOUTUBE_API_KEY = 'test-key';
  const fetchImpl = scriptedFetch([{ status: 403 }]);
  const sleep = recordingSleep(); const warn = recordingWarn();
  const out = await ytFetch('channels', { id: 'x' }, { fetchImpl, sleep, warn });
  assert.equal(out, null, 'null so the caller falls back to scraping/RSS');
  assert.equal(fetchImpl.calls.length, 1, 'no retry — straight to fallback');
  assert.equal(sleep.waits.length, 0);
  assert.equal(warn.calls.length, 1);
  assert.match(warn.calls[0], /403/);
});

test('ytFetch treats a network error / timeout as transient and retries', async () => {
  process.env.YOUTUBE_API_KEY = 'test-key';
  const fetchImpl = scriptedFetch([new Error('ETIMEDOUT'), { status: 200, json: { ok: 1 } }]);
  const sleep = recordingSleep(); const warn = recordingWarn();
  const out = await ytFetch('channels', {}, { fetchImpl, sleep, warn });
  assert.deepEqual(out, { ok: 1 });
  assert.equal(fetchImpl.calls.length, 2);
});

test('ytFetch returns null after exhausting retries on persistent 5xx, and warns', async () => {
  process.env.YOUTUBE_API_KEY = 'test-key';
  const fetchImpl = scriptedFetch([{ status: 502 }, { status: 502 }, { status: 502 }]);
  const sleep = recordingSleep(); const warn = recordingWarn();
  const out = await ytFetch('channels', {}, { fetchImpl, sleep, warn });
  assert.equal(out, null);
  assert.equal(fetchImpl.calls.length, 3, '1 initial + 2 retries');
  assert.equal(warn.calls.length, 1);
  assert.match(warn.calls[0], /502/);
});

test('fetchRssXml retries a failed RSS fetch once, then returns the xml (last line of defense)', async () => {
  const fetchImpl = scriptedFetch([{ status: 502 }, { status: 200, text: '<feed>ok</feed>' }]);
  const sleep = recordingSleep();
  const xml = await fetchRssXml('UC123', { fetchImpl, sleep });
  assert.equal(xml, '<feed>ok</feed>');
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(sleep.waits.length, 1);
});

test('fetchRssXml returns null when every RSS attempt fails', async () => {
  const fetchImpl = scriptedFetch([{ status: 502 }, { status: 502 }]);
  const sleep = recordingSleep();
  assert.equal(await fetchRssXml('UC123', { fetchImpl, sleep }), null);
  assert.equal(fetchImpl.calls.length, 2, '1 initial + 1 retry');
});
