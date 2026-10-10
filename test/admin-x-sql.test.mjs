// Source-level guards on the two X meter queries in adminStats.
//
// WHY THIS IS A SOURCE TEST, stated plainly rather than dressed up. adminStats calls db() at module
// scope and test-helpers/handler.mjs is a stateful fake store that throws on any query it does not
// recognise; teaching it to EVALUATE `sum … group by` would be
// disproportionate for an owner-only read-only panel. So there is no behavioural test that can
// reach these two queries, and the consequence is that an
// owner-exclusion clause, a timezone swap and a wrong-table swap would all keep the suite green.
//
// The owner account must be included, and a test must pin that, so a future tidy-up toward
// the active-user metrics' exclusion rule cannot silently empty the
// panel. A source assertion is a weaker instrument than a behavioural one — it pins the TEXT of
// the query, not its result — but it is strictly stronger than the nothing that was there, and it
// fails exactly when that tidy-up is attempted. Replace it with a behavioural
// test the day the fake store learns aggregates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../api/state.js', import.meta.url), 'utf8');

const START = '// X cost & volume meters (CHR-072)';
const END = 'return { tz, totals';

// Non-vacuity first. If either marker moves, indexOf returns -1 and every assertion below would
// run against a garbage slice and pass — the failure mode that makes a green source test worthless.
function meterBlock() {
  const from = SRC.indexOf(START);
  const to = SRC.indexOf(END);
  assert.ok(from !== -1, `marker moved: ${START}`);
  assert.ok(to > from, `marker moved or reordered: ${END}`);
  return SRC.slice(from, to);
}

function query(block, decl) {
  const at = block.indexOf(decl);
  assert.ok(at !== -1, `query declaration not found: ${decl}`);
  const body = block.slice(at + decl.length);
  const end = body.indexOf('`');
  assert.ok(end > 0, `unterminated template literal after ${decl}`);
  const sql = body.slice(0, end);
  assert.ok(sql.includes('select') && sql.length > 50, `extracted text is not a query: ${sql}`);
  return sql;
}

const spend = () => query(meterBlock(), 'const spendRows = await sql`');
const volume = () => query(meterBlock(), 'const volumeRows = await sql`');

test('CHR-072 c2: the SPEND query reads x_posts_seen and never x_usage', () => {
  // The pure function prices whatever `spendRows` holds, so swapping the table here prices the
  // fairness meter — which overstates spend — with every arithmetic test green.
  const q = spend();
  assert.ok(q.includes('from x_posts_seen'), q);
  assert.ok(!q.includes('from x_usage'), q);
  assert.ok(q.includes('count(*)'), q);
});

test('CHR-072 c2: the VOLUME query reads x_usage and never x_posts_seen', () => {
  const q = volume();
  assert.ok(q.includes('from x_usage'), q);
  assert.ok(!q.includes('from x_posts_seen'), q);
});

test('CHR-072 c7: the owner is INCLUDED — no exclusion clause on either meter query', () => {
  // The two ACTIVE-USER metrics exclude the owner, and this panel deliberately
  // inverts that: before launch the owner's account is the only one with meter rows at all, so
  // adopting the exclusion here would empty the panel.
  for (const q of [spend(), volume()]) {
    assert.ok(!/<>\s*all/.test(q), `owner exclusion reached a meter query: ${q}`);
    assert.ok(!q.includes('ownerAccountIds'), q);
    assert.ok(!q.includes('ownerDeviceIds'), q);
  }
});

test('CHR-072 c6: both meter queries bucket by UTC, never by the client timezone', () => {
  // x_usage.day and x_posts_seen.day are UTC dates because that is the window X bills on. Every
  // OTHER rollup in adminStats buckets by `${tz}` from the browser. Swapping this one in would
  // re-window spend against a clock X does not bill on while the on-screen "UTC" label stayed there
  // being wrong — the panel would not look broken, it would look precise.
  for (const q of [spend(), volume()]) {
    assert.ok(q.includes("at time zone 'UTC'"), q);
    assert.ok(!q.includes('${tz}'), q);
  }
});

test('CHR-072: both meter queries read a 30-day window, matching the retention sweep', () => {
  // api/feed.js sweeps rows older than 30 days on write, so the read window and the retention
  // window have to agree or the oldest day silently truncates.
  for (const q of [spend(), volume()]) {
    assert.match(q, /date - 30/, q);
  }
});
