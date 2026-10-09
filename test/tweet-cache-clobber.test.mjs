// [BUG-109] Parallel X channel loads clobber each other's tweetCache.
//
// `loadTwitterChannel` reads the whole cache object BEFORE its fetch await, then writes the whole
// object back after. `loadFeed` runs channels through Promise.all, so every channel writes a
// snapshot taken before any of them finished — and the last writer wins. Pre-existing, and invisible
// for as long as every render was built from freshly fetched data.
//
// TASK-100 made it visible by making the cache load-bearing for what is DISPLAYED: at quota the feed
// renders FROM the cache, so a clobbered channel contributes nothing. Found in Asli's live-verify —
// 41 unread became 24 across one refresh with nothing archived and nothing marked done.
//
// B1 pins the mechanism, B2 the symptom she actually saw. Both are needed: B1 alone would keep
// passing if the cache were written correctly but read from the wrong place, and B2 alone would not
// say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';

const mkChannel = (id, name) => ({ id, name, handle: name.toLowerCase(), keyword: '', source: 'twitter' });
const CH_A = mkChannel('111', 'Alpha');
const CH_B = mkChannel('222', 'Beta');

// `n` posts for a channel, newest first, all comfortably inside the 14-day window.
//
// Ids must be NUMERIC STRINGS. `loadTwitterChannel` derives since_id with `BigInt(t.id)`, so a
// non-numeric fixture id throws and the channel is filed as failed — which fails this test for a
// reason that has nothing to do with the cache. Cost one round; real X ids are numeric snowflakes.
const postsFor = (base, n) => Array.from({ length: n }, (_, i) => ({
  id: String(base + i),
  text: `post ${base + i}`,
  published: new Date(Date.now() - i * 3600_000).toISOString(),
}));

const A_POSTS = postsFor(1_000_000, 5);
const B_POSTS = postsFor(2_000_000, 5);

function boot() {
  const app = createApp({ store: { focus_channels: JSON.stringify([CH_A, CH_B]) } });
  let quota = false;
  app.setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/api/group')) return { ok: true, status: 200, json: async () => ({ groups: null }) };
    if (u.includes('source=twitter')) {
      if (quota) return { ok: false, status: 429, json: async () => ({ reason: 'quota' }) };
      const items = u.includes('sourceId=222') ? B_POSTS : A_POSTS;
      return { ok: true, status: 200, json: async () => ({ items, capped: false }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  });
  return { app, setQuota: () => { quota = true; } };
}

test('B1 two X channels loaded in parallel BOTH keep their cache entry', async () => {
  const { app } = boot();
  await app.ctx.loadFeed();
  const cache = JSON.parse(app.get('focus_tweet_cache') || '{}');
  assert.deepEqual(Object.keys(cache).sort(), ['111', '222'],
    'one channel\'s entry was overwritten by the other\'s stale snapshot');
  assert.equal(cache['111'].length, 5);
  assert.equal(cache['222'].length, 5);
});

test('B2 the unread count does not drop when a later load falls back to the cache', async () => {
  // Asli's symptom, end to end: a good load, then a quota'd one, with nothing read or archived
  // in between. The feed is rebuilt from the cache and must hold the same posts.
  const { app, setQuota } = boot();
  const first = await app.ctx.loadFeed();
  app.ctx.renderFeedResults(first);
  const before = app.el('feed-count').textContent;

  setQuota();
  const second = await app.ctx.loadFeed();
  app.ctx.renderFeedResults(second);

  assert.equal(second.items.length, first.items.length,
    `posts vanished across a refresh: ${first.items.length} -> ${second.items.length}`);
  assert.equal(app.el('feed-count').textContent, before);
  assert.equal(before, '10 new', 'guard: both channels really did contribute');
});
