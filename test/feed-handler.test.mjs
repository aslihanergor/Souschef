// /api/feed handler tests — the X path (TASK-100).
//
// FIRST handler test for this endpoint. `test/feed.test.mjs` covers the pure parsers only, so until
// now nothing could ask what `/api/feed` does with an actual request: not which requests reach X,
// not what a cap looks like to a caller, not whether validation happens before we spend money.
// TASK-100 adds per-user quotas here, and a quota is unassertable without that.
//
// These are CHARACTERISATION tests of the behaviour on `main` — they pin what the endpoint does
// today, before any quota exists. F8 deliberately pins a conflation the task will CHANGE (an X
// cap and a network blip are both 502 today, which is why the app tells the user "Couldn't load…
// Try reopening the feed" and invites a retry that costs money). When criteria 9 and 10 land, F8
// is expected to change — and it should be changed knowingly, not discovered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedHandler } from '../api/feed.js';
import { fakeDb, fakeReq, fakeRes, fakeXFetch, xPage, xError } from '../test-helpers/handler.mjs';

const USER_ID = '1234567890';

// Every call here is SIGNED IN ([BUG-025]). These tests characterise what the endpoint does with a
// request it SERVES, and since BUG-025 it serves only a confirmed session — so the helper supplies one,
// and a store for the X path to meter that account against. Nothing asserted below changed meaning
// (Asli, 2026-09-13: "3 yes"); the signed-out behaviour lives in test/signed-in-gate.test.mjs.
const SIGNED_IN = { accountId: 'acct-f', email: 'f@example.com' };

// Build the handler over canned X pages. Returns the res so tests assert on the response, and the
// fake so they can assert on what went out to X — the billable side effect.
function feedWith(pages) {
  const xf = fakeXFetch(pages);
  return {
    handler: createFeedHandler({ xFetch: xf, db: () => fakeDb({}), sessionAccount: async () => SIGNED_IN }),
    xf,
  };
}

async function callTwitter(pages, { sourceId = USER_ID, sinceId } = {}) {
  const { handler, xf } = feedWith(pages);
  const res = fakeRes();
  const query = { source: 'twitter', sourceId };
  if (sinceId) query.sinceId = sinceId;
  await handler(fakeReq({ query }), res);
  return { res, xf };
}

// A date safely outside WINDOW_DAYS (14) regardless of when the suite runs.
const LONG_AGO = new Date(Date.now() - 400 * 86400_000).toISOString();
const RECENT = new Date(Date.now() - 60_000).toISOString();

test('F1 an invalid sourceId is refused BEFORE any billable X call goes out', async () => {
  const { res, xf } = await callTwitter([], { sourceId: 'not-numeric' });
  assert.equal(res.statusCode, 400);
  assert.equal(xf.calls.length, 0, 'validation must not cost an X read');
});

test('F2 no X token configured → 502, and the caller is told it is not configured', async () => {
  const { res } = await callTwitter([null]);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'X not configured');
});

test('F3 a first fetch (no sinceId) asks for ONE shallow page and no since_id', async () => {
  const { res, xf } = await callTwitter([xPage({ ids: ['11'], at: RECENT })]);
  assert.equal(res.statusCode, 200);
  assert.equal(xf.calls.length, 1);
  assert.equal(xf.calls[0].endpoint, `users/${USER_ID}/tweets`);
  assert.equal(xf.calls[0].params.max_results, '20');
  assert.ok(!('since_id' in xf.calls[0].params), 'a first fetch must not send since_id');
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].id, '11');
  assert.equal(res.body.capped, false);
});

test('F4 the X response is never shared-cached (per-user cursor + per-app credits)', async () => {
  const { res } = await callTwitter([xPage({ ids: ['11'], at: RECENT })]);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('F5 posts older than the 14-day window are dropped from the response', async () => {
  const { res } = await callTwitter([xPage({ ids: ['old'], at: LONG_AGO })]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 0);
});

test('F6 an incremental fetch pages until X runs out, and is not capped', async () => {
  const { res, xf } = await callTwitter(
    [xPage({ ids: ['21'], at: RECENT, nextToken: 'tok' }), xPage({ ids: ['22'], at: RECENT })],
    { sinceId: '20' },
  );
  assert.equal(xf.calls.length, 2);
  assert.equal(xf.calls[0].params.since_id, '20');
  assert.equal(xf.calls[0].params.max_results, '100');
  assert.equal(xf.calls[1].params.pagination_token, 'tok');
  assert.deepEqual(res.body.items.map((i) => i.id), ['21', '22']);
  assert.equal(res.body.capped, false);
});

test('F7 an incremental fetch stops at X_PAGE_CAP and reports capped', async () => {
  const { res, xf } = await callTwitter(
    [
      xPage({ ids: ['31'], at: RECENT, nextToken: 'a' }),
      xPage({ ids: ['32'], at: RECENT, nextToken: 'b' }),
    ],
    { sinceId: '30' },
  );
  assert.equal(xf.calls.length, 2, 'the page cap is what bounds the spend — a third call is a defect');
  assert.equal(res.body.capped, true);
  assert.equal(res.statusCode, 200);
});

// CHANGED DELIBERATELY, and this is the record of why. The original F8 asserted that an X 402 was
// reported as a BARE 502, identical to a network blip — it pinned the defect rather than a
// requirement, and said so in its own comment. Criteria 9 and 10, signed off at scoping, change that
// contract: a cap must be distinguishable so the client can stop telling people to retry into a
// wall. This is the "confirm the requirement changed" branch of the never-change-a-test rule, not
// the "make it pass" one.
test('F8 an X 402 (app-wide cap) is tagged as a cap, not left as a bare failure', async () => {
  const { res } = await callTwitter([xError(402)]);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.reason, 'cap');
});

test('F9 an X 429 (rate-limited by X) is tagged the same way — neither clears on a retry', async () => {
  const { res } = await callTwitter([xError(429)]);
  assert.equal(res.body.reason, 'cap');
});

test('F10 a transient failure is NOT tagged, so it keeps the retry message', async () => {
  const { res } = await callTwitter([xError(503)]);
  assert.equal(res.statusCode, 502);
  assert.ok(!('reason' in res.body), 'a blip really is worth retrying — only a cap is not');
});
