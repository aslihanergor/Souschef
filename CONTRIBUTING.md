# Contributing to SousChef

Thanks for your interest. SousChef is a small project with one maintainer, so this guide is short.
By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## How this repository works

SousChef is developed in a private repository. This public repository is a snapshot of its code and
tests, refreshed at each release as a single commit. That has one consequence worth knowing before
you open a pull request:

- A pull request is reviewed here, in public.
- If it is accepted, the change is applied to the development repository, with you credited as its
  author, and it appears in this repository with the next release.
- So an accepted pull request is closed with a note rather than merged with the green button, and
  your change arrives as part of a release commit. Nothing is lost; it just takes one release.

## Running it

You need Node 18 or newer (the project is developed on Node 20).

```
npm install
node dev-server.mjs      # http://localhost:3000, the app itself is at /app
npm test
```

The app runs without any API keys for YouTube and Substack. X, sign-in and sync need keys and a
database of your own; the README says which environment variables each one reads.

A few tests are skipped in this copy because they check documents that are not published here. That
is expected.

## What makes a good change

- **Open an issue first** for anything larger than a small fix, so we can agree on the approach
  before you spend time on it.
- **Keep it vanilla.** No framework, no build step, and no new dependency without discussing it.
- **Logic comes with tests.** `node:test` is built into Node; look at `test/` for the style. Tests
  assert on what the code produces, not on whether a function was called.
- **Escape what you render.** User and remote strings go through `esc()` before `innerHTML`, and a
  remote URL reaches an `href` only through `safeHref()`.
- **One change per pull request**, with a description of what it does and how you checked it.

## Reporting a security problem

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

SousChef is released under the MIT licence (see `LICENSE`). By contributing you agree that your
contribution is released under the same licence.
