#!/usr/bin/env node
// Production row health check — READ-ONLY.
//
// Why this exists: a silent data loss was found only by someone happening to look. An account row lost all 7 of its
// channels with no `remove_channel` event ever recorded, and four days later the mechanism still
// could not be established from the data, because nothing had been watching. The sync bugs that
// empty a row are silent by construction — the user sees an empty feed and assumes they did it.
//
// So this prints the fingerprint rather than raw rows: an account whose row holds ZERO channels while
// its event log contains `add_channel` and no `remove_channel` has lost data it never asked to lose.
// That is the exact shape of that loss, and one the sync bugs can still produce.
//
// SAFE TO RUN ANY TIME. Selects only; no INSERT/UPDATE/DELETE, no DDL. It does not boot the app, so
// it cannot trip the known hazard (opening SousChef on the owner's trysouschef.vercel.app
// browser reconciles local against the row and destroys the evidence).
//
//   node scripts/check-rows.mjs          # production (DATABASE_URL)
//   node scripts/check-rows.mjs --dev    # the dev branch (DEV_DATABASE_URL)
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';

const useDev = process.argv.includes('--dev');

// dotenv is not a dependency (the app reads env from Vercel), so parse .env directly — same approach
// as dev-server.mjs. Real env vars win, so this works in CI or a shell that already has them.
function loadEnv() {
  const out = { ...process.env };
  try {
    for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      if (!line.includes('=') || line.trimStart().startsWith('#')) continue;
      const k = line.slice(0, line.indexOf('=')).trim();
      if (out[k]) continue;
      out[k] = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — rely on the real environment */ }
  return out;
}

const env = loadEnv();
const url = useDev ? env.DEV_DATABASE_URL : env.DATABASE_URL;
if (!url) {
  console.error(`Missing ${useDev ? 'DEV_DATABASE_URL' : 'DATABASE_URL'}.`);
  process.exit(1);
}

// Say which database this is BEFORE printing anything, so a reader never has to guess which numbers
// they are looking at. A migration against prod looks identical to one against a branch.
const host = (url.match(/@([^/]+)\//) || [, '(unknown)'])[1];
console.log(`DB → ${host}  ${useDev ? '(dev branch)' : '(PRODUCTION)'}\n`);

const sql = neon(url);

const rows = await sql`
  select u.id, u.updated_at,
         jsonb_array_length(coalesce(u.state->'channels','[]'::jsonb)) as channels,
         jsonb_array_length(coalesce(u.state->'done','[]'::jsonb))     as done,
         jsonb_array_length(coalesce(u.state->'archive','[]'::jsonb))  as archive,
         a.email,
         (select count(*) from events e
            where e.account_id = a.id and e.name = 'add_channel')::int    as adds,
         (select count(*) from events e
            where e.account_id = a.id and e.name = 'remove_channel')::int as removes
  from users u
  join accounts a on a.id::text = u.id
  where u.kind = 'account'
  order by channels desc, done desc`;

const pad = (v, n) => String(v).padStart(n);
console.log('  email                          chan  done  arch   adds  rmvs   updated');
for (const r of rows) {
  // The fingerprint: nothing left, yet they added channels and never removed one.
  const lost = r.channels === 0 && r.adds > 0 && r.removes === 0;
  console.log(
    `  ${(r.email || '(none)').padEnd(30)}${pad(r.channels, 4)}${pad(r.done, 6)}${pad(r.archive, 6)}` +
    `${pad(r.adds, 7)}${pad(r.removes, 6)}   ${new Date(r.updated_at).toISOString().slice(0, 16)}` +
    (lost ? '   ← LOST CHANNELS, no removal recorded' : ''));
}

const suspect = rows.filter(r => r.channels === 0 && r.adds > 0 && r.removes === 0);
console.log('');
if (suspect.length === 0) {
  console.log(`✅ ${rows.length} account rows, none showing BUG-059's fingerprint.`);
} else {
  // Loud but not alarmist: the owner's own row is a KNOWN instance that was
  // deliberately not restored, so a hit there is expected and must not read as a new incident.
  console.log(`⚠️  ${suspect.length} account row(s) hold no channels despite having added some and never removed one:`);
  for (const r of suspect) console.log(`      ${r.email}  (${r.adds} adds, last written ${new Date(r.updated_at).toISOString()})`);
  console.log("\n    The owner's own account is the KNOWN case — BUG-059, test data, deliberately not restored.");
  console.log('    Any OTHER row here is new: check tasks/BUG-059.md for how that one was investigated.');
}
console.log('\nCompare channel counts against the last run. A count that FALLS is the signal —');
console.log('rising counts are people adding, and `done` rising is people reading.');
