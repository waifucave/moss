// CI's install-and-remove of the built installers (the release wave, lane RP), on the runner that built them: the Linux packages have
// theirs in the packages job (dpkg and dnf); this does macOS (each dmg mounted read-only, its app copied out, checked and removed)
// and Windows (each per-user NSIS installer run silently, the engine run from the install, the apps removed one at a time). Both
// apps are installed together, and removing one must leave the other working (spec §3.1). Nothing here is signed, opened as an app
// or registered: a disposable runner is its only target, and a Mac or a Windows PC of a person is never one.
//
//   bun scripts/release/install-check.ts mac|win [--dir <the build's folder>]
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { engineFile } from "./lib";
import { installersOf, type AppKey } from "./artifacts";
import { HOST_HELPER, HOST_TREE_DIR, hostExecutableName } from "./two-apps";

const APPS: Readonly<Record<AppKey, { product: string; identifier: string }>> = {
  code: { product: "MOSS Code", identifier: "com.waifucave.moss.code" },
  moss: { product: "MOSS", identifier: "com.waifucave.moss" },
};

function run(cmd: string[], env: Record<string, string> = {}): { status: number; out: string } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function must(what: string, cond: boolean, detail = ""): void {
  if (!cond) throw new Error(`${what}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`install-check: ok: ${what}`);
}

/** The engine run from an installed app answers `--version` as the release's (in a home of its own). */
function engineSays(core: string, version: string): void {
  const home = mkdtempSync(join(tmpdir(), "moss-install-check-home-"));
  try {
    const r = run([core, "--version"], { MOSS_HOME: home });
    must(`${core} --version`, r.status === 0 && r.out === `moss ${version}`, r.out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function checkMac(dist: string, version: string): void {
  const work = mkdtempSync(join(tmpdir(), "moss-install-check-mac-"));
  try {
    for (const [key, app] of Object.entries(APPS) as Array<[AppKey, (typeof APPS)[AppKey]]>) {
      const dmg = join(dist, installersOf(version, "mac", key).find((n) => n.endsWith(".dmg"))!);
      const mount = join(work, `mount-${key}`);
      mkdirSync(mount);
      // Read-only, not browsable, never opened: mounted and detached in this step.
      must(`${dmg} mounts read-only`, run(["hdiutil", "attach", "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mount, dmg]).status === 0);
      try {
        const bundle = join(mount, `${app.product}.app`);
        must(`${app.product}.app is in its dmg`, existsSync(join(bundle, "Contents", "Info.plist")));
        // "Installed": copied out of the dmg to a folder of this run's own (never /Applications), checked there, and removed.
        const installed = join(work, `Applications-${key}`);
        mkdirSync(installed);
        must(`${app.product}.app copies out of the dmg`, run(["ditto", bundle, join(installed, `${app.product}.app`)]).status === 0);
        const copy = join(installed, `${app.product}.app`);
        const id = run(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", join(copy, "Contents", "Info.plist")]).out;
        must(`${app.product}.app is ${app.identifier}`, id === app.identifier, id);
        must(`${app.product}.app carries the engine, the bundled tree and the host helper`, [`Contents/Resources/daemon/${engineFile("mac")}`, "Contents/Resources/plugins/moss/moss.json", `Contents/Frameworks/${HOST_HELPER}/Contents/Info.plist`].every((f) => existsSync(join(copy, f))));
        engineSays(join(copy, "Contents", "Resources", "daemon", engineFile("mac")), version);
        rmSync(installed, { recursive: true, force: true });
        must(`${app.product}.app is removed`, !existsSync(copy));
      } finally {
        if (run(["hdiutil", "detach", mount]).status !== 0) run(["hdiutil", "detach", "-force", mount]);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The folder electron-builder's per-user NSIS installer makes: the app's package name without the slash. */
export function windowsInstallFolder(key: AppKey): string {
  const dir = key === "code" ? "desktop" : "moss";
  const name = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", dir, "package.json"), "utf8")) as { name: string }).name;
  return name.replace("/", "");
}

/** A per-user NSIS install lives under %LOCALAPPDATA%\Programs\<package name>. */
export function windowsInstallDir(localAppData: string, key: AppKey): string {
  return join(localAppData, "Programs", windowsInstallFolder(key));
}

/** For a failed install: what is in the per-user Programs folder and the usual machine-wide ones. */
function whereIs(local: string, product: string): string {
  const roots = [join(local, "Programs"), process.env.ProgramFiles ?? "", process.env["ProgramFiles(x86)"] ?? "", local].filter((r) => r !== "");
  return roots.map((r) => `${r}: ${existsSync(r) ? readdirSync(r).filter((n) => /moss/i.test(n) || r === join(local, "Programs")).join(", ") || "(none)" : "(missing)"}`).join("; ") + ` [${product}]`;
}

export function checkWin(dist: string, version: string): void {
  const local = process.env.LOCALAPPDATA;
  if (local === undefined || local === "") throw new Error("no LOCALAPPDATA: a per-user install needs a user profile");
  const dirs = { code: windowsInstallDir(local, "code"), moss: windowsInstallDir(local, "moss") };
  for (const [key, app] of Object.entries(APPS) as Array<[AppKey, (typeof APPS)[AppKey]]>) {
    const exe = join(dist, installersOf(version, "win", key)[0]!);
    // /S: silent (and a silent install doesn't start the app); it returns when the install is done.
    const r = run([exe, "/S"]);
    must(`${app.product}'s installer runs silently`, r.status === 0, r.out);
    // The installer may hand off to a second process: wait for the app, and say where things are if it never shows up.
    const exePath = join(dirs[key], `${app.product}.exe`);
    for (let i = 0; i < 60 && !existsSync(exePath); i++) Bun.sleepSync(1000);
    must(`${app.product} is installed in ${dirs[key]}`, existsSync(exePath), whereIs(local, app.product));
    must(`${app.product} carries the engine and the bundled tree`, existsSync(join(dirs[key], "resources", "daemon", engineFile("win"))) && existsSync(join(dirs[key], "resources", "plugins", "moss", "moss.json")));
    engineSays(join(dirs[key], "resources", "daemon", engineFile("win")), version);
  }
  // MOSS carries the host: MOSS Code's app, as moss-host.exe in its own folder (a MOSS-only install has a host to start).
  const host = join(dirs.moss, "resources", HOST_TREE_DIR, hostExecutableName("win"));
  must("MOSS carries the host (resources/host/moss-host.exe)", existsSync(host) && statSync(host).size > 0);
  must("and it runs MOSS Code's own code", readFileSync(join(dirs.moss, "resources", HOST_TREE_DIR, "resources", "app.asar")).equals(readFileSync(join(dirs.code, "resources", "app.asar"))));
  // The app role through the installed engine's own caller check (lane XC, platform/app-image.ts): each installed app gets
  // it (a per-user install: the "unverified" branch, never verified on Windows), the ENGINE starts its host through the task
  // `autostart enable` writes (on this runner's default home) and the host says host.ready, and a script with the app token
  // is refused (scripts/release/app-role-check.ts).
  const role = run([process.execPath, join(dirname(fileURLToPath(import.meta.url)), "app-role-check.ts"), "--core", join(dirs.code, "resources", "daemon", engineFile("win")),
    "--app", join(dirs.moss, `${APPS.moss.product}.exe`), "--app", join(dirs.code, `${APPS.code.product}.exe`), "--engine-starts-host", "--expect", "unverified"]);
  console.log(role.out);
  must("the installed apps get the app role through the engine's own check, its host says host.ready, a script with the token is refused", role.status === 0, role.out.split("\n").slice(-5).join(" | "));
  // Removing one app leaves the other working: MOSS first (MOSS Code stays), then MOSS Code. `_?=<dir>` makes the uninstaller
  // synchronous (it otherwise copies itself aside and returns at once); it leaves its own exe and folder behind.
  for (const key of ["moss", "code"] as const) {
    const app = APPS[key];
    const uninstaller = join(dirs[key], `Uninstall ${app.product}.exe`);
    must(`${app.product} has an uninstaller`, existsSync(uninstaller));
    const r = run([uninstaller, "/S", `_?=${dirs[key]}`]);
    must(`${app.product} uninstalls silently`, r.status === 0, r.out);
    must(`${app.product}'s engine and app are removed`, !existsSync(join(dirs[key], "resources", "daemon", engineFile("win"))) && !existsSync(join(dirs[key], `${app.product}.exe`)));
    if (key === "moss") engineSays(join(dirs.code, "resources", "daemon", engineFile("win")), version);
  }
  must("both apps are gone", !existsSync(join(dirs.moss, "resources")) && !existsSync(join(dirs.code, "resources")));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const di = argv.indexOf("--dir");
  const dist = di >= 0 ? argv[di + 1]! : join(root, "apps", "desktop", "out", "dist");
  const version = (JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")) as { version: string }).version;
  try {
    if (argv[0] === "mac") checkMac(dist, version);
    else if (argv[0] === "win") checkWin(dist, version);
    else { console.error("usage: bun scripts/release/install-check.ts mac|win [--dir <folder>]"); process.exit(2); }
  } catch (err) {
    // stdout, and an exit code set rather than process.exit: Bun on Windows can drop stderr at an immediate exit.
    console.log(`install-check: FAILED: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
