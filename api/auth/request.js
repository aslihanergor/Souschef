// POST /api/auth/request  { email }  → mint a single-use magic-link token, email it (TASK-025).
// Uniform 200 response: never reveals whether an account exists (there's no account lookup
// here — accounts are found-or-created at callback) nor whether we were rate-limited.
import { db } from '../_db.js';
import {
  normalizeEmail, generateToken, TOKEN_TTL_MS,
  clientIp, requestBaseUrl, withinRateLimit,
  RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_PER_EMAIL, RATE_LIMIT_MAX_PER_IP,
} from '../_auth.js';
import { sendMagicLink } from '../_resend.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const sql = db();
  if (!sql) return res.status(503).json({ error: 'auth unavailable' });

  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'invalid email' });

  // From here on the response is uniform ({ ok: true }); we send only if under the caps.
  try {
    const ip = clientIp(req.headers);
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
    const [{ n: emailN }] = await sql`
      select count(*)::int as n from login_tokens where email = ${email} and created_at > ${since}`;
    const [{ n: ipN }] = await sql`
      select count(*)::int as n from login_tokens where ip = ${ip} and created_at > ${since}`;

    if (withinRateLimit(emailN, RATE_LIMIT_MAX_PER_EMAIL) &&
        withinRateLimit(ipN, RATE_LIMIT_MAX_PER_IP)) {
      const { token, hash } = generateToken();
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
      await sql`
        insert into login_tokens (token_hash, email, expires_at, ip)
        values (${hash}, ${email}, ${expiresAt}, ${ip})`;
      const link = `${requestBaseUrl(req.headers)}/api/auth/callback?token=${token}`;
      await sendMagicLink(email, link);
    }
  } catch (e) {
    console.error('[auth/request]', e.message); // stay uniform; log for us
  }
  return res.status(200).json({ ok: true });
}
