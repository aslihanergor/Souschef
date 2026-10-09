// Pure, DOM-free helpers extracted from app.js so they can be unit-tested (TASK-081).
// `.js`, not `.mjs`: package.json is `"type":"module"` so Node reads this as ESM, and
// dev-server.mjs has no `.mjs` MIME entry — a `.mjs` would be served wrong and the browser
// would refuse the module. app.js imports these; test/pure.test.mjs imports the same file
// the browser loads, so there is no second copy to drift.

// [BUG-112] OUR month names, not the viewer's. This used to end in
// `toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })`, which runs in the READER's
// browser and takes its abbreviations from that device's locale data — so September came back
// "Sept" while all eleven other months came back with three letters, and two people could see
// different text for the same post. `getDate`/`getMonth` are local-time reads, exactly as
// `toLocaleDateString` formatted in local time, so the day and month shown are unchanged; only
// the name is now ours. Localising the UI would replace this table, not restore the old call.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function timeAgo(iso) {
  const diff  = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  < 7)  return `${days}d ago`;
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A remote URL is fit for an `href` only if it is absolute http(s). Anything else — `javascript:`,
// `data:`, a relative or protocol-relative path, a non-string — is null, and the caller renders no link.
// esc() escapes HTML, not schemes, so every href built from a feed's URL goes through here. ([BUG-023])
export function safeHref(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  return /^https?:\/\//i.test(u) ? u : null;
}

// Case- and Turkish-diacritic-insensitive fold, so "ornek"/"Ornek"/"örnek" all match.
// Plain .toLowerCase() only folds case — it leaves ö/ı/ş/ç/ğ/ü as distinct characters from o/i/s/c/g/u.
export function foldTurkish(str) {
  return String(str)
    .replace(/İ/g, 'i').replace(/I/g, 'i')
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g');
}

// Keyword filter (chips, TASK-044): `channel.keyword` is stored as a comma-separated list of
// terms ("chips"). A title/text matches if it matches ANY chip (OR between chips); a chip with
// several words matches only when the title contains ALL of them (AND within a chip, any order
// or position). Empty = no filter. Case- and Turkish-diacritic-insensitive via foldTurkish.
//   ""                  => matches everything
//   "review, unboxing"  => contains "review" OR "unboxing"
//   "dunya kupasi ozet" => contains "dunya" AND "kupasi" AND "ozet"   (one chip, all three)
//   "formula 1, f1"     => (contains "formula" AND "1") OR contains "f1"
// See parseKeywordChips (display) vs foldKeywordChips (match).
export function parseKeywordChips(keyword) {
  // Raw display terms (chips) for the input UI — original casing preserved, comma-separated.
  return (keyword || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Match-time form: each chip → its folded words (all required); chips are OR'd.
export function foldKeywordChips(keyword) {
  return parseKeywordChips(keyword).map(chip => foldTurkish(chip).split(/\s+/).filter(Boolean));
}

export function matchesKeywordChips(foldedTitle, chipWordLists) {
  if (chipWordLists.length === 0) return true;
  return chipWordLists.some(words => words.every(w => foldedTitle.includes(w)));
}

// Lookback for a newly added channel (TASK-030). Adding a channel used to hand you its last
// 14 days (`WINDOW_DAYS`, api/feed.js) — five channels on setup meant ~35 items, the backlog
// wall the feed exists to remove. So a channel added from now on contributes only what it
// published in the 24h before it was added; channels with no `addedAt` keep the old behaviour.
const LOOKBACK_MS = 86_400_000;
const LOOKBACK_FLOOR = 2; // ...but never blank — see below.

// Call order matters: keyword filter → applyLookback → done/archive. Running the floor AFTER
// the done set would mean clearing the floored items empties the channel again, so the floor
// would reach for the next older item, and the next — walking backwards through the whole
// backlog forever. Filter first, hide second.
export function applyLookback(items, addedAt, now = Date.now(), floor = LOOKBACK_FLOOR) {
  // Parse once, carrying the input index: recency picks the top-ups, but the caller gets its
  // original order back (loadFeed sorts the merged feed itself). Undated items can't be
  // reasoned about — drop them, as the callers already did.
  const dated = [];
  items.forEach((item, i) => {
    const t = Date.parse(item?.published);
    if (!Number.isNaN(t)) dated.push({ item, t, i });
  });

  // No usable addedAt — a channel from before this shipped, or a hand-edited blob. Fall back to
  // the server's 14-day window, exactly as before.
  const raw = Number(addedAt);
  if (!Number.isFinite(raw) || raw <= 0) return dated.map(d => d.item);

  // A FUTURE addedAt is different: it means "there is an anchor, the clock is just off". The
  // adding device stamps it and a different device evaluates it, so drift is routine. Falling
  // back there would restore the exact backlog wall this feature removes, and then silently
  // self-heal once real time catches up — a bug nobody can reproduce from a report. Clamp
  // instead: skew costs a few minutes of slightly-too-little content, never the wall.
  const added = Math.min(raw, now);

  const anchor = added - LOOKBACK_MS;
  const inside = dated.filter(d => d.t >= anchor);

  // Never blank: a weekly Substack added on a Tuesday clears nothing, and an empty
  // "You're all caught up" as your FIRST screen reads as broken, not finished. So when the
  // channel would contribute NOTHING, fall back to its newest few.
  //   Fires only at zero, not below `floor`: one fresh item isn't a blank screen, and topping
  //   up to two would hand you something published before you added the channel while it
  //   already has something to show. The floor is an emptiness guard, not a quota.
  // It can only reach as deep as the caller's list — the server's 14-day window (api/feed.js).
  // That's the intent: the anchor must never leave a channel emptier than that window would,
  // and a channel already silent for 14 days is silent for reasons that predate this.
  const kept = inside.length > 0 ? inside
    : dated.slice().sort((a, b) => b.t - a.t).slice(0, floor);

  return kept.sort((a, b) => a.i - b.i).map(d => d.item);
}

// The three feed filters below all run the same three stages, and this is the ONLY place that
// order is written down (TASK-030):
//   1. keyword — so the lookback's never-blank fallback can only surface something the user
//      actually asked to see;
//   2. applyLookback — a newly added channel starts on its last 24h;
//   3. hidden (done ∪ archived) — what the user already handled.
// Stage 3 MUST stay last. Run it before stage 2 and the fallback computes over unhidden items
// only: clear the surfaced items and the channel is "empty" again, so it surfaces the next two,
// and the next — walking backwards through the whole backlog, and a finishable feed stops being
// finishable. Pinned by the ordering tests in test/pure.test.mjs.
function selectChannelItems(items, channel, hiddenSet, idOf, textOf) {
  const kwChips = foldKeywordChips(channel.keyword);
  const matched = items.filter(it =>
    idOf(it) && it.published && matchesKeywordChips(foldTurkish(textOf(it)), kwChips));
  return applyLookback(matched, channel.addedAt).filter(it => !hiddenSet.has(idOf(it)));
}

// The server (/api/feed) already fetched, normalized, Shorts-filtered, and windowed the items.
export function filterFeedItems(rawItems, channel, hiddenSet) {
  return selectChannelItems(rawItems, channel, hiddenSet, i => i.videoId, i => i.title)
    .map(({ videoId, title, published }) => ({ videoId, title, published, channel }));
}

// Tweets: mapped to the shape the source-aware renderer (renderTweetCard) consumes. Keyword
// matches on text. Note this runs over the merged local `tweetCache`, not a fresh response —
// so the lookback has to apply here too, or cached posts would slip past the anchor.
export function filterTweetItems(tweets, channel, hiddenSet) {
  return selectChannelItems(tweets, channel, hiddenSet, t => t.id, t => t.text || '')
    .map(t => ({ source: 'twitter', id: t.id, text: t.text, published: t.published,
      media: t.media, imageUrl: t.imageUrl, url: t.url, urls: t.urls, quoted: t.quoted, channel }));
}

// Substack posts (TASK-022): mapped to the shape renderSubstackCard consumes. Keyword matches on
// the title + subtitle. Stateless like YouTube (the server returns the latest posts each load).
export function filterSubstackItems(posts, channel, hiddenSet) {
  return selectChannelItems(posts, channel, hiddenSet, p => p.id, p => `${p.title} ${p.subtitle || ''}`)
    .map(p => ({ source: 'substack', id: p.id, title: p.title, subtitle: p.subtitle,
      url: p.url, author: p.author, published: p.published, preview: p.preview,
      cover: p.cover, channel }));
}

// ── The boot gate: who sees the landing (TASK-027 → TASK-084) ─────────────────
// Signing in is the only way into the app, so a signed-out visitor sees the landing on EVERY boot.
//
// `landingSeen` is deliberately NOT destructured, and that is the whole point of this signature.
// TASK-027's predicate was `!landingSeen && !signedIn`, and every user who took the old "Continue
// without an account" still carries SK.landing = 'true' — so reading it here would wall them out of
// their own channels forever. Callers may still pass it; it is ignored, and a test asserts that no
// value of it can change the result.
export function shouldShowLanding({ signedIn } = {}) {
  return !signedIn;
}

// ── Which colour a screen is shown in ([TASK-109]) ───────────────────────────
// The sign-in wall is always light, whatever is stored; every other screen shows the stored choice when
// it is 'light' or 'dark', else light. The phone's own setting is never read — the app is light unless
// its reader chose Dark. showView applies this; the inline <head> script in app/index.html makes the
// first-frame guess before the session is known.
export function themeForView(viewId, stored) {
  if (viewId === 'view-landing') return 'light';
  return stored === 'light' || stored === 'dark' ? stored : 'light';
}

// ── What sign-out and delete leave behind (BUG-017) ───────────────────────────
// Both exits used to clear exactly one key (SK.landing), so the next account to sign in on this
// browser inherited the previous person's channels, done-set and archive. The policy of WHICH keys
// go is pure and lives here; the clearing itself touches localStorage and stays in app.js.
//
// Keys are named by their SK property, not their storage string, so this survives a rename of the
// underlying 'focus_*' values. Every SK key must appear here — a test parses app.js and fails if
// one doesn't, because the default for a forgotten key is to SURVIVE a sign-out, which is the bug.
//
//   'clear'  — removed from localStorage on both exits
//   'keep'   — deliberately left in place
//   'rotate' — replaced with a fresh value, not merely removed
export const EXIT_DISPOSITION = {
  channels:     'clear',
  done:         'clear',
  archive:      'clear',
  groups:       'clear',
  // A synced *preference*, but it changes which content appears — inheriting it leaks. Contrast
  // `theme` below: that is the one preference with no bearing on what you see.
  shorts:       'clear',
  theme:        'keep',
  // Device-local caches. Regenerable, but they hold the departing user's content verbatim.
  tweetCache:   'clear',
  lastFeedLoad: 'clear',
  lastView:     'clear',
  // Sync bookkeeping. `dirty` must not outlive the state it describes, or the next boot would
  // keep an empty local state over a good server row (BUG-015's guard, inverted).
  dirty:        'clear',
  // The row version local is based on. MUST clear wherever `channels` does — and the reason written
  // here first was BACKWARDS, corrected in review round 4. The hazard is NOT "a write with no base
  // is accepted unconditionally": a write with no base can only ever CREATE, so a browser that has
  // been emptied and kept no rev is harmless. The hazard is a base that STILL MATCHES. The exit
  // wipes `channels` and leaves the row untouched, so a surviving rev is a valid, current base for a
  // row this browser no longer has any business writing to — and the emptied blob is then ACCEPTED,
  // which is [BUG-047] returning through the exit path, the one route nobody looks at.
  // Pinned as an invariant over this table rather than as a scenario, because the failure is a
  // MISSING entry.
  rev:          'clear',
  events:       'clear',
  // The grouped-view preference ([TASK-099]). Device-local, so it is never uploaded — but the next
  // account on this browser must not inherit the previous person's view, and the default for a
  // forgotten key is to SURVIVE, which is [BUG-017]'s exact shape.
  groupView:    'clear',
  // KEPT, and not for the user's benefit: `signout` is only ever emitted by spotting the
  // authed→not-authed transition on the NEXT boot (app.js, TASK-070), which needs this flag to
  // survive the exit. Clearing it silently zeroed the metric on the owner dashboard (TASK-087).
  // It holds '1' and nothing else — no personal content to leak.
  wasAuthed:    'keep',
  // Vestigial since TASK-084 (nothing reads or writes it), but deliberately still cleared: real
  // browsers hold 'true' from the removed skip, and dropping the entry would strand that value
  // forever rather than tidying it on the way out.
  landing:      'clear',
  // The first-run tour's record ([TASK-092]). Device-local and never synced, but it describes what
  // THIS person has seen, so the next account on this browser must get its own tour — and a surviving
  // record would silently deny it one, since a present record is one of the reasons not to start.
  tour:         'clear',
  // Load-bearing, and load-bearing for SIGN-OUT specifically: api/auth/logout.js deliberately
  // deletes no device row, so the server keeps a stale snapshot from sign-in time. While this id
  // persists the next anonymous boot pulls that state straight back down — rotation is the only
  // thing that makes the row unreachable. (On delete, api/auth/delete.js does remove the row when
  // the client sends its id, so rotation is belt-and-braces there rather than the mechanism.)
  // Clearing would also work (getDeviceId() regenerates); 'rotate' names the intent — a new
  // identity, not an absent one.
  deviceId:     'rotate',
};

const EXIT_DISPOSITIONS = ['clear', 'keep', 'rotate'];

// Group the disposition map into the three lists app.js acts on. Throws on an unrecognised
// disposition rather than dropping the key, so a typo fails loudly instead of silently leaving
// someone's channels behind.
export function exitKeyPlan(disposition = EXIT_DISPOSITION) {
  const plan = { clear: [], keep: [], rotate: [] };
  for (const [name, verb] of Object.entries(disposition)) {
    if (!EXIT_DISPOSITIONS.includes(verb)) {
      throw new Error(`unknown exit disposition '${verb}' for key '${name}'`);
    }
    plan[verb].push(name);
  }
  return plan;
}

// ── The first-run tour ([TASK-092]) ───────────────────────────────────────────
// Every DECISION the tour makes lives here, so it is tested directly; app.js only draws the result and
// reports events into `tourStep`. Nothing here writes channels, read state or anything synced — the
// record is one device-local key.
//
// THE RECORD is `{ at, card?, replay? }`, where `at` is how far the tour has got:
//   'setup'        — a setup card is showing (`card` says which)
//   'wait-channel' — OK was pressed on card 4; the dim is lifted until the first channel lands
//   'tip'          — the "Open my feed" tip is showing
//   'wait-feed'    — waiting for the first feed that renders
//   'feed'         — a feed card is showing (`card` says which)
//   'done'         — finished or closed; nothing more happens on this device unless replayed
// The task names three waits; the "showing" states are what let a reload or the YouTube import
// round-trip come back to the same card without a second `tour_start` (criterion 13).
export const TOUR_CARDS = {
  setup: ['tabs', 'add', 'import', 'wait'],
  feed:  ['done', 'archive', 'topics', 'gear', 'end'],
};
const TOUR_AT = ['setup', 'wait-channel', 'tip', 'wait-feed', 'feed', 'done'];

// Wording and targets are mock version 2's, which Asli settled (UI & states). `target` names what the
// ring is FOR; app.js resolves it to an element, and null means a centred card with no highlight.
const TOUR_COPY = {
  tabs:    { text: 'Pick where to add from: YouTube, X or Substack.', target: 'tabs' },
  add:     { text: 'Type a name, @handle or link, then confirm it.', target: 'add' },
  import:  { text: 'Or bring in the channels you already subscribe to.', target: 'import' },
  wait:    { text: 'Add your first channel. “Open my feed” appears when you do.', target: null },
  tip:     { text: 'Your feed is ready. Tap here to open it, or OK to add more first.', target: 'go' },
  done:    { text: 'Done clears it. Your feed shrinks as you read.', target: 'done' },
  archive: { text: 'Archive keeps it for later, under Archive at the bottom.', target: 'archive' },
  topics:  { text: 'Groups X posts by topic. It lights up when topics are ready.', target: 'topics' },
  gear:    { text: 'Manage channels, theme, and replay this tour.', target: 'gear' },
  end:     { text: 'When everything’s done you’ll see “You’re all caught up”. That’s the point.', target: null },
};

/** Whether a boot may START the tour (criteria 1–2). Every term is required, and each one is there
 *  because "no channels" alone does not mean "new account": a failed or refused boot read, and a
 *  damaged store, both leave local storage looking empty for an EXISTING account (Risk 2). `record`
 *  is the raw stored value — any value at all, readable or not, means this device already has a tour. */
export function shouldStartTour({ signedIn, stateLoaded, damaged, channels, archived, record } = {}) {
  if (signedIn !== true) return false;
  if (stateLoaded !== true) return false;
  if (damaged !== false) return false;
  if (channels !== 0) return false;
  if (archived !== 0) return false;
  return record == null;
}

/** The cards of a part that survive the skip rule (criterion 9). Import exists only on the YouTube
 *  tab; card 4 ("Add your first channel") is dropped whenever "Open my feed" is already showing,
 *  because the tip needs that button to point at (amendment 3); the topics card only when an X
 *  account is followed. Done and Archive are never skipped: the feed part only starts once a post is visible in the
 *  stream (amendments 11, 12), and if the reader empties it under them they show centred. */
export function tourCards(part, { source = 'youtube', hasX = false, hasContent = false } = {}) {
  if (part === 'setup') {
    return TOUR_CARDS.setup.filter((c) => (c !== 'import' || source === 'youtube') && (c !== 'wait' || !hasContent));
  }
  if (part === 'feed') return TOUR_CARDS.feed.filter((c) => c !== 'topics' || hasX);
  return [];
}

// Where `card` sits in the surviving list. A card that no longer survives — its tab changed, or a
// resumed record meets different circumstances — resolves to the next card that does, else the last.
function tourIndex(part, card, cards) {
  const i = cards.indexOf(card);
  if (i !== -1) return i;
  const order = TOUR_CARDS[part];
  const from = order.indexOf(card);
  const next = cards.findIndex((c) => order.indexOf(c) > from);
  return next === -1 ? cards.length - 1 : next;
}

/** One event applied to the record: 'next' | 'back' | 'ok' | 'close' (Escape is a close) | 'channel'
 *  (the first channel landed) | 'go' (Open my feed was tapped) | 'feed' (a feed render worked; `ctx.feedHasPost`
 *  says whether it left a post the reader can see in the stream — only one that did starts the feed part,
 *  amendments 11 and 12).
 *  Returns `{ record, emit }`. An event that changes nothing returns the SAME record object, so the
 *  caller can tell there is nothing to write; `emit` is the analytics event to record, or null. */
export function tourStep(rec, event, ctx = {}) {
  const same = { record: rec, emit: null };
  if (!rec || rec.at === 'done') return same;          // finished raises nothing (criterion 6)
  const replay = !!rec.replay;

  if (event === 'close') {
    if (rec.at !== 'setup' && rec.at !== 'tip' && rec.at !== 'feed') return same;   // nothing showing
    const card = rec.at === 'tip' ? 'tip' : tourIndexCard(rec, ctx);
    return { record: { at: 'done' }, emit: { name: 'tour_close', props: { part: rec.at, card, replay } } };
  }
  if (event === 'channel') {
    return rec.at === 'setup' || rec.at === 'wait-channel' ? { record: { at: 'tip', replay }, emit: null } : same;
  }
  if (event === 'feed') {
    // A render with no post in the stream keeps the wait, because Done and Archive would have nothing to point at:
    // caught up or only the X-unavailable note (Asli's handset walk, amendment 11), or every post filed into a topic
    // or held while grouping runs (amendment 12). Once the part has started, an emptied feed is not this branch's
    // business; the cards show centred.
    return rec.at === 'wait-feed' && ctx.feedHasPost === true
      ? { record: { at: 'feed', card: tourCards('feed', ctx)[0], replay }, emit: null } : same;
  }
  if (rec.at === 'tip') {
    return event === 'ok' || event === 'go' ? { record: { at: 'wait-feed', replay }, emit: null } : same;
  }
  if (rec.at !== 'setup' && rec.at !== 'feed') return same;

  const part = rec.at;
  const cards = tourCards(part, ctx);
  const i = tourIndex(part, rec.card, cards);
  if (event === 'back') {
    return i > 0 ? { record: { at: part, card: cards[i - 1], replay }, emit: null } : same;
  }
  if (event === 'ok') {
    return part === 'setup' && cards[i] === 'wait' ? { record: { at: 'wait-channel', replay }, emit: null } : same;
  }
  if (event === 'next') {
    if (part === 'setup' && cards[i] === 'wait') return same;   // card 4 is left by OK, never by Next
    if (i + 1 < cards.length) return { record: { at: part, card: cards[i + 1], replay }, emit: null };
    if (part === 'setup') return { record: { at: 'tip', replay }, emit: null };
    return { record: { at: 'done' }, emit: { name: 'tour_finish', props: { replay } } };
  }
  return same;
}
function tourIndexCard(rec, ctx) {
  const cards = tourCards(rec.at, ctx);
  return cards[tourIndex(rec.at, rec.card, cards)];
}

/** What the card shows for this record, or null when nothing is showing. `count` is recalculated
 *  from the cards that will show NOW, at every call (amendment 1); Back is disabled on the first card
 *  of each part, and the tip is a part of its own, so Back never crosses a step the reader had to act
 *  on (criterion 3). */
export function tourView(rec, ctx = {}) {
  if (!rec) return null;
  if (rec.at === 'tip') {
    return { part: 'Tip', card: 'tip', text: TOUR_COPY.tip.text, count: '', backDisabled: true, main: 'OK', target: TOUR_COPY.tip.target };
  }
  if (rec.at !== 'setup' && rec.at !== 'feed') return null;
  const cards = tourCards(rec.at, ctx);
  const i = tourIndex(rec.at, rec.card, cards);
  const card = cards[i];
  const last = i === cards.length - 1;
  const main = card === 'wait' ? 'OK' : rec.at === 'feed' && last ? 'Done' : 'Next';
  return {
    part: rec.at === 'setup' ? 'Setup' : 'Your feed',
    card,
    text: TOUR_COPY[card].text,
    count: `${i + 1} of ${cards.length}`,
    backDisabled: i === 0,
    main,
    target: TOUR_COPY[card].target,
  };
}

/** The stored record, read defensively. Absent is null (no tour on this device). Anything unreadable
 *  — not JSON, not an object, an unknown `at` — reads as finished, so a damaged key fails to the plain
 *  app rather than to a card (criterion 15). */
export function parseTourRecord(raw) {
  if (raw == null) return null;
  let v;
  try { v = JSON.parse(raw); } catch { return { at: 'done' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !TOUR_AT.includes(v.at)) return { at: 'done' };
  return v;
}

// ── Bullets ([BUG-089]) ──────────────────────────────────────────────────────
// A topic's summary bullet is `string | {text, item_ids}`. The object form records WHICH POSTS the
// bullet describes, which is the whole of BUG-089: without it nothing knows what to remove when a
// post is read, so a topic reported "1 post" above 8 bullets on a real handset.
//
// The bare string is not legacy — it is the live representation of a bullet with NO ids, and one has
// to exist because the safe default is always KEEP. Deleting a bullet that describes an unread post
// is the [BUG-070]/[BUG-073] failure class and is worse than the bug being fixed. Keeping the
// id-less form as a plain string is also what makes the change additive across the existing grouping
// suite, whose fake model replies are all id-less strings.
//
// Normalise on READ, minimise on WRITE. api/_group.js carries its own copy of these three, for the
// same reason `topicKey` is copied there rather than imported (no api/ module imports lib/pure.js);
// test/group-bullets.test.mjs drives both over the same values so the copies cannot drift silently.
export function bulletText(b) {
  if (typeof b === 'string') return b;
  return (b && typeof b.text === 'string') ? b.text : '';
}
// Always an array of non-empty strings. A malformed `item_ids` reads as NO ids, which routes the
// bullet to the keep-forever default rather than to a delete.
export function bulletIds(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.item_ids)) return [];
  return b.item_ids.filter(id => typeof id === 'string' && id);
}
// The wire/storage form: a bullet with no ids is a bare string, never {text, item_ids: []}.
export function bulletOut(text, ids) {
  return (Array.isArray(ids) && ids.length) ? { text, item_ids: [...ids] } : text;
}
// Is this bullet still worth showing? A bullet with NO ids always is — an id we cannot resolve, or
// one the model never gave, is not evidence that the post was read. Otherwise it lives while at
// least one post it names is still unread.
export function bulletIsLive(b, unreadIds) {
  const ids = bulletIds(b);
  if (!ids.length) return true;
  return ids.some(id => unreadIds.has(id));
}

// ── Is local state already identical to the server row? ([BUG-047] review round 4, must-fix A) ──
//
// The absorbing state this closes: `syncOnLoad`'s dirty branch returns before the re-base, so the
// push it fires declares a stale or absent base, is refused, and `dirty` is never cleared — because
// only a 200 clears it. The next boot repeats it identically, forever. Measured over three boots:
// `dirty=1 rev=null`, the same notice each time, the un-pushed channel never reaching the server.
//
// The everyday trigger is NOT the rollout, which is what made this a blocker rather than a cost. The
// unload flush sends a `keepalive` state push, which by design outlives the document — so the write
// LANDS and the response carrying the new rev is never read. `SK.rev` is then one version behind a
// row this same browser wrote. Mark a video done, close the tab, reopen: sync dead. That is the
// app's core mobile interaction.
//
// The fix is provably safe because it grants no power: if local is byte-identical to the row, then
// writing local over the row would change nothing, so treating it as "not un-pushed" cannot destroy
// anything. It is the keepalive case exactly.
//
// WHICH DIRECTION TO ERR IN, and it is not symmetric. A false "different" costs a refusal and the
// notice — recoverable, visible, no data lost. A false "identical" clears `dirty` while local really
// IS ahead, and then the NEXT boot takes the pull-down branch and overwrites the un-pushed change
// with the server row. So every uncertainty here resolves to "different".
//
// Hence the union of keys rather than a fixed list: a key present on one side and absent on the
// other reads as different, which is the safe answer and needs no shared constant to stay in step
// with SYNCED_KEYS.
export function sameSyncedState(local, server) {
  if (!local || typeof local !== 'object' || Array.isArray(local)) return false;
  if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
  const keys = new Set([...Object.keys(local), ...Object.keys(server)]);
  for (const k of keys) {
    if (canonicalJson(local[k]) !== canonicalJson(server[k])) return false;
  }
  return true;
}

// Stable-key JSON, and it is not a nicety. The server round-trips state through Postgres `jsonb`,
// which does NOT preserve key order — it stores keys sorted by length then bytewise. So the row read
// back from a GET can be a key-for-key reordering of what this browser sent, and a plain
// `JSON.stringify` comparison would call an identical state different on every real request while
// passing against any hand-built fixture. That is the "green, correct, and measuring the wrong
// quantity" shape: it fails SAFE here, but it fails always, so the fix would never actually fire.
//
// Arrays keep their order — `channels`, `done` and `archive` are ordered lists and a reordering is a
// real difference. `undefined` is distinguished from absent by nothing, which is correct: JSON has
// no undefined, so neither side can ever hold one after a round trip.
export function canonicalJson(value) {
  return JSON.stringify(canonicalise(value));
}
function canonicalise(v) {
  if (Array.isArray(v)) return v.map(canonicalise);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalise(v[k]);
    return out;
  }
  return v;
}
