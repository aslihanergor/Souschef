// Host canonicalisation config guard.
//
// A `redirects` key in vercel.json makes one host canonical, so a browser
// gets ONE localStorage and ONE device id instead of one per origin. There is no way to test the
// deployed behaviour here: `dev-server.mjs`'s `vercelHeaders` reads only `cfg.headers` and never looks at
// redirects, and a host-conditional rule is meaningless against localhost:3000. Production is the
// only tier that can exercise it, which is why this file guards the config's SHAPE — the same trade
// public-landing.test.mjs:296 makes for the CSP, and for the same reason: the failure ships silently
// and the page still looks fine.
//
// ── Why each guard exists ───────────────────────────────────────────────────────────────────────
//
// THE PATH PATTERN. Vercel compiles every `source` with path-to-regexp under `strict: true`
// (vercel/vercel, packages/routing-utils/src/superstatic.ts). `strict` suppresses the optional
// trailing-delimiter group, so the named-parameter form `/:path*` does NOT match the bare root `/`,
// nor `/app/`, nor `/privacy/` — measured against path-to-regexp 6.1.0 with Vercel's exact options.
// The first version of this change shipped `/:path*` and would have left the apex of every
// secondary host answering 200, plus `/app/` still booting the app on a non-canonical origin: the split
// unfixed, on a live URL, past a green suite. So a rule is not judged by whether it has a parameter.
// It is judged by whether its pattern actually matches the paths that must be folded.
//
// THE HOST CONDITION. `has[].value` is a REGEX, not a literal string (Vercel's schema; matched as
// `new RegExp('^' + value + '$')` against the lowercased, port-stripped Host). A guard that compares
// it for string equality cannot see `".*"`, which matches the canonical host and redirects it to
// itself forever — the app unreachable on every origin at once, since all hosts serve the same
// deployment. So the check compiles each pattern and asks whether it matches the canonical host,
// rather than whether it spells it.
//
// Values are deliberately left UNESCAPED (`focus-social.app`, not `focus-social\.app`). The `.` is a
// regex wildcard, so `focus-socialXapp` would also match — harmless, since no such host is assigned
// to the project. The escaped form is only correct if the value is definitely a regex; the
// unescaped form is correct under BOTH readings, and this file's job is to fail safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('vercel.json', ROOT), 'utf8'));

// The canonical host. index.html:25 already declares og:url as this host.
const CANONICAL = 'trysouschef.vercel.app';

// Every OTHER host serving this deployment. Hand-maintained, and it can only make noise about a host
// that is IN it: a domain added in the Vercel dashboard and not added here re-opens the split silently
// and no unit test can see that. That obligation lives in docs/architecture.md,
// not here — stated so nobody mistakes this list for a mechanism that covers it.
const NON_CANONICAL = ['focus-social.app', 'focus-social.vercel.app'];

// Paths that MUST be folded onto the canonical host. `/` is the apex a human types; `/app/` and
// `/privacy/` are the trailing-slash forms Vercel does NOT normalise (no `trailingSlash` key is set),
// and `/app/` serves the real app shell — so a rule that misses it leaves the split wide open.
// `/api/auth/callback` carries single-use magic-link tokens already sitting in people's inboxes.
const MUST_FOLD = ['/', '/app', '/app/', '/privacy', '/privacy/', '/api/auth/callback'];

const hostPatterns = (rule) =>
  (rule.has || []).filter((c) => c && c.type === 'host').map((c) => c.value);

// Each guard below is an invariant over the rule list, and an invariant over an EMPTY list holds
// vacuously — it would report green while checking nothing. So every guard that iterates the rules
// demands the list be non-empty first: deleting the `redirects` key must red every test in this
// file. (The per-host coverage test iterates NON_CANONICAL instead, so it is already non-vacuous.)
function rulesOrFail() {
  assert.ok(
    Array.isArray(config.redirects) && config.redirects.length > 0,
    'vercel.json declares no redirect rules, so this guard has nothing to check and would pass ' +
    'vacuously. BUG-060 is re-opened the moment the `redirects` key goes away.',
  );
  return config.redirects;
}

test('vercel.json declares a redirects array covering every non-canonical host', () => {
  assert.ok(
    Array.isArray(config.redirects),
    'vercel.json has no `redirects` array. BUG-060: each origin keeps its own localStorage and ' +
    'session cookie, so one browser is several devices against one account row.',
  );
  assert.ok(
    config.redirects.length >= NON_CANONICAL.length,
    `vercel.json declares ${config.redirects.length} redirect rule(s) but ${NON_CANONICAL.length} ` +
    `non-canonical host(s) need folding into ${CANONICAL}: ${NON_CANONICAL.join(', ')}`,
  );
});

test('every rule folds the whole site, including the bare root and trailing-slash paths', () => {
  for (const rule of rulesOrFail()) {
    const source = String(rule.source);

    // A named parameter (`/:path*`) is the trap this assertion exists for: it reads as a catch-all
    // and is not one under `strict: true`. Rejected by name so the failure explains itself rather
    // than surfacing as a confusing regex mismatch below.
    assert.ok(
      !/:\w+/.test(source),
      `Redirect source "${source}" uses a named parameter. Vercel compiles sources with ` +
      `path-to-regexp \`strict: true\`, under which "/:path*" does NOT match the bare root "/", ` +
      `"/app/" or "/privacy/". Use the regex form "/(.*)" with a "$1" backreference.`,
    );

    // `source` is now a plain regex fragment, so compiling it naively is faithful to what Vercel
    // builds (it produces ^(?:\/(.*))$ for "/(.*)", equivalent to the anchored form below).
    const re = new RegExp(`^${source}$`);
    for (const path of MUST_FOLD) {
      assert.ok(
        re.test(path),
        `Redirect source "${source}" does not match "${path}", so that URL keeps serving from the ` +
        `non-canonical origin with its own localStorage and device id — BUG-060, unfixed, on a live ` +
        `200 URL. Matched paths must include: ${MUST_FOLD.join(', ')}`,
      );
    }

    // A capture in the source is worthless unless the destination spends it, or every deep link
    // collapses onto the canonical host's landing page.
    if (/\((?!\?:)/.test(source)) {
      assert.match(
        String(rule.destination), /\$\d/,
        `Redirect source "${source}" captures a path but destination "${rule.destination}" carries ` +
        `no "$1" backreference, so every path would collapse onto the canonical host's root. A ` +
        `magic-link callback already sitting in someone's inbox would stop working.`,
      );
    }
  }
});

test('every non-canonical host is folded into the canonical host', () => {
  for (const host of NON_CANONICAL) {
    const rule = (config.redirects || []).find((r) =>
      hostPatterns(r).some((v) => typeof v === 'string' && new RegExp(`^${v}$`).test(host)));

    assert.ok(
      rule,
      `No redirect rule fires for ${host}. It serves the same deployment as ${CANONICAL}, so a user ` +
      `who opens it gets a second device id and a second local store for the same account.`,
    );
    assert.ok(
      String(rule.destination).startsWith(`https://${CANONICAL}/`),
      `${host}'s rule points at ${rule.destination}, not at https://${CANONICAL}/`,
    );
  }
});

test('no redirect rule is unconditioned — the loop guard', () => {
  for (const rule of rulesOrFail()) {
    assert.ok(
      hostPatterns(rule).length > 0,
      `A redirect rule (source ${rule.source} → ${rule.destination}) carries no host condition. ` +
      `All hosts serve the SAME deployment, so this rule also fires on ${CANONICAL} and redirects ` +
      `it to itself forever. The app becomes unreachable on every origin at once.`,
    );
  }
});

test('no redirect rule can match the canonical host itself', () => {
  for (const rule of rulesOrFail()) {
    for (const value of hostPatterns(rule)) {
      // A condition object ({eq}, {suf}, {re}, …) is schema-valid and this guard cannot reason about
      // it, so it is refused outright rather than waved through — refusing an unknown is the only
      // answer that fails safe.
      assert.equal(
        typeof value, 'string',
        `A host condition on rule "${rule.source}" is not a plain string pattern ` +
        `(${JSON.stringify(value)}). This guard can only prove a STRING pattern misses ${CANONICAL}; ` +
        `a condition object may match it and loop. Use a string, or extend this guard first.`,
      );
      // Anchored is how Vercel matches. Unanchored is tested too because the anchoring is not
      // documented in the schema itself — if it is ever relaxed, a substring pattern would loop.
      for (const [label, compiled] of [['anchored', new RegExp(`^${value}$`)], ['unanchored', new RegExp(value)]]) {
        assert.ok(
          !compiled.test(CANONICAL),
          `Host pattern "${value}" on rule "${rule.source}" matches the canonical host ` +
          `${CANONICAL} (${label}). That rule redirects the canonical host to itself forever and ` +
          `the app becomes unreachable on every origin at once.`,
        );
      }
    }
  }
});

test('the redirects are temporary (307) and no statusCode overrides that', () => {
  for (const rule of rulesOrFail()) {
    // souschef.app belongs to a different company, so the branded apex we
    // might have wanted is unavailable and the canonical host is not final. A 308 is cached hard by
    // browsers and would strand anyone who visited during this period.
    assert.equal(
      rule.permanent, false,
      `A redirect rule (source ${rule.source}) is permanent (308). Vercel caches 308 in the browser ` +
      `indefinitely; the canonical host is not final, so these must be 307 (permanent: false).`,
    );
    // Vercel's reference: "statusCode … Overrides permanent when set". Asserting `permanent` alone
    // pins a field, not the status code the browser actually receives.
    assert.ok(
      !('statusCode' in rule),
      `A redirect rule (source ${rule.source}) sets statusCode, which OVERRIDES permanent — so the ` +
      `307 asserted just above is not what would be served.`,
    );
  }
});
