import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_COOKIE,
  TOKEN_TTL_MS,
  SESSION_TTL_MS,
  RATE_LIMIT_MAX_PER_EMAIL,
  RATE_LIMIT_MAX_PER_IP,
  normalizeEmail,
  isValidEmail,
  generateToken,
  hashToken,
  isExpired,
  withinRateLimit,
  parseCookies,
  readSessionToken,
  serializeSessionCookie,
  clearSessionCookie,
  clientIp,
  isSecureRequest,
  requestBaseUrl,
} from '../api/_auth.js';

// ── email ───────────────────────────────────────────────────────────────────
test('isValidEmail: accepts sane addresses, rejects junk', () => {
  assert.equal(isValidEmail('a@b.co'), true);
  assert.equal(isValidEmail('first.last+focus@example.com'), true);
  assert.equal(isValidEmail('no-at-sign'), false);
  assert.equal(isValidEmail('no@domain'), false); // no dot in domain
  assert.equal(isValidEmail('spaces @b.co'), false);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail(null), false);
  assert.equal(isValidEmail(123), false);
});
test('normalizeEmail: trims + lowercases valid, returns null for junk', () => {
  assert.equal(normalizeEmail('  ALICE@Example.COM '), 'alice@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail(null), null);
});

// ── token gen + hash ──────────────────────────────────────────────────────────
test('hashToken: stable sha256 hex (known-answer for "abc")', () => {
  assert.equal(
    hashToken('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});
test('generateToken: returns {token, hash} where hash === sha256(token)', () => {
  const a = generateToken();
  assert.equal(typeof a.token, 'string');
  assert.ok(a.token.length >= 32); // 32 random bytes, base64url ≈ 43 chars
  assert.equal(a.hash, hashToken(a.token));
});
test('generateToken: two calls produce different tokens', () => {
  assert.notEqual(generateToken().token, generateToken().token);
});

// ── expiry ────────────────────────────────────────────────────────────────────
test('isExpired: past → true, future → false (now is injectable)', () => {
  const now = 1_000_000;
  assert.equal(isExpired(now - 1, now), true);
  assert.equal(isExpired(now + 1, now), false);
  assert.equal(isExpired(new Date(now - 1), now), true); // Date accepted
  assert.equal(isExpired(new Date(now + 1).toISOString(), now), false); // ISO string accepted
});
test('TTL constants are sane (15 min token, 30 day session)', () => {
  assert.equal(TOKEN_TTL_MS, 15 * 60 * 1000);
  assert.equal(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
});

// ── rate limit decision ───────────────────────────────────────────────────────
test('withinRateLimit: allows under the cap, denies at/over it', () => {
  assert.equal(withinRateLimit(0, 3), true);
  assert.equal(withinRateLimit(2, 3), true);
  assert.equal(withinRateLimit(3, 3), false);
  assert.equal(withinRateLimit(4, 3), false);
});
test('rate-limit caps exist (per-email tighter than per-IP)', () => {
  assert.ok(RATE_LIMIT_MAX_PER_EMAIL >= 1);
  assert.ok(RATE_LIMIT_MAX_PER_IP >= RATE_LIMIT_MAX_PER_EMAIL);
});

// ── cookies ───────────────────────────────────────────────────────────────────
test('serializeSessionCookie: httpOnly + SameSite=Lax + Path=/ + Max-Age; Secure by default', () => {
  const c = serializeSessionCookie('abc123', { maxAgeSeconds: 100 });
  assert.ok(c.startsWith(`${SESSION_COOKIE}=abc123`));
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=100/);
  assert.match(c, /Secure/);
});
test('serializeSessionCookie: Secure omitted when secure:false (local http)', () => {
  const c = serializeSessionCookie('abc123', { maxAgeSeconds: 100, secure: false });
  assert.doesNotMatch(c, /Secure/);
});
test('clearSessionCookie: Max-Age=0 to expire it', () => {
  assert.match(clearSessionCookie(), /Max-Age=0/);
});
test('parseCookies + readSessionToken: pull the session value out of a Cookie header', () => {
  const header = `theme=dark; ${SESSION_COOKIE}=sess-token-xyz; other=1`;
  assert.deepEqual(parseCookies(header), {
    theme: 'dark',
    [SESSION_COOKIE]: 'sess-token-xyz',
    other: '1',
  });
  assert.equal(readSessionToken(header), 'sess-token-xyz');
});
test('readSessionToken: null when absent or header missing', () => {
  assert.equal(readSessionToken('theme=dark'), null);
  assert.equal(readSessionToken(''), null);
  assert.equal(readSessionToken(undefined), null);
});

// ── request-header helpers (proxy-aware) ──────────────────────────────────────
test('clientIp: first hop of x-forwarded-for, else "unknown"', () => {
  assert.equal(clientIp({ 'x-forwarded-for': '203.0.113.4, 198.51.100.8' }), '203.0.113.4');
  assert.equal(clientIp({ 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9');
  assert.equal(clientIp({}), 'unknown');
  assert.equal(clientIp(), 'unknown');
});
// The per-IP sign-in limit keys on clientIp. Any client can send x-forwarded-for, so Vercel's own
// x-vercel-forwarded-for is read first (documented as identical, except that x-forwarded-for can be overwritten by
// a proxy on top). x-forwarded-for stays as the fallback so localhost, which has no Vercel header, keeps working.
// Not covered here: api/auth/request.js has no test, so nothing in the suite notices if the per-IP count or the insert
// stops keying on clientIp(req.headers). It was checked once, live,
// by a localhost cap check (11 requests with one x-vercel-forwarded-for stored 10 rows).
test('clientIp (BUG-022): x-vercel-forwarded-for wins over x-forwarded-for', () => {
  assert.equal(clientIp({ 'x-vercel-forwarded-for': '198.51.100.9', 'x-forwarded-for': '203.0.113.7' }), '198.51.100.9');
});
test('clientIp (BUG-022): no x-forwarded-for value changes the result while x-vercel-forwarded-for is present', () => {
  const vercel = { 'x-vercel-forwarded-for': '198.51.100.9' };
  assert.equal(clientIp({ ...vercel }), '198.51.100.9');
  assert.equal(clientIp({ ...vercel, 'x-forwarded-for': '203.0.113.7' }), '198.51.100.9');
  assert.equal(clientIp({ ...vercel, 'x-forwarded-for': '203.0.113.7, 192.0.2.1' }), '198.51.100.9');
  assert.equal(clientIp({ ...vercel, 'x-forwarded-for': '  203.0.113.7  ' }), '198.51.100.9');
});
test('clientIp (BUG-022): an x-vercel-forwarded-for list gives its first entry, trimmed', () => {
  assert.equal(clientIp({ 'x-vercel-forwarded-for': ' 198.51.100.9, 203.0.113.7' }), '198.51.100.9');
  assert.equal(clientIp({ 'x-vercel-forwarded-for': '198.51.100.9 , 203.0.113.7' }), '198.51.100.9');
  assert.equal(clientIp({ 'x-vercel-forwarded-for': '198.51.100.9,203.0.113.7' }), '198.51.100.9');
});
test('clientIp (BUG-022): an empty or whitespace-only x-vercel-forwarded-for falls back to x-forwarded-for', () => {
  assert.equal(clientIp({ 'x-vercel-forwarded-for': '', 'x-forwarded-for': '203.0.113.7, 192.0.2.1' }), '203.0.113.7');
  assert.equal(clientIp({ 'x-vercel-forwarded-for': '   ', 'x-forwarded-for': '203.0.113.7, 192.0.2.1' }), '203.0.113.7');
});
test('clientIp (BUG-022): an absent or non-string x-vercel-forwarded-for falls back, else "unknown"', () => {
  assert.equal(clientIp({ 'x-forwarded-for': '203.0.113.7, 192.0.2.1' }), '203.0.113.7');
  assert.equal(clientIp({ 'x-vercel-forwarded-for': ['198.51.100.9'], 'x-forwarded-for': '203.0.113.7' }), '203.0.113.7');
  assert.equal(clientIp({ 'x-vercel-forwarded-for': ['198.51.100.9'] }), 'unknown');
});
test('clientIp (BUG-022): the x-forwarded-for fallback trims its first entry and reads an empty header as "unknown"', () => {
  assert.equal(clientIp({ 'x-forwarded-for': '203.0.113.7 , 192.0.2.1' }), '203.0.113.7');
  assert.equal(clientIp({ 'x-forwarded-for': '' }), 'unknown');
  assert.equal(clientIp({ 'x-forwarded-for': '   ' }), 'unknown');
});
test('isSecureRequest: true only when x-forwarded-proto is https', () => {
  assert.equal(isSecureRequest({ 'x-forwarded-proto': 'https' }), true);
  assert.equal(isSecureRequest({ 'x-forwarded-proto': 'https,http' }), true);
  assert.equal(isSecureRequest({ 'x-forwarded-proto': 'http' }), false);
  assert.equal(isSecureRequest({}), false); // local http dev
});
test('requestBaseUrl: proto + host, defaults to localhost', () => {
  assert.equal(
    requestBaseUrl({ host: 'focus-social.vercel.app', 'x-forwarded-proto': 'https' }),
    'https://focus-social.vercel.app'
  );
  assert.equal(requestBaseUrl({ host: 'localhost:3000' }), 'http://localhost:3000');
  assert.equal(requestBaseUrl({}), 'http://localhost:3000');
});
