// GET /api/auth/callback?token=…  → verify the magic link, open a session, redirect home.
// Atomic single-use: the token is claimed only if unused AND unexpired, in one UPDATE.
import { db } from '../_db.js';
import {
  hashToken, generateToken, isSecureRequest,
  serializeSessionCookie, SESSION_TTL_MS,
} from '../_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const fail = () => res.redirect(302, '/app?auth=invalid'); // app lives at /app

  const raw = req.query?.token;
  if (!raw || typeof raw !== 'string') return fail();
  const sql = db();
  if (!sql) return fail();

  try {
    // Claim the token: marks used only if it was unused and unexpired. Race-safe.
    const claimed = await sql`
      update login_tokens set used = true
      where token_hash = ${hashToken(raw)} and used = false and expires_at > now()
      returning email`;
    if (!claimed.length) return fail();
    const email = claimed[0].email;

    // Find-or-create the account keyed on the verified email.
    const [account] = await sql`
      insert into accounts (email) values (${email})
      on conflict (email) do update set email = excluded.email
      returning id`;

    // Open a 30-day session (store only the hash of the cookie value).
    const { token: sessionToken, hash: sessionHash } = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await sql`
      insert into sessions (token_hash, account_id, expires_at)
      values (${sessionHash}, ${account.id}, ${expiresAt})`;

    res.setHeader('Set-Cookie', serializeSessionCookie(sessionToken, {
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
      secure: isSecureRequest(req.headers),
    }));
    return res.redirect(302, '/app?auth=ok');
  } catch (e) {
    console.error('[auth/callback]', e.message);
    return fail();
  }
}
