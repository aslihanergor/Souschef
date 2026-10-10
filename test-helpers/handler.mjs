// Handler test harness: what makes owner-resolution rules provable.
//
// The design decision that matters: `fakeDb()` is a STATEFUL STORE, not a call recorder. Tests
// assert on what is actually stored afterwards ("the victim's row is byte-identical"), never on
// "the query ran" — assert observable output, not that a function was called.
//
// It reads the SQL rather than pattern-matching fixed strings, so it models the real semantics:
//   - `where id = ?`            matches a row of ANY kind  → reproduces the cross-namespace vulnerability
//   - `where id = ? and kind = ?` matches exactly          → what the fix must produce
// Nothing here needs editing to go from RED to GREEN; the same fake serves both.
//
// SAFETY NET: any query it does not recognise THROWS. A silently-ignored query would let a test
// pass green against SQL that never ran — a false-confidence failure.
//
// It lives OUTSIDE `test/` on purpose. `npm test` runs `node --test test/`, and Node treats every
// .mjs under a `test/` directory as a test file — so a harness parked there reports itself as a
// passing test with zero assertions, inflating the count with a green that asserts nothing.

// A monotonic fake clock so `updated_at` is deterministic AND observably changes on each write.
let _tick = 0;
function nextNow() {
  _tick += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, _tick));
}

import { REV_EXPR, REV_EXPR_QUALIFIED } from '../api/_state.js';

// The canonical rev expression as `normalize()` below renders it: whitespace-collapsed and
// lowercased. Every rev the handler asks for must match ONE of these two spellings exactly.
//
// A fake matching `to_char\(users\.updated_at, '[^']*'\)`
// — ANY format literal — and then rendering the token with its own `toCharUS` regardless would let the read
// ask for one format and the write for another, or either drop the `at time zone 'UTC'`
// that makes the token GUC-stable, while handing back matching strings and staying green. The
// instrument could not detect the defect it was installed to detect. So it refuses anything it does
// not recognise, which is the same fail-loudly property the rest of this file has.
const REV_SQL = REV_EXPR.replace(/\s+/g, ' ').toLowerCase();
const REV_SQL_QUALIFIED = REV_EXPR_QUALIFIED.replace(/\s+/g, ' ').toLowerCase();

// Escape a literal for embedding in a RegExp — the expressions carry `(`, `)`, `.` and `'`.
function reLit(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Render a timestamp the way Postgres' `to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')` does:
// microsecond precision, no timezone suffix. DELIBERATELY not `toISOString()`.
//
// This is the difference between a test that can fail on the
// risk it names and one that cannot. The rev token and the `updatedAt` field are two different
// renderings of the SAME column, so a fake that emits one string for both makes them
// interchangeable — a fake returning them byte-identical means a
// client echoing `updatedAt` where it should echo `rev` passes a test written to catch exactly that.
// `2026-01-01T00:00:01.000000` (here) vs `2026-01-01T00:00:01.000Z` (JSON's Date) cannot be confused.
//
// It is also why the real query must use `to_char` rather than `::text`: `timestamptz::text` renders
// through the session DateStyle/TimeZone GUCs, and GET and PUT are different Neon HTTP requests, so
// any drift makes EVERY conditional write fail to match.
export function toCharUS(date) {
  const iso = date.toISOString();                       // 2026-01-01T00:00:01.000Z
  return `${iso.slice(0, -1)}000`;                      // 2026-01-01T00:00:01.000000
}

// Collapse a tagged-template query into single-line, lowercased text with `?` for each bound value.
function normalize(strings) {
  return strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase();
}

// The columns compared against a bound value in a WHERE clause, in template order — so
// `where id = ? and kind = ?` yields ['id','kind'] and zips positionally onto the values.
//
// `fromEnd` is for UPDATE, where the SET values are bound BEFORE the WHERE ones, so the predicate
// zips onto the tail of `values` rather than the head. Zipping from 0 there would silently match
// the wrong row — a fake that quietly answers the wrong question is worse than one that throws.
function wherePredicate(text, values, { fromEnd = false } = {}) {
  const where = text.slice(text.indexOf(' where '));
  const cols = [...where.matchAll(/([a-z_]+)\s*=\s*\?/g)].map((m) => m[1]);
  const offset = fromEnd ? values.length - cols.length : 0;
  const pred = {};
  cols.forEach((c, i) => { pred[c] = values[offset + i]; });
  return pred;
}

// Zip an `insert into T (cols…) values (…)` against its bound values. Value tokens that are SQL
// expressions rather than placeholders (`now()`) are evaluated here; `?::jsonb` counts as a
// placeholder. Column-order and value-order correspond, so one index walks both.
function parseInsert(text, values) {
  const m = text.match(/insert into (\w+) \(([^)]*)\) values \(/);
  if (!m) return null;
  // Scan to the MATCHING close paren. `values \(([^)]*)\)` would stop at the first
  // `)` — the one inside `now()` — so the token list would be truncated to `?, ?, ?::jsonb, now(`, the
  // trailing token would match nothing, and EVERY insert would store `updated_at: null`. A test comparing a
  // write's timestamp would then be comparing null to null and passing against nothing.
  const open = m.index + m[0].length;
  let depth = 1, i = open;
  while (i < text.length && depth > 0) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    i += 1;
  }
  if (depth !== 0) return null;                       // unbalanced → let the caller's throw fire
  const cols = m[2].split(',').map((s) => s.trim());
  // Splitting on ',' is safe only while no value token contains one (`now()` does not). If a future
  // insert binds something like `coalesce(a, b)`, split at top level instead.
  const toks = text.slice(open, i - 1).split(',').map((s) => s.trim());
  const row = {};
  let vi = 0;
  cols.forEach((col, i) => {
    const tok = toks[i] ?? '';
    if (tok.startsWith('?')) row[col] = values[vi++];
    else if (tok.includes('now()')) row[col] = nextNow();
    else row[col] = null;
  });
  const conflict = text.match(/on conflict \(([^)]*)\)/);
  return {
    table: m[1],
    row,
    conflictCols: conflict ? conflict[1].split(',').map((s) => s.trim()) : [],
    ...conflictAction(text, values),
  };
}

// What the ON CONFLICT clause DOES.
//
// If `parseInsert` read only the conflict TARGET and dropped
// the action, `do update … where <guard>` would be applied as an unconditional overwrite. A conditional
// write is the entire mechanism of stale-write refusal, so its test would go green against an
// implementation guarding nothing — the "green, correct, and measuring the wrong quantity" shape,
// one layer below the code under test.
//
// Three shapes are recognised, and anything else THROWS rather than being guessed at:
//   do nothing                          → create-only; an existing row is left alone
//   do update set …                     → unconditional overwrite (today's behaviour, kept so the
//                                         mutation that DELETES the guard reproduces the real defect
//                                         rather than crashing the harness)
//   do update set … where to_char(…) = ? → the conditional write; the guard is evaluated against the
//                                         PRE-UPDATE row, which is what `users.updated_at` means in
//                                         Postgres and what makes two racing clients resolvable.
function conflictAction(text, values) {
  if (!/on conflict/.test(text)) return { action: 'insert', guard: null };
  if (/on conflict \([^)]*\) do nothing/.test(text)) return { action: 'nothing', guard: null };
  const upd = text.indexOf(' do update set ');
  if (upd === -1) {
    throw new Error(`fakeDb: unrecognised on-conflict action — refusing to guess.\n  ${text}`);
  }
  const tail = text.slice(upd);
  const where = tail.indexOf(' where ');
  if (where === -1) return { action: 'update', guard: null };
  // The guard's bound value is the LAST one: the insert's own values bind first.
  const g = tail.slice(where).match(new RegExp(`^ where ${reLit(REV_SQL_QUALIFIED)} = \\?`));
  if (!g) {
    throw new Error(
      'fakeDb: unrecognised conditional-write guard — refusing to pretend it matched.\n' +
      `  ${tail.slice(where).trim()}\n` +
      `  Expected: where ${REV_SQL_QUALIFIED} = ?`
    );
  }
  return { action: 'update', guard: { rev: values[values.length - 1] } };
}

// Does this statement ask for a rev, and is it the CANONICAL one?
//
// Three answers, and the third is the point: an expression that asks for a rev in ANY other spelling
// THROWS rather than being served. A fake that quietly answers a divergent expression with its own
// rendering is an instrument that cannot detect divergence — which is precisely the defect this
// mechanism exists to make impossible.
function revRequested(text) {
  if (text.includes(`${REV_SQL} as rev`)) return true;
  if (/to_char\([^)]*updated_at[^)]*\)\s+as rev/.test(text)) {
    throw new Error(
      'fakeDb: a rev asked for in a NON-CANONICAL expression — refusing to render it.\n' +
      `  ${text}\n` +
      `  Expected: ${REV_SQL} as rev\n` +
      '  Read and write must use one spelling, or the token drifts and every write 409s.'
    );
  }
  return false;
}

// What a write hands back, honouring its own `returning` list. The rev is a SECOND rendering of the
// same column, never the same string as `updated_at` — see toCharUS.
function writeResult(text, row) {
  const out = { updated_at: row.updated_at };
  if (revRequested(text)) out.rev = toCharUS(row.updated_at);
  return out;
}

// A fake `users` store plus an events log, behind the same tagged-template interface as
// @neondatabase/serverless. `users` seeds rows as { kind, id, state }.
// TWO HALVES of the events `client_id` migration, separately stageable, because a real un-migrated table is
// missing BOTH and answers for the COLUMN first — measured against Postgres:
//   `eventsClientIdColumn: false` → any statement naming client_id raises 42703 undefined_column.
//        This is the ordinary deploy order (a merge deploys the code; init-db is run by hand), and
//        modelling only the index half would let a fallback that misses 42703 look tested.
//   `eventsIndex: false`          → the column exists, its unique index does not: 42P10.
// Either way `ingestEvents`' best-effort catch would swallow the error while the response said 200.
export function fakeDb({ users = [], xUsage = [], throwOn = null, eventsIndex = true, eventsClientIdColumn = true } = {}) {
  const rows = users.map((u) => ({
    kind: u.kind,
    id: u.id,
    state: u.state ?? {},
    updated_at: u.updated_at ?? nextNow(),
  }));
  const events = [];
  // THE ROWS, not the calls. `events` above stays a call log because
  // test/state-handler.test.mjs reads its shape; this is the stateful table beside it, and it is what
  // "stored once" can be asserted against. `client_id` carries the unique index when `eventsIndex`.
  const eventRows = [];
  let eventSeq = 0;
  const queries = [];
  // The two X usage meters. `usage` is the per-owner fairness counter; `postsSeen` is the app-wide
  // SPEND meter and is a Set keyed `day|post_id`, which is what makes it exact rather than a sum —
  // it models X's own within-a-day dedup, so a test can show the two meters diverging.
  const usage = xUsage.map((u) => ({ ...u, posts: u.posts ?? 0 }));
  const postsSeen = new Set();

  const sql = (strings, ...values) => {
    const text = normalize(strings);
    queries.push({ text, values });

    // A query the test has asked to fail, so the fail-open path can be exercised. The
    // real failure is a Neon blip mid-request; this is the only way to stage one.
    if (throwOn && text.startsWith(throwOn)) {
      return Promise.reject(new Error(`fakeDb: staged failure for "${throwOn}"`));
    }

    // ── X usage meters ───────────────────────────────────────────────────────
    if (text.startsWith('select posts from x_usage')) {
      const pred = wherePredicate(text, values);
      const hit = usage.find((r) => Object.keys(pred).every((k) => String(r[k]) === String(pred[k])));
      return Promise.resolve(hit ? [{ posts: hit.posts }] : []);
    }

    // The increment upsert. It READS the on-conflict action rather than always adding — the same
    // property `conflictAction` gives the users table, and for the same reason. A branch
    // that added unconditionally would let "two channels sum into one
    // row" pass identically against `posts = x_usage.posts + n` and against `posts = n`: the
    // instrument could not detect the defect it was installed to detect.
    if (text.startsWith('insert into x_usage')) {
      const [owner_kind, owner_id, day, n] = values;
      const increments = /do update set posts = x_usage\.posts \+ \?/.test(text);
      const replaces = /do update set posts = \?/.test(text);
      if (!increments && !replaces) {
        throw new Error(`fakeDb: unrecognised x_usage conflict action — refusing to guess.\n  ${text}`);
      }
      const hit = usage.find(
        (r) => r.owner_kind === owner_kind && String(r.owner_id) === String(owner_id) && String(r.day) === String(day),
      );
      if (hit) hit.posts = increments ? hit.posts + n : n;
      else usage.push({ owner_kind, owner_id, day, posts: n });
      return Promise.resolve([]);
    }

    // The spend meter. The Set models the (day, post_id) primary key, which is what makes a re-read
    // by a SECOND user add nothing — the divergence the meter tests assert. Without `on conflict do
    // nothing` a real Postgres raises a unique violation on that duplicate, so the fake rejects
    // too: the clause is load-bearing and a fake that silently absorbed the duplicate would hide
    // that the app-wide meter had stopped recording.
    if (text.startsWith('insert into x_posts_seen')) {
      const [day, ids] = values;
      const tolerates = /on conflict do nothing/.test(text);
      for (const id of ids || []) {
        const key = `${day}|${id}`;
        if (postsSeen.has(key) && !tolerates) {
          return Promise.reject(new Error(`fakeDb: duplicate key (${key}) and no "on conflict do nothing"`));
        }
        postsSeen.add(key);
      }
      return Promise.resolve([]);
    }

    if (text.startsWith('delete from x_usage where day <')) {
      const [cutoff] = values;
      for (let i = usage.length - 1; i >= 0; i -= 1) if (usage[i].day < cutoff) usage.splice(i, 1);
      return Promise.resolve([]);
    }
    if (text.startsWith('delete from x_posts_seen where day <')) {
      const [cutoff] = values;
      for (const key of [...postsSeen]) if (key.split('|')[0] < cutoff) postsSeen.delete(key);
      return Promise.resolve([]);
    }

    // Existence probe. The write paths cannot always distinguish "no row to update" from "a row
    // exists and this client had no standing to replace it", and those are 200 and 409 respectively.
    if (text.startsWith('select 1 as one from users')) {
      const pred = wherePredicate(text, values);
      const keys = Object.keys(pred);
      const hit = rows.find((r) => keys.every((k) => r[k] === pred[k]));
      return Promise.resolve(hit ? [{ one: 1 }] : []);
    }

    if (text.startsWith('select state, updated_at')) {
      const wantsRev = revRequested(text);
      const pred = wherePredicate(text, values);
      const keys = Object.keys(pred);
      const hit = rows.find((r) => keys.every((k) => r[k] === pred[k]));
      if (!hit) return Promise.resolve([]);
      const out = { state: hit.state, updated_at: hit.updated_at };
      if (wantsRev) out.rev = toCharUS(hit.updated_at);
      return Promise.resolve([out]);
    }

    if (text.startsWith('insert into users')) {
      const { row, conflictCols, action, guard } = parseInsert(text, values);
      // `state` arrives as the JSON text the handler stringified; store the parsed object so
      // assertions compare real state, and a round-trip returns what was written.
      const incoming = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
      const existing = conflictCols.length
        ? rows.find((r) => conflictCols.every((c) => r[c] === row[c]))
        : null;
      if (existing) {
        // `do nothing` — an unbound write may CREATE a row but never overwrite one. Zero rows come
        // back, which is what the handler turns into a refusal. (Punch-list item 1.)
        if (action === 'nothing') return Promise.resolve([]);
        // The guard reads the PRE-UPDATE row — that is what `users.updated_at` means inside an
        // `on conflict do update`, and it is what lets two clients declaring the same base be
        // resolved rather than both winning.
        if (guard && toCharUS(existing.updated_at) !== guard.rev) return Promise.resolve([]);
        existing.state = incoming;
        existing.updated_at = row.updated_at;
        return Promise.resolve([writeResult(text, existing)]);
      }
      // A row inserted by SQL that never mentions `kind` has none — which is exactly the
      // pre-fix schema. Tests read it back the same way, so this stays self-consistent.
      const fresh = { kind: row.kind ?? undefined, id: row.id, state: incoming, updated_at: row.updated_at };
      rows.push(fresh);
      return Promise.resolve([writeResult(text, fresh)]);
    }

    // Update-but-never-create, for a PUT carrying no user data.
    //
    // It takes the SAME conditional guard as the upsert above, and that is not symmetry for its own
    // sake. This branch replaces the WHOLE state blob, so it destroys exactly as much as the upsert
    // does — and it is the branch through which an empty
    // browser's blob actually lands on a populated row. Guarding only the upsert would leave the
    // measured wipe path wide open.
    const UPDATE_RE = new RegExp(
      '^update users set state = \\?::jsonb, updated_at = now\\(\\) where kind = \\? and id = \\?' +
      `( and ${reLit(REV_SQL_QUALIFIED)} = \\?)? returning `);
    const um = text.match(UPDATE_RE);
    if (um) {
      const [stateJson, kind, id, base] = values;
      const hit = rows.find((r) => r.kind === kind && r.id === id);
      if (!hit) return Promise.resolve([]);            // no row matched → nothing updated, none created
      if (um[1] && toCharUS(hit.updated_at) !== base) return Promise.resolve([]);  // stale base → refused
      hit.state = typeof stateJson === 'string' ? JSON.parse(stateJson) : stateJson;
      hit.updated_at = nextNow();
      return Promise.resolve([writeResult(text, hit)]);
    }
    if (/^update users set state = /.test(text)) {
      throw new Error(
        `fakeDb: unrecognised UPDATE shape — refusing to pretend it matched.\n  ${text}`
      );
    }

    if (text.startsWith('delete from users')) {
      const pred = wherePredicate(text, values);
      const keys = Object.keys(pred);
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (keys.every((k) => rows[i][k] === pred[k])) rows.splice(i, 1);
      }
      return Promise.resolve([]);
    }

    // Analytics ingestion rides along on PUT. BOTH records are kept: the call log above
    // (state-handler.test.mjs reads it) and the ROWS, which is what event de-duplication turns on — "the same
    // event reached the table once" cannot be asked of a recorder.
    if (text.startsWith('insert into events')) {
      events.push({ accountId: values[0], deviceId: values[1], batch: values[2] });
      const skipsDuplicates = /on conflict \(client_id\) do nothing/.test(text);
      const namesClientId = /client_id/.test(text);
      // Postgres 42703, and it outranks the index error below exactly as the real planner does: a
      // statement cannot reference a column that is not there, whether in its target list or in its
      // conflict target. The fallback insert names no client_id and is valid against this table.
      if (namesClientId && !eventsClientIdColumn) {
        return Promise.reject(Object.assign(
          new Error('column "client_id" of relation "events" does not exist'),
          { code: '42703' }));
      }
      // Postgres 42P10: the conflict target must be backed by a unique index. Staged by
      // `eventsIndex: false` — the deploy-order failure, which no other instrument can show.
      if (skipsDuplicates && !eventsIndex) {
        return Promise.reject(Object.assign(
          new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification'),
          { code: '42P10' }));
      }
      const batch = typeof values[2] === 'string' ? JSON.parse(values[2]) : (values[2] || []);
      // Validate the WHOLE batch first, then apply it: one INSERT is atomic, so a unique violation
      // must leave no row behind. Applying row-by-row and throwing halfway would let a test pass
      // against a half-written table no database would produce.
      const taken = new Set(eventRows.map((r) => r.client_id).filter((v) => v != null));
      const keep = [];
      for (const e of batch) {
        // READ FROM THE STATEMENT, not from the batch: a statement that does not name `client_id`
        // stores none, however many ids the payload carries. Without this the fallback insert looked
        // like it wrote the column it exists precisely to avoid naming.
        const cid = (namesClientId && e && e.id != null) ? String(e.id) : null;
        if (eventsIndex && cid != null && taken.has(cid)) {
          // The clause is what makes a repeat harmless. Without it the database REFUSES the whole
          // statement, which is exactly what a client re-sending its buffer would hit.
          if (skipsDuplicates) continue;
          return Promise.reject(Object.assign(
            new Error('duplicate key value violates unique constraint "events_client_id_key"'),
            { code: '23505' }));
        }
        if (cid != null) taken.add(cid);
        keep.push({ e, cid });
      }
      for (const { e, cid } of keep) {
        eventSeq += 1;
        eventRows.push({
          id: eventSeq,
          account_id: values[0] ?? null,
          device_id: values[1] ?? null,
          name: e.name,
          section: e.section ?? null,
          props: e.props ?? {},
          ts: e.ts,
          client_id: cid,
        });
      }
      return Promise.resolve([]);
    }
    if (text.startsWith('update events set account_id')) {
      events.push({ attributed: { accountId: values[0], deviceId: values[1] } });
      // Attribute-on-login, applied to the rows as well: the tests ask what the table holds after
      // a sign-in, which the log could only answer as "the statement ran".
      for (const r of eventRows) {
        if (r.device_id === values[1] && r.account_id == null) r.account_id = values[0];
      }
      return Promise.resolve([]);
    }

    throw new Error(
      `fakeDb: unrecognised query — refusing to pretend it succeeded.\n  ${text}\n` +
      '  Teach the harness this shape, or the test proves nothing.'
    );
  };

  sql.rows = rows;
  sql.events = events;
  /** The `events` TABLE as rows — `sql.events` above is the call log it replaced for
   *  anything asking what is stored. */
  sql.eventRows = eventRows;
  /** How many rows the table holds for `name` — the count "stored exactly once" is asserted on. */
  sql.eventCount = (name) => eventRows.filter((r) => r.name === name).length;
  sql.usage = usage;
  sql.postsSeen = postsSeen;
  // Posts counted for one owner on one day, or 0 — the fairness meter as a test reads it.
  sql.postsFor = (owner_kind, owner_id, day) =>
    usage.find((r) => r.owner_kind === owner_kind && r.owner_id === owner_id && r.day === day)?.posts ?? 0;
  // How many DISTINCT posts the app was billed for on a day — the spend meter.
  sql.spendOn = (day) => [...postsSeen].filter((k) => k.startsWith(`${day}|`)).length;
  sql.queries = queries;
  // The stored row for a (kind, id), or undefined. `kind: undefined` reads pre-fix rows.
  sql.get = (kind, id) => rows.find((r) => r.kind === kind && r.id === id);
  return sql;
}

export function fakeReq({ method = 'GET', query = {}, headers = {}, body = null } = {}) {
  return { method, query, headers, body };
}

// Behaves like a Node response in the one way a header test depends on: once `json()` has sent the body,
// `setHeader` throws `ERR_HTTP_HEADERS_SENT`, and `sentHeaders` records the headers the body actually left
// with. If it accepted a header in any order, a `no-store` set AFTER the
// body would look identical to one set before it — while on Vercel that response would leave without the
// header. Assert on `sentHeaders` whenever WHEN a header was set matters.
export function fakeRes() {
  const res = {
    statusCode: null,
    body: undefined,
    headers: {},
    sentHeaders: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; res.sentHeaders = { ...res.headers }; return res; },
    setHeader(k, v) {
      if (res.sentHeaders) {
        throw Object.assign(new Error(`Cannot set headers after they are sent to the client (${k})`),
          { code: 'ERR_HTTP_HEADERS_SENT' });
      }
      res.headers[k] = v;
      return res;
    },
  };
  return res;
}

// Deep structural equality via canonical JSON — the "byte-identical afterwards" assertion.
// Returns the serialized form so a failure shows what changed.
export function snapshot(value) {
  return JSON.stringify(value);
}

// ── X / feed handler fakes ─────────────────────────────────────────
//
// `test/feed.test.mjs` covers the pure parsers only; these let a test ask
// what the endpoint DOES with a request. `createFeedHandler({ xFetch })` takes the
// client as a parameter; this is what a test passes in.
//
// WHY THIS ONE RECORDS CALLS, when the rest of this file deliberately does not. The rule is to
// assert observable output, never "the function was called" — and `fakeDb` obeys that by being a
// store. Here the outbound request IS the observable: X bills on retrieval, so "did a billable call
// go out" is the quantity the quota exists to control, not a proxy for it. "Returns 429
// and issues no X API call at all" is unassertable any other way.
//
// `pages` is consumed one entry per call, in order:
//   an object   → returned as the parsed JSON body
//   null        → what the real xFetch returns when X_BEARER_TOKEN is unset
//   an Error    → thrown, as the real xFetch does for a 4xx (402 no credits, 429 rate-limited)
// Running past the end THROWS rather than repeating the last page — a silent repeat would let a
// pagination test pass against a loop that never terminates the way the assertion claims.
export function fakeXFetch(pages = []) {
  const calls = [];
  const fn = async (endpoint, params = {}) => {
    calls.push({ endpoint, params });
    if (calls.length > pages.length) {
      throw new Error(
        `fakeXFetch: call ${calls.length} (${endpoint}) has no canned page — refusing to invent one.\n` +
        `  ${pages.length} page(s) were provided. An unplanned call is a finding, not a fixture gap.`
      );
    }
    const next = pages[calls.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

// One users/:id/tweets page, shaped as X API v2 actually returns it — `data` + `includes.users`
// for the permalink handle, and `meta.next_token` when more remain. Built to satisfy the real
// `parseTweets`, so a fixture that stops parsing is a real signal rather than a broken mock.
export function xPage({ ids = [], at = '2026-09-01T10:00:00.000Z', nextToken = null, username = 'sam' } = {}) {
  const page = {
    data: ids.map((id) => ({
      id: String(id),
      text: `post ${id}`,
      created_at: at,
      author_id: 'u1',
    })),
    includes: { users: [{ id: 'u1', username, name: 'Sam' }] },
    meta: {},
  };
  if (nextToken) page.meta.next_token = nextToken;
  return page;
}

// An X 4xx as `xFetch` throws it: a real answer, never retried. 402 = no credits (the app-wide
// cap), 429 = rate-limited.
export function xError(status) {
  return Object.assign(new Error(`X API ${status}`), { status });
}
