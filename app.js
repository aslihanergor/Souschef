// ── Storage ──────────────────────────────────────────────────────────────────

import { esc, safeHref, foldTurkish, timeAgo, parseKeywordChips,
         filterFeedItems, filterTweetItems, filterSubstackItems,
         exitKeyPlan, shouldShowLanding, themeForView,
         bulletText, bulletIds, bulletIsLive,
         sameSyncedState,
         shouldStartTour, tourCards, tourStep, tourView, parseTourRecord } from './lib/pure.js';

const SK = {
  channels: 'focus_channels',  // [{id, name, keyword, color, avatarUrl, source, handle?, addedAt?}] — handle is twitter-only, addedAt is ms and absent on channels added before the field existed
  done:     'focus_done',      // [videoId, ...]
  lastView: 'focus_last_view', // 'setup' | 'feed' — which screen to resume into on reload
  theme:    'focus_theme',     // 'light' | 'dark' — set before paint by the inline <head> script
  shorts:   'focus_include_shorts', // 'true' | 'false' — the Shorts preference
  lastFeedLoad: 'focus_last_feed_load', // ms timestamp of the last feed load — drives the "New" badge
  tweetCache: 'focus_tweet_cache', // { [channelId]: [{id,text,published,imageUrl,url}, …] } — per-X-channel cache, newest first
  archive:  'focus_archive',   // [{id, source, …metadata, archivedAt}] — items bookmarked out of the feed ("watch later")
  deviceId: 'focus_device_id', // stable per-browser id; keys server state. Device-local — never synced.
  landing:  'focus_landing_seen', // VESTIGIAL — never read or written now the sign-in wall is mandatory. Kept in the inventory so exit still clears it from browsers that took the old skip.
  groups:   'focus_groups',    // AI topic-grouping cache: {assignments:{itemId:groupId}, groups:{groupId:{label,summary}}, unfiled:[itemId], updatedAt, v}. Synced.
                               // `unfiled` is the posts a classify examined and could not place. They carry NO
                               // assignment — that is the point — so this is the only record that they have already had their
                               // turn, which is what stops them being held hidden on every load. Bounded by the live feed.
                               // A summary bullet is `string | {text, item_ids}` — the object form records which
                               // posts it describes so a read post's bullet stops showing; a bare string means NO ids, which is
                               // never pruned. `v` is the schema version (GROUP_STATE_VERSION), stamped on every write.
  dirty:    'focus_dirty',      // '1' while local state has un-pushed mutations; cleared only on a confirmed PUT. Device-local, never synced.
  rev:      'focus_rev',        // the server row version local is BASED ON. An opaque token — never parsed, only
                               // echoed back on the next PUT so the server can refuse a write from a client that has not read
                               // the row. Set ONLY by a pull that was applied or a push that was accepted; a GET that was merely
                               // read must never set it. Device-local, never synced.
  events:   'focus_events',     // pending analytics events buffered until the next /api/state PUT drains them. Device-local, never synced.
  wasAuthed:'focus_was_authed', // '1' if the last boot saw a session — lets us fire signin/signout on the transition across reloads.
  groupView:'focus_group_view', // 'on' | 'off' — is the reader in the grouped view?
                               // ABSENT MEANS 'off': ungrouped-first is the default, so a fresh browser and one
                               // that has never grouped behave identically, and a corrupted value degrades to the
                               // plain chronological feed — the thing that always works.
                               // DEVICE-LOCAL, NEVER SYNCED, and that is a safety property rather than a shortcut:
                               // syncing it would arm schedulePush, so flipping a VIEW could raise the notice
                               // "Not syncing — this device has changes the saved copy doesn't." A view preference
                               // must never produce a sync-conflict notice. It still clears on exit — device-local
                               // means "not uploaded", not "survives the account that chose it".
  tour:     'focus_tour',       // the first-run tour's record, `{at, card?, replay?}` — shape in lib/pure.js.
                               // DEVICE-LOCAL, NEVER SYNCED, for groupView's reason: it must never arm a push. It
                               // records what THIS person has seen on THIS device, so it clears on exit.
};

// ── The damaged-store guard ──────────────────────────────────────
// One malformed value used to give the user a BLANK PAGE: four synced keys each threw somewhere on
// the boot path, and since signing in is mandatory this sits on the path every user
// walks, with no route back except clearing site data they do not know how to clear.
//
// The obvious fix — coerce an unreadable value to empty at the reader — destroys data by four
// routes. Every one is the same shape: a coerced empty is indistinguishable from a
// genuinely empty store, and it flows into a decision the reader never sees. The push claims the
// account has no channels; the reconcile clears `dirty` and re-bases; sign-out decides there is
// nothing worth keeping and wipes; a save launders the coerced empty into the store itself.
//
// So the line is NOT "may this push claim state". It is "is this store damaged" — and while it is,
// the app is READ-ONLY until it heals. Reads still degrade to empty, because rendering something is
// better than rendering nothing; WRITES and destructive decisions stop.
//
// HEALING is a successful pull: applySyncedState rewrites the key with the server's copy. A RELOAD
// IS NOT HEALING and must never be offered as one — with `dirty` set, syncOnLoad takes the
// keep-local branch and returns WITHOUT applying the row, so the damage survives every reload.
//
// UNREADABLE means three things, and all three are load-bearing:
//   - it does not parse                    — truncation, the original report
//   - it is the EMPTY STRING                — the residue of a quota-aborted write. `raw === null`
//     reads that as "never set", which leads to an empty state PUT over a row holding
//     the user's real channels. An ABSENT key is NOT damage, and that direction matters just as
//     much — treating it as damage makes every fresh install permanently read-only.
//   - it parses to the WRONG SHAPE          — `{"a":1}` in focus_channels reaches the server
//     verbatim and destroys the row.
//
// TWO TIERS, because `tweet_cache` is DEVICE-LOCAL. Damage to it must stop `saveTweetCache` (a
// persisted reset erases every other channel's cached posts, and for a pay-per-post source that is
// real money) — but it must NOT raise the notice, which offers to restore from the account, and the
// cache is not in the account. A notice must never over-promise.
const SYNCED_PROTECTED = [SK.channels, SK.done, SK.archive, SK.groups];
const PROTECTED_KEYS = [...SYNCED_PROTECTED, SK.tweetCache];
// The shape each key must hold to count as readable.
//
// `groups`' `v === null` arm is UNREACHABLE from anything this app writes, and that is recorded
// rather than quietly relied on: an absent key returns at `raw === null`
// two lines below, and no writer here ever stores the literal string "null" — `saveGroupState`
// always stringifies an object, and both `applySyncedState` and `rowValueFor` refuse a non-object.
// It is kept for a value written by some earlier version or by hand, where reading "null" as
// DAMAGE would make the app read-only over a value that means "empty".
const PROTECTED_SHAPE = {
  [SK.channels]:   (v) => Array.isArray(v),
  [SK.done]:       (v) => Array.isArray(v),
  [SK.archive]:    (v) => Array.isArray(v),
  [SK.groups]:     (v) => v === null || (typeof v === 'object' && !Array.isArray(v)),
  [SK.tweetCache]: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};
function _keyDamaged(k) {
  const raw = localStorage.getItem(k);
  if (raw === null) return false;   // absent — a fresh install, not damage
  if (raw === '') return true;      // quota-abort residue — damage, not "never set"
  let v;
  try { v = JSON.parse(raw); } catch { return true; }
  return !PROTECTED_SHAPE[k](v);
}
/** THE predicate. Gates every synced write, the state push, the exit decisions, the export and the
 *  notice. Spans all four synced keys rather than only the one being written: a channels write ARMS
 *  a push built from all four, so damage in `done` makes writing `channels` just as destructive.
 *
 *  `tweet_cache` is deliberately NOT here, and the reason is the notice. The cache is device-local,
 *  so it can never raise an account-restore notice without over-promising — and an
 *  app that silently refuses every write with NO explanation is the exact state the notice exists
 *  to prevent. Damage there therefore stops only its own writer, below. */
function syncedDamaged() { return SYNCED_PROTECTED.some(_keyDamaged); }
// Recomputed on every call rather than memoised. A cache would need invalidating from every write
// path plus the heal, and a stale "healthy" here is a silent data-destruction bug — the exact class
// this guard exists to close. Four JSON.parses on a user-initiated write is not a cost worth that.

/** What a refused write does. One function, so the user-facing half of read-only mode is decided
 *  ONCE rather than per writer — a silent no-op reads as "the app is broken" rather than "this
 *  device's copy is damaged", which is arguably worse than the white screen it replaces.
 *
 *  RETURNS `false`, and that is the load-bearing part rather than a convention. Without it
 *  every refused write still CONFIRMS SUCCESS: the card slides
 *  away and the toast says "Marked done"; the import says "Added 3 channels"; un-archiving puts the
 *  item back in the feed while it stays archived. A false confirmation is worse than the silence
 *  this notice was added to fix — the user marks a session's worth of items read, is told each one
 *  worked, and loses all of it. A writer reports refusal so its caller can stop. */
function refuseWrite() {
  renderDamagedNotice();
  return false;
}

/** Ask, at the top of a user ACTION, whether it can write at all — and if not, say so and stop.
 *
 *  This deliberately repeats the predicate at call sites, which everywhere else in this file is the
 *  pattern the design moved AWAY from. The difference is that this is about the MESSAGE, not the
 *  safety: the write boundary already refuses, so nothing here protects data. Only the caller knows
 *  what it was about to claim ("Marked done", "Added 3 channels"), so only the caller can decline to
 *  claim it, and there is no shared choke point they all pass through.
 *
 *  A toast as well as the notice, and the two are not redundant: the notice states a CONDITION that
 *  persists, this confirms that THIS TAP did not take — a
 *  UI action that silently didn't happen looks identical to a broken feature. */
function blockedByDamage() {
  if (!syncedDamaged()) return false;
  refuseWrite();
  showToast("Not saved — this device's copy is damaged");
  return true;
}

/** Read a protected key, degrading to `empty` when it cannot be read. NEVER used to decide whether
 *  to write — that is syncedDamaged()'s job, and conflating the two is what destroys data. */
function _readProtected(key, empty) {
  const raw = localStorage.getItem(key);
  if (raw === null || raw === '') return empty;
  try {
    const v = JSON.parse(raw);
    return PROTECTED_SHAPE[key](v) ? v : empty;
  } catch { return empty; }
}

// Every channel carries a `source` ('youtube' | 'twitter'). Channels stored before the
// field existed default to 'youtube' at read time.
//
// The default is added to
// the object this returns, so the next `saveChannels(getChannels()…)` — any edit, any removal —
// PERSISTS it. That is harmless here (the written value is the one already assumed), but
// anything added
// at read time reaches the store. That is why `channelName` is render-only and never joins the
// object.
//
// `ch && ch.source` rather than `ch.source`: a null element in the array would throw here and
// BLANK THE BOOT. Note what this does NOT do: it never filters. Dropping the element would satisfy
// every render but lose a channel.
function getChannels()  {
  return _readProtected(SK.channels, [])
    .map(ch => ({ ...ch, source: (ch && ch.source) || 'youtube' }));
}
function saveChannels(v){
  if (syncedDamaged()) return refuseWrite();
  localStorage.setItem(SK.channels, JSON.stringify(v));
  schedulePush();
  return true;
}
function getDoneSet()   { return new Set(_readProtected(SK.done, [])); }
function addDone(id) {
  if (syncedDamaged()) return refuseWrite();
  const d = getDoneSet(); d.add(id);
  localStorage.setItem(SK.done, JSON.stringify([...d]));
  schedulePush();
  return true;
}
// Remove ids from the done set — the reverse of addDone, used to Undo a bulk mark-all.
function removeDone(ids) {
  if (syncedDamaged()) return refuseWrite();
  const d = getDoneSet();
  ids.forEach(id => d.delete(id));
  localStorage.setItem(SK.done, JSON.stringify([...d]));
  schedulePush();
  return true;
}

// AI topic groups: the cached clustering of the unread X feed (Substack is not
// grouped). Normalised so a new
// post can be checked for an existing assignment in O(1) and a group's label/summary stays stable
// across re-renders as its membership changes. Regenerable from the feed (cache-like), but synced
// so a phone and a laptop show the same bundles. Malformed/missing → an empty state, never a throw.
function getGroupState() {
  // Through the shared reader, so "unreadable" means the same thing here as
  // everywhere else — including the empty string and a wrong shape, neither of which a bare
  // try/catch treats as damage.
  const raw = _readProtected(SK.groups, null);
  // `unfiled: []` is part of this shape and is LOAD-BEARING, not defensive. This is the FIRST-RUN
  // path — empty localStorage parses to null and lands here — and its live consumer is
  // `updateGroupsForFeed`'s `state.unfiled.filter(...)`, which has no fallback. Remove it and the
  // very first classify on a fresh install throws and degrades: measured, 15 tests die, none of them
  // about this function. This reader's contract is "malformed or missing → an empty state, never a
  // throw", and a shape missing a field the file reads breaks it.
  if (!raw || typeof raw !== 'object') {
    return { assignments: {}, groups: {}, updatedAt: 0, unfiled: [], postMeta: {}, postMetaEpoch: 0 };
  }
  return {
    assignments: (raw.assignments && typeof raw.assignments === 'object') ? raw.assignments : {},
    groups:      (raw.groups && typeof raw.groups === 'object') ? raw.groups : {},
    updatedAt:   Number(raw.updatedAt) || 0,
    // Schema version. Absent → 0 → the migration below runs once. It is carried through
    // every read/write so a device that has migrated never migrates again.
    v:           Number(raw.v) || 0,
    // The posts the last classify could not place. Ids only — recomputed on every
    // classify and pruned with assignments, so it cannot outlive the posts it names.
    //
    // It MUST be declared here. This reader normalises rather than spreads, so a field it does not
    // name is dropped on the next save — the record would be written by updateGroupsForFeed and
    // silently gone by the following read, leaving every leftover held hidden on every load with
    // the suite green.
    unfiled:     Array.isArray(raw.unfiled) ? raw.unfiled : [],
    // What the prune is allowed to know about a post WITHOUT asking the feed:
    // `postMeta[id] = [at, ch]` — the post's publish time in SECONDS, and the id of the channel it
    // came from. A sibling of `assignments`, never a change to it: making `assignments[id]` an object
    // would break every reader and all ~50 `focus_groups` fixtures. Seconds because `at` is only ever
    // compared against a 14-day boundary, and the two field names would otherwise repeat identically
    // on every entry — measured at 108 -> 95 bytes per assignment, against a 256 KB server cap.
    //
    // An ABSENT entry means UNKNOWN, which is never evidence that a post is gone.
    // `typeof [] === 'object'`, and an array swallows string-key stamps silently — `JSON.stringify`
    // drops them, so `stampPostMeta` would report a change on EVERY render forever and no assignment
    // would ever carry an age. Reject anything that is not a plain object.
    postMeta:    (raw.postMeta && typeof raw.postMeta === 'object' && !Array.isArray(raw.postMeta))
                   ? raw.postMeta : {},
    // When this record first came under the `postMeta` rules, in seconds. Unknown is not evidence, but
    // it must not be permanent either: an assignment whose post had already left the feed can never
    // be backfilled (never in hand), never be reached by the channel rule (no `ch`) and could never
    // age out (no `at`) — so it would sit in `countGroupedUnread()` forever and make "You're all
    // caught up" permanently unreachable. Ageless assignments age from
    // this instead. It starts a clock; it does not strike, because it is absent until the first save
    // under this code and anything still visible is backfilled long before the window closes.
    //
    // `Number(...) || 0` and NEVER a `Date.now()` default: default it on READ and every read mints a
    // fresh epoch, nothing ever ages, and the field silently does nothing at all.
    postMetaEpoch: Number(raw.postMetaEpoch) || 0,
  };
}
// Schema version for the grouping cache. Version 1 is the implicit original shape:
// summaries as flat string arrays, carrying no `v` at all. Version 2 gives each bullet the
// posts it describes.
const GROUP_STATE_VERSION = 2;
// Stamped on EVERY write, not just after a migration. Without that, a classify following a migration
// would write back the `v: 0` a fresh read produced, and the next boot would migrate again — wiping
// the cache it had just rebuilt, on every load, forever.
function saveGroupState(state) {
  // The epoch is stamped on the first write that finds it missing, and carried unchanged after that
  // — the same shape as `v` above, and for the same reason: a value re-derived on every write is not
  // a record of when anything happened.
  if (syncedDamaged()) return refuseWrite();
  const postMetaEpoch = state.postMetaEpoch || nowSec();
  localStorage.setItem(SK.groups, JSON.stringify({ ...state, v: GROUP_STATE_VERSION, postMetaEpoch }));
  schedulePush();
}

// The lookback every liveness rule here shares. It MIRRORS `WINDOW_DAYS` in `api/feed.js`, which is
// the source of truth — `app.js` cannot import from `api/`, so this is a deliberate second copy
// rather than a third: `mergeTweets` below reads this instead of hard-coding the same arithmetic.
const GROUP_WINDOW_MS = 14 * 86400_000;
const nowSec = () => Math.floor(Date.now() / 1000);
// `published` is remote text, and it is parsed here exactly once. Anything unparseable lands as
// `null` — UNKNOWN — and never as 0, which would age every post out instantly. Numbers are accepted
// as epoch millis because that is what the fixtures carry.
function publishedSec(published) {
  const ms = typeof published === 'number' ? published : Date.parse(published);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// ── Keep the grouping cache in step with the feed ────────────
// Called (non-blocking) after each feed render. Classifies only genuinely-NEW X posts against
// the existing topic labels — incremental, so steady-state cost is a fraction of a cent and existing
// groups stay stable. Also prunes assignments for posts that have left the unread feed. Never blocks
// or breaks the feed: on ANY failure the cache is left as-is and those posts just render in the
// chronological stream (no cache → no grid).
let _grouping = false;
// How long a classify may run before the client stops waiting on it.
//
// 120s, and the number is a TRADE rather than a measurement. Sizing it, honestly:
//   • The server's own cap is `MAX_ITEMS = 200` (`api/_group.js`), and the client sends `newItems`
//     WHOLE — it applies no cap of its own. So a first classify of a full backlog is the case to
//     size for, not a steady-state open.
//   • A measured decomposition (9.6s fixed + 7.41ms per output token) is the only model there is.
//     At 200 X posts:
//     ids 200 × 2.1 ≈ 420 tokens plus bullets/labels ≈ 200 × 23.7 ≈ 4,740 → ≈5,160 output tokens
//     → **≈48s modelled**. Real latency has been measured running ~1.45× ahead of that model.
//     That puts the worst realistic case near **70s**.
//   • 45s sits BELOW that. It would abort a classify that was going to succeed — and because a
//     timeout deliberately records nothing (C5), the identical payload re-sends on the next render
//     and is billed again, for ever: a rare problem made permanent for the heaviest users.
//
// The asymmetry decides it: too tight is a permanent billed loop; too loose only means a genuine
// stall shows for longer before it clears. So bias LARGE. C10 pins this against `MAX_ITEMS` rather
// than against a literal, so it reds if the bound shrinks OR the server's cap grows.
//
// NOTHING HERE IS A MEASUREMENT AT THIS SCALE — no classify has ever been timed at MAX_ITEMS. That is
// why the timeout is instrumented (`group_classify_timeout`): if this number is still wrong we find
// out from data rather than from a user noticing.
//
// Deliberately NOT a `Date.now()` deadline. A backgrounded tab throttles this timer so it fires
// LATE — the generous direction, and the right one; a wall-clock deadline would fire EARLY against a
// classify that is throttled but perfectly alive.
const GROUP_TIMEOUT_MS = 120000;
let _lastFeedItems = null; // the items from the last feed render — drill-in reads posts from here
let _groupsCapped = false; // last classify hit the server's input cap → show the group-note
// Posts a classify placed while their card was ALREADY VISIBLE in the stream. They keep
// their assignment — it is written and synced like any other — but the card stays where the reader
// can see it, and the post joins its tile on the next feed load instead of being yanked mid-read.
//
// In memory on purpose, and that is a safety property rather than a shortcut: `clearLocalIdentity`
// clears by the `SK` inventory, so a persisted set would need an EXIT_DISPOSITION decision it must
// not acquire silently. A reload cannot carry a deferral, which is
// also exactly the semantics wanted — "until the next load" is the whole rule.
//
// Cleared at the top of every `renderFeedResults`: a fresh render re-decides stream membership from
// stored assignments, so the deferred post is routed to the grid by the ordinary path with no extra
// code. `updateGroupsForFeed` is called from that function and nowhere else, so this set is
// GUARANTEED EMPTY whenever an /api/group payload is built — which is what keeps the deferral away
// from `liveBullets` (see the note at the existing-topics payload).
let _liftDeferred = new Set();

// Which sources are grouped at all. ONE definition, because this question is asked at three sites
// that each do something different with the answer — prune, classify, hold-hidden — and three copies
// of it would drift apart.
//
// X only. Substack is deliberately out: we only ever send a post's title, subtitle
// and first paragraph, so the bullet the model writes can only restate the headline the card already
// shows, and a handful of long reads was never the volume problem grouping was built for.
function isGroupableSource(item) {
  return item.source === 'twitter';
}
// The text we hand the model for each post. Only X posts reach here, so it is the tweet text.
function groupTextOf(item) {
  return item.text || '';
}
// A stable group id derived from the label, so the same topic always maps to the same id across
// incremental calls (find-or-create by label is then just a lookup).
function groupIdFor(label) {
  return 'g_' + String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
// Drop assignments the record itself can PROVE are finished, then drop any group left with no
// members. Mutates `state`; returns whether anything changed.
//
// `inHandIds` is what the feed happened to load. It is not evidence of anything being GONE — reading it
// that way destroys the bullets of unread posts and syncs the loss to every device. Absence
// is unusable here because the evidence is device-local (`tweetCache` is not synced, and is cleared on
// sign-out) while the record is synced: a cold cache answers with the newest 20 posts and no signal of
// any kind. So deletion needs a positive reason, and each one is either synced or locally
// authoritative:
//
//   rule 1  the user handled it   — `done` or `archive`, both synced, and `done` is never pruned, so
//                                   this evidence never expires and no device can be ignorant of it
//   rule 2  the channel is gone   — the recorded `ch` is no longer in `getChannels()`, also synced
//   rule 3  the post aged out     — the recorded `at` (or the epoch, for ageless records) is older
//                                   than the window
//
// `inHandIds` survives for exactly two jobs, and neither can delete an assignment: it VETOES rule 3
// for a post the reader can currently see, and it is the liveness signal for `unfiled` at the bottom,
// which deliberately keeps the absence rule (dropping an id from that record wrongly costs one post
// one extra hidden moment, once; dropping an assignment wrongly destroys a synced cluster).
function pruneGroupState(state, inHandIds, { complete = false, ageTrusted = true } = {}) {
  let changed = false;
  const done = getDoneSet();
  const arch = getArchiveSet();
  const chIds = new Set(getChannels().map(c => c.id));
  const meta = state.postMeta || (state.postMeta = {});
  const cutoff = nowSec() - GROUP_WINDOW_MS / 1000;
  // Start the clock if this is the first pass over a record written before the epoch existed.
  // Marking it changed matters: without a write the epoch is never persisted, and a user whose record
  // needs no other change would keep ageless assignments forever — the failure the epoch exists for.
  if (!state.postMetaEpoch) { state.postMetaEpoch = nowSec(); changed = true; }
  // An EMPTY channel list is absence, not evidence of removal — the same mistake as above,
  // one rule along. `channels` emptying in production is documented rather than hypothetical,
  // and without this guard one stale sync would delete every assignment the
  // account has and PUT the loss upward. (A CORRUPT list is a different case: `getChannels` parses
  // without a try/catch, so it throws before reaching here.)
  const channelsKnown = chIds.size > 0;
  for (const id of Object.keys(state.assignments)) {
    const entry = Array.isArray(meta[id]) ? meta[id] : null;
    // `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious version of this line reads
    // a `[null, ch]` entry as a KNOWN age of zero — which the `age > 0` guard below then makes
    // IMMORTAL rather than ageless, the exact opposite of the intent. Require a positive number.
    const raw0 = entry ? entry[0] : null;
    const at = (typeof raw0 === 'number' && Number.isFinite(raw0) && raw0 > 0) ? raw0 : null;
    const ch = entry ? entry[1] : null;

    let prune = false;
    if (done.has(id) || arch.has(id)) {
      prune = true;                                             // rule 1
    } else if (channelsKnown && ch != null && !chIds.has(ch)) {
      prune = true;                                             // rule 2
    } else if (!inHandIds.has(id)) {
      // rule 3. A post in hand is live BY DEFINITION whatever its recorded date claims, so presence
      // vetoes this — and only this. Presence never licenses a deletion, which is why it cannot
      // reintroduce deletion by absence: the reason to delete still comes from the record, never from the feed.
      if (!ageTrusted) continue;   // see `syncGroupPrune` — this device's clock is not corroborated
      // No `age > 0` term. The parse above
      // yields `null` for anything not a positive number, and the epoch is stamped before this
      // loop, so `age` is always positive and the term would be dead. The invariant is
      // pinned by M30 instead, where a test can see it fail.
      const age = at != null ? at : state.postMetaEpoch;
      prune = age < cutoff;
    }
    if (!prune) continue;
    delete state.assignments[id];
    changed = true;
  }
  // `postMeta` cannot outlive the assignments it describes, or it becomes an unbounded
  // synced record of its own, on a record justified by staying small.
  //
  // ONE guard, deliberately. A second, inline `delete meta[id]` in the loop above would mask this
  // one perfectly: either could be deleted and every test would stay green,
  // because whichever survived did the whole job. Two guards over one input pin neither.
  // This one is strictly more general — it also collects an entry whose assignment left by another
  // path, such as the bucket sweep.
  for (const id of Object.keys(meta)) {
    if (!Object.hasOwn(state.assignments, id)) { delete meta[id]; changed = true; }
  }
  const used = new Set(Object.values(state.assignments));
  for (const gid of Object.keys(state.groups)) {
    if (!used.has(gid)) { delete state.groups[gid]; changed = true; }
  }
  // Garbage-collect bullets whose every post has left. This is storage hygiene, NOT the
  // user-visible fix — `liveBullets` filters by what is UNREAD, which is a different and larger
  // set than what is still assigned. Doing it here as well keeps the synced row from carrying text
  // about posts that no longer exist.
  //
  // Keyed off `state.assignments` — the liveness signal this function has just finished computing —
  // and NOT off an id supplied by a feed. That distinction is load-bearing: a Substack id
  // is `guid || url` taken verbatim from a publication's RSS, so any pass that deletes by remote id
  // inherits remote control of the key. Nothing here trusts a bullet's id to name a real post; it
  // only asks whether that id is still assigned.
  //
  // A bullet with NO ids is never collected. Same rule as the render filter and for the same reason:
  // the absence of a link is not evidence that a post was read.
  for (const gid of Object.keys(state.groups)) {
    const summary = state.groups[gid]?.summary;
    if (!Array.isArray(summary)) continue;
    const kept = summary.filter(b => {
      const ids = bulletIds(b);
      return ids.length === 0 || ids.some(id => Object.hasOwn(state.assignments, id));
    });
    if (kept.length !== summary.length) { state.groups[gid].summary = kept; changed = true; }
  }
  // The unfiled record is pruned on the same liveness signal, for the same reason.
  // Recomputing it on every classify is not enough on its own: a quiet load where nothing is new
  // runs no classify at all, so without this a read or aged-out post's id would sit in the synced
  // row indefinitely, on a record whose whole justification is that it stays small.
  //
  // This is the ONE place `inHandIds` decides a deletion, and it keeps the absence rule on purpose
  // (only assignments need a positive reason). `done` is subtracted here as well.
  //
  // GATED ON A COMPLETE LOAD, and that gate is not vestigial. On a failed load
  // absence means "X 502'd at its post
  // cap", which is routine. Measured: ungated, one failed X channel wiped the whole record, and the next load
  // held 22-32% of the backlog hidden for 4.4-10.3s behind `grouping-pending`.
  // The comment above justifies absence here as costing "one extra hidden
  // moment, ONCE"; ungated it is once per X failure. A caller that omits the flag gets NO prune,
  // never an ungated one.
  const unfiled = state.unfiled || [];
  const keptUnfiled = complete ? unfiled.filter(id => inHandIds.has(id) && !done.has(id)) : unfiled;
  if (keptUnfiled.length !== unfiled.length) { state.unfiled = keptUnfiled; changed = true; }
  return changed;
}

// Record what the prune is allowed to know, at the one moment both facts are in hand.
//
// Also the BACKFILL: a record written before `postMeta` existed carries no ages at all, and this is what
// heals it. Only posts actually in `items` are stamped — a guess about a post nobody fetched is the
// same species of mistake as inferring absence — so anything the user can still see gets a real age
// within one window, and the epoch only ever reaches assignments that never reappeared.
//
// Idempotent by comparison, not by blind assignment: `saveGroupState` calls `schedulePush()`, so a
// stamp that reports a change when nothing moved turns every render into a push on a synced key.
function stampPostMeta(state, items) {
  let changed = false;
  const meta = state.postMeta || (state.postMeta = {});
  for (const it of items || []) {
    if (!isGroupableSource(it) || !Object.hasOwn(state.assignments, it.id)) continue;
    const at = publishedSec(it.published);
    const ch = it.channel?.id ?? null;
    if (at === null && ch === null) continue;
    const cur = meta[it.id];
    if (Array.isArray(cur) && cur[0] === at && cur[1] === ch) continue;
    meta[it.id] = [at, ch];
    changed = true;
  }
  return changed;
}
// The bucket's stable id. The label literal is DUPLICATED from `api/_group.js:11`, not
// derived from it — no `app.js` code can import from `api/`, so only the slug function is shared in
// spirit. What actually catches drift is the suite: `test/group-unfiled.test.mjs` imports the
// server's own `EVERYTHING_ELSE` and `topicKey` for its fixtures, so renaming the server constant
// reds those tests by name. The coupling lives in the tests, not in this line — do not read it as
// self-maintaining.
//
// Matched by KEY, never by raw label: a model reply of "everything else" is the same topic as
// "Everything else", and comparing the string is an identity bug.
// `api/_group.js:483`'s `isEverythingElse` is the server-side precedent.
const EVERYTHING_ELSE_KEY = groupIdFor('Everything else');

// Fold the endpoint's groups (keyed by label → stable id) into the cached normalised state.
//
// The bucket is skipped ENTIRELY — no assignment for its members, and no `state.groups`
// entry for the bucket itself. The server still mints it, deliberately: M1 measured that denying the
// model a named sink makes it invent unstable substitutes ("Technology & Innovation" and two other
// spellings of the same junk drawer, each slugging to a different id, so every classify mints a fresh
// tile). The stable sink stays; only what the client STORES changes.
//
// "Skip the group, not just its assignments" is load-bearing, and the third reason is the one that
// would quietly undo the skip: `updateGroupsForFeed` builds its existing-topics block from
// `Object.entries(state.groups)`, so a leftover entry is forwarded back into the next prompt as an
// existing topic — inviting the model to keep populating it.
function mergeGroups(state, endpointGroups, items) {
  // `items` is what was SENT for classification, so every id coming back names one of them. It is
  // here because this is the only place an assignment is ever CREATED, and therefore the only
  // moment the post's age and channel are in hand to be recorded alongside it (`stampPostMeta`
  // below). An id the endpoint returns that we never sent gets an assignment but no `postMeta` —
  // which reads as UNKNOWN, the safe direction, rather than as a guess.
  for (const g of endpointGroups || []) {
    const id = groupIdFor(g.label);
    if (id === EVERYTHING_ELSE_KEY) continue;
    state.groups[id] = { label: g.label, summary: g.summary || '' };
    for (const itemId of (g.item_ids || [])) state.assignments[itemId] = id;
  }
  stampPostMeta(state, items);
}

// Prune stale group assignments synchronously (posts no longer unread in the current feed), so the
// grid never paints a cluster that the async classify would then remove out from under you. Run from
// renderFeedResults BEFORE the first grid paint, on every load, complete or not — nothing is
// inferred from what loaded. The `complete` flag it
// takes governs ONE pass, the `unfiled` record at the bottom of `pruneGroupState`, which keeps
// the absence rule deliberately.
//
// There is deliberately NO unconditional "is this assignment still valid" pass here
// (un-assigning a post in hand whose source is no longer grouped).
// An id here is REMOTE TEXT, not a namespaced key. A Substack id is `guid || url`
// taken verbatim from the publication's RSS (`api/_substack.js`), so a hostile or broken feed can
// name an X post's id, and any pass that DELETES BY ID inherits that. Such a pass can
// un-assign a real X post (billed classify on every render, forever), or
// destroy the whole topic — label and bullets, synced to every device — when the
// colliding X post is absent, which an X 502 at the plan's post cap makes routine.
//
// What that costs, recorded rather than implied: on a load where a channel failed, a stale Substack
// assignment survives that render, so its card is in the stream AND still counted in its tile —
// measured "2 new" where the truth is 1. It self-corrects when the post is read, its
// channel goes, or it ages out.
// A briefly wrong number, in exchange for no delete-by-remote-id path existing at all.
// The deletion rules are `done`/`archive`, a removed channel, and age. Rule 1 does
// read an id supplied by a feed — a Substack `guid` marked done deletes whatever assignment shares
// that id.
//
// What this does NOT do either: it drops Substack ASSIGNMENTS, never group
// SUMMARIES. A topic keeping at least one X member keeps bullets the model wrote partly from
// Substack text. Cached bullets do not reach the prompt, so
// the concern is storage rather than injection. The fence
// and the label check in _group.js guard the labels that are the block's only content.
function syncGroupPrune(items, complete = false) {
  const state = getGroupState();
  const inHand = new Set((items || []).filter(isGroupableSource).map(it => it.id));
  // CLOCK SANITY. Rule 3 compares a server-supplied `at` against a cutoff
  // derived from the LOCAL clock, and nothing reconciles the two. `api/feed.js` windows every source
  // to WINDOW_DAYS server-side, so anything in hand is inside the window by the SERVER's clock — if
  // this device's clock says the newest post it just fetched has already aged out, the clock is
  // wrong, not the posts. Without this guard a device 20 days fast deletes in-window
  // assignments and their bullets and pushes the loss to every other device.
  // `lib/pure.js` clamps a future `addedAt` for the same reason; here
  // the consequence is deletion rather than a hidden card, so the pass is skipped outright.
  //
  // A stamp the local clock says has NOT HAPPENED YET is discarded before the max is taken.
  // `published` is remote text: `api/feed.js` and `mergeTweets` bound it
  // below, so nothing older than the window arrives, but nothing bounds it above — so one
  // future-dated `pubDate` would set the max arbitrarily high and vouch for ANY clock, which is the
  // guard's own failure mode (measured: a 20-days-fast device plus one such item deleted the whole
  // cluster). Discarding is safe in both directions: a FAST clock sees real posts in the past, so
  // only bogus dates are dropped; a SLOW clock sees them all as future and drops everything, leaving
  // `stamps` empty and the clock trusted — which costs nothing, because a slow clock puts the cutoff
  // EARLIER and so can only prune less. Pinned by R2c.
  const now = nowSec();
  const stamps = (items || []).map(it => publishedSec(it.published))
    .filter(s => s !== null && s > 0 && s <= now);
  const ageTrusted = stamps.length === 0 || Math.max(...stamps) >= now - GROUP_WINDOW_MS / 1000;
  // ORDER IS LOAD-BEARING: stamp first, prune second. A legacy assignment whose post is in this feed
  // gets a real `at` and a current `ch` BEFORE any rule looks at it — so the epoch can never age out
  // something the reader can see, and rule 2 can never fire on a post whose channel is evidently
  // still followed (the feed only fetches channels you follow).
  const stamped = stampPostMeta(state, items);
  const pruned = pruneGroupState(state, inHand, { complete, ageTrusted });
  if (stamped || pruned) saveGroupState(state);
}

// One-time migration of the grouping cache, keyed off the VERSION STAMP and never off the shape of
// what it finds.
//
// It must not infer "some summary is a string, therefore this is the old paragraph format, therefore
// drop the cache", and the reason is worth stating because
// that inference would be catastrophic rather than merely wrong. A bullet with no ids is
// SERIALISED AS A BARE STRING — that is the live representation, not a legacy one — so a perfectly
// current cache can consist entirely of string bullets. A shape predicate would fire on it, every
// boot, calling the clear below plus schedulePush(): the account's grouping state wiped on every
// page load, on every device.
//
// Clears by WRITING the empty stamped state rather than removeItem()-ing. A removed key reads back as
// v: 0, so the migration would re-fire on the very next call until some later classify happened to
// stamp it — a window in which a pull-to-refresh wipes the rebuilt cache again.
// It drops SUMMARIES ONLY, keeping every assignment and label. Only the bullets are un-linkable —
// an assignment is `{itemId: groupId}` and a label is a string, both perfectly valid at v2 — so
// clearing them would be destroying valid state to fix invalid state beside it, and would cost
// the user a re-classify and vanished topics.
function migrateGroupSummaries() {
  if (localStorage.getItem(SK.groups) === null) return; // nothing cached: first write stamps it
  const state = getGroupState();
  if (state.v >= GROUP_STATE_VERSION) return;
  for (const gid of Object.keys(state.groups)) {
    state.groups[gid] = { ...state.groups[gid], summary: [] };
  }
  saveGroupState(state);
}

// Sweep a bucket cached by an earlier version out of an existing user's state.
//
// `mergeGroups` skipping the bucket only governs cache written from now on. Anyone upgrading from
// an earlier version is already holding `g_everything_else` with live assignments behind it, and
// `pruneGroupState` only drops a group once nothing is assigned to it — so without this the tile
// keeps painting, its posts stay lifted out of the stream and never re-classified, and
// `updateGroupsForFeed` keeps forwarding the bucket into the prompt as an existing topic, for as
// long as those posts stay unread (up to the full 14-day lookback). The measured sticky rate is
// 22-32% of a single-domain backlog, so that is a third of the feed left stranded.
//
// Deliberately NOT keyed off GROUP_STATE_VERSION. Bumping the stamp would also run
// migrateGroupSummaries, which clears the summaries of EVERY topic — destroying valid bullets across
// the whole cache to remove one group. This is idempotent and self-retiring instead: once no bucket
// is present it returns before writing, so it costs a settled user nothing and arms no sync.
//
// The freed posts are seeded into `unfiled` rather than left absent. They HAVE been through a
// classify — that is how they were bucketed — so the hold does not apply to them, and seeding them
// is what stops a fifth of the backlog blinking out of the feed on the upgrade load.
// `items` is the feed being rendered. Only swept posts still IN it are seeded into the record: a
// bucket member that was read or aged out months ago must be retired, not promoted into a synced
// record that then has to be pruned back out again. This runs before `syncGroupPrune` and is not
// gated on a complete load, so without the filter those ids would survive on any feed with a failing
// channel — the same unbounded-growth path the recompute above guards.
// `syncGroupPrune`'s `unfiled` pass is complete-load-only, so this filter is what covers
// the failed ones. Pinned by M31.
function dropCachedBucket(items) {
  const state = getGroupState();
  const inFeed = new Set((items || []).filter(isGroupableSource).map(it => it.id));
  const swept = Object.keys(state.assignments).filter(id => state.assignments[id] === EVERYTHING_ELSE_KEY);
  // Both halves, so a partial state (assignments whose group entry was already pruned away, or an
  // empty bucket group) is cleaned too — and so a cache with neither is left byte-identical.
  if (!Object.hasOwn(state.groups, EVERYTHING_ELSE_KEY) && swept.length === 0) return;
  delete state.groups[EVERYTHING_ELSE_KEY];
  // `postMeta` is NOT swept here on purpose. `pruneGroupState`'s orphan pass already collects any
  // entry whose assignment has gone, whatever removed it — so deleting here too would be a second
  // guard over one input, and neither would be pinned.
  // Do not add it for symmetry.
  for (const id of swept) delete state.assignments[id];
  state.unfiled = [...new Set([...state.unfiled, ...swept.filter(id => inFeed.has(id))])];
  saveGroupState(state);
}

// The busy indicator: a cue beside
// the grouping switch while /api/group runs, so a multi-second classify doesn't look like the app
// froze. The wait is long: measured at 38.5s, later brought to ~22s.
//
// It lives in `.appbar`, not in `#feed-body`. `#feed-body` SCROLLS — so a
// reassurance there leaves the screen the moment the reader scrolls, which is what they do during a wait.
// `.appbar` is `position: sticky`, so this one stays. And it carries no words: "Gathering the
// topics…" beneath a feed that has ALREADY painted every post reads as "your posts are still
// loading" — the opposite of the truth, since the full stream renders first.
// The explanatory sentence belongs to the READY moment (`showReadyNote`),
// which is where it is actually news.
function showGroupBusy() { document.getElementById('group-busy')?.classList.remove('hidden'); }
function hideGroupBusy() { document.getElementById('group-busy')?.classList.add('hidden'); }

// The ready sentence. The bloom says "something is ready" and cannot say WHAT; this is
// the only place the app ever explains what the switch does. Shown at the same instant as the bloom
// and armed by the same CONDITION (`showable.length`), so it inherits the bloom's guards on what
// counts as news: not on a cache-only paint, and not when every placed post was deferred.
//
// It does NOT inherit the third one for free.
// "Not on a quiet open" comes from `_noteArmed` being consumed by the very next paint — see its
// declaration below. Armed-by-the-same-condition is not consumed-by-the-same-rule.
const READY_NOTE_MS = 6000;
let _noteTimer = null;

function showReadyNote() {
  const el = document.getElementById('group-ready-note');
  if (!el) return;
  el.classList.remove('hidden');
  // A NEWER classify owns the dismissal. Without this clear, the first classify's timer is still
  // pending and cuts the re-shown sentence short at ITS deadline — the reader loses news they were
  // just handed, to a countdown that belongs to news they already saw. Pinned by N8, which is only
  // writable because `advance(ms)` makes cancellation observable.
  clearTimeout(_noteTimer);
  _noteTimer = setTimeout(hideReadyNote, READY_NOTE_MS);
}

// KNOWN, NOT FIXED: a note raised just
// before the reader clears the feed sits over the caught-up screen for the rest of its six seconds,
// offering to group posts that are all now read. It self-heals on the timer and nothing is lost.
// The fix if it ever annoys anyone is one line in
// `showCaughtUp`: call `hideReadyNote()`.
function hideReadyNote() {
  clearTimeout(_noteTimer);
  _noteTimer = null;
  document.getElementById('group-ready-note')?.classList.add('hidden');
}

// Reveal X cards that were held hidden in the stream while grouping ran (see renderFeedResults).
// Substack is never held, so it is never waiting on this.
// Called when grouping resolves so any text that stayed ungrouped — the degrade path (no key, network
// failure) or the server input cap — appears in the chronological stream instead of vanishing.
function revealPendingText() {
  document.querySelectorAll('#feed .card.grouping-pending').forEach(c => c.classList.remove('grouping-pending'));
  tourOnStreamChanged(); // released posts can be the first a waiting tour has had to point at
}

// ── The grouped-view toggle ──────────────────────────────────────
// Ungrouped is the DEFAULT. Every post renders into the chronological stream; an assigned one
// additionally carries `.grouped-out` (display:none) only while the reader has grouping on. The lift
// HIDES rather than removes, which is what makes the toggle symmetric and idempotent — a removed card
// is not rebuilt until the next feed load, so toggling back would strand the reader on an empty feed.

// 'off' is the default AND the fallback for any unexpected value, so a corrupted key degrades to the
// plain chronological feed — the thing that always works.
function isGrouped() { return localStorage.getItem(SK.groupView) === 'on'; }

function setGrouped(on) {
  localStorage.setItem(SK.groupView, on ? 'on' : 'off');
  // Deliberately NO schedulePush() and NO SK.dirty: this key is not synced, so there is nothing to
  // push — and arming the sync would let flipping a VIEW raise the "Not syncing" notice.
}

// Apply `.grouped-out` to exactly the cards the grid owns. Idempotent and symmetric — it is a
// `toggle` over the whole stream, not an incremental add, so calling it twice changes nothing and
// calling it after a view flip needs no record of what the previous view hid.
//
// A DEFERRED post is excluded on purpose: it was placed while its card was already
// visible, so it stays readable in the stream until the next feed load. Hiding it here would be the
// same yank-under-the-reader that deferral exists to prevent, wearing a different class name.
function setGroupedCardsHidden() {
  const on = isGrouped();
  const assigned = getGroupState().assignments;
  document.querySelectorAll('#feed .card').forEach(card => {
    const id = card.dataset.id;
    if (!id) return;
    card.classList.toggle('grouped-out', on && Object.hasOwn(assigned, id) && !_liftDeferred.has(id));
  });
}

// Switch the whole view over, from whatever state it is in now.
function applyGroupView() {
  setGroupedCardsHidden();
  renderTopicCards();  // self-gating: it removes its own cards while ungrouped
  // The caught-up screen OWNS the badge and `#feed`'s visibility. Re-running the counters there
  // repaints "N new" from cards whose posts are every one of them done — the count does not consult
  // the done set, it only skips `.removing` and `.grouped-out`.
  if (document.getElementById('caughtup').classList.contains('hidden')) {
    updateCount();     // …which also runs updateSectionHeads()
    checkEmpty();
  } else {
    updateSectionHeads();
  }
  // A card held for a classify that is still in flight must not stay hidden in the ungrouped view —
  // only `updateGroupsForFeed`'s tail reveals it otherwise, up to 4.4-10.3s later.
  // …which also asks a waiting tour to look again: switching grouping OFF is how filed posts return to the stream.
  // Switching it on only takes posts away, and the tap already re-places a running card.
  if (!isGrouped()) revealPendingText();
  syncGroupingToggle();
}

// A classify produced something the reader can actually be shown; the next paint blooms.
let _shineArmed = false;

// The SENTENCE's own arm, deliberately separate from `_shineArmed` rather than riding it.
// The bloom's arm LATCHES on purpose: it is consumed only inside `if (_shineArmed && live)`, so a
// classify that lands while the switch is inert blooms later, when a tile finally becomes paintable.
// That is right for the bloom, which means "the grid changed".
// It is WRONG for the sentence: mark everything done during a classify, resolve it inert, then tap Undo, and
// a latched arm fires on the NEXT RENDER — `syncGroupingToggle` runs on every one — announcing new
// topics on a paint that made no API call at all.
// This arm is therefore consumed by the VERY NEXT paint whatever happens: shown if that paint can
// show it, dropped if it cannot. It never survives to a later one. N10.
let _noteArmed = false;

// Paint the control from state. The ONE place that decides how the switch looks, so a caller cannot
// half-update it.
function syncGroupingToggle() {
  const el = document.getElementById('toggle-grouping');
  if (!el) return;
  const on = isGrouped();
  el.classList.toggle('is-on', on);
  el.setAttribute('aria-checked', String(on));

  // Inert — WHILE OFF — until the grid would ACTUALLY paint a tile. NOT `Object.keys(groups).length
  // > 0`: a topic
  // whose posts are all done, archived, deferred or not-in-hand drops out of the grid entirely
  // (`counts[gid] > 0`), so that test would offer the reader a view that opens empty.
  //
  // `aria-disabled`, not `disabled`, so the control stays in the accessibility tree and its label can
  // still be read. It is advisory, so the click handler carries its own explicit guard.
  // `isGrouped() ||` — ALWAYS ALLOW TURNING OFF. Computing `live` from the grid
  // alone makes "nothing to switch INTO" and "no way to switch OUT OF" one state: a reader whose
  // topics all went done, archived or out-of-hand — or whose X posts stopped arriving at the plan's
  // post cap — would be stranded in a view they did not want,
  // holding a dead switch. Inert is for the empty view ahead, never for the way back. Cost checked,
  // not assumed: this gates only the CLICK, the classify runs eagerly whatever the view (so no extra
  // API spend), and the key is device-local with no `schedulePush` (so no network call). T22.
  const live = isGrouped() || paintableTileCount() > 0;
  el.setAttribute('aria-disabled', live ? 'false' : 'true');

  if (_shineArmed && live) {
    el.classList.remove('is-shining');
    void el.offsetWidth;          // restart cleanly if a second classify lands mid-bloom
    el.classList.add('is-shining');
    _shineArmed = false;
  }

  // …and say what happened, but ONLY to a reader who is not already there. The bloom
  // fires in BOTH views (it means "the grid changed"); the sentence is an offer, and offering
  // "you can group your posts by topic now" to someone reading the grouped view is telling them to
  // do the thing they have done. The `!on` gate is the one piece of genuinely new logic here — N6.
  //
  // Consumed unconditionally, and OUTSIDE the bloom's `live` gate above — that is the whole point.
  // Inside it, an arm that could not be shown would survive to a later, unrelated paint (N10).
  // `live` and `!on` decide whether it is SHOWN; nothing decides whether it is CLEARED.
  // N12 pins the `live` term, N6 the `!on` term — each mutated separately, because a compound
  // predicate deleted in one edit short-circuits and proves only what short-circuited.
  if (_noteArmed && live && !on) showReadyNote();
  _noteArmed = false;
}

function wireGroupingToggle() {
  const el = document.getElementById('toggle-grouping');
  if (!el) return;
  el.addEventListener('click', () => {
    if (el.getAttribute('aria-disabled') === 'true') return; // advisory attribute; guard explicitly
    const on = !isGrouped();
    setGrouped(on);
    // A tap consumes the shine whichever way it went — the reader has now seen the news.
    el.classList.remove('is-shining');
    _shineArmed = false;
    _noteArmed = false;
    hideReadyNote();   // …and the sentence with it: they have acted on the offer
    track('group_view_toggle', { on }, 'group');
    applyGroupView();
  });
  syncGroupingToggle();
}

async function updateGroupsForFeed(items) {
  if (_grouping) return;
  // Pruning of stale assignments happens up front in renderFeedResults (syncGroupPrune) — here we
  // only classify genuinely-new X posts against the existing labels.
  const done = getDoneSet();
  const textItems = items.filter(it => isGroupableSource(it) && !done.has(it.id));
  const state = getGroupState();
  const newItems = textItems.filter(it => !Object.hasOwn(state.assignments, it.id));
  if (newItems.length === 0) { revealPendingText(); return; } // nothing to group → don't leave text hidden

  // A one-line instrument: the distribution of groupable-unread posts per load, which
  // has never been measured — every absolute backlog figure on record is synthetic. Both numbers are
  // in hand here, and it rides the analytics buffer that already flushes on the next /api/state PUT —
  // no endpoint, no key, no dependency.
  track('group_classify', { new: newItems.length, total: textItems.length }, 'group');

  // Armed BEFORE `_grouping` is raised, deliberately. Between raising the flag and entering the
  // `try` there must be nothing that can throw, or a throw there leaves `_grouping` true and
  // `hideGroupBusy()` unrun — which is the very wedge the bound below exists to prevent. Not reachable
  // today (`AbortController` is universal and already used three times in this file), but it costs
  // two lines of ordering to make unreachable by construction rather than by luck.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GROUP_TIMEOUT_MS);
  _grouping = true;
  showGroupBusy();
  let changed = false;
  // BOUND. A
  // request that STALLS rather than fails never settles, so the `finally` below never runs:
  // `_grouping` stays true and NO FURTHER CLASSIFY RUNS for the rest of the session, behind a busy
  // indicator that never stops — and since that indicator sits in the STICKY appbar,
  // one that cannot even be scrolled away.
  //
  // The half that costs the READER: `renderFeedResults` re-applies `.grouping-pending` on every
  // later render, while the re-entrancy guard at the top of this function returns BEFORE
  // `revealPendingText()`. So held posts are re-hidden on each render and nothing ever reveals them.
  // Measured without the bound, three renders against a stalled classify: the badge reads
  // "3 new" over a COMPLETELY EMPTY feed, and a post arriving after the wedge is swallowed too.
  //
  // NOT "the only unbounded fetch in this file": `app.js` has 16 `fetch(` calls
  // and 5 carry a signal; the `/api/state` PUT below is unbounded ON PURPOSE, `exportData`'s GET and
  // three auth calls simply are. What is true is narrower and is the whole reason this one needed a
  // bound: it is the only unbounded fetch whose failure to settle LATCHES a guard, so the cost is
  // not one lost request but every later classify in the session.
  //
  // The PUT below records that an AbortController there was measured WORSE than parking.
  // That does NOT transfer here, and it was CHECKED rather than reasoned: `api/group.js`
  // writes nothing. Its only use of the database is the sign-in gate's session READ, which
  // finishes before the model call starts. There is no server-side write to strand
  // mid-flight — an abort abandons a billed model call and nothing else.
  try {
    // `size` = how many UNREAD posts this topic still holds. Without it the server cannot tell a new
    // post joining a 40-member topic from a post about nothing, so it folded both into "Everything
    // else" and real topics never grew. Counted the way the grid counts, so a fully-read
    // topic reports 0 and gets no protection.
    // `summary` = the bullets this topic ALREADY has.
    //
    // ⚠️ DO NOT DELETE THIS FIELD, and read why before touching it. The model does not
    // see these bullets: `planExistingTopics` forwards none. It would be natural to conclude the send
    // is dead weight and drop it. **That silently destroys every summary** — the server restores
    // cached bullets from exactly
    // this field (`restoreCachedBullets`, via `plan.withheld`), and it is the ONLY copy that
    // restoration can draw on. Send nothing here and every topic's summary is replaced by whatever
    // the model wrote about the new posts alone.
    //
    // Only LIVE bullets go up — a bullet whose posts are all read is not restored, which
    // is how a finished topic stops carrying its day-one summary. That filter now decides what is
    // RESTORABLE rather than what is billed, since nothing here reaches the prompt. `unread` is
    // computed once and used for both the size and the filter, so the two cannot disagree.
    // `groupUnreadIds`, NOT `visibleGroupUnreadIds` — and this is the one place where that choice
    // destroys data if it is got wrong. A deferred
    // post is unread; filtering it out here would shrink `size` (the protection a real topic
    // gets) and, far worse, drop its bullet from `summary` — the ONLY copy `restoreCachedBullets`
    // can draw on. The deferred set is in fact empty at this point, because
    // `updateGroupsForFeed` is only ever called from `renderFeedResults`, which clears it first; that
    // makes the hazard latent rather than live, and `group-defer-lift` C7 drives the unreachable state
    // directly so the invariant is checked rather than merely argued.
    // ⚠️ THIS IS THE LINE THE DATA-LOSS GUARD IS ON (not `groupGridCounts`), and it is pinned by
    // the tests named B4 and C7. Narrow `unread` to
    // what this render fetched and every topic's cached summary is destroyed on the next classify.
    const existing = Object.entries(state.groups).map(([id, g]) => {
      const unread = new Set(groupUnreadIds(id));
      return { id, label: g.label, size: unread.size, summary: liveBullets(g.summary, unread) };
    });
    const payload = newItems.map(it => ({ id: it.id, source: it.source, text: groupTextOf(it) }));
    const res = await fetch('/api/group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: payload, groups: existing }),
      signal: ctrl.signal,
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.groups) {
        // The server recovered this reply from a `groups` field that arrived as a STRING.
        // `truncated` separates the two model behaviours that share that path — a cut-off string
        // from a complete one that was merely serialised. One number for both would let a rate
        // that stopped being about truncation go on looking identical.
        //
        // Emitted BEFORE the merge deliberately: the merge is what can throw, and a repair that
        // happened must be recorded even if what followed it did not. That ordering means this event
        // asserts "the reply was recovered", NOT "the classify succeeded" — a merge that throws
        // lands in the `catch` below and is counted there as a failure.
        if (data.repaired) {
          track('group_classify_repaired',
            { new: newItems.length, total: textItems.length, truncated: data.truncated === true }, 'group');
        }
        mergeGroups(state, data.groups, newItems);
        // Which of the posts we just sent came back with no home. Recorded so the next
        // render does not hold them hidden all over again — M2 measured the sticky set at 22-32% of a
        // single-domain backlog, held for 4.4-10.3s on EVERY load, against a badge still counting them.
        //
        // Computed from the OUTCOME (which ids ended up unassigned) rather than by reading the
        // bucket's members, so a post the partition dropped some other way is covered too. Rebuilt
        // wholesale, which is what makes a post the model later places drop out of it by itself —
        // sticky posts carry no assignment, so they are always in `newItems` and always re-decided.
        //
        // Only on a SUCCESSFUL classify. On a degrade nothing came back, and writing the record there
        // would let one network blip mark genuinely-new posts as already-seen, permanently.
        //
        // And only for posts the server ACTUALLY PROCESSED. `capBatch` (api/_group.js) keeps a prefix
        // and flags `capped`, so on a backlog over MAX_ITEMS the tail never reaches the model at all —
        // and `newItems` is what the client SENT, not what came back. Recording the tail would render
        // it unheld next load and then yank it into a topic once a later classify reached it, which is
        // a visible flash for the posts that never had their turn.
        //
        // `validatePartition` guarantees the response is an exact partition of what was processed, so
        // the union of the returned item_ids IS "what was looked at" — no dependence on the `capped`
        // flag, which would only cover the truncation case and not a group the repair pass dropped.
        // So a post JOINS the record when a classify examined it and gave it no home, and LEAVES it
        // only by gaining an assignment or by leaving the feed (the liveness prune). Not being looked
        // at this round is not evidence of anything, and must not discard what an earlier round
        // already established — recomputing wholesale from the accounted
        // set would quietly drop a known-unplaceable post the moment one capped batch omits it,
        // handing back the hold it had already earned its way out of.
        // No shape coercion here on purpose: `mergeGroups` has just iterated both `data.groups` and
        // each `item_ids` one line above, so any shape that would need guarding has already thrown
        // into the degrade path. A coercion here would be unreachable by construction — defensive
        // noise on internal code, and two mutations that survive by design.
        const accounted = new Set(data.groups.flatMap(g => g.item_ids || []));
        // Bounded by the feed in hand, NOT only by assignments. `syncGroupPrune` is the record's
        // other liveness pass and its `unfiled` half is gated on a complete load, while this function
        // is not — so on
        // a feed with one permanently-dead channel (or X 502ing at its post cap, which is routine)
        // nothing would ever prune and a carry-forward record would grow monotonically on a synced
        // key — the one record whose justification is that it stays small.
        //
        // Unlike the ASSIGNMENT prune, this needs no complete-load gate, and the asymmetry is the
        // whole reason it is safe here: dropping an assignment wrongly destroys a cluster — label,
        // bullets, synced to every device — whereas dropping an id from this record wrongly costs one
        // post one extra hold, once, the next time it appears. Cheap to be wrong in this direction,
        // catastrophic in that one.
        const inFeed = new Set(textItems.map(it => it.id));
        const stillUnfiled = state.unfiled.filter(id => inFeed.has(id) && !Object.hasOwn(state.assignments, id));
        const newlyUnfiled = newItems
          .filter(it => accounted.has(it.id) && !Object.hasOwn(state.assignments, it.id))
          .map(it => it.id);
        state.unfiled = [...new Set([...stillUnfiled, ...newlyUnfiled])];
        state.updatedAt = Date.now();
        _groupsCapped = !!data.capped; // surface the server input-cap (no silent truncation)
        changed = true;
      }
      // else: degrade signal / bad body → leave those posts in the chronological stream
      else {
        // The endpoint answered 200 and carried nothing usable. Note what this does NOT
        // mean: `api/group.js` converts every failure of the CLASSIFY into this shape — a missing
        // ANTHROPIC_API_KEY, an Anthropic outage, an unreadable reply — so it is "the server gave us
        // no groups", not "a billed call bought no grouping". An unset key on Production drives this
        // to 100% having spent nothing.
        track('group_classify_degraded', { new: newItems.length, total: textItems.length }, 'group');
      }
    } else {
      // The request never reached that logic: a non-2xx from our own endpoint. The WAF
      // rate-limit rule (documented in api/group.js) denies at
      // the EDGE, and a platform function timeout answers 5xx — neither reaches the handler, so
      // neither can arrive as a degrade. Counted separately because the remedy differs, and counted
      // AT ALL because the
      // degrade counter cannot distinguish "reply unreadable" from "Anthropic down" either, so
      // excluding this would buy no precision.
      // The handler ITSELF also answers non-2xx, before any of that logic runs: 401
      // with no session and 503 when the session could not be checked. Both land here with their status.
      track('group_classify_failed', { new: newItems.length, total: textItems.length, status: res.status }, 'group');
    }
  } catch {
    // Network failure — degrade: those posts stay in the chronological stream.
    //
    // The one thing recorded on this path, and ONLY when WE gave up rather than the network failing.
    // GROUP_TIMEOUT_MS is sized from a model, not from a measurement at `MAX_ITEMS` — nobody has ever
    // timed a classify at that scale. This counter is how a wrong number becomes visible in data
    // instead of waiting for someone to notice grouping quietly not working. `new`/`total` ride along
    // because a timeout that only happens on large backlogs says something different from one that
    // happens on small ones.
    //
    // It records no POST IDS and arms no state write — a timeout must still leave the record
    // byte-identical (C5). `track` writes the analytics buffer, which is a different key entirely.
    if (ctrl.signal.aborted) track('group_classify_timeout', { new: newItems.length, total: textItems.length }, 'group');
    // Everything else that throws: offline, DNS, a connection reset, or a merge that threw
    // after the reply arrived. `status: 0` because no response ever existed to have one. With this,
    // the outcomes finally PARTITION — attempts minus degraded, repaired, failed and timeout leaves
    // clean successes, which is what makes "grouping sometimes just doesn't happen" a number rather
    // than a shrug.
    else track('group_classify_failed', { new: newItems.length, total: textItems.length, status: 0 }, 'group');
  }
  // `clearTimeout` lives HERE and not next to the `await fetch` — that placement is the point, not
  // housekeeping. The stall this bounds can happen AFTER the headers arrive, with `res.json()` the
  // thing that never settles; a timer cleared the moment the response object exists leaves exactly
  // that case unbounded, which is the `/api/state` pattern's blind spot. The `finally` covers every
  // path — success, non-ok, throw, abort — and runs after the body read on all of them. C3.
  finally { clearTimeout(timer); _grouping = false; hideGroupBusy(); }

  if (changed) {
    saveGroupState(state);
    // ORDER IS LOAD-BEARING: the lift is what decides which posts were DEFERRED
    // (placed while their card was already visible), and `renderTopicCards` reads that set — through
    // `visibleGroupUnreadIds` — to know what each topic card owns right now. Painting first shows the deferred post in its tile AND in the
    // stream for one frame — a duplicate. Swapping these two lines back
    // reds group-defer-lift C3 by name.
    if (isGrouped()) {
      liftGroupedFromStream(); // lift the now-grouped text out of the chronological stream
      setGroupedCardsHidden(); // …and hide anything this classify newly assigned
      renderTopicCards();      // reflect freshly-classified groups in the stream
    }
    // Arm the bloom only if this classify gave at least one post a home THE READER CAN BE SHOWN.
    // `changed` alone is the wrong signal: it is also true when every post came back unplaceable, and
    // when a reply merely folds posts into an existing topic.
    //
    // Computed AFTER the lift, and that order is the whole point. Computed before it, the
    // `_liftDeferred` term CANNOT FAIL — `newItems` is exactly the complement of the assignment keys,
    // and `_liftDeferred` only ever receives ids that ARE assignment keys — so the filter reads as
    // protection while being vacuous by construction.
    // NO in-hand term here, deliberately. One
    // would be VACUOUS BY CONSTRUCTION: `updateGroupsForFeed` has exactly one
    // caller (`renderFeedResults`), which sets `_lastFeedItems = items` earlier in that same function
    // — not adjacent to the call, but unconditionally before it — so every `newItems` id
    // is in `inHandGroupableIds()` and the term could never be false:
    // present, ineffective, and reading as protection. `visibleGroupUnreadIds` still applies the real in-hand rule where posts genuinely
    // can be missing; this predicate is only about what THIS classify just placed.
    const showable = newItems.filter(it => Object.hasOwn(state.assignments, it.id) && !_liftDeferred.has(it.id));
    if (showable.length) { _shineArmed = true; _noteArmed = true; }
  }
  syncGroupingToggle();      // goes live / blooms if this classify produced a tile
  revealPendingText();       // reveal any text left ungrouped (degrade / input cap) — it was held
                             // hidden so it wouldn't flash under "Posts"; it must now show, not vanish
  updateCount();
}

// The bullets a tile should actually show: those describing at least one post you have not read yet.
// A bullet with no ids always shows — see `bulletIsLive`.
//
// This is deliberately a render-time filter over state rather than a
// mutation of it. Two consequences worth keeping: it self-corrects, so a stale write (an in-flight
// classify resurrecting pruned state) cannot leave a wrong tile on screen; and it never
// deletes, so being wrong here shows a bullet too many rather than destroying one.
function liveBullets(summary, unreadIds) {
  if (!Array.isArray(summary)) return summary;
  return summary.filter(b => bulletIsLive(b, unreadIds));
}

// Show/hide the "Topics" and "Posts" section headers based on whether each section has content —
// keeps the two sections cleanly labelled and the Topics section visibly pinned above the rest.
// The "Posts" heading kept the id `videos-head` when it was renamed.
function updateSectionHeads() {
  const feed = document.getElementById('feed');
  // ONE HEAD, AND IT MUST COUNT TOPIC CARDS.
  // A topic card deliberately carries no `.card` (or `updateCount` would count it
  // as a post), so without this term a feed holding ONLY topic cards matches zero here and "Posts"
  // hides itself over a screen full of content.
  const hasCards = feed && (
    feed.querySelectorAll('.card:not(.removing):not(.grouping-pending):not(.grouped-out)').length > 0
    || feed.querySelectorAll('.topic-card:not(.removing)').length > 0);
  const feedShown = feed && feed.style.display !== 'none' && hasCards;
  document.getElementById('videos-head')?.classList.toggle('hidden', !feedShown);
}

// What each tile owns right now, and which posts are unread per topic.
//
// SHARED with the grouping switch, which needs the same answer: the switch must be inert
// until the grid would ACTUALLY paint a tile, and `Object.keys(state.groups).length > 0` is a
// different question — it says a topic exists, not that anything reachable is in it. Computing that
// separately would be one more definition of unread-per-group, and
// the two would drift apart exactly where it matters. One walk, two callers, no copy.
function groupGridCounts() {
  const state = getGroupState();
  const done = getDoneSet();
  const arch = getArchiveSet();
  const counts = {};
  const inHand = inHandGroupableIds();
  // The same walk also collects WHICH posts are unread per group, so the bullet filter below asks
  // the identical question the count answers. Built here rather than by calling
  // groupUnreadIds(gid) per tile: that re-reads localStorage and re-parses the whole state for every
  // topic. This
  // adds no further definition — it is the count's own working.
  // THE SECOND ANSWER: which unread posts the reader can actually REACH right now. The
  // bullets are painted from this, so a card never describes posts it
  // cannot open ("6 posts" over 26 bullets).
  const reachableByGid = {};
  for (const [itemId, gid] of Object.entries(state.assignments)) {
    if (done.has(itemId) || arch.has(itemId)) continue;
    // `counts` and `reachable` DELIBERATELY DIVERGE for a deferred post:
    //
    //   reachable — "which posts can the reader open right now", which decides which BULLETS render.
    //               A deferred post is on screen in the stream, so it KEEPS its bullet; dropping it
    //               would make the sentence blink out of the card and back on the next load.
    //   counts    — "what does this card own RIGHT NOW". A deferred post is already in the stream, so
    //               the card must not also claim it, or the reader sees it twice and the badge counts
    //               it twice.
    //
    // This is not one more definition of unread-per-group
    // but a real split between a REACHABILITY question and an OWNERSHIP one. Do not "tidy" them back
    // together.
    //
    // The header count comes from `visibleGroupUnreadIds`, not from `counts`.
    // Reachable means ON THIS CARD'S RAIL, OR VISIBLE IN THE STREAM.
    // One rule, and it settles both of the exclusions below in opposite directions, which is why it
    // is stated as a rule rather than as two filters.
    const reachable = reachableByGid[gid] || (reachableByGid[gid] = new Set());
    // A DEFERRED POST IS REACHABLE: it is on screen in the chronological stream, just not on this
    // rail. So it keeps its bullet. Dropping this `add` reds `group-defer-lift` C3c and T32.
    //
    // THE `continue` IS LOAD-BEARING TOO (pinned by B11). Delete it and a
    // deferred post falls through into `counts`, so a topic whose only unread post is deferred paints
    // a card reading "0 posts" over an empty rail, in the stream directly above the post it describes.
    if (_liftDeferred.has(itemId)) { reachable.add(itemId); continue; }
    // Same split, one rule further: an assignment whose post this render did not fetch is
    // not COUNTED, or the card claims posts its own rail cannot show.
    // A topic with nothing reachable drops
    // out of the stream entirely via `counts[gid] > 0` below, and returns when its posts do.
    //
    // A post this render did not fetch is reachable NOWHERE — not on the rail, not in the stream —
    // so it gets no bullet. `inHand` is null when no feed has loaded, and then nothing is narrowed at
    // all: absence is not evidence. B7 pins it.
    if (inHand && !inHand.has(itemId)) continue;
    reachable.add(itemId);
    counts[gid] = (counts[gid] || 0) + 1;
  }
  // No wider `unreadByGid` is returned: nothing here protects the /api/group payload. That
  // payload is built at `updateGroupsForFeed` from `groupUnreadIds`, and that is where the guard
  // lives. See the note there.
  return { counts, reachableByGid };
}

// How many topic cards the stream would paint right now. `counts[gid] > 0` is `renderTopicCards`'s
// own filter, so this cannot disagree with what the reader ends up seeing.
function paintableTileCount() {
  const { counts } = groupGridCounts();
  return Object.keys(getGroupState().groups).filter(gid => counts[gid] > 0).length;
}

// ONE STREAM. A topic renders as an always-expanded `.topic-card` INSIDE `#feed`, in the
// chronological slot of its newest unread post — not as a collapsed tile in a separate grid above it.
// There is no separate grid and no drill-in: the same feed read in two places under
// two rules is a reliable source of count and visibility bugs.
//
// BUILT AS APPENDED NODES, not one `innerHTML` blob — a testability requirement, not a style
// preference. `test-helpers/app-harness.mjs` stores `innerHTML` as an unparsed STRING, so anything
// inside a blob is invisible to the suite. The old `.group-card` WAS such a blob, which is exactly
// why its label, count, buttons and bullets were pinned by nothing at all.
//
// NO `.card` CLASS, here or on the nested post. `updateCount` and `checkEmpty` both
// count `#feed .card:not(.removing):not(.grouped-out)` and add `countGroupedUnread()` on top — so a
// topic card carrying `.card` reads L + G + T, and a nested rail card carrying it reads L + 2G,
// because the rail lives inside `#feed` and those posts are already counted from storage.
function renderTopicCards() {
  const feed = document.getElementById('feed');
  if (!feed) return;
  const note = document.getElementById('group-note');
  // Remove what this function owns before repainting. `renderFeedResults` rebuilds `#feed` wholesale,
  // but the toggle and a background classify call straight in here over an already-painted feed — so
  // without this a second call stacks a duplicate set of topic cards on the stream.
  [...feed.children].filter(c => c.classList.contains('topic-card')).forEach(c => c.remove());

  // Ungrouped is the default view. Gated HERE rather than at each call site, so no
  // future caller can paint topics the reader did not ask for, and the OFF state is reached by the
  // same path whether it arrived by toggle, by reload or by a background classify.
  if (!isGrouped()) { if (note) note.classList.add('hidden'); updateSectionHeads(); return; }

  const state = getGroupState();
  const { counts, reachableByGid } = groupGridCounts();
  // Biggest first decides only the FALLBACK append order; `topicAnchor` decides where a card actually
  // lands, because in one stream a topic sits in time order among the posts.
  const entries = Object.entries(state.groups)
    .filter(([gid]) => counts[gid] > 0)
    .sort((a, b) => counts[b[0]] - counts[a[0]]);

  if (entries.length === 0) { if (note) note.classList.add('hidden'); updateSectionHeads(); return; }

  const items = new Map((_lastFeedItems || []).map(it => [it.id, it]));
  for (const [gid, g] of entries) {
    const ids = visibleGroupUnreadIds(gid); // exactly what the header count claims
    feed.insertBefore(buildTopicCard(gid, g, ids, reachableByGid[gid] || new Set(), items),
                      topicAnchor(feed, state.assignments, gid));
  }
  // This is the ONLY site that reveals the note. Without it `_groupsCapped` would be
  // set and never read — silent truncation, the one thing the note exists to prevent.
  if (note) note.classList.toggle('hidden', !_groupsCapped);
  updateSectionHeads();
}

// Where a topic card belongs: immediately before the first card holding one of its posts.
// `renderFeedResults` appends in feed order, so that card is the topic's newest post and the topic
// lands in its own chronological slot. `insertBefore(node, null)` appends, which is the right answer
// for a topic whose posts this device did not fetch.
function topicAnchor(feed, assigned, gid) {
  return [...feed.children].find(c => c.dataset && assigned[c.dataset.id] === gid) || null;
}

// The topic card's bullet list, painted from state. ONE definition, called both when the card is
// built and when a rail action changes what is unread — two loops here would be two renderers, and
// the whole defect T31 pins is a card disagreeing with itself about which posts it holds.
//
// The "No summary yet" note is toggled HERE, for the same reason. The list can empty out
// mid-session — `liveBullets` drops a bullet once every post it names is read — so a note painted
// only at build time would be a second renderer disagreeing with the first the moment a Done lands.
// `emptyEl` is optional so a caller that has no note (there is none today) is unchanged.
function paintBullets(ul, summary, unread, emptyEl) {
  [...ul.children].forEach(c => c.remove());
  for (const b of liveBullets(summary, unread) || []) {
    const text = bulletText(b);
    if (!text.trim()) continue;
    const li = document.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
  }
  // BOTH halves, or they share the slide. `.tc-bullets` and `.tc-empty` each carry `flex: 1`, so an
  // empty list still claims half the page and the note is centred in the OTHER half — measured at
  // 104px below the slide's centre in Chrome before this line hid the list. They are mutually
  // exclusive by design; this is what makes them mutually exclusive in layout.
  if (emptyEl) {
    const blank = ul.children.length === 0;
    emptyEl.classList.toggle('hidden', !blank);
    ul.classList.toggle('hidden', blank);
  }
}

function countLabel(n) { return `${n} ${n === 1 ? 'post' : 'posts'}`; }

function buildTopicCard(gid, g, ids, unread, items) {
  const card = document.createElement('div');
  card.className = 'topic-card';   // deliberately NOT `.card` — see the note above
  card.dataset.gid = gid;

  const head = document.createElement('div');
  head.className = 'tc-head';
  const label = document.createElement('span');
  label.className = 'tc-label';
  label.textContent = g.label || 'Topic';   // textContent, not innerHTML: the label is LLM-authored
  const count = document.createElement('span');
  count.className = 'tc-count';
  count.textContent = countLabel(ids.length);
  const done = document.createElement('button');
  done.className = 'tc-done';
  done.type = 'button';
  done.textContent = 'Mark all done';
  done.addEventListener('click', () => markGroupDone(gid));
  card.appendChild(head);
  head.appendChild(label);
  head.appendChild(count);
  head.appendChild(done);

  const rail = document.createElement('div');
  rail.className = 'tc-rail';

  // SLIDE ONE IS THE SUMMARY. As a page it gets 432px.
  //
  // NO `data-id`, deliberately: the guarantee is that every id on this rail is one the header
  // count claims, and a summary is not a post. It carries `.tc-slide` so `wireCarouselDots` — which
  // re-queries `.tc-slide` and uses `slides.indexOf` — aligns it with dot 0 for free.
  //
  // The slide is present even with nothing to say. Dropping it would restructure the
  // card mid-session under the reader's thumb.
  const summarySlide = document.createElement('div');
  summarySlide.className = 'tc-slide tc-summary';
  const bullets = document.createElement('ul');
  bullets.className = 'tc-bullets';
  const emptyNote = document.createElement('div');
  emptyNote.className = 'tc-empty';
  emptyNote.textContent = 'No summary yet';
  paintBullets(bullets, g.summary, unread, emptyNote);
  summarySlide.appendChild(bullets);
  summarySlide.appendChild(emptyNote);
  rail.appendChild(summarySlide);

  for (const id of ids) {
    const item = items.get(id);
    if (!item) continue;
    const slide = document.createElement('div');
    slide.className = 'tc-slide';
    slide.dataset.id = id;
    slide.appendChild(renderReducedPost(item, gid));
    rail.appendChild(slide);
  }
  card.appendChild(rail);

  // One dot per SLIDE, which is now posts + 1. Reading it off `rail.children` rather than off `ids`
  // is what keeps that true without a second count to hold in sync.
  const n = rail.children.length;
  const dots = document.createElement('div');
  dots.className = 'tc-dots';
  for (let i = 0; i < n; i++) {
    const dot = document.createElement('span');
    dot.className = i === 0 ? 'tc-dot active' : 'tc-dot';
    dots.appendChild(dot);
  }
  // NO "Swipe →" HINT, deliberately; T15 pins its absence so it cannot come back by slip.
  // It would be the only thing on the card whose presence depended on the post
  // count, so its absence is what makes every topic card render identically, and the dots carry the
  // sideways cue alone.
  card.appendChild(dots);
  // Reuses the in-tweet photo carousel's mechanism verbatim — scroll-snap x with dots synced by an
  // IntersectionObserver, no touch handler — so the rail needs no new gesture code.
  //
  // GUARDED ON `n > 1`. It is tempting to reason that a
  // card only renders when `counts[gid] > 0`, so there are always at least two slides. But `counts`
  // counts ASSIGNMENTS while the loop above appends a slide only when `items.get(id)` resolves — and
  // `items` comes from `_lastFeedItems`, which is null after a caught-up boot AND a failed one.
  // The rail can hold the summary alone, and an IntersectionObserver
  // over one slide is a dot row that can never change, watching a page that can never be left.
  // Reachable through Archive → Remove → `insertIntoFeed`. Pinned by T13.
  if (n > 1) wireCarouselDots(rail, dots, '.tc-slide', '.tc-dot');
  return card;
}

// The nested post: avatar, display name, `@handle · timeAgo`, a small X link, the text,
// Archive and Done. No media, no quoted tweet, no "New" badge — a fixed post height is what keeps the
// 127px peek exact and the carousel stable.
//
// The ACTIONS are appended nodes rather than `cardActionsHtml`'s markup, for the harness reason
// above: inside an `innerHTML` blob neither button is reachable, so "did Done act on the right post"
// would be unassertable — and these are data-writing paths.
function renderReducedPost(item, gid) {
  const post = document.createElement('div');
  post.className = 'tc-post';   // deliberately NOT `.card`
  post.dataset.id = item.id;
  const ch = item.channel || {};
  const handle = ch.handle ? `@${esc(ch.handle)} · ` : '';
  // REQUIRED, not decorative: the rail is ~240px and a long post truncates, so without a way out a
  // truncated post is a dead end.
  const href = safeHref(item.url); // an http(s) link or none — a feed chooses its own URLs
  const link = href
    ? ` · <a class="tc-link" href="${esc(href)}" target="_blank" rel="noopener">Open ↗</a>`
    : '';
  const chan = document.createElement('div');
  chan.className = 'chan';
  chan.innerHTML = `
    ${avatarHtml(ch)}
    <div>
      <div class="chan-name">${esc(ch.name || '')}</div>
      <div class="chan-meta">${handle}${esc(timeAgo(item.published))}${link}</div>
    </div>`;
  post.appendChild(chan);

  const text = document.createElement('div');
  text.className = 'tc-text';
  text.textContent = item.text || item.title || '';
  post.appendChild(text);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const doneBtn = document.createElement('button');
  doneBtn.className = 'btn-done';
  doneBtn.type = 'button';
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', () => markDoneInGroup(post, item.id, item, gid));
  const archBtn = document.createElement('button');
  archBtn.className = 'btn-archive';
  archBtn.type = 'button';
  archBtn.setAttribute('aria-label', 'Archive for later');
  archBtn.textContent = 'Archive';
  archBtn.addEventListener('click', () => archiveInGroup(post, item, gid));
  actions.appendChild(doneBtn);
  actions.appendChild(archBtn);
  post.appendChild(actions);
  return post;
}

// The groupable ids THIS RENDER actually has in hand.
//
// Since assignments stopped dying of absence they outlive the feed that fetched them — which is the
// whole point, because the record is synced and the feed is per-device. But a DISPLAY that counts
// every assignment then counts posts this device cannot reach: on a cold cache the badge read "3 new"
// over one visible post, the tile offered "Mark 3 done" for two posts the reader was never shown, and
// reading everything on screen still left the counter stuck, so "You're all caught up" — the
// product's whole promise — never arrived.
//
// So the record is device-independent and the display is per-device. That is the SAME split the
// deferred-post exclusion below already draws, for the same reason, and it must NOT be applied to
// `groupUnreadIds`: that one feeds the classify payload, where under-reporting shrinks a topic's
// `size` and drops bullets `restoreCachedBullets` can no longer recover.
//
// Returns `null` — meaning "do not filter" — when no render has happened yet. `_lastFeedItems` is
// null only before the first feed render, and "I have not looked" is not the same fact as "I looked
// and it was not there". Treating the two alike
// here would blank every tile on a grid painted before the first feed.
function inHandGroupableIds() {
  if (_lastFeedItems === null) return null;
  return new Set(_lastFeedItems.filter(isGroupableSource).map(it => it.id));
}

// The still-unread posts in a group (assignments minus anything since marked done or archived).
// STATE-side: deliberately NOT filtered by what is in hand. See `inHandGroupableIds`.
function groupUnreadIds(gid) {
  const state = getGroupState();
  const done = getDoneSet();
  const arch = getArchiveSet();
  return Object.keys(state.assignments).filter(id => state.assignments[id] === gid && !done.has(id) && !arch.has(id));
}

// The still-unread posts a group can actually SHOW — `groupUnreadIds` minus anything
// deferred, because a deferred post is on screen in the chronological stream instead.
//
// A separate function rather than a flag on `groupUnreadIds`, so the STATE-side caller cannot reach
// this behaviour by accident: `updateGroupsForFeed`'s existing-topics payload must count a deferred
// post as unread (its `size` protects a real topic, and `liveBullets` decides what the server can
// restore — under-report there and the topic's summary is destroyed).
// Every caller here answers "what does the user see"; none of them writes state.
function visibleGroupUnreadIds(gid) {
  const inHand = inHandGroupableIds();
  return groupUnreadIds(gid).filter(id => !_liftDeferred.has(id) && (!inHand || inHand.has(id)));
}

// All still-unread grouped post ids across every group — the grid's contribution to "unread".
// These posts live only in the grid, so count/mark-all/caught-up must
// consult this in addition to the #feed cards.
//
// STATE-side, and deliberately unfiltered: this answers "what does the ACCOUNT still hold unread",
// which is a different question from "what can this device show". The same split `groupUnreadIds` /
// `visibleGroupUnreadIds` draws per group, drawn once more across all of them — and as there, it is
// two functions rather than a flag, so a state-side caller cannot reach the filtered answer by
// forgetting an argument.
function groupedUnreadIds() {
  const { assignments } = getGroupState();
  const done = getDoneSet();
  const arch = getArchiveSet();
  return Object.keys(assignments).filter(id => !done.has(id) && !arch.has(id));
}

// DISPLAY-side: the grouped posts this render can actually put in front of the reader.
//
// A deferred post is excluded because it is still a `#feed` card, and `updateCount` adds
// these to the stream count — counting it in both reads "3 new" over a screen showing two.
// `inHand`: an assignment for a post this device did not fetch is real
// and must survive, but it is not something the reader can act on, so it must not be counted.
//
// Neither filter may live inside `groupedUnreadIds` itself, which would put them on `markAllDone` too
// — and there the `inHand` half is a bug, not a refinement: its posts
// have no stream card precisely because this device never fetched them, so Mark-all would skip them
// and leave them unread on every device that had (pinned by R2a/R2b).
function visibleGroupedUnreadIds() {
  // Ungrouped: the stream holds every post, so the grid owns none of the count.
  // Without this, updateCount adds the assignments on top of the very cards now rendering them —
  // "12 new" over 6 visible posts — and checkEmpty never reaches zero, so "You're all caught up"
  // never arrives. Gated HERE and not in groupedUnreadIds: this feeds only countGroupedUnread →
  // updateCount / checkEmpty, both DISPLAY questions. markAllDone unions the STATE-side list
  // deliberately, and filtering that one would make Mark-all skip posts.
  if (!isGrouped()) return [];
  const inHand = inHandGroupableIds();
  return groupedUnreadIds().filter(id =>
    !_liftDeferred.has(id) && (!inHand || inHand.has(id)));
}
function countGroupedUnread() { return visibleGroupedUnreadIds().length; }

// Lift-out: remove from the chronological stream any text card now assigned to a
// group — those belong to the grid. YouTube cards (their dataset.id is a videoId, never an
// assignment key) are untouched, as is not-yet-classified text.
function liftGroupedFromStream() {
  const assigned = getGroupState().assignments;
  // `:not(.grouped-out)` is LOAD-BEARING under hide-not-remove. A hidden card is still
  // in the DOM, still assigned and no longer `grouping-pending`, so without this exclusion every one
  // of them falls into `_liftDeferred` below, `groupGridCounts` then skips them when building
  // `counts`, `counts[gid] > 0` filters every topic card out and THE GROUPED VIEW COLLAPSES — silently, on a
  // background classify the reader did not ask for.
  document.querySelectorAll('#feed .card:not(.grouped-out)').forEach(card => {
    // `Object.hasOwn`, not `in`. `assigned` comes from JSON.parse, so `'toString' in assigned` is
    // always true, and a Substack card carries its `guid` as `dataset.id` — so a `<guid>toString</guid>`
    // would make that post silently vanish from the feed on every classify.
    //
    // ⚠️ NO TEST PINS THIS LINE. Mutating this
    // back to `in` SURVIVES
    // the whole suite, because the defect adds `.grouped-out` and
    // `setGroupedCardsHidden()` recomputes that class from scratch on the very next line, erasing it.
    // `group-defer-lift.test.mjs` C1c is killed only through `setGroupedCardsHidden`'s own
    // `Object.hasOwn` — a different guard in a different function. Keep `Object.hasOwn` here anyway.
    //
    // There is a THIRD copy of this guard at the render (`grouped` in renderFeedResults), besides
    // the one in `setGroupedCardsHidden`. `C1c` kills only the
    // `setGroupedCardsHidden` copy; the render's survives being changed to `in`. Reachability is low
    // — `isGroupableSource` is twitter-only and X ids are numeric — so it is defensive rather than
    // live damage, but all three must stay `Object.hasOwn` and only one of them is pinned.
    if (!card.dataset.id || !Object.hasOwn(assigned, card.dataset.id)) return;
    // ONLY a card the reader has never seen. `revealPendingText` runs AFTER this
    // function (both in updateGroupsForFeed's tail), so a still-held first-pass card carries
    // `grouping-pending` here and a sticky (unfiled) card — rendered visible, possibly being read
    // right now — does not. The class IS the "has the user seen this" flag; no second record needed.
    //
    // Removing a visible card would yank a post out from under the reader. Mutating this back to an unconditional remove() reds
    // test/group-defer-lift.test.mjs C1 by name.
    // HIDE, not remove. A removed card is not rebuilt until the next feed load, so
    // toggling back to the plain feed would strand the reader looking at an empty stream.
    if (card.classList.contains('grouping-pending')) card.classList.add('grouped-out');
    else _liftDeferred.add(card.dataset.id);
  });
}

// Per-post Done/Archive inside a topic card. Same effect as
// the feed actions, but reconciled against the topic instead of the stream: slide the one slide out,
// refresh the count in the header, and — if that was the topic's last unread post — take the whole
// topic card out too. `checkEmpty()` after that drops to caught-up if the feed is now clear. Done
// offers an Undo (matching single-card feed Done); Archive does not.
//
// THE GID IS A PARAMETER, not module state. There is no
// "currently open topic" to read — several topic cards are on screen at once, so a module-level
// answer would be wrong for every one of them but a single card.
function markDoneInGroup(post, id, item, gid) {
  if (blockedByDamage()) return;
  addDone(id);
  // The hidden stream card is a SECOND HOME for this post, so this writer has
  // to take it too — exactly as `markGroupDone` and `archiveInGroup` do. Without it,
  // `setGroupedCardsHidden` un-hides the orphan on the next toggle and a post the reader explicitly
  // marked done is back in the feed, counted as unread.
  const streamCard = document.querySelector(`#feed .card[data-id="${CSS.escape(id)}"]`);
  if (streamCard) streamCard.remove();
  finishGroupCardAction(post, gid);
  // Undo owes the SECOND HOME too: the Done above destroys the hidden
  // stream card, so an Undo restoring only the topic would leave the post in NEITHER home.
  // `insertIntoFeed` repaints the topic cards.
  showToast('Marked done', 'Undo', () => {
    removeDone([id]);
    if (item) insertIntoFeed(item);
  });
}
function archiveInGroup(post, item, gid) {
  addArchive(toArchiveItem(item));
  // Same second home, same reason.
  const streamCard = document.querySelector(`#feed .card[data-id="${CSS.escape(item.id)}"]`);
  if (streamCard) streamCard.remove();
  finishGroupCardAction(post, gid);
}
// Take one post out of its topic card, then reconcile the card with what is left.
//
// `document.querySelector` with an `#id`-ROOTED selector throughout, never `card.querySelector`: the
// element-scoped form returns a fresh memoised PHANTOM in the test harness rather than the real
// appended node, so a count written through it would update nothing — not the reader's screen, and
// not anything the suite can read back.
function finishGroupCardAction(post, gid) {
  const slide = post.parentElement && post.parentElement.classList.contains('tc-slide')
    ? post.parentElement : post;
  slideOutCard(slide, () => {
    updateCount();
    const remaining = visibleGroupUnreadIds(gid).length; // match what the rail listed
    const sel = `#feed .topic-card[data-gid="${CSS.escape(gid)}"]`;
    const card = document.querySelector(sel);
    if (remaining === 0) {
      // The topic is empty: its card leaves on the same `slideOutCard` idiom a feed card uses.
      if (card) slideOutCard(card, () => checkEmpty()); else checkEmpty();
      return;
    }
    const count = document.querySelector(`${sel} .tc-count`);
    if (count) count.textContent = countLabel(remaining);
    // Keep the dot row honest: one dot per remaining SLIDE, which is `remaining + 1` because slide
    // one is the summary. Counting POSTS here would be off by one on every Done.
    const dots = [...document.querySelectorAll(`${sel} .tc-dot`)];
    while (dots.length > remaining + 1) dots.pop().remove();
    // The bullets are a render-time filter over state. A single Done does not repaint the
    // card, so without this the list goes stale and stays stale until a reload, a grouping toggle or a
    // background classify happens to rebuild it.
    // `groupGridCounts()` is the SAME source a repaint reads, so this converges on what
    // a full render would paint instead of defining a second answer. T31.
    const ul = document.querySelector(`${sel} .tc-bullets`);
    const emptyNote = document.querySelector(`${sel} .tc-empty`);
    const grp = getGroupState().groups[gid];
    // `reachableByGid`, the SAME set a full render paints from — reading the wide one
    // here would make the repaint a second renderer that disagrees with the first, which is the T31
    // defect one field along. B8 pins it.
    if (ul && grp) paintBullets(ul, grp.summary, groupGridCounts().reachableByGid[gid] || new Set(), emptyNote);
  });
}

// Bulk "Mark N done" for a group: mark every still-unread post read, slide out any matching stream
// card, shrink the grid, and offer Undo.
//
// Under hide-not-remove every assigned post has a HIDDEN stream card, so the stream lookup below
// fires for every id in the tile and is the only thing stopping "Mark N done" leaving an orphan
// that the next toggle un-hides as unread.
function markGroupDone(gid) {
  const ids = visibleGroupUnreadIds(gid); // "Mark N done" marks exactly what the tile claimed
  if (!ids.length) return;
  track('mark_done', { via: 'group', count: ids.length }, 'group');
  ids.forEach(addDone);
  ids.forEach(id => {
    const card = document.querySelector(`#feed .card[data-id="${CSS.escape(id)}"]`);
    if (card) slideOutCard(card, () => {}); // .removing hides it immediately; DOM cleanup at 320ms
  });
  updateCount();
  // Slide the topic card out (matching a feed card's Done/Archive) before repainting, instead of it
  // snapping away instantly. Defer the repaint + caught-up check to the callback. The
  // card is IN `#feed`, so this is a stream selector.
  const card = document.querySelector(`#feed .topic-card[data-gid="${CSS.escape(gid)}"]`);
  const finish = () => { renderTopicCards(); checkEmpty(); }; // caught-up if that emptied the stream
  if (card) slideOutCard(card, finish); else finish();
  showToast(`Marked ${ids.length} done`, 'Undo', () => { removeDone(ids); refreshFeed(); });
}

// Archive ("watch later"): items bookmarked OUT of the feed to revisit. Unlike
// `done` (an id-only read-state), the archive stores each item's METADATA so the Archive tab
// renders cards without re-fetching. Newest-first.
function getArchive()    { return _readProtected(SK.archive, []); }
function saveArchive(v)  {
  if (syncedDamaged()) return refuseWrite();
  localStorage.setItem(SK.archive, JSON.stringify(v));
  schedulePush();
  return true;
}
function getArchiveSet() { return new Set(getArchive().map(it => it.id)); }
function addArchive(item) {
  const list = getArchive();
  if (list.some(it => it.id === item.id)) return; // dedup — already archived
  list.unshift(item);                             // newest-first
  saveArchive(list);
}
function removeArchive(id) {
  saveArchive(getArchive().filter(it => it.id !== id));
}

// "New" badge baseline: the last time the feed was loaded (open or pull-refresh).
// Null until the first load, so a brand-new feed badges nothing.
function getLastFeedLoad() {
  const v = localStorage.getItem(SK.lastFeedLoad);
  return v == null ? null : Number(v);
}
function setLastFeedLoad(ms) { localStorage.setItem(SK.lastFeedLoad, String(ms)); }

// Per-X-channel incremental cache: the tweets we've already fetched (newest first), so we
// only pay to fetch what's genuinely new (since_id). The cache holds up to 14 days; how much of
// it a channel actually renders is then narrowed by its own lookback.
function getTweetCache()  { return _readProtected(SK.tweetCache, {}); }
// The READ degrades to {} so the feed still renders; persisting that {} is what erases every other
// channel's cached posts.
function saveTweetCache(v){
  // Guards its OWN key ONLY, and the narrowing is deliberate. `_readProtected`
  // degrades a corrupt cache to `{}` so the feed still renders, and persisting that `{}` erases
  // every other channel's cached posts — that is what this stops.
  //
  // What it deliberately does NOT stop is a HEALTHY cache write while some SYNCED key is damaged.
  // The rule is "no coerced-empty value is ever PERSISTED", and a write derived from a
  // readable cache is not a coerced empty. Blocking it would make the feed re-fetch every X post on every
  // load for as long as read-only mode lasted, on a pay-per-post source. The cache is device-local and never uploaded, so
  // writing it while another key is damaged cannot mislead the server about anything.
  if (_keyDamaged(SK.tweetCache)) return;
  localStorage.setItem(SK.tweetCache, JSON.stringify(v));
}

// ── Backend sync ─────────────────────────────────────────────────
// User state is persisted to /api/state, keyed by an anonymous device id (or by the
// account once signed in). Writes are debounced write-throughs; the app never depends on the
// network to function — if the server is unreachable it runs entirely from localStorage.
// This mirrors api/_state.js, which app.js (a classic script) can't import.

function getDeviceId() {
  let id = localStorage.getItem(SK.deviceId);
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : _fallbackUuid();
    localStorage.setItem(SK.deviceId, id);
  }
  return id;
}
function _fallbackUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Exactly the keys that sync (mirror SYNCED_KEYS in api/_state.js). Device-local keys —
// lastFeedLoad, tweetCache, lastView, deviceId — are deliberately excluded.
function collectSyncedState() {
  return {
    channels: JSON.parse(localStorage.getItem(SK.channels) || '[]'),
    done:     JSON.parse(localStorage.getItem(SK.done) || '[]'),
    archive:  JSON.parse(localStorage.getItem(SK.archive) || '[]'),
    theme:    localStorage.getItem(SK.theme),
    shorts:   localStorage.getItem(SK.shorts),
    groups:   JSON.parse(localStorage.getItem(SK.groups) || 'null'),
  };
}
// ALL SIX KEYS OR NONE. These are six separate `setItem`
// calls and any of them can throw — quota, a private window, a browser blocking site data — which
// would leave local half-replaced: some keys the server's, the rest still this device's, a state
// neither side ever held. Mid-adopt that means the user's channel gone,
// `dirty` still set, the base not re-based, and NOTHING said. A failed resolution must leave
// NOTHING half-adopted; this is what makes that true rather
// than aspirational.
//
// It RETHROWS after rolling back, so callers keep deciding for themselves — `adoptServerCopy` tells
// the user and keeps the halt; `syncOnLoad` decides for the boot.
//
// The restore itself is per-key try/catch: a `setItem` of a value that was already in the store fits
// by definition, so it should not throw — but if the store is failing wholesale, doing as much as
// possible and still reporting the original failure beats abandoning the rollback halfway.
function applySyncedState(s) {
  if (!s || typeof s !== 'object') return;
  const KEYS = [SK.channels, SK.done, SK.archive, SK.theme, SK.shorts, SK.groups];
  const before = KEYS.map((k) => [k, localStorage.getItem(k)]);
  const themeBefore = document.documentElement.getAttribute('data-theme');
  // Which keys this adopt actually REPLACED. Only these need freeing on the way back out, and that
  // distinction is load-bearing — see the rollback below.
  const wrote = [];
  try {
    if (Array.isArray(s.channels)) { localStorage.setItem(SK.channels, JSON.stringify(s.channels)); wrote.push(SK.channels); }
    if (Array.isArray(s.done))     { localStorage.setItem(SK.done, JSON.stringify(s.done)); wrote.push(SK.done); }
    if (Array.isArray(s.archive))  { localStorage.setItem(SK.archive, JSON.stringify(s.archive)); wrote.push(SK.archive); }
    if (s.theme === 'light' || s.theme === 'dark') {
      localStorage.setItem(SK.theme, s.theme);
      wrote.push(SK.theme);
      document.documentElement.setAttribute('data-theme', s.theme);
    }
    if (s.shorts === 'true' || s.shorts === 'false') { localStorage.setItem(SK.shorts, s.shorts); wrote.push(SK.shorts); }
    if (s.groups && typeof s.groups === 'object') { localStorage.setItem(SK.groups, JSON.stringify(s.groups)); wrote.push(SK.groups); }
  } catch (e) {
    // ALL-OR-NOTHING, and the ORDER is the guard.
    // Restoring in place puts an early key back while a LATER one
    // still holds the server's larger value: an intermediate total the original state never reached.
    // That setItem throws, and local is left holding the SERVER's value
    // for one key and its own for another — a state neither side ever had.
    //
    // Freeing first removes that intermediate: the values going back all coexisted a moment ago, so
    // they fit. Only the keys this adopt actually WROTE are freed, and that is not tidiness. A
    // browser blocking site data makes every setItem throw while removeItem still works, so freeing
    // all six would DELETE a store nothing had touched — `wrote` is empty there, and the
    // rollback correctly becomes a no-op.
    for (const k of wrote) { try { localStorage.removeItem(k); } catch { /* nothing left to free */ } }
    const lost = [];
    for (const [k, v] of before) {
      if (!wrote.includes(k)) continue;   // never replaced, so never freed: still exactly as it was
      if (v === null) continue;           // did not exist before — leaving it removed IS the restore
      try { localStorage.setItem(k, v); } catch { lost.push(k); }
    }
    try {
      if (themeBefore === null) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', themeBefore);
    } catch { /* the paint is cosmetic; the data is what matters */ }
    // A rollback that could not put everything back is a DIFFERENT and strictly worse failure than
    // the one we were about to report. Say so, rather than let the caller's "free up some space and
    // try again" imply nothing was lost.
    if (lost.length) {
      const err = new Error(`rollback incomplete: ${lost.join(', ')}`);
      err.rollbackFailed = true;
      throw err;
    }
    throw e;
  }
}

/** Clear a damaged key the server row cannot replace — the last step of a CONSENTED repair.
 *
 *  Why it is needed at all: `applySyncedState` writes each key only if the row carries one, so a
 *  damaged key whose server copy is absent survives an adopt untouched. Without this the app stays
 *  read-only forever and the one escape the notice offers does not work.
 *
 *  Why it is NOT in `applySyncedState`: that would put a silent `removeItem` of user bytes on
 *  the ORDINARY BOOT PATH — no user action, no notice, nothing said. A `focus_channels` holding
 *  `{"UC_a":{"name":"Alpha"},…}` parses fine and still spells out two readable channel names, and
 *  manual recovery works by reading exactly those bytes in devtools, so surviving bytes are operational
 *  here, not theoretical. Deleting them is defensible only as something the user CHOSE.
 *
 *  Removing does NOT "lose nothing that could have been read":
 *  `_keyDamaged` also fires on the empty string and on values that parse perfectly into the wrong
 *  shape — two of its three classes. But an unreadable key the row cannot replace has to
 *  go, or the app never writes again. */
function clearUnrepairableKeys() {
  for (const k of PROTECTED_KEYS) {
    if (_keyDamaged(k)) { try { localStorage.removeItem(k); } catch { /* nothing more we can do */ } }
  }
}
function _hasUserData(s) {
  return !!(s && ((s.channels && s.channels.length) || (s.done && s.done.length) || (s.archive && s.archive.length)));
}

// Debounced write-through PUT — called after every synced mutation.
// Each mutation marks the local state "dirty" (un-pushed) and bumps a sequence number. The dirty
// flag lives in localStorage so it SURVIVES a reload: if a push never confirmed (e.g. a mobile
// app-kill dropped the keepalive PUT), the next open still sees dirty and keeps local instead of
// letting the stale server row resurrect already-read posts. Only a confirmed PUT with no
// newer mutation queued behind it clears the flag.
let _pushTimer = null;
let _pushSeq = 0;
// Set when a state push is requested; cleared only by a CONFIRMED one. Deliberately a one-way latch
// in the failure direction — a push that never confirms leaves it true for the life of the document,
// so we keep sending state rather than stop. That errs toward writing, which is the safe side here.
// In memory on purpose: it must NOT be SK.dirty, because the adopt push (syncOnLoad's no-row branch)
// deliberately never sets dirty — syncOnLoad reads dirty === '1' as "keep local, do NOT pull the
// server row down", which would be a cross-account leak. So the adopt case needs a flag
// that neither survives a reload nor is ever read by syncOnLoad.
let _stateOutstanding = false;
// A change the server REFUSED with a 412 — owed within THIS page, and never across a reload by
// itself. Keeping `focus_dirty` set on a refusal would be wrong: that flag
// survives the reload, and when the next boot is not this account's healthy one — another account signing in
// through a link, a stale second tab, a row that appeared meanwhile — syncOnLoad's dirty branch pushes the
// previous copy instead of loading the row and stops behind "Not syncing". So a refusal clears `dirty` and
// sets this instead: the change still rides the next save, and flushPush re-sends it when the page goes away.
//
// Narrower than `_stateOutstanding`, deliberately: re-sending every owed push on close was measured to
// re-raise "Not syncing" on each tab switch for a halted page and to send a no-op save for a discarded one.
// Settled by an accepted save, a discard, a 409, or Use saved copy. In memory, so an app killed outright
// (no pagehide) loses the change.
//
// THAT LOSS IS NARROW. Only a 412 arms this, and since the server tells a failed
// lookup from a missing session, a 412 means the session is really gone. A database blip is answered 503,
// which arms nothing and leaves `dirty` set — so the change survives a kill, a failed unload save and an
// over-cap store exactly as an offline save does. What is left here is the genuine-expiry case.
let _refusalOwed = false;
// STANDING, not intent. `eventsOnly` says what a push CARRIES; this says whether the
// sender had any business claiming it. False until syncOnLoad gets an answer from the server — a boot
// whose GET 500'd or hit the 2.5s abort holds a copy of nothing and does not know it, so the empty
// blob it would send is byte-identical to a deliberate "I removed every channel" clear. A
// caller-declares-intent flag can never close that: a theme tap genuinely IS claiming state.
// A DEVICE answer to a SIGNED-IN boot — one the sign-in answer contradicts — counts as no answer at
// all, so it grants nothing either, and on such a boot this stays false for the whole document. The
// other contradiction, a walled browser answered by its account, does grant it: that browser may still
// upload its own copy to that account (see syncOnLoad).
//
// In memory, deliberately, and for a different reason than _stateOutstanding above: this must NOT
// survive a reload, or one lucky boot vouches for every later one. It must also not be SK.dirty —
// syncOnLoad READS that flag to decide whether to pull, so overloading it would change that decision.
// Write-once per document; never consulted by syncOnLoad's own branch decision.
let _stateLoaded = false;
// The boot's pull-down of the row was attempted and ROLLED BACK. Read by nothing but the tour's
// start decision: `_stateLoaded` stays exactly as it was for every sync decision that already rests on it.
let _bootApplyFailed = false;
// Set when the server has REFUSED a write (409): the row moved under us, so every further state
// push would be refused for the same reason. In memory ONLY and deliberately — a leaked halt
// disables sync invisibly, which is worse than the bug it guards, so a reload must always clear it.
// It is lifted by exactly one thing: the user pressing the notice's action.
let _syncHalted = false;
// What the PUSH PATHS ask before deciding whether to carry state. (Not the only place the question
// is asked — syncOnLoad and signOut's refusal branch ask their own versions, on _hasUserData and on
// dirty directly; don't consolidate them without re-reading why each one differs.) SK.dirty appears
// here ONLY in the widening direction: dirty === '1' can ADD a state push, never suppress one.
// Inverting it — `dirty !== '1'` → send no state — is a trap, because the
// adopt push runs with dirty clear and would be silently dropped. `_pushTimer` is deliberately not
// consulted: schedulePush() sets dirty on the same line it arms the timer, so it would read as a
// second independent fact while adding no coverage, and the timer nulls itself before pushing.
function _statePending() {
  return _stateOutstanding || localStorage.getItem(SK.dirty) === '1';
}
// Every call site here is a real user mutation that IS claiming state, which is why `eventsOnly`
// alone is not enough: a theme push genuinely means it. What matters is a different
// question — not "what is this push for" but "has this browser any standing to answer" — and
// `_stateLoaded` is it (see pushNow). What follows here is the second half of that guard.
function schedulePush() {
  // `dirty` asserts "local is AHEAD of the server row" — which a browser that never read the row
  // cannot know. Marking it anyway is what carried the damage into the NEXT boot: dirty survives the
  // reload, so a later healthy boot takes syncOnLoad's dirty branch, pushes this same unloaded blob
  // and never applies the row. Suppressing the push without this is strictly WORSE than doing
  // neither, because a suppressed push can never confirm and so can never CLEAR dirty — today a
  // succeeding PUT at least clears it. Measured both ways in the harness; pinned by B2's two rows.
  // The timer is still armed: that push carries analytics, which must go out regardless.
  if (_stateLoaded) localStorage.setItem(SK.dirty, '1');
  _pushSeq++;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => { _pushTimer = null; pushNow(); }, 1500);
}
function flushPush() {
  // Flush a pending state push OR buffered analytics events (a page-hide may be the last chance
  // to send events even when no state changed).
  if (_pushTimer || _evtTimer || _readEvents().length || _refusalOwed) {
    // Only the PAYLOAD narrows here — the trigger condition above is deliberately unchanged, since
    // swapping it for _statePending() would make the flush fire in a case where it does not today,
    // i.e. widen a write path while we are closing one.
    // ONE exception, measured rather than assumed: `_refusalOwed`. A change the
    // server refused is no longer carried across a reload by `dirty`, so this is its last chance to leave.
    // Scoped to a refusal alone — the broad `_statePending()` version re-raised "Not syncing" on every tab
    // switch for a halted page and sent a no-op save for a discarded one (c15b–c15e pin that neither widens).
    const statePending = _statePending();
    clearTimeout(_pushTimer); _pushTimer = null;
    clearTimeout(_evtTimer);  _evtTimer = null;
    // the page is going away — this is the one place it is worth the 64KiB cap
    //
    // ...but it claims NO STATE while another write is already travelling WITH A BASE.
    // This push bypasses the in-flight latch on purpose, and the base is read per invocation, so a
    // flush firing over a live PUT declares the SAME base and the server refuses one of the two.
    // Losing the flush is harmless (its halt dies with the document); losing the INTERACTIVE one is
    // not — visibilitychange fires on an ordinary tab switch, so the document often survives, and it
    // is left halted behind a notice whose action replaces local data.
    //
    // `SK.rev` is the whole condition, and it is not belt-and-braces. A push with NO base cannot
    // collide: there is nothing for the server to find stale, and `on conflict do nothing` covers
    // the create. That is exactly the first-sign-in adopt push — fire-and-forget out of syncOnLoad's
    // no-row branch, which deliberately never sets `dirty`. Suppressing the flush there would drop
    // the adoption outright, and NOT self-heal, because the "the next boot re-pushes" argument below
    // runs on `dirty` and the adopt never set it. C3b in test/push-intent.test.mjs is that control,
    // and it red when this condition was `_pushInFlight` alone.
    //
    // Degrading rather than skipping: the flush's other job is draining analytics, and that must
    // still happen. Where a base DOES exist, `dirty` was set by schedulePush, so the state is not
    // lost — the next boot re-pushes it. Today's alternative is a 409 that writes nothing and halts
    // the client, reaching the same row a boot later by a worse road.
    pushNow({ keepalive: true, eventsOnly: !statePending || (!!_pushInFlight && !!localStorage.getItem(SK.rev)) });
  }
}
// Set once an exit is under way. pushNow() refuses after this, because a push landing during or
// after a delete resolves to the DEVICE namespace (the session has cascaded away) and re-inserts
// the state we are destroying — which the device-id rotation then orphans permanently. Cancelling
// the timers is not enough on its own: `pagehide` and `visibilitychange` call flushPush() directly,
// so backgrounding the tab mid-delete hits the same path.
// There is a second, server-side layer: a state push from a signed-in page carries
// `X-Require-Account`, so a current server refuses it with 412 instead of writing it. The seal is kept,
// and the comments at cancelPendingPushes, _signOut and deleteAccount still describe the mechanism
// without that layer: the seal is client-side, so it holds whatever deployment answers, and it stops the
// request being sent at all.
let _leaving = false;
let _sealToken = 0;            // issues ids
const _heldSeals = new Set();  // outstanding seals; pushes stay blocked while ANY is held

// `keepalive` lets a request outlive the page, which is essential on pagehide — but the Fetch spec
// caps keepalive request BODIES at 64 KiB and answers a *network error* over that, which lands in
// the bare catch below and is indistinguishable from being offline. A heavy archive crosses that
// (one archived item is ~1KB and `done` is never pruned), so with it always on, sync died silently
// and permanently for exactly the users with the most to lose. It is opt-in, set only by the
// unload flush; every interactive push is uncapped. (The unload path keeps the cap.)
//
// `eventsOnly` is the caller declaring what this push is FOR, and it is load-bearing.
// A push built from collectSyncedState() on a browser that never loaded its row — a boot GET that
// 500'd or hit the 2.5s abort — sends an empty state, and the server cannot tell that apart from a
// deliberate "I removed every channel" clear, so it dutifully empties the account's row. The two are
// byte-identical on the wire; only the caller knows which one it means. An events-only push omits
// the `state` KEY entirely (absent, never null — see api/state.js) and claims nothing.
// One state push in flight at a time.
//
// The base is read per invocation, so without this two overlapping pushes declare the SAME base: the
// server accepts the first, the row moves, and the second is refused. A single user on a single
// device then gets a halt and an affordance offering to discard their own newest state. It is
// reachable three ways — flushPush (whose trigger is truthy WHILE a push carrying those events is in
// flight), _signOut, and the independent 1.5s/3s timers — which is why it is fixed here, once, rather
// than at each call site.
//
// Deliberately a wrapper rather than a restructure of the body below: that function's ordering
// is heavily hardened, and reordering it to thread a latch through
// would put the latch's cost exactly where a mistake is most expensive.
//
// WHAT THIS DOES NOT CLOSE: the latch is per-DOCUMENT. Two TABS still self-conflict, and nothing here
// changes that — a shared latch would need a lock the browser does not give us. What it closes is
// the single-document race, which is the one that was reachable three ways from one page.
//
// Two things bypass the queue, both on purpose:
//   - events-only pushes claim no state, so they have no base to be stale. Queueing them would delay
//     the flush that exists to drain them and buy nothing.
//   - keepalive pushes are the unload flush: the page is going away and waiting means never sending.
//     If that one races and is refused, the halt is in memory and dies with the document, `dirty`
//     stays set, and the next boot reconciles — and that reconciliation is silent when
//     the write actually landed, which is the common case.
let _pushInFlight = null;
// `requireAccount` is ON by default, and that direction is the point: a push from a signed-in
// page declares that it needs the account, so a failed session lookup is refused by the server instead of
// written into the anonymous device row. The ONE caller that opts out is `_signOut`'s save — see there.
// A default of off would leave every future caller downgrading silently.
async function pushNow({ keepalive = false, eventsOnly = false, requireAccount = true } = {}) {
  // `!_stateLoaded` is INTENT, not a guard, and that is measured rather than assumed:
  // deleting the term survives the whole suite. It cannot currently bite, and the reasoning is
  // worth writing down because it is not obvious. `_pushNow` downgrades every push to events-only
  // while `_stateLoaded` is false, events-only pushes never take the latch, and
  // `_stateLoaded` is write-once false->true — so `_pushInFlight` is provably null for as long as the
  // term can be true, and the queue it skips would never have made it wait. A signed-in boot answered by the device
  // never grants standing, which only lengthens how long the term can stay true
  // without making `_stateLoaded` resettable. Kept because it says what
  // this line means, and because it stops being dead the moment `_stateLoaded` becomes resettable.
  if (eventsOnly || keepalive || !_stateLoaded) return _pushNow({ keepalive, eventsOnly, requireAccount });
  // `while`, not `if`: another caller can take the slot between our wait resolving and our claim.
  while (_pushInFlight) { try { await _pushInFlight; } catch { /* the other caller owns its outcome */ } }
  let release;
  _pushInFlight = new Promise((r) => { release = r; });
  try {
    // Every gate inside — _leaving, _syncHalted, the base itself — is read AFTER the wait, which is
    // the entire point: the world may have changed while we queued.
    return await _pushNow({ keepalive, eventsOnly, requireAccount });
  } finally {
    _pushInFlight = null;
    release();
  }
}

async function _pushNow({ keepalive = false, eventsOnly = false, requireAccount = true } = {}) {
  if (_leaving) return { ok: false, confirmed: false };
  // Suppression lives HERE, in one place, rather than at each call site — so the debounce
  // timer, the unload flush, sign-out and any future caller inherit it without having to know. That
  // is what makes `eventsOnly`'s dangerous `false` default safe: a bare pushNow()
  // added later still cannot claim state it never loaded.
  // NOT a refusal — this becomes an ordinary events-only push, so analytics still ride and still
  // drain. Refusing instead would blind the metric on exactly the boots that matter.
  if (!_stateLoaded) eventsOnly = true;
  // DOWNGRADE, not refuse. A store with an unreadable synced key cannot
  // build a body that is true: collectSyncedState would coerce the damaged key to empty, and the
  // server cannot tell that from a deliberate "I removed everything". Refusing outright was
  // measured as strictly worse — it took a corrupt-store session from 3 analytics events
  // to none, blinding the metric on exactly the sessions worth measuring. Same shape and same
  // reasoning as the `_stateLoaded` line above, deliberately.
  //
  // ── A RECORDED TRADE, not an oversight ──────────────────────────────────
  // This is ALL FOUR synced keys, so damage in one strands the three that are readable: a user
  // with 50 new read marks and a truncated `focus_channels` uploads nothing. That is a real
  // cost, deliberately accepted rather than missed.
  //
  // The alternative is a per-key upload, and it is not available: `/api/state` replaces the whole
  // state blob, so omitting a key does not preserve the row's copy of it — partial upload needs a
  // server change, and we sit at 12/12 serverless functions.
  //
  // What makes the trade acceptable is that uploading is not the good outcome it looks
  // like: it would upload the 50 marks AND overwrite the account's channels with a coerced empty.
  // Refusing preserves everything locally and costs only the upload — and the
  // window is one tap wide, because `repairDamagedStore` heals the damaged key and the very next
  // push carries the readable work up with its base intact.
  if (syncedDamaged()) eventsOnly = true;
  // Halted. The notice is re-shown BEFORE the early return, not after — sync-paused is a STATE, not
  // an event, and the toast auto-hides at 5s. Returning first would show the notice once
  // and let every later push no-op in silence. Events-only
  // pushes are deliberately NOT halted: they claim no state, so they have no base to be stale, and
  // stopping them would blind the metric on exactly the sessions worth measuring.
  if (_syncHalted && !eventsOnly) {
    _showSyncConflict();
    return { ok: false, confirmed: false, refused: true };
  }
  if (!eventsOnly) _stateOutstanding = true;
  const seq = _pushSeq; // snapshot: only clear dirty if nothing new was queued while we were in flight
  // Capped at what the server actually keeps — see MAX_EVENTS_PER_SAVE. Anything held
  // back stays buffered and is re-armed by _dropSentEvents once this save is delivered.
  const events = _readEvents().slice(0, MAX_EVENTS_PER_SAVE);   // the pending analytics buffer (may be empty)
  // `uid` stays in the body for the accept-both release: the header above is what the
  // server now reads, but a rollback to the previous deployment would leave a client that sends
  // only the header unable to sync. Costs nothing to keep.
  try {
    // BUILT INSIDE THE TRY. Outside it, anything throwing here REJECTED the promise
    // instead of returning the {ok:false} every caller is written against — and two callers hold no
    // handler: schedulePush's debounce timer (`_pushTimer = setTimeout(…)`) and flushPush from
    // pagehide/visibilitychange (its `pushNow({ keepalive: true, … })`).
    // Sync would then die silently while `focus_dirty` still
    // asserts un-pushed work, so the next boot takes syncOnLoad's dirty branch and does it again.
    //
    // collectSyncedState JSON.parses four raw localStorage values and is the thrower that matters
    // today; getDeviceId can also throw,
    // since it setItem()s a fresh id when none is stored and a private window or a browser blocking
    // site data refuses that write. Guarding the STRUCTURE covers both, and whatever is added here
    // next, rather than one audited line.
    const body = JSON.stringify({
      uid: getDeviceId(),
      ...(eventsOnly ? {} : { state: collectSyncedState() }),
      events,
    });
    // The base this document is entitled to declare. Omitted on an events-only push, which claims no
    // state and therefore has no base to be stale — otherwise a halted client would stop reporting
    // analytics too, blinding the metric on exactly the sessions worth measuring.
    const base = localStorage.getItem(SK.rev);
    // DELIBERATELY UNBOUNDED, and the reasoning is worth keeping because it is easy to get wrong.
    //
    // A hung PUT parks sign-out, which waits on it through the in-flight latch.
    // Two remedies were built and each was measured to be WORSE than the parking:
    //   - An AbortController here stops the client READING the response, not the server WRITING. A
    //     write committed after the abort moves the row while SK.rev stays behind: every later push
    //     is refused, a reload cannot recover it, and the only escape destroys the work.
    //   - Bounding the WAIT in _signOut instead cancels nothing, but it lets _signOut return with
    //     this PUT still travelling — and if the user then deletes their account, the write lands
    //     afterwards and re-creates the deleted state in a device row the id rotation orphans.
    //     Reproduced against the real handler.
    // Neither is used. The parking is real, and it is the lesser cost.
    const r = await fetch('/api/state', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': getDeviceId(),
        ...(!eventsOnly && base ? { 'X-State-Rev': base } : {}),
        // A state push from a page that believes it is signed in must reach the ACCOUNT or
        // nothing: without this, a session lookup that failed (api/_session.js answered null for a database
        // error exactly as for an expired session) would write this page's state into the anonymous device row
        // with a 200, the page would re-base onto that row, and its next healthy save would be refused behind "Not
        // syncing" — across reloads. The server refuses instead, and it answers
        // TWO statuses rather than one: 503 when it could not check the session, and 412 when there is
        // none. A 503 is an ordinary failure here — `dirty`, the base and the events are all kept, exactly
        // as when offline. A 412 keeps the base and the events, says nothing, and owes the change within
        // this page (`_refusalOwed`) — it rides the next save, or leaves with the unload flush — rather
        // than carrying it across a reload by `dirty`.
        // Read AFTER the downgrades above, so an analytics-only push never carries it; keyed on
        // `_authEmail`, so a signed-out page's claim still reaches its device row as before.
        ...(!eventsOnly && requireAccount && _authEmail ? { 'X-Require-Account': '1' } : {}),
      },
      body,
      keepalive,
    });
    // Read the answer once. A PUT now reports one of THREE outcomes and the client acts differently
    // on each, so `r.ok` alone is no longer enough to know what happened.
    let answer = null;
    try { answer = await r.json(); } catch { /* no body (keepalive, opaque) → no extra detail */ }
    // DISCARDED: 200, but the server matched no row and stored nothing. Only an EXPLICIT
    // null says so — a missing key means an answer that carries no detail (an older deployment, or a
    // body that did not parse), and reading that as "discarded" would stop the client trusting writes
    // that really did land.
    // REFUSED (409): the row moved under this client, so it wrote nothing. Determinate — unlike a
    // network failure, a retry cannot help — and that distinction is what lets sign-out act on it.
    // The events still rode along and were ingested server-side (api/state.js runs ingestEvents on
    // both paths), so they are dropped here as on any other delivered PUT. Returning before
    // this line would re-send the whole batch on every later flush, double-counting it.
    if (r.status === 409) {
      if (events.length) _dropSentEvents(events);
      // The halt owns this change now. A push that STARTS while halted is refused
      // above, before any request — but that is not the same as "a halted page can never be owed again".
      // A keepalive skips the
      // in-flight queue, so an unload flush that passed the halt gate before this 409 landed can have its
      // 412 processed afterwards and re-arm the flag. Use saved copy clears it; c23-A26 stages the race.
      _refusalOwed = false;
      _syncHalted = true;
      _showSyncConflict();
      return { ok: false, confirmed: false, refused: true };
    }
    const discarded = !eventsOnly && r.ok && !!answer && answer.updatedAt === null;
    // ACCEPTED: the server wrote this state. Note this does NOT require `_pushSeq === seq` — a
    // mutation landing mid-flight makes local newer, but the ROW is still the version the server just
    // wrote, and the base describes the row rather than local.
    const accepted = r.ok && !eventsOnly && !discarded;
    if (accepted && answer && answer.rev) localStorage.setItem(SK.rev, answer.rev);
    // Accepted, not confirmed: this push carried the whole state, so a change a refusal left owed
    // has landed with it even if a newer mutation arrived mid-flight — that one arms its own save.
    if (accepted) _refusalOwed = false;
    // Confirmed write and no mutation arrived mid-flight → local now matches the server.
    // TWO different facts, and conflating them caused a leak. `ok` = the server accepted this state.
    // `confirmed` = it accepted it AND nothing newer was queued while we were in flight. A mutation
    // landing mid-push (saveGroupState from the async /api/group resolve is the common one) makes
    // `confirmed` false against a perfectly healthy server — so a caller that reads that as "the
    // save failed" acts on a false alarm. Only `ok` speaks to whether the write landed.
    // `!eventsOnly` is not tidy-up: an events-only push did not send the state, so clearing dirty
    // here would tell the next boot the server is up to date and let syncOnLoad pull a stale row
    // down over un-pushed local changes.
    const confirmed = accepted && _pushSeq === seq;
    if (confirmed) { _stateOutstanding = false; localStorage.removeItem(SK.dirty); }
    // A DISCARDED write clears `dirty` too, and that is the counter-intuitive part.
    // `dirty` asserts "local is AHEAD of the server row". There is no row, so the claim is not merely
    // useless — it is false, and acting on it destroys data: a later boot takes syncOnLoad's dirty
    // branch, pushes this empty blob over a row another device has since created, and returns WITHOUT
    // applying it. Measured against the real handler: a row holding 1 channel + 2 done was
    // emptied at 200 OK, silently. `_stateOutstanding` is deliberately left TRUE — it is in memory,
    // syncOnLoad never reads it, so the preference re-sends within this document and lands the moment
    // there is real data to hang it on, with no cross-boot claim.
    else if (discarded) { localStorage.removeItem(SK.dirty); _refusalOwed = false; }
    // REFUSED: the server CHECKED and there is no session, so it wrote nothing and a
    // retry cannot help. `dirty` is CLEARED, the change is owed in this page instead — see
    // `_refusalOwed`. The base and the events are kept (the generic failure path below), and nothing is
    // said. Strictly 412, not "the server could not tie this save to the account", which covers both
    // answers: a lookup that FAILED is a 503 and must not reach this branch — it keeps `dirty` and owes
    // nothing, exactly as being offline does.
    if (!eventsOnly && r.status === 412) { localStorage.removeItem(SK.dirty); _refusalOwed = true; }
    // Drop exactly the events we sent (events only ever append to the end, so removing the first
    // N leaves any that arrived mid-flight). On failure they stay buffered for the next flush.
    // Gated on `ok`, NOT `confirmed` — do not "simplify" it now that confirmed excludes events-only
    // pushes, or the buffer would never drain on exactly the pushes that exist to drain it, and
    // every metric would re-ship on every flush forever.
    if (r.ok && events.length) _dropSentEvents(events);
    // Both facts are returned so signOut can act on the right one. It gates on `confirmed` — `ok`
    // alone only says *some* state reached the server, which after a mid-flight mutation is the OLD
    // state. Gating on `confirmed` is safe only because signOut retries up to 3x first; without the
    // retry it misreads a healthy server as a failure. Don't "simplify" this to `ok`.
    return { ok: r.ok, confirmed };
  } catch { /* offline → dirty stays set; events stay buffered; a later mutation/open retries */ }
  return { ok: false, confirmed: false };
}

// ── The damaged-store notice ──────────────────────────────────────
// A COMPREHENSION control, not a safety one, and the distinction decides the copy. Under read-only
// the predicate already prevents every destructive action, so what is left is explaining an app that looks empty and silently
// refuses to accept a new channel. Without it that reads as "the app is broken" rather than "this
// device's copy is damaged" — arguably worse than the white screen it replaces, because a white
// screen at least does not invite a diagnosis.
//
// Whether a server row EXISTS decides what the notice may promise. `null` means this document has not
// been told — a boot whose GET failed or timed out knows nothing, and must not claim either way.
let _serverRowSeen = null;

// THREE COPIES, one per state of `_serverRowSeen`, because only one can be true at a time and the
// wrong one is a lie about the user's data. All three say CHANGES ARE PAUSED, so the user
// learns why their taps do nothing (see `blockedByDamage`).
//
// `row` does NOT say the account "has a copy" of the unreadable data, because it may not:
// `applySyncedState` writes each key only if the ROW carries one, so restoring can CLEAR the
// damaged key rather than replace it. It says what the action actually does, and it discloses that
// the action REPLACES — which is the same disclosure `_showSyncConflict` already makes for this
// same call ("They stay here unless you use the saved copy, which replaces them"). That matters:
// with `dirty` set, readable un-pushed work in the OTHER keys is replaced too.
//
// `unknown` is the third state. Without it a boot whose GET failed would show the
// no-row copy and assert there is no saved copy — a claim it never established, and one whose
// obvious next move (clear site data) destroys the local bytes.
const _DAMAGED_COPY = {
  row:     "Some of this device's saved data couldn't be read, so changes are paused here. Restoring replaces everything on this device with the copy saved to your account.",
  unknown: "Some of this device's saved data couldn't be read, so changes are paused here. We couldn't reach your account to check for a saved copy.",
  none:    "Some of this device's saved data couldn't be read, so changes are paused here. There's no saved copy to restore from.",
};

// Every render recomputes from the store rather than remembering a decision, which is what makes
// it a STATE: it survives a re-render, and it disappears on its own the moment the key is readable
// again. Both directions are asserted, because a notice that is always on is indistinguishable
// from one that is always off.
//
// A damaged `tweet_cache` is deliberately not part of this predicate at all: it is device-local and
// is not in the account, so raising an account-restore notice for it would over-promise — and it
// therefore does not make the app read-only either, or the user would face a silent refusal with
// no explanation. It blocks only `saveTweetCache`.
function renderDamagedNotice() {
  // Nothing is wired for a signed-out visitor (`wireApp` is behind the session gate), and the view
  // that would carry this is not shown — but revealing it anyway would leave the guard resting
  // entirely on an ancestor's class, and reachability must not be part of
  // the trust chain.
  if (!_authEmail) return;
  const damaged = syncedDamaged();
  // Offered whenever the row is not known to be ABSENT: with a row it heals, and in the unknown
  // state trying is how you find out — `adoptServerCopy` re-reads, and says so if there is nothing
  // there. Hidden only when we know there is no copy, because an escape that cannot work is worse
  // than none.
  const canHeal = damaged && _serverRowSeen !== false;
  const copy = _serverRowSeen === true ? _DAMAGED_COPY.row
             : _serverRowSeen === null ? _DAMAGED_COPY.unknown
             : _DAMAGED_COPY.none;
  for (const view of ['setup', 'feed', 'archive']) {
    const box = document.getElementById(`damaged-notice-${view}`);
    if (!box) continue;
    box.classList.toggle('hidden', !damaged);
    const text = document.getElementById(`damaged-notice-${view}-text`);
    if (text) text.textContent = copy;
    // Hidden rather than disabled when there is no row: an action that cannot work is worse than
    // no action — the one escape the app offers
    // appearing broken at the moment the user reaches for it.
    const action = document.getElementById(`damaged-heal-${view}`);
    if (action) action.classList.toggle('hidden', !canHeal);
  }
}

// The notice. Its wording must be true in THREE situations the client cannot tell apart and must
// not guess between: another person signed in on this browser; another of your own devices wrote; or
// your session ended. It therefore states the fact common to all three and discloses nothing about
// anyone else. (A signed-in page's ordinary save is refused rather than resolved to the
// device namespace, so the third cause is rare; it is kept because it can still arise — sign-out's
// exempt save is one route.)
//
// IT MUST ALSO BE HONEST IN BOTH DIRECTIONS, and that is a design condition rather than
// a copy preference. There is deliberately NO second button: a "keep mine" button
// asks the user a question the app cannot answer and they cannot either — and DOING NOTHING is
// already the non-destructive option, since local data survives and only syncing stops. That
// argument only holds if the notice says so.
//
// Which is why it wraps. `.toast-msg` is `white-space: nowrap; text-overflow: ellipsis`,
// so the default pill is one truncated line and physically cannot carry this. The
// `wrap` option exists for this notice; every other toast is unchanged.
function _showSyncConflict() {
  showToast(
    "Not syncing — this device has changes the saved copy doesn't. They stay here unless you use the saved copy, which replaces them.",
    'Use saved copy', adoptServerCopy, 5000, { wrap: true },
  );
}

// The ONE action that resolves a halt, and the only path in the app that replaces local state with
// the server's on purpose. A person has to choose it.
//
// Deliberately NOT a reload: SK.rev and dirty both survive one, so a reload re-runs the same branch,
// re-sends the same stale base, and re-shows the same notice — forever. The affordance has to
// resolve the conflict, not restart it.
/** Read THIS browser's own row, with every guard the affordance below needs.
 *  Shared so the targeted repair reuses them rather than growing a
 *  second, younger copy — the hardening here is the part that is expensive to get right, and two
 *  of these guards exist because data is destroyed without them.
 *
 *  Returns the row, or null having already told the user. A null also covers "an exit is in
 *  flight", where the right answer is to say nothing and stop. */
async function _readOwnRow() {
  // Sealed and timed like every other user-state writer. Unsealed and untimed,
  // a stalled GET could resolve after sign-out had
  // wiped and rotated, writing the departing account's channels back into the anonymous browser.
  if (_leaving || _heldSeals.size) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  let server = null;
  try {
    const r = await fetch('/api/state', { signal: ctrl.signal, headers: { 'X-Device-Id': getDeviceId() } });
    clearTimeout(t);
    if (!r.ok) throw new Error('read failed');
    server = await r.json();
  } catch {
    clearTimeout(t);
    // A failed resolution must leave NOTHING half-adopted: the halt stays, local is untouched, and
    // the notice comes back on the next attempt.
    showToast("Couldn't load the saved copy — try again");
    return null;
  }
  // Re-checked after the await, not only before it. The exit could have begun while the GET was in
  // flight, which is the whole window the seal exists to cover.
  if (_leaving || _heldSeals.size) return null;

  // WHICH NAMESPACE ANSWERED. `api/_session.js` returns null
  // on a DB blip as well as on expiry, so this GET can silently resolve to the DEVICE namespace
  // while the user is signed in. Without this check the user presses this button, receives a stale
  // anonymous snapshot and loses their un-pushed change.
  // (Their next push is refused by the server rather than written to the device row, but the stale
  // snapshot has already replaced the un-pushed change by then, so this check still stands.)
  // The reverse leak is real too: `_authEmail` can be stale-null while the cookie is still good, and
  // adopting there pours an account's channels into a browser nobody signed in on.
  // The boot (syncOnLoad) checks too —
  // refusing everything for a signed-in user, and only the pull for a walled browser, whose own copy
  // may still be uploaded. Unlike the boot, this reader has no upload of its own for a refusal to defer
  // — its caller re-arms a push only AFTER an answer from the right namespace — so it refuses both
  // directions outright.
  //
  // A response that does not SAY is refused rather than guessed at. An absent `kind` is not evidence
  // of the right namespace, and the client cannot tell unaided. Refusing
  // costs a visible "try again"; guessing costs the user's data.
  //
  // ⚠️ THE BOOT DOES NOT MATCH THIS, DELIBERATELY. syncOnLoad acts on an unlabelled answer and refuses
  // only a wrong label. The real server labels every answer — pinned in
  // test/sync-conflict.test.mjs — so an unlabelled one only ever comes from a test fixture
  // (and a walled browser's unlabelled answer still uploads). Do not
  // "harmonise" either reader without weighing that;
  // each side is pinned — "B4 a response that does not SAY which namespace answered is refused" in
  // test/sync-conflict-client.test.mjs for this one, c9 in test/boot-namespace.test.mjs for the boot.
  const expectedKind = _authEmail ? 'account' : 'device';
  if (!server || server.kind !== expectedKind) {
    showToast("Couldn't load the saved copy — try again");
    return null;
  }
  return server;
}

/** What a row offers for one protected key, or `undefined` if it offers nothing usable.
 *
 *  MIRRORS `applySyncedState`'s per-key acceptance, and the duplication is deliberate rather than
 *  lazy: that function's ordering and all-or-nothing rollback are heavily hardened, and
 *  restructuring it to share this would put the cost exactly where a mistake is most
 *  expensive. Two copies of a rule drift, so they are pinned together by r14 — if one starts accepting
 *  a shape the other refuses, that test reds. `tweet_cache` is never in a row, by construction. */
function rowValueFor(state, key) {
  if (!state || typeof state !== 'object') return undefined;
  if (key === SK.channels) return Array.isArray(state.channels) ? state.channels : undefined;
  if (key === SK.done)     return Array.isArray(state.done)     ? state.done     : undefined;
  if (key === SK.archive)  return Array.isArray(state.archive)  ? state.archive  : undefined;
  if (key === SK.groups)   return (state.groups && typeof state.groups === 'object') ? state.groups : undefined;
  return undefined;
}

/** The notice's action: repair ONLY what cannot be read, and touch nothing else.
 *
 *  This is deliberately NOT `adoptServerCopy`. That replaces every key the row carries, and
 *  that is costly here: with `dirty` set — which IS the affected
 *  population, because a clean boot auto-heals through `syncOnLoad` — one tap would take 50 un-pushed
 *  read marks to 0. The user would press the only escape the app offers and
 *  lose work that was never damaged.
 *
 *  So: for each damaged key, take the row's value if it has a usable one, otherwise clear it. A
 *  readable key is never touched, whatever the row says about it.
 *
 *  `dirty` is NOT cleared and the base is NOT moved, and that is the difference from an adopt.
 *  Nothing was adopted — local is still ahead of the row in every key that was readable — so
 *  clearing `dirty` would tell the next boot the server is up to date and let it pull a stale row
 *  down over exactly the work this function exists to protect. The base follows the DATA.
 *
 *  PER-KEY rather than all-or-nothing, unlike `applySyncedState`, and the reason it is safe here is
 *  that every key it touches is CURRENTLY UNREADABLE. There is no meaningful local value to leave
 *  half-replaced: repairing two of three leaves the third unreadable, the app read-only and the
 *  notice up, which is exactly the state we started in for that key. */
async function repairDamagedStore() {
  const server = await _readOwnRow();
  if (!server) return;
  // A row that has vanished offers nothing, so every damaged key is cleared — that is still the
  // only repair available, and it is what makes the app writable again.
  const state = server.updatedAt == null ? null : server.state;
  let replaced = 0, cleared = 0, stuck = 0;
  for (const k of PROTECTED_KEYS) {
    if (!_keyDamaged(k)) continue;
    const v = rowValueFor(state, k);
    try {
      if (v === undefined) { localStorage.removeItem(k); cleared++; }
      else { localStorage.setItem(k, JSON.stringify(v)); replaced++; }
    } catch { stuck++; }   // out of room — leave it damaged; the notice stays up and says so
  }
  try {
    renderChannelList();
    // `toggleGoButton` belongs beside every `renderChannelList`.
    // A damaged `focus_channels` reads as zero channels, so the boot
    // correctly hides "Open my feed →" — and without this the repair restores the channels, lists
    // them, and leaves the user on setup with no way to reach the feed.
    toggleGoButton();
    renderDamagedNotice();
    if (!document.getElementById('view-feed')?.classList.contains('hidden')) loadFeed();
  } catch { /* a repaint failure must not undo a repair that already succeeded */ }
  if (stuck) showToast("Couldn't save the copy on this device — free up some space and try again");
  else if (replaced) showToast('Restored what this device could not read');
  else if (cleared) showToast('Cleared the data that could not be read');
}

async function adoptServerCopy() {
  const server = await _readOwnRow();
  if (!server) return;

  if (server.updatedAt == null) {
    // The row has vanished — there is no saved copy to use, in the namespace this browser is
    // entitled to. Do NOT drop the base and do NOT touch local data: a base deleted while local data
    // is kept IS the unconditional-overwrite state, which is the bug rather than a fix for it. Lift
    // the halt and let the next push CREATE the row (create is always allowed; only overwrite is not).
    //
    // In the session-lapse case this branch would be actively dangerous: the
    // rearmed push would put the signed-in ACCOUNT's channels into the anonymous device row. The
    // namespace check in `_readOwnRow` runs first and catches that, so what is left is the
    // honest case — the row is genuinely gone from the right namespace.
    //
    // And it says so. As a silent no-op, the user
    // presses the one escape the app offers and NOTHING happens, then rearmPush() 1.5s later
    // re-raises the same notice. The only way out would appear broken at exactly the moment they
    // reach for it.
    _syncHalted = false;
    showToast('No saved copy to use — keeping what is on this device, and saving it now');
    rearmPush();
    return;
  }

  // Guarded, and the ORDER below it is the point: nothing that records "local now matches the row"
  // may run unless the row actually landed. applySyncedState is all-or-nothing and rethrows, so a
  // failure here leaves local exactly as it was and the halt exactly as it was — the user can press
  // again once there is room. Reporting it is not optional: a destruction nobody is told about and a
  // button that quietly does nothing look identical from the outside.
  try {
    applySyncedState(server.state);
    // ...then clear whatever the row could not replace. Only here, on the
    // path a person deliberately chose, never on an ordinary boot.
    clearUnrepairableKeys();
    if (server.rev) localStorage.setItem(SK.rev, server.rev);
  } catch {
    showToast("Couldn't save the copy on this device — free up some space and try again");
    return;
  }
  // Local is now a copy of the row rather than ahead of it, so nothing is un-pushed any more.
  localStorage.removeItem(SK.dirty);
  _stateOutstanding = false;
  _refusalOwed = false;   // the user chose the saved copy over what this page owed
  _syncHalted = false;
  // Repaint what the user is actually looking at, so the resolution is visible rather than merely
  // recorded. The feed is only reloaded when it is on screen — it costs a network round trip.
  _serverRowSeen = true;   // we just read one
  try {
    renderChannelList();
    toggleGoButton();   // for the same reason as in the repair above
    // Also redundant — `renderChannelList` above already repaints — and measured, not
    // assumed: mutating it away survives the suite. Kept as the explicit statement that a repair
    // must clear its own notice, which is the property r9 asserts.
    renderDamagedNotice();
    if (!document.getElementById('view-feed')?.classList.contains('hidden')) loadFeed();
  } catch { /* a repaint failure must not undo an adoption that already succeeded */ }
  showToast('Using the saved copy');
}

// ── Analytics events ─────────────────────────────────────────────
// track() buffers a section/action-level event (never a content id) and rides it up on the next
// /api/state PUT — no new endpoint (we sit at the 12-fn cap). Deliberately does NOT mark state
// dirty (an event isn't a state mutation), so it can't perturb the sync semantics.
function _readEvents() { try { return JSON.parse(localStorage.getItem(SK.events) || '[]'); } catch { return []; } }
// What ONE save may carry, mirroring `MAX_EVENTS_PER_BATCH` in api/_events.js. The server
// keeps the first 100 VALID events of a batch and silently ignores the rest. A client that
// sends up to 200 (the buffer ceiling) and then drops everything it sent destroys events 101-200
// after a long offline stretch, with every response saying 200. Sending no more than the
// server keeps is what makes "delivered" true for every entry dropped below. Raise the two together
// or not at all.
const MAX_EVENTS_PER_SAVE = 100;
// Drop exactly the entries THIS save carried. Matched by id, and for an entry buffered before
// events carried ids (no id) by value — never by rewriting it in place, because two refusal tests
// assert this buffer is byte-identical after a 412 and a rewrite would also re-send it as a new event.
//
// Removing by COUNT is the defect. Events only ever append, so "the first n" is right for ONE save in
// flight — and events-only and keepalive saves deliberately skip the in-flight latch, so two of them
// routinely carry the same buffer. When the second answer arrived it removed n entries that had
// arrived MEANWHILE and were never sent. Measured: one real `refresh` destroyed while two saves
// overlapped.
function _dropSentEvents(sent) {
  const rest = _readEvents();
  for (const e of (sent || [])) {
    const i = e && e.id != null
      ? rest.findIndex((x) => x && x.id === e.id)
      : rest.findIndex((x) => x && x.id == null && JSON.stringify(x) === JSON.stringify(e));
    if (i !== -1) rest.splice(i, 1);   // -1 = another save already dropped it; nothing owed
  }
  // GUARDED: `setItem` throws on quota, in a private
  // window, and where site data is blocked — and this runs inside `_pushNow`'s try, so unguarded,
  // a throw here would turn a save the server had ACCEPTED into `{ok:false, confirmed:false}`,
  // which `signOut` reads as a failure. And this is the common branch: the
  // 100-event cap means `rest` is often non-empty, so `setItem` runs rather than `removeItem`.
  // Swallowing leaves the entries buffered and they are sent again — which is exactly what an id
  // makes harmless.
  try {
    if (rest.length) localStorage.setItem(SK.events, JSON.stringify(rest));
    else localStorage.removeItem(SK.events);
  } catch { /* the entries stay buffered; the id makes the re-send a no-op server-side */ }
  // Anything still here leaves on its own rather than waiting for the next event or the next close.
  // Bounded: each save drains up to 100 of a buffer that never exceeds 200.
  //
  // NOT "only when the cap held some back": with four events buffered, nowhere near the cap, an event
  // tracked WHILE a save is in flight is still here when the answer arrives. So the everyday trigger
  // is the overlap, not the cap. The consequence is benign and worth stating:
  // this re-arm CLEARS the timer `track()` already set, so that event leaves 3s after
  // the ANSWER rather than 3s after being tracked. Measured: no PUT at answer+2999ms, one at +3000ms.
  //
  // NOT during an exit: `cancelPendingPushes` has just cleared these timers on purpose, and re-arming
  // one from a late answer is exactly the re-entry the seal exists to stop (the push would be refused
  // by `_leaving` anyway; this keeps the intent visible).
  if (rest.length && !_leaving) _armEventsTimer();
}
let _evtTimer = null;
// Events-only by construction: this timer exists to deliver analytics and never has anything to say
// about state. It is also the push that would destroy account rows if it carried state — it fires ~3s into EVERY
// boot, including one whose GET failed and left the browser holding nothing.
function _armEventsTimer() {
  clearTimeout(_evtTimer);
  _evtTimer = setTimeout(() => { _evtTimer = null; pushNow({ eventsOnly: true }); }, 3000); // flush soon, on our own cadence
}
// An event's identity, minted once here and carried through every re-send, so the server
// can tell a re-send from a second real action (api/_events.js `eventId`). Guarded: `crypto` is absent
// or refuses in some embedded webviews, and an analytics id is never worth throwing over — an event
// with no id is still counted, it just cannot be de-duplicated.
function _eventId() {
  try { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : _fallbackUuid(); }
  catch { return _fallbackUuid(); }
}
function track(name, props, section) {
  try {
    const buf = _readEvents();
    buf.push({ name, props: props || {}, section: section || null, ts: Date.now(), id: _eventId() });
    while (buf.length > 200) buf.shift(); // bound the buffer if a long offline stretch piles up
    localStorage.setItem(SK.events, JSON.stringify(buf));
  } catch { return; }
  _armEventsTimer();
}
// Flush a pending write when the tab is backgrounded/closed so a quick action isn't lost.
window.addEventListener('pagehide', flushPush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPush(); });

// On load: reconcile localStorage with the server BEFORE the view is decided (bounded by a
// 2.5s timeout; degrades to localStorage on slow/offline/unavailable). No server row yet →
// claim the existing local state (first push); a row exists → the server is authoritative.
// Only a row from the namespace the SIGN-IN ANSWER says this browser belongs to — which
// is why `init` hands this function checkAuth's promise rather than letting the two race.
async function syncOnLoad(authAnswer) {
  const uid = getDeviceId();
  let server = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    // The device id goes in a header, never the query string: a URL leaks into
    // access logs, proxy logs, browser history and Referer headers, and this id is the only thing
    // authenticating the row behind it.
    const r = await fetch('/api/state', { signal: ctrl.signal, headers: { 'X-Device-Id': uid } });
    clearTimeout(t);
    if (!r.ok) return;               // 503 (no store) / 4xx → stay on localStorage
    server = await r.json();          // { state, updatedAt, rev, kind }
  } catch { return; }                // offline / timeout → stay on localStorage
  // WHICH NAMESPACE ANSWERED, against WHO THE SIGN-IN SAYS THIS IS. The server
  // answers from the account when the session cookie checks out and from the device otherwise, and
  // `/api/auth/me` is a SEPARATE request that can disagree: it times out, or one query's
  // session lookup blips and the other's does not (`api/_session.js` returns null on a DB error).
  // Acting on a contradicted answer does two things: a browser showing the sign-in wall is
  // handed the account's channels — and the next brand-new account signed in on it uploads them as
  // its own — and a signed-in user's channels are replaced by the device's stale copy, or uploaded
  // into the anonymous device row when there is none.
  //
  // THE REFUSAL DEPENDS ON WHICH WAY THEY DISAGREE:
  //   - SIGNED IN, but the DEVICE answered: nothing in that answer is hers. Treated EXACTLY like a
  //     failed read — nothing applied, nothing claimed, no standing, `_serverRowSeen` left unknown —
  //     and returned from right here. The next healthy boot syncs. As after a failed read, a change
  //     made during this visit is replaced by that boot — and the rest of the failed-read trade comes
  //     with it: if something else comes first (another device writes the row, the session ends, a
  //     different account signs in, or a sign-out), un-pushed changes from BEFORE this visit can be
  //     lost too, and a different account signed in next sees them behind "Not syncing".
  //     Refusing the upload stops a
  //     longer blip writing it into the device row. (The server also refuses such an upload from a
  //     signed-in page, so this client-side refusal is no longer the only protection; four tests
  //     pin it.)
  //   - WALLED, but the ACCOUNT answered: the cookie is valid, and only PULLING the account into this
  //     browser is the leak, so only the apply below is refused. The no-row claim and the dirty push
  //     still run: they send THIS browser's own copy to the account that cookie names, which is exactly
  //     what the next healthy boot does moments later. Refusing them too
  //     would protect nothing and lose data — a
  //     signed-out browser's channels when another device created the row first (c2c), and un-pushed
  //     work when the session ended before the next boot (c2d).
  //
  // AWAITED HERE, not read from `_authEmail` directly, and that is the whole of the ordering: the two
  // requests start together and either may answer first. Checking without waiting refuses a signed-in
  // user her OWN row whenever the state read wins, and boots her onto an empty setup screen —
  // measured, and pinned by c8a in test/boot-namespace.test.mjs. The await is wrapped so it can add no
  // new way for the boot to reject: checkAuth assigns `_authEmail` inside its own try/catch, before
  // any line of it that can reject (its render and its storage read and write), so the value is
  // settled.
  //
  // ONLY A WRONG LABEL IS REFUSED. An answer carrying no
  // `kind` is acted on. `_readOwnRow` refuses an unlabelled answer and this deliberately does
  // not — the real server labels every answer, pinned in test/sync-conflict.test.mjs, and c9 pins this
  // side of the difference so a tightening cannot land without that decision being made again.
  try { await authAnswer; } catch { /* _authEmail holds whatever checkAuth resolved before it threw */ }
  const contradicted = !!(server && server.kind != null && server.kind !== (_authEmail ? 'account' : 'device'));
  if (contradicted && _authEmail) return;
  // We now know what the server holds FOR THIS BROWSER, which is the ONLY thing that gives this
  // document standing to push state. Set AFTER the !r.ok guard, after the body parses, and
  // after the signed-in refusal above — one line earlier and a failed read, or a device answer to a
  // signed-in user, vouches for the browser, which is the whole bug with the suite green (c6a). A
  // walled browser answered by its account DOES get standing, because its claim and its dirty push
  // are the two things it may still do; it has no wired controls to use it for anything else. It
  // covers all three branches below on purpose: "no row", "keep local" and "pull down" are different
  // decisions about the SAME established fact.
  _stateLoaded = true;
  const noRow = !server || server.updatedAt == null;
  // Recorded only once the GET has actually answered — the `catch`, the
  // `!r.ok` return and the signed-in refusal above all leave it `null`, which is "this document does
  // not know" and is a third state, not a synonym for "no" (c7). A walled browser records its
  // account's answer here, and nothing reads it there: the damaged-store notice needs a session.
  _serverRowSeen = !noRow;
  if (noRow) {
    // `syncedDamaged()` FIRST, and the short-circuit is the guard, not tidiness: this is the one
    // collectSyncedState() on the boot path that is not wrapped, so on a corrupt store it would throw,
    // reject init's Promise.all and blank the app. Claiming a
    // damaged store's contents as the account's first copy would also be the worst possible moment
    // to do it — there is no row to fall back to.
    if (!syncedDamaged() && _hasUserData(collectSyncedState())) pushNow(); // claim existing local state
    return;
  }
  // A server row exists. If local still has un-pushed changes (dirty) — a prior push may have been
  // dropped on a mobile app-kill — the server row is stale for THIS device: keep local and re-push,
  // rather than pulling the stale row down over correct state and resurrecting read posts.
  if (localStorage.getItem(SK.dirty) === '1') {
    // ABSORBING STATE, closed here. `dirty` says "local is
    // AHEAD of the row". Sometimes it is lying, and when it is, the lie is self-perpetuating: the
    // push below declares a stale base, is refused, and only a 200 clears `dirty` — so the next boot
    // does exactly this again, forever. Measured over three boots.
    //
    // The everyday cause is the unload flush: a `keepalive` push outlives the
    // document by design, so the write LANDS and the response carrying the new rev is never read.
    // `SK.rev` is then one version behind a row this very browser wrote. Mark a video done, close
    // the tab, reopen — sync dead.
    //
    // If local is byte-identical to the row then nothing is genuinely un-pushed, and this grants no
    // power whatsoever: writing identical bytes over the row would change nothing, so declining to
    // write them cannot destroy anything. Errs to "different" on every uncertainty — see
    // sameSyncedState, where the asymmetry is spelled out.
    //
    // Guarded: collectSyncedState() JSON.parses raw localStorage and throws on corrupt storage, and
    // this is the BOOT path. A throw here degrades to pushing (and
    // finding out), never to a blank app.
    let reconciled = false;
    try {
      // `!syncedDamaged()` FIRST, and it is NOT belt-and-braces.
      // Leaving this guard to `collectSyncedState()` throwing
      // works ONLY for unparseable bytes:
      // `collectSyncedState` reads `getItem(k) || '[]'`, so the EMPTY STRING coerces to `[]` and
      // never throws. Without this term, with
      // `focus_done: ''` and `dirty: '1'`, boot 1 clears `dirty`, re-bases `SK.rev` to the
      // server's and sends NO push, so the next boot overwrites the damaged key. Pinned by r1, which
      // exercises all three classes.
      if (!syncedDamaged() && sameSyncedState(collectSyncedState(), server.state)) {
        localStorage.removeItem(SK.dirty);
        if (server.rev) localStorage.setItem(SK.rev, server.rev);
        reconciled = true;
      }
    } catch { /* corrupt storage → fall through to the push */ }
    // .catch, because this call is NOT awaited. The body is built inside _pushNow's try,
    // so a storage throw is a returned {ok:false} and this `.catch` is dead FOR THAT CAUSE.
    // KEPT DELIBERATELY — the call is un-awaited, and any future
    // rejection from _pushNow (or from a caller added above it) would be unhandled here. It is
    // a guard on the CALL SHAPE.
    //
    // Swallowing is the right answer here and not a shrug: `dirty` stays set, so the next boot tries
    // again.
    if (!reconciled) pushNow().catch(() => { /* dirty stays set; the next boot retries */ });
    return;
  }
  // APPLY, THEN RE-BASE, and the order is the guard. A rev written
  // before the apply would leave this client based on a row it never actually holds if the apply
  // throws — and its next push, declaring a base that still MATCHES, would then be accepted and
  // overwrite the row with the state that failed to be replaced. Wrapped because
  // this is the BOOT path, and a storage throw escaping here rejects init's
  // Promise.all and blanks the app. applySyncedState is all-or-nothing, so a failure
  // leaves local exactly as it was — no base, no data, no boot lost.
  // Re-base HERE and nowhere else on this path, and AFTER the apply, never before. The branch above
  // READ the same response and deliberately did not apply it — re-basing there would tell the server
  // this client had seen a row it ignored, which is the overwrite this whole mechanism exists to
  // refuse. The base follows the DATA.
  //
  // Quota, a private window and a browser blocking site data all throw here.
  // Failing to record a base degrades to a client that declares none — it can still create, and can
  // never overwrite. Sync is lost, not safety, and never the app.
  //
  // THE ONE THING A WALLED BROWSER MAY NOT DO (c1 and c3): pull its account's row in. The
  // claim and the dirty push above ran, and this is where a contradicted answer stops. Placed here,
  // below them, on purpose — above them it would defer the uploads again (see the refusal's comment).
  if (contradicted) return;
  try {
    applySyncedState(server.state);     // server authoritative → pull down
    if (server.rev) localStorage.setItem(SK.rev, server.rev);
  } catch {
    // Boot survives. Either the apply rolled back (local untouched) or it succeeded and only the rev write
    // failed — both leave this client declaring no new base, and the tour's start reads both as "not applied"
    // (the second case matters only for an account whose row is empty).
    _bootApplyFailed = true;
  }
}

// ── Account / sign-in ─────────────────────────────────────────────
// Passwordless magic-link. The Account block (bottom of setup) has three states, toggled here.
// Fetches carry the session cookie automatically (same-origin), so once signed in the
// sync (syncOnLoad/pushNow) is keyed to the account server-side — "adopt on login" happens for
// free on the post-callback reload, with no extra client code.
let _authEmail = null;
const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function showAcctState(which) {
  document.getElementById('acct-out').classList.toggle('hidden', which !== 'out');
  document.getElementById('acct-sent').classList.toggle('hidden', which !== 'sent');
  document.getElementById('acct-in').classList.toggle('hidden', which !== 'in');
}

const _PROFILE_SILHOUETTE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.7-8 6v1h16v-1c0-3.3-3.6-6-8-6Z"/></svg>';

function renderAccount() {
  const name = document.getElementById('profile-id-name');
  const sub = document.getElementById('profile-id-sub');
  const av = document.getElementById('profile-id-av');
  if (_authEmail) {
    document.getElementById('acct-in-email').textContent = _authEmail;
    document.getElementById('acct-avatar').textContent = (_authEmail[0] || '?').toUpperCase();
    // Identity header mirrors the signed-in state (the account block below just shows Sign out).
    if (name) name.textContent = _authEmail;
    if (sub) sub.textContent = 'Synced across your devices';
    if (av) { av.textContent = (_authEmail[0] || '?').toUpperCase(); av.classList.add('is-signed'); }
    showAcctState('in');
  } else {
    if (name) name.textContent = 'Anonymous';
    if (sub) sub.textContent = 'Not signed in. Channels saved on this device only';
    if (av) { av.innerHTML = _PROFILE_SILHOUETTE; av.classList.remove('is-signed'); }
    showAcctState('out');
  }
}

// Resolve the current session (if any) and render the block. Non-blocking; degrades to
// signed-out on any error so the UI never hangs on the network.
async function checkAuth() {
  try {
    // Bounded so boot never hangs on /api/auth/me (mirrors syncOnLoad); offline/slow → signed-out.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch('/api/auth/me', { signal: ctrl.signal });
    clearTimeout(t);
    _authEmail = r.ok ? (await r.json()).email : null;
  } catch { _authEmail = null; }
  renderAccount();
  // Fire signin/signout on the auth transition across reloads (auth is a full-page redirect, so
  // there's no in-page moment to catch). SK.wasAuthed remembers the last boot's auth state.
  const wasAuthed = localStorage.getItem(SK.wasAuthed) === '1';
  const nowAuthed = !!_authEmail;
  if (nowAuthed && !wasAuthed) { track('signin'); localStorage.setItem(SK.wasAuthed, '1'); }
  else if (!nowAuthed && wasAuthed) { track('signout'); localStorage.removeItem(SK.wasAuthed); }
}

// ── Profile panel ── slide-in drawer holding the relocated account block ──
let _profilePrevFocus = null;
function _profileEsc(e) { if (e.key === 'Escape') closeProfile(); }
function openProfile() {
  track('view', {}, 'profile');
  const panel = document.getElementById('profile-panel');
  const scrim = document.getElementById('profile-scrim');
  const btn = document.getElementById('profile-btn');
  _profilePrevFocus = document.activeElement;
  scrim.classList.add('show');
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  document.body.classList.add('profile-open');
  document.addEventListener('keydown', _profileEsc);
  resetDeleteConfirm(); // each open starts with the delete confirm collapsed
  resetSignOutConfirm(); // and the sign-out warning, for the same reason
  panel.focus();
  tourSync(); // the tour waits while the drawer is open
}
function closeProfile() {
  const panel = document.getElementById('profile-panel');
  const scrim = document.getElementById('profile-scrim');
  const btn = document.getElementById('profile-btn');
  scrim.classList.remove('show');
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('profile-open');
  document.removeEventListener('keydown', _profileEsc);
  resetDeleteConfirm(); // don't leave a half-typed delete confirm open
  resetSignOutConfirm(); // nor a warning one stray tap from destroying work
  if (_profilePrevFocus && _profilePrevFocus.focus) _profilePrevFocus.focus();
  tourSync(); // …and returns to the same card when it closes
  // `.toast` (z-index 62) sits ABOVE `.profile-panel` (61) and its scrim (60), so the drawer
  // does NOT paint over the notice and a toast raised while it is open is reachable (verified with
  // `elementFromPoint`). The reason for the call below
  // is that a halt is worth telling the reader about on close, not that it was invisible.
  // The drawer holds the theme toggle, which makes it the
  // likeliest way to raise one. Sync-paused is a STATE, not an event, so this fires on EVERY close
  // rather than once. The notice's "no second button" design is conditional on the notice
  // being reachable, so this is load-bearing for that design, not a polish item.
  if (_syncHalted) _showSyncConflict();
}

// Wire the Settings drawer's controls once, at boot. The drawer is body-level and opens from the
// feed/archive gears too — not just setup — so its handlers can't live in initSetup: on a feed-first
// boot initSetup never runs, which left Close + the scrim dead (no way to dismiss on mobile).
let _drawerWired = false;
function wireDrawer() {
  if (_drawerWired) return;
  _drawerWired = true;
  document.getElementById('profile-btn').addEventListener('click', openProfile);
  document.getElementById('profile-close').addEventListener('click', closeProfile);
  document.getElementById('profile-scrim').addEventListener('click', closeProfile);
  // Account block lives inside the drawer, so it's wired here too.
  document.getElementById('acct-send').addEventListener('click', sendMagicLink);
  document.getElementById('acct-email').addEventListener('keydown', e => { if (e.key === 'Enter') sendMagicLink(); });
  document.getElementById('acct-different').addEventListener('click', () => showAcctState('out'));
  document.getElementById('acct-signout').addEventListener('click', () => signOut());
  document.getElementById('acct-signout-cancel')?.addEventListener('click', resetSignOutConfirm);
  // `force` is the user's own second press, and it is the ONLY way past the refusal gate.
  document.getElementById('acct-signout-go')?.addEventListener('click', () => signOut({ force: true }));
  document.getElementById('acct-export').addEventListener('click', exportData);
  document.getElementById('acct-delete-open').addEventListener('click', openDeleteConfirm);
  document.getElementById('acct-delete-cancel').addEventListener('click', resetDeleteConfirm);
  document.getElementById('acct-delete-email').addEventListener('input', _syncDeleteGate);
  document.getElementById('acct-delete-go').addEventListener('click', deleteAccount);
}

// Shared magic-link request — POST the email to the (uniform, always-200, no-enumeration)
// endpoint. A network blip just means no email; the user can retry. Used by the account block
// and the first-run landing.
async function requestMagicLink(email) {
  try {
    await fetch('/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  } catch { /* offline → no email sent; user can retry */ }
}

async function sendMagicLink() {
  const input = document.getElementById('acct-email');
  const msg = document.getElementById('acct-msg');
  const email = (input.value || '').trim();
  if (!_EMAIL_RE.test(email)) {
    msg.textContent = 'Enter a valid email address.';
    msg.classList.remove('hidden');
    return;
  }
  msg.classList.add('hidden');
  const btn = document.getElementById('acct-send');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  await requestMagicLink(email);
  btn.disabled = false;
  btn.textContent = label;
  document.getElementById('acct-sent-email').textContent = email;
  showAcctState('sent');
}

// ── Leaving actually leaves ────────────────────────────────────────
// Both exits must clear this browser's state, or the next account to sign in on this
// browser inherits the previous person's channels/done/archive via syncOnLoad's adopt path.
// The disposition of every SK key lives in lib/pure.js (unit-tested); this just applies it.
// Cancel queued pushes. Must run BEFORE any destructive network call, not after: a timer firing
// mid-delete lands once the session has cascaded away, so /api/state resolves it to the DEVICE
// namespace and re-inserts the deleted user's whole state under the not-yet-rotated id — which
// rotation then orphans permanently. (Reproduced, not hypothetical.)
// `sealed` additionally blocks every OTHER route into pushNow — the pagehide/visibilitychange
// listeners, and any push already queued behind an await. An in-flight `keepalive` fetch still
// cannot be recalled; that residual remains.
// Returns a seal token when `sealed` — the caller's proof of ownership, which unsealPushes()
// requires. Without it "only the sealer may unseal" is a comment rather than a rule.
function cancelPendingPushes({ sealed = false } = {}) {
  clearTimeout(_pushTimer); _pushTimer = null;
  clearTimeout(_evtTimer);  _evtTimer = null;
  if (!sealed) return 0;
  _leaving = true;
  const token = ++_sealToken;
  _heldSeals.add(token);
  return token;
}

// Re-arm a push we cancelled but never sealed. Kept separate from unsealPushes on purpose: clearing
// `_leaving` when you did not set it releases whatever OTHER exit is in flight — signOut's early
// refusal would do exactly that to deleteAccount's seal, letting a timer fire mid-delete and write
// the state back into a device row. Only the code that sealed may unseal.
function rearmPush() {
  if (localStorage.getItem(SK.dirty) === '1') schedulePush();
}

// Release a seal — but only the one this caller took, and only if no other exit still holds one.
// A refcount rather than a single token: sign-out and delete live in the same drawer and can
// overlap, and with a bare token the second sealer's release would unseal the first as well. While
// any seal is held a timer firing mid-exit would write the departing state into a device row that
// rotation then orphans.
function unsealPushes(token) {
  if (!token || !_heldSeals.delete(token)) return;   // not ours, or already released
  if (_heldSeals.size) return;                       // another exit is still in flight — stay sealed
  _leaving = false;
  rearmPush();
}

function clearLocalIdentity() {
  cancelPendingPushes({ sealed: true }); // no push may follow the clear, by any route
  const { clear, rotate } = exitKeyPlan();
  for (const name of clear) localStorage.removeItem(SK[name]);
  // Rotation is what actually closes the delete case: the server's device row is a stale snapshot
  // from sign-in time, so while this id survives the next anonymous boot pulls that state back
  // down. Removing the key is enough — getDeviceId() mints a fresh uuid on its next call.
  for (const name of rotate) localStorage.removeItem(SK[name]);
  getDeviceId(); // mint eagerly so the new identity exists before any reload
}

// Guards re-entry: a second click while the first exit is awaiting the network must not start
// another. Reset only on the paths where we stay on the page.
//
// Belt-and-braces, deliberately, and deliberately NOT pinned by a test: the seal already blocks the
// second call's push, so removing this guard changes no observable behaviour today and no honest
// test can red on it. It earns its place by making the intent explicit rather than emergent — if
// the seal is ever moved or scoped differently, this is what stops two exits running at once.
let _signingOut = false;
let _signOutSeal = 0;   // the token _signOut took, so the catch can release only its own seal

async function signOut({ force = false } = {}) {
  if (_signingOut) return;
  _signingOut = true;
  _signOutSeal = 0;
  try {
    await _signOut({ force });
  } catch (e) {
    // Without this the latch stays set and the button is silently dead for the rest of the page.
    //
    // A corrupt VALUE does not throw here — `_signOut` consults `syncedDamaged()` and short-circuits
    // ahead of every collectSyncedState call. But this is not decoration:
    // a browser blocking site data makes `getItem` itself throw
    // (the harness models that with `failGetItem`, and test/exit-paths.test.mjs is
    // pointed at it). The guard is on the CALL SHAPE.
    console.error('[signOut]', e);
    closeProfile();
    showToast("Couldn't sign out — something went wrong");
    // Release ONLY a seal this call took. _signOut can still throw before it seals — a storage
    // read that is REFUSED outright, not merely unparseable (see above) — and a blanket reset here
    // would release a concurrent delete's seal.
    unsealPushes(_signOutSeal);
    _signOutSeal = 0;
    _signingOut = false;
  }
}

async function _signOut({ force = false } = {}) {
  // ORDER IS THE WHOLE DESIGN HERE. Save, and if that provably failed, refuse the sign-out BEFORE
  // ending the session — never after.
  //
  // "The session is over, so what do I do with data I
  // could not save?" has no good answer: a browser
  // that is signed out while still holding the previous user's channels IS the leak this ordering
  // exists to close, whatever else we do to it. Keeping the data leaks it to the next person;
  // wiping it destroys work irreversibly. Rotating the id fixes neither (the data is still in this
  // browser for the next person) and adds a third failure — the stale row overwrites what we just
  // promised to keep.
  //
  // Refusing first sidesteps it: the session stays live, nothing is wiped, the drawer still works,
  // and a retry succeeds once the network does. It is the same shape as the !reached branch below,
  // for the same reason — stay in the recoverable state.
  cancelPendingPushes();                                 // don't let a queued timer double-push
  let push = { ok: false, confirmed: false };
  // Nothing to save means nothing to SEND. A boot whose GET failed shows
  // the user an empty app, so they sign out to fix it — and an unconditional push writes that empty
  // state over the account's real row on the way out. Degrades to an events-only push rather than to
  // no push at all, because the buffered events are about to be wiped by EXIT_DISPOSITION and this
  // is their last chance to leave. (Not the `signout` event — that one is emitted on the NEXT boot
  // from SK.wasAuthed.)
  //
  // NOT the only such trigger, and this does not close the class — see schedulePush's comment.
  //
  // A deliberate clear is unaffected: removing every channel set dirty via schedulePush(), so
  // _statePending() is true and the clearing PUT still goes out. Pinned by C8 in
  // test/push-intent.test.mjs — dropping `!_statePending()` here loses the clear and the channels
  // come back on the next sign-in.
  //
  // DELIBERATELY ADDS NO TERM HERE — read this
  // before "fixing" the wedge below. `_stateLoaded` looks like it belongs: without standing a push
  // cannot confirm, so the refusal fires and sign-out is impossible while the read keeps failing.
  // The tempting carve-out is `(!_stateLoaded || !_hasUserData(...))` — "no standing means nothing
  // worth keeping". It is FALSE, and it destroys data:
  //
  //   - It short-circuits before `_hasUserData` is ever consulted, so it cannot tell "a stale mirror
  //     of a row we never read" from "the user added three channels ten seconds ago". Measured: the
  //     new channel is erased from local AND never sent. (Pinned by B8.)
  //   - It disables BOTH `_hasUserData` calls here as a side effect: two faithful mutations of them
  //     leave the whole suite green.
  //   - `nothingToSave` also feeds the gate below, so a push refused by the exit SEAL reads as
  //     "nothing to do" and sign-out completes mid-delete, wiping and rotating.
  //
  // What makes the wedge acceptable is that it is exactly what happens when a save
  // provably fails, and that is on purpose — refusing keeps the session live, keeps the
  // data, and a retry succeeds once a read does. A browser with nothing to lose still leaves, because
  // `_hasUserData` is false and the gate below never fires. The residual — a user holding channels
  // whose reads keep failing must reload before they can sign out — is known, not solved here.
  // UNPINNED IN THE DANGEROUS DIRECTION: replacing
  // the argument below with `pushNow({})` — i.e. always claiming state — survives the whole suite.
  // The property this protects (an unloaded browser must not claim state) currently rests entirely on `_pushNow`'s
  // `if (!_stateLoaded) eventsOnly = true`, which is well pinned and independently
  // neutralises it, so nothing is broken today. But a developer "simplifying" this argument away
  // gets a green suite, and the two guards are one deploy apart from being the only one.
  // `!syncedDamaged()` must stay in the MIDDLE: it short-circuits
  // before collectSyncedState() — which still throws on a damaged store, by design — and it answers
  // "unreadable" as HAS DATA WORTH KEEPING. The opposite reading is fatal: _hasUserData sees
  // a coerced empty, reads it as "nothing", the refusal never fires and EXIT_DISPOSITION
  // wipes the only copy there is. This refuses and keeps the bytes.
  const nothingToSave = !_statePending() && !syncedDamaged() && !_hasUserData(collectSyncedState());
  try {
    // Retry while a mutation keeps landing behind the PUT — routine, since the async /api/group
    // resolve calls saveGroupState. Bounded: three attempts, then we refuse rather than spin.
    for (let i = 0; i < 3; i++) {
      // `requireAccount: false` — the one exempt save. Measured with the guard on it: once the session has ENDED this save
      // gets a 412 on every attempt, so the refusal below fires every time and the departing user's data
      // stays in the browser — sign-out cannot complete on that page. With it off this save
      // lands in a device row the id rotation then orphans. An argument rather
      // than a flag, so an unload flush firing while this awaits still carries the header.
      push = await pushNow({ eventsOnly: nothingToSave, requireAccount: false });
      // failed, or the server now holds the newest state. An events-only push can never confirm, so
      // it must break too rather than spin out all three attempts.
      // TWO OF THESE THREE TERMS ARE UNPINNED: dropping
      // `!push.ok` survives the suite, and so does dropping `nothingToSave`; only `push.confirmed`
      // is caught, and only by J3. The cost of either is three PUTs where one belongs — cosmetic
      // today, and NOT cosmetic if a deadline is ever put on this loop, because three slow attempts
      // then burn it. Pin these before adding one.
      if (!push.ok || push.confirmed || nothingToSave) break;
    }
  } catch { push = { ok: false, confirmed: false }; }

  // Same guard, same order, same reason. A damaged store can never produce a confirmed
  // push — _pushNow downgrades it to events-only and an events-only push cannot confirm — so this
  // reaches the INDETERMINATE branch below: refuse, keep the session live, keep every byte, and let
  // a retry succeed once the store heals. The user is told something true instead of "something
  // went wrong". The residual wedge (a damaged store cannot sign out until it heals) remains,
  // and the notice's action is the way out of it.
  if (!push.confirmed && (syncedDamaged() || _hasUserData(collectSyncedState()))) {
    // TWO different failures now reach here and they must be answered differently.
    //
    // DETERMINATE — the server considered this write and REFUSED it (409). A retry cannot help, so
    // the refusal below would make sign-out permanently impossible, while letting them out
    // unconditionally would destroy data silently. So: let them out, having WARNED them, so the loss is chosen
    // rather than either silent or inescapable. `force` is the user's own second press.
    if (push.refused && !force) {
      showSignOutWarning();
      rearmPush();                                       // we cancelled a push but never sealed
      _signingOut = false;
      return;
    }
    // INDETERMINATE — everything else. A retry may work once the network
    // does, so staying recoverable is still right and nothing is offered up for destruction.
    if (!push.refused) {
    // `confirmed`, not `ok`. `ok` only says *some* state reached the server — after a mutation
    // queued behind the PUT, that state is the OLD one, so clearing here silently destroys the
    // newest change. The retry loop
    // above is what makes gating on `confirmed` safe — a mid-flight mutation is re-sent rather than
    // read as a failure.
    //
    // _hasUserData rather than SK.dirty because the adopt push in syncOnLoad never sets dirty, so a
    // first sign-in whose adopt failed would look clean while the server held nothing.
    closeProfile();                                      // close the drawer so the toast is the answer
    showToast("Not signed out — couldn't save your changes");
    // Deliberately does NOT set SK.dirty. It looks right — "keep local and retry on the next boot" —
    // and it is a cross-account hazard: syncOnLoad treats dirty === '1' as "push local up" and
    // returns WITHOUT calling applySyncedState, so if a different account signs in on this browser
    // next, their row is never pulled down and this user's channels are uploaded into it.
    // Any mutation worth keeping already
    // set dirty via schedulePush(); the narrow gap (a failed adopt push, which never sets it)
    // self-heals — syncOnLoad's no-row branch re-adopts on the next boot.
    rearmPush();                                         // we cancelled a push but never sealed
    _signingOut = false;
    return;
    }
    // Determinate AND confirmed by the user: fall through and complete the sign-out.
  }

  // Everything worth keeping is on the server. From here we await the network, and
  // pagehide/visibilitychange → flushPush() could still re-enter pushNow() on a backgrounded tab —
  // which, once the session is gone, resolves to the DEVICE namespace under the not-yet-rotated id.
  _signOutSeal = cancelPendingPushes({ sealed: true });

  let reached = false;
  try {
    // No device id is sent: the server no longer deletes device rows on sign-out (see
    // api/auth/logout.js). Rotation below is what makes this browser stop reading the stale row.
    const r = await fetch('/api/auth/logout', { method: 'POST' });
    reached = r.ok;
  } catch { /* never landed → handled below */ }

  if (!reached) {
    // No 200, so the cookie was not cleared and this browser is still signed in. Wiping here would
    // hand the account to whoever reloads next.
    //
    // Asking the server "did you end a session?" instead is not safe. That answer is also false
    // for a DB blip (api/_session.js swallows the error and returns null) — while logout clears the
    // cookie unconditionally. So the refusal would fire on a browser that was genuinely signed out, keep
    // everything, and never recover: the retry has no cookie left to send.
    closeProfile();
    showToast("Couldn't sign out — check your connection");
    unsealPushes(_signOutSeal);   // this branch DID seal, above
    _signOutSeal = 0;
    _signingOut = false;
    return;
  }

  // What brings the wall back is the reload below finding no session (_authEmail stays null), NOT
  // any stored flag — nothing reads SK.landing. clearLocalIdentity() still clears it
  // along with everything else, to tidy the value off browsers that took the old skip.
  clearLocalIdentity();
  location.href = '/app'; // reload the app (at /app) as anonymous → view-landing sign-in
}

// ── Account data controls ── export my data + delete account ──
// Export pulls the authoritative server blob (session-gated /api/state) and offers it as a JSON
// download — the honest "what we hold". Falls back to the local mirror if the fetch fails so it
// still works offline; the shape matches collectSyncedState() either way.
async function exportData() {
  let state = null;
  try {
    const r = await fetch('/api/state', { headers: { Accept: 'application/json' } });
    if (r.ok) state = (await r.json()).state;
  } catch { /* offline → fall back to the local mirror below */ }
  let unreadable = null;
  if (state == null) {
    // The server is unreachable, so the local mirror is all there is.
    //
    // What is forbidden is a CONFIDENT EMPTY — a backup whose damaged key is silently absent,
    // filed away by the user as a complete copy. It does NOT follow that the right answer is to
    // refuse: with one key of four damaged, refusing offers ZERO files where one
    // carrying the channels and all 50 read marks was possible. Export is the user's own
    // preservation action, and refusing it exactly when they most want it is a regression.
    //
    // So: export everything readable, and NAME what could not be read, in the file itself.
    unreadable = SYNCED_PROTECTED.filter(_keyDamaged);
    state = {
      channels: _readProtected(SK.channels, []),
      done:     _readProtected(SK.done, []),
      archive:  _readProtected(SK.archive, []),
      theme:    localStorage.getItem(SK.theme),
      shorts:   localStorage.getItem(SK.shorts),
      groups:   _readProtected(SK.groups, null),
    };
    if (!unreadable.length) unreadable = null;
  }
  const payload = { email: _authEmail || null, exportedAt: new Date().toISOString(),
    // Present ONLY when something could not be read, so an ordinary export is byte-identical to
    // what it always was.
    ...(unreadable ? { unreadable } : {}), state };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `focus-data-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Data exported');
}

// Delete is irreversible → the gate is: the typed email must match the signed-in address.
function _syncDeleteGate() {
  const typed = (document.getElementById('acct-delete-email').value || '').trim().toLowerCase();
  document.getElementById('acct-delete-go').disabled = !_authEmail || typed !== _authEmail.toLowerCase();
}
function openDeleteConfirm() {
  document.getElementById('acct-delete-open').classList.add('hidden');
  document.getElementById('acct-delete-confirm').classList.remove('hidden');
  const input = document.getElementById('acct-delete-email');
  input.value = '';
  _syncDeleteGate();
  input.focus();
}
// Collapse the confirm back to just the "Delete account" button — called on cancel and whenever
// the panel opens/closes, so a half-typed delete never lingers.
// Reveal the warning inside the drawer rather than closing it. The refusal toast below closes the
// drawer because the drawer's job is done; here it is not — the user has a choice to make in it.
function showSignOutWarning() {
  document.getElementById('acct-signout-confirm')?.classList.remove('hidden');
}

function resetSignOutConfirm() {
  document.getElementById('acct-signout-confirm')?.classList.add('hidden');
}

function resetDeleteConfirm() {
  const confirm = document.getElementById('acct-delete-confirm');
  if (!confirm) return;
  confirm.classList.add('hidden');
  document.getElementById('acct-delete-open').classList.remove('hidden');
  document.getElementById('acct-delete-email').value = '';
  const msg = document.getElementById('acct-delete-msg');
  msg.textContent = ''; msg.classList.add('hidden');
  const go = document.getElementById('acct-delete-go');
  go.disabled = true; go.textContent = 'Permanently delete';
}
async function deleteAccount() {
  const go = document.getElementById('acct-delete-go');
  const msg = document.getElementById('acct-delete-msg');
  if (go.disabled) return; // gated on the email match
  go.disabled = true;
  go.textContent = 'Deleting…';
  // BEFORE the destructive call, not after (reproduced): a queued push firing during the
  // await lands after the session has cascaded away, so /api/state writes the state we are deleting
  // into a fresh DEVICE row under the current id — which the rotation below then orphans forever.
  // Sealed, because cancelling timers alone leaves pagehide/visibilitychange able to do it anyway
  // — and on a delete there is nothing left worth pushing.
  const seal = cancelPendingPushes({ sealed: true });
  let ok = false, status = 0;
  try {
    // Send the CURRENT device id so the server can delete this browser's device row too — it is a
    // stale pre-sign-in snapshot the delete would otherwise leave behind, and it is what makes a deleted
    // account come back on the next reload. Rotation below happens only after a 200, so
    // the id we send is still the one the row is keyed on.
    const r = await fetch('/api/auth/delete', {
      method: 'POST',
      headers: { 'X-Device-Id': getDeviceId() },
    });
    status = r.status; ok = r.ok;
  } catch { /* network error handled below */ }
  if (ok) {
    // Account, server-side state and this browser's device row are all gone. Now drop the local
    // copy and rotate the device id, so nothing of this person survives the reboot.
    // No flush first — unlike sign-out, we are deliberately destroying this data.
    clearLocalIdentity();
    location.href = '/app'; // app relocated to /app
    return;
  }
  // The delete did not happen and the user stays in a working app, so the seal taken above must be
  // released — otherwise sync is dead for the rest of this page.
  unsealPushes(seal);   // only ours — a concurrent signOut may be holding its own
  go.textContent = 'Permanently delete';
  _syncDeleteGate();
  msg.textContent = status === 401
    ? 'Your session expired. Please sign in again.'
    : 'Could not delete right now. Please try again.';
  msg.classList.remove('hidden');
}

// The email link → callback redirects to /?auth=ok|invalid. Toast it, then strip the param so
// a refresh doesn't re-toast.
function handleAuthLanding() {
  const params = new URLSearchParams(location.search);
  const a = params.get('auth');
  if (!a) return;
  params.delete('auth');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  if (a === 'ok') {
    // Two different people reach this line with no session, and from here they are
    // indistinguishable: someone opening a stale, shared or hand-typed /app?auth=ok — every value
    // of this param is attacker-supplied, see the boot comment in init() — and someone whose
    // sign-in genuinely succeeded but whose /api/auth/me missed checkAuth's 2.5s abort,
    // whose cookie is valid and for whom a reload really does work. Because we cannot tell them
    // apart, the message asserts nothing about the server and states only what is observable here:
    // you are not signed in. The retry helps the second case and costs the first nothing. The param
    // strip above is unconditional, so it is bounded to one attempt.
    //
    // Gated on _authEmail rather than trusted from the URL because the wall was telling people they
    // were signed in while showing them a sign-in screen (reproduced on production). This
    // makes the CALL ORDER load-bearing: _authEmail is written only by checkAuth(), which init()
    // awaits before calling this — hoisting the call above that await leaves every real sign-in
    // unconfirmed.
    if (_authEmail) {
      showToast('Signed in');
    } else {
      showToast('You’re not signed in', 'Try again', () => location.reload());
    }
  } else if (a === 'invalid') {
    showToast('That sign-in link expired', 'Send a new one', () => {
      // Signed out, the wall is already on screen and IS the send-a-new-one form, so just focus it.
      // Calling showView('view-setup') + openProfile() unconditionally here would put
      // an UNAUTHENTICATED visitor inside the app — a
      // bypass of the only gate. Never route past the wall from here.
      if (!_authEmail) { document.getElementById('landing-email')?.focus(); return; }
      showView('view-setup');
      initSetup();
      openProfile();
      document.getElementById('acct-email')?.focus();
    });
  } else if (a === 'google_failed') {
    showToast('Google sign-in didn’t work. Please try again');
  } else if (a === 'google_unavailable') {
    showToast('Google sign-in isn’t available right now');
  }
}

// ── The sign-in wall (mandatory) ──────────────────
// Shown to every signed-out visitor on every boot. It reuses the sign-in endpoints and is the only
// way into the app.
//
// SK.landing is no longer read or written. It is NOT deleted: browsers that took the old
// "Continue without an account" skip still hold `focus_landing_seen = 'true'`, and keeping the key
// in the SK inventory is what keeps EXIT_DISPOSITION clearing it on the way out. Nothing reads it,
// so its value cannot affect who sees the wall — lib/pure.js's shouldShowLanding ignores
// `landingSeen` on purpose, and a test asserts no value of it changes the result.
//
// shouldShowLanding lives in lib/pure.js — it decides whether a visitor may use the app
// at all, and it was the only boot predicate with no test.

let _landingWired = false;
function showLandingView() {
  showView('view-landing');
  // The denominator of the only rate that can tell us whether the sign-in wall costs us
  // users — landing_view vs signin. Deliberately before the wiring guard below: this counts "the
  // wall was shown", which is true on every call, not "the wall was wired", which happens once.
  // In practice init() reaches here once per boot, so it is one event per session either way.
  track('landing_view', {}, 'landing');
  if (_landingWired) return;
  _landingWired = true;
  document.getElementById('landing-send').addEventListener('click', landingSendMagicLink);
  document.getElementById('landing-email').addEventListener('keydown', e => { if (e.key === 'Enter') landingSendMagicLink(); });
  // "Continue with Google" is a plain <a href="/api/auth/google/start"> — a full redirect, no JS.
  // There is deliberately no third handler here: there is no "Continue without an account"
  // skip. If you add a control to this view, remember the markup and the listener are one edit —
  // a getElementById() that returns null throws HERE, half-way through wiring, and leaves the only
  // door into the app rendered but dead.
}

// Email path: the same request as the account block, then an inline "check your email" panel.
async function landingSendMagicLink() {
  const input = document.getElementById('landing-email');
  const msg = document.getElementById('landing-msg');
  const email = (input.value || '').trim();
  if (!_EMAIL_RE.test(email)) {
    msg.textContent = 'Enter a valid email address.';
    msg.classList.remove('hidden');
    return;
  }
  msg.classList.add('hidden');
  const btn = document.getElementById('landing-send');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  await requestMagicLink(email);
  btn.disabled = false;
  btn.textContent = label;
  document.getElementById('landing-sent-email').textContent = email;
  document.getElementById('landing-signin').classList.add('hidden');
  document.getElementById('landing-sent').classList.remove('hidden');
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#c0392b','#2e7d32','#8e44ad','#d35400','#2980b9',
  '#16a085','#7f8c8d','#1a237e','#4a148c','#00695c',
];

function avatarColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// Reusable chips/tags input for keyword filters. Turns `host` into a field where
// typing a term + Enter or comma commits it as a chip, and each chip carries a ✕ to remove it.
// Terms with spaces are kept whole (matched later as a phrase). Duplicates are ignored
// case-/Turkish-diacritic-insensitively. Returns a controller:
//   getChips() — commits any half-typed text first, then returns the terms (original casing)
//   clear()    — empties the field
//   focus()    — focuses the text input
function createChipsInput(host, { initial = [], placeholder = '' } = {}) {
  const chips = [];
  const field = document.createElement('div');
  field.className = 'chips-input';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chips-text';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.autocorrect = 'off';
  input.spellcheck = false;

  function renderChips() {
    field.querySelectorAll('.chip').forEach(c => c.remove());
    chips.forEach((term, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const label = document.createElement('span');
      label.textContent = term;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip-remove';
      x.setAttribute('aria-label', 'Remove ' + term);
      x.textContent = '×';
      x.addEventListener('click', () => { chips.splice(i, 1); renderChips(); input.focus(); });
      chip.append(label, x);
      field.insertBefore(chip, input);
    });
  }

  function addTerm(raw) {
    const term = (raw || '').trim();
    if (!term) return;
    const folded = foldTurkish(term);
    if (chips.some(c => foldTurkish(c) === folded)) return; // dedupe (case-/diacritic-insensitive)
    chips.push(term);
    renderChips();
  }

  // Commit whatever's typed — on Enter/comma, and again on getChips() so a half-typed term
  // isn't silently lost when the user clicks Save/Add without pressing Enter.
  function commitPending() {
    if (input.value.trim()) { addTerm(input.value); input.value = ''; }
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitPending(); }
  });
  // Paste (or a mobile comma keypress that skips keydown): split on commas, keeping the
  // trailing fragment in the field as still-being-typed.
  input.addEventListener('input', () => {
    if (input.value.includes(',')) {
      const parts = input.value.split(',');
      input.value = parts.pop();
      parts.forEach(addTerm);
    }
  });
  // Clicking the padding around the chips focuses the text input.
  field.addEventListener('click', e => { if (e.target === field) input.focus(); });

  field.appendChild(input);
  (initial || []).forEach(addTerm);
  host.appendChild(field);

  return {
    getChips() { commitPending(); return chips.slice(); },
    clear() { chips.length = 0; input.value = ''; renderChips(); },
    focus() { input.focus(); },
  };
}

// ── YouTube IFrame API ────────────────────────────────────────────────────────

let _ytApiPromise = null;

function loadYtApi() {
  if (_ytApiPromise) return _ytApiPromise;
  _ytApiPromise = new Promise(resolve => {
    if (window.YT && window.YT.Player) { resolve(); return; }
    window.onYouTubeIframeAPIReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return _ytApiPromise;
}

// ── Feed item filtering ───────────────────────────────────────────────────────

// filterFeedItems / filterTweetItems / filterSubstackItems now live in lib/pure.js (imported at
// the top of this file). They are pure functions of (items, channel, hiddenSet), and the
// keyword → lookback → hidden order they share is a correctness invariant — so they belong
// where node:test can reach them, alongside the rest of the extracted helpers.

// Merge freshly-fetched tweets into the cached set: dedupe by id, drop anything older than
// the 14-day window, sort newest-first. Keeps the cache bounded and the since_id cursor
// (cache[0].id) correct.
function mergeTweets(fresh, cached) {
  const byId = new Map();
  for (const t of cached) byId.set(t.id, t);
  for (const t of fresh)  byId.set(t.id, t);
  const cutoff = Date.now() - GROUP_WINDOW_MS;
  return [...byId.values()]
    .filter(t => { const ms = Date.parse(t.published); return !Number.isNaN(ms) && ms >= cutoff; })
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
}

// ── Feed loading ──────────────────────────────────────────────────────────────

async function loadFeed() {
  const channels = getChannels();
  // Hide items the user already handled: done (read) ∪ archived (saved for later).
  const hiddenSet = new Set([...getDoneSet(), ...getArchiveSet()]);
  const items    = [];
  const failed   = [];
  const cappedNames = []; // X accounts whose refresh hit the page cap (older posts skipped)
  // Why NEW X posts stopped arriving, when they did. Not a failure — the cached posts
  // below still render — so this is deliberately separate from `failed`, which carries the one
  // condition a retry can actually fix.
  const limited = { quota: false, cap: false };
  // SK.shorts: 'true'/null = include (default), 'false' = hide.
  const hideShorts = localStorage.getItem(SK.shorts) === 'false' ? '1' : '0';

  await Promise.all(channels.map(async ch => {
    try {
      if (ch.source === 'twitter') {
        await loadTwitterChannel(ch, hiddenSet, items, cappedNames, limited);
      } else if (ch.source === 'substack') {
        const r = await fetch(`/api/feed?source=substack&sourceId=${encodeURIComponent(ch.id)}`);
        if (!r.ok) { failed.push(ch.name); return; }
        const data = await r.json();
        items.push(...filterSubstackItems(data.items || [], ch, hiddenSet));
      } else {
        const r = await fetch(`/api/feed?channelId=${encodeURIComponent(ch.id)}&hideShorts=${hideShorts}`);
        if (!r.ok) { failed.push(ch.name); return; }
        const data = await r.json();
        items.push(...filterFeedItems(data.items || [], ch, hiddenSet));
      }
    } catch { failed.push(ch.name); }
  }));

  items.sort((a, b) => new Date(b.published) - new Date(a.published));

  // Tag videos that arrived since the feed was last loaded, so they get a "New"
  // badge. First-ever load has no baseline (null) → nothing is marked New.
  const lastLoad = getLastFeedLoad();
  items.forEach(it => {
    it.isNew = lastLoad != null && new Date(it.published).getTime() > lastLoad;
  });

  return { items, failed, cappedNames, limited, totalChannels: channels.length };
}

// One X channel's contribution to the feed: fetch only what's new (since_id = newest cached
// id), merge into the client cache, then apply keyword + done filters. Throws on a fetch
// failure so loadFeed marks the channel as failed.
async function loadTwitterChannel(ch, hiddenSet, items, cappedNames, limited) {
  const cache  = getTweetCache();
  const cached = cache[ch.id] || [];
  const sinceId = cached.length
    ? cached.map(t => t.id).reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a))
    : null;

  const qs = new URLSearchParams({ source: 'twitter', sourceId: ch.id });
  if (sinceId) qs.set('sinceId', sinceId);
  const r = await fetch(`/api/feed?${qs}`);
  if (!r.ok) {
    // A per-user quota (429) and an app-wide cap (502 + reason) are NOT failures — they mean "no new
    // posts right now", and the cached ones still belong in the feed. Only an untagged failure earns
    // "Couldn't load … try reopening", because only that one can clear on a retry. Sending a capped
    // user back to retry is what spends the money.
    const reason = (await r.json().catch(() => null))?.reason;
    if (limited && (reason === 'quota' || reason === 'cap')) {
      limited[reason] = true;
      items.push(...filterTweetItems(cached, ch, hiddenSet));
      return;
    }
    throw new Error('twitter feed failed');
  }
  const data = await r.json();
  if (data.capped) cappedNames.push('@' + (ch.handle || ch.name)); // skip-note

  const merged = mergeTweets(data.items || [], cached);
  // RE-READ before writing. `cache` above was read BEFORE the fetch await, and loadFeed
  // runs channels through Promise.all — so every parallel channel would write back a snapshot taken
  // before any of them finished, and the last writer would silently drop the rest. Measured: two
  // channels, only the second one's entry survived. There is no await between this read and the
  // write and JS is single-threaded, so this read-modify-write is atomic.
  //
  // A lost entry costs more than
  // a redundant first fetch (and the X reads that go with it): the cache is
  // load-bearing for what is DISPLAYED, so at quota a clobbered channel contributes nothing.
  const store = getTweetCache();
  store[ch.id] = merged;
  saveTweetCache(store);
  items.push(...filterTweetItems(merged, ch, hiddenSet));
}

// ── Card rendering ────────────────────────────────────────────────────────────

function checkIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
}

// Bookmark outline — the Archive ("save for later") affordance on feed cards.
function bookmarkIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
}

// X — the "remove from archive" (un-archive) affordance in the Archive view.
function xIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
}

// A card's action row depends on context: in the feed you Done or Archive an item; in the
// Archive you Done it (leaves both) or Remove it (un-archive → back to feed).
function cardActionsHtml(context) {
  const done = `<button class="btn-done">${checkIcon()} Done</button>`;
  const second = context === 'archive'
    ? `<button class="btn-archive" aria-label="Remove from archive">${xIcon()} Remove</button>`
    : `<button class="btn-archive" aria-label="Archive for later">${bookmarkIcon()} Archive</button>`;
  return `${done}\n      ${second}`;
}

function wireCardActions(card, item, id, context) {
  if (context === 'archive') {
    card.querySelector('.btn-done').addEventListener('click', () => markDoneFromArchive(card, id));
    card.querySelector('.btn-archive').addEventListener('click', () => removeFromArchive(card, id));
  } else if (context === 'group') {
    // Drill-in: Done/Archive reconcile against the group, not the stream.
    card.querySelector('.btn-done').addEventListener('click', () => markDoneInGroup(card, id, item));
    card.querySelector('.btn-archive').addEventListener('click', () => archiveInGroup(card, item));
  } else {
    card.querySelector('.btn-done').addEventListener('click', () => markDone(card, id, item));
    card.querySelector('.btn-archive').addEventListener('click', () => archiveItem(card, item));
  }
}

// RENDER-ONLY, and that is a hard property rather than a description.
// Its output must never reach `saveChannels`: a version that falls through to `ch.id`
// MATCHES migrateChannelNames' broken-name regex `/^UC[\w-]{22}$/` — so the repair would be persisted
// and re-pushed on every boot, forever. `ch.id` is therefore deliberately absent from the chain.
//
// Precedence is name → title → 'Channel'. Inverting the first two shows the wrong name for every
// channel carrying both; an empty final fallback renders a blank row and a blank
// avatar letter.
function channelName(ch) {
  const c = ch || {};
  if (typeof c.name === 'string' && c.name) return c.name;
  if (typeof c.title === 'string' && c.title) return c.title;
  return 'Channel';
}

// TOTAL — it must not throw for ANY argument, including undefined. Two live defects came through
// here: a channel with no `name` (well-formed JSON, no corruption at all) killed the setup render
// via `avatarColor(str).length`, and an archived item carrying no channel at all killed the archive
// render via `channel.color`. Both
// escaped init() and blanked or half-rendered the boot.
function avatarHtml(channel) {
  const ch = channel || {};
  const name = channelName(ch);
  const color = ch.color || avatarColor(name);
  const letter = esc(name.charAt(0).toUpperCase());
  const img = ch.avatarUrl
    ? `<img src="${esc(ch.avatarUrl)}" alt="${esc(name)}">`
    : '';
  // Letter sits behind the image; if the remote avatar fails to load, it shows through
  // instead of a broken-image icon.
  return `<div class="avatar" style="background:${esc(color)}">${letter}${img}</div>`;
}

function renderCard(item, context = 'feed') {
  const { videoId, title, published, channel, isNew } = item;
  const thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const div = document.createElement('div');
  div.className = 'card';
  div.dataset.videoId = videoId;
  div.dataset.id = videoId; // uniform done-key across sources, for bulk mark-all
  div.dataset.published = published; // used to re-insert chronologically on un-archive

  div.innerHTML = `
    <div class="chan">
      ${avatarHtml(channel)}
      <div>
        <div class="chan-name">${esc(channelName(channel))}</div>
        <div class="chan-meta">${esc(timeAgo(published))}</div>
      </div>
      ${isNew ? `<span class="new-badge">New</span>` : ''}    </div>
    <div class="media" data-video-id="${esc(videoId)}">
      <div class="thumb">
        <img src="${esc(thumb)}" alt="${esc(title)}" loading="lazy">
        <div class="play-overlay">
          <button class="play-btn" aria-label="Play video">
            <svg viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
          </button>
        </div>
      </div>
      <div class="player-wrap"></div>
    </div>
    <div class="video-title">${esc(title)}</div>
    <div class="actions">
      ${cardActionsHtml(context)}
    </div>
  `;

  div.querySelector('.media').addEventListener('click', e => {
    if (e.target.closest('.btn-yt-link')) return; // let the link through
    track('video_play', {}, context);
    playInApp(div, videoId);
  });
  wireCardActions(div, item, videoId, context);

  return div;
}

// Build a tweet card. Mirrors renderCard (video card): same .card shell + .chan header
// + Done button, but the body inverts — the post text is the hero, media is optional, and
// there's no player (read-only). Reuses avatarHtml()/checkIcon(); Done runs the same
// markDone() as videos. Tweet feed item shape (normalized server-side in the API slice):
//   { source:'twitter', id, text, published, imageUrl, url, channel, isNew }
//   channel: { id, name, handle, keyword, color, avatarUrl, source:'twitter', addedAt? }

// Escape tweet text, then linkify real URLs: swap each t.co `short` for an anchor to its
// `expanded` URL, labelled with the pretty `display`. @mentions/#hashtags stay plain text by
// design (we don't send users into X's feeds). XSS-safe: the base is fully escaped, every
// inserted attribute/label is independently esc()'d, and t.co shorts have no HTML-special chars.
function tweetTextHtml(text, urls) {
  let html = esc(text);
  for (const u of urls || []) {
    if (!u || !u.short) continue;
    // An expanded URL that is not http(s) keeps its label and loses the link.
    const href = safeHref(u.expanded);
    const anchor = href
      ? `<a class="tweet-link" target="_blank" rel="noopener" href="${esc(href)}">${esc(u.display)}</a>`
      : esc(u.display);
    html = html.split(esc(u.short)).join(anchor);
  }
  return html;
}

// A quoted (referenced) tweet: a compact read-only card (author + text) linking out to the
// quoted post on X. Text-only by design (quoted media isn't fetched). XSS-safe — every field is
// esc()'d. Absent `quoted` (non-quotes, old cached tweets) → nothing.
function quotedHtml(q) {
  if (!q || !q.author) return '';
  const head = `<span class="quoted-name">${esc(q.author.name)}</span> <span class="quoted-handle">@${esc(q.author.handle)}</span>`;
  const body = q.text ? `<div class="quoted-text">${esc(q.text)}</div>` : '';
  return `<a class="tweet-quoted" href="${esc(q.url)}" target="_blank" rel="noopener"><div class="quoted-head">${head}</div>${body}</a>`;
}

// Clamp an image's aspect ratio to [4/5, 2/1]: portrait shows ~whole (only extreme verticals
// crop), ultra-wide panoramas don't shrink to a sliver. Unknown dims → 4:5 default.
function cropAspect(m, floor = 0.8) {
  if (!m || !m.width || !m.height) return floor;
  return Math.min(2, Math.max(floor, m.width / m.height));
}

// A tweet's media block: nothing / a single capped image / a swipeable carousel (2–4 photos).
function mediaHtml(media) {
  if (!media.length) return '';
  if (media.length === 1) {
    const m = media[0];
    if ((m.type === 'video' || m.type === 'animated_gif') && m.videoUrl) {
      const gif = m.type === 'animated_gif';
      const aspect = cropAspect(m, 9 / 16); // taller floor for video → vertical shown whole
      return `<div class="tweet-media"><video class="tweet-video" muted playsinline preload="metadata"${gif ? ' loop' : ' controls'} poster="${esc(m.url)}" style="aspect-ratio:${aspect}"><source src="${esc(m.videoUrl)}" type="video/mp4"></video></div>`;
    }
    return `<div class="tweet-media"><img src="${esc(m.url)}" alt="" loading="lazy" style="aspect-ratio:${cropAspect(m)}"></div>`;
  }
  const aspect = cropAspect(media[0]); // one uniform viewport across slides (no height jumps)
  const slides = media.map(m => `<img class="tweet-slide" src="${esc(m.url)}" alt="" loading="lazy">`).join('');
  const dots = media.map((_, i) => `<span class="tweet-dot${i === 0 ? ' active' : ''}"></span>`).join('');
  return `<div class="tweet-media-carousel" style="aspect-ratio:${aspect}">${slides}</div><div class="tweet-dots">${dots}</div>`;
}

// Sync the carousel dots to the slide in view (vanilla, no scroll math).
// The selectors are PARAMETERS with the tweet-carousel defaults, so a second caller can reuse the
// mechanism rather than only the function name. They must be DECLARED parameters: passing `'.tc-slide', '.tc-dot'`
// as a third and fourth argument to a two-parameter function is discarded silently by JavaScript — both
// lists come back empty, the observer watches nothing, and the topic card's dots never move.
// Pinned by T20.
// ⚠️ THE TWEET PATH OF THIS FUNCTION IS UNVERIFIED SINCE 1.29.0, and deliberately so. The
// topic rail and the in-tweet photo carousel are this function's two callers, and the
// live-resolution change below was walked on a handset for the RAIL only.
// It is not unit-testable either, which was PROBED rather than assumed:
// the tweet card is built as one `innerHTML` string, so the harness stores it unparsed and
// `.tweet-media-carousel`, `.tweet-slide` and `.tweet-dot` all resolve to 0 nodes.
// The argument for safety is that with nothing removed from a carousel the in-callback query returns
// the identical list in the identical order, and tweet photo slides are never removed — an argument,
// not evidence. The worst case is a wrong active dot. If you are here because a photo carousel's dots
// misbehave, this is your note.
function wireCarouselDots(carousel, dotsEl, slideSel = '.tweet-slide', dotSel = '.tweet-dot') {
  // Resolved INSIDE the callback rather than captured beside the observer. A topic card's rail
  // LOSES a slide whenever a post is done or archived and nothing re-wires, so a
  // captured array went on holding the removed node: `indexOf` returned an index one too high for
  // every slide after it and lit the dot for a post the reader had just cleared — permanently,
  // because scrolling re-ran the same stale lookup. `finishGroupCardAction` trims the dot COUNT
  // correctly, but that does not fix the index. T30.
  // The in-tweet carousel never removes a slide, so this is latent there, not live.
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio >= 0.6) {
        const slides = [...carousel.querySelectorAll(slideSel)];
        const dots = [...dotsEl.querySelectorAll(dotSel)];
        const i = slides.indexOf(e.target);
        dots.forEach((d, j) => d.classList.toggle('active', j === i));
      }
    }
  }, { root: carousel, threshold: 0.6 });
  [...carousel.querySelectorAll(slideSel)].forEach(s => io.observe(s));
}

// One video plays at a time: a shared IntersectionObserver autoplays the most-visible tweet
// video/GIF (muted) and pauses the rest (and any that scroll out).
let _videoObserver = null;
const _videoRatios = new Map();
function ensureVideoObserver() {
  if (_videoObserver) return _videoObserver;
  _videoObserver = new IntersectionObserver(entries => {
    for (const e of entries) _videoRatios.set(e.target, e.isIntersecting ? e.intersectionRatio : 0);
    let top = null, best = 0.5; // must be >50% visible to autoplay
    for (const [v, r] of _videoRatios) if (r > best) { best = r; top = v; }
    for (const [v] of _videoRatios) {
      if (v === top) v.play().catch(() => {});
      else if (!v.paused) v.pause();
    }
  }, { threshold: [0, 0.5, 0.75, 1] });
  return _videoObserver;
}
function registerVideoAutoplay(v) {
  _videoRatios.set(v, 0);
  ensureVideoObserver().observe(v);
}
// Called when the feed re-renders: drop stale video refs so the observer/map don't leak.
function resetVideoAutoplay() {
  if (_videoObserver) _videoObserver.disconnect();
  _videoRatios.clear();
}

function renderTweetCard(item, context = 'feed') {
  const { id, text, published, imageUrl, url, channel, isNew, urls, quoted, media: rawMedia } = item;
  // Migration: old cached tweets carry a single `imageUrl`; new ones carry a `media` array.
  const media = rawMedia ?? (imageUrl ? [{ type: 'photo', url: imageUrl }] : []);

  const div = document.createElement('div');
  div.className = 'card';
  div.dataset.tweetId = id;
  div.dataset.id = id; // uniform done-key across sources, for bulk mark-all
  div.dataset.published = published; // used to re-insert chronologically on un-archive

  div.innerHTML = `
    <div class="chan">
      ${avatarHtml(channel)}
      <div class="tweet-id">
        <span class="chan-name">${esc(channelName(channel))}</span>
        <span class="chan-meta">@${esc((channel && channel.handle) || '')} · ${esc(timeAgo(published))}</span>
      </div>
      ${isNew ? `<span class="new-badge">New</span>` : ''}      <a class="tweet-x" href="${esc(url)}" target="_blank" rel="noopener" aria-label="View on X">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2H22l-7.3 8.3L23 22h-6.6l-5.2-6.8L5.3 22H2.2l7.8-8.9L1.6 2h6.8l4.7 6.2L18.9 2Zm-1.2 18h1.8L7.4 3.9H5.5L17.7 20Z"/></svg>
      </a>
    </div>
    <div class="tweet-text">${tweetTextHtml(text, urls)}</div>
    ${mediaHtml(media)}
    ${quotedHtml(quoted)}
    <div class="actions">
      ${cardActionsHtml(context)}
    </div>
  `;

  const carousel = div.querySelector('.tweet-media-carousel');
  if (carousel) wireCarouselDots(carousel, div.querySelector('.tweet-dots'));
  const video = div.querySelector('.tweet-video');
  if (video) registerVideoAutoplay(video);
  wireCardActions(div, item, id, context);
  return div;
}

// The Substack "S" mark — the read-out affordance on a Substack card (brand-recognizable).
function substackIcon() {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z"/></svg>`;
}

// Full post bodies fetched by the reader, keyed by post URL. Re-rendering the feed
// recreates cards, so this in-memory cache keeps re-expanding a post instant within a session.
const _substackBodyCache = new Map(); // url → { html, paywalled }

async function fetchSubstackBody(url) {
  if (_substackBodyCache.has(url)) return _substackBodyCache.get(url);
  try {
    const r = await fetch(`/api/substack-post?url=${encodeURIComponent(url)}`);
    if (!r.ok) return null;
    const data = await r.json();
    _substackBodyCache.set(url, data);
    return data;
  } catch {
    return null;
  }
}

// Substack post card (with an inline reader). Reuses the .card shell + .chan header. Collapsed,
// it shows the title, subtitle, and one preview paragraph; "…read more" lazily fetches the full
// post (sanitised server-side) and expands it inline. Paywalled posts show the free preview + a
// link out. Item shape: { source:'substack', id, title, subtitle, url, author, published, preview,
// channel, isNew }.
function renderSubstackCard(item, context = 'feed') {
  const { id, title, subtitle, url, author, published, preview, cover, channel, isNew } = item;
  // The feed chooses `url`; a scheme other than http(s) gets no link — a plain title, no "S" icon.
  const href = safeHref(url);

  const div = document.createElement('div');
  div.className = 'card';
  div.dataset.id = id; // uniform done-key across sources, for bulk mark-all
  div.dataset.published = published; // used to re-insert chronologically on un-archive

  div.innerHTML = `
    <div class="chan">
      ${avatarHtml(channel)}
      <div class="tweet-id">
        <span class="chan-name">${esc(channelName(channel))}</span>
        <span class="chan-meta">${author ? esc(author) + ' · ' : ''}${esc(timeAgo(published))}</span>
      </div>
      ${isNew ? `<span class="new-badge">New</span>` : ''}
      ${href ? `<a class="tweet-x substack-link" href="${esc(href)}" target="_blank" rel="noopener" aria-label="Read on Substack">
        ${substackIcon()}
      </a>` : ''}
    </div>
    ${href ? `<a class="substack-title" href="${esc(href)}" target="_blank" rel="noopener">${esc(title)}</a>`
      : `<span class="substack-title">${esc(title)}</span>`}
    ${subtitle ? `<div class="substack-sub">${esc(subtitle)}</div>` : ''}
    ${cover ? `<img class="substack-cover" src="${esc(cover)}" alt="" loading="lazy">` : ''}
    <div class="substack-reader">
      ${preview ? `<p class="substack-preview">${esc(preview)}</p>` : ''}
      <div class="substack-body" hidden></div>
      <div class="substack-readout" hidden></div>
      <button class="substack-more" type="button" aria-expanded="false">…read more</button>
    </div>
    <div class="actions">
      ${cardActionsHtml(context)}
    </div>
  `;
  wireCardActions(div, item, id, context);
  div.querySelector('.substack-more').addEventListener('click', () => toggleSubstackReader(div, url));
  return div;
}

// Expand/collapse a Substack card's in-app reader. First expand lazily fetches + injects the
// sanitised full post; later toggles are instant. The body HTML is sanitised server-side
// (api/_sanitize.js), so injecting it via innerHTML here is the trusted path.
async function toggleSubstackReader(card, url) {
  const btn      = card.querySelector('.substack-more');
  const body     = card.querySelector('.substack-body');
  const readout  = card.querySelector('.substack-readout');
  const preview  = card.querySelector('.substack-preview');
  const cover    = card.querySelector('.substack-cover');
  const expanded = btn.getAttribute('aria-expanded') === 'true';

  const reveal = show => {
    if (preview) preview.hidden = show;      // hide the teaser once the full body is shown
    if (cover) cover.hidden = show;          // the full article already leads with this image
    body.hidden = !show;
    readout.hidden = !show;
    btn.textContent = show ? 'Show less' : '…read more';
    btn.setAttribute('aria-expanded', show ? 'true' : 'false');
  };

  if (expanded) { reveal(false); return; }
  track('reader_open', {}, 'reader');

  if (!body.dataset.loaded) {
    btn.disabled = true;
    btn.textContent = 'loading…';
    const data = await fetchSubstackBody(url);
    btn.disabled = false;

    // Only an http(s) `url` becomes a link out. Otherwise each branch keeps its explanation, loses the text that
    // only existed to link out ("Read on Substack →", "Open on Substack →") and drops the anchor.
    const href = safeHref(url);
    const readoutLink = (data && data.paywalled)
      ? (href ? `🔒 This post is for paid subscribers. <a href="${esc(href)}" target="_blank" rel="noopener">read the rest on Substack →</a>`
        : '🔒 This post is for paid subscribers.')
      : (href ? `<a href="${esc(href)}" target="_blank" rel="noopener">Read on Substack →</a>` : '');

    if (!data || data.html == null) {
      // Couldn't read the body (fetch failed, or a paywalled post with no extractable preview) —
      // keep the teaser, retire the button, and just link out.
      readout.innerHTML = `<div class="substack-readout-link">${
        data && data.paywalled ? readoutLink
        : href ? `<a href="${esc(href)}" target="_blank" rel="noopener">Couldn’t load the full post. Open on Substack →</a>`
        : 'Couldn’t load the full post.'
      }</div>`;
      readout.hidden = false;
      btn.hidden = true;
      return;
    }

    body.innerHTML = data.html; // trusted: sanitised server-side
    readout.innerHTML = `<div class="substack-readout-link">${readoutLink}</div>`;
    body.dataset.loaded = '1';
  }

  reveal(true);
}

// Source-aware card dispatch: the feed & archive interleave YouTube videos, X tweets, and
// Substack posts, each with its own renderer. Uses the item's own `source`, or its channel's
// source for freshly-loaded feed items.
function renderItemCard(item, context = 'feed') {
  const source = item.source || (item.channel && item.channel.source) || 'youtube';
  if (source === 'twitter')  return renderTweetCard(item, context);
  if (source === 'substack') return renderSubstackCard(item, context);
  return renderCard(item, context);
}

// ── In-app player ─────────────────────────────────────────────────────────────

async function playInApp(card, videoId) {
  const media = card.querySelector('.media');
  if (media.classList.contains('playing')) return;

  const playerWrap = media.querySelector('.player-wrap');
  media.classList.add('playing');

  await loadYtApi();

  const containerId = `yt-${videoId}-${Date.now()}`;
  const container = document.createElement('div');
  container.id = containerId;
  playerWrap.appendChild(container);

  new YT.Player(containerId, {
    videoId,
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onError() {
        showEmbedFallback(card, videoId);
      },
    },
  });
}

function showEmbedFallback(card, videoId) {
  const media = card.querySelector('.media');
  const playerWrap = media.querySelector('.player-wrap');
  playerWrap.innerHTML = '';
  media.classList.remove('playing');
  media.querySelector('.thumb').style.display = 'none';
  media.style.cursor = 'default';
  media.onclick = null;

  const fallback = document.createElement('div');
  fallback.className = 'embed-fallback';
  fallback.innerHTML = `
    <p class="embed-note">Can't be played in SousChef</p>
    <a class="btn-yt-link" href="https://www.youtube.com/watch?v=${esc(videoId)}" target="_blank" rel="noopener noreferrer">Open in YouTube</a>
  `;
  media.appendChild(fallback);
}

// ── Mark done ─────────────────────────────────────────────────────────────────

// Slide a card out with the removal animation, then run onDone (count / empty-state update).
// Shared by the feed (Done, Archive) and the Archive view (Done, Remove).
function slideOutCard(card, onDone) {
  card.classList.add('removing');
  setTimeout(() => { card.remove(); onDone(); }, 320);
}

function markDone(card, id, item) {
  if (blockedByDamage()) return;
  addDone(id);
  track('mark_done', {}, 'feed');
  slideOutCard(card, () => { updateCount(); checkEmpty(); });
  // Undo: un-mark and re-insert just this card at its chronological spot (no full-feed reload).
  showToast('Marked done', 'Undo', () => { removeDone([id]); if (item) insertIntoFeed(item); });
}

// Snapshot a feed item into the archive: keep the whole item (it already holds everything a
// card needs) plus a normalized `id`, its `source`, and `archivedAt` — so the Archive view
// re-renders with the existing card renderers, no re-fetch.
function toArchiveItem(item) {
  const source = item.source || item.channel?.source || 'youtube';
  const id = item.id ?? item.videoId;
  return { ...item, id, source, isNew: false, archivedAt: Date.now() };
}

function archiveItem(card, item) {
  if (blockedByDamage()) return;
  addArchive(toArchiveItem(item));
  track('archive', {}, 'feed');
  slideOutCard(card, () => { updateCount(); checkEmpty(); });
}

// ── Archive-view card actions ──
// From the Archive: Done marks it read AND drops it from the archive (leaves both); Remove
// un-archives it → it reappears in the feed immediately (re-inserted chronologically).
function markDoneFromArchive(card, id) {
  if (blockedByDamage()) return;
  addDone(id);
  removeArchive(id);
  slideOutCard(card, updateArchiveState);
}
function removeFromArchive(card, id) {
  if (blockedByDamage()) return;
  const item = getArchive().find(it => it.id === id);
  removeArchive(id);
  if (item) insertIntoFeed(item); // reappears in the feed immediately — no refresh needed
  slideOutCard(card, updateArchiveState);
}

// Re-insert an un-archived item into the feed at its chronological spot (newest-first). The
// archive stored the whole item, so we just re-render it as a feed card. If the feed was empty
// (caught up), un-hide it.
function insertIntoFeed(item) {
  const feedEl = document.getElementById('feed');
  // Under hide-not-remove a card for this post may ALREADY be in the stream —
  // HIDDEN — because the assignment OUTLIVES the archive: `pruneGroupState` rule 1 only fires at the
  // next `syncGroupPrune`, which runs from `renderFeedResults`, and no path from archiving to
  // un-archiving triggers a feed render. Appending without checking puts the post in two places at
  // once: measured `#feed` ids [x1, x2, x1], badge "5 new" over two real posts.
  //
  // `document.querySelector` with an `#id` root, NOT `feedEl.querySelector`: the element-scoped
  // version answers a memoised PHANTOM for any selector, so `if (existing)` would be permanently true
  // in tests and this guard would pin nothing.
  const dup = document.querySelector(`#feed .card[data-id="${CSS.escape(item.id)}"]`);
  if (dup) dup.remove();
  const card = renderItemCard(item, 'feed');
  const ts = Date.parse(item.published);
  const older = [...feedEl.querySelectorAll('.card')].find(c => Date.parse(c.dataset.published) < ts);
  if (older) feedEl.insertBefore(card, older);
  else feedEl.appendChild(card);
  feedEl.style.display = '';
  document.getElementById('caughtup').classList.add('hidden');
  // Place it correctly for the CURRENT view, and repaint the grid — the post re-entering its topic
  // changes what that tile owns, and nothing else here would have refreshed the count.
  setGroupedCardsHidden();
  renderTopicCards();
  updateCount();
}
function updateArchiveState() {
  const remaining = document.querySelectorAll('#archive-feed .card:not(.removing)').length;
  document.getElementById('archive-count').textContent = remaining ? `${remaining} saved` : '';
  if (remaining === 0) {
    document.getElementById('archive-feed').style.display = 'none';
    document.getElementById('archive-empty').classList.remove('hidden');
  }
}

// Is the reader actually looking at the feed surface?
//
// ASKED HERE, at the one place that REVEALS the bulk control, rather than at each way in — which is
// the whole point. Guarding one caller at a time always misses another: `showView`
// is 1 of TEN `updateCount()` call sites, and several run while the reader is on
// Archive (the classify tail, un-archiving a card) or on the load-error screen (`applyGroupView`).
// The drawer is body-level and opens
// from the Archive gear, so an off-feed reveal is TAPPABLE. T35/T36.
//
// In one stream a topic
// card IS a feed card: `#feed` never hides to show one, so no term for an open topic is needed.
//
// NOT phrased with `_lastFeedItems`: it is tempting to believe it is null
// "only before the first feed render", but BOTH early returns in `renderFeedResults` precede the
// assignment, so a caught-up boot and a failed boot leave it null as well. It distinguishes neither
// case. The DOM already knows the answer; asking it removes the dependence on a false premise.
function feedSurfaceShowing() {
  if (document.getElementById('view-feed')?.classList.contains('hidden')) return false;
  // ⚠️ This term fails OPEN on a missing element (`!undefined` is true) where the one above fails
  // closed. Unreachable today — T11 asserts every id app.js reaches for exists — and left as-is
  // rather than "fixed" blind, but the asymmetry is what would bite after a markup rename.
  return document.getElementById('feed')?.style.display !== 'none';
}

function updateCount() {
  // Lift-out: unread = chronological-stream cards + posts sitting in the bundle grid.
  const remaining = document.querySelectorAll('#feed .card:not(.removing):not(.grouped-out)').length + countGroupedUnread();
  const el = document.getElementById('feed-count');
  if (el) el.textContent = remaining === 0 ? '' : `${remaining} new`;
  // Mark-all-done is only meaningful with items still to clear.
  const markAll = document.getElementById('btn-mark-all');
  // SCOPED TO THE REVEAL. An early return here would guard the BADGE too, and that remains blocked:
  // 12 tests in TWO files (`group-toggle`, `group-defer-lift`) assert badge values while rendering
  // into a hidden feed view. Those 12 tests block only the `applyGroupView` gap;
  // the `showView` return path is covered by one term in
  // `showView`.
  if (markAll) markAll.classList.toggle('hidden', remaining === 0 || !feedSurfaceShowing());
  updateSectionHeads();
}

function checkEmpty() {
  // Caught up only when BOTH the stream and the grid are empty (lift-out).
  const remaining = document.querySelectorAll('#feed .card:not(.removing):not(.grouped-out)').length + countGroupedUnread();
  if (remaining === 0) showCaughtUp();
}

function showCaughtUp() {
  document.getElementById('feed').style.display = 'none';
  document.getElementById('feed-count').textContent = 'all caught up ✓';
  document.getElementById('btn-mark-all')?.classList.add('hidden');
  document.getElementById('caughtup').classList.remove('hidden');
  updateSectionHeads();
  renderArchiveNudge();
}

// On the caught-up screen, offer a shortcut into the Archive when it's non-empty.
function renderArchiveNudge() {
  const el = document.getElementById('archive-nudge');
  if (!el) return;
  const n = getArchive().length;
  if (n === 0) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = `${n} more in archive →`;
  el.classList.remove('hidden');
}

// ── Mark all as done ──
// One tap marks every item currently in the feed as done and drops to the caught-up screen,
// with an Undo. The cards aren't destroyed (showCaughtUp only hides #feed), so Undo just
// removes the ids from the done set and reveals them again.
let _bulkDoneIds = null;
function markAllDone() {
  if (blockedByDamage()) return;
  // Everything unread = chronological-stream cards + grouped posts in the grid (lift-out).
  const streamIds = [...document.querySelectorAll('#feed .card:not(.removing)')]
    .map(c => c.dataset.id).filter(Boolean);
  // `groupedUnreadIds()`, NOT `visibleGroupedUnreadIds()`. This is a WRITE answering "clear
  // everything the account holds", so it must not inherit the display's per-device filter: a grouped
  // post this device did not fetch has no stream card either, so a filtered set leaves it in NEITHER
  // half of this union and Mark-all silently skips it.
  const ids = [...new Set([...streamIds, ...groupedUnreadIds()])];
  if (ids.length === 0) return;
  track('mark_all_done', { count: ids.length }, 'feed');
  ids.forEach(addDone);
  _bulkDoneIds = ids;
  // The control lives in the Settings drawer, so tapping it leaves the reader
  // looking at a drawer while the whole screen behind it becomes the caught-up state they just
  // created. Close it first.
  //
  // This call is a UX decision, not a safety one. A toast raised with the drawer open is NOT
  // painted behind it: `.toast` has z-index 62 precisely so it clears the drawer (61)
  // AND its scrim (60). Measured live with the drawer open:
  // `elementFromPoint` over the Undo button returns `.toast-action` — it is reachable.
  //
  // `closeProfile` may itself raise the sync-paused notice, which this toast then replaces —
  // acceptable, because that notice is a STATE re-shown on every drawer close, not a lost event.
  closeProfile();
  renderTopicCards(); // grouped posts are now done → their topic cards go with them
  showCaughtUp();
  showToast(`Marked ${ids.length} as done`, 'Undo', undoMarkAll);
  // NO REPRISE HERE, and that is a measured decision rather than an omission.
  // `closeProfile()` above raises the sync notice when halted and the line above
  // replaces it within a millisecond, which looks like a message being eaten. It is not: `pushNow`
  // already re-shows the notice before its halted early-return, `addDone` schedules a push, and the
  // debounce is 1500ms. Measured timeline for a halted reader tapping this control: warning at 0
  // (invisible), "Marked N as done" at 0, warning again at ~1500, ~3000, and every push after.
  // The warning is not lost; it is REPEATED. A reprise would add a fourth showing of a notice that
  // already returns three times.
  //
  // ⚠️ A KNOWN DEFECT, not fixed here: that 1500ms
  // push destroys the UNDO. A halted reader gets ~1.5s to take back marking their whole feed read,
  // not the 5s everyone else gets (the push path does it wherever the
  // control lives).
}
function undoMarkAll() {
  if (!_bulkDoneIds) return;
  removeDone(_bulkDoneIds);
  _bulkDoneIds = null;
  document.getElementById('caughtup').classList.add('hidden');
  document.getElementById('feed').style.display = '';
  renderTopicCards(); // grouped posts return to their topic cards
  updateCount();     // re-reveals the Mark-all-done button
}

// ── Toast ── minimal reusable notice with one optional action; auto-hides.
let _toastTimer = null;
function showToast(msg, actionLabel, onAction, duration = 5000, { wrap = false } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(_toastTimer);
  // Opt-in, and toggled on EVERY call rather than only when true: the toast element is reused, so a
  // wrapping notice would otherwise leave the next ordinary toast wrapped behind it.
  el.classList.toggle('toast-wrap', !!wrap);
  el.querySelector('.toast-msg').textContent = msg;
  const btn = el.querySelector('.toast-action');
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.classList.remove('hidden');
    // Run the action BEFORE hiding: hideToast() clears any pending undo state, so hiding
    // first would make the action a no-op (this bit the Undo path in verification).
    // A rejecting action must not escape. This ran the action
    // bare, so an async handler that threw became an UNHANDLED rejection and the toast hid as though
    // it had worked — which is how a destroyed channel and a silent no-op became indistinguishable.
    // Deliberately still NOT awaited before hideToast(): the comment below is load-bearing, and
    // awaiting here would reintroduce the Undo no-op it describes.
    btn.onclick = () => {
      try {
        const r = onAction && onAction();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch { /* a synchronous throw is handled the same way: the toast still closes */ }
      hideToast();
    };
  } else {
    btn.classList.add('hidden');
    btn.onclick = null;
  }
  el.classList.add('show');
  _toastTimer = setTimeout(hideToast, duration);
}
function hideToast() {
  clearTimeout(_toastTimer);
  document.getElementById('toast')?.classList.remove('show');
  _bulkDoneIds = null; // the Undo window closes when the toast goes away
}

function renderFeedError(failed) {
  const el = document.getElementById('feed-error');
  if (!failed || failed.length === 0) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = `Couldn't load: ${failed.join(', ')}. Try reopening the feed.`;
  el.classList.remove('hidden');
}

function showLoadError(failed) {
  document.getElementById('feed').style.display = 'none';
  document.getElementById('feed-count').textContent = '';
  document.getElementById('caughtup').classList.add('hidden');
  // This screen leaves the
  // previous render's cards in the DOM, so a bulk control sitting over it would be live — one tap marks
  // those stale cards done, paints a done-state we explicitly refuse to claim two lines above, and
  // syncs it. `showView`'s gate (T30/T31) only covers a reader who navigates away and back; a reader
  // who just sits here would still be offered it. Hidden at the screen that owns the state rather than at
  // the three drawer openers, same reason `showView` hides there rather than in each opener.
  document.getElementById('btn-mark-all')?.classList.add('hidden');
  renderFeedError(failed);
}

// The neutral source-unavailable line — ONE constant with TWO callers:
// the app-wide cap below, and the empty-cache fallback in renderFeedResults. They must read
// IDENTICALLY, because a distinct string is a tell: two states that both mean "no new X right now,
// through no fault of yours" should be indistinguishable, or a reader comparing notes with a friend
// learns exactly what we chose not to tell them. Two copies of a sentence drift; one cannot.
const X_UNAVAILABLE_NOTE = 'X is catching its breath — your other sources are still updating.';

// A subtle notice when an X account's refresh hit the page cap — some older new posts were
// skipped to keep the feed bounded/finishable. Mirrors renderFeedError; called on
// every render so a stale note clears.
function setFeedNote(text) {
  const el = document.getElementById('feed-note');
  if (!el) return;
  if (!text) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden');
}

function renderFeedNote(cappedNames, limited) {
  // PRECEDENCE. An app-wide cap
  // outranks the skip-note. The per-user fuse does not compete for this line at all: it
  // is SILENT, because telling a reader about a daily allowance they have no
  // way to lift, on a product with nothing to sell, reads as a paywall tease. It speaks in exactly
  // one place — the empty-cache fallback in renderFeedResults, which can fire only when the screen
  // would otherwise be blank. Neither message may suggest a retry: the retry is the
  // expensive part.
  let text = '';
  if (limited?.cap) text = X_UNAVAILABLE_NOTE;
  else if (cappedNames?.length) text = `Some older posts from ${cappedNames.join(', ')} were skipped to keep your feed finishable.`;
  setFeedNote(text);
}

// ── Views ─────────────────────────────────────────────────────────────────────

// The colour for the screen being shown — the sign-in wall always light, every other screen the
// stored choice, else light (themeForView). Called from showView, after its signed-out coercion, so the
// wall can never be shown dark. The read is guarded because showView decides whether the app is reachable
// at all, and a colour must never be what stops a screen showing: unreadable storage reads as no choice.
// It also sets the drawer's Light/Dark highlight, which wireApp paints from whatever was on <html> when it
// ran — before any view was chosen, so on the first boot after signing in it would show Light over Dark.
function applyTheme(viewId) {
  let stored = null;
  try { stored = localStorage.getItem(SK.theme); } catch { /* no readable choice → light */ }
  const t = themeForView(viewId, stored);
  document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('is-active', b.dataset.theme === t));
}

function showView(id) {
  // Second layer behind wireApp(). Nothing should be able to call this while
  // signed out — but "nothing should be able to" is not a guarantee.
  // Coerce rather than return: a bare return would leave NO view showing at all if a future change
  // to the boot decision ever routed a signed-out visitor here, and 'view-landing' is absent from
  // both maps below, so this records neither a lastView nor a `view` event.
  if (!_authEmail && id !== 'view-landing') id = 'view-landing';

  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  applyTheme(id);
  // Here rather than at each caller so a future fifth entry point inherits it, and
  // because "the store is damaged" is a property of the STORE, not of the screen you arrived from.
  renderDamagedNotice();

  // Bottom nav is shown on the feed-side views (Feed / Archive), hidden on setup.
  const nav = document.getElementById('bottom-nav');
  const feedSide = id === 'view-feed' || id === 'view-archive';
  nav.classList.toggle('hidden', !feedSide);
  if (feedSide) nav.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === id));

  // The Settings drawer is BODY-LEVEL and reachable from three gears (setup, feed,
  // archive), so "Mark all done" inside it is a feed-only bulk write firable from screens
  // where the feed is not even showing: open Archive, tap the gear, and one tap marks the whole
  // unread feed read behind a hidden view.
  // Hidden HERE rather than in each opener, so a future fourth entry point inherits the rule.
  //
  // ONE-WAY ON PURPOSE — `add`, never `toggle`. `classList.toggle(cls, cond)` also REVEALS when the
  // condition is false, and `showView` runs BEFORE any feed state exists, so a two-way version
  // un-hides the control on every entry to the feed regardless of whether there is anything to mark.
  // Three reachable paths, each measured: the bottom-nav Feed tab is `else showView('view-feed')` with no re-render by
  // design, so it reveals the button over the caught-up screen — where the cards are still in the
  // DOM, so a tap raises a real "Marked N as done" whose UNDO then un-marks posts the reader had
  // already finished; a total feed-load failure returns early from `renderFeedResults` before either
  // counter runs, so a tap marks stored assignments read, paints "all caught up" over a feed that
  // never loaded, and SYNCS that to every device; and the window between here and `loadFeed()`
  // resolving on every boot.
  if (id !== 'view-feed') {
    document.getElementById('btn-mark-all')?.classList.add('hidden');
  } else if (document.getElementById('feed')?.style.display !== 'none') {
    // …and RESTORE it on the way back, from the unread count rather than from the fact of arriving.
    // The one-way `add` above is right for leaving and is not enough on its own: the Feed nav tab
    // is `else showView('view-feed')` with NO re-render by design, so without this `updateCount` — the
    // thing that decides this — never runs on that path and the control stays gone until the next feed load.
    //
    // THE GATE ASKS WHETHER THE FEED IS SHOWING, not whether the caught-up screen is hidden
    // (pinned by T30/T31). "#caughtup is hidden" is also true when nothing has rendered AT ALL, which
    // would re-open the two paths the one-way `add` above closes:
    //
    //   • COLD BOOT. `openFeedView` calls `showView('view-feed')` before `await loadFeed()`. With no
    //     render yet, `updateCount` counts zero cards PLUS `countGroupedUnread()` — and
    //     `inHandGroupableIds()` returns null ("do not filter") while `_lastFeedItems === null`, so
    //     that term is the count of PERSISTED assignments. The control would appear over an empty screen
    //     and one tap would mark every grouped post the account holds, synced everywhere.
    //   • LOAD FAILURE. `showLoadError` blanks the badge and hides `#feed` but leaves the previous
    //     render's cards in the DOM, so `updateCount` would count STALE cards and repaint "N new" over
    //     "couldn't load your feed".
    //
    // ⚠️ THIS GATE IS NOT REDUNDANT, though it looks it:
    // `feedSurfaceShowing()` inside `updateCount` covers the CONTROL from every
    // caller, but `updateCount` also writes the BADGE, which
    // that predicate does not guard, so deleting the gate repaints "2 new" over BOTH the caught-up
    // screen and the load-error screen. T31 and T41 pin both.
    //
    // ONE TERM, not two. `_lastFeedItems` is NOT part of it: it does not separate
    // "have not looked" from "looked and it was empty" — both early returns in
    // `renderFeedResults` precede its assignment, so a caught-up boot and a failed boot both leave it
    // null. `#feed`'s display is what `showCaughtUp` AND `showLoadError` both set, which is why one
    // term covers both. The cold-boot case above is
    // held by `feedSurfaceShowing()` inside `updateCount`, not here.
    //
    // Every site that makes `#feed` visible again (`undoMarkAll`, un-archive, and the ONE success
    // path in `renderFeedResults`) does so with real cards in it; enumerated, not assumed.
    updateCount();
  }

  const lastView = { 'view-setup': 'setup', 'view-feed': 'feed', 'view-archive': 'archive' }[id];
  if (lastView) localStorage.setItem(SK.lastView, lastView);
  const section = { 'view-setup': 'add', 'view-feed': 'feed', 'view-archive': 'archive' }[id];
  if (section) track('view', {}, section); // section/action-level navigation signal
  // Here rather than at each caller, for the same reason as the notice above: a card belongs
  // to one screen, and leaving that screen by any route must take it down (and arriving bring it back).
  tourSync();
}

async function openFeedView() {
  // The feed is about to load, so no feed card may show until this load has rendered —
  // "never during loading". Before showView, which redraws the tour.
  _tourFeedReady = false;
  showView('view-feed');
  document.getElementById('feed-count').textContent = '';
  document.getElementById('feed-loading').style.display = '';
  document.getElementById('feed').style.display = 'none';
  document.getElementById('caughtup').classList.add('hidden');

  const results = await loadFeed();
  document.getElementById('feed-loading').style.display = 'none';
  renderFeedResults(results);
}

// ── Archive view ──
function openArchiveView() {
  showView('view-archive');
  renderArchive();
}

function renderArchive() {
  // Order by publish date (newest first), same as the feed — not archive-insertion
  // order. The stored `archivedAt` is kept for possible future sort options.
  const list = getArchive().sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  const feedEl  = document.getElementById('archive-feed');
  const emptyEl = document.getElementById('archive-empty');
  document.getElementById('archive-count').textContent = list.length ? `${list.length} saved` : '';
  feedEl.innerHTML = '';
  resetVideoAutoplay(); // drop any video refs from a previous render
  if (list.length === 0) {
    feedEl.style.display = 'none';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  list.forEach(item => {
    const card = renderItemCard(item, 'archive');
    feedEl.appendChild(card);
  });
  feedEl.style.display = '';
}

// Shared render for the initial load and for pull-to-refresh.
function renderFeedResults({ items, failed, cappedNames, limited, totalChannels }) {
  renderFeedNote(cappedNames, limited); // show/clear the note each render
  // Total fetch failure isn't the same as "caught up" — don't claim a done-state we didn't earn.
  if (items.length === 0 && failed.length > 0 && failed.length === totalChannels) {
    showLoadError(failed);
    return;
  }

  // Retire a bucket cached by an earlier version, before anything reads it — and ABOVE the
  // caught-up return, so a user whose feed happens to be empty on their upgrade load is not left
  // holding the stale bucket (and offering it to the model) until some later load has posts in it.
  // Below the total-failure return on purpose: that is the one path where nothing was fetched, and
  // deleting assignments there would be a write made on no evidence.
  dropCachedBucket(items);

  if (items.length === 0) {
    renderFeedError(failed);
    // Empty because a LIMIT stopped the fetch is not the same as finished — the same distinction the
    // total-failure branch above makes, for the same reason. Two things must not happen here:
    // claiming a done-state we did not earn, and advancing the New baseline, which would compare
    // tomorrow's fetch of today's withheld posts against today and quietly deliver them un-New.
    if (limited?.quota || limited?.cap) {
      // The per-user fuse is silent
      // while the cache is warm — but silence on a screen with nothing on it is a blank app, not
      // discretion, and this branch already hides `#feed`, blanks the count and refuses caught-up.
      // So this is the one place a refused reader is told anything, and it says precisely what an
      // app-wide cap says: your feed is not broken, and whose limit stopped it is not your business.
      // Set here rather than in renderFeedNote because it must OVERWRITE what that call decided — a
      // skip-note explains the wrong absence on a screen with no posts on it at all.
      setFeedNote(X_UNAVAILABLE_NOTE);
      document.getElementById('feed').style.display = 'none';
      document.getElementById('feed-count').textContent = '';
      document.getElementById('btn-mark-all')?.classList.add('hidden');
      tourOnFeedRendered(false); // a limit, not an error — but no post, so a waiting tour keeps waiting
      return;
    }
    showCaughtUp();
    setLastFeedLoad(Date.now()); // reached the feed (nothing new) — advance the "New" baseline
    tourOnFeedRendered(false); // a load that worked with no posts: a waiting tour keeps waiting
    return;
  }

  renderFeedError(failed);
  document.getElementById('caughtup').classList.add('hidden');
  const feedEl = document.getElementById('feed');
  feedEl.innerHTML = '';
  // A deferral names a card IN `#feed`, so it dies exactly when those cards do — with the rebuild on
  // the line above, never earlier and never later. In particular it does NOT belong
  // ABOVE the early returns ("at the top"): that clears while the cards are still in the
  // DOM, because `showLoadError`/`showCaughtUp` hide `#feed` without rebuilding it. The post then
  // counts as a stream card AND as a grouped post: badge "3 new" over two unread posts. Reds C5c.
  // The cost of this position is that a deferral survives a zero-item render.
  _liftDeferred.clear();
  resetVideoAutoplay(); // drop video refs from the previous render before re-registering
  _lastFeedItems = items;     // topic cards render a group's posts from this snapshot
  migrateGroupSummaries();    // one-time: drop old paragraph-summary cache so it re-groups into bullets
  // Deliberately NOT gated on `failed.length === 0`. The prune
  // does not delete by ABSENCE, so a transient fetch failure cannot empty a valid cluster — nothing is
  // inferred from what loaded, so there is no failure for a gate to protect against,
  // and a gate's own cost would be severe: one permanently-dead channel switches off the ONLY route by
  // which assignments, emptied topics and dead bullets ever leave storage, while the classify keeps
  // adding to them.
  //
  // ⚠️ THIS CALL'S POSITION IS LOAD-BEARING — it must stay BELOW the `items.length === 0` early
  // return above. That return is what shields the record while `channels` is transiently empty
  // (which does happen in production): with no channels there are no
  // items, so nothing is pruned at all. The prune rules are
  // feed-independent — which is precisely what makes hoisting this to boot look like a tidy-up.
  // It is not: `pruneGroupState`'s empty-channel guard is the second line of defence, not the first.
  // Pinned by `group-prune` C9b.
  syncGroupPrune(items, failed.length === 0); // drop finished clusters BEFORE the grid paints
  // Lift-out: grouped posts live in the bundle grid, not the chronological stream.
  // YouTube, Substack and not-yet-classified X stay in
  // the stream (a brand-new X post shows here briefly, then gets lifted when it's classified).
  const groupState = getGroupState();
  const assigned = groupState.assignments;
  // Posts a previous classify already looked at and could not place. They are held on
  // their FIRST pass and never again — see the hold below.
  const sticky = new Set(groupState.unfiled);
  const doneSet = getDoneSet();
  items.forEach(item => {
    const groupable = isGroupableSource(item);
    // An assigned post is NOT skipped here. `renderFeedResults` contains no
    // lift, so a skip would be what empties the stream — and while
    // ungrouped it would render nothing on screen at all for a returning reader whose assignments are
    // already in synced state. Every post is rendered; an assigned one is hidden instead.
    const grouped = groupable && Object.hasOwn(assigned, item.id);
    const card = renderItemCard(item);
    // An unread, not-yet-grouped X post is about to be classified by updateGroupsForFeed. Hold it
    // hidden so it doesn't flash under "Posts" and then get yanked into a group a second later.
    // It's lifted if grouped, or revealed in place (correct chronological slot) if
    // grouping leaves it. A Substack post is never held: it takes no part in the classify,
    // so there is nothing for it to wait on.
    // …but only on its first pass. A post that has already been through a classify and came back
    // unplaceable is re-sent on every load, so holding it again would hide a fifth to a
    // third of the backlog for 4.4-10.3s on EVERY load while `updateCount` still counts the hidden
    // cards — the badge reading "N new" over a screen showing fewer (measured).
    // The hold is for genuinely-new posts.
    // Two more conditions on the hold:
    //   !grouped   — an already-classified post is not WAITING on a classify, so holding it is
    //                meaningless. It also breaks the lift: a card carrying both classes takes the
    //                `grouping-pending` branch and never reaches the deferral, which made a faithful
    //                hide-not-remove probe report GREEN against code carrying the collapse.
    //   isGrouped()— while ungrouped nothing will ever yank a card into a tile, so the hold guards a
    //                flash that cannot happen while costing the DEFAULT path 22-32% of the backlog,
    //                hidden for 4.4-10.3s on every load.
    if (groupable && !grouped && isGrouped() && !doneSet.has(item.id) && !sticky.has(item.id)) card.classList.add('grouping-pending');
    // `.grouped-out` cannot persist across renders — `feedEl.innerHTML = ''` above destroys it — so it
    // is re-applied on EVERY render, not only on toggle. A toggle-only call looks correct and fails
    // silently on the next pull-to-refresh.
    if (grouped && isGrouped()) card.classList.add('grouped-out');
    feedEl.appendChild(card);
  });
  feedEl.style.display = '';
  renderTopicCards();         // paint topics into the stream from cache (self-gating while ungrouped)
  syncGroupingToggle();       // the switch reflects this render's state
  updateCount();              // …count = stream cards + grouped-unread (see updateCount)
  updateGroupsForFeed(items); // …then classify any new posts (non-blocking): lifts them + re-renders
  setLastFeedLoad(Date.now()); // rendered — anything newer than *this* load is New next time
  tourOnFeedRendered(!!_tourStreamPost()); // LAST, so the cards the tour points at exist. Not on the total-failure return above.
  // A post in `items` is not necessarily in the stream: grouped view files it into a topic card or holds it while
  // grouping runs, and neither is anything for Done to point at.
}

// Pull-to-refresh: re-fetch and re-render without the full-screen loading swap.
let _refreshing = false;
async function refreshFeed() {
  if (_refreshing) return;
  track('refresh', {}, 'feed');
  _refreshing = true;
  try {
    renderFeedResults(await loadFeed());
  } finally {
    _refreshing = false;
  }
}

// Pull down from the top of the feed to refresh. The feed itself stretches
// down under your finger (with resistance) and the spinner sits in the gap that
// opens at the top; release past TRIGGER holds it open and spins while
// refreshing, then springs back.
function initPullToRefresh() {
  const view = document.getElementById('view-feed');
  const body = document.getElementById('feed-body'); // stretches on pull; appbar stays pinned
  const bar  = document.querySelector('.appbar');
  const ptr  = document.getElementById('ptr');
  const TRIGGER = 70;  // px of (resisted) stretch needed to fire a refresh
  const MAX     = 120; // cap on how far the feed stretches
  const REST    = 60;  // gap held open while refreshing
  const PH      = 32;  // spinner box size, for centering it in the gap
  let startY = 0, startX = 0, pulling = false, pull = 0, barH = 0;

  // GESTURE ARBITRATION.
  // "Is the page at the top, and is the finger moving down" is not enough; pull-to-refresh
  // must also ask what is UNDER the finger.
  // A topic card puts a vertically-scrolling bullet box AND a horizontally-scrolling rail
  // inside the vertically-scrolling feed, so without these two rules dragging the bullets back up
  // would stretch the whole page and reload the feed instead.
  //
  // (a) A drag that STARTS inside a scroller already scrolled down from its own top belongs to that
  //     scroller — it has somewhere to go. At scrollTop 0 the box cannot scroll up any further, so
  //     the page may take the gesture.
  const startsInScrolledBox = (target) => {
    for (let el = target; el && el !== view; el = el.parentElement) {
      if (el.scrollTop > 0) return true;
    }
    return false;
  };

  // Stretch #feed-body to contentY and center the spinner in the gap that opens
  // just below the appbar — barH offsets it clear of the pinned header.
  const place = (contentY, opacity, scale) => {
    body.style.transform = `translateY(${contentY}px)`;
    ptr.style.opacity = String(opacity);
    ptr.style.transform = `translate(-50%, ${barH + contentY / 2 - PH / 2}px) scale(${scale})`;
  };
  const snap = on => {
    body.classList.toggle('snapping', on);
    ptr.classList.toggle('snapping', on);
  };

  view.addEventListener('touchstart', e => {
    if (_refreshing || window.scrollY > 0) return;
    if (startsInScrolledBox(e.target)) return;   // (a)
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; pulling = true; pull = 0;
    barH = bar.getBoundingClientRect().height; // measure now (incl. safe-area inset)
    snap(false); // follow the finger directly, no transition
  }, { passive: true });

  view.addEventListener('touchmove', e => {
    if (!pulling) return;
    const d = e.touches[0].clientY - startY;
    // (b) More horizontal than vertical means the RAIL is paging, not the page pulling. Give the
    //     gesture up — and note this guard must come BEFORE `preventDefault()` below, or the rail's
    //     own scroll is cancelled by the very handler deciding it should not be.
    if (Math.abs(e.touches[0].clientX - startX) > Math.abs(d)) {
      pulling = false; snap(true); place(0, 0, 0.6); return;
    }
    if (d <= 0 || window.scrollY > 0) { pulling = false; snap(true); place(0, 0, 0.6); return; }
    e.preventDefault(); // take over from the browser's native pull-to-refresh
    pull = Math.min(d * 0.5, MAX); // resistance
    const progress = Math.min(pull / TRIGGER, 1);
    place(pull, progress, 0.6 + 0.4 * progress);
  }, { passive: false });

  view.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    snap(true);
    if (pull >= TRIGGER) {
      place(REST, 1, 1);       // hold the gap open, spinner full-size
      await refreshFeed();
      place(0, 0, 0.6);        // spring back
    } else {
      place(0, 0, 0.6);        // didn't reach threshold — spring back
    }
  });
}

// ── Setup view ────────────────────────────────────────────────────────────────

let _setupWired = false;
let _searchState = null; // { results:[{channelId,name,avatarUrl,alreadyAdded}], fromSearch, topId }
let _selectedId = null;  // channelId currently shown in the confirm card
let _altsExpanded = false;
let _editingIndex = null; // index of the channel whose filter is being edited inline (or null)
let _addSource = 'youtube'; // which source the add form targets ('youtube' | 'twitter')
let _keywordChips = null;   // chips-input controller for the add-flow keyword field

// Input placeholder per source. YouTube supports fuzzy name/URL/@handle/ID; X resolves an
// exact @handle (a handle is globally unique, so it's an exact match — no name search).
const ADD_PLACEHOLDERS = {
  youtube: 'Channel name, @handle, or URL',
  twitter: '@handle  (e.g. @NBA)',
  substack: 'Publication URL or name (e.g. astralcodexten)',
};

function setAddSource(src) {
  _addSource = src;
  document.querySelectorAll('.source-opt').forEach(b => {
    const on = b.dataset.source === src;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  document.getElementById('input-url').placeholder = ADD_PLACEHOLDERS[src];
  document.getElementById('btn-add').textContent =
    src === 'twitter' ? 'Add account' : src === 'substack' ? 'Add publication' : 'Add channel';
  // Shorts is a YouTube-only concept — hide the preference on the non-YouTube tabs.
  const shortsRow = document.getElementById('pref-shorts');
  if (shortsRow) shortsRow.classList.toggle('hidden', src !== 'youtube');
  // Subscription import is YouTube-only too.
  const connectBtn = document.getElementById('btn-connect-youtube');
  if (connectBtn) connectBtn.classList.toggle('hidden', src !== 'youtube');
  renderChannelList(); // re-filter the list to the newly-active tab
  tourSync(); // Import and Shorts just appeared or went: the card count changes, and the controls below them move
}

function renderChannelList() {
  // REDUNDANT in every path a test can reach, and measured to be: mutating it away
  // survives the whole suite, because `showView` and `refuseWrite` between them already repaint on
  // every route that gets here. Kept because it is the call that makes a SETUP re-render honest on
  // its own terms, and because removing it would make `repairDamagedStore`'s repaint the only one —
  // but it is belt-and-braces, and the earlier comment claiming otherwise was wrong.
  renderDamagedNotice();
  const channels = getChannels();
  const list = document.getElementById('channel-list');
  list.innerHTML = '';

  // Show only the source the active tab targets, but keep the original index so
  // edit/remove still address the right entry in the full channels array.
  let shown = 0;
  channels.forEach((ch, i) => {
    if ((ch.source || 'youtube') !== _addSource) return;
    shown++;
    const li = document.createElement('li');
    li.className = 'channel-list-item';
    if (i === _editingIndex) renderChannelEditRow(li, ch, i);
    else                     renderChannelRow(li, ch, i);
    list.appendChild(li);
  });

  if (shown === 0) {
    const li = document.createElement('li');
    li.className = 'channel-list-empty';
    li.textContent = _addSource === 'twitter' ? 'No X accounts added yet.'
      : _addSource === 'substack' ? 'No Substacks added yet.'
      : 'No YouTube channels added yet.';
    list.appendChild(li);
  }

  // Focus the chips text field once the edit row is live (chips render pre-filled).
  if (_editingIndex !== null) {
    const input = list.querySelector('.ch-edit-chips .chips-text');
    if (input) input.focus();
  }
}

// Collapsed row: name + current filter (bare keyword in green, or "all videos"), edit + remove.
function renderChannelRow(li, ch, i) {
  li.innerHTML = `
    ${avatarHtml(ch)}
    <div class="info">
      <div class="ch-name">${esc(channelName(ch))}</div>
      ${ch.keyword
        ? `<div class="ch-rule">${esc(ch.keyword)}</div>`
        : `<div class="ch-rule-none">${({ twitter: 'all posts', substack: 'all articles' })[ch.source] || 'all videos'}</div>`}
    </div>
    <div class="ch-actions">
      <button class="btn-edit" data-index="${i}" aria-label="Edit filters">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>
      </button>
      <button class="btn-remove" data-index="${i}" aria-label="Remove">×</button>
    </div>
  `;
  li.querySelector('.btn-edit').addEventListener('click', () => {
    _editingIndex = i;
    renderChannelList();
  });
  li.querySelector('.btn-remove').addEventListener('click', () => {
    const chs = getChannels();
    chs.splice(i, 1);
    saveChannels(chs);
    _editingIndex = null;
    renderChannelList();
    toggleGoButton();
  });
}

// Expanded row: the same keyword input as the add flow, pre-filled, with Save / Cancel.
// Saving an empty keyword clears the filter (channel falls back to "all videos").
function renderChannelEditRow(li, ch, i) {
  li.classList.add('editing');
  li.innerHTML = `
    <div class="ch-edit-head">
      ${avatarHtml(ch)}
      <div class="info">
        <div class="ch-name">${esc(channelName(ch))}</div>
        <div class="ch-editing-label">Editing filters</div>
      </div>
      <button class="btn-edit-close" aria-label="Cancel editing">×</button>
    </div>
    <div class="ch-edit-body">
      <div class="ch-edit-chips"></div>
      <p class="add-hint">Show videos matching any of these. Press Enter after each. Several words in one chip means all must appear. Leave empty to show all.</p>
      <div class="ch-edit-actions">
        <button class="btn-edit-save" type="button">Save filters</button>
        <button class="btn-edit-cancel" type="button">Cancel</button>
      </div>
    </div>
  `;

  const chipsInput = createChipsInput(li.querySelector('.ch-edit-chips'), {
    initial: parseKeywordChips(ch.keyword),
    placeholder: 'Add a keyword…',
  });
  const save = () => {
    const chs = getChannels();
    if (!chs[i]) return;
    chs[i].keyword = chipsInput.getChips().join(', ');
    saveChannels(chs);
    _editingIndex = null;
    renderChannelList();
  };
  const cancel = () => { _editingIndex = null; renderChannelList(); };

  li.querySelector('.btn-edit-save').addEventListener('click', save);
  li.querySelector('.btn-edit-cancel').addEventListener('click', cancel);
  li.querySelector('.btn-edit-close').addEventListener('click', cancel);
  // Enter adds a chip (handled by the widget); Escape cancels the edit.
  li.querySelector('.ch-edit-chips .chips-text').addEventListener('keydown', e => {
    if (e.key === 'Escape') cancel();
  });
}

// Show "Open my feed →" whenever there's anything to reach — channels OR archived items.
// The Archive is stored independently of channels (getArchive), so it must stay reachable even
// after the last channel is removed; otherwise setup becomes a dead-end.
function toggleGoButton() {
  const hasContent = getChannels().length > 0 || getArchive().length > 0;
  document.getElementById('btn-go').classList.toggle('hidden', !hasContent);
}

function showAddForm() {
  document.getElementById('add-form').classList.remove('hidden');
  document.getElementById('add-confirm').classList.add('hidden');
  _searchState = null;
  _selectedId = null;
  _altsExpanded = false;
  _editingIndex = null;
  tourSync(); // the confirm panel just closed, so card 2's cut-out moves back to the add box
}

async function handleAddChannel() {
  const urlInput = document.getElementById('input-url');
  const errEl    = document.getElementById('add-error');
  const addBtn   = document.getElementById('btn-add');
  const raw = urlInput.value.trim();
  if (!raw) return;

  errEl.classList.add('hidden');
  addBtn.disabled = true;
  addBtn.textContent = 'Resolving…';

  try {
    // YouTube resolves a name / @handle / URL / ID (fuzzy, with alternatives); X resolves
    // an exact @handle to one account (no alternatives).
    const endpoint = _addSource === 'twitter'
      ? `/api/resolve-channel?source=twitter&handle=${encodeURIComponent(raw.replace(/^@/, ''))}`
      : _addSource === 'substack'
      ? `/api/resolve-channel?source=substack&url=${encodeURIComponent(raw)}`
      : `/api/resolve-channel?url=${encodeURIComponent(raw)}`;
    const r = await fetch(endpoint);
    const data = await r.json();

    if (!r.ok) {
      errEl.textContent = data.error || 'Could not find that account.';
      errEl.classList.remove('hidden');
      return;
    }

    const { channelId, name, avatarUrl, handle, fromSearch, alternatives } = data;
    const added = new Set(getChannels().map(c => c.id));

    // Fold the top match + any alternatives into one selectable list, flagging the
    // ones already in the user's channels (shown but disabled, not a hard error) so
    // a search whose top hit is already added still surfaces the other matches. (X
    // returns a single exact match, so there are no alternatives.)
    const results = [{ channelId, name, avatarUrl: avatarUrl || null, handle: handle || null }, ...(alternatives || [])]
      .map(res => ({ ...res, alreadyAdded: added.has(res.channelId) }));

    if (results.every(res => res.alreadyAdded)) {
      errEl.textContent = results.length === 1
        ? 'Already added.'
        : 'You’ve already added every match for that search.';
      errEl.classList.remove('hidden');
      return;
    }

    _searchState = { results, fromSearch: !!fromSearch, topId: channelId, source: _addSource };
    _selectedId = results.find(res => !res.alreadyAdded).channelId;

    renderConfirm();
    // Auto-expand alternatives when the default pick isn't the top result (e.g. the
    // top was already added), so it's clear other choices exist.
    setAlternativesExpanded(_selectedId !== channelId);

    document.getElementById('add-form').classList.add('hidden');
    document.getElementById('add-confirm').classList.remove('hidden');
    // The confirm panel sits at the top of the scroll region; if the list was scrolled
    // down when Add was pressed, snap back so the panel is visible.
    document.querySelector('.setup-scroll')?.scrollTo(0, 0);

  } catch {
    errEl.textContent = 'Network error. Is the dev server running?';
    errEl.classList.remove('hidden');
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = _addSource === 'twitter' ? 'Add account' : 'Add channel';
    // The confirm panel or the error line just appeared. Card 2 asks the reader to confirm, so
    // its cut-out must move there NOW — not on a tap's timer, which a slow resolve outlives and the Enter
    // key never starts.
    tourSync();
  }
}

// Render the confirm card for the currently-selected result, plus its alternatives.
function renderConfirm() {
  const { results, fromSearch, topId, source } = _searchState;
  const selected = results.find(r => r.channelId === _selectedId);
  const noun = source === 'twitter' ? 'account' : source === 'substack' ? 'publication' : 'channel';

  const avatarEl = document.getElementById('confirm-avatar');
  avatarEl.style.background = avatarColor(selected.name);
  avatarEl.innerHTML = esc(selected.name.charAt(0).toUpperCase()) +
    (selected.avatarUrl ? `<img src="${esc(selected.avatarUrl)}" alt="${esc(selected.name)}">` : '');
  document.querySelector('.confirm-label').textContent = `Is this the right ${noun}?`;
  document.getElementById('btn-confirm-add').textContent = `Add this ${noun}`;
  document.getElementById('confirm-name').textContent = selected.name;
  document.getElementById('confirm-meta').textContent =
    !fromSearch                    ? `Is this the right ${noun}?`
    : selected.channelId === topId ? 'Top search result. Is this right?'
    :                                `Is this the ${noun} you meant?`;

  renderAlternatives();
}

// Render the "other results" list — everything except the current selection.
function renderAlternatives() {
  const others = _searchState.results.filter(r => r.channelId !== _selectedId);
  const toggle = document.getElementById('btn-show-alternatives');
  const list   = document.getElementById('confirm-alternatives');

  if (others.length === 0) {
    toggle.classList.add('hidden');
    list.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  toggle.classList.remove('hidden');
  toggle.textContent = _altsExpanded ? 'Hide other results' : `Not this one? See ${others.length} more`;

  list.innerHTML = '';
  others.forEach(res => {
    const li = document.createElement('li');
    li.className = 'alt-item' + (res.alreadyAdded ? ' alt-added' : '');
    li.innerHTML = `
      ${avatarHtml(res)}
      <div class="alt-info">
        <div class="alt-name">${esc(res.name)}</div>
        ${res.alreadyAdded ? '<div class="alt-note">already added</div>' : ''}
      </div>
    `;
    if (!res.alreadyAdded) {
      li.addEventListener('click', () => { _selectedId = res.channelId; renderConfirm(); });
    }
    list.appendChild(li);
  });

  list.classList.toggle('hidden', !_altsExpanded);
}

function setAlternativesExpanded(expanded) {
  _altsExpanded = expanded;
  renderAlternatives();
}

function handleConfirmAdd() {
  if (blockedByDamage()) return;
  if (!_searchState || !_selectedId) return;
  const selected = _searchState.results.find(r => r.channelId === _selectedId);
  if (!selected) return;

  const source = _searchState.source || 'youtube';
  const channels = getChannels();
  const channel = {
    id: selected.channelId,
    name: selected.name,
    keyword: _keywordChips.getChips().join(', '),
    color: avatarColor(selected.name),
    avatarUrl: selected.avatarUrl || null,
    source,
    addedAt: Date.now(), // starts the feed on this channel's last 24h
  };
  if (source === 'twitter') channel.handle = selected.handle || null;
  channels.push(channel);
  saveChannels(channels);
  track('add_channel', { source }, 'add');

  document.getElementById('input-url').value = '';
  _keywordChips.clear();
  showAddForm();
  renderChannelList();
  toggleGoButton();
  tourApply('channel'); // after toggleGoButton, so the tip has "Open my feed" to point at
}

function handleConfirmCancel() {
  document.getElementById('input-url').value = '';
  _keywordChips.clear();
  showAddForm();
}

// ── Connect YouTube: import subscriptions ──────────────────────────
// Bulk-add the channels you already follow on YouTube. "Import your subscriptions" → OAuth
// (youtube.readonly) → the callback stashes the list → we land back on /?import=youtube, fetch it
// once, and open a preview picker so you choose what to add (never auto-add-all).
const IMPORT_ERRORS = {
  youtube_denied: 'YouTube import was cancelled.',
  youtube_error: "Couldn't reach YouTube. Please try again.",
  youtube_unavailable: 'YouTube import is unavailable right now.',
};
const IMPORT_CHECK_SVG = '<span class="import-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>';
const IMPORT_WARN_AT = 25; // soft nudge above this many selected — a big feed isn't finishable

let _importChannels = []; // the fetched subscriptions being previewed ({ channelId, name, avatarUrl })
let _importSelected = new Set(); // channelIds ticked to add

function startYouTubeImport() {
  location.href = '/api/connect/youtube/start'; // top-level nav → Google consent
}

// After the OAuth redirect lands on /?import=…, resolve the stashed result and open the picker
// (or toast an error). Strips ?import= so a reload/reshare can't re-trigger it.
async function handleImportLanding() {
  const params = new URLSearchParams(location.search);
  const flag = params.get('import');
  if (!flag) return;
  params.delete('import');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  // This runs outside the boot's view decision, and the picker is an overlay rather than a .view —
  // so unguarded it would paint itself over the sign-in wall and confirmImport would write
  // channels for an anonymous visitor. Refused AFTER the strip above, so a reload can't retry it.
  // The toast matters: checkAuth aborts at 2.5s, and a genuinely signed-in user coming
  // back from Google consent lands here — silence would look exactly like a broken import.
  if (!_authEmail) { showToast('Please sign in to import your subscriptions.'); return; }
  if (flag !== 'youtube') { showToast(IMPORT_ERRORS[flag] || 'YouTube import failed.'); return; }
  try {
    const r = await fetch('/api/connect/youtube/result');
    const data = r.ok ? await r.json() : null;
    const channels = (data && data.channels) || [];
    if (!channels.length) { showToast('No subscriptions found to import.'); return; }
    openImportModal(channels, !!(data && data.truncated));
  } catch {
    showToast("Couldn't load your subscriptions. Please try again.");
  }
}

function openImportModal(channels, truncated) {
  _importChannels = channels;
  // Default to NONE selected: a subscription list can be huge (hundreds), and a giant feed breaks
  // the "finishable" promise + means a per-channel fetch per load. The user deliberately ticks who
  // to add, or hits "Select all" for a short list.
  _importSelected = new Set();
  document.getElementById('import-search').value = '';
  const note = document.getElementById('import-note');
  note.classList.toggle('hidden', !truncated);
  if (truncated) note.textContent = `Showing your most recent ${channels.length} subscriptions.`;
  renderImportList('');
  document.getElementById('import-scrim').classList.add('show');
  const modal = document.getElementById('import-modal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('profile-open'); // reuse the scroll-lock
  tourSync(); // the tour waits while the picker is open
}

function closeImportModal() {
  document.getElementById('import-scrim').classList.remove('show');
  const modal = document.getElementById('import-modal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('profile-open');
  tourSync(); // …and returns to the same card when it closes
}

function renderImportList(filter) {
  const have = new Set(getChannels().map(c => c.id));
  const list = document.getElementById('import-list');
  const q = foldTurkish(filter || '');
  list.innerHTML = '';
  for (const c of _importChannels) {
    if (q && !foldTurkish(c.name).includes(q)) continue;
    const added = have.has(c.channelId);
    const checked = _importSelected.has(c.channelId);
    const li = document.createElement('li');
    li.className = 'import-item' + (added ? ' is-added' : checked ? ' is-checked' : '');
    li.innerHTML = `${avatarHtml({ name: c.name, avatarUrl: c.avatarUrl })}
      <span class="import-item-name">${esc(c.name)}</span>
      ${added ? '<span class="import-added-tag">Added</span>' : IMPORT_CHECK_SVG}`;
    if (!added) li.addEventListener('click', () => {
      if (_importSelected.has(c.channelId)) _importSelected.delete(c.channelId);
      else _importSelected.add(c.channelId);
      li.classList.toggle('is-checked');
      updateImportControls();
    });
    list.appendChild(li);
  }
  updateImportControls();
}

// Keep the "Add N" button and the Select-all label in sync with the current selection.
function updateImportControls() {
  const n = _importSelected.size;
  const addBtn = document.getElementById('import-add');
  addBtn.textContent = n ? `Add ${n} channel${n === 1 ? '' : 's'}` : 'Add';
  addBtn.disabled = n === 0;
  const selectable = _importChannels.filter(c => !getChannels().some(g => g.id === c.channelId));
  const allSelected = selectable.length > 0 && selectable.every(c => _importSelected.has(c.channelId));
  document.getElementById('import-selectall').textContent = allSelected ? 'Deselect all' : 'Select all';
  // Soft nudge: a big selection strains the finishable feed (per-channel fetch).
  const warn = document.getElementById('import-warn');
  warn.classList.toggle('hidden', n <= IMPORT_WARN_AT);
  if (n > IMPORT_WARN_AT) warn.textContent = `Adding ${n} channels may make your feed hard to finish.`;
}

function toggleImportSelectAll() {
  const have = new Set(getChannels().map(c => c.id));
  const selectable = _importChannels.filter(c => !have.has(c.channelId));
  const allSelected = selectable.length > 0 && selectable.every(c => _importSelected.has(c.channelId));
  _importSelected = allSelected ? new Set() : new Set(selectable.map(c => c.channelId));
  renderImportList(document.getElementById('import-search').value);
}

function confirmImport() {
  if (blockedByDamage()) return;
  const channels = getChannels();
  const have = new Set(channels.map(c => c.id));
  let added = 0;
  for (const c of _importChannels) {
    if (!_importSelected.has(c.channelId) || have.has(c.channelId)) continue;
    channels.push({
      id: c.channelId,
      name: c.name,
      keyword: '',
      color: avatarColor(c.name),
      avatarUrl: c.avatarUrl || null,
      source: 'youtube',
      addedAt: Date.now(), // matters most here: a bulk import is the biggest backlog
    });
    have.add(c.channelId);
    added++;
  }
  saveChannels(channels);
  track('youtube_import', { count: added }, 'add');
  closeImportModal();
  renderChannelList();
  toggleGoButton();
  showToast(`Added ${added} channel${added === 1 ? '' : 's'}`);
  // After the picker has closed and "Open my feed" exists, so the tip never draws over the
  // picker and always has its button. A no-op when nothing was added.
  if (added > 0) tourApply('channel');
}

function initSetup() {
  showAddForm();
  renderChannelList();
  toggleGoButton();

  // Wire event handlers once only
  if (!_setupWired) {
    _setupWired = true;
    document.getElementById('btn-add').addEventListener('click', handleAddChannel);
    document.getElementById('input-url').addEventListener('keydown', e => {
      if (e.key === 'Enter') handleAddChannel();
    });
    document.getElementById('btn-show-alternatives').addEventListener('click', () => setAlternativesExpanded(!_altsExpanded));
    // Keyword field is a chips input: Enter/comma add a chip, so it no longer
    // submits the add — the "Add this channel" button is the sole submit.
    _keywordChips = createChipsInput(document.getElementById('keyword-chips'), { placeholder: 'Add a keyword…' });
    document.getElementById('btn-confirm-add').addEventListener('click', handleConfirmAdd);
    document.getElementById('btn-confirm-cancel').addEventListener('click', handleConfirmCancel);
    document.querySelectorAll('.source-opt').forEach(b => {
      b.addEventListener('click', () => setAddSource(b.dataset.source));
    });
    // The account block + Settings-drawer controls are wired once at boot (wireDrawer); the drawer is
    // body-level and opens from the feed/archive gears too, so it must not depend on initSetup running.
  }

  // btn-go always re-points to current openFeedView (use onclick to overwrite)
  // Tapping it is also how the reader leaves the "Open my feed" tip. Recorded
  // BEFORE the feed opens, so the render that follows finds the tour waiting for it.
  document.getElementById('btn-go').onclick = () => { tourApply('go'); return openFeedView(); };
}

// ── First-run tour ([TASK-092]) ───────────────────────────────────────────────
// A short tour of highlights over the real controls, for an account with nothing in it yet: the setup
// cards, the "Open my feed" tip, then the feed cards. Every DECISION — start or not, which cards
// survive, what a button does — is pure and tested in lib/pure.js (`shouldStartTour`, `tourStep`,
// `tourView`). This section supplies what only the live page knows — whether the boot read applied, which
// control a card highlights, where the card sits — draws the result, owns the switch-off, and reports events.
//
// THE PROPERTY THAT MATTERS MOST: a dim that will not go away makes the app unusable — the one way this
// feature can stop someone using SousChef at all. So every entry point runs inside
// `_tourGuard`, and a throw tears the whole layer down — backdrop, ring, all four blockers, the scroll
// lock — AND SWITCHES THE TOUR OFF FOR THE REST OF THIS DOCUMENT. The teardown reads
// nothing and guards each step on its own, so it cannot itself stop halfway.
//
// The switch-off is not belt-and-braces; tearing down alone was measured insufficient.
// A browser runs the document's capture-phase click listener BEFORE a button's own handler, so
// the re-draw it schedules is already queued when Close's save throws. The record on disk still says a
// card is up, the teardown ran, and the queued re-draw put the card straight back — on every tap, with no
// Escape key on a phone. Only an explicit replay from Settings turns it back on.
//
// NOTHING HERE WRITES ANYTHING SYNCED. The record is one device-local key and never arms a push — the
// rule `setGrouped` follows — so no tour action can raise the "Not syncing" notice.
//
// WIRED ONLY WITH A SESSION, inside wireApp. Every entry point checks `_tourWired`, so a
// signed-out document — which still runs showView — never draws a card.
const TOUR_LAYER = ['tour', 'tour-ring', 'tour-block-top', 'tour-block-right', 'tour-block-bottom', 'tour-block-left'];
const TOUR_FOCUSABLE = 'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])';
let _tourWired = false;
let _tourShowing = false;    // a card is up right now
let _tourKey = null;         // which card is up, so focus moves only when the card changes
let _tourPrevFocus = null;   // what had focus before the tour took it
let _tourFeedReady = false;  // a feed render has completed since the feed last started loading
let _tourOff = false;        // a throw switched the tour off for this document (see the header)
let _tourBooted = false;     // tourBoot has run — nothing is drawn before the boot has decided

function _tourTeardown() {
  _tourShowing = false;
  _tourKey = null;
  for (const id of TOUR_LAYER) {
    try { document.getElementById(id).classList.add('hidden'); } catch { /* keep going — every piece must come down */ }
  }
  try { document.body.classList.remove('tour-open'); } catch { /* as above */ }
}

function _tourGuard(fn) {
  // Down the same path as a close, so focus goes back to where the tour began rather than staying on a button
  // in the layer just hidden — and only if a card was up to take it.
  try { fn(); } catch { _tourOff = true; _tourHide(true); }
}

function _tourRecord() { return parseTourRecord(localStorage.getItem(SK.tour)); }
function _tourSave(rec) { localStorage.setItem(SK.tour, JSON.stringify(rec)); }
function _tourCtx() {
  const channels = getChannels();
  return {
    source: _addSource,
    hasX: channels.some((c) => c.source === 'twitter'),
    hasContent: channels.length > 0 || getArchive().length > 0,   // i.e. "Open my feed" is showing (toggleGoButton)
  };
}

/** At boot, after the view is decided: start the tour for a new account, or resume a run in progress. */
function tourBoot() {
  if (!_tourWired) return;
  _tourBooted = true;
  // Switched off before the boot — a tour control missing from the page — so nothing will ever be drawn: no
  // record and no tour_start for a tour nobody sees.
  if (_tourOff) return;
  _tourGuard(() => {
    const record = localStorage.getItem(SK.tour);
    const start = shouldStartTour({
      signedIn: !!_authEmail,
      // The boot read answered for THIS namespace (syncOnLoad) AND what it answered was applied. An
      // answer that rolled back leaves local empty for an account whose row has data,
      // which is exactly what a new account looks like.
      stateLoaded: _stateLoaded && !_bootApplyFailed,
      damaged: syncedDamaged(),         // a damaged store reads as empty, too
      channels: getChannels().length,
      archived: getArchive().length,
      record,
    });
    if (start) _tourBegin(false);
    else tourSync();                    // resume: a reload or the YouTube round-trip mid-run
  });
}

function _tourBegin(replay) {
  _tourSave({ at: 'setup', card: tourCards('setup', _tourCtx())[0], replay });
  track('tour_start', { replay }, 'tour');
  tourSync();
}

/** Apply one event to the record — see `tourStep` for the vocabulary — then redraw. */
function tourApply(event, extra) {
  if (!_tourWired || _tourOff) return;
  _tourGuard(() => {
    const rec = _tourRecord();
    const { record, emit } = tourStep(rec, event, { ..._tourCtx(), ...extra });
    if (record !== rec) _tourSave(record);
    // Spelled out rather than `track(emit.name, …)`: docs.test.mjs checks every literal track() name
    // against the server allowlist, and a computed name would walk straight past that check.
    if (emit && emit.name === 'tour_close') track('tour_close', emit.props, 'tour');
    if (emit && emit.name === 'tour_finish') track('tour_finish', emit.props, 'tour');
    tourSync();
  });
}

/** A feed render that WORKED — cards, caught up, or the X-unavailable note. Never called on a total load
 *  failure, so the tour does not talk over an error and keeps waiting. `hasPost` says whether the
 *  render left a post the reader can SEE in the stream: only one that did starts the feed part.
 *  Either way the render counts as done, so a feed part ALREADY running still draws its card — centred if
 *  there is nothing to point at. */
function tourOnFeedRendered(hasPost) {
  _tourFeedReady = true;
  tourApply('feed', { feedHasPost: hasPost === true });
}

/** Posts came into the stream, or left it, without a render: grouping released the posts it held, or the reader
 *  switched grouping. A tour waiting for its first post asks again; a running one re-places its card. Nothing
 *  before a render has completed — until then there is no feed for the tour to talk about. */
function tourOnStreamChanged() {
  if (!_tourFeedReady) return;
  tourApply('feed', { feedHasPost: !!_tourStreamPost() });
}

/** The first post the reader can see in the stream, or null — the one Done and Archive point at. A caught-up
 *  screen or a load error hides `#feed` but can leave an earlier render's cards in it, and a card filed into a
 *  topic, held while grouping runs or sliding out is not in the stream. */
function _tourStreamPost() {
  if (document.getElementById('feed').style.display === 'none') return null;
  return document.querySelectorAll('#feed .card:not(.grouped-out):not(.grouping-pending):not(.removing)')[0] || null;
}

/** Draw whatever the record says should be up, or take the layer down. Idempotent — called on every
 *  view change, drawer and picker open/close, and after a tap while a card is up. */
function tourSync() {
  // Before the boot has decided there is nothing to draw: a view change or the YouTube import landing
  // would otherwise draw a resumed card for as long as the picker's data takes to arrive.
  if (!_tourWired || !_tourBooted) return;
  if (_tourOff) { _tourTeardown(); return; }
  _tourGuard(() => {
    const rec = _tourRecord();
    // Suspended while the drawer or the import picker is open: both sit above the layer,
    // and a card left up underneath would come back pointing at whatever they changed.
    const suspended = document.getElementById('profile-panel').classList.contains('open')
      || document.getElementById('import-modal').classList.contains('open');
    const onSetup = !document.getElementById('view-setup').classList.contains('hidden');
    const onFeed = !document.getElementById('view-feed').classList.contains('hidden');
    const due = !!rec && !suspended && (
      ((rec.at === 'setup' || rec.at === 'tip') && onSetup)
      || (rec.at === 'feed' && onFeed && _tourFeedReady)
    );
    const view = due ? tourView(rec, _tourCtx()) : null;
    if (!view) { _tourHide(!suspended); return; }
    _tourShow(rec, view);
  });
}

function _tourHide(restoreFocus) {
  const was = _tourShowing;
  _tourTeardown();
  // Suspended: the drawer or picker owns focus now, and the card comes back when it closes.
  if (!restoreFocus) return;
  const prev = _tourPrevFocus;
  _tourPrevFocus = null;
  // Guarded: a switch-off comes down this path from inside `_tourGuard`'s catch, where a throw would escape.
  if (was && prev && prev.focus) { try { prev.focus(); } catch { /* the layer is already down */ } }
}

function _tourShow(rec, view) {
  const key = `${rec.at}:${view.card}`;
  const changed = key !== _tourKey;
  if (!_tourShowing && _tourPrevFocus === null) _tourPrevFocus = document.activeElement || null;
  document.getElementById('tour-part').textContent = view.part;
  document.getElementById('tour-text').textContent = view.text;
  document.getElementById('tour-count').textContent = view.count;
  document.getElementById('tour-back').disabled = view.backDisabled;
  document.getElementById('tour-main').textContent = view.main;
  const layer = document.getElementById('tour');
  layer.dataset.card = view.card;
  // BEFORE _tourPlace, which measures #tour's own rect: while the layer is display:none that rect is all zeros and the
  // placement's offset correction silently becomes 0. The harness stubs rects whatever the display, so no test sees this order.
  layer.classList.remove('hidden');
  document.body.classList.add('tour-open');
  _tourShowing = true;
  _tourPlace(view.target, changed);
  if (changed) {
    _tourKey = key;
    document.getElementById('tour-main').focus();   // every new card takes focus
  }
}

/** The element a card's ring is for, or null for a centred card. Resolved on every draw, never cached:
 *  the add step moves from the form to the confirm panel (so "then confirm it" stays inside the
 *  cut-out), and a post's Done belongs to whichever post is first in the stream NOW. */
function _tourTarget(key) {
  const shownById = (id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden') ? el : null;
  };
  if (key === 'tabs') return shownById('source-toggle');
  if (key === 'add') return shownById('add-confirm') || shownById('add-form');
  if (key === 'import') return shownById('btn-connect-youtube');
  if (key === 'go') return shownById('btn-go');
  if (key === 'topics') return shownById('toggle-grouping');
  if (key === 'gear') return shownById('btn-feed-manage');
  if (key === 'done' || key === 'archive') {
    const post = _tourStreamPost();   // the same post whose presence starts the feed part
    return post ? post.querySelector(key === 'done' ? '.btn-done' : '.btn-archive') : null;
  }
  return null;
}

// Placement. The harness answers zeros for a rect unless a test stubs one, so the arithmetic is unit-tested
// (A29–A29e stub the boxes and viewports) and how it LOOKS is verified live and on a handset.
// It must never throw on a missing browser API, because a throw
// here takes the tour down with it.
function _tourPlace(targetKey, scroll) {
  const ring = document.getElementById('tour-ring');
  const card = document.getElementById('tour-card');
  const blocks = ['top', 'right', 'bottom', 'left'].map((s) => document.getElementById(`tour-block-${s}`));
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  // With the on-screen keyboard open the VISUAL viewport is shorter than the layout one, so "does the
  // card fit below" is asked of what the reader can actually see.
  const vv = window.visualViewport;
  const seenBottom = vv ? vv.offsetTop + vv.height : vh;
  const cw = card.offsetWidth || 0;
  const ch = card.offsetHeight || 0;
  const box = (b, x, y, w, h) => {
    b.classList.remove('hidden');
    Object.assign(b.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, h)}px` });
  };
  ring.classList.remove('hidden');
  const el = _tourTarget(targetKey);

  if (!el) {
    // Centred, no highlight: the ring collapses to a point and its shadow dims everything, and one
    // blocker covers the whole screen.
    ring.classList.add('no-target');
    ring.dataset.target = '';
    Object.assign(ring.style, { left: '', top: '', width: '', height: '', borderRadius: '' });
    box(blocks[0], 0, 0, vw, vh);
    for (const b of blocks.slice(1)) b.classList.add('hidden');
    card.dataset.side = 'center';
    card.style.left = `${Math.max(12, (vw - cw) / 2)}px`;
    card.style.top = `${Math.max(12, Math.round(vh * 0.58 - ch / 2))}px`;
    return;
  }

  if (scroll && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  // The rect and the fixed layer are not always in the same frame. Opening the keyboard on iOS
  // scrolls the document even under `body.tour-open` (146px on an iPhone 17 Pro), and while it is scrolled a
  // fixed element is drawn that far ABOVE where the rect's coordinates say — measured on the phone: ring top
  // set to 171 from a rect of 177, the ring's own rect then 25. `#tour` is `position: fixed; inset: 0`, so its
  // rect is where fixed (0, 0) sits in the rect's frame: 0 on desktop, and -146 there by inference (the probe logged
  // the ring's rect, not #tour's; style minus rect equalled scrollY in every reading). Subtracting it converts the
  // control's rect into the frame the ring, blockers and card are drawn in.
  const o = document.getElementById('tour').getBoundingClientRect();
  const pad = 6;
  const x = r.left - o.left - pad;
  const y = r.top - o.top - pad;
  const w = r.width + pad * 2;
  const h = r.height + pad * 2;
  const radius = parseFloat(window.getComputedStyle ? window.getComputedStyle(el).borderTopLeftRadius : '') || 10;
  ring.classList.remove('no-target');
  ring.dataset.target = targetKey;
  Object.assign(ring.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, borderRadius: `${radius + pad}px` });
  box(blocks[0], 0, 0, vw, y);                    // above the cut-out
  box(blocks[1], x + w, y, vw - x - w, h);        // right of it
  box(blocks[2], 0, y + h, vw, vh - y - h);       // below it
  box(blocks[3], 0, y, x, h);                     // left of it

  const gap = 14;
  const below = y + h + gap + ch <= seenBottom - 12;
  const cx = x + w / 2;
  const left = Math.min(Math.max(12, cx - cw / 2), Math.max(12, vw - cw - 12));
  // Clamped to the top of what the reader can SEE, for the same reason as `seenBottom`: with the keyboard
  // open the visual viewport can start below the layout one, and a card clamped to 12px of the layout
  // viewport lands off-screen. The clamp does NOT keep the card off its own control: when
  // it fits neither below nor above, it is pushed down over it (A29c's fixture does exactly that). Whether that
  // happens on a real phone is for a handset check to answer before anything changes here.
  const seenTop = vv ? vv.offsetTop : 0;
  card.dataset.side = below ? 'below' : 'above';
  card.style.left = `${left}px`;
  card.style.top = `${below ? y + h + gap : Math.max(seenTop + 12, y - gap - ch)}px`;
  if (card.style.setProperty) card.style.setProperty('--caret-x', `${Math.min(Math.max(18, cx - left), Math.max(18, cw - 18))}px`);
}

// Escape closes; Tab stays inside the card, the highlighted control and a toast's action while the dim
// is up. Covered in the harness: A30 cycles a centred card, and A30b–A30e the highlighted
// control, a control inside it that is not drawn, and a toast's action with and without one — those stub
// `matches`, `getClientRects` and `:not(.hidden)` on the elements involved, which the harness lacks. What a
// real screen reader and keyboard make of it is still the walk.
function _tourKeydown(e) {
  if (!_tourShowing) return;
  if (e.key === 'Escape') {
    if (e.preventDefault) e.preventDefault();
    tourApply('close');
    return;
  }
  if (e.key !== 'Tab') return;
  _tourGuard(() => {
    const view = tourView(_tourRecord(), _tourCtx());
    const target = view ? _tourTarget(view.target) : null;
    const inTarget = target
      ? [target, ...target.querySelectorAll(TOUR_FOCUSABLE)].filter((n) => n.matches(TOUR_FOCUSABLE) && n.getClientRects().length > 0)
      : [];
    const onCard = ['tour-back', 'tour-close', 'tour-main'].map((id) => document.getElementById(id)).filter((b) => !b.disabled);
    // A toast sits above the dim (z 62) and its action can be an Undo or the sync notice's remedy, so a
    // keyboard reader must be able to reach it too, not only a finger.
    const toast = document.getElementById('toast');
    const action = toast && toast.classList.contains('show') ? toast.querySelector('.toast-action:not(.hidden)') : null;
    const ring = [...inTarget, ...onCard, ...(action ? [action] : [])];
    const i = ring.indexOf(document.activeElement);
    e.preventDefault();
    const next = e.shiftKey ? (i <= 0 ? ring.length - 1 : i - 1) : (i === -1 || i === ring.length - 1 ? 0 : i + 1);
    ring[next].focus();
  });
}

// Wired LAST in wireApp, and guarded, so a tour control missing from the page can never cost the rest of
// the app its wiring — run before the gears, the nav and the import picker with no guard,
// a single null would throw straight out of the boot.
function wireTour() {
  if (_tourWired) return;
  try { _wireTour(); } catch { _tourOff = true; _tourTeardown(); }
}
function _wireTour() {
  _tourWired = true;
  // One physical button: OK on the two waiting cards, Next or Done everywhere else.
  document.getElementById('tour-main').addEventListener('click', () => _tourGuard(() => {
    const view = tourView(_tourRecord(), _tourCtx());
    tourApply(view && view.main === 'OK' ? 'ok' : 'next');
  }));
  document.getElementById('tour-back').addEventListener('click', () => tourApply('back'));
  document.getElementById('tour-close').addEventListener('click', () => tourApply('close'));
  // Replay: whatever the record says, from card 1, marked as a replay.
  document.getElementById('btn-drawer-tour').addEventListener('click', () => {
    closeProfile();
    showView('view-setup');
    initSetup();
    // An explicit request, so it clears a switch-off from an earlier throw. If whatever threw is still
    // broken, the guard switches it off again on the way back down.
    // Where focus returns when it ends: setup's own gear. The drawer has just handed focus back to the gear
    // that opened it, and from the feed or Archive that gear is on a screen showView has hidden.
    _tourGuard(() => {
      _tourOff = false;
      _tourBooted = true;
      _tourPrevFocus = document.getElementById('profile-btn');
      _tourBegin(true);
    });
  });
  document.addEventListener('keydown', _tourKeydown);
  // Re-place after anything that can move the target: a tap (a tab switch reflows setup, Done slides a
  // card out over 320ms), a resize or rotation, the on-screen keyboard, a scroll.
  const later = () => { if (_tourShowing) setTimeout(tourSync, 0); };
  window.addEventListener('resize', later);
  window.addEventListener('scroll', later, true);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', later);
  document.addEventListener('click', () => { if (_tourShowing) { setTimeout(tourSync, 0); setTimeout(tourSync, 350); } }, true);
}

// ── Startup migration: fix channels stored with raw channel ID as name ─────────

async function migrateChannelNames() {
  const channels = getChannels();
  const broken = channels.filter(ch => /^UC[\w-]{22}$/.test(ch.name));
  if (broken.length === 0) return;

  await Promise.all(broken.map(async ch => {
    try {
      const r = await fetch(`/api/resolve-channel?url=${encodeURIComponent(ch.id)}`);
      if (!r.ok) return;
      const data = await r.json();
      if (data.name && !/^UC[\w-]{22}$/.test(data.name)) {
        ch.name = data.name;
      }
      if (data.avatarUrl) ch.avatarUrl = data.avatarUrl;
    } catch { /* skip */ }
  }));

  saveChannels(channels);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Every control that belongs to the app itself, wired in one place so init() can decline to call
// it. None of these surfaces exist for a signed-out visitor: the theme and
// Shorts toggles live in the Settings drawer and on setup, and the rest hang off the feed, archive
// and import flows. The landing wires its own three controls in showLandingView().
function wireApp() {
  // Theme toggle (two-option segmented control on the setup page). The current
  // theme is already applied via <html data-theme> by the inline head script;
  // here we sync the button highlight and let the user override + persist it.
  const themeBtns = [...document.querySelectorAll('.theme-opt')];
  const syncTheme = t => themeBtns.forEach(b => b.classList.toggle('is-active', b.dataset.theme === t));
  syncTheme(document.documentElement.getAttribute('data-theme') || 'light');
  themeBtns.forEach(b => b.addEventListener('click', () => {
    // `theme` and `shorts` are SYNCED but are scalars, so they are not in
    // SYNCED_PROTECTED and, unguarded, their writes would be the only ones still reaching `schedulePush()` on a
    // damaged store. That is not merely an unguarded write — it sets `focus_dirty`, and syncOnLoad
    // reads that as "keep local, do NOT pull", which is exactly what stops the next clean boot from
    // AUTO-HEALING. A theme tap could therefore convert a store that would have repaired itself
    // into one that never does.
    if (blockedByDamage()) return;
    const t = b.dataset.theme;
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(SK.theme, t);
    schedulePush();
    syncTheme(t);
  }));

  // The damaged-store notice's action, on both screens. Wired HERE, inside the
  // session gate, because a signed-out visitor holds a page whose buttons are connected to nothing
  // — and because the action is "restore from my account", which is meaningless
  // without one. `adoptServerCopy` is reused rather than reimplemented: it already carries the
  // namespace check, the seal re-check across its await, and the all-or-nothing apply.
  // A RELOAD would not do: with `dirty` set, syncOnLoad keeps local and never applies the row, so
  // the damage survives every reload.
  ['setup', 'feed', 'archive'].forEach(view => {
    document.getElementById(`damaged-heal-${view}`)?.addEventListener('click', repairDamagedStore);
  });

  // Shorts preference — persisted here; the actual feed filtering
  // needs the Data API so Shorts-heavy channels aren't starved.
  const shortsBtn = document.getElementById('toggle-shorts');
  if (shortsBtn) {
    const stored = localStorage.getItem(SK.shorts);
    const setShorts = (on, persist) => {
      shortsBtn.classList.toggle('is-on', on);
      shortsBtn.setAttribute('aria-checked', String(on));
      localStorage.setItem(SK.shorts, String(on));
      if (persist) schedulePush(); // only a real toggle syncs — not the load-time UI init
    };
    setShorts(stored === null ? true : stored === 'true'); // default: include Shorts
    // Guarded for the same reason as the theme control above — and only the CLICK, not
    // the load-time `setShorts(...)` init above it, which persists no user intent and must still
    // paint the control correctly on a damaged store.
    shortsBtn.addEventListener('click', () => {
      if (blockedByDamage()) return;
      setShorts(!shortsBtn.classList.contains('is-on'), true);
    });
  }

  // The grouped-view switch in the feed appbar.
  wireGroupingToggle();

  initPullToRefresh();

  // Manage channels from caught-up screen
  document.getElementById('btn-manage').addEventListener('click', () => {
    showView('view-setup');
    initSetup();
  });

  // The Settings drawer (body-level) wires its own controls once, so it works from any view.
  wireDrawer();
  // Feed & archive app bars: the gear opens the Settings drawer.
  document.getElementById('btn-feed-manage').addEventListener('click', openProfile);
  document.getElementById('btn-archive-manage').addEventListener('click', openProfile);
  // "Manage channels" inside the Settings drawer → the add/setup page.
  document.getElementById('btn-drawer-manage').addEventListener('click', () => {
    closeProfile();
    showView('view-setup');
    initSetup();
  });

  // Bottom-nav tabs (Feed / Archive). The feed is already loaded, so switching back to it just
  // shows it (no re-fetch); Archive re-renders from localStorage each time.
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.addEventListener('click', () => {
      if (t.dataset.view === 'view-archive') openArchiveView();
      else showView('view-feed');
    });
  });
  // Caught-up screen → Archive shortcut
  document.getElementById('archive-nudge').addEventListener('click', openArchiveView);
  // Mark every feed item as done in one tap
  document.getElementById('btn-mark-all').addEventListener('click', markAllDone);
  // Back out of a group's drill-in view

  // Connect YouTube → import subscriptions
  document.getElementById('btn-connect-youtube').addEventListener('click', startYouTubeImport);
  document.getElementById('import-close').addEventListener('click', closeImportModal);
  document.getElementById('import-cancel').addEventListener('click', closeImportModal);
  document.getElementById('import-scrim').addEventListener('click', closeImportModal);
  document.getElementById('import-add').addEventListener('click', confirmImport);
  document.getElementById('import-selectall').addEventListener('click', toggleImportSelectAll);
  document.getElementById('import-search').addEventListener('input', e => renderImportList(e.target.value));

  // The first-run tour — its card controls, Escape, and the drawer's "Show the tour" row.
  // LAST, so nothing above depends on it (see wireTour).
  wireTour();
}

async function init() {
  // A broken remote avatar should fall back to the letter behind it, not the browser's
  // broken-image glyph. `error` events don't bubble, so listen in the capture phase.
  document.addEventListener('error', e => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.closest('.avatar')) img.style.display = 'none';
  }, true);

  // Reconcile server state AND resolve the session before the view is
  // decided — both bounded, both degrade to localStorage/signed-out. Run in parallel so boot
  // waits on the slower of the two, not the sum. checkAuth sets _authEmail + renders the account.
  //
  // Both REQUESTS still start together, but syncOnLoad's DECISION waits for the sign-in answer, so
  // it is handed checkAuth's promise rather than racing it: a state row may be acted on
  // only once we know which namespace this browser is entitled to. Awaiting checkAuth first instead
  // would make the boot wait for the sum.
  const authAnswer = checkAuth();
  await Promise.all([syncOnLoad(authAnswer), authAnswer]);

  // One app-open signal per boot. checkAuth has resolved the session by here.
  track('session_start', { signedIn: !!_authEmail });

  // Toast any magic-link/Google landing (the session was already resolved above).
  //
  // `?auth=` must never let a value skip the landing: that would be
  // a hole straight past the only gate
  // — a used or expired link answers `?auth=invalid`, which is truthy, so a failed sign-in would land
  // an ANONYMOUS visitor in the app. Narrowing it to
  // `auth=ok` would be no better: anyone can type that in the address bar. The view decision below
  // rests solely on whether checkAuth resolved a real session.
  handleAuthLanding();

  // The wall is not a screen in front of the app — the app is not built.
  //
  // A gate that only decides what to SHOW can be bypassed by something reaching PAST it: any `?auth=` value,
  // or four Tab presses into the Settings drawer, which is body-level and hidden by
  // `transform`, so its controls stay in the tab order and #btn-drawer-manage walks straight
  // into setup. Another check at the one place that decides
  // what to show is not the answer. It is not a decision at all: a signed-out visitor holds a page whose buttons
  // are not connected to anything, so no future overlay can reopen the hole by picking the wrong
  // way to hide itself. Reachability is not part of the trust chain.
  //
  // Signing IN is safe: _authEmail is written only in checkAuth(), and every sign-in arrives as a
  // full page load (magic link → /app?auth=ok, Google → redirect), so there is no moment where the
  // app is visible but dead.
  //
  // Signing OUT is NOT covered, and this gate does not claim to cover it. It runs once per
  // document, so a document wired while a session existed stays a working app after that session
  // ends — reachable by pressing Back after signing out (bfcache restores it with _authEmail still
  // set) or simply by a second tab left open. Both demonstrated live.
  // It needs a pageshow/storage re-check, not another condition here.
  if (_authEmail) {
    wireApp();
    await migrateChannelNames();
  }

  // The sign-in wall (mandatory): every signed-out visitor sees it, on
  // every boot. The decision rests SOLELY on whether checkAuth resolved a session — there is no
  // `?auth=` term and there must never be one, because every value of it is truthy and a
  // failed sign-in would therefore be a way straight past the wall. A genuine mid-auth load needs no
  // exemption: it arrives as a full page load carrying the session cookie, so _authEmail is set.
  //
  // Two false claims, recorded so they are not introduced: that a
  // confirmed session "graduates" this device against a later sign-out (false — sign-out re-walls,
  // by design), and that being mid-auth exempts a visitor from the decision (false).
  const signedIn = !!_authEmail;

  // Land on setup only when there's genuinely nothing to see. Archived items are stored
  // independently of channels, so a user with 0 channels but a non-empty archive still gets the
  // feed (→ caught-up → Archive via the bottom nav) rather than being trapped on setup.
  const noContent = getChannels().length === 0 && getArchive().length === 0;
  const lastView = localStorage.getItem(SK.lastView);

  if (shouldShowLanding({ signedIn })) {
    showLandingView();
  } else if (noContent || lastView === 'setup') {
    showView('view-setup');
    initSetup();
  } else {
    await openFeedView();
    if (lastView === 'archive') openArchiveView();
  }

  // If we just came back from the YouTube OAuth round-trip, resolve the result + open the picker
  // over whatever view we landed on.
  await handleImportLanding();

  // Start the tour for a new account, or resume one in progress. After the view decision,
  // because the start rests on what the boot read left in storage — and AFTER the import landing, because
  // nothing is drawn until this runs: any earlier, a resumed card would be drawn and take focus for
  // the whole of the subscriptions fetch, then vanish under the picker.
  if (signedIn) tourBoot();
}

document.addEventListener('DOMContentLoaded', init);
