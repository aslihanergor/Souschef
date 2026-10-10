import { ytFetch, parseUploads, parseDurations, isShort, parseRssFeed, fetchRssXml } from './_youtube.js';
import { xFetch, parseTweets, pageStep } from './_twitter.js';
import { fetchSubstackXml, parseSubstackFeed, isSubstackFeed, substackFeedUrl } from './_substack.js';
import { isSafePublicHost } from './_hosts.js';
import { db } from './_db.js';
import { sessionAccount, signedInGate, refuse } from './_session.js';
import { utcDay, readQuotaLimit, quotaExceeded } from './_quota.js';

// Outer bound on what any channel can return. A newly added channel is narrowed further to its
// last 24h client-side (applyLookback, lib/pure.js); that stays off this endpoint on
// purpose, since a per-channel `?since=` would fragment the YouTube/Substack shared caches below
// for no gain. (The X path is `no-store` for an unrelated reason — per-user cursor + per-app
// credits — so cache fragmentation was never the argument there.)
const WINDOW_DAYS = 14;
const X_PAGE_CAP = 2;   // incremental catch-up ceiling: 2 pages × 100 = 200 posts/account/refresh
const METER_RETAIN_DAYS = 30;  // both meter tables are swept on write past this

// Injection seam. `xFetch` is a parameter so the X path can run in a handler test
// against a canned response. Before this, `api/feed.js` had NO handler tests — `test/feed.test.mjs`
// covers only the pure parsers — so nothing could ask what this endpoint does with a real request.
// Production behaviour is unchanged: the default export binds the real module and keeps Vercel's
// `handler(req, res)` signature.
export function createFeedHandler({
  xFetch: xf = xFetch,
  db: dbFn = db,
  sessionAccount: sessionFn = sessionAccount,
  sessionTimeoutMs,   // undefined → the gate's production limit (SESSION_CHECK_TIMEOUT_MS)
  now = Date.now,
  env = process.env,
} = {}) {
  return (req, res) => handleFeed(req, res, { xf, dbFn, sessionFn, sessionTimeoutMs, now, env });
}

export default createFeedHandler();

async function handleFeed(req, res, ctx) {
  // Signed-in only, and FIRST — ahead of validation and dispatch — so a refused request never
  // reaches YouTube, X or Substack. X bills per post read and YouTube burns a shared daily quota; Substack
  // is keyless and gated so that one rule covers the endpoint. The app only calls this after sign-in, so a
  // refusal costs no real user. `signedInGate` (api/_session.js) owns the three answers.
  const sql = ctx.dbFn();
  const gate = await signedInGate(sql, req?.headers?.cookie, ctx.sessionFn, { timeoutMs: ctx.sessionTimeoutMs });
  if (!gate) return refuse(res, 401, 'sign in required');

  const { channelId, hideShorts, source, sourceId, sinceId } = req.query;
  // ONE clock per request. The window cutoffs below used to read Date.now() while the quota day
  // read this, so a test pinning the clock pinned half the handler — and aged out of the real window.
  const { now } = ctx;

  // X/Twitter: incremental fetch of a user's recent posts (since_id keeps cost down). Only under a CONFIRMED
  // account (decision B): when the store could not be asked, the account X would be billed and metered
  // against is unknown, and anyone sending any `focus_session` value reaches this line — so X is refused,
  // while YouTube and Substack below are still served.
  if (source === 'twitter') {
    if (!gate.account) return refuse(res, 503, 'could not verify sign-in');
    return handleTwitter(res, sourceId, sinceId, ctx, sql, gate.account);
  }
  // Substack: keyless RSS per publication (sourceId = the publication host).
  if (source === 'substack') return handleSubstack(res, sourceId, now);

  if (!channelId || !/^UC[\w-]{22}$/.test(channelId)) {
    return res.status(400).json({ error: 'invalid channelId' });
  }
  const hide = hideShorts === '1' || hideShorts === 'true';

  try {
    // Data API first (deeper window), RSS as a keyless fallback.
    let items = await fetchViaApi(channelId, hide);
    if (items == null) items = await fetchViaRss(channelId, hide);
    if (items == null) return res.status(502).json({ error: 'feed fetch failed' });

    // Keep only the last WINDOW_DAYS.
    const cutoff = now() - WINDOW_DAYS * 86400_000;
    items = items.filter(it => {
      const t = Date.parse(it.published);
      return !Number.isNaN(t) && t >= cutoff;
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.status(200).json({ items });
  } catch {
    res.status(502).json({ error: 'feed fetch failed' });
  }
}

// Data API: uploads playlist (+ durations only when hiding Shorts). Returns items,
// or null when the key is unset / the API fails — so the caller falls back to RSS.
async function fetchViaApi(channelId, hideShorts) {
  const uploadsId = 'UU' + channelId.slice(2); // uploads playlist = channel id with UC->UU
  const pl = await ytFetch('playlistItems', {
    part: 'snippet,contentDetails', playlistId: uploadsId, maxResults: '50',
  });
  if (!pl) return null;

  let items = parseUploads(pl);
  if (hideShorts && items.length) {
    const durations = parseDurations(await ytFetch('videos', {
      part: 'contentDetails', id: items.map(i => i.videoId).join(','),
    }) || {});
    items = items.filter(i => !isShort(durations[i.videoId])); // unknown duration -> kept
  }
  return items;
}

// RSS fallback (keyless): detects Shorts from the /shorts/ link path. The fetch (with its
// transient retry) lives in fetchRssXml; here we just parse, filter, and shape.
async function fetchViaRss(channelId, hideShorts) {
  const xml = await fetchRssXml(channelId);
  if (xml == null) return null;
  let items = parseRssFeed(xml);
  if (hideShorts) items = items.filter(i => !i.isShort);
  return items.map(({ videoId, title, published }) => ({ videoId, title, published }));
}

// ── X / Twitter feed ──────────────────────────────────────────────────────────

async function handleTwitter(res, sourceId, sinceId, ctx, sql, account) {
  const { xf, now, env } = ctx;
  if (!sourceId || !/^\d+$/.test(sourceId)) {
    return res.status(400).json({ error: 'invalid sourceId' });
  }

  // Quota gate. The owner is the account `signedInGate` CONFIRMED — never a client-supplied id,
  // which is why the quota cannot be reset by rotating a header, and never missing: the signed-in gate refuses X
  // before this function runs unless the session was confirmed, so no X read is unidentified.
  // A confirmed read CAN still go unmetered, because metering is best-effort at both ends: a meter
  // query that errors must not refuse a confirmed user's feed, so this block fails OPEN — the only outcome
  // that stops a fetch here is a quota we actually read — and `recordUsage` swallows a failed write.
  const day = utcDay(now());
  const owner = { kind: 'account', id: account.accountId };
  try {
    const limit = readQuotaLimit(env);
    if (limit != null) {
      const rows = await sql`select posts from x_usage
                             where owner_kind = ${owner.kind} and owner_id = ${owner.id} and day = ${day}`;
      if (quotaExceeded(rows[0]?.posts ?? 0, limit)) {
        return res.status(429).json({ error: "You've hit today's X limit", reason: 'quota' });
      }
    }
  } catch {
    // Fail open. A blip here costs some unmetered reads; failing closed costs the whole feed.
  }

  try {
    const result = await fetchTweets(sourceId, /^\d+$/.test(sinceId || '') ? sinceId : null, xf);
    if (result == null) return res.status(502).json({ error: 'X not configured' });

    // Meter what X RETURNED, before the window filter below — X billed us for those posts whether
    // we keep them or not. Two meters: the owner's daily total (fairness) and the app-wide set of
    // distinct post ids (spend), which is what X's own within-a-day dedup actually charges for.
    await recordUsage(sql, owner, day, result.items);

    // First fetch (no since_id) can reach past the window — trim it. Incremental fetches
    // only return newer posts, so they're already inside it.
    const cutoff = now() - WINDOW_DAYS * 86400_000;
    const items = result.items.filter(it => {
      const t = Date.parse(it.published);
      return !Number.isNaN(t) && t >= cutoff;
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Per-user cursor (since_id) + per-app credits → never shared-cache this response.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ items, capped: result.capped });
  } catch (err) {
    // Tell an app-wide CAP apart from a transient failure.
    // `xFetch` fails fast on a 4xx and attaches the status: 402 is credits
    // exhausted, 429 is X rate-limiting us. Neither clears by retrying in the next minute, which is
    // exactly why the old bare 502 was harmful — the client rendered "Try reopening the feed" and
    // the retry spent more of the cap. Everything else stays an untagged 502 and keeps that message.
    const capped = err?.status === 402 || err?.status === 429;
    res.status(502).json({ error: 'feed fetch failed', ...(capped ? { reason: 'cap' } : {}) });
  }
}

// Write both X usage meters, plus an opportunistic sweep. Best-effort by contract: the caller has
// already served nothing yet, and a metering failure must not cost the user their feed,
// so every error is swallowed here rather than propagated.
async function recordUsage(sql, owner, day, items) {
  if (!sql || !items?.length) return;
  const ids = items.map(it => it.id).filter(Boolean);
  try {
    if (owner) {
      await sql`insert into x_usage (owner_kind, owner_id, day, posts, updated_at)
                values (${owner.kind}, ${owner.id}, ${day}, ${items.length}, now())
                on conflict (owner_kind, owner_id, day)
                do update set posts = x_usage.posts + ${items.length}, updated_at = now()`;
    }
    if (ids.length) {
      await sql`insert into x_posts_seen (day, post_id)
                select ${day}::date, unnest(${ids}::text[])
                on conflict do nothing`;
    }
    const cutoff = utcDay(Date.parse(`${day}T00:00:00Z`) - METER_RETAIN_DAYS * 86400_000);
    await sql`delete from x_usage where day < ${cutoff}`;
    await sql`delete from x_posts_seen where day < ${cutoff}`;
  } catch {
    // swallowed — see the contract above
  }
}

// ── Substack feed ──────────────────────────────────────────────────

// Fetch a publication's keyless RSS, parse, and window to the last WINDOW_DAYS. Stateless
// (like YouTube). `host` is the publication hostname stored as the channel id at resolve time.
async function handleSubstack(res, host, now) {
  // Validate the NORMALISED hostname (new URL collapses 127.1 → 127.0.0.1, which the old raw-string
  // regex missed), then re-derive the fetch URL from it. Shared guard via _hosts.js; isSubstackFeed()
  // below still rejects any non-Substack response. (SSRF)
  let hostname = '';
  try { hostname = new URL(`https://${host}`).hostname; } catch { /* invalid → rejected below */ }
  if (!isSafePublicHost(hostname)) {
    return res.status(400).json({ error: 'invalid sourceId' });
  }
  try {
    const xml = await fetchSubstackXml(substackFeedUrl(hostname));
    if (xml == null || !isSubstackFeed(xml)) return res.status(502).json({ error: 'substack feed failed' });

    const cutoff = now() - WINDOW_DAYS * 86400_000;
    const items = parseSubstackFeed(xml).filter(it => {
      const t = Date.parse(it.published);
      return !Number.isNaN(t) && t >= cutoff;
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
    res.status(200).json({ items });
  } catch {
    res.status(502).json({ error: 'feed fetch failed' });
  }
}

// users/:id/tweets with media + author expansions, excluding RTs/replies for a clean
// chronological feed. Returns { items, capped }, or null when no token is configured.
//   • First-ever fetch (no since_id): one shallow page (~20 newest), no pagination.
//   • Incremental (since_id): page newest→older through everything newer than since_id,
//     bounded by X_PAGE_CAP so a dormant high-volume account can't run up cost / an
//     unfinishable feed. `capped` = stopped at the cap with more still pending.
async function fetchTweets(userId, sinceId, xf) {
  const base = {
    'tweet.fields': 'created_at,entities,note_tweet,referenced_tweets',
    expansions: 'attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.author_id',
    'media.fields': 'type,url,preview_image_url,width,height,variants,duration_ms',
    'user.fields': 'name,username,profile_image_url',
    exclude: 'retweets,replies',
  };

  if (!sinceId) {
    const json = await xf(`users/${userId}/tweets`, { ...base, max_results: '20' });
    if (!json) return null;
    return { items: parseTweets(json), capped: false };
  }

  const items = [];
  let token = null, pages = 0, capped = false;
  while (true) {
    const page = await xf(`users/${userId}/tweets`, {
      ...base, max_results: '100', since_id: sinceId, ...(token ? { pagination_token: token } : {}),
    });
    if (!page) return pages === 0 ? null : { items, capped }; // no token ⇒ X unconfigured (only on page 0)
    items.push(...parseTweets(page));
    pages++;
    const step = pageStep({ nextToken: page.meta?.next_token, pages, cap: X_PAGE_CAP });
    capped = step.capped;
    if (!step.more) break;
    token = page.meta.next_token;
  }
  return { items, capped };
}
