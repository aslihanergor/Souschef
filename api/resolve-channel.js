import { ytFetch, parseChannelResult, parseSearchResults as parseApiSearchResults } from './_youtube.js';
import { xFetch, parseTwitterUser } from './_twitter.js';
import { fetchSubstackXml, parseSubstackChannel, isSubstackFeed, substackFeedUrl } from './_substack.js';
import { isYouTubeHost } from './_hosts.js';
import { db } from './_db.js';
import { sessionAccount, signedInGate, refuse } from './_session.js';

// Injection seam ([BUG-025]), mirroring `createFeedHandler`. Until this, the endpoint had no handler
// test — `test/resolve-channel.test.mjs` covers the pure URL helpers only — so nothing could ask
// what it does with a real request. Upstream requests need no seam of their own: `ytFetch`, `xFetch`
// and `fetchSubstackXml` default `fetchImpl` to the global `fetch` per call, and the scrape path
// calls it directly, so a test that stubs `globalThis.fetch` sees every one. The default export
// binds the real modules and keeps Vercel's `handler(req, res)` signature.
export function createResolveHandler({
  db: dbFn = db,
  sessionAccount: sessionFn = sessionAccount,
  sessionTimeoutMs,   // undefined → the gate's production limit (SESSION_CHECK_TIMEOUT_MS)
} = {}) {
  return (req, res) => handleResolve(req, res, { dbFn, sessionFn, sessionTimeoutMs });
}

export default createResolveHandler();

async function handleResolve(req, res, ctx) {
  // Signed-in only ([BUG-025]), before any upstream request: an X handle lookup bills $0.010 a user
  // read and a YouTube name search spends one of 100 searches a day. The app only resolves after
  // sign-in; a document that outlived its session shows this `error` in the add form, which renders
  // `data.error`. `signedInGate` (api/_session.js) owns the three answers.
  const gate = await signedInGate(ctx.dbFn(), req?.headers?.cookie, ctx.sessionFn, { timeoutMs: ctx.sessionTimeoutMs });
  if (!gate) return refuse(res, 401, 'Sign in again to add channels.');

  const { url, source, handle } = req.query;

  // X/Twitter: resolve an exact @handle to a numeric user id via the X API. Only under a CONFIRMED account
  // (decision B): when the store could not be asked, anyone sending any `focus_session` value gets here, and
  // an X user read is billed — so it is refused, while the YouTube and Substack lookups below still run.
  if (source === 'twitter') {
    if (!gate.account) return refuse(res, 503, "Couldn't check your sign-in — try again in a moment.");
    if (!handle) return res.status(400).json({ error: 'handle required' });
    const account = await resolveTwitter(handle.trim());
    if (!account) {
      return res.status(404).json({ error: 'Could not find that X account — check the @handle.' });
    }
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json(account);
  }

  // Substack: validate a publication's keyless RSS and read its title + avatar. (TASK-022)
  if (source === 'substack') {
    if (!url) return res.status(400).json({ error: 'url required' });
    const pub = await resolveSubstack(url.trim());
    if (!pub) {
      return res.status(404).json({ error: 'Could not find that Substack — check the publication URL or name.' });
    }
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json(pub);
  }

  if (!url) return res.status(400).json({ error: 'url required' });

  const result = await resolveToChannel(url.trim());
  if (!result) {
    return res.status(404).json({
      error: 'Could not find that channel. Try pasting the @handle or full channel URL.',
    });
  }

  res.setHeader('Cache-Control', 's-maxage=3600');
  res.status(200).json(result);
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Resolve a channel, preferring the YouTube Data API (structured, robust) and
// falling back to HTML scraping when the key is unset, the API errors or hits
// quota, or it finds no match. Same return shape either way — the client is
// unchanged.
async function resolveToChannel(input) {
  const viaApi = await resolveViaApi(input);
  if (viaApi) return viaApi;
  return resolveViaScrape(input);
}

// ── X / Twitter path ──────────────────────────────────────────────────────────

// Resolve an @handle to our channel shape via the X API (App-only Bearer). Handles are
// globally unique → a single exact match, no alternatives. We store the numeric user id
// (permanent — survives handle renames) as the channel id, plus the handle for permalinks.
async function resolveTwitter(handle) {
  const username = handle.replace(/^@/, '').trim();
  if (!username) return null;
  let json;
  try {
    json = await xFetch(`users/by/username/${encodeURIComponent(username)}`, {
      'user.fields': 'profile_image_url,name,username',
    });
  } catch {
    return null; // API error (rate limit / credits / bad handle) — surface as "not found"
  }
  if (!json) return null; // no token configured
  const u = parseTwitterUser(json);
  if (!u) return null;
  return { channelId: u.sourceId, name: u.name, avatarUrl: u.avatarUrl, handle: u.handle };
}

// ── Substack path ─────────────────────────────────────────────────────────────

// Validate a publication by fetching its keyless RSS, confirming it's a Substack feed, and
// reading the channel title + avatar. channelId = the publication hostname (used by the feed
// fetch, which re-derives https://<host>/feed). Accepts a subdomain, custom domain, or URL.
async function resolveSubstack(input) {
  const feedUrl = substackFeedUrl(input);
  if (!feedUrl) return null;
  const xml = await fetchSubstackXml(feedUrl);
  if (!xml || !isSubstackFeed(xml)) return null;
  const ch = parseSubstackChannel(xml);
  if (!ch) return null;
  let host;
  try { host = new URL(feedUrl).hostname; } catch { return null; }
  return { channelId: host, name: ch.name, avatarUrl: ch.avatarUrl };
}

// ── YouTube Data API path ─────────────────────────────────────────────────────

async function resolveViaApi(input) {
  if (/^UC[\w-]{22}$/.test(input)) return channelById(input);
  if (input.startsWith('@'))       return channelByHandle(input);
  if (input.startsWith('http')) {
    const parsed = parseYouTubeUrl(input);
    if (parsed?.id)     return channelById(parsed.id);
    if (parsed?.handle) return channelByHandle(parsed.handle);
    return null; // /c/ or /user/ custom URL — no direct API call; let scraping try
  }
  return searchViaApi(input); // plain display name
}

async function channelById(id) {
  return parseChannelResult(await ytFetch('channels', { part: 'snippet', id }));
}

async function channelByHandle(handle) {
  return parseChannelResult(await ytFetch('channels', { part: 'snippet', forHandle: handle }));
}

async function searchViaApi(query) {
  const results = parseApiSearchResults(await ytFetch('search', {
    part: 'snippet', type: 'channel', q: query, maxResults: '5',
  }), 5);
  if (results.length === 0) return null;
  const [top, ...alternatives] = results;
  return { ...top, fromSearch: true, alternatives };
}

// Pull a channel id or @handle out of a YouTube URL. Custom /c/ and /user/ URLs
// have no direct Data-API lookup, so they return null and fall through to scraping.
export function parseYouTubeUrl(url) {
  try {
    const u = new URL(url);
    if (!isYouTubeHost(u.hostname)) return null; // exact match, not endsWith (BUG-020)
    const id = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
    if (id) return { id: id[1] };
    const handle = u.pathname.match(/^\/(@[\w.-]+)/);
    if (handle) return { handle: handle[1] };
    return null;
  } catch {
    return null;
  }
}

// ── HTML scraping path (fallback) ─────────────────────────────────────────────

async function resolveViaScrape(input) {
  const candidates = buildCandidates(input);
  for (const url of candidates) {
    const r = await tryFetchChannel(url);
    if (r) return r;
  }
  // Last resort for plain display names: YouTube search (no API key)
  if (!isDirectInput(input)) return searchForChannel(input);
  return null;
}

function isDirectInput(input) {
  return input.startsWith('http') ||
    /^UC[\w-]{22}$/.test(input) ||
    input.startsWith('@');
}

// ── Candidate URL builder ─────────────────────────────────────────────────────

export function buildCandidates(input) {
  if (/^UC[\w-]{22}$/.test(input)) {
    return [`https://www.youtube.com/channel/${input}`];
  }
  if (input.startsWith('http')) {
    try {
      const u = new URL(input);
      if (!isYouTubeHost(u.hostname)) return []; // exact match, not endsWith (BUG-020)
      // Fetch a URL we REBUILD from the validated host + path — never the raw input, whose port,
      // query and fragment are attacker-controlled. https is forced (an http input would downgrade).
      return [`https://${u.hostname}${u.pathname}`];
    } catch { return []; }
  }
  if (input.startsWith('@')) {
    return [`https://www.youtube.com/${input}`];
  }
  // Plain display name / search term — don't guess handles from it. Guessing
  // "@<name>" often resolves to a DIFFERENT channel (e.g. "fear&" -> "@fear"), so we
  // let resolveToChannel() fall through to YouTube search, which returns the top
  // channel result — matching what the user sees when they search on YouTube.
  return [];
}

// ── HTML entity decode ────────────────────────────────────────────────────────
// Names come from HTML (og:title), so entities like &amp; / &#39; arrive encoded.
// Decode once so we store plain text (e.g. "Fear&", not "Fear&amp;"). &amp; is
// replaced last so a value like "&amp;lt;" decodes to "&lt;", not "<".
function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ── Fetch & parse a single channel page ──────────────────────────────────────

async function tryFetchChannel(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!r.ok) return null;
    const html = await r.text();

    // Canonical link is page-specific — check it first
    const idPatterns = [
      /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
      /<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
      /"externalChannelId":"(UC[\w-]{22})"/,
      /"browseId":"(UC[\w-]{22})"/,
    ];
    let channelId = null;
    for (const p of idPatterns) {
      const m = html.match(p);
      if (m) { channelId = m[1]; break; }
    }
    if (!channelId) return null;

    const nameMatch   = html.match(/<meta property="og:title" content="([^"]+)"/);
    const avatarMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
    const name = nameMatch
      ? decodeHtmlEntities(nameMatch[1]).replace(/ - YouTube$/, '').trim()
      : channelId;
    const avatarUrl = avatarMatch ? avatarMatch[1] : null;

    return { channelId, name, avatarUrl };
  } catch {
    return null;
  }
}

// ── YouTube channel search (no API key) ──────────────────────────────────────

// Parse the top channel results out of a YouTube search page. Each channelRenderer
// block in ytInitialData carries the channelId, title (JSON-escaped text), and an
// avatar thumbnail — enough to offer alternatives without an extra fetch per result
// (keeps our request volume low; see BUG-004 throttling). Pure function so it can be
// unit-tested against a saved fixture once we stand up a runner.
function parseSearchResults(html, limit = 5) {
  const results = [];
  const seen = new Set();
  const re = /"channelRenderer"/g;
  let m;
  while ((m = re.exec(html)) && results.length < limit) {
    const chunk = html.slice(m.index, m.index + 3000);
    const idM = chunk.match(/"channelId":"(UC[\w-]{22})"/);
    if (!idM || seen.has(idM[1])) continue;
    const channelId = idM[1];
    seen.add(channelId);

    // The title is either {"simpleText":"…"} or {"runs":[{"text":"…"},…]} — YouTube
    // uses runs when it highlights the matched query inside the channel name, which
    // happens exactly when the search term appears in the name. Handle both.
    let name = channelId;
    const simpleM = chunk.match(/"title":\{"simpleText":"((?:[^"\\]|\\.)*)"/);
    if (simpleM) {
      name = jsonUnescape(simpleM[1]);
    } else {
      const runsM = chunk.match(/"title":\{"runs":\[(.*?)\]\}/);
      if (runsM) {
        const parts = [...runsM[1].matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map(x => jsonUnescape(x[1]));
        if (parts.length) name = parts.join('');
      }
    }

    const avaM = chunk.match(/"thumbnails":\[\{"url":"(\/\/[^"]+|https?:[^"]+?)"/);
    let avatarUrl = avaM ? avaM[1] : null;
    if (avatarUrl && avatarUrl.startsWith('//')) avatarUrl = 'https:' + avatarUrl;

    results.push({ channelId, name, avatarUrl });
  }
  return results;
}

// ytInitialData strings are JSON-escaped (a "&" arrives as a & escape), not
// HTML-encoded — so we unescape as JSON, not via decodeHtmlEntities.
function jsonUnescape(raw) {
  try { return JSON.parse('"' + raw + '"'); }
  catch {
    return raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, '$1');
  }
}

async function searchForChannel(query) {
  try {
    // sp=EgIQAg== filters results to channels only
    const r = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%3D%3D`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      }
    );
    if (!r.ok) return null;
    const html = await r.text();

    const results = parseSearchResults(html, 5);
    if (results.length === 0) return null;

    // Upgrade only the TOP match via its channel page (canonical name + higher-res
    // avatar), exactly as before. Alternatives keep the lighter search-JSON data, so
    // offering them costs no extra fetches.
    const top = results[0];
    const page = await tryFetchChannel(`https://www.youtube.com/channel/${top.channelId}`);
    const topResult = page || top;

    return {
      channelId: topResult.channelId,
      name: topResult.name,
      avatarUrl: topResult.avatarUrl || null,
      fromSearch: true,
      alternatives: results.slice(1),
    };
  } catch {
    return null;
  }
}
