# moss.waifucave.com

The product's page and its docs: a static site built by Bun alone, with no dependency, into plain files that a Worker
with static assets, or any static host, serves at `/` and `/docs/`. Why it looks the way it does is in
[DESIGN.md](DESIGN.md).

## The switch

[`site.json`](site.json) holds the site's switches:

* `release.state`: `"unreleased"` shows "not released yet" and the repository; `"released"` shows a download button
  for each app, system and architecture, named by the release scripts' own artifact table
  (`scripts/release/artifacts.ts`) for `release.version`.
* `release.homebrew`, `release.winget`: `true` once the casks are in `waifucave/homebrew-moss` and the manifests in
  winget, which adds their install lines.

## Commands

Run from this folder with the repository's Bun (`../../scripts/pinned-bun`):

| Command | What it does |
| :- | :- |
| `bun run build` | builds `dist/` |
| `bun run check` | builds, then fails on a broken link or anything loaded from another host, and prints each page's weight |
| `bun run serve` | serves `dist/` on 127.0.0.1:4321 the way the Worker does |
| `bun test` | builds both release states, checks them, checks the facts and words the page must and mustn't say, and checks the docs' sources exist |
| `bun scripts/render.ts --out <folder>` | pictures of every page at 390, 820 and 1440, light and dark, and contact sheets; a headless browser, never in CI |

## Where things are

* `src/landing.ts`: the page; `src/layout.ts`: the frame every page shares; `src/style/site.css`: the look;
  `src/client/main.ts`: the page's one script (the living faces, the docs' search).
* `content/outline.json`: every docs page, written or planned, with the files its facts come from;
  `content/docs/<slug>.md`: the pages written.
* `public/pictures/`: pictures of the apps with sample data, light and dark ([SOURCES.md](public/pictures/SOURCES.md)).
* The faces are the app's own: `packages/plugin-sdk/src/ui/faces/living-bots.js`, bundled in.

## Sentences that wait on other work

A docs sentence that describes work not merged yet ends with a mark in its Markdown, `<!-- pending: <what> -->`, where
`<what>` is one of `PENDING_KINDS` in `src/markdown.ts` (none today: add the kind there first). The build drops the
mark, so it never reaches a page; `grep -rn "pending:" content/docs` finds every such sentence, to check or remove the
mark once the work lands.

## Deploying (the owner's steps: each deploy needs his word)

1. Pick the state in `site.json`, then `../../scripts/pinned-bun run check` in this folder: it must end with `ok`.
2. With the repository installed (`bun install` at its root), sign in once: `../../node_modules/.bin/wrangler login`, with
   the Cloudflare account that holds `waifucave.com`.
3. `../../node_modules/.bin/wrangler deploy --env production` from this folder (the repository's pinned wrangler). It uploads `dist/` as the `moss-site` Worker's static
   assets and attaches the custom domain `moss.waifucave.com` (`wrangler.jsonc`), which makes its DNS record.
4. Open https://moss.waifucave.com and https://moss.waifucave.com/docs/, and check one response's headers carry the
   `Content-Security-Policy` from `dist/_headers`.

The site goes live in the not-released state, with Privacy and Terms as placeholder pages until the first release.
It holds one host, `moss.waifucave.com`, and one Worker, `moss-site`: the services' Workers (`services/*`, named
`moss-*` too) and the web companion's host (`app.moss.waifucave.com`) are theirs, and this deploy touches none of them.

Any other static host works too: serve `dist/` with `/docs` redirecting to `/docs/`, `404.html` for a missing page, and
the headers in `dist/_headers`.
