// Per-user X quota helpers (TASK-100). Pure — no DB, no I/O, no `process.env` read — so they are
// unit-tested directly, the way `_events.js` is. `nowMs` and `env` are parameters for that reason.
//
// Underscore-prefixed, so it does not count against Vercel Hobby's 12-function cap (we sit at 12/12).

// The UTC calendar day, as `YYYY-MM-DD`.
//
// UTC is not a stylistic choice. X deduplicates a post's billing "within a day", so a counter keyed
// to any other clock is counting a different quantity from the one we are charged for. Built from
// the ISO string rather than local date parts precisely so the machine's timezone cannot move it.
export function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// The configured daily per-user post limit, or null when enforcement is off.
//
// FAIL-SAFE DIRECTION: only a positive integer turns enforcement ON. Everything else — unset, empty,
// '0', negative, fractional, junk — reads as null and leaves every user counted and served. A typo
// in a Vercel env var must never be the thing that refuses everybody's feed, and the asymmetry is
// deliberate: the cost of failing open is some spend we can see in the counters, while the cost of
// failing closed is the app looking broken for every user at once.
export function readQuotaLimit(env) {
  const raw = env?.X_DAILY_POST_QUOTA;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;      // rejects '', ' ', '-5', '4.5', 'abc', 'NaN'
  const n = Number(trimmed);
  return n > 0 ? n : null;                      // '0' disables rather than blocking everything
}

// Is this owner already at or past their limit? Checked BEFORE the fetch, so `used >= limit` is the
// right comparison: the request being judged is the one that would carry them past N.
//
// An unreadable count (a DB blip returning null/NaN) fails OPEN — criterion 12. A counting failure
// must serve the feed, never refuse it.
export function quotaExceeded(used, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  // An unreadable count fails OPEN (criterion 12) — and that is provided by the comparison itself,
  // not by a guard: `Number(null)` is 0 and `Number(undefined)`/`Number('lots')` are NaN, and every
  // comparison against NaN is false. An explicit `isFinite(used)` check was here and was removed
  // deliberately: no mutation could pin it, so it read as load-bearing while pinning nothing.
  return Number(used) >= limit;
}

// The fuse as a HUMAN must read it (CHR-074). `readQuotaLimit` answers "what does the code ENFORCE"
// and collapses four different situations into one `null` — correct for enforcement, useless for
// diagnosis. "Never set", "typed wrong" and "switched off on purpose" each need a different response
// from whoever is looking at the admin panel, and until now nothing could tell them apart: a silent
// fuse plus a write-only env var means a typo and a working 800 produce identical evidence.
//
// Pure, with `env` as a parameter, for exactly the reason `readQuotaLimit` is — so the states are
// unit-testable without a handler, a database or a deployment.
export function fuseStatus(env) {
  // Ask the enforcement path FIRST and defer to it. If these two ever disagree about whether the
  // fuse is armed, the panel is lying about the code that actually runs, which is the one failure
  // this function exists to prevent (pinned by Q17).
  const limit = readQuotaLimit(env);
  if (limit != null) return { state: 'on', limit };

  const raw = env?.X_DAILY_POST_QUOTA;
  const trimmed = raw == null ? '' : String(raw).trim();
  if (trimmed === '') return { state: 'unset', limit: null };

  // Zero is a DELIBERATE off switch — `readQuotaLimit` documents it as "disables rather than
  // blocking everything". Folding it into `unreadable` would report a fault where a choice was
  // made, and send someone hunting a typo that does not exist.
  if (/^\d+$/.test(trimmed) && Number(trimmed) === 0) return { state: 'disabled', limit: 0 };

  return { state: 'unreadable', limit: null };
}
