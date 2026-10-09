// Server-side Substack client (TASK-022). Substack publishes a keyless RSS 2.0 feed per
// publication at https://<host>/feed — reachable from Vercel (Cloudflare-fronted, unlike
// Reddit, which IP-blocks datacenter ranges). Pure parsers map the feed into Focus's shared
// item shape. The leading underscore keeps Vercel from treating this as a routable endpoint.

import { isSafePublicHost } from './_hosts.js';

const UA = 'web:focus-app:v1.0 (finishable feed)';
const SUB_TRIES = 2;      // 1 initial + 1 retry on a transient failure
const BACKOFF_MS = 300;
const TIMEOUT_MS = 6000;

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// Substack is a single host with no fallback. 5xx/network are transient (retry); 4xx are real
// answers — 404 = no such publication, so retrying just wastes the deadline. (Cf. _youtube.js.)
export function isTransient(status) {
  return status >= 500;
}

// Normalise whatever the user typed into a feed URL, or null if unusable.
//   • bare word            → <word>.substack.com/feed  (assume a substack subdomain)
//   • host / custom domain → https://<host>/feed
//   • any page URL         → https://<host>/feed        (host extracted)
export function substackFeedUrl(input) {
  const s = (input || '').trim();
  if (!s) return null;
  if (/^[\w-]+$/.test(s)) return `https://${s}.substack.com/feed`; // bare word → *.substack.com (safe by construction)
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    // Guard on the NORMALISED hostname so IP-literals / localhost — and short forms like 127.1 that
    // new URL() expands to 127.0.0.1 — are all rejected before we ever fetch it (SSRF, BUG-020).
    if (!isSafePublicHost(u.hostname)) return null;
    return `https://${u.hostname}/feed`;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetchImpl, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a publication's RSS, retrying a transient failure once. Returns the raw XML, or null
// when the feed is missing (4xx) or every attempt fails. Injectable for tests.
export async function fetchSubstackXml(feedUrl, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  for (let i = 0; i < SUB_TRIES; i++) {
    if (i > 0) await sleep(BACKOFF_MS * i);
    try {
      const r = await fetchWithTimeout(fetchImpl, feedUrl);
      if (r.ok) return r.text();
      if (!isTransient(r.status)) return null; // 404 etc. — real "no feed here"
    } catch {
      // network error / timeout — fall through to the retry
    }
  }
  return null;
}

// Fetch a Substack post page's HTML for the reader (TASK-059). Same UA / timeout / transient-retry
// as the feed fetch — a page GET is the same kind of request. Returns the HTML text, or null.
export const fetchSubstackHtml = fetchSubstackXml;

function decodeXml(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Extract clean text from an RSS field value: strip a CDATA wrapper if present, then decode
// entities (Substack leaves things like &#8217; as literal text inside CDATA).
function text(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  const m = s.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (m) s = m[1];
  return decodeXml(s).trim();
}

// True if this XML is a Substack feed — used by the resolver to reject non-Substack hosts.
export function isSubstackFeed(xml) {
  return typeof xml === 'string' && /<generator>\s*Substack/i.test(xml);
}

// Channel header → { name, avatarUrl } | null. Reads the first <title> (the publication's,
// before any <item>) and the channel <image><url> (the publication avatar).
export function parseSubstackChannel(xml) {
  if (!xml) return null;
  const head = String(xml).split('<item>')[0]; // channel header, before the first item
  const name = text((head.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
  if (!name) return null;
  const avatarUrl = text((head.match(/<image>[\s\S]*?<url>([\s\S]*?)<\/url>/) || [])[1]) || null;
  return { name, avatarUrl };
}

// The collapsed card's teaser is bounded here, at parse time, so every consumer inherits the bound:
// the feed payload, the rendered card, and — via toArchiveItem's spread — what an archived post
// pushes into the 256KB-capped state row. ([BUG-115])
//
// 280 characters INCLUDING the ellipsis, cut at the last word boundary. Measured 2026-09-09 over the
// 175 openers the app can actually reach (feeds without a <generator>Substack tag are 502'd upstream
// by handleSubstack, so they never become a card): p50 233, p90 472, max 781 — the tail, which is the
// whole problem at ~17 lines on a phone, collapses to ~6.
//
// Input at or under the cap is returned BYTE-IDENTICAL and unmarked. That is a property, not an
// optimisation: an author whose paragraph genuinely ends in "…" must not be reported as truncated.
export const PREVIEW_CAP = 280;

// A word boundary is only worth taking if it keeps most of the cap. Without a floor,
// lastIndexOf(' ') accepts ANY space in range however early, so text where spaces are sparse
// starves: measured on a live Chinese publication, a 365-character opener yielded a 58-character
// teaser, and any paragraph whose second character is a space (「 , — , 《 — ordinary CJK and
// em-dash prose) yielded TWO characters. Below the floor a hard cut shows far more of the post.
const BOUNDARY_FLOOR = 0.6;

export function capPreview(s, cap = PREVIEW_CAP) {
  if (typeof s !== 'string') return ''; // exported helper: a non-string is not a short string
  // A cap below one character cannot hold even the ellipsis, and a non-finite one would make every
  // comparison below false and return the paragraph UNBOUNDED — the bug this function exists to fix.
  if (!Number.isFinite(cap) || cap < 1) return '';
  if (s.length <= cap) return s;
  const room = cap - 1;                 // reserve one unit for the ellipsis

  // Accumulate by CODE POINT, not by String.slice's UTF-16 code unit. Slicing units severs a
  // surrogate pair on the hard-cut path, and the damage is not cosmetic: the tail encodes to U+FFFD
  // (the reader sees a replacement glyph before the ellipsis) AND the string is ill-formed, which
  // survives JSON round-tripping to the client and into an archived item. Postgres then REFUSES the
  // whole state row — 'invalid input syntax for type json', verified against the dev database — so a
  // single archived emoji post would wedge that account's sync until the entry was removed.
  let slice = '';
  for (const ch of s) {
    if (slice.length + ch.length > room) break;
    slice += ch;
  }

  const sp = slice.lastIndexOf(' ');
  const cut = sp >= Math.floor(room * BOUNDARY_FLOOR) ? slice.slice(0, sp) : slice;
  return cut.replace(/\s+$/, '') + '…';
}

// The plain text of the first non-empty <p> in the article HTML — the collapsed card's teaser
// paragraph ("one paragraph → …read more", TASK-059). Inner tags are stripped and entities decoded.
function firstParagraph(contentEncoded) {
  if (!contentEncoded) return '';
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(contentEncoded))) {
    const t = text(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    // skip empties and Substack's "Read more" boilerplate (all a thread/discussion post carries)
    if (t && !/^read more$/i.test(t)) return capPreview(t);
  }
  return '';
}

// Feed XML → [{ id, title, subtitle, url, author, published, preview }]. The full <content:encoded>
// article HTML is kept out of the item (the feed stays light — the reader lazily fetches the full
// post), but its first paragraph is distilled into `preview` for the collapsed card. Field parsing
// still runs on the content-stripped head so decoy tags in the body can't leak into title/etc.
export function parseSubstackFeed(xml) {
  const out = [];
  const items = (xml || '').match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const raw of items) {
    const ce = ((raw.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/) || [])[1] || '')
      .replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
    const head = raw.replace(/<content:encoded>[\s\S]*?<\/content:encoded>/, '');
    const title = text((head.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    if (!title) continue;
    const url = text((head.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    const guid = text((head.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1]);
    const subtitle = text((head.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
    const author = text((head.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/) || [])[1]);
    const pub = ((head.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim();
    const d = new Date(pub);
    const published = Number.isNaN(d.getTime()) ? pub : d.toISOString();
    // Post cover image lives in <enclosure type="image/…" url="…">. https only (mixed content).
    const encTag = (head.match(/<enclosure[^>]*type="image\/[^"]*"[^>]*>/i) || [])[0] || '';
    const encUrl = text((encTag.match(/url="([^"]*)"/) || [])[1]);
    const cover = /^https:\/\//i.test(encUrl) ? encUrl : '';
    out.push({ id: guid || url, title, subtitle, url, author, published, preview: firstParagraph(ce), cover });
  }
  return out;
}

// A Substack post page embeds the article in <div class="available-content"><div class="body
// markup">…. Return that container's HTML (still raw — the caller sanitises), or null when the
// page has no such container. Bracket-matches nested <div>s so the whole article is captured and
// page chrome (footer, comments, the paywall gate) is excluded. (TASK-059)
export function extractSubstackArticle(html) {
  if (!html || typeof html !== 'string') return null;
  const k = html.indexOf('available-content');
  if (k < 0) return null;
  const open = html.lastIndexOf('<div', k);
  if (open < 0) return null;
  const re = /<div\b|<\/div\s*>/gi;
  re.lastIndex = open;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') {
      if (--depth === 0) return html.slice(open, m.index + m[0].length);
    } else {
      depth++;
    }
  }
  return null; // unbalanced markup — treat as no article
}

// Roundup-style Substack posts (e.g. "What I Read This Week") append curated sections — a list of
// links under "Other Reading…" and a wall of tweet embeds under "On X…" — that read as noise in the
// in-app reader. Strip any heading-delimited section whose heading text matches a known marker,
// taking everything from that heading up to the next heading (or the end) with it, so the embeds
// inside go too. (BUG-012)
const APPENDIX_HEADINGS = [/^other reading\b/i, /^on x\b/i];

export function stripSubstackAppendix(html) {
  if (!html || typeof html !== 'string') return html || '';
  // Index every heading with its visible text (inner tags stripped). Heading open tags carry no
  // '>'-bearing attributes, so a plain scan is safe here.
  const heads = [];
  const re = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    heads.push({ start: m.index, label });
  }
  if (!heads.length) return html;
  // A matched section spans from its heading to the next heading (or the end) — that range carries
  // the section's links/embeds out with it.
  let out = '', cursor = 0;
  for (let i = 0; i < heads.length; i++) {
    if (!APPENDIX_HEADINGS.some(rx => rx.test(heads[i].label))) continue;
    const end = i + 1 < heads.length ? heads[i + 1].start : html.length;
    if (heads[i].start > cursor) out += html.slice(cursor, heads[i].start);
    cursor = Math.max(cursor, end);
  }
  out += html.slice(cursor);
  return out;
}

// True when a post page carries Substack's inline paywall gate. Substack renders it as
// <div data-testid="paywall" …> only on gated posts; the footer subscribe widget (which uses
// class="paywall…") is present on every post, so we key on the stable data-testid, not the class.
export function isPaywalled(html) {
  return typeof html === 'string' && /data-testid=["']paywall["']/i.test(html);
}
