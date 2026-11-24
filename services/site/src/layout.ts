// The frame every page shares: the head, the top bar and the foot. Nothing here loads from another host: the
// stylesheet, the script and the icons are the site's own files.
import { face, MOSS_PINS } from "./faces";
import { html, raw, type Html } from "./html";
import type { SiteConfig } from "./config";

export interface Assets {
  /** The hashed paths the build wrote, from the site's root. */
  css: string;
  js: string;
}

export interface PageFrame {
  title: string;
  description: string;
  /** The path this page is served at, for the top bar's current link. */
  path: string;
  body: Html;
  assets: Assets;
  config: SiteConfig;
  /** The docs' bar: a search field instead of the download button. */
  docs?: boolean;
}

export function page(f: PageFrame): string {
  const repo = f.config.repository;
  const here = (p: string) => (f.path === p || (p !== "/" && f.path.startsWith(p)) ? raw(' aria-current="page"') : "");
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${f.title}</title>
<meta name="description" content="${f.description}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#FFFFFF">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121212">
<meta name="referrer" content="no-referrer">
<meta property="og:title" content="${f.title}">
<meta property="og:description" content="${f.description}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="${f.assets.css}">
<script type="module" src="${f.assets.js}"></script>
</head>
<body${f.docs === true ? raw(' class="is-docs"') : ""}>
<a class="skip" href="#main">Skip to the content</a>
<header class="top">
<div class="top__in">
<a class="brand" href="/" aria-label="MOSS, home">${face({ name: "MOSS", pins: MOSS_PINS, size: "logo", data: { "data-logo": "" } })}<span class="brand__name">MOSS</span>${f.docs === true ? html`<span class="brand__docs">Docs</span>` : ""}</a>
<nav class="top__nav" aria-label="Site">
<a href="/#code">MOSS Code</a>
<a href="/docs/"${here("/docs/")}>Docs</a>
<a href="${repo}">GitHub</a>
</nav>
${f.docs === true
    ? html`<div class="search" data-search>
<label class="search__label" for="search-input">Search the docs</label>
<input id="search-input" class="search__input" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="search-results" aria-expanded="false" data-search-input>
<div id="search-results" class="search__results" role="listbox" aria-label="Results" hidden data-search-results></div>
</div>`
    : html`<a class="button button--small" href="/#download">Download</a>`}
</div>
</header>
<main id="main" tabindex="-1">
${f.body}
</main>
<footer class="foot">
<div class="foot__in">
<p class="foot__made">MOSS is made by WaifuCave and is open source under the Apache 2.0 license.</p>
<nav class="foot__nav" aria-label="More">
<a href="/docs/">Docs</a>
<a href="${repo}">Source code</a>
<a href="${repo}/releases">Releases</a>
<a href="${repo}/blob/main/SECURITY.md">Report a security problem</a>
<a href="${repo}/blob/main/LICENSE">License</a>
</nav>
<p class="foot__note">This site loads nothing from any other site: no fonts, no analytics, no cookies. Claude Code, Codex and the other coding agents and model providers named here are trademarks of their owners, named only to say what MOSS works with; none of them made or endorses MOSS.</p>
</div>
</footer>
</body>
</html>`.html;
}
