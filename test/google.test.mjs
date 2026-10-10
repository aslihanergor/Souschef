// Pure helpers for Sign in with Google. The OAuth network calls live in the
// endpoints; here we test only the pure logic: building the consent URL, extracting a
// verified email from Google's userinfo, and the CSRF state cookie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthUrl, verifiedEmail, googleIdentity,
  serializeStateCookie, readStateCookie, clearStateCookie,
  STATE_COOKIE,
  buildYouTubeConnectUrl, youtubeRedirectUri, YOUTUBE_READONLY_SCOPE,
} from '../api/_google.js';

test('buildAuthUrl includes the required OAuth params', () => {
  const url = buildAuthUrl({
    clientId: 'abc.apps.googleusercontent.com',
    redirectUri: 'https://focus-social.app/api/auth/google/callback',
    state: 'xyz123',
  });
  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
  const q = new URL(url).searchParams;
  assert.equal(q.get('client_id'), 'abc.apps.googleusercontent.com');
  assert.equal(q.get('redirect_uri'), 'https://focus-social.app/api/auth/google/callback');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'openid email profile');
  assert.equal(q.get('state'), 'xyz123');
});

test('verifiedEmail returns a normalized email only when Google says it is verified', () => {
  assert.equal(verifiedEmail({ email: 'A@Example.COM', email_verified: true }), 'a@example.com');
  assert.equal(verifiedEmail({ email: 'a@example.com', email_verified: 'true' }), 'a@example.com');
});

test('verifiedEmail rejects unverified, missing, or malformed emails', () => {
  assert.equal(verifiedEmail({ email: 'a@example.com', email_verified: false }), null);
  assert.equal(verifiedEmail({ email: 'a@example.com' }), null);   // no verified flag
  assert.equal(verifiedEmail({ email_verified: true }), null);     // no email
  assert.equal(verifiedEmail({ email: 'not-an-email', email_verified: true }), null);
  assert.equal(verifiedEmail(null), null);
});

// `sub` is Google's stable, never-reused account identifier. It — not the email — is
// what identifies the account, because an email can be changed upstream or recycled by a
// Workspace/edu domain. googleIdentity() refuses to hand back an identity unless BOTH halves are
// trustworthy: a verified email AND a usable sub.
test('googleIdentity returns the stable sub alongside the normalized email', () => {
  assert.deepEqual(
    googleIdentity({ sub: '110169484474386276334', email: 'A@Example.COM', email_verified: true }),
    { sub: '110169484474386276334', email: 'a@example.com' },
  );
  assert.deepEqual(
    googleIdentity({ sub: '42', email: 'a@example.com', email_verified: 'true' }),
    { sub: '42', email: 'a@example.com' },
  );
});

test('googleIdentity rejects anything missing a usable sub', () => {
  const ok = { email: 'a@example.com', email_verified: true };
  assert.equal(googleIdentity({ ...ok }), null);                  // no sub at all
  assert.equal(googleIdentity({ ...ok, sub: '' }), null);         // empty string
  assert.equal(googleIdentity({ ...ok, sub: '   ' }), null);      // whitespace only
  assert.equal(googleIdentity({ ...ok, sub: 12345 }), null);      // not a string
  assert.equal(googleIdentity({ ...ok, sub: null }), null);
});

test('googleIdentity rejects an unverified or malformed email even with a valid sub', () => {
  assert.equal(googleIdentity({ sub: '42', email: 'a@example.com', email_verified: false }), null);
  assert.equal(googleIdentity({ sub: '42', email: 'a@example.com' }), null);   // no verified flag
  assert.equal(googleIdentity({ sub: '42', email_verified: true }), null);     // no email
  assert.equal(googleIdentity({ sub: '42', email: 'nope', email_verified: true }), null);
  assert.equal(googleIdentity(null), null);
  assert.equal(googleIdentity('not-an-object'), null);
});

test('state cookie round-trips and can be cleared', () => {
  const c = serializeStateCookie('tok', { maxAgeSeconds: 600, secure: true });
  assert.ok(c.includes(`${STATE_COOKIE}=tok`));
  assert.ok(c.includes('HttpOnly'));
  assert.ok(c.includes('SameSite=Lax'));
  assert.ok(c.includes('Secure'));
  assert.ok(c.includes('Max-Age=600'));
  assert.equal(readStateCookie(`${STATE_COOKIE}=tok; other=1`), 'tok');
  assert.equal(readStateCookie('other=1'), null);
  assert.ok(clearStateCookie({ secure: true }).includes('Max-Age=0'));
});

test('serializeStateCookie omits Secure on plain http (local dev)', () => {
  const c = serializeStateCookie('tok', { maxAgeSeconds: 600, secure: false });
  assert.ok(!c.includes('Secure'));
});

// ── Connect YouTube: incremental-auth consent URL for youtube.readonly ──

test('youtubeRedirectUri builds the connect callback path (distinct from sign-in)', () => {
  assert.equal(
    youtubeRedirectUri('https://focus-social.app'),
    'https://focus-social.app/api/connect/youtube/callback',
  );
});

test('buildYouTubeConnectUrl requests youtube.readonly with incremental / online / forced consent', () => {
  const url = buildYouTubeConnectUrl({
    clientId: 'abc.apps.googleusercontent.com',
    redirectUri: 'https://focus-social.app/api/connect/youtube/callback',
    state: 'st8',
  });
  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
  const q = new URL(url).searchParams;
  assert.equal(q.get('client_id'), 'abc.apps.googleusercontent.com');
  assert.equal(q.get('redirect_uri'), 'https://focus-social.app/api/connect/youtube/callback');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), YOUTUBE_READONLY_SCOPE);
  assert.equal(q.get('scope'), 'https://www.googleapis.com/auth/youtube.readonly');
  assert.equal(q.get('state'), 'st8');
  assert.equal(q.get('access_type'), 'online');           // one-shot import — no refresh token
  assert.equal(q.get('include_granted_scopes'), 'true');  // incremental auth
  assert.equal(q.get('prompt'), 'consent');
});

test('the connect flow does not disturb the sign-in scope', () => {
  const signin = new URL(buildAuthUrl({ clientId: 'c', redirectUri: 'r', state: 's' })).searchParams;
  assert.equal(signin.get('scope'), 'openid email profile');
});
