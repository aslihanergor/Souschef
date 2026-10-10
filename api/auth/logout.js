// POST /api/auth/logout  → delete the session row + clear the cookie.
//
// The contract the client depends on: **200 means this browser is signed out.** The
// cookie is cleared on every 200, and the only way to reach a 200 is for the session delete to have
// succeeded or for there to have been no session to begin with. Anything else answers non-2xx, so
// `response.ok` is a signal the client can actually act on.
//
// An earlier version instead returned an `endedSession` flag resolved from a SELECT taken before
// the DELETE. That was wrong twice over: it reported whether a session was *found*, not whether it
// was *ended* (a failing DELETE still answered true), and it read false for a mere DB blip —
// api/_session.js swallows the error and returns null — while the cookie was cleared regardless.
// The client refused on that false, kept the previous user's state, and could never recover because
// the retry had no cookie left to send.
import { db } from '../_db.js';
import { hashToken, readSessionToken, clearSessionCookie, isSecureRequest } from '../_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const raw = readSessionToken(req.headers?.cookie);
  const sql = db();
  if (raw && !sql) {
    // A live cookie but no database configured: we cannot revoke the session, and answering 200
    // here would clear the cookie and tell the client it is safe to wipe while the row lives out
    // its 30-day TTL — the third path to a false 200 the invariant above claims does not exist.
    return res.status(503).json({ error: 'cannot end session' });
  }
  if (raw && sql) {
    try {
      await sql`delete from sessions where token_hash = ${hashToken(raw)}`;
    } catch (e) {
      console.error('[auth/logout]', e.message);
      // Fail loudly rather than clear the cookie: the row may still be live, and a copy of the
      // cookie would keep working against it for the rest of its 30-day TTL. The client refuses on
      // a non-2xx and keeps local state, which is correct — this browser is still signed in.
      return res.status(500).json({ error: 'logout failed' });
    }

    // Deliberately does NOT delete this browser's device row:
    // the row can be the only surviving copy of the user's state, and no cheap server-side gate
    // distinguishes "safe to drop" from "about to destroy the last copy" — an `exists` check on the
    // account row is true within seconds of every boot, including when that row is empty or was
    // filled by adopting someone else's state. Rotating the device id client-side already makes the
    // row unreachable, which is what closes the leak; deleting it only bought storage hygiene, and
    // that is not worth an irreversible delete guarded by a heuristic. Orphan tracked separately.
  }
  res.setHeader('Set-Cookie', clearSessionCookie({ secure: isSecureRequest(req.headers) }));
  return res.status(200).json({ ok: true });
}
