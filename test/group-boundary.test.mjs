// The BOUNDARY of POST /api/group — what the endpoint accepts before an Anthropic call is billed
// ([BUG-069]).
//
// These drive the REAL handler through fakeReq/fakeRes with only Anthropic faked, for the reason
// test/group-seam.test.mjs exists: `const body = ...; const groups = body?.groups` in api/group.js is
// the only thing joining the browser to the server, and a unit test on either side of that line can
// pass while the seam itself is broken. Validation added AT that line is invisible to every test in
// test/group.test.mjs, which imports _group.js directly and never crosses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeReq, fakeRes } from '../test-helpers/handler.mjs';
import { createGroupHandler } from '../api/group.js';

// [BUG-130] made the endpoint signed-in only, so this file presents a confirmed session: these tests are
// about what a signed-in caller's request does, and the gate itself is covered in signed-in-gate.test.mjs.
// Only how the handler is built changed (the import above and this block); no assertion did (Asli,
// 2026-10-07: "yes to all three, go ahead"). The DEFAULT export, which these files used to run, is now
// covered by test/group-default-export.test.mjs (review round 1, H1).
const handler = createGroupHandler({
  db: () => ({}),
  sessionAccount: async () => ({ accountId: 'acct-test', email: 'test@example.com' }),
});

const POSTS = [
  { id: 'n1', source: 'twitter', text: 'Senate advances the spending bill' },
  { id: 'n2', source: 'twitter', text: 'The budget vote is scheduled for Thursday' },
];

// Lever A ([BUG-077]): posts reach the model as positional indices, so a fake reply must answer in
// the same language. Two posts in one group, so collapseSingletons has no singleton to fold and the
// label survives — this file is about the boundary, not about the fold.
const REPLY = {
  content: [{
    type: 'tool_use',
    name: 'emit_groups',
    input: { groups: [{ label: 'US Politics', summary: ['a bill advanced'], item_ids: ['0', '1'] }] },
  }],
};

const allIds = groups => groups.flatMap(g => g.item_ids);

// Run the real handler with Anthropic faked. Restores both globals whatever happens — a leaked
// ANTHROPIC_API_KEY would make every later test in the process talk to the network.
async function callHandler(body) {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => REPLY });
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    const res = fakeRes();
    await handler(fakeReq({ method: 'POST', body }), res);
    return res;
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
}

test('BUG-069: a string `groups` no longer takes the whole classify down', async () => {
  // A STRING has a truthy `.length`, so planExistingTopics reaches `groups.map` and throws — AFTER
  // the request is built. groupItems' catch turns that into a degrade, and the user's posts silently
  // stay ungrouped. group.test.mjs pins that as pre-existing and says the boundary validation that
  // fixes it belongs to THIS task; normalising here means the string never reaches that function.
  const res = await callHandler({ items: POSTS, groups: 'abc' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.groups,
    `the classify degraded instead of succeeding: ${JSON.stringify(res.body)}`);
  assert.deepEqual(allIds(res.body.groups).sort(), ['n1', 'n2']);
});

test('BUG-069: the non-array `groups` values that already worked keep working', async () => {
  // {} / 42 / true have a FALSY .length, so buildGroupRequest ignores them and the call succeeds
  // today. A `|| []` guard once turned them into a throw after the call was billed (BUG-066 review
  // round 1, M3), so this pins the direction the fix must NOT regress. Normalising to [] preserves
  // it exactly: no labels either way.
  for (const bad of [{}, 42, true]) {
    const res = await callHandler({ items: POSTS, groups: bad });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.groups, `groups: ${JSON.stringify(bad)} degraded`);
    assert.deepEqual(allIds(res.body.groups).sort(), ['n1', 'n2']);
  }
});

test('BUG-069: a non-array `items` is rejected at the boundary, before anything is billed', async () => {
  // The handler's oldest guard, and nothing has ever asserted it. Pinned here because the validation
  // this task adds sits on the line directly below it — the easiest thing in the world to break
  // while rewriting its neighbour.
  for (const bad of [undefined, null, 'abc', 42, {}]) {
    const res = await callHandler({ items: bad, groups: [] });
    assert.equal(res.statusCode, 400, `items: ${JSON.stringify(bad)} must be rejected`);
    assert.equal(res.body.error, 'items must be an array');
  }
});

// ── The measurement that matters: what actually goes ON THE WIRE ────────────────────────────────
// capItems being correct in isolation is not the claim. The claim is that nothing between the
// request body and the Anthropic call can bypass it — so these read `init.body`, the exact string
// handed to fetch, and never a payload the test reconstructs.
//
// That distinction cost a wrong diagnosis on this very task. A probe that rebuilt the payload itself
// reported 688,291 bytes for a batch of oversized `id`s and the number was fiction: lever A
// ([BUG-077]) rewrites every id to its position BEFORE the prompt is built, so the real wire figure
// is 15,862 bytes and the ids appear nowhere in it. Measure the bag you actually carry home.
const HOSTILE = [
  {
    name: 'a non-string text switches the budget off',
    wireToday: 2507862,
    items: () => [
      { id: 'poison', source: 'twitter', text: 5 },
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `n${i}`, source: 'twitter', text: 'x'.repeat(50000),
      })),
    ],
  },
  {
    // No longer expected to CAP. `source` is truncated to MAX_SOURCE_CHARS at the same boundary, so
    // 200 oversized sources are bounded before any budget sees them — a better outcome than capping,
    // because every post still reaches the model. The wire bound is the claim; `capped` is not.
    name: 'an oversized source is truncated, so it never reaches the wire',
    wireToday: 694462,
    expectCapped: false,
    items: () => Array.from({ length: 200 }, (_, i) => ({
      id: `n${i}`, source: 's'.repeat(3400), text: '',
    })),
  },
  {
    // The case no field cap can reach: JSON escaping. maxChars counts RAW characters, so 60,000
    // control characters measure 60,000 to the text budget and 360,039 on the wire.
    name: 'escape-inflated text is bounded on the wire, which maxChars cannot see',
    wireToday: 360039,
    expectCapped: true,
    items: () => [{ id: 'a', source: 'twitter', text: String.fromCharCode(1).repeat(60000) }],
  },
];

for (const shape of HOSTILE) {
  test(`BUG-069: ${shape.name} — bounded on the wire`, async () => {
    let sentBody = null;
    const realFetch = globalThis.fetch;
    const realKey = process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = async (_url, init) => {
      sentBody = init.body;
      return { ok: true, status: 200, json: async () => REPLY };
    };
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const res = fakeRes();
      await handler(fakeReq({ method: 'POST', body: { items: shape.items(), groups: [] } }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(sentBody, 'the handler reached the Anthropic call');
      assert.ok(sentBody.length <= 200000,
        `the billed request body was ${sentBody.length} bytes (today: ${shape.wireToday})`);
      assert.equal(res.body.capped, shape.expectCapped ?? true,
        'the client is told the truth about whether anything was dropped');
      // 33, not 10: the truncated source is legitimately 32 's' characters, so a shorter needle
      // matches the CORRECT output and the assertion would pass for the wrong reason.
      assert.ok(!sentBody.includes('s'.repeat(33)),
        'and no source longer than MAX_SOURCE_CHARS survived into the prompt');
    } finally {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = realKey;
    }
  });
}
