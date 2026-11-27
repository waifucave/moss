// The computer node's Bash (the controller's wiring ruling, item 3; C-M2 part 2): a tool call on this computer's tree
// runs through lane C's fenced process (`fencedSpawner`): Seatbelt on macOS, bubblewrap on Linux, and the Windows fence
// (`win-fenced.ts`) on Windows, where every call is refused with the reason until that fence is set up. Never
// unsandboxed: there is no fallback to a plain shell, and a spawner that can't start a fenced process here refuses
// each call. The daemon's parts build it over their one MossFence (lane XC).
//
// The run is the caller's (`who`): a bot's own session gets its bot's reach, a coding session its own. Another
// computer's call (a peer) gets never more than a bot here (fence/peer-floor.ts): a fresh temp folder of its own for
// the call, its one write root and its TMPDIR, removed after it; the user's secret places unread; the fence's set,
// closed doors and network rule as for anyone. The child's environment is built here, whole: a fixed PATH, the user's
// home and a temp folder (TMPDIR: a bot's own scratch folder for its own runs, the peer's own folder for a peer's,
// the fence's temp folder for the rest), nothing inherited from the daemon (no keys, no tokens).
//
// Step 3b: a peer's command may also write the folder it runs in, where the tree service says so (`ctx.write`, by
// `peerFolderFor`), under exactly the local bot sandbox's denies there (`peerFolderDenies`). Such runs go one at a
// time per folder (and with any run in a folder holding it or inside it), and the folder's real path is read again
// right before each: no other peer command can then swap it for a link between the service's check and the spawn (a
// temp-only one can't write its parent, and one granted a folder elsewhere can't reach it).
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Caller, Os } from "@waifucave/moss-protocol";
import { fenceContextFor, ownFoldersOf } from "../contracts/fence";
import { mkdirNoLinks } from "../fence/fenced-process";
import { peerFolderDenies, peerFolderFor, type PeerFloorOptions, type PeerWriteFolder } from "../fence/peer-floor";
import type { FencedRunResult, FencedSpawner } from "../fence/spawn";
import type { ToolExecutor, ToolRunContext } from "../tree/service";

/** How long a Bash call runs when it doesn't say (Claude Code's default). */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
/** The longest a Bash call may ask for (Claude Code's limit). */
export const BASH_MAX_TIMEOUT_MS = 600_000;

export interface FencedExecutorOptions {
  /** Lane C's fenced process for this computer (`fencedSpawner({ fence })`); never `FENCED_SPAWN_NOT_YET`. */
  spawner: FencedSpawner;
  /** The user's home folder: `HOME` in the child's environment. */
  home: string;
  /** The fence's temp folder (`MossFence`'s `temp`, which every caller may write): `TMPDIR` in the child's
   *  environment, so tools that make temp files don't fall back to a folder the sandbox refuses. A bot's own run gets
   *  its own scratch folder instead (with `mossHome`; the owner's ruling). */
  temp?: string;
  /** The MOSS home, for a bot's own scratch folder (`<home>/scratch/<bot>`, `ownFoldersOf`): a bot's session or
   *  side thread runs with it as `TMPDIR`. */
  mossHome?: string;
  os: Os;
  /** Another computer's call (a `peer`): the fenced process it runs on, built for its own fresh temp folder `root`, its
   *  one write root (`peerFence`, fence/peer-floor.ts). The folder is made under `temp` for the call and removed
   *  after it. Without it, a peer's command is refused here. */
  peerSpawner?: (root: string, folder?: PeerWriteFolder) => FencedSpawner;
  /** What a peer's folder is judged against here (step 3b, `peerFolderFor`): the homes, the OS and the PATH's folders
   *  now. Without it, a peer's command writes only its own temp folder, as before. */
  peerFloor?: PeerFloorOptions & { pathFolders: () => readonly string[] };
}

/** Where another computer's calls get their own folders: one parent per MOSS home (`moss-peer-<hash>` in the fence's
 *  temp folder), so a daemon on another home never sweeps them, and this daemon sweeps what a crash left
 *  (`sweepPeerFolders`). A local runner that may write the temp folder can reach them: it gains nothing it can't do
 *  already (a peer's folder holds only what that peer wrote for its call, and the peer is held to less than it). */
export function peerFolderParent(temp: string, mossHome?: string): string {
  return mossHome === undefined ? temp : join(temp, `moss-peer-${createHash("sha256").update(mossHome).digest("hex").slice(0, 12)}`);
}

/** Removes the peer folders a stopped daemon left behind (at start: no peer call runs yet). */
export function sweepPeerFolders(temp: string, mossHome: string): void {
  const parent = peerFolderParent(temp, mossHome);
  try { if (!lstatSync(parent).isDirectory()) return; } catch { return; }
  for (const name of readdirSync(parent)) if (name.startsWith("peer-")) rmSync(join(parent, name), { recursive: true, force: true });
}

/** The PATH a fenced Bash call sees: the system's standard places, never the daemon's own PATH. */
export function fencedPath(os: Os): string {
  return os === "macos" ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
}

/** The computer node's executor over `o.spawner`. */
export function fencedExecutor(o: FencedExecutorOptions): ToolExecutor {
  const base: Record<string, string> = { PATH: fencedPath(o.os), HOME: o.home, LANG: "en_US.UTF-8", TERM: "dumb" };
  /** The caller's TMPDIR: a bot's own scratch folder (made when missing, never through a link), else the fence's. */
  const tempFor = (as: Caller): string | undefined => {
    const scratch = o.mossHome === undefined ? undefined : ownFoldersOf(fenceContextFor(as), o.mossHome).ownScratch;
    if (scratch !== undefined) {
      try {
        // Never through a link, at any level on the way down (lane C's `mkdirNoLinks`, as the fenced paths make theirs).
        mkdirNoLinks(scratch);
        if (lstatSync(scratch).isDirectory()) return scratch;
      } catch { /* fall back to the fence's own temp folder */ }
    }
    return o.temp;
  };
  // Peer runs that write a folder go one at a time PER FOLDER, by its real path (the head comment): a build in one folder
  // never holds a run in another; a run in a folder inside another's, or holding it, waits for that one too, since it
  // could swap a link in there. Temp-only runs are never held.
  const folderRuns = new Map<string, Promise<unknown>>();
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
  const oneAtATime = <T>(folder: string, fn: () => Promise<T>): Promise<T> => {
    const before = [...folderRuns].filter(([f]) => overlaps(f, folder)).map(([, p]) => p);
    const next = Promise.allSettled(before).then(fn);
    const held = next.catch(() => {});
    folderRuns.set(folder, held);
    void held.then(() => { if (folderRuns.get(folder) === held) folderRuns.delete(folder); });
    return next;
  };
  // The homes by their real paths, as the folder is (the service's `realFolder`): a home reached through a link
  // (macOS's /var → /private/var) would otherwise read every folder in it as outside the home. The daemon's own folder
  // class does the same (`folderClass`).
  const realOr = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
  const floor = o.peerFloor === undefined ? undefined : { ...o.peerFloor, userHome: realOr(o.peerFloor.userHome), mossHome: realOr(o.peerFloor.mossHome) };
  /** The folder a peer's run may write, with its denies; or why not now. macOS (Seatbelt holds the denies by pattern
   *  as each path opens) and Linux (the agent runtime's own sandbox holds them, as for a local bot: the peer spawner's
   *  `peerFolderSpawnerLinux`); on Windows no folder, whatever the service said. */
  const prepare = (folder: string): { folder: PeerWriteFolder } | { why: string } => {
    const held = (os: Os | undefined) => os === "macos" || os === "linux";
    if (floor === undefined || !held(floor.os) || !held(o.os) || floor.os !== o.os) return { why: `this computer gives another computer's commands no folder, so it ran without access to ${folder}` };
    let real: string;
    try { real = realpathSync.native(folder); } catch { real = ""; }
    if (real !== folder || !lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return { why: `${folder} changed before the command started, so it ran without access to it` };
    const f = { ...floor, pathFolders: floor.pathFolders() };
    return { folder: { path: folder, denyWrite: peerFolderDenies(folder, f) } };
  };
  return {
    ...(floor === undefined ? {} : {
      peerFolder: (x: Parameters<NonNullable<ToolExecutor["peerFolder"]>>[0]) => peerFolderFor(x, { ...floor, pathFolders: floor.pathFolders() }),
    }),
    async run(tool, input, ctx) {
      const wants = ctx.as.kind === "peer" && ctx.write !== undefined && "folder" in ctx.write ? ctx.write.folder : undefined;
      if (wants !== undefined) return oneAtATime(realOr(wants), () => runOnce(tool, input, ctx, wants));
      return runOnce(tool, input, ctx, undefined);
    },
  };

  async function runOnce(tool: string, input: unknown, ctx: ToolRunContext, wants: string | undefined): Promise<{ output: unknown; isError: boolean }> {
      if (tool !== "Bash") return { output: { error: `${tool} doesn't run through this computer's executor; only Bash does` }, isError: true };
      const i = (typeof input === "object" && input !== null ? input : {}) as { command?: unknown; timeoutMs?: unknown };
      if (typeof i.command !== "string" || i.command.length === 0) return { output: { error: "Bash: no command" }, isError: true };
      const asked = typeof i.timeoutMs === "number" && Number.isInteger(i.timeoutMs) && i.timeoutMs > 0 ? i.timeoutMs : BASH_DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.min(asked, BASH_MAX_TIMEOUT_MS);
      if (ctx.signal.aborted) return { output: { stdout: "", stderr: "", code: null, aborted: true }, isError: true };
      let r: FencedRunResult;
      // Another computer's call: its own fresh temp folder, its only write root (fence/peer-floor.ts), gone after it;
      // and the folder it runs in, when the service gave it (step 3b) and it is still that folder now.
      let peerRoot: string | undefined;
      let note: string | undefined = ctx.write !== undefined && "why" in ctx.write ? ctx.write.why : undefined;
      try {
        let spawner = o.spawner;
        let tmp: string | undefined;
        if (ctx.as.kind === "peer") {
          if (o.peerSpawner === undefined || o.temp === undefined) return { output: { error: "refused: this computer runs no commands for other computers" }, isError: true };
          const parent = peerFolderParent(o.temp, o.mossHome);
          mkdirNoLinks(parent);
          peerRoot = mkdtempSync(join(parent, "peer-"));
          const ready = wants === undefined ? undefined : prepare(wants);
          if (ready !== undefined && "why" in ready) note = ready.why;
          const folder = ready !== undefined && "folder" in ready ? ready.folder : undefined;
          spawner = folder === undefined ? o.peerSpawner(peerRoot) : o.peerSpawner(peerRoot, folder);
          tmp = peerRoot;
        } else tmp = tempFor(ctx.as);
        const env = { ...base, ...(tmp === undefined ? {} : { TMPDIR: tmp }) };
        r = await spawner.run({ command: i.command, cwd: ctx.cwd, env, timeoutMs, signal: ctx.signal, who: { caller: ctx.as } });
      } catch (e) {
        // A spawner that throws ran nothing we can vouch for: refused, with the reason.
        return { output: { error: `this computer's fenced process failed to start: ${e instanceof Error ? e.message : String(e)}` }, isError: true };
      } finally {
        if (peerRoot !== undefined) rmSync(peerRoot, { recursive: true, force: true });
      }
      const noted = note === undefined ? {} : { note };
      if (r.kind === "refused") return { output: { error: `refused: ${r.reason}`, ...noted }, isError: true };
      // The fenced process gives its output at the end; it goes to the caller's stream once, in order.
      if (r.stdout) ctx.output(r.stdout, "stdout");
      if (r.stderr) ctx.output(r.stderr, "stderr");
      if (r.kind === "timeout") return { output: { stdout: r.stdout, stderr: r.stderr, code: null, timedOut: true, aborted: ctx.signal.aborted, ...noted }, isError: true };
      return { output: { stdout: r.stdout, stderr: r.stderr, code: r.code, aborted: ctx.signal.aborted, ...noted }, isError: r.code !== 0 || ctx.signal.aborted };
  }
}
