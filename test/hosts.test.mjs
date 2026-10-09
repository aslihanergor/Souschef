import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isYouTubeHost, isSafePublicHost } from '../api/_hosts.js';

// One shared decision about whether a hostname is safe to fetch server-side (BUG-020). The four
// call sites previously each had their own copy and disagreed; this is the single source.

// ── isYouTubeHost — EXACT match, not a suffix ────────────────────────────────
// `hostname.endsWith('youtube.com')` also matches notyoutube.com, which let the resolver fetch an
// attacker host (BUG-020 vector 1). The rule is: the host IS youtube.com or ends with .youtube.com.

test('isYouTubeHost accepts youtube.com and real subdomains', () => {
  for (const h of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']) {
    assert.equal(isYouTubeHost(h), true, h);
  }
});

test('isYouTubeHost rejects look-alike and suffixed hosts', () => {
  for (const h of ['notyoutube.com', 'evil-youtube.com', 'youtube.com.attacker.tld', 'youtube.evil.com', 'youtubexcom', '', null, undefined]) {
    assert.equal(isYouTubeHost(h), false, String(h));
  }
});

// ── isSafePublicHost — a dotted public host, never an IP literal / localhost ──
// (BUG-020 vector 2). CONTRACT: callers pass the NORMALISED hostname (new URL(...).hostname). The
// function does not itself defend against short-form IPs like 127.1 — new URL() collapses those to
// 127.0.0.1 first, and that normalisation is asserted at the substackFeedUrl integration level.

test('isSafePublicHost accepts real dotted public hosts', () => {
  for (const h of ['astralcodexten.substack.com', 'www.slowboring.com', 'example.co.uk', 'chamath.substack.com']) {
    assert.equal(isSafePublicHost(h), true, h);
  }
});

test('isSafePublicHost rejects IPv4 literals, localhost, IPv6 and non-hosts', () => {
  for (const h of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.1.1', 'localhost', 'foo.localhost', '[::1]', '', 'nodot', null, undefined]) {
    assert.equal(isSafePublicHost(h), false, String(h));
  }
});

// Documents the contract above: a normalised loopback IS rejected; the short form is only caught
// once new URL() has expanded it (see substack.test.mjs).
test('isSafePublicHost rejects a normalised loopback but not the raw short form', () => {
  assert.equal(isSafePublicHost('127.0.0.1'), false);
  assert.equal(isSafePublicHost('127.1'), true, 'short form passes — callers MUST normalise first');
});
