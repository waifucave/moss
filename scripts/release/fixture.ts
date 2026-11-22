// A local folder that stands in for a release's builds (the release wave, lane RP): every file of the artifact table for every
// system, both apps, written with consistent update files (each names files that exist, with their real SHA-512 and size) and a
// BUILD-COMMIT per system. `publish.ts --dry-run --from <dir>` is proven against it, never against GitHub; the folder holds
// placeholder bytes, so nothing in it can install or update anything.
//
//   bun scripts/release/fixture.ts <dir> [--channel latest|beta] [--version <N.N.N>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatCoreFeed } from "../../packages/update-feed/src/index";
import { PLUGIN_BUN } from "../bundled-binaries";
import { APP_KEYS, appFeedFile, channelsServed, coreArtifacts, pluginBunArtifacts, pluginsArtifacts, RELEASE_OSES, type Channel, type InstallerKind, INSTALLER_ROWS, installerName } from "./artifacts";
import { buildCommitFile, formatUpdateInfo, parseChannel, sha512Base64 } from "./lib";

/** The fixture's placeholder commit, 40 hex digits. */
export const FIXTURE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const bytesOf = (name: string): Uint8Array => new TextEncoder().encode(`placeholder bytes of ${name}\n`);

/** The kinds a system's update file names (electron-updater: the dmg and zip on macOS, the installer on Windows, the AppImage on Linux). */
const FEED_KINDS: Readonly<Record<string, readonly InstallerKind[]>> = { mac: ["zip", "dmg"], win: ["exe"], "linux-x64": ["AppImage"], "linux-arm64": ["AppImage"] };

/** Writes the folder; returns the names written. */
export function writeReleaseFixture(dir: string, version: string, channel: Channel, commit: string = FIXTURE_COMMIT): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const put = (name: string, bytes: Uint8Array | string): void => { writeFileSync(join(dir, name), bytes); written.push(name); };
  for (const os of RELEASE_OSES) {
    for (const app of APP_KEYS) {
      const rows = INSTALLER_ROWS.filter((r) => r.os === os && r.app === app);
      for (const row of rows) put(installerName(row, version), bytesOf(installerName(row, version)));
      const named = rows.filter((r) => FEED_KINDS[os]!.includes(r.kind)).map((r) => installerName(r, version));
      for (const c of channelsServed(channel)) {
        const files = named.map((url) => ({ url, sha512: sha512Base64(bytesOf(url)), size: bytesOf(url).length }));
        put(appFeedFile(app, c, os), formatUpdateInfo({ version, files, path: files[0]!.url, sha512: files[0]!.sha512, releaseDate: "2026-12-01T00:00:00.000Z" }));
      }
    }
    // The engine's files, once per system.
    const [core, ...coreFeeds] = coreArtifacts(version, os, channel);
    put(core!, bytesOf(core!));
    for (const f of coreFeeds) put(f, formatCoreFeed({ version, file: core!, sha512: sha512Base64(bytesOf(core!)), size: bytesOf(core!).length }));
    const [bun, ...bunFeeds] = pluginBunArtifacts(os, channel);
    put(bun!, bytesOf(bun!));
    for (const f of bunFeeds) put(f, formatCoreFeed({ version: PLUGIN_BUN.version, file: bun!, sha512: sha512Base64(bytesOf(bun!)), size: bytesOf(bun!).length }));
    const [plugins, ...pluginsFeeds] = pluginsArtifacts(version, os, channel);
    put(plugins!, bytesOf(plugins!));
    for (const f of pluginsFeeds) put(f, formatCoreFeed({ version, file: plugins!, sha512: sha512Base64(bytesOf(plugins!)), size: bytesOf(plugins!).length }));
    put(buildCommitFile(os), `${commit}\n`);
  }
  return written;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (dir === undefined || dir.startsWith("--")) { console.error("usage: bun scripts/release/fixture.ts <dir> [--channel latest|beta] [--version N.N.N]"); process.exit(2); }
  const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const version = flag("--version") ?? (JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "apps", "desktop", "package.json"), "utf8")) as { version: string }).version;
  console.log(`fixture: ${writeReleaseFixture(dir, version, parseChannel(flag("--channel") ?? "latest")).length} files for ${version} in ${dir}`);
}
