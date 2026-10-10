// Run the REAL app.js inside Node so the exit paths can be tested.
//
// Why this exists: signOut/deleteAccount/pushNow/clearLocalIdentity are where the data-destroying
// defects live, and a suite covering only pure
// functions and the EXIT_DISPOSITION map stays green with `clearLocalIdentity(){}` as a no-op. The
// browser was never the hard part; the globals were. Fake the globals and the logic is ordinary
// testable code.
//
// It lives OUTSIDE test/ on purpose, exactly like test-helpers/handler.mjs: `node --test test/`
// treats every .mjs under that directory as a test file, so a harness parked there reports itself
// as a passing test with zero assertions.
//
// Two properties to keep:
//   1. It runs app.js VERBATIM from disk — no copy, no rewrite of logic. The only transform is
//      stripping the `import` line (vm.runInContext evaluates a *script*, and scripts cannot have
//      import declarations); the real bindings from lib/pure.js are injected instead, so the code
//      under test uses the same esc/exitKeyPlan/filters the browser loads.
//   2. Assert on OBSERVABLE OUTPUT — what the store holds afterwards, what requests went out, where
//      the page navigated. Never "was this function called". A test that asserts on calls passes
//      against a broken implementation that happens to make the same calls.
//
// Gotcha: values returned by app.js are built in the vm's realm, so they carry ITS Object.prototype
// and Array.prototype. `assert.deepEqual` from node:assert/strict compares prototypes and will fail
// on a structurally identical object. Compare fields individually, or JSON round-trip first.
import fs from 'node:fs';
import vm from 'node:vm';
import * as pure from '../lib/pure.js';

const APP = new URL('../app.js', import.meta.url);

// Only top-level `function` declarations and `var` become properties of a vm context; `const`/`let`
// stay in the script's lexical scope. That is why tests reach signOut() but not SK or _leaving —
// which is the right constraint anyway: it forces assertions onto observable state.
const IMPORT_RE = /^import\s+\{[\s\S]*?\}\s+from\s+'\.\/lib\/pure\.js';\s*$/m;

// ── Selector matching ─────────────────────────────────────────────────────────
// A `querySelectorAll` that answers `[]` makes `liftGroupedFromStream` — which reads
// `#feed .card`, and removes a card from under the reader — impossible to observe AT ALL.
// A hardcoded `[]` is not a stub, it is a wrong answer that never fails.
// These answer from the tracked `children` tree instead, so the reply is DERIVED.
//
// Deliberately NOT a CSS engine. It supports exactly the grammar app.js uses — `#id`, `.cls`,
// `[attr="v"]`, `:not(.cls)`, chained by descendant spaces — and **throws on anything else**, the
// same property `test-helpers/handler.mjs` has for unrecognised SQL: a selector this cannot model
// fails loudly instead of quietly returning nothing. Every selector in app.js was enumerated before
// this was written (14 forms, no tag selectors); a new one that throws here wants a line added, not
// a `catch`.
function parseCompound(part) {
  const need = { id: null, classes: [], notClasses: [], attrs: [] };
  let rest = part;
  rest = rest.replace(/:not\(\.([A-Za-z0-9_-]+)\)/g, (_m, c) => { need.notClasses.push(c); return ''; });
  rest = rest.replace(/\[([A-Za-z0-9_-]+)="([^"]*)"\]/g, (_m, k, v) => { need.attrs.push([k, v]); return ''; });
  rest = rest.replace(/#([A-Za-z0-9_-]+)/g, (_m, i) => { need.id = i; return ''; });
  rest = rest.replace(/\.([A-Za-z0-9_-]+)/g, (_m, c) => { need.classes.push(c); return ''; });
  if (rest.trim() !== '') throw new Error(`app-harness: unsupported selector part "${part}"`);
  return need;
}
// `data-*` is read off `dataset`, not `attrs`: renderTweetCard assigns `div.dataset.id = id`
// directly (`renderTweetCard`) and never calls setAttribute, so an attrs-only lookup would answer null for
// every card the feed actually renders.
function readAttr(el, key) {
  if (key.startsWith('data-')) {
    const camel = key.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    return el.dataset ? el.dataset[camel] : undefined;
  }
  return el.getAttribute ? el.getAttribute(key) : undefined;
}
function matchesCompound(el, need) {
  if (need.id && el.id !== need.id) return false;
  // One source of truth for classes: `className` is an accessor over the same Set `classList`
  // mutates (see stubEl), because a card gets `.card` from `div.className = 'card'` and
  // `.grouping-pending` from `classList.add` — reading only one of the two misses half the feed.
  const cls = el.classList;
  if (!cls) return false;
  for (const c of need.classes)    if (!cls.contains(c)) return false;
  for (const c of need.notClasses) if (cls.contains(c))  return false;
  // Values arrive through `CSS.escape` at the call site (`markGroupDone`), so unescape before
  // comparing — otherwise a Substack id (a URL, full of escapable characters) would never
  // match its own card and the miss would look like correct behaviour.
  for (const [k, v] of need.attrs) if (String(readAttr(el, k)) !== v.replace(/\\(.)/g, '$1')) return false;
  return true;
}
function descendantsOf(el, out = []) {
  for (const c of el.children || []) { out.push(c); descendantsOf(c, out); }
  return out;
}
// Descendant chain, left to right: each part narrows to the matching descendants of what survived.
function queryWithin(roots, sel) {
  const parts = String(sel).trim().split(/\s+/).map(parseCompound);
  let scope = roots;
  for (const need of parts) {
    const next = [];
    const seen = new Set();
    for (const root of scope) {
      for (const d of descendantsOf(root)) {
        if (matchesCompound(d, need) && !seen.has(d)) { seen.add(d); next.push(d); }
      }
    }
    scope = next;
  }
  return scope;
}

function stubEl(id = '') {
  const classes = new Set();
  const attrs = new Map();
  const kids = new Map();
  const el = {
    id,
    textContent: '',
    value: '',
    disabled: false,
    // NUMERIC, like every real element, and the gap would not be cosmetic: the
    // gesture guard walks ancestors asking `el.scrollTop > 0`, and against a stub with NO scrollTop
    // that reads `undefined > 0` — false, by luck. Changing the guard to `>= 0` would then survive the
    // whole suite, while in a browser it makes the FIRST ancestor answer true, so touchstart always
    // bails and pull-to-refresh is dead on every screen.
    // A stub that omits a property the code reads does not fail; it agrees with you.
    scrollTop: 0,
    style: {},
    dataset: {},
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (on ? classes.add(c) : classes.delete(c))),
      contains: c => classes.has(c),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: k => attrs.delete(k),
    focus() { el.focused = true; },
    blur() {},
    // RECORDED, not dispatched — and it is the download. `exportData` builds an `<a download>`,
    // appends it and calls this; without it the whole function threw TypeError inside the vm, so
    // every assertion about what it exported would have passed for the wrong reason. Deliberately
    // does NOT fire listeners: a detached `<a download>` has none, and `app.click(el)` is the
    // driver for controls that do. The payload itself is captured at URL.createObjectURL.
    click() { el.clicks = (el.clicks || 0) + 1; },
    // Recorded, not run. The harness cannot dispatch events, but "was this control wired at all"
    // is a different question from "what does it do", and it is the one the sign-in wall turns on:
    // wireApp() is only trustworthy if it is ALL-or-nothing, and hoisting any single wiring call
    // out of the session gate used to be invisible to the suite. Assert on `listeners.length`.
    addEventListener: (type, fn) => { el.listeners.push({ type, fn }); },
    removeEventListener() {},
    listeners: [],
    // Tracked, not stubbed. `updateSectionHeads` decides whether the Topics/Posts headings show by
    // reading `children.length`, so an always-empty array would answer "no content" forever and let a
    // test pass vacuously (a field declared, returned, never populated).
    children: [],
    // `_parent` is what makes `remove()` real. As a no-op — declared, called by production code,
    // doing nothing — a harness `#feed` grows forever and `liftGroupedFromStream` has no effect a
    // test can see. Pinned by test/harness-dom.test.mjs.
    // ⚠️ DOES NOT DETACH, and a real `appendChild` does. Passing a node that is ALREADY in the tree
    // moves it in a browser; here it is pushed a second time, so the node appears at both its old
    // index and the end. A whole defect class — any re-parenting of an existing element — is
    // therefore invisible to this suite: measured, where a mutation moving
    // the topic card's summary slide to the end of its rail SURVIVED, because the slide stayed at
    // index 0 as well. A mutation in that shape must `remove()` first to be honest, and a test that
    // relies on this to catch re-ordering is not testing what it thinks. Not fixed here because
    // splicing on append changes the ordering every existing fixture already depends on.
    appendChild: c => { c._parent = el; el.children.push(c); return c; },
    // `insertIntoFeed` re-inserts an undone card at its chronological slot. Modelled for
    // completeness, NOT because the suite exercises it: with the numeric
    // epoch these fixtures use, `Date.parse(c.dataset.published)` is NaN, so `older` is undefined and
    // insertIntoFeed always APPENDS — insertBefore is reached only with an ISO-string `published`.
    insertBefore: (c, ref) => {
      c._parent = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i >= 0) el.children.splice(i, 0, c); else el.children.push(c);
      return c;
    },
    removeChild: c => {
      const i = el.children.indexOf(c);
      if (i >= 0) { el.children.splice(i, 1); c._parent = null; }
      return c;
    },
    remove() { if (el._parent) el._parent.removeChild(el); },
    closest: () => null,
    // Memoised per selector, for the same reason getElementById is: a handler assigned in one
    // statement has to be readable in the next. showToast() puts the action callback on
    // `el.querySelector('.toast-action').onclick`, and while every call returned a fresh stub that
    // callback was unreachable — which is why the wall's "Send a new one" guard had no test.
    querySelector: sel => {
      if (!kids.has(sel)) kids.set(sel, stubEl(sel));
      return kids.get(sel);
    },
    querySelectorAll: sel => queryWithin([el], sel),
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    scrollIntoView() {},
    insertAdjacentHTML() {},
  };
  // Assigning innerHTML destroys existing children in a real DOM; renderGroupGrid relies on that to
  // reset the grid before repainting, so the harness has to model it or `children` only ever grows.
  // The detached children have their `_parent` cleared too, or a later `remove()` would splice them
  // out of a parent that no longer holds them.
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html || '',
    set: v => {
      el._html = String(v);
      el.children.forEach(c => { c._parent = null; });
      el.children.length = 0;
    },
    enumerable: true,
  });
  // `className` over the SAME Set `classList` mutates, exactly as a real element does. Without this
  // the two disagreed: `renderTweetCard` gives a card its `.card` via `div.className = 'card'`
  // (`renderTweetCard`) while the hold arrives via `classList.add('grouping-pending')` — so a selector
  // reading either one alone matches nothing the feed renders, and `#feed .card` would still answer
  // `[]` with a fully "real" matcher in place. Found by running the query, not by reading the stub.
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: v => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    enumerable: true,
  });
  // `toggleGroupCard` collapses siblings through `card.parentElement`.
  Object.defineProperty(el, 'parentElement', {
    get: () => el._parent || null,
    enumerable: true,
  });
  return el;
}

/**
 * Boot app.js in a fake browser.
 *
 * @param {object}   opts
 * @param {object}   opts.store   initial localStorage contents, as a plain object
 * @param {function} opts.fetch   async (url, init) => Response-ish. Default: every call 200 {}.
 * @returns {{ctx, store, requests, navigations, toasts, toastLog, timers, runTimers, advance, setFetch, get, set}}
 */
/** Ids that ship with `class="… hidden"` in app/index.html. EXPORTED (and hoisted out of
 *  `createApp`) so test/docs.test.mjs can assert the contract this set depends on: every id here
 *  must really ship hidden in the markup, and its class must really have a `display: none` rule.
 *  Without that assertion, removing `hidden` from the markup and `display:
 *  none` from the CSS fails NOTHING — the harness seeds the class itself, so a seeded stub
 *  agrees with you about markup it never read. That is the vacuity trap this set exists to close,
 *  reappearing at the other end. */
// Elements that ship an INLINE `display:none` in the markup rather than a `hidden` class. Kept
// separate from HIDDEN_IDS because the app reads them differently — `.style.display`, not
// `.classList` — so seeding one as the other would answer the wrong question.
export const INLINE_HIDDEN_IDS = new Set(['feed']);

export const HIDDEN_IDS = new Set([
  // Both ship as `class="… hidden"` in app/index.html, so both belong here. Measured
  // rather than assumed: a control asserting "the ready bubble was shown" PASSED
  // against a tree where neither the element nor the code existed, because a fresh stub starts
  // with an empty class set and `contains('hidden')` answered false. Seeded, the same control
  // fails.
  'group-busy', 'group-ready-note',
  // docs.test.mjs asserts every id here really ships
  // hidden in app/index.html with a display:none rule, so a seed left behind after its markup goes
  // fails the suite — which is the check working, not a nuisance. #group-note is revealed by
  // `renderTopicCards`.
  'group-note',
  'videos-head', 'caughtup',
  // Both notices and both actions ship `class="… hidden"`. Seeded because a fresh stub
  // starts with an EMPTY class set and therefore reads as VISIBLE: at the RED step "the notice
  // survives a re-render" PASSED against a tree where neither the element nor the code existed.
  'damaged-notice-setup', 'damaged-notice-feed', 'damaged-notice-archive',
  'damaged-heal-setup', 'damaged-heal-feed', 'damaged-heal-archive',
  // Both account confirms ship as `class="acct-confirm hidden"` (app/index.html). Seeding them
  // matters for the same reason `.toast-action` is seeded below: a fresh stub starts with an EMPTY
  // class set, so "the confirm was revealed" passes whether or not the code ever revealed it — and
  // a destructive confirm nobody can prove was shown is the worst place to keep that hole.
  'acct-delete-confirm', 'acct-signout-confirm',
  // It ships `class="pref-manage btn-mark-all hidden"`, so a fresh stub starting with an
  // EMPTY class set answered `false` to contains('hidden') — and every assertion that this control
  // was REVEALED passed whether or not updateCount ever revealed it. Dormant while the button lived
  // in the appbar and nothing asked; live the moment it does.
  'btn-mark-all',
  // The tour layer, its ring and its four blockers — every tour element the code shows or
  // hides. Unseeded, "the tour ended and left nothing dimmed" would pass over stubs that
  // were never hidden in the first place.
  'tour', 'tour-ring', 'tour-block-top', 'tour-block-right', 'tour-block-bottom', 'tour-block-left',
  // The add flow's confirm panel ships `class="add-confirm hidden"`, and the tour's add step highlights it only
  // while it is SHOWING, so the stub is seeded to match the markup. NOT
  // load-bearing today, measured: `initSetup → showAddForm` hides the panel on every entry to setup before any
  // card is drawn, and removing this seed changes no test. It protects a future path
  // that draws a card before setup has run.
  'add-confirm',
  ]);

// One counter for the whole process, so every document this harness builds mints ids no other
// document can repeat — see `docId` below.
let docSeq = 0;

export function createApp({ store: initial = {}, fetch: fetchImpl, search = '' } = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
  const requests = [];
  const navigations = [];
  const toasts = [];
  // `toasts` records WHAT was said; `toastLog` records the state it was said INTO.
  // "the panel was closed" and "the panel was closed FIRST" have IDENTICAL end states, so an
  // end-state assertion cannot tell them apart. This captures the panel at RAISE TIME, the only
  // moment the difference exists. Kept separate from `toasts` rather than folded into it: 40
  // assertions across three files read those entries as strings.
  //
  // ⚠️ WHAT THIS IS NOT. A toast raised with the drawer open is NOT painted behind it:
  // `.toast` sits at z-index 62 to clear the drawer (61) and its scrim (60). Measured live with the drawer
  // open, `elementFromPoint` over the Undo returns `.toast-action`. So this field pins an ORDERING
  // decision, not a reachability guarantee — do not cite it as the latter.
  const toastLog = [];
  const timers = [];
  let clock = 0;               // virtual ms, moved only by advance(); see the driver below
  let uuidSeq = 0;
  // UNIQUE PER DOCUMENT, not just per call. These ids used to restart at 1 for every
  // createApp, so two documents over the same storage — a reload, the second tab — minted the SAME
  // uuid, and anything keyed on one (an event id, a device id) had collisions no browser produces.
  // A dedupe test then read "two real boots" as one event and looked like a defect in the code.
  const docId = String(++docSeq).padStart(8, '0');

  let doFetch = fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) }));

  // A programmable storage FAILURE. Quota, a private window
  // and a browser blocking site data all make setItem throw. Unhandled mid-adopt, that
  // was measured as: the user's channel gone, `dirty` still set, the base not re-based, and
  // `toasts: []` — a silent destruction.
  // A test cannot ask that question without being able to cause it.
  //
  // `failGetItem` is the READ counterpart. A browser blocking site data throws
  // on `getItem` too, not only on `setItem` — and this is load-bearing rather than theoretical:
  // `_signOut` does not throw on a corrupt VALUE, so the seal test
  // ("a sign-out that throws does not release a seal held by an in-flight delete") cannot use
  // corrupt JSON as its instrument to force a throw. It uses this instead.
  let failSetItem = null;
  let failGetItem = null;
  const localStorage = {
    getItem: k => {
      if (failGetItem && failGetItem(k)) {
        const e = new Error('SecurityError'); e.name = 'SecurityError'; throw e;
      }
      return store.has(k) ? store.get(k) : null;
    },
    setItem: (k, v) => {
      if (failSetItem && failSetItem(k, v)) {
        const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
      }
      store.set(k, String(v));
    },
    removeItem: k => { store.delete(k); },
    clear: () => store.clear(),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };

  // Elements are MEMOISED by id, so a class written in one statement can be read back in the next.
  // A fresh stub per lookup would make DOM state write-only, and nothing in the suite could then
  // assert WHICH VIEW a boot ended on: deleting showView's call in
  // showLandingView() leaves every signed-out visitor staring at a blank page with the suite green.
  // The four views start `hidden`, matching app/index.html, so
  // showView's `add('hidden')` sweep + `remove('hidden')` on the target is observable via el().
  const VIEW_IDS = ['view-landing', 'view-setup', 'view-feed', 'view-archive'];
  // Every OTHER element app/index.html ships with class="hidden" is seeded hidden too: an unseeded
  // stub — whose class set starts EMPTY — reads as VISIBLE from boot, so a guard of the form
  // `!el.classList.contains('hidden')` takes the wrong branch on every call and any assertion
  // downstream of it passes VACUOUSLY.
  //
  // Seed a new id here the moment app/index.html ships it hidden; an unseeded stub does not fail, it
  // agrees with you.
  const docKids = new Map(); // memoised phantoms for document.querySelector's non-#id selectors
  // Every Blob handed to URL.createObjectURL, in order — i.e. every file the app offered the user.
  // `exportData` is the only producer today, and its tests turn on the DIFFERENCE
  // between "no file was offered" and "an empty file was offered".
  const objectUrls = [];
  const scrolls = [];   // every window.scrollTo, in order — see ctx.scrollTo below
  const observers = []; // every IntersectionObserver constructed, with what each was told to watch
  // Listeners registered on `window` and on `document` — RECORDED, and run only when a test fires
  // one, exactly like the element-scoped `listeners` array above stubEl. As `() => {}`,
  // `window.addEventListener('pagehide', flushPush)` and the
  // `visibilitychange` wiring beside it would be unreachable: no test could fire the unload flush
  // through the path a real tab close takes, so deleting either line would be a fully green mutation.
  const winListeners = [];
  const docListeners = [];
  // Run every `type` listener on one of those targets and report how many ran, so a test can tell
  // "the handler correctly did nothing" from "nothing was wired" — the distinction `app.click`
  // exists for. The event object is a bare stub: nothing here reads more than `type` today.
  const fireOn = (list, type, ev) => {
    const fns = list.filter(l => l.type === type);
    fns.forEach(l => l.fn(ev ?? { type }));
    return fns.length;
  };
  // Real removal, not a no-op: `_profileEsc` is added and removed by reference, so a no-op would
  // leave a test firing keydown into a handler a browser had already detached.
  const offFrom = (list, type, fn) => {
    const i = list.findIndex(l => l.type === type && l.fn === fn);
    if (i !== -1) list.splice(i, 1);
  };
  // `document.activeElement`. `focus()` used to set a flag on the element
  // and nothing else, so "focus moved INTO the card" was assertable and "focus came BACK on close" was
  // not — the second needs to know what was focused before, which is exactly this. Starts at `body`, as
  // a browser's does. Tracked only on elements the app can reach by id or create, which is every
  // element it focuses; a `querySelector` phantom keeps the old flag-only focus. It does NOT model a
  // browser refusing focus to an element inside a `display: none` ancestor.
  let activeEl = null;
  const trackFocus = (el) => {
    const focus = el.focus;
    const blur = el.blur;
    el.focus = () => { focus.call(el); activeEl = el; };
    el.blur = () => { blur.call(el); if (activeEl === el) activeEl = null; };
    return el;
  };
  const els = new Map();
  const elFor = (id) => {
    if (!els.has(id)) {
      const el = trackFocus(stubEl(id));
      if (VIEW_IDS.includes(id) || HIDDEN_IDS.has(id)) el.classList.add('hidden');
      // Same hazard as HIDDEN_IDS, one property over. `app/index.html:293` ships
      // `<div class="feed" id="feed" style="display:none">`, and a fresh stub starts with an EMPTY
      // style object — so a cold-boot `#feed` would read `''` here and `'none'` in a browser, and any
      // guard phrased "is the feed showing" would be answered by the harness rather than by the app.
      // Seeded, the two agree.
      if (INLINE_HIDDEN_IDS.has(id)) el.style.display = 'none';
      // `toasts` must actually be written to, or
      // `assert.equal(app.toasts.length, 0)` is permanently true no matter what the app does.
      // showToast's only record of the message is the textContent it
      // writes to `.toast-msg` (app.js), so recording that write is what makes a toast observable
      // as HISTORY rather than as last-value-wins.
      if (id === 'toast') {
        const msg = el.querySelector('.toast-msg');
        let text = '';
        Object.defineProperty(msg, 'textContent', {
          get: () => text,
          set: (v) => {
            text = String(v);
            toasts.push(text);
            // `elFor` is defined above and called later, so this is not a TDZ read. Asking for a
            // panel nothing has touched MEMOISES a fresh stub whose class set is empty, which
            // answers `false` — correct: a panel that was never opened is not covering anything.
            toastLog.push({ text, profileOpen: elFor('profile-panel').classList.contains('open') });
          },
          enumerable: true,
        });
        // app/index.html ships the action as `class="toast-action hidden"`, and a fresh stub starts
        // with an EMPTY class set — so an assertion that the button was revealed passes whether or
        // not showToast ever removed the class. Seeding it is what makes that assertion bite;
        // deleting `btn.classList.remove('hidden')` is otherwise a fully green mutation, leaving
        // the remedy invisible while the test calls onclick() directly.
        el.querySelector('.toast-action').classList.add('hidden');
      }
      els.set(id, el);
    }
    return els.get(id);
  };

  // The two theme buttons (app/index.html:338-343), memoised under pseudo-ids so their listeners
  // survive between statements exactly as a real node's would. Modelled because the THEME tap is the
  // measured repro of a data loss — a browser whose boot read failed, one tap, and the account's row is
  // emptied 1.5s later. `wireApp` reaches them only through querySelectorAll('.theme-opt'), so
  // answering `[]` there would leave the measured repro as the one mutation route no test could fire; the
  // Shorts toggle runs the same code but is not the control that destroyed a real row. Their
  // `dataset.theme` is what the click handler reads to decide which theme to store, so it is seeded
  // here rather than left undefined.
  const THEME_OPTS = ['light', 'dark'];
  const themeOptFor = (theme) => {
    const el = elFor(`__theme-opt-${theme}`);
    el.dataset.theme = theme;
    return el;
  };

  // `markGroupDone`'s card lookup and its tile lookup each address one node through `CSS.escape`.
  // Absent from the vm, both threw `CSS is not defined` — so the bulk "Mark N done" path could not be
  // driven at all. Not the full spec algorithm: it escapes everything outside [A-Za-z0-9_-], which
  // ROUND-TRIPS correctly against the matcher's unescape, which is the only property tests need.
  const CSS = { escape: str => String(str).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch) };

  const document = {
    body: trackFocus(stubEl('body')),
    documentElement: stubEl('html'),
    readyState: 'complete',
    visibilityState: 'visible',
    get activeElement() { return activeEl ?? document.body; },
    getElementById: id => elFor(id),
    // The SINGULAR sibling — the half that both document-level production
    // reads actually use (`markGroupDone`'s card and tile lookups). Returning a fresh truthy
    // detached stub would make `if (card)` permanently true, so renaming `data-id`, deleting `CSS.escape`,
    // or forcing the tile lookup to null would ALL be fully green mutations. An instrument that is
    // honest in one method and phantom in its sibling is worse than one that is uniformly crude.
    //
    // `#id`-rooted selectors go through the real matcher and can return null, exactly like a
    // browser. Bare-class selectors (`.appbar`, `.setup-scroll`, `.confirm-label`) still get a
    // phantom, because production dereferences those without a null check and the DOM model does not
    // contain them — but it is MEMOISED per selector, so a handler assigned in one statement is
    // readable in the next, as with the element-scoped version. Narrowed rather than fixed, and said
    // so: making those real needs a full DOM model, not a bigger matcher.
    querySelector: sel => {
      const parts = String(sel).trim().split(/\s+/);
      if (parseCompound(parts[0]).id) return document.querySelectorAll(sel)[0] ?? null;
      if (!docKids.has(sel)) docKids.set(sel, stubEl(sel));
      return docKids.get(sel);
    },
    // `.view` and `.theme-opt` stay enumerated: those stubs are memoised under pseudo-ids and are
    // parented to nothing, so no tree walk can reach them. Everything else is ANSWERED FROM THE TREE
    // rather than hardcoded to `[]` — see the selector-matching note above stubEl for why that
    // distinction matters.
    querySelectorAll: sel => {
      if (sel === '.view') return VIEW_IDS.map(elFor);
      if (sel === '.theme-opt') return THEME_OPTS.map(themeOptFor);
      const parts = String(sel).trim().split(/\s+/);
      const first = parseCompound(parts[0]);
      // `#feed .card…` — the shape that matters here. Root the walk at that element.
      if (first.id) {
        const root = elFor(first.id);
        if (parts.length === 1) return matchesCompound(root, first) ? [root] : [];
        return queryWithin([root], parts.slice(1).join(' '));
      }
      // No id root: every element memoised BY ID, plus their subtrees. Narrower than a browser's
      // document, and NOT "every element this harness has
      // ever handed out": `document.body`, `createElement` products not appended under an
      // id'd element, and the phantoms from `el.querySelector()` are all invisible here, so a card
      // appended to `document.body` answers 0 where a browser answers 1. Adequate because every
      // container app.js queries into is reached by id; widening it needs a full DOM model.
      // A class the model does not contain (`.chip`, `.nav-tab`) still answers `[]` —
      // because nothing matched, not because the answer was written in advance.
      if (parts.length > 1) {
        throw new Error(`app-harness: document-level descendant selector needs an #id root: "${sel}"`);
      }
      const out = [];
      const seen = new Set();
      for (const el of els.values()) {
        for (const cand of [el, ...descendantsOf(el)]) {
          if (!seen.has(cand) && matchesCompound(cand, first)) { seen.add(cand); out.push(cand); }
        }
      }
      return out;
    },
    createElement: tag => trackFocus(stubEl(tag)),
    addEventListener: (type, fn) => { docListeners.push({ type, fn }); },
    removeEventListener: (type, fn) => { offFrom(docListeners, type, fn); },
  };

  // `search` is settable so the auth-landing paths are testable: a magic-link round-trip arrives as
  // `?auth=ok|invalid|google_failed`, and the FAILURE values are the ones that matter — an expired
  // link must not skip the wall and drop an anonymous visitor into the app.
  // history.replaceState clears it, exactly as the browser does, so a test sees the real sequence.
  let _search = search;
  const location = {
    _href: 'http://localhost:3000/app' + _search,
    get href() { return this._href; },
    set href(v) { navigations.push(String(v)); this._href = String(v); },
    replace(v) { navigations.push(String(v)); this._href = String(v); },
    reload() { navigations.push('reload'); },
    // GETTER ONLY — assigning `app.ctx.location.search = '?x'` is a SILENT NO-OP: a probe that sets it that way
    // believes it has configured the app and reads "nothing happened". Pass `createApp({ search })`. Left a getter rather than
    // made settable, because `history.replaceState` below is what models the real strip and a
    // second write path would let a test diverge from the browser.
    get search() { return _search; },
    get pathname() { return '/app'; },
    get origin() { return 'http://localhost:3000'; },
  };
  const history = { replaceState: (_s, _t, url) => { _search = String(url || '').includes('?') ? '?' + String(url).split('?')[1] : ''; } };

  const crypto = { randomUUID: () => `${docId}-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}` };

  class HarnessURL extends URL {}
  HarnessURL.createObjectURL = (blob) => {
    objectUrls.push(blob);
    return `blob:harness/${objectUrls.length}`;
  };
  HarnessURL.revokeObjectURL = () => {};

  const ctx = {
    localStorage,
    document,
    CSS,
    location,
    history,
    crypto,
    console: { log() {}, warn() {}, error() {}, info() {} },
    // Timers are captured rather than run, so a test can assert "a push was re-armed" without
    // sleeping, and drive it deterministically with runTimers().
    setTimeout: (fn, ms) => { timers.push({ fn, ms, at: clock + (Number(ms) || 0) }); return timers.length; },
    clearTimeout: (id) => { if (id >= 1 && id <= timers.length) timers[id - 1].cancelled = true; },
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: fn => { timers.push({ fn, ms: 0, at: clock }); return timers.length; },
    fetch: async (url, init) => { requests.push({ url: String(url), init: init || {} }); return doFetch(String(url), init || {}); },
    // LOAD-BEARING, not housekeeping. syncOnLoad (app.js) and checkAuth both bound their boot fetch
    // with `new AbortController()` on the FIRST line of a try whose catch swallows everything. Without
    // this both throw ReferenceError, are swallowed as "offline", and init() completes
    // having issued ZERO requests — so every boot-path assertion passes vacuously.
    AbortController,
    // A real `URL` (so `new URL()` and its statics keep working) plus the two object-url statics
    // Node does not provide. Subclassed rather than replaced: `URL.canParse` and friends stay
    // reachable through the constructor's prototype chain.
    URL: HarnessURL,
    // Content-preserving, so a test can read back exactly what the app put in the file rather than
    // only that it made one.
    Blob: class {
      constructor(parts = [], opts = {}) {
        this.parts = [...parts];
        this.type = opts.type || '';
      }
      get size() { return this.parts.join('').length; }
      text() { return this.parts.join(''); }
    },
    URLSearchParams,
    JSON,
    Math,
    Date,
    Intl,
    TextDecoder,
    navigator: { onLine: true, userAgent: 'node', language: 'en' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    // Rendering ANY X card reaches wireCarouselDots, which constructs one of these — so without it
    // renderFeedResults throws ReferenceError and no test can drive the feed render at all. Inert on
    // purpose: the harness cannot scroll, and nothing asserts on carousel dots.
    // RECORDS what it was told to watch. A no-op stub makes "wired to the right elements" and
    // "wired to nothing at all" indistinguishable — and that is not hypothetical: calling
    // `wireCarouselDots(rail, dots, '.tc-slide', '.tc-dot')` against a two-parameter function that
    // hardcodes `.tweet-slide`/`.tweet-dot` silently drops the extra arguments, both lists
    // come back empty, the observer watches nothing, and the carousel's dots never move.
    // `observed` is the side-effect that makes the wiring assertable without dispatching an event.
    IntersectionObserver: class {
      constructor(cb, opts) { this.cb = cb; this.opts = opts; this.observed = []; observers.push(this); }
      observe(el) { this.observed.push(el); }
      unobserve() {}
      disconnect() {}
    },
    ...pure,                       // esc, exitKeyPlan, filters… the same bindings the browser loads
  };
  // `openGroupDetail` ends with `window.scrollTo(0, 0)`, so without this the drill-in
  // throws `window.scrollTo is not a function` and cannot be driven AT ALL. Recorded rather than silently swallowed: "did opening a group scroll the
  // reader to the top" is a real question, and a no-op would make it permanently unanswerable.
  ctx.scrollTo = (x = 0, y = 0) => { scrolls.push({ x, y }); };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window.crypto = crypto;
  ctx.window.addEventListener = (type, fn) => { winListeners.push({ type, fn }); };
  ctx.window.removeEventListener = (type, fn) => { offFrom(winListeners, type, fn); };

  let src = fs.readFileSync(APP, 'utf8');
  if (!IMPORT_RE.test(src)) {
    throw new Error('app-harness: app.js no longer starts with the expected lib/pure.js import — update IMPORT_RE');
  }
  src = src.replace(IMPORT_RE, '');

  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'app.js' });

  return {
    ctx,
    store,
    requests,
    navigations,
    toasts,
    /** Every toast as `{ text, profileOpen }`, with `profileOpen` read AT RAISE TIME.
     *  Use it to pin the ORDER of a drawer close against a message — NOT to conclude anything about
     *  reachability. `.toast` is z-index 62 and clears the drawer (61) and its scrim (60), so a
     *  message raised with the panel open is still on top. See the declaration for the measurement. */
    toastLog,
    /** Make localStorage.setItem throw for keys the predicate accepts; null restores it. */
    failSetItem: (pred) => { failSetItem = pred; },
    /** Make localStorage.getItem throw for keys the predicate accepts; null restores it.
     *  Models a browser blocking site data, which refuses READS as well as writes. */
    failGetItem: (pred) => { failGetItem = pred; },
    /** Every file the app offered the user, as `{ type, text }`, in order. Empty means NO download
     *  was produced — which is a different fact from an empty one. */
    exports: () => objectUrls.map(b => ({ type: b.type, text: typeof b.text === 'function' ? b.text() : '' })),
    timers,
    scrolls,
    /** Every IntersectionObserver the app constructed, each with an `observed` array of the elements
     *  it was told to watch. Use it to assert that wiring reached the RIGHT nodes — a carousel wired
     *  to a selector that matches nothing looks identical to a correct one from every other angle. */
    observers,
    get: k => (store.has(k) ? store.get(k) : null),
    set: (k, v) => store.set(k, String(v)),
    setFetch: fn => { doFetch = fn; },
    urls: () => requests.map(r => r.url),
    /** The memoised element for `id` — lets a test read back what the app wrote to the DOM.
     *  `visibleViews()` is the one that matters: it answers "which screen did this boot end on". */
    el: id => elFor(id),
    /** `document.querySelectorAll`, exposed so the selector model itself is assertable.
     *  Needed because the app's own reads of `#feed .card` are internal, and an instrument that
     *  cannot be interrogated hides defects. Pinned by test/harness-dom.test.mjs. */
    queryAll: sel => document.querySelectorAll(sel),
    visibleViews: () => VIEW_IDS.filter(id => !elFor(id).classList.contains('hidden')),
    /** The memoised `.theme-opt` button for 'light' | 'dark'. */
    themeOpt: theme => themeOptFor(theme),
    /** Run every click listener registered on `el`, and report how many ran.
     *  The count is returned rather than swallowed so a test can assert the control was WIRED —
     *  a tap on an unwired button is silently a no-op, which is indistinguishable from a tap whose
     *  handler correctly did nothing (clicks that never ran read as "the toast never fires"). */
    click: (el) => {
      const fns = el.listeners.filter(l => l.type === 'click');
      fns.forEach(l => l.fn());
      return fns.length;
    },
    /** Every listener the app registered on `window` / on `document`, as `{ type, fn }`.
     *  Read them to assert wiring ("is anything listening for pagehide at all"); fire them to
     *  drive it. Neither list is dispatched by the harness itself. */
    winListeners,
    docListeners,
    /** Run every `window` listener for `type`; returns how many ran.
     *  `fireWindow('pagehide')` is how a test closes the tab. */
    fireWindow: (type, ev) => fireOn(winListeners, type, ev),
    /** Run every `document` listener for `type`; returns how many ran.
     *  `visibilitychange` reads `document.visibilityState`, which is settable on `ctx.document` —
     *  set it BEFORE firing, as a browser does. */
    fireDocument: (type, ev) => fireOn(docListeners, type, ev),
    /** Set `document.visibilityState` ('visible' | 'hidden'). Sugar for the line above. */
    setVisibility: (state) => { document.visibilityState = state; },
    /** Run every timer queued so far (and any they queue), up to `rounds` passes. */
    // TWO BLIND SPOTS, measured rather than suspected — read them
    // before writing a test that claims to pin a timeout.
    //   - DELAY is ignored: this fires every pending timer whatever its `ms`, so nothing here can
    //     tell an 8s bound from a 0s one, and calling it before a short operation completes
    //     MANUFACTURES a timeout. Closed only for callers who use the OTHER
    //     driver: `advance(ms)` above models a virtual clock and fires just what is due. This
    //     blind spot is still real for `runTimers` itself, which is kept unchanged because 38 call
    //     sites depend on its fire-everything semantics. Use `advance` for a TIMEOUT or a DEBOUNCE;
    //     `runTimers` for "flush whatever is pending".
    //   - CANCELLATION is invisible TO runTimers, and is observable through `advance`: a
    //     cancelled timer never fires there, pinned by "a cancelled timer never fires".
    //     The paragraph below still holds for everything driven by runTimers.
    //     Making `clearTimeout` a no-op survives the whole suite. Every
    //     clearTimeout in app.js — cancelPendingPushes, schedulePush's debounce coalescing — is
    //     unobservable, so a test asserting "the timer was cancelled" is decoration by construction.
    //     The exit tests that look like they cover it actually pin `_leaving` and the seals.
    /** Move the virtual clock forward by `ms`, firing ONLY the timers that come due inside that
     *  window, in due order. Returns how many fired.
     *
     *  This is the delay-aware counterpart to `runTimers`, which fires everything regardless of `ms`
     *  and therefore cannot tell an 8s bound from a 0s one. Use `advance` for anything that asserts
     *  a TIMEOUT or a DEBOUNCE; `runTimers` remains correct for "flush whatever is pending".
     *
     *  Fires one timer at a time and re-scans, so a callback that arms another (schedulePush
     *  debouncing itself) is picked up when its own due time falls inside the same window — and is
     *  NOT picked up when it falls outside it.
     *
     *  LIMIT: this moves the timer queue's clock, not `Date`. Code that compares `Date.now()`
     *  against a stored timestamp does not advance with it. */
    advance: (ms = 0) => {
      const target = clock + Math.max(0, Number(ms) || 0);
      let fired = 0;
      for (let guard = 0; ; guard++) {
        if (guard > 10000) throw new Error('advance(): 10000 timers in one window — a timer is re-arming itself');
        let next = -1;
        for (let i = 0; i < timers.length; i++) {
          const t = timers[i];
          if (t.cancelled || t.ran || t.at > target) continue;
          // Earliest due wins; insertion order breaks a tie, which is what a browser does.
          if (next === -1 || t.at < timers[next].at) next = i;
        }
        if (next === -1) break;
        const t = timers[next];
        t.ran = true;
        clock = Math.max(clock, t.at);   // the clock reads the due time WHILE the callback runs
        fired++;
        try { t.fn(); } catch { /* surfaced by assertions */ }
      }
      clock = target;
      return fired;
    },
    runTimers: (rounds = 3) => {
      for (let i = 0; i < rounds; i++) {
        const batch = timers.filter(t => !t.cancelled && !t.ran);
        if (!batch.length) return;
        batch.forEach(t => { t.ran = true; try { t.fn(); } catch { /* surfaced by assertions */ } });
      }
    },
  };
}

/** A signed-in browser with real content in EVERY key an exit is supposed to clear.
 *
 * Seeding all of them matters: `assert.equal(get(k), null)` passes trivially for a key that was
 * never in the store, so a fixture that omits one turns its own assertion into decoration.
 * If you add an SK key, seed it. */
export const SIGNED_IN = {
  focus_device_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  focus_channels: JSON.stringify([{ id: 'UC_prev', name: "Previous user's channel" }]),
  focus_done: JSON.stringify(['vid1', 'vid2']),
  focus_archive: JSON.stringify([{ id: 'a1' }]),
  focus_groups: JSON.stringify({ assignments: { t1: 'g1' }, groups: { g1: { label: "Previous user's topics" } } }),
  focus_tweet_cache: JSON.stringify({ UC_prev: { items: [{ id: 't1', text: "previous user's post text" }] } }),
  focus_last_feed_load: '1753000000000',
  focus_last_view: 'archive',
  focus_events: JSON.stringify([{ name: 'view', section: 'feed' }]),
  focus_include_shorts: 'false',
  // NOT focus_dirty — it is a control flag, not content. Seeding it globally would change what the
  // refusal tests mean (they assert the refusal does not ADD it). A dedicated test seeds it.
  focus_theme: 'dark',
  focus_was_authed: '1',
  focus_landing_seen: 'true',
  // The tour record. Device-local and cleared on exit, so an exit test that forgot it would
  // pass `get('focus_tour') === null` over a key that was never there.
  focus_tour: JSON.stringify({ at: 'done' }),
};
