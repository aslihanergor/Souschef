// [BUG-104] — A STALLED /api/group MUST NOT WEDGE GROUPING FOR THE SESSION.
//
// `updateGroupsForFeed` awaits `fetch('/api/group')` with no AbortController and no timeout — the
// only user-state fetch in `app.js` without one. A request that STALLS rather than fails never
// settles, so the `finally` never runs: `_grouping` stays true and the busy indicator never hides.
//
// REPRODUCED before a line of the fix was written (recorded in tasks/BUG-104.md): three renders
// against a stalled classify leave the badge reading "3 new" over a COMPLETELY EMPTY feed, swallow
// posts that arrive after the wedge, and freeze the /api/group call count at 1.
//
// WHICH TESTS COULD RED BEFORE THE FIX, stated because a merely-red suite hides the one that passed
// for the wrong reason (CLAUDE.md, Mutation batteries):
//
//   RED before the fix   — C1, C3, C4, C6. Four of six.
//   GREEN before the fix — C2 and C5, BY DESIGN, and neither is decoration:
//     C2 guards against a bound that is too TIGHT. It can only red if the fix is wrong, which is
//        exactly what the 45000 → 2500 mutation does to it.
//     C5 guards the degrade path's silence. Before the fix nothing is written because the classify
//        never returns; after it, nothing is written because a timeout must not record posts as
//        already-seen. Same assertion, two different reasons — and the second is the one that can
//        break.
//
// THE FAKES' FIDELITY IS PROVEN BY TEST, NOT BY INSPECTION — but by TWO tests, not one, and saying
// "C1 proves it" was false by omission until an independent battery said so.
//   `bootStalled` is covered by C1: if it ignored `init.signal` nothing would ever reject, the
//   `finally` would never run, and C1 could not pass EVEN WITH THE FIX.
//   `bootGated` is a DIFFERENT fake and C1 never touches it. Reverting its race to a plain
//   `await gate` left the entire suite green and resurrected the 45000 → 2500 mutation — so C2, the
//   only defence of the bound's SIZE, was one careless edit from being decoration. C8 exists to
//   close that, and M14 mutates the fake itself to prove C8 can see it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MAX_ITEMS } from '../api/_group.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUBLISHED = '2026-08-20T10:00:00.000Z';
// READ FROM THE SOURCE, not hand-synced. As a literal this said 45000, and when the bound moved to
// 120000 six tests went red at once — they were testing a number this file happened to agree with
// rather than the app's actual behaviour. C1-C9 are all about behaviour RELATIVE to the bound
// (in flight just before it, abandoned at it), so deriving it is what they always meant.
// The absolute value is pinned separately and deliberately by C10, against the SERVER's MAX_ITEMS —
// a test that derives the bound cannot also judge whether the bound is big enough.
const BOUND = Number(
  /const GROUP_TIMEOUT_MS = (\d+);/.exec(readFileSync(join(ROOT, 'app.js'), 'utf8'))?.[1]
);
if (!Number.isFinite(BOUND)) throw new Error('could not read GROUP_TIMEOUT_MS from app.js');

const xPost = (id, text = `post ${id} says something`) => ({
  id, source: 'twitter', text, published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});

const render = (app, items) =>
  app.ctx.renderFeedResults({ items, failed: [], cappedNames: [], totalChannels: items.length });

const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };

const heldIds = app => app.queryAll('#feed .card.grouping-pending').map(c => c.dataset.id);
const visibleIds = app =>
  app.queryAll('#feed .card:not(.grouped-out):not(.grouping-pending):not(.removing)').map(c => c.dataset.id);
const busyHidden = app => app.el('group-busy').classList.contains('hidden');
const groups = app => JSON.parse(app.get('focus_groups') || '{"assignments":{},"groups":{},"unfiled":[]}');

function abortError() {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

/** A classify that STALLS — the request goes out and the promise never settles — unless the client
 *  aborts it, in which case it rejects the way a browser does.
 *  `stallBody: true` moves the stall AFTER the headers: the response resolves, its `json()` is what
 *  hangs. That is the case a timer cleared straight after `fetch` would miss entirely. */
function bootStalled({ store = {}, grouped = true, stallBody = false } = {}) {
  const reqs = [];
  const app = createApp({
    store: { focus_device_id: DEVICE, focus_group_view: grouped ? 'on' : 'off', ...store },
  });
  app.setFetch(async (url, init) => {
    if (!String(url).includes('/api/group')) return { ok: true, status: 200, json: async () => ({}) };
    reqs.push(init);
    const abortive = () => new Promise((_, reject) => {
      const s = init.signal;
      if (!s) return;                                    // unbounded: nothing ever rejects
      if (s.aborted) return reject(abortError());
      s.addEventListener('abort', () => reject(abortError()));
    });
    if (stallBody) return { ok: true, status: 200, json: () => abortive() };
    return abortive();
  });
  return { app, reqs };
}

/** A classify that hangs until `release()` — used where the point is "it answered in time".
 *
 *  IT MUST HONOUR `init.signal` TOO, and this is not symmetry for its own sake. The first version
 *  awaited the gate alone, so an abort simply went unnoticed and the request answered anyway. The
 *  M3 mutation — the bound cut from 45s to /api/state's 2500ms — then SURVIVED: the abort fired at
 *  2.5s inside C2's 44.9s window, the fake ignored it, the assignments landed, and C2 passed while
 *  asserting nothing about the quantity in its own name. Green, correct-looking, and measuring the
 *  wrong thing. Found by the battery, not by re-reading; the assertion below never changed. */
function bootGated({ store = {}, reply = [], grouped = true, ok = true } = {}) {
  const reqs = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const app = createApp({
    store: { focus_device_id: DEVICE, focus_group_view: grouped ? 'on' : 'off', ...store },
  });
  app.setFetch(async (url, init) => {
    if (!String(url).includes('/api/group')) return { ok: true, status: 200, json: async () => ({}) };
    reqs.push(init);
    // Whichever comes first: the server answering, or the client giving up. With no signal (the
    // unbounded code this replaced) the abort side never settles, so the race is just the gate.
    await Promise.race([gate, new Promise((_, reject) => {
      const sig = init.signal;
      if (!sig) return;
      if (sig.aborted) return reject(abortError());
      sig.addEventListener('abort', () => reject(abortError()));
    })]);
    if (!ok) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ groups: reply, capped: false }) };
  });
  return { app, reqs, release: () => release() };
}

const AI_NEWS = { id: 'g_ai_news', label: 'AI news', item_ids: ['x1', 'x2'], summary: ['a bullet'] };

test('BUG-104 C1: a classify whose response never arrives is abandoned at the bound, and grouping resumes', async () => {
  // Predicted killer of "delete the AbortController" and of "drop `signal:` from the init": this
  // test. Nothing else in the suite makes a stalled classify observable past the stall.
  const { app, reqs } = bootStalled({ grouped: true });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(reqs.length, 1, 'guard: the classify actually went out');
  assert.equal(busyHidden(app), false, 'guard: the busy indicator is showing while the call is in flight');

  app.advance(BOUND);
  await settle();

  assert.equal(busyHidden(app), true, 'the busy indicator is hidden once the bound passes');

  // The observable that proves `_grouping` was released. Reading the flag would prove nothing about
  // what the reader can do next; issuing a second classify is what "grouping still works" MEANS.
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(reqs.length, 2, 'a second classify ran — the re-entrancy guard was released');
});

test('BUG-104 C2: a classify that answers just inside the bound is NOT aborted', async () => {
  // GREEN BEFORE THE FIX, declared. Predicted killer: the 45000 → 2500 mutation, which aborts this
  // classify 42.4s before it answers and leaves the assignments unwritten.
  const { app, reqs, release } = bootGated({ grouped: true, reply: [AI_NEWS] });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(reqs.length, 1, 'guard: the classify actually went out');

  app.advance(BOUND - 100);   // 44.9s — inside the bound, so nothing may abort
  await settle();
  release();
  await settle();

  assert.deepEqual(Object.keys(groups(app).assignments).sort(), ['x1', 'x2'],
    'a classify answering at 44.9s still lands its assignments — the bound is not too tight');
});

test('BUG-104 C3: a stall AFTER the headers — a body read that never settles — is bounded too', async () => {
  // Predicted killer of "move clearTimeout back above res.json()": this test alone. C1 passes with
  // the timer cleared early, because C1's stall happens before the response exists.
  const { app, reqs } = bootStalled({ grouped: true, stallBody: true });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(reqs.length, 1, 'guard: the classify actually went out');
  assert.equal(busyHidden(app), false, 'guard: still in flight — the body has not arrived');

  app.advance(BOUND);
  await settle();

  assert.equal(busyHidden(app), true, 'a hung body read is abandoned at the bound, like a hung response');
  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(reqs.length, 2, 'and grouping resumes');
});

test('BUG-104 C4: after the bound, the held posts are readable instead of hidden', async () => {
  // The half of this bug that costs the READER rather than the mechanism. Measured on main: the
  // badge reads "3 new" over an empty feed because every held card stays display:none forever.
  const { app } = bootStalled({ grouped: true });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.deepEqual(heldIds(app).sort(), ['x1', 'x2'], 'guard: both posts are held while the classify runs');
  assert.deepEqual(visibleIds(app), [], 'guard: and the reader can see neither');

  app.advance(BOUND);
  await settle();

  assert.deepEqual(heldIds(app), [], 'no post stays held once the classify has been abandoned');
  assert.deepEqual(visibleIds(app).sort(), ['x1', 'x2'],
    'both posts are readable in the chronological stream — the degrade this app promises everywhere else');
});

test('BUG-104 C5: a timed-out classify records nothing — not even that the posts were seen', async () => {
  // GREEN BEFORE THE FIX, declared, and the two reasons differ: before, nothing is written because
  // the call never returns; after, because a timeout must not mark posts already-seen. The second is
  // the one that can break — writing `unfiled` here would let one stalled request permanently
  // suppress the hold for genuinely-new posts.
  const before = { assignments: {}, groups: {}, unfiled: [], updatedAt: 1 };
  const raw = JSON.stringify(before);
  const { app, reqs } = bootStalled({ grouped: true, store: { focus_groups: raw } });
  app.ctx.wireApp();
  // A SYNCED boot, and the fixture is wrong without it. `pushNow` sends events-only for as long as
  // `_stateLoaded` is false, so in an unsynced fixture a state push is impossible BY CONSTRUCTION and
  // this test cannot tell a timeout that writes state from one that does not. That is not a
  // theoretical nicety: forcing `changed` true SURVIVED here until this line existed. Every real
  // user is synced, so the unsynced fixture was the unrepresentative one.
  await app.ctx.syncOnLoad();
  await settle();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  // THE GUARD C5 SHIPPED WITHOUT, and its absence made this test pass against a tree where
  // `updateGroupsForFeed` was never called at all — no classify, no abort, nothing to record, green.
  // Found by an independent reviewer and reproduced directly: replacing the call site with
  // `void items` left C1-C4 and C6 red and THIS TEST GREEN. Every sibling opens with this line;
  // C5 was the one that omitted it, which is exactly why it was the one that went vacuous.
  assert.equal(reqs.length, 1, 'guard: the classify actually went out');

  // The BASELINE is the record as it stands with the classify already in flight — NOT the seeded
  // string. Rendering legitimately migrates the record (`v`, `postMeta`, `postMetaEpoch`) before the
  // classify is even issued, so comparing against the seed would measure that migration and blame it
  // on the timeout. What this test is about is the timeout's OWN contribution, which must be nil.
  // SIZED SO ONLY THE GUARD UNDER TEST CAN FIRE. `advance(BOUND)` in one step also fires the two
  // unrelated timers pending at 1500ms and 3000ms — the analytics push debounce — and the /api/state
  // PUT they produce is indistinguishable from one the timeout caused. Splitting the window moves
  // them out of the measured interval, and pins the lower edge of the bound as a bonus: at
  // BOUND - 1 the classify must still be in flight.
  app.advance(BOUND - 1);
  await settle();
  assert.equal(busyHidden(app), false, 'guard: one millisecond short of the bound, the classify is still running');

  const recordBeforeBound = app.get('focus_groups');
  const dirtyBeforeBound = app.get('focus_dirty');
  const stateWritesBefore = app.requests.filter(r => r.url.includes('/api/state')).length;

  app.advance(1);   // now the abort is the ONLY timer due
  await settle();
  assert.equal(busyHidden(app), true, 'guard: the bound actually fired — otherwise nothing here is about a TIMEOUT');

  // BYTE-IDENTICAL, not field-by-field. Reading `assignments` and `unfiled` alone cannot see a WRITE
  // that changes neither: flipping `changed` to true makes every degrade call `saveGroupState`,
  // which stamps the record and calls `schedulePush()` — a billed /api/state PUT on every timeout.
  // That mutation survived the first version of this test.
  assert.equal(app.get('focus_groups'), recordBeforeBound,
    'the stored record is byte-identical across the bound — a timeout writes nothing at all');

  // BYTE-IDENTICAL IS NOT ENOUGH ON ITS OWN, and the battery is what proved it. Forcing `changed`
  // true makes the degrade call `saveGroupState`, but on this path `state` was never modified and
  // `postMetaEpoch` is already stamped — so the record it writes back is byte-for-byte what was
  // there, and the comparison above sees nothing. The WRITE is still real: it arms `schedulePush`,
  // which sets the dirty flag and queues a billed /api/state PUT. That is what these two see.
  assert.equal(app.get('focus_dirty'), dirtyBeforeBound,
    'no push was armed — a timeout must not mark local state as ahead of the server row');

  // A raw request COUNT is the wrong quantity here, and it took the marker to expose that: a timeout
  // now legitimately emits `group_classify_timeout`, and `track` flushes analytics through the same
  // /api/state endpoint. So one more PUT after the bound is CORRECT. What must never happen is a
  // STATE push — the app's own analytics timer is "events-only by construction", and the thing that
  // separates the two is whether the body carries state at all.
  app.advance(5000);   // long enough for any debounce armed at the bound to come due
  await settle();
  const after = app.requests.filter(r => r.url.includes('/api/state')).slice(stateWritesBefore);
  for (const r of after) {
    const body = JSON.parse(r.init.body || '{}');
    assert.deepEqual(Object.keys(body).sort(), ['events', 'uid'],
      `a PUT after the bound carried more than analytics: ${Object.keys(body).join(', ')} — `
      + 'a classify that never answered must not push user state');
  }
});

test('BUG-104 C6: a successful classify clears its timer, so no late abort fires', async () => {
  // Predicted killer of "delete clearTimeout(t)": this test. The fetch is long settled by then, so
  // the abort is a no-op FOR THE REQUEST — but the SIGNAL still flips, and that is observable.
  // (Scoped as an expected mutation SURVIVOR in tasks/BUG-104.md on the reasoning that an abort
  // after settle is unobservable. That prediction was wrong: the signal is the observable.)
  const { app, reqs, release } = bootGated({ grouped: true, reply: [AI_NEWS] });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  release();
  await settle();
  assert.deepEqual(Object.keys(groups(app).assignments).sort(), ['x1', 'x2'], 'guard: the classify succeeded');

  // PAST the bound, derived — this said `advance(60000)` while the bound was 45000, and when the
  // bound moved to 120000 the advance no longer reached the timer at all: the test kept passing
  // while both clearTimeout mutations walked straight through it. A literal that silently stops
  // reaching the thing it tests is the worst kind, because nothing goes red.
  app.advance(BOUND + 60000);
  await settle();

  assert.equal(reqs[0].signal.aborted, false,
    'the timer was cleared on success — nothing aborts a request that already answered');
});

// ── Added after independent review, 2026-08-28 ────────────────────────────────
// Three gaps an independent mutation battery found in the six above. Each is recorded with the
// mutation that survived, because a test whose motivating defect is not written down is one
// refactor away from looking redundant.

test('BUG-104 C7: while a classify is in flight, a second render does NOT start another', async () => {
  // GREEN BEFORE THE FIX, declared — the guard is pre-existing. It is here because the CHANGE made
  // it load-bearing and NOTHING pinned it: neutering it to `if (false && _grouping) return;` left
  // all 908 tests green (reproduced directly, not taken on report). That mattered twice over —
  // C1 and C3 assert "a second classify ran — the re-entrancy guard was released", and with the
  // guard unpinned that message could not distinguish "released" from "never existed".
  // Predicted killer of both `if (false && _grouping)` and `_grouping = true` deleted: this test.
  const { app, reqs } = bootStalled({ grouped: true });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(reqs.length, 1, 'guard: the first classify went out');

  render(app, [xPost('x1'), xPost('x2'), xPost('x3')]);
  await settle();

  assert.equal(reqs.length, 1,
    'the second render started no second classify — one in flight at a time, and the billed call is not doubled');
});

test('BUG-104 C8: an aborted gated request lands nothing even if the server answers afterwards', async () => {
  // THIS TEST EXISTS TO PIN `bootGated`'s FIDELITY, which C1 cannot cover — C1 only exercises
  // `bootStalled`. Reverting bootGated's race to the plain `await gate` form left the whole suite
  // green AND resurrected the 45000 → 2500 mutation, so C2 — the only defence of the bound's SIZE —
  // was one careless edit from being decoration, with nothing to catch it.
  // Predicted killer of "bootGated ignores init.signal": this test alone.
  const { app, reqs, release } = bootGated({ grouped: true, reply: [AI_NEWS] });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(reqs.length, 1, 'guard: the classify went out');

  app.advance(BOUND);
  await settle();
  release();          // the server answers, but the client gave up a moment ago
  await settle();

  assert.deepEqual(Object.keys(groups(app).assignments), [],
    'the abandoned answer is not applied — the client stopped listening and stays stopped');
});

test('BUG-104 C9: the timer is cleared on a DEGRADE answer too, not only on success', async () => {
  // `finally`, not the success branch. Gating the clear on `changed` leaves the timer armed on a
  // non-ok response, a bad body and a throw — three of the four exit paths — and that mutation
  // survived C6, which only ever drove the successful one.
  // Predicted killer of `finally { if (changed) clearTimeout(timer); ... }`: this test alone.
  const { app, reqs, release } = bootGated({ grouped: true, ok: false });
  app.ctx.wireApp();

  render(app, [xPost('x1'), xPost('x2')]);
  await settle();
  release();
  await settle();
  assert.equal(busyHidden(app), true, 'guard: the 502 resolved the classify and released the indicator');

  app.advance(BOUND + 60000);   // past the bound, derived — see C6
  await settle();

  assert.equal(reqs[0].signal.aborted, false,
    'no late abort fires after a degrade answer — the timer was cleared on that path as well');
});

test('BUG-104 C10: the bound clears the SERVER\'s own worst case, not just a literal in this file', async () => {
  // C2 pins the bound only RELATIVE to itself — its fixture is derived from the same constant, so a
  // bound and a test moved together red nothing. That is how 45s survived: it looked defended, and
  // the thing defending it could not see an absolute error. This test relates the bound to a value
  // in ANOTHER file that the client does not control, so it reds if the bound shrinks OR if the
  // server's capacity grows.
  //
  // The arithmetic is [BUG-077]'s decomposition, which its own file marks as the surviving half
  // (:317 — the 80-post headline is superseded, the model is not), plus [TASK-090]'s measured
  // finding that real latency runs ~1.45x ahead of it. Sources are cited so a future reader can
  // re-derive rather than trust.
  const FIXED_MS = 9603;          // BUG-077: prefill + network + queueing
  const PER_TOKEN_MS = 7.41;      // BUG-077: output tokens drive wall clock
  const TOKENS_PER_POST = 25.8;   // ≈23.7 bullets/labels + 2.1 short-index id (lever A shipped)
  const MODEL_UNDERSHOOT = 1.45;  // TASK-090: "real latency runs ahead of the per-token model"

  const src = readFileSync(join(ROOT, 'app.js'), 'utf8');
  const m = /const GROUP_TIMEOUT_MS = (\d+);/.exec(src);
  assert.ok(m, 'guard: the bound is still declared where this test looks for it');
  const bound = Number(m[1]);

  const worstMs = (FIXED_MS + PER_TOKEN_MS * TOKENS_PER_POST * MAX_ITEMS) * MODEL_UNDERSHOOT;
  assert.ok(bound > worstMs,
    `the bound (${bound}ms) must exceed the modelled worst case for the server's own MAX_ITEMS=${MAX_ITEMS} `
    + `(${Math.round(worstMs)}ms). A bound below it aborts a classify that would have succeeded — and `
    + 'because a timeout records nothing, the identical payload re-sends and re-bills on every render.');

  // AND AN UPPER LIMIT, because "bias large" is not "arbitrarily large". A bound of half an hour is
  // not a bound: the wedge this whole task exists to remove would simply last half an hour, with the
  // reader's posts held hidden the entire time. C1-C9 cannot see this — they derive their advance
  // FROM the bound, so they follow it wherever it goes, and the infinite-bound mutation walked
  // through every one of them.
  const CEILING_MS = 300000;
  assert.ok(bound <= CEILING_MS,
    `the bound (${bound}ms) must also stay under ${CEILING_MS}ms — past that it stops being a bound `
    + 'and the stall it exists to catch simply lasts longer, with held posts hidden throughout.');
});

test('BUG-104 C11: a timeout is recorded in analytics; a classify that answers is not', async () => {
  // How a wrong bound becomes visible in data instead of waiting for a user to notice grouping
  // quietly not working. The NEGATIVE half is the load-bearing one: it pins `ctrl.signal.aborted`,
  // without which every ordinary network failure would be counted as a timeout and the number would
  // mean nothing.
  const timeouts = app => JSON.parse(app.get('focus_events') || '[]')
    .filter(e => e.name === 'group_classify_timeout');

  const stalled = bootStalled({ grouped: true });
  stalled.app.ctx.wireApp();
  render(stalled.app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(timeouts(stalled.app).length, 0, 'guard: nothing recorded while the classify is still running');

  // Split, so the analytics flush timers come due BEFORE the abort rather than after it. Advancing
  // in one step fires a flush that ships the buffer and CLEARS it — which is why the first version of
  // this test read an empty buffer and reported the marker missing when it had fired perfectly well.
  // The instrument was wrong, not the code.
  stalled.app.advance(BOUND - 1);
  await settle();
  assert.equal(timeouts(stalled.app).length, 0, 'guard: still nothing recorded one millisecond short of the bound');
  stalled.app.advance(1);
  await settle();
  const rec = timeouts(stalled.app);
  assert.equal(rec.length, 1, 'the timeout is recorded exactly once');
  assert.equal(rec[0].props.new, 2, 'and carries how many posts were in flight, so a large-backlog timeout is distinguishable');

  // A classify that ANSWERS must record nothing — otherwise the counter measures attempts, not failures.
  const ok = bootGated({ grouped: true, reply: [AI_NEWS] });
  ok.app.ctx.wireApp();
  render(ok.app, [xPost('x1'), xPost('x2')]);
  await settle();
  ok.release();
  await settle();
  ok.app.advance(BOUND * 2);
  await settle();
  assert.equal(timeouts(ok.app).length, 0, 'a classify that answered is never counted as a timeout');

  // …and neither is a classify that FAILED for some other reason. This is the half that pins
  // `ctrl.signal.aborted`: a success never enters the catch at all, so it cannot tell a guarded
  // marker from an unguarded one. Only a non-abort failure can, and without it `if (true)` survives.
  const broken = bootStalled({ grouped: true });
  broken.app.setFetch(async (url) => {
    if (String(url).includes('/api/group')) throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({}) };
  });
  broken.app.ctx.wireApp();
  render(broken.app, [xPost('x1'), xPost('x2')]);
  await settle();
  assert.equal(busyHidden(broken.app), true, 'guard: the failed classify resolved on its own, with no abort involved');
  assert.equal(timeouts(broken.app).length, 0,
    'a plain network failure is not a timeout — otherwise the counter measures failures in general '
    + 'and says nothing about whether the bound is right');
});
