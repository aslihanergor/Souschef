// Session resolver. Given the request's Cookie header, return the logged-in
// account or null. Called by api/auth/me.js, api/auth/delete.js and api/state.js, and — through
// `signedInGate` below — by api/feed.js and api/resolve-channel.js and api/group.js. Touches the DB, so
// it lives outside the pure api/_auth.js. No cookie → no DB hit (anonymous fast path).
import { hashToken, readSessionToken, isExpired } from './_auth.js';

// `strict` decides what a DATABASE ERROR means to the caller.
//
// Without it this function answers null for three different things: no cookie, no matching or
// expired session, and "the database could not be asked". The first two really are "not signed in".
// The third is not — and api/state.js has to refuse a signed-in page's save on exactly that
// distinction. Flattening them cost a change the user had made: the server refused, the client read
// the refusal as determinate and dropped its unsaved mark, and the change died with the page.
//
// The default stays lax on purpose. `/api/auth/me` and `/api/auth/delete` call this and neither would be
// made SAFER by the difference — which is not the same as "could do nothing useful with it":
// `/api/auth/delete` would say "Your session expired" where a
// strict answer could say "Could not delete right now", which is more accurate. It is not worth a
// behaviour change on endpoints that already degrade gracefully, and that is a judgement rather than an
// impossibility. Only a caller that says it needs to tell them apart gets
// to see the error. `/api/feed` and `/api/resolve-channel` ask
// for strict through `signedInGate` below, because for them the difference decides whether to serve.
export async function sessionAccount(sql, cookieHeader, { strict = false } = {}) {
  const raw = readSessionToken(cookieHeader);
  // The anonymous fast path returns BEFORE the database is touched, in both modes — which is why a
  // request with no cookie can be refused but can never produce a 503 FROM HERE: there is no lookup to
  // fail. `/api/state` has its own 503 for a missing store, above any lookup, so a cookie-less request
  // to that endpoint can still see one.
  if (!raw || !sql) return null;
  try {
    const rows = await sql`
      select s.account_id, s.expires_at, a.email
      from sessions s
      join accounts a on a.id = s.account_id
      where s.token_hash = ${hashToken(raw)}`;
    // An empty result and an expired row are both "no session": the question was asked and answered.
    // Neither is affected by `strict` — there is nothing to rethrow.
    if (!rows.length || isExpired(rows[0].expires_at)) return null;
    return { accountId: rows[0].account_id, email: rows[0].email };
  } catch (e) {
    if (strict) throw e;  // the caller must tell "could not check" from "no session"
    return null;          // DB blip → treat as signed-out; the client degrades gracefully
  }
}

// How long the gate waits for the session lookup before treating the store as unreachable.
// The Neon driver has no timeout of its own, so without this a hanging store stalls every YouTube, Substack
// and resolve request. Three seconds
// clears a cold Neon start — 1540 ms measured from a laptop, further from Neon than Vercel is — and the
// client's own 2.5 s /api/auth/me bound puts it in the same range. The abandoned query is not cancelled.
export const SESSION_CHECK_TIMEOUT_MS = 3000;

// The signed-in gate for the endpoints that spend money or a shared quota on every request:
// `/api/feed` (X posts at $0.005 each; YouTube's daily units) and `/api/resolve-channel` (X user reads at
// $0.010; YouTube's 100 searches a day) — and `/api/group` (a Claude call per request).
// Three answers:
//
//   { account }         a session the store confirmed                   → serve, as that account
//   { account: null }   the lookup threw or missed the time limit        → UNVERIFIED: see below
//   null                no cookie, no store configured, no live session → refuse with 401, before any upstream call
//
// UNVERIFIED IS NOT "SERVE". It covers ANY failure to get an answer — a Neon blip, but also a wrong or rotated
// DATABASE_URL, a rate limit, an exhausted compute quota, a hang — and for as long as that lasts it is reached
// by anyone who sends a `focus_session` cookie of ANY value, forged ones included, because a cookie is what
// sends the request to the store at all. So callers split by cost:
// YouTube and Substack are served — they spend quota, not money, and refusing them would
// blank every signed-in feed during an outage — while the X paths refuse with 503, since the account X would
// be billed and metered against is exactly what is unknown. `/api/group` has no free branch, so it refuses
// every unverified request with 503. The gate therefore CAN serve a stranger (YouTube and Substack
// only) during a store failure.
//
// A request with NO cookie never reaches the store: `sessionAccount` returns null first, so it is refused even
// mid-outage, without waiting. A MISSING store is a refusal by that same early return: a
// deployment without DATABASE_URL cannot sign anyone in, and a missing env var must not reopen these endpoints.
//
// `strict` and the catch are the mechanism together: without `strict`, `sessionAccount` flattens a database
// error into "no session". `lookup` and `timeoutMs` are parameters so handler tests can inject both.
export async function signedInGate(sql, cookieHeader, lookup = sessionAccount, { timeoutMs = SESSION_CHECK_TIMEOUT_MS } = {}) {
  let timer;
  try {
    const account = await Promise.race([
      lookup(sql, cookieHeader, { strict: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('session check timed out')), timeoutMs);
      }),
    ]);
    return account ? { account } : null;
  } catch {
    return { account: null };
  } finally {
    clearTimeout(timer);
  }
}

// The refusal the gated endpoints send, in one place so they cannot drift apart: 401 for no session, 503
// for a paid request (X, or a classify) the gate could not verify. `no-store` is set BEFORE the body because a real response
// cannot take a header afterwards, and a refusal must never be cacheable — the YouTube and Substack feed
// responses are edge-cached by URL, so one cached refusal could reach the next signed-in user. Whether
// Vercel would cache a header-less 401 was not verified; this does not rely on it. The client renders
// `error` (the add form shows it verbatim), so each caller words it for its own screen.
export function refuse(res, status, error) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error });
}
