// Server-side X (Twitter) API v2 client + pure response parsers. Mirrors _youtube.js:
// keep the fetch/env access thin, put the mappable logic in pure functions we unit-test.
// Unlike YouTube (which has an RSS/scrape keyless fallback), X has NO keyless path — with
// no token the source is simply unavailable, and the callers skip it.

// Ordered v2 hosts (BUG-009). api.twitter.com is primary: on 2026-07-05 (BUG-008)
// api.x.com returned 503 for every authenticated v2 request while api.twitter.com served
// the identical API on the same token — so twitter.com is the stable host, x.com the
// fallback. Trying both means a whole-host outage of either no longer takes X dark.
const HOSTS = ['https://api.twitter.com/2', 'https://api.x.com/2'];
const TRIES_PER_HOST = 2; // 1 initial attempt + 1 retry, per host
const BACKOFF_MS = 400;   // base backoff between attempts (grows with attempt index)
const TIMEOUT_MS = 6000;  // per-attempt timeout so a hung host also triggers fallback

// A 5xx (or a thrown network error / timeout) is transient — worth a retry / host
// fallback. A 4xx is a real answer (401 bad token, 402 no credits, 404 no such user, 429
// rate-limit): retrying only burns latency and can't change the result, so we fail fast.
export function isTransient(status) {
  return status >= 500;
}

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch a v2 endpoint with retry-with-backoff + host fallback (BUG-009). Returns parsed
// JSON, or null when the token is unset (callers treat X as unconfigured and skip it).
// Throws immediately on a 4xx (fail fast), or the last error once every host attempt is
// exhausted on transient failures — so the feed loader marks just that channel failed.
// Only *failed* (non-2xx) requests are retried, and a 5xx costs no read credit, so the
// retry/fallback never double-charges a successful read. `fetchImpl`/`sleep` are injectable
// for tests; production uses global fetch + a real backoff.
export async function xFetch(endpoint, params = {}, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return null;
  const qs = new URLSearchParams(params).toString();
  const suffix = `${endpoint}${qs ? `?${qs}` : ''}`;

  // Flat ordered attempt list: each host is tried TRIES_PER_HOST times before the next.
  const attempts = HOSTS.flatMap(h => Array(TRIES_PER_HOST).fill(h));
  let lastError;
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0) await sleep(BACKOFF_MS * i); // brief, growing backoff between attempts
    let r;
    try {
      r = await fetchWithTimeout(fetchImpl, `${attempts[i]}/${suffix}`, token);
    } catch (err) {
      lastError = err; // network error / timeout — transient, try the next attempt/host
      continue;
    }
    if (r.ok) return r.json();
    if (!isTransient(r.status)) { // 4xx — a real answer, don't retry or fall over
      throw Object.assign(new Error(`X API ${r.status}`), { status: r.status });
    }
    lastError = Object.assign(new Error(`X API ${r.status}`), { status: r.status }); // 5xx — retry/fallback
  }
  throw lastError;
}

// One attempt with an AbortController timeout, so a host that hangs (rather than returning
// a 5xx) still fails and triggers the next attempt / host fallback.
async function fetchWithTimeout(fetchImpl, url, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Incremental pagination loop control (TASK-040). After fetching a page (so `pages` counts pages
// already retrieved), decide whether to fetch another and whether we stopped early with more
// pending. `capped` is true ONLY when a next_token remains but we've hit the page cap — i.e. older
// new posts are being skipped (surface a note). Exhausting exactly at the cap is NOT capped.
export function pageStep({ nextToken, pages, cap }) {
  if (!nextToken) return { more: false, capped: false };  // exhausted — fetched everything new
  if (pages >= cap) return { more: false, capped: true };  // cap reached with more still pending
  return { more: true, capped: false };
}

// users/by/username → our channel shape, or null if the user wasn't found.
export function parseTwitterUser(json) {
  const u = json?.data;
  if (!u || !u.id) return null;
  return {
    sourceId: u.id,
    name: u.name || u.username,
    handle: u.username,
    // Avatars come back as `_normal` (48px); upscale to a crisp size for retina. If the
    // pattern ever changes the replace is a no-op and the original URL still works.
    avatarUrl: u.profile_image_url ? u.profile_image_url.replace('_normal', '_400x400') : null,
  };
}

// Choose the mp4 variant nearest a target bitrate (~832k ≈ 640×360 — crisp at card width without
// over-spending data). Ignores the HLS variant; null if no mp4. (TASK-038)
function pickMp4(variants, target = 832000) {
  const mp4s = (variants || []).filter(v => v.content_type === 'video/mp4' && v.url);
  if (!mp4s.length) return null;
  return mp4s.reduce((best, v) =>
    Math.abs((v.bit_rate || 0) - target) < Math.abs((best.bit_rate || 0) - target) ? v : best
  ).url;
}

// Extract the numeric status id from a tweet permalink (x.com/twitter.com/…/status/<id>), or null.
function statusIdOf(url) {
  const m = (url || '').match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

// Build { text, author, url } for a tweet's quoted reference, or null when there's no `quoted`
// ref or its tweet/author isn't expanded in `includes` (defensive — the caller then leaves the
// quoted-status link in the text as a fallback). Preview is text-only, so all t.co shorts in the
// quoted body are dropped (quoted media isn't fetched — see spec). (TASK-034)
function resolveQuoted(tw, tweetById, userById) {
  const ref = (tw.referenced_tweets || []).find(r => r.type === 'quoted');
  if (!ref) return null;
  const qt = tweetById[ref.id];
  const author = qt && userById[qt.author_id];
  if (!qt || !author?.username) return null;
  let text = qt.note_tweet?.text ?? qt.text ?? '';
  for (const u of qt.entities?.urls ?? []) text = text.split(u.url).join('');
  return {
    text: text.replace(/\s+$/, ''),
    author: { name: author.name || author.username, handle: author.username },
    url: `https://x.com/${author.username}/status/${ref.id}`,
  };
}

// users/:id/tweets → normalized feed items { id, text, urls, published, media[], url, quoted? }.
// Joins includes.media (ALL attachments) + includes.users (permalink handle) + includes.tweets
// (quoted context). Video/GIF media items carry a `videoUrl` (mp4) for in-app playback (TASK-038);
// a quote tweet carries `quoted` (referenced author + text) (TASK-034).
export function parseTweets(json) {
  const tweets = json?.data;
  if (!Array.isArray(tweets)) return [];

  const mediaByKey = {};
  for (const m of json.includes?.media || []) mediaByKey[m.media_key] = m;
  const userById = {};
  for (const u of json.includes?.users || []) userById[u.id] = u;
  const tweetById = {};
  for (const t of json.includes?.tweets || []) tweetById[t.id] = t;

  return tweets.map(tw => {
    // All attachments in order (up to 4 photos, or 1 video/gif). Photos carry `url`; video/gif
    // carry only `preview_image_url`. width/height drive the client crop policy (TASK-037).
    const media = (tw.attachments?.media_keys || [])
      .map(k => mediaByKey[k])
      .filter(Boolean)
      .map(m => {
        const item = { type: m.type, url: m.url || m.preview_image_url || null, width: m.width, height: m.height };
        if (m.type === 'video' || m.type === 'animated_gif') item.videoUrl = pickMp4(m.variants);
        return item;
      })
      .filter(m => m.url);
    const username = userById[tw.author_id]?.username;

    // A quoted (referenced) tweet, if present and fully expanded. Only `quoted` refs reach here —
    // RTs/replies are excluded upstream. When resolved, its permalink in the text is redundant
    // (we render the quote inline), so strip it below. (TASK-034)
    const quoted = resolveQuoted(tw, tweetById, userById);
    const quotedId = quoted ? tw.referenced_tweets.find(r => r.type === 'quoted').id : null;

    // Long ("note") tweets are truncated in `text`; the full body is in note_tweet.text. Use the
    // full body and its matching entities (falling back to the tweet-level entities).
    const src = tw.note_tweet ?? tw;
    let text = src.text ?? tw.text ?? '';
    const urlEntities = src.entities?.urls ?? tw.entities?.urls ?? [];

    // A media t.co (an entities.urls entry WITH a media_key) just points to media we already
    // render → strip it. The resolved quoted-status link is likewise redundant → strip it.
    // Every other real link stays in the text and is surfaced in `urls` for the client to
    // linkify (TASK-035/036).
    const urls = [];
    for (const u of urlEntities) {
      if (u.media_key) text = text.split(u.url).join('');
      else if (quotedId && statusIdOf(u.expanded_url) === quotedId) text = text.split(u.url).join('');
      else urls.push({ short: u.url, display: u.display_url, expanded: u.expanded_url });
    }
    text = text.replace(/\s+$/, ''); // tidy trailing space left by a stripped link

    const item = {
      id: tw.id,
      text,
      published: tw.created_at,
      media,
      url: username ? `https://x.com/${username}/status/${tw.id}` : null,
      urls,
    };
    if (quoted) item.quoted = quoted;
    return item;
  });
}
