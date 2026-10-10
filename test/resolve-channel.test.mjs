import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeUrl, buildCandidates } from '../api/resolve-channel.js';

// resolve-channel.js fetches the URL buildCandidates() returns. Two holes: a
// youtube.com SUFFIX match that also accepts notyoutube.com, and fetching the RAW input URL (attacker
// host/port/path). The endpoint is signed-in only — the handler's own tests, including the
// refusals, are in test/signed-in-gate.test.mjs.

// ── parseYouTubeUrl — used by the API path to pull an id/@handle out of a URL ──

test('parseYouTubeUrl extracts a channel id and @handle from real youtube URLs', () => {
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ'), { id: 'UCBJycsmduvYEL83R_U4JriQ' });
  assert.deepEqual(parseYouTubeUrl('https://youtube.com/@NASA'), { handle: '@NASA' });
  assert.deepEqual(parseYouTubeUrl('https://m.youtube.com/@NASA'), { handle: '@NASA' });
});

test('parseYouTubeUrl rejects look-alike hosts (no more endsWith bypass)', () => {
  for (const u of ['https://notyoutube.com/channel/UCBJycsmduvYEL83R_U4JriQ', 'https://evil-youtube.com/@NASA', 'https://youtube.com.attacker.tld/@NASA']) {
    assert.equal(parseYouTubeUrl(u), null, u);
  }
});

// ── buildCandidates — returns the URL(s) the scrape path will FETCH ──

test('buildCandidates rejects look-alike hosts (empty → no fetch)', () => {
  for (const u of ['https://notyoutube.com/@NASA', 'https://evil-youtube.com/channel/UC', 'https://169.254.169.254/']) {
    assert.deepEqual(buildCandidates(u), [], u);
  }
});

test('buildCandidates rebuilds the fetch URL from host+path, dropping attacker port/query', () => {
  // A youtube host with an unexpected port and query must not be fetched verbatim.
  assert.deepEqual(buildCandidates('https://www.youtube.com:8080/@handle?x=1'), ['https://www.youtube.com/@handle']);
  // A plain channel URL is unchanged.
  assert.deepEqual(buildCandidates('https://www.youtube.com/@NASA'), ['https://www.youtube.com/@NASA']);
});

test('buildCandidates still handles UC-ids and @handles directly', () => {
  assert.deepEqual(buildCandidates('UCBJycsmduvYEL83R_U4JriQ'), ['https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ']);
  assert.deepEqual(buildCandidates('@NASA'), ['https://www.youtube.com/@NASA']);
  assert.deepEqual(buildCandidates('some display name'), []); // plain name → search path, not a guess
});
