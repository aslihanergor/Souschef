// Sign-in-with-Google in ONE serverless function, dispatched on the trailing path
// segment (req.query.action): /api/auth/google/{start,callback}. Collapsed into a dynamic [action]
// route to stay under Vercel's 12-function-per-deployment ceiling; the
// /callback path is preserved so the Google redirect URI registered in the console still matches.
import { db } from '../../_db.js';
import {
  isSecureRequest, generateToken, serializeSessionCookie,
  requestBaseUrl, SESSION_TTL_MS,
} from '../../_auth.js';
import {
  buildAuthUrl, googleRedirectUri, serializeStateCookie, STATE_TTL_MS,
  exchangeCode, fetchUserInfo, googleIdentity, readStateCookie, clearStateCookie,
} from '../../_google.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  switch (req.query.action) {
    case 'start':    return start(req, res);
    case 'callback': return callback(req, res);
    default:         return res.status(404).json({ error: 'not found' });
  }
}

// start → redirect to Google's consent screen. Sets a short-lived CSRF `state` cookie the callback
// verifies.
async function start(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    console.error('[google/start] GOOGLE_CLIENT_ID unset');
    return res.redirect(302, '/app?auth=google_unavailable'); // app at /app
  }
  const { token: state } = generateToken();
  const secure = isSecureRequest(req.headers);
  res.setHeader('Set-Cookie', serializeStateCookie(state, {
    maxAgeSeconds: Math.floor(STATE_TTL_MS / 1000),
    secure,
  }));
  const redirectUri = googleRedirectUri(requestBaseUrl(req.headers));
  return res.redirect(302, buildAuthUrl({ clientId, redirectUri, state }));
}

// callback → verify, find-or-create the account by the verified Google email, open a session,
// redirect home. Reuses the exact account + session logic from the magic-link callback, so both
// methods land on the same account.
async function callback(req, res) {
  const fail = () => res.redirect(302, '/app?auth=google_failed');

  const code = req.query?.code;
  const state = req.query?.state;
  const cookieState = readStateCookie(req.headers?.cookie);
  // CSRF: state must be present and match the cookie we set at /start.
  if (!code || typeof code !== 'string' || !state || state !== cookieState) return fail();

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[google/callback] client env unset');
    return fail();
  }

  const sql = db();
  if (!sql) return fail();

  const secure = isSecureRequest(req.headers);
  try {
    const redirectUri = googleRedirectUri(requestBaseUrl(req.headers));
    const accessToken = await exchangeCode({ code, clientId, clientSecret, redirectUri });
    if (!accessToken) return fail();
    const identity = googleIdentity(await fetchUserInfo(accessToken));
    if (!identity) return fail();
    const { sub, email } = identity;

    // Resolve the account by *identity* (sub) first, falling back to email. A Google
    // sign-in must NEVER write accounts.email: the sub is what says "this is the same account",
    // and the email is a mutable attribute the user may have changed on our side.
    const accountId = await resolveGoogleAccount(sql, sub, email);
    if (!accountId) return fail();

    // Open a 30-day session (store only the hash of the cookie value).
    const { token: sessionToken, hash: sessionHash } = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await sql`
      insert into sessions (token_hash, account_id, expires_at)
      values (${sessionHash}, ${accountId}, ${expiresAt})`;

    // Set the session cookie and clear the one-time CSRF state cookie.
    res.setHeader('Set-Cookie', [
      serializeSessionCookie(sessionToken, {
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
        secure,
      }),
      clearStateCookie({ secure }),
    ]);
    return res.redirect(302, '/app?auth=ok');
  } catch (e) {
    console.error('[google/callback]', e.message);
    return fail();
  }
}

// Three-step resolution, in strict order. Returns an account id, or null.
async function resolveGoogleAccount(sql, sub, email) {
  // 1. Identity match. Authoritative — even if this account's email is now something else entirely
  //    (the user changed it here, or Google renamed it upstream). We do not touch accounts.email.
  const bySub = await sql`select id from accounts where google_sub = ${sub}`;
  if (bySub.length) return bySub[0].id;

  // 2. First Google sign-in for an account that already exists under this email (created by a magic
  //    link, or predating this fix). Attach the sub — the backfill that makes step 1 work forever
  //    after. `google_sub is null` keeps us from stealing a sub that already belongs to a row.
  const byEmail = await sql`
    update accounts set google_sub = ${sub}
    where email = ${email} and google_sub is null
    returning id`;
  if (byEmail.length) return byEmail[0].id;

  // 3. Brand-new account. `on conflict (email)` covers the two-tab race where another request
  //    inserted this email between steps 2 and 3; coalesce keeps whichever sub landed first rather
  //    than clobbering it, and the email is left exactly as it already was.
  const created = await sql`
    insert into accounts (email, google_sub) values (${email}, ${sub})
    on conflict (email) do update
      set google_sub = coalesce(accounts.google_sub, excluded.google_sub)
    returning id`;
  return created[0]?.id ?? null;
}
