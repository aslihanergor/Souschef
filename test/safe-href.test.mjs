// A remote URL reaches an `href` only if it is absolute http(s).
//
// A Substack feed chooses its own post links, and every card that renders one used to pass it through
// `esc()` alone, which escapes HTML and says nothing about the scheme — so a feed whose <link> is
// `javascript:…` put a script link on the post title. Seven sinks are covered: the Substack card's title
// and "S" icon, the reader's three readout links, the topic card's "Open ↗", and each linkified URL in
// tweet text. The guard sits at RENDER, not in the parser, because archived posts keep their `url` in
// synced state and cached tweets keep theirs on the device; a parser fix reaches neither.
//
// Every assertion reads RENDERED MARKUP, never "was safeHref called". Three things keep them honest,
// so the tests can tell a weak guard from a real one:
//   - EVERY sink is driven with the whole HOSTILE list, not one `javascript:` string — otherwise a sink
//     guarded by a weak blocklist (`/^javascript:/`) passes, while `java<TAB>script:` still executes;
//   - the fixtures carry HTML-special characters, so the `esc()` at every sink this change touched is
//     pinned too, not only the scheme check;
//   - expected markup is HARD-CODED, never built with `esc()` — a twin that computes its expectation
//     with the function under test cannot see that function regress.
// And every unsafe case has a safe twin asserting the anchor IS there, because "no href" is vacuously
// true of markup that rendered nothing — an assertion that could not fail.
//
// The harness injects EVERY lib/pure.js export into the vm (`...pure`) and strips app.js's import line,
// while the browser sees only what that line imports — and parses the file as a MODULE. So the renderer
// tests would pass with `safeHref` missing from the import, or imported twice, while the browser threw.
// The last two tests close both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as pure from '../lib/pure.js';
import { createApp } from '../test-helpers/app-harness.mjs';

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);
const SOH = String.fromCharCode(1);

// Each one resolves to something other than an absolute http(s) page in a browser's URL parser:
// the parser strips tabs and newlines inside a URL and leading control characters before a scheme.
const HOSTILE = [
  'javascript:alert(document.domain)',
  `java${TAB}script:alert(1)`,
  `${SOH}javascript:alert(1)`,
  `javascript:alert(1)//${NL}https://example.com/`,
  // A non-http scheme WITH `//`: `//` opens a JS comment and `%0A` ends it. Without this entry no sink saw
  // the "any scheme://" shape at all — only c1 did.
  'javascript://%0Aalert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  '//evil.example/x',
  'https:/api/state',
];

const SAFE = 'https://example.substack.com/p/a-post?utm=1&ref=feed';
const SAFE_ATTR = 'https://example.substack.com/p/a-post?utm=1&amp;ref=feed'; // hard-coded, not esc(SAFE)
const TITLE = 'Bait <b>"title"</b> & more';
const TITLE_HTML = 'Bait &lt;b&gt;&quot;title&quot;&lt;/b&gt; &amp; more';

const hrefsIn = markup => [...String(markup).matchAll(/\bhref="([^"]*)"/g)].map(m => m[1]);
const noFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
const label = s => JSON.stringify(s);

const SUB_CHANNEL = { id: 'example.substack.com', name: 'Example Pub', source: 'substack' };
const substackItem = url => ({
  source: 'substack', id: 'post-1', title: TITLE, subtitle: '', url, author: 'Author',
  published: new Date(Date.now() - 3600_000).toISOString(), preview: 'Teaser.', cover: '', channel: SUB_CHANNEL,
});

// ── c1: the predicate ────────────────────────────────────────────────────────────────────────────────

test('BUG-023 c1: safeHref accepts absolute http(s), trimmed, in any case', () => {
  const cases = [
    ['https://a.substack.com/p/x', 'https://a.substack.com/p/x'],
    ['http://example.com/', 'http://example.com/'],
    ['HTTPS://EXAMPLE.COM/P', 'HTTPS://EXAMPLE.COM/P'],
    ['  https://example.com/x \n', 'https://example.com/x'],
  ];
  for (const [input, want] of cases) assert.equal(pure.safeHref(input), want, label(input));
});

test('BUG-023 c1: safeHref rejects every other scheme, relative forms and non-strings', () => {
  const cases = [
    ...HOSTILE,
    'JavaScript:alert(1)', '  javascript:alert(1)', `${NUL}javascript:alert(1)`, '/p/relative', '',
    null, undefined, 42, { toString: () => 'https://x.example' },
    // Without these the
    // `^` anchor (P4) and the http(s)-only scheme (P5) could be deleted and every case above still passed.
    'javascript:alert(1)//https://example.com/', 'javascript://%0Aalert(1)',
    // Alongside HOSTILE's raw-newline and `https:/api/state` entries: a RAW
    // newline defeats a multiline-flagged `^`, and a scheme with one or no slash is relative to the app's
    // own origin, not absolute (`https:/api/state` resolves to this site's /api/state).
    'https:evil.example', 'http:/x',
  ];
  for (const input of cases) assert.equal(pure.safeHref(input), null, label(input));
});

// ── c2: the Substack card ────────────────────────────────────────────────────────────────────────────

test('BUG-023 c2: a Substack card with any hostile link renders no href and keeps its (escaped) title', () => {
  for (const bad of HOSTILE) {
    const app = createApp({ fetch: noFetch });
    const markup = app.ctx.renderSubstackCard(substackItem(bad), 'feed').innerHTML;
    assert.deepEqual(hrefsIn(markup), [], label(bad));
    assert.ok(markup.includes(`<span class="substack-title">${TITLE_HTML}</span>`), `title span for ${label(bad)}`);
    assert.ok(!markup.includes('substack-link'), `no "S" icon for ${label(bad)}`);
  }
});

test('BUG-023 c2 twin: a Substack card with an https link keeps both anchors, byte for byte', () => {
  const app = createApp({ fetch: noFetch });
  const markup = app.ctx.renderSubstackCard(substackItem(SAFE), 'feed').innerHTML;
  assert.ok(markup.includes(
    `<a class="substack-title" href="${SAFE_ATTR}" target="_blank" rel="noopener">${TITLE_HTML}</a>`), markup);
  assert.ok(markup.includes(
    `<a class="tweet-x substack-link" href="${SAFE_ATTR}" target="_blank" rel="noopener" aria-label="Read on Substack">`), markup);
  assert.equal(hrefsIn(markup).length, 2);
});

// ── c3: the reader's readout, all four branches ──────────────────────────────────────────────────────

// `paywalledPreview` is the fourth path: a paywalled post whose free preview WAS extracted renders the body
// AND the paywall readout from the success branch, not the failure one.
const READOUT_BRANCHES = {
  paywalled:        { ok: true,  status: 200, body: { html: null, paywalled: true } },
  paywalledPreview: { ok: true,  status: 200, body: { html: '<p>preview</p>', paywalled: true } },
  free:             { ok: true,  status: 200, body: { html: '<p>body</p>', paywalled: false } },
  failed:           { ok: false, status: 400, body: { error: 'invalid url' } },
};

// Hard-coded, whole readout markup per branch. Unsafe keeps only the explanation; text that exists only
// to link out ("Read on Substack →", "Open on Substack →") goes with the anchor.
const READOUT_SAFE = {
  paywalled:        `<div class="substack-readout-link">🔒 This post is for paid subscribers. <a href="${SAFE_ATTR}" target="_blank" rel="noopener">read the rest on Substack →</a></div>`,
  paywalledPreview: `<div class="substack-readout-link">🔒 This post is for paid subscribers. <a href="${SAFE_ATTR}" target="_blank" rel="noopener">read the rest on Substack →</a></div>`,
  free:             `<div class="substack-readout-link"><a href="${SAFE_ATTR}" target="_blank" rel="noopener">Read on Substack →</a></div>`,
  failed:           `<div class="substack-readout-link"><a href="${SAFE_ATTR}" target="_blank" rel="noopener">Couldn’t load the full post. Open on Substack →</a></div>`,
};
const READOUT_UNSAFE = {
  paywalled:        '<div class="substack-readout-link">🔒 This post is for paid subscribers.</div>',
  paywalledPreview: '<div class="substack-readout-link">🔒 This post is for paid subscribers.</div>',
  free:             '<div class="substack-readout-link"></div>',
  failed:           '<div class="substack-readout-link">Couldn’t load the full post.</div>',
};
const BODY = { paywalled: '', paywalledPreview: '<p>preview</p>', free: '<p>body</p>', failed: '' };

async function readerFor(branch, url) {
  const b = READOUT_BRANCHES[branch];
  const fetchImpl = async u => String(u).startsWith('/api/substack-post')
    ? { ok: b.ok, status: b.status, json: async () => b.body }
    : { ok: false, status: 500, json: async () => ({}) };
  const app = createApp({ fetch: fetchImpl });
  const card = app.ctx.renderSubstackCard(substackItem(url), 'feed');
  await app.ctx.toggleSubstackReader(card, url);
  return { readout: card.querySelector('.substack-readout').innerHTML, body: card.querySelector('.substack-body').innerHTML };
}

// One named test per branch, so a failure says WHICH branch it came from.
for (const branch of Object.keys(READOUT_BRANCHES)) {
  test(`BUG-023 c3 [${branch}]: the readout drops the link for every hostile url and keeps its explanation`, async () => {
    for (const bad of HOSTILE) {
      const { readout, body } = await readerFor(branch, bad);
      assert.equal(readout, READOUT_UNSAFE[branch], label(bad));
      // Positive half: the article (or preview) still renders — "no link" must not mean "nothing".
      assert.equal(body, BODY[branch], `body for ${label(bad)}`);
    }
  });

  test(`BUG-023 c3 twin [${branch}]: the readout keeps its link for an https post, byte for byte`, async () => {
    const { readout, body } = await readerFor(branch, SAFE);
    assert.equal(readout, READOUT_SAFE[branch]);
    assert.equal(body, BODY[branch], 'body');
  });
}

// ── c4: the topic card's reduced post ────────────────────────────────────────────────────────────────

test('BUG-023 c4: a topic-card post with any hostile link renders no "Open" link', () => {
  for (const bad of HOSTILE) {
    const app = createApp({ fetch: noFetch });
    const markup = app.ctx.renderReducedPost(substackItem(bad), 'g1').children[0].innerHTML;
    assert.deepEqual(hrefsIn(markup), [], label(bad));
    assert.ok(!markup.includes('tc-link'), `no "Open ↗" for ${label(bad)}`);
  }
});

test('BUG-023 c4 twin: a topic-card post with an https link keeps "Open", byte for byte', () => {
  const app = createApp({ fetch: noFetch });
  const markup = app.ctx.renderReducedPost(substackItem(SAFE), 'g1').children[0].innerHTML;
  assert.ok(markup.includes(` · <a class="tc-link" href="${SAFE_ATTR}" target="_blank" rel="noopener">Open ↗</a>`), markup);
});

// ── c5: links inside tweet text ──────────────────────────────────────────────────────────────────────

const tweetItem = (expanded, display = 'example.com/x') => ({
  source: 'twitter', id: '1', text: 'read this https://t.co/abc123', published: new Date().toISOString(),
  url: 'https://x.com/someone/status/1', media: [],
  urls: [{ short: 'https://t.co/abc123', display, expanded }],
  channel: { id: 'u1', name: 'Someone', handle: 'someone', source: 'twitter' },
});
const tweetTextOf = markup => (String(markup).match(/<div class="tweet-text">([\s\S]*?)<\/div>/) || [])[1];
const renderTweetText = item => tweetTextOf(createApp({ fetch: noFetch }).ctx.renderTweetCard(item, 'feed').innerHTML);

test('BUG-023 c5: a tweet link whose expanded URL is hostile shows its display text, unlinked', () => {
  for (const bad of HOSTILE) {
    assert.equal(renderTweetText(tweetItem(bad)), 'read this example.com/x', label(bad));
  }
  // The unlinked label is escaped too.
  assert.equal(renderTweetText(tweetItem('javascript:alert(1)', '<img src=x onerror=alert(1)>')),
    'read this &lt;img src=x onerror=alert(1)&gt;');
});

test('BUG-023 c5 twin: tweet links with http(s) expanded URLs render their anchors, escaped, byte for byte', () => {
  assert.equal(renderTweetText(tweetItem('https://example.com/x')),
    'read this <a class="tweet-link" target="_blank" rel="noopener" href="https://example.com/x">example.com/x</a>');
  assert.equal(renderTweetText(tweetItem('http://example.com/y', 'example.com/y')),
    'read this <a class="tweet-link" target="_blank" rel="noopener" href="http://example.com/y">example.com/y</a>');
  // A quote and an ampersand inside an accepted URL, and HTML in the label: safeHref lets the URL through,
  // so the esc() around it is what keeps the attribute closed.
  assert.equal(renderTweetText(tweetItem('https://example.com/x?a=1&b="2"', 'ex.com/<x>')),
    'read this <a class="tweet-link" target="_blank" rel="noopener" href="https://example.com/x?a=1&amp;b=&quot;2&quot;">ex.com/&lt;x&gt;</a>');
});

// ── the browser path the harness cannot see ──────────────────────────────────────────────────────────

const APP = new URL('../app.js', import.meta.url);

test('BUG-023: app.js imports every lib/pure.js function it calls (the harness injects them all; the browser does not)', () => {
  const src = fs.readFileSync(APP, 'utf8');
  const m = src.match(/^import\s+\{([\s\S]*?)\}\s+from\s+'\.\/lib\/pure\.js';/m);
  assert.ok(m, 'app.js still opens with its lib/pure.js import');
  const imported = m[1].split(',').map(s => s.trim()).filter(Boolean);
  // Comments stripped (whole-line, and ` // ` trailing) so a name mentioned in prose is not a call;
  // a bare `//` is left alone because `https://` inside a template string is code. Known limit, measured
  // clean at the time of writing: only CALL syntax is seen — `.map(esc)` or `const f = safeHref` is not.
  const code = src.slice(m.index + m[0].length).split('\n')
    .map(l => (/^\s*\/\//.test(l) ? '' : l.replace(/\s\/\/\s.*$/, ''))).join('\n');
  const called = Object.keys(pure).filter(n => typeof pure[n] === 'function' && new RegExp(`\\b${n}\\s*\\(`).test(code));
  assert.ok(called.includes('esc'), 'non-vacuity: the scan sees esc() calls');
  assert.deepEqual(called.filter(n => !imported.includes(n)), []);
});

test('BUG-023: app.js parses as an ES module (the harness runs it as a script, with the import stripped)', () => {
  const src = fs.readFileSync(APP, 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug023-module-'));
  try {
    const check = (name, text) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      return spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    };
    const real = check('app.mjs', src);
    assert.equal(real.status, 0, real.stderr);
    // Non-vacuity: the same check must fail on a binding imported twice — a blank app in a browser that
    // every harness test would pass.
    assert.ok(src.includes('import { esc,'), 'the control can be built');
    const dup = check('dup.mjs', src.replace('import { esc,', 'import { esc, esc,'));
    assert.notEqual(dup.status, 0, 'a duplicated import must fail the module parse');
    assert.match(dup.stderr, /already been declared/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
