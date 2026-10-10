// Backend state sync endpoint.
//   GET  /api/state   X-Device-Id: <uuid>          → { state, updatedAt }  (state:null for a new id)
//   PUT  /api/state   X-Device-Id: <uuid>, { state } → { updatedAt }       (last-write-wins)
//
// The PUT body's `state` key is a THREE-way signal, not two:
//   present & an object → claim this state    ·   ABSENT → analytics only, don't touch my row
//   null / array / non-object → 400 (a malformed claim, never read as an abstention)
//
// Owner resolution lives in `resolveOwner` (api/_state.js) and is the security boundary here: a
// valid session cookie pins the owner to that account and any client-supplied id is IGNORED;
// otherwise the request can only address the DEVICE namespace. Rows are keyed by (kind, id), so an
// anonymous request cannot name an account row however it is spelled — in a flat keyspace it could,
// and would read and overwrite other people's channels, done list and archive. A state PUT that declares
// `X-Require-Account: 1` and has no session is refused instead of being written to the device
// namespace, with TWO statuses that the client must not conflate:
//   412  there is no session — checked, and there is none. Retrying cannot help.
//   503  the session could not be CHECKED (the lookup errored). Retrying is exactly what helps, so
//        the client keeps its unsaved mark, its base and its events, as it does when offline.
// Both sit BELOW the 400 and 413 checks: a malformed or over-cap state is answered on its own terms
// whatever the session says, because a 412 tells the client its change is settled and a 413 does not.
// (The order is load-bearing; see the refusal itself.)
//
// ACCEPT-BOTH, ONE RELEASE ONLY: the device id is also still read from the legacy `?uid` query
// param / `uid` body field so a client cached mid-deploy keeps syncing. The query string leaks the
// id into access logs, proxy logs, history and Referer headers, and that id is the row's only
// authenticator — so this fallback is a migration aid, not a supported input. Planned for removal.
//
// If DATABASE_URL is unset the endpoint 503s so the client stays on localStorage.
import { db } from './_db.js';
import { isValidUid, withinSizeCap, resolveOwner, hasUserData, readRev } from './_state.js';
import { sessionAccount } from './_session.js';
import { sanitizeEvents, isOwner } from './_events.js';
import { dauByDay, xMeterRollup } from './_analytics.js';
import { fuseStatus } from './_quota.js';

// Injection seam. The DB client and the session resolver are parameters so the handler
// can run in a test against a fake store — before this, nothing in `api/` had handler tests, and
// the owner-resolution rules below were unprovable. Production behaviour is unchanged: the default
// export binds the real `db`/`sessionAccount` and keeps Vercel's `handler(req, res)` signature.
export function createStateHandler({
  db: dbFn = db,
  sessionAccount: sessionFn = sessionAccount,
  // An injected default, following api/feed.js:24-34's existing pattern rather than
  // inventing one. Additive on purpose: every existing call site and test keeps working untouched,
  // which matters more here than anywhere else in the repo — this factory is the sync endpoint.
  env = process.env,
} = {}) {
  return async function handler(req, res) {
    const sql = dbFn();
    if (!sql) return res.status(503).json({ error: 'state store unavailable' });

    // Signed in → owner is the account id, and no client uid can override it. Account ids are
    // UUIDs too, so downstream validation is unified.
    //
    // ASKED STRICTLY. `sessionAccount` normally answers null both when it
    // found no session and when it could not ask, and only the PUT refusal below needs to tell those
    // apart — a change made during a database outage must stay marked unsaved, where a change made
    // after a real expiry must not. `account` is still null in both cases, so every other branch
    // here (the admin gate, resolveOwner, ingestEvents' attribution) is untouched by the option.
    let account = null;
    let lookupFailed = false;
    try {
      account = await sessionFn(sql, req.headers?.cookie, { strict: true });
    } catch {
      lookupFailed = true;
    }

    if (req.method === 'GET') {
      // Owner-only analytics dashboard. Gated on the session email matching ADMIN_EMAIL —
      // reads the behavioural log nobody else may see. Same function as the sync endpoint (the 12-fn
      // cap rules out a dedicated /api/analytics route).
      if (req.query?.admin != null) {
        if (!isOwner(account?.email, process.env.ADMIN_EMAIL)) {
          return res.status(403).json({ error: 'forbidden' });
        }
        try {
          // Computed HERE rather than inside adminStats, and that placement is the
          // point, not a style choice: adminStats builds `x` in its own try/catch and
          // degrades it to null when a meter query fails, and admin.js returns early when there
          // are no meter rows. A fuse reading living in that panel would therefore go dark on a
          // quiet day and whenever the meters break — an instrument absent exactly when it is
          // needed. It also touches no SQL, so it has no business inside a database rollup.
          const stats = await adminStats(sql, req.query?.tz);
          return res.status(200).json({ ...stats, fuse: fuseStatus(env) });
        } catch {
          return res.status(500).json({ error: 'stats failed' });
        }
      }

      const owner = resolveOwner({
        account,
        headerUid: req.headers?.['x-device-id'],
        legacyUid: req.query?.uid,
      });
      if (!isValidUid(owner.id)) return res.status(400).json({ error: 'invalid uid' });
      try {
        // `kind` here is not decoration, it is the isolation. Without it this read returns whichever
        // row carries that id — which is precisely how an anonymous request read an account row.
        const rows = await sql`
          select state, updated_at, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as rev
          from users where id = ${owner.id} and kind = ${owner.kind}`;
        // `rev` is the row version the client echoes back on its next write. Null when
        // there is no row: a client cannot declare a base it was never given, and a write with no
        // base may CREATE but never overwrite.
        // `kind` tells the client WHICH NAMESPACE answered.
        // Not decoration: `sessionAccount` returns null on a DB blip as well as on expiry, so a
        // signed-in browser's GET can silently resolve to the device namespace, and the response
        // carried nothing it could check that against. A client that adopts such a row loses its own
        // work and then writes its curated list into the anonymous device row — this endpoint's own
        // subject, reached through the affordance built to fix it. Sent on the EMPTY answer too: "no
        // row" is only meaningful once you know which namespace has none.
        //
        // It leaks nothing. Anyone who can name a device id already gets that row's whole state from
        // this same endpoint, and a caller always knows whether it sent a session cookie.
        if (!rows.length) return res.status(200).json({ state: null, updatedAt: null, rev: null, kind: owner.kind });
        return res.status(200).json({ state: rows[0].state, updatedAt: rows[0].updated_at, rev: rows[0].rev, kind: owner.kind });
      } catch {
        return res.status(500).json({ error: 'read failed' });
      }
    }

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
      // A body that did not parse, or was never JSON, is a client error — not an abstention. The
      // events-only rule below reads a missing `state` key as "analytics only", and every non-object
      // body has a missing `state` key, so without this guard a client whose requests are broken
      // would stop syncing forever while every response said OK — losing its events too, since
      // pushNow drains them on `ok`. It also makes `body.x` below safe to write unguarded.
      //
      // A POSITIVE plain-object check, deliberately. Ruling out `null`, non-objects and arrays is
      // not enough: Vercel's Node runtime hands the handler a raw Buffer for any content-type it
      // does not recognise, and a Buffer passes both of those tests.
      if (!body || Object.getPrototypeOf(body) !== Object.prototype) {
        return res.status(400).json({ error: 'body must be an object' });
      }
      // The device id is read the same way on both verbs so there is one rule to reason about.
      const deviceUid = (typeof req.headers?.['x-device-id'] === 'string' && req.headers['x-device-id'])
        ? req.headers['x-device-id']
        : body.uid;
      const owner = resolveOwner({ account, headerUid: deviceUid });
      // Stays ahead of everything, including the events-only path: a request nobody can be
      // identified from must not write events rows with both ids null.
      if (!isValidUid(owner.id)) return res.status(400).json({ error: 'invalid uid' });

      // THE CALLER DECLARES INTENT. An ABSENT `state` key means "I am
      // not claiming any state — these are analytics only", which is what track()'s 3s flush and an
      // unload flush with nothing pending always mean. The server cannot infer it: a browser that
      // never loaded its row (a failed boot GET) sends an empty state that is byte-identical to a
      // deliberate "I removed every channel" clear, and the update branch below dutifully destroys
      // the account's channels. Only the client knows which one it meant, so only the client can say.
      //
      // Strict `===`. `null` is what a broken serializer produces, not something a client chooses;
      // it stays a 400 alongside arrays and non-objects.
      const eventsOnly = body.state === undefined;
      // A SIGNED-IN PAGE'S SAVE IS REFUSED, NEVER DOWNGRADED. `sessionAccount` USED TO answer
      // null for an expired session and for a database error alike, and `resolveOwner` then addresses the
      // device namespace — so a save from a page that believes it is signed in was written into an
      // anonymous device row and answered 200 with that row's `rev`. The page re-based onto it, and its
      // next healthy save was refused behind "Not syncing", across reloads. Only the
      // client knows what it believes, so it says so, and the server refuses rather than guess.
      //
      // THIS CALLER ASKS STRICTLY, so the two answers are separate here: a lookup
      // that errored is 503 and a lookup that found nothing is 412 — see the refusal itself below.
      // Everywhere else `sessionAccount` still flattens both to null, deliberately.
      //
      // Not 401 for either: the client needs a 401 to mean the session is gone, and neither of
      // these does. Not 409: that tells the client its base is stale and halts it. And BEFORE the events
      // are recorded, not only before the write: the client keeps a refused push's events and sends them
      // again, so recording them here would count them twice.
      //
      // Analytics-only PUTs are not refused — they claim no state, so they cannot land in the wrong row.
      // A PUT without the header is unchanged: old clients, signed-out pages, and sign-out's own save,
      // which is exempt on purpose (see `_signOut` in app.js).
      // `account.accountId`, not bare `account`: the condition must be exactly the one under which
      // resolveOwner would NOT address the account, or a truthy answer without an id slips past the refusal
      // into a device row.
      //
      // THE REFUSAL ITSELF LIVES BELOW, inside the state branch and after the 400/413 checks — see
      // the comment at the `x-require-account` test there for why the order is load-bearing.
      //
      // The base this client declares it is writing against. Header only — it is not user data and
      // has no business in the body alongside the legacy `uid`.
      const rev = readRev(req.headers?.['x-state-rev']);
      let updatedAt = null;
      let outRev = null;
      // Set when the server REFUSED the write. Not an early return: the buffered analytics on this
      // PUT are attributed independently of the state row and must still be ingested,
      // or a client whose sync is halted also stops reporting — exactly when we most want to know.
      let conflict = false;
      if (!eventsOnly) {
        const state = body.state;
        if (state === null || typeof state !== 'object' || Array.isArray(state)) {
          return res.status(400).json({ error: 'state must be an object' });
        }
        if (!withinSizeCap(state)) return res.status(413).json({ error: 'state too large' });
        // THE REFUSAL — after the shape and size checks, before the write and before ingestEvents.
        //
        // Order first, because it is the half that cost data. A 412 tells the client its change is
        // settled (the mark is cleared and the change is owed only within the page); a 413 tells it
        // nothing was stored and the mark stays. With the refusal ahead of the size check, a store
        // over the cap whose session had really ended was answered "account required" instead of
        // "too large", dropped its mark, and had its whole local copy replaced by the row on the next
        // boot — measured: 30002 read marks going to 1.
        // A state that is malformed or too large is malformed or too large whatever the session
        // says, so those answers outrank the refusal.
        //
        // No `!eventsOnly` term: this sits inside the state branch, so an analytics-only PUT never
        // reaches it. That was a term of the predicate when the refusal lived above; here it is
        // enforced by position, and repeating it would be a condition that cannot be false. The
        // mutation that tests it is "move this block back out of the branch", not "delete a term".
        //
        // 503 vs 412 — the distinction this release exists for. 503: the session could not be
        // checked, so the client must keep its unsaved mark and try again, exactly as when offline.
        // 412: the session was checked and there is none, so retrying cannot help. Not 401 (a blip is
        // not a sign-out, and the client needs 401 to mean the session is gone), and not 409
        // (that tells the client its base is stale and halts it behind "Not syncing").
        if (!(account && account.accountId) && req.headers?.['x-require-account'] === '1') {
          if (lookupFailed) return res.status(503).json({ error: 'session lookup failed' });
          return res.status(412).json({ error: 'account required' });
        }
        try {
          // `on conflict (kind, id)` — the composite key. An anonymous PUT carrying an account id
          // lands on ('device', thatId), an ordinary row of its own, and cannot collide with the
          // account. Conflicting on `id` alone would have overwritten the account row instead.
          //
          // Guarding THE UPSERT with a WHERE makes its response an existence oracle, and that is
          // accepted: this endpoint's GET already returns a device row's WHOLE STATE to
          // anyone who can name the id, so a 200-vs-409 distinction leaks strictly less than what is
          // already on offer, and refusing a stale write is worth more than hiding a fact that is
          // not hidden anyway.
          //
          // `kind` is load-bearing in the UPDATE below for exactly the same reason it is in the
          // conflict target: without it, `where id = …` reaches across the namespace and an
          // anonymous request empties any account row whose id it can name — a cross-namespace overwrite in a
          // statement `grep "on conflict"` does not find. Pinned by the two empty-state isolation
          // tests in test/state-handler.test.mjs.
          // (The oracle argument does NOT transfer: this branch already answers `updatedAt: null`
          // vs a timestamp. That leaks strictly less than GET, which returns the row's whole state
          // to anyone who can name a device id, so it costs nothing new.)
          //
          // A PUT carrying NO user data may update a row, but must never create one.
          // An empty browser used to manufacture a row nobody asked for; a second browser holding
          // real channels then signed in, found a row, and pulled the empty one down over its own
          // state (measured: 3 channels + 2 done -> 0 and 0).
          //
          // Creation is the only thing restricted. An empty row that ALREADY exists still wins on
          // read, because removing every channel is a real action that has to sync — see
          // test/state.test.mjs's "a cleared account". Inverting that would break a deliberate
          // clear: on the wire it is byte-identical to an accidental one, so the server cannot tell
          // them apart and must not try. That is why intent is declared by the caller.
          //
          // Which does NOT mean the server can relax: it still cannot tell an accidental empty state
          // from a deliberate clear, and must not try. What changed is who is filtered upstream. The
          // client declares intent on the paths with nothing to claim (the analytics flush, an unload
          // flush with nothing pending, a sign-out with nothing to save), and it also
          // withholds state entirely on a document that never learned what the server holds — a boot
          // whose GET failed. So the "ordinary mutation after a failed read" that used to arrive here
          // looking exactly like a clear no longer arrives at all. An OLD client still sends it (the
          // fix is client-side, so a tab open across the deploy keeps the old behaviour until it
          // reloads), and this branch would still write it. See app.js's `_stateLoaded`.
          // REFUSE A STALE WRITE. The rule, in one line: **create is always allowed,
          // overwrite never is unless the client declares the base it read.**
          //
          // The guard is evaluated inside the statement, under the row lock, against the PRE-update
          // row — so two clients declaring the same base cannot both win, and the decision is
          // derived from `rows.length` rather than asserted separately.
          //
          // BOTH write paths take it, and that is not symmetry for its own sake: the bare UPDATE
          // below replaces the whole state blob exactly as the upsert does. A control
          // run measured an empty browser's blob landing through the UPDATE branch onto a
          // populated row — 200 OK, channels and done silently emptied. Guarding only the upsert
          // would leave that measured path open.
          if (hasUserData(state)) {
            const rows = rev
              ? await sql`
                  insert into users (kind, id, state, updated_at)
                  values (${owner.kind}, ${owner.id}, ${JSON.stringify(state)}::jsonb, now())
                  on conflict (kind, id) do update set state = excluded.state, updated_at = now()
                  where to_char(users.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') = ${rev}
                  returning updated_at, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as rev`
              // No base declared. `do nothing` keeps adopt-on-login working (a first sign-in has no
              // base and must still claim its own feed) while making an overwrite impossible. Accepting
              // an unbound write unconditionally is not an option: since `SK.rev` is acquired only by an
              // applied pull or an accepted push, the FIRST push after deploy has no base — which is
              // the dangerous one.
              : await sql`
                  insert into users (kind, id, state, updated_at)
                  values (${owner.kind}, ${owner.id}, ${JSON.stringify(state)}::jsonb, now())
                  on conflict (kind, id) do nothing
                  returning updated_at, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as rev`;
            // Zero rows can only mean the row existed and this client had no standing to replace it:
            // had there been no row, the insert itself would have happened.
            if (rows.length) { updatedAt = rows[0].updated_at; outRev = rows[0].rev; }
            else conflict = true;
          } else {
            // Carries no user data, so it may update a row but must never create one (an
            // empty browser used to manufacture a row that a populated browser then pulled down over
            // its own state — measured there at 3 channels + 2 done to 0 and 0).
            const rows = rev
              ? await sql`
                  update users set state = ${JSON.stringify(state)}::jsonb, updated_at = now()
                  where kind = ${owner.kind} and id = ${owner.id}
                    and to_char(users.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') = ${rev}
                  returning updated_at, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as rev`
              // No base and nothing to create: there is no write this request is entitled to make.
              // Deliberately runs NO statement rather than an unguarded UPDATE.
              : [];
            if (rows.length) { updatedAt = rows[0].updated_at; outRev = rows[0].rev; }
            else {
              // Zero rows is ambiguous on this path — no row at all, or a row whose base did not
              // match. Those are 200 and 409, and conflating them either hides a refusal or invents
              // one. A client with nothing curated yet must be told plainly that nothing was stored
              //; a client whose base is stale must be told it was refused.
              const exists = await sql`
                select 1 as one from users where id = ${owner.id} and kind = ${owner.kind}`;
              if (exists.length) conflict = true;
              // else: nothing to update and nothing to create. A success with `updatedAt: null`,
              // which is what lets the client stop reporting a save that never happened.
            }
          }
        } catch {
          return res.status(500).json({ error: 'write failed' });
        }
      }
      // Analytics ingestion rides along on the state PUT so it needs no new endpoint
      // (we sit at the 12-fn cap). Strictly best-effort: a failed event write must never fail the
      // state sync above. The device id is sent even when signed in (that's what makes
      // attribute-on-login work), so it comes from `deviceUid` rather than from the owner.
      // Runs on BOTH paths — carrying analytics is the entire reason an events-only PUT exists.
      try {
        await ingestEvents(sql, {
          accountId: account ? account.accountId : null,
          deviceId: isValidUid(deviceUid) ? deviceUid : null,
          events: body.events,
        });
      } catch { /* best-effort — swallow */ }
      // The 409 carries NO rev, deliberately. Handing the current base back would let a client
      // re-base from a refusal and immediately retry — re-arming the overwrite this exists to
      // prevent. The base may be refreshed only by a pull the client applied or a push the server
      // accepted, and a 409 is neither.
      if (conflict) return res.status(409).json({ error: 'stale state' });
      return res.status(200).json({ updatedAt, rev: outRev });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  };
}

export default createStateHandler();

// Append a batch of validated events, then (when signed in) attribute this device's earlier
// anonymous events to the account — the "capture everyone, attribute on login" model.
async function ingestEvents(sql, { accountId, deviceId, events }) {
  const clean = sanitizeEvents(events, Date.now());
  if (clean.length) {
    const batch = JSON.stringify(clean);
    // One round-trip for the whole batch: jsonb_to_recordset expands the array server-side.
    //
    // `on conflict (client_id) do nothing` is what makes delivery at-least-once safe: a
    // closing page CANNOT know whether its send landed (it never reads the answer), so the client
    // keeps sending and the table decides. The target is backed by `events_client_id_key`; nulls are
    // distinct in a unique index, so rows from before this shipped — and any event whose id did not
    // validate — insert exactly as they used to.
    try {
      await sql`
        insert into events (account_id, device_id, name, section, props, created_at, client_id)
        select ${accountId}::uuid, ${deviceId}, e.name, e.section, e.props, to_timestamp(e.ts / 1000.0), e.id
        from jsonb_to_recordset(${batch}::jsonb)
          as e(name text, section text, props jsonb, ts double precision, id text)
        on conflict (client_id) do nothing`;
    } catch (err) {
      // THE DEPLOY-ORDER GUARD, and the direction is the point. If this code reaches a database whose
      // migration has not run, the caller's best-effort catch would swallow the error while the
      // response still said 200 — so the client would drop events that were never stored. Every
      // analytics event, silently, until someone noticed. Falling back to the plain insert fails
      // toward COUNTING TWICE, never toward counting nothing.
      //
      // TWO SQLSTATES, because an un-migrated table is missing BOTH things and answers for the
      // column first. Measured against a real Postgres, not reasoned:
      //   42703 undefined_column — no `client_id` at all: "column "client_id" of relation "events"
      //         does not exist". THIS is what the ordinary deploy order produces (a merge deploys
      //         the code; `init-db` is run by hand). Matching 42P10 alone would let the one case
      //         the fallback exists for fall straight through to the swallow.
      //   42P10 invalid_column_reference — the column exists but its unique index does not.
      // The fallback statement names no `client_id`, so it is valid under both.
      //
      // Narrow on purpose: only these. Anything else (a blip, a real constraint violation) is
      // rethrown, and the caller drops the batch exactly as it does today — retrying here could
      // double-insert a batch whose first attempt had actually committed. Matched on the codes AND
      // the messages because a driver that loses `code` would otherwise turn this guard off without
      // a word; `sql.transaction` in particular is documented to reshape errors.
      const text = String((err && err.message) || '');
      const unmigrated = (err && (err.code === '42P10' || err.code === '42703'))
        || /no unique or exclusion constraint/i.test(text)
        || /column "client_id"/i.test(text);
      if (!unmigrated) throw err;
      await sql`
        insert into events (account_id, device_id, name, section, props, created_at)
        select ${accountId}::uuid, ${deviceId}, e.name, e.section, e.props, to_timestamp(e.ts / 1000.0)
        from jsonb_to_recordset(${batch}::jsonb)
          as e(name text, section text, props jsonb, ts double precision)`;
    }
  }
  // Idempotent + cheap (partial index): only rows still lacking an account match. Runs on every
  // authenticated PUT; steady-state it stamps nothing. Note: attributes ALL of a device's prior
  // anonymous events to the signer — acceptable for a personal/trusted-circle tool.
  if (accountId && deviceId) {
    await sql`update events set account_id = ${accountId}::uuid
              where device_id = ${deviceId} and account_id is null`;
  }
}

// Owner-only analytics rollups. `tz` is an IANA zone from the client so day/hour buckets
// read in the viewer's local time; it's a bound parameter (no SQL injection) but still validated so a
// bad value falls back to UTC instead of throwing. All counts cast to int for clean JSON.
async function adminStats(sql, tzRaw) {
  const tz = (typeof tzRaw === 'string' && /^[A-Za-z0-9_/+-]{1,63}$/.test(tzRaw)) ? tzRaw : 'UTC';

  // Owner exclusion. The developer tests constantly, so their own traffic would dominate
  // the active-user readouts and make them look like signal. Resolve the ADMIN_EMAIL account and
  // every device-id ever attributed to it, and exclude both from the TWO active-user metrics below:
  // "Active now" and DAU. (The descriptive rollups — totals, People, byDay volume, sign-ins — still
  // count everyone on purpose; they're a roster/volume view, not an active-user signal.) A friend's account counts
  // as a real user — only the owner account is excluded. No new env var: ADMIN_EMAIL already gates
  // this endpoint. If it doesn't resolve, nothing is excluded (degrades loud, not silent — DAU sits
  // at the raw people count, the tell to check the env var).
  const ownerEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const ownerAccounts = ownerEmail
    ? await sql`select id from accounts where lower(email) = ${ownerEmail}`
    : [];
  const ownerAccountIds = ownerAccounts.map((r) => r.id);
  const ownerDevices = ownerAccountIds.length
    ? await sql`select distinct device_id from events
                where account_id = any(${ownerAccountIds}::uuid[]) and device_id is not null`
    : [];
  const ownerDeviceIds = ownerDevices.map((r) => r.device_id);

  const [totals] = await sql`
    select count(*)::int as events,
           count(*) filter (where account_id is not null)::int as identified,
           count(*) filter (where account_id is null)::int as anonymous,
           count(distinct account_id)::int as accounts
    from events`;

  // Who signs in + when: per-account rollup (email, activity span, sign-in count). This is the
  // direct answer to "see the people who log in".
  const people = await sql`
    select a.email, a.id as account_id,
           count(*)::int as events,
           count(*) filter (where e.name = 'signin')::int as signins,
           min(e.created_at) as first_seen,
           max(e.created_at) as last_active
    from events e join accounts a on a.id = e.account_id
    group by a.email, a.id
    order by last_active desc
    limit 200`;

  const eventCounts = await sql`
    select name, count(*)::int as count from events group by name order by count desc`;

  const byDay = await sql`
    select to_char((created_at at time zone ${tz})::date, 'YYYY-MM-DD') as day,
           count(*)::int as events,
           count(distinct account_id)::int as accounts
    from events
    where created_at > now() - interval '30 days'
    group by day order by day`;

  const byHour = await sql`
    select extract(hour from (created_at at time zone ${tz}))::int as hour,
           count(*)::int as events
    from events group by hour order by hour`;

  const recentSignins = await sql`
    select a.email, e.created_at as at
    from events e join accounts a on a.id = e.account_id
    where e.name = 'signin'
    order by e.created_at desc limit 50`;

  // "Active now" — distinct people with any event in the last 5 minutes, OWNER-EXCLUDED (same rule
  // as DAU below, so the two active-user readouts agree). A person is an account (identified) or a
  // device (anonymous); coalesce(account_id, device_id) is the person key — kept identical to the
  // `dauRows` query below; change the definition in one, change it in the other. Events flush within
  // a few seconds of happening, so this is a near-live signal, not exact presence.
  const activeNow = await sql`
    select coalesce(a.email, 'anonymous') as who,
           (e.account_id is not null) as identified,
           count(*)::int as events,
           max(e.created_at) as last_active
    from events e
    left join accounts a on a.id = e.account_id
    where e.created_at > now() - interval '5 minutes'
      and (e.account_id is null or e.account_id <> all(${ownerAccountIds}::uuid[]))
      and (e.device_id is null or e.device_id <> all(${ownerDeviceIds}::text[]))
    group by coalesce(e.account_id::text, e.device_id), a.email, (e.account_id is not null)
    order by last_active desc
    limit 100`;

  // Daily active users (owner-excluded), split into new vs returning — the real active-user
  // measure the plain byDay `count(distinct account_id)` never was (it drops anonymous rows and
  // never de-dupes a person across their device + account). A "person" is
  // coalesce(account_id, device_id) — the SAME person key as the `activeNow` query above; keep the
  // two in sync. `first_day` is their first-ever active day over ALL history — NOT windowed — so
  // someone first seen 40 days ago reads as returning, not new. The 30-day filter is applied only to
  // the rows returned; classification (new vs returning, per-day de-dupe) happens in dauByDay()
  // (pure, unit-tested). `select distinct` collapses the per-event `ev` rows to one per
  // (person, day) BEFORE the wire, so the response is O(person-days), not O(events) — without it a
  // busy month ships thousands of duplicate rows that dauByDay would just fold away. `ev` still
  // scans all events to get an honest first_day; fine at this volume, revisit if the log grows.
  const dauRows = await sql`
    with ev as (
      select coalesce(account_id::text, device_id) as person,
             (created_at at time zone ${tz})::date as day
      from events
      where coalesce(account_id::text, device_id) is not null
        and (account_id is null or account_id <> all(${ownerAccountIds}::uuid[]))
        and (device_id is null or device_id <> all(${ownerDeviceIds}::text[]))
    ),
    firsts as (select person, min(day) as first_day from ev group by person)
    select distinct to_char(e.day, 'YYYY-MM-DD') as day,
           e.person as person,
           to_char(f.first_day, 'YYYY-MM-DD') as first_day
    from ev e join firsts f using (person)
    where e.day > (now() at time zone ${tz})::date - 30`;
  const dau = dauByDay(dauRows.map((r) => ({ person: r.person, day: r.day, firstDay: r.first_day })));

  // X cost & volume meters (CHR-072). In their OWN try/catch, and that is the whole point: the
  // caller wraps adminStats in a single catch that answers 500, so one query against a table a
  // database has not migrated yet would take down all eight rollups above with it. This panel
  // degrades to null — an empty section beside a working dashboard.
  //
  // Owner INCLUDED here, unlike the two active-user metrics above. Inverting the owner-exclusion
  // rule is deliberate: before launch the owner's account is the only one with meter rows at all,
  // so excluding her would empty the only panel that has data.
  //
  // Both tables key on a UTC date, while every rollup above buckets by ${tz}. The two therefore
  // describe different 24-hour windows for anyone not on UTC, and that CANNOT be reconciled here —
  // the per-post timestamps needed to re-bucket are not kept. The UI labels these UTC instead.
  let x = null;
  try {
    const spendRows = await sql`
      select to_char(day, 'YYYY-MM-DD') as day, count(*)::int as posts
      from x_posts_seen
      where day > (now() at time zone 'UTC')::date - 30
      group by day order by day`;
    // a.id::text = u.owner_id, never u.owner_id::uuid. To be exact about why:
    // every owner_id the APP can write today IS a uuid —
    // api/feed.js only takes the device branch under isValidUid, which is a uuid regex. The cast
    // direction is defence-in-depth rather than a live hazard: x_usage.owner_id is a `text` column
    // with nothing enforcing that shape, so one hand-written or future-written row that is not a
    // uuid would make `owner_id::uuid` raise for the WHOLE query and empty the panel. Casting the
    // uuid side to text cannot fail. (It also forgoes an index on accounts.id — irrelevant here.)
    //
    // No owner exclusion, no ${tz}: the owner stays IN (before launch her account is
    // the only one with rows) and both meters stay on the UTC day X bills on. Both are
    // pinned in test/admin-x-sql.test.mjs, because neither is reachable from a handler test.
    const volumeRows = await sql`
      select to_char(u.day, 'YYYY-MM-DD') as day,
             u.owner_kind as "ownerKind",
             u.owner_id   as "ownerId",
             u.posts::int as posts,
             a.email      as email
      from x_usage u
      left join accounts a on u.owner_kind = 'account' and a.id::text = u.owner_id
      where u.day > (now() at time zone 'UTC')::date - 30`;
    // Deliberately UNCAPPED, unlike people/activeNow/recentSignins above. Those are display-only
    // lists where a cap drops rows nobody sums; these rows are SUMMED into the daily volume and the
    // dedup ratio, so a LIMIT would silently understate both — a truncated ratio reads as better
    // dedup than reality. Bounded instead by the data: one row per owner per day over a 30-day
    // window, so 20 users is ~600 rows and 100 users ~3,000. Revisit by aggregating per-day in SQL
    // if that ever stops being small.

    x = xMeterRollup({ spendRows, volumeRows, today: new Date().toISOString().slice(0, 10) });
  } catch {
    x = null; // missing tables or a failed rollup — the panel empties, the dashboard survives.
  }

  return { tz, totals, people, eventCounts, byDay, byHour, recentSignins, activeNow, dau, x };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
