/**
 * Makes the lock file for an agent adapter MOSS provides (packages/core/src/agents/adapter, spec §9.3):
 *
 *   scripts/pinned-bun scripts/agent-adapter-lock.ts <package>@<exact version> <out.json>
 *   scripts/pinned-bun scripts/agent-adapter-lock.ts <package>@<exact version> --bundled
 *
 * (`--bundled`: the adapter ships as one self-contained file, as Codex's does; nothing is locked beside it, and only the
 * adapter's own integrity and size are read and checked.)
 *
 * A DEV-TIME tool, run when a plugin names a new adapter version; its output is reviewed in the diff like any pinned
 * list. It needs `npm` and the public registry. It writes the metadata's results into <out.json> and prints the line to
 * paste into the plugin's quirks file (`launch.adapter`: package, version, integrity, size).
 *
 *  1. npm resolves the adapter's closure into a lockfile (`--package-lock-only --ignore-scripts --omit=optional`: no
 *     package is installed and no script runs; optional packages, the platform binaries of a vendor SDK, are left out, as
 *     MOSS hands the adapter the person's own program instead).
 *  2. Each locked package's tarball is downloaded and checked against the lockfile's integrity, and unpacked with MOSS's own
 *     reader into a temp folder (so a package MOSS's reader would refuse is found here, not on a person's computer); its size
 *     is recorded.
 *  3. The adapter's own integrity is checked against the registry's metadata (`dist.integrity`), the source of the hashes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockFileSchema, tarballUrl, type LockedPackage } from "../packages/core/src/agents/adapter/types";
import { npmPackageUrl, NPM_REGISTRY } from "../packages/core/src/registry/indexes/npm";
import { unpackTarGz } from "../packages/core/src/registry/indexes/unpack";

const [spec, out] = process.argv.slice(2);
const bundled = out === "--bundled";
const m = /^(@?[^@]+)@(\d+\.\d+\.\d+)$/.exec(spec ?? "");
if (!m || !out) {
  console.error("usage: agent-adapter-lock.ts <package>@<exact version> <out.json>");
  process.exit(2);
}
const [, name, version] = m as unknown as [string, string, string];

const work = mkdtempSync(join(tmpdir(), "moss-adapter-lock-"));
try {
  if (bundled) {
    const meta = (await (await fetch(npmPackageUrl(name), { headers: { accept: "application/vnd.npm.install-v1+json" } })).json()) as { versions?: Record<string, { dist?: { integrity?: string } }> };
    const integrity = meta.versions?.[version]?.dist?.integrity;
    if (integrity === undefined) throw new Error(`the registry has no ${name} ${version}`);
    const res = await fetch(tarballUrl(NPM_REGISTRY, name, version));
    if (!res.ok) throw new Error(`${name} ${version}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) throw new Error("the download doesn't match the registry's integrity");
    mkdirSync(join(work, "u"), { recursive: true });
    unpackTarGz(bytes, join(work, "u", "package"), { root: "package" });
    console.log(`launch.adapter: "package": ${JSON.stringify(name)}, "version": ${JSON.stringify(version)}, "integrity": ${JSON.stringify(integrity)}, "size": ${bytes.byteLength}  (source: registry metadata dist.integrity, tarball re-hashed)`);
    process.exit(0);
  }
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "adapter-lock", private: true, dependencies: { [name]: version } }));
  const npm = Bun.spawnSync(["npm", "install", "--package-lock-only", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", "--userconfig", "/dev/null"], { cwd: work, stdout: "inherit", stderr: "inherit" });
  if (npm.exitCode !== 0) throw new Error("npm couldn't resolve it");
  const lock = JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8")) as { packages: Record<string, { name?: string; version?: string; resolved?: string; integrity?: string; optional?: boolean }> };
  const mainPath = `node_modules/${name}`;
  const packages: LockedPackage[] = [];
  let main: { integrity: string; size: number } | undefined;
  let n = 0;
  for (const [path, p] of Object.entries(lock.packages).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (path === "") continue;
    if (p.optional === true) continue; // a platform binary: the person's own program is used instead
    const pkgName = p.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (p.version === undefined || p.integrity === undefined || p.resolved === undefined) throw new Error(`${path} has no version, integrity or resolved address in npm's lockfile`);
    const url = tarballUrl(NPM_REGISTRY, pkgName, p.version);
    if (p.resolved !== url) throw new Error(`${path} resolves to ${p.resolved}, not npm's own layout ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const got = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (got !== p.integrity) throw new Error(`${url} doesn't match npm's lockfile integrity`);
    const scratch = join(work, "unpack", String(n++));
    mkdirSync(scratch, { recursive: true });
    try {
      unpackTarGz(bytes, join(scratch, "package"), { root: "package" });
    } catch (err) {
      throw new Error(`${pkgName} ${p.version}: MOSS's reader refuses it: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (path === mainPath) {
      main = { integrity: p.integrity, size: bytes.byteLength };
      continue;
    }
    packages.push({ path, name: pkgName, version: p.version, integrity: p.integrity, size: bytes.byteLength });
  }
  if (main === undefined) throw new Error(`${mainPath} isn't in the lockfile`);
  // The registry's own metadata says the adapter's integrity: where the pinned hash comes from.
  const meta = (await (await fetch(npmPackageUrl(name), { headers: { accept: "application/vnd.npm.install-v1+json" } })).json()) as { versions?: Record<string, { dist?: { integrity?: string } }> };
  if (meta.versions?.[version]?.dist?.integrity !== main.integrity) throw new Error(`the registry's metadata for ${name} ${version} names another integrity than the lockfile`);
  const file = LockFileSchema.parse({ lock: 1, source: `npm lockfile resolved by npm ${Bun.spawnSync(["npm", "--version"]).stdout.toString().trim()} on ${new Date().toISOString().slice(0, 10)} from ${NPM_REGISTRY}; each tarball re-downloaded and checked against its integrity; the adapter's integrity checked against the registry's metadata (dist.integrity)`, packages });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`${packages.length} packages locked into ${out} (${Math.round(packages.reduce((n, p) => n + (p.size ?? 0), 0) / 1024)} KB compressed besides the adapter)`);
  console.log(`launch.adapter: "package": ${JSON.stringify(name)}, "version": ${JSON.stringify(version)}, "integrity": ${JSON.stringify(main.integrity)}, "size": ${main.size}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
