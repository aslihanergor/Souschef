import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSubscriptions, listSubscriptions } from '../api/_youtube.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = name => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

// ── parseSubscriptions (subscriptions.list item → our { channelId, name, avatarUrl }) ──

test('parseSubscriptions maps resourceId.channelId (the followed channel), NOT snippet.channelId', () => {
  const rs = parseSubscriptions(fx('youtube-subscriptions.json'));
  assert.equal(rs.length, 3);
  assert.deepEqual(rs.map(r => r.channelId),
    ['UCBJycsmduvYEL83R_U4JriQ', 'UCHnyfMqiRRG1u-2MsSQLbXA', 'UCsXVk37bltHxD1rDPwtNM8Q']);
  // snippet.channelId is the SUBSCRIBER's own channel — a classic mis-map. Guard against it.
  assert.ok(!rs.some(r => r.channelId === 'UCsubscriberOwnChannel0000000'));
});

test('parseSubscriptions maps the title and best avatar (high → medium → default)', () => {
  const rs = parseSubscriptions(fx('youtube-subscriptions.json'));
  assert.equal(rs[0].name, 'Marques Brownlee');
  assert.equal(rs[0].avatarUrl, 'https://yt3.ggpht.com/mkbhd=s800-c-k-c0x00ffffff-no-rj'); // high wins
  assert.equal(rs[2].avatarUrl, 'https://yt3.ggpht.com/kurzgesagt=s88');                   // only default present
});

test('parseSubscriptions skips items without a channelId and dedupes within a page', () => {
  const json = { items: [
    { snippet: { title: 'A', resourceId: { channelId: 'UC_A' } } },
    { snippet: { title: 'no resourceId' } },                          // skipped
    { snippet: { title: 'A again', resourceId: { channelId: 'UC_A' } } }, // deduped
  ] };
  assert.deepEqual(parseSubscriptions(json).map(r => r.channelId), ['UC_A']);
});

test('parseSubscriptions returns [] on an empty or malformed response', () => {
  assert.deepEqual(parseSubscriptions({ items: [] }), []);
  assert.deepEqual(parseSubscriptions({}), []);
});

// ── listSubscriptions (paginated fetch with the OAuth access token) ──

// Replays scripted JSON page bodies; records { url, opts } per call.
function scriptedJson(pages) {
  const calls = [];
  let i = 0;
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => pages[i++] };
  };
  impl.calls = calls;
  return impl;
}

test('listSubscriptions follows nextPageToken across pages, aggregating; sends the Bearer token', async () => {
  const page1 = { nextPageToken: 'P2', items: [
    { snippet: { title: 'A', resourceId: { channelId: 'UC_A' } } },
    { snippet: { title: 'B', resourceId: { channelId: 'UC_B' } } },
  ] };
  const page2 = { items: [
    { snippet: { title: 'C', resourceId: { channelId: 'UC_C' } } },
  ] };
  const fetchImpl = scriptedJson([page1, page2]);
  const { channels, truncated } = await listSubscriptions('tok-123', { fetchImpl });
  assert.deepEqual(channels.map(c => c.channelId), ['UC_A', 'UC_B', 'UC_C']);
  assert.equal(truncated, false);
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[1].url, /pageToken=P2/);                       // page 2 carried the token
  assert.equal(fetchImpl.calls[0].opts.headers.Authorization, 'Bearer tok-123');
  assert.match(fetchImpl.calls[0].url, /\/subscriptions\?/);
  assert.match(fetchImpl.calls[0].url, /mine=true/);
});

test('listSubscriptions stops at maxPages and flags truncated', async () => {
  const page = tok => ({ nextPageToken: tok, items: [
    { snippet: { title: tok, resourceId: { channelId: 'UC_' + tok } } },
  ] });
  const fetchImpl = scriptedJson([page('P2'), page('P3'), page('P4')]);
  const { channels, truncated } = await listSubscriptions('tok', { fetchImpl, maxPages: 2 });
  assert.equal(truncated, true);
  assert.equal(fetchImpl.calls.length, 2, 'stopped after maxPages fetches');
  assert.equal(channels.length, 2);
});

test('listSubscriptions dedupes a channel that appears on two pages', async () => {
  const page1 = { nextPageToken: 'P2', items: [{ snippet: { title: 'A', resourceId: { channelId: 'UC_A' } } }] };
  const page2 = { items: [{ snippet: { title: 'A again', resourceId: { channelId: 'UC_A' } } }] };
  const fetchImpl = scriptedJson([page1, page2]);
  const { channels } = await listSubscriptions('tok', { fetchImpl });
  assert.deepEqual(channels.map(c => c.channelId), ['UC_A']);
});

test('listSubscriptions throws on a non-ok response (e.g. 401 expired token)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(listSubscriptions('bad-tok', { fetchImpl }), /401/);
});
