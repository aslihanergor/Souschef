// Client half of the grouping contract (BUG-066). `test/group.test.mjs` covers the server helpers by
// direct import; this file covers what the BROWSER sends, which is where the missing fact lived: the
// request carried each existing topic's name but never its size, so the server could not tell a post
// joining a 40-member topic from a post about nothing.
//
// These run app.js for real inside the app harness, so the assertions are on the actual outgoing
// request body — not on a reimplementation of how it is built.
//
// The fake /api/group deliberately answers with the degrade shape ({groups:null}). These criteria are
// about what goes OUT; degrading keeps the classify from rendering a grid and keeps each test to one
// claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../test-helpers/app-harness.mjs';
import { topicKey } from '../api/_group.js';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

// Two live topics and one whose posts have all been read:
//   US Politics    a1..a4, with a2 done and a3 archived  → 2 unread
//   About Football b1                                    → 1 unread
//   Old topic      c1, c2, both done                     → 0 unread
const GROUP_STATE = {
  assignments: {
    a1: 'g_us_politics', a2: 'g_us_politics', a3: 'g_us_politics', a4: 'g_us_politics',
    b1: 'g_about_football',
    c1: 'g_old_topic', c2: 'g_old_topic',
  },
  // Each carries the bullets an earlier grouping produced — that is what BUG-067 sends back up, and
  // no BUG-066 assertion below depends on these being empty.
  groups: {
    g_us_politics:    { label: 'US Politics', summary: ['the spending bill stalled', 'two senators retired'] },
    g_about_football: { label: 'About Football', summary: ['Arsenal signed a striker'] },
    g_old_topic:      { label: 'Old topic', summary: ['an old point'] },
  },
  updatedAt: 1753000000000,
};

const STORE = {
  focus_device_id: DEVICE_ID,
  focus_groups: JSON.stringify(GROUP_STATE),
  focus_done: JSON.stringify(['a2', 'c1', 'c2']),
  focus_archive: JSON.stringify([{ id: 'a3' }]),
};

// One genuinely-new text post, which is what makes updateGroupsForFeed call the endpoint at all.
const NEW_POSTS = [{ id: 'new1', source: 'twitter', text: 'Senate advances the spending bill' }];

// Boot the app, run one classify, and hand back the parsed /api/group request body.
async function classifyAndCaptureRequest() {
  const app = createApp({ store: { ...STORE } });
  let groupBody = null;
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      groupBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ groups: null, reason: 'unavailable' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  await app.ctx.updateGroupsForFeed(NEW_POSTS);
  assert.ok(groupBody, 'the classify actually reached /api/group');
  return groupBody;
}

const byId = (groups, id) => groups.find(g => g.id === id);

test('the classify request carries a size for every cached topic', async () => {
  const body = await classifyAndCaptureRequest();
  assert.equal(body.groups.length, 3, 'every cached topic is offered to the model');
  for (const g of body.groups) {
    assert.ok(typeof g.id === 'string' && g.id, `${g.label} carries its id`);
    assert.ok(typeof g.label === 'string' && g.label, 'the label is still sent');
    assert.equal(typeof g.size, 'number', `${g.label} carries a numeric size`);
  }
});

test('a topic size counts unread posts only — done and archived are excluded', async () => {
  const body = await classifyAndCaptureRequest();
  // a1..a4 assigned, a2 done, a3 archived → 2 remain unread.
  assert.equal(byId(body.groups, 'g_us_politics').size, 2);
  assert.equal(byId(body.groups, 'g_about_football').size, 1);
});

test('a topic whose posts are all done sends size 0', async () => {
  const body = await classifyAndCaptureRequest();
  assert.equal(byId(body.groups, 'g_old_topic').size, 0);
});

test('the new post itself is still the only item sent', async () => {
  const body = await classifyAndCaptureRequest();
  assert.deepEqual(body.items.map(i => i.id), ['new1'], 'only genuinely-new posts are classified');
});

// ── The OUTCOME, not just the request (review round 1, H2) ──────────────────────
// The tests above stop at what the browser sends, and the server tests stop at what the endpoint
// returns. Neither covers the thing the fix exists to produce: the post actually joining the topic.
// That last step runs through `groupIdFor` — a PRE-EXISTING function this fix leans on and never
// mutated — so grouping could be broken outright with the whole suite green. Three faithful
// mutations proved it: groupIdFor returning a different id, deleting mergeGroups' assignment line,
// and the handler stripping `size`. These two tests red all three.

// A classify whose endpoint SUCCEEDS, assigning the new post to an existing topic by label.
async function classifyWithServerReply(groups) {
  const app = createApp({ store: { ...STORE } });
  app.setFetch(async (url, init) => {
    if (String(url).includes('/api/group')) {
      return { ok: true, status: 200, json: async () => ({ groups, capped: false }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  await app.ctx.updateGroupsForFeed(NEW_POSTS);
  return JSON.parse(app.get('focus_groups'));
}

test('a spared singleton joins the EXISTING topic rather than making a second tile', async () => {
  const after = await classifyWithServerReply([
    { label: 'US Politics', summary: ['a new hearing was scheduled'], item_ids: ['new1'] },
  ]);
  // The whole point: the post lands in the topic the user already sees.
  assert.equal(after.assignments.new1, 'g_us_politics');
  // And no duplicate tile appears under the same name — still the original three topics.
  assert.deepEqual(
    Object.keys(after.groups).sort(),
    ['g_about_football', 'g_old_topic', 'g_us_politics'],
  );
});

test('a genuinely new topic still creates its own tile', async () => {
  const after = await classifyWithServerReply([
    { label: 'Sourdough', summary: ['a starter finally rose'], item_ids: ['new1'] },
  ]);
  assert.equal(after.assignments.new1, 'g_sourdough');
  assert.equal(Object.keys(after.groups).length, 4, 'a fourth topic was added');
});

// ── BUG-067: the topic's own bullets go UP, and an untouched topic keeps its own ──
// The model is only ever shown the NEW posts, so the summary it returns can only describe those —
// and mergeGroups assigns {label, summary} wholesale, captioning a 41-post topic with this morning's
// single post. Sending each topic's current bullets is what lets the model return an updated summary.

test("the classify request carries each cached topic's summary", async () => {
  const body = await classifyAndCaptureRequest();
  assert.deepEqual(
    byId(body.groups, 'g_us_politics').summary,
    ['the spending bill stalled', 'two senators retired'],
    'the topic goes up with the bullets it already has',
  );
  assert.deepEqual(byId(body.groups, 'g_about_football').summary, ['Arsenal signed a striker']);
});

test('a topic the model returns no group for keeps its summary byte-identical', async () => {
  // The model only returns groups for topics the new posts join. Every other topic must be left
  // exactly as it was — the half of the behaviour that was already correct.
  const after = await classifyWithServerReply([
    { label: 'About Football', summary: ['a new signing'], item_ids: ['new1'] },
  ]);
  assert.deepEqual(
    after.groups.g_us_politics.summary,
    ['the spending bill stalled', 'two senators retired'],
    'the untouched topic still holds its original bullets',
  );
});

test('a merged topic caches an ARRAY summary, never a string', async () => {
  // KNOWN WEAK — this fixture is already an array, so the assertion below cannot fail from it.
  // Recorded as [CHR-061] item (a) and re-confirmed 2026-08-12 while killing [BUG-071]: mutating
  // `bulletsOf` (api/_group.js) to drop the string branch kills 0 of 577 tests. `group.test.mjs`'s
  // "M3" looks like the missing coverage but asserts only Array.isArray, so a mutation returning []
  // passes it while the bullet text is silently discarded.
  //
  // The stakes are lower than the original comment here claimed. It said a string summary makes
  // migrateGroupSummaries drop the whole grouping cache on the next boot — that stopped being true
  // at [BUG-089]: the migration keys off a `v` stamp, never off summary shape, and clears only
  // `summary` while keeping assignments and labels. Every consumer (syncGroupPrune, liveBullets,
  // summaryHtml) guards Array.isArray independently, so a string is inert rather than destructive.
  // Left as-is deliberately: [CHR-010] (committed mutation check) is the fix for this class.
  const after = await classifyWithServerReply([
    { label: 'US Politics', summary: ['a hearing was scheduled'], item_ids: ['new1'] },
  ]);
  assert.ok(Array.isArray(after.groups.g_us_politics.summary), 'summary stayed an array');
  assert.equal(after.assignments.new1, 'g_us_politics', 'and the post really joined that topic');
});

// ── BUG-068: the server's topicKey is a hand copy of the browser's groupIdFor ──────
// `api/_group.js` cannot import `lib/pure.js` (no api/ module does, and adding that dependency is an
// architecture call to raise), so the transform exists twice. Two copies that must agree and nothing
// checking it is how the round-2 HIGH happened in the first place — the server compared raw labels
// while the browser compared slugs. This runs BOTH functions, the real one lifted out of the running
// app.js, over the spellings that actually differ, and fails the moment either side drifts.
test('the server-side topicKey matches the browser-side groupIdFor exactly', () => {
  const { ctx } = createApp({ store: {} });
  assert.equal(typeof ctx.groupIdFor, 'function', 'the real browser function is reachable');
  const labels = [
    'AI news', 'AI News', 'AI NEWS', 'AI-news', 'AI news ', ' AI news', 'A.I. news',
    'US Politics', 'us politics', 'About Football', 'Everything else',
    'Türkiye gündemi', 'Crypto & Markets', 'Health/Fitness', '2026 Elections',
    '', '   ', '!!!', 'a', 'Multi   space', "O'Brien on tech",
  ];
  for (const label of labels) {
    assert.equal(topicKey(label), ctx.groupIdFor(label), `both sides agree on ${JSON.stringify(label)}`);
  }
});
