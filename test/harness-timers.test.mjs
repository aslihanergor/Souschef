// The harness's DELAY-AWARE timer driver — `advance(ms)`.
//
// WHY THIS EXISTS. `runTimers(n)` fires every pending timer whatever its `ms`, so nothing built on
// it can tell an 8s bound from a 0s one, and calling it before a short operation completes
// MANUFACTURES a timeout. A driver that models delay was built once during [BUG-047] round 6, was
// cut with the change that needed it, and its only copy — an uncommitted file in a review worktree —
// was destroyed on 2026-08-27. This is the re-derivation.
//
// It is a SECOND driver, not a replacement: 38 call sites across six files depend on runTimers'
// fire-everything semantics, and quietly changing those would be a silent rewrite of what they pin.
//
// ONE HONEST LIMIT, stated because a virtual clock invites the assumption it is total: this moves
// the TIMER QUEUE's clock only. `Date` is the real one inside the vm, so code that compares
// `Date.now()` against a stored timestamp does not advance with it. Timeouts expressed as
// `setTimeout(fn, ms)` are driveable; deadlines expressed as `Date.now() - started > ms` are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';

const fresh = () => createApp({ store: {} });

test('harness advance: a timer due later than the window does NOT fire', () => {
  const app = fresh();
  const fired = [];
  app.ctx.setTimeout(() => fired.push('at8s'), 8000);

  app.advance(1000);
  assert.deepEqual(fired, [],
    'this is the whole point: runTimers cannot tell 8s from 0s, so a test built on it manufactures '
    + 'the timeout it claims to observe');
});

test('harness advance: a timer fires once the clock reaches its delay', () => {
  const app = fresh();
  const fired = [];
  app.ctx.setTimeout(() => fired.push('at8s'), 8000);

  app.advance(7999);
  assert.deepEqual(fired, [], 'guard: still short by 1ms, or the boundary below proves nothing');
  app.advance(1);
  assert.deepEqual(fired, ['at8s'], 'due exactly at the boundary counts as due');
});

test('harness advance: timers fire in DUE order, not insertion order', () => {
  const app = fresh();
  const order = [];
  app.ctx.setTimeout(() => order.push('slow'), 500);
  app.ctx.setTimeout(() => order.push('fast'), 10);

  app.advance(1000);
  assert.deepEqual(order, ['fast', 'slow'],
    'insertion order would give slow,fast — a driver that fires in the wrong order can make a race '
    + 'resolve the way the test wanted rather than the way production would');
});

test('harness advance: a timer armed DURING the advance still fires if it comes due inside it', () => {
  const app = fresh();
  const order = [];
  app.ctx.setTimeout(() => { order.push('first'); app.ctx.setTimeout(() => order.push('second'), 100); }, 100);

  app.advance(1000);
  assert.deepEqual(order, ['first', 'second'],
    'a re-arming timer (schedulePush debouncing itself) must be reachable, or the driver cannot '
    + 'drive the very pattern it exists for');
});

test('harness advance: a timer armed during the advance that is due AFTER it does not fire', () => {
  const app = fresh();
  const order = [];
  app.ctx.setTimeout(() => { order.push('first'); app.ctx.setTimeout(() => order.push('late'), 5000); }, 100);

  app.advance(1000);
  assert.deepEqual(order, ['first'], 'the window is a bound, not a suggestion');
});

test('harness advance: a cancelled timer never fires', () => {
  const app = fresh();
  const fired = [];
  const id = app.ctx.setTimeout(() => fired.push('cancelled'), 100);
  app.ctx.clearTimeout(id);

  app.advance(1000);
  assert.deepEqual(fired, [],
    'CLAUDE.md records clearTimeout as unobservable in this harness — making it a no-op survived the '
    + 'whole suite. This is the assertion that ends that: it fails if cancellation stops working');
});

test('harness advance: reports how many timers it fired', () => {
  const app = fresh();
  app.ctx.setTimeout(() => {}, 10);
  app.ctx.setTimeout(() => {}, 20);
  app.ctx.setTimeout(() => {}, 9000);

  assert.equal(app.advance(1000), 2, 'a driver that silently fires nothing looks identical to one that had nothing to fire');
  assert.equal(app.advance(0), 0, 'and advancing past them again must not re-fire them');
});

test('harness runTimers is UNCHANGED: it still ignores delay', () => {
  // Not a wish — a compatibility pin. 38 call sites across six files depend on this exact
  // semantics, and `advance` was added beside it precisely so they keep meaning what they meant.
  const app = fresh();
  const fired = [];
  app.ctx.setTimeout(() => fired.push('at9s'), 9000);

  app.runTimers(4);
  assert.deepEqual(fired, ['at9s'], 'runTimers fires everything regardless of ms — that is its documented blind spot');
});

test('harness advance: nested delays COMPOUND from the due time, not from zero', () => {
  // The discriminator for the clock moving WHILE a callback runs. The inner timer is armed at 100ms
  // and asks for 950 more, so it is due at 1050 — outside a 1000ms window. If the clock did not read
  // 100 during the callback the inner one would be stamped 950, land inside the window, and fire.
  // Without this test that line can be deleted and every other assertion here still passes.
  const app = fresh();
  const order = [];
  app.ctx.setTimeout(() => { order.push('outer'); app.ctx.setTimeout(() => order.push('inner'), 950); }, 100);

  assert.equal(app.advance(1000), 1, 'only the outer one is due inside the window');
  assert.deepEqual(order, ['outer'], 'the inner one is due at 1050, which this window does not reach');
  app.advance(50);
  assert.deepEqual(order, ['outer', 'inner'], 'and it fires once the clock actually gets there');
});
