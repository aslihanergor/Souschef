// [BUG-123] One-off cleanup of the analytics rows the re-send defect stored more than once.
//
//   node scripts/dedupe-events.mjs                  # DRY RUN against the dev database
//   node scripts/dedupe-events.mjs --prod           # DRY RUN against production
//   node scripts/dedupe-events.mjs --prod --apply   # the delete, with a backup table first
//
// RUN IT AFTER THE FIX IS LIVE. Until then new copies keep arriving behind it, so a clean count
// would be wrong within the hour.
//
// WHAT COUNTS AS A COPY: identical `device_id`, `account_id`, `name`, `section`, `props` AND
// `created_at`. That last one is the CLIENT's own timestamp (`to_timestamp(e.ts / 1000.0)` in
// ingestEvents), not the insert time, so equal values mean the same client event was sent twice —
// two separate actions a millisecond apart would differ.
//
// CONSERVATIVE BY CONSTRUCTION. A group whose rows have CONSECUTIVE ids is left alone. Those are
// ambiguous: either one batch genuinely carried the same event twice, or two simultaneous saves
// happened to land adjacent. Measured on production 2026-09-16: most groups were spread (deleted
// here) and a minority contiguous (kept). Deleting a real event to tidy a metric is the wrong trade.
//
// Every deleted row is copied into `events_bug123_backup` first, in the same transaction, and the
// lowest id in each group is always kept.
import { neon } from '@neondatabase/serverless';
import { scriptDatabaseTarget } from '../api/_db.js';

process.loadEnvFile('.env');

const APPLY = process.argv.includes('--apply');
// CHR-016: `--prod` selects production and refuses anything else; without it production is refused.
const target = scriptDatabaseTarget({ prod: process.argv.includes('--prod') });
if (target.error) {
  console.error(`✗ ${target.error}`);
  process.exit(1);
}
console.log(`→ ${APPLY ? 'CLEANING' : 'dry run on'} ${target.host}${target.isProd ? '  ⚠️  PRODUCTION' : '  (non-production)'}`);

const sql = neon(target.url);

// One definition, used by the report and by the delete, so the rows counted are the rows removed.
const GROUPS = `
  select device_id, account_id, name, section, props::text as p, created_at,
         count(*)::int as n, min(id) as minid, max(id) as maxid
    from events
   group by 1,2,3,4,5,6
  having count(*) > 1`;
// `is not distinct from` throughout: device_id, account_id and section are all nullable, and `=`
// answers NULL for a null on either side — which would silently match nothing and delete nothing.
const VICTIMS = `
  with g as (${GROUPS}), spread as (select * from g where maxid - minid <> n - 1)
  select e.id
    from events e
    join spread s
      on e.device_id is not distinct from s.device_id
     and e.account_id is not distinct from s.account_id
     and e.name = s.name
     and e.section is not distinct from s.section
     and e.props::text = s.p
     and e.created_at = s.created_at
   where e.id <> s.minid`;

const before = await sql`select count(*)::int as rows from events`;
const shape = await sql.query(`
  select case when maxid - minid = n - 1 then 'contiguous' else 'spread' end as shape,
         count(*)::int as groups, sum(n - 1)::int as excess_rows
    from (${GROUPS}) g group by 1 order by 1`);
const victims = await sql.query(`select count(*)::int as n from (${VICTIMS}) v`);

console.log(`   rows now: ${before[0].rows}`);
for (const s of shape) console.log(`   ${s.shape.padEnd(10)} groups ${String(s.groups).padStart(4)}   extra rows ${s.excess_rows}`);
console.log(`   would delete: ${victims[0].n} rows (spread groups only; the lowest id in each group is kept)`);

if (!APPLY) {
  console.log('\n   dry run — nothing was changed. Re-run with --apply to perform the cleanup.');
  process.exit(0);
}

// `like events` WITHOUT defaults: the backup must not share the id sequence, and the rows go in with
// their original ids so a restore is a plain `insert into events select * from events_bug123_backup`.
await sql`create table if not exists events_bug123_backup (like events)`;
await sql.transaction([
  sql.query(`insert into events_bug123_backup select * from events where id in (${VICTIMS})`),
  sql.query(`delete from events where id in (${VICTIMS})`),
]);

const after = await sql`select count(*)::int as rows from events`;
const kept = await sql.query(`select count(*)::int as groups from (${GROUPS}) g where maxid - minid = n - 1`);
const left = await sql.query(`select count(*)::int as groups from (${GROUPS}) g where maxid - minid <> n - 1`);
const backup = await sql`select count(*)::int as rows from events_bug123_backup`;
console.log(`\n✓ rows: ${before[0].rows} → ${after[0].rows}  (removed ${before[0].rows - after[0].rows})`);
console.log(`  backed up in events_bug123_backup: ${backup[0].rows}`);
console.log(`  spread groups remaining: ${left[0].groups} (expected 0)`);
console.log(`  contiguous groups deliberately kept: ${kept[0].groups}`);
