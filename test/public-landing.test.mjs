// The PUBLIC landing page at `/` — index.html (TASK-091).
//
// Not to be confused with test/landing.test.mjs, which despite its name is entirely about the
// APP's sign-in wall (`view-landing` in app.js). Different page, different file, no overlap.
//
// Why these are source-text assertions rather than behaviour: TASK-091 puts a scroll-driven canvas
// animation on a page that carried zero JavaScript by design. The animation cannot be exercised
// here — there is no canvas, no scroll and no rAF in node — and building a harness for it would
// cost more than the thing it guards; the project rule for animation is verify-by-looking.
//
// But ONE failure in this change ships silently, and it is not visual. `vercel.json` sets
//   script-src 'self' '<sha256 of the app's theme script>'
// with no 'unsafe-inline'. An inline <script> on this origin is therefore BLOCKED by the browser:
// the page still renders, the headline still reads, and the stage is a dead black rectangle. No
// test that looks at markup structure would notice, and a reviewer reading the diff sees ordinary
// working code. So the external-file requirement is pinned here, at the only layer that can see it.
//
// Precedent for the shape: landing.test.mjs:479 asserts on style.css source text for the same
// reason — the harness cannot observe it and it would regress invisibly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

// Commented-out markup is not markup. Both checks below run on the stripped text, so deleting the
// script tag by wrapping it in <!-- --> reads as deletion rather than as "still there" (round-1 H5).
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

// An opening <script> tag, quote-aware: a `>` inside an attribute value does not end the tag.
// The earlier `[^>]*>` ended at the first `>` it saw, which is a bypass on its own.
const SCRIPT_OPEN = /<script\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;

/**
 * The NAMES of the attributes in an opening tag.
 *
 * The point is what it skips. The previous guard asked whether the text `src=` appeared anywhere in
 * the tag, so `data-src` matched (`\b` fires between `-` and `s`) and so did a `src=` sitting inside
 * some other attribute's quoted value. Consuming each `name="value"` pair whole steps over the
 * value, so only real attribute names are ever returned.
 */
function attrNames(openTag) {
  const inner = openTag.replace(/^<\s*[a-z0-9-]+/i, '').replace(/\/?>$/, '');
  // The name part is not optional, so every match consumes at least one character and this cannot
  // spin on a zero-width match. Keep it that way if the pattern is ever edited.
  const re = /([a-z_:][-a-z0-9_:.]*)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]*))?/gi;
  const names = [];
  for (let m; (m = re.exec(inner)); ) names.push(m[1].toLowerCase());
  return names;
}

/** Opening <script> tags that carry no src attribute, i.e. inline scripts the CSP blocks. */
function inlineScripts(html) {
  return (stripComments(html).match(SCRIPT_OPEN) ?? [])
    .filter((tag) => !attrNames(tag).includes('src'));
}

/** Does this HTML load the animation from /landing.js? */
function loadsLandingJs(html) {
  return /<script[^>]*\bsrc\s*=\s*["']\/landing\.js["']/i.test(stripComments(html));
}

test('index.html carries no inline <script> — the CSP would block it', () => {
  const html = read('index.html');
  const inline = inlineScripts(html);

  assert.deepEqual(
    inline, [],
    `index.html has ${inline.length} inline <script> tag(s). vercel.json's script-src allows only ` +
    `'self' plus one hashed snippet (which lives in app/index.html), so these are blocked at ` +
    `runtime: the page renders and the animation silently does nothing.\n  ${inline.join('\n  ')}`,
  );
});

test('index.html loads the animation from an external /landing.js', () => {
  const html = read('index.html');

  assert.ok(
    loadsLandingJs(html),
    'index.html does not reference /landing.js. The dot-story animation (TASK-091) must be served ' +
    'as a same-origin file, which is what script-src \'self\' permits.',
  );
});

// ── The guard's own bypasses (round-1 H5) ────────────────────────────────────────────
//
// Everything above asserts against the real index.html, which is the file we want to be right —
// but it cannot show that the GUARD is right, and a tripwire nobody has tried to walk past is a
// decoration. A reviewer walked past this one three ways. So these two tests attack the detector
// itself with fixtures, in both directions: things it must catch, and things it must not.

test('the inline-script guard cannot be walked past by a lookalike attribute', () => {
  // `\b` fires between `data-` and `src`, and the lookahead scanned the whole opening tag rather
  // than its attribute NAMES, so a src- substring anywhere — including inside another attribute's
  // quoted value — read as "this tag has a src". Every one of these is inline, and every one is
  // blocked by script-src 'self' at runtime while the page renders around it.
  const mustCatch = [
    ['<script data-src="/landing.js">alert(1)</script>', 'a data-src attribute'],
    ['<script title="see src=/landing.js">alert(1)</script>', 'src= inside a quoted value'],
    ['<script title="a>b">alert(1)</script>', 'a > inside a quoted value'],
    ['<SCRIPT>alert(1)</SCRIPT>', 'uppercase'],
    ['<script >alert(1)</script>', 'a space before the close'],
    ['<script\ttype="module">alert(1)</script>', 'a tab separator'],
    ['<script\n  type="module">alert(1)</script>', 'a newline in the tag'],
  ];
  for (const [html, why] of mustCatch) {
    assert.equal(inlineScripts(html).length, 1,
      `the guard did not see an inline <script> with ${why} — it is CSP-blocked in production and ` +
      `this test file exists to make exactly that visible:\n  ${html}`);
  }

  // And the other direction, so "catch everything" is not a passing strategy. A false positive here
  // is not harmless: it fails the build on correct markup, and the fix for that is to loosen the
  // guard — which is how a tripwire quietly becomes decoration.
  const mustPass = [
    ['<script src="/landing.js"></script>', 'the ordinary form'],
    ['<script defer src="/landing.js"></script>', 'src after another attribute'],
    ['<script src = "/landing.js"></script>', 'spaces around the ='],
    ["<script src='/landing.js' type='text/javascript'></script>", 'single quotes'],
    // Needs the quote-aware tag matcher: `[^>]*>` stops at the `>` inside the title value, so the
    // tag it hands on is the truncated `<script title="a>` — which has no src and reads as inline.
    ['<script title="a>b" src="/landing.js"></script>', 'a > inside an earlier attribute value'],
    // Needs the comment strip: commented-out markup is inert, so flagging it is a false alarm.
    ['<!-- <script>alert(1)</script> -->', 'an inline script that is commented out'],
  ];
  for (const [html, why] of mustPass) {
    assert.equal(inlineScripts(html).length, 0,
      `the guard flagged a legitimate external script as inline (${why}):\n  ${html}`);
  }
});

test('commenting the script tag out fails the guard instead of passing it silently', () => {
  // The whole failure this file exists to prevent, fully realised: comment out one line and the
  // animation is gone from the page while every assertion above stays green — test 1 sees no inline
  // script, test 2's regex matches happily INSIDE the comment, test 3 only stats the file on disk.
  const html = read('index.html');
  const commentedOut = html.replace(
    /<script[^>]*\bsrc\s*=\s*["']\/landing\.js["'][^>]*>\s*<\/script>/i,
    (tag) => `<!-- ${tag} -->`,
  );
  assert.notEqual(commentedOut, html, 'guard: the fixture did not actually comment anything out');

  assert.equal(loadsLandingJs(commentedOut), false,
    'a commented-out <script> still counts as loading /landing.js, so the page can lose its ' +
    'animation entirely with this suite green');
});

test('landing.js exists at the path index.html asks for', () => {
  // The reference above is satisfied by a typo'd path just as happily as a real one. Vercel and
  // dev-server.mjs both route static files by path, so a missing file is a 404 and a dead stage.
  assert.ok(
    existsSync(new URL('landing.js', ROOT)),
    'index.html references /landing.js but the file does not exist — the stage would 404 and the ' +
    'landing page would render a black rectangle.',
  );
});

// ── Script ↔ markup coupling (round-1 H4) ────────────────────────────────────────────
//
// landing.js reaches into index.html by id and by class. Neither file imports the other, so every
// one of those references is an unchecked assumption, and a rename in either direction is silent:
// the script bails or throws, the page renders its fallback, and nothing in the suite moves. The
// harness now reads index.html so it can no longer invent a missing element — these three cover
// what a fake DOM still cannot see.

test('every element landing.js reaches for exists in index.html', () => {
  const js = read('landing.js');
  const html = read('index.html');
  const ids = [...js.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

  assert.ok(ids.length >= 10, `guard: only found ${ids.length} getElementById calls, so this test ` +
    'is not looking at the script it thinks it is');

  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [],
    `landing.js asks for ${missing.length} element(s) index.html does not define: ${missing.join(', ')}. ` +
    'A missing id is not a soft failure — the script either returns early and the stage is dead, or ' +
    'throws on the first property access and every beat after it is gone.');
});

test('the six demo posts the beat timings were tuned for are still there', () => {
  // NPOST is read from the DOM at runtime and drives the per-dot stagger, the clear schedule and
  // the counter, so adding or removing a post silently re-times every beat after the pour.
  const posts = read('index.html').match(/<article[^>]*\bclass="post\b/g) ?? [];

  assert.equal(posts.length, 6,
    `index.html now has ${posts.length} demo posts rather than 6. That is not just a visual change: ` +
    'the pour stagger, the clear schedule and the counter are all functions of this count.');
});

test('the tall scroll track is gated on the class landing.js hands over with', () => {
  // The two halves of one mechanism, in two files. index.html keeps the stage at its short height
  // until `js-stage` appears; landing.js adds it. Drop either and the stage is 100vh, so
  // progress()'s span is zero, p is pinned at 0 forever and the story never starts — while the
  // page still renders a headline and looks, to a reviewer reading the diff, entirely fine.
  const html = read('index.html');
  const js = read('landing.js');

  assert.match(html, /\.js-stage\s+\.stage\s*\{[^}]*height:\s*[\d.]+vh/,
    'index.html no longer sizes the scroll track with a `.js-stage .stage { height: …vh }` rule — ' +
    'the harness derives the track length from it, and the story needs a track longer than the ' +
    'viewport to have anywhere to happen.');

  assert.match(js, /documentElement\.classList\.add\(\s*["']js-stage["']\s*\)/,
    'landing.js no longer adds the `js-stage` class, so index.html keeps the stage at its ' +
    'no-JavaScript height: the scroll span is zero, progress is pinned at 0, and the animation is ' +
    'dead on a page that still looks correct at rest.');
});

test('the unlit headline clauses stay legible (acceptance criterion 2)', () => {
  // AC 2 says the headline is legible at zero scroll, before any interaction. Two of its three
  // clauses render unlit at that moment, and the first version of this page set them to #565d68 —
  // 2.65:1 on the background they actually sit on, under the 3:1 floor for large text. It looked
  // deliberate, and a review had to measure it to find otherwise, so it is measured here instead.
  //
  // Contrast is computed, not asserted as a hex, so the test survives a palette change and fails
  // only on the thing that matters.
  const html = read('index.html');
  const hex = (re, what) => {
    const m = html.match(re);
    assert.ok(m, `guard: could not find ${what} in index.html, so this test proves nothing`);
    return m[1];
  };
  const unlit = hex(/\.js-stage\s+\.copy\s+h1\s+\.w\s*\{\s*color:\s*(#[0-9a-f]{6})/i, 'the unlit clause colour');
  // The copy sits over the radial gradient's inner stop, which is the lighter of the two — so it is
  // the worse case for contrast and the right one to measure against.
  const bg = hex(/--void-2:\s*(#[0-9a-f]{6})/i, 'the --void-2 background');

  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const r = ratio(unlit, bg);

  assert.ok(r >= 3,
    `the unlit headline clauses are ${r.toFixed(2)}:1 against ${bg} — under the 3:1 WCAG floor for ` +
    `large text, on copy acceptance criterion 2 requires to be legible before any interaction. ` +
    `The beat needs the lit/unlit DELTA, not darkness, so raise ${unlit} rather than dimming the lit state.`);
});

test('the mobile step-back fades the subhead, not the headline (BUG-085)', () => {
  // Reported from a handset: "they all 9 words start dimming ... instead of the last 3 words also
  // lightening up." The mobile step-back sat on `.copy`, which contains the headline, the subhead
  // AND the CTA. It fades to 26% over p 0.38-0.54 and holds until 0.89 — but the third clause does
  // not light until p = FLY[0] + 0.02 = 0.60, i.e. INSIDE the fade. So its moment was never seen:
  // nine words dimmed together and returned fully lit at the end.
  //
  // That matters because TASK-091's brief makes the three clauses the three beats of the page. On
  // mobile the third beat did not exist.
  //
  // A source-text test because neither half is observable from the harness: it records the
  // `--copyfade` VALUE the writer emits, and cannot see which element the cascade applies it to.
  // The value is unchanged by this fix — only its owner moved — so every existing assertion about
  // it stays true and none of them could have caught this.
  // Comments stripped FIRST, and that is not tidiness. The initial version of this test anchored
  // the selector on a preceding `{` or `}` — then a comment was written directly above the `.copy`
  // rule, so the character before it became `/` from `*/`, the pattern matched only the
  // media-query `.copy`, and the top-level one was never examined. The mutation that restores the
  // bug exactly went GREEN while two lesser mutations went red, which is precisely how a battery
  // lulls you. A comment must not be able to hide a rule from its own guard.
  const css = read('index.html').replace(/\/\*[\s\S]*?\*\//g, '');

  // Rules whose selector is exactly `.copy` — not `.copy h1`, not `.copy.day`. matchAll rather
  // than match, so a declaration moved into the media query cannot slip past either.
  const copyRules = [...css.matchAll(/(?:^|[{}])\s*\.copy\s*\{([^}]*)\}/g)];
  assert.ok(copyRules.length >= 2,
    `guard: found ${copyRules.length} \`.copy { … }\` rule(s); the page has two (base + mobile). ` +
    'Finding fewer means the pattern is missing one, and the one it misses is the one that matters');

  const offending = copyRules.map((m) => m[1]).filter((body) => /--copyfade/.test(body));
  assert.deepEqual(offending, [],
    '`.copy` carries the mobile step-back. It wraps the headline, so the fade swallows the third ' +
    'clause lighting up at p=0.60 and all nine words dim together (BUG-085). It also wraps ' +
    "#stage-cta, which is exactly how review round-1 H1 rendered the page's only CTA at 26% " +
    `opacity on every phone.\n  .copy {${offending.join('}\n  .copy {')}}`);

  assert.match(css, /\.sub\s*\{[^}]*opacity:\s*var\(--copyfade/,
    'nothing carries the step-back any more. Taking it off `.copy` has to MOVE it to `.sub`, not ' +
    'delete it — the subhead must still step back mid-pour so the phone owns a narrow view. ' +
    'Deleting it would pass the assertion above while losing what the fade is for.');
});

test("the CSP still has no 'unsafe-inline' for scripts", () => {
  // The pre-existing condition this whole design rests on, pinned deliberately.
  //
  // CLAUDE.md's lesson from TASK-084 round 4: mutate the pre-existing condition your change made
  // load-bearing, not only the code you added. If someone later adds 'unsafe-inline' to script-src,
  // every test above still passes, the external file keeps working, and the *reason* it had to be
  // external evaporates with nothing recording that it did. This is the tripwire for that — and
  // relaxing script-src on a page that now runs JavaScript deserves to be a conversation, not a
  // side effect.
  const csp = JSON.parse(read('vercel.json'))
    .headers.flatMap((h) => h.headers)
    .find((h) => h.key === 'Content-Security-Policy');

  assert.ok(csp, 'guard: no Content-Security-Policy header found in vercel.json at all');

  const scriptSrc = csp.value.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
  assert.ok(scriptSrc, 'guard: the CSP has no script-src directive, so this test proves nothing');

  assert.ok(
    !scriptSrc.includes("'unsafe-inline'"),
    `script-src now allows 'unsafe-inline', which removes the constraint that TASK-091's external ` +
    `/landing.js exists to satisfy. If that relaxation is intended, decide it deliberately and ` +
    `update this test and the task — do not let it happen silently.\n  ${scriptSrc}`,
  );
});
