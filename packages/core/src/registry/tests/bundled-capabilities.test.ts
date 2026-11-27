// A bundled plugin's client that reads a gated part of the plugin API must declare that capability in its manifest: a call without it is refused
// at the core ("bot.list needs the capability bots.read, which <id>'s OK doesn't list"), and the OK card can't show what isn't declared. The
// table is the API's own doors in the source (`api.bots`, `useApprovals`) and the capability each needs.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "plugins", "moss", "plugins");
const DOORS: readonly { re: RegExp; any: readonly string[]; what: string }[] = [
  { re: /\bapi\.bots\b|\bbots\.list\(/, any: ["bots.read"], what: "the bots (api.bots)" },
  { re: /\buseApprovals\b/, any: ["approvals", "approvals.all"], what: "the pending cards (useApprovals)" },
];

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === "test" || n === "tests") return [];
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) && !/gallery|\.test\./.test(n) ? [p] : [];
  });
}

describe("every bundled plugin declares the capabilities its client's calls need", () => {
  for (const id of readdirSync(ROOT)) {
    const manifest = join(ROOT, id, "moss.json");
    if (!existsSync(manifest)) continue;
    test(id, () => {
      const declared = new Set<string>((JSON.parse(readFileSync(manifest, "utf8")) as { capabilities?: string[] }).capabilities ?? []);
      const missing: string[] = [];
      for (const dir of ["src", "client"]) for (const f of sources(join(ROOT, id, dir))) {
        const text = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        for (const d of DOORS) if (d.re.test(text) && !d.any.some((c) => declared.has(c))) missing.push(`${f.slice(ROOT.length + 1)} uses ${d.what} but ${id} declares none of ${d.any.join(", ")}`);
      }
      expect(missing).toEqual([]);
    });
  }
});
