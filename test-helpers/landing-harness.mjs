// Run the REAL landing.js inside Node so the dot story's frame loop can be tested (TASK-091).
//
// Why this exists: three defects went into the landing rebuild in a single sitting — a loop that
// never stopped, a resize that repainted the DOM while leaving the canvas showing a different
// scroll position, and a boot that left the headline fully dim. All three were found by looking,
// one of them only because a screenshot happened to be taken mid-resize, and NONE of them could be
// caught by any test that existed. (No commit SHA is cited here on purpose: the first version of
// this comment named one, and a later rebase made it unreachable from any ref.)
//
// The browser was a poor instrument for the loop specifically. Chrome reports an automated tab
// `hidden` and suspends both requestAnimationFrame and CSS transitions, so a liveness probe run
// that way reads 0 no matter what the code does — which is exactly how the second fix attempt was
// wrongly declared broken. Here rAF is a QUEUE THE TEST DRIVES, so "did the loop re-arm?" stops
// being a timing question and becomes a fact you can read off `pendingFrames()`.
//
// It lives OUTSIDE test/ on purpose, exactly like app-harness.mjs and handler.mjs: `node --test
// test/` treats every .mjs under that directory as a test file, so a harness parked there reports
// itself as a passing test with zero assertions.
//
// Two properties to keep:
//   1. It runs landing.js VERBATIM from disk — and unlike app-harness there is no transform at all,
//      because landing.js is a plain IIFE with no import declarations. If that ever changes, strip
//      the import here rather than keeping a copy of the code.
//   2. Assert on OBSERVABLE OUTPUT — which classes ended up on which element, what the counter
//      reads, whether another frame was scheduled. Never "was this function called".
//
// Gotcha, same as app-harness: values built inside the vm carry that realm's prototypes, so
// `assert.deepEqual` from node:assert/strict fails on structurally identical objects. Compare
// fields.
import fs from 'node:fs';
import vm from 'node:vm';

const LANDING = new URL('../landing.js', import.meta.url);
const INDEX = new URL('../index.html', import.meta.url);

// ── Everything the fake DOM knows, it reads off the real page (round-1 H4) ──────────────
//
// The first version of this harness invented an element for any id it was asked for, and hardcoded
// the stage geometry. That made the whole suite blind to the one thing it most needed to see: the
// coupling between landing.js and the markup it drives. A reviewer renamed `id="stage"` — which
// makes the script bail at its first line and the animation entirely dead — and all 484 tests
// passed. Same for deleting a demo post, and for changing the 700vh scroll track to 100vh.
//
// So the three facts the script depends on are DERIVED here, and an id the page does not have
// resolves to null exactly as `document.getElementById` would.
const HTML = fs.readFileSync(INDEX, 'utf8');

function derive(re, what) {
  const m = HTML.match(re);
  if (!m) throw new Error(
    `landing-harness: could not find ${what} in index.html. The harness derives it from the real ` +
    `page on purpose — if the markup moved, update this pattern rather than hardcoding a value.`);
  return m[1];
}

// The scroll track, as a multiple of the viewport: 700vh -> 7. progress() is -top / (height -
// innerHeight), so this number IS the mapping from scroll position to beat, and at 1 (a 100vh
// stage) the span is zero and the story cannot advance at all.
//
// The /100 is load-bearing and was briefly missing: with the raw 700 every test still passed,
// because the harness's own span cancels out of its own progress calculation. A derived value that
// nothing can disagree with is the same blindness this block exists to remove, one level up.
// Exported because BUG-082's acceptance criteria are written in SCREEN HEIGHTS rather than in beat
// constants — deliberately, so they survive the constants being tuned on a handset. A test needs the
// real track to convert one to the other, and reading it from here keeps the single derivation
// rather than starting a second copy that can drift from the CSS.
export const STAGE_VH = parseFloat(derive(/\.js-stage\s+\.stage\s*\{[^}]*height:\s*([\d.]+)vh/, 'the .js-stage .stage height')) / 100;

// The demo posts. NPOST drives the per-dot stagger, the clear schedule and the counter, so a post
// added or removed in the markup shifts every beat boundary after the pour.
const NPOST = (HTML.match(/<article[^>]*\bclass="post\b/g) ?? []).length;

// Every id the real page defines. Anything else is a typo or a rename, and must read as absent.
const PAGE_IDS = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

function stubEl(id = '') {
  const classes = new Set();
  const style = {
    setProperty: (k, v) => { style[k] = String(v); },
    removeProperty: (k) => { delete style[k]; },
  };
  const el = {
    id,
    textContent: '',
    style,
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, on) => (on === undefined
        ? (classes.has(c) ? classes.delete(c) : classes.add(c))
        : (on ? classes.add(c) : classes.delete(c))),
      contains: c => classes.has(c),
    },
    classes: () => [...classes],
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return el;
}

// Records what was drawn instead of drawing it. `clearRect` is the honest frame counter: draw()
// opens with exactly one per call, so `draws` counts renders of the CANVAS specifically — which is
// the half that a DOM-only repaint silently skips. `arcs` is a coarse fingerprint of WHICH beat was
// drawn: every dot is skipped once its alpha reaches 0, so a canvas painted after the pour draws
// none at all.
//
// `ink` is the same idea one level finer: a per-frame rolling hash of every dot's POSITION. The
// count alone cannot tell a still frame from a moving one — the same 324 dots are drawn either way
// — so "these frames are identical" was not something the harness could actually say. It had to be
// able to: that claim is the entire justification for letting the loop idle under reduced motion.
//
// `styles`, `paths` and `moves` count canvas WORK per frame rather than pixels. They exist because
// the cost of a frame is not the dot count: a real phone stuttered through the grey field, which
// draws 174 dots against 24 once the queue has formed, and the per-dot cost there was a colour
// string rebuilt identically 150 times plus 150 separate path submissions. "The field costs O(1)
// canvas state" is the property that fixed it, so it is the property the suite can now assert.
export function newRecord() {
  return { draws: 0, arcs: [0], ink: [0], styles: [0], paths: [0], moves: [0], composites: [0], blooms: 0 };
}

function stubCtx(record) {
  const bump = (k) => { const a = record[k]; if (a.length) a[a.length - 1]++; };
  const ink = (x, y, r) => {
    const i = record.ink.length - 1;
    // Rounded to 0.01px: enough to see a wobble, immune to float noise. |0 keeps it a 32-bit int.
    record.ink[i] = (Math.imul(record.ink[i], 31) + Math.round(x * 100) + Math.round(y * 100) * 7 + Math.round(r * 100) * 13) | 0;
  };
  let fillStyle = '';
  let composite = 'source-over';
  return {
    canvas: null,
    globalAlpha: 1,
    get globalCompositeOperation() { return composite; },
    set globalCompositeOperation(v) { composite = v; bump('composites'); },
    get fillStyle() { return fillStyle; },
    set fillStyle(v) { fillStyle = v; bump('styles'); },
    clearRect: () => {
      record.draws++;
      for (const k of ['arcs', 'ink', 'styles', 'paths', 'moves', 'composites']) record[k].push(0);
    },
    setTransform() {},
    beginPath: () => { bump('paths'); },
    moveTo: () => { bump('moves'); },
    arc: (x, y, r) => { bump('arcs'); ink(x, y, r); },
    fill() {},
    fillRect() {},
    drawImage: () => { record.blooms++; },
    createRadialGradient: () => ({ addColorStop() {} }),
  };
}

/**
 * Boot landing.js in a fake browser.
 *
 * @param {object}  opts
 * @param {boolean} opts.reduced  value of prefers-reduced-motion
 * @param {number}  opts.width    viewport width (mobile branch is < 860)
 * @param {number}  opts.height   viewport height
 */
export function createLanding({ reduced = false, width = 1280, height = 800 } = {}) {
  const record = newRecord();
  const els = new Map();
  const posts = Array.from({ length: NPOST }, (_, i) => stubEl(`__post-${i}`));

  let scrollY = 0;
  let now = 0;

  // Two heights, on purpose — this is the whole iOS URL-bar problem in one pair of variables.
  // `height` is the vh basis: what `100vh` resolves to, which on a phone is the LARGE viewport and
  // does NOT change when the browser chrome shows or hides. `innerH` is window.innerHeight, which
  // does. A page that mixes them moves its content when nothing has actually changed.
  let innerH = height;

  // ── The rAF queue the test drives. This is the whole point of the harness. ──
  let frames = [];
  let nextId = 1;
  const requestAnimationFrame = (cb) => { frames.push({ id: nextId, cb }); return nextId++; };
  const cancelAnimationFrame = (id) => { frames = frames.filter(f => f.id !== id); };

  // Captured so a test can put the stage off screen without a layout engine.
  let observerCb = null;

  const timers = [];
  const setTimeout_ = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const listeners = { scroll: [], resize: [] };

  const span = () => STAGE_VH * height - height;

  const elFor = (id) => {
    // As the real DOM answers: an id the page does not define is null, not a fresh element.
    if (!PAGE_IDS.has(id)) return null;
    if (!els.has(id)) {
      const el = stubEl(id);
      if (id === 'stage') {
        // progress() reads -top / (height - innerHeight). Modelling the sticky pin is unnecessary:
        // only the stage's own rect feeds the scroll→progress mapping.
        el.getBoundingClientRect = () => ({
          top: -scrollY, left: 0, right: width,
          bottom: STAGE_VH * height - scrollY,
          width, height: STAGE_VH * height,
        });
      }
      if (id === 'pin') {
        // .pin is `position: sticky; height: 100vh` — the box the canvas is inset:0 inside of, and
        // the one that stays put while innerHeight flickers.
        el.getBoundingClientRect = () => ({
          top: 0, left: 0, right: width, bottom: height, width, height,
        });
      }
      if (id === 'screen' || id === 'phone') {
        el.getBoundingClientRect = () => ({
          top: height * 0.15, left: width * 0.6, right: width * 0.85,
          bottom: height * 0.85, width: width * 0.25, height: height * 0.7,
        });
      }
      if (id === 'feed') el.querySelectorAll = (sel) => (sel === '.post' ? posts : []);
      els.set(id, el);
    }
    return els.get(id);
  };

  const documentElement = stubEl('html');
  const nav = stubEl('nav');

  const document = {
    documentElement,
    getElementById: id => elFor(id),
    querySelector: sel => (sel === '.nav' ? nav : stubEl(sel)),
    querySelectorAll: () => [],
    createElement: () => {
      const c = stubEl('canvas');
      c.getContext = () => stubCtx(newRecord());          // the glow sprite, not the stage
      return c;
    },
  };

  const field = elFor('field');
  field.getContext = () => stubCtx(record);

  const window_ = {
    innerWidth: width,
    get innerHeight() { return innerH; },
    devicePixelRatio: 2,
    get scrollY() { return scrollY; },
    matchMedia: () => ({ matches: reduced, addEventListener() {} }),
    requestAnimationFrame,
    cancelAnimationFrame,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    IntersectionObserver: class {
      constructor(cb) { observerCb = cb; }
      observe() {}
      disconnect() {}
    },
  };

  const ctx = vm.createContext({
    window: window_,
    document,
    matchMedia: window_.matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    IntersectionObserver: window_.IntersectionObserver,
    performance: { now: () => now },
    setTimeout: setTimeout_,
    clearTimeout: () => {},
    Math,
    console,
  });

  // Verbatim. No transform — see the header.
  vm.runInContext(fs.readFileSync(LANDING, 'utf8'), ctx, { filename: 'landing.js' });

  const api = {
    ctx,
    el: elFor,
    nav,
    html: documentElement,
    posts,
    canvas: record,

    /** How many frames are queued but not yet run. 0 means the loop has gone idle. */
    pendingFrames: () => frames.length,

    /** Run every queued frame once. Frames they schedule in turn are NOT run — that is the signal. */
    flush(times = 1) {
      for (let i = 0; i < times; i++) {
        const due = frames;
        frames = [];
        now += 16;
        due.forEach(f => f.cb(now));
      }
      return this;
    },

    /** Put the stage at scroll progress `p` and fire the scroll listeners, as a browser would. */
    scrollToProgress(p) {
      scrollY = Math.round(p * span());
      listeners.scroll.forEach(fn => fn());
      return this;
    },

    /**
     * Model the mobile browser chrome showing or hiding: window.innerHeight changes, every vh-based
     * box (.pin at 100vh) does NOT, and a resize fires — exactly what iOS Safari does when the URL
     * bar collapses on the first scroll. Anything that moves as a result is moving for no reason.
     */
    setInnerHeight(h) {
      innerH = h;
      listeners.resize.forEach(fn => fn());
      timers.splice(0).forEach(t => t.fn());
      return this;
    },

    /** Fire resize + run its debounce timer, which is what calls boot() again. */
    resize() {
      listeners.resize.forEach(fn => fn());
      timers.splice(0).forEach(t => t.fn());
      return this;
    },

    /** Drive the IntersectionObserver directly; there is no layout engine to do it for us. */
    setOnStage(isIntersecting) {
      if (observerCb) observerCb([{ isIntersecting }]);
      return this;
    },

    count: () => elFor('screenCount').textContent,
    lit: () => ['w1', 'w2', 'w3'].map(id => elFor(id).classList.contains('lit')),
    postsIn: () => posts.filter(p => p.classList.contains('in')).length,
    postsCleared: () => posts.filter(p => p.classList.contains('cleared')).length,
  };
  return api;
}
