// Thin Neon Postgres client for the backend sync layer (TASK-024). The pooled DATABASE_URL is
// server-side only (Vercel env, never sent to the browser). Uses @neondatabase/serverless over
// HTTP — a good fit for serverless/Fluid Compute (low cold-start, nothing to pool or close).

import { neon } from '@neondatabase/serverless';

// Lazily build the tagged-template SQL runner. Usage: const sql = db(); await sql`select …`.
// Interpolated ${values} are sent as bound parameters (not spliced into the query text), so
// queries are injection-safe. Returns null when DATABASE_URL is unset so callers can degrade
// (mirrors ytFetch/xFetch returning null instead of throwing).
let _sql = null;
export function db() {
  if (_sql) return _sql;
  const url = resolveDatabaseUrl();
  if (!url) return null;
  _sql = neon(url);
  return _sql;
}

// Which URL do we actually connect to? (TASK-064)
//
// The Neon Marketplace integration OWNS `DATABASE_URL` and points Production, Preview *and*
// Development at the same (production) database. Vercel makes integration-managed variables
// read-only, so we cannot repoint it per environment. Instead we own `DEV_DATABASE_URL`: set it for
// Development + Preview, and `vercel env pull` then writes a local .env that is safe by default.
//
// It is ignored in production on purpose. Honouring an override there would mean the live app
// writing to a dev branch — a worse failure than the one this prevents — so `VERCEL_ENV` (set by
// Vercel on every deployment; absent in a local shell) makes that structurally impossible rather
// than merely unlikely.
export function resolveDatabaseUrl(env = process.env) {
  const override = env.DEV_DATABASE_URL;
  if (override && env.VERCEL_ENV !== 'production') return override;
  return env.DATABASE_URL || null;
}

// ── Which database am I about to touch? (TASK-064) ────────────────────────────
// Local `.env` gets its DATABASE_URL from `vercel env pull`, and the Neon integration points
// every Vercel environment at the SAME database — so localhost silently writes to production
// unless something says otherwise. Nothing in the tooling used to say otherwise: a migration
// against prod and one against a branch printed identical output. These make the target legible
// (dev-server prints it at boot) and let `scripts/init-db.mjs` refuse prod without `--prod`.
//
// The endpoint id — not a secret, just a hostname — identifies the production compute. It appears
// in both the pooled (`…-pooler.…`) and direct forms of the URL, so a substring match covers both.
export const PRODUCTION_DB_ENDPOINT = 'ep-young-unit-atz3xq46';

// The host portion of a Postgres URL, or null. Never returns credentials — this value gets printed.
export function dbHost(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(/^[a-z+]+:\/\/[^@/]*@([^/?#]+)/i);
  return m ? m[1] : null;
}

// NOTE: an unset/invalid URL returns false — "not production" is not the same as "a safe target".
// Callers must handle a missing DATABASE_URL separately.
export function isProductionDb(url) {
  return typeof url === 'string' && url.includes(PRODUCTION_DB_ENDPOINT);
}

// ── Which database does a MUTATING SCRIPT target? (CHR-016) ──────────────────
// `--prod` must SELECT production, not merely permit it. Scripts used to take resolveDatabaseUrl() and
// refuse production without the flag — but that function prefers DEV_DATABASE_URL on any laptop, so
// `--prod` quietly ran against the dev branch while printing a normal banner. It happened twice
// ([BUG-123]'s migration, [BUG-055]'s cleanup). So the flag decides the target, and each mode refuses
// the other's database:
//   prod  → DATABASE_URL, and it must be production;
//   !prod → resolveDatabaseUrl(), and it must NOT be production (TASK-064's guard).
// Returns { url, host, isProd } or { error }. Connect with neon(url) on the returned url — db() resolves
// its own, which is how a checked URL and a connected one can differ.
export function scriptDatabaseTarget({ prod, env = process.env }) {
  const url = prod ? env.DATABASE_URL : resolveDatabaseUrl(env);
  if (!url) {
    return { error: `No database configured (${prod ? 'DATABASE_URL' : 'DEV_DATABASE_URL / DATABASE_URL'}).` };
  }
  const host = dbHost(url) ?? '(unparseable host)';
  const isProd = isProductionDb(url);
  if (prod && !isProd) return { error: `REFUSING: --prod was given but ${host} is not the production database.` };
  if (!prod && isProd) return { error: `REFUSING: ${host} is the PRODUCTION database. Re-run with --prod if you mean it.` };
  return { url, host, isProd };
}
