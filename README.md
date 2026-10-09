# SousChef

A **finishable feed** for the accounts you follow. Pick your channels, get one
chronological feed, mark items **Done** (or **Archive** to save for later), and
reach "You're all caught up." No infinite scroll, no algorithm.

v1 aggregates **YouTube** channels, **X (Twitter)** accounts, and **Substack**
publications, with optional keyword filtering, e.g. show only a channel's videos
about *Galatasaray*.

## How it works
- Add **YouTube** channels by URL, `@handle`, channel ID, or plain name; add **X**
  accounts by `@handle`; add **Substack** publications by URL, subdomain, or name.
  Each source has its own tab in the add page.
- **Import your YouTube subscriptions** in one step: "Connect YouTube" (Google OAuth,
  read-only) previews the channels you follow so you can multi-select which to add.
- Optional per-channel keyword filter, entered as removable **chips**: a video shows if
  it matches **any** chip, and a chip with several words needs **all** of them; matching
  is Turkish-diacritic-insensitive (`galatasaray` matches `Galatasaray`).
- Watch YouTube in-app (iframe) or open in YouTube; optionally hide Shorts.
- Read X posts as native, read-only cards: full post text, clickable links,
  multi-image carousels, in-app video/GIF playback, and inline quoted-tweet
  context, with a link out to X for anything more.
- Read **Substack** posts inside SousChef: each card shows the publication, author, title,
  subtitle, cover image, and a bounded opening paragraph — 280 characters, cut at a whole word
  ([BUG-115]) — with a **"…read more"** that expands the full article inline: text, images, and
  formatting (fetched on demand and sanitized server-side). Paywalled posts show their free
  preview and link out for the rest.
- **Topic grouping (X only), off by default:** the feed is chronological unless you ask for
  topics. A **switch** in the feed appbar turns grouping on; it glows when a classify has filed
  something you can open, and your choice is **device-local** (never synced, never arms the sync).
  With it on, your unread **X** posts are grouped into a few labelled **topics**, and a topic
  appears **as a card in the feed itself** — in time order among the posts, not in a separate
  section above them. The card is always open: its label, how many posts it holds, and a
  **swipeable row** whose **first page is a short bullet summary**, followed by the topic's posts,
  each carrying its own **Done** and **Archive**. A **"Mark all done"** in its header clears the
  whole topic at once.
  A card lists only the bullets for posts it can actually open — ones you have **not read yet** and
  that this load fetched — so a topic shrinks as you work through it, and the summary never describes
  a post you cannot reach.
  Videos, Substack posts and any not-yet-grouped X post sit in the same one stream, in time order.
  Grouping is incremental and cached, and falls back to the plain feed if it's unavailable.
- **Archive** ("watch later"): tap **Archive** on any card to move it out of the feed into
  the Archive tab (bottom nav: Archive · Feed); un-archiving returns it. Keeps the feed a
  clean, finishable inbox.
- New items since your last visit are badged **New**; pull down to refresh; the app
  is light by default, with a Dark option in Settings (the sign-in page is always light).
- What you've seen is remembered locally, so the feed stays finishable.
- **Signing in is how you get in.** **Google** (one tap) or a passwordless **magic-link** email; no
  password either way. Both are keyed on your verified email, so they land on the same account. Your
  channels, archive, and settings follow you to any device you sign in on with the same email.
- **A short tour on your first sign-in.** A brand-new account with nothing added gets a dimmed walkthrough over
  the real controls: picking a source, adding a channel, importing your YouTube subscriptions. Once the feed
  has posts it continues with Done, Archive, the topics switch and Settings. Close or Escape ends it, and
  **Settings → Show the tour** replays it.
- **Your data is yours.** Signed in, **Settings** lets you **export your data** as a JSON file
  (channels, read/archive state, preferences) or **delete your account**, which removes everything on
  the server behind a type-your-email confirmation, clears this device's copy, and gives the browser
  a fresh device id so nothing of yours is left for the next person (BUG-017). That browser lands
  back on the sign-in screen — since TASK-084 there is no anonymous mode to return to.
- **The front door:** signed-out visitors get a sign-in screen offering one-tap **Google** or a
  **magic-link** email, and nothing else — **TASK-084 deleted the anonymous skip**, because
  anonymous users can't be reached, interviewed, or counted as people (it made DAU a count of
  browsers). It shows on **every** signed-out load, not just the first, and channels added before
  signing in are adopted into the account rather than stranded.

## Stack
- Vanilla JS front end: the app shell `app/index.html` (served at `/app`) + `app.js` +
  `style.css`, plus a public landing (`index.html` at `/`, whose hero is a scroll-driven canvas
  animation in `landing.js` — TASK-091) and a static privacy page (`privacy/index.html` at
  `/privacy`). No framework, no build step.
- Vercel serverless functions in `api/`.
- External data via the **YouTube Data API v3** (server-side key) for the feed and
  channel resolution, each with a keyless fallback (RSS / HTML scraping).
- **X (Twitter) API v2** (server-side App-only Bearer token) for X account resolution
  and feed, incremental (`since_id`) fetch with a client-side cache. No keyless fallback
  for X.
- **AI topic grouping** via the **Anthropic Messages API** (Claude Haiku 4.5, server-side
  `ANTHROPIC_API_KEY`) behind `/api/group`: a plain `fetch`, no SDK, so the front end stays
  build-free; degrades to the ungrouped feed if the key or call is unavailable.
- **Neon Postgres** datastore (`DATABASE_URL`, server-side) for state persistence via
  `/api/state`, the project's one npm dependency (`@neondatabase/serverless`); the front
  end stays vanilla with no build step.
- **Sign-in** (`api/auth/*`): **Sign in with Google** (OAuth 2.0, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`)
  and a passwordless **magic-link** email via **Resend** (`RESEND_API_KEY`); both open an httpOnly
  session cookie stored in Neon. No new npm dependency: tokens + OAuth use Node's `crypto` and
  plain `fetch`.
- **Account identity** (BUG-013): an account *is* its `accounts.id` (a UUID). A verified **email**
  and a Google **`sub`** are the two external identifiers that resolve to it. Google sign-in matches
  on `sub` first and never rewrites the stored email, because an email can be renamed upstream, or
  recycled to a new person by a Workspace/school domain, and an identity may be neither.
- State lives in the browser's `localStorage`, **written through to the datastore**, keyed by an
  **anonymous device id** when signed out, or by your **account id** when signed in. Signing in syncs
  your feed across devices. `localStorage` is still the render source, so the feed paints without
  waiting on the network — but since TASK-084 *reaching* the app needs a successful session check,
  so an offline boot lands on the sign-in screen (BUG-053).
- **Owner-only usage analytics** (TASK-070): section/action-level events (sign-ins, sections opened,
  features used; never which video/post) buffered client-side and flushed on the `/api/state` PUT
  (no new function), stored in a Neon `events` table; anonymous activity is attributed to the person
  on sign-in. A private dashboard at **`/admin.html`** reads them, gated by `ADMIN_EMAIL`, including a
  live **"Active now"** panel (distinct people active in the last 5 minutes, auto-refreshing every 30s)
  and an **"X cost & volume"** panel (CHR-072) reading TASK-100's two X meters — daily spend, per-person
  volume and the dedup ratio, all on the UTC day X bills on.

## Run locally
```
node dev-server.mjs
```
Then open http://localhost:3000, the public **landing** page; the app itself is at
**http://localhost:3000/app** (`/`, `/app`, `/privacy` all route by file, no Vercel rewrites). Run
`npm install` once (for the Postgres driver). Requires
Node 18+ (developed on Node 20).

The dev server serves only the app's own files and answers only this computer (BUG-131). To open
the app on a phone on the same network, start it with `node dev-server.mjs --lan`.

The app runs **without a key** for YouTube (keyless RSS/scraping fallback). For the full
Data API path locally, put a `YOUTUBE_API_KEY` in a gitignored `.env` at the repo root.
Adding **X** accounts additionally needs an `X_BEARER_TOKEN` in `.env`; there is no
keyless fallback for X. Per-person X limits (TASK-100) are **off unless `X_DAILY_POST_QUOTA`
is set** to a positive integer in `.env`. Unset — or empty, zero, negative or malformed —
means usage is counted but nobody is refused; a typo can never be the thing that blocks every
user's feed. Because that failure is silent, the admin page shows which of those states the
running deployment is actually in (CHR-074). State sync (`/api/state`) needs a `DATABASE_URL` (Neon) in `.env`;
run `node scripts/init-db.mjs` to create the tables — and re-run it after pulling a change that alters
the schema (every statement is `if not exists`, so repeating it is safe). Without `DATABASE_URL` the app
just falls back to `localStorage`-only.

> ### ⚠️ Which database are you pointing at? Use `DEV_DATABASE_URL` locally.
> The Neon integration **owns `DATABASE_URL`** and points Production, Preview *and* Development at
> the **same (production) database**, and Vercel makes integration-managed variables read-only, so
> it can't be repointed per environment. A `vercel env pull` therefore hands you the **production**
> URL, and `node dev-server.mjs` would read and write **real users' rows**.
>
> So set **`DEV_DATABASE_URL`** to a Neon **dev branch** (create one: `npx neonctl branches create
> --name dev`). `api/_db.js` prefers it over `DATABASE_URL` **everywhere except production**: the
> override is ignored when `VERCEL_ENV=production`, so it can never make the live app write to a
> branch. Set it in `.env` locally, and in Vercel for the Development + Preview environments.
>
> Two backstops make the target visible rather than silent (TASK-064): `dev-server.mjs` **prints the
> database host at boot** and shouts if it's production, and every mutating script
> (`init-db.mjs`, `dedupe-events.mjs`, …) **refuses production unless you pass `--prod`** — and with
> `--prod` it targets production (`DATABASE_URL`) and nothing else, refusing any other host (CHR-016).
> New scripts that write should call `scriptDatabaseTarget({ prod })` from `api/_db.js` and connect
> with `neon(target.url)` — not `resolveDatabaseUrl()` + `db()`, which prefers the dev branch on a
> laptop and made `--prod` quietly run there.

Magic-link sign-in additionally needs a `RESEND_API_KEY`
(Resend) in `.env`; without it, sign-in requests are accepted but no email is sent. Emails send
from `login@focus-social.app`, a Resend-**verified** sender domain (`from` is set in
`api/_resend.js`), so links deliver to any address. (If you fork this onto your own Resend account,
you'll need to verify your own domain at resend.com/domains and update that `from`; an unverified
account is limited to delivering only to its own owner address.) **Sign in with Google** needs
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`: an OAuth *Web application* client whose
authorized redirect URI is `<origin>/api/auth/google/callback`; without them the Google button
degrades gracefully to unavailable and the magic link still works.

## Project structure
```
index.html               public landing, served at / — a five-beat scroll story (TASK-069, TASK-091)
landing.js               the landing hero's scroll-driven dot story; external because the CSP
                         forbids inline script on this origin (TASK-091)
privacy/index.html       privacy policy, served at /privacy (TASK-069)
app/index.html           app shell (setup + feed views), served at /app (TASK-069)
app.js                   all client logic (storage, feed, filtering, player, analytics track())
style.css                styles
admin.html / admin.js    owner-only usage-analytics dashboard (TASK-070); reads /api/state?admin
api/feed.js              feed per source: YouTube (Data API/RSS), X (since_id), or Substack (RSS)
api/resolve-channel.js   resolve a YouTube channel, an X @handle, or a Substack publication
api/substack-post.js     fetch + sanitize a full Substack post for the in-app reader (TASK-059)
api/state.js             GET/PUT user state sync + analytics ingest (PUT) & owner dashboard (GET ?admin), Neon (TASK-024/025/070)
api/auth/request.js      POST, mint a magic-link token + email it via Resend (TASK-025)
api/auth/callback.js     GET, verify the link, open a session, redirect home (TASK-025)
api/auth/logout.js       POST, delete the session + clear the cookie (TASK-025)
api/auth/me.js           GET, { email } for a valid session, else 401 (TASK-025)
api/auth/google/[action].js GET, start: redirect to Google's consent + set CSRF state; callback: verify Google, open a session, redirect to /app (TASK-060; one dynamic route, consolidated for the 12-function cap)
api/connect/youtube/[action].js GET, import subscriptions: start→consent, callback→fetch, result→hand off (TASK-015)
api/_youtube.js          server-side Data API client + response parsers (not routed)
api/_youtube_import.js   transient one-time store for the import handoff (not routed) (TASK-015)
api/_twitter.js          server-side X API v2 client + tweet/user parsers (not routed)
api/_substack.js         server-side Substack RSS/page client + parsers (not routed)
api/_sanitize.js         allowlist HTML sanitizer for the Substack reader (not routed)
api/_db.js               Neon Postgres client (not routed)
api/_state.js            pure state helpers: uid/size validation + claim/merge decision (not routed)
api/_events.js           pure analytics helpers: event validation/normalization + owner-email gate (not routed) (TASK-070)
api/_auth.js             pure auth core: token gen/hash, expiry, cookies, rate-limit (not routed)
api/_session.js          session cookie → account resolver (not routed)
api/_resend.js           magic-link email sender via Resend/fetch (not routed)
api/_google.js           pure Google OAuth helpers: auth URL, identity (sub+email), state cookie (not routed)
scripts/init-db.mjs      one-off DB migration (users, accounts, login_tokens, sessions, youtube_imports, events)
scripts/check-rows.mjs   read-only prod row health check; flags BUG-059's fingerprint (--dev for the dev branch)
scripts/mutate.mjs       mutation battery runner: breaks the code on purpose, checks the suite notices (CHR-010)
scripts/measure-substack-openers.mjs
                         measure Substack opening-paragraph lengths through the app's own
                         isSubstackFeed gate — the numbers behind the 280-char cap (BUG-115)
dev-server.mjs           local server: the app's own files + /api handlers, this computer only (--lan opens it)
package.json             npm manifest, one dependency: @neondatabase/serverless
test/                    node:test suites + fixtures
test-helpers/            test harnesses, outside test/ so the runner doesn't collect them:
                         handler.mjs (fake DB for api/ handlers), app-harness.mjs (runs the
                         real app.js in a node:vm context with a stubbed browser),
                         landing-harness.mjs (runs the real landing.js the same way, driving
                         rAF as a queue and deriving the page's geometry from index.html)
vercel.json              Vercel config
```

## Tests
```
npm test                                # -> node --test test/
npm run mutate <spec>                   # -> mutation battery over a spec file
```
`node:test` (zero-dep, built into Node) covers the server side: the **YouTube Data API**
(`api/_youtube.js`), **X API** (`api/_twitter.js`) and **Substack** (`api/_substack.js`) response
parsers against saved fixtures, the Substack **HTML sanitizer** (`api/_sanitize.js`), the **AI
grouping** helpers (`api/_group.js`), the **state helpers** (`api/_state.js`), the **database-URL
resolver** (`api/_db.js`), the **auth core** (`api/_auth.js`), the **Google OAuth helpers**
(`api/_google.js`), and the **analytics event helpers** (`api/_events.js`) — plus the front-end
**pure functions** extracted to `lib/pure.js` (`esc`, `safeHref`, `foldTurkish`, `timeAgo`, and the keyword-chip
trio; TASK-081, BUG-023). Run `npm test` for the current count.

Client-side **exit paths** (`signOut`, `deleteAccount`, `pushNow`) are covered too, via
`test-helpers/app-harness.mjs`, which runs the real `app.js` in a `node:vm` context with a stubbed
browser — logic that can destroy or upload user data is testable without a browser and is tested.
Since TASK-094 the harness also drives `renderFeedResults`, so the render's **routing decisions** —
which cards are held back, which are skipped as already-grouped, which posts reach a billed API call
— are tested too. How a screen *looks* is what stays on verify-by-looking. `npm install`
wires a pre-commit hook that runs the suite, so a red test blocks a commit.

The landing animation is covered the same way, via `test-helpers/landing-harness.mjs`: it runs the
real `landing.js` with `requestAnimationFrame` as a queue the test drives, so "did the loop re-arm?"
is a fact rather than a measurement — a browser cannot answer it, because an automated tab reports
itself hidden and Chrome suspends rAF there. What is tested is when the loop paints and what it
paints; how the stage *looks* stays on verify-by-looking.

A green suite proves the code *ran*, not that a defect would be **noticed**. `npm run mutate`
(CHR-010) answers the second question: it takes a spec of deliberate breakages, applies each one on
its own, runs the suite, restores the file, and reports which **named** test killed it — or that
nothing did. It is manual, run
while building rather than on every commit, and it never touches git: the file is restored from the
bytes read before the run, so an uncommitted fix on disk survives.

Every battery starts with a **control run** — one unmutated pass of the suite — and refuses to go on
unless it is green. Without that, a test that was already failing gets credited to every mutation,
and the tool reports `KILLED` for changes that could not possibly have caused it. If a battery is
interrupted the file is left mutated, and the spec — which states file, find and with — is the record
of what to swap back; the control run is what stops the next battery measuring against it.

## Deploy
Hosted on Vercel (project linked in `.vercel/`).

## Working on this project
SousChef is developed in a private repository; the public copy is a snapshot of its code and tests,
released under the MIT licence (see `LICENSE`). The task history, session notes, changelog and
mutation specs are kept with the development repository and are not published.

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for how pull requests are handled,
the [Code of Conduct](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md) for reporting a vulnerability.
