// The client half of the per-reader X quota and the app-wide cap.
//
// If `loadTwitterChannel` threw on ANY non-OK response, `loadFeed` would file it under `failed`
// and the user would read "Couldn't load: @x. Try reopening the feed." A quota 429 rendered that way
// would be worse than having no quota at all: the advice is wrong, and acting on it spends more of
// the cap. These pin the three outcomes apart.
//
// ON VACUITY. `#feed-note`, `#feed-error` and `#caughtup` all ship `class="… hidden"`. `caughtup` is
// seeded in the harness's HIDDEN_IDS, so "it stayed hidden" is a claim that can be false; the other
// two are NOT seeded, which makes a fresh stub's classList empty and any "is hidden" assertion
// STRICTER rather than weaker — it can only pass if the code actively hid the element. L6 exists so
// L5 is not the vacuous direction: it shows the same render DOES reveal caught-up when nothing is
// withheld.
//
// THERE IS NO QUOTA MESSAGE. A refused reader is told NOTHING while their cache is warm,
// and reads the neutral source-unavailable line only when it is cold and the screen would otherwise
// be blank.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';

const X_CHANNEL = { id: '111', name: 'Sam', handle: 'sam', keyword: '', source: 'twitter' };
const CACHED = [{ id: '900', text: 'cached post', published: '2026-08-31T10:00:00.000Z' }];

// An app whose only channel is X, with a programmable /api/feed reply.
function boot({ reply, cache = null, lastLoad = null } = {}) {
  const store = { focus_channels: JSON.stringify([X_CHANNEL]) };
  if (cache) store.focus_tweet_cache = JSON.stringify({ [X_CHANNEL.id]: cache });
  if (lastLoad) store.focus_last_feed_load = String(lastLoad);
  const app = createApp({ store });
  app.setFetch(async (url) => {
    if (String(url).includes('/api/group')) return { ok: true, status: 200, json: async () => ({ groups: null }) };
    if (String(url).includes('source=twitter')) return reply;
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  });
  return app;
}

const QUOTA = { ok: false, status: 429, json: async () => ({ error: "You've hit today's X limit", reason: 'quota' }) };
const CAP = { ok: false, status: 502, json: async () => ({ error: 'feed fetch failed', reason: 'cap' }) };
const BLIP = { ok: false, status: 502, json: async () => ({ error: 'feed fetch failed' }) };

// Run a full load + render, the way openFeedView does.
async function loadAndRender(app) {
  const result = await app.ctx.loadFeed();
  app.ctx.renderFeedResults(result);
  return result;
}

test('L1 at quota with a warm cache the reader is told NOTHING AT ALL (criterion 15)', async () => {
  // The whole no-message rule in one assertion: a refused reader whose cached posts still render sees an
  // ordinary feed. Both elements are observed, not the absence of one string, so a message
  // reintroduced in different words is still caught here.
  const app = boot({ reply: QUOTA, cache: CACHED });
  const { items } = await loadAndRender(app);
  assert.equal(items.length, 1, 'guard: the warm-cache case, so this is not the blank-screen path');
  assert.equal(app.el('feed-note').textContent, '', 'no note');
  assert.ok(app.el('feed-note').classList.contains('hidden'), 'and the note element is hidden');
  assert.ok(app.el('feed-error').classList.contains('hidden'), 'nor is it reported as a load failure');
});

test('L2 an app-wide cap renders as a NOTE, not as a load error (criterion 9)', async () => {
  const app = boot({ reply: CAP });
  await loadAndRender(app);
  assert.match(app.el('feed-note').textContent, /catching its breath/);
  assert.ok(app.el('feed-error').classList.contains('hidden'));
});

test('L3 a transient failure still reads as one, and still says to retry (criterion 10)', async () => {
  const app = boot({ reply: BLIP });
  await loadAndRender(app);
  assert.match(app.el('feed-error').textContent, /Couldn't load: Sam/);
  assert.match(app.el('feed-error').textContent, /Try reopening/);
});

test('L4 cached X posts still render while the limit is on (criterion 7, client half)', async () => {
  const app = boot({ reply: QUOTA, cache: CACHED });
  const { items } = await loadAndRender(app);
  assert.equal(items.length, 1, 'the feed does not go empty — only new fetching stopped');
  assert.equal(items[0].id, '900');
});

test('L5 an X-only feed at quota with a cold cache does not go blank, nor claim caught-up (criteria 11, 17)', async () => {
  // At N=800 this is the state a real user reaches first (a cache clear on ~15 X accounts), which is
  // why the cold-cache fallback is load-bearing rather than defensive. Removing the note without this fallback
  // yields a completely blank app: `#feed` hidden, no count, no caught-up, no note.
  const app = boot({ reply: QUOTA });
  const { items } = await loadAndRender(app);
  assert.equal(items.length, 0, 'guard: this really is the empty case');
  assert.ok(app.el('caughtup').classList.contains('hidden'), 'empty because X stopped, not because you finished');
  assert.equal(app.el('feed-note').textContent,
    'X is catching its breath — your other sources are still updating.');
  assert.ok(!app.el('feed-note').classList.contains('hidden'), 'the screen must not be left blank');
});

test('L6 CONTROL: the same empty render DOES claim caught-up when nothing was withheld', async () => {
  const app = boot({ reply: { ok: true, status: 200, json: async () => ({ items: [], capped: false }) } });
  const { items } = await loadAndRender(app);
  assert.equal(items.length, 0);
  assert.ok(!app.el('caughtup').classList.contains('hidden'), 'without this, L5 proves nothing');
});

test('L7 neither limit note tells the user to retry — the retry is what costs money', async () => {
  for (const reply of [QUOTA, CAP]) {
    const app = boot({ reply });
    await loadAndRender(app);
    assert.ok(!/reopen|try again|retry/i.test(app.el('feed-note').textContent),
      `"${app.el('feed-note').textContent}" recommends the one action that spends more cap`);
  }
});

test('L8 the New-badge baseline does not advance while posts were withheld', async () => {
  // Advancing it here would compare tomorrow's fetch of today's withheld posts against today's
  // timestamp, so they would arrive already un-New — silently, and only for people who hit a limit.
  const app = boot({ reply: QUOTA, lastLoad: 1000 });
  await loadAndRender(app);
  assert.equal(app.get('focus_last_feed_load'), '1000', 'the baseline must stay where it was');
});

test('L9 the blank-screen fallback outranks TASK-040 skip-note when both apply', async () => {
  // The empty-cache fallback
  // has to win its one line: telling a reader that some OLDER posts were skipped, on a screen with no
  // posts on it at all, explains the wrong absence.
  const app = boot({ reply: QUOTA });
  const result = await app.ctx.loadFeed();
  result.cappedNames = ['@someone'];              // both conditions true in one render
  app.ctx.renderFeedResults(result);
  assert.equal(app.el('feed-note').textContent,
    'X is catching its breath — your other sources are still updating.',
    'the fallback explains the empty screen; the skip-note would explain something else');
});

test('L10 a stale limit note clears on the next clean render', async () => {
  // renderFeedNote is called on EVERY render precisely so a note cannot outlive its cause. Without
  // this, the fallback line would sit over a working feed until a reload — and nothing else in this
  // file asks whether the note ever goes away.
  const app = boot({ reply: QUOTA });
  await loadAndRender(app);
  assert.match(app.el('feed-note').textContent, /catching its breath/, 'guard: the note really was up');

  app.setFetch(async (url) => {
    if (String(url).includes('/api/group')) return { ok: true, status: 200, json: async () => ({ groups: null }) };
    return { ok: true, status: 200, json: async () => ({ items: [], capped: false }) };
  });
  await loadAndRender(app);
  assert.equal(app.el('feed-note').textContent, '');
  assert.ok(app.el('feed-note').classList.contains('hidden'));
});

test('L11 no user-visible surface names a quota, a limit or an allowance (criterion 16)', async () => {
  // Text-level rather than string-level on purpose: this has to catch a message reintroduced
  // in a DIFFERENT function or in different words, which an assertion against one known sentence
  // cannot. Scoped to the rendered states, because a source-wide grep would match every `limited
  // ?.quota` branch and comment in app.js and so could never fail honestly.
  const FORBIDDEN = /\b(limit|limits|limited|quota|quotas|allowance)\b/i;
  const SURFACES = ['feed-note', 'feed-error', 'feed-count'];
  const STATES = [
    ['quota, warm cache', QUOTA, CACHED],
    ['quota, cold cache', QUOTA, null],
    ['app-wide cap',      CAP,   null],
    ['transient failure', BLIP,  null],
  ];
  for (const [name, reply, cache] of STATES) {
    const app = boot({ reply, cache });
    await loadAndRender(app);
    for (const id of SURFACES) {
      const text = app.el(id)?.textContent || '';
      assert.ok(!FORBIDDEN.test(text), `${name}: #${id} says "${text}"`);
    }
  }
});

test('L12 a refused reader and an app-wide cap read IDENTICALLY — the wording is not a tell', async () => {
  // Two states that both mean "no new X right now, through no fault of yours" must be indistinguishable,
  // or a user comparing notes with a friend learns exactly what we chose not to tell them. Pinned by
  // comparing the two renders rather than by two copies of one literal, so the strings cannot drift apart.
  //
  // THE CAP ARM NEEDS A WARM CACHE. With a cold one
  // the empty-branch fallback overwrites the note for the cap path as well, so both arms come out of the
  // same final assignment and the comparison cannot fail, even if the fallback has its own
  // wording. A warm cache keeps items non-empty, so the cap arm never reaches the
  // fallback and reads the genuine renderFeedNote line — which is the string the design claims they share.
  const quotaApp = boot({ reply: QUOTA });          // cold: the fallback speaks
  await loadAndRender(quotaApp);
  const capApp = boot({ reply: CAP, cache: CACHED }); // warm: renderFeedNote speaks
  await loadAndRender(capApp);

  const refused = quotaApp.el('feed-note').textContent;
  assert.ok(refused.length > 0, 'guard: not two empty strings agreeing with each other');
  assert.equal(refused, capApp.el('feed-note').textContent);
});

test('L13 an app-wide cap with a cold cache also refuses caught-up, and holds the baseline', async () => {
  // The same guard covers both limits. It is pinned here because
  // deleting the `cap` term would otherwise go unnoticed: L2 asserts the note, L5
  // and L8 assert caught-up and the baseline but only for the quota half, so nothing else asks whether an
  // app-wide cap could claim you had finished. A guard whose second term nothing tests is half a guard.
  const app = boot({ reply: CAP, lastLoad: 1000 });
  const { items } = await loadAndRender(app);
  assert.equal(items.length, 0, 'guard: this really is the empty case');
  assert.ok(app.el('caughtup').classList.contains('hidden'), 'X paused; you did not finish');
  assert.equal(app.get('focus_last_feed_load'), '1000', 'and the New baseline must stay where it was');
});
