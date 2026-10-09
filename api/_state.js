// Pure state helpers for the backend sync layer (TASK-024). No DB, no I/O — unit-tested
// in test/state.test.mjs. Shared by api/state.js (server) and mirrored by app.js (client).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The state keys that sync to the server. Device-local keys (lastFeedLoad, tweetCache,
// lastView, deviceId) are deliberately excluded — see spec TASK-024. `groups` is the AI
// topic-grouping cache (TASK-068): regenerable, but synced so devices show the same bundles.
export const SYNCED_KEYS = ['channels', 'done', 'archive', 'theme', 'shorts', 'groups'];

// How a row version is rendered, on BOTH the read and the write, and never any other way.
//
// NOT `updated_at::text` (BUG-047 punch-list item 7). `timestamptz::text` renders through the
// session `DateStyle`/`TimeZone` GUCs, and a GET and a PUT are different Neon HTTP requests — so any
// drift between them makes EVERY conditional write fail to match, which is total sync failure
// arriving from the opposite side of the risk the original note was written about.
//
// AN EXPLICIT FORMAT IS NOT ENOUGH, and the earlier claim here that it "has no GUC to drift" was
// FALSE — it removes the `DateStyle` dependence only (review round 4, found independently by two
// reviewers). `updated_at` is a `timestamptz` (scripts/init-db.mjs), and `to_char` on a `timestamptz`
// renders it in the session's `TimeZone` before formatting, so the same row reads as a different
// token under a different GUC. `at time zone 'UTC'` converts it to a plain `timestamp` FIRST, and a
// `timestamp` has no zone left to render through. That is what makes the token stable rather than
// merely explicit. If it ever drifted, EVERY write would 409 — which, until this round's fix A, meant
// every user permanently halted.
//
// The expression is inlined as SQL text at each use rather than interpolated, because `${REV_EXPR}`
// in a tagged template binds as a PARAMETER and the text would never appear in the statement at all.
// These constants are therefore the thing the statements are COMPARED AGAINST, not built from:
// `test-helpers/handler.mjs` refuses any rev expression that is not byte-identical to them, and
// `test/harness-conditional-write.test.mjs` asserts the handler's own statements match. Before that,
// the fake accepted any format literal and rendered with its own — so read and write could diverge
// and nothing would red (review round 4, R18/R19), and `REV_FORMAT` was exported and never imported:
// dead code standing in for a guarantee.
export const REV_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US';
export const REV_EXPR = `to_char(updated_at at time zone 'UTC', '${REV_FORMAT}')`;
// The same expression inside a WHERE, where the column must be table-qualified: in an
// `on conflict do update`, bare `updated_at` is ambiguous and `users.updated_at` is specifically the
// PRE-UPDATE row — which is what makes two clients declaring the same base resolvable.
export const REV_EXPR_QUALIFIED = REV_EXPR.replace('updated_at', 'users.updated_at');

// The base a client declares on a PUT: an opaque token it can only have obtained from a pull it
// applied or a push the server accepted. Anything absent, empty or not a string is "no base
// declared" — which is a weaker claim, never a stronger one, so a malformed header can only cost a
// client its write, never earn it one.
export function readRev(raw) {
  return (typeof raw === 'string' && raw.trim()) ? raw.trim() : null;
}

// Server-side size cap (256 KB) — abuse guard on PUT /api/state.
export const STATE_SIZE_CAP = 256 * 1024;

// A uid is a device id (pre-login) or an account id (post-login) — both UUIDs.
export function isValidUid(uid) {
  return typeof uid === 'string' && UUID_RE.test(uid);
}

// The two namespaces a `users` row can live in (BUG-019). Account rows and device rows were once
// a single flat keyspace, so a request supplying someone else's id reached their row. They are now
// separate namespaces in the schema — the primary key is (kind, id) — which is what makes crossing
// between them impossible rather than merely guarded.
export const OWNER_ACCOUNT = 'account';
export const OWNER_DEVICE = 'device';

// Which row does this request act on? The one security-critical decision in /api/state.
//
// A session pins the owner to that account and the client-supplied id is ignored entirely — that
// half was always correct. Without a session the request can only ever address the DEVICE
// namespace, so no client-supplied value can name an account row however it is spelled. "Without a
// session" still includes a lookup that FAILED — this function is handed `account: null` for a database
// error exactly as for an expiry, and deliberately so, because the namespace rule is the same either
// way. What changed in review round 2 is that api/state.js now knows the difference BEFORE it gets
// here: a state PUT declaring it needs an account is answered 503 when the lookup could not be made and
// 412 when there was no session, so neither reaches the WRITE ([BUG-039]). Not "never reaches this
// answer" — that was the first wording and it is false: `resolveOwner` runs well above the refusal and
// its answer is consumed by the uid check, so such a PUT with a malformed X-Device-Id is decided HERE,
// at 400. Measured in review round 3; harmless today because getDeviceId() always yields a valid uuid,
// but a plausible reason for excluding a code path is the dangerous kind. A GET reaches the write with
// this answer too — that half is [BUG-120].
//
// `headerUid` (X-Device-Id) is preferred over `legacyUid` (?uid / body.uid) because the query
// string leaks into access logs, proxy logs, browser history and Referer headers, and the uid is
// the row's only authenticator (CHR-007a). The legacy source stays readable for one release so a
// client cached mid-deploy keeps syncing; removing it is CHR-014.
//
// The returned `id` is NOT validated here — callers run isValidUid, which keeps this pure and the
// rejection in one place.
export function resolveOwner({ account, headerUid, legacyUid } = {}) {
  if (account && account.accountId) return { kind: OWNER_ACCOUNT, id: account.accountId };
  const id = (typeof headerUid === 'string' && headerUid) ? headerUid : legacyUid;
  return { kind: OWNER_DEVICE, id };
}

export function withinSizeCap(state, capBytes = STATE_SIZE_CAP) {
  try {
    return Buffer.byteLength(JSON.stringify(state ?? {}), 'utf8') <= capBytes;
  } catch {
    return false; // non-serializable → reject
  }
}

// "Meaningful" state = the user has actually curated something. Prefs alone (theme/shorts)
// don't count — claiming an empty account over just a theme change isn't worth a write.
export function hasUserData(state) {
  if (!state || typeof state !== 'object') return false;
  return Boolean(
    (state.channels && state.channels.length) ||
    (state.done && state.done.length) ||
    (state.archive && state.archive.length)
  );
}

// The claim/merge decision (spec TASK-024): local is authoritative only on the FIRST claim
// (no server row yet); once a row exists the server is authoritative and local is its cache.
// Returns the state to adopt + whether the client should push it up.
export function resolveSync({ local, server }) {
  const noRow = !server || server.updatedAt == null;
  if (noRow) return { state: local, push: hasUserData(local) };
  return { state: server.state, push: false };
}
