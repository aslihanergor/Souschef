// Pure event helpers for the owner-only analytics layer (TASK-070). No DB, no I/O — unit-tested
// in test/events.test.mjs. Shared by api/state.js (ingestion) and mirrored (in spirit) by app.js's
// client-side track(). Events are appended to the `events` table; they are NOT synced state.

// Allowlist of event names (section/action level — never a content id). Anything not here is
// dropped: the client can't invent event types and a malformed/hostile batch can't pollute the log.
export const EVENT_NAMES = new Set([
  'signin', 'signout', 'account_created', 'session_start',
  'view', 'mark_done', 'mark_all_done', 'archive', 'add_channel',
  'remove_channel', 'group_open', 'video_play', 'reader_open',
  'youtube_import', 'refresh',
  // TASK-084: the sign-in wall is the only way into the app, so this is the denominator of the one
  // rate that says whether it costs us users — landing_view vs signin. An allowlist is a silent
  // dropper by design: without this entry the client would emit the event, the PUT would carry it,
  // and normalizeEvent would bin it, leaving a metric that measures nothing and looks healthy.
  'landing_view',
  // [BUG-104], 2026-08-28. `group_classify` and `group_view_toggle` were BOTH being emitted by
  // `app.js` and BOTH binned here — the precise failure the comment above describes, landed twice
  // more without anyone noticing, because a silent dropper leaves a metric that looks healthy.
  // `group_classify` is [CHR-012]'s instrument, whose whole purpose was to measure the
  // groupable-unread distribution nobody had ever measured; it has recorded NOTHING since it
  // shipped. `group_view_toggle` is [TASK-099]'s adoption metric, same story. The historical data is
  // simply gone — this entry starts the collection, it cannot recover it.
  // `docs.test.mjs` now fails the suite if `app.js` emits a name absent from this set, so the class
  // of defect is mechanised rather than left to review.
  'group_classify', 'group_view_toggle',
  // The timeout counter added with BUG-104's bound: GROUP_TIMEOUT_MS is sized from a model and never
  // from a measurement at MAX_ITEMS scale, so this is how a wrong bound surfaces as data.
  'group_classify_timeout',
  // [BUG-116], 2026-09-09. The remaining classify outcomes. `group_classify` fires BEFORE the call
  // and is the attempt denominator; these three are the ways an attempt fails to produce grouping:
  //   degraded — a 200 from our endpoint carrying no usable groups (which is also how a missing key
  //              or an Anthropic outage arrives, since api/group.js converts every server-side
  //              failure into that shape);
  //   failed   — a non-2xx (WAF deny, platform 5xx) or a thrown fetch, neither of which reaches the
  //              handler at all;
  //   repaired — a SUCCESS, recorded because the reply's `groups` arrived as a string; its
  //              `truncated` prop separates a cut-off string from a merely serialised one.
  // With `group_classify_timeout` the space now partitions, so clean successes are derivable by
  // subtraction. An earlier version of this comment claimed three names made the outcomes "add up"
  // while two outcomes were counted by nothing — the arithmetic is the whole point, so it is stated
  // here explicitly rather than asserted.
  // Added in the SAME commit as their `track()` calls, deliberately: the comment above records this
  // exact allowlist being missed twice, leaving metrics that looked healthy and recorded nothing.
  'group_classify_degraded', 'group_classify_repaired', 'group_classify_failed',
  // [TASK-092] The first-run tour, also in the same commit as its `track()` calls. `tour_start` carries
  // whether it is a replay and `tour_close` the part and card it was closed on, so the funnel can see
  // which card people abandon.
  'tour_start', 'tour_close', 'tour_finish',
]);

export const MAX_EVENTS_PER_BATCH = 100;  // cap per PUT — guards the hot /api/state path
export const MAX_PROPS_BYTES = 1024;      // per-event props cap (metadata only; not content)
const MAX_STR = 120;                      // section/name length clamp

// [BUG-123] An event's IDENTITY, minted by the client in `track()` and carried unchanged through
// every re-send. Without it a re-sent batch and a second real action are the same bytes on the wire,
// which is how one sign-in came to be stored four times: a closing page sends its buffer twice (both
// `visibilitychange` and `pagehide` reach flushPush), never reads the answers, and the next boot
// sends it again. A malformed id is discarded rather than rejected — the event still counts, it just
// cannot be de-duplicated, which is strictly better than losing it. Lower-cased so two spellings of
// one id cannot become two rows.
const EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function eventId(raw) {
  return typeof raw === 'string' && EVENT_ID_RE.test(raw) ? raw.toLowerCase() : null;
}

// Clamp a client-supplied epoch-ms timestamp into a sane window, else fall back to nowMs.
// Client clocks can be wrong or spoofed; for owner-only analytics of a trusted circle this is
// accurate enough, and the clamp stops absurd values (a click can't be an hour in the future).
export function clampTs(ts, nowMs) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return nowMs;
  const min = nowMs - 30 * 24 * 3600 * 1000; // 30 days back
  const max = nowMs + 5 * 60 * 1000;         // 5 min ahead (clock skew)
  return (n < min || n > max) ? nowMs : n;
}

// Normalize one raw client event into a clean, storable row — or null to drop it.
// nowMs is passed in (not read via Date.now()) so the function is pure and deterministically tested.
export function normalizeEvent(raw, nowMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!name || !EVENT_NAMES.has(name)) return null;
  const section = typeof raw.section === 'string' ? raw.section.slice(0, MAX_STR) : null;
  let props = (raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props)) ? raw.props : {};
  try {
    if (Buffer.byteLength(JSON.stringify(props), 'utf8') > MAX_PROPS_BYTES) props = {};
  } catch {
    props = {}; // non-serializable → drop the props, keep the event
  }
  return { name, section, props, ts: clampTs(raw.ts, nowMs), id: eventId(raw.id) };
}

// Normalize a whole batch: array in → clean events out (unknowns dropped, count capped).
export function sanitizeEvents(arr, nowMs) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  // [BUG-123] Within-batch repeats are dropped here. The reason first written for this guard was
  // FALSE and is recorded so it is not re-derived: it claimed `on conflict do nothing` cannot
  // de-duplicate two rows proposed inside ONE statement. Measured against a real Postgres (dev
  // branch, 2026-09-16): a statement proposing the same `client_id` twice stores exactly one row and
  // raises nothing. (The "cannot affect row a second time" error belongs to DO UPDATE.) An
  // independent reviewer flagged the claim; the probe settled it.
  //
  // The guard stays, for the reason that IS true: the fallback insert above — the un-migrated
  // database — carries no conflict clause and no index, so nothing else stops one id becoming two
  // rows there. It also keeps a batch from spending its 100-event budget on repeats.
  const seen = new Set();
  for (const raw of arr) {
    if (out.length >= MAX_EVENTS_PER_BATCH) break;
    const e = normalizeEvent(raw, nowMs);
    if (!e) continue;
    if (e.id) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
    }
    out.push(e);
  }
  return out;
}

// Admin gate for the analytics view: is this session's email the configured owner?
// Case-insensitive + trimmed; any blank on either side is a hard no.
export function isOwner(sessionEmail, adminEmail) {
  if (!sessionEmail || !adminEmail) return false;
  return String(sessionEmail).trim().toLowerCase() === String(adminEmail).trim().toLowerCase();
}
