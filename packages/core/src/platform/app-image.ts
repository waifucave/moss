// The `app` role's image check on Linux and Windows (lane XC; the owner's ruling of 2026-11-27, "Allow, and say so").
// macOS proves the app by its code signature (`peer-signature.ts`). Linux and Windows have no signature MOSS can check
// on a running process (the first Windows release is unsigned, Linux has no code signing), so these are the cheap
// checks those OSes allow. They stop a script that read `<home>/run/app.token` and replays it: its process is a shell,
// Python or Bun, never MOSS's own executable. They do NOT stop a program of the person's that starts the real app
// itself under LD_PRELOAD, or as a child it traces, or that replaces a user-writable install: those OSes can't tell
// MOSS from another program running as the person (docs/across-computers-owed.md, the site docs' security page).
//
//   Linux    the peer as the connection's pidfd holds it (SO_PEERPIDFD, kernel 6.5 or later; before it the pid alone,
//            a stated residual); its image (`/proc/<pid>/exe`) one of the three programs' executables, never a
//            replaced one ("(deleted)"); no tracer (`TracerPid: 0`); and the pidfd still naming that process after the
//            reads. The image at its installed path (the deb and rpm's `/opt/...`), the file and every folder above it
//            root-owned and writable by no one else, is "verified"; the same executable anywhere else (an AppImage's
//            mount, a home install: user-writable) is "unverified", still accepted, and logged. PR_SET_DUMPABLE is not
//            asked of the app: a non-dumpable process's `exe` and namespaces can't be read by a same-user process, so
//            this check and the caller floor could read nothing (Yama's ptrace_scope 1, the default on Ubuntu and
//            Fedora, already keeps a same-user process from attaching to an app it didn't start).
//   Windows  the pipe client's image (QueryFullProcessImageName) the per-user install's executable, under
//            %LOCALAPPDATA%\Programs; its integrity level medium or higher. "In no job of ours" is the caller check's
//            own (`spawnedByDaemon`: a process in the daemon's job is never the user, so never the app).
//
// The test and dev seam (`imageSeam`): a build that isn't a release (no `__MOSS_DIST__`), or a test-marked one,
// also takes the programs' executables outside the install and the dev app's Electron. Compiled out of a release, and
// the release gate refuses a real core that carries its marker (scripts/test-build.ts `TEST_ONLY_CORE_STRINGS`).
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { ffiLib, ffiPtr as ptr } from "./ffi";
import { foldedSpelling, UNJUDGEABLE, type SpellingOptions } from "../fence/spelling";
import type { PeerFacts } from "./caller-probe";

declare const __MOSS_DIST__: boolean | undefined;
declare const __MOSS_TEST_BUILD__: string | false | undefined;

/** The programs' executables as the Linux packages install them (apps/*\/electron-builder.yml, packaging/linux). */
export const LINUX_INSTALLED = ["/opt/moss-code/moss-code", "/opt/moss/moss-app", "/opt/moss/resources/host/moss-host"] as const;
/** Their names, wherever they are (an AppImage, an unpacked tree). */
const LINUX_NAMES = new Set(LINUX_INSTALLED.map((p) => posix.basename(p)));
/** The per-user installs' executables under %LOCALAPPDATA%\Programs (packaging/windows/installer*.nsh). */
export const WINDOWS_INSTALLED = ["@waifucavemoss-desktop\\MOSS Code.exe", "@waifucavemoss-moss\\MOSS.exe", "@waifucavemoss-moss\\resources\\host\\moss-host.exe"] as const;
const WINDOWS_NAMES = new Set(WINDOWS_INSTALLED.map((p) => win32.basename(p).toLowerCase()));
/** The dev app's Electron (`bun run dev:app`), taken only by the seam. */
const DEV_ELECTRON = new Set(["electron", "electron.exe"]);

/** Windows' mandatory label for medium integrity (SECURITY_MANDATORY_MEDIUM_RID). */
export const MEDIUM_INTEGRITY = 0x2000;

/** What the check found about the peer's image: accepted (verified or not), or why not. `seam`: taken by the dev and
 *  test seam, with its marker. */
export type AppImageVerdict = { ok: true; verified: boolean; image: string; seam?: string } | { ok: false; why: string };

/** The dev and test seam: an image named as one of the programs' executables (or the dev app's Electron) outside the
 *  install. Defined only in a build that isn't a release, or a test-marked one: the condition is the defines' alone, so
 *  a release build folds it to `undefined` and drops the function and its marker string with it, and the release gate
 *  refuses a real core that still carries the marker (scripts/test-build.ts `TEST_ONLY_CORE_STRINGS`). */
export const imageSeam: ((image: string, os: "linux" | "win32") => AppImageVerdict | undefined) | undefined =
  (typeof __MOSS_DIST__ === "undefined" || __MOSS_DIST__ !== true || typeof __MOSS_TEST_BUILD__ === "string")
    ? (image, os) => {
      const name = os === "linux" ? posix.basename(image) : win32.basename(image).toLowerCase();
      const ours = os === "linux" ? LINUX_NAMES.has(name) : WINDOWS_NAMES.has(name);
      return ours || DEV_ELECTRON.has(name) ? { ok: true, verified: false, image, seam: "MOSS_APP_IMAGE_LOOSE_SEAM" } : undefined;
    }
    : undefined;

/** The facts the judge reads, from the OS (`linuxFacts`, `windowsFacts`) or a test. */
export interface AppImageFacts {
  /** The peer's executable, as the OS names it; null when it couldn't be read. */
  image: string | null;
  /** Linux: `TracerPid` from its status; null when unreadable. */
  tracer?: number | null;
  /** Windows: its integrity level's RID; null when unreadable. */
  integrity?: number | null;
  /** Linux: whether the image and every folder above it is root-owned and writable by no one else. */
  rootOwned?: (path: string) => boolean;
  /** Linux: whether `<dir>/resources/app.asar` is there (an Electron app laid out as ours). */
  hasAppAsar?: (dir: string) => boolean;
  /** Still the process the reads were about (the pidfd after the reads). */
  stillThere: boolean;
}

type Seam = typeof imageSeam;

/** Linux: the judge. */
export function judgeLinuxImage(f: AppImageFacts, seam: Seam): AppImageVerdict {
  if (f.image === null) return { ok: false, why: "its executable couldn't be read" };
  if (f.image.endsWith(" (deleted)")) return { ok: false, why: "its executable was replaced or removed while it ran" };
  if (f.tracer !== 0) return { ok: false, why: f.tracer === null || f.tracer === undefined ? "whether it is traced couldn't be read" : "it is being traced by another process" };
  const name = posix.basename(f.image);
  let v: AppImageVerdict;
  if ((LINUX_INSTALLED as readonly string[]).includes(f.image) && (f.rootOwned?.(f.image) ?? false)) v = { ok: true, verified: true, image: f.image };
  else if (LINUX_NAMES.has(name) && (f.hasAppAsar?.(posix.dirname(f.image)) ?? false)) v = { ok: true, verified: false, image: f.image };
  else v = seam?.(f.image, "linux") ?? { ok: false, why: `its executable (${shown(f.image)}) isn't MOSS's, MOSS Code's or the host's` };
  if (v.ok && !f.stillThere) return { ok: false, why: "it exited while it was checked" };
  return v;
}

/** Windows: the judge. `localAppData` is the daemon's own (the person's) %LOCALAPPDATA%. Both sides are compared in the
 *  shared Windows spelling (`foldedSpelling`: an 8.3 short name such as `RUNNER~1` expanded, case, separators, a trailing
 *  dot and the `\\?\` prefix folded); a spelling it can't judge matches nothing. `spelling`: a test's machine. */
export function judgeWindowsImage(f: AppImageFacts, localAppData: string | undefined, seam: Seam, spelling: SpellingOptions = { win32: true }): AppImageVerdict {
  if (f.image === null) return { ok: false, why: "its executable couldn't be read" };
  if (f.integrity === null || f.integrity === undefined || f.integrity < MEDIUM_INTEGRITY) return { ok: false, why: "it runs below medium integrity" };
  const key = (p: string) => { const k = foldedSpelling(p, spelling); return k === UNJUDGEABLE ? undefined : k; };
  const installed = localAppData === undefined || localAppData === "" ? [] : WINDOWS_INSTALLED.map((p) => key(win32.join(localAppData, "Programs", p))).filter((k): k is string => k !== undefined);
  const image = key(f.image);
  let v: AppImageVerdict;
  // A per-user install is the user's to write: never "verified" on Windows.
  if (image !== undefined && installed.includes(image)) v = { ok: true, verified: false, image: f.image };
  else v = seam?.(f.image, "win32") ?? { ok: false, why: `its executable (${shown(f.image)}) isn't the installed MOSS's, MOSS Code's or host's` };
  if (v.ok && !f.stillThere) return { ok: false, why: "it exited while it was checked" };
  return v;
}

/** A path from the OS as a refusal shows it: control and bidirectional characters as `?`, at most 200 characters. */
function shown(p: string): string {
  const t = p.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "?");
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

/** Root-owned and writable by no one else: the path and every folder above it. */
export function rootOwnedChain(path: string, stat: (p: string) => { uid: number; mode: number } | null = (p) => { try { const s = lstatSync(p); return { uid: s.uid, mode: s.mode }; } catch { return null; } }): boolean {
  for (let at = path; ; at = posix.dirname(at)) {
    const s = stat(at);
    if (s === null || s.uid !== 0 || (s.mode & 0o022) !== 0) return false;
    if (at === posix.dirname(at)) return true;
  }
}

/** Linux: the facts, by the peer's pid, believed only while its handle still names it. */
export function linuxFacts(peer: PeerFacts): AppImageFacts {
  const pid = peer.pid;
  if (pid === null) return { image: null, stillThere: false };
  let image: string | null = null;
  try { image = readlinkSync(`/proc/${pid}/exe`); } catch { /* unreadable: refused */ }
  let tracer: number | null = null;
  try {
    const m = /^TracerPid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    tracer = m === null ? null : Number(m[1]);
  } catch { /* unreadable: refused */ }
  const stillThere = peer.handle === undefined ? (() => { try { process.kill(pid, 0); return true; } catch { return false; } })() : peer.handle.alive();
  return {
    image, tracer, stillThere, rootOwned: (p) => rootOwnedChain(p),
    hasAppAsar: (d) => { try { return lstatSync(join(d, "resources", "app.asar")).isFile(); } catch { return false; } },
  };
}

function winLibs() {
  const k = ffiLib("app-image-kernel32", "kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    QueryFullProcessImageNameW: { args: ["u64", "u32", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  const a = ffiLib("app-image-advapi32", "advapi32.dll", {
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
  });
  return k && a ? { k, a } : null;
}

/** The integrity RID from a TOKEN_MANDATORY_LABEL buffer: its SID pointer points into the same buffer (the SID's
 *  revision, count, 6-byte authority, then the sub-authorities; the last is the RID). Null when it doesn't. */
export function integrityRidOf(buf: Buffer, base: bigint): number | null {
  if (buf.length < 16) return null;
  const off = Number(buf.readBigUInt64LE(0) - base);
  if (!(off >= 8 && off + 8 <= buf.length)) return null;
  const count = buf[off + 1]!;
  const last = off + 8 + (count - 1) * 4;
  if (count < 1 || last + 4 > buf.length) return null;
  return buf.readUInt32LE(last);
}

/** Windows: the facts, by the peer's pid, which can't be reused while the connection's handle holds the process. */
export function windowsFacts(peer: PeerFacts): AppImageFacts {
  const pid = peer.pid;
  const l = winLibs();
  if (pid === null || l === null) return { image: null, stillThere: false };
  const h = BigInt(l.k.OpenProcess!(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid) as number | bigint);
  if (h === 0n) return { image: null, stillThere: false };
  try {
    const chars = new Uint32Array([32_768]);
    const name = Buffer.alloc(32_768 * 2);
    const image = (l.k.QueryFullProcessImageNameW!(h, 0, ptr(name), ptr(chars)) as number) !== 0 ? name.subarray(0, chars[0]! * 2).toString("utf16le") : null;
    let integrity: number | null = null;
    const tok = new BigUint64Array(1);
    if ((l.a.OpenProcessToken!(h, 0x8 /* TOKEN_QUERY */, ptr(tok)) as number) !== 0) {
      try {
        const buf = Buffer.alloc(256), ret = new Uint32Array(1);
        if ((l.a.GetTokenInformation!(tok[0]!, 25 /* TokenIntegrityLevel */, ptr(buf), buf.length, ptr(ret)) as number) !== 0) {
          integrity = integrityRidOf(buf, BigInt(ptr(buf) as number));
        }
      } finally { l.k.CloseHandle!(tok[0]!); }
    }
    return { image, integrity, stillThere: peer.handle === undefined ? true : peer.handle.alive() };
  } finally { l.k.CloseHandle!(h); }
}

/** The check for `os`: Linux and Windows; `log` hears each accepted image once per check (verified or not). */
export function appImageCheck(os: "linux" | "win32", o: { log?: (line: string) => void; facts?: (peer: PeerFacts) => AppImageFacts; seam?: Seam; localAppData?: string } = {}): (peer: PeerFacts) => boolean {
  const seam = "seam" in o ? o.seam : imageSeam;
  return (peer) => {
    const facts = (o.facts ?? (os === "linux" ? linuxFacts : windowsFacts))(peer);
    const v = os === "linux" ? judgeLinuxImage(facts, seam) : judgeWindowsImage(facts, o.localAppData ?? process.env.LOCALAPPDATA, seam);
    if (!v.ok) { o.log?.(`[moss] an app connection was refused: ${v.why}`); return false; }
    o.log?.(`[moss] app connection from ${shown(v.image)}: ${v.seam !== undefined ? `a dev or test build's image (${v.seam})` : v.verified ? "verified image (root-owned install)" : "unverified image (a user-writable install)"}`);
    return true;
  };
}
