// The canvas's `gallery` script, run by CI's gallery job (docs/moss-layout.md, "A gallery"): builds the self-contained
// gallery page and renders every story to PNG, light and dark, under $MOSS_GALLERY_OUT/canvas/ (`site/`, the page, and
// `png/<theme>/<story>.png`), with Playwright's Chromium. CI only: it downloads and runs a browser. On this Mac, build the
// page alone: `scripts/pinned-bun plugins/moss/plugins/canvas/gallery/build.ts <out.html>`.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { buildGallery } from "./build";

const root = process.env.MOSS_GALLERY_OUT;
if (root === undefined || root === "") {
  console.error("gallery: set MOSS_GALLERY_OUT to the folder the galleries go in (CI's gallery job does)");
  process.exit(2);
}
if (process.env.GITHUB_ACTIONS !== "true") {
  console.error("gallery: renders in CI only (GITHUB_ACTIONS=true), since it downloads and runs Chromium");
  process.exit(2);
}

const pkg = join(import.meta.dir, "..");
const out = join(root, "canvas");
const page = await buildGallery(join(out, "site", "canvas-gallery.html"));
function run(cmd: string[]): void {
  console.log(`$ ${cmd.join(" ")}`);
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: pkg, stdio: "inherit", env: { ...process.env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
run(["node", "node_modules/playwright/cli.js", "install", "--with-deps", "chromium"]);
run(["node", "gallery/shoot.mjs", page, join(out, "png")]);
