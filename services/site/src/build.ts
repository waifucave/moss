// Builds the site into plain files: dist/ by default. Bun alone does it (its Markdown, its bundler); nothing is
// downloaded and nothing is fetched. Any static host serves the result at / and /docs/; the Worker in wrangler.jsonc
// serves it with the headers in dist/_headers.
//
//   bun src/build.ts [--out <dir>] [--state unreleased|released]
//
// --state builds with the release switch changed from site.json's, for the check and the pictures; site.json
// itself is what a real build reads.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readConfig, REPO_ROOT, SITE_DIR, withSwitches, type ReleaseState, type SiteConfig } from "./config";
import { docsPages } from "./docs";
import { html, tidy } from "./html";
import { LANDING_DESCRIPTION, LANDING_TITLE, landingBody } from "./landing";
import { page, type Assets } from "./layout";

/** The headers the Worker's static assets serve (Cloudflare reads dist/_headers). The policy allows this site's own
 *  files and nothing else: a page that tried to load from another host would be refused by the browser too. */
export const HEADERS = `/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/pictures/*
  Cache-Control: public, max-age=86400
`;

export interface BuildOptions {
  out?: string;
  state?: ReleaseState;
  config?: SiteConfig;
}

export interface BuildResult {
  out: string;
  /** Every page written, by the path it is served at. */
  pages: string[];
  assets: Assets;
}

async function bundle(entry: string, out: string, kind: "js" | "css"): Promise<string> {
  const r = await Bun.build({
    entrypoints: [entry],
    outdir: join(out, "assets"),
    target: "browser",
    format: "esm",
    minify: true,
    naming: `site-[hash].${kind}`,
    sourcemap: "none",
    ...{ macros: false },
  });
  if (!r.success) throw new Error(`build: ${entry}: ${r.logs.map((l) => l.message).join("; ")}`);
  const file = r.outputs.find((o) => o.path.endsWith(`.${kind}`));
  if (file === undefined) throw new Error(`build: ${entry} wrote no .${kind}`);
  return `/assets/${file.path.split(/[\\/]/).pop()}`;
}

function write(out: string, urlPath: string, text: string): void {
  const file = urlPath.endsWith("/") ? join(out, urlPath, "index.html") : join(out, urlPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export async function buildSite(opts: BuildOptions = {}): Promise<BuildResult> {
  const out = resolve(opts.out ?? join(SITE_DIR, "dist"));
  const config = withSwitches(opts.config ?? readConfig(), { ...(opts.state !== undefined ? { state: opts.state } : {}) });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const assets: Assets = {
    css: await bundle(join(SITE_DIR, "src", "style", "site.css"), out, "css"),
    js: await bundle(join(SITE_DIR, "src", "client", "main.ts"), out, "js"),
  };

  const pages: string[] = [];
  const put = (path: string, title: string, description: string, body: ReturnType<typeof html>, docs: boolean) => {
    write(out, path, tidy(page({ title, description, path, body, assets, config, docs })));
    pages.push(path);
  };

  put("/", LANDING_TITLE, LANDING_DESCRIPTION, landingBody(config), false);
  const docs = docsPages(config);
  for (const p of docs.pages) put(p.url, p.title, p.description, p.body, true);
  write(out, "/docs/search.json", JSON.stringify(docs.search));
  // Privacy and Terms: placeholders until the first release, when the real ones are published.
  put("/privacy/", "Privacy: MOSS", "MOSS's privacy policy comes with the first release.", html`<section class="wrap lost">
<h1>Privacy</h1>
<p class="lead">MOSS's privacy policy is coming with the first release.</p>
<p>Until then, <a href="/docs/privacy/">What leaves your computer</a> says what MOSS's code sends, and to whom.</p>
</section>`, false);
  put("/terms/", "Terms: MOSS", "MOSS's terms of use come with the first release.", html`<section class="wrap lost">
<h1>Terms</h1>
<p class="lead">MOSS's terms of use are coming with the first release.</p>
</section>`, false);
  put("/404.html", "Not found: MOSS", "There is no page at this address.", html`<section class="wrap lost">
<h1>There's no page here</h1>
<p class="lead">The address may be mistyped, or the page has moved.</p>
<div class="actions"><a class="button" href="/">Go to the start</a><a class="button button--quiet" href="/docs/">Open the docs</a></div>
</section>`, false);

  // The site's own files: the pictures, and the icons, taken from MOSS's app icon so they never drift from it.
  if (existsSync(join(SITE_DIR, "public"))) cpSync(join(SITE_DIR, "public"), out, { recursive: true, filter: (src) => !src.endsWith(".md") && !src.endsWith(".DS_Store") });
  copyFileSync(join(REPO_ROOT, "apps", "moss", "build", "icon.svg"), join(out, "favicon.svg"));
  copyFileSync(join(REPO_ROOT, "apps", "moss", "build", "icons", "256x256.png"), join(out, "apple-touch-icon.png"));
  writeFileSync(join(out, "_headers"), HEADERS);
  writeFileSync(join(out, "robots.txt"), "User-agent: *\nAllow: /\n");
  return { out, pages, assets };
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const state = arg("--state");
  if (state !== undefined && state !== "released" && state !== "unreleased") throw new Error("--state is released or unreleased");
  const r = await buildSite({ ...(arg("--out") !== undefined ? { out: arg("--out") } : {}), ...(state !== undefined ? { state } : {}) });
  console.log(`site: ${r.pages.length} pages in ${r.out}`);
}
