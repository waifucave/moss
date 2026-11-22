// CI's and the release workflow's check of a build's folder against the artifact table (scripts/release/artifacts.ts): every file
// the table names for the system(s) is there, and nothing else is (but a build's byproducts). The builds make this check
// themselves at their end; this runs it again on the folder as CI holds it (and as the release workflow uploads it), and prints each
// app's files per system, so a job's log shows that BOTH apps were built.
//
//   bun scripts/release/check-artifacts.ts --os mac|win|linux-x64|linux-arm64[,…] [--channel latest|beta] [--dir <folder>]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_KEYS, appArtifacts, builtArtifactProblems, engineArtifacts, RELEASE_OSES, type ReleaseOs } from "./artifacts";
import { parseChannel } from "./lib";

export function main(argv: readonly string[], root: string): number {
  const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const oses = (flag("--os") ?? "").split(",").filter(Boolean) as ReleaseOs[];
  if (oses.length === 0 || oses.some((o) => !RELEASE_OSES.includes(o))) { console.error(`check-artifacts: --os takes some of ${RELEASE_OSES.join(", ")}`); return 2; }
  const channel = parseChannel(flag("--channel") ?? "latest");
  const dir = flag("--dir") ?? join(root, "apps", "desktop", "out", "dist");
  const version = (JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")) as { version: string }).version;
  const present = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  const problems = builtArtifactProblems(version, oses, channel, present);
  for (const os of oses) {
    for (const app of APP_KEYS) console.log(`check-artifacts: ${os} / ${app === "moss" ? "MOSS" : "MOSS Code"}: ${appArtifacts(app, version, os, channel).join(", ")}`);
    console.log(`check-artifacts: ${os} / the engine: ${engineArtifacts(version, os, channel).join(", ")}`);
  }
  for (const p of problems) console.error(`check-artifacts: ${p}`);
  if (problems.length > 0) return 1;
  console.log(`check-artifacts: ${oses.join(", ")}: every file of the table is in ${dir}, and nothing else`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..", "..")));
