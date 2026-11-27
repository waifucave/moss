// Lane XC, the owner's ruling of 2026-11-27 ("Allow, and say so"): the `app` role on Linux and Windows is checked by
// what those OSes allow (platform/app-image.ts). The judges on every OS; live on Linux, an executable laid out as ours
// accepted as "unverified", a replaced, traced or foreign one refused; live on Windows, the per-user install's exe
// accepted, the same file elsewhere refused; and the dev and test seam compiled out of a release build.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import {
  appImageCheck, imageSeam, integrityRidOf, judgeLinuxImage, judgeWindowsImage as judgeWindowsOn, linuxFacts,MEDIUM_INTEGRITY, rootOwnedChain, rootOwnedProblem, windowsFacts, type AppImageFacts,
} from "../../src/platform/app-image";
import type { PeerFacts } from "../../src/platform/caller-probe";
import { MOSS_METHODS } from "@waifucave/moss-protocol";
import { hostOs } from "../../src/tree/names";
import { TEST_ONLY_CORE_STRINGS } from "../../../../scripts/test-build";

const MARKER = "MOSS_APP_IMAGE_LOOSE_SEAM";
const temps: string[] = [];
const kids: ChildProcess[] = [];
afterAll(async () => {
  // Each child ended and waited for first: Windows won't remove an executable a process still runs from.
  await Promise.all(kids.splice(0).map((k) => new Promise<void>((done) => {
    if (k.exitCode !== null || k.signalCode !== null) return done();
    k.once("exit", () => done());
    try { k.kill("SIGKILL"); } catch { done(); }
  })));
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
function temp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}
const peer = (pid: number | null): PeerFacts => ({ pid, ancestors: [], probe: {}, floor: "outside-floor" });
const linux = (f: Partial<AppImageFacts>): AppImageFacts => ({ image: null, tracer: 0, stillThere: true, rootOwned: () => true, hasAppAsar: () => true, ...f });

describe("the Linux judge", () => {
  test("the installed path, root-owned: verified; the same name elsewhere with its app.asar: unverified, still accepted", () => {
    expect(judgeLinuxImage(linux({ image: "/opt/moss-code/moss-code" }), undefined)).toEqual({ ok: true, verified: true, image: "/opt/moss-code/moss-code" });
    expect(judgeLinuxImage(linux({ image: "/opt/moss/moss-app" }), undefined)).toMatchObject({ ok: true, verified: true });
    expect(judgeLinuxImage(linux({ image: "/opt/moss/resources/host/moss-host" }), undefined)).toMatchObject({ ok: true, verified: true });
    // At its installed path but user-writable (someone chowned it): no longer verified.
    expect(judgeLinuxImage(linux({ image: "/opt/moss-code/moss-code", rootOwned: () => false }), undefined)).toMatchObject({ ok: true, verified: false });
    expect(judgeLinuxImage(linux({ image: "/tmp/.mount_MOSSabc/moss-code", rootOwned: () => false }), undefined)).toMatchObject({ ok: true, verified: false });
  });

  test("refused: a foreign image, ours with no app.asar beside it, a replaced file, a tracer, an unreadable fact, a process gone", () => {
    for (const image of ["/usr/bin/python3", "/home/u/.bun/bin/bun", "/usr/bin/node", "/home/u/moss-code-x"]) {
      expect(judgeLinuxImage(linux({ image, rootOwned: () => false, hasAppAsar: () => false }), undefined).ok).toBe(false);
    }
    expect(judgeLinuxImage(linux({ image: "/home/u/bin/moss-code", rootOwned: () => false, hasAppAsar: () => false }), undefined).ok).toBe(false);
    expect(judgeLinuxImage(linux({ image: "/opt/moss-code/moss-code (deleted)" }), undefined)).toMatchObject({ ok: false, why: expect.stringContaining("replaced") });
    expect(judgeLinuxImage(linux({ image: "/opt/moss-code/moss-code", tracer: 4242 }), undefined)).toMatchObject({ ok: false, why: expect.stringContaining("traced") });
    expect(judgeLinuxImage(linux({ image: "/opt/moss-code/moss-code", tracer: null }), undefined).ok).toBe(false);
    expect(judgeLinuxImage(linux({ image: null }), undefined).ok).toBe(false);
    expect(judgeLinuxImage(linux({ image: "/opt/moss-code/moss-code", stillThere: false }), undefined)).toMatchObject({ ok: false, why: expect.stringContaining("exited") });
    // A name with control characters is folded out of the reason.
    const why = (judgeLinuxImage(linux({ image: "/x/a\u001b[31m\u202eb", hasAppAsar: () => false }), undefined) as { why: string }).why;
    expect(/[\u0000-\u001f\u202e]/.test(why)).toBe(false);
  });

  test("the seam (a dev or test build): our names and the dev Electron anywhere, marked; nothing else", () => {
    expect(imageSeam).toBeFunction(); // a test process runs from source: no release define
    expect(judgeLinuxImage(linux({ image: "/w/apps/desktop/node_modules/electron/dist/electron", hasAppAsar: () => false, rootOwned: () => false }), imageSeam)).toMatchObject({ ok: true, verified: false, seam: MARKER });
    expect(judgeLinuxImage(linux({ image: "/w/out/linux-unpacked/moss-code", hasAppAsar: () => false, rootOwned: () => false }), imageSeam)).toMatchObject({ ok: true, seam: MARKER });
    expect(judgeLinuxImage(linux({ image: "/usr/bin/python3", hasAppAsar: () => false, rootOwned: () => false }), imageSeam).ok).toBe(false);
    // Never past a tracer or a replaced file.
    expect(judgeLinuxImage(linux({ image: "/w/electron", tracer: 7 }), imageSeam).ok).toBe(false);
    expect(judgeLinuxImage(linux({ image: "/w/electron (deleted)" }), imageSeam).ok).toBe(false);
  });

  test("root-owned all the way up, writable by no one else", () => {
    const tree: Record<string, { uid: number; mode: number }> = { "/": { uid: 0, mode: 0o40755 }, "/opt": { uid: 0, mode: 0o40755 }, "/opt/moss": { uid: 0, mode: 0o40755 }, "/opt/moss/moss-app": { uid: 0, mode: 0o100755 } };
    const stat = (t: typeof tree) => (p: string) => t[p] ?? null;
    expect(rootOwnedChain("/opt/moss/moss-app", stat(tree))).toBe(true);
    expect(rootOwnedChain("/opt/moss/moss-app", stat({ ...tree, "/opt/moss": { uid: 1000, mode: 0o40755 } }))).toBe(false);
    expect(rootOwnedChain("/opt/moss/moss-app", stat({ ...tree, "/opt": { uid: 0, mode: 0o40777 } }))).toBe(false);
    expect(rootOwnedChain("/opt/moss/moss-app", stat({ ...tree, "/opt/moss/moss-app": { uid: 0, mode: 0o100775 } }))).toBe(false);
    expect(rootOwnedChain("/opt/moss/moss-app", stat({ ...tree, "/opt": undefined as never }))).toBe(false);
  });
  test("why it failed, for the log: the first path on the chain, its owner and mode", () => {
    const tree: Record<string, { uid: number; mode: number }> = { "/": { uid: 0, mode: 0o40755 }, "/opt": { uid: 0, mode: 0o40755 }, "/opt/moss": { uid: 0, mode: 0o40755 }, "/opt/moss/moss-app": { uid: 0, mode: 0o100755 } };
    const stat = (t: typeof tree) => (p: string) => t[p] ?? null;
    expect(rootOwnedProblem("/opt/moss/moss-app", stat(tree))).toBeUndefined();
    expect(rootOwnedProblem("/opt/moss/moss-app", stat({ ...tree, "/opt/moss": { uid: 0, mode: 0o40775 } }))).toBe("/opt/moss: owner uid 0, mode 0775");
    expect(rootOwnedProblem("/opt/moss/moss-app", stat({ ...tree, "/opt": undefined as never }))).toBe("/opt couldn't be read");
  });
  test("the engine's line names that path when an install at the packages' path comes out unverified", () => {
    const lines: string[] = [];
    const check = appImageCheck("linux", { log: (l) => lines.push(l), seam: undefined, facts: () => ({ image: "/opt/moss/moss-app", tracer: 0, stillThere: true, rootOwned: () => false, rootOwnedWhy: () => "/opt/moss: owner uid 0, mode 0775", hasAppAsar: () => true }) });
    expect(check({ pid: 1, uid: 0 } as never)).toBe(true);
    expect(lines).toEqual(["[moss] app connection from /opt/moss/moss-app: unverified image (a user-writable install: /opt/moss: owner uid 0, mode 0775)"]);
  });
});

/** A machine whose user folder `C:\Users\runneradmin` has the 8.3 name `RUNNER~1` (as GitHub's runners), every path
 *  there; `GetLongPathNameW` as the fold asks it. */
const RUNNER_MACHINE = { win32: true, long: (p: string) => p.replace(/\\RUNNER~1(?=\\|$)/gi, "\\runneradmin") };
/** The judge on that machine (the live Windows case below asks the real one). */
const judgeWindowsImage = (f: AppImageFacts, lad: string | undefined, seam: typeof imageSeam) => judgeWindowsOn(f, lad, seam, RUNNER_MACHINE);

describe("the Windows judge", () => {
  const lad = "C:\\Users\\u\\AppData\\Local";
  const win = (f: Partial<AppImageFacts>): AppImageFacts => ({ image: null, integrity: MEDIUM_INTEGRITY, stillThere: true, ...f });
  test("an 8.3 short name on either side (RUNNER~1 for runneradmin), the extended prefix, a trailing dot: the same install", () => {
    const short = "C:\\Users\\RUNNER~1\\AppData\\Local", long = "C:\\Users\\runneradmin\\AppData\\Local";
    const exe = (root: string) => win32.join(root, "Programs", "@waifucavemoss-desktop", "MOSS Code.exe");
    expect(judgeWindowsImage(win({ image: exe(long) }), short, undefined)).toMatchObject({ ok: true, verified: false });
    expect(judgeWindowsImage(win({ image: exe(short) }), long, undefined)).toMatchObject({ ok: true });
    expect(judgeWindowsImage(win({ image: `\\\\?\\${exe(long)}` }), short, undefined)).toMatchObject({ ok: true });
    expect(judgeWindowsImage(win({ image: exe(long).replace("Programs", "Programs.") }), long, undefined)).toMatchObject({ ok: true });
    // A spelling the fold can't judge (a UNC path, a stream, a short name it can't expand) matches nothing.
    expect(judgeWindowsImage(win({ image: `\\\\localhost\\C$\\Users\\runneradmin\\AppData\\Local\\Programs\\@waifucavemoss-desktop\\MOSS Code.exe` }), long, undefined).ok).toBe(false);
    expect(judgeWindowsImage(win({ image: `${exe(long)}:evil` }), long, undefined).ok).toBe(false);
    expect(judgeWindowsOn(win({ image: exe(long) }), short, undefined, { win32: true, long: () => null }).ok).toBe(false);
  });
  test("the per-user install's executables, any case: accepted, never verified (the user can write them)", () => {
    for (const p of ["@waifucavemoss-desktop\\MOSS Code.exe", "@waifucavemoss-moss\\MOSS.exe", "@waifucavemoss-moss\\resources\\host\\moss-host.exe"]) {
      expect(judgeWindowsImage(win({ image: win32.join(lad, "Programs", p) }), lad, undefined)).toMatchObject({ ok: true, verified: false });
    }
    expect(judgeWindowsImage(win({ image: "c:\\users\\U\\appdata\\local\\programs\\@WAIFUCAVEMOSS-DESKTOP\\moss code.exe", integrity: 0x3000 }), lad, undefined).ok).toBe(true);
  });
  test("refused: another path, below medium integrity, no integrity read, no LOCALAPPDATA, a process gone", () => {
    expect(judgeWindowsImage(win({ image: "C:\\Users\\u\\Downloads\\MOSS Code.exe" }), lad, undefined).ok).toBe(false);
    expect(judgeWindowsImage(win({ image: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }), lad, undefined).ok).toBe(false);
    const installed = win32.join(lad, "Programs", "@waifucavemoss-moss\\MOSS.exe");
    expect(judgeWindowsImage(win({ image: installed, integrity: 0x1000 }), lad, undefined)).toMatchObject({ ok: false, why: expect.stringContaining("integrity") });
    expect(judgeWindowsImage(win({ image: installed, integrity: null }), lad, undefined).ok).toBe(false);
    expect(judgeWindowsImage(win({ image: installed }), undefined, undefined).ok).toBe(false);
    expect(judgeWindowsImage(win({ image: installed, stillThere: false }), lad, undefined).ok).toBe(false);
  });
  test("the seam: our names and the dev Electron anywhere, marked; never below medium integrity", () => {
    expect(judgeWindowsImage(win({ image: "D:\\a\\moss\\apps\\desktop\\dist\\win-unpacked\\MOSS Code.exe" }), lad, imageSeam)).toMatchObject({ ok: true, seam: MARKER });
    expect(judgeWindowsImage(win({ image: "D:\\a\\node_modules\\electron\\dist\\electron.exe" }), lad, imageSeam)).toMatchObject({ ok: true, seam: MARKER });
    expect(judgeWindowsImage(win({ image: "C:\\x\\bun.exe" }), lad, imageSeam).ok).toBe(false);
    expect(judgeWindowsImage(win({ image: "D:\\a\\MOSS.exe", integrity: 0x1000 }), lad, imageSeam).ok).toBe(false);
  });
  test("the integrity level's RID, read from a TOKEN_MANDATORY_LABEL whose SID sits in the same buffer", () => {
    const buf = Buffer.alloc(64);
    const base = 0x10_0000n;
    buf.writeBigUInt64LE(base + 16n, 0); // the SID right after the label
    buf[16] = 1; buf[17] = 1; buf[23] = 16; // revision 1, one sub-authority, the mandatory label authority
    buf.writeUInt32LE(0x2000, 24);
    expect(integrityRidOf(buf, base)).toBe(0x2000);
    buf.writeBigUInt64LE(base + 4096n, 0);
    expect(integrityRidOf(buf, base)).toBeNull();
  });
});

describe("what rides the check", () => {
  test("host.ready and device.programKey.set are the app role's alone, so a refused app hello reaches neither", () => {
    expect(MOSS_METHODS.get("host.ready")?.roles).toEqual(["app"]);
    expect(MOSS_METHODS.get("device.programKey.set")?.roles).toEqual(["app"]);
  });
});

describe("the seam is compiled out of a release", () => {
  const build = async (define: Record<string, string>) => {
    // As the release's `compile:core` builds (packages/cli/package.json): no minify, the defines alone fold the branch.
    const r = await Bun.build({ entrypoints: [join(import.meta.dir, "../../src/platform/app-image.ts")], target: "bun", define, ...{ macros: false } });
    expect(r.success).toBe(true);
    return (await Promise.all(r.outputs.map((o) => o.text()))).join("\n");
  };
  test("a release's defines drop it and its marker; a test build and a checkout keep it; the release gate knows the marker", async () => {
    expect(await build({ __MOSS_DIST__: "true", __MOSS_TEST_BUILD__: "false" })).not.toContain(MARKER);
    expect(await build({ __MOSS_DIST__: "true", __MOSS_TEST_BUILD__: JSON.stringify("MOSS-TEST-BUILD") })).toContain(MARKER);
    expect(await build({})).toContain(MARKER);
    expect(TEST_ONLY_CORE_STRINGS as readonly string[]).toContain(MARKER);
  }, 60_000);
});

const linuxTest = hostOs() === "linux" ? test : test.skip;
const windowsTest = hostOs() === "windows" ? test : test.skip;

describe("live on Linux: the real /proc facts", () => {
  /** A copy of `sleep` named `name` in a folder of its own, with or without an app.asar beside it, started. */
  const started = (name: string, asar: boolean): { pid: number; exe: string; child: ChildProcess } => {
    const dir = temp("xc-app-image-");
    const exe = join(dir, name);
    copyFileSync("/bin/sleep", exe);
    if (asar) { mkdirSync(join(dir, "resources")); writeFileSync(join(dir, "resources", "app.asar"), "asar"); }
    const child = spawn(exe, ["30"], { stdio: "ignore" });
    kids.push(child);
    return { pid: child.pid!, exe, child };
  };
  const settle = () => Bun.sleepSync(150);

  linuxTest("our executable with its app.asar: unverified, accepted; with none, or a foreign one (this test's bun): refused", () => {
    const ours = started("moss-code", true);
    settle();
    expect(judgeLinuxImage(linuxFacts(peer(ours.pid)), undefined)).toEqual({ ok: true, verified: false, image: ours.exe });
    const bare = started("moss-app", false);
    settle();
    expect(judgeLinuxImage(linuxFacts(peer(bare.pid)), undefined).ok).toBe(false);
    expect(judgeLinuxImage(linuxFacts(peer(process.pid)), undefined).ok).toBe(false);
    expect(judgeLinuxImage(linuxFacts(peer(process.pid)), imageSeam).ok).toBe(false);
  });

  linuxTest("its file removed while it runs: refused as replaced", () => {
    const ours = started("moss-host", true);
    settle();
    rmSync(ours.exe);
    expect(judgeLinuxImage(linuxFacts(peer(ours.pid)), undefined)).toMatchObject({ ok: false, why: expect.stringContaining("replaced") });
  });

  linuxTest("traced (started by a parent that traces it, as Yama's scope 1 allows): refused", async () => {
    if (spawnSync("python3", ["-c", "0"]).status !== 0) throw new Error("python3 is needed for the traced case");
    const dir = temp("xc-app-image-traced-");
    const exe = join(dir, "moss-code");
    copyFileSync("/bin/sleep", exe);
    mkdirSync(join(dir, "resources"));
    writeFileSync(join(dir, "resources", "app.asar"), "asar");
    // The tracer forks, the child asks to be traced and execs our name; the tracer prints the child's pid and waits.
    const script = `import ctypes, os, sys, time
libc = ctypes.CDLL(None, use_errno=True)
pid = os.fork()
if pid == 0:
    libc.ptrace(0, 0, None, None)
    os.execv(sys.argv[1], [sys.argv[1], "30"])
print(pid, flush=True)
time.sleep(30)`;
    const tracer = spawn("python3", ["-c", script, exe], { stdio: ["ignore", "pipe", "ignore"] });
    kids.push(tracer);
    let out = "";
    tracer.stdout!.on("data", (b: Buffer) => { out += b.toString(); });
    // Awaited, not slept: the tracer's output arrives on the event loop.
    for (let i = 0; i < 100 && !/\d+\n/.test(out); i++) await Bun.sleep(100);
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    await Bun.sleep(200);
    const f = linuxFacts(peer(pid));
    try {
      expect(f.tracer).toBe(tracer.pid!);
      expect(judgeLinuxImage(f, undefined)).toMatchObject({ ok: false, why: expect.stringContaining("traced") });
    } finally { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }, 30_000);
});

describe("live on Windows: the real image and integrity", () => {
  windowsTest("the per-user install's exe: accepted; the same file elsewhere, or this test's bun: refused (the seam marks the copy)", () => {
    const lad = temp("xc-app-image-lad-");
    const installed = join(lad, "Programs", "@waifucavemoss-desktop", "MOSS Code.exe");
    mkdirSync(join(lad, "Programs", "@waifucavemoss-desktop"), { recursive: true });
    const ping = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE");
    copyFileSync(ping, installed);
    const elsewhere = join(temp("xc-app-image-dl-"), "MOSS Code.exe");
    copyFileSync(ping, elsewhere);
    const a = spawn(installed, ["-n", "30", "127.0.0.1"], { stdio: "ignore" });
    const b = spawn(elsewhere, ["-n", "30", "127.0.0.1"], { stdio: "ignore" });
    kids.push(a, b);
    Bun.sleepSync(300);
    const fa = windowsFacts(peer(a.pid!));
    expect(fa.integrity).toBeGreaterThanOrEqual(MEDIUM_INTEGRITY);
    // This machine's own spelling fold (GetLongPathNameW), as the daemon judges.
    expect(judgeWindowsOn(fa, lad, undefined)).toMatchObject({ ok: true, verified: false });
    // %LOCALAPPDATA% in its 8.3 form (the runner's TEMP is `C:\Users\RUNNER~1\…`): still the same install.
    const shortTemp = process.env.TEMP ?? "";
    const longTemp = shortTemp === "" ? "" : realpathSync.native(shortTemp);
    const shortLad = shortTemp !== "" && shortTemp.toLowerCase() !== longTemp.toLowerCase() && lad.toLowerCase().startsWith(longTemp.toLowerCase()) ? shortTemp + lad.slice(longTemp.length) : undefined;
    console.log(`app-image live: the install's folder spelled short as well: ${shortLad !== undefined}`);
    if (shortLad !== undefined) expect(judgeWindowsOn(fa, shortLad, undefined)).toMatchObject({ ok: true, verified: false });
    const fb = windowsFacts(peer(b.pid!));
    expect(judgeWindowsOn(fb, lad, undefined).ok).toBe(false);
    expect(judgeWindowsOn(fb, lad, imageSeam)).toMatchObject({ ok: true, seam: MARKER });
    expect(judgeWindowsOn(windowsFacts(peer(process.pid)), lad, undefined).ok).toBe(false);
  });
});
