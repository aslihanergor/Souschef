// Server-side YouTube Data API v3 client. The key stays server-side (read from
// process.env, never sent to the client). Pure parsers map raw API JSON into
// Focus's existing channel shape { channelId, name, avatarUrl }.
//
// The leading underscore keeps Vercel from treating this file as a routable
// /api endpoint — it's a helper imported by the real handlers.

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const RSS_BASE = 'https://www.youtube.com/feeds/videos.xml';

// Resilience (BUG-004). Single host (no fallback host like X has), so this is retry-only.
const YT_TRIES = 3;      // 1 initial attempt + 2 retries on the Data API
const RSS_TRIES = 2;     // 1 initial + 1 retry on the keyless RSS fallback
const BACKOFF_MS = 300;  // base backoff between attempts (grows with attempt index)
const TIMEOUT_MS = 6000; // per-attempt timeout so a hung request also gives up / falls back

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// One fetch attempt with an AbortController timeout, so a request that hangs (rather than
// erroring) still fails and lets us retry / fall back.
async function fetchWithTimeout(fetchImpl, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A YouTube Data API failure is transient — worth a retry — only for 429 (rate-limit) and
// 5xx. A 403 is the REAL answer for quota-exceeded / forbidden: retrying just burns the
// request deadline, so we fail fast to the keyless fallback. (Contrast X's isTransient in
// _twitter.js, where 429 is a real answer we do NOT retry — different API, different rules.)
export function isTransient(status) {
  return status === 429 || status >= 500;
}

// Best available avatar, high → medium → default; null if none present.
function pickAvatar(thumbnails) {
  if (!thumbnails) return null;
  const t = thumbnails.high || thumbnails.medium || thumbnails.default;
  return t && t.url ? t.url : null;
}

// Fetch a Data API endpoint with the key injected, retrying transient failures with backoff
// (BUG-004). Returns parsed JSON, or null when the key is unset OR the request ultimately
// fails — callers fall back to scraping/RSS. A non-transient failure (403 quota / other 4xx)
// returns null immediately (no retry). On any failure we console.warn the status, so a prod
// outage isn't diagnosed blind (previously every failure collapsed silently to null).
// `fetchImpl`/`sleep`/`warn` are injectable for tests; production uses global fetch + a real
// backoff + console.warn.
export async function ytFetch(endpoint, params, { fetchImpl = fetch, sleep = defaultSleep, warn = console.warn } = {}) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null; // no key configured → caller falls back to scraping
  const qs = new URLSearchParams({ ...params, key }).toString();
  const url = `${API_BASE}/${endpoint}?${qs}`;

  let lastStatus = null;
  for (let i = 0; i < YT_TRIES; i++) {
    if (i > 0) await sleep(BACKOFF_MS * i); // brief, growing backoff between attempts
    let r;
    try {
      r = await fetchWithTimeout(fetchImpl, url);
    } catch {
      lastStatus = 'network/timeout'; // transient — retry
      continue;
    }
    if (r.ok) return r.json();
    if (!isTransient(r.status)) { // 403 quota / other 4xx — a real answer, straight to fallback
      warn(`ytFetch ${endpoint} → HTTP ${r.status} (no retry, falling back)`);
      return null;
    }
    lastStatus = r.status; // 429 / 5xx — retry
  }
  warn(`ytFetch ${endpoint} → gave up after ${YT_TRIES} attempts (last: ${lastStatus}), falling back`);
  return null;
}

// Fetch a channel's RSS upload feed (the keyless fallback), retrying a transient failure once
// (BUG-004). The shared-datacenter-IP 502 throttle (this bug's origin) lands here, and this
// path is reached exactly when the Data API is already down — so it's the last line of
// defense. Returns the raw XML, or null if every attempt fails. Injectable for tests.
export async function fetchRssXml(channelId, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const url = `${RSS_BASE}?channel_id=${channelId}`;
  for (let i = 0; i < RSS_TRIES; i++) {
    if (i > 0) await sleep(BACKOFF_MS * i);
    try {
      const r = await fetchWithTimeout(fetchImpl, url);
      if (r.ok) return r.text();
    } catch {
      // network error / timeout — fall through to the retry
    }
  }
  return null;
}

// A channels.list response -> { channelId, name, avatarUrl } | null (no match).
export function parseChannelResult(json) {
  const item = json && json.items && json.items[0];
  if (!item) return null;
  const sn = item.snippet || {};
  return {
    channelId: item.id,
    name: sn.title || item.id,
    avatarUrl: pickAvatar(sn.thumbnails),
  };
}

// A search.list (type=channel) response -> [{ channelId, name, avatarUrl }],
// top result first, deduped by channelId, capped at `limit`.
export function parseSearchResults(json, limit = 5) {
  const items = (json && json.items) || [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const channelId = item.id && item.id.channelId;
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);
    const sn = item.snippet || {};
    out.push({
      channelId,
      name: sn.title || channelId,
      avatarUrl: pickAvatar(sn.thumbnails),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Subscription import (TASK-015) ────────────────────────────────────────────

// A subscriptions.list response -> [{ channelId, name, avatarUrl }] for the channels the user
// follows, deduped by channelId. IMPORTANT: the followed channel is `snippet.resourceId.channelId`;
// `snippet.channelId` is the *subscriber's own* channel (the classic mis-map here).
export function parseSubscriptions(json) {
  const items = (json && json.items) || [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const sn = item.snippet || {};
    const channelId = sn.resourceId && sn.resourceId.channelId;
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);
    out.push({
      channelId,
      name: sn.title || channelId,
      avatarUrl: pickAvatar(sn.thumbnails),
    });
  }
  return out;
}

// Fetch every channel the signed-in user subscribes to, via subscriptions.list with their OAuth
// access token (Bearer — NOT the server API key). Follows `nextPageToken`, deduping across pages,
// bounded by `maxPages` so a huge account can't run unbounded (returns `truncated: true` when the
// cap cuts the walk short). Throws on a non-ok response so the caller can surface a clear failure
// (e.g. an expired token). Injectable `fetchImpl` for tests.
const SUBS_MAX_PAGES = 20; // 20 × 50 = up to 1000 subscriptions per import
export async function listSubscriptions(accessToken, { fetchImpl = fetch, maxPages = SUBS_MAX_PAGES } = {}) {
  const channels = [];
  const seen = new Set();
  let pageToken;
  let pages = 0;
  let truncated = false;
  for (;;) {
    if (pages >= maxPages) { truncated = true; break; }
    const params = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50', order: 'alphabetical' });
    if (pageToken) params.set('pageToken', pageToken);
    const r = await fetchImpl(`${API_BASE}/subscriptions?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) throw new Error(`subscriptions.list → HTTP ${r.status}`);
    const json = await r.json();
    pages++;
    for (const ch of parseSubscriptions(json)) {
      if (seen.has(ch.channelId)) continue;
      seen.add(ch.channelId);
      channels.push(ch);
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return { channels, truncated };
}

// ── Feed parsing (TASK-006) ───────────────────────────────────────────────────

export const SHORTS_MAX_SECONDS = 180; // YouTube caps Shorts at 3 minutes

// ISO 8601 duration ("PT1H2M3S", "PT49S") -> seconds, or null if unparseable.
export function isoDurationToSeconds(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

// True if a video's duration marks it a Short.
export function isShort(seconds) {
  return seconds != null && seconds <= SHORTS_MAX_SECONDS;
}

// playlistItems.list response -> [{ videoId, title, published }]. Skips deleted/
// private placeholders (no videoId or a marker title).
export function parseUploads(json) {
  const items = (json && json.items) || [];
  const out = [];
  for (const it of items) {
    const videoId = it.contentDetails && it.contentDetails.videoId;
    const sn = it.snippet || {};
    if (!videoId || sn.title === 'Deleted video' || sn.title === 'Private video') continue;
    out.push({ videoId, title: sn.title || '', published: sn.publishedAt || '' });
  }
  return out;
}

// videos.list response -> { videoId: durationSeconds }.
export function parseDurations(json) {
  const items = (json && json.items) || [];
  const map = {};
  for (const it of items) {
    map[it.id] = isoDurationToSeconds(it.contentDetails && it.contentDetails.duration);
  }
  return map;
}

function decodeXml(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// YouTube RSS xml -> [{ videoId, title, published, isShort }] (isShort from the
// /shorts/ link path — the fallback source's Shorts signal).
export function parseRssFeed(xml) {
  const out = [];
  const entries = (xml || '').match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const e of entries) {
    const videoId = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    if (!videoId) continue;
    const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
    const link = (e.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || '';
    out.push({ videoId, title: decodeXml(title), published, isShort: link.includes('/shorts/') });
  }
  return out;
}
