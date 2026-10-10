# SousChef

A **finishable feed** for the accounts you follow. Pick your YouTube channels, X accounts and
Substack publications, get one chronological feed, mark items **Done** or **Archive**, and reach
"You're all caught up." No infinite scroll, no algorithm.

Live at **https://trysouschef.vercel.app**

## Features

- **Three sources, one feed.** Add YouTube channels (URL, `@handle`, ID or name, or import your
  subscriptions), X accounts (`@handle`) and Substack publications (URL or name).
- **Keyword filters.** Give a channel keyword chips to see only matching items. Any chip can match;
  a chip with several words needs all of them. Matching ignores case and Turkish diacritics.
- **Read and watch in place.** YouTube plays in the app, with an option to hide Shorts. X posts show
  full text, images, video and quoted posts. Substack posts expand into the full article.
- **Done and Archive.** Done clears an item; Archive saves it for later in its own tab. New items
  since your last visit are badged.
- **Topic grouping (optional).** A switch groups your unread X posts into labelled topic cards, each
  with a short AI summary. It is off by default.
- **Accounts.** Sign in with Google or an emailed magic link. Your channels, archive and settings
  sync across devices, and you can export your data or delete your account from Settings.
- **Light and dark themes.**

## Stack

- **Front end:** vanilla JavaScript, with no framework and no build step.
- **Back end:** Vercel serverless functions in `api/`.
- **Database:** Neon Postgres, through the project's only npm dependency.
- **External services:** YouTube Data API v3, X API v2, Substack RSS, the Anthropic Messages API
  (topic grouping), Resend (sign-in emails) and Google OAuth.

## Run locally

Requires Node 18 or later.

```
npm install
node dev-server.mjs
```

The landing page is at http://localhost:3000 and the app is at http://localhost:3000/app. The
server answers only this computer; use `node dev-server.mjs --lan` to open the app on a phone on the
same network.

Configuration goes in a `.env` file at the repo root:

| Variable | What it enables | Without it |
|---|---|---|
| `DATABASE_URL` | Sign-in and sync (Neon Postgres) | Nobody can sign in |
| `DEV_DATABASE_URL` | A separate development database, used instead of `DATABASE_URL` outside production | `DATABASE_URL` is used |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign in with Google, and YouTube import | The Google button is unavailable |
| `RESEND_API_KEY` | Magic-link emails | No email is sent |
| `YOUTUBE_API_KEY` | The YouTube Data API | Falls back to RSS and page scraping |
| `X_BEARER_TOKEN` | X accounts | X is unavailable |
| `ANTHROPIC_API_KEY` | Topic grouping | The feed stays ungrouped |
| `X_DAILY_POST_QUOTA` | A daily per-person limit on X posts | Usage is counted and nobody is limited |
| `ADMIN_EMAIL` | The usage dashboard at `/admin.html` for that account | The dashboard is closed |

Create the tables once with `node scripts/init-db.mjs`. It is safe to re-run.

**Check which database you are on.** If `DATABASE_URL` is your production database, set
`DEV_DATABASE_URL` to a development one before running anything locally. The dev server prints the
database host when it starts, and scripts that write refuse production unless you pass `--prod`.

**If you fork this:** magic-link emails are sent from the address in `api/_resend.js`. Change it to
a domain you have verified with Resend. The Google OAuth client needs
`<origin>/api/auth/google/callback` as an authorised redirect URI.

## Project layout

```
index.html, landing.js    landing page, served at /
app/index.html            app shell, served at /app
app.js, style.css         client logic and styles
lib/pure.js               pure functions shared by the app and the tests
privacy/index.html        privacy policy, served at /privacy
admin.html, admin.js      usage dashboard
api/                      serverless functions; files starting with _ are helpers, not routes
scripts/                  database setup and maintenance scripts
dev-server.mjs            local server
test/                     tests and fixtures
test-helpers/             test harnesses
```

## Tests

```
npm test
```

The suite uses `node:test`, which is built into Node, so there is no test framework to install. It
covers the server code in `api/`, the pure functions in `lib/pure.js`, and the client logic in
`app.js` and `landing.js`, which the harnesses in `test-helpers/` run against a stubbed browser.
`npm install` sets up a pre-commit hook that runs the suite.

`npm run mutate <spec>` runs a mutation battery: it applies each deliberate breakage listed in a
spec file, runs the suite, and reports which test caught it.

## Contributing

SousChef is developed in a private repository, and this one is a snapshot of its code and tests.
Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), the
[Code of Conduct](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md) for reporting a vulnerability.

## Licence

MIT. See [LICENSE](LICENSE).
