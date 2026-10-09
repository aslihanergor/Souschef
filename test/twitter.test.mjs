import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { xFetch, isTransient, parseTwitterUser, parseTweets, pageStep } from '../api/_twitter.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = name => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

// ── parseTwitterUser (users/by/username) ──────────────────────────────────────

test('parseTwitterUser maps a user lookup to our channel shape', () => {
  const u = parseTwitterUser(fx('twitter-user.json'));
  assert.equal(u.sourceId, '11348282');
  assert.equal(u.name, 'NASA');
  assert.equal(u.handle, 'NASA');
  assert.match(u.avatarUrl, /^https:\/\/pbs\.twimg\.com\/profile_images\//);
  // avatar upscaled from _normal (48px) to a crisp size for retina
  assert.match(u.avatarUrl, /_400x400\./);
  assert.doesNotMatch(u.avatarUrl, /_normal\./);
});

test('parseTwitterUser returns null when the user is not found', () => {
  assert.equal(parseTwitterUser({}), null);
  assert.equal(parseTwitterUser({ errors: [{}] }), null);
});

// ── parseTweets (users/:id/tweets with media + author expansions) ─────────────

test('parseTweets maps tweets, collects media, builds the permalink (TASK-037)', () => {
  const items = parseTweets(fx('twitter-tweets.json'));
  assert.equal(items.length, 10);
  const first = items[0];
  assert.equal(first.id, '2073460397902827575');
  assert.match(first.text, /^Happy 250th birthday, America!/);
  assert.equal(first.published, '2026-07-04T17:34:16.000Z');
  assert.equal(first.media.length, 1);
  assert.equal(first.media[0].type, 'photo');
  assert.equal(first.media[0].url, 'https://pbs.twimg.com/media/HMW-dyAW4AAa4Gl.jpg');
  assert.equal(first.url, 'https://x.com/NASA/status/2073460397902827575');
});

test('parseTweets sets media [] for a text-only tweet (TASK-037)', () => {
  const items = parseTweets(fx('twitter-tweets.json'));
  const textOnly = items.find(i => i.id === '2073142236838048092');
  assert.deepEqual(textOnly.media, []);
});

test('parseTweets collects ALL images in order when a tweet has several (TASK-037)', () => {
  const items = parseTweets(fx('twitter-tweets.json'));
  const multi = items.find(i => i.id === '2073078061499617543');
  assert.equal(multi.media.length, 3);
  assert.deepEqual(multi.media.map(m => m.url), [
    'https://pbs.twimg.com/media/HMQs7G_X0AA523_.jpg',
    'https://pbs.twimg.com/media/HMQs7YSW0AA5xkZ.jpg',
    'https://pbs.twimg.com/media/HMQs72tXsAAbFWb.jpg',
  ]);
  assert.ok(multi.media.every(m => m.type === 'photo'));
});

test('parseTweets carries type + dims; video uses preview_image_url (TASK-037)', () => {
  const json = {
    data: [{ id: '1', text: 'vid', created_at: '2026-07-04T00:00:00.000Z', author_id: 'u1', attachments: { media_keys: ['m1', 'm2'] } }],
    includes: {
      users: [{ id: 'u1', username: 'someone', name: 'Some One' }],
      media: [
        { media_key: 'm1', type: 'video', preview_image_url: 'https://pbs.twimg.com/preview.jpg', width: 1280, height: 720 },
        { media_key: 'm2', type: 'photo', url: 'https://pbs.twimg.com/media/p.jpg', width: 1080, height: 1350 },
      ],
    },
  };
  const items = parseTweets(json);
  assert.deepEqual(items[0].media, [
    { type: 'video', url: 'https://pbs.twimg.com/preview.jpg', width: 1280, height: 720, videoUrl: null },
    { type: 'photo', url: 'https://pbs.twimg.com/media/p.jpg', width: 1080, height: 1350 },
  ]);
  assert.equal(items[0].url, 'https://x.com/someone/status/1');
});

// ── parseTweets video/GIF playback — TASK-038 ─────────────────────────────────────────────
// A video/animated_gif media item gains a `videoUrl`: the mp4 variant nearest the target
// bitrate (~832k). Photos carry no videoUrl. Shapes mirror the live probe (2026-07-05).

test('parseTweets picks the ~832k mp4 variant as videoUrl for a video (TASK-038)', () => {
  const json = {
    data: [{ id: 'v1', text: '', created_at: '2026-07-04T00:00:00.000Z', author_id: 'u1', attachments: { media_keys: ['m1'] } }],
    includes: {
      users: [{ id: 'u1', username: 'NASA', name: 'NASA' }],
      media: [{ media_key: 'm1', type: 'video', preview_image_url: 'https://pbs.twimg.com/prev.jpg', width: 720, height: 405, variants: [
        { content_type: 'video/mp4', bit_rate: 288000, url: 'https://video.twimg.com/lo.mp4' },
        { content_type: 'video/mp4', bit_rate: 832000, url: 'https://video.twimg.com/mid.mp4' },
        { content_type: 'video/mp4', bit_rate: 2176000, url: 'https://video.twimg.com/hi.mp4' },
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/pl.m3u8' },
      ] }],
    },
  };
  const m = parseTweets(json)[0].media[0];
  assert.equal(m.type, 'video');
  assert.equal(m.url, 'https://pbs.twimg.com/prev.jpg'); // poster stays the preview
  assert.equal(m.videoUrl, 'https://video.twimg.com/mid.mp4'); // 832k picked
});

test('parseTweets carries videoUrl for an animated_gif (TASK-038)', () => {
  const json = {
    data: [{ id: 'g1', text: '', created_at: '2026-07-04T00:00:00.000Z', author_id: 'u1', attachments: { media_keys: ['m1'] } }],
    includes: {
      users: [{ id: 'u1', username: 'NASA', name: 'NASA' }],
      media: [{ media_key: 'm1', type: 'animated_gif', preview_image_url: 'https://pbs.twimg.com/g.jpg', width: 480, height: 480, variants: [
        { content_type: 'video/mp4', bit_rate: 0, url: 'https://video.twimg.com/gif.mp4' },
      ] }],
    },
  };
  const m = parseTweets(json)[0].media[0];
  assert.equal(m.type, 'animated_gif');
  assert.equal(m.videoUrl, 'https://video.twimg.com/gif.mp4');
});

test('parseTweets sets videoUrl null when a video has no mp4 variant (TASK-038)', () => {
  const json = {
    data: [{ id: 'v2', text: '', created_at: '2026-07-04T00:00:00.000Z', author_id: 'u1', attachments: { media_keys: ['m1'] } }],
    includes: {
      users: [{ id: 'u1', username: 'NASA', name: 'NASA' }],
      media: [{ media_key: 'm1', type: 'video', preview_image_url: 'https://pbs.twimg.com/prev.jpg', width: 720, height: 405, variants: [
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/pl.m3u8' },
      ] }],
    },
  };
  const m = parseTweets(json)[0].media[0];
  assert.equal(m.videoUrl, null); // client falls back to the preview image
});

test('parseTweets returns [] when there are no tweets', () => {
  assert.deepEqual(parseTweets({ meta: { result_count: 0 } }), []);
  assert.deepEqual(parseTweets({}), []);
});

// ── parseTweets text pipeline — Cluster A (036 strip t.co / 033 note_tweet / 035 urls) ────
// Shapes mirror the live probe (2026-07-05): a media t.co is an entities.urls entry WITH a
// media_key; a real link has none and carries expanded_url + display_url.

test('parseTweets strips the trailing media t.co link from text (TASK-036)', () => {
  const json = {
    data: [{
      id: '1', created_at: '2026-07-04T00:00:00.000Z', author_id: 'u1',
      text: 'Look at this photo https://t.co/ABC',
      attachments: { media_keys: ['3_1'] },
      entities: { urls: [{ url: 'https://t.co/ABC', display_url: 'pic.x.com/ABC', expanded_url: 'https://x.com/NASA/status/1/photo/1', media_key: '3_1' }] },
    }],
    includes: {
      users: [{ id: 'u1', username: 'NASA', name: 'NASA' }],
      media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg' }],
    },
  };
  const item = parseTweets(json)[0];
  assert.equal(item.text, 'Look at this photo');
  assert.deepEqual(item.urls, []);
});

test('parseTweets keeps real links (in text + urls), strips only media links (TASK-035/036)', () => {
  const json = {
    data: [{
      id: '2', created_at: '2026-07-04T00:00:00.000Z', author_id: 'u1',
      text: 'Read more https://t.co/REAL and a pic https://t.co/MEDIA',
      attachments: { media_keys: ['3_2'] },
      entities: { urls: [
        { url: 'https://t.co/REAL', display_url: 'go.nasa.gov/x', expanded_url: 'https://go.nasa.gov/x' },
        { url: 'https://t.co/MEDIA', display_url: 'pic.x.com/MEDIA', expanded_url: 'https://x.com/NASA/status/2/photo/1', media_key: '3_2' },
      ] },
    }],
    includes: {
      users: [{ id: 'u1', username: 'NASA', name: 'NASA' }],
      media: [{ media_key: '3_2', type: 'photo', url: 'https://pbs.twimg.com/media/y.jpg' }],
    },
  };
  const item = parseTweets(json)[0];
  assert.equal(item.text, 'Read more https://t.co/REAL and a pic');
  assert.deepEqual(item.urls, [
    { short: 'https://t.co/REAL', display: 'go.nasa.gov/x', expanded: 'https://go.nasa.gov/x' },
  ]);
});

test('parseTweets uses note_tweet.text for long tweets, media t.co stripped (TASK-033)', () => {
  const stripped = 'The full long body of the tweet that goes well beyond the 280-character limit and keeps going.';
  const json = {
    data: [{
      id: '3', created_at: '2026-07-04T00:00:00.000Z', author_id: 'u1',
      text: 'The full long body of the tweet that goes… https://t.co/M',
      note_tweet: { text: stripped + ' https://t.co/M' },
      attachments: { media_keys: ['3_3'] },
      entities: { urls: [{ url: 'https://t.co/M', display_url: 'pic.x.com/M', expanded_url: 'https://x.com/NASA/status/3/photo/1', media_key: '3_3' }] },
    }],
    includes: {
      users: [{ id: 'u1', username: 'NASA', name: 'NASA' }],
      media: [{ media_key: '3_3', type: 'photo', url: 'https://pbs.twimg.com/media/z.jpg' }],
    },
  };
  const item = parseTweets(json)[0];
  assert.equal(item.text, stripped);
});

test('parseTweets passes text through as data (no markup) and yields [] urls with no entities', () => {
  const json = {
    data: [{ id: '4', created_at: '2026-07-04T00:00:00.000Z', author_id: 'u1', text: 'hi <b>x</b> "q" & more' }],
    includes: { users: [{ id: 'u1', username: 'NASA', name: 'NASA' }] },
  };
  const item = parseTweets(json)[0];
  assert.equal(item.text, 'hi <b>x</b> "q" & more');
  assert.deepEqual(item.urls, []);
});

test('parseTweets yields [] urls for the captured fixture (no entities field) — back-compat', () => {
  const items = parseTweets(fx('twitter-tweets.json'));
  assert.deepEqual(items[0].urls, []);
});

// ── parseTweets quoted (referenced) tweet — TASK-034 ──────────────────────────
// A quote tweet carries referenced_tweets:[{type:'quoted', id}]; the quoted tweet is in
// includes.tweets and its author in includes.users. We surface { text, author, url } and strip
// the redundant quoted-status link from the main text. Shapes mirror the live probe (2026-07-05).

test('parseTweets surfaces a quoted tweet and strips its link from the text (TASK-034)', () => {
  const json = {
    data: [{
      id: '900000', created_at: '2026-07-05T00:00:00.000Z', author_id: 'u1',
      text: 'Great point here https://t.co/QUOTE',
      referenced_tweets: [{ type: 'quoted', id: '900001' }],
      entities: { urls: [{ url: 'https://t.co/QUOTE', display_url: 'twitter.com/steve/…', expanded_url: 'https://twitter.com/steve/status/900001' }] },
    }],
    includes: {
      users: [
        { id: 'u1', username: 'elonmusk', name: 'Elon Musk' },
        { id: 'u2', username: 'steve', name: 'Steve S' },
      ],
      tweets: [{ id: '900001', author_id: 'u2', text: 'The original insight goes here.' }],
    },
  };
  const item = parseTweets(json)[0];
  assert.equal(item.text, 'Great point here');   // redundant quoted-status link removed
  assert.deepEqual(item.urls, []);               // and NOT surfaced as a link
  assert.deepEqual(item.quoted, {
    text: 'The original insight goes here.',
    author: { name: 'Steve S', handle: 'steve' },
    url: 'https://x.com/steve/status/900001',
  });
});

test('parseTweets strips t.co links inside the quoted preview text (TASK-034)', () => {
  const json = {
    data: [{
      id: '900000', created_at: '2026-07-05T00:00:00.000Z', author_id: 'u1',
      text: 'wow https://t.co/QUOTE',
      referenced_tweets: [{ type: 'quoted', id: '900001' }],
      entities: { urls: [{ url: 'https://t.co/QUOTE', expanded_url: 'https://x.com/steve/status/900001' }] },
    }],
    includes: {
      users: [{ id: 'u1', username: 'elonmusk', name: 'Elon Musk' }, { id: 'u2', username: 'steve', name: 'Steve S' }],
      tweets: [{ id: '900001', author_id: 'u2', text: 'Look at this photo https://t.co/PIC',
        entities: { urls: [{ url: 'https://t.co/PIC', media_key: '3_9', expanded_url: 'https://x.com/steve/status/900001/photo/1' }] } }],
    },
  };
  assert.equal(parseTweets(json)[0].quoted.text, 'Look at this photo');
});

test('parseTweets sets no quoted field for a plain (non-quote) tweet (TASK-034)', () => {
  const items = parseTweets(fx('twitter-tweets.json'));
  assert.equal(items[0].quoted, undefined);
});

test('parseTweets ignores replied_to / retweeted references (TASK-034)', () => {
  const mk = type => ({
    data: [{ id: '900000', created_at: '2026-07-05T00:00:00.000Z', author_id: 'u1', text: 'x', referenced_tweets: [{ type, id: '900001' }] }],
    includes: { users: [{ id: 'u1', username: 'a', name: 'A' }], tweets: [{ id: '900001', author_id: 'u1', text: 'ref' }] },
  });
  assert.equal(parseTweets(mk('replied_to'))[0].quoted, undefined);
  assert.equal(parseTweets(mk('retweeted'))[0].quoted, undefined);
});

test('parseTweets leaves the link and emits no quoted when the quoted tweet is missing from includes (TASK-034)', () => {
  const json = {
    data: [{
      id: '900000', created_at: '2026-07-05T00:00:00.000Z', author_id: 'u1',
      text: 'See this https://t.co/QUOTE',
      referenced_tweets: [{ type: 'quoted', id: '900001' }],
      entities: { urls: [{ url: 'https://t.co/QUOTE', display_url: 'x.com/steve/…', expanded_url: 'https://x.com/steve/status/900001' }] },
    }],
    includes: { users: [{ id: 'u1', username: 'a', name: 'A' }] }, // no includes.tweets
  };
  const item = parseTweets(json)[0];
  assert.equal(item.quoted, undefined);
  assert.equal(item.text, 'See this https://t.co/QUOTE'); // link NOT stripped (still useful)
  assert.deepEqual(item.urls, [{ short: 'https://t.co/QUOTE', display: 'x.com/steve/…', expanded: 'https://x.com/steve/status/900001' }]);
});

test('parseTweets emits no quoted (link kept) when the quoted author is missing from includes (TASK-034)', () => {
  const json = {
    data: [{
      id: '900000', created_at: '2026-07-05T00:00:00.000Z', author_id: 'u1',
      text: 'See this https://t.co/QUOTE',
      referenced_tweets: [{ type: 'quoted', id: '900001' }],
      entities: { urls: [{ url: 'https://t.co/QUOTE', display_url: 'x.com/steve/…', expanded_url: 'https://x.com/steve/status/900001' }] },
    }],
    includes: {
      users: [{ id: 'u1', username: 'a', name: 'A' }],   // u2 (quoted author) absent
      tweets: [{ id: '900001', author_id: 'u2', text: 'ref' }],
    },
  };
  const item = parseTweets(json)[0];
  assert.equal(item.quoted, undefined);
  assert.equal(item.text, 'See this https://t.co/QUOTE');
});

// ── pageStep — incremental pagination loop control (TASK-040) ─────────────────
// After fetching a page: keep going only if there's a next_token AND we're under the cap;
// flag `capped` only when we stop early WITH more still pending (older posts skipped).

test('pageStep stops without capping when the timeline is exhausted (no next_token)', () => {
  assert.deepEqual(pageStep({ nextToken: null, pages: 1, cap: 2 }), { more: false, capped: false });
});

test('pageStep continues while under the cap and more pages remain', () => {
  assert.deepEqual(pageStep({ nextToken: 't', pages: 1, cap: 2 }), { more: true, capped: false });
});

test('pageStep stops AND caps when the cap is reached with more still pending', () => {
  assert.deepEqual(pageStep({ nextToken: 't', pages: 2, cap: 2 }), { more: false, capped: true });
});

test('pageStep does NOT cap when it exhausts exactly at the cap (nothing pending)', () => {
  // last page landed right on the cap but had no next_token → we got everything, not capped
  assert.deepEqual(pageStep({ nextToken: null, pages: 2, cap: 2 }), { more: false, capped: false });
});

test('pageStep caps defensively if pages somehow exceed the cap', () => {
  assert.deepEqual(pageStep({ nextToken: 't', pages: 3, cap: 2 }), { more: false, capped: true });
});

// ── xFetch fallback trigger ───────────────────────────────────────────────────

test('xFetch returns null when no token is set (X source simply unavailable)', async () => {
  const saved = process.env.X_BEARER_TOKEN;
  delete process.env.X_BEARER_TOKEN;
  try {
    assert.equal(await xFetch('users/by/username/NASA', {}), null);
  } finally {
    if (saved !== undefined) process.env.X_BEARER_TOKEN = saved;
  }
});

// ── xFetch resilience: retry-with-backoff + host fallback (BUG-009) ───────────
// A transient 5xx (e.g. BUG-008's 503) or a whole-host outage must NOT take the X
// source dark: retry the same host, then fall over to the other host. But a 4xx is a
// real answer (bad token / no credits / no such user / rate-limit) — fail fast, no
// retry, no double-charge. xFetch takes injectable { fetchImpl, sleep } so these
// branches (which can't be summoned from live X on demand) are driven deterministically.

// Fake fetch replaying scripted outcomes in order: each entry is { status, body }
// (Response-like) or an Error (network failure / timeout — thrown). Records each URL;
// throws if called more often than scripted (an unexpected extra call fails loudly).
function scriptedFetch(outcomes) {
  const calls = [];
  let i = 0;
  const impl = async (url) => {
    calls.push(url);
    if (i >= outcomes.length) throw new Error(`unexpected extra fetch (call #${calls.length})`);
    const o = outcomes[i++];
    if (o instanceof Error) throw o;
    return { ok: o.status >= 200 && o.status < 300, status: o.status, json: async () => o.body };
  };
  impl.calls = calls;
  return impl;
}

// No-wait sleep that records the backoff durations it was asked to wait.
function recordingSleep() {
  const waits = [];
  const sleep = async ms => { waits.push(ms); };
  sleep.waits = waits;
  return sleep;
}

const TW = 'https://api.twitter.com/2/'; // primary host (BUG-008: the stable v2 host)
const XC = 'https://api.x.com/2/';       // fallback host

test('isTransient: 5xx is transient (retry/fallback); 4xx is a real answer (fail fast)', () => {
  for (const s of [500, 502, 503]) assert.equal(isTransient(s), true, `${s} should be transient`);
  for (const s of [400, 401, 402, 404, 429]) assert.equal(isTransient(s), false, `${s} should be terminal`);
});

test('xFetch retries a transient 503 on the same host, then returns the 200 body', async () => {
  process.env.X_BEARER_TOKEN = 'test-token';
  const fetchImpl = scriptedFetch([{ status: 503 }, { status: 200, body: { data: 'ok' } }]);
  const sleep = recordingSleep();
  const out = await xFetch('users/1/tweets', { max_results: '20' }, { fetchImpl, sleep });
  assert.deepEqual(out, { data: 'ok' });
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls.every(u => u.startsWith(TW)), 'both attempts on the primary host');
  assert.equal(sleep.waits.length, 1, 'one backoff between the two attempts');
});

test('xFetch falls over to api.x.com when the primary host stays 5xx, returns its 200', async () => {
  process.env.X_BEARER_TOKEN = 'test-token';
  const fetchImpl = scriptedFetch([{ status: 502 }, { status: 502 }, { status: 200, body: { data: 'via-x' } }]);
  const sleep = recordingSleep();
  const out = await xFetch('users/1/tweets', {}, { fetchImpl, sleep });
  assert.deepEqual(out, { data: 'via-x' });
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(fetchImpl.calls[0].startsWith(TW) && fetchImpl.calls[1].startsWith(TW), 'primary host tried twice');
  assert.ok(fetchImpl.calls[2].startsWith(XC), 'then fell over to the fallback host');
});

test('xFetch does NOT retry a 429 (rate-limit is real): one call, throws with .status', async () => {
  process.env.X_BEARER_TOKEN = 'test-token';
  const fetchImpl = scriptedFetch([{ status: 429 }]);
  const sleep = recordingSleep();
  await assert.rejects(
    () => xFetch('users/1/tweets', {}, { fetchImpl, sleep }),
    err => err.status === 429,
  );
  assert.equal(fetchImpl.calls.length, 1, 'no retry, no host switch');
  assert.equal(sleep.waits.length, 0, 'no backoff on a terminal answer');
});

test('xFetch treats a network error / timeout as transient and retries', async () => {
  process.env.X_BEARER_TOKEN = 'test-token';
  const fetchImpl = scriptedFetch([new Error('ECONNRESET'), { status: 200, body: { data: 'recovered' } }]);
  const sleep = recordingSleep();
  const out = await xFetch('users/1/tweets', {}, { fetchImpl, sleep });
  assert.deepEqual(out, { data: 'recovered' });
  assert.equal(fetchImpl.calls.length, 2);
});

test('xFetch throws the last error when every host attempt fails (X marked down)', async () => {
  process.env.X_BEARER_TOKEN = 'test-token';
  // 2 hosts × 2 attempts = 4 total; all 503 → give up and surface the failure
  const fetchImpl = scriptedFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
  const sleep = recordingSleep();
  await assert.rejects(
    () => xFetch('users/1/tweets', {}, { fetchImpl, sleep }),
    err => err.status === 503,
  );
  assert.equal(fetchImpl.calls.length, 4, 'exhausted both hosts, twice each');
  assert.ok(fetchImpl.calls.slice(0, 2).every(u => u.startsWith(TW)), 'primary host first');
  assert.ok(fetchImpl.calls.slice(2, 4).every(u => u.startsWith(XC)), 'then the fallback host');
});
