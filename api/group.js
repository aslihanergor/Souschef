// POST /api/group — cluster the user's unread text posts into topic bundles (TASK-068).
//
// Pure endpoint: the client sends the posts it already holds (id/source/text); we call Claude and
// return groupings keyed by post id. It never re-fetches a source feed (avoids the per-channel
// fanout of TASK-066). On any failure of the CLASSIFY — missing key, network, unparseable response — it
// returns { groups: null } with a 200 so the client degrades to the plain chronological feed rather than
// treating grouping as a hard error. (A request the sign-in gate refuses is not that: see below.)
//
// RATE LIMITING LIVES OUTSIDE THIS FILE (BUG-021). Every POST here bills a Claude call, so the
// endpoint is capped by a Vercel WAF rate-limit rule, keyed on IP and enforced at the edge before
// this function is ever invoked. It is project config, not
// code: it is not in git, not in `npm test`, and not visible from this file. `vercel firewall
// rules list` shows it. Do not assume this handler is unprotected, and do not remove the rule
// without replacing the bound. Full rationale + the limits' derivation: tasks/BUG-021.md.
//
// SIGNED-IN ONLY ([BUG-130]). Until then this endpoint answered anyone, bounded only by the rule above
// and the request-size caps ([BUG-069]). A request without a confirmed session is now refused before anything else runs — 401, or 503
// when the session could not be checked — and a refusal is NOT the degrade above: it carries an `error`
// and a non-2xx status, which the client counts as `group_classify_failed`. The rule still matters: sign-up
// is open, so the gate decides WHO can spend the key, not how much ([BUG-132]).
import { groupItems } from './_group.js';
import { db } from './_db.js';
import { sessionAccount, signedInGate, refuse } from './_session.js';

// Injection seam ([BUG-130]), mirroring `createFeedHandler` and `createResolveHandler`. The Anthropic
// request needs no seam of its own: `groupItems` defaults `fetchImpl` to the global `fetch` per call, so
// a test that stubs `globalThis.fetch` sees it. The default export binds the real modules and keeps
// Vercel's `handler(req, res)` signature.
export function createGroupHandler({
  db: dbFn = db,
  sessionAccount: sessionFn = sessionAccount,
  sessionTimeoutMs,   // undefined → the gate's production limit (SESSION_CHECK_TIMEOUT_MS)
} = {}) {
  return (req, res) => handleGroup(req, res, { dbFn, sessionFn, sessionTimeoutMs });
}

export default createGroupHandler();

async function handleGroup(req, res, ctx) {
  // FIRST — ahead of the method check and the body — so a refused request never reaches Anthropic. The
  // app only classifies after sign-in ([TASK-084]) and its same-origin request carries the cookie, so a
  // refusal costs no real user. There is no free branch here as there is on `/api/feed`: every request
  // that gets past this line can bill a Claude call, so an UNVERIFIED session (the store errored or missed
  // the time limit, which anyone sending any `focus_session` value reaches) is refused too — decision B's
  // rule for the paths that spend money. `signedInGate` (api/_session.js) owns the three answers.
  const gate = await signedInGate(ctx.dbFn(), req?.headers?.cookie, ctx.sessionFn, { timeoutMs: ctx.sessionTimeoutMs });
  if (!gate) return refuse(res, 401, 'sign in required');
  if (!gate.account) return refuse(res, 503, 'could not verify sign-in');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const items = body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  // NORMALISE, never reject ([BUG-069]). A non-array `groups` is only reachable from a hand-crafted
  // request — the browser always builds one (app.js:196) — but the two shapes fail in opposite
  // directions downstream and both are wrong. A STRING has a truthy `.length`, so planExistingTopics
  // reaches `groups.map` and throws, degrading a classify the user never sees fail. `{}` / `42` /
  // `true` have a falsy `.length` and already succeed, so rejecting them would re-break what
  // BUG-066 review round 1 (M3) fixed. Coercing to [] gives both the same correct outcome: no
  // existing labels, classify proceeds. This is the boundary the four `_group.js` comments about
  // unvalidated `groups` used to point at.
  const groups = Array.isArray(body?.groups) ? body.groups : [];

  const result = await groupItems({ items, groups, apiKey: process.env.ANTHROPIC_API_KEY });
  // null = degrade signal from groupItems; hand the client a shape it can fall back on.
  if (!result) return res.status(200).json({ groups: null, reason: 'unavailable' });
  return res.status(200).json(result);
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
