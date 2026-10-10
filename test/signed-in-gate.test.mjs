// The signed-in gate on /api/feed and /api/resolve-channel, and on /api/group.
//
// Both endpoints spend money or shared quota per request — X bills $0.005 a post read and $0.010 a
// user read, YouTube's daily quota burns on every Data API call — and ungated both would answer
// anyone. The quantity under test is therefore the OUTBOUND request, not only the status: a 401 that
// still fetched has already spent the money. Two instruments count it: the fake `xFetch` the feed
// handler takes, and a stub over `globalThis.fetch`, which every other upstream call resolves at call
// time (`ytFetch`, `xFetch` inside resolve-channel, `fetchRssXml`, `fetchSubstackXml` and the scrape).
//
// THE FAKE KEYS, and exactly what they buy. `xFetch` returns null BEFORE fetching when X_BEARER_TOKEN is
// unset, so without the X key resolve's X-handle branch would make no upstream request on the unfixed code
// either, and its "nothing sent upstream" would prove nothing. YouTube is different: without its key
// `ytFetch` skips the Data API, but RSS and the scrape still call `fetch`, so the YouTube branches are
// observable either way; the key is set so the Data API path is the one exercised.
// The G4 twins show every branch DOES reach the stub once it is allowed through.
//
// Sessions run through the REAL `sessionAccount`, so the tests see what the gate actually asks for — the
// cookie header it reads and the `strict` mode that separates "no session" from "could not check" — and a
// store failure is the REAL Neon driver's error (G6d), because a staged one carrying a `code` the
// driver never sets would let a gate serving only coded errors pass.
//
// DECISION B. When the session check cannot be made —
// the store errors, or has not answered within the time limit — YouTube and Substack are still served,
// and both X paths are refused with a 503, because X is the one that spends money and the account it
// would be billed against is unknown. The alternative, "serve every branch", would serve X unmetered to anyone
// sending any `focus_session` value for as long as a store failure lasted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neon, neonConfig } from '@neondatabase/serverless';
import { createFeedHandler } from '../api/feed.js';
import { createResolveHandler } from '../api/resolve-channel.js';
import { createGroupHandler } from '../api/group.js';
import * as session from '../api/_session.js';
import { hashToken } from '../api/_auth.js';
import { fakeDb, fakeReq, fakeRes, fakeXFetch, xPage } from '../test-helpers/handler.mjs';

process.env.X_BEARER_TOKEN = 'test-token-not-real';
process.env.YOUTUBE_API_KEY = 'test-key-not-real';

const { sessionAccount } = session;
const TOKEN = 'tok-alice';
const COOKIE = `focus_session=${TOKEN}`;
const UNKNOWN_COOKIE = 'focus_session=nobody-has-this';
const ALICE = { accountId: 'acct-alice', email: 'alice@example.com' };
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const FUTURE = new Date(Date.now() + 86400_000).toISOString();
const PAST = new Date(Date.now() - 86400_000).toISOString();
const RECENT = new Date(Date.now() - 60_000).toISOString();
const DAY = new Date().toISOString().slice(0, 10);

// A store failure as the real driver produces it: Neon's own client, with the network replaced by one
// that fails the way undici does on a reset. No request leaves the process. What comes back is a
// `NeonDbError` with no `code` — the property is `undefined` —
// and G6d pins it as `code ?? null`, so this fixture cannot drift back to a coded error.
neonConfig.fetchFunction = async () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
};
const unreachableNeon = neon('postgresql://u:p@ep-test-000000.us-east-2.aws.neon.tech/db');
const DB_DOWN = () => unreachableNeon`select 1`;

// The sessions table, wrapped around fakeDb — the pattern and the reason are
// test/require-account-r2.test.mjs's: a wrapper, so fakeDb's throw-on-anything-unrecognised property
// is not widened for every other file. Anything this does not recognise still falls through and throws.
//   store: 'ok'   — answers the lookup (Alice's token hits; any other misses)
//          'fail' — the lookup rejects with the real driver's error
//          'hang' — the lookup never answers
//
// Two kinds of count, on purpose. `lookups` and `failures` record what the fixture SET OUT to do; `rejected`
// and `resolved` record what the lookup it handed back actually DID, observed on that promise. Reading
// only the first kind is not enough: `failures` is bumped before the failure is staged — so a fixture that
// kept the bump and lost the `return` would answer Alice while its counter still said "failed", and a hang
// fixture that failed fast would look exactly like a hang.
function withSessions(sql, { expiresAt = FUTURE, store = 'ok' } = {}) {
  const state = { lookups: 0, failures: 0, rejected: 0, resolved: 0 };
  const observe = (answer) => answer.then(
    (rows) => { state.resolved += 1; return rows; },
    (e) => { state.rejected += 1; throw e; },
  );
  // The body keeps the indentation it had inside `wrapped`: mutation specs
  // find these lines by their exact text, and a mutation run with one absent anchor
  // refuses to run at all.
  const lookup = (values) => {
      if (store === 'fail') { state.failures += 1; return DB_DOWN(); }
      if (store === 'hang') return new Promise(() => {});
      if (hashToken(TOKEN) !== values[0]) return Promise.resolve([]);
      return Promise.resolve([{ account_id: ALICE.accountId, expires_at: expiresAt, email: ALICE.email }]);
  };
  const wrapped = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase();
    if (text.startsWith('select s.account_id')) {
      state.lookups += 1;
      return observe(lookup(values));
    }
    return sql(strings, ...values);
  };
  for (const k of ['usage', 'postsSeen', 'queries', 'postsFor', 'spendOn']) wrapped[k] = sql[k];
  wrapped.session = state;
  return wrapped;
}

// Every non-X upstream request goes through the global fetch; record it and answer instantly with an
// empty 200 (every parser tolerates `{}` and '' — checked, not assumed, before this file was written).
function stubFetch() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

// A handler that never answers must fail its test, not hang the suite.
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The four shapes of /api/feed. X comes twice because a first fetch and an incremental one take
// different code paths inside fetchTweets. `x` marks the branches that spend money.
const FEED_BRANCHES = [
  { name: 'YouTube', query: { channelId: `UC${'a'.repeat(22)}`, hideShorts: '0' }, x: false },
  { name: 'X first fetch', query: { source: 'twitter', sourceId: '1234567890' }, x: true },
  { name: 'X incremental', query: { source: 'twitter', sourceId: '1234567890', sinceId: '20' }, x: true },
  { name: 'Substack', query: { source: 'substack', sourceId: 'example.substack.com' }, x: false },
];

// The five inputs /api/resolve-channel accepts, each reaching a different upstream first.
const RESOLVE_INPUTS = [
  { name: 'YouTube URL', query: { url: 'https://www.youtube.com/@somechannel' }, x: false },
  { name: 'YouTube @handle', query: { url: '@somechannel' }, x: false },
  { name: 'YouTube name search', query: { url: 'some channel' }, x: false },
  { name: 'X handle', query: { source: 'twitter', handle: 'someone' }, x: true },
  { name: 'Substack', query: { source: 'substack', url: 'example.substack.com' }, x: false },
];

async function callFeed(query, {
  cookie, headers = {}, sql = withSessions(fakeDb({})), noStore = false, env = {}, sessionTimeoutMs, waitMs = 2000,
} = {}) {
  const xf = fakeXFetch([xPage({ ids: ['21'], at: RECENT })]);
  const net = stubFetch();
  try {
    const handler = createFeedHandler({
      xFetch: xf, db: noStore ? () => null : () => sql, sessionAccount, env, sessionTimeoutMs,
    });
    const res = fakeRes();
    await within(handler(fakeReq({ query, headers: { ...headers, ...(cookie ? { cookie } : {}) } }), res), waitMs);
    return { res, upstream: xf.calls.length + net.calls.length, sql };
  } finally {
    net.restore();
  }
}

async function callResolve(query, {
  cookie, sql = withSessions(fakeDb({})), noStore = false, sessionTimeoutMs, waitMs = 2000,
} = {}) {
  const net = stubFetch();
  try {
    const handler = createResolveHandler({ db: noStore ? () => null : () => sql, sessionAccount, sessionTimeoutMs });
    const res = fakeRes();
    await within(handler(fakeReq({ query, headers: cookie ? { cookie } : {} }), res), waitMs);
    return { res, upstream: net.calls.length, sql };
  } finally {
    net.restore();
  }
}

// A refusal: the status, nothing sent upstream, and `no-store` on the headers the body LEFT WITH — a header
// set after `json()` would not be on a real response (the harness now throws on one, as Node does).
function assertRefused({ res, upstream }, status = 401) {
  assert.equal(res.statusCode, status);
  assert.equal(upstream, 0, 'refused, but the request still went out — the money is already spent');
  assert.equal(res.sentHeaders?.['Cache-Control'], 'no-store',
    'a refusal must never be cacheable — a cached one would reach a signed-in user');
  assert.equal(typeof res.body?.error, 'string');
  assert.ok(res.body.error.length > 0, 'the client renders data.error, so it must say something');
}

function assertServed({ res, upstream }) {
  assert.notEqual(res.statusCode, 401);
  assert.notEqual(res.statusCode, 503);
  assert.ok(upstream >= 1, 'served requests reach upstream — the control that makes the 0 above mean something');
}

// Every store-failure test first proves the failure HAPPENED: the lookup was made and failed. Without this,
// a fixture that stopped staging the failure would turn those tests into silent copies of G4.
// The rejection is read off the promise the gate received, not off the fixture's own
// intent.
function assertLookupFailed(sql) {
  assert.equal(sql.session.lookups, 1, 'the gate asked the store exactly once');
  assert.equal(sql.session.failures, 1, 'and that one lookup failed');
  assert.equal(sql.session.rejected, 1, 'and the lookup the gate received really did reject');
  assert.equal(sql.session.resolved, 0, 'and never answered');
}

// Every hang test proves the lookup was STILL WAITING when the handler answered — so the answer came from the
// time limit, not from a lookup that failed or answered quickly. Without it, a hang fixture that failed fast
// would turn G11a and G11b into silent copies of G6a and G6x, and no handler-level test would exercise the limit at all.
function assertLookupHung(sql) {
  assert.equal(sql.session.lookups, 1, 'the gate asked the store exactly once');
  assert.equal(sql.session.rejected, 0, 'the lookup had not failed when the handler answered');
  assert.equal(sql.session.resolved, 0, 'nor answered — the time limit is what decided');
}

// ── /api/feed ────────────────────────────────────────────────────────────────────────────────────────

for (const b of FEED_BRANCHES) {
  test(`G1 feed ${b.name}: no cookie → 401, no-store, nothing sent upstream`, async () => {
    assertRefused(await callFeed(b.query));
  });

  test(`G2a feed ${b.name}: a cookie naming no session → 401, nothing sent upstream`, async () => {
    assertRefused(await callFeed(b.query, { cookie: UNKNOWN_COOKIE }));
  });

  test(`G2b feed ${b.name}: an expired session → 401, nothing sent upstream`, async () => {
    assertRefused(await callFeed(b.query, { cookie: COOKIE, sql: withSessions(fakeDb({}), { expiresAt: PAST }) }));
  });

  // Twin: passes on the unfixed code too, by design. It is the control for the refusals' "0 upstream" —
  // the same request, allowed through, does reach the instrument. It also pins ONE lookup per request
  // (an X owner re-read through a second lookup would double the queries and
  // leave a confirmed account unmetered whenever only the second one failed).
  test(`G4 feed ${b.name}: signed in → served, and the request reaches upstream`, async () => {
    const out = await callFeed(b.query, { cookie: COOKIE });
    assertServed(out);
    assert.equal(out.sql.session.lookups, 1, 'one session lookup per request');
  });

  if (b.x) {
    // Decision B. X spends money and the account is unknown, so the X path is refused rather than served
    // unmetered. Was "served" — changed with the decision, not to make anything pass.
    test(`G6x feed ${b.name}: the store cannot be asked → 503, no-store, nothing sent to X`, async () => {
      const sql = withSessions(fakeDb({}), { store: 'fail' });
      const out = await callFeed(b.query, { cookie: COOKIE, sql });
      assertLookupFailed(sql);
      assertRefused(out, 503);
    });

    test(`G11b feed ${b.name}: a lookup that never answers → 503 within the time limit, nothing sent to X`, async () => {
      const sql = withSessions(fakeDb({}), { store: 'hang' });
      const out = await callFeed(b.query, { cookie: COOKIE, sql, sessionTimeoutMs: 30 });
      assertLookupHung(sql);
      assertRefused(out, 503);
    });
  } else {
    // Twin on the unfixed code, which served everyone; it stops being trivial once the gate exists —
    // dropping `strict` turns a store failure into a 401 and this is what reds.
    test(`G6a feed ${b.name}: the store cannot be asked → served, and the request reaches upstream`, async () => {
      const sql = withSessions(fakeDb({}), { store: 'fail' });
      const out = await callFeed(b.query, { cookie: COOKIE, sql });
      assertLookupFailed(sql);
      assertServed(out);
    });

    test(`G11a feed ${b.name}: a lookup that never answers → served within the time limit, and it reaches upstream`, async () => {
      const sql = withSessions(fakeDb({}), { store: 'hang' });
      const out = await callFeed(b.query, { cookie: COOKIE, sql, sessionTimeoutMs: 30 });
      assertLookupHung(sql);
      assertServed(out);
    });
  }

  test(`G7 feed ${b.name}: no store configured → 401 even with a cookie, nothing sent upstream`, async () => {
    assertRefused(await callFeed(b.query, { cookie: COOKIE, noStore: true }));
  });
}

test('G6b feed X: a store failure refuses X even over the limit and with an X-Device-Id — no 429, no X call, no meter write', async () => {
  // The account is over a limit of 1 and the request carries a device id. Guessing an owner — the account
  // (a 429 or an increment) or the client-supplied device (a new row, a quota reset by rotating the header)
  // — would show here. Under decision B nothing is guessed: X is not reached at all.
  const store = fakeDb({ xUsage: [{ owner_kind: 'account', owner_id: ALICE.accountId, day: DAY, posts: 5 }] });
  const sql = withSessions(store, { store: 'fail' });
  const out = await callFeed(FEED_BRANCHES[1].query, {
    cookie: COOKIE, sql, headers: { 'x-device-id': DEVICE_ID }, env: { X_DAILY_POST_QUOTA: '1' },
  });
  assertLookupFailed(sql);
  assertRefused(out, 503);
  assert.equal(sql.usage.length, 1, 'no new meter row, for any owner');
  assert.equal(sql.postsFor('account', ALICE.accountId, DAY), 5, 'and the existing one untouched');
  assert.equal(sql.postsFor('device', DEVICE_ID, DAY), 0);
});

test('G6c feed: a store failure does not serve a request with NO cookie — the store is never asked', async () => {
  // "Serve the free sources when the store cannot be asked" must not become "serve strangers during an
  // outage": with no cookie there is no lookup to fail, so the refusal happens before the store is touched.
  const sql = withSessions(fakeDb({}), { store: 'fail' });
  assertRefused(await callFeed(FEED_BRANCHES[0].query, { sql }));
  assert.equal(sql.session.lookups, 0);
});

test('G6d harness: the staged store failure is the real driver\'s error — NeonDbError, no code', async () => {
  // Pins the fixture every store-failure test relies on. Staging `code: 'ECONNRESET'`, which
  // the driver never sets, would let a gate that served only errors carrying a code pass.
  const e = await DB_DOWN().then(() => null, (err) => err);
  assert.ok(e, 'the unreachable store must reject');
  assert.equal(e.name, 'NeonDbError');
  assert.equal(e.code ?? null, null);
});

test('G11c feed: with a hanging store, a request with NO cookie is refused without waiting', async () => {
  // A limit of 1.5 s and an answer required inside 0.5 s: the no-cookie path never asks the store, so it cannot
  // be the thing that waits. The limit is deliberately short. It was a minute at first, and a mutation that made
  // this request wait left a minute-long timer pending, which kept the test process alive past the mutation
  // runner's own limit — so the run ended TIMEOUT and proved nothing, instead of failing here.
  const sql = withSessions(fakeDb({}), { store: 'hang' });
  const out = await callFeed(FEED_BRANCHES[0].query, { sql, sessionTimeoutMs: 1500, waitMs: 500 });
  assert.equal(sql.session.lookups, 0);
  assertRefused(out);
});

test('G11d signedInGate gives up after exactly 3 s by default', async (t) => {
  // The production time limit, pinned on mock timers so the suite does not wait three real seconds.
  assert.equal(session.SESSION_CHECK_TIMEOUT_MS, 3000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise((r) => setImmediate(r));
  let answer = 'pending';
  session.signedInGate({}, COOKIE, () => new Promise(() => {})).then((v) => { answer = v; });
  await flush();
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(answer, 'pending', 'still waiting one millisecond before the limit');
  t.mock.timers.tick(1);
  await flush();
  assert.ok(answer && typeof answer === 'object', 'answered at the limit');
  assert.equal(answer.account, null, 'as "could not be asked", not as a refusal');
});

// The time limit through the handlers' OWN wiring. G11d pins `signedInGate`'s default, but both
// factories forward `sessionTimeoutMs`, and every other test either injects a limit or answers at once — so a
// factory whose own default drifted to 30 s would pass every other test while production waited 30 s on
// a hanging store. These build each handler with NO limit, as the default exports do. The X paths are used because
// their answer at the limit is a 503 that sends nothing upstream, so the mock clock is the only thing that runs.
for (const [name, build, query] of [
  ['feed X first fetch', (sql, xf) => createFeedHandler({ xFetch: xf, db: () => sql, sessionAccount }), FEED_BRANCHES[1].query],
  ['resolve X handle', (sql) => createResolveHandler({ db: () => sql, sessionAccount }), RESOLVE_INPUTS[3].query],
]) {
  test(`G11e ${name}: with no limit injected, the handler answers at exactly 3 s — 503, nothing sent to X`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const flush = () => new Promise((r) => setImmediate(r));
    const sql = withSessions(fakeDb({}), { store: 'hang' });
    const xf = fakeXFetch([xPage({ ids: ['21'], at: RECENT })]);
    const net = stubFetch();
    try {
      const res = fakeRes();
      let settled = 'pending';
      build(sql, xf)(fakeReq({ query, headers: { cookie: COOKIE } }), res)
        .then(() => { settled = 'answered'; }, (e) => { settled = e; });
      await flush();
      t.mock.timers.tick(2999);
      await flush();
      assert.equal(settled, 'pending', 'still waiting one millisecond before the limit');
      t.mock.timers.tick(1);
      await flush();
      assert.equal(settled, 'answered', 'answered at the limit');
      assertLookupHung(sql);
      assertRefused({ res, upstream: xf.calls.length + net.calls.length }, 503);
    } finally {
      net.restore();
    }
  });
}

// The gate runs BEFORE validation, so a malformed anonymous request is refused
// as signed-out rather than told what is wrong with it. Twins on the unfixed code; each reds if validation moves
// above the gate.
for (const [name, query] of [
  ['feed X, non-numeric sourceId', { source: 'twitter', sourceId: 'abc' }],
  ['feed YouTube, malformed channelId', { channelId: 'not-a-channel' }],
  ['feed Substack, unsafe host', { source: 'substack', sourceId: '127.0.0.1' }],
]) {
  test(`G13 ${name}: a malformed anonymous request is 401, not 400`, async () => {
    assertRefused(await callFeed(query));
  });
}

// ── /api/resolve-channel ─────────────────────────────────────────────────────────────────────────────

for (const r of RESOLVE_INPUTS) {
  test(`G3a resolve ${r.name}: no cookie → 401, no-store, nothing sent upstream`, async () => {
    assertRefused(await callResolve(r.query));
  });

  test(`G3b resolve ${r.name}: a cookie naming no session → 401, nothing sent upstream`, async () => {
    assertRefused(await callResolve(r.query, { cookie: UNKNOWN_COOKIE }));
  });

  test(`G3c resolve ${r.name}: an expired session → 401, nothing sent upstream`, async () => {
    assertRefused(await callResolve(r.query, { cookie: COOKIE, sql: withSessions(fakeDb({}), { expiresAt: PAST }) }));
  });

  test(`G4 resolve ${r.name}: signed in → served, and the request reaches upstream`, async () => {
    const out = await callResolve(r.query, { cookie: COOKIE });
    assertServed(out);
    assert.equal(out.sql.session.lookups, 1, 'one session lookup per request');
  });

  if (r.x) {
    test(`G6x resolve ${r.name}: the store cannot be asked → 503, no-store, nothing sent to X`, async () => {
      const sql = withSessions(fakeDb({}), { store: 'fail' });
      const out = await callResolve(r.query, { cookie: COOKIE, sql });
      assertLookupFailed(sql);
      assertRefused(out, 503);
    });

    test(`G11b resolve ${r.name}: a lookup that never answers → 503 within the time limit, nothing sent to X`, async () => {
      const sql = withSessions(fakeDb({}), { store: 'hang' });
      const out = await callResolve(r.query, { cookie: COOKIE, sql, sessionTimeoutMs: 30 });
      assertLookupHung(sql);
      assertRefused(out, 503);
    });
  } else {
    test(`G6a resolve ${r.name}: the store cannot be asked → served, and the request reaches upstream`, async () => {
      const sql = withSessions(fakeDb({}), { store: 'fail' });
      const out = await callResolve(r.query, { cookie: COOKIE, sql });
      assertLookupFailed(sql);
      assertServed(out);
    });

    test(`G11a resolve ${r.name}: a lookup that never answers → served within the time limit, and it reaches upstream`, async () => {
      const sql = withSessions(fakeDb({}), { store: 'hang' });
      const out = await callResolve(r.query, { cookie: COOKIE, sql, sessionTimeoutMs: 30 });
      assertLookupHung(sql);
      assertServed(out);
    });
  }

  test(`G7 resolve ${r.name}: no store configured → 401 even with a cookie, nothing sent upstream`, async () => {
    assertRefused(await callResolve(r.query, { cookie: COOKIE, noStore: true }));
  });
}

for (const [name, query] of [
  ['resolve X, no handle', { source: 'twitter' }],
  ['resolve YouTube, no url', {}],
  // The sixth branch: without it, moving this 400 above the gate goes unnoticed.
  ['resolve Substack, no url', { source: 'substack' }],
]) {
  test(`G13 ${name}: a malformed anonymous request is 401, not 400`, async () => {
    assertRefused(await callResolve(query));
  });
}

// ── The instrument ───────────────────────────────────────────────────────────────────────────────────

// A real Node response refuses a header once the body has gone (`ERR_HTTP_HEADERS_SENT`); a fake that
// accepts one in any order makes a `no-store` set AFTER `json()` look identical to one set before it — and on
// Vercel that 401 would leave without the header. This
// proves the fake behaves like Node before any refusal test leans on it.
test('H1 harness: fakeRes refuses a header set after the body, as Node does, and snapshots headers at send', () => {
  const res = fakeRes();
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).json({ error: 'x' });
  assert.equal(res.sentHeaders?.['Cache-Control'], 'no-store', 'the headers the body actually left with');
  assert.throws(() => res.setHeader('Cache-Control', 's-maxage=300'), (e) => e.code === 'ERR_HTTP_HEADERS_SENT');
  assert.equal(res.sentHeaders['Cache-Control'], 'no-store', 'a late header never reaches what was sent');
});

// ── /api/group ───────────────────────────────────────────────────────────────────────────
//
// Every POST here bills a Claude call on the server's key, and ungated the endpoint would answer anyone.
// The same quantity is under test as above: the OUTBOUND request, counted on a stub over `globalThis.fetch`,
// which `groupItems` resolves at call time.
//
// THE FAKE KEY IS LOAD-BEARING. `groupItems` returns null BEFORE fetching when no key is passed, so without
// ANTHROPIC_API_KEY the unfixed handler would send nothing either and every "nothing sent to Anthropic" below
// would hold on the code it is meant to fail. GG4 is the control: the same request, allowed through, reaches
// the stub exactly once.
//
// There is no free branch on this endpoint, so decision B has one side only here: when the session cannot be
// checked the request is refused with a 503.
const GROUP_POSTS = [
  { id: 'n1', source: 'twitter', text: 'Senate advances the spending bill' },
  { id: 'n2', source: 'twitter', text: 'The budget vote is scheduled for Thursday' },
];
// Posts reach the model as positional indices, so the fake reply answers in indices. Two posts in
// one group, so nothing is folded and the label survives.
const GROUP_REPLY = {
  content: [{
    type: 'tool_use',
    name: 'emit_groups',
    input: { groups: [{ label: 'US Politics', summary: ['a bill advanced'], item_ids: ['0', '1'] }] },
  }],
};
const GROUP_BODY = { items: GROUP_POSTS, groups: [] };

async function callGroup(body, {
  method = 'POST', cookie, sql = withSessions(fakeDb({})), noStore = false, sessionTimeoutMs, waitMs = 2000,
  reply = GROUP_REPLY,
} = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => reply };
  };
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  try {
    const handler = createGroupHandler({ db: noStore ? () => null : () => sql, sessionAccount, sessionTimeoutMs });
    const res = fakeRes();
    await within(handler(fakeReq({ method, body, headers: cookie ? { cookie } : {} }), res), waitMs);
    return { res, upstream: calls.length, calls, sql };
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
}

test('GG1 group: no cookie → 401, no-store, nothing sent to Anthropic', async () => {
  assertRefused(await callGroup(GROUP_BODY));
});

test('GG2a group: a cookie naming no session → 401, nothing sent to Anthropic', async () => {
  assertRefused(await callGroup(GROUP_BODY, { cookie: UNKNOWN_COOKIE }));
});

test('GG2b group: an expired session → 401, nothing sent to Anthropic', async () => {
  assertRefused(await callGroup(GROUP_BODY, { cookie: COOKIE, sql: withSessions(fakeDb({}), { expiresAt: PAST }) }));
});

test('GG4 group: signed in → one Anthropic request, one session lookup, and the grouping comes back', async () => {
  const out = await callGroup(GROUP_BODY, { cookie: COOKIE });
  assert.equal(out.res.statusCode, 200);
  assert.equal(out.calls.length, 1, 'exactly one billed call');
  assert.equal(out.calls[0], 'https://api.anthropic.com/v1/messages');
  assert.equal(out.sql.session.lookups, 1, 'one session lookup per request');
  assert.equal(out.res.body.groups.length, 1);
  assert.equal(out.res.body.groups[0].label, 'US Politics');
  assert.equal(out.res.body.groups[0].item_ids.slice().sort().join(','), 'n1,n2');
});

test('GG6 group: the store cannot be asked → 503, no-store, nothing sent to Anthropic', async () => {
  const sql = withSessions(fakeDb({}), { store: 'fail' });
  const out = await callGroup(GROUP_BODY, { cookie: COOKIE, sql });
  assertLookupFailed(sql);
  assertRefused(out, 503);
});

test('GG6c group: a store failure does not serve a request with NO cookie — the store is never asked', async () => {
  const sql = withSessions(fakeDb({}), { store: 'fail' });
  assertRefused(await callGroup(GROUP_BODY, { sql }));
  assert.equal(sql.session.lookups, 0);
});

test('GG7 group: no store configured → 401 even with a cookie, nothing sent to Anthropic', async () => {
  assertRefused(await callGroup(GROUP_BODY, { cookie: COOKIE, noStore: true }));
});

test('GG9 group: a non-POST with no session → 401, not 405 — the gate comes first', async () => {
  assertRefused(await callGroup(null, { method: 'GET' }));
});

test('GG11 group: a lookup that never answers → 503 within the time limit, nothing sent to Anthropic', async () => {
  const sql = withSessions(fakeDb({}), { store: 'hang' });
  const out = await callGroup(GROUP_BODY, { cookie: COOKIE, sql, sessionTimeoutMs: 30 });
  assertLookupHung(sql);
  assertRefused(out, 503);
});

// Twins: these three pass on the unfixed code too, by design. They pin what a signed-in caller must KEEP,
// so a gate that swallowed the method check, the boundary check or the degrade shape reds here.
test('GG10a group: signed in, a non-POST → 405 with Allow: POST, nothing sent to Anthropic', async () => {
  const out = await callGroup(null, { method: 'GET', cookie: COOKIE });
  assert.equal(out.res.statusCode, 405);
  assert.equal(out.res.sentHeaders?.Allow, 'POST');
  assert.equal(out.upstream, 0);
});

test('GG10b group: signed in, a non-array `items` → 400, nothing sent to Anthropic', async () => {
  const out = await callGroup({ items: 'nope' }, { cookie: COOKIE });
  assert.equal(out.res.statusCode, 400);
  assert.equal(out.res.body.error, 'items must be an array');
  assert.equal(out.upstream, 0);
});

test('GG10c group: signed in, an unusable model reply → 200 with the degrade shape', async () => {
  const out = await callGroup(GROUP_BODY, { cookie: COOKIE, reply: {} });
  assert.equal(out.res.statusCode, 200);
  assert.equal(out.res.body.groups, null);
  assert.equal(out.res.body.reason, 'unavailable');
  assert.equal(out.upstream, 1);
});

// GG11 injects a 30 ms limit, so it does not pin the
// limit production actually runs with. Twin of G11e: no limit injected, mock timers, answered at exactly 3 s.
test('GG11e group: with no limit injected, the handler answers at exactly 3 s — 503, nothing sent to Anthropic', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise((r) => setImmediate(r));
  const sql = withSessions(fakeDb({}), { store: 'hang' });
  const calls = [];
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => GROUP_REPLY }; };
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  try {
    const res = fakeRes();
    let settled = 'pending';
    createGroupHandler({ db: () => sql, sessionAccount })(fakeReq({ method: 'POST', body: GROUP_BODY, headers: { cookie: COOKIE } }), res)
      .then(() => { settled = 'answered'; }, (e) => { settled = e; });
    await flush();
    t.mock.timers.tick(2999);
    await flush();
    assert.equal(settled, 'pending', 'still waiting one millisecond before the limit');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(settled, 'answered', 'answered at the limit');
    assertLookupHung(sql);
    assertRefused({ res, upstream: calls.length }, 503);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
});

// GG9 pins "the gate comes first" for a non-POST only. Twins of
// G13: a signed-out POST is refused as signed-out whatever its body is — never told what is wrong with it, and
// never let through because the body arrived as a string.
for (const [name, body] of [
  ['a non-array items', { items: 'nope' }],
  ['no body at all', null],
  ['a string that is not JSON', 'not json'],
  ['a valid body sent as a JSON string', JSON.stringify(GROUP_BODY)],
]) {
  test(`GG13 group, ${name}: a signed-out POST is 401, not 400, and nothing is sent to Anthropic`, async () => {
    assertRefused(await callGroup(body));
  });
}
