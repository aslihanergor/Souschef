// Pure dashboard-aggregation tests (TASK-087 — owner-excluded DAU + returning-user retention).
// Zero-dep node:test. dauByDay() is the classification half of the metric; the SQL owns
// owner-exclusion, the person-key coalesce(account_id, device_id), and each person's first-seen
// day (over ALL history). This turns per-(person, day) rows into a day-by-day active-users series
// split into new vs returning — the retention signal the go/no-go rests on. The SQL itself is
// live-verified against the non-prod DB (it can't be unit-tested without a database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dauByDay, xMeterRollup } from '../api/_analytics.js';

test('dauByDay: empty input → empty series', () => {
  assert.deepEqual(dauByDay([]), []);
});

test('dauByDay: non-array input → empty series (defensive, matches sanitizeEvents)', () => {
  assert.deepEqual(dauByDay(null), []);
  assert.deepEqual(dauByDay(undefined), []);
});

test('dauByDay: a first-ever-active person counts as new, not returning', () => {
  assert.deepEqual(
    dauByDay([{ person: 'p1', day: '2026-07-20', firstDay: '2026-07-20' }]),
    [{ day: '2026-07-20', dau: 1, fresh: 1, returning: 0 }],
  );
});

test('dauByDay: the same person on a later day is returning (the retention signal)', () => {
  const rows = [
    { person: 'p1', day: '2026-07-20', firstDay: '2026-07-20' },
    { person: 'p1', day: '2026-07-22', firstDay: '2026-07-20' },
  ];
  assert.deepEqual(dauByDay(rows), [
    { day: '2026-07-20', dau: 1, fresh: 1, returning: 0 },
    { day: '2026-07-22', dau: 1, fresh: 0, returning: 1 },
  ]);
});

test('dauByDay: the same (person, day) twice is one active user', () => {
  const rows = [
    { person: 'p1', day: '2026-07-20', firstDay: '2026-07-20' },
    { person: 'p1', day: '2026-07-20', firstDay: '2026-07-20' },
  ];
  assert.deepEqual(dauByDay(rows), [{ day: '2026-07-20', dau: 1, fresh: 1, returning: 0 }]);
});

test('dauByDay: first-seen long before the window still classifies as returning', () => {
  // The 40-days-before case: firstDay predates every day in the window, so the person is
  // returning, never new. This only holds because firstDay is computed over ALL history — the
  // exact bug the criterion guards against (a windowed first-seen would mislabel them "new").
  const rows = [{ person: 'p1', day: '2026-07-20', firstDay: '2026-06-10' }];
  assert.deepEqual(dauByDay(rows), [{ day: '2026-07-20', dau: 1, fresh: 0, returning: 1 }]);
});

test('dauByDay: a single day mixes new and returning people', () => {
  const rows = [
    { person: 'p1', day: '2026-07-20', firstDay: '2026-07-20' }, // new that day
    { person: 'p2', day: '2026-07-20', firstDay: '2026-07-01' }, // returning
  ];
  assert.deepEqual(dauByDay(rows), [{ day: '2026-07-20', dau: 2, fresh: 1, returning: 1 }]);
});

test('dauByDay: output is sorted by day ascending regardless of input order', () => {
  const rows = [
    { person: 'p1', day: '2026-07-22', firstDay: '2026-07-20' },
    { person: 'p1', day: '2026-07-20', firstDay: '2026-07-20' },
    { person: 'p1', day: '2026-07-21', firstDay: '2026-07-20' },
  ];
  assert.deepEqual(dauByDay(rows).map((r) => r.day), ['2026-07-20', '2026-07-21', '2026-07-22']);
});

test('dauByDay: new + returning always equals dau', () => {
  const rows = [
    { person: 'p1', day: '2026-07-20', firstDay: '2026-07-20' },
    { person: 'p2', day: '2026-07-20', firstDay: '2026-07-19' },
    { person: 'p3', day: '2026-07-20', firstDay: '2026-07-20' },
    { person: 'p1', day: '2026-07-21', firstDay: '2026-07-20' },
  ];
  for (const r of dauByDay(rows)) assert.equal(r.fresh + r.returning, r.dau);
});

test('dauByDay: rows missing a person or day are skipped, not counted', () => {
  const rows = [
    { person: 'p1', day: '2026-07-20', firstDay: '2026-07-20' },
    { person: null, day: '2026-07-20', firstDay: '2026-07-20' }, // no person key → skip
    { person: 'p2', day: null, firstDay: '2026-07-20' },          // no day → skip
  ];
  assert.deepEqual(dauByDay(rows), [{ day: '2026-07-20', dau: 1, fresh: 1, returning: 0 }]);
});

// ── X meter rollups (CHR-072) ───────────────────────────────────────────────
// xMeterRollup is the arithmetic half of the "X cost & volume" panel. The SQL owns the two
// aggregates (distinct posts per UTC day from x_posts_seen; per-owner posts per UTC day from
// x_usage) and the email join; this turns them into the series the dashboard renders.
//
// The load-bearing rule is criterion 2: SPEND is distinct posts x price and must NEVER be derived
// from x_usage, which overstates by design (scripts/init-db.mjs:163) and by ~2.8x today while
// [BUG-110] is open. `today` is passed in rather than read from the clock so the zero-fill is
// deterministic — and it is a UTC 'YYYY-MM-DD', because both tables store UTC dates.

const spend = (day, posts) => ({ day, posts });
const vol = (day, ownerKind, ownerId, posts, email = null) =>
  ({ day, ownerKind, ownerId, posts, email });

test('xMeterRollup: no rows → empty series and zeroed totals', () => {
  const r = xMeterRollup({ spendRows: [], volumeRows: [], today: '2026-09-03' });
  assert.deepEqual(r.days, []);
  assert.deepEqual(r.owners, []);
  assert.equal(r.totals.posts, 0);
  assert.equal(r.totals.costUsd, 0);
  assert.equal(r.totals.volume, 0);
  assert.equal(r.totals.ratio, null);
});

test('xMeterRollup: non-array input → empty rollup (defensive, matches dauByDay)', () => {
  for (const bad of [null, undefined, 'rows', 42, {}]) {
    const r = xMeterRollup({ spendRows: bad, volumeRows: bad, today: '2026-09-03' });
    assert.deepEqual(r.days, []);
    assert.deepEqual(r.owners, []);
  }
  assert.deepEqual(xMeterRollup().days, []); // no argument at all
});

test('xMeterRollup: daily cost is distinct posts times the X post price', () => {
  const r = xMeterRollup({ spendRows: [spend('2026-09-02', 45)], volumeRows: [], today: '2026-09-02' });
  assert.equal(r.days.length, 1);
  assert.equal(r.days[0].posts, 45);
  assert.equal(r.days[0].costUsd, 0.225); // 45 x $0.005
  assert.equal(r.totals.costUsd, 0.225);
});

test('xMeterRollup: cost comes from x_posts_seen, never from x_usage volume', () => {
  // The shape measured on production 2026-09-02: one person on two devices, 125 counted vs 45
  // distinct. Pricing the wrong meter overstates spend 2.8x and could talk us out of launching.
  const r = xMeterRollup({
    spendRows: [spend('2026-09-02', 45)],
    volumeRows: [vol('2026-09-02', 'account', 'a1', 125, 'asli@example.com')],
    today: '2026-09-02',
  });
  assert.equal(r.days[0].costUsd, 0.225);   // 45 x $0.005, not 125 x $0.005 = 0.625
  assert.equal(r.totals.costUsd, 0.225);
});

test('xMeterRollup: dedup ratio is summed volume over distinct posts', () => {
  const r = xMeterRollup({
    spendRows: [spend('2026-09-02', 45)],
    volumeRows: [
      vol('2026-09-02', 'account', 'a1', 100, 'a@example.com'),
      vol('2026-09-02', 'device', 'd1', 25),
    ],
    today: '2026-09-02',
  });
  assert.equal(r.days[0].volume, 125);
  assert.equal(r.days[0].ratio, 2.78);
  assert.equal(r.totals.ratio, 2.78);
});

test('xMeterRollup: volume with no distinct posts yields no ratio, not Infinity', () => {
  const r = xMeterRollup({
    spendRows: [],
    volumeRows: [vol('2026-09-02', 'account', 'a1', 7, 'a@example.com')],
    today: '2026-09-02',
  });
  assert.equal(r.days[0].posts, 0);
  assert.equal(r.days[0].volume, 7);
  assert.equal(r.days[0].ratio, null);
  assert.equal(r.totals.ratio, null);
});

test('xMeterRollup: a quiet day between active days is zero-filled, not dropped', () => {
  const r = xMeterRollup({
    spendRows: [spend('2026-09-01', 10), spend('2026-09-03', 20)],
    volumeRows: [],
    today: '2026-09-03',
  });
  assert.deepEqual(r.days.map((d) => d.day), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(r.days[1].posts, 0);
  assert.equal(r.days[1].costUsd, 0);
  assert.equal(r.days[1].ratio, null);
});

test('xMeterRollup: days after the last metered day fill to today (the metering-stopped tell)', () => {
  // Criterion 8's real purpose: metering that silently stopped two days ago must LOOK stopped.
  // recordUsage swallows every error by design, so trailing zeros are the only symptom there is.
  const r = xMeterRollup({ spendRows: [spend('2026-09-01', 10)], volumeRows: [], today: '2026-09-03' });
  assert.deepEqual(r.days.map((d) => d.day), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(r.days[2].posts, 0);
});

test('xMeterRollup: account owners are labelled by email, device owners stay anonymous', () => {
  const r = xMeterRollup({
    spendRows: [],
    volumeRows: [
      vol('2026-09-02', 'account', 'a1', 30, 'asli@example.com'),
      vol('2026-09-02', 'device', 'device-abc-123', 12),
    ],
    today: '2026-09-02',
  });
  assert.ok(r.owners.map((o) => o.label).includes('asli@example.com'));
  const dev = r.owners.find((o) => o.ownerKind === 'device');
  assert.equal(dev.label, 'anonymous device');
  // Not merely absent from the LABEL — absent from the row. The whole rollup is returned by
  // /api/state?admin=1 and re-fetched every 30s, and a device id is what resolveOwner accepts as
  // X-Device-Id, so carrying it would put that device's authenticator on the wire unrendered.
  assert.ok(!('ownerId' in dev), `raw owner id reached the payload: ${JSON.stringify(dev)}`);
  assert.ok(!JSON.stringify(r.owners).includes('device-abc-123'), JSON.stringify(r.owners));
});

test('xMeterRollup: an account row whose email did not resolve is labelled, not blank', () => {
  const r = xMeterRollup({
    spendRows: [],
    volumeRows: [vol('2026-09-02', 'account', 'a1', 3, null)],
    today: '2026-09-02',
  });
  assert.equal(r.owners[0].label, 'account (no email)');
});

test('xMeterRollup: rows may arrive unsorted and come back ascending by day', () => {
  const r = xMeterRollup({
    spendRows: [spend('2026-09-03', 5), spend('2026-09-01', 1)],
    volumeRows: [],
    today: '2026-09-03',
  });
  assert.deepEqual(r.days.map((d) => d.day), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(r.days[0].posts, 1);
  assert.equal(r.days[2].posts, 5);
});

test('xMeterRollup: totals sum posts, cost and volume across every day', () => {
  const r = xMeterRollup({
    spendRows: [spend('2026-09-01', 10), spend('2026-09-02', 20)],
    volumeRows: [
      vol('2026-09-01', 'account', 'a1', 15, 'a@example.com'),
      vol('2026-09-02', 'account', 'a1', 45, 'a@example.com'),
    ],
    today: '2026-09-02',
  });
  assert.equal(r.totals.posts, 30);
  assert.equal(r.totals.costUsd, 0.15);
  assert.equal(r.totals.volume, 60);
  assert.equal(r.totals.ratio, 2);
});

test('xMeterRollup: the owner table reads newest day first, heaviest reader first', () => {
  const r = xMeterRollup({
    spendRows: [],
    volumeRows: [
      vol('2026-09-01', 'account', 'a1', 5, 'light@example.com'),
      vol('2026-09-02', 'account', 'a1', 10, 'light@example.com'),
      vol('2026-09-02', 'account', 'a2', 90, 'heavy@example.com'),
    ],
    today: '2026-09-02',
  });
  // Newest first, because the fairness question is always "who is burning the top-up TODAY".
  assert.deepEqual(r.owners.map((o) => [o.day, o.posts]),
    [['2026-09-02', 90], ['2026-09-02', 10], ['2026-09-01', 5]]);
});

test('xMeterRollup: a malformed day is skipped, not bucketed (M13 in the CHR-072 battery)', () => {
  // Added because the battery measured this as a survivor. An unvalidated day would become a
  // bucket key and the zero-fill would walk forward from garbage — up to its 366-day bound.
  const r = xMeterRollup({
    spendRows: [{ day: 'not-a-date', posts: 99 }, spend('2026-09-02', 4)],
    volumeRows: [vol('', 'account', 'a1', 50, 'a@example.com')],
    today: '2026-09-02',
  });
  assert.deepEqual(r.days.map((d) => d.day), ['2026-09-02']);
  assert.equal(r.days[0].posts, 4);
  assert.deepEqual(r.owners, []);
  assert.equal(r.totals.posts, 4);
});

// ── Guards the CHR-072 review found unpinned ────────────────────────────────

test('xMeterRollup: a silent volume meter reads as absent, never as a perfect dedup ratio', () => {
  // Found in review. The guard protected the denominator only, so posts>0 with volume=0 returned
  // ratio 0 and rendered "0.00x" — the most FAVOURABLE reading available, on the figure that
  // decides whether twenty users cost ~$9 or ~$180 a month. Reachable: recordUsage writes
  // x_posts_seen unconditionally but x_usage only `if (owner)`, so an unattributed fetch meters
  // spend and not volume; if x_usage writes broke entirely, the headline would read "extra users
  // are nearly free" rather than "something is wrong".
  const r = xMeterRollup({
    spendRows: [spend('2026-09-02', 45), spend('2026-09-03', 30)],
    volumeRows: [],
    today: '2026-09-03',
  });
  assert.equal(r.days[0].ratio, null);
  assert.equal(r.days[1].ratio, null);
  assert.equal(r.totals.ratio, null);
  assert.equal(r.totals.posts, 75);      // spend itself stays exact and visible
  assert.equal(r.totals.costUsd, 0.375);
});

test('xMeterRollup: a partly-silent volume meter still reports its (low) ratio', () => {
  // The complement of the test above: only a FULLY silent day reads as absent. A day that recorded
  // some volume must still show it, low ratio and all, or a half-broken meter hides behind "—".
  const r = xMeterRollup({
    spendRows: [spend('2026-09-02', 45)],
    volumeRows: [vol('2026-09-02', 'account', 'a1', 5, 'a@example.com')],
    today: '2026-09-02',
  });
  assert.equal(r.days[0].ratio, 0.11);
});

test('xMeterRollup: a non-numeric count is zeroed on the owner row, never propagated as NaN', () => {
  // The FIRST version of this test asserted on days/totals and could not fail. Measured, not
  // reasoned: the `|| 0` in both accumulators and again in the day loop absorbs NaN, so asCount's
  // finite guard has NO observable effect there — `Number('lots')` is NaN, `NaN || 0` is 0, and a
  // clean number comes out either way. The guard is load-bearing on ONE path only: owners[].posts
  // takes asCount's result directly, with no fallback behind it. Asserting the quantity the guard
  // actually protects is what turns this from decoration into a test (battery M13b).
  const r = xMeterRollup({
    spendRows: [{ day: '2026-09-02', posts: 'lots' }, spend('2026-09-02', 4)],
    volumeRows: [vol('2026-09-02', 'account', 'a1', 'plenty', 'a@example.com')],
    today: '2026-09-02',
  });
  assert.equal(r.owners[0].posts, 0, 'NaN reached an owner row');
  assert.ok(!Number.isNaN(r.owners[0].posts));
  assert.equal(r.days[0].posts, 4);
  assert.equal(r.days[0].volume, 0);
  assert.equal(r.totals.costUsd, 0.02);
});

test('xMeterRollup: a day later than today is still rendered, not truncated away', () => {
  // maxDay picks the later of (last observed day, today). Returning `today` unconditionally would
  // silently drop days that HAVE data whenever the clock is behind a row — and those rows carry
  // real spend, so they would vanish from the totals too.
  // Dates kept in the PAST on purpose — docs.test.mjs fails the suite on any future-dated claim
  // under test/, and it caught this fixture when it was written with tomorrow's date.
  const r = xMeterRollup({
    spendRows: [spend('2026-08-20', 10), spend('2026-08-23', 6)],
    volumeRows: [],
    today: '2026-08-21',
  });
  assert.deepEqual(r.days.map((d) => d.day),
    ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23']);
  assert.equal(r.totals.posts, 16);
});

test('xMeterRollup: an owner_kind that is neither account nor device stays anonymous', () => {
  // The guard is `!== 'account'`, not `=== 'device'`. Written that way on purpose: a third
  // owner_kind must fall to the anonymous side, never be named by a field we have not vetted.
  const r = xMeterRollup({
    spendRows: [],
    volumeRows: [{ day: '2026-09-02', ownerKind: 'service', ownerId: 'svc-1', posts: 3, email: 'leak@example.com' }],
    today: '2026-09-02',
  });
  assert.equal(r.owners[0].label, 'anonymous device');
});

test('xMeterRollup: a whitespace-only email is treated as no email, not a blank cell', () => {
  const r = xMeterRollup({
    spendRows: [],
    volumeRows: [vol('2026-09-02', 'account', 'a1', 3, '   ')],
    today: '2026-09-02',
  });
  assert.equal(r.owners[0].label, 'account (no email)');
});
