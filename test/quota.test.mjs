// Per-user X quota helpers — the pure half.
//
// The day boundary is the piece most likely to be green while measuring the wrong quantity: X
// deduplicates a post's billing "within a day", so a counter keyed to any other clock counts a
// different thing from the one we are charged for. Criterion 13 is Q2/Q3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcDay, readQuotaLimit, quotaExceeded } from '../api/_quota.js';

// 2026-08-31T23:59:59.999Z and one millisecond later — the UTC midnight boundary. Deliberately a
// PAST boundary: docs.test.mjs fails the suite on any future date in test/, and a fixture straddling
// tomorrow would trip it.
const BEFORE_MIDNIGHT = Date.UTC(2026, 7, 31, 23, 59, 59, 999);
const AFTER_MIDNIGHT = BEFORE_MIDNIGHT + 1;

test('Q1 utcDay renders the UTC calendar day as YYYY-MM-DD', () => {
  assert.equal(utcDay(Date.UTC(2026, 8, 1, 12, 0, 0)), '2026-09-01');
});

test('Q2 utcDay puts either side of UTC midnight in different days', () => {
  assert.equal(utcDay(BEFORE_MIDNIGHT), '2026-08-31');
  assert.equal(utcDay(AFTER_MIDNIGHT), '2026-09-01');
});

test('Q3 utcDay follows UTC, not the machine timezone', () => {
  // 00:30 UTC on the 1st is still 31 August in every timezone west of UTC. A helper built on local
  // date parts would answer '2026-08-31' on such a machine and pass a naive test.
  assert.equal(utcDay(Date.UTC(2026, 8, 1, 0, 30, 0)), '2026-09-01');
});

test('Q4 readQuotaLimit: an unset var means enforcement is OFF, not zero', () => {
  assert.equal(readQuotaLimit({}), null);
});

test('Q5 readQuotaLimit: a positive integer enables enforcement at that number', () => {
  assert.equal(readQuotaLimit({ X_DAILY_POST_QUOTA: '400' }), 400);
});

test('Q6 readQuotaLimit: any non-positive or malformed value degrades to OFF, never to blocking', () => {
  // Fail-safe direction matters more than strictness here. A typo must leave everyone counted and
  // served; it must never be the thing that refuses every user's feed.
  for (const bad of ['', '0', '-5', 'abc', '4.5', ' ', 'NaN']) {
    assert.equal(readQuotaLimit({ X_DAILY_POST_QUOTA: bad }), null, `"${bad}" must disable, not block`);
  }
});

test('Q7 quotaExceeded: with no limit configured nothing is ever over quota', () => {
  assert.equal(quotaExceeded(0, null), false);
  assert.equal(quotaExceeded(10_000_000, null), false);
});

test('Q8 quotaExceeded: below the limit is not exceeded', () => {
  assert.equal(quotaExceeded(399, 400), false);
});

test('Q9 quotaExceeded: AT the limit is exceeded — the next fetch would carry it past N', () => {
  assert.equal(quotaExceeded(400, 400), true);
  assert.equal(quotaExceeded(401, 400), true);
});

test('Q10 quotaExceeded: an unreadable count fails OPEN, it does not lock the feed', () => {
  // The count comes from a DB read that can blip. Criterion 12: a counting failure must serve the
  // feed, never refuse it.
  for (const bad of [null, undefined, NaN, 'lots']) {
    assert.equal(quotaExceeded(bad, 400), false, `${String(bad)} must not refuse the feed`);
  }
});

// ── The fuse as the ADMIN PANEL must describe it ───────────────────
//
// readQuotaLimit answers "what does the code ENFORCE" and collapses every non-value into one null.
// That is right for enforcement and useless for diagnosis: "you never set it", "you typed it wrong"
// and "you turned it off on purpose" need three different responses from a human, and today the
// panel cannot tell a reader which of them happened. These pin the distinction.
//
// FOUR states, not three. '0' is a DELIBERATE off switch — the code
// comment at readQuotaLimit says so explicitly — and reporting it as "set but unreadable" would send
// someone hunting a typo that does not exist. An instrument that invents a fault is the failure this
// panel exists to prevent.
import { fuseStatus } from '../api/_quota.js';

const F = (v) => fuseStatus(v === undefined ? {} : { X_DAILY_POST_QUOTA: v });

test('Q11 a positive integer reads as ON, carrying the number the code enforces', () => {
  assert.deepEqual(F('800'), { state: 'on', limit: 800 });
  assert.deepEqual(F(' 800 '), { state: 'on', limit: 800 }, 'surrounding whitespace is trimmed, as readQuotaLimit already allows');
});

test('Q12 never set at all reads as UNSET, not as a mistake', () => {
  assert.deepEqual(F(undefined), { state: 'unset', limit: null });
  assert.deepEqual(fuseStatus(undefined), { state: 'unset', limit: null }, 'a missing env object must not throw');
  assert.deepEqual(fuseStatus(null), { state: 'unset', limit: null });
});

test('Q13 present but empty or whitespace reads as UNSET — there is nothing to have typed wrong', () => {
  assert.deepEqual(F(''), { state: 'unset', limit: null });
  assert.deepEqual(F('   '), { state: 'unset', limit: null });
});

test('Q14 a malformed value reads as UNREADABLE — this is the state that says "typo"', () => {
  for (const bad of ['abc', '-5', '4.5', '8 00', 'NaN', '800posts']) {
    assert.equal(F(bad).state, 'unreadable', `${JSON.stringify(bad)} must read as a typo, not as unset`);
    assert.equal(F(bad).limit, null);
  }
});

test('Q15 a QUOTED number is unreadable — the exact slip that costs a silent fuse', () => {
  // Typing "800" with the quote characters into the Vercel field is the realistic mistake: it looks
  // right in the box, parses to null, and disables enforcement without a word anywhere.
  assert.equal(F('"800"').state, 'unreadable');
});

test('Q16 zero reads as DISABLED, distinct from both unset and unreadable', () => {
  // readQuotaLimit treats '0' as "disable rather than block everybody" ON PURPOSE. Folding it into
  // unreadable would report a fault where a deliberate choice was made.
  assert.deepEqual(F('0'), { state: 'disabled', limit: 0 });
});

test('Q17 fuseStatus and readQuotaLimit never disagree about whether the fuse is armed', () => {
  // The panel must describe the code that actually runs. If these two ever diverge, the panel is
  // lying about enforcement — the precise failure this panel exists to prevent.
  for (const v of ['800', '1', '0', '', '   ', 'abc', '-5', '4.5', '"800"', undefined]) {
    const env = v === undefined ? {} : { X_DAILY_POST_QUOTA: v };
    const armed = readQuotaLimit(env) != null;
    assert.equal(fuseStatus(env).state === 'on', armed,
      `${JSON.stringify(v)}: panel says ${fuseStatus(env).state}, enforcement says ${armed ? 'armed' : 'off'}`);
  }
});
