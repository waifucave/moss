// Serves a built site on this computer the way the Worker's static assets serve it: /docs redirects to /docs/, a
// folder serves its index.html, a missing path serves 404.html with status 404, and every answer carries the headers
// in _headers. For looking at the site and for the pictures; it listens on 127.0.0.1 only.
//
//   bun src/serve.ts <dist> [port]
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function headerRules(dist: string): { pattern: RegExp; headers: [string, string][] }[] {
  const file = join(dist, "_headers");
  if (!existsSync(file)) return [];
  const rules: { pattern: RegExp; headers: [string, string][] }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) rules.push({ pattern: new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`), headers: [] });
    else {
      const i = line.indexOf(":");
      rules[rules.length - 1]?.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

export function serveSite(dist: string, port = 0): { url: string; stop: () => void } {
  const rules = headerRules(dist);
  const withHeaders = (path: string, res: Response) => {
    for (const r of rules) if (r.pattern.test(path)) for (const [k, v] of r.headers) res.headers.set(k, v);
    return res;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      if (path.includes("..")) return new Response("bad path", { status: 400 });
      const base = join(dist, ...path.split("/").filter((s) => s !== ""));
      if (!path.endsWith("/") && existsSync(base) && statSync(base).isDirectory() && existsSync(join(base, "index.html"))) {
        return withHeaders(path, new Response(null, { status: 307, headers: { Location: `${path}/${url.search}` } }));
      }
      const file = path.endsWith("/") ? join(base, "index.html") : base;
      if (existsSync(file) && statSync(file).isFile() && !file.endsWith("_headers")) return withHeaders(path, new Response(Bun.file(file)));
      return withHeaders(path, new Response(Bun.file(join(dist, "404.html")), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }));
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const dist = process.argv[2];
  if (dist === undefined) throw new Error("usage: bun src/serve.ts <dist> [port]");
  const s = serveSite(dist, Number(process.argv[3] ?? 4321));
  console.log(`serving ${dist} at ${s.url}`);
}
