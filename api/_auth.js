// Pure auth helpers for magic-link sign-in. No DB, no I/O — unit-tested in
// test/auth.test.mjs. The endpoints (api/auth/*.js) wire these to Neon + Resend.
//
// Security posture: raw tokens live only in the emailed link / the cookie; the DB stores
// only their sha256. Sessions are opaque cookie values (not JWTs) → revoke by deleting a row.

import { randomBytes, createHash } from 'node:crypto';

export const SESSION_COOKIE = 'focus_session';

export const TOKEN_TTL_MS = 15 * 60 * 1000;              // magic-link: 15 min
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // session: 30 days

// Send-endpoint abuse guard. Counted over RATE_LIMIT_WINDOW_MS of recent login_tokens.
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX_PER_EMAIL = 3;
export const RATE_LIMIT_MAX_PER_IP = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── email ─────────────────────────────────────────────────────────────────────
export function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

// The verified email *is* the identity — normalize so casing/whitespace can't fork an
// account. Returns null for junk so callers can reject uniformly.
export function normalizeEmail(email) {
  if (!isValidEmail(email)) return null;
  return email.trim().toLowerCase();
}

// ── tokens ────────────────────────────────────────────────────────────────────
export function hashToken(raw) {
  return createHash('sha256').update(String(raw)).digest('hex');
}

// 32 bytes of CSPRNG → URL-safe token for the link/cookie, plus its hash for storage.
export function generateToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

// ── expiry ────────────────────────────────────────────────────────────────────
// `expiresAt` may be a Date, an ISO string, or epoch ms; `now` is injectable for tests.
export function isExpired(expiresAt, now = Date.now()) {
  const exp = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return !(exp > now);
}

// ── rate limit ────────────────────────────────────────────────────────────────
export function withinRateLimit(recentCount, max) {
  return recentCount < max;
}

// ── cookies ───────────────────────────────────────────────────────────────────
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function readSessionToken(header) {
  return parseCookies(header)[SESSION_COOKIE] || null;
}

// httpOnly + SameSite=Lax (Strict would drop the cookie on the email-client redirect) +
// Path=/. Secure by default; pass secure:false only for local http dev.
export function serializeSessionCookie(value, { maxAgeSeconds, secure = true } = {}) {
  const parts = [`${SESSION_COOKIE}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (secure) parts.push('Secure');
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function clearSessionCookie({ secure = true } = {}) {
  return serializeSessionCookie('', { maxAgeSeconds: 0, secure });
}

// ── request-header helpers (proxy-aware) ──────────────────────────────────────
// Behind Vercel's proxy the real client info is in x-forwarded-*. These read the first
// hop and degrade sanely for local http dev (no forwarded headers → http/unknown).
//
// clientIp keys the per-IP sign-in limit, so it should not be a value the client chose.
// Any client can send x-forwarded-for. Vercel documents overwriting it, and documents
// x-vercel-forwarded-for as identical except that a proxy on top of Vercel can overwrite
// x-forwarded-for again — so the Vercel header is read first.
// x-forwarded-for stays as the fallback for local dev, which has no Vercel header.
export function clientIp(headers = {}) {
  const vercel = headers['x-vercel-forwarded-for'];
  if (typeof vercel === 'string' && vercel.trim()) return vercel.split(',')[0].trim();
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return 'unknown';
}

export function isSecureRequest(headers = {}) {
  const proto = headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

// Base URL for building the magic link — environment-aware (localhost in dev, the real
// host on Vercel) with no extra config.
export function requestBaseUrl(headers = {}) {
  const proto = isSecureRequest(headers) ? 'https' : 'http';
  const host = headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}
