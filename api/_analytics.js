// Pure dashboard aggregation for the owner-only analytics layer. No DB, no I/O —
// unit-tested in test/analytics.test.mjs.
//
// The SQL owns the parts that need the database: owner-exclusion, the person-key
// coalesce(account_id, device_id), and each person's first-seen day computed over ALL history.
// dauByDay() is the pure classification half: it turns per-(person, day) rows into a day-by-day
// active-users series, split into `fresh` (the person's first-ever active day IS this day) vs
// `returning` (they were active before it) — the retention signal the go/no-go rests on. The field
// is `fresh`, not `new`, because `new` is a reserved word — `const { new } = row` is a SyntaxError.
//
// rows: [{ person, day, firstDay }] where day/firstDay are 'YYYY-MM-DD' strings (lexical order ==
// chronological order, so string comparison is safe). Returns [{ day, dau, fresh, returning }],
// sorted by day ascending, with fresh + returning === dau by construction.
export function dauByDay(rows) {
  if (!Array.isArray(rows)) return [];

  // De-dupe to one (person, day): a person active many times in a day is a single active user.
  const byDay = new Map(); // day -> Map<person, firstDay>
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const { person, day, firstDay } = r;
    if (person == null || !day) continue; // no person-key or no day → not an active-user row
    if (!byDay.has(day)) byDay.set(day, new Map());
    byDay.get(day).set(person, firstDay);
  }

  const out = [];
  for (const [day, people] of byDay) {
    let returning = 0;
    for (const firstDay of people.values()) {
      // firstDay is the first-ever active day (over all history). Strictly before today → they
      // are coming back; equal (or missing) → counted as fresh.
      if (firstDay && firstDay < day) returning += 1;
    }
    const dau = people.size;
    out.push({ day, dau, fresh: dau - returning, returning });
  }
  out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return out;
}

// ── X meters ──────────────────────────────────────────────────────

// Price per post retrieved from X, in USD. DISPLAY-ONLY: nothing here can refuse a fetch — the
// fuse that does is a post COUNT, `X_DAILY_POST_QUOTA` (api/_quota.js). A wrong value here makes a
// number on the owner's dashboard wrong and changes nothing a user can see.
//
// Source: the X developer portal's pay-per-use rate.
// A constant rather than an env var deliberately: a Vercel env var set for
// Development alone leaves Production on the fallback path, and a spend panel
// reading $0.00 looks exactly like "nobody read any posts" — the very ambiguity this meter exists to
// remove. Changing it is a one-line edit whose value is then visible in git history.
export const X_POST_PRICE_USD = 0.005;

// Turn the two X meter aggregates into the series the owner dashboard renders.
//
//   spendRows  [{ day, posts }]                         distinct post ids per UTC day (x_posts_seen)
//   volumeRows [{ day, ownerKind, ownerId, posts, email }] per owner per UTC day (x_usage)
//   today      'YYYY-MM-DD' in UTC — passed in, not read from the clock, so the zero-fill is
//              deterministic and so the caller cannot accidentally bucket by a browser timezone.
//
// Days are 'YYYY-MM-DD' strings throughout, so lexical order IS chronological order — the same
// contract dauByDay above relies on, and the reason the SQL uses to_char rather than returning a
// date. Returns { days, owners, totals }.
export function xMeterRollup({ spendRows, volumeRows, today } = {}) {
  const spend = Array.isArray(spendRows) ? spendRows : [];
  const volume = Array.isArray(volumeRows) ? volumeRows : [];

  const postsByDay = new Map();
  for (const r of spend) {
    const day = asDay(r?.day);
    if (!day) continue;
    postsByDay.set(day, (postsByDay.get(day) || 0) + asCount(r.posts));
  }

  const volumeByDay = new Map();
  const owners = [];
  for (const r of volume) {
    const day = asDay(r?.day);
    if (!day) continue;
    const posts = asCount(r.posts);
    volumeByDay.set(day, (volumeByDay.get(day) || 0) + posts);
    // The raw owner id is deliberately NOT carried onto this row. It reaches the browser
    // otherwise — the whole rollup is returned by /api/state?admin=1 and re-fetched every 30s —
    // and for a device owner that id is what resolveOwner accepts as X-Device-Id, i.e. that
    // device's only authenticator. Nothing renders it; nothing needs it.
    owners.push({ day, ownerKind: r.ownerKind, label: ownerLabel(r), posts });
  }

  if (postsByDay.size === 0 && volumeByDay.size === 0) {
    return { days: [], owners: [], totals: { posts: 0, costUsd: 0, volume: 0, ratio: null } };
  }

  // Newest day first, heaviest reader first within a day: the fairness question is always "who is
  // burning the top-up today".
  owners.sort((a, b) => (a.day === b.day ? b.posts - a.posts : (a.day < b.day ? 1 : -1)));

  const observed = [...postsByDay.keys(), ...volumeByDay.keys()].sort();
  const first = observed[0];
  const lastObserved = observed[observed.length - 1];
  // Fill THROUGH today, not merely to the last day that has rows. recordUsage swallows every error
  // by design, so metering that stopped two days ago leaves no error
  // anywhere — a run of trailing zeros is the only symptom it can ever produce.
  const end = maxDay(lastObserved, asDay(today) || lastObserved);

  const days = [];
  // Bounded against a VALID but far-future `today` — a skewed server clock, not a malformed
  // string: a malformed one is rejected by asDay above and falls back to lastObserved, so it can
  // never drive this loop. The queries look back 30 days, so 366 buckets is already far past
  // anything renderable; if this ever fires it truncates silently, which is why it is far from
  // any reachable range rather than snug.
  for (let day = first, guard = 0; day <= end && guard < 366; day = nextDay(day), guard += 1) {
    const posts = postsByDay.get(day) || 0;
    const vol = volumeByDay.get(day) || 0;
    days.push({
      day,
      posts,
      // SPEND IS DISTINCT POSTS, NEVER x_usage. x_usage overstates on overlap by design
      // (scripts/init-db.mjs:163) and by ~2.8x while a known over-count remains open; pricing it would
      // overstate the trial's cost by the same factor.
      costUsd: round(posts * X_POST_PRICE_USD, 4),
      volume: vol,
      // BOTH terms are guarded, not just the denominator. `vol === 0` with `posts > 0` means the
      // FAIRNESS meter recorded nothing while the spend meter did — recordUsage writes x_posts_seen
      // unconditionally but x_usage only `if (owner)` (api/feed.js:171-186), so an unattributed
      // fetch produces exactly that. Reporting it as 0.00x would be the most FAVOURABLE dedup
      // reading available ("extra users are nearly free") on the figure that decides whether twenty
      // users cost ~$9 or ~$180 a month. A dead meter must read as absent, never as good news.
      ratio: posts > 0 && vol > 0 ? round(vol / posts, 2) : null,
    });
  }

  const totalPosts = days.reduce((n, d) => n + d.posts, 0);
  const totalVolume = days.reduce((n, d) => n + d.volume, 0);
  return {
    days,
    owners,
    totals: {
      posts: totalPosts,
      costUsd: round(totalPosts * X_POST_PRICE_USD, 4),
      volume: totalVolume,
      ratio: totalPosts > 0 && totalVolume > 0 ? round(totalVolume / totalPosts, 2) : null,
    },
  };
}

// An account is named by its email; a device is never named at all. The raw
// id is not on the returned row either (see the push above), so "anonymous" is a property of the
// payload and not only of the rendering.
function ownerLabel(r) {
  if (r?.ownerKind !== 'account') return 'anonymous device';
  const email = typeof r.email === 'string' ? r.email.trim() : '';
  return email || 'account (no email)';
}

function asDay(d) {
  return (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : null;
}

function asCount(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.trunc(v) : 0;
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function maxDay(a, b) { return a > b ? a : b; }

function nextDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
