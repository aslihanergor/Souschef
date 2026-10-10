import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  esc, foldTurkish, timeAgo,
  parseKeywordChips, foldKeywordChips, matchesKeywordChips,
  applyLookback, filterFeedItems, filterTweetItems, filterSubstackItems,
  EXIT_DISPOSITION, exitKeyPlan, shouldShowLanding,
  sameSyncedState,
} from '../lib/pure.js';
import { SYNCED_KEYS } from '../api/_state.js';

// app.js's pure functions, extracted so node:test can import them. Same file the
// browser loads — no copy to rot. These assert the OBSERVABLE contract, not the implementation.

// ── esc: the HTML-escape trust primitive (used before every innerHTML) ─────────

test('esc escapes the four HTML-significant characters', () => {
  assert.equal(esc('&<>"'), '&amp;&lt;&gt;&quot;');
});

test('esc escapes & first so it does not double-encode the others', () => {
  // if < were escaped before &, "<" -> "&lt;" -> "&amp;lt;" — this guards that order.
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(esc('a & b'), 'a &amp; b');
});

test('esc leaves plain text and single quotes untouched', () => {
  assert.equal(esc("it's fine"), "it's fine");
});

test('esc coerces non-strings via String()', () => {
  assert.equal(esc(null), 'null');
  assert.equal(esc(42), '42');
});

// ── foldTurkish: case- AND Turkish-diacritic-insensitive (users are Turkish) ────

test('foldTurkish folds all four i-variants (dotted/dotless) to plain i', () => {
  assert.equal(foldTurkish('İ'), 'i'); // capital dotted
  assert.equal(foldTurkish('I'), 'i'); // capital dotless
  assert.equal(foldTurkish('ı'), 'i'); // small dotless
  assert.equal(foldTurkish('i'), 'i'); // small dotted
});

test('foldTurkish folds a real dotless-I word', () => {
  assert.equal(foldTurkish('IŞIK'), 'isik'); // I->i, Ş->ş->s
  assert.equal(foldTurkish('İstanbul'), 'istanbul');
});

test('foldTurkish folds ö ü ş ç ğ to their ASCII bases', () => {
  assert.equal(foldTurkish('Örnek'), 'ornek');
  assert.equal(foldTurkish('ğçüş'), 'gcus');
  assert.equal(foldTurkish('Dünya Kupası'), 'dunya kupasi');
});

// ── parseKeywordChips: raw display terms, original casing preserved ────────────

test('parseKeywordChips splits on commas, trims, drops empties', () => {
  assert.deepEqual(parseKeywordChips('review, unboxing'), ['review', 'unboxing']);
  assert.deepEqual(parseKeywordChips('  a , , b '), ['a', 'b']);
});

test('parseKeywordChips returns [] for empty/nullish input', () => {
  assert.deepEqual(parseKeywordChips(''), []);
  assert.deepEqual(parseKeywordChips(null), []);
});

test('parseKeywordChips preserves original casing (display form)', () => {
  assert.deepEqual(parseKeywordChips('Formula 1, F1'), ['Formula 1', 'F1']);
});

// ── foldKeywordChips: match-time form — each chip -> its folded words ──────────

test('foldKeywordChips folds each chip to its word list', () => {
  assert.deepEqual(foldKeywordChips('review, unboxing'), [['review'], ['unboxing']]);
  assert.deepEqual(foldKeywordChips('dunya kupasi ozet'), [['dunya', 'kupasi', 'ozet']]);
  assert.deepEqual(foldKeywordChips('formula 1, f1'), [['formula', '1'], ['f1']]);
});

test('foldKeywordChips applies the Turkish fold to each word', () => {
  assert.deepEqual(foldKeywordChips('Dünya Kupası'), [['dunya', 'kupasi']]);
});

test('foldKeywordChips returns [] for an empty filter', () => {
  assert.deepEqual(foldKeywordChips(''), []);
});

// ── matchesKeywordChips: AND within a chip, OR across chips ─────────

test('an empty filter matches everything', () => {
  assert.equal(matchesKeywordChips('any title at all', []), true);
});

test('a single-word chip matches when the folded title contains it', () => {
  assert.equal(matchesKeywordChips(foldTurkish('F1 Review'), [['review']]), true);
  assert.equal(matchesKeywordChips(foldTurkish('F1 Highlights'), [['review']]), false);
});

test('a multi-word chip requires ALL its words (AND within a chip)', () => {
  const title = foldTurkish('Dünya Kupası Özet');
  assert.equal(matchesKeywordChips(title, [['dunya', 'kupasi', 'ozet']]), true);
  assert.equal(matchesKeywordChips(title, [['dunya', 'yok']]), false); // "yok" absent -> whole chip fails
});

test('chips are OR-ed — any one satisfied chip matches (the TASK-044 13->0 regression)', () => {
  // Under an OR-only-across-words model this went to 0; the AND-within/OR-across model keeps it.
  const chips = foldKeywordChips('formula 1, f1');
  assert.equal(matchesKeywordChips(foldTurkish('F1 Grand Prix'), chips), true); // via the "f1" chip
  assert.equal(matchesKeywordChips(foldTurkish('Formula 1 Recap'), chips), true); // via "formula"+"1"
  assert.equal(matchesKeywordChips(foldTurkish('NBA Highlights'), chips), false); // neither chip
});

// ── timeAgo: relative for < 7 days, absolute date beyond ───────────────────────

test('timeAgo reports minutes, hours, days inside their buckets', () => {
  assert.equal(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString()), '5m ago');
  assert.equal(timeAgo(new Date(Date.now() - 3 * 3_600_000).toISOString()), '3h ago');
  assert.equal(timeAgo(new Date(Date.now() - 3 * 86_400_000).toISOString()), '3d ago');
});

test('timeAgo falls back to an absolute en-GB date beyond 7 days', () => {
  const out = timeAgo(new Date(Date.now() - 40 * 86_400_000).toISOString());
  assert.doesNotMatch(out, /ago$/);
  assert.match(out, /^\d{1,2} [A-Z][a-z]{2}$/); // e.g. "5 Jun"
});

// Boundary transitions — the exact thresholds a <-> <= slip would flip (guards the buckets).
test('timeAgo flips buckets exactly at 60m / 24h / 7d', () => {
  const min = 60_000, hour = 3_600_000, day = 86_400_000;
  assert.equal(timeAgo(new Date(Date.now() - 59 * min).toISOString()),  '59m ago');
  assert.equal(timeAgo(new Date(Date.now() - 60 * min).toISOString()),  '1h ago');
  assert.equal(timeAgo(new Date(Date.now() - 23 * hour).toISOString()), '23h ago');
  assert.equal(timeAgo(new Date(Date.now() - 24 * hour).toISOString()), '1d ago');
  assert.equal(timeAgo(new Date(Date.now() - 6 * day).toISOString()),   '6d ago');
  assert.match(timeAgo(new Date(Date.now() - 7 * day).toISOString()), /^\d{1,2} [A-Z][a-z]{2}$/);
});

// The month abbreviation has to be OURS. `toLocaleDateString` runs in the READER's
// browser, so its month names come from that device's locale data: September rendered "1 Sept"
// where every other month rendered three letters, and two devices could disagree about the same
// post. These assert the EXACT string rather than a shape — a shape is precisely what let the
// four-letter case through for as long as it took the calendar to reach September.
test('timeAgo renders every month as a three-letter abbreviation', () => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Midday UTC, so no host timezone within ±11h can roll the day onto its neighbour.
  const got = months.map((_, m) => timeAgo(new Date(Date.UTC(2025, m, 15, 12)).toISOString()));
  assert.deepEqual(got, months.map(mon => `15 ${mon}`));
});

test('timeAgo renders September as Sep, not Sept', () => {
  assert.equal(timeAgo(new Date(Date.UTC(2025, 8, 1, 12)).toISOString()), '1 Sep');
});

// ── applyLookback: a newly added channel starts light ───────────────
// Contract. With no valid addedAt: keep every item with a parseable `published` — the legacy
// path, so channels added before this shipped are untouched. With one: keep items published at
// or after (addedAt - 24h); if fewer than `floor` clear it, top up with the NEWEST of the rest,
// so a slow source is never blank. Kept items come back in INPUT order (loadFeed sorts globally).

const NOW  = Date.parse('2026-07-27T12:00:00Z');
const HOUR = 3_600_000;
const DAY  = 86_400_000;
const at   = ms => ({ id: String(ms), published: new Date(ms).toISOString() });
const ids  = list => list.map(i => i.id);

test('applyLookback keeps every dated item when the channel has no addedAt (legacy 14 days)', () => {
  const items = [at(NOW - 1 * HOUR), at(NOW - 5 * DAY), at(NOW - 13 * DAY)];
  assert.deepEqual(ids(applyLookback(items, undefined, NOW)), ids(items));
});

test('applyLookback treats an unusable addedAt as absent', () => {
  const items = [at(NOW - 1 * HOUR), at(NOW - 9 * DAY)];
  for (const bad of [null, 0, NaN, 'yesterday', undefined]) {
    assert.deepEqual(ids(applyLookback(items, bad, NOW)), ids(items), `addedAt=${String(bad)}`);
  }
});

// A future addedAt is NOT "absent" — it means the anchor is real and a clock is off. Falling
// back to the full window there would restore the backlog wall on the other device, then
// self-heal once real time catches up, so nobody could ever reproduce it. Clamp to now instead.
test('applyLookback clamps a future addedAt instead of falling back to the full window', () => {
  const fresh = at(NOW - 1 * HOUR), old = at(NOW - 9 * DAY);
  const items = [fresh, old];
  const skewed = applyLookback(items, NOW + DAY, NOW);

  assert.deepEqual(ids(skewed), ids([fresh]), 'skew must not reopen the 14-day window');
  assert.notDeepEqual(ids(skewed), ids(items), 'and must not be the legacy passthrough');
  assert.deepEqual(ids(skewed), ids(applyLookback(items, NOW, NOW)),
    'a clock 24h fast behaves exactly as if the channel were added now');
});

test('applyLookback drops items published before the 24h anchor', () => {
  const fresh = at(NOW - 2 * HOUR), alsoFresh = at(NOW - 20 * HOUR);
  const old = at(NOW - 3 * DAY), older = at(NOW - 10 * DAY);
  const kept = applyLookback([fresh, alsoFresh, old, older], NOW, NOW);
  assert.deepEqual(ids(kept), ids([fresh, alsoFresh]));
});

test('applyLookback includes an item exactly on the anchor and excludes one a ms older', () => {
  // floor 0 isolates the cutoff from the never-blank top-up.
  const onAnchor = at(NOW - DAY), justBefore = at(NOW - DAY - 1);
  const kept = applyLookback([onAnchor, justBefore], NOW, NOW, 0);
  assert.deepEqual(ids(kept), ids([onAnchor]));
});

test('applyLookback surfaces the newest 2 when nothing clears the anchor — never blank', () => {
  const newest = at(NOW - 3 * DAY), mid = at(NOW - 5 * DAY), oldest = at(NOW - 9 * DAY);
  const kept = applyLookback([oldest, newest, mid], NOW, NOW); // deliberately unsorted input
  assert.deepEqual(ids(kept), ids([newest, mid]), 'newest two, returned in input order');
});

// The fallback is an emptiness guard, not a quota: one fresh item is not a blank screen, so
// nothing published before the channel was added should be dragged in alongside it.
test('applyLookback does NOT reach back when even one item clears the anchor', () => {
  const fresh = at(NOW - 2 * HOUR), old = at(NOW - 3 * DAY), older = at(NOW - 6 * DAY);
  assert.deepEqual(ids(applyLookback([fresh, old, older], NOW, NOW)), ids([fresh]));
});

test('applyLookback pulls in nothing older once the floor is already met', () => {
  const fresh = [at(NOW - 1 * HOUR), at(NOW - 2 * HOUR), at(NOW - 3 * HOUR),
                 at(NOW - 4 * HOUR), at(NOW - 5 * HOUR)];
  const old = [at(NOW - 4 * DAY), at(NOW - 8 * DAY)];
  assert.deepEqual(ids(applyLookback([...fresh, ...old], NOW, NOW)), ids(fresh));
});

test('applyLookback returns fewer than the floor rather than inventing items', () => {
  const only = at(NOW - 6 * DAY);
  assert.deepEqual(ids(applyLookback([only], NOW, NOW)), ids([only]));
  assert.deepEqual(applyLookback([], NOW, NOW), []);
});

test('applyLookback with floor 0 does no top-up at all', () => {
  assert.deepEqual(applyLookback([at(NOW - 3 * DAY), at(NOW - 5 * DAY)], NOW, NOW, 0), []);
});

test('applyLookback drops items with a missing or unparseable published', () => {
  const good = at(NOW - 2 * HOUR);
  const bad  = [{ id: 'none' }, { id: 'empty', published: '' }, { id: 'junk', published: 'soon' }];
  assert.deepEqual(ids(applyLookback([good, ...bad], NOW, NOW)), ids([good]));
  // and on the legacy path, where there is no anchor to hide behind
  assert.deepEqual(ids(applyLookback([good, ...bad], undefined, NOW)), ids([good]));
});

test('applyLookback does not mutate the array it was given', () => {
  const items = [at(NOW - 9 * DAY), at(NOW - 1 * HOUR)];
  const before = ids(items);
  applyLookback(items, NOW, NOW);
  assert.deepEqual(ids(items), before);
});

// ── The filters' stage ORDER: keyword → lookback → hidden ───────────
// The feature's correctness rests on stage 3 running LAST. These pin it. If a future edit folds
// the hidden check into the keyword pass, the
// never-blank fallback recomputes over unhidden items only and walks backwards through the
// backlog, one pair per visit, and the channel never finishes. That regression must fail here.

// These go through the filters, which have no `now` seam — they call applyLookback with its
// Date.now() default. So anchor the fixtures to real time, not the fixed NOW above: an addedAt
// even a minute in the future takes the fall-open path and returns the whole window.
const T = Date.now();
const CH = { keyword: '', addedAt: T };
const vid = (id, ms, title = 'a video') => ({ videoId: id, title, published: new Date(ms).toISOString() });
const post = (id, ms, text = 'a post') => ({ id, text, title: text, published: new Date(ms).toISOString() });

test('filterFeedItems: marking the surfaced items done does NOT surface older ones', () => {
  // A quiet channel: nothing inside the anchor, five older videos.
  const items = [vid('v1', T - 3 * DAY), vid('v2', T - 4 * DAY), vid('v3', T - 5 * DAY),
                 vid('v4', T - 6 * DAY), vid('v5', T - 7 * DAY)];
  const first = filterFeedItems(items, CH, new Set());
  assert.deepEqual(first.map(i => i.videoId), ['v1', 'v2'], 'never blank: newest two');

  // The user clears them. The channel must go silent — not offer v3/v4.
  const second = filterFeedItems(items, CH, new Set(['v1', 'v2']));
  assert.deepEqual(second.map(i => i.videoId), [], 'no reach further back once handled');

  // And again, to catch a fallback that walks one pair at a time.
  const third = filterFeedItems(items, CH, new Set(['v1', 'v2', 'v3', 'v4']));
  assert.deepEqual(third.map(i => i.videoId), [], 'still silent');
});

test('filterFeedItems: the never-blank fallback never surfaces a keyword-excluded item', () => {
  const items = [vid('hit', T - 5 * DAY, 'F1 race recap'), vid('miss', T - 2 * DAY, 'NBA game')];
  const kept = filterFeedItems(items, { keyword: 'f1', addedAt: T }, new Set());
  assert.deepEqual(kept.map(i => i.videoId), ['hit'],
    'the newer item loses to the filter — the fallback picks from matches only');
});

test('filterTweetItems: same ordering guarantee over the merged tweetCache', () => {
  const items = [post('t1', T - 3 * DAY), post('t2', T - 4 * DAY), post('t3', T - 5 * DAY)];
  assert.deepEqual(filterTweetItems(items, CH, new Set()).map(i => i.id), ['t1', 't2']);
  assert.deepEqual(filterTweetItems(items, CH, new Set(['t1', 't2'])).map(i => i.id), []);
});

test('filterSubstackItems: same ordering guarantee', () => {
  const items = [post('s1', T - 3 * DAY), post('s2', T - 4 * DAY), post('s3', T - 5 * DAY)];
  assert.deepEqual(filterSubstackItems(items, CH, new Set()).map(i => i.id), ['s1', 's2']);
  assert.deepEqual(filterSubstackItems(items, CH, new Set(['s1', 's2'])).map(i => i.id), []);
});

test('the filters leave a channel with no addedAt on the full server window', () => {
  const legacy = { keyword: '', addedAt: undefined };
  const items = [vid('v1', T - 1 * HOUR), vid('v2', T - 6 * DAY), vid('v3', T - 13 * DAY)];
  assert.deepEqual(filterFeedItems(items, legacy, new Set()).map(i => i.videoId), ['v1', 'v2', 'v3']);
});

// ── shouldShowLanding: the boot gate ────────────────────────────────
// There is no "Continue without an account", so the
// landing is not a dismissible welcome but the only way in: `landingSeen` does not
// participate at all. The second case below is the point.

test('shouldShowLanding: a signed-out visitor always sees it', () => {
  assert.equal(shouldShowLanding({ signedIn: false, landingSeen: false }), true);
});

test('shouldShowLanding: a signed-out visitor who dismissed it BEFORE still sees it', () => {
  // SK.landing once dismissed the wall permanently per device.
  // Anyone who took that old skip carries landingSeen:'true' forever, so this is the upgrade path for
  // every existing anonymous user — not a hypothetical.
  assert.equal(shouldShowLanding({ signedIn: false, landingSeen: true }), true);
});

test('shouldShowLanding: a signed-in visitor never sees it', () => {
  assert.equal(shouldShowLanding({ signedIn: true, landingSeen: false }), false);
  assert.equal(shouldShowLanding({ signedIn: true, landingSeen: true }), false);
});

test('shouldShowLanding: landingSeen cannot affect the outcome, whatever it holds', () => {
  // Guards the collapse itself: if a future edit reintroduces landingSeen to the predicate, the two
  // results diverge and this reds. Covers the absent/garbage cases the caller can actually produce.
  for (const seen of [undefined, null, 'true', 'false', 0, 1]) {
    assert.equal(shouldShowLanding({ signedIn: false, landingSeen: seen }), true, `landingSeen=${String(seen)}`);
    assert.equal(shouldShowLanding({ signedIn: true, landingSeen: seen }), false, `landingSeen=${String(seen)}`);
  }
});

// ── exit key disposition: what sign-out and delete leave behind ──────
// The bug is that leaving doesn't leave: both exits clear only SK.landing, so the next account to
// sign in on this browser inherits the previous person's state. The policy of WHICH keys go is
// pure and lives here; the clearing itself touches localStorage and stays on verify-by-looking.

test('exitKeyPlan: every synced key except theme is cleared on exit', () => {
  const { clear } = exitKeyPlan();
  for (const k of SYNCED_KEYS) {
    if (k === 'theme') continue;
    assert.ok(clear.includes(k), `${k} syncs to the account but survives a sign-out`);
  }
});

test('exitKeyPlan: theme and wasAuthed are the deliberate survivors', () => {
  // theme IS a synced key — kept on purpose. A light/dark preference carries no personal content,
  // and an app that flips theme on sign-out reads as a bug rather than as privacy.
  //
  // wasAuthed was added to `keep` after code review: `signout` is only ever emitted by spotting the
  // authed→not-authed transition on the NEXT boot, so clearing this flag on the way out zeroed the
  // metric silently. Requirement change, not a test bent to fit — the old expectation of ['theme']
  // described behaviour we no longer want.
  const { clear, keep } = exitKeyPlan();
  assert.ok(SYNCED_KEYS.includes('theme'), 'guard: theme is expected to be a synced key');
  assert.deepEqual(keep, ['theme', 'wasAuthed']);
  assert.ok(!clear.includes('theme'));
  assert.ok(!clear.includes('wasAuthed'), 'clearing this silently kills the signout metric');
});

test('exitKeyPlan: shorts is cleared even though it is also a preference', () => {
  // The counter-example to theme: shorts changes WHICH CONTENT appears, so inheriting it leaks.
  assert.ok(exitKeyPlan().clear.includes('shorts'));
});

test('exitKeyPlan: deviceId is rotated, never merely cleared', () => {
  // Load-bearing. The stale device row on the server is an active restore path: clearing
  // localStorage alone lets the next boot pull the "deleted" state straight back down.
  const { rotate, clear, keep } = exitKeyPlan();
  assert.deepEqual(rotate, ['deviceId']);
  assert.ok(!clear.includes('deviceId'));
  assert.ok(!keep.includes('deviceId'));
});

test('exitKeyPlan: the three dispositions are disjoint and cover the inventory', () => {
  const { clear, keep, rotate } = exitKeyPlan();
  const all = [...clear, ...keep, ...rotate];
  // Non-vacuity first: an empty plan satisfies "disjoint" and "covers" trivially, so assert the
  // inventory is real before asserting anything about its shape.
  assert.ok(all.length >= 14, `plan covers only ${all.length} keys`);
  assert.equal(new Set(all).size, all.length, 'a key appears under two dispositions');
  assert.deepEqual(new Set(all), new Set(Object.keys(EXIT_DISPOSITION)));
});

test('exitKeyPlan: an unknown disposition is rejected rather than silently dropped', () => {
  assert.throws(() => exitKeyPlan({ channels: 'clear', mystery: 'maybe' }), /mystery/);
});

test('every SK key in app.js has an exit disposition', () => {
  // Drift guard. Without this, adding an SK key defaults it to SURVIVING a sign-out — the exact
  // shape of this bug. Reads the real app.js so no second copy of the key list can rot.
  const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const block = src.match(/const SK = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not find the SK object in app.js — update this guard');
  const names = [...block[1].matchAll(/^\s{2}(\w+)\s*:/gm)].map(m => m[1]);
  assert.ok(names.length >= 14, `parsed only ${names.length} SK keys — the guard is not seeing them`);
  for (const n of names) {
    assert.ok(n in EXIT_DISPOSITION, `SK.${n} has no exit disposition — classify it in lib/pure.js`);
  }
  // And the reverse. Without this a typo in EXIT_DISPOSITION ('tweetcache') passes every test:
  // clearLocalIdentity does localStorage.removeItem(SK[name]) → removeItem(undefined), which removes
  // a key literally named "undefined" and leaves the real one behind — the original bug, silently.
  // Verified by mutation: before this assertion, adding a bogus key kept the suite at 295 green.
  for (const n of Object.keys(EXIT_DISPOSITION)) {
    assert.ok(names.includes(n), `EXIT_DISPOSITION.${n} matches no SK key — typo? it would clear nothing`);
  }
});

// ── sameSyncedState / canonicalJson ──────────────────────
//
// The client-path tests (A1-A5 in test/sync-conflict-client.test.mjs) cover what a real boot can
// produce. These cover the two properties a real boot CANNOT currently exercise — collectSyncedState
// always emits exactly six keys, so no client state can put an extra key on one side — and which
// would therefore be unfalsifiable if pinned only there.
test('sameSyncedState: a key the SERVER holds and local does not is a difference', () => {
  // The union of keys, not local's alone. Errs to "different", which is the direction that costs a
  // refusal rather than the direction that destroys the next boot's data.
  assert.equal(sameSyncedState({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(sameSyncedState({ a: 1, b: 2 }, { a: 1 }), false);
  assert.equal(sameSyncedState({ a: 1 }, { a: 1 }), true);
});

test('sameSyncedState: arrays are SEQUENCES — a reordering is a difference', () => {
  // `channels`, `done` and `archive` are ordered lists. Folding them to sets would let a real
  // difference reconcile away silently.
  assert.equal(sameSyncedState({ done: ['a', 'b'] }, { done: ['b', 'a'] }), false);
  assert.equal(sameSyncedState({ done: ['a', 'b'] }, { done: ['a', 'b'] }), true);
});

test('sameSyncedState: nested key order is NOT a difference (Postgres jsonb reorders)', () => {
  // jsonb stores keys sorted by length then bytewise, so a row read back is routinely a key-for-key
  // reordering of what was sent — at every depth, not just the top.
  const local  = { channels: [{ id: 'UC1', name: 'x', source: 'youtube' }] };
  const server = { channels: [{ source: 'youtube', name: 'x', id: 'UC1' }] };
  assert.equal(sameSyncedState(local, server), true);
});

test('sameSyncedState: a non-object on either side is never identical', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(sameSyncedState(bad, { a: 1 }), false, `local ${JSON.stringify(bad)}`);
    assert.equal(sameSyncedState({ a: 1 }, bad), false, `server ${JSON.stringify(bad)}`);
  }
});
