// What another computer's call gets on this one (lane XC, the reader's floor for step 2: never more than a bot running
// here gets). One module for both doors a peer reaches this computer by, so they can't drift:
//
// * its FILE calls through the folder tree (`LocalHolder`): a write, delete or move that lands on a run-later place
//   (`runLaterByName`: every `.git`, the shells' start files, `.vscode`, `.claude`, `.mcp.json`, credential files, a
//   `.moss` outside the MOSS home, a fixed PATH folder…) or on one of the user's secret places (`SECRET_READ_PLACES`)
//   is refused, as a bot's file write there is refused before any card (bot-check); a read of a secret place is
//   refused, as a bot's Read is;
// * its BASH (`fencedExecutor`): the fenced process runs on a view of this computer's fence whose write roots are the
//   call's own fresh temp folder (`peerFence`), and — step 3b, the controller's rulings (A)–(D) — the folder it runs
//   in, but only where a bot here would write that folder too:
//   - by the holder's reviewer's "safe", at a level whose own shell roots (`levelShellRoots`, what `botSandboxSettings`
//     draws: the home's ordinary top-level folders at accept edits, the home at fully automatic) cover it, as a bot
//     here writes them with no card;
//   - by the person's yes to the holder's card, as a one-call RequestAccess grant (its never-given checks), on macOS
//     only: a bot here on Linux gets no grant (its sandbox holds only what exists when a command starts), and Windows
//     peers stay in their temp folder (owed);
//   - never at all for a folder RequestAccess never gives (the home, its Library or Applications, one holding the MOSS
//     home or a PATH folder, a sensitive place), a run-later or secret place, or a name a glob would misread.
//   Inside it, exactly the local bot sandbox's denies (`shellRunLaterDenies`: every `.git`/`*.git` whole, at any depth
//   and in any case, the run-later names, `*.app`, the PATH folders, what the repos' configs name) and the user's
//   secret places, read and write. On macOS as Seatbelt globs from `/`; on Linux as the matches found under the
//   folder when the command starts (held read-only by bubblewrap), and what appeared at a held name during the run
//   moved aside after it (`sweepRunLater`: recoverable, never deleted), the local sandbox's own residual.
//   Nothing the asking computer sends widens it: its level, its answer and its bot are the holder's to judge.
import { cpSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, posix, relative, win32 } from "node:path";
import type { Level, Os } from "@waifucave/moss-protocol";
import { secretReadPlaces, type Fence, type FenceContext, type SandboxPolicy } from "../contracts/fence";
import { pathClass } from "../approvals/ordinary-paths";
import { neverGiven } from "../approvals/request-access";
import { CONTROL, ordinaryTopFolders, runLaterByName, shellRunLaterDenies } from "./sandbox-settings";
import { secretPlaceOf } from "./secret-reads";
import { pathWithin } from "./fold";

export interface PeerFloorOptions {
  /** The user's home folder here. */
  userHome: string;
  /** The MOSS home here. */
  mossHome: string;
  os: Os;
}

/** What a peer's folder is judged against here, besides the homes: the folders on the user's PATH now. */
export interface PeerFolderOptions extends PeerFloorOptions {
  pathFolders: readonly string[];
  /** A folder's entries, for tests (`ordinaryTopFolders`). */
  list?: (dir: string) => readonly { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
}

/** Why a peer may not write, remove or move `real` here (a real, absolute path), or undefined. */
export function peerWriteRefusal(real: string, o: PeerFloorOptions): string | undefined {
  if (runLaterByName(real, o)) return "another computer's call never writes a place that runs later (a .git, a shell's start file, an editor's or agent's settings, a credential file)";
  return peerReadRefusal(real, o);
}

/** Why a peer may not read `real` here, or undefined: the user's secret places. */
export function peerReadRefusal(real: string, o: PeerFloorOptions): string | undefined {
  const cls = secretPlaceOf(real, { userHome: o.userHome, os: o.os, cwd: o.userHome });
  return cls === undefined ? undefined : `another computer's call never reaches the user's secret places (${cls})`;
}

/** How a peer's command was let through here (`judgePeer`): by the level alone (fully automatic), as a read-only
 *  command (ask for risky actions and accept edits, the bot check's own rule), by the reviewer's "safe", or by the
 *  person's signed answer. */
export type PeerPassBy = "level" | "read-only" | "reviewer" | "answer";

/** What the folder a peer's command runs in gets: write access, none (with why, for the tool result), or the card
 *  first (at the asking levels, a command the reviewer passed whose folder the level's roots don't cover). */
export type PeerFolderDecision = { folder: string } | { why?: string } | { ask: string };

/** The shell's write roots a bot's command has here at `level` with no card and no grant, besides its own folders and
 *  temp (`botSandboxSettings`): the home's ordinary top-level folders at accept edits, the whole home at fully
 *  automatic, none below. */
export function levelShellRoots(level: Level, o: PeerFolderOptions): string[] {
  if (level === "automatic") return [o.userHome];
  if (level === "accept-edits") return ordinaryTopFolders(o.userHome, { os: o.os, mossHome: o.mossHome, pathFolders: o.pathFolders, ...(o.list ? { list: o.list } : {}) });
  return [];
}

/** A glob's own characters: a folder named with one would be misread inside the denies drawn under it. */
const GLOB_CHARS = /[*?[\]{}]/;

/** Why `real` (the real path of the folder a peer's command runs in) is never written by one, or undefined:
 *  RequestAccess's never-given checks (`neverGiven`), a sensitive place by the path classes, a run-later or secret
 *  place, or a name the denies' globs would misread. */
export function peerFolderRefusal(real: string, o: PeerFolderOptions): string | undefined {
  if (!posix.isAbsolute(real) && o.os !== "windows") return `${real} isn't an absolute folder`;
  // The checks below compare spellings: a `..`, a `.` or a doubled separator would stand for another folder than it
  // reads as (`~/Projects/..` is the home). The holder passes a real path; anything else is refused, not mended.
  const p = o.os === "windows" ? win32 : posix;
  if (p.normalize(real).replace(/[\\/]+$/, "") !== real.replace(/[\\/]+$/, "") || /[\\/]+$/.test(real)) return `${real} isn't a folder's real path`;
  if (CONTROL.test(real) || GLOB_CHARS.test(real)) return `${real} has characters (control or glob ones) the sandbox's rules can't hold it by`;
  // The same checks as a grant to a bot here; the Linux line is left out by asking them as macOS (whose compare folds
  // case: stricter), since on Linux only the wider levels' own roots reach here.
  const never = neverGiven(real, { home: o.userHome, mossHome: o.mossHome, pathFolders: () => o.pathFolders, os: o.os === "linux" ? "macos" : o.os });
  if (never !== undefined) return never;
  if (pathClass(join(real, "x"), { home: o.userHome, os: o.os, mossHome: o.mossHome, pathFolders: o.pathFolders }) !== "ordinary") {
    return `${real} is a sensitive place (a dot-folder, ~/Library, an app, a .git, a folder on the PATH, outside the home, or MOSS's own)`;
  }
  return peerWriteRefusal(real, o);
}

/** Whether `folder` is `root` or inside it, on this OS's compare. */
const within = (folder: string, root: string, os: Os) => pathWithin(folder, root, os);

/** What the folder a peer's command runs in gets (step 3b; the controller's rulings (A)–(D)). `holder` names this
 *  computer in the reasons; `verdict` is the reviewer's, asked at fully automatic (where no card is ever raised). */
export function peerFolderFor(o: {
  holder: string; folder: string; by: PeerPassBy; level: Level; readOnly: boolean;
  verdict?: "safe" | "risky" | "unavailable";
}, f: PeerFolderOptions): PeerFolderDecision {
  const { holder, folder } = o;
  const without = `so it ran without access to ${folder}`;
  // A read-only command reads where its sandbox reads, whatever its write roots: nothing to give, nothing to say.
  if (o.readOnly || o.by === "read-only") return {};
  if (f.os === "windows") return { why: `${holder} runs another computer's commands only in their own temp folder on Windows for now, ${without}` };
  const refusal = peerFolderRefusal(folder, f);
  if (refusal !== undefined) return { why: `${refusal}: another computer's command never writes there, ${without}` };
  const linux = `On Linux ${holder}'s sandbox holds only the places there when a command starts, so it gives another computer's commands no folder at this level (as it gives its own bots none), ${without}`;
  const covered = levelShellRoots(o.level, f).some((r) => within(folder, r, f.os));
  switch (o.by) {
    case "answer":
      // The person's yes: a one-call RequestAccess grant, which a bot here on Linux never gets; a folder the level's
      // roots cover a bot here writes after its card's yes anyway, on Linux too.
      return covered || f.os === "macos" ? { folder } : { why: linux };
    case "reviewer":
      if (covered) return { folder };
      return f.os === "macos" ? { ask: `${holder} needs the user's answer before a command from another computer writes ${folder}` } : { why: linux };
    case "level": {
      // Fully automatic: never a card. The folder only on the reviewer's "safe", where the level's roots cover it.
      if (o.verdict === "unavailable") return { why: `${holder}'s reviewer couldn't judge this command, ${without}; at an asking level ${holder} would ask the person` };
      if (o.verdict !== "safe") return { why: `${holder}'s reviewer judged this command risky, ${without}; at an asking level ${holder} would ask the person` };
      if (!covered) return { why: `${folder} isn't a folder ${holder}'s own bots' commands write at fully automatic, ${without}` };
      return { folder };
    }
  }
}

/** How many folders the Linux look for held names walks under a peer's folder, at the command's start and after it. */
export const PEER_WALK_BUDGET = 20_000;

/** The run-later places under `folder` (each held name that is there, never looked inside), walked without following
 *  a link, at most `budget` folders: `complete` false past it. */
export function runLaterUnder(folder: string, f: PeerFloorOptions, budget = PEER_WALK_BUDGET): { found: string[]; complete: boolean } {
  const found: string[] = [];
  let left = budget;
  const stack = [folder];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (left-- <= 0) return { found, complete: false };
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const at = join(dir, name);
      if (runLaterByName(at, f) || peerReadRefusal(at, f) !== undefined) { found.push(at); continue; }
      try { if (lstatSync(at).isDirectory()) stack.push(at); } catch { /* gone meanwhile */ }
    }
  }
  return { found: found.sort(), complete: true };
}

/** What a peer's command under `folder` may not write, as `denyWrite` entries: on macOS the local bot sandbox's own
 *  (`shellRunLaterDenies` for the folder, globs from `/`); on Linux the held places there now (`held`, from
 *  `runLaterUnder`) and the concrete ones of the same list (the PATH folders, what the repos' configs name). The
 *  user's secret places too, on both. */
export function peerFolderDenies(folder: string, f: PeerFolderOptions, held: readonly string[] = []): string[] {
  const local = shellRunLaterDenies([folder], { userHome: f.userHome, mossHome: f.mossHome, os: f.os, pathFolders: f.pathFolders });
  const secrets = secretReadPlaces(f.os, f.userHome).map((p) => p.path);
  const drawn = f.os === "macos" ? local : [...local.filter((d) => !d.includes("*")), ...held];
  return [...new Set([...drawn, ...secrets])];
}

/** After a peer's command on Linux: the held places under `folder` that weren't there at its start (not in `before`),
 *  moved aside into `putAway` at their path under the folder, never deleted: one the person made meanwhile (an
 *  editor's `.vscode`, their own `git init`) is theirs to take back. Each is moved only while its parent is still its
 *  own real path (no link swapped in since the walk). Returns what was moved, and whether the look finished (past the
 *  budget a place made deeper isn't found). */
export function sweepRunLater(folder: string, before: readonly string[], f: PeerFloorOptions, putAway: string): { moved: string[]; complete: boolean } {
  const was = new Set(before);
  const now = runLaterUnder(folder, f);
  const moved: string[] = [];
  for (const p of now.found) {
    if (was.has(p)) continue;
    try {
      if (realpathSync.native(dirname(p)) !== dirname(p)) continue;
      const to = join(putAway, relative(folder, p));
      mkdirSync(dirname(to), { recursive: true });
      try { renameSync(p, to); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        // Another volume: a copy (links as links), then the original away.
        cpSync(p, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
        rmSync(p, { recursive: true, force: true });
      }
      moved.push(p);
    } catch { /* left where it is: not in `moved` */ }
  }
  return { moved, complete: now.complete };
}

/** The folder a peer's command may write, with what is held inside it. */
export interface PeerWriteFolder {
  path: string;
  denyWrite: readonly string[];
}

/** The fence a peer's command runs under: this computer's, its policy narrowed to `writeRoot` as the one write root
 *  (and `folder`, when the call's folder was given: step 3b), with the user's secret places read-denied and, inside
 *  the folder, its denies. Every other part (the fenced set, the closed doors, the MOSS home's default-deny, the
 *  network rule) is the fence's own. */
export function peerFence<F extends Pick<Fence, "policy">>(fence: F, writeRoot: string, o: PeerFloorOptions, folder?: PeerWriteFolder): F {
  const secrets = secretReadPlaces(o.os, o.userHome).map((p) => p.path);
  const policy = (ctx?: FenceContext): SandboxPolicy => {
    const base = fence.policy(ctx);
    return {
      ...base,
      allowWrite: folder === undefined ? [writeRoot] : [writeRoot, folder.path],
      denyWrite: folder === undefined ? base.denyWrite : [...new Set([...base.denyWrite, ...folder.denyWrite])],
      denyRead: [...new Set([...base.denyRead, ...secrets])],
    };
  };
  return new Proxy(fence, {
    get(target, key) {
      if (key === "policy") return policy;
      // On the fence itself (its private fields and getters are its own, never the proxy's).
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
