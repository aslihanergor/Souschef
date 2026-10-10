// Sign in with Google. No npm dep — plain fetch over Google's OAuth 2.0 endpoints,
// authorization-code flow. Accounts stay keyed on the *verified* email Google returns, so a
// Google sign-in lands on the same account as a magic link with that email. Pure helpers here
// (buildAuthUrl, verifiedEmail, state cookie) are unit-tested; the two network calls take an
// injectable fetchImpl for the same reason.
import { normalizeEmail, parseCookies } from './_auth.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GOOGLE_SCOPE = 'openid email profile';

export const STATE_COOKIE = 'focus_oauth_state';
export const STATE_TTL_MS = 10 * 60 * 1000; // the round-trip to Google and back

// The redirect URI must byte-match one registered in the Google console. We derive it from the
// request host (reusing requestBaseUrl's proto/host logic) so it's correct on focus-social.app,
// the *.vercel.app host, and localhost — all three are registered.
export function googleRedirectUri(baseUrl) {
  return `${baseUrl}/api/auth/google/callback`;
}

export function buildAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// ── Connect YouTube → import subscriptions ──────────────────────────
// A separate OAuth flow from sign-in: same client, a distinct callback path, and the *sensitive*
// youtube.readonly scope requested via incremental auth so only importers ever see it (sign-in
// keeps GOOGLE_SCOPE). `access_type: 'online'` — the token is used once to read subscriptions and
// discarded; no refresh token stored. `prompt: 'consent'` guarantees the scope is granted even if
// the user previously signed in with Google.
export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

// Distinct from googleRedirectUri so the connect round-trip lands on its own handler; must byte-
// match a redirect URI registered in the Google console (all three hosts).
export function youtubeRedirectUri(baseUrl) {
  return `${baseUrl}/api/connect/youtube/callback`;
}

export function buildYouTubeConnectUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_READONLY_SCOPE,
    state,
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// Google's userinfo → a trusted email, or null. We only accept an email Google marks verified.
export function verifiedEmail(userinfo) {
  if (!userinfo || typeof userinfo !== 'object') return null;
  const verified = userinfo.email_verified === true || userinfo.email_verified === 'true';
  if (!verified) return null;
  return normalizeEmail(userinfo.email);
}

// Google's userinfo → { sub, email }, or null.
//
// `sub` is the account's *identity*: unique to the Google account, never reused, and stable across
// email changes. The email is only an *attribute* — it can be renamed upstream (Workspace/edu, or a
// Google account with a non-Gmail primary) and those domains recycle addresses to new people. Keying
// accounts on the email therefore breaks both ways: a rename orphans the real account, and a recycled
// address hands it to a stranger. Callers must resolve on `sub` first and treat `email` as mutable.
//
// Both halves must be trustworthy or we return null: an unverified email is unusable for the
// find-or-create fallback (and for contacting the user), and a missing/blank `sub` means we have no
// identity to key on. Google always sends `sub` as a string; anything else is a response we don't
// understand, so we refuse it rather than coerce.
export function googleIdentity(userinfo) {
  const email = verifiedEmail(userinfo);
  if (!email) return null;
  const sub = userinfo.sub;
  if (typeof sub !== 'string' || !sub.trim()) return null;
  return { sub: sub.trim(), email };
}

// Exchange the one-time code for an access token. Returns the token string or null on failure.
export async function exchangeCode({ code, clientId, clientSecret, redirectUri }, fetchImpl = fetch) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const r = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    console.error('[google] token exchange failed', r.status, await r.text().catch(() => ''));
    return null;
  }
  const json = await r.json().catch(() => null);
  return json?.access_token || null;
}

// Fetch the signed-in user's profile (we only need the verified email). Returns the object or null.
export async function fetchUserInfo(accessToken, fetchImpl = fetch) {
  const r = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    console.error('[google] userinfo failed', r.status);
    return null;
  }
  return r.json().catch(() => null);
}

// Short-lived CSRF cookie carrying the `state` we sent to Google; compared on callback.
export function serializeStateCookie(value, { maxAgeSeconds, secure = true } = {}) {
  const parts = [`${STATE_COOKIE}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (secure) parts.push('Secure');
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function readStateCookie(header) {
  return parseCookies(header)[STATE_COOKIE] || null;
}

export function clearStateCookie({ secure = true } = {}) {
  return serializeStateCookie('', { maxAgeSeconds: 0, secure });
}
