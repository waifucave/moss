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
* `hero`: the opening, `"list"` (a bot list whose bots work) or `"name"` (type a name, see its bot).

## Commands

Run from this folder with the repository's Bun (`../../scripts/pinned-bun`):

| Command | What it does |
| :- | :- |
| `bun run build` | builds `dist/` |
| `bun run check` | builds, then fails on a broken link or anything loaded from another host, and prints each page's weight |
| `bun run serve` | serves `dist/` on 127.0.0.1:4321 the way the Worker does |
| `bun test` | builds both release states and both openings, checks them, and checks the docs' sources exist |
| `bun scripts/render.ts --out <folder>` | pictures of every page at 390, 820 and 1440, light and dark, and contact sheets; a headless browser, never in CI |

## Where things are

* `src/landing.ts`: the page; `src/layout.ts`: the frame every page shares; `src/style/site.css`: the look;
  `src/client/main.ts`: the page's one script (the living faces, the docs' search).
* `content/outline.json`: every docs page, written or planned, with the files its facts come from;
  `content/docs/<slug>.md`: the pages written.
* `public/pictures/`: pictures of the apps with sample data, light and dark ([SOURCES.md](public/pictures/SOURCES.md)).
* The faces are the app's own: `packages/plugin-sdk/src/ui/faces/living-bots.js`, bundled in.

## Deploying (the owner's steps; nothing here has been deployed)

1. Pick the state in `site.json`, then `../../scripts/pinned-bun run check` in this folder: it must end with `ok`.
2. With the repository installed (`bun install` at its root), sign in once: `../../node_modules/.bin/wrangler login`, with
   the Cloudflare account that holds `waifucave.com`.
3. `../../node_modules/.bin/wrangler deploy --env production` from this folder (the repository's pinned wrangler). It uploads `dist/` as the `moss-site` Worker's static
   assets and attaches the custom domain `moss.waifucave.com` (`wrangler.jsonc`), which makes its DNS record.
4. Open https://moss.waifucave.com and https://moss.waifucave.com/docs/, and check one response's headers carry the
   `Content-Security-Policy` from `dist/_headers`.

Any other static host works too: serve `dist/` with `/docs` redirecting to `/docs/`, `404.html` for a missing page, and
the headers in `dist/_headers`.
