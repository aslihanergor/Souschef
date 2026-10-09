// The landing dot story's frame loop (TASK-091).
//
// Every test here pins a defect that went into the landing rebuild and that nothing could catch.
// (Deliberately no commit SHA: an earlier version named one, and a rebase made it unreachable.)
// The browser could not catch them: Chrome reports an automated tab hidden and suspends rAF, so a
// probe run that way reads 0 regardless of the code — which is how the second fix attempt was
// wrongly declared broken. The harness turns rAF into a queue the test drives, which makes "was
// another frame scheduled?" a fact rather than a measurement.
//
// These tests cover the loop's CONTROL — when to schedule a frame, and painting both surfaces from
// one reading. They do NOT yet cover what the loop paints: a review found 13 of 18 mutations of the
// paint effects survive this suite green. That gap is tracked in TASK-091's round-1 disposition.
//
// Not tested here, deliberately: anything about how the stage LOOKS. Dot positions, colours, easing
// and the daylight gradient stay on verify-by-looking, per CLAUDE.md. What is tested is the logic
// that decides WHEN to paint and WHAT to paint together — which is where all three bugs were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLanding, STAGE_VH } from '../test-helpers/landing-harness.mjs';

// Beat boundaries, mirrored from landing.js so a drift in either shows up as a failure here.
// Re-paced with the rest for BUG-082 (was [0.58, 0.74]).
//
// Worth knowing before trusting the sentence above: when the constants moved and these did NOT, the
// suite stayed green. The two places these are used ask "mid-pour" and "past the pour", and the old
// values still happened to land in those regions of the new timeline. So the mirror catches a drift
// only when the drift is big enough to cross a beat boundary — it is a smoke alarm, not a lock.
const FLY_START = 0.485, FLY_END = 0.66;

test('boot paints the DOM synchronously, before any frame runs', () => {
  // The bug: boot() was reduced to `layout(); request();`, so nothing painted until the first rAF
  // fired. `lit` is applied by paintDom and by nothing else, so the headline rendered in the dim
  // colour — and in a background tab, where rAF never fires at all, it stayed that way.
  const app = createLanding();

  assert.deepEqual(app.lit(), [true, false, false],
    'the first clause was not lit until a frame ran — a delayed rAF leaves the headline fully dim');
  assert.ok(app.canvas.draws > 0,
    'boot never drew the canvas, so the stage is blank until the first frame');
});

test('the loop keeps re-arming while the dots are still moving', () => {
  const app = createLanding();
  app.scrollToProgress(0.09).flush();

  assert.equal(app.pendingFrames(), 1,
    'no follow-up frame was scheduled while dots are still drifting — the animation would freeze');

  app.flush();
  assert.equal(app.pendingFrames(), 1, 'the loop stopped re-arming after one further frame');
});

test('the loop goes idle once nothing is moving any more', () => {
  // Acceptance criterion 7, and the one the browser could not answer. Past FLY[1] every chosen dot
  // has f = 1 so its alpha is 0, and every noise dot went to zero back at QUEUE[1] — the canvas is
  // empty and a frame cannot change it.
  const app = createLanding();
  app.scrollToProgress(0.95).flush();

  assert.equal(app.pendingFrames(), 0,
    'the loop is still scheduling frames after the pour, with nothing left to animate — this is ' +
    'the 60fps-forever bug, invisible on screen and expensive on a phone');
});

test('the idle loop wakes on scroll — it is suspended, not dead', () => {
  // The other half. Without this, "goes idle" is satisfied by a loop that never runs again, which
  // would freeze the stage the moment a visitor scrolled back up.
  const app = createLanding();
  app.scrollToProgress(0.95).flush();
  assert.equal(app.pendingFrames(), 0, 'guard: the loop did not go idle, so this proves nothing');

  app.scrollToProgress(0.20);

  assert.ok(app.pendingFrames() > 0, 'scrolling back into the animated range did not restart the loop');
});

test('a resize repaints the canvas, not only the DOM', () => {
  // The desync. boot() used to call paintDom() directly, which was harmless while the loop ran
  // forever and is not once it idles: a resize updated the DOM and left the canvas showing whatever
  // it last drew. Observed on screen as the dot queue above a header reading "0 new".
  const app = createLanding();
  app.scrollToProgress(0.95).flush();
  const drawsBefore = app.canvas.draws;
  assert.equal(app.pendingFrames(), 0, 'guard: the loop must be idle for this to be the real case');

  app.resize();

  assert.ok(app.canvas.draws > drawsBefore,
    'the resize repainted the DOM without redrawing the canvas — the two now disagree about where ' +
    'the page is scrolled to');
  assert.equal(app.count(), '0 left',
    'the DOM stopped matching the scroll position after a resize');
});

test('a resize leaves every dot where it was (BUG-079)', () => {
  // Seen on a real handset, which is the only place it shows: the field is smooth, you scroll once,
  // and the entire cloud teleports to new positions — then runs smoothly from there. iOS Safari
  // collapses the URL bar on the first scroll, that changes the viewport height, and boot() re-runs
  // layout() 140ms later. layout() rebuilt every dot with fresh Math.random() home positions, so
  // the field's IDENTITY was being re-rolled by a routine that should only recompute its GEOMETRY.
  // It happens exactly once because the bar then stays collapsed, which is why it reads as "the
  // first scroll changes the state".
  //
  // The resize here changes nothing at all — same width, same height, same scroll, same clock. Any
  // difference in what gets painted is the bug and nothing else.
  const app = createLanding({ width: 390, height: 844 });
  app.scrollToProgress(0.10).flush();
  const before = app.canvas.ink.at(-1);
  const drawn = app.canvas.arcs.at(-1);
  assert.ok(drawn > 100, 'guard: the grey field is not on screen, so there is nothing to preserve');

  app.resize();

  assert.equal(app.canvas.arcs.at(-1), drawn,
    'a resize changed how many dots exist, not just where they are');
  assert.equal(app.canvas.ink.at(-1), before,
    'every dot moved on a resize that changed nothing — on a phone this is the whole field jumping ' +
    'to a new arrangement mid-story, on the first scroll, in front of the user');
});

test('the browser chrome hiding does not move the field (BUG-079, second half)', () => {
  // The first fix stopped layout() re-ROLLING the dots. It did not stop it re-PROJECTING them, and
  // on a phone the report was still "it shifts a little bit" on the first scroll.
  //
  // .pin is `height: 100vh` and the canvas is inset:0 inside it. On iOS, 100vh resolves to the
  // LARGE viewport and does not change when the URL bar hides — but window.innerHeight does, by
  // ~7-12%. layout() measured the window, so every dot's vertical position rescaled by that ratio
  // inside a container that had not moved an inch. The story position moved too: progress() divides
  // by `stageHeight - window.innerHeight`, so the same event nudges the whole narrative.
  //
  // Nothing here changes: same width, same vh basis, same scroll, same clock. Only the chrome.
  // No flush between the two readings, deliberately: flushing advances the harness clock, the dots
  // wobble with time, and the fingerprint would differ for an innocent reason. setInnerHeight runs
  // the resize debounce, which re-lays-out and repaints on the SAME clock — so the only thing that
  // can move a dot here is the projection.
  const app = createLanding({ width: 390, height: 844 });
  app.setInnerHeight(784);                    // URL bar showing, as on arrival
  app.scrollToProgress(0.10).flush();
  const before = app.canvas.ink.at(-1);
  const drawn = app.canvas.arcs.at(-1);
  assert.ok(drawn > 100, 'guard: the grey field is not on screen, so there is nothing to preserve');

  app.setInnerHeight(844);                    // and collapsing, which is what the first scroll does

  assert.equal(app.canvas.arcs.at(-1), drawn, 'the dot count changed when only the chrome did');
  assert.equal(app.canvas.ink.at(-1), before,
    'the field moved when the URL bar collapsed. The canvas lives inside a 100vh box that did not ' +
    'change size, so measuring the window instead of that box rescales every dot for nothing — ' +
    'which is the residual shift still visible on a real phone after the re-roll was fixed');
});

test('the browser chrome hiding does not advance the story (BUG-079, progress)', () => {
  // The other half of the same measurement mistake. progress() divided by
  // `stageHeight - window.innerHeight`, but the distance the sticky pin travels is the stage minus
  // the PIN. The two differ by exactly the browser chrome, so collapsing the URL bar shrank the
  // divisor and nudged the whole story forward ~1.2% — enough to step a beat boundary at the same
  // scroll position, on the same first scroll that moved the field.
  //
  // Swept rather than sampled at one point: a single sample only catches this if it happens to sit
  // within the shift of a threshold. Stepping 0.005 guarantees landing exactly on the clause
  // boundaries at 0.33 and 0.60, where the discontinuity is unambiguous.
  const app = createLanding({ width: 390, height: 844 });
  const STEP = 0.005;
  const sweep = () => {
    const seen = [];
    for (let i = 0; i * STEP <= 1; i++) {
      app.scrollToProgress(i * STEP).flush();
      seen.push(`${app.lit().join(',')}|${app.count()}|${app.el('caught').classList.contains('on')}`);
    }
    return seen;
  };

  app.setInnerHeight(784);            // URL bar showing
  const before = sweep();
  app.setInnerHeight(844);            // URL bar collapsed
  const after = sweep();

  const moved = before
    .map((b, i) => (b === after[i] ? null : `p=${(i * STEP).toFixed(3)}  ${b}  ->  ${after[i]}`))
    .filter(Boolean);

  assert.deepEqual(moved, [],
    `${moved.length} scroll position(s) tell a different beat once the URL bar collapses. The same ` +
    'place in the page is showing a different point in the story because the chrome changed — ' +
    `nothing about the document did.\n  ${moved.slice(0, 4).join('\n  ')}`);
});

test('the observer suspends the loop when the stage leaves the viewport', () => {
  const app = createLanding();
  app.scrollToProgress(0.09).flush();
  assert.equal(app.pendingFrames(), 1, 'guard: the loop was not running before we suspended it');

  app.setOnStage(false);

  assert.equal(app.pendingFrames(), 0, 'the loop kept running with the stage off screen');

  app.setOnStage(true);
  assert.ok(app.pendingFrames() > 0, 'the loop never resumed when the stage came back');
});

test('the counter counts UP while the feed fills and DOWN while it empties', () => {
  // "2 left" mid-pour would read as "only 2 exist" when four more are still on the way. This is the
  // one piece of copy on the stage that changes, so it is the one that can be wrong.
  const app = createLanding();

  // Sample points re-derived for BUG-082's re-pacing (was 0.30 / 0.60 / 0.67). The beats moved;
  // what each sample has to CATCH did not, so each new number is derived from the new constants
  // rather than read off a failure:
  //   before the pour  — after QUEUE[1] = 0.37, before FLY[0] = 0.485  ->  0.40
  //   the M1 gap       — after FLY[0] = 0.485, before the first post lands at 0.566  ->  0.52
  //   mid-pour         — 0.60, where four of the six have landed (they arrive ~0.01 apart)
  app.scrollToProgress(0.40).flush();
  assert.equal(app.count(), '6 new', 'before the pour the phone should promise all six');

  // Round-1 M1. The pour starts at FLY[0] but the first post does not land until 0.566, and the
  // phone is fully opaque before that — so for a stretch the visitor watched a promise of "6 new"
  // become "0 new" over a still-empty feed, then climb back to 6. The old samples straddled that
  // window without ever touching it, and the re-paced ones must still land inside it.
  app.scrollToProgress(0.52).flush();
  assert.equal(app.postsIn(), 0, 'guard: a post has already landed at 0.52, so this is not the gap');
  assert.equal(app.count(), '6 new',
    'the counter reports 0 new over an empty feed after the pour has begun but before anything ' +
    'has arrived — it contradicts itself, and the phone is fully visible while it does');

  app.scrollToProgress(0.60).flush();
  assert.equal(app.postsIn(), 4, 'guard: the pour is not where this test thinks it is');
  assert.equal(app.count(), '4 new', 'mid-pour the counter must count up, not report what is left');

  app.scrollToProgress(0.95).flush();
  assert.equal(app.count(), '0 left', 'after clearing, the counter must switch to what remains');
  assert.equal(app.postsCleared(), 6, 'guard: not everything cleared');
});

test('reduced motion snaps progress to beat centres', () => {
  // The same story told in still frames — and BUG-082's re-pacing INVERTED this test's contrast
  // rather than just moving its sample point, which is worth stating because a reader will assume
  // the expectation was flipped to go green.
  //
  // Before: the third clause lit at FLY[0] + 0.02 = 0.60, and p = 0.62 snapped BACK to the 0.54
  // stop, so reduced motion showed it unlit while normal showed it lit.
  // Now: the clause lights at FLY[0] + 0.02 = 0.505, and every p past that snaps FORWARD to the
  // 0.57 stop — which is also past it. So no sample can show reduced-unlit against normal-lit, and
  // keeping that shape would have meant inventing a stop.
  //
  // The contrast that does exist runs the other way. At p = 0.50 the clause has NOT lit normally
  // (0.50 < 0.505), while reduced motion snaps to 0.57 and shows it lit — a snapped frame from
  // further along the story than the page is actually scrolled to. That is the same property the
  // test always asserted: reduced motion renders a beat centre, not the continuous position.
  const P = 0.50;
  const normal = createLanding({ reduced: false });
  normal.scrollToProgress(P).flush();
  assert.deepEqual(normal.lit(), [true, true, false],
    `guard: ${P} already lights the third clause without snapping, so the contrast below is empty`);

  const reduced = createLanding({ reduced: true });
  reduced.scrollToProgress(P).flush();

  assert.deepEqual(reduced.lit(), [true, true, true],
    'reduced motion did not snap to a beat centre — it is rendering the continuous animation');
});

// ── What the loop PAINTS (round-1 H3) ────────────────────────────────────────────────
//
// The tests above cover the loop's control — when to schedule a frame. A review pointed out that
// the commit claiming "8 mutations, 8 red" had proved exactly that and nothing else: 13 of 18
// faithful mutations of the paint effects survived the suite green, including the CTA never
// appearing, "You're all caught up" never showing, the daylight never rising and the canvas never
// drawing a single dot. The harness was already recording every one of those facts and asserting
// none of them.
//
// These pin the OUTPUT of each beat. Still not tested, deliberately: how any of it looks — dot
// positions, colours, easing curves. That stays on verify-by-looking per CLAUDE.md.

test('each beat leaves its own mark on the DOM', () => {
  const app = createLanding();
  const at = (p) => {
    app.scrollToProgress(p).flush();
    return {
      phone: Number(app.el('phone').style.opacity),
      daylight: Number(app.el('daylight').style.opacity),
      caught: app.el('caught').classList.contains('on'),
      cta: app.el('stage-cta').classList.contains('on'),
      navDay: app.nav.classList.contains('day'),
    };
  };

  const rest = at(0.05);
  assert.equal(rest.phone, 0, 'the phone is already visible before the dots have been chosen');
  assert.equal(rest.caught, false, '"You\'re all caught up" is showing before anything arrived');
  assert.equal(rest.daylight, 0, 'the daylight is up before the story has been told');
  assert.equal(rest.navDay, false, 'the nav swapped to its light state at the start of the story');

  assert.ok(at(0.50).phone > 0.9,
    'the phone never faded in, so the dots pour into nothing and beats 4 and 5 happen off screen');

  // The very end, not 0.97: LIFT is [0.91, 0.99] on a smoothstep, so 0.97 is only 0.844 of the way
  // up. Sampling the end of the story is what makes "the daylight completes" a real assertion.
  const end = at(1);
  assert.equal(end.caught, true, '"You\'re all caught up" never appears — the page never shows the ' +
    'one thing it exists to argue, that the feed ENDS');
  assert.equal(end.cta, true, 'the CTA never turns on, so the page has no conversion path at all');
  assert.equal(end.navDay, true, 'the nav never swapped dark to light with the daylight');
  assert.ok(end.daylight > 0.9, `the daylight only reached ${end.daylight} — beat 5 never happens`);
});

// ── What a frame COSTS (the handset check) ───────────────────────────────────────────
//
// Found by walking the page on a real phone, which is the only instrument that could: it stuttered
// through the opening grey cloud and ran smoothly from the queue onward. The measurement explains
// it — the grey phase draws 174 dots per frame against 24 once the noise has gone, 7.25x the work,
// and almost all of the per-dot cost there was avoidable. The field's alpha is a function of scroll
// progress alone, so every one of the ~150 noise dots was rebuilding the SAME colour string (with a
// toFixed) and submitting its own path.
//
// These assert the property rather than a frame time, which is the only part that is measurable off
// a device: the grey field must cost O(1) canvas state, not O(dots).

test('the grey field costs a fixed amount of canvas state, not one setup per dot', () => {
  const app = createLanding({ width: 390, height: 844 });
  app.scrollToProgress(0.10).flush();

  const drawn = app.canvas.arcs.at(-1);
  const styles = app.canvas.styles.at(-1);
  const paths = app.canvas.paths.at(-1);

  // Exactly once each: 150 noise dots (halved from 300 for a narrow screen) plus 6 posts x 4 dots.
  // An exact count rather than a floor, because the cheap way to "batch" the field is to stop
  // skipping the chosen dots in the noise pass — which draws them grey and then paints them green
  // on top, costs more than it saves, and looks almost right. That mutation survived a >= 150 guard.
  assert.equal(drawn, 174,
    `${drawn} arcs at p=0.10, expected 174 (150 noise + 24 chosen). Either the field size changed ` +
    'deliberately — in which case update this number — or some dots are being drawn twice.');

  const wide = createLanding({ width: 1280, height: 800 });
  wide.scrollToProgress(0.10).flush();
  assert.equal(wide.canvas.arcs.at(-1), 324,
    'a wide screen should draw the full 300-dot field plus 24 chosen; the mobile halving is a ' +
    'deliberate concession and must not leak into desktop');

  // The 24 chosen dots legitimately each need their own colour — their alpha is staggered per dot
  // by the flight lag. The ~150 noise dots do not: they share one. 30 leaves room for the chosen
  // set plus a few frame-level state changes, and is far below the 174 that one-per-dot produces.
  assert.ok(styles <= 30,
    `${styles} fillStyle assignments to draw ${drawn} dots. The grey field's colour depends only on ` +
    'scroll position, so this is the same string rebuilt ~150 times per frame — at 60fps, ~9,000 ' +
    'string allocations a second for one flat-grey cloud. Hoist it out of the loop.');

  assert.ok(paths <= 30,
    `${paths} separate paths submitted to draw ${drawn} dots. The grey field shares one colour, so ` +
    'it can be one path with one fill — this is the single largest cost in the beat a real phone ' +
    'stuttered through.');
});

test('every batched arc starts a new subpath, so the field is dots and not a web', () => {
  // A tripwire, green before and after, for the specific way batching goes wrong: `arc()` draws a
  // line from the current point to the arc's start, so a path of arcs with no `moveTo` between them
  // renders as a spider's web joining every dot. Invariant: an arc must be preceded either by a
  // beginPath (which discards the current point) or by a moveTo.
  const app = createLanding({ width: 390, height: 844 });

  for (const p of [0.02, 0.10, 0.20, 0.40, 0.60]) {
    app.scrollToProgress(p).flush();
    const arcs = app.canvas.arcs.at(-1);
    const starts = app.canvas.paths.at(-1) + app.canvas.moves.at(-1);
    assert.ok(starts >= arcs,
      `at p=${p}, ${arcs} arcs were drawn with only ${starts} subpath starts — at least one arc ` +
      'continues the previous one, which draws a straight line between two dots');
  }
});

test('the canvas draws dots while they are alive and none once they are gone', () => {
  // This is the premise moving() rests on: past FLY[1] every chosen dot has f = 1 so its alpha is
  // 0, and the noise dots went to zero back at QUEUE[1] — the canvas is empty, so a frame cannot
  // change anything and the loop is free to idle. The harness records exactly this and the suite
  // asserted it nowhere, which left the loop fix resting on a comment.
  const app = createLanding();

  app.scrollToProgress(0.30).flush();
  assert.ok(app.canvas.arcs.at(-1) > 0,
    'the canvas drew no dots at all mid-story — the stage is a black rectangle');

  // 0.12, not 0.21: re-derived for BUG-082. The bloom peaks at the middle of SELECT, which moved
  // from [0.13, 0.29] to [0.05, 0.19] — so mid-SELECT is (0.05 + 0.19) / 2 = 0.12. At the old 0.21
  // the field is now PAST the bloom entirely (`sel` clamps to 1, sin(pi) = 0, nothing is blitted),
  // so the test would have gone quietly green-for-the-wrong-reason had the assertion been inverted.
  const bloomsBefore = app.canvas.blooms;
  app.scrollToProgress(0.12).flush();
  assert.ok(app.canvas.blooms > bloomsBefore,
    'no dot ever blooms amber. The bloom IS beat 2 — the moment of choosing — and without it the ' +
    'grey field simply turns green with nothing marking the decision');

  app.scrollToProgress(0.95).flush();
  assert.equal(app.canvas.arcs.at(-1), 0,
    'dots are still being drawn after the pour, so the canvas is NOT empty past FLY[1] — which is ' +
    'the premise the whole idle-when-not-moving fix rests on');
});

test('reduced motion does not hold the frame loop open (round-1 H2)', () => {
  // The bug this whole loop-control exists to remove, still fully present on the one setting that
  // asks for less work. `moving()` was a function of progress alone, but under reduced motion the
  // dots have no wobble, so position stops depending on time and every frame paints identical
  // pixels. A reduce-motion visitor anywhere before FLY[1] burned 324 dots at 60fps, forever.
  const app = createLanding({ reduced: true });

  // The guard has to compare frames that actually PAINTED. Flushing repeatedly cannot do it once
  // the loop is fixed — it re-arms nothing, so there is no second frame and the fingerprint is
  // trivially equal to itself. Scrolling within one snap stop does.
  //
  // The three points are re-derived for BUG-082, and the PREMISE moved, not just the numbers: the
  // old trio rested on "0.20, 0.21 and 0.235 all snap to 0.22", which is false under the new stops
  // (0.20 -> 0.12, 0.21 -> 0.29). The new stops are [0.02, 0.12, 0.29, 0.43, 0.57, 0.78, 0.96], so
  // anything between the 0.12/0.29 midpoint (0.205) and the 0.29/0.43 midpoint (0.36) snaps to
  // 0.29 — 0.27, 0.29 and 0.31 are three renders of the SAME progress at three different times.
  // If anything still moved with time, they would differ.
  //
  // `ink`, not `arcs`: a count of dots cannot tell a still frame from a moving one, since the same
  // 324 are drawn either way. This hashes where each one actually landed.
  const fingerprint = () => app.canvas.ink.at(-1);
  app.scrollToProgress(0.27).flush(); const first = fingerprint();
  app.scrollToProgress(0.29).flush(); const second = fingerprint();
  app.scrollToProgress(0.31).flush(); const third = fingerprint();

  assert.equal(first === second && second === third, true,
    `guard: three renders of the same beat at different times painted dots in DIFFERENT places ` +
    `(${first}/${second}/${third}) — something is still animating under reduced motion, so ` +
    'stopping the loop would freeze real movement rather than save wasted work');

  assert.equal(app.pendingFrames(), 0,
    'the loop is still re-arming under prefers-reduced-motion, repainting pixel-identical frames ' +
    'at 60fps — the exact defect this change exists to remove, on the setting that asks for less');
});

test('reduced motion still repaints on scroll — suspended, not dead', () => {
  // The other half, same shape as the non-reduced pair above: "never schedules a frame" satisfies
  // the test above and freezes the still frames the reduced-motion story is told in.
  const app = createLanding({ reduced: true });
  app.scrollToProgress(0.20).flush();
  assert.equal(app.pendingFrames(), 0, 'guard: the loop did not idle, so this proves nothing');

  app.scrollToProgress(0.86);

  assert.ok(app.pendingFrames() > 0,
    'scrolling under reduced motion scheduled no frame at all, so the snapped still frames would ' +
    'never advance');
  app.flush();
  // Re-derived for BUG-082, and 0.86 is no longer a snap stop — it now snaps back to 0.78.
  // Posts clear at CLEAR[0] + i·(CLEAR[1]-CLEAR[0])/6 = 0.71 + i·0.02333:
  //   i=0 0.710   i=1 0.733   i=2 0.757   i=3 0.780   i=4 0.803   i=5 0.827
  // At the snapped 0.78, posts 0-3 have gone and two are still standing — "2 left", where the old
  // stops left one. (The previous value was 1 left, and before that 0 from bad arithmetic; the
  // number is derived here rather than read off the failure so it stays checkable.)
  assert.equal(app.count(), '2 left',
    'the frame that did run painted the beat the page was scrolled away FROM, so the still frames ' +
    'are stuck where the loop stopped');
});

// ── The mobile copy step-back (round-1 H1, and later BUG-085) ────────────────────────
//
// These three tests pin what the WRITER emits: the step-back happens, it ENDS before the CTA
// arrives, and it never touches a wide screen. All three assertions are unchanged since BUG-085.
//
// What changed underneath them is which element spends the value. It used to be
// `.copy { opacity: var(--copyfade, 1) }`, and `#stage-cta` is one of its children, so the parent's
// opacity multiplied the button — a cascade fact nothing in the DOM stated, which is why two
// reviewers had to find round-1 H1 by reading the CSS and the writer together. The same fade also
// swallowed the headline's third clause, which lights at p=0.60, inside it. BUG-085 moved the
// opacity to `.sub` alone.
//
// The harness cannot see any of that: it records the VALUE, not the element the cascade applies it
// to, so every assertion here stayed green through a change that altered what a phone renders. That
// blind spot is covered by a source-text test in test/public-landing.test.mjs instead. Worth
// knowing before trusting a green run here to mean the step-back is correct — it means the writer
// is correct, which is a smaller claim.

test('the copy comes back before the CTA arrives, so the button is not rendered at 26%', () => {
  // Round-1 H1. The step-back was written for the pour, when the phone should own a narrow view.
  // It had no end, so the page's ONLY conversion path — the button that arrives with the daylight
  // at p ≈ 0.92 — rendered at 0.26 opacity on every phone, along with the headline and subhead.
  //
  // Since BUG-085 the CTA is no longer in the faded subtree at all, so the button is safe by
  // construction and this name now overstates what the assertion proves. Kept rather than renamed
  // or deleted, because the assertion still guards something real and separate: the subhead must
  // return to full opacity by the end of the story. If the fade is ever moved back onto `.copy`,
  // the CTA hazard returns and THIS test would not notice — public-landing.test.mjs is what does.
  const app = createLanding({ width: 390, height: 844 });

  app.scrollToProgress(0.95).flush();

  assert.equal(app.el('stage-cta').classList.contains('on'), true,
    'guard: the CTA never turned on at p=0.95, so this test is not looking at the CTA at all');
  assert.equal(Number(app.el('copy').style['--copyfade']), 1,
    'the block containing the page’s only CTA is still faded at the end of the story — the button ' +
    'renders at that opacity on every viewport under 860px');
});

test('the copy still steps back mid-pour so the phone owns a narrow view', () => {
  // The other half of the same fix: "restore it at the end" must not become "delete it". Without
  // this, dropping the step-back entirely passes the test above while losing what it was for.
  const app = createLanding({ width: 390, height: 844 });

  app.scrollToProgress(0.60).flush();

  assert.ok(Number(app.el('copy').style['--copyfade']) < 0.3,
    'the copy no longer steps back while the dots pour into the phone, so a narrow screen shows ' +
    'full-strength headline copy competing with the beat it is meant to hand over to');
});

test('a wide screen never fades the copy at all', () => {
  // The step-back is a mobile-only concession. On desktop the copy and the phone sit side by side,
  // so there is nothing to hand over and the writer must emit a flat 1 at every beat.
  const app = createLanding({ width: 1280, height: 800 });

  [0.10, 0.60, 0.95].forEach((p) => {
    app.scrollToProgress(p).flush();
    assert.equal(Number(app.el('copy').style['--copyfade']), 1,
      `the copy faded at p=${p} on a 1280px viewport, where the mobile step-back should not apply`);
  });
});

test('the pour boundary is where the loop hands over from moving to idle', () => {
  // Honest scope: this samples two points either side of the boundary, 0.13 apart — it does NOT
  // pin the threshold itself, and a review proved `moving()` can drift by ±0.03 in either direction
  // with this test green. (The comment here previously claimed the opposite.) Tightening it to
  // FLY[1]±0.005 belongs with the paint-coverage work in TASK-091's round-1 disposition, so that
  // the whole suite is strengthened in one pass rather than piecemeal.
  const inside = createLanding();
  inside.scrollToProgress(FLY_START + (FLY_END - FLY_START) * 0.5).flush();
  assert.equal(inside.pendingFrames(), 1, 'the loop stopped while dots were still in flight');

  const outside = createLanding();
  outside.scrollToProgress(FLY_END + 0.05).flush();
  assert.equal(outside.pendingFrames(), 0, 'the loop kept running past the point where dots exist');
});

// ── How long the story takes to start, and to finish (BUG-082) ───────────────────────────────────
//
// Reported from a phone against production: "the scroll amount is a bit too much before the dots
// turn gold, it takes too long to reach that state and the actual scene to begin."
//
// These are written in SCREEN HEIGHTS, not in beat constants, and that is the point. The constants
// are a starting set that will be tuned on a handset; a criterion pinned to `SELECT[0] === 0.05`
// would have to be rewritten with every tweak and would assert the tuning rather than the goal.
// A screen height is the thing the visitor actually experiences.
//
// `screens(p)` is exact rather than a model: the pin travels `stage - pin` = (STAGE_VH - 1) viewport
// heights, so progress p costs p * (STAGE_VH - 1) screens of scrolling. STAGE_VH is derived from the
// real CSS by the harness, so shortening the track moves these numbers automatically.
const screens = (p) => p * (STAGE_VH - 1);

// The beats are read from BEHAVIOUR, not from constants mirrored into this file. A mirrored copy
// asserts that two numbers I typed agree with each other; scanning asserts what the page does.
function firstPWhere(app, predicate, step = 0.005) {
  for (let p = 0; p <= 1 + 1e-9; p += step) {
    app.scrollToProgress(Math.min(p, 1)).flush();
    if (predicate(app)) return Math.min(p, 1);
  }
  return null;
}

test('the amber bloom begins within a quarter screen of scrolling (BUG-082 AC1)', () => {
  const app = createLanding({ width: 393, height: 844 });
  app.setOnStage(true);

  // The bloom sprite is blitted only for dots that are lighting up, so the first frame that draws
  // one IS the first beat becoming visible. `blooms` is cumulative, so the signal is the delta.
  let seen = app.canvas.blooms;
  const p = firstPWhere(app, (a) => {
    const grew = a.canvas.blooms > seen;
    seen = a.canvas.blooms;
    return grew;
  });

  assert.ok(p !== null, 'guard: no bloom was ever drawn, so this test is measuring nothing');
  assert.ok(screens(p) <= 0.25,
    `nothing happens for the first ${screens(p).toFixed(2)} screen heights — the visitor scrolls ` +
    'that far watching an unchanging grey cloud before the page begins its argument. That is the ' +
    'most expensive stretch of the page, and it is the one a stranger from a poll link judges it on.');
});

test('the pour into the phone begins within 1.8 screens (BUG-082 AC2)', () => {
  const app = createLanding({ width: 393, height: 844 });
  app.setOnStage(true);

  // The pour BEGINS when the column stops being still. Once the queue has formed, `queue` is 1 and
  // `fly` is still 0, so every dot sits exactly on its slot with no wobble term and consecutive
  // frames are pixel-identical; the first frame that differs again is the first dot leaving.
  //
  // This measured the first POST LANDING first, which was wrong and is worth recording rather than
  // quietly rewriting. A post lands well after the pour starts — 1.96 screens against the pour's
  // 1.70 — so the test asserted something stricter than the criterion it named, and failed a
  // criterion the code actually met. The proxy was chosen as "conservative"; the conservatism was
  // bigger than the margin. A probe has to measure the thing it claims to measure.
  let prev = null, stillFrom = null;
  const p = firstPWhere(app, (a) => {
    const ink = a.canvas.ink.at(-1), arcs = a.canvas.arcs.at(-1);
    const still = prev !== null && ink === prev && arcs > 0;
    const moved = stillFrom !== null && !still;      // the held column has started to move
    if (still && stillFrom === null) stillFrom = ink;
    prev = ink;
    return moved;
  });

  assert.ok(p !== null, 'guard: the column never held then moved, so this test is measuring nothing');
  assert.ok(screens(p) <= 1.8,
    `the pour does not begin until ${screens(p).toFixed(2)} screens in. The pour is the beat that ` +
    'shows the product working; asking for most of two screens before it starts loses the visitors ' +
    'who never get there.');
});

test('the whole story fits in four screen heights (BUG-082 AC3)', () => {
  // Pure derivation from the CSS — no scanning needed. The track IS the ask.
  const total = STAGE_VH - 1;
  assert.ok(total <= 4.0,
    `the stage asks for ${total.toFixed(1)} screen heights of scrolling from top to "You're all ` +
    'caught up". Every one of them is a chance to leave.');
});

test('the queue hold survives the shortening (BUG-082 AC4)', () => {
  // A constraint, not a defect: this passes today and must still pass after the track is shortened.
  // It is the guard against fixing "too slow" by compressing the pivot beat out of existence.
  //
  // The hold is observable without knowing a single constant. Once the column has formed, `queue`
  // is 1 and `fly` is still 0, so every dot sits exactly on its slot with no wobble term — frames
  // are pixel-identical. The stretch where consecutive frames share an ink fingerprint IS the hold.
  const H = 844;
  const app = createLanding({ width: 393, height: H });
  app.setOnStage(true);

  const step = 0.0025;
  let prev = null, runStart = null, best = 0, bestStart = null;
  for (let p = 0; p <= 1 + 1e-9; p += step) {
    app.scrollToProgress(Math.min(p, 1)).flush();
    const ink = app.canvas.ink.at(-1);
    const arcs = app.canvas.arcs.at(-1);
    const still = prev !== null && ink === prev && arcs > 0;
    if (still) {
      if (runStart === null) runStart = p - step;
      if (p - runStart > best) { best = p - runStart; bestStart = runStart; }
    } else {
      runStart = null;
    }
    prev = ink;
  }

  const span = (STAGE_VH - 1) * H;
  const holdPx = best * span;

  assert.ok(bestStart !== null, 'guard: no still stretch found at all — the column never holds');
  assert.ok(holdPx >= 300,
    `the queue holds for only ${Math.round(holdPx)}px at a ${H}px viewport. The column has to exist ` +
    'long enough to be read as an ordered list — that is the pivot beat of the page and the one ' +
    'visual claim an algorithmic feed cannot make (TASK-091 AC1). Shortening the track must not ' +
    'buy speed by deleting it.');
});

test('the platform rows are gone before the phone arrives in their slot (BUG-082)', () => {
  // Not a pacing criterion of its own — it is the invariant BUG-084 created and BUG-082 can break.
  // #rows and #stage-cta were taken OUT of the flow and parked at `top: 100%` of .copy, which is
  // exactly the space the phone later occupies. That is only safe because the rows have finished
  // fading before the phone starts appearing; if the two ever overlap, a half-faded COMING SOON row
  // renders through the product demo.
  //
  // The margin is 0.04 of progress and it is easy to spend by accident: rows finish at 0.21
  // (`smooth(0.12, 0.21, p)`) and the phone starts at QUEUE[0] + 0.04 = 0.25. Re-pacing moved both,
  // and nothing in the suite noticed — reverting the rows fade to its pre-BUG-082 timing was the one
  // mutation of this change that survived green.
  const app = createLanding({ width: 393, height: 844 });
  app.setOnStage(true);

  let firstVisible = null;
  for (let p = 0; p <= 1 + 1e-9 && firstVisible === null; p += 0.005) {
    app.scrollToProgress(Math.min(p, 1)).flush();
    if (parseFloat(app.el('phone').style.opacity) > 0) firstVisible = Math.min(p, 1);
  }

  assert.ok(firstVisible !== null, 'guard: the phone never became visible, so this proves nothing');
  assert.equal(parseFloat(app.el('rows').style.opacity), 0,
    `at p=${firstVisible.toFixed(3)} the phone has started to appear while the platform rows are ` +
    `still at opacity ${app.el('rows').style.opacity}. They share one absolutely-positioned slot ` +
    '(BUG-084), so the rows are now rendering through the phone.');
});
