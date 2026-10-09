// [BUG-115] — the collapsed Substack card's teaser is bounded.
//
// firstParagraph() returned the author's ENTIRE opening <p>, so a card's height was whatever they
// happened to write. Measured 2026-09-09 over the 175 openers the app can actually reach (9 of 12
// sampled publications clear isSubstackFeed; the rest are 502'd by handleSubstack and never become a
// card): p50 233 characters, p90 472, p99 770, max 781 — ~17 lines on a 360px phone.
//
// The 1456-character fixtures below are DELIBERATELY beyond that observed maximum: headroom, not
// "the measured worst case". An earlier draft called them that on the strength of a run that skipped
// the isSubstackFeed gate and counted a WordPress blog the app answers with a 502.
//
// WHY THESE TESTS GO THROUGH parseSubstackFeed AS WELL AS capPreview: the [BUG-116] shape is a
// helper that is written, exported, tested and never called. Testing only the pure helper would
// leave "delete the call site in firstParagraph" killed by exactly one test. Every end-to-end case
// here re-proves the wiring, so that mutation has nowhere to hide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubstackFeed, capPreview, PREVIEW_CAP } from '../api/_substack.js';
import { esc } from '../lib/pure.js';

// A feed carrying one post whose <content:encoded> opens with `ce`.
const mk = ce =>
  '<rss><channel><generator>Substack</generator>' +
  '<item><title>T</title><link>https://x.test/p/a</link><guid>https://x.test/p/a</guid>' +
  `<pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate>` +
  `<content:encoded><![CDATA[<p>${ce}</p>]]></content:encoded></item></channel></rss>`;

const previewOf = ce => parseSubstackFeed(mk(ce))[0].preview;

// Same, but `raw` is the FULL content:encoded (already carrying its own <p> tags), for fixtures
// that need more than one paragraph.
const previewOfRaw = raw => parseSubstackFeed(
  '<rss><channel><generator>Substack</generator>' +
  '<item><title>T</title><link>https://x.test/p/a</link><guid>https://x.test/p/a</guid>' +
  '<pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate>' +
  `<content:encoded><![CDATA[${raw}]]></content:encoded></item></channel></rss>`
)[0].preview;

// Deterministic filler of an exact character length, built from whole words so the word-boundary
// search has somewhere to land. 'alpha beta gamma delta ' is 23 chars and repeats cleanly.
function words(n) {
  const unit = 'alpha beta gamma delta ';
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n).trim().padEnd(n, 'x');
}

test('[BUG-115] c1: an over-cap paragraph is bounded to PREVIEW_CAP, ellipsis included', () => {
  const long = words(1456); // ~1.9x the observed max (781) — headroom, not the measured worst case
  const out = previewOf(long);
  assert.ok(out.length <= PREVIEW_CAP,
    `preview is ${out.length} chars, over the ${PREVIEW_CAP} cap`);
  assert.notEqual(out, long, 'and it actually changed — a no-op cap must not pass this');
  assert.ok(out.endsWith('…'), 'a cut teaser signals it was cut');
});

test('[BUG-115] c2: an at-or-under-cap paragraph is returned BYTE-IDENTICAL', () => {
  // The case BUG-116's criterion 8 missed: the marker must not fire for the case it does not
  // apply to. Asserting byte-identity rather than "no ellipsis" — an author whose paragraph
  // genuinely ends in "…" must still come back untouched.
  for (const n of [1, 179, 279, PREVIEW_CAP]) {
    const s = words(n);
    assert.equal(previewOf(s), s, `a ${n}-char opener must survive unchanged`);
    assert.equal(capPreview(s), s, `capPreview(${n}) must survive unchanged`);
  }
  const endsWithEllipsis = words(200) + '…';
  assert.equal(capPreview(endsWithEllipsis), endsWithEllipsis,
    "an author's own trailing ellipsis is not a truncation marker");
});

test('[BUG-115] c2b: exactly one character over the cap IS cut (the boundary is not off by one)', () => {
  const s = words(PREVIEW_CAP + 1);
  const out = capPreview(s);
  assert.notEqual(out, s, 'one char over the cap must be truncated');
  assert.ok(out.length <= PREVIEW_CAP);
});

test('[BUG-115] c3: the cut lands on a word boundary, never mid-word', () => {
  const long = words(900);
  const out = capPreview(long);
  const body = out.slice(0, -1); // drop the '…'
  assert.ok(long.startsWith(body), 'the teaser is a true prefix of the original');
  assert.equal(long[body.length], ' ',
    'the character after the cut is a space — i.e. we stopped at a whole word');
});

test('[BUG-115] c4: a paragraph with no word boundary in range is still bounded', () => {
  // e.g. one enormous URL. Falls back to a hard cut rather than returning the whole thing.
  const url = 'https://example.test/' + 'a'.repeat(600);
  const out = capPreview(url);
  assert.ok(out.length <= PREVIEW_CAP, `no-boundary input came back ${out.length} chars`);
  assert.notEqual(out, url);
  // Closes independent-battery survivor I7: making the ellipsis conditional on a word boundary
  // left the no-boundary teaser silently truncated with no marker, and nothing redded.
  assert.ok(out.endsWith('…'), 'a hard-cut teaser must still be marked as cut');
  // The sp === 0 edge: a leading space and no other boundary in range. firstParagraph collapses and
  // trims, so the WIRED path cannot produce this — but capPreview is exported, and "unreachable" is
  // a claim that deserves a test rather than a comment. A bare "…" is not a teaser.
  const leading = ' ' + 'a'.repeat(600);
  const out2 = capPreview(leading);
  assert.ok(out2.length <= PREVIEW_CAP);
  assert.ok(out2.replace('…', '').trim().length > 0, 'a leading space must not empty the teaser');
});

test('[BUG-115] c5: no whitespace is left stranded before the ellipsis', () => {
  // Sized so a naive slice lands immediately after a space. Every n here is OVER the cap, and the
  // endsWith assertion is load-bearing: without it this test passes vacuously against a no-op cap
  // (no ellipsis is ever produced, so the whitespace pattern can never match). Caught at RED.
  for (let n = PREVIEW_CAP + 1; n < PREVIEW_CAP + 60; n++) {
    const out = capPreview(words(n));
    assert.ok(out.endsWith('…'), `n=${n} was not cut at all — the whitespace check below would be vacuous`);
    assert.ok(!/\s…$/.test(out), `n=${n} left whitespace before the ellipsis: ${JSON.stringify(out.slice(-12))}`);
  }
  // MEASURED, not assumed: with SINGLE spaces the cut never lands on whitespace, so the loop above
  // cannot reach the trailing-whitespace guard at all — mutation M8 survived it. Double spaces are
  // what make the guard load-bearing, because lastIndexOf finds the second space of the pair and the
  // slice then ends on the first. ([BUG-115] battery round 1.)
  // Three spaces, not two: survivor I4 showed that /\s+$/ -> /\s$/ passes a doubled-space fixture,
  // because stripping one space is enough there. Only a longer run distinguishes them.
  // Every whitespace CLASS, not just the ASCII space: `/\s+$/` -> `/ +$/` survived a spaces-only
  // fixture (independent battery, H4). firstParagraph collapses \s+ before this runs, so tabs and
  // newlines are unreachable through the wired path — but capPreview is exported, and c14 exists on
  // the stated principle that unreachable-through-the-wired-path is not a safety argument.
  // The separator must be a NON-SPACE whitespace char FOLLOWED BY a space. The cut lands just
  // before the last space, so it ends on whitespace only when whitespace precedes that space — a
  // tab-only fixture has no space at all, `lastIndexOf(' ')` returns -1, the boundary path never
  // runs and the strip is never reached. (My first attempt at this got it wrong and M23 survived.)
  // 'spaces' keeps a run of THREE: M14 narrows /\s+$/ to /\s$/, which strips one character, so a
  // two-space run is stripped clean and the mutation escapes. Three is the shortest run that pins it.
  for (const [label, ws] of [['spaces', '   '], ['tab+space', '\t '], ['newline+space', '\n '],
                             ['form feed+space', '\f '], ['NBSP+space', '\u00a0 ']]) {
    const src = ('alpha' + ws + 'beta' + ws + 'gamma' + ws).repeat(40);
    const out2 = capPreview(src);
    assert.ok(out2.endsWith('…'), `${label}: non-vacuity — the fixture must exceed the cap`);
    assert.ok(!/\s…$/.test(out2),
      `${label} stranded whitespace before the ellipsis: ${JSON.stringify(out2.slice(-12))}`);
  }
});

test('[BUG-115] c6: the cap is WIRED — parseSubstackFeed bounds a real 1456-char opener', () => {
  // Kills "the helper exists but firstParagraph never calls it".
  const out = previewOf(words(1456));
  assert.ok(out.length <= PREVIEW_CAP, `parseSubstackFeed returned ${out.length} chars`);
});

test('[BUG-115] c7: existing preview behaviour is untouched', () => {
  // The boilerplate skip still wins, and still wins when the REAL opener is over-cap.
  assert.equal(previewOf('Read more'), '');
  const real = words(900);
  const both = parseSubstackFeed(
    '<rss><channel><generator>Substack</generator>' +
    '<item><title>T</title><link>https://x.test/p/a</link><guid>https://x.test/p/a</guid>' +
    '<pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate>' +
    `<content:encoded><![CDATA[<p>Read more</p><p>${real}</p>]]></content:encoded></item></channel></rss>`
  )[0].preview;
  assert.ok(both.length <= PREVIEW_CAP, 'the real opener is used AND capped');
  assert.ok(real.startsWith(both.slice(0, -1)), 'and it is the real opener, not the boilerplate');
});

test('[BUG-115] c8: the cap runs on DECODED text, so no entity can be split', () => {
  // REWRITTEN after an independent audit. The original assertion was
  //     assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(esc(out)))
  // which CANNOT FAIL: esc() rewrites every bare "&" to "&amp;" first, so in esc(x) every "&" is
  // by construction the start of a known entity. Measured — it passes on esc('Tom &am'), a
  // deliberately half-cut entity, and on cap-after-esc, the very hazard it claimed to pin. That is
  // the [BUG-091] shape: a non-vacuity guard that could not fail.
  const filler  = words(600);
  const source  = `Tom &amp; Jerry said &quot;hi&quot; about &lt;b&gt; tags. ${filler}`;
  const decoded = `Tom & Jerry said "hi" about <b> tags. ${filler}`;
  const out = previewOf(source);

  assert.ok(out.includes('&'), 'non-vacuity: the fixture really does carry an ampersand');
  assert.ok(out.length <= PREVIEW_CAP);

  // The stored preview is DECODED plain text. An entity sequence in it means the cap ran on
  // ESCAPED text — the ordering hazard, and what splits "&amp;" into a dangling "&am".
  assert.ok(!/&[a-z]+;|&#\d+;/i.test(out),
    `preview carries an escaped entity, so the cap ran after esc(): ${JSON.stringify(out.slice(-30))}`);

  // ...and it is a clean PREFIX of the decoded paragraph, so the cut fell between characters of
  // the real text rather than inside any construct.
  assert.ok(decoded.startsWith(out.slice(0, -1)),
    'the teaser is not a prefix of the decoded paragraph');

  // CONTROL. Without this the two assertions above are claims, not measurements: capping the
  // ESCAPED text (the wrong order) must actually be DETECTED, or they pin nothing.
  const wrongOrder = capPreview(esc(decoded));
  assert.ok(/&[a-z]+;/i.test(wrongOrder),
    'control failed: cap-after-esc produced no entity, so the check above cannot detect it');

  // A SPACELESS fixture, because the two above are not enough. Capping the raw text at a word
  // BOUNDARY happens to be safe (the cut retreats to a space, before any entity), so a spaced
  // fixture cannot catch cap-before-decode — mutation M16 survived exactly that way. With no space
  // in range the cut is hard, and it can land inside "&amp;" leaving a dangling "&am".
  const tightSrc = 'a'.repeat(276) + '&amp; more prose follows here to exceed the cap comfortably';
  const tightDec = 'a'.repeat(276) + '& more prose follows here to exceed the cap comfortably';
  const tight = previewOf(tightSrc);
  assert.ok(tightDec.startsWith(tight.slice(0, -1)),
    `spaceless teaser is not a prefix of the decoded paragraph: ${JSON.stringify(tight.slice(-12))}`);
});

test('[BUG-115] c11: an EMPTY first paragraph is skipped, not returned as the teaser', () => {
  // Closes independent-battery survivor I2: dropping the `t &&` term from firstParagraph's guard.
  // Without it an empty leading <p> RETURNS '' and the loop never reaches the real opener, so a
  // post silently loses its teaser. No empty-<p> fixture existed anywhere in the repo.
  assert.equal(previewOfRaw('<p></p><p>The real opener.</p>'), 'The real opener.');
  assert.equal(previewOfRaw('<p>   </p><p>The real opener.</p>'), 'The real opener.');
});

// ── Two gaps found by PREDICTING each mutation's killer before running the battery ────────────────

test('[BUG-115] c9: PREVIEW_CAP is exactly 280 — the decided value, not whatever the constant says', () => {
  // 280 is a product decision (Asli, 2026-09-09, chosen off the measured distribution); changing it
  // is a decision, not a refactor.
  //
  // An earlier version of this comment claimed raising PREVIEW_CAP to 2800 "would stay green
  // everywhere". That is FALSE — c1, c3, c4, c5 and c10 kill it too, because a fixture LARGER than
  // the raised cap comes back uncut and their absolute assertions fail. What is true, and why this
  // test still earns its place, is narrower: those killers are fixture-size dependent and stop
  // killing the moment a fixture is smaller than the raised cap. This one is not. (An independent
  // battery measured 280 -> 279 killed by c9 ALONE.)
  assert.equal(PREVIEW_CAP, 280);
});

test('[BUG-115] c10: the teaser is cut near the cap, not back at the first space', () => {
  // Kills lastIndexOf(' ') → indexOf(' '), which yields a one-word teaser ("alpha…") and passes
  // every word-boundary assertion in c3 — the cut IS on a boundary, just a useless one. Nothing
  // else in this file pins how much text survives.
  // The fixture's longest word is 5 characters, so a correct cut lands within ~6 of the slice end.
  const out = capPreview(words(900));
  assert.ok(out.length >= PREVIEW_CAP - 20,
    `teaser collapsed to ${out.length} chars — the cut ran back too far`);
});

// ── Round 2: defects found by an INDEPENDENT correctness review, both confirmed by measurement ───

test('[BUG-115] c12: a far-back word boundary is REJECTED — the teaser is never starved', () => {
  // Measured on a live Chinese publication: lastIndexOf(' ') accepts ANY space in range, so a
  // 365-character opener returned a 58-character teaser, and an opener whose SECOND character is a
  // space returned TWO characters. "《 ", "— " and "「 " are ordinary CJK and em-dash prose, not
  // adversarial input. Below the floor a hard cut shows far more of the post.
  const cases = [
    ['CJK quote opener', '《 ' + '人沦为工具的工具每一种工具都嵌入了意识形态偏向'.repeat(20)],
    ['em-dash opener',   '— ' + '中'.repeat(400)],
    ['single early word','A ' + 'x'.repeat(400)],
    ['one long URL',     'Quick housekeeping note before we begin. https://example.test/' + 'a'.repeat(500)],
  ];
  for (const [label, src] of cases) {
    const out = capPreview(src);
    assert.ok(out.length >= PREVIEW_CAP - 20,
      `${label}: teaser starved to ${out.length} of ${PREVIEW_CAP}`);
    assert.ok(out.length <= PREVIEW_CAP, `${label}: teaser overflowed to ${out.length}`);
  }
  // THE MID-BAND CASE. The four fixtures above sit far below any plausible floor and the English
  // one far above it, so between them they pin only the extremes — lowering BOUNDARY_FLOOR from
  // 0.6 to 0.3 starved this input to 112 characters with the whole suite green (found by an
  // independent battery, H3). This is the hazard c9 closes for PREVIEW_CAP; the floor is a product
  // decision too, and needs the same treatment.
  const midBand = 'Quick housekeeping note before we begin, and then a link that runs on for ages ' +
                  'without any spaces at all in it. https://example.test/' + 'a'.repeat(500);
  assert.equal(midBand.slice(0, PREVIEW_CAP - 1).lastIndexOf(' '), 111,
    'fixture drifted: the boundary must sit in the band between a 0.3 and a 0.6 floor');
  assert.ok(capPreview(midBand).length >= PREVIEW_CAP - 20,
    `mid-band boundary was accepted and starved the teaser to ${capPreview(midBand).length}`);

  // Non-vacuity: an ordinary English opener must STILL take its word boundary rather than hard-cut.
  const english = capPreview(words(900));
  assert.ok(english.length >= PREVIEW_CAP - 20);
  assert.equal(words(900)[english.length - 1], ' ',
    'an English teaser still ends on a whole word, so the floor did not disable the boundary search');
});

test('[BUG-115] c13: the cut never splits a code point', () => {
  // String.slice cuts UTF-16 units, severing a surrogate pair on the hard-cut path. The damage is
  // NOT cosmetic: the tail encodes to U+FFFD, and the ill-formed string survives JSON round-tripping
  // into an archived item, where Postgres refuses the whole state row — "invalid input syntax for
  // type json", verified against the dev database — wedging that account's sync. The UNCAPPED code
  // returned the paragraph whole and always well-formed, so this hazard was introduced by the cap.
  for (const [label, src] of [
    ['emoji run',   '🎉'.repeat(300)],
    ['CJK Ext-B',   '\u{2000B}'.repeat(300)],
    ['ZWJ family',  '👩‍👩‍👧‍👦'.repeat(60)],
    ['flags',       '🇹🇷'.repeat(120)],
    ['latin+emoji', 'a'.repeat(278) + '🎉' + 'b'.repeat(100)],
  ]) {
    const out = capPreview(src);
    assert.ok(out.isWellFormed(), `${label}: produced a lone surrogate (renders as U+FFFD)`);
    assert.ok(out.length <= PREVIEW_CAP, `${label}: ${out.length} chars`);
    assert.ok(!Buffer.from(out, 'utf8').includes(Buffer.from('\uFFFD', 'utf8')),
      `${label}: encodes to a replacement character`);
  }
  // And end-to-end, since the wire and the archive are what actually carry it.
  const wired = previewOf('🎉'.repeat(300));
  assert.ok(wired.isWellFormed(), 'the parsed preview reached the caller ill-formed');
  assert.equal(JSON.parse(JSON.stringify(wired)), wired, 'must survive the JSON round trip intact');
});

test('[BUG-115] c14: the exported helper is safe on input firstParagraph would never send', () => {
  // capPreview is exported, so "unreachable through the wired path" is not a safety argument.
  assert.equal(capPreview(42), '');                    // was: TypeError, t.slice is not a function
  assert.equal(capPreview(['x'.repeat(400)]), '');     // was: returned the ARRAY unchanged
  assert.equal(capPreview(null), '');
  assert.equal(capPreview(undefined), '');
  // A degenerate cap must not INVERT (String.slice(0, -1) counted from the END and returned MORE
  // than asked) and must not go UNBOUNDED (a non-finite cap makes every comparison false, which
  // would return the whole paragraph — the exact bug this function exists to fix).
  const long = 'hello world this is a long enough paragraph to exceed any small cap ' + words(400);
  for (const bad of [0, -5, NaN, Infinity, undefined === null ? 0 : Number('x')]) {
    assert.equal(capPreview(long, bad), '', `cap=${String(bad)} must yield no teaser, not a bad one`);
  }
  // Non-vacuity: a SANE explicit cap still works, so the guard above is not swallowing everything.
  assert.ok(capPreview(long, 50).length <= 50);
  assert.ok(capPreview(long, 50).endsWith('…'));
});
