// Docs-drift guard (TASK-082).
//
// Why this exists: the 2026-07-17 audit found that docs describing *the system*
// (README, architecture.md) had drifted five releases behind, while docs describing
// *the work* (registry, CHANGELOG) stayed current — because updating the latter is
// part of shipping and the former relied on someone remembering. CLAUDE.md's DoD
// already said "docs updated"; the rule existed and was skipped anyway.
//
// So: mechanise the mechanically-checkable part.
//
//   forward  — a file/module named in the docs must exist       (catches ghosts)
//   reverse  — a routed endpoint / DB table must be documented  (catches omissions)
//
// What this CANNOT catch: prose that is merely out of date ("recheck if analytics is
// added" after analytics shipped), or a diagram whose parts all exist but describe the
// wrong shape. Those still need a human. This guards the class that is checkable, which
// is the class that produced 2 of the audit's findings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Docs that describe the system. Recaps are excluded by design: they are point-in-time
// records and are *supposed* to name things that no longer exist.
// The public copy of this repo (CHR-080) carries no CLAUDE.md and no tasks/, so the checks that read
// them cannot run there. The skip keys on the files' ABSENCE, never on a flag someone could set, and
// test/export-public.test.mjs (private, never exported) runs this file and fails if any of these
// checks is skipped or missing HERE.
const HAS_RECORDS = existsSync(join(ROOT, 'CLAUDE.md')) && existsSync(join(ROOT, 'tasks'));
const NO_RECORDS = HAS_RECORDS ? false : 'the public copy has no CLAUDE.md or tasks/ (CHR-080)';
// docs/ stays private too, for the same reason and under the same guard.
const HAS_ARCH = existsSync(join(ROOT, 'docs/architecture.md'));
const NO_ARCH = HAS_ARCH ? false : 'the public copy has no docs/ (CHR-080)';
const SYSTEM_DOCS = ['README.md', ...(HAS_ARCH ? ['docs/architecture.md'] : []), ...(HAS_RECORDS ? ['CLAUDE.md'] : [])];

// Tokens that look like repo files but aren't (gitignored, external, or illustrative).
const NOT_REPO_FILES = new Set([
  '.env', '.env.local', 'package-lock.json', 'node_modules',
  '[param].js',   // CLAUDE.md's name for the dynamic-route *pattern*, not a file
]);

// Longest extension first: an ordered alternation would match `.js` inside `.json`.
// `md` is here so task/recap pointers rot loudly (CHR-018) — the pitfalls section cites
// its evidence rather than restating it, and an uncheckable citation is not evidence.
const FILE_TOKEN = /[A-Za-z0-9_./[\]-]+\.(?:json|html|mjs|css|js|md)\b/g;

// Every file in the repo, so a doc can name `feed.js` and mean `api/feed.js` — the
// architecture doc legitimately drops the prefix inside a section already scoped to api/.
function repoFiles(dir = '.', acc = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = dir === '.' ? entry : join(dir, entry);
    if (statSync(join(ROOT, full)).isDirectory()) repoFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}
const FILES = repoFiles();
// A leading slash means a URL route, not a path — and since both Vercel and dev-server
// route by file (TASK-069), `/admin.html` resolves to the file `admin.html`.
// Three prefixes are punctuation, not part of the name:
//   '['   markdown link syntax — `[CLAUDE.md](…)` tokenizes as `[CLAUDE.md`
//   './'  a relative link target — `](./CLAUDE.md)` tokenizes as `./CLAUDE.md`
//   '/'   a URL route, not a path (both Vercel and dev-server route by file, TASK-069)
// `[param].js` never reaches here — NOT_REPO_FILES filters it first, on the raw token.
const isRealFile = (token) => {
  const p = token.replace(/^\[/, '').replace(/^\.?\//, '');
  return FILES.some((f) => f === p || f.endsWith('/' + p));
};

// --- forward: everything the docs name must exist -------------------------------

// Extracted so the tokenizer is testable on its own (CHR-018). Reading the live docs
// can only ever say "today's files happen to resolve"; it cannot say whether a rotted
// pointer WOULD be caught, which is the property the pitfalls section now depends on.
function ghostsIn(text) {
  return [...new Set(text.match(FILE_TOKEN) ?? [])]
    .filter((t) => !NOT_REPO_FILES.has(t))
    .filter((t) => !t.startsWith('http'))
    .filter((t) => !isRealFile(t));
}

for (const doc of SYSTEM_DOCS) {
  test(`${doc}: every file it names exists`, () => {
    const ghosts = ghostsIn(read(doc));

    assert.deepEqual(
      ghosts, [],
      `${doc} names ${ghosts.length} file(s) that do not exist. Either the doc is stale ` +
      `or the file moved:\n  ${ghosts.join('\n  ')}`,
    );
  });
}

// --- forward, continued: task and recap pointers must be checkable ---------------

// CHR-018 rewrites Known Pitfalls so each rule carries its evidence as a `tasks/BUG-xxx.md`
// pointer instead of an inline retelling. That trade is only safe if a rotted pointer fails
// here — otherwise 3,192 words of self-contained story become 1,100 words of maybe-dangling
// references, which is strictly worse than what it replaced.

test('a pointer to a nonexistent .md file is a ghost', () => {
  assert.deepEqual(ghostsIn('the long story is in tasks/BUG-999.md'), ['tasks/BUG-999.md']);
});

test('a pointer to a real .md file is not a ghost', () => {
  assert.deepEqual(ghostsIn('the long story is in README.md'), []);
});

// The two link punctuation forms get a test each, so a failure names the guard that
// broke. One fixture covering both would still go red if either strip were removed,
// but it could not say which — and a test that cannot name its guard is the shape
// BUG-069 was caught by. Neither can be RED before the fix (no .md token is produced
// at all yet); both are pinned by the mutation battery instead.
test('a markdown link bracket is not a ghost', () => {
  assert.deepEqual(ghostsIn('See [README.md](README.md) for conventions'), []);
});

test('a relative ./ link target is not a ghost', () => {
  assert.deepEqual(ghostsIn('See [the readme](./README.md) for the overview'), []);
});

// Bracketed ids are the form the pitfalls section actually cites in ([BUG-059], not
// tasks/BUG-059.md), so the .md guard above cannot see them. This is the check that
// makes "cite the task instead of retelling the story" a safe trade.
function unknownTaskIds(text) {
  return [...new Set([...text.matchAll(/\[((?:BUG|TASK|CHR)-\d+[a-z]?)\]/g)].map((m) => m[1]))]
    .filter((id) => !existsSync(join(ROOT, 'tasks', `${id}.md`)));
}

test('CLAUDE.md: every bracketed task id has a task file', { skip: NO_RECORDS }, () => {
  const unknown = unknownTaskIds(read('CLAUDE.md'));
  assert.deepEqual(
    unknown, [],
    `CLAUDE.md cites ${unknown.length} task id(s) with no file in tasks/. A pitfall whose ` +
    `evidence cannot be opened is not evidence:\n  ${unknown.join('\n  ')}`,
  );
});

// Neither fixture test can be RED before the fix — they pin a check that did not exist,
// rather than a defect that did. The mutation battery is what proves they can fail.
test('a bracketed id with no task file is flagged', () => {
  assert.deepEqual(unknownTaskIds('the long story is in [BUG-999]'), ['BUG-999']);
});

test('a bracketed id with a task file is not flagged', { skip: NO_RECORDS }, () => {
  assert.deepEqual(unknownTaskIds('the long story is in [CHR-018]'), []);
});

// --- reverse: every routed endpoint must be documented ---------------------------

// Vercel routes every api/**/*.js except underscore-prefixed helpers (which is also
// what the 12-function Hobby cap counts — see CLAUDE.md "Known constraints").
function routedEndpoints(dir = 'api', acc = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const full = join(dir, entry);
    if (statSync(join(ROOT, full)).isDirectory()) routedEndpoints(full, acc);
    else if (entry.endsWith('.js') && !entry.startsWith('_')) acc.push(full);
  }
  return acc;
}

// The name a human would actually write in prose: `api/auth/google/[action].js` is
// documented as "auth/google", `api/feed.js` as "feed.js" or "/api/feed".
function documentedAs(endpoint) {
  return relative('api', endpoint).replace(/\.js$/, '').replace(/\/?\[\w+\]$/, '');
}

test('architecture.md documents every routed endpoint', { skip: NO_ARCH }, () => {
  const arch = read('docs/architecture.md');
  const undocumented = routedEndpoints()
    .map(documentedAs)
    .filter((name) => !arch.includes(name));

  assert.deepEqual(
    undocumented, [],
    `docs/architecture.md never mentions ${undocumented.length} routed endpoint(s). ` +
    `A shipped endpoint that no doc describes is exactly the drift this guards:\n  ` +
    undocumented.join('\n  '),
  );
});

test('the 12-function Vercel cap is not silently exceeded', () => {
  // CLAUDE.md: Hobby caps a deployment at 12 serverless functions and we sit at 12/12.
  // A 13th fails the deploy at "Deploying outputs" while the build still succeeds — so
  // it reads as a code error when it isn't. Fail here instead, where it's legible.
  const n = routedEndpoints().length;
  assert.ok(n <= 12, `${n} routed functions — Vercel Hobby caps a deployment at 12. ` +
    `Consolidate into a dynamic [param].js route, or move to Pro.`);
});

// --- reverse: every DB table must be documented ----------------------------------

test('architecture.md documents every database table', { skip: NO_ARCH }, () => {
  const arch = read('docs/architecture.md');
  const tables = [...read('scripts/init-db.mjs')
    .matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);

  assert.ok(tables.length > 0, 'no tables parsed from init-db.mjs — the regex has drifted');

  const undocumented = tables.filter((t) => !arch.includes(t));
  assert.deepEqual(
    undocumented, [],
    `docs/architecture.md's Schema section is missing ${undocumented.length} table(s) ` +
    `that scripts/init-db.mjs creates:\n  ${undocumented.join('\n  ')}`,
  );
});


// ── Future-dated claims in code and batteries (TASK-099, 2026-08-27) ──────────
//
// CLAUDE.md already carried this rule — "date it to a day that has happened" — and it did not stop
// six comments being stamped with the NEXT day's date across app.js, style.css, a test file and two
// mutation specs, all in one session. A rule that is written down and broken anyway is CLAUDE.md's
// own "mechanise, then retire" trigger, so here is the mechanism.
//
// ONE LIMITATION, and it applies to this very comment: the check cannot tell a date that is QUOTED
// from one that is ASSERTED. So a comment in the scanned set must DESCRIBE such a mistake rather
// than reproduce the offending date — as this one now does. That is a real cost of the mechanism and
// it is cheaper than the class of error it closes.
//
// SCOPE, stated so nobody over-credits it. This checks CODE and MUTATION SPECS only, where a date is
// always a claim about something that already happened ("measured 2026-08-27", "corrected in place").
// It deliberately does NOT check tasks/, recaps/, CHANGELOG.md or README.md, because those carry
// legitimate FORWARD references — a registered domain's expiry, a date on which stale Inbox tasks
// age out — and flagging those would be a false positive that teaches people to ignore the test.
// A future-dated claim in a task file is still wrong; it is just not mechanically separable from a
// deadline, so it stays a human check.
//
// The controls below compare against a FIXED past `today` rather than a real future date: this file
// is inside the scanned set, so a literal tomorrow in a fixture would make the check flag itself.
// Measured — the first version did exactly that, on all three dates it mentioned.
const DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;

/** Every date in `text` that is later than `today` (both ISO yyyy-mm-dd; string compare is safe). */
export function futureDatesIn(text, today) {
  return [...new Set([...String(text).matchAll(DATE_RE)].map((m) => m[1]))].filter((d) => d > today);
}

const SOURCE_GLOBS = ['app.js', 'style.css', 'dev-server.mjs', 'landing.js'];
const SOURCE_DIRS = ['lib', 'test', 'mutations', 'scripts', 'api', 'test-helpers'];

function sourceFiles() {
  const out = SOURCE_GLOBS.filter((f) => existsSync(join(ROOT, f)));
  const walk = (d) => {
    for (const e of readdirSync(join(ROOT, d))) {
      const rel = join(d, e);
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(m?js|css)$/.test(e)) out.push(rel);
    }
  };
  SOURCE_DIRS.filter((d) => existsSync(join(ROOT, d))).forEach(walk);
  return out;
}

test('no source file or mutation spec carries a future-dated claim', () => {
  const today = new Date().toISOString().slice(0, 10);
  const offenders = [];
  for (const f of sourceFiles()) {
    const bad = futureDatesIn(read(f), today);
    if (bad.length) offenders.push(`${f}: ${bad.join(', ')}`);
  }
  assert.deepEqual(offenders, [],
    'a date later than today in code or a battery is a claim about a day that has not happened — '
    + `today is ${today}. Fix the date; do not widen this test.`);
});

// The two controls. Without them this test is indistinguishable from one that cannot fail.
test('the future-date detector flags a date after today', () => {
  assert.deepEqual(futureDatesIn('measured 2024-01-02, as always', '2024-01-01'), ['2024-01-02']);
});

test('the future-date detector passes today and the past', () => {
  assert.deepEqual(futureDatesIn('landed 2024-01-01 after 2023-06-30', '2024-01-01'), []);
});

// ── The other half of the date guard: RETROSPECTIVE markers in tasks/ and recaps/ ───────────────
//
// The check above deliberately skips tasks/, recaps/, CHANGELOG.md and README.md, because those
// carry legitimate FORWARD references — a domain expiry, a go-stale date — and a check that flags
// those teaches people to ignore it. That exemption was correct and it left a real gap, which then
// fired: an "Asli requirement" was written into tasks/BUG-111.md attributed to the NEXT day —
// the date is not reproduced here, because this file is scanned by the check above.
//
// What makes a subset mechanically separable is not the FILE but the PHRASE. A forecast is written
// "expires <some date next year>", "goes stale by …". A retrospective marker — "Amendment — …",
// "Closed …",
// "Measured …", "(Asli, …)", a `logged:` header — describes something that ALREADY HAPPENED and
// therefore cannot be in the future, whatever file it sits in. This checks only that phrase class.
//
// Narrow on purpose. The date must follow the marker directly, separated by nothing but a space, a
// dash or "on"/"at" — so "measured the gap, and the trial expires 2024-06-01" is not a match. A
// missed offender is the intended failure direction here; a false positive is not.
//
// NOT included: `when:` (a schedule, so legitimately future) and any bare date in prose.
const RETRO_MARKER_RE = new RegExp(
  String.raw`\b(amendment|amended|re-measured|remeasured|measured|live-verified|verified|confirmed`
  + String.raw`|closed|killed|shipped|decided|reviewed|logged|corrected|scoping pass|scoped`
  + String.raw`)\b[ \t]*(?:on|at)?[ \t]*[—–\-,:]?[ \t]*\b(20\d{2}-\d{2}-\d{2})\b`,
  'gi',
);
const RETRO_ATTRIB_RE = /\((?:[A-Z][a-z]+)\s*,\s*(20\d{2}-\d{2}-\d{2})\s*\)/g;
const RETRO_HEADER_RE = /^(?:logged|completed):[ \t]*(20\d{2}-\d{2}-\d{2})[ \t]*$/gim;

/**
 * Dates later than `today` that sit in a RETROSPECTIVE marker — a claim about something that has
 * already happened. Forecasts ("expires <a date next year>") are not matched by construction.
 */
export function retroFutureDatesIn(text, today) {
  const found = new Set();
  for (const re of [RETRO_MARKER_RE, RETRO_ATTRIB_RE, RETRO_HEADER_RE]) {
    re.lastIndex = 0;
    for (const m of String(text).matchAll(re)) {
      const date = m[m.length - 1];
      if (date > today) found.add(date);
    }
  }
  return [...found].sort();
}

const RECORD_DIRS = ['tasks', 'recaps'];

function recordFiles() {
  const out = [];
  for (const d of RECORD_DIRS.filter((x) => existsSync(join(ROOT, x)))) {
    for (const e of readdirSync(join(ROOT, d))) if (e.endsWith('.md')) out.push(join(d, e));
  }
  return out;
}

test('no task or recap carries a future-dated retrospective marker', () => {
  const today = new Date().toISOString().slice(0, 10);
  const offenders = [];
  for (const f of recordFiles()) {
    const bad = retroFutureDatesIn(read(f), today);
    if (bad.length) offenders.push(`${f}: ${bad.join(', ')}`);
  }
  assert.deepEqual(offenders, [],
    'a retrospective marker ("Amendment —", "Closed", "Measured", "(Asli, …)", "logged:") dated '
    + `later than today is a claim about a day that has not happened — today is ${today}. Fix the `
    + 'date. If the date is a genuine FORECAST, rephrase it so it does not read as a record.');
});

// The controls. Fixed past dates, because this file is inside the OTHER check's scanned set.
test('the retrospective-marker detector flags a future marker in each of its three forms', () => {
  assert.deepEqual(retroFutureDatesIn('Amendment — 2024-01-02, agreed', '2024-01-01'), ['2024-01-02']);
  assert.deepEqual(retroFutureDatesIn('the call (Asli, 2024-01-03)', '2024-01-01'), ['2024-01-03']);
  assert.deepEqual(retroFutureDatesIn('logged: 2024-01-04', '2024-01-01'), ['2024-01-04']);
  assert.deepEqual(retroFutureDatesIn('Measured on 2024-01-05 in prod', '2024-01-01'), ['2024-01-05']);
});

test('the retrospective-marker detector leaves forecasts and past markers alone', () => {
  // The whole reason the broad check skips these directories: these must NOT be flagged.
  assert.deepEqual(retroFutureDatesIn('the domain expires 2024-06-01', '2024-01-01'), []);
  assert.deepEqual(retroFutureDatesIn('goes stale by 2024-06-01 unless renewed', '2024-01-01'), []);
  assert.deepEqual(retroFutureDatesIn('when: 2024-06-01', '2024-01-01'), []);
  assert.deepEqual(retroFutureDatesIn('measured the gap; the trial expires 2024-06-01', '2024-01-01'), []);
  assert.deepEqual(retroFutureDatesIn('Closed 2023-12-31', '2024-01-01'), []);
  assert.deepEqual(retroFutureDatesIn('Amendment — 2024-01-01 today', '2024-01-01'), []);
});

// ── [TASK-101] / [BUG-095]: the reduced-motion tripwire ──────────────────────────────────────────
//
// A CSS assertion, which is unusual here and deliberate. [BUG-095] was ONE LINE —
// `@media (prefers-reduced-motion: reduce) { .g-spinner { animation: none; } }` — written by someone
// doing the obviously-right thing for an accessibility rule, and it left a ring that looks exactly
// like a spinner sitting perfectly still on the slowest screen in the app. No unit test in this repo
// can see CSS, so 874 tests stayed green over it and only a handset caught it.
//
// This does NOT test that the pulse looks calm, or that it is visible against the appbar — only a
// handset does that (task Verification step 6). It makes the one-line regression uncommittable,
// which is what the pre-commit hook then enforces.

/** The declarations `selector` receives inside every `@media (prefers-reduced-motion: reduce)` block.
 *  Brace-matched rather than regexed: the media block nests, and a regex that ignores that reads the
 *  first `}` as the end of the block and silently returns nothing — which would make this whole
 *  tripwire pass by finding no rule at all. */
function reducedMotionDecls(css, selector) {
  const out = [];
  const open = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  let m;
  while ((m = open.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const body = css.slice(start, i - 1);
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let r;
    while ((r = rule.exec(body))) {
      if (r[1].split(',').map(x => x.trim()).includes(selector)) out.push(r[2]);
    }
  }
  return out.join('\n');
}

test('[BUG-095] the busy indicator keeps a LIVE animation under reduced motion', () => {
  const decls = reducedMotionDecls(read('style.css'), '.g-busy');
  assert.notEqual(decls.trim(), '',
    'the reduced-motion block must address .g-busy AT ALL — falling through to the spinning default '
    + 'is the opposite failure and just as wrong');
  assert.match(decls, /animation:\s*g-pulse/,
    'reduced motion must get a non-rotating but still LIVE indicator: the accessibility need is no '
    + 'SPINNING, not no FEEDBACK ([BUG-095])');
  assert.doesNotMatch(decls, /animation:\s*none/,
    'this is [BUG-095] verbatim — killing the only motion leaves a dead ring that reads as a hang');
});

test('[BUG-095] the tripwire flags `animation: none` — the exact line that shipped the bug', () => {
  const css = '@media (prefers-reduced-motion: reduce) {\n  .g-busy { animation: none; }\n}';
  const decls = reducedMotionDecls(css, '.g-busy');
  assert.match(decls, /animation:\s*none/, 'the detector must SEE the defect it exists to catch');
  assert.doesNotMatch(decls, /g-pulse/);
});

test('[BUG-095] the tripwire reads a nested block without stopping at the first brace', () => {
  // The parser control. A regex-only version returns '' here and every assertion above passes
  // vacuously — the instrument agreeing with you rather than measuring.
  const css = '@media (prefers-reduced-motion: reduce) {\n  .other { transition: none; }\n'
    + '  .g-busy { animation: g-pulse 1.6s ease-in-out infinite; }\n}';
  assert.match(reducedMotionDecls(css, '.g-busy'), /g-pulse/,
    'a rule after another rule inside the same media block must still be found');
  assert.equal(reducedMotionDecls(css, '.not-there').trim(), '',
    'and a selector that is genuinely absent must read as absent');
});

test('[TASK-101] the "Gathering the topics" pill cannot render', () => {
  // SCOPED TO MARKUP AND RULES, not to every mention of the string, and that is a correction rather
  // than a convenience. Written first as "the string appears nowhere in app.js either", it failed on
  // three COMMENTS that cite the pill as superseded history — which CLAUDE.md requires be rewritten
  // and kept, not deleted. The criterion's content is that no reader ever sees the sentence; the
  // copy lived in markup, so markup is where that guarantee is real. A comment cannot render.
  assert.doesNotMatch(read('app/index.html'), /Gathering the topics/,
    'the markup still tells the reader their posts are loading, under a feed that has already painted');
  assert.doesNotMatch(read('app/index.html'), /id="group-loading"/, 'the pill element is gone');
  const css = read('style.css');
  assert.doesNotMatch(css, /^\.group-loading\s*\{/m, 'the pill rule is gone');
  assert.doesNotMatch(css, /^\.g-spinner\s*\{/m, 'and its spinner rule with it');
});

// ── [TASK-101] round 2 — what an independent mutation battery walked straight past ───────────────
//
// The tripwire above asserts that the string `g-pulse` appears and the string `none` does not. An
// independent battery (2026-08-27) found that is a DECLARATION NAME, not perceivable motion, and
// defeated it with one token each:
//   • `infinite` → `1`      — pulses once, then sits still for the rest of a 15-20s classify.
//   • `@keyframes g-pulse` flattened to `opacity: 1` at every stop — visually IDENTICAL to
//     `animation: none`, i.e. [BUG-095] verbatim, through a door the parser never opens.
// CLAUDE.md: "a test can be green, correct, and measuring the wrong quantity." This was that.

/** The body of `@keyframes <name>`, brace-matched — the block nests, so a flat regex reads the first
 *  inner `}` as the end and returns a fragment that happens to look fine. */
function keyframesBody(css, name) {
  const open = new RegExp(`@keyframes\\s+${name}\\s*\\{`, 'g');
  const m = open.exec(css);
  if (!m) return '';
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(start, i - 1);
}

test('[BUG-095] the reduced-motion pulse runs forever, not once', () => {
  const decls = reducedMotionDecls(read('style.css'), '.g-busy');
  assert.match(decls, /animation:[^;]*\binfinite\b/,
    'a finite iteration count pulses and then stops, which is `animation: none` with extra steps — '
    + 'and the reader is still waiting 15-20s ([BUG-077])');
});

test('[BUG-095] the g-pulse keyframes actually vary opacity', () => {
  const body = keyframesBody(read('style.css'), 'g-pulse');
  assert.notEqual(body.trim(), '', '`@keyframes g-pulse` must exist — the animation names it');
  const opacities = new Set([...body.matchAll(/opacity:\s*([\d.]+)/g)].map(m => m[1]));
  assert.ok(opacities.size >= 2,
    `g-pulse must move between at least two opacities; found ${[...opacities].join(', ') || 'none'}. `
    + 'A keyframe set that holds one value animates nothing — the indicator is dead and the '
    + 'declaration-name assertion above cannot tell');
});

test('[BUG-095] the ring is levelled UP to --accent, never down to --accent-soft', () => {
  // The defect this branch shipped and an accessibility review caught. Against `--bg`, `--accent-soft`
  // is 1.05:1 in light — three quarters of the ring were never visible, and the ONLY perceivable part
  // was the `--accent` top border at 3.69:1. Levelling down deleted exactly that: it turned "a ring
  // that looks frozen" into "no ring at all", for the people the rule exists to serve.
  const decls = reducedMotionDecls(read('style.css'), '.g-busy');
  assert.doesNotMatch(decls, /border(-top)?-color:\s*var\(--accent-soft\)/,
    'levelling the ring to --accent-soft makes it invisible (1.05:1), which is worse than the frozen '
    + 'spinner [BUG-095] is about, not better');
});

test('[TASK-101] the ready sentence still APPEARS under reduced motion', () => {
  // Criterion 10: information, not decoration. `style.css` says so in a comment ("Nothing here may
  // become `display: none`") and an independent mutation made it `display: none` with the whole
  // suite green — a rule written down and enforced by nobody.
  const decls = reducedMotionDecls(read('style.css'), '.toggle-note');
  assert.doesNotMatch(decls, /display:\s*none/,
    'reduced motion removes the ANIMATION, never the sentence — it is the only text in the app that '
    + 'explains what the switch does');
  assert.doesNotMatch(decls, /opacity:\s*0(\D|$)/, 'nor may it be faded out of existence');
});

test('[BUG-095] the new detectors flag their own defects', () => {
  // Controls. Each detector must SEE the mutation it was written for, or it is decoration.
  const finite = '@media (prefers-reduced-motion: reduce) { .g-busy { animation: g-pulse 1.6s ease-in-out 1; } }';
  assert.doesNotMatch(reducedMotionDecls(finite, '.g-busy'), /animation:[^;]*\binfinite\b/);

  const flat = '@keyframes g-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 1; } }';
  const flatOpacities = new Set([...keyframesBody(flat, 'g-pulse').matchAll(/opacity:\s*([\d.]+)/g)].map(m => m[1]));
  assert.equal(flatOpacities.size, 1, 'the flattened-keyframes defect must read as one opacity');

  const levelled = '@media (prefers-reduced-motion: reduce) { .g-busy { border-color: var(--accent-soft); } }';
  assert.match(reducedMotionDecls(levelled, '.g-busy'), /border(-top)?-color:\s*var\(--accent-soft\)/);

  const gone = '@media (prefers-reduced-motion: reduce) { .toggle-note { display: none; } }';
  assert.match(reducedMotionDecls(gone, '.toggle-note'), /display:\s*none/);

  // And the keyframes matcher must survive its own nesting, or every assertion above is vacuous.
  const real = '@keyframes g-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }\n.after { color: red; }';
  assert.doesNotMatch(keyframesBody(real, 'g-pulse'), /color:\s*red/,
    'the brace matcher must stop at the keyframes block, not run on into the next rule');
});

test('[TASK-101] every id the harness seeds as hidden really ships hidden', async () => {
  // The harness's `HIDDEN_IDS` is a hand-maintained mirror of app/index.html, and it cuts BOTH ways:
  // an UNSEEDED id makes "was it revealed" pass vacuously (the reason the set exists), and a SEEDED
  // id whose markup lost its `hidden` class makes every such assertion pass over an element that is
  // permanently visible in a real browser. An independent battery removed `hidden` from the markup
  // of both new elements and nothing failed. Imported from the harness, never hand-copied, so the
  // two cannot drift.
  const { HIDDEN_IDS } = await import('../test-helpers/app-harness.mjs');
  const html = read('app/index.html');
  for (const id of HIDDEN_IDS) {
    const el = new RegExp(`<[^>]*\\sid="${id}"[^>]*>`).exec(html);
    assert.ok(el, `#${id} is seeded hidden in the harness but does not exist in app/index.html`);
    assert.match(el[0], /\sclass="[^"]*\bhidden\b/,
      `#${id} is seeded hidden in the harness but does NOT ship with the hidden class — every test `
      + `asserting it was revealed passes over an element the browser shows from first paint`);
  }
  assert.match(read('style.css'), /^\.hidden\s*\{[^}]*display:\s*none/m,
    'and the class must actually hide: the global .hidden rule is what all of the above relies on');
});

test('[BUG-051] the damaged-store notice is complete in the markup, on all three views', () => {
  // Independent battery, P03/P05. The harness memoises a stub for ANY getElementById id and never
  // reads app/index.html, so renaming `#damaged-notice-setup-text` leaves every notice test green
  // while a browser shows an empty red box with an unexplained button in it. Same for the live
  // region: `role="status"` is what announces the state to a screen reader, and dropping it is
  // invisible to every other check. Both are pinnable here, exactly as HIDDEN_IDS already is.
  const html = read('app/index.html');
  for (const view of ['setup', 'feed', 'archive']) {
    const box = new RegExp(`<div[^>]*\\sid="damaged-notice-${view}"[^>]*>`).exec(html);
    assert.ok(box, `#damaged-notice-${view} must exist — the notice appears on all three views`);
    assert.match(box[0], /role="status"/,
      `#damaged-notice-${view} must be a live region, or the state is never announced`);
    assert.ok(new RegExp(`id="damaged-notice-${view}-text"`).test(html),
      `#damaged-notice-${view}-text must exist, or the notice renders as an empty box`);
    const action = new RegExp(`<button[^>]*\\sid="damaged-heal-${view}"[^>]*>([^<]*)</button>`).exec(html);
    assert.ok(action, `#damaged-heal-${view} must exist`);
    assert.ok(action[1].trim().length > 0,
      `#damaged-heal-${view} must carry a label — an empty button is unusable and unannounced`);
  }
});

test('[TASK-101] criterion 12 — both new signals are announced, not just drawn', () => {
  // The deleted pill announced through `role="status"`. Independent mutations emptied the
  // visually-hidden label and stripped the role, with the whole suite green — so a non-sighted
  // reader could have been left with strictly less than before and nothing would have said so.
  const html = read('app/index.html');
  const busy = /<span[^>]*\sid="group-busy"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/.exec(html)
    || /<span[^>]*\sid="group-busy"[^>]*>([\s\S]*?)<button/.exec(html);
  assert.ok(busy, 'the busy indicator must exist in the markup');
  assert.match(busy[0], /role="status"/, 'the busy indicator must be a live region');
  assert.match(busy[1], /class="sr-only"[^>]*>\s*\S+/,
    'and must carry non-empty visually-hidden text — a bare decorative ring announces nothing');

  const note = /<p[^>]*\sid="group-ready-note"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  assert.ok(note, 'the ready note must exist in the markup');
  assert.match(note[0], /role="status"/, 'the sentence must be announced, not shown silently');
  assert.match(note[1], /\S/, 'and must not be empty');
});

test('[TASK-101] the appbar stays sticky — criterion 3 and the note anchor both rest on it', () => {
  // One untouched line carrying two criteria. Make `.appbar` static and (a) the busy indicator
  // scrolls away mid-classify, which is the ENTIRE argument for moving it out of the pill, and
  // (b) `.toggle-note`'s `position: absolute` loses its containing block, so `top: 100%` resolves
  // against the initial containing block and the bubble lands a viewport down the page.
  // Neither the CSS nor the markup said so until a review pointed it out.
  const css = read('style.css');
  const appbar = /^\.appbar\s*\{([^}]*)\}/m.exec(css);
  assert.ok(appbar, '.appbar rule must exist');
  assert.match(appbar[1], /position:\s*sticky/,
    'the busy indicator only survives a scroll because the appbar does, and the note is only '
    + 'anchored under the switch because a sticky appbar is a containing block');
});

test('[TASK-101] criteria 8 and 9 — the sentence is tappable-through and not the toast surface', () => {
  // Two more independent mutations that survived the whole suite: `pointer-events: auto` (the bubble
  // swallows taps on the feed beneath it for six seconds after every classify) and swapping its
  // background to `--btn-strong-bg` — which is EXACTLY the solid toast surface a user named as "too
  // black and solid", the one hard requirement he gave for this element.
  const css = read('style.css');
  const rule = /^\.toggle-note\s*\{([^}]*)\}/m.exec(css);
  assert.ok(rule, '.toggle-note rule must exist');
  assert.match(rule[1], /pointer-events:\s*none/,
    'the note is an aside, not a dialog — the reader must be able to tap the feed through it');
  assert.doesNotMatch(rule[1], /background:\s*var\(--btn-strong-bg\)/,
    'that is the toast surface, and "not like the sync warning, too black and solid" was the brief');
  assert.match(rule[1], /background:\s*rgb\(var\(--note-bg\)/,
    'it must use the translucent note surface');
});

test('[BUG-095] the reduced-motion ring is levelled on ALL FOUR sides, not just the top', () => {
  // Independent survivor I14. Criterion 4 has two halves — "still moves" and "stops claiming to be a
  // spinner" — and only the first was pinned. Reverting `border-color` to `border-top-color` leaves
  // the ring with one differently-coloured quarter: the exact shape that reads as a stopped spinner,
  // which is what [BUG-095] is ABOUT. The pulse would still run, so every other assertion passes.
  const decls = reducedMotionDecls(read('style.css'), '.g-busy');
  assert.match(decls, /border-color:\s*var\(--accent\)/,
    'all four sides must take the same colour — a single differently-coloured quarter is the spinner '
    + 'shape, and a still spinner reads as a hang however well it pulses');
});

test('[TASK-101] --note-bg is defined in BOTH themes', () => {
  // Independent survivor I37. `rgb(var(--note-bg) / .93)` with the token missing is not a fallback,
  // it is an INVALID declaration: the background drops to transparent and the sentence lands on the
  // feed with a blur and a border and no surface — in dark mode only, which is the half a light-mode
  // check never sees.
  const css = read('style.css');
  const light = /^:root\s*\{([\s\S]*?)\n\}/m.exec(css);
  const dark = /^:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/m.exec(css);
  assert.ok(light && dark, 'both theme blocks must exist');
  assert.match(light[1], /--note-bg:\s*[\d\s]+;/, 'light theme must define --note-bg');
  assert.match(dark[1], /--note-bg:\s*[\d\s]+;/,
    'dark theme must define --note-bg, or the note is transparent for every dark-mode reader');
});

test('[TASK-101] the two new CSS detectors flag their own defects', () => {
  const quartered = '@media (prefers-reduced-motion: reduce) { .g-busy { border-top-color: var(--accent); } }';
  assert.doesNotMatch(reducedMotionDecls(quartered, '.g-busy'), /border-color:\s*var\(--accent\)/,
    'the four-sides detector must not accept a top-only rule');
  const noDark = ':root {\n  --note-bg: 255 255 255;\n}\n:root[data-theme="dark"] {\n  --shine: 1 2 3;\n}';
  assert.doesNotMatch(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/m.exec(noDark)[1], /--note-bg:/,
    'the both-themes detector must see a missing dark token');
});

// ── [BUG-104] Every analytics name app.js emits must be one the server will store ──────────────
// `normalizeEvent` drops any name absent from `EVENT_NAMES`, which makes an unlisted event a SILENT
// failure: the client emits it, the PUT carries it, the server bins it, and what is left is a metric
// that measures nothing and looks perfectly healthy. `api/_events.js` already carries a comment
// saying exactly that, written when `landing_view` was added for [TASK-084] — and two later events
// were then added to `app.js` without the matching entry anyway.
//
// Found 2026-08-28: `group_classify` ([CHR-012]'s instrument, the whole point of which was to
// measure a distribution nobody had ever measured) and `group_view_toggle` ([TASK-099]'s adoption
// metric) had BOTH been recording nothing since they shipped. A comment did not prevent it twice;
// this test is the mechanism that replaces the comment.
test('BUG-104: every track() name in app.js is in the server-side EVENT_NAMES allowlist', async () => {
  const { EVENT_NAMES } = await import('../api/_events.js');
  const emitted = [...read('app.js').matchAll(/\btrack\(\s*'([a-z_]+)'/g)].map(m => m[1]);

  assert.ok(emitted.length > 10, `guard: found only ${emitted.length} track() calls — the scan is broken, not the code`);
  // Guard on a name that has been stable since the first analytics landed, NOT on the newest one:
  // guarding on the newest couples this test to that feature's existence, so removing the feature
  // reds this test for a reason that has nothing to do with allowlists.
  assert.ok(emitted.includes('signin'), 'guard: the scan can actually see track() names');

  const dropped = [...new Set(emitted)].filter(n => !EVENT_NAMES.has(n)).sort();
  assert.deepEqual(dropped, [],
    `app.js emits ${dropped.length} event name(s) the server silently bins: ${dropped.join(', ')} — `
    + 'add them to EVENT_NAMES in api/_events.js or stop emitting them');
});

// ── [TASK-092] The first-run tour: markup and CSS contracts ─────────────────────────────────────
// The harness memoises a stub for any id and never reads app/index.html or style.css, so every tour
// test in test/tour.test.mjs would stay green over a card with no dialog role, a layer nested inside a
// view (and so hidden with it), or a reduced-motion rule that hides the card. These read the files.

const TOUR_IDS = ['tour', 'tour-ring', 'tour-block-top', 'tour-block-right', 'tour-block-bottom', 'tour-block-left'];

test('[TASK-092] D1 every tour element the code shows or hides is seeded hidden in the harness (criterion 16)', async () => {
  // The companion check above ("every id the harness seeds as hidden really ships hidden") only runs
  // over ids that ARE seeded, so a tour id left out of HIDDEN_IDS escapes both halves.
  const { HIDDEN_IDS } = await import('../test-helpers/app-harness.mjs');
  for (const id of TOUR_IDS) assert.ok(HIDDEN_IDS.has(id), `#${id} must be seeded in HIDDEN_IDS`);
});

test('[TASK-092] D2 the tour layer is body-level and its card is a labelled dialog (criterion 16, UI & states)', () => {
  const html = read('app/index.html');
  const layer = html.indexOf('id="tour"');
  assert.ok(layer > html.indexOf('id="bottom-nav"'),
    '#tour must sit at body level after the views and the bottom nav — inside a .view it hides with that view');
  const cardEl = /<[^>]*\sid="tour-card"[^>]*>/.exec(html);
  assert.ok(cardEl, '#tour-card must exist');
  assert.match(cardEl[0], /role="dialog"/);
  // NOT modal (Asli, 2026-09-15, accepting review round 1's L6): the highlighted control sits outside the card,
  // and aria-modal would tell a screen reader it is inert. This asserted the opposite until that decision.
  assert.doesNotMatch(cardEl[0], /aria-modal/, 'the card must not hide the highlighted control from a screen reader');
  assert.match(cardEl[0], /aria-labelledby="tour-text"/, 'the dialog is labelled by its sentence');
  for (const id of ['tour-part', 'tour-text', 'tour-count']) {
    assert.ok(new RegExp(`\\sid="${id}"`).test(html), `#${id} must exist`);
  }
  const back = /<button[^>]*\sid="tour-back"[^>]*>/.exec(html);
  assert.ok(back, '#tour-back must be a button');
  assert.match(back[0], /aria-label="[^"]+"/, 'the Back arrow is an icon, so it needs a label');
  assert.match(html, /<button[^>]*\sid="tour-close"[^>]*>\s*Close\s*<\/button>/);
  assert.ok(/<button[^>]*\sid="tour-main"[^>]*>/.test(html), '#tour-main must be a button');
});

test('[TASK-092] D3 "Show the tour" sits in the drawer under Manage channels, styled like it (criterion 11)', () => {
  const html = read('app/index.html');
  const row = /<button[^>]*\sid="btn-drawer-tour"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  assert.ok(row, '#btn-drawer-tour must exist');
  assert.match(row[0], /class="[^"]*\bpref-manage\b/);
  assert.match(row[1], /Show the tour/);
  const manage = html.indexOf('id="btn-drawer-manage"');
  assert.ok(manage !== -1 && row.index > manage, 'below Manage channels');
  assert.ok(row.index < html.indexOf('id="account"'), 'inside the preferences block, above the account block');
});

test('[TASK-092] D4 the source tabs carry the id the first card points at', () => {
  assert.match(read('app/index.html'), /<div[^>]*class="source-toggle"[^>]*\sid="source-toggle"|<div[^>]*\sid="source-toggle"[^>]*class="source-toggle"/);
});

test('[TASK-092] D5 the layer stacks between the bottom nav and the drawer, dims harder in dark, and locks scroll (UI & states)', () => {
  const css = read('style.css');
  const layer = /^\.tour\s*\{([^}]*)\}/m.exec(css);
  assert.ok(layer, 'a top-level .tour rule must exist');
  assert.match(layer[1], /z-index:\s*55\b/, 'above the bottom nav (50), below the drawer (60/61), toasts (62) and the picker (70/71)');
  assert.match(css, /body\.tour-open\s*\{[^}]*overflow:\s*hidden/, 'the page does not scroll under the dim');
  const light = /:root\s*\{[^}]*--tour-scrim:\s*rgba\([^)]*,\s*0?\.58\)/.exec(css);
  const dark = /:root\[data-theme="dark"\]\s*\{[^}]*--tour-scrim:\s*rgba\([^)]*,\s*0?\.66\)/.exec(css);
  assert.ok(light, 'the dim is 58% in light');
  assert.ok(dark, 'and 66% in dark, so the cut-out still reads');
});

test('[TASK-092] D6 under reduced motion the ring and card jump instead of sliding, and still appear (criterion 16, Risk 12)', () => {
  const css = read('style.css');
  for (const sel of ['.tour-ring', '.tour-card']) {
    const decls = reducedMotionDecls(css, sel);
    assert.match(decls, /transition:\s*none/, `${sel} must not animate under reduced motion`);
    assert.doesNotMatch(decls, /display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])/,
      `${sel} is information, not decoration — it must still appear`);
  }
});

/** The declarations of a TOP-LEVEL rule whose selector is exactly `selector` — not one inside a media block. */
function topLevelRule(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return m ? m[1] : null;
}

test('[TASK-092] D7 the cut-out takes taps and nothing else does — the layer, blockers, ring and card (Risks 1, 3)', () => {
  // Author battery C2, C3, C6, C12, every one invisible to the harness. The layer passes taps through so
  // the highlighted control works; the blockers catch the taps outside it; the ring sits ON the cut-out
  // and must not swallow the tap on the control; and the card must take taps or Close cannot be pressed
  // — on a phone, with no Escape key, that is a dim with no way out.
  const css = read('style.css');
  const want = [
    ['.tour', /pointer-events:\s*none/, 'the layer passes taps through to the highlighted control'],
    ['.tour-block', /pointer-events:\s*auto/, 'the blockers catch the taps outside the cut-out'],
    ['.tour-ring', /pointer-events:\s*none/, 'the ring does not swallow the tap on the control it surrounds'],
    ['.tour-card', /pointer-events:\s*auto/, 'the card\'s buttons can be pressed'],
  ];
  for (const [sel, re, why] of want) {
    const decls = topLevelRule(css, sel);
    assert.ok(decls !== null, `a top-level ${sel} rule must exist`);
    assert.match(decls, re, `${sel}: ${why}`);
  }
});

test('[TASK-092] D8 the ring, card and blockers are fixed to the viewport the positions are measured in (criterion 17)', () => {
  // Author battery C4, C7, C13. app.js places them from getBoundingClientRect, which is viewport-relative;
  // anything but `position: fixed` puts them somewhere else, and the harness answers zeros either way.
  const css = read('style.css');
  for (const sel of ['.tour-block', '.tour-ring', '.tour-card']) {
    const decls = topLevelRule(css, sel);
    assert.ok(decls !== null, `a top-level ${sel} rule must exist`);
    assert.match(decls, /(^|;|\s)position:\s*fixed/, `${sel} must be position: fixed`);
  }
});

test('[TASK-092] D9 the dim is drawn with and without a highlight (design B)', () => {
  // Author battery C8, C9. The dim is the ring's shadow, so dropping that one value removes the backdrop
  // Asli chose while every other check stays green.
  const css = read('style.css');
  assert.match(topLevelRule(css, '.tour-ring') || '', /box-shadow:[^;]*var\(--tour-scrim\)/, 'the ring\'s shadow is the dim');
  assert.match(topLevelRule(css, '.tour-ring.no-target') || '', /box-shadow:[^;]*var\(--tour-scrim\)/,
    'and a centred card, with nothing highlighted, is still dimmed');
});

test('[TASK-092] D10 the card paints above the blockers and the ring, whatever the markup order and whatever a later rule says (Risk 1; review MED-4, round 2 E14–E16)', () => {
  // All three are position:fixed inside #tour. Without explicit z-index the card is on top only because
  // it comes last in the markup — and a centred card sits under a full-screen blocker, so reordering the
  // markup would make Close untappable.
  const css = read('style.css');
  const z = (sel) => {
    const m = /z-index:\s*(\d+)/.exec(topLevelRule(css, sel) || '');
    assert.ok(m, `${sel} must declare its own z-index`);
    return Number(m[1]);
  };
  assert.ok(z('.tour-card') > z('.tour-block'), 'the card is above the blockers');
  assert.ok(z('.tour-card') > z('.tour-ring'), 'and above the ring');
  // The first top-level rule is not the cascade: a later rule, a media block or a more specific selector
  // could sink the card with the three rules above untouched — the MED-4 trap again, measured by both
  // round-2 reviewers. Every rule that sets a z-index on any of the three counts.
  const card = zOf(css, 'tour-card', ['tour-card']);
  const under = [...zOf(css, 'tour-block', TOUR_IDS.filter((id) => id.startsWith('tour-block-'))), ...zOf(css, 'tour-ring', ['tour-ring'])];
  assert.ok(Math.min(...card) > Math.max(...under),
    `every z-index any rule gives the card (${card}) must stay above every one given to a blocker or the ring (${under})`);
});

test('[TASK-092] D15 a toast paints above the tour layer in every rule, so its Undo can be tapped under the dim (Risk 3; independent round 2 E18)', () => {
  const css = read('style.css');
  const toast = zOf(css, 'toast', ['toast']);
  const layer = zOf(css, 'tour', ['tour']);
  assert.ok(toast.length && layer.length, 'guard: the scan sees a z-index for both');
  assert.ok(Math.min(...toast) > Math.max(...layer), `every toast z-index (${toast}) must be above every tour-layer one (${layer})`);
});

test('[TASK-092] D16 neither the tour layer nor its card is hidden from a screen reader (Risk 11; independent round 2 D02)', () => {
  const html = read('app/index.html');
  for (const id of ['tour', 'tour-card']) {
    const tag = new RegExp(`<[^>]*\\sid="${id}"[^>]*>`).exec(html);
    assert.ok(tag, `#${id} must exist`);
    assert.doesNotMatch(tag[0], /aria-hidden/, `#${id} must not carry aria-hidden — a screen reader would announce a dim with no dialog`);
  }
});

test('[TASK-092] D11 the tour layer is a direct child of body, not merely later in the file (review L1)', () => {
  const html = read('app/index.html');
  assert.match(html, /<\/nav>\s*(?:<!--[\s\S]*?-->\s*)*<div id="tour" class="tour hidden">/,
    '#tour follows the bottom nav with nothing but comments between');
  assert.match(html, /<\/div>\s*<\/div>\s*<\/div>\s*<script type="module" src="\/app\.js"><\/script>/,
    'and closes right before the app script, so nothing wraps it');
  // The two patterns above read text shape, and a hidden wrapper followed by a comment passes both: the lazy
  // comment group spans the wrapper's tag, and the last three </div>s match whatever wraps them (review round 2,
  // Q37). So, as structure: with comments gone, the region between the bottom nav and the app script is ONE
  // element — #tour — and its own closing tag is the last </div> in it.
  const bare = html.replace(/<!--[\s\S]*?-->/g, '');
  const end = bare.indexOf('<script type="module" src="/app.js">');
  const region = bare.slice(bare.lastIndexOf('</nav>', end) + '</nav>'.length, end).trim();
  assert.ok(region.startsWith('<div id="tour" class="tour hidden">'), '#tour is the first element after the bottom nav — nothing opens around it');
  const divs = [...region.matchAll(/<(\/?)div\b[^>]*>/g)];
  let depth = 0;
  divs.forEach((t, i) => {
    depth += t[1] ? -1 : 1;
    if (depth === 0) assert.equal(i, divs.length - 1, '#tour closes on the last </div> before the app script — nothing wraps it, nothing follows it');
  });
  assert.equal(depth, 0, 'every <div> opened after the bottom nav closes before the app script');
  assert.ok(region.endsWith('</div>'), 'and nothing but #tour sits there');
  assert.match(topLevelRule(read('style.css'), '.tour-block') || '', /touch-action:\s*none/,
    'and a drag on the dim does not scroll the page on a touch screen (review L2)');
});

/** Every innermost `selector { declarations }` in the file, media blocks included, comments stripped. */
function allRules(css) {
  const out = [];
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(bare))) out.push({ selectors: m[1].split(',').map((s) => s.trim()), decls: m[2] });
  return out;
}

/** Whether a selector's SUBJECT — its last compound, the element the rule styles — names class `cls` or one of
 *  `ids`. A pseudo-element subject (`::before`) styles something else, so it never counts. */
function namesSubject(selector, cls, ids = []) {
  const subject = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() || '';
  if (subject.includes('::')) return false;
  const bound = '(?![\\w-])';
  return new RegExp(`\\.${cls}${bound}`).test(subject) || ids.some((id) => new RegExp(`#${id}${bound}`).test(subject));
}

/** Every z-index that ANY rule — media blocks and later rules included — sets on an element named by
 *  `namesSubject(selector, cls, ids)`. `auto` reads as 0. */
function zOf(css, cls, ids) {
  const out = [];
  for (const { selectors, decls } of allRules(css)) {
    const z = /z-index:\s*(-?\d+|auto)/.exec(decls);
    if (z && selectors.some((s) => namesSubject(s, cls, ids))) out.push(z[1] === 'auto' ? 0 : Number(z[1]));
  }
  return out;
}

test('[TASK-092] D12 no rule anywhere hides or disables the tour\'s card, its buttons or the layer — by class, by id or inside a longer selector (Risk 1; independent C1, C28, C29, C31, C36, C43; review round 2 Q35, Q36)', () => {
  // A contract that reads only the FIRST rule for a selector is beaten by a later one, and one that reads
  // only top-level rules is beaten by a media block — both measured by the independent battery. This reads
  // every rule in the file, including inside @media, and lets the cascade have no say. Round 2 measured the
  // third way past it: an exact-selector list misses `#tour-close` and `:root[data-theme="dark"] .tour-card`,
  // so a rule counts whenever its SUBJECT (the last compound) names one of these elements by class or id.
  const rules = allRules(read('style.css'));
  const mustShow = ['.tour', '.tour-card', '.tour-foot', '.tour-close', '.tour-main', '.tour-back', '.tour-card button', '.tour-ring', '.tour-block', '.tour-text'];
  const pointer = { '.tour': 'none', '.tour-ring': 'none', '.tour-block': 'auto', '.tour-card': 'auto', '.tour-foot': null, '.tour-close': null, '.tour-main': null, '.tour-back': null, '.tour-card button': null };
  const idsOf = (cls) => (cls === '.tour-block' ? TOUR_IDS.filter((id) => id.startsWith('tour-block-')) : [cls.slice(1)]);
  const covered = (sel) => (mustShow.includes(sel) ? sel
    : mustShow.filter((m) => !m.includes(' ')).find((m) => namesSubject(sel, m.slice(1), idsOf(m))));
  let subjectHits = 0;
  for (const { selectors, decls } of rules) {
    for (const sel of selectors) {
      const key = covered(sel);
      if (!key) continue;
      if (key !== sel) subjectHits++;
      assert.doesNotMatch(decls, /display:\s*none|visibility:\s*hidden/, `${sel} must never be hidden by a rule`);
      if (key in pointer) {
        const pe = /pointer-events:\s*([a-z]+)/.exec(decls);
        if (pe) {
          assert.ok(pointer[key] !== null, `${sel} must not set pointer-events at all — it inherits auto from the card`);
          assert.equal(pe[1], pointer[key], `${sel} pointer-events must be ${pointer[key]} in every rule that sets it`);
        }
      }
    }
  }
  assert.ok(subjectHits > 0, 'guard: the subject scan reaches beyond the exact list (`.tour-back:disabled`, `.tour-ring.no-target`)');
  assert.match(topLevelRule(read('style.css'), '.tour') || '', /position:\s*fixed/, '.tour must be positioned, or its z-index does nothing');
});

test('[TASK-092] D13 the dim\'s spread covers any screen (design B; independent C14)', () => {
  const css = read('style.css');
  for (const sel of ['.tour-ring', '.tour-ring.no-target']) {
    const m = /0 0 0 (\d+)(vmax|px)\s+var\(--tour-scrim\)/.exec(topLevelRule(css, sel) || '');
    assert.ok(m, `${sel}'s shadow spread must be readable`);
    assert.ok(m[2] === 'vmax' ? Number(m[1]) >= 100 : Number(m[1]) >= 4000, `${sel}: a spread of ${m[1]}${m[2]} does not cover a large screen`);
  }
});

test('[TASK-092] D14 every element the tour looks up by id exists in the markup (independent T39)', () => {
  // docs.test's T11 checks literal getElementById calls; the tour also resolves targets through
  // `shownById(...)`, and a renamed id there just makes a card centred with nothing highlighted.
  const app = read('app.js');
  const start = app.indexOf('// ── First-run tour ([TASK-092])');
  const end = app.indexOf('\n// ──', start + 10);
  assert.ok(start !== -1 && end !== -1, 'guard: the tour section is findable');
  const section = app.slice(start, end);
  const ids = new Set([...section.matchAll(/(?:getElementById|shownById)\(\s*'([a-z][a-z0-9-]*)'\s*\)/g)].map((m) => m[1]));
  for (const s of ['top', 'right', 'bottom', 'left']) ids.add(`tour-block-${s}`);
  assert.ok(ids.size >= 15, `guard: found only ${ids.size} ids — the scan is broken`);
  const html = read('app/index.html');
  const missing = [...ids].filter((id) => !new RegExp(`\\sid="${id}"`).test(html));
  assert.deepEqual(missing, [], `the tour looks up ids the page does not have: ${missing.join(', ')}`);
});
