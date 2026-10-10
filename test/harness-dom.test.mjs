// THE INSTRUMENT ITSELF.
//
// `liftGroupedFromStream` reads `document.querySelectorAll('#feed .card')` and detaches with
// `card.remove()`. A harness that answers that selector with a hardcoded `[]` and
// whose `remove()` is `remove() {}` makes the function that yanks a card from under the reader
// unobservable.
//
// Every test here reds when the harness
// capability it names is reverted, verified by mutation, not assumed.
//
// Assert on DERIVED answers, never on hardcoded ones. `.chip` returning `[]` is only meaningful once
// `.card` returns cards through the same code path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';

const PUBLISHED = 1754000000000;
const xPost = (id = 'x1') => ({
  id, source: 'twitter', text: 'Senate advances the spending bill', published: PUBLISHED,
  channel: { id: 'c1', name: 'X acct', handle: 'xacct', source: 'twitter' },
});

// GROUPED VIEW SEEDED. Ungrouped is now the DEFAULT: every post renders into the
// chronological stream and an assigned one is merely HIDDEN, so a fixture with no view key exercises
// the plain feed — where tiles, the lift and the classify hold do not exist at all. The seed states a PRECONDITION and is load-bearing
// rather than inert — stripping it from the six seeded files reds 37 tests. This file's own
// subject is the INSTRUMENT (the selector model, `remove()`, `children`), not the grouped view;
// what the seed buys is that its cases reach the code they are about. No assertion here was altered.
function boot(store = {}) {
  const app = createApp({ store: { focus_group_view: 'on', ...store } });
  app.setFetch(async (url) => {
    if (String(url).includes('/api/group')) return { ok: true, status: 200, json: async () => ({ groups: null }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return app;
}
const render = (app, items, failed = []) =>
  app.ctx.renderFeedResults({ items, failed, cappedNames: [], totalChannels: items.length + failed.length });

// ── The selector model answers from the tree ───────────────────────────────────

test('harness: document.querySelectorAll("#feed .card") answers from the rendered tree, not []', () => {
  const app = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  assert.equal(app.el('feed').children.length, 2, 'two cards were appended');
  assert.equal(app.queryAll('#feed .card').length, 2,
    'and the document-level selector the app actually uses finds both');
});

test('harness: a class set via className and one via classList share ONE set', () => {
  const app = boot();
  render(app, [xPost('x1')]);
  // `.card` arrives as `div.className = 'card'` (`renderTweetCard`); the hold as classList.add. A selector
  // needing both only matches if the two write to the same place.
  assert.equal(app.queryAll('#feed .card.grouping-pending').length, 1,
    'a first-pass X card matches a selector spanning both write paths');
  const card = app.el('feed').children[0];
  assert.equal(card.classList.contains('card'), true, 'classList sees what className wrote');
  assert.ok(card.className.includes('grouping-pending'), 'className sees what classList wrote');
});

test('harness: :not() actually excludes', () => {
  const app = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  app.el('feed').children[0].classList.add('removing');
  assert.equal(app.queryAll('#feed .card:not(.removing)').length, 1,
    'the card marked .removing drops out of the selector updateCount uses');
});

test('harness: an attribute selector matches on dataset, which is where cards carry their id', () => {
  const app = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  // markGroupDone reaches one card through `#feed .card[data-id="…"]` (`markGroupDone`). renderTweetCard
  // assigns `div.dataset.id` directly and never calls setAttribute, so an attrs-only lookup answers
  // null for every card the feed renders.
  const hit = app.queryAll('#feed .card[data-id="x2"]');
  assert.equal(hit.length, 1, 'exactly the addressed card');
  assert.equal(hit[0].dataset.id, 'x2', 'and it is the right one');
  assert.equal(app.queryAll('#feed .card[data-id="nope"]').length, 0, 'a miss is a miss');
});

test('harness: an absent class answers [] by derivation, through the same code path', () => {
  const app = boot();
  render(app, [xPost('x1')]);
  assert.equal(app.queryAll('.chip').length, 0, 'nothing in the tree carries .chip');
  assert.equal(app.queryAll('.card').length, 1, '…and the same walk still finds the card');
});

test('harness: a selector the model cannot express THROWS rather than answering []', () => {
  const app = boot();
  // Same property test-helpers/handler.mjs has for unrecognised SQL: a query this cannot model must
  // fail loudly. A silent [] is what makes a wrongly removed card invisible.
  assert.throws(() => app.queryAll('div.card'), /unsupported selector part/,
    'a tag selector is not modelled and says so');
  assert.throws(() => app.queryAll('.card .inner'), /needs an #id root/,
    'a document-level descendant chain with no id root says so');
});

test('harness: ELEMENT-scoped querySelectorAll works, and the "Posts" heading depends on it', () => {
  // Added after mutation M2 SURVIVED. Every other test in this file reaches the matcher through
  // `document.querySelectorAll`, so reverting the element-scoped method to `() => []` was invisible —
  // a pinning file that failed to pin the very method `updateSectionHeads` reads.
  // The observable is the heading, not the call: with `() => []` the "Posts" header was
  // PERMANENTLY hidden in every harness test, and nothing could ask.
  const held = boot();
  render(held, [xPost('x1')]);
  assert.equal(held.el('feed').querySelectorAll('.card:not(.removing):not(.grouping-pending)').length, 0,
    'a first-pass X card is held, so it does not count as shown content');
  assert.equal(held.el('videos-head').classList.contains('hidden'), true,
    'and the Posts heading stays hidden above an empty-looking stream');

  const shown = boot();
  render(shown, [{
    id: 'https://foo.substack.com/p/a-post', source: 'substack', title: 'A long read',
    subtitle: 'a subtitle', preview: 'the first paragraph', url: 'https://foo.substack.com/p/a-post',
    author: 'An author', published: PUBLISHED,
    channel: { id: 'c2', name: 'Publication', source: 'substack' },
  }]);
  assert.equal(shown.el('feed').querySelectorAll('.card:not(.removing):not(.grouping-pending)').length, 1,
    'a Substack card is never held ([TASK-094]), so it counts immediately');
  assert.equal(shown.el('videos-head').classList.contains('hidden'), false,
    'and the Posts heading appears — the half that was unobservable');
});

test('harness: the descendant walk is RECURSIVE — two levels deep is found', () => {
  // The tree really is two levels deep:
  // createChipsInput(host, {}) builds #keyword-chips > .chips-input > .chips-text through
  // plain appendChild.
  const app = boot();
  const host = app.el('keyword-chips');
  const field = app.ctx.document.createElement('div');
  field.className = 'chips-input';
  const inner = app.ctx.document.createElement('span');
  inner.className = 'chips-text';
  host.appendChild(field);
  field.appendChild(inner);

  assert.equal(app.queryAll('#keyword-chips .chips-text').length, 1,
    'a grandchild is reachable through an #id root');
  assert.equal(app.queryAll('.chips-text').length, 1, 'and through a bare-class document query');
  assert.equal(inner.parentElement, field, 'and it knows its real parent, not the root');
});

test('harness: document.querySelector is REAL for #id roots and a phantom only for bare classes', () => {
  // The harness-side assertion for the split: stub it back and this test reds.
  const app = boot();
  render(app, [xPost('x1')]);
  const doc = app.ctx.document;

  const hit = doc.querySelector('#feed .card[data-id="x1"]');
  assert.equal(hit, app.el('feed').children[0], 'an #id-rooted hit is the REAL node, not a lookalike');
  assert.equal(doc.querySelector('#feed .card[data-id="nope"]'), null,
    'and a miss is null, exactly as a browser — this is what lets production null-check');

  // Bare-class stays a phantom on purpose (production dereferences .appbar without a null check),
  // but it must at least be STABLE, or a handler assigned in one statement is unreachable in the next.
  assert.equal(doc.querySelector('.appbar'), doc.querySelector('.appbar'),
    'the bare-class phantom is memoised, not freshly minted per call');
});

// ── remove() detaches ─────────────────────────────────────────────────────────

test('harness: remove() detaches the node from its parent', () => {
  const app = boot();
  render(app, [xPost('x1'), xPost('x2')]);
  const card = app.el('feed').children.find(c => c.dataset.id === 'x1');
  card.remove();
  assert.equal(app.el('feed').children.length, 1, 'the parent no longer holds it');
  assert.equal(app.el('feed').children[0].dataset.id, 'x2', 'and the survivor is the other card');
  assert.equal(app.queryAll('#feed .card').length, 1, 'the selector agrees');
  assert.equal(card.parentElement, null, 'and the detached node knows it has no parent');
});

test('harness: parentElement is the element that appended the node', () => {
  const app = boot();
  render(app, [xPost('x1')]);
  const card = app.el('feed').children[0];
  assert.equal(card.parentElement, app.el('feed'),
    '`toggleGroupCard` reaches sibling tiles through this');
});

test('harness: innerHTML detaches its children, so a later remove() cannot splice a stale parent', () => {
  const app = boot();
  render(app, [xPost('x1')]);
  const card = app.el('feed').children[0];
  app.el('feed').innerHTML = '';
  assert.equal(app.el('feed').children.length, 0, 'the reset emptied the parent');
  assert.equal(card.parentElement, null, 'and the orphan is not still pointing at it');
  card.remove(); // must be a harmless no-op, not a splice of something else
  assert.equal(app.el('feed').children.length, 0, 'removing an orphan changes nothing');
});

test('harness: insertBefore places the node at the reference index', () => {
  const app = boot();
  render(app, [xPost('x1')]);
  const feed = app.el('feed');
  const first = feed.children[0];
  const fresh = app.ctx.renderItemCard(xPost('x0'), 'feed');
  feed.insertBefore(fresh, first);
  assert.deepEqual(feed.children.map(c => c.dataset.id), ['x0', 'x1'],
    'the method places at the reference index');
  // Said plainly: this calls insertBefore DIRECTLY. `insertIntoFeed` reaches it only with an
  // ISO-string `published` — with the numeric epoch these fixtures use, Date.parse is NaN and it
  // appends instead. Claiming this test covers insertIntoFeed would be false.
});

// ── The seed the whole sign-out warning proof rests on ──────────────────────────────────────────
//
// A fresh stub starts with an EMPTY class set, so "the confirm was revealed" passes whether or not
// the code ever revealed it. `acct-signout-confirm` ships as `class="acct-confirm hidden"` in
// app/index.html and is seeded into HIDDEN_IDS to match. Without that one line, deleting the
// ENTIRE sign-out warning branch goes GREEN: the proof that a destructive confirm is ever shown
// rests on this harness line.
test('the two account confirms start HIDDEN, as app/index.html ships them', async () => {
  const app = createApp();
  for (const id of ['acct-delete-confirm', 'acct-signout-confirm']) {
    assert.ok(app.el(id).classList.contains('hidden'),
      `#${id} must start hidden, or "it was revealed" is true before anything runs`);
  }
});

test('revealing a confirm is therefore a DERIVED answer, not a hardcoded one', async () => {
  // The control: the assertion above is only worth something if the same query can also say "shown".
  const app = createApp();
  app.el('acct-signout-confirm').classList.remove('hidden');
  assert.equal(app.el('acct-signout-confirm').classList.contains('hidden'), false);
});

// ─── The page-close listeners ────────────────────────────────────────
//
// A `window.addEventListener` or `document.addEventListener` that is `() => {}`
// is the same shape of hole as the `[]` above: `window.addEventListener('pagehide', flushPush)`
// and the `visibilitychange` line beside it would be unreachable, so no test could close the tab the way
// a browser does, and deleting either line would go unnoticed. These pin the INSTRUMENT; what the flush then does is pinned in
// test/require-account-r2.test.mjs.

test('harness: window listeners are RECORDED, so app.js wiring pagehide is visible at all', () => {
  const app = createApp();
  const types = app.winListeners.map(l => l.type);
  assert.ok(types.includes('pagehide'),
    `app.js must wire a pagehide listener the harness can see; window listeners were [${types}]`);
});

test('harness: document listeners are RECORDED, so the visibilitychange wiring is visible', () => {
  const app = createApp();
  const types = app.docListeners.map(l => l.type);
  assert.ok(types.includes('visibilitychange'),
    `app.js must wire a visibilitychange listener the harness can see; document listeners were [${types}]`);
});

test('harness: fireWindow RUNS the listeners and reports how many ran', () => {
  // Derived, like every other assertion here: register through the same `window.addEventListener`
  // app.js uses, then fire. A count of 0 and a handler that did nothing look identical otherwise —
  // the distinction `app.click` exists for.
  const app = createApp();
  let ran = 0;
  app.ctx.window.addEventListener('pagehide', () => { ran++; });
  const fired = app.fireWindow('pagehide');
  assert.equal(ran, 1, 'the listener must actually run');
  assert.ok(fired >= 1, 'fireWindow must report the listeners it ran');
  assert.equal(app.fireWindow('no-such-event'), 0, 'and report 0 for a type nothing listens for');
});

test('harness: fireDocument RUNS the listeners, and the event carries its type', () => {
  const app = createApp();
  const seen = [];
  app.ctx.document.addEventListener('visibilitychange', (e) => { seen.push(e && e.type); });
  app.fireDocument('visibilitychange');
  assert.deepEqual(seen, ['visibilitychange']);
});

test('harness: removeEventListener DETACHES, rather than being a no-op', () => {
  // `_profileEsc` is added and removed by reference. A no-op removal would leave a test firing into
  // a handler the browser had already dropped — an instrument that reports listeners a page no
  // longer has.
  const app = createApp();
  let ran = 0;
  const fn = () => { ran++; };
  app.ctx.document.addEventListener('keydown', fn);
  assert.equal(app.fireDocument('keydown'), 1);
  app.ctx.document.removeEventListener('keydown', fn);
  assert.equal(app.fireDocument('keydown'), 0, 'the removed listener must not run');
  assert.equal(ran, 1);
});

test('harness: removeEventListener DETACHES on WINDOW too, not only on document', () => {
  // The other half of the pair: the document side is pinned by the test
  // above, the window side here. Nothing in app.js removes a window listener today, so this
  // pins a capability rather than a behaviour — which is what this file is for.
  const app = createApp();
  let ran = 0;
  const fn = () => { ran++; };
  app.ctx.window.addEventListener('pagehide', fn);
  const before = app.fireWindow('pagehide');
  app.ctx.window.removeEventListener('pagehide', fn);
  assert.equal(app.fireWindow('pagehide'), before - 1, 'the removed listener must not run');
  assert.equal(ran, 1);
});

test('harness: document.visibilityState is settable, and starts "visible"', () => {
  const app = createApp();
  assert.equal(app.ctx.document.visibilityState, 'visible');
  app.setVisibility('hidden');
  assert.equal(app.ctx.document.visibilityState, 'hidden');
});

test('[TASK-092] harness: document.activeElement follows focus() and blur(), and starts at body', () => {
  // Where focus RETURNS when the tour ends needs a record of what was focused
  // before it began. A `focus()` that only sets a flag cannot answer that.
  // Both elements the tour moves between are exercised: one reached by id, one built by createElement.
  const app = createApp();
  const doc = app.ctx.document;
  assert.equal(doc.activeElement, doc.body, 'nothing focused yet reads as body, as in a browser');
  const byId = doc.getElementById('tour-main');
  byId.focus();
  assert.equal(doc.activeElement, byId, 'focusing an id-memoised element moves activeElement to it');
  const made = doc.createElement('button');
  made.focus();
  assert.equal(doc.activeElement, made, 'and so does focusing a created one');
  byId.blur();
  assert.equal(doc.activeElement, made, 'blurring an element that is NOT focused changes nothing');
  made.blur();
  assert.equal(doc.activeElement, doc.body, 'blurring the focused element returns focus to body');
});
