// One-off, idempotent DB migration for the backend sync layer.
// Run locally with:  node scripts/init-db.mjs          (the dev branch: DEV_DATABASE_URL from .env)
//                    node scripts/init-db.mjs --prod   (production: DATABASE_URL, and nothing else)
// Safe to re-run — every statement is CREATE … IF NOT EXISTS.
//
// TASK-024: the `users` state table.
// TASK-025: accounts / login_tokens / sessions (magic-link auth).

import { neon } from '@neondatabase/serverless';
import { scriptDatabaseTarget } from '../api/_db.js';

process.loadEnvFile('.env');

// CHR-016: `--prod` SELECTS production (DATABASE_URL) and refuses anything else; without it the
// target is the dev branch (DEV_DATABASE_URL, as api/_db.js resolves it) and production is refused.
// It used to only PERMIT production, so a plain `--prod` on a laptop migrated the dev branch while
// the banner read like success — the undocumented `DEV_DATABASE_URL=` prefix was the only way in.
const target = scriptDatabaseTarget({ prod: process.argv.includes('--prod') });
if (target.error) {
  console.error(`✗ ${target.error}`);
  process.exit(1);
}
console.log(`→ migrating ${target.host}${target.isProd ? '  ⚠️  PRODUCTION' : '  (non-production)'}`);

// Connect to the URL that was checked — db() resolves its own and would ignore --prod.
const sql = neon(target.url);

// State table (TASK-024): `id` = an anonymous device id, or an account id after login.
await sql`
  create table if not exists users (
    id         text primary key,
    state      jsonb       not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  )
`;

// BUG-019: split device rows from account rows into separate namespaces.
//
// Both kinds of id shared one flat keyspace, so `where id = $1` matched either — which is how an
// anonymous request supplying someone else's id read and overwrote their state. The isolation has
// to live in the schema: a WHERE clause is only as good as every future query remembering it.
//
// Three steps, each independently idempotent so re-running this script is always safe.
await sql`alter table users add column if not exists kind text not null default 'device'`;

// Backfill: a row whose id matches an account IS that account's state; everything else is a device.
// Safe to re-run — it only ever relabels rows still sitting on the 'device' default.
await sql`
  update users set kind = 'account'
  where kind = 'device' and id in (select id::text from accounts)`;

// Swap the primary key to (kind, id). Guarded on the current PK's column count so a second run is
// a no-op rather than an error. Done last: the backfill above must be correct before the key that
// depends on it exists, or two rows could collide on the way in.
await sql`
  do $$
  begin
    if (select count(*) from information_schema.key_column_usage
        where table_name = 'users' and constraint_name = 'users_pkey') < 2 then
      alter table users drop constraint if exists users_pkey;
      alter table users add primary key (kind, id);
    end if;
  end $$`;

// Accounts (TASK-025): keyed on verified email. gen_random_uuid() is built into
// Postgres 13+ (no pgcrypto extension needed on Neon).
await sql`
  create table if not exists accounts (
    id         uuid        primary key default gen_random_uuid(),
    email      text        unique not null,
    created_at timestamptz not null default now()
  )
`;

// BUG-013: Google's `sub` — the stable, never-reused id for a Google account. It, not the email,
// identifies a Google sign-in: an email can be renamed upstream or recycled by a Workspace/edu
// domain. Nullable (magic-link accounts have none, and existing rows backfill on their next Google
// sign-in). The unique index is created separately because `add column … unique` is not idempotent.
await sql`alter table accounts add column if not exists google_sub text`;
await sql`create unique index if not exists accounts_google_sub_key on accounts (google_sub)`;

// Login tokens (TASK-025): only the sha256 of the emailed token is stored; the raw
// token lives only in the magic link. Single-use, ~15-min expiry. `ip` backs per-IP
// rate limiting on the send endpoint.
await sql`
  create table if not exists login_tokens (
    token_hash text        primary key,
    email      text        not null,
    expires_at timestamptz not null,
    used       boolean     not null default false,
    ip         text,
    created_at timestamptz not null default now()
  )
`;
// Idempotent for DBs created before the ip column existed.
await sql`alter table login_tokens add column if not exists ip text`;

// Sessions (TASK-025): opaque cookie value, stored as its sha256. ~30-day expiry.
await sql`
  create table if not exists sessions (
    token_hash text        primary key,
    account_id uuid        not null references accounts(id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  )
`;

// Rate-limiting the send endpoint queries recent login_tokens by email/ip + created_at.
await sql`create index if not exists login_tokens_email_created_idx
          on login_tokens (email, created_at)`;
await sql`create index if not exists login_tokens_ip_created_idx
          on login_tokens (ip, created_at)`;

// Connect-YouTube import handoff (TASK-015): a one-time, short-lived stash of the fetched
// subscription list, keyed by the sha256 of a token handed to the client via redirect. Read once
// (DELETE … RETURNING) then gone; rows also expire (~5 min) and are swept on the next stash.
await sql`
  create table if not exists youtube_imports (
    token_hash    text        primary key,
    subscriptions jsonb       not null,
    expires_at    timestamptz not null,
    created_at    timestamptz not null default now()
  )
`;

// Analytics events (TASK-070): an append-only behavioural log, owner-only. Separate from the
// state blob — events aren't state. `account_id` is null for anonymous activity and back-filled
// on the person's next authenticated sync (attribute-on-login); `device_id` is the anon device
// uuid. Section/action level only — `props` holds metadata (counts/source/method), never a
// content id.
await sql`
  create table if not exists events (
    id         bigserial   primary key,
    account_id uuid        references accounts(id) on delete set null,
    device_id  text,
    name       text        not null,
    section    text,
    props      jsonb       not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )
`;
// [BUG-123] An event's client-minted id, and the unique index `ingestEvents` conflicts on. Nullable
// and nulls-distinct, so the rows stored before this shipped (and any event whose id did not
// validate) are untouched and keep inserting. Added as its own statement rather than folded into the
// create above, because the table already exists everywhere: `create table if not exists` would skip
// a changed column list in silence.
//
// ORDER MATTERS: this must reach a database BEFORE the code that conflicts on it. The other way
// round is a 42P10 on every ingest — see the fallback in api/state.js.
await sql`alter table events add column if not exists client_id text`;
// UNIQUE ON `client_id` ALONE, not on `(device_id, client_id)` — a decision, not an oversight. A blind
// reviewer noted that global uniqueness lets any client occupy an id and so suppress a colliding event
// belonging to someone else. Deliberate collision is not prevented; accidental collision is negligible
// (uuid v4). Scoping it to the device would not close the hole either, because `device_id` is
// client-supplied too — anyone able to do this can already spoof that header and flood events outright.
// These are owner-only analytics for a trusted circle. (Asli, 2026-09-16: "keep it as is".)
await sql`create unique index if not exists events_client_id_key on events (client_id)`;

// Read paths for the owner dashboard: per-person timelines and per-event-type counts over time.
await sql`create index if not exists events_account_created_idx on events (account_id, created_at)`;
await sql`create index if not exists events_name_created_idx    on events (name, created_at)`;
// Attribute-on-login backfill targets exactly the unattributed rows for one device; a partial
// index keeps that UPDATE cheap and shrinks as rows get attributed.
await sql`create index if not exists events_unattributed_idx
          on events (device_id) where account_id is null`;

// X post-usage meters (TASK-100). TWO tables, because "what did the app spend" and "who should be
// limited" are different questions and one counter cannot answer both.
//
// X bills on retrieval but deduplicates within a day: "If the same post is returned from multiple
// queries within a day, it only counts once for billing." So when two users follow the same account
// they each retrieve the same posts and we are charged ONCE. A per-user posts-returned counter
// therefore OVERSTATES shared cost, and a single app-wide counter cannot say whose usage to bound.
//
//   x_usage      per (owner, UTC day) — the FAIRNESS meter. Approximate on overlap, by design.
//   x_posts_seen distinct (UTC day, post id) — the SPEND meter, exact, matching X's own dedup.
//
// `owner_kind` is 'account' or 'device', mirroring the users-table namespacing BUG-019 introduced:
// a device id and an account id must never collide in one keyspace.
await sql`
  create table if not exists x_usage (
    owner_kind text        not null,
    owner_id   text        not null,
    day        date        not null,
    posts      integer     not null default 0,
    updated_at timestamptz not null default now(),
    primary key (owner_kind, owner_id, day)
  )
`;
await sql`
  create table if not exists x_posts_seen (
    day     date not null,
    post_id text not null,
    primary key (day, post_id)
  )
`;
// Both tables are append-mostly and would otherwise grow forever — the shape CHR-026 flags on
// login_tokens. Swept opportunistically on write (the youtube_imports pattern), so there is no cron
// to forget; 30 days is well past any window we read.
await sql`create index if not exists x_usage_day_idx      on x_usage (day)`;
await sql`create index if not exists x_posts_seen_day_idx on x_posts_seen (day)`;

console.log('✓ migration complete: users, accounts, login_tokens, sessions, youtube_imports, events, x_usage, x_posts_seen ready');
