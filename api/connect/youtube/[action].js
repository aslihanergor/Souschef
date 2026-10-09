// The whole Connect-YouTube import flow (TASK-015) in ONE serverless function, dispatched on the
// trailing path segment (req.query.action): /api/connect/youtube/{start,callback,result}. Collapsed
// into a dynamic [action] route to stay under Vercel's 12-function-per-deployment ceiling; the
// /callback path is preserved so the Google redirect URI registered in the console still matches.
import { isSecureRequest, generateToken, requestBaseUrl, parseCookies } from '../../_auth.js';
import {
  serializeStateCookie, STATE_TTL_MS, clearStateCookie, readStateCookie,
  buildYouTubeConnectUrl, youtubeRedirectUri, exchangeCode,
} from '../../_google.js';
import { listSubscriptions } from '../../_youtube.js';
import { stashImport, consumeImport } from '../../_youtube_import.js';
import { db } from '../../_db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  switch (req.query.action) {
    case 'start':    return start(req, res);
    case 'callback': return callback(req, res);
    case 'result':   return result(req, res);
    default:         return res.status(404).json({ error: 'not found' });
  }
}

// start → redirect to Google's consent (youtube.readonly, incremental/online), setting the CSRF
// state cookie the callback verifies.
async function start(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    console.error('[connect/youtube/start] GOOGLE_CLIENT_ID unset');
    return res.redirect(302, '/app?import=youtube_unavailable'); // app at /app (TASK-069)
  }
  const { token: state } = generateToken();
  const secure = isSecureRequest(req.headers);
  res.setHeader('Set-Cookie', serializeStateCookie(state, {
    maxAgeSeconds: Math.floor(STATE_TTL_MS / 1000),
    secure,
  }));
  const redirectUri = youtubeRedirectUri(requestBaseUrl(req.headers));
  return res.redirect(302, buildYouTubeConnectUrl({ clientId, redirectUri, state }));
}

// callback → verify CSRF state, exchange the code, fetch subscriptions, stash them under a one-time
// httpOnly cookie, and redirect to the app (which reads them via ?action=result). The Google token
// is used here and discarded; it never reaches the client.
async function callback(req, res) {
  const secure = isSecureRequest(req.headers);
  const clearState = clearStateCookie({ secure });
  const fail = reason => {
    res.setHeader('Set-Cookie', clearState);
    return res.redirect(302, `/app?import=${reason}`);
  };

  const { code, state } = req.query;
  const cookieState = readStateCookie(req.headers.cookie);
  if (!code || !state || !cookieState || state !== cookieState) return fail('youtube_denied');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = youtubeRedirectUri(requestBaseUrl(req.headers));
  const accessToken = await exchangeCode({ code, clientId, clientSecret, redirectUri });
  if (!accessToken) return fail('youtube_error');

  let importResult;
  try {
    importResult = await listSubscriptions(accessToken); // { channels, truncated }
  } catch (e) {
    console.error('[connect/youtube/callback] listSubscriptions failed:', e.message);
    return fail('youtube_error');
  }

  const sql = db();
  if (!sql) return fail('youtube_error');
  const importToken = await stashImport(sql, importResult);
  const importCookie = `focus_import=${importToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [clearState, importCookie]);
  return res.redirect(302, '/app?import=youtube');
}

// result → return the stashed subscription list exactly once (consume the one-time token + clear
// the cookie). Empty result for a missing/expired token.
async function result(req, res) {
  const token = parseCookies(req.headers.cookie)['focus_import'] || null;
  const secure = isSecureRequest(req.headers);
  res.setHeader('Set-Cookie', `focus_import=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);

  const sql = db();
  const empty = { channels: [], truncated: false };
  if (!sql || !token) return res.status(200).json(empty);
  const data = await consumeImport(sql, token); // { channels, truncated } | null
  return res.status(200).json(data || empty);
}
