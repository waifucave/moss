// The site's check, run on a built folder: it fails on a broken link and on anything that would make a visitor's
// browser request a file from another host.
//
//   bun src/check.ts <dist>
//
// What it reads:
//   * every page: each href, src, srcset, poster, data and action. A link a person follows (<a href>) may go to another
//     site, over https only; anything the browser fetches by itself (scripts, styles, icons, pictures, frames,
//     preloads) must be this site's own file. Every link into the site must reach a file that exists, and a link to
//     #part of a page must reach an id on that page;
//   * every stylesheet: each url() and @import, which must be the site's own;
//   * every script: no address of another host at all, and no use of what could reach one (fetch, XMLHttpRequest,
//     WebSocket, EventSource, sendBeacon, import()) except the docs' own search index, fetched by its path;
//   * _headers: a Content-Security-Policy that allows 'self' and nothing else;
//   * the size of each page with what it loads, against a budget.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

export interface CheckResult {
  problems: string[];
  /** Every address a page asks the browser to load by itself, by page. */
  loads: Record<string, string[]>;
  /** Every address on another host that a person can follow (links). */
  outbound: string[];
  /** Bytes of each page with its own stylesheet and script, and pictures it loads. */
  weight: Record<string, { html: number; css: number; js: number; images: number }>;
}

/** Each page with what it loads must stay under this, pictures left out (they load lazily, and only one theme's). */
export const PAGE_BUDGET = 160 * 1024;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** The URL path a built file is served at. */
function urlOf(dist: string, file: string): string {
  const rel = relative(dist, file).split(sep).join("/");
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"index.html".length)}`;
  return `/${rel}`;
}

/** The file a site path is served from, or undefined when there is none (directory index and trailing slash as the
 *  Worker's `auto-trailing-slash` serves them). */
function fileFor(dist: string, path: string): string | undefined {
  const clean = decodeURIComponent(path.split("#")[0]!.split("?")[0]!);
  if (clean.includes("..")) return undefined;
  const base = join(dist, ...clean.split("/").filter((s) => s !== ""));
  if (clean.endsWith("/")) return existsSync(join(base, "index.html")) ? join(base, "index.html") : undefined;
  if (existsSync(base) && statSync(base).isFile()) return base;
  if (existsSync(join(base, "index.html"))) return join(base, "index.html");
  if (existsSync(`${base}.html`)) return `${base}.html`;
  return undefined;
}

interface Ref { tag: string; attr: string; value: string; rel?: string }

/** Every URL-bearing attribute in a page. Plain parsing: the pages are the build's own output. */
function refsOf(page: string): Ref[] {
  const refs: Ref[] = [];
  const tagRe = /<([a-zA-Z][\w-]*)(\s[^<>]*?)?\/?>/g;
  for (const m of page.matchAll(tagRe)) {
    const tag = m[1]!.toLowerCase();
    const attrs = m[2] ?? "";
    const get = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
    const rel = get("rel");
    for (const attr of ["href", "src", "srcset", "poster", "data", "action", "formaction", "background", "xlink:href"]) {
      const v = get(attr.replace(":", "\\:"));
      if (v === null) continue;
      const value = (v[2] ?? v[3] ?? v[4] ?? "").replace(/&amp;/g, "&");
      if (attr === "srcset") for (const part of value.split(",")) refs.push({ tag, attr, value: part.trim().split(/\s+/)[0]! });
      else refs.push({ tag, attr, value, ...(rel !== null ? { rel: (rel[2] ?? rel[3] ?? rel[4] ?? "").toLowerCase() } : {}) });
    }
    if (tag === "meta") {
      const equiv = get("http-equiv"), content = get("content");
      if (equiv !== null && /refresh/i.test(equiv[0]) && content !== null) refs.push({ tag, attr: "refresh", value: (content[2] ?? content[3] ?? "").replace(/^.*url=/i, "") });
    }
  }
  return refs;
}

const isOther = (u: string) => /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//");

/** Whether a reference is a navigation a person makes (a link), not a load the browser makes by itself. */
const isNavigation = (r: Ref) => (r.tag === "a" || r.tag === "area") && r.attr === "href";

export function checkSite(dist: string): CheckResult {
  const problems: string[] = [];
  const loads: Record<string, string[]> = {};
  const outbound = new Set<string>();
  const weight: CheckResult["weight"] = {};
  const files = walk(dist);
  const pages = files.filter((f) => f.endsWith(".html"));
  const idsOf = new Map<string, Set<string>>();
  const ids = (file: string) => {
    let s = idsOf.get(file);
    if (s === undefined) {
      s = new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
      idsOf.set(file, s);
    }
    return s;
  };

  for (const file of pages) {
    const url = urlOf(dist, file);
    const text = readFileSync(file, "utf8");
    const own: string[] = [];
    let css = 0, js = 0, images = 0;
    if (/<style[\s>]/i.test(text)) problems.push(`${url}: an inline <style> (the policy allows the site's own stylesheet only)`);
    if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(text)) problems.push(`${url}: an inline <script>`);
    if (/\sstyle\s*=/i.test(text.replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<code[\s\S]*?<\/code>/g, ""))) problems.push(`${url}: a style="" attribute (the policy refuses inline styles)`);
    if (/\son[a-z]+\s*=/i.test(text.replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<code[\s\S]*?<\/code>/g, ""))) problems.push(`${url}: an inline event handler`);
    for (const r of refsOf(text)) {
      const v = r.value.trim();
      if (v === "" || v.startsWith("#") && r.attr === "href") {
        if (v.length > 1 && !ids(file).has(decodeURIComponent(v.slice(1)))) problems.push(`${url}: a link to #${v.slice(1)}, which this page has no id for`);
        continue;
      }
      if (isOther(v)) {
        if (isNavigation(r)) {
          if (!/^https:\/\//.test(v) && !/^mailto:/.test(v)) problems.push(`${url}: a link that isn't https: ${v}`);
          else outbound.add(v);
        } else if (r.rel === "canonical" || r.rel === "alternate") {
          outbound.add(v);
        } else {
          problems.push(`${url}: <${r.tag} ${r.attr}> loads from another host: ${v}`);
        }
        continue;
      }
      const target = posix.resolve(url.endsWith("/") ? url : posix.dirname(url), v);
      const hit = fileFor(dist, target);
      if (hit === undefined) { problems.push(`${url}: a broken link: ${v}`); continue; }
      const hash = v.includes("#") ? v.slice(v.indexOf("#") + 1) : "";
      if (hash !== "" && hit.endsWith(".html") && !ids(hit).has(decodeURIComponent(hash))) problems.push(`${url}: a link to ${v}, but ${urlOf(dist, hit)} has no id "${hash}"`);
      if (!isNavigation(r)) {
        own.push(target);
        const size = statSync(hit).size;
        if (hit.endsWith(".css")) css += size;
        else if (hit.endsWith(".js")) js += size;
        else if (/\.(png|svg|jpe?g|webp|avif|gif)$/.test(hit)) images += size;
      }
    }
    loads[url] = [...new Set(own)].sort();
    weight[url] = { html: Buffer.byteLength(text), css, js, images };
    const total = weight[url]!.html + css + js;
    if (total > PAGE_BUDGET) problems.push(`${url}: ${Math.round(total / 1024)} KB with its stylesheet and script, over the ${PAGE_BUDGET / 1024} KB budget`);
  }

  for (const file of files.filter((f) => f.endsWith(".css"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const v = m[2]!;
      if (v.startsWith("data:")) { problems.push(`${urlOf(dist, file)}: a data: URL (the policy refuses them)`); continue; }
      if (isOther(v)) problems.push(`${urlOf(dist, file)}: url() loads from another host: ${v}`);
      else if (fileFor(dist, posix.resolve(posix.dirname(urlOf(dist, file)), v)) === undefined) problems.push(`${urlOf(dist, file)}: url() names a missing file: ${v}`);
    }
    if (/@import/.test(text)) problems.push(`${urlOf(dist, file)}: an @import`);
  }

  for (const file of files.filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(file, "utf8");
    const where = urlOf(dist, file);
    // An XML namespace (the faces' SVG names its own) is a name, never fetched.
    for (const m of text.matchAll(/(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(\/[^\s"'`]*)?/gi)) if (!/^http:\/\/www\.w3\.org\/(2000\/svg|1999\/xlink|1999\/xhtml)$/.test(m[0])) problems.push(`${where}: an address of another host in the script: ${m[0]}`);
    for (const word of ["XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import("]) if (text.includes(word)) problems.push(`${where}: uses ${word}`);
    const fetches = [...text.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    for (const f of fetches) if (f !== '"/docs/search.json"' && f !== "'/docs/search.json'" && f !== "`/docs/search.json`") problems.push(`${where}: fetch(${f}), which isn't the docs' search index`);
  }

  const headers = join(dist, "_headers");
  if (!existsSync(headers)) problems.push("no _headers file");
  else {
    const csp = /Content-Security-Policy:\s*(.+)/.exec(readFileSync(headers, "utf8"))?.[1] ?? "";
    if (!/default-src 'none'/.test(csp)) problems.push("_headers: the policy's default-src isn't 'none'");
    for (const d of csp.split(";").map((s) => s.trim()).filter(Boolean)) {
      const sources = d.split(/\s+/).slice(1);
      for (const s of sources) if (s !== "'self'" && s !== "'none'") problems.push(`_headers: ${d.split(/\s+/)[0]} allows ${s}`);
    }
  }
  for (const want of ["index.html", "404.html", "favicon.svg", join("docs", "index.html")]) if (!existsSync(join(dist, want))) problems.push(`${want} is missing`);

  return { problems, loads, outbound: [...outbound].sort(), weight };
}

if (import.meta.main) {
  const dist = process.argv[2];
  if (dist === undefined) throw new Error("usage: bun src/check.ts <dist>");
  const r = checkSite(dist);
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  for (const [page, w] of Object.entries(r.weight)) console.log(`${page}  html ${kb(w.html)}  css ${kb(w.css)}  js ${kb(w.js)}  pictures ${kb(w.images)}`);
  console.log(`\nlinks out (followed by a person, never loaded): ${r.outbound.length}`);
  for (const o of r.outbound) console.log(`  ${o}`);
  if (r.problems.length > 0) {
    console.error(`\n${r.problems.length} problem(s):`);
    for (const p of r.problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`\nok: ${Object.keys(r.loads).length} pages, every link reaches a file, nothing loads from another host`);
}
