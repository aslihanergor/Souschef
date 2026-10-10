// A topic keeps bullets for posts you have already read.
//
// A summary is a flat array of sentences with no record of which post each describes, so nothing
// knows what to remove when a post is read. Seen on a handset: "1 post" above 8
// bullets, none about the post that was left.
//
// The fix types a bullet as `string | {text, item_ids}` — ids on the bullet, normalised on read,
// serialised back to a bare STRING when it carries no ids. That last half is what keeps the change
// additive: every fake model reply in the existing grouping suite uses id-less string bullets, so
// they must round-trip byte-identically.
//
// Everything here asserts on OBSERVABLE OUTPUT — the tile's rendered HTML, the stored state, the
// request body that actually goes out, the value groupItems returns. Nothing imports a helper by
// name: a missing named export is a link-time SyntaxError that takes the whole FILE down, and a
// file-level crash is not the same as N named failing tests.
//
// These tests can only bite because test-helpers/app-harness.mjs seeds the elements
// app/index.html ships hidden. Without that seed renderGroupGrid returns early on every call and
// paints nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';
import { validatePartition, groupItems, buildGroupRequest, mergeSameLabel,
         MAX_TOPIC_BULLETS } from '../api/_group.js';

// ── reading a tile ───────────────────────────────────────────────────────────
// renderGroupGrid builds each tile with createElement + innerHTML, so the harness holds the card's
// markup on `grid.children[n]`. `grid.innerHTML` itself is '' — assigning it is what CLEARS children
// in the harness's model — so read the children, never the grid's own html.
// A topic is a `.topic-card` in the stream, not a `.group-card` tile in a
// `#group-grid` above it. The assertions below are unchanged — only where they look. The READERS got
// stronger in the move: the old tile was one `innerHTML` blob, so its count and bullets could only be
// scraped by regex over an unparsed string; the new card is appended nodes, so these are real queries.
const tileOf = (app, n = 0) => app.queryAll('#feed .topic-card')[n];
// `.tc-bullets li` would be a TAG selector, which the harness refuses on purpose — read the list's
// own children instead.
const bulletsOn = card => [...(card.querySelectorAll('.tc-bullets')[0]?.children || [])].map(li => li.textContent);
const countOn = card => card?.querySelectorAll('.tc-count')[0]?.textContent;

// GROUPED VIEW SEEDED. Ungrouped is now the DEFAULT: every post renders into the
// chronological stream and an assigned one is merely HIDDEN, so a fixture with no view key exercises
// the plain feed — where tiles, the lift and the classify hold do not exist at all. This file's
// subject is what happens INSIDE the grouped view, which is unchanged, so only the precondition had
// to be stated. No assertion in this file was altered.
const boot = (groups, { done = [], archive = [] } = {}) => createApp({
  store: {
    focus_group_view: 'on',
    focus_groups: JSON.stringify(groups),
    focus_done: JSON.stringify(done),
    focus_archive: JSON.stringify(archive.map(id => ({ id }))),
  },
});

// ── 1. the reported defect, inverted ─────────────────────────────────────────

test('BUG-089: a topic with 2 of 3 posts read shows only the remaining post\'s bullet', () => {
  const app = boot({
    assignments: { p1: 'g_t', p2: 'g_t', p3: 'g_t' },
    groups: { g_t: { label: 'T', summary: [
      { text: 'about p1', item_ids: ['p1'] },
      { text: 'about p2', item_ids: ['p2'] },
      { text: 'about p3', item_ids: ['p3'] },
    ] } },
    updatedAt: 1753000000000,
  }, { done: ['p1', 'p2'] });

  app.ctx.renderTopicCards();
  const card = tileOf(app);
  assert.equal(countOn(card), '1 post', 'the count was always right');
  assert.deepEqual(bulletsOn(card), ['about p3'], 'and the bullets now agree with it');
});

// The reported shape: the count is right and the bullets are for posts already read.
test('BUG-089: the reported 1-post-8-bullet tile is not reachable', () => {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
  const app = boot({
    assignments: Object.fromEntries(ids.map(id => [id, 'g_t'])),
    groups: { g_t: { label: 'Specialized AI Products & Applications',
      summary: ids.map(id => ({ text: `about ${id}`, item_ids: [id] })) } },
    updatedAt: 1753000000000,
  }, { done: ids.slice(0, 8) });

  app.ctx.renderTopicCards();
  const card = tileOf(app);
  assert.equal(countOn(card), '1 post');
  assert.equal(bulletsOn(card).length, 1, 'one post left means one bullet, not eight');
});

// ── 2. a bullet describing more than one post ────────────────────────────────

test('BUG-089: a bullet naming two posts survives while EITHER is unread', () => {
  const state = () => ({
    assignments: { p1: 'g_t', p2: 'g_t', p3: 'g_t' },
    groups: { g_t: { label: 'T', summary: [
      { text: 'p1 and p2 together', item_ids: ['p1', 'p2'] },
      { text: 'about p3', item_ids: ['p3'] },
    ] } },
    updatedAt: 1753000000000,
  });

  const half = boot(state(), { done: ['p1'] });
  half.ctx.renderTopicCards();
  assert.deepEqual(bulletsOn(tileOf(half)), ['p1 and p2 together', 'about p3'],
    'p2 is still unread, so the shared bullet stays');

  const both = boot(state(), { done: ['p1', 'p2'] });
  both.ctx.renderTopicCards();
  assert.deepEqual(bulletsOn(tileOf(both)), ['about p3'],
    'only once BOTH its posts are read does it go');
});

test('BUG-089: an archived post counts as read for its bullet', () => {
  const app = boot({
    assignments: { p1: 'g_t', p2: 'g_t' },
    groups: { g_t: { label: 'T', summary: [
      { text: 'about p1', item_ids: ['p1'] },
      { text: 'about p2', item_ids: ['p2'] },
    ] } },
    updatedAt: 1753000000000,
  }, { archive: ['p1'] });

  app.ctx.renderTopicCards();
  assert.deepEqual(bulletsOn(tileOf(app)), ['about p2']);
});

// ── 3. the safe default: no ids means never pruned ───────────────────────────
// Deliberately DISCRIMINATING. Asserting only "the legacy bullet survives" would pass without the fix too —
// summaryHtml already drops non-strings, so it would render exactly ['legacy'] — a test green for the
// wrong reason. The linked bullet for the LIVE post is what makes it bite.
test('BUG-089: a bullet carrying no ids is never hidden, whatever is read', () => {
  const app = boot({
    assignments: { p1: 'g_t', p2: 'g_t' },
    groups: { g_t: { label: 'T', summary: [
      'a legacy bullet with no ids',
      { text: 'about p1', item_ids: ['p1'] },
      { text: 'about p2', item_ids: ['p2'] },
    ] } },
    updatedAt: 1753000000000,
  }, { done: ['p1'] });

  app.ctx.renderTopicCards();
  assert.deepEqual(bulletsOn(tileOf(app)), ['a legacy bullet with no ids', 'about p2'],
    'the unlinked bullet stays and the read post\'s bullet goes');
});

// A bullet naming only UNKNOWN posts must NOT stay visible, whatever a general "safe default"
// instinct suggests:
// an id outside the unread set means the post was read, or has left the app entirely, and in
// both cases a bullet about it is stale.
//
// The safe-default rule is real but narrower: NO ids means keep (test above), and
// nothing here DELETES. Hiding is a render-time filter over untouched state, so the bullet returns
// the moment its post does — an Undo on Mark-done, a re-added channel. The dangerous direction is
// guarded by 'pruneGroupState never collects an id-less bullet' and by the second assertion below.
test('BUG-089: a bullet naming only posts outside the unread set is hidden, not deleted', () => {
  const app = boot({
    assignments: { p1: 'g_t' },
    groups: { g_t: { label: 'T', summary: [
      { text: 'about a post nobody has heard of', item_ids: ['ghost'] },
      { text: 'about p1', item_ids: ['p1'] },
    ] } },
    updatedAt: 1753000000000,
  });

  app.ctx.renderTopicCards();
  assert.deepEqual(bulletsOn(tileOf(app)), ['about p1'], 'the unresolvable bullet is not shown');
  assert.equal(JSON.parse(app.get('focus_groups')).groups.g_t.summary.length, 2,
    'and it is still in the cache — the render filter hides, it never destroys');
});

// ── 4. pruneGroupState garbage-collects a dead bullet ────────────────────────

// p1 is proved gone by being READ, not by being missing from the set passed in. Absence is not
// evidence — the second argument does not decide whether an assignment survives — so the
// fixture states the premise the way the code accepts it.
test('BUG-089: pruneGroupState drops a bullet once every post it names has gone', () => {
  const app = boot({ assignments: {}, groups: {}, updatedAt: 0 }, { done: ['p1'] });
  const state = {
    assignments: { p1: 'g_t', p2: 'g_t' },
    groups: { g_t: { label: 'T', summary: [
      { text: 'about p1', item_ids: ['p1'] },
      { text: 'about p2', item_ids: ['p2'] },
    ] } },
    updatedAt: 0,
  };

  const changed = app.ctx.pruneGroupState(state, new Set(['p2']));
  assert.equal(changed, true, 'it reports the change');
  assert.deepEqual(Object.keys(state.assignments), ['p2']);
  assert.equal(state.groups.g_t.summary.length, 1, 'p1\'s bullet was collected');
  assert.equal(state.groups.g_t.summary[0].text, 'about p2');
});

// Absence does not remove p1's assignment, so the fixture marks p1 `done`: otherwise BOTH ids
// stay assigned and the bullet survives because EVERY post is live — not because at least one is —
// and `ids.some` → `ids.every` would pass.
test('BUG-089: pruneGroupState keeps a bullet with at least one live post', () => {
  const app = boot({ assignments: {}, groups: {}, updatedAt: 0 }, { done: ['p1'] });
  const state = {
    assignments: { p1: 'g_t', p2: 'g_t' },
    groups: { g_t: { label: 'T', summary: [{ text: 'p1 and p2', item_ids: ['p1', 'p2'] }] } },
    updatedAt: 0,
  };

  app.ctx.pruneGroupState(state, new Set(['p2']));
  assert.equal(state.groups.g_t.summary.length, 1, 'p2 keeps it alive');
  assert.deepEqual(state.groups.g_t.summary[0].item_ids, ['p1', 'p2'],
    'and its ids are not rewritten — GC is not the render filter');
});

test('BUG-089: pruneGroupState never collects an id-less bullet', () => {
  const app = boot({ assignments: {}, groups: {}, updatedAt: 0 });
  const state = {
    assignments: { p1: 'g_t' },
    groups: { g_t: { label: 'T', summary: ['unlinked', { text: 'about p1', item_ids: ['p1'] }] } },
    updatedAt: 0,
  };

  app.ctx.pruneGroupState(state, new Set(['p1']));
  assert.deepEqual(state.groups.g_t.summary[0], 'unlinked', 'kept, and kept as a bare string');
});

// ── 5. a read bullet never reaches a billed prompt again ─────────────────────

test('BUG-089: the existing-topics block sent upstream omits bullets whose posts are all read', async () => {
  const app = createApp({ store: {
    focus_group_view: 'on', // this assertion is about the grouped view
    focus_device_id: '33333333-3333-4333-8333-333333333333',
    focus_groups: JSON.stringify({
      assignments: { p1: 'g_t', p2: 'g_t' },
      groups: { g_t: { label: 'T', summary: [
        { text: 'about the read one', item_ids: ['p1'] },
        { text: 'about the live one', item_ids: ['p2'] },
      ] } },
      updatedAt: 1753000000000,
    }),
    focus_done: JSON.stringify(['p1']),
    focus_archive: '[]',
  } });

  let sent = null;
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ groups: null, reason: 'unavailable' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  await app.ctx.updateGroupsForFeed([{ id: 'new1', source: 'twitter', text: 'a genuinely new post' }]);
  assert.ok(sent, 'the classify actually went out');
  const topic = sent.groups.find(g => g.id === 'g_t');
  const texts = (topic.summary || []).map(b => (typeof b === 'string' ? b : b.text));
  assert.deepEqual(texts, ['about the live one'],
    'the bullet for the read post is not re-sent, so it is not billed again');
});

// ── 6/7. the server keeps bullet ids honest ──────────────────────────────────

test('BUG-089: validatePartition drops a bullet id naming a post outside the partition', () => {
  const { groups } = validatePartition(['real1'], [{
    label: 'T',
    summary: [{ text: 'about both', item_ids: ['real1', 'invented'] }],
    item_ids: ['real1'],
  }]);
  assert.deepEqual(groups[0].summary[0].item_ids, ['real1'],
    'the invented id is gone from the bullet, exactly as it is from item_ids');
});

test('BUG-089: a bullet left with no ids by the partition SURVIVES as an unlinked bullet', () => {
  const { groups } = validatePartition(['real1'], [{
    label: 'T',
    summary: [{ text: 'about a post that was invented', item_ids: ['invented'] }],
    item_ids: ['real1'],
  }]);
  assert.equal(groups[0].summary.length, 1, 'the bullet is not deleted');
  const b = groups[0].summary[0];
  assert.equal(typeof b === 'string' ? b : b.text, 'about a post that was invented');
});

// Posts go up as positions, so a bullet's ids come back as positions too and
// must be reversed by the SAME pass. A position with no post is dropped; the bullet survives.
const replyWith = groups => async () => ({
  ok: true, status: 200,
  json: async () => ({ content: [{ type: 'tool_use', name: 'emit_groups', input: { groups } }] }),
});

test('BUG-089: bullet ids arrive as batch positions and come back as real post ids', async () => {
  const res = await groupItems({
    items: [{ id: 'tweet_aaa', source: 'twitter', text: 'first' },
            { id: 'tweet_bbb', source: 'twitter', text: 'second' }],
    apiKey: 'sk-test',
  }, replyWith([{ label: 'T', summary: [{ text: 'about the first', item_ids: ['0'] }], item_ids: ['0', '1'] }]));

  assert.ok(res, 'the call succeeded');
  assert.deepEqual(res.groups[0].summary[0].item_ids, ['tweet_aaa'],
    'the position was resolved, so no index escapes into the cache');
});

test('BUG-089: an out-of-range bullet position is dropped and the bullet survives', async () => {
  const res = await groupItems({
    items: [{ id: 'tweet_aaa', source: 'twitter', text: 'first' }],
    apiKey: 'sk-test',
  }, replyWith([{ label: 'T', summary: [{ text: 'about something', item_ids: ['7'] }], item_ids: ['0'] }]));

  assert.ok(res);
  assert.equal(res.groups[0].summary.length, 1, 'the bullet is kept');
  const b = res.groups[0].summary[0];
  assert.deepEqual(typeof b === 'string' ? [] : b.item_ids, [],
    'with no ids, so it is never pruned — a reply we cannot read is not evidence of a read post');
});

// ── 9. the additive guarantee ────────────────────────────────────────────────
// The whole existing grouping suite rests on this: 269 summary references, ~41 of them output
// assertions, every fake reply using id-less string bullets. If an id-less bullet came back as
// {text, item_ids: []} instead of a bare string, all of them would break at once.
test('BUG-089: an id-less bullet round-trips byte-identically as a bare string', async () => {
  const res = await groupItems({
    items: [{ id: 'tweet_aaa', source: 'twitter', text: 'first' },
            { id: 'tweet_bbb', source: 'twitter', text: 'second' }],
    apiKey: 'sk-test',
  }, replyWith([{ label: 'T', summary: ['a model shipped', 'a lab raised money'], item_ids: ['0', '1'] }]));

  assert.ok(res);
  assert.deepEqual(res.groups[0].summary, ['a model shipped', 'a lab raised money'],
    'bare strings in, bare strings out — never {text, item_ids: []}');
});

// ── 8. the migration, keyed off a version stamp ──────────────────────────────
// NOT off the bullet shape. Once an array of strings is legal NEW output, "the cache holds string
// bullets" no longer distinguishes old state from new, so a shape predicate fires on every boot —
// removeItem(SK.groups) plus schedulePush(), wiping synced grouping state on every load.

// The migration clears SUMMARIES only, not the whole cache. A FULL wipe, run from
// renderFeedResults, would destroy the very assignments a clean feed load
// had just pruned (pinned in test/group-sources.test.mjs).
//
// Only SUMMARIES are un-linkable. An assignment is `{itemId: groupId}` and a label is a string — both
// valid at v2 — so wiping them would destroy good state to fix bad state beside it. The narrower
// migration fixes the bug just as completely and costs no billed re-classify.
test('BUG-089: the migration clears summaries, keeps assignments and labels, and stamps', () => {
  const app = boot({
    assignments: { p1: 'g_t', p2: 'g_t' },
    groups: { g_t: { label: 'T', summary: ['an old unlinkable bullet', 'and another'] } },
    updatedAt: 1753000000000,
  });

  app.ctx.migrateGroupSummaries();
  const after = JSON.parse(app.get('focus_groups'));
  assert.deepEqual(after.groups.g_t.summary, [], 'the unlinkable bullets are gone');
  assert.equal(after.groups.g_t.label, 'T', 'the label is untouched — it was never un-linkable');
  assert.deepEqual(Object.keys(after.assignments).sort(), ['p1', 'p2'],
    'and every assignment survives, so no topic vanishes and nothing is re-classified');
  assert.equal(after.v, 2, 'stamped in the SAME step, not left to a later classify');
});

// The tile that results: a correct count with no bullets, which is the accepted cost of the narrower
// migration. Asserted so "your topics go bare for a while" is a pinned, visible consequence rather
// than something discovered on the handset.
test('BUG-089: a migrated topic renders its count with no bullets until new posts arrive', () => {
  const app = boot({
    assignments: { p1: 'g_t' },
    groups: { g_t: { label: 'T', summary: ['an old unlinkable bullet'] } },
    updatedAt: 1753000000000,
  });

  app.ctx.migrateGroupSummaries();
  app.ctx.renderTopicCards();
  const card = tileOf(app);
  assert.equal(countOn(card), '1 post', 'the topic is still there and still counts correctly');
  assert.deepEqual(bulletsOn(card), [], 'with no bullets, rather than eight wrong ones');
});

test('BUG-089: the migration does not fire a second time', () => {
  const app = boot({
    assignments: { p1: 'g_t' },
    groups: { g_t: { label: 'T', summary: ['an old unlinkable bullet'] } },
    updatedAt: 1753000000000,
  });

  app.ctx.migrateGroupSummaries();
  app.set('focus_groups', JSON.stringify({
    assignments: { p9: 'g_new' },
    groups: { g_new: { label: 'New', summary: [{ text: 'about p9', item_ids: ['p9'] }] } },
    updatedAt: 1753000001000,
    v: 2,
  }));

  app.ctx.migrateGroupSummaries();
  const after = JSON.parse(app.get('focus_groups'));
  assert.deepEqual(Object.keys(after.groups), ['g_new'],
    'a stamped cache built after the migration is not wiped by the next boot');
  // THE ASSERTION THAT MATTERS. The line above alone
  // is green for the wrong reason: deleting the version guard entirely — so the
  // migration re-fires on EVERY boot — leaves it passing. The topic KEY
  // survives a re-fire; it is the bullets that are destroyed, and destroyed on every page load, on
  // every device, because migrateGroupSummaries also schedulePush()es.
  assert.deepEqual(after.groups.g_new.summary, [{ text: 'about p9', item_ids: ['p9'] }],
    'and its BULLETS survive — a re-firing migration wipes these while leaving the key behind');
});

test('BUG-089: a stamped cache of ALL id-less string bullets is not mistaken for old state', () => {
  const app = boot({
    assignments: { p1: 'g_t' },
    groups: { g_t: { label: 'T', summary: ['a fresh bullet the model gave no ids for'] } },
    updatedAt: 1753000000000,
    v: 2,
  });

  app.ctx.migrateGroupSummaries();
  const after = JSON.parse(app.get('focus_groups'));
  assert.deepEqual(Object.keys(after.groups), ['g_t'],
    'this is the exact case shape inference gets wrong, and it must survive');
});

// ── The server half: the model must be ASKED for ids, and cached ids must survive ──
// Everything above works on state the client already holds. These cover the round trip that puts
// ids there in the first place, and the bullet-forwarding machinery that must keep working around them.

test('BUG-089: the tool schema lets a bullet name the posts it describes', () => {
  const req = buildGroupRequest({ items: [{ id: '0', source: 'twitter', text: 'x' }] });
  const summary = req.tools[0].input_schema.properties.groups.items.properties.summary;
  const item = summary.items;
  assert.notEqual(item.type, 'string',
    'a bare string schema is what makes the model unable to tell us which post a bullet is about');
  assert.ok(item.properties?.item_ids, 'each bullet can carry item_ids');
  assert.ok(item.properties?.text, 'and its text');
});

test('BUG-089: the prompt tells the model to attribute each bullet', () => {
  const req = buildGroupRequest({ items: [{ id: '0', source: 'twitter', text: 'x' }] });
  assert.match(req.system, /item_ids/,
    'the schema alone is a shape; the rule is what makes the model actually fill it');
});

// A topic reaches the model WITHOUT its bullets, by design: the summary is not replaced on merge,
// so the model does not need them.
//
// That a cached bullet is not silently dropped by a shape
// test is protected by restoration rather than by forwarding, and is pinned in
// `test/group.test.mjs` ('BUG-091: every cached bullet survives a revision…'). What is pinned here
// is that real post ids must never be retyped into a billed prompt:
// neither the text nor the ids go up.
test('BUG-091: a cached bullet with ids reaches the model neither as text nor as ids', () => {
  const req = buildGroupRequest({
    items: [{ id: '0', source: 'twitter', text: 'a new post' }],
    groups: [{ label: 'AI news', summary: [{ text: 'a model shipped', item_ids: ['old1'] }] }],
  });
  assert.doesNotMatch(req.messages[0].content, /a model shipped/,
    'the bullet text is withheld, so no reply can supersede it');
  assert.doesNotMatch(req.messages[0].content, /old1/,
    'and never its real post ids — lever A ([BUG-077])');
  assert.match(req.messages[0].content, /AI news/,
    'the label still goes up, so the post can still be assigned to this topic ([BUG-067])');
});

test('BUG-089: a bullet returned verbatim recovers the ids it was cached with', async () => {
  const res = await groupItems({
    items: [{ id: 'tweet_new', source: 'twitter', text: 'a new post' }],
    // `size` is what the BROWSER sends for every cached topic (app.js builds it from
    // groupUnreadIds). A fixture omitting it does not model the real client: with no
    // size, collapseSingletons reads the topic as unpopulated and folds this one-post group into
    // "Everything else", so the label — and the assertion below — disappear.
    groups: [{ label: 'AI news', size: 1, summary: [{ text: 'a model shipped', item_ids: ['tweet_old'] }] }],
    apiKey: 'sk-test',
  }, replyWith([{
    label: 'AI news',
    summary: ['a model shipped', { text: 'and a lab raised money', item_ids: ['0'] }],
    item_ids: ['0'],
  }]));

  assert.ok(res);
  const kept = res.groups[0].summary.find(b => (typeof b === 'string' ? b : b.text) === 'a model shipped');
  assert.deepEqual(kept?.item_ids, ['tweet_old'],
    'the model was shown text only, so the link comes back from the cache — not lost on every refresh');
});

test('BUG-089: a withheld bullet keeps its ids when it is restored', async () => {
  // MAX_TOPIC_BULLETS forwarded; anything past that the model never sees and must come back intact.
  const cached = Array.from({ length: MAX_TOPIC_BULLETS + 2 }, (_, i) =>
    ({ text: `cached bullet ${i}`, item_ids: [`old${i}`] }));
  const res = await groupItems({
    items: [{ id: 'tweet_new', source: 'twitter', text: 'a new post' }],
    groups: [{ label: 'AI news', size: 1, summary: cached }],   // see the note above on `size`
    apiKey: 'sk-test',
  }, replyWith([{ label: 'AI news', summary: [{ text: 'something new', item_ids: ['0'] }], item_ids: ['0'] }]));

  assert.ok(res);
  const tail = res.groups[0].summary.find(b => (typeof b === 'string' ? b : b.text) === `cached bullet ${MAX_TOPIC_BULLETS + 1}`);
  assert.ok(tail, 'the withheld bullet came back');
  assert.deepEqual(tail.item_ids, [`old${MAX_TOPIC_BULLETS + 1}`], 'still carrying its post');
});

test('BUG-089: merging two same-label groups dedupes on TEXT and unions the ids', () => {
  const merged = mergeSameLabel([
    { label: 'AI news', summary: [{ text: 'shared point', item_ids: ['a'] }], item_ids: ['a'] },
    { label: 'AI news', summary: [{ text: 'shared point', item_ids: ['b'] }], item_ids: ['b'] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].summary.length, 1, 'one bullet, not two copies of the same sentence');
  assert.deepEqual(merged[0].summary[0].item_ids, ['a', 'b'],
    'and it describes BOTH posts, so it survives until both are read');
});
