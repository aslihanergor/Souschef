import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseSubstackFeed, parseSubstackChannel, substackFeedUrl, isTransient,
  extractSubstackArticle, isPaywalled, stripSubstackAppendix,
} from '../api/_substack.js';

const here = dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(join(here, 'fixtures', 'substack-feed.xml'), 'utf8');
const freeHtml = readFileSync(join(here, 'fixtures', 'substack-post-free.html'), 'utf8');
const paidHtml = readFileSync(join(here, 'fixtures', 'substack-post-paid.html'), 'utf8');

// ── parseSubstackChannel (resolution) ─────────────────────────────────────────

test('parseSubstackChannel pulls the publication name + avatar (not the item titles)', () => {
  const c = parseSubstackChannel(xml);
  assert.equal(c.name, 'Slow Boring');
  assert.equal(c.avatarUrl, 'https://substackcdn.com/image/slowboring-256x256.png');
});

test('parseSubstackChannel returns null on empty/invalid input', () => {
  assert.equal(parseSubstackChannel(''), null);
  assert.equal(parseSubstackChannel(null), null);
});

// ── parseSubstackFeed (feed) ──────────────────────────────────────────────────

test('parseSubstackFeed maps items to the shared shape', () => {
  const items = parseSubstackFeed(xml);
  assert.equal(items.length, 2);
  const a = items[0];
  assert.equal(a.title, 'Where key battleground races stand four months before the midterm elections');
  assert.equal(a.subtitle, 'There is plenty of time before November, but conditions are telling.');
  assert.equal(a.url, 'https://www.slowboring.com/p/battleground-races');
  assert.equal(a.id, 'https://www.slowboring.com/p/battleground-races');
  assert.equal(a.author, 'Halina Bennet');
  assert.equal(a.published, '2026-07-06T22:00:28.000Z'); // RFC-822 → ISO
});

test('parseSubstackFeed ignores tags inside content:encoded (no decoy title leaks in)', () => {
  const items = parseSubstackFeed(xml);
  assert.ok(items.every(i => i.title !== 'NOT THE TITLE'));
});

test('parseSubstackFeed decodes HTML entities in the subtitle', () => {
  const items = parseSubstackFeed(xml);
  assert.equal(items[1].subtitle, 'Socialism is not the answer, but the status quo isn’t working.');
});

test('parseSubstackFeed extracts a preview (first paragraph text) for the collapsed card', () => {
  const items = parseSubstackFeed(xml);
  assert.equal(items[1].preview, 'Another body.');
  assert.ok(items[0].preview.startsWith('Long article body with a link'));
});

test('parseSubstackFeed extracts the cover image from <enclosure> (https only, empty when absent)', () => {
  const items = parseSubstackFeed(xml);
  assert.equal(items[0].cover, 'https://substackcdn.com/image/battleground-cover.jpg');
  assert.equal(items[1].cover, ''); // second fixture item has no enclosure
  // non-https enclosure is rejected (mixed content)
  const httpFeed = '<rss><channel><generator>Substack</generator>' +
    '<item><title>T</title><link>https://x.test/p/a</link><guid>https://x.test/p/a</guid>' +
    '<pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate>' +
    '<enclosure url="http://cdn.test/x.jpg" type="image/jpeg"/></item></channel></rss>';
  assert.equal(parseSubstackFeed(httpFeed)[0].cover, '');
});

test('parseSubstackFeed skips the Substack "Read more" boilerplate when building the preview', () => {
  const mk = ce =>
    '<rss><channel><generator>Substack</generator>' +
    '<item><title>T</title><link>https://x.test/p/a</link><guid>https://x.test/p/a</guid>' +
    '<pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate>' +
    `<content:encoded><![CDATA[${ce}]]></content:encoded></item></channel></rss>`;
  // discussion/thread posts carry only a "Read more" link — don't surface it as the teaser
  assert.equal(parseSubstackFeed(mk('<p>Read more</p>'))[0].preview, '');
  // boilerplate followed by a real paragraph → use the real one
  assert.equal(parseSubstackFeed(mk('<p>Read more</p><p>The real opener.</p>'))[0].preview, 'The real opener.');
});

// ── reader: article extraction + paywall detection (TASK-059) ─────────────────

test('extractSubstackArticle returns the article body, not the page chrome', () => {
  const art = extractSubstackArticle(freeHtml);
  assert.ok(art.includes('opening paragraph'));
  assert.ok(art.includes('concludes the piece'));
  assert.ok(art.includes('substackcdn.com/image/hero.png'));
  assert.ok(!art.includes('Subscribe now')); // footer widget lives outside available-content
});

test('extractSubstackArticle on a paywalled page returns only the free preview (gate excluded)', () => {
  const art = extractSubstackArticle(paidHtml);
  assert.ok(art.includes('free preview paragraph'));
  // the inline gate sits after available-content — its element + CTA copy must be excluded
  assert.ok(!art.includes('data-testid'));
  assert.ok(!art.includes('Keep reading'));
});

test('extractSubstackArticle returns null when there is no article container', () => {
  assert.equal(extractSubstackArticle('<html><body><p>nope</p></body></html>'), null);
  assert.equal(extractSubstackArticle(''), null);
  assert.equal(extractSubstackArticle(null), null);
});

test('isPaywalled detects the inline gate, ignoring footer subscribe widgets', () => {
  assert.equal(isPaywalled(paidHtml), true);
  assert.equal(isPaywalled(freeHtml), false); // footer paywall-cta must NOT count
});

// ── stripSubstackAppendix: prune curated "Other Reading…/On X…" roundup sections (BUG-012) ──

const roundup =
  '<div class="available-content">' +
  '<p>Intro summary of the week.</p>' +
  '<h2><span>Caught My Eye…</span></h2><p>Real analysis paragraph worth reading.</p>' +
  '<h2><span>Learn With My Friends…</span></h2><p>A short podcast plug.</p>' +
  '<h2><span>Other Reading…</span></h2><ul><li><a href="https://nyt.com/x">An NYT link</a></li></ul>' +
  '<h2><span>On X…</span></h2>' +
  '<div data-attrs="{&quot;full_text&quot;:&quot;a>b tweet json&quot;}" class="twitter-embed">' +
  '<a href="https://x.com/u/1">handle inline tweet text 2.8K Replies</a></div>' +
  '</div>';

test('stripSubstackAppendix removes the "Other Reading…" and "On X…" sections (and their embeds)', () => {
  const out = stripSubstackAppendix(roundup);
  assert.ok(!out.includes('Other Reading'), 'Other Reading heading gone');
  assert.ok(!out.includes('An NYT link'), 'Other Reading links gone');
  assert.ok(!out.includes('On X'), 'On X heading gone');
  assert.ok(!out.includes('twitter-embed') && !out.includes('data-attrs'), 'tweet embed gone');
  assert.ok(!out.includes('inline tweet text'), 'tweet fallback text gone');
});

test('stripSubstackAppendix keeps the intro and genuine content sections', () => {
  const out = stripSubstackAppendix(roundup);
  assert.ok(out.includes('Intro summary of the week'), 'intro kept');
  assert.ok(out.includes('Caught My Eye') && out.includes('Real analysis paragraph'), 'real section kept');
  assert.ok(out.includes('Learn With My Friends') && out.includes('podcast plug'), 'non-marker section kept');
});

test('stripSubstackAppendix only matches a marker at the heading start (no false positives)', () => {
  const essay = '<h2><span>On Xenon and other noble gases</span></h2><p>chemistry.</p>';
  assert.equal(stripSubstackAppendix(essay), essay); // "On Xenon" must not match "On X"
  assert.equal(stripSubstackAppendix('<p>a plain essay, no headings</p>'), '<p>a plain essay, no headings</p>');
});

// ── substackFeedUrl (input normalisation) ─────────────────────────────────────

test('substackFeedUrl handles subdomains, custom domains, URLs, and bare names', () => {
  assert.equal(substackFeedUrl('astralcodexten.substack.com'), 'https://astralcodexten.substack.com/feed');
  assert.equal(substackFeedUrl('www.honest-broker.com'), 'https://www.honest-broker.com/feed');
  assert.equal(substackFeedUrl('https://www.honest-broker.com/p/some-post'), 'https://www.honest-broker.com/feed');
  assert.equal(substackFeedUrl('noahpinion'), 'https://noahpinion.substack.com/feed'); // bare word → subdomain
  assert.equal(substackFeedUrl(''), null);
});

// SSRF guard (BUG-020 vector 2): the resolver fetched substackFeedUrl(userInput) with no IP/localhost
// guard, so 169.254.169.254 (cloud metadata) was fetchable. The guard now lives in substackFeedUrl,
// so both the resolver and the feed handler inherit it.
test('substackFeedUrl rejects IP literals and localhost as a HOST', () => {
  for (const bad of ['169.254.169.254', '10.0.0.1', '127.0.0.1', '192.168.0.1', 'http://localhost/feed', 'localhost.', '[::1]']) {
    assert.equal(substackFeedUrl(bad), null, bad);
  }
});

// A bare word (no dots) is a Substack subdomain by construction, so it is SAFE and NOT null — even
// the word "localhost", which becomes localhost.substack.com (Substack's public servers), not the
// local machine. Only a dotted/URL host form can name a real loopback, and those are rejected above.
test('substackFeedUrl treats a bare word as a *.substack.com subdomain (incl. "localhost")', () => {
  assert.equal(substackFeedUrl('localhost'), 'https://localhost.substack.com/feed');
  assert.equal(substackFeedUrl('noahpinion'), 'https://noahpinion.substack.com/feed');
});

// The normalisation case: 127.1 is not a dotted-quad literally, but new URL() expands it to
// 127.0.0.1. Validating the normalised hostname is what closes it (and decimal/octal forms too).
test('substackFeedUrl rejects short-form IPs that normalise to a loopback', () => {
  assert.equal(substackFeedUrl('127.1'), null);
  assert.equal(substackFeedUrl('http://127.1/feed'), null);
});

// ── isTransient (resilience classifier) ───────────────────────────────────────

test('isTransient: 5xx retryable, 4xx (e.g. 404 no such publication) is a real answer', () => {
  assert.equal(isTransient(500), true);
  assert.equal(isTransient(503), true);
  assert.equal(isTransient(404), false);
  assert.equal(isTransient(429), false);
});
