// The DEFAULT EXPORT of api/group.js — the handler Vercel actually runs ([BUG-130], review round 1, H1).
//
// Every other group test builds its own handler through `createGroupHandler` and injects a session, so
// until this file nothing ran the production wiring: `export default createGroupHandler()` and the
// factory's two defaults, the real `db` and the real `sessionAccount`. The independent battery showed
// three ways to break that wiring with the suite green — a default export that confirms everyone (I2), a
// default session lookup that confirms everyone (I3), both of which are the original hole, and a default
// store of none (I4), which refuses every real user.
//
// Nothing is injected here. The store is chosen the way production chooses it, through the environment,
// and the network under the real Neon driver is replaced so no request leaves the process:
//   GD1  no database configured  → `db()` is null            → 401
//   GD2  a database that fails   → the real lookup rejects   → 503   (proves the REAL store was asked)
//   GD3  a database that answers → the real lookup confirms  → served (proves a real user gets through)
//
// This is its own file on purpose: `node --test` runs each file in its own process, and `api/_db.js`
// memoises its client, so the environment set here cannot leak into another file's handler.
//
// THE FAKE KEY IS LOAD-BEARING, as in signed-in-gate.test.mjs: without it `groupItems` returns before
// fetching and "nothing sent to Anthropic" would hold for a handler that served everyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neonConfig } from '@neondatabase/serverless';
import { fakeReq, fakeRes } from '../test-helpers/handler.mjs';
import handler from '../api/group.js';

const COOKIE = 'focus_session=tok-default-export';
const POSTS = [
  { id: 'n1', source: 'twitter', text: 'Senate advances the spending bill' },
  { id: 'n2', source: 'twitter', text: 'The budget vote is scheduled for Thursday' },
];
const REPLY = {
  content: [{
    type: 'tool_use',
    name: 'emit_groups',
    input: { groups: [{ label: 'US Politics', summary: ['a bill advanced'], item_ids: ['0', '1'] }] },
  }],
};

// The 'alice' answer is the driver's own wire format, measured against @neondatabase/serverless 1.1.0: it
// sends `Neon-Array-Mode` and reads `rows` as ARRAYS in `fields` order (an object row throws inside the
// driver, which the gate reads as "could not check" — a 503, so a format drift fails GD3 loudly).
//
// What the Neon HTTP driver does with the network, per test: 'fail' rejects the way undici does on a
// reset; 'alice' answers the session query with one live row. `neonCalls` counts the driver's requests,
// which is how GD2 and GD3 show the real store was asked and GD1 shows it was not.
let neonMode = 'fail';
let neonCalls = 0;
neonConfig.fetchFunction = async () => {
  neonCalls += 1;
  if (neonMode === 'fail') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const body = JSON.stringify({
    command: 'SELECT',
    rowCount: 1,
    rowAsArray: true,
    fields: [
      { name: 'account_id', dataTypeID: 25 },
      { name: 'expires_at', dataTypeID: 25 },
      { name: 'email', dataTypeID: 25 },
    ],
    rows: [['acct-alice', new Date(Date.now() + 86400_000).toISOString(), 'alice@example.com']],
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const ENV_KEYS = ['DATABASE_URL', 'DEV_DATABASE_URL', 'VERCEL_ENV', 'ANTHROPIC_API_KEY'];

async function call({ cookie, databaseUrl } = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const anthropic = [];
  for (const k of ENV_KEYS) delete process.env[k];
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  globalThis.fetch = async (url) => {
    anthropic.push(String(url));
    return { ok: true, status: 200, json: async () => REPLY };
  };
  neonCalls = 0;
  try {
    const res = fakeRes();
    await handler(fakeReq({ method: 'POST', body: { items: POSTS, groups: [] }, headers: cookie ? { cookie } : {} }), res);
    return { res, anthropic, neonCalls };
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const UNREACHABLE = 'postgresql://u:p@ep-test-000000.us-east-2.aws.neon.tech/db';

// ORDER MATTERS: `api/_db.js` memoises its client on the first call that finds a URL, so the
// no-database case must run before any test that configures one.
test('GD1 default export: no database configured → 401 even with a cookie, nothing sent to Anthropic', async () => {
  const out = await call({ cookie: COOKIE });
  assert.equal(out.res.statusCode, 401);
  assert.equal(out.res.sentHeaders?.['Cache-Control'], 'no-store');
  assert.equal(out.anthropic.length, 0, 'refused, but the billed call still went out');
  assert.equal(out.neonCalls, 0, 'with no store configured there is nothing to ask');
});

test('GD2 default export: the real store is asked, and when it fails the answer is 503, nothing sent to Anthropic', async () => {
  neonMode = 'fail';
  const out = await call({ cookie: COOKIE, databaseUrl: UNREACHABLE });
  assert.equal(out.neonCalls, 1, 'the production handler asked the REAL store exactly once');
  assert.equal(out.res.statusCode, 503);
  assert.equal(out.res.sentHeaders?.['Cache-Control'], 'no-store');
  assert.equal(out.anthropic.length, 0, 'refused, but the billed call still went out');
});

test('GD2b default export: with a store configured, no cookie → 401 and the store is never asked', async () => {
  neonMode = 'fail';
  const out = await call({ databaseUrl: UNREACHABLE });
  assert.equal(out.res.statusCode, 401);
  assert.equal(out.neonCalls, 0);
  assert.equal(out.anthropic.length, 0);
});

test('GD3 default export: a session the real store confirms is served — one lookup, one Anthropic call, the grouping', async () => {
  neonMode = 'alice';
  const out = await call({ cookie: COOKIE, databaseUrl: UNREACHABLE });
  assert.equal(out.neonCalls, 1, 'one session lookup through the real driver');
  assert.equal(out.res.statusCode, 200);
  assert.equal(out.anthropic.length, 1, 'exactly one billed call');
  assert.equal(out.anthropic[0], 'https://api.anthropic.com/v1/messages');
  assert.equal(out.res.body.groups.length, 1);
  assert.equal(out.res.body.groups[0].label, 'US Politics');
  assert.equal(out.res.body.groups[0].item_ids.slice().sort().join(','), 'n1,n2');
});
