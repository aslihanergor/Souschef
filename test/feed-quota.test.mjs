// Per-user X quotas — the handler half.
//
// The assertion that matters is C6: over quota, NO X call goes out. X bills on retrieval, so a 429
// that still fetched has spent the money and merely hidden the posts. Everything else here is
// bookkeeping around that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFeedHandler } from '../api/feed.js';
import { fakeDb, fakeReq, fakeRes, fakeXFetch, xPage, xError } from '../test-helpers/handler.mjs';

const USER_ID = '1234567890';
const ACCOUNT = { accountId: 'acct-aaa', email: 'a@example.com' };
const OTHER_ACCOUNT = { accountId: 'acct-bbb', email: 'b@example.com' };
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

const NOON = Date.UTC(2026, 8, 1, 12, 0, 0);
const DAY = '2026-09-01';
const RECENT = new Date(NOON - 60_000).toISOString();
const LONG_AGO = new Date(NOON - 400 * 86400_000).toISOString();

// One handler over a given store. `sql` is passed in so two callers can share one database, which
// is what C3 (two users, one post) needs.
function feedOn(sql, { pages = [], account = null, env = {}, now = () => NOON } = {}) {
  const xf = fakeXFetch(pages);
  const handler = createFeedHandler({
    xFetch: xf, db: () => sql, sessionAccount: async () => account, now, env,
  });
  return { handler, xf };
}

async function twitterCall(handler, { headers = {}, sinceId } = {}) {
  const res = fakeRes();
  const query = { source: 'twitter', sourceId: USER_ID };
  if (sinceId) query.sinceId = sinceId;
  await handler(fakeReq({ query, headers }), res);
  return res;
}

test('C1a a signed-in fetch is attributed to the ACCOUNT id', async () => {
  const sql = fakeDb({});
  const { handler } = feedOn(sql, { pages: [xPage({ ids: ['1', '2'], at: RECENT })], account: ACCOUNT });
  await twitterCall(handler, { headers: { 'x-device-id': DEVICE_ID } });
  assert.equal(sql.postsFor('account', ACCOUNT.accountId, DAY), 2);
  assert.equal(sql.postsFor('device', DEVICE_ID, DAY), 0, 'a session must outrank the client-supplied id');
});

// C1b, C1c and C15: a request with no session must be REFUSED, even when it sends a
// device id. Serving it — counted against the device id — would bill an anonymous X fetch that meets no
// quota, so each asserts the refusal, and that nothing went out to X.
test('C1b a signed-out fetch with a device header is REFUSED — no X call, no device row', async () => {
  const sql = fakeDb({});
  const { handler, xf } = feedOn(sql, { pages: [xPage({ ids: ['1'], at: RECENT })] });
  const res = await twitterCall(handler, { headers: { 'x-device-id': DEVICE_ID } });
  assert.equal(res.statusCode, 401);
  assert.equal(xf.calls.length, 0, 'X bills on retrieval — a refusal that still fetched has spent the money');
  assert.equal(sql.postsFor('device', DEVICE_ID, DAY), 0);
});

test('C1c with no identity at all the X fetch is REFUSED, and nothing is recorded', async () => {
  const sql = fakeDb({});
  const { handler, xf } = feedOn(sql, { pages: [xPage({ ids: ['1'], at: RECENT })] });
  const res = await twitterCall(handler);
  assert.equal(res.statusCode, 401);
  assert.equal(xf.calls.length, 0);
  assert.equal(sql.usage.length, 0);
  assert.equal(sql.spendOn(DAY), 0);
});

test('C2 the counter counts what X RETURNED, not what survives the 14-day window', async () => {
  // X billed us for both posts. The window filter drops one from the response afterwards; counting
  // post-filter would undercount every fetch that reaches back past the window.
  const page = {
    data: [
      { id: 'fresh', text: 'a', created_at: RECENT, author_id: 'u1' },
      { id: 'stale', text: 'b', created_at: LONG_AGO, author_id: 'u1' },
    ],
    includes: { users: [{ id: 'u1', username: 'sam', name: 'Sam' }] },
    meta: {},
  };
  const sql = fakeDb({});
  const { handler } = feedOn(sql, { pages: [page], account: ACCOUNT });
  const res = await twitterCall(handler);
  assert.equal(res.body.items.length, 1, 'the response is still windowed');
  assert.equal(sql.postsFor('account', ACCOUNT.accountId, DAY), 2, 'but both posts were billed');
});

test('C3 the same post read by TWO users bills once app-wide but counts for each of them', async () => {
  const sql = fakeDb({});
  const a = feedOn(sql, { pages: [xPage({ ids: ['shared'], at: RECENT })], account: ACCOUNT });
  const b = feedOn(sql, { pages: [xPage({ ids: ['shared'], at: RECENT })], account: OTHER_ACCOUNT });
  await twitterCall(a.handler);
  await twitterCall(b.handler);
  assert.equal(sql.postsFor('account', ACCOUNT.accountId, DAY), 1);
  assert.equal(sql.postsFor('account', OTHER_ACCOUNT.accountId, DAY), 1);
  assert.equal(sql.spendOn(DAY), 1, 'X deduplicates within a day — the app paid for ONE post');
});

test('C4 two channels in one refresh sum into ONE row for the day', async () => {
  const sql = fakeDb({});
  const { handler } = feedOn(sql, {
    pages: [xPage({ ids: ['1', '2'], at: RECENT }), xPage({ ids: ['3'], at: RECENT })],
    account: ACCOUNT,
  });
  await twitterCall(handler);
  await twitterCall(handler);
  assert.equal(sql.usage.length, 1, 'one owner, one day, one row');
  assert.equal(sql.postsFor('account', ACCOUNT.accountId, DAY), 3);
});

test('C5 with no quota configured a heavy user is never refused', async () => {
  const sql = fakeDb({ xUsage: [{ owner_kind: 'account', owner_id: ACCOUNT.accountId, day: DAY, posts: 10_000_000 }] });
  const { handler, xf } = feedOn(sql, { pages: [xPage({ ids: ['1'], at: RECENT })], account: ACCOUNT, env: {} });
  const res = await twitterCall(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(xf.calls.length, 1);
});

test('C6 over quota returns 429 AND issues no X call at all', async () => {
  const sql = fakeDb({ xUsage: [{ owner_kind: 'account', owner_id: ACCOUNT.accountId, day: DAY, posts: 400 }] });
  const { handler, xf } = feedOn(sql, {
    pages: [xPage({ ids: ['1'], at: RECENT })], account: ACCOUNT, env: { X_DAILY_POST_QUOTA: '400' },
  });
  const res = await twitterCall(handler);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.reason, 'quota');
  assert.equal(xf.calls.length, 0, 'a 429 that still fetched has already spent the money');
});

test('C7 the quota gate is X-only — it does not short-circuit another source', async () => {
  // The server-side half. A YouTube request under the same over-quota session still
  // reaches its OWN validation rather than the quota's 429. YouTube and
  // Substack items still rendering in the same load is a client assertion.
  const sql = fakeDb({ xUsage: [{ owner_kind: 'account', owner_id: ACCOUNT.accountId, day: DAY, posts: 400 }] });
  const { handler } = feedOn(sql, { account: ACCOUNT, env: { X_DAILY_POST_QUOTA: '400' } });
  const res = fakeRes();
  await handler(fakeReq({ query: { channelId: 'not-a-channel' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid channelId');
});

test('C15 a DEVICE-identified requester is refused whatever its count — only a session is served', async () => {
  // With C1b and C1c above. A device id is client-supplied and rotatable, so it is
  // not an identity to enforce a quota on — nor one to serve on.
  const sql = fakeDb({ xUsage: [{ owner_kind: 'device', owner_id: DEVICE_ID, day: DAY, posts: 400 }] });
  const { handler, xf } = feedOn(sql, {
    pages: [xPage({ ids: ['1'], at: RECENT })], env: { X_DAILY_POST_QUOTA: '400' },
  });
  const res = await twitterCall(handler, { headers: { 'x-device-id': DEVICE_ID } });
  assert.equal(res.statusCode, 401);
  assert.equal(xf.calls.length, 0);
  assert.equal(sql.postsFor('device', DEVICE_ID, DAY), 400, 'refused before the meter, so the row is untouched');
});

test('C12 a counting failure serves the feed rather than refusing it', async () => {
  const sql = fakeDb({ throwOn: 'select posts from x_usage' });
  const { handler, xf } = feedOn(sql, {
    pages: [xPage({ ids: ['1'], at: RECENT })], account: ACCOUNT, env: { X_DAILY_POST_QUOTA: '1' },
  });
  const res = await twitterCall(handler);
  assert.equal(res.statusCode, 200, 'a DB blip must not look like a quota refusal');
  assert.equal(xf.calls.length, 1);
});

test('C13 fetches either side of UTC midnight land in different day rows', async () => {
  const sql = fakeDb({});
  const before = feedOn(sql, {
    pages: [xPage({ ids: ['1'], at: RECENT })], account: ACCOUNT,
    now: () => Date.UTC(2026, 7, 31, 23, 59, 59, 999),
  });
  const after = feedOn(sql, {
    pages: [xPage({ ids: ['2'], at: RECENT })], account: ACCOUNT,
    now: () => Date.UTC(2026, 8, 1, 0, 0, 0, 0),
  });
  await twitterCall(before.handler);
  await twitterCall(after.handler);
  assert.equal(sql.postsFor('account', ACCOUNT.accountId, '2026-08-31'), 1);
  assert.equal(sql.postsFor('account', ACCOUNT.accountId, '2026-09-01'), 1);
});

test('C14 a failed fetch records nothing — X returned no posts to bill', async () => {
  const sql = fakeDb({});
  const { handler } = feedOn(sql, { pages: [xError(402)], account: ACCOUNT });
  const res = await twitterCall(handler);
  assert.ok(res.statusCode >= 400);
  assert.equal(sql.postsFor('account', ACCOUNT.accountId, DAY), 0);
  assert.equal(sql.spendOn(DAY), 0);
});

test('[BUG-122] every window cutoff in api/feed.js reads the injected clock, never the real one', () => {
  // If the handler reads two clocks — its quota day from the injected `now()` and its 14-day window from
  // `Date.now()` — a test pinning the clock pins only half of it, and C2 above, whose "fresh" post is
  // dated from that pin, ages out of the real window and reds every branch. A scan rather
  // than a behaviour test per path, because the YouTube and Substack paths have no fixture that could
  // notice, and this is the one shape that must not come back.
  const src = readFileSync(new URL('../api/feed.js', import.meta.url), 'utf8');
  const cutoffs = [...src.matchAll(/const cutoff = (.+?) - WINDOW_DAYS \* 86400_000;/g)].map((m) => m[1].trim());
  assert.equal(cutoffs.length, 3, `guard: expected the three window cutoffs (YouTube, X, Substack), found ${cutoffs.length}`);
  assert.deepEqual(cutoffs.filter((c) => c !== 'now()'), [], 'every cutoff is computed from the injected clock');
});
