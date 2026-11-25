// Where a session's own tool call runs (spec §9.1 [D]: `Read`, `Write`, `Edit`, `Glob` and `Grep` run on the computer
// that holds the path; `Bash` on the computer that holds its working folder). The runtime's built-in tools know only
// this computer's disk, and a tree path (`home/<Computer>/…`, `home/memory/…`, `bots/<bot>/…`) is not a path on it, so
// the session's PreToolUse hook asks this router first (lane XC's step 0 design):
//
// * `local`: not a tree path (an absolute path, or one relative to the session's folder), or `home/<name>/…` where no
//   computer has that name. The call is untouched: the hook answers exactly what it answered before.
// * `here`: a tree path this computer holds. The call is rewritten to the real path (`CoreTree.resolve` as the session,
//   so `home/memory/` is the calling bot's own memory and nobody else's), and the runtime's own tool runs on it. The
//   file fence, the sandbox, the write roots and the approval check then judge the real path exactly as they judge any
//   absolute path: the session gains nothing it couldn't get by typing the real path.
// * `other`: a tree path another computer holds. It goes to `TreeTools.run`, which the holder fences and judges.
// * `refused`: a tree path the session may not name this way (`.` or `..` in it, `home/memory/` for a session with no
//   memory): answered with the reason, never run.
//
// Bash keeps a tree folder per session, as a shell keeps its folder: after a call whose folder is on another computer
// (`cd home/Studio/x`, alone or followed by `&&`/`;`), later calls with no leading `cd` run there; a `cd` to anything
// else (a local folder, an absolute path, `home/<this computer>/…`) clears it. A plain `mv` or `cp` whose ends are
// on two computers takes the tree's direct path, whatever the folder.
import type { Caller } from "@waifucave/moss-protocol";
import { isContractError } from "../contracts/common";
import { splitTreePath } from "../contracts/tree";
import { MEMORY_FOLDER } from "./holder";
import { transferCommand } from "./tools";
import type { TreeDirectory } from "./tree";

/** The file tools whose path the router reads, and the field each names it in. */
const PATH_FIELD: Readonly<Record<string, "file_path" | "path">> = {
  Read: "file_path", Write: "file_path", Edit: "file_path", Glob: "path", Grep: "path",
};

export interface TreeRouteDeps {
  directory: TreeDirectory;
  /** A tree path's computer and its real path there (`CoreTree.resolve`). Throws for a path no computer holds. */
  resolve(path: string, as: Caller): { computer: string; path: string };
}

export type TreeRoute =
  | { kind: "local" }
  | { kind: "here"; input: Record<string, unknown> }
  | {
    kind: "other"; computer: string; online: boolean;
    /** Bash only: the session's tree folder the call runs in (its leading `cd` may move it). */
    cwd?: string;
  }
  | { kind: "refused"; reason: string };

const LOCAL: TreeRoute = { kind: "local" };
const LEADING_CD = /^\s*cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:(&&|;)\s*([\s\S]*))?$/;

/** A path in single quotes for a POSIX shell. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** One session's router: its tree folder for Bash, and how each of its calls runs. */
export class TreeRouter {
  readonly #d: TreeRouteDeps;
  readonly #as: Caller;
  /** Bash's folder on another computer, when a call left it there. */
  #treeCwd: string | undefined;

  constructor(deps: TreeRouteDeps, as: Caller) {
    this.#d = deps;
    this.#as = as;
  }

  /** Bash's folder on another computer, if any. */
  get treeCwd(): string | undefined {
    return this.#treeCwd;
  }

  /** Whether `path` names the tree (a known computer, `home/memory`, or a bot's folder), and is spelt as one. */
  #treeName(path: string): "tree" | "dotted" | "no" {
    const head = /^(home|bots)\/([^/\\]+)(?:[/\\]|$)/.exec(path);
    if (!head) return "no";
    const [, area, name] = head;
    const known = area === "bots" || name === MEMORY_FOLDER || this.#d.directory.get(name!) !== undefined;
    if (!known) return "no";
    return splitTreePath(path) === null ? "dotted" : "tree";
  }

  /** Where a tree path is: this computer (with its real path), another one, or refused. */
  #place(path: string): { here: string } | { other: string; online: boolean } | { refused: string } | null {
    switch (this.#treeName(path)) {
      case "no": return null;
      case "dotted": return { refused: `${path}: a path in the folder tree takes no "." or ".." parts, empty parts or backslashes; name the folder itself` };
    }
    let at: { computer: string; path: string };
    try {
      at = this.#d.resolve(path, this.#as);
    } catch (e) {
      // A computer that hasn't said where its home is yet is offline, never a refusal.
      if (isContractError(e) && e.code === "computer_offline") {
        const named = (e.detail as { computer?: unknown } | undefined)?.computer;
        return { other: typeof named === "string" ? named : path.split("/")[1]!, online: false };
      }
      return { refused: `${path}: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (at.computer === this.#d.directory.self()) return { here: at.path };
    return { other: at.computer, online: this.#d.directory.get(at.computer)?.online === true };
  }

  /** How `tool`'s call with `input` runs. Pure but for Bash's folder, which `settled` moves. */
  route(tool: string, input: unknown): TreeRoute {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return LOCAL;
    const i = input as Record<string, unknown>;
    if (tool === "Bash") return this.#bash(i);
    const field = PATH_FIELD[tool];
    if (field === undefined) return LOCAL;
    const path = i[field];
    if (typeof path !== "string") return LOCAL;
    const p = this.#place(path);
    if (p === null) return LOCAL;
    if ("refused" in p) return { kind: "refused", reason: p.refused };
    if ("here" in p) return { kind: "here", input: { ...i, [field]: p.here } };
    return { kind: "other", computer: p.other, online: p.online };
  }

  #bash(i: Record<string, unknown>): TreeRoute {
    const command = i.command;
    if (typeof command !== "string") return LOCAL;
    const m = LEADING_CD.exec(command);
    if (m) {
      const folder = m[2] ?? m[3] ?? m[4]!;
      const p = this.#place(folder);
      if (p === null) {
        // A `cd` to a folder that isn't in the tree: this computer's own, as before. A relative one while the folder
        // is on another computer is relative to that folder, as in a shell.
        if (this.#treeCwd !== undefined && !folder.startsWith("/") && !folder.startsWith("~") && !/^[A-Za-z]:[\\/]/.test(folder)) {
          return this.#elsewhere(this.#treeCwd);
        }
        return LOCAL;
      }
      if ("refused" in p) return { kind: "refused", reason: p.refused };
      if ("here" in p) {
        const rest = m[6]?.trim();
        return { kind: "here", input: { ...i, command: `cd ${shellQuote(p.here)}${rest ? ` ${m[5]} ${rest}` : ""}` } };
      }
      return { kind: "other", computer: p.other, online: p.online, ...(this.#treeCwd === undefined ? {} : { cwd: this.#treeCwd }) };
    }
    if (this.#treeCwd !== undefined) return this.#elsewhere(this.#treeCwd);
    // A plain `mv` or `cp` between tree paths, from this computer's own folder: the direct path when an end is
    // elsewhere; both ends here run here, on their real paths.
    const self = this.#d.directory.self();
    // Against a folder that is never in the tree, so only ends written as tree paths count (a relative or dotted one
    // is this computer's own, as before).
    const t = transferCommand(command, "\0");
    if (t && [t.from, t.to].every((p) => this.#treeName(p) === "tree")) {
      const ends = [t.from, t.to].map((p) => this.#place(p));
      for (const e of ends) if (e !== null && "refused" in e) return { kind: "refused", reason: e.refused };
      const away = ends.find((e): e is { other: string; online: boolean } => e !== null && "other" in e);
      if (away) return { kind: "other", computer: away.other, online: away.online, cwd: `home/${self}` };
    }
    return LOCAL;
  }

  /** A call run in the session's folder on another computer. */
  #elsewhere(cwd: string): TreeRoute {
    const p = this.#place(cwd);
    if (p === null || "refused" in p) return { kind: "refused", reason: p !== null && "refused" in p ? p.refused : `${cwd} isn't in the folder tree` };
    if ("here" in p) return { kind: "refused", reason: `${cwd} is on this computer now; cd into it again` };
    return { kind: "other", computer: p.other, online: p.online, cwd };
  }

  /** A Bash call has run: its folder afterwards. `other`: where `TreeTools` left it (a tree path); anything else, the
   *  call ran here and the session's folder is this computer's again. */
  settled(route: TreeRoute, cwd?: string): void {
    if (route.kind === "other" && cwd !== undefined) {
      const p = this.#place(cwd);
      this.#treeCwd = p !== null && "other" in p ? cwd : undefined;
    } else if (route.kind === "here" || route.kind === "local") this.#treeCwd = undefined;
  }
}
