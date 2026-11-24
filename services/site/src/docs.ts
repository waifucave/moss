// /docs: the written pages (content/docs/<slug>.md), in the order and groups of the outline (content/outline.json),
// the docs' home, the outline page listing every page planned, and the search index the page searches offline.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, SITE_DIR, type SiteConfig } from "./config";
import { html, raw, type Html } from "./html";
import { downloads } from "./downloads";
import { renderDoc, type Blocks, type RenderedDoc } from "./markdown";

export interface OutlinePage {
  slug: string;
  title: string;
  summary: string;
  sources: string[];
}

export interface OutlineGroup {
  title: string;
  pages: OutlinePage[];
}

export function readOutline(): OutlineGroup[] {
  const o = JSON.parse(readFileSync(join(SITE_DIR, "content", "outline.json"), "utf8")) as { groups: OutlineGroup[] };
  const seen = new Set<string>();
  for (const g of o.groups) for (const p of g.pages) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug)) throw new Error(`outline: "${p.slug}" is not a slug`);
    if (seen.has(p.slug) || p.slug === "outline") throw new Error(`outline: "${p.slug}" twice, or a reserved name`);
    seen.add(p.slug);
  }
  return o.groups;
}

/** The repository path a source names (the part before a space and a section). */
export function sourcePath(source: string): string {
  return source.split(" ")[0]!;
}

export function docFile(slug: string): string {
  return join(SITE_DIR, "content", "docs", `${slug}.md`);
}

export interface WrittenPage extends OutlinePage {
  group: string;
  doc: RenderedDoc;
}

/** The installers of a release, by system, as the release scripts name them, with `<version>` for the number. */
function releaseFiles(repository: string): string {
  const PLACE = "0.0.0";
  const apps = downloads(PLACE, repository);
  const names = (files: { name: string }[]) => files.map((f) => `<code>${f.name.replace(PLACE, "&lt;version&gt;")}</code>`).join("<br>");
  const rows = apps[0]!.systems.map((s, i) => `<tr><td>${s.name}<br><span class="note">${s.detail}</span></td>${apps.map((a) => `<td>${names(a.systems[i]!.files)}</td>`).join("")}</tr>`);
  return `<div class="table"><table><thead><tr><th>System</th>${apps.map((a) => `<th>${a.name}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

export function writtenPages(outline: OutlineGroup[], repository = "https://github.com/waifucave/moss"): WrittenPage[] {
  const blocks: Blocks = { "release-files": () => releaseFiles(repository) };
  return outline.flatMap((g) => g.pages.filter((p) => existsSync(docFile(p.slug))).map((p) => ({
    ...p, group: g.title, doc: renderDoc(readFileSync(docFile(p.slug), "utf8"), `content/docs/${p.slug}.md`, blocks),
  })));
}

export const docUrl = (slug: string): string => `/docs/${slug}/`;

function sourceLink(repo: string, source: string): Html {
  const path = sourcePath(source);
  const rest = source.slice(path.length).trim();
  const abs = join(REPO_ROOT, path);
  const kind = existsSync(abs) && statSync(abs).isDirectory() ? "tree" : "blob";
  return html`<li><a href="${repo}/${raw(kind)}/main/${path}">${path}</a>${rest !== "" ? html` ${rest}` : ""}</li>`;
}

function nav(outline: OutlineGroup[], written: Set<string>, current: string): Html {
  const here = (url: string) => (url === current ? raw(' aria-current="page"') : "");
  return html`<nav class="docnav" aria-label="Docs">
<details data-docnav open>
<summary>All docs pages</summary>
<div class="docnav__sticky">
<div class="docnav__group"><ul><li><a href="/docs/"${here("/docs/")}>Docs home</a></li></ul></div>
${outline.filter((g) => g.pages.some((p) => written.has(p.slug))).map((g) => html`<div class="docnav__group">
<h2>${g.title}</h2>
<ul>${g.pages.filter((p) => written.has(p.slug)).map((p) => html`<li><a href="${docUrl(p.slug)}"${here(docUrl(p.slug))}>${p.title}</a></li>`)}</ul>
</div>`)}
<div class="docnav__group"><ul><li><a href="/docs/outline/"${here("/docs/outline/")}>Every page, planned too</a></li></ul></div>
</div>
</details>
</nav>`;
}

function toc(page: WrittenPage): Html {
  const hs = page.doc.headings;
  if (hs.length < 2) return html`<aside class="toc" aria-label="On this page"></aside>`;
  return html`<aside class="toc" aria-label="On this page"><div class="toc__sticky">
<h2>On this page</h2>
<ul>${hs.map((h) => html`<li${h.level === 3 ? raw(' class="toc__sub"') : ""}><a href="#${h.id}">${h.text}</a></li>`)}</ul>
</div></aside>`;
}

export interface DocsPage {
  url: string;
  title: string;
  description: string;
  body: Html;
}

export function docsPages(config: SiteConfig): { pages: DocsPage[]; search: unknown } {
  const outline = readOutline();
  const written = writtenPages(outline, config.repository);
  const writtenSlugs = new Set(written.map((p) => p.slug));
  const repo = config.repository;
  const pages: DocsPage[] = [];

  written.forEach((p, i) => {
    const prev = written[i - 1], next = written[i + 1];
    const url = docUrl(p.slug);
    pages.push({
      url, title: `${p.doc.meta.title}: MOSS docs`, description: p.doc.meta.description,
      body: html`<div class="docs">
${nav(outline, writtenSlugs, url)}
<article class="doc">
<header class="doc__head">
<p class="doc__where">${p.group}</p>
<h1>${p.doc.meta.title}</h1>
<p class="doc__desc">${p.doc.meta.description}</p>
</header>
<div class="prose">${raw(p.doc.html)}</div>
<footer class="doc__sources">
<p>Checked against these files in the repository:</p>
<ul>${p.sources.map((s) => sourceLink(repo, s))}</ul>
</footer>
<nav class="pager" aria-label="Next and previous pages">
${prev !== undefined ? html`<a class="prev" href="${docUrl(prev.slug)}"><span class="pager__dir">Previous</span><span class="pager__title">${prev.title}</span></a>` : ""}
${next !== undefined ? html`<a class="next" href="${docUrl(next.slug)}"><span class="pager__dir">Next</span><span class="pager__title">${next.title}</span></a>` : ""}
</nav>
</article>
${toc(p)}
</div>`,
    });
  });

  const planned = outline.reduce((n, g) => n + g.pages.length, 0);
  pages.push({
    url: "/docs/", title: "MOSS docs", description: "How to use MOSS and MOSS Code, keep them in charge, and build plugins for them.",
    body: html`<div class="docs">
${nav(outline, writtenSlugs, "/docs/")}
<article class="doc">
<header class="doc__head">
<h1>MOSS docs</h1>
<p class="doc__desc">How to use MOSS and MOSS Code, how they keep you in charge, and how to build plugins for them.</p>
</header>
<div class="prose">
<blockquote><p><strong>MOSS isn't released yet.</strong> These pages describe the first release, which is still being built. Where a part isn't finished, the page says so.</p></blockquote>
${outline.filter((g) => g.pages.some((p) => writtenSlugs.has(p.slug))).map((g) => html`<h2 id="${g.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}">${g.title}</h2>
<ul class="doclist">${g.pages.filter((p) => writtenSlugs.has(p.slug)).map((p) => html`<li><a href="${docUrl(p.slug)}"><span class="doclist__title">${p.title}</span><span class="doclist__what">${p.summary}</span></a></li>`)}</ul>`)}
<p>${written.length} of the ${planned} pages planned are written. <a href="/docs/outline/">See every page, planned too</a>.</p>
</div>
</article>
<aside class="toc" aria-label="On this page"></aside>
</div>`,
  });

  pages.push({
    url: "/docs/outline/", title: "Every page: MOSS docs", description: "The whole of MOSS's documentation, page by page, with what each covers and where its facts come from.",
    body: html`<div class="docs">
${nav(outline, writtenSlugs, "/docs/outline/")}
<article class="doc">
<header class="doc__head">
<h1>Every page</h1>
<p class="doc__desc">The whole of the documentation, page by page: what each page covers and the files in the repository its facts come from. ${written.length} of ${planned} are written.</p>
</header>
<div class="prose outline">
${outline.map((g) => html`<section class="outline__group">
<h2>${g.title}</h2>
<ul class="outline__list">${g.pages.map((p) => html`<li class="outline__item">
<span class="outline__title">${writtenSlugs.has(p.slug) ? html`<a href="${docUrl(p.slug)}">${p.title}</a>` : p.title}<span class="outline__state">${writtenSlugs.has(p.slug) ? "Written" : "Planned"}</span></span>
<span class="outline__what">${p.summary}</span>
<span class="outline__src">${p.sources.join("; ")}</span>
</li>`)}</ul>
</section>`)}
</div>
</article>
<aside class="toc" aria-label="On this page"></aside>
</div>`,
  });

  const search = written.map((p) => ({
    u: docUrl(p.slug), t: p.doc.meta.title, d: p.doc.meta.description, g: p.group,
    h: p.doc.headings.map((h) => [h.id, h.text]),
    x: p.doc.text.slice(0, 6000),
  }));
  return { pages, search };
}
