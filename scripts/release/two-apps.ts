// One release, two apps (spec §3.1 "One release for everything", R4; G3, R3, R7; lane PK): the release build makes MOSS Code
// and MOSS in one run, from one stage. There is no flag that builds one without the other. This module holds what the build
// knows of the two apps and the checks that hold them to one release:
//
//   * one version: both apps' package.json say the `VERSION` file's release (`oneVersionProblems`), checked before anything
//     is built;
//   * one payload: after packaging, each app's engine and sidecars (`Contents/Resources/daemon`), bundled tree
//     (`Contents/Resources/plugins`) and, on macOS, host helper's code (`Contents/Frameworks/MOSS Host.app`'s app.asar and its
//     identity) are byte for byte the same in both (`samePayloadProblems`); the helper's Info.plist names its own asar's
//     integrity (`helperIntegrityProblems`), or the integrity fuse refuses to start it;
//   * its own feed: MOSS's update files carry `MOSS_APP_FEED_PREFIX` (`moss-latest-mac.yml`), so the two apps' files in one
//     GitHub release never overwrite each other (`mossFeedFile`, `renameMossFeeds`).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MOSS_APP_FEED_PREFIX } from "../../packages/update-feed/src/index";
import { asarFiles } from "../test-build";
import { walkTree } from "./bundled-plugins";
import { appArtifacts, appFeedFile, channelsServed, installersOf, type Channel, type ReleaseOs } from "./artifacts";

export interface ReleaseApp {
  program: "code" | "moss";
  /** The app's folder, relative to the repository. */
  dir: string;
  /** electron-builder's productName: the bundle's name. */
  product: string;
  /** The artifacts' prefix (electron-builder.yml's artifactName). */
  artifact: string;
}

export const CODE_APP: ReleaseApp = { program: "code", dir: "apps/desktop", product: "MOSS Code", artifact: "MOSS-Code" };
export const MOSS_APP: ReleaseApp = { program: "moss", dir: "apps/moss", product: "MOSS", artifact: "MOSS" };
/** Every app a release builds, MOSS Code first: its afterPack makes the host helper MOSS then carries. */
export const RELEASE_APPS: readonly ReleaseApp[] = [CODE_APP, MOSS_APP];

/** The host helper's bundle inside a macOS app (the engine's `hostHelperPath`, dist profile). */
export const HOST_HELPER = "MOSS Host.app";

/** Where the release build stashes MOSS Code's finished helper for MOSS (relative to apps/desktop). */
export const HOST_HELPER_STASH = "out/host-helper";

/** Each app's package.json version against the `VERSION` file: one release, or the build stops before it starts. */
export function oneVersionProblems(release: string, versions: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(versions).filter(([, v]) => v !== release).map(([dir, v]) => `${dir}/package.json says ${v ?? "no version"}, not the release ${release} (VERSION): run the version sync first; both apps ship one release`);
}

/** The installers of MOSS a release holds for `os` (the artifact table's rows, apps/moss/electron-builder.yml's artifact names). */
export function mossInstallers(version: string, os: ReleaseOs): string[] {
  return installersOf(version, os, "moss");
}

/** MOSS's update file for a channel and an OS: MOSS Code's name with MOSS's prefix (packages/update-feed's FEED_NAME). */
export function mossFeedFile(channel: Channel, os: ReleaseOs): string {
  return appFeedFile("moss", channel, os);
}

/** What a release build of MOSS adds to the release: its installers and its update files for each channel served. */
export function mossArtifacts(version: string, os: ReleaseOs, channel: Channel): string[] {
  return appArtifacts("moss", version, os, channel);
}

/** A test build's MOSS dmg and zip (TEST in their names, as MOSS Code's). */
export function mossTestBuildArtifacts(version: string): { dmg: string; zip: string } {
  return { dmg: `MOSS-${version}-TEST.dmg`, zip: `MOSS-${version}-TEST-mac.zip` };
}

/** electron-builder's names for a MOSS test build's artifacts. */
export const MOSS_TEST_BUILD_ARTIFACT_ARGS = ["-c.dmg.artifactName=MOSS-${version}-TEST.${ext}", "-c.mac.artifactName=MOSS-${version}-TEST-mac.${ext}"] as const;

/** A file of MOSS's own electron-builder run that belongs in the release: its dmg, zip, installer, AppImage, deb and rpm, and
 *  their block maps (MOSS Code's carry `MOSS-Code-` or `moss-code`, the engine's `moss-core`, `moss-plugin-bun`, `moss-plugins`). */
export function isMossFile(name: string): boolean {
  return (/^MOSS-(?!Code-).*\.(dmg|zip|exe|AppImage|blockmap)$/.test(name)) || /^moss_.*\.deb$/.test(name) || /^moss-\d.*\.rpm$/.test(name);
}

/**
 * Moves what MOSS's electron-builder run left in its own output folder into the release's (MOSS Code's): its installers and
 * blockmaps, its update files under MOSS's names (electron-builder writes `latest-mac.yml`, which is MOSS Code's name), and on
 * macOS its `.app` beside MOSS Code's in `mac-arm64/`. MOSS's folder is removed after. Returns the names moved.
 */
export function moveMossOutputs(from: string, to: string, os: ReleaseOs): string[] {
  const moved: string[] = [];
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (isMossFile(name)) {
      renameSync(src, join(to, name));
      moved.push(name);
    } else if (/^(latest|beta)(-mac|-linux|-linux-arm64)?\.yml$/.test(name)) {
      renameSync(src, join(to, `${MOSS_APP_FEED_PREFIX}${name}`));
      moved.push(`${MOSS_APP_FEED_PREFIX}${name}`);
    }
  }
  if (os === "mac" && existsSync(join(from, "mac-arm64", `${MOSS_APP.product}.app`))) {
    mkdirSync(join(to, "mac-arm64"), { recursive: true });
    rmSync(join(to, "mac-arm64", `${MOSS_APP.product}.app`), { recursive: true, force: true });
    renameSync(join(from, "mac-arm64", `${MOSS_APP.product}.app`), join(to, "mac-arm64", `${MOSS_APP.product}.app`));
    moved.push(`mac-arm64/${MOSS_APP.product}.app`);
  }
  return moved;
}

/** On a latest release MOSS's update files go to the beta names too (lib.ts's `writeServedCopies`, MOSS's names). */
export function mossServedCopies(outDir: string, channel: Channel, os: ReleaseOs, copy: (from: string, to: string) => void): string[] {
  const from = join(outDir, mossFeedFile(channel, os));
  if (!existsSync(from)) return [];
  return channelsServed(channel).filter((c) => c !== channel).map((c) => { copy(from, join(outDir, mossFeedFile(c, os))); return mossFeedFile(c, os); });
}

/**
 * The host on Windows and Linux (spec §3.1: each app carries the engine AND the host). MOSS Code is the host's program (its main
 * process runs as the host when started with `--moss-program=host`, apps/desktop/src/main/host-program.ts), so MOSS Code carries
 * the host by being itself: its own executable. MOSS's app.asar has no host in it, so MOSS carries MOSS Code's whole unpacked app
 * (its executable, its Electron files and its app.asar, which the fuses and the integrity check tie to the executable beside it)
 * in `resources/host/` as `moss-host[.exe]` (apps/moss/scripts/host-helper.mjs lays it out; macOS's helper bundle is the same
 * thing in that system's form). Without it a MOSS-only install on those systems has no host to start.
 */
export const HOST_TREE_DIR = "host";
export function hostExecutableName(os: ReleaseOs): string {
  return os === "win" ? "moss-host.exe" : "moss-host";
}

/** What's wrong with the host tree MOSS carries (`mossResources/host`) against MOSS Code's own app: it holds the executable and
 *  MOSS Code's app.asar byte for byte, and no second copy of the engine or the bundled tree (they are MOSS's own beside it). */
export function hostTreeProblems(o: { os: "win" | "linux-x64" | "linux-arm64"; codeResources: string; mossResources: string }): string[] {
  const host = join(o.mossResources, HOST_TREE_DIR);
  const out: string[] = [];
  const exe = join(host, hostExecutableName(o.os));
  if (!existsSync(exe)) return [`MOSS carries no host: ${exe} is missing (a MOSS-only install would have no host to start)`];
  const asar = join(host, "resources", "app.asar");
  const own = join(o.codeResources, "app.asar");
  if (!existsSync(asar)) out.push("MOSS's host tree holds no resources/app.asar");
  else if (!existsSync(own) || sha(new Uint8Array(readFileSync(asar))) !== sha(new Uint8Array(readFileSync(own)))) out.push("MOSS's host runs different code from MOSS Code's own (their app.asar differ): the host must be the same whichever app's copy runs");
  for (const dup of ["daemon", "plugins"]) if (existsSync(join(host, "resources", dup))) out.push(`MOSS's host tree holds its own resources/${dup}: the engine and the bundled tree are MOSS's own, never copied twice`);
  return out;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Every regular file under `dir` (relative paths) with its hash; a symlink is named as one. */
export function treeHashes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of walkTree(dir)) out.set(e.rel, e.link ? "symlink" : sha(new Uint8Array(readFileSync(join(dir, e.rel)))));
  return out;
}

/** Where two trees differ: files only in one, and files whose bytes differ (names only, at most a few). */
export function treeDifferences(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of a) if (!b.has(k)) out.push(`${k} only in MOSS Code`); else if (b.get(k) !== v) out.push(`${k} differs`);
  for (const k of b.keys()) if (!a.has(k)) out.push(`${k} only in MOSS`);
  return out;
}

/** A plist's string value for a key (plain XML, as electron-builder writes it). */
export function plistString(xml: string, key: string): string | undefined {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1];
}

/** The asar integrity hash a plist names for `Resources/app.asar` (Electron's `ElectronAsarIntegrity`). */
export function plistAsarHash(xml: string): string | undefined {
  return /<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>Resources\/app\.asar<\/key>\s*<dict>[\s\S]*?<key>hash<\/key>\s*<string>([0-9a-f]+)<\/string>/.exec(xml)?.[1];
}

/** The integrity hash Electron computes for an asar: SHA-256 of its header's JSON. */
export function asarHeaderHash(bytes: Uint8Array): string {
  asarFiles(bytes); // throws on anything that isn't an asar
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  return sha(bytes.subarray(16, 16 + jsonLength));
}

/** The host helper inside an app's bundle: its Info.plist names its own asar's integrity and the host's fixed identifier. */
export function helperIntegrityProblems(label: string, helper: string, identifier: string): string[] {
  const plist = join(helper, "Contents", "Info.plist");
  const asar = join(helper, "Contents", "Resources", "app.asar");
  if (!existsSync(plist) || !existsSync(asar)) return [`${label} carries no host helper (${HOST_HELPER}): the engine could start no host from it`];
  const xml = readFileSync(plist, "utf8");
  const out: string[] = [];
  if (plistString(xml, "CFBundleIdentifier") !== identifier) out.push(`${label}'s host helper is ${plistString(xml, "CFBundleIdentifier") ?? "unnamed"}, not ${identifier}`);
  const want = asarHeaderHash(new Uint8Array(readFileSync(asar)));
  const said = plistAsarHash(xml);
  if (said !== want) out.push(`${label}'s host helper's Info.plist names asar integrity ${said ?? "(none)"}, not its own app.asar's ${want}: the integrity fuse would refuse to start it`);
  return out;
}

/**
 * One release in both apps, after packaging: the same engine and sidecars, the same bundled tree, and (macOS) the same host
 * helper code and identity. `code` and `moss` are the two apps' `Contents/Resources` (or `resources`) folders and, on macOS,
 * the bundles themselves.
 */
export function samePayloadProblems(o: { codeResources: string; mossResources: string; codeBundle?: string; mossBundle?: string; hostIdentifier?: string }): string[] {
  const out: string[] = [];
  for (const part of ["daemon", "plugins"] as const) {
    const a = treeHashes(join(o.codeResources, part)), b = treeHashes(join(o.mossResources, part));
    if (a.size === 0) out.push(`MOSS Code carries no ${part}`);
    const diff = treeDifferences(a, b);
    if (diff.length > 0) out.push(`the two apps' ${part} differ (one release ships one ${part === "daemon" ? "engine" : "bundled tree"}): ${diff.slice(0, 5).join("; ")}${diff.length > 5 ? `; and ${diff.length - 5} more` : ""}`);
  }
  if (o.codeBundle !== undefined && o.mossBundle !== undefined) {
    const id = o.hostIdentifier ?? "com.waifucave.moss.host";
    const ch = join(o.codeBundle, "Contents", "Frameworks", HOST_HELPER), mh = join(o.mossBundle, "Contents", "Frameworks", HOST_HELPER);
    out.push(...helperIntegrityProblems("MOSS Code", ch, id), ...helperIntegrityProblems("MOSS", mh, id));
    const asar = (h: string) => { try { return sha(new Uint8Array(readFileSync(join(h, "Contents", "Resources", "app.asar")))); } catch { return undefined; } };
    if (asar(ch) !== undefined && asar(ch) !== asar(mh)) out.push("the two apps' host helpers run different code (their app.asar differ): the host must be the same whichever app's copy runs");
    // The host is MOSS Code's main process (apps/desktop/src/main/host-program.ts): its helper runs MOSS Code's own app.asar.
    const own = existsSync(join(o.codeResources, "app.asar")) ? sha(new Uint8Array(readFileSync(join(o.codeResources, "app.asar")))) : undefined;
    if (asar(ch) !== undefined && asar(ch) !== own) out.push("MOSS Code's host helper doesn't run MOSS Code's own code (its app.asar)");
  }
  return out;
}
