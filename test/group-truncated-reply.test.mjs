// [BUG-116] — A TRUNCATED TOOL REPLY MUST NOT THROW AWAY A BILLED CLASSIFY.
//
// Roughly 1 billed classify in 24 comes back with `input.groups` as a JSON STRING rather than an
// array, truncated with its final closing bracket missing, while `stop_reason` is `tool_use` — a
// clean stop, nowhere near `max_tokens` (peak output across 16 production-shaped runs: 2,293 of
// 8,192; the run that failed used 1,812). `parseGroupResponse` rejects it, `groupItems` returns null,
// and the whole classify is discarded after we paid for it.
//
// The fixture strings in `test/fixtures/group-truncated-tool-reply.json` are the REAL captured
// replies, committed because they are not reproducible on demand.
//
// WHICH TESTS CAN RED BEFORE THE FIX, declared because a merely-red suite hides the one that passed
// for the wrong reason (CLAUDE.md, Mutation batteries):
//
//   RED before the fix   — C1, C2, C3, C6, C8, C9, C10, C11, C13, C14, C15, C16, C17, C18, C19.
//                           Fifteen of nineteen. MEASURED, not asserted: the three source files were
//                           reverted to the parent commit in a scratch copy and this file re-run.
//   GREEN before the fix — C4, C5, C7, C12, BY DESIGN, and none is decoration:
//     C4  guards against an OVER-EAGER repair. Today it passes because nothing is repaired at all;
//         after the fix it passes because a string with no complete element must still degrade.
//         Same assertion, two different reasons — the second is the one that can break.
//     C5  pins the existing contract for non-string junk. It can only red if the repair over-reaches
//         into shapes that were never text.
//     C7  pins that a well-formed native array never enters the repair path.
//     C12 pins that a degrade still reveals held posts — existing behaviour this change must not
//         regress while touching the branch right next to it.
//
// THE ORACLE IS INDEPENDENT ONLY WHERE THE INPUT IS. Where a test needs to know what SHOULD be
// recovered it computes it as `JSON.parse(captured + ']')` — naive bracket-closing. An earlier
// version of this comment claimed that made the whole file implementation-independent. It does not,
// and the claim was measured false: for a truncation at a CLEAN element boundary the scanner's
// `slice(0, cut+1) + ']'` and the oracle's `raw + ']'` differ by trailing whitespace only, so on C1
// they agree BY CONSTRUCTION — replacing the scanner with the oracle leaves C1 green. C3, C13, C14
// and C15 are where the oracle and the implementation can actually disagree, and they are the tests
// that pin the scanner's behaviour. C1 pins the measurement, not the algorithm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from '../test-helpers/app-harness.mjs';
import { parseGroupResponse, groupItems, EVERYTHING_ELSE } from '../api/_group.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, 'test/fixtures/group-truncated-tool-reply.json'), 'utf8'),
);
const CAP0 = FIXTURE.truncated.find(c => c.id === 'capture-0');
const CAP1 = FIXTURE.truncated.find(c => c.id === 'capture-1');
if (!CAP0 || !CAP1) throw new Error('fixture is missing capture-0 / capture-1');

// The independent oracle: close the array naively and parse. Valid for these two captures precisely
// because the truncation lands at a clean element boundary — which is the measured fact this whole
// task rests on, so a test asserting it is a test worth having (C1 does exactly that).
const oracle = s => JSON.parse(s + ']');

const toolUse = groups => ({ content: [{ type: 'tool_use', name: 'emit_groups', input: { groups } }] });
const fakeResponse = body => ({ ok: true, status: 200, json: async () => body });
const idsOf = groups => groups.flatMap(g => g.item_ids || []);

// ── C1-C9: the server-side parse ────────────────────────────────────────────────

test('BUG-116 C1: the two real captured strings recover completely', () => {
  // The measurement this task exists on. If this ever reds, re-read the fixture before the code:
  // it means the captured shape is not what the amendment in tasks/BUG-116.md recorded.
  const g0 = parseGroupResponse(toolUse(CAP0.groups));
  assert.ok(g0, 'capture-0 must parse, not degrade');
  assert.equal(g0.groups.length, 10, 'capture-0 recovers 10 groups');
  assert.equal(idsOf(g0.groups).length, 54, 'capture-0 recovers 54 item_ids');

  const g1 = parseGroupResponse(toolUse(CAP1.groups));
  assert.ok(g1, 'capture-1 must parse, not degrade');
  assert.equal(g1.groups.length, 15, 'capture-1 recovers 15 groups');
  assert.equal(idsOf(g1.groups).length, 69, 'capture-1 recovers 69 item_ids');

  // …and the recovery matches the independent oracle exactly, group for group.
  assert.deepEqual(g0.groups.map(g => g.label), oracle(CAP0.groups).map(g => g.label));
  assert.deepEqual(g1.groups.map(g => g.label), oracle(CAP1.groups).map(g => g.label));
});

test('BUG-116 C2: a stringified but COMPLETE array parses to the same thing as the native array', () => {
  // The non-truncated half of the same defect: the model serialised the array but finished it.
  const native = [{ label: 'AI news', item_ids: ['0', '1'], summary: ['a bullet'] }];
  const parsed = parseGroupResponse(toolUse(JSON.stringify(native)));
  assert.ok(parsed, 'a complete stringified array must not degrade');
  assert.deepEqual(parsed.groups, native, 'and must equal what the native array would have given');
});

test('BUG-116 C3: a MID-OBJECT truncation yields only the complete prefix, never a partial group', () => {
  // The captures happen to break at a clean boundary. Nothing guarantees the next one will, and the
  // dangerous failure is a half-written group completed by guesswork.
  const cut = Math.floor(CAP0.groups.length * 0.5);   // 4122 — lands inside a group object
  const parsed = parseGroupResponse(toolUse(CAP0.groups.slice(0, cut)));
  assert.ok(parsed, 'a mid-object truncation still recovers what was complete');
  assert.equal(parsed.groups.length, 4, 'four complete groups precede the 50% cut');
  assert.equal(idsOf(parsed.groups).length, 25, 'carrying 25 item_ids between them');

  // Every recovered group is a whole one: the prefix must be identical to the oracle's first four.
  assert.deepEqual(parsed.groups, oracle(CAP0.groups).slice(0, 4),
    'the recovered prefix must be byte-identical to the complete groups, not a repaired approximation');
});

test('BUG-116 C4: a string truncated before the first complete element degrades', () => {
  // GREEN BEFORE THE FIX, declared. Guards against an over-eager repair inventing a group out of a
  // fragment.
  //
  // This test USED to claim it was the predicted killer of "close the array wherever you are"
  // (i.e. `JSON.parse(raw + ']')`) rather than "at the last complete element". That was measured and
  // is FALSE: under that mutation C4 stays green and C3 is the sole killer, because every input here
  // fails to parse under BOTH implementations. Left in place for what it does pin — that a fragment
  // degrades — with the false claim removed rather than the test.
  const fragment = CAP0.groups.slice(0, CAP0.groups.indexOf('"label"') + 12);
  assert.equal(parseGroupResponse(toolUse(fragment)), null,
    'half of one group is not a classify — degrade rather than invent');
  assert.equal(parseGroupResponse(toolUse('[')), null, 'an empty opening bracket is not a classify');
  assert.equal(parseGroupResponse(toolUse('not json at all')), null, 'and neither is prose');
});

test('BUG-116 C5: non-string, non-array groups still degrade, exactly as before', () => {
  // GREEN BEFORE THE FIX, declared. It can only red if the repair reaches into shapes that were
  // never text — which would be a new failure mode, not a fix.
  for (const junk of [{}, 42, true, null, undefined]) {
    assert.equal(parseGroupResponse(toolUse(junk)), null, `groups=${JSON.stringify(junk)} must degrade`);
  }
  assert.equal(parseGroupResponse({}), null, 'a body with no content at all still degrades');
  assert.equal(parseGroupResponse({ content: [{ type: 'text', text: 'nope' }] }), null,
    'a reply with no tool_use block still degrades');
});

test('BUG-116 C6: the repair never invents — every label and id appears verbatim in the source', () => {
  // Near-vacuous against an implementation that only slices, and that is the point: it exists to
  // fail a future "improvement" that completes a partial object by guessing at its closing brace.
  const parsed = parseGroupResponse(toolUse(CAP0.groups));
  assert.ok(parsed, 'guard: capture-0 recovered');
  for (const g of parsed.groups) {
    assert.ok(CAP0.groups.includes(JSON.stringify(g.label)),
      `label ${JSON.stringify(g.label)} was not present verbatim in the captured string`);
    for (const id of g.item_ids) {
      assert.ok(CAP0.groups.includes(JSON.stringify(id)),
        `item id ${JSON.stringify(id)} was not present verbatim in the captured string`);
    }
  }
});

test('BUG-116 C7: a well-formed native array is returned untouched', () => {
  // GREEN BEFORE THE FIX, declared. Pins that the repair is reached only when it is needed.
  const native = [
    { label: 'AI news', item_ids: ['0', '1'], summary: ['a bullet'] },
    { label: 'Tesla', item_ids: ['2'] },
  ];
  const parsed = parseGroupResponse(toolUse(native));
  assert.deepEqual(parsed, { groups: native }, 'a native array must pass through unchanged');
  assert.equal(parsed.groups, native, 'and must be the SAME array — not a re-parsed copy');
});

test('BUG-116 C8: groupItems reports `repaired` exactly when the repair produced the groups', async () => {
  const items = Array.from({ length: 70 }, (_, n) => ({ id: `x${n}`, source: 'twitter', text: `post ${n}` }));

  const repaired = await groupItems(
    { items, apiKey: 'k' },
    async () => fakeResponse(toolUse(CAP0.groups)),
  );
  assert.ok(repaired, 'guard: the truncated reply produced a result at all');
  assert.equal(repaired.repaired, true, 'a recovered reply is flagged as repaired');

  assert.equal(repaired.truncated, true, 'and as truncated, because the scanner had to cut it');

  // THE CASE THE FIRST VERSION MISSED, and an independent review caught: a COMPLETE array that the
  // model merely serialised. It travels the same string path and is equally worth recovering, but it
  // is NOT the truncation this task was logged for. One flag for both would mean a rate that stopped
  // being about truncation went on looking identical.
  const stringified = await groupItems(
    { items, apiKey: 'k' },
    async () => fakeResponse(toolUse(JSON.stringify([{ label: 'AI news', item_ids: ['0', '1'] }]))),
  );
  assert.ok(stringified, 'guard: the complete stringified reply produced a result');
  assert.equal(stringified.repaired, true, 'a string that needed parsing is still a recovery');
  assert.equal(stringified.truncated, false, '…but it was NOT truncated, and must not say it was');

  const clean = await groupItems(
    { items, apiKey: 'k' },
    async () => fakeResponse(toolUse([{ label: 'AI news', item_ids: ['0', '1'] }])),
  );
  assert.ok(clean, 'guard: the well-formed reply produced a result');
  assert.notEqual(clean.repaired, true, 'a reply that arrived as an array is NOT flagged');
  assert.notEqual(clean.truncated, true, 'nor flagged as truncated');
});

test('BUG-116 C9: a group DROPPED by truncation leaves its posts unassigned, never misfiled', async () => {
  // REBUILT after review. The first version fed the whole capture-0 string, which has NO partial
  // trailing group — both fixtures are complete arrays missing one character — so it exercised
  // `validatePartition`'s pre-existing forgotten-id sweep and not this change at all. Its comment
  // said the unaccounted posts were "lost to truncation"; they were omitted by the MODEL. The
  // criterion is about a group the SCANNER drops, so the input must actually have one.
  //
  // A mid-object cut does: 4 complete groups survive, the fifth is half-written and discarded, and
  // the posts it would have held must reach the client unfiled — readable in the chronological
  // stream ([TASK-096]) — rather than filed under one of the four that did survive.
  const items = Array.from({ length: 70 }, (_, n) => ({ id: `x${n}`, source: 'twitter', text: `post ${n}` }));
  const cut = Math.floor(CAP0.groups.length * 0.5);
  const call = reply => groupItems({ items, apiKey: 'k' }, async () => fakeResponse(toolUse(reply)));

  const truncated = await call(CAP0.groups.slice(0, cut));
  assert.ok(truncated, 'guard: the mid-object cut still produced a result');
  assert.equal(truncated.truncated, true, 'guard: and it went through the scanner, not the honest parse');

  const returned = idsOf(truncated.groups);
  assert.equal(new Set(returned).size, 70, 'still an exact partition of all 70 posts');
  assert.equal(returned.length, 70, 'and no post appears twice');

  // What survived the cut, derived from the FULL capture rather than from the scanner's own output.
  // The oracle cannot be applied to the cut string directly — appending one `]` to a half-written
  // object does not parse, which is exactly why the scanner exists.
  const survived = oracle(CAP0.groups).slice(0, 4);
  assert.equal(survived.length, 4, 'guard: four complete groups precede the cut');

  const bucket = truncated.groups.find(g => g.label === EVERYTHING_ELSE);
  assert.ok(bucket, 'the posts whose group was discarded must land in "Everything else"');

  // THE MISFILE CHECK: every post that survived the cut keeps the topic the model gave it, and
  // every post that did not is unfiled. Neither may end up under someone else's label — assignment
  // is irreversible, so a misfile is permanent.
  const survivorTopic = new Map();
  for (const g of survived) for (const pos of g.item_ids) survivorTopic.set(`x${pos}`, g.label);
  for (const g of truncated.groups) {
    for (const id of g.item_ids) {
      if (survivorTopic.has(id)) {
        assert.equal(g.label, survivorTopic.get(id), `${id} must keep the topic the model gave it`);
      } else {
        assert.equal(g.label, EVERYTHING_ELSE, `${id} lost its group to truncation and must be unfiled`);
      }
    }
  }
  assert.equal(survivorTopic.size, 25, 'guard: 25 posts survived the cut, so 45 were dropped');
  assert.equal(bucket.item_ids.length, 45, 'and all 45 arrive unfiled');
});

test('BUG-116 C13: an unbalanced bracket inside a LABEL cannot move the cut', () => {
  // The scanner's `if (inStr) continue` had no fixture at all: neither captured reply contains
  // `[ ] { }` inside any string, so deleting the guard left the whole suite green. An independent
  // battery measured the cost over 200,000 randomised replies — 13% came back valid but SHORT,
  // complete groups silently dropped with no degrade signal and no flag difference.
  //
  // The bracket must be UNBALANCED to bite, which is the part that is easy to get wrong: a label
  // like "Tesla [FSD beta]" opens and closes, nets to zero, and such a fixture proves NOTHING —
  // the unguarded scanner returns the same answer. A stray opener does not net out. `Tesla [FSD
  // rollout` is ordinary model output.
  const groups = [
    { label: 'Tesla [FSD rollout', item_ids: ['0'] },
    { label: 'Second', item_ids: ['1'] },
    { label: 'Third', item_ids: ['2'] },
  ];
  const truncated = JSON.stringify(groups).slice(0, -1);   // drop the closing ]
  const parsed = parseGroupResponse(toolUse(truncated));
  assert.ok(parsed, 'a stray bracket inside a label must not degrade the classify');
  assert.deepEqual(parsed.groups, groups, 'all three groups recover, the label intact');
});

test('BUG-116 C14: an escaped quote inside a string cannot desynchronise the scan', () => {
  // Same shape as C13 for the `esc` half — also unfixtured, also survived a battery. Both captures
  // happen to carry balanced quote pairs, so parity is preserved and the tests were blind. An ODD
  // number of escaped quotes is what desynchronises string state; a sentence that opens a quotation
  // and is cut before closing it is exactly how that arises in real summaries.
  const groups = [
    { label: 'He said "go now', item_ids: ['0'] },
    { label: 'Second', item_ids: ['1'] },
    { label: 'Third', item_ids: ['2'] },
  ];
  const truncated = JSON.stringify(groups).slice(0, -1);
  const parsed = parseGroupResponse(toolUse(truncated));
  assert.ok(parsed, 'an escaped quote must not degrade the classify');
  assert.deepEqual(parsed.groups, groups, 'all three groups recover, the quotation intact');
});

test('BUG-116 C15: a truncation landing EXACTLY on the final brace keeps that group', () => {
  // The loop bound. `i < s.length - 1` never examines the last character, and both captured strings
  // end `}\n` — the newline absorbs the off-by-one, so the mutation survived. A reply cut with no
  // trailing whitespace is the case that exposes it, and "the truncation lands at a clean element
  // boundary" is the measured shape this whole fix is built for, which makes that byte load-bearing.
  const groups = [
    { label: 'One', item_ids: ['0'] },
    { label: 'Two', item_ids: ['1'] },
    { label: 'Three', item_ids: ['2'] },
  ];
  const truncated = JSON.stringify(groups).slice(0, -1);
  assert.equal(truncated.at(-1), '}', 'guard: this fixture really does end on the brace, with nothing after it');
  const parsed = parseGroupResponse(toolUse(truncated));
  assert.ok(parsed, 'guard: it recovered at all');
  assert.equal(parsed.groups.length, 3, 'the final complete group is kept, not skipped by the loop bound');
});

test('BUG-116 C16: a recovered EMPTY array is a repair, consistent with a native empty array', () => {
  // Deliberate, and it is the one place we did NOT follow a review. Making the string "[]" degrade
  // while a NATIVE [] continues to succeed would make two spellings of the same reply behave
  // differently — a new inconsistency rather than a fix. The only real problem was that it counted
  // as a TRUNCATION repair, which `truncated: false` now settles. Pinned so the behaviour stops
  // being merely unspecified in either direction.
  const parsed = parseGroupResponse(toolUse('[]'));
  assert.deepEqual(parsed, { groups: [], repaired: true, truncated: false },
    'an empty array recovered from a string is a recovery, and is not truncated');
});

// ── the client counters ────────────────────────────────────────────────

const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUBLISHED = '2026-08-20T10:00:00.000Z';
const xPost = (id, text = `post ${id} says something`) => ({
  id, source: 'twitter', text, published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});
const render = (app, items) =>
  app.ctx.renderFeedResults({ items, failed: [], cappedNames: [], totalChannels: items.length });
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
const events = (app, name) => JSON.parse(app.get('focus_events') || '[]').filter(e => e.name === name);

/** A classify that answers with exactly `body`, or fails the way `fail` says. */
function bootAnswering(body, { grouped = true, store = {}, fail = null } = {}) {
  const app = createApp({
    store: { focus_device_id: DEVICE, focus_group_view: grouped ? 'on' : 'off', ...store },
  });
  app.setFetch(async url => {
    if (!String(url).includes('/api/group')) return { ok: true, status: 200, json: async () => ({}) };
    if (fail === 'throw') throw new Error('offline');
    if (typeof fail === 'number') return { ok: false, status: fail, json: async () => ({}) };
    if (fail === 'badbody') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } };
    return { ok: true, status: 200, json: async () => body };
  });
  return app;
}

test('BUG-116 C10: a degraded classify is recorded; one that answers is not', async () => {
  // The NEGATIVE half is load-bearing: without it the counter measures attempts, not failures, and
  // the production rate this task exists to produce would be meaningless.
  // `new` and `total` MUST DIFFER here. The first version rendered two posts of which two were new,
  // so `new === total === 2` and swapping the two props survived a mutation battery — the assertion
  // could not tell its own fields apart. One post is pre-assigned so the numbers separate:
  // three groupable unread, of which two are new to this classify.
  const seeded = {
    focus_groups: JSON.stringify({
      assignments: { x1: 'g_seed' },
      groups: { g_seed: { label: 'Seeded topic', item_ids: ['x1'] } },
      unfiled: [],
    }),
  };
  const bad = bootAnswering({ groups: null, reason: 'unavailable' }, { store: seeded });
  bad.ctx.wireApp();
  render(bad, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();
  const rec = events(bad, 'group_classify_degraded');
  assert.equal(rec.length, 1, 'a {groups:null} answer is recorded exactly once');
  assert.equal(rec[0].props.new, 2, '`new` is the posts this classify sent — two of the three');
  assert.equal(rec[0].props.total, 3, '`total` is every groupable unread post — all three');

  const good = bootAnswering({ groups: [{ id: 'g_ai', label: 'AI news', item_ids: ['x1', 'x2'] }], capped: false });
  good.ctx.wireApp();
  render(good, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(events(good, 'group_classify_degraded').length, 0,
    'a classify that answered is never counted as a degrade');
});

test('BUG-116 C11: a repaired classify is recorded, and an unrepaired one is not', async () => {
  const repaired = bootAnswering({
    groups: [{ id: 'g_ai', label: 'AI news', item_ids: ['x1', 'x2'] }],
    capped: false, repaired: true, truncated: true,
  });
  repaired.ctx.wireApp();
  render(repaired, [xPost('x1'), xPost('x2')]);
  await settle();
  const rep = events(repaired, 'group_classify_repaired');
  assert.equal(rep.length, 1,
    'a reply the server had to repair is recorded — this is the number that measures the bug in production');
  assert.equal(rep[0].props.truncated, true, 'and says it was the TRUNCATION case');

  // The other half of the same path: a complete array the model merely serialised. Recorded, but it
  // must not inflate the truncation rate — that conflation is what the review found.
  const stringified = bootAnswering({
    groups: [{ id: 'g_ai', label: 'AI news', item_ids: ['x1', 'x2'] }],
    capped: false, repaired: true, truncated: false,
  });
  stringified.ctx.wireApp();
  render(stringified, [xPost('x1'), xPost('x2')]);
  await settle();
  const str = events(stringified, 'group_classify_repaired');
  assert.equal(str.length, 1, 'a stringified-but-complete reply is still a recovery worth counting');
  assert.equal(str[0].props.truncated, false, '…but must NOT be counted as a truncation');

  const clean = bootAnswering({
    groups: [{ id: 'g_ai', label: 'AI news', item_ids: ['x1', 'x2'] }], capped: false,
  });
  clean.ctx.wireApp();
  render(clean, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(events(clean, 'group_classify_repaired').length, 0,
    'a reply that arrived intact is not counted as a repair');
});

test('BUG-116 C12: a degrade still reveals held posts — nothing is left hidden', async () => {
  // GREEN BEFORE THE FIX, declared. `revealPendingText()` runs unconditionally after the `finally`,
  // and this change edits the branch immediately beside it. BUG-104 measured what regressing this
  // costs: a badge reading "3 new" over a completely empty feed.
  const app = bootAnswering({ groups: null, reason: 'unavailable' });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  // The POSITIVE form first, because "nothing is held" is vacuously true on an empty feed — the
  // instrument must be shown capable of seeing a card before its silence counts as evidence.
  const visible = app
    .queryAll('#feed .card:not(.grouped-out):not(.grouping-pending):not(.removing)')
    .map(c => c.dataset.id);
  assert.deepEqual(visible, ['x1', 'x2'],
    'both posts must be READABLE after a degrade — not merely un-held');

  const held = app.queryAll('#feed .card.grouping-pending').map(c => c.dataset.id);
  assert.deepEqual(held, [], 'and none of them left hidden behind .grouping-pending');
});

test('BUG-116 C17: a non-2xx is counted as a FAILURE, never as a degrade', async () => {
  // The `if (res.ok)` branch was not load-bearing: deleting it left the suite green while a 502 got
  // filed as `group_classify_degraded`. Nothing in the suite drove a non-ok response at all.
  //
  // 429 is the realistic one — the WAF rate-limit rule documented in `api/group.js` denies at the
  // EDGE, so the request never reaches the handler and cannot come back as a degrade.
  for (const status of [429, 502, 504]) {
    const app = bootAnswering(null, { fail: status });
    app.ctx.wireApp();
    render(app, [xPost('x1'), xPost('x2')]);
    await settle();
    const failed = events(app, 'group_classify_failed');
    assert.equal(failed.length, 1, `a ${status} is recorded exactly once as a failure`);
    assert.equal(failed[0].props.status, status, 'and carries the status, so the remedy is distinguishable');
    assert.equal(events(app, 'group_classify_degraded').length, 0,
      `a ${status} must NOT be filed as a degrade — different failure, different remedy`);
  }
});

test('BUG-116 C18: a 200 with an unparseable body is a DEGRADE, and is recorded', async () => {
  // The most literal instance of "answered 200, carried nothing usable" — and it was unpinned. The
  // `data &&` term guards it: without that term `data.groups` throws on a null body, execution lands
  // in the catch, and the degrade goes unrecorded (or, since the failure counter, is miscounted as a
  // transport failure). `res.json().catch(() => null)` is what makes `data` null here.
  const app = bootAnswering(null, { fail: 'badbody' });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(events(app, 'group_classify_degraded').length, 1,
    'an unreadable body is the degrade case, and must be counted as one');
  assert.equal(events(app, 'group_classify_failed').length, 0,
    'it reached our endpoint and got a 200 — it is not a transport failure');
});

test('BUG-116 C19: a thrown fetch is a failure; an ABORT stays a timeout and is not double-counted', async () => {
  // The catch branch. Both halves matter: without the `else` an offline classify is counted by
  // nothing, and without the `ctrl.signal.aborted` term every timeout would be counted twice — once
  // as a timeout and again as a failure — which would quietly break the partition the counters exist
  // to provide.
  const offline = bootAnswering(null, { fail: 'throw' });
  offline.ctx.wireApp();
  render(offline, [xPost('x1'), xPost('x2')]);
  await settle();
  const failed = events(offline, 'group_classify_failed');
  assert.equal(failed.length, 1, 'a thrown fetch is recorded as a failure');
  assert.equal(failed[0].props.status, 0, 'with status 0 — no response ever existed to have one');
  assert.equal(events(offline, 'group_classify_timeout').length, 0, 'and it is not a timeout');

  // An abort: the request stalls until the client gives up at the bound.
  const BOUND = Number(
    /const GROUP_TIMEOUT_MS = (\d+);/.exec(readFileSync(join(ROOT, 'app.js'), 'utf8'))?.[1],
  );
  assert.ok(Number.isFinite(BOUND), 'guard: read the real bound from app.js');
  const stalled = createApp({ store: { focus_device_id: DEVICE, focus_group_view: 'on' } });
  stalled.setFetch(async (url, init) => {
    if (!String(url).includes('/api/group')) return { ok: true, status: 200, json: async () => ({}) };
    return new Promise((_, reject) => {
      const sig = init.signal;
      if (!sig) return;
      const fail = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
      if (sig.aborted) return fail();
      sig.addEventListener('abort', fail);
    });
  });
  stalled.ctx.wireApp();
  render(stalled, [xPost('x1'), xPost('x2')]);
  await settle();
  // SPLIT, and this is not stylistic. Advancing in one step also brings the analytics flush timer
  // due, which ships the buffer and CLEARS it — the read then finds nothing and reports the marker
  // missing when it fired perfectly well. `group-timeout.test.mjs` records the same trap; this test
  // walked straight into it before the split.
  stalled.advance(BOUND - 1);
  await settle();
  stalled.advance(1);
  await settle();
  assert.equal(events(stalled, 'group_classify_timeout').length, 1, 'the abort is recorded as a timeout');
  assert.equal(events(stalled, 'group_classify_failed').length, 0,
    'and NOT also as a failure — a double-counted timeout breaks the partition');
});

// ── [BUG-130] the sign-in gate's refusals, seen from the client ──────────────────────────────────────
//
// Since BUG-130 our OWN handler answers 401 (no session) and 503 (session could not be checked). Until
// then a non-2xx on this request came only from the edge, and C17 above drives 429/502/504 and asserts
// analytics only. Review round 1 (M4) showed two things nothing pinned.

test('BUG-130 C20: a 401 or 503 from the gate still reveals held posts, and is counted as a failure', async () => {
  // Independent battery survivor A2: a `return` after the `group_classify_failed` track skips
  // `revealPendingText()`, leaving a badge counting posts over an empty feed. Same positive-then-negative
  // form as C12, because "nothing is held" is vacuously true on an empty feed.
  for (const status of [401, 503]) {
    const app = bootAnswering(null, { fail: status });
    app.ctx.wireApp();
    render(app, [xPost('x1'), xPost('x2')]);
    await settle();
    const visible = app
      .queryAll('#feed .card:not(.grouped-out):not(.grouping-pending):not(.removing)')
      .map(c => c.dataset.id);
    assert.deepEqual(visible, ['x1', 'x2'], `both posts must be READABLE after a ${status}`);
    const held = app.queryAll('#feed .card.grouping-pending').map(c => c.dataset.id);
    assert.deepEqual(held, [], `none left hidden behind .grouping-pending after a ${status}`);
    const failed = events(app, 'group_classify_failed');
    assert.equal(failed.length, 1, `a ${status} is recorded exactly once as a failure`);
    assert.equal(failed[0].props.status, status);
  }
});

test('BUG-130 C21: the classify request does not opt out of the session cookie', async () => {
  // Independent battery survivor A1: `credentials: 'omit'` on this fetch would have every signed-in user
  // refused, and the harness fetch models no cookies, so only the request's own options can show it. A
  // same-origin fetch sends the cookie unless it says otherwise; this pins that it does not say otherwise.
  const app = createApp({ store: { focus_device_id: DEVICE, focus_group_view: 'on' } });
  const seen = [];
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) seen.push({ url: String(url), credentials: init?.credentials });
    return { ok: true, status: 200, json: async () => ({ groups: null }) };
  });
  app.ctx.wireApp();
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(seen.length, 1, 'the classify actually went out');
  assert.equal(seen[0].url, '/api/group', 'same-origin, so the cookie rides along by default');
  assert.ok([undefined, 'same-origin', 'include'].includes(seen[0].credentials),
    `the request opts out of the cookie: credentials=${seen[0].credentials}`);
});
