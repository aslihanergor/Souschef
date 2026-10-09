// [TASK-104] — THE FEED APPBAR REWORK.
//
// Three asks from Asli (2026-08-28): the date comes out, the gear moves to the LEFT of row 1 with
// the wordmark dropping to row 2 beside the count, and the "Posts" head gets breathing room. Plus
// one decision taken at scoping (2026-08-29): "Mark all done" moves into the settings panel rather
// than being deleted, because ungrouped is the DEFAULT view — where no topic card exists — and
// grouping is X-only, so a YouTube-only reader would never see a per-topic button at all.
//
// WHY SOURCE-TEXT ASSERTIONS FOR HALF OF THIS. The harness fabricates a stub for any id asked for,
// so "the date element is gone" is not observable through it — `el('feed-date')` answers with a
// perfectly good object either way. Layout is verify-by-looking by project rule, and the caret
// offset (criterion 9) and the safe-area inset are handset measurements. What IS pinned here is the
// half that regresses silently: element placement, and the ORDER of the panel close against the
// toast. Precedent for the shape: test/public-landing.test.mjs and test/landing.test.mjs:479.
//
// WHICH TESTS COULD RED BEFORE THE FIX — predicted BEFORE running, because a merely-red suite hides
// the one that passed for the wrong reason (CLAUDE.md, Mutation batteries):
//
//   RED before the fix   — T1 (date in markup), T2 (todayLabel in app.js), T3 (mark-all not in the
//                          panel), T5 (toast raised behind the panel), T7b (mark-all not seeded
//                          hidden), T8 (#videos-head override present), T9 (wordmark before the
//                          controls in row 1).
//   GREEN before the fix — T4, T6 and T7a are GUARDS on behaviour that must SURVIVE the move, not
//                          proofs of the change. T5b is the CONTROL: it proves this file can SEE a
//                          toast raised behind the panel, which is what makes T5's pass meaningful
//                          rather than an instrument that always answers `false`. Declared rather
//                          than quietly counted as coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../test-helpers/app-harness.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
// Commented-out markup is not markup — deleting a tag by wrapping it in <!-- --> must read as
// deletion, not as "still there". Same guard public-landing.test.mjs carries, for the same reason.
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

const HTML = () => stripComments(read('app/index.html'));
const APPJS = () => read('app.js');
// Comments stripped for the same reason the HTML is: a rule inside a comment is not a rule.
// This bit at the GREEN step — the replacement comment in style.css spells out the deleted override
// verbatim, and the raw-text version read its own explanation as the thing it was looking for. The
// assertion was right; the instrument could not tell code from prose. T8b is the control.
const CSS = () => read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');

// The feed view only. The ARCHIVE screen has its own appbar with its own gear, and this task
// deliberately does not touch it — a whole-file search would happily match that one instead.
const feedView = (html) => {
  const a = html.indexOf('id="view-feed"');
  const b = html.indexOf('id="view-archive"');
  assert.ok(a >= 0 && b > a, 'guard: the feed view must precede the archive view in the markup');
  return html.slice(a, b);
};

const PUBLISHED = Date.now() - 2 * 86400_000;
const xPost = (id) => ({
  id, source: 'twitter', text: `post ${id} says something`, published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});

function boot({ signedIn = false } = {}) {
  const app = createApp({ store: { focus_device_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
  // The classify must not be what decides these outcomes, so it returns nothing placeable.
  app.setFetch(async (url) => {
    if (String(url).includes('/api/auth/me')) {
      return signedIn
        ? { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) }
        : { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ groups: [], capped: false }) };
  });
  return app;
}

/** Signed in FOR REAL, which any test that changes view needs.
 *  `showView` coerces every id to 'view-landing' while `_authEmail` is unset (app.js), so a
 *  signed-out fixture never reaches the screen it names — it asserts against the sign-in wall and
 *  passes for the wrong reason. Measured 2026-08-29: T16 was doing exactly that, and a mutation
 *  leaving the bulk control live on Archive and Setup survived it. */
async function bootSignedIn() {
  const app = boot({ signedIn: true });
  await app.ctx.checkAuth();
  return app;
}

/** Is `needle` inside the element whose opening tag `opener` matches? A DEPTH WALK, because index
 *  comparison cannot see nesting — the lesson T10b was rewritten for. */
function insideBlock(html, opener, needle) {
  const at = html.search(opener);
  if (at < 0) return false;
  const openAt = html.lastIndexOf('<div', at);
  let depth = 0, closeAt = -1;
  for (const m of html.slice(openAt).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { closeAt = openAt + m.index; break; }
  }
  const n = html.indexOf(needle);
  return closeAt > openAt && n > openAt && n < closeAt;
}
/** Render a feed the way a reader NORMALLY reaches one: `openFeedView` calls `showView('view-feed')`
 *  before `await loadFeed()`, so the common render happens with the feed on screen. From [TASK-104]
 *  round 6 that matters, because `updateCount` refuses to reveal a whole-feed bulk control while the
 *  reader is looking at something else.
 *  ⚠️ CORRECTED 2026-08-29. The first version of this said the old fixtures modelled "a state the app
 *  cannot be in". That is FALSE, and an independent reviewer caught it: both `renderFeedResults`
 *  callers sit after an `await`, so tapping Archive during a refresh lands a render into a hidden
 *  feed view for real. The fixture change is still right — it models the normal path, which is what
 *  these tests are about — but that off-feed render is now UNCOVERED here, and it is precisely what
 *  `feedSurfaceShowing()` exists to make safe. Recorded rather than left as a false justification. */
const render = (app, items) => {
  app.ctx.showView('view-feed');
  return app.ctx.renderFeedResults({ items, failed: [], cappedNames: [], totalChannels: items.length });
};
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };

// ── The three asks ──────────────────────────────────────────────────────────────────────────────

test('T1 the date is gone from the feed appbar', () => {
  assert.ok(!/id="feed-date"/.test(HTML()),
    'the date element must be deleted, not merely hidden — a hidden node still occupies the markup');
});

test('T2 todayLabel() is gone from app.js', () => {
  // Its ONLY caller was the date write (app.js:3554 before this change). A function left behind
  // with no caller is exactly the residue a "delete the element" change ships when nobody looks.
  assert.ok(!/todayLabel/.test(APPJS()),
    'todayLabel had one call site; deleting the element must take the function with it');
});

test('T9 row 1 is the gear then the switch, with the wordmark BELOW them', () => {
  const v = feedView(HTML());
  const gear = v.indexOf('id="btn-feed-manage"');
  const sw = v.indexOf('id="toggle-grouping"');
  const brand = v.indexOf('<h1>');
  assert.ok(gear >= 0 && sw >= 0 && brand >= 0, 'guard: all three must exist in the feed view');
  assert.ok(gear < sw, `gear must come before the switch in row 1 (gear ${gear}, switch ${sw})`);
  assert.ok(sw < brand,
    `the wordmark moves to row 2, so both controls precede it (switch ${sw}, wordmark ${brand})`);
});

test('T8 the "Posts" head keeps no top-margin override of its own', () => {
  // `#videos-head { margin-top: 2px }` existed because the head sat under the topics grid. In the
  // DEFAULT ungrouped view that grid is hidden, so the head is left 2px under the appbar — which is
  // the complaint. The fix is to DELETE the override and let .section-head's own 8px apply.
  const rule = CSS().match(/#videos-head\s*\{[^}]*\}/);
  assert.ok(!rule || !/margin-top/.test(rule[0]),
    `#videos-head must not override the section head's top margin; found ${JSON.stringify(rule && rule[0])}`);
});

test('T8b CONTROL: the stripped stylesheet still shows live rules', () => {
  // Without this, T8 passes against a reader that returns nothing at all — an instrument that cannot
  // disagree. `.section-head` carries the margin the override used to beat, so if this cannot be
  // seen, T8's silence means nothing. CLAUDE.md: a tool's silence is only evidence once you have
  // seen it break the silence.
  const rule = CSS().match(/\.section-head\s*\{[^}]*\}/);
  assert.ok(rule, 'guard: .section-head must still be a live rule in the stylesheet');
  assert.ok(/margin:/.test(rule[0]),
    `the reader must see real declarations, not just braces; got ${JSON.stringify(rule[0])}`);
});

test('T10 <div> opens and closes BALANCE across the markup', () => {
  // NAME CORRECTED after review: this counts, it does not parse. A compensating surplus-and-deficit
  // pair passes it, and it only sees <div> — a stray </span> or </aside> goes through. T10b is the
  // one that actually walks nesting. Both are kept: the count localises the error to "somewhere in
  // this file", which is what made the real defect findable in seconds.
  // THIS TEST EXISTS BECAUSE THE SUITE MISSED THE REAL BUG. The first cut of this change left ONE
  // surplus </div>: the replacement matched a six-space `</div>` INSIDE an eight-space one, ate the
  // wrong closing tag, and closed `.appbar` early. `#feed-body` was ejected out of `#view-feed`
  // altogether and the whole feed rendered 803px below the bar — a blank screen under a correct-
  // looking header, with 926 tests green. Every markup assertion here was about ORDER and
  // CONTAINMENT BY INDEX, and an index test cannot see nesting: the button really was between the
  // panel's start and its end, in a document where the panel no longer closed where it appeared to.
  //
  // Found by LOOKING, in a browser, which is exactly what the project rule is for ([TASK-084]
  // shipped a blank page past a green suite for the same reason: nothing could ask).
  const stripped = read('app/index.html').replace(/<!--[\s\S]*?-->/g, '');
  const open = (stripped.match(/<div\b/g) || []).length;
  const close = (stripped.match(/<\/div>\s*/g) || []).length;
  assert.equal(close, open,
    `unbalanced div COUNTS: ${open} opened, ${close} closed — a surplus close silently reparents` +
    ' everything after it, which renders as a blank screen rather than as an error');
});

test('T10b the feed body is still INSIDE the feed view, by DEPTH not by index', () => {
  // The specific consequence T10 generalises. The first version of this test compared string
  // INDEXES — and when the surplus </div> was reintroduced as a control, it stayed GREEN: the text
  // order never changed, only the nesting did. That is the same blind spot that let the bug through
  // in the first place, written a second time, and it was caught by running the mutation rather than
  // by re-reading the test. It now walks div depth and finds where the view actually closes.
  const html = read('app/index.html').replace(/<!--[\s\S]*?-->/g, '');
  const viewAt = html.indexOf('id="view-feed"');
  assert.ok(viewAt >= 0, 'guard: the feed view must exist');
  const openAt = html.lastIndexOf('<div', viewAt);
  let depth = 0, closeAt = -1;
  for (const m of html.slice(openAt).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { closeAt = openAt + m.index; break; }
  }
  assert.ok(closeAt > openAt, 'guard: the feed view must close somewhere');
  const bodyAt = html.indexOf('id="feed-body"');
  assert.ok(bodyAt > openAt && bodyAt < closeAt,
    `#feed-body must be nested inside #view-feed (view ${openAt}-${closeAt}, body ${bodyAt}) —` +
    ' a surplus close tag ejects it and the feed renders below the whole view');
});

// ── "Mark all done" moves into the settings panel ───────────────────────────────────────────────

test('T3 mark-all lives inside the settings panel, not in the appbar', () => {
  const html = HTML();
  const panelStart = html.indexOf('id="profile-panel"');
  const panelEnd = html.indexOf('</aside>', panelStart);
  const btn = html.indexOf('id="btn-mark-all"');
  assert.ok(panelStart >= 0 && panelEnd > panelStart, 'guard: the settings panel must exist');
  assert.ok(btn >= 0, 'guard: the button must still exist — this task moves it, it does not delete it');
  // Ids are unique, so proving it is INSIDE the panel proves it is no longer in the appbar.
  assert.ok(btn > panelStart && btn < panelEnd,
    `mark-all must sit inside the settings panel (panel ${panelStart}-${panelEnd}, button ${btn})`);
});

test('T4 GUARD: mark-all still follows the unread count', async () => {
  // Green before the fix and after. It keeps its id precisely so updateCount and showCaughtUp go on
  // working untouched.
  // ⚠️ SIGNED IN since [TASK-104] round 6, and this is a fixture correction rather than a weakening:
  // `showView` coerces every id to the sign-in wall while `_authEmail` is unset, so a signed-out
  // fixture never reaches the feed it claims to render — the same flaw measured in T16 on 2026-08-29.
  // It passed anyway because `updateCount` used to reveal regardless of which view was on screen,
  // which is the defect round 6 fixes. (Its own comment claiming it "would catch the move breaking
  // that contract" was false for a second reason too — see T32.)
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), false,
    'two unread posts — the control must be offered');
  app.ctx.markAllDone();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'nothing left unread — the control must go');
});

test('T7a GUARD: mark-all really does ship hidden in the markup', () => {
  // HIDDEN_IDS seeds the class itself, so T7b agrees with you about markup it never read. An
  // independent battery (2026-08-27) removed `hidden` from markup and `display:none` from CSS and
  // nothing failed, for exactly this reason. This is the half that reads the file.
  // Read the STRIPPED markup and match the button's own tag. Two defects, both measured: it read
  // app/index.html RAW, so leaving a commented-out copy of the class list above a
  // class-less button satisfied it; and its scope expression was inoperative (the button sits
  // outside the feed-view slice, so only the whole-file half ever matched).
  const tag = HTML().match(/<button[^>]*id="btn-mark-all"[^>]*>/);
  assert.ok(tag, 'the button must exist as LIVE markup, not only inside a comment');
  assert.match(tag[0], /class="[^"]*\bhidden\b[^"]*"/,
    'it must ship hidden, or updateCount has nothing to reveal');
  assert.match(tag[0], /class="[^"]*\bbtn-mark-all\b[^"]*"/,
    'and keep the class its tint and its harness seed both hang off');
});

test('T7b a fresh harness seeds mark-all hidden, so "it was revealed" can fail', () => {
  // Without this the button is absent from HIDDEN_IDS: a fresh stub starts with an EMPTY class set,
  // so `contains('hidden')` answers false and T4's first assertion passes whether or not the code
  // ever revealed anything. That is the vacuity trap HIDDEN_IDS' own comment documents.
  const app = boot();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'a button that ships hidden must start hidden in the harness too');
});

// ── The reachability requirement (criterion 5) ──────────────────────────────────────────────────

// NOTE ON WHY T5 EXISTS, corrected 2026-08-29 after measuring rather than reading. It was written
// on [CHR-032]'s account that a toast raised with the drawer open is painted BEHIND it and its Undo
// unreachable. That account is STALE: `.toast` was raised to z-index 62 on 2026-08-24 (commit
// 12743cb) to clear the drawer (61) and its scrim (60), and a live check with the drawer open finds
// `elementFromPoint` over the Undo returning `.toast-action`. So this pins a UX ordering — the
// drawer goes before the reader is told the screen changed — NOT a reachability guarantee. Kept at
// its stated value rather than deleted, and relabelled rather than left implying a safety property
// it does not have.
test('T5 marking all done closes the panel BEFORE raising the toast', async () => {
  const app = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  app.ctx.openProfile();
  assert.equal(app.el('profile-panel').classList.contains('open'), true, 'guard: the panel is open');
  app.toastLog.length = 0;
  app.ctx.markAllDone();
  const entry = app.toastLog.find(t => /Marked 2 as done/.test(t.text));
  assert.ok(entry, `the Undo toast must be raised; log was ${JSON.stringify(app.toastLog)}`);
  assert.equal(entry.profileOpen, false,
    'the drawer must be gone before the reader is told what happened behind it');
  // …and CLOSED, not merely un-classed. Replacing closeProfile() with a bare
  // `panel.classList.remove('open')` was a measured survivor: it leaves the scrim up, the scroll
  // locked and `aria-hidden="false"` stale, so assistive tech is still told a dialog is showing.
  assert.equal(app.el('profile-scrim').classList.contains('show'), false,
    'the scrim must come down too — it is what dims the page behind the drawer');
  assert.equal(app.el('profile-panel').getAttribute('aria-hidden'), 'true',
    'and the dialog must stop announcing itself as open');
});

test('T5b CONTROL: this file can SEE a toast raised behind the panel', () => {
  // Without this, T5 passes against an instrument that answers `false` unconditionally — the exact
  // shape of a reading that never had the ability to disagree. CLAUDE.md: a tool's silence is only
  // evidence once you have seen it break the silence.
  const app = boot();
  app.ctx.openProfile();
  app.toastLog.length = 0;
  app.ctx.showToast('a message nobody closed the panel for');
  const entry = app.toastLog.at(-1);
  assert.ok(entry, 'guard: the toast was recorded at all');
  assert.equal(entry.profileOpen, true,
    'a toast raised with the panel open must be REPORTED as such, or T5 proves nothing');
});

test('T6 GUARD: Undo still brings the posts back', async () => {
  // Green before and after. The whole reason mark-all may not hide behind the panel is that this
  // Undo is the only way back from a mistaken tap — so the Undo itself has to keep working.
  const app = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  app.ctx.markAllDone();
  assert.equal(app.el('caughtup').classList.contains('hidden'), false, 'guard: reader is caught up');
  app.ctx.undoMarkAll();
  assert.equal(app.el('caughtup').classList.contains('hidden'), true, 'undo leaves the caught-up screen');
  assert.equal(app.el('feed').style.display, '', 'and puts the feed back in front of the reader');
  assert.equal(JSON.parse(app.get('focus_done') || '[]').length, 0, 'with nothing left marked done');
});

// ── Tests added after an INDEPENDENT mutation battery (2026-08-29) ───────────────────────────────
//
// The battery ran 20 mutations and 7 SURVIVED — six of them in style.css, where only 1 of 7 died.
// That is the [TASK-101] precedent this task's own Verification section cites, walked into anyway:
// the author never wrote a battery at all, only spot-checked two tests. Each test below kills one
// named survivor. C6 (`.appbar-sub` back to `align-items: baseline`) is DECLARED UNPINNED and left
// to verify-by-looking: its worst case is a count sitting a pixel off a wordmark.

test('T11 every id app.js reaches for exists in the markup', () => {
  // Kills survivor A5: the date ELEMENT is deleted but a write to it survives in openFeedView. In a
  // browser getElementById returns null, `.textContent =` throws, and the feed never renders — a
  // blank screen. The harness cannot see it: it fabricates a stub for any id asked for, so the
  // throw simply never happens there. This is the general form, and it is cheap.
  const js = read('app.js');
  const html = read('app/index.html');
  const ids = [...new Set([...js.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)].map(m => m[1]))];
  assert.ok(ids.length > 50, `guard: expected to find many ids, found ${ids.length}`);
  const missing = ids.filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [],
    'app.js reaches for ids that no longer exist in the markup — getElementById returns null and the' +
    ' next property access throws, taking the whole render with it');
});

test('T12 .hidden keeps !important, which is what hides the relocated button', () => {
  // Kills survivor C5, the worst of the seven. `.btn-mark-all` now also carries `.pref-manage`,
  // whose `display: flex` sits LATER in the file at EQUAL specificity — so without `!important`,
  // `.hidden` loses on source order and "Mark all done" is permanently visible in the drawer,
  // including on the caught-up screen with nothing to mark, while updateCount, showCaughtUp, T4 and
  // T7b all go on believing it hidden. The change's own comment names this dependency as checked;
  // nothing was checking it. docs.test.mjs's guard matches `display:\s*none` and stops one word short.
  const rule = CSS().match(/(^|\})\s*\.hidden\s*\{[^}]*\}/m);
  assert.ok(rule, 'guard: a bare `.hidden` rule must exist');
  assert.match(rule[0], /display:\s*none\s*!important/,
    '`.hidden` must win against `.pref-manage { display: flex }`, which is later and equally specific');
});

test('T13 no #videos-head top margin under ANY property synonym', () => {
  // Kills survivor C3: the deleted override restored as `margin-block-start`, which is the same
  // declaration by its logical name. T8 matches the literal `margin-top` and waves it through —
  // the "guard present but ineffective" shape CLAUDE.md warns about.
  const rule = CSS().match(/#videos-head\s*\{[^}]*\}/);
  // `margin: 2px auto 12px` — the SHORTHAND, which is the form .section-head itself uses — restores
  // the exact complaint and slipped past the longhand-only list. Measured as a survivor, 2026-08-29.
  assert.ok(!rule || !/margin(-top|-block-start|-block)?\s*:/.test(rule[0]),
    `#videos-head must not re-open its top margin under any name; found ${JSON.stringify(rule && rule[0])}`);
});

test('T14 .appbar-controls actually lays row 1 out as a row', () => {
  // Kills survivor C4 — the ONE rule this change adds, and it was unpinned. Neutered to
  // `display: block`, the gear and switch stop sharing a line and the entire "gear left, switch
  // right" ask is silently undone while every markup test still passes.
  const rule = CSS().match(/\.appbar-controls\s*\{[^}]*\}/);
  assert.ok(rule, '.appbar-controls must exist — it is what makes row 1 a row');
  assert.match(rule[0], /display:\s*flex/, 'row 1 must be a flex row');
  assert.match(rule[0], /justify-content:\s*space-between/,
    'gear and switch are pinned to opposite ends by space-between, not by an auto margin');
});

test('T15 the ready-note caret points at the switch, not past it', () => {
  // Kills survivor C1: the offset reverted to 53px, which was correct only while the gear sat to
  // the switch's right. The note would still appear and still read correctly while pointing ~40px
  // away at empty bar — it fails SILENTLY, which is why a value this small earns a test.
  // Asserted as a PROPERTY, not as the magic number: the note and the switch share a right edge, so
  // the caret's centre must fall within the switch's own 38px width. That kills 53 without freezing
  // 12 against the handset measurement still owed (criterion 9).
  const rule = CSS().match(/\.toggle-note::after\s*\{[^}]*\}/);
  assert.ok(rule, 'guard: the caret rule must exist');
  const right = Number((rule[0].match(/right:\s*(\d+(?:\.\d+)?)px/) || [])[1]);
  const half = Number((rule[0].match(/border:\s*(\d+(?:\.\d+)?)px/) || [])[1]);
  assert.ok(Number.isFinite(right) && Number.isFinite(half), `guard: parsed right=${right} half=${half}`);
  // TIGHTENED 2026-08-29. The `<= 2` window accepted `right` values 11 through 15 identically, so
  // this could not tell the shipped 12 from a 3px-wrong value — and the handset measurement it was
  // deliberately not freezing against has now been taken (delta 0.0 at 402px and 874px, with a
  // control that moved it to -48.0 at right:60px). Both quantities are read from the LIVE stylesheet
  // rather than hardcoded, so changing the switch's width fails here and says the caret needs
  // re-measuring, instead of silently drifting.
  const swW = Number((CSS().match(/\.switch-grouping\s*\{[^}]*width:\s*(\d+(?:\.\d+)?)px/) || [])[1]);
  const noteRule = CSS().match(/\.toggle-note\s*\{[^}]*\}/);
  assert.ok(noteRule, 'guard: .toggle-note must have a rule');
  const noteBorder = Number((noteRule[0].match(/border:\s*(\d+(?:\.\d+)?)px/) || [])[1]);
  assert.ok(Number.isFinite(swW) && Number.isFinite(noteBorder),
    `guard: parsed switch width=${swW} note border=${noteBorder}`);
  // The note and the switch share the appbar's right edge. The switch's centre is half its width
  // inboard of that edge; the caret resolves against the note's PADDING box, which is its border
  // width further in — which is the 1px that made 13 wrong and 12 right.
  const want = swW / 2 - noteBorder;
  const centre = right + half;
  assert.equal(centre, want,
    `the caret centre must sit on the switch's centre: ${swW}/2 - ${noteBorder} = ${want}px from ` +
    `the note's padding-box right edge, but right ${right} + half-width ${half} = ${centre}px`);
});

test('T16 mark-all is hidden on views that are not the feed', async () => {
  // Kills the regression independent review found in this very change. `#profile-panel` is
  // body-level and reachable from THREE gears (setup, feed, archive), so relocating the button into
  // it made a feed-only bulk write firable from a screen where the feed is not even showing: open
  // Archive, tap the gear, tap it, and the whole unread feed is marked read behind a hidden view.
  // In the app bar it was physically unreachable off the feed. The scoping decision assumed one
  // entry point; the drawer has three.
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), false,
    'guard: on the feed with two unread, the control is offered');
  app.ctx.openArchiveView();
  assert.deepEqual(app.visibleViews(), ['view-archive'],
    'guard: the fixture must actually REACH the archive. Signed out, showView coerces every id to the' +
    ' sign-in wall, and this test passed for years-old reasons without ever leaving it');
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'off the feed, a control that clears the whole feed must not be reachable in the drawer');
});

test('T17 the bulk action is tinted apart from the navigation row above it', () => {
  // Kills survivor C7. `.btn-mark-all` sits 16px under `#btn-drawer-manage` in an IDENTICAL
  // `.pref-manage` shape, so colour is the only thing distinguishing "go to another screen" from
  // "mark every unread post read". Two reviewers raised the confusion risk independently.
  const rule = CSS().match(/(^|\})\s*\.btn-mark-all\s*\{[^}]*\}/m);
  assert.ok(rule, 'guard: a `.btn-mark-all` rule must exist');
  assert.match(rule[0], /color:\s*var\(--accent\)/,
    'the bulk write must not be pixel-identical to the navigation row above it');
});

// ── Round 2, after THREE independent blind reviews (2026-08-29) ──────────────────────────────────
//
// All three converged on the same HIGH: the `showView` guard added in round 1 was written with
// `classList.toggle(cls, cond)`, which also REVEALS when the condition is false. Everything below
// closes a hole a reviewer measured as a surviving mutation against the tests above.

test('T18 returning to the feed does NOT reveal mark-all when there is nothing to mark', async () => {
  // The HIGH. `showView` runs BEFORE any feed state exists, and the bottom-nav Feed tab is
  // `else showView('view-feed')` with no re-render by design — so a two-way toggle un-hid the bulk
  // control over the caught-up screen. The cards are still in the DOM there (showCaughtUp only
  // hides #feed), so a tap raised a real "Marked N as done" whose UNDO then un-marked posts the
  // reader had already finished. Round 1 pinned only the hide direction; `toggle('hidden', true)`
  // survived the whole 935-test suite.
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  app.ctx.markAllDone();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'guard: caught up, so the control is gone');
  app.ctx.openArchiveView();
  app.ctx.showView('view-feed');           // the nav tab's exact call — no re-render
  assert.equal(app.el('caughtup').classList.contains('hidden'), false,
    'guard: still the caught-up screen, so there is genuinely nothing to mark');
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'showView must not reveal here — the caught-up screen owns this state. (The reason once given, ' +
    '"updateCount is not on this path", has been INVERTED since round 6: it is. What keeps this ' +
    'green now is `feedSurfaceShowing()`, which sees #feed hidden by showCaughtUp.)');
});

test('T19 row 1 markup actually uses .appbar-controls', async () => {
  // T14 asserts the RULE exists; nothing asserted anything USES it. Two measured survivors: drop the
  // class from the div, or swap it for `.appbar-actions` (a real class with no justify-content).
  // Either undoes "gear left, switch right" entirely with the stylesheet untouched.
  const v = feedView(HTML());
  assert.match(v, /<div class="appbar-controls">/, 'row 1 must carry the class its layout depends on');
  assert.ok(insideBlock(v, /<div class="appbar-controls">/, 'id="btn-feed-manage"'),
    'the gear must be INSIDE that row, not merely before the switch in the file');
  assert.ok(insideBlock(v, /<div class="appbar-controls">/, 'id="toggle-grouping"'),
    'and so must the switch, or space-between has nothing to push apart');
});

test('T20 the wordmark sits in row 2, and declares its own colour', async () => {
  // Two survivors in one place. The wordmark could be lifted out of row 2 entirely and T9 stayed
  // green (it compares indexes, and row 1 has no <h1> either way). And `.brand` moving under
  // `.appbar-sub` — which sets `color: var(--ink-soft)` — silently greyed the feed wordmark while
  // the archive one kept `--ink`: the same wordmark, two colours on two screens, with the count
  // beside it brighter than the brand.
  const v = feedView(HTML());
  assert.ok(insideBlock(v, /<div class="appbar-sub">/, '<h1>SousChef</h1>'),
    'the wordmark belongs in row 2, level with the count');
  const rule = CSS().match(/\.brand h1\s*\{[^}]*\}/);
  assert.ok(rule, 'guard: .brand h1 must have a rule');
  // TIGHTENED 2026-08-29 after an independent battery: `/color:\s*var\(--/` matched `--ink-soft`
  // too, so the fix's own regression test could not fail against the exact bug it exists for —
  // mutating `--ink` → `--ink-soft` survived all 947 tests with the wordmark visibly greyed.
  assert.match(rule[0], /color:\s*var\(--ink\)/,
    'it must declare --ink specifically: --ink-soft IS the bug, and is what .appbar-sub would give it');
});

test('T21 nothing in row 1 carries an auto margin', async () => {
  // `.appbar-actions` regaining `margin-left: auto` was a survivor — and the stylesheet comment
  // right above it warns that is exactly what collapses the row, because an auto margin eats the
  // free space before justify-content can distribute it. A warning nothing enforces.
  const rule = CSS().match(/\.appbar-actions\s*\{[^}]*\}/);
  assert.ok(rule, 'guard: .appbar-actions must have a rule');
  assert.ok(!/margin-(left|inline-start)\s*:\s*auto/.test(rule[0]),
    `row 1 is pinned by space-between; an auto margin here strands the switch. Found ${JSON.stringify(rule[0])}`);
});

test('T22 the bulk action tints its glyph too, not just its label', async () => {
  // T17 read only the bare `.btn-mark-all` rule, so the arrow's tint could be dropped and the ✓
  // would render in the navigation row's ink beside an accent label.
  assert.match(CSS(), /\.btn-mark-all \.pref-arrow\s*\{[^}]*color:\s*var\(--accent\)/,
    'the ✓ must carry the accent too, or the row reads half-navigation');
});

// ── The archive bar mirrors the feed bar (Asli, 2026-08-29) ──────────────────────────────────────
//
// TASK-104 originally said the archive appbar was untouched. Asli asked for the opposite once she
// saw the two screens side by side: the gear must sit top-left there too, and the bar must be the
// same height. Height parity is a CONSEQUENCE of structural parity — both bars get a controls row
// carrying a 22px gear, then a row-2 carrying the 19px wordmark — so these pin the structure that
// produces it rather than freezing a pixel value a handset check may still move.

const archiveView = (html) => {
  const a = html.indexOf('id="view-archive"');
  assert.ok(a >= 0, 'guard: the archive view must exist');
  return html.slice(a);
};

test('T23 the archive bar has the same two-row shape as the feed bar', () => {
  const v = archiveView(HTML());
  assert.match(v, /<div class="appbar-controls">/,
    'the archive bar needs the same controls row, or its gear cannot sit where the feed one does');
  assert.ok(insideBlock(v, /<div class="appbar-controls">/, 'id="btn-archive-manage"'),
    'the gear belongs in row 1, on the left — not tucked into the brand row on the right');
  assert.ok(insideBlock(v, /<div class="appbar-sub">/, '<h1>SousChef</h1>'),
    'and the wordmark drops to row 2, exactly as it does on the feed');
  assert.ok(insideBlock(v, /<div class="appbar-sub">/, 'id="archive-count"'),
    'with the count beside it — this pairing is what makes the two bars the same height');
});

test('T24 the archive gear carries no auto margin', () => {
  // This is the rule that would silently defeat T23. `#btn-archive-manage { margin-left: auto }`
  // existed precisely BECAUSE that gear was a direct child of `.brand` with no justify-content;
  // left in place once the gear moves into `.appbar-controls`, it pushes it back to the right and
  // the markup change looks applied while the screen is unchanged.
  const rule = CSS().match(/#btn-archive-manage\s*\{[^}]*\}/);
  assert.ok(!rule || !/margin-(left|inline-start)\s*:\s*auto/.test(rule[0]),
    `the archive gear is pinned left by its row now; an auto margin sends it back right. Found ${JSON.stringify(rule && rule[0])}`);
});

test('T25 neither bar keeps a brand in its controls row', () => {
  // The shape both screens now share, asserted once. On the feed this was the whole ask; on the
  // archive it is what took the gear off the right.
  //
  // NON-VACUITY GUARD added 2026-08-29 after an independent review: `insideBlock` returns false when
  // the opening tag does not EXIST at all, so a bare negative assertion here passed on `main` — where
  // the brand genuinely IS in the controls row — for the sole reason that `.appbar-controls` was not
  // in the markup yet. A test that cannot fail on the code it was written against pins nothing, so
  // the row's existence is asserted first and the absence claim is only meaningful after it.
  for (const [name, v] of [['feed', feedView(HTML())], ['archive', archiveView(HTML())]]) {
    assert.match(v, /<div class="appbar-controls">/,
      `${name}: guard — the controls row must EXIST, or the assertion below is vacuously true`);
    assert.ok(!insideBlock(v, /<div class="appbar-controls">/, '<h1>SousChef</h1>'),
      `${name}: row 1 is controls only — the wordmark belongs in row 2`);
  }
});

test('T26 mark-all COMES BACK when you return to a feed that still has unread', async () => {
  // The other half of T18, and a regression the round-2 fix introduced on its own. Round 1's guard
  // was two-way and revealed when it should not; the fix made it one-way — which is correct for
  // LEAVING, but nothing then restores the control on the way back. The bottom-nav Feed tab is
  // `else showView('view-feed')` with NO re-render by design, so `updateCount` — which is what
  // decides this from the unread count — never runs on that path.
  //
  // Result: visit Archive once with posts still unread, come back, and "Mark all done" is gone from
  // the drawer until the next feed load. Asli spotted the button missing; her feed happened to be
  // caught up, where hiding it is right, but the same question exposed this.
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), false,
    'guard: two unread, so the control is offered');
  app.ctx.openArchiveView();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'guard: off the feed it must go');
  app.ctx.showView('view-feed');            // the nav tab's exact call — no re-render
  assert.equal(app.el('caughtup').classList.contains('hidden'), true,
    'guard: the reader is NOT caught up — two posts are still unread');
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), false,
    'returning to a feed with unread posts must offer the control again');
});

// ── The sync warning must survive the mark-all toast (Asli, 2026-08-29) ──────────────────────────

/** A signed-in client whose sync is HALTED: it holds local changes the server refused with a 409.
 *  Built the way test/sync-conflict-client.test.mjs builds one — a real refusal, not a flag poked
 *  into place, because `_syncHalted` is module-scoped and the point is the path, not the boolean. */
async function bootHalted() {
  const app = createApp({ store: {
    focus_device_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    focus_channels: JSON.stringify([{ id: 'UCmine', name: 'My Channel', keyword: '', source: 'youtube' }]),
  } });
  app.setFetch(async (url, init) => {
    const u = String(url), method = init?.method || 'GET';
    if (u.includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    if (u.includes('/api/state') && method === 'PUT') return { ok: false, status: 409, json: async () => ({ error: 'stale state' }) };
    // `kind: 'account'`, matching the signed-in `/api/auth/me` above ([BUG-063]; changed with Asli's
    // approval, 2026-09-11: "yes to 3 and 4"). It said `'device'`, which the boot now refuses as a
    // contradicted answer — so the boot never gained standing, and the halt T28 relies on came from a
    // 409 on an analytics-only PUT, which the real server never sends. Found by independent review.
    if (u.includes('/api/state')) return { ok: true, status: 200, json: async () => ({
      state: { channels: [{ id: 'UCrow', name: 'From the row', source: 'youtube' }], done: ['v1'] },
      updatedAt: '2026-01-01T00:00:01.000Z', rev: '2026-01-01T00:00:01.000000', kind: 'account' }) };
    return { ok: true, status: 200, json: async () => ({ groups: [], capped: false }) };
  });
  await app.ctx.checkAuth();
  await app.ctx.syncOnLoad();
  app.ctx.wireApp();
  await settle();
  app.ctx.saveChannels([{ id: 'UCnew', name: 'New', source: 'youtube' }]); // a mutation the server refuses
  app.runTimers(4);
  await settle();
  return app;
}

test('T27 CONTROL: closing the drawer while halted really does raise the sync warning', async () => {
  // Without this, T28 could pass against a fixture that never halted at all — the warning would be
  // absent both before and after, and "it came back" would be indistinguishable from "there was
  // never one". CLAUDE.md: a tool's silence is only evidence once you have seen it break the silence.
  const app = await bootHalted();
  app.ctx.openProfile();
  app.toasts.length = 0;
  app.ctx.closeProfile();
  await settle();
  assert.ok(app.toasts.some(t => /not syncing/i.test(t)),
    `guard: this fixture must actually be halted; toasts were ${JSON.stringify(app.toasts)}`);
});

test('T28 the sync warning returns on its own, without extra machinery', async () => {
  // WRITTEN AS A REPRISE TEST, THEN CORRECTED BY ITS OWN MUTATION. A 5.25s re-raise was added here
  // on the belief that the mark-all toast eats the warning for good — and the mutation deleting that
  // re-raise SURVIVED. A probe showed why: `pushNow` re-shows the notice before its halted
  // early-return, `addDone` schedules a push, and the debounce is 1500ms. So the warning comes back
  // at ~1500, ~3000 and on every push after; it is REPEATED, not lost. The reprise was a fourth
  // showing of a notice that already returns three times, and it is gone.
  //
  // What this test now pins is that property, so nobody rebuilds the machinery: mark all done while
  // halted, and the warning is back WITHOUT anything in markAllDone doing it.
  const app = await bootHalted();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  app.ctx.openProfile();
  app.toasts.length = 0;
  app.ctx.markAllDone();
  await settle();
  assert.match(app.toasts.at(-1), /Marked 2 as done/,
    'the Undo message wins the moment it is raised');
  app.advance(1600);   // past the 1500ms push debounce
  await settle();
  assert.ok(/not syncing/i.test(app.toasts.at(-1)),
    `the halted push brings the warning back by itself; toasts were ${JSON.stringify(app.toasts)}`);
});

test('T29 CONTROL: a healthy client is told nothing extra after mark-all', async () => {
  // ⚠️ REWRITTEN 2026-08-29 — the previous version described a "reprise" that "arms on EVERY mark-all
  // and is gated once, at fire time". There is no reprise: it was removed in this same branch once a
  // probe showed the sync notice already returns on its own (T28, six lines above, is the test that
  // says so). The comment survived the code it described by one commit.
  //
  // What this control actually establishes, and why it still earns its place: it proves the window
  // is genuinely QUIET for a healthy client. Without it, T28's pass would be consistent with the app
  // saying something to everyone after a mark-all — a warning shown to people whose sync is fine
  // trains them to ignore the one that matters. Sized so only the halt could speak here.
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  app.ctx.markAllDone();
  await settle();
  app.toasts.length = 0;
  app.advance(5300);
  assert.deepEqual(app.toasts, [],
    'nothing is wrong, so nothing may be said — a warning shown to everyone trains everyone to ignore it');
});

// ── The reveal branch must ask whether the feed is SHOWING, not whether caught-up is hidden ──────
// Round 4's `else if` restored the control from the unread count, which fixed T26's regression and
// re-opened the two paths round 3's one-way `add` had closed. Both are pinned here.

test('T30 the bulk control is not offered before the feed has rendered ANYTHING', async () => {
  // THE HIGH, found by an independent blind review 2026-08-29 and reproduced here.
  //
  // `openFeedView` calls `showView('view-feed')` as its FIRST statement, before `await loadFeed()`.
  // The old gate asked only "is #caughtup hidden?" — which is true on a cold boot, because nothing
  // has rendered yet. `updateCount` then counts `#feed .card` (zero) PLUS `countGroupedUnread()`,
  // and `inHandGroupableIds()` returns null ("do not filter") while `_lastFeedItems === null`, so
  // that second term is the count of PERSISTED assignments. The control is revealed over an empty
  // screen, and the gear that opens the drawer is in the sticky appbar throughout.
  //
  // A tap then marks every grouped post the account holds as done, paints "all caught up ✓" over a
  // feed that never loaded, and PUTs that to every device. The author's own comment above the branch
  // names this exact path as why round 1's two-way toggle was wrong.
  const app = createApp({ store: {
    focus_device_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    focus_group_view: 'on',
    focus_groups: JSON.stringify({
      assignments: { t1: 'g1', t2: 'g1', t3: 'g1' },
      groups: { g1: { label: 'A topic', summary: [] } },
      unfiled: [], updatedAt: Date.now(), v: 2,
    }),
  } });
  app.setFetch(async (url) => {
    if (String(url).includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ email: 'a@example.com' }) };
    return { ok: true, status: 200, json: async () => ({ groups: [], capped: false }) };
  });
  await app.ctx.checkAuth();

  // VACUITY CONTROL. If the fixture's assignments do not survive into a non-zero count, this test
  // passes because there was nothing to reveal — proving nothing about the guard. Assert the hazard
  // exists before asserting it is handled.
  assert.ok(app.ctx.countGroupedUnread() > 0,
    'control: the fixture must actually carry unread grouped posts, or this test is vacuous');

  app.ctx.showView('view-feed');   // openFeedView's first statement, before await loadFeed()
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'nothing has rendered, so there is nothing on screen to mark — the control must stay away');
});

test('T31 a feed that FAILED to load offers nothing and repaints no badge', async () => {
  // The second re-opened path, and the one two of three reviewers measured directly.
  // `showLoadError` blanks `#feed-count` on purpose — renderFeedResults: "Total fetch failure isn't
  // the same as 'caught up' — don't claim a done-state we didn't earn." It hides `#feed` but leaves
  // the previous render's cards in the DOM, and leaves `#caughtup` hidden. So the old gate passed
  // and `updateCount` counted STALE cards: measured "2 new" over "couldn't load your feed".
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), false,
    'guard: two unread, so the control is genuinely offered first');

  app.ctx.renderFeedResults({ items: [], failed: ['c1'], cappedNames: [], totalChannels: 1 });
  await settle();
  assert.equal(app.el('feed-count').textContent, '',
    'guard: showLoadError blanks the badge — this is the state we must not undo');
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'and the control must go the moment the error screen appears — a reader who never navigates ' +
    'away was still being offered it, over the previous render\'s stale cards');

  app.ctx.openArchiveView();
  app.ctx.showView('view-feed');   // the nav tab's exact call — no re-render
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'the bulk control must not be offered over a feed that never loaded');
  // ⚠️ RESTORED 2026-08-29. This assertion was GREEN, and round 6 DELETED it — the test was renamed
  // to match the weaker claim and a comment added calling the difference a "logged gap". That is the
  // one thing CLAUDE.md forbids outright: never change a test to make it pass. The stated reason
  // ("12 tests across three files") described a DIFFERENT gap; restoring one term in `showView`
  // costs zero tests, measured. Found by independent review.
  assert.equal(app.el('feed-count').textContent, '',
    'the badge must stay blank: nothing loaded, so no count was earned');
});

test('T32 COVERAGE: updateCount can hide the control on its own, without showCaughtUp', async () => {
  // GREEN before and after — declared, not counted as proof of the fix. It exists because T4 could
  // not fail: T4 drives `markAllDone()`, which calls `showCaughtUp()`, and THAT also hides the
  // control. Two guards can stop the same input, so T4 pinned neither. Measured by an independent
  // battery 2026-08-29: `toggle('hidden', remaining === 0)` → `toggle('hidden', false)` — i.e.
  // updateCount can never hide anything — SURVIVED all 947 tests.
  //
  // That term became load-bearing in a place `showCaughtUp` does not run: `showView`'s reveal branch.
  // This drives `updateCount` alone, so only the guard under test can fire.
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), false, 'guard: offered at two unread');

  // Empty the stream WITHOUT going through markAllDone/showCaughtUp, then ask updateCount alone.
  app.el('feed').innerHTML = '';
  app.ctx.updateCount();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'updateCount must hide at zero by itself — nothing else ran here');
});

// ── Two markup survivors an independent battery measured, each green across all 947 ──────────────

test('T33 row 2 keeps the .brand WRAPPER, not just an <h1> somewhere inside it', async () => {
  // Measured survivor 2026-08-29: delete the `<div class="brand">` wrapper so the dot and the <h1>
  // become direct children of `.appbar-sub`. Suite stayed green — T20's `insideBlock` check passes
  // either way, because the <h1> is still inside `.appbar-sub`. Looked at in a browser it undoes the
  // headline ask completely: `space-between` spreads toque hard-left, wordmark CENTRED, count right,
  // and the wordmark greys out because `.brand h1` no longer matches its own colour rule.
  const v = feedView(HTML());
  assert.ok(insideBlock(v, /<div class="appbar-sub">/, '<div class="brand">'),
    'row 2 must contain the .brand wrapper — it is what groups the toque with the wordmark');
  assert.ok(insideBlock(v, /<div class="brand">/, '<h1>SousChef</h1>'),
    'and the wordmark must be INSIDE it, or .brand h1 stops matching and the colour fix dies with it');
  assert.ok(insideBlock(v, /<div class="brand">/, '<span class="dot"></span>'),
    'as must the toque, or space-between pushes them apart instead of keeping them a unit');
});

test('T34 the relocated bulk button still carries the drawer row class', async () => {
  // Measured survivor 2026-08-29: drop `pref-manage` from the class list. Suite green; in a browser
  // the button renders as a raw UA control — `background: rgb(107,107,107)`, `border: 2px outset` —
  // sitting in the drawer. `btn-mark-all` alone only carries the tint (T17/T22), never the row shape.
  const html = HTML();
  const tag = html.match(/<button[^>]*id="btn-mark-all"[^>]*>/);
  assert.ok(tag, 'guard: the button must exist in the markup');
  assert.match(tag[0], /class="[^"]*\bpref-manage\b/,
    'without pref-manage it is an unstyled UA button in the settings drawer');
  assert.match(tag[0], /class="[^"]*\bhidden\b/,
    'and it must still ship hidden — T7a/T7b depend on that being the seeded state');
});

// ── Round 6: the reveal is guarded where it HAPPENS, not at each way in ─────────────────────────
// Rounds 1-5 each guarded one path into `updateCount`. `showView` is 1 of 8 callers, so three of the
// others still re-armed a whole-feed bulk write from screens the feed was not on. Found by an
// independent blind review of round 5, 2026-08-29.

test('T35 updateCount cannot reveal the bulk control while the reader is on Archive', async () => {
  // H1. The drawer is body-level and the Archive gear opens it, so an off-feed reveal is TAPPABLE —
  // it was harmless on `main` only because the button lived inside #view-feed's appbar. Two real
  // callers do this with no user action on the feed at all: the classify tail (app.js:988) fires
  // 4-10s after boot, and un-archiving a card (app.js:3375) runs on the Archive screen itself.
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  // VACUITY GUARD, added 2026-08-29 after an independent battery MEASURED this test passing
  // vacuously: a mutation that made the control never appear at all killed seven sibling tests and
  // T35 SURVIVED it. A test asserting "hidden" needs to prove the thing could be shown.
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), false,
    'guard: offered on the feed with two unread, or "still hidden" proves nothing');
  app.ctx.openArchiveView();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'guard: leaving the feed took the control away');

  app.ctx.updateCount();     // what the classify tail and the un-archive path both call
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'a bulk feed write must not be re-armed while the reader is looking at Archive');
});

test('T36 the grouping switch cannot repaint a count over a feed that failed to load', async () => {
  // H2. `applyGroupView` still carried the ROUND 4 PREDICATE round 5 rejected — `if (#caughtup is
  // hidden) updateCount()` — and on the error screen #caughtup IS hidden. One tap on the appbar
  // switch repainted "2 new" over "couldn't load your feed" and re-armed the control over the
  // previous render's stale cards, undoing showLoadError's guard from the same commit.
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  app.ctx.renderFeedResults({ items: [], failed: ['c1'], cappedNames: [], totalChannels: 1 });
  await settle();
  assert.equal(app.el('feed-count').textContent, '', 'guard: the error screen blanked the badge');

  app.ctx.applyGroupView();  // the switch's own handler
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'the bulk control must stay away — its cards are the previous render\'s, already stale');
  // KNOWN GAP, declared rather than quietly dropped: the BADGE is still repainted here, because the
  // guard is scoped to the reveal (see updateCount). Nothing is tappable, so this is a wrong string
  // rather than a data path — logged as [BUG-108], with the fixture work it depends on.
});


// ── Three coverage gaps an independent review measured as surviving mutations ────────────────────

test('T38 COVERAGE: the bulk control is hidden on SETUP too, not just Archive', async () => {
  // Declared GREEN coverage. A measured survivor narrowed `id !== 'view-feed'` to
  // `id === 'view-archive'` and nothing noticed, because every test that leaves the feed goes to
  // Archive. Setup has its OWN gear (`#profile-btn`, app/index.html) opening the same body-level
  // drawer, so that narrowing puts a whole-feed bulk write back on a screen the feed is not on —
  // the exact regression T16 exists for, one screen over.
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), false,
    'guard: offered on the feed with two unread');

  app.ctx.showView('view-setup');
  assert.deepEqual(app.visibleViews(), ['view-setup'],
    'guard: the fixture must actually REACH setup — signed out, showView coerces to the sign-in wall');
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'setup is not the feed either: the drawer opens from there too');
});

test('T39 COVERAGE: the relocated button is actually WIRED to markAllDone', async () => {
  // Declared GREEN coverage. Deleting the `addEventListener` at app.js:4505 survived the whole
  // suite, because every test drives `ctx.markAllDone()` directly and never the control. The element
  // MOVED FILES in this change, which makes "the button is there and does nothing" the plausible
  // slip — and a UI action that silently did not happen looks exactly like a broken feature
  // (CLAUDE.md). `listeners.length` exists in the harness for precisely this and was unused here.
  const app = await bootSignedIn();
  app.ctx.wireApp();
  const clicks = app.el('btn-mark-all').listeners.filter(l => l.type === 'click');
  assert.equal(clicks.length, 1, 'the control must carry exactly one click handler after wiring');

  // …and that the handler is the real one, not merely SOME function: drive it and read the effect.
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  clicks[0].fn();
  await settle();
  assert.equal(app.el('caughtup').classList.contains('hidden'), false,
    'firing the wired handler must actually clear the feed — a bound no-op would pass a count check');
});

test('T40 the caret offset stays tied to the padding the note is positioned from', async () => {
  // Declared GREEN coverage, and it closes the last unpinned term of T15's arithmetic. `.toggle-note`
  // is `right: 20px` BECAUSE that is `.appbar`'s own side padding — the note's right edge and the
  // switch's right edge coincide, which is the premise the 12px caret is derived from. A measured
  // survivor moved the note to `right: 60px`: T15 still passed, because it measures the caret
  // relative to the NOTE and never asks where the note itself sits.
  const css = CSS();
  const noteRule = css.match(/\.toggle-note\s*\{[^}]*\}/);
  assert.ok(noteRule, 'guard: .toggle-note must have a rule');
  const noteRight = Number((noteRule[0].match(/right:\s*(\d+(?:\.\d+)?)px/) || [])[1]);
  const barRule = css.match(/\.appbar\s*\{[^}]*\}/);
  assert.ok(barRule, 'guard: .appbar must have a rule');
  const barPad = Number((barRule[0].match(/padding:[^;]*?\s(\d+(?:\.\d+)?)px\s+\d+(?:\.\d+)?px;/) || [])[1]);
  assert.ok(Number.isFinite(noteRight) && Number.isFinite(barPad),
    `guard: parsed note right=${noteRight} appbar side padding=${barPad}`);
  assert.equal(noteRight, barPad,
    'the note must share the appbar\'s right edge — the caret offset is derived from that and ' +
    'fails SILENTLY if the note moves: the bubble still appears, still reads correctly, and points ' +
    'at empty bar');
});

test('T41 returning to a caught-up feed does not print a count over it', async () => {
  // The sibling T31 never had, and the variant that was never logged. Same mechanism, the path a
  // reader hits far more often: `showCaughtUp` hides #feed but leaves the read cards in the DOM for
  // Undo, so an ungated `updateCount` on the nav-tab return counts them and prints "2 new" ABOVE
  // "You're all caught up". Measured at round 6's tip; `main` and round 5 both read "all caught up ✓".
  //
  // The suite already pins this invariant for the OTHER entry point — group-toggle.test.mjs, TASK-099
  // T17, "the badge must not be repainted as 'N new' from cards whose posts are all done". Round 6
  // broke it via `showView` instead of via the switch, which is why no existing test caught it.
  const app = await bootSignedIn();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  app.ctx.markAllDone();
  await settle();
  assert.equal(app.el('feed-count').textContent, 'all caught up ✓', 'guard: the caught-up state');

  app.ctx.openArchiveView();
  app.ctx.showView('view-feed');   // the nav tab's exact call — no re-render
  assert.equal(app.el('feed-count').textContent, 'all caught up ✓',
    'the reader finished their feed — printing "2 new" over it counts posts they already read');
  assert.equal(app.el('btn-mark-all').classList.contains('hidden'), true,
    'and nothing is left to mark');
});

// ── [BUG-106] the relocated bulk control is a 17px tap target beside an identical row ────────────
//
// TASK-104 moved "Mark all done" into the settings drawer as a `.pref-manage` row. `.pref-manage`
// is `padding: 0`, so the control is exactly its 14px line box — measured at 17px in Chrome — and
// it sits 16px under `#btn-drawer-manage` in an IDENTICAL shape, colour being the only difference
// (that half is T17). 17px is well under the 44px minimum tap target, and the thing one slip lands
// on is a whole-feed bulk write synced to every device, with a 5s Undo (~1.5s halted, [BUG-105]).
//
// WHICH RED BEFORE THE FIX — predicted BEFORE running (CLAUDE.md, Mutation batteries):
//   RED   — T42 (the rule declares no vertical padding, so the box IS the line box) and T43 (no
//           `border-top`, so nothing separates it from the navigation row).
//   GREEN — T44 is a GUARD, not a proof. `.hidden` is `display: none !important` and already beats
//           anything this fix adds; it is here so the divider cannot survive as a stray line at zero
//           unread. Declared rather than quietly counted as coverage.
//
// ⚠️ WHAT THESE CANNOT DO, stated because the criterion names a rendered quantity. They read CSS
// TEXT. `padding: 14px 0` in a stylesheet is NOT a measurement of a tap target — the 44px and 16px
// numbers are live-measured in a browser and cited in the task. These pin that the rule exists and
// carries the intended values, which is the half that regresses silently when someone tidies the
// stylesheet. A test that is green, correct and measuring the wrong quantity is the failure mode
// this comment exists to prevent.
//
// ⚠️ The `::before` OVERLAY used by `.switch-grouping` (style.css:2074) was read and REJECTED here.
// An absolutely positioned pseudo-element extends past its box, and these rows are a 33px pitch
// (17px tall, 16px gap) — two 44px overlays would collide by 11px and resolve by stacking order.
// Padding grows the real box instead, and the flex `gap` on `.pref-block` is preserved between
// border boxes, so the separation survives. If a future change swaps padding for an overlay, T42
// keeps passing and the bug comes back: that is why T43 pins the divider on the ELEMENT.

// The measured line box of a `.pref-manage` row: 14px/600 type, `padding: 0`, no min-height.
// Live Chrome measurement recorded in tasks/BUG-106.md. The arithmetic below rests on it, so it is
// named rather than inlined — if the drawer type ever changes, this is the number that moved.
const PREF_ROW_LINE_BOX = 17;
const MIN_TAP_TARGET = 44;

const markAllRule = () => {
  const m = CSS().match(/(^|\})\s*\.btn-mark-all\s*\{([^}]*)\}/m);
  assert.ok(m, 'guard: a `.btn-mark-all` rule must exist — T17 depends on the same block');
  return m[2];
};

// Reads the vertical padding a declaration block sets, shorthand or longhand. Returns px numbers.
const verticalPadding = (decls) => {
  let top = 0, bottom = 0;
  const short = decls.match(/(?:^|;)\s*padding\s*:\s*([^;]+)/);
  if (short) {
    const parts = short[1].trim().split(/\s+/);
    const n = (v) => (parseFloat(v) || 0);
    if (parts.length === 1) { top = bottom = n(parts[0]); }
    else if (parts.length === 2) { top = bottom = n(parts[0]); }
    else { top = n(parts[0]); bottom = n(parts[2]); }
  }
  const t = decls.match(/(?:^|;)\s*padding-top\s*:\s*([\d.]+)px/);
  const b = decls.match(/(?:^|;)\s*padding-bottom\s*:\s*([\d.]+)px/);
  if (t) top = parseFloat(t[1]);
  if (b) bottom = parseFloat(b[1]);
  return { top, bottom };
};

test('T42 the bulk control clears the 44px minimum tap target', () => {
  const decls = markAllRule();
  const { top, bottom } = verticalPadding(decls);
  const box = PREF_ROW_LINE_BOX + top + bottom;
  assert.ok(box >= MIN_TAP_TARGET,
    `the tap box is ${box}px (${PREF_ROW_LINE_BOX} line box + ${top} + ${bottom} padding); a control` +
    ` that marks the whole feed read must clear ${MIN_TAP_TARGET}px`);
  // ⚠️ THIS ASSERTION REPLACED A SYMMETRY CHECK, 2026-08-29, and the reason is recorded because a
  // test edit is the one move CLAUDE.md forbids doing quietly. The original asserted
  // `top === bottom`, on the reasoning that one-sided padding puts the label off-centre. That is a
  // PROXY, and it was the wrong one: the whitespace a reader sees is bounded by the two RULES — this
  // button's `border-top` above, and `.pref-block`'s `border-bottom` below — and `.pref-block` puts
  // its own `padding-bottom` between the label and that lower line. So symmetric padding renders
  // VISIBLY off-centre, which is what Asli saw on localhost: 14px above the label, 34px below.
  // Requirement changed (her call, this session), not a gap declared to make failing code pass.
  //
  // The replacement is strictly stronger. It pins the quantity the eye actually judges, and it
  // encodes the COUPLING to `.pref-block` — so changing that block's padding now reds this test
  // instead of silently un-centring the label.
  const blockPad = CSS().match(/\.pref-block\s*\{[^}]*padding-bottom:\s*([\d.]+)px/);
  assert.ok(blockPad, 'guard: `.pref-block` must declare the padding-bottom this centring depends on');
  const below = bottom + parseFloat(blockPad[1]);
  assert.equal(top, below,
    `the label must sit centred between the two rules: ${top}px above it, ${below}px below ` +
    `(${bottom} of the button's own padding + ${blockPad[1]} of .pref-block's). Symmetric padding on ` +
    `the button is NOT centred text, because the block's padding sits inside the visible band.`);
});

test('T43 a divider separates the bulk write from the navigation row, and belongs to the element', () => {
  const decls = markAllRule();
  assert.match(decls, /border-top:\s*1px\s+solid\s+var\(--line\)/,
    'a hairline must separate "Mark all done" from "Manage channels" — colour alone is T17, and two' +
    ' reviewers raised the confusion risk independently');
  // ON THE ELEMENT, not on a sibling/parent selector or a `::before`. A border painted from outside
  // the button survives `display: none` on the button, leaving a rule floating above the Account
  // block at zero unread. Pinning it here is what makes T44's guard mean anything.
  assert.doesNotMatch(CSS(), /\.pref-block\s*>\s*\.btn-mark-all|\.btn-mark-all::before/,
    'the divider must be a border on the button itself, or it outlives the button it separates');
});

test('T44 guard: hidden still beats the new box, so no stray divider at zero unread', () => {
  // GREEN before the fix too — declared above. `.hidden` is `display: none !important` (style.css:93),
  // which outranks anything `.btn-mark-all` declares regardless of order or specificity. This exists
  // so that adding a border and padding cannot leave a visible hairline once the control is hidden.
  assert.match(CSS(), /\.hidden\s*\{[^}]*display:\s*none\s*!important/,
    '`.hidden` must stay `display: none !important` — the new border rides on the same element');
});
