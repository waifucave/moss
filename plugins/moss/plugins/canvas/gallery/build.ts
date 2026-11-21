// Builds the canvas gallery into ONE self-contained HTML file (its script and styles inline), to open straight from disk:
//   scripts/pinned-bun plugins/moss/plugins/canvas/gallery/build.ts [out.html] [--marks <dir>]
// (default gallery/dist/canvas-gallery.html). `--marks <dir>` puts agents' marks in the pretend `agent.backends` (an
// SVG or PNG per agent, by file name: claude-code, codex, gemini, opencode, qwen), as each agent's plugin will ship
// them; without it every agent shows the SDK's fallback mark. React is pinned to this package's copy: one React for
// the canvas and the SDK.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";

const here = import.meta.dir;
const pkg = join(here, "..");

const oneReact: BunPlugin = {
  name: "one-react",
  setup(build) {
    const reactDom = dirname(Bun.resolveSync("react-dom/package.json", pkg));
    build.onResolve({ filter: /^(react|react-dom|scheduler)(\/.*)?$/ }, (args) => ({ path: Bun.resolveSync(args.path, /^scheduler(\/|$)/.test(args.path) ? reactDom : pkg) }));
  },
};

/** The agents' marks in `dir`, by backend id (the first file of each that exists). */
const MARK_FILES: Record<string, readonly string[]> = {
  "claude-code": ["claude-code.svg"],
  codex: ["codex.svg", "codex-openai.svg"],
  gemini: ["gemini.png", "gemini.svg"],
  opencode: ["opencode.svg"],
  qwen: ["qwen.svg", "qwen-code.svg"],
};

function readMarks(dir: string | undefined): Record<string, { mediaType: string; data: string }> | undefined {
  if (dir === undefined) return undefined;
  const out: Record<string, { mediaType: string; data: string }> = {};
  for (const [id, files] of Object.entries(MARK_FILES)) {
    const file = files.map((f) => join(dir, f)).find((f) => existsSync(f));
    if (file === undefined) continue;
    out[id] = { mediaType: file.endsWith(".png") ? "image/png" : "image/svg+xml", data: readFileSync(file).toString("base64") };
  }
  return out;
}

export async function buildGallery(out = join(here, "dist", "canvas-gallery.html"), marksDir?: string): Promise<string> {
  const tmp = join(dirname(out), ".canvas-gallery-build");
  const result = await Bun.build({
    entrypoints: [join(here, "main.tsx")],
    outdir: tmp,
    target: "browser",
    format: "iife",
    minify: true,
    naming: "[name].[ext]",
    define: { "process.env.NODE_ENV": JSON.stringify("production"), __CANVAS_MARKS__: JSON.stringify(readMarks(marksDir) ?? null) },
    plugins: [oneReact],
    ...{ macros: false },
  });
  if (!result.success) throw new AggregateError(result.logs, "the canvas gallery did not build");
  const js = readFileSync(join(tmp, "main.js"), "utf8").replace(/<\/script/gi, "<\\/script");
  const css = readFileSync(join(tmp, "main.css"), "utf8").replace(/<\/style/gi, "<\\/style");
  const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Session canvas gallery</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  rmSync(tmp, { recursive: true, force: true });
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const m = args.indexOf("--marks");
  const marks = m >= 0 ? args[m + 1] : undefined;
  const rest = args.filter((_, i) => i !== m && i !== m + 1);
  const out = resolve(rest[0] ?? join(here, "dist", "canvas-gallery.html"));
  console.log(`building the canvas gallery into ${out}${marks !== undefined ? ` with the marks in ${marks}` : ""}`);
  console.log(`  ${await buildGallery(out, marks)}`);
}
