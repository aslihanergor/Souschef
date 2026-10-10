// Transient handoff store for Connect-YouTube import. The OAuth callback fetches the
// user's subscriptions server-side and stashes them here keyed by a one-time token — only its
// sha256 is stored, mirroring login_tokens/sessions. The callback then redirects to the app, and
// the client reads the list exactly once via /result, which DELETEs the row. Short TTL + single-use.
// This is the DB-touching half of the flow; the pure parsers live in _youtube.js.
import { generateToken, hashToken, isExpired } from './_auth.js';

export const IMPORT_TTL_MS = 5 * 60 * 1000; // covers the callback → app redirect → /result round-trip

// Stash a subscription list; return the RAW one-time token (only its hash is persisted). Sweeps
// expired rows first so abandoned imports (consent granted, app never reopened) can't accumulate.
export async function stashImport(sql, subscriptions, { ttlMs = IMPORT_TTL_MS, now = Date.now() } = {}) {
  const { token, hash } = generateToken();
  const expiresAt = new Date(now + ttlMs).toISOString();
  await sql`delete from youtube_imports where expires_at < now()`;
  await sql`
    insert into youtube_imports (token_hash, subscriptions, expires_at)
    values (${hash}, ${JSON.stringify(subscriptions)}::jsonb, ${expiresAt})`;
  return token;
}

// Consume a one-time token: DELETE the row and return its stored list, or null if missing/expired.
// The DELETE … RETURNING makes read-and-invalidate atomic, so a token can't be replayed.
export async function consumeImport(sql, rawToken) {
  if (!rawToken || !sql) return null;
  const rows = await sql`
    delete from youtube_imports where token_hash = ${hashToken(rawToken)}
    returning subscriptions, expires_at`;
  if (!rows.length || isExpired(rows[0].expires_at)) return null;
  return rows[0].subscriptions;
}
