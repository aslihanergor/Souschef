import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml } from '../api/_sanitize.js';

// The reader injects remote Substack HTML via innerHTML, so this runs SERVER-SIDE and is the
// trust boundary. Allowlist tags/attrs; drop everything else. (TASK-059)

// ── allowed content is preserved ──────────────────────────────────────────────

test('keeps allowed formatting tags as-is', () => {
  assert.equal(
    sanitizeHtml('<p>Hi <strong>bold</strong> and <em>em</em></p>'),
    '<p>Hi <strong>bold</strong> and <em>em</em></p>',
  );
});

test('keeps headings, lists, blockquote', () => {
  assert.equal(
    sanitizeHtml('<h2>T</h2><ul><li>a</li><li>b</li></ul><blockquote>q</blockquote>'),
    '<h2>T</h2><ul><li>a</li><li>b</li></ul><blockquote>q</blockquote>',
  );
});

test('strips all attributes from ordinary allowed tags', () => {
  assert.equal(sanitizeHtml('<p dir="auto" class="body">hi</p>'), '<p>hi</p>');
});

// ── dangerous blocks removed with their content ───────────────────────────────

test('removes <script> and its content', () => {
  assert.equal(sanitizeHtml('<p>a</p><script>alert(1)</script><p>b</p>'), '<p>a</p><p>b</p>');
});

test('removes <style> and <iframe> with content', () => {
  assert.equal(sanitizeHtml('<style>.x{color:red}</style><p>hi</p>'), '<p>hi</p>');
  assert.equal(sanitizeHtml('<iframe src="//evil"></iframe><p>ok</p>'), '<p>ok</p>');
});

test('removes HTML comments', () => {
  assert.equal(sanitizeHtml('<!-- secret -->text'), 'text');
});

// ── event handlers / unsafe urls neutralised ──────────────────────────────────

test('strips on* event-handler attributes', () => {
  assert.equal(sanitizeHtml('<p onclick="steal()">hi</p>'), '<p>hi</p>');
});

test('a with javascript: href becomes a bare (non-clickable) anchor', () => {
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
});

test('a with a fragment/relative href is not linked (bare anchor)', () => {
  assert.equal(sanitizeHtml('<a href="#footnote-1">1</a>'), '<a>1</a>');
  assert.equal(sanitizeHtml('<a href="/relative">y</a>'), '<a>y</a>');
});

test('a with a safe http(s) href is kept and hardened', () => {
  assert.equal(
    sanitizeHtml('<a href="https://ex.com/p">y</a>'),
    '<a href="https://ex.com/p" target="_blank" rel="noopener nofollow">y</a>',
  );
});

// ── images: https only, alt kept, lazy ────────────────────────────────────────

test('keeps https img with alt, adds lazy loading, drops other attrs', () => {
  assert.equal(
    sanitizeHtml('<img src="https://cdn/x.png" alt="cap" width="9" srcset="...">'),
    '<img src="https://cdn/x.png" alt="cap" loading="lazy">',
  );
});

test('drops non-https / data: images entirely', () => {
  assert.equal(sanitizeHtml('<img src="http://cdn/x.png">'), '');
  assert.equal(sanitizeHtml('<img src="data:image/png;base64,AAAA">'), '');
});

test('escapes quotes in alt text', () => {
  assert.equal(
    sanitizeHtml('<img src="https://cdn/x.png" alt=\'a "quote"\'>'),
    '<img src="https://cdn/x.png" alt="a &quot;quote&quot;" loading="lazy">',
  );
});

// ── unknown tags unwrapped (content kept) ─────────────────────────────────────

test('unwraps unknown wrapper tags but keeps their text', () => {
  assert.equal(sanitizeHtml('<div class="c"><span>hi</span> there</div>'), 'hi there');
});

test('preserves a real Substack figure block', () => {
  const input =
    '<figure><a href="https://substackcdn.com/i.png"><div class="inset">' +
    '<img src="https://substackcdn.com/i.png" alt="A chart"></div></a>' +
    '<figcaption>Source: BLS</figcaption></figure>';
  assert.equal(
    sanitizeHtml(input),
    '<figure><a href="https://substackcdn.com/i.png" target="_blank" rel="noopener nofollow">' +
    '<img src="https://substackcdn.com/i.png" alt="A chart" loading="lazy"></a>' +
    '<figcaption>Source: BLS</figcaption></figure>',
  );
});

// ── misc / hardening ──────────────────────────────────────────────────────────

test('empty / non-string input yields empty string', () => {
  assert.equal(sanitizeHtml(''), '');
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(undefined), '');
});

// A '>' inside a quoted attribute value must not truncate the tag and leak its tail as visible
// text — this is what made Substack tweet-embed JSON (data-attrs="{…>…}") spill onto the page.
// (BUG-012)
test('a ">" inside a quoted attribute cannot truncate the tag or leak its tail', () => {
  assert.equal(sanitizeHtml('<div data-x="a>b">keep</div>'), 'keep');
  assert.equal(sanitizeHtml('<p title="x>y">hi</p>'), '<p>hi</p>');
  assert.equal(
    sanitizeHtml('<a href="https://ex.com/p" data-j="{&quot;t&quot;:&quot;a>b&quot;}">link</a>'),
    '<a href="https://ex.com/p" target="_blank" rel="noopener nofollow">link</a>',
  );
});

// ── malformed tags must not survive as markup (BUG-018) ──────────────────────
//
// Two weaknesses combine, neither dangerous alone: the tokenizer only matches tags whose quotes
// balance (so a malformed tag is never allow-listed AND never removed — it survives as text), and
// the on* stripper requires whitespace before "on", which a quote does not provide. A quote-glued
// handler therefore reaches body.innerHTML intact.
//
// The structural invariant asserted here is "no '<' in the output begins a tag carrying an event
// handler" — NOT "the string 'onerror=' is absent". Once the '<' is escaped the handler text is
// inert and legitimately survives as visible text (&lt;img src="x"onerror=…), which is the correct
// outcome: dropping content silently is how BUG-012 went unnoticed.
//
// This invariant is necessary but the interesting proof is that the browser EXECUTES the pre-fix
// output and does not execute the post-fix output. That was verified live at body.innerHTML in
// Chrome, not here — see the task's Verification section (pre: onerror fired, title changed; post:
// 0 handlers, 0 elements). A regex assertion alone would be the exact "validate the probe" trap:
// it proves a string property, not that a browser runs anything. The first payload below is the
// vector confirmed to execute; the rest are structural variants that must also fail closed.

const LIVE_HANDLER = /<[^>]*\bon\w+\s*=/i;

const MALFORMED = [
  // Browser-confirmed executing vector: the trailing stray quote makes the quote count odd so the
  // tokenizer fails, "onerror is quote-glued so step 4 misses it, and onerror="…" is cleanly quoted
  // so the handler body is valid JS. This one fired at the sink pre-fix.
  ['img, confirmed-executing (trailing stray quote)', `<img src="x"onerror="parent.x=1"'>`],
  // Structural variants — unbalanced + quote-glued, must also fail closed.
  ['img, quote-glued onerror',        '<img src="x"onerror="alert(1)>'],
  ['img, trailing text after',        '<img src="x"onerror="alert(1)>text'],
  ['anchor, quote-glued onclick',     '<a href="x"onclick="alert(1)>click</a>'],
  ['img with a legitimate https src', '<img src="https://e.com/a.png"onerror="alert(1)>'],
  ['p, quote-glued onmouseover',      '<p title="a"onmouseover="alert(1)>hover'],
  ['unknown tag, quote-glued onload', '<div title="q"onload="alert(1)>x'],
];

for (const [label, payload] of MALFORMED) {
  test(`malformed tag cannot survive as a handler-bearing tag: ${label}`, () => {
    const out = sanitizeHtml(payload);
    assert.doesNotMatch(out, LIVE_HANDLER, `payload survived as markup: ${JSON.stringify(out)}`);
  });
}

test('an unparseable tag is escaped to visible text, not dropped', () => {
  // The user should SEE the broken markup rather than have it silently vanish.
  assert.equal(sanitizeHtml('<img src="x"onerror="alert(1)>'), '&lt;img src="x"onerror="alert(1)>');
});

// The scan tries the tag regex anchored at each '<'. A regex that matches LATER in the string must
// count as a non-match at this position, or the scanner would skip over the malformed tag and
// resume inside it.
test('a malformed tag followed by a well-formed one: only the good tag survives', () => {
  const out = sanitizeHtml('<img src="x"onerror="alert(1)> then <strong>bold</strong>');
  assert.doesNotMatch(out, LIVE_HANDLER);
  assert.match(out, /<strong>bold<\/strong>/);
});

test('escaping a stray "<" does not double-escape existing entities', () => {
  assert.equal(sanitizeHtml('<p>a &amp; b</p>'), '<p>a &amp; b</p>');
  assert.equal(sanitizeHtml('<p>5 &lt; 6 &amp;&amp; 7 &gt; 6</p>'), '<p>5 &lt; 6 &amp;&amp; 7 &gt; 6</p>');
});
