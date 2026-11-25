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
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Caller, Os } from "@waifucave/moss-protocol";
import { fenceContextFor, ownFoldersOf } from "../contracts/fence";
import { mkdirNoLinks } from "../fence/fenced-process";
import type { FencedRunResult, FencedSpawner } from "../fence/spawn";
import type { ToolExecutor } from "../tree/service";

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
  peerSpawner?: (root: string) => FencedSpawner;
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
  return {
    async run(tool, input, ctx) {
      if (tool !== "Bash") return { output: { error: `${tool} doesn't run through this computer's executor; only Bash does` }, isError: true };
      const i = (typeof input === "object" && input !== null ? input : {}) as { command?: unknown; timeoutMs?: unknown };
      if (typeof i.command !== "string" || i.command.length === 0) return { output: { error: "Bash: no command" }, isError: true };
      const asked = typeof i.timeoutMs === "number" && Number.isInteger(i.timeoutMs) && i.timeoutMs > 0 ? i.timeoutMs : BASH_DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.min(asked, BASH_MAX_TIMEOUT_MS);
      if (ctx.signal.aborted) return { output: { stdout: "", stderr: "", code: null, aborted: true }, isError: true };
      let r: FencedRunResult;
      // Another computer's call: its own fresh temp folder, its only write root (fence/peer-floor.ts), gone after it.
      let peerRoot: string | undefined;
      try {
        let spawner = o.spawner;
        let tmp: string | undefined;
        if (ctx.as.kind === "peer") {
          if (o.peerSpawner === undefined || o.temp === undefined) return { output: { error: "refused: this computer runs no commands for other computers" }, isError: true };
          mkdirNoLinks(o.temp);
          peerRoot = mkdtempSync(join(o.temp, "peer-"));
          spawner = o.peerSpawner(peerRoot);
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
      if (r.kind === "refused") return { output: { error: `refused: ${r.reason}` }, isError: true };
      // The fenced process gives its output at the end; it goes to the caller's stream once, in order.
      if (r.stdout) ctx.output(r.stdout, "stdout");
      if (r.stderr) ctx.output(r.stderr, "stderr");
      if (r.kind === "timeout") return { output: { stdout: r.stdout, stderr: r.stderr, code: null, timedOut: true, aborted: ctx.signal.aborted }, isError: true };
      return { output: { stdout: r.stdout, stderr: r.stderr, code: r.code, aborted: ctx.signal.aborted }, isError: r.code !== 0 || ctx.signal.aborted };
    },
  };
}
