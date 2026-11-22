// MOSS carries the background host too (spec §3.1: each app carries the engine and the host; R7: the host has ONE fixed
// identity, the same in both apps; lane PK). electron-builder's `afterPack` (electron-builder.yml): after MOSS.app is laid
// out and before its fuses are flipped and it is signed, it puts the host helper MOSS Code's build just made into
// `MOSS.app/Contents/Frameworks/MOSS Host.app`, so MOSS's own signing seals it with MOSS.
//
// The helper is MOSS Code's, byte for byte (its app.asar is MOSS Code's main process, which is the host when it runs from the
// helper: apps/desktop/src/main/host-program.ts), never one made from MOSS's own app.asar, which has no host in it. So it is
// made once, by MOSS Code's afterPack (apps/desktop/scripts/host-helper.mjs), and copied from the stash the release build
// names (`MOSS_HOST_HELPER_STASH`), which also refuses a MOSS without it (scripts/release/build.ts). A plain `bun run dist`
// names none: MOSS is packaged without a host, and says so.
import { chmodSync, cpSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

export const HOST_HELPER_STASH_ENV = "MOSS_HOST_HELPER_STASH";

/** The helper's name MOSS's profile carries (the engine's `hostProductName`): `.dev` ids carry the dev host. */
export function hostHelperName(appId) {
  return appId.endsWith(".dev") ? "MOSS Host Dev.app" : "MOSS Host.app";
}

/** Copies the stashed helper into the laid-out app; returns its path, or undefined when the stash holds none for this profile. */
export function carryHostHelper({ appPath, appId, stash }) {
  const name = hostHelperName(appId);
  const from = join(stash, name);
  if (!existsSync(join(from, "Contents", "Info.plist"))) return undefined;
  const to = join(appPath, "Contents", "Frameworks", name);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  return to;
}

/** Windows and Linux (the release wave, lane RP): the host is MOSS Code's program, started as `<its executable> --moss-program=host`
 *  (apps/desktop/src/main/host-program.ts), and MOSS's app.asar has no host in it. So MOSS carries MOSS Code's whole unpacked app in
 *  `resources/host/`, its executable renamed `moss-host[.exe]`, from the folder the release build names (`MOSS_HOST_TREE_FROM`:
 *  MOSS Code's `win-unpacked` or `linux-unpacked`). The engine and the bundled tree are MOSS's own beside it, never copied twice
 *  (scripts/release/two-apps.ts's `hostTreeProblems` holds the result to MOSS Code's app.asar). */
export const HOST_TREE_FROM_ENV = "MOSS_HOST_TREE_FROM";
export const HOST_TREE_DIR = "host";
/** MOSS Code's executable in its unpacked app, by platform. */
export const CODE_EXECUTABLE = { linux: "moss-code", win32: "MOSS Code.exe" };
const NOT_COPIED = new Set(["resources/daemon", "resources/plugins", "resources/apparmor-profile"]);

/** Copies the unpacked MOSS Code in `from` to `<resourcesDir>/host`; returns the host's executable path, or undefined when `from` holds no MOSS Code. */
export function carryHostTree({ resourcesDir, from, platform }) {
  const code = CODE_EXECUTABLE[platform];
  if (code === undefined || !existsSync(join(from, code))) return undefined;
  const to = join(resourcesDir, HOST_TREE_DIR);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !NOT_COPIED.has(relative(from, src).split("\\").join("/")),
  });
  const exe = join(to, platform === "win32" ? "moss-host.exe" : "moss-host");
  renameSync(join(to, code), exe);
  if (platform !== "win32") chmodSync(exe, 0o755);
  return exe;
}

/** electron-builder's `afterPack`. */
export default async function afterPack(context) {
  if (context.electronPlatformName === "linux" || context.electronPlatformName === "win32") {
    const from = process.env[HOST_TREE_FROM_ENV];
    if (!from) {
      console.log("  • no host for MOSS (a plain dist: the release build names MOSS Code's unpacked app)");
      return;
    }
    const exe = carryHostTree({ resourcesDir: join(context.appOutDir, "resources"), from, platform: context.electronPlatformName });
    if (exe === undefined) throw new Error(`MOSS's build was given ${HOST_TREE_FROM_ENV} (${from}) but it holds no MOSS Code to carry as the host`);
    console.log(`  • host (MOSS Code's app)  ${exe}`);
    return;
  }
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "mas") return;
  const packager = context.packager;
  const appPath = join(context.appOutDir, `${packager.appInfo.productFilename}.app`);
  const stash = process.env[HOST_HELPER_STASH_ENV];
  if (!stash) {
    console.log("  • no host helper for MOSS (a plain dist: the release build stages MOSS Code's)");
    return;
  }
  const host = carryHostHelper({ appPath, appId: packager.appInfo.id, stash });
  if (host === undefined) throw new Error(`MOSS's build was given ${HOST_HELPER_STASH_ENV} but it holds no ${hostHelperName(packager.appInfo.id)} (found: ${existsSync(stash) ? readdirSync(stash).join(", ") || "nothing" : "no folder"})`);
  console.log(`  • host helper (MOSS Code's)  ${host}`);
}
