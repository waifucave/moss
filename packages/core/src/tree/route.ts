// Where a session's own tool call runs (spec §9.1 [D]: `Read`, `Write`, `Edit`, `Glob` and `Grep` run on the computer
// that holds the path; `Bash` on the computer that holds its working folder). The runtime's built-in tools know only
// this computer's disk, and a tree path (`home/<Computer>/…`, `home/memory/…`, `bots/<bot>/…`) is not a path on it, so
// the session's PreToolUse hook asks this router first (lane XC's step 0 design):
//
// * `local`: not a tree path: an absolute path, or a relative one that names no part of the tree. The call is
//   untouched: the hook answers exactly what it answered before.
// * `here`: a tree path this computer holds. The call is rewritten to the real path (`CoreTree.resolve` as the session,
//   so `home/memory/` is the calling bot's own memory and nobody else's), and the runtime's own tool runs on it. The
//   file fence, the sandbox, the write roots and the approval check then judge the real path exactly as they judge any
//   absolute path: the session gains nothing it couldn't get by typing the real path.
// * `other`: a tree path another computer holds. It goes to that computer (lane XC's hand-off).
// * `refused`: a path that names the tree but can't be one (`.` or `..` in it, `home/memory/` for a session with no
//   memory, `home/<a name no computer has>/`): answered with the reason, never run, never left to land in the session's
//   folder under that name (the review of #1a: a misfile must never be silent).
//
// What counts as naming the tree: `home/<name>/…`, any `<name>` (a computer's name in any case, `memory` in any case,
// or else refused), and `bots/<bot>/…` for a bot the tree knows. A relative path is one only where it would resolve
// against the session's own start folder: always for the file tools (their relative paths are the start folder's),
// and for Bash only while its shell is still there (no command of the session's has changed folder yet).
//
// Bash keeps a tree folder per session, as a shell keeps its folder: after a call whose folder is on another computer
// (`cd home/Studio/x`, alone or followed by `&&`/`;`), later calls with no leading `cd` run there; a `cd` to anything
// else clears it. A plain `mv` or `cp` between tree paths takes the direct path when an end is on another computer, and
// runs here on the real paths when both ends are here. Other paths inside a command are the shell's: the bot's prompt
// gives it the real paths to use there (`bots/prompt.ts`).
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

/** The computers the tree knows, for a refusal that names them (`ComputerRegistry.list`). */
export interface TreeRouteDeps {
  directory: TreeDirectory;
  /** A tree path's computer and its real path there (`CoreTree.resolve`). Throws for a path no computer holds. */
  resolve(path: string, as: Caller): { computer: string; path: string };
  /** The computers' names, for the refusal of a name no computer has. */
  names?(): readonly string[];
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

type Place = { here: string } | { other: string; online: boolean } | { refused: string };

const LOCAL: TreeRoute = { kind: "local" };
const LEADING_CD = /^\s*cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:(&&|;)\s*([\s\S]*))?$/;
/** A command that may move the shell's folder: after it, Bash's relative paths aren't the start folder's. */
const MOVES_FOLDER = /(^|[^A-Za-z0-9_-])(cd|pushd|popd)([^A-Za-z0-9_-]|$)/;
const GLOB_CHARS = /[*?[\]{}!]/;

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
  /** Whether a command of this session may have moved the runtime's shell out of its start folder. */
  #shellMoved = false;

  constructor(deps: TreeRouteDeps, as: Caller) {
    this.#d = deps;
    this.#as = as;
  }

  /** Bash's folder on another computer, if any. */
  get treeCwd(): string | undefined {
    return this.#treeCwd;
  }

  /** The path with `home/<memory in any case>/` spelt `home/memory/`, or undefined when it doesn't name the tree. */
  #treeSpelling(path: string): string | "unknown" | undefined {
    const head = /^(home|bots)\/([^/\\]+)(?=[/\\]|$)/.exec(path);
    if (!head) return undefined;
    const [, area, name] = head;
    if (area === "home") {
      if (name!.toLowerCase() === MEMORY_FOLDER) return `home/${MEMORY_FOLDER}${path.slice(head[0].length)}`;
      return this.#d.directory.get(name!) !== undefined ? path : "unknown";
    }
    // `bots/<name>` only for a bot the tree knows (a project's own `bots/` folder stays the project's).
    try {
      this.#d.resolve(`bots/${name}`, this.#as);
      return path;
    } catch {
      return undefined;
    }
  }

  /** Where a path is, when it names the tree: this computer (with its real path), another one, or refused. */
  #place(path: string): Place | null {
    const spelt = this.#treeSpelling(path);
    if (spelt === undefined) return null;
    if (spelt === "unknown") {
      const name = path.split("/")[1]!;
      const names = this.#d.names?.() ?? [this.#d.directory.self()];
      return { refused: `${path}: no computer is called ${name} (the computers: ${names.join(", ")}). A folder of your own goes in your scratch folder under another name.` };
    }
    if (splitTreePath(spelt) === null) return { refused: `${path}: a path in the folder tree takes no "." or ".." parts, empty parts or backslashes; name the folder itself` };
    let at: { computer: string; path: string };
    try {
      at = this.#d.resolve(spelt, this.#as);
    } catch (e) {
      if (isContractError(e) && e.code === "computer_offline") {
        const named = (e.detail as { computer?: unknown } | undefined)?.computer;
        const computer = typeof named === "string" ? named : spelt.split("/")[1]!;
        // This computer's own home not known yet is no offline computer: say so.
        if (computer === this.#d.directory.self()) return { refused: `${path}: this computer's home folder isn't known to MOSS yet; try again in a moment` };
        return { other: computer, online: false };
      }
      return { refused: `${path}: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (at.computer === this.#d.directory.self()) return { here: at.path };
    return { other: at.computer, online: this.#d.directory.get(at.computer)?.online === true };
  }

  /** How `tool`'s call with `input` runs. Pure but for Bash's folders, which `settled` moves. */
  route(tool: string, input: unknown): TreeRoute {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return LOCAL;
    const i = input as Record<string, unknown>;
    if (tool === "Bash") return this.#bash(i);
    const field = PATH_FIELD[tool];
    if (field === undefined) return LOCAL;
    const path = i[field];
    if (typeof path === "string") return this.#fileRoute(i, field, path);
    // Glob and Grep with no path search the start folder; a pattern (Glob) or a `glob` (Grep) that begins with a
    // tree path names its folder: split it there, never search the start folder under that name.
    const key = tool === "Glob" ? "pattern" : tool === "Grep" ? "glob" : undefined;
    if (key === undefined || typeof i[key] !== "string") return LOCAL;
    const split = splitPattern(i[key] as string);
    if (split === undefined) return LOCAL;
    const route = this.#fileRoute({ ...i, [key]: split.rest }, "path", split.root);
    return route.kind === "local" ? LOCAL : route;
  }

  #fileRoute(i: Record<string, unknown>, field: string, path: string): TreeRoute {
    const p = this.#place(path);
    if (p === null) return LOCAL;
    if ("refused" in p) return { kind: "refused", reason: p.refused };
    if ("here" in p) return { kind: "here", input: { ...i, [field]: p.here } };
    return { kind: "other", computer: p.other, online: p.online };
  }

  /** A relative path in a command names the tree only while the shell is in the session's start folder. */
  #bashPlace(path: string): Place | null {
    return this.#shellMoved ? null : this.#place(path);
  }

  #bash(i: Record<string, unknown>): TreeRoute {
    const command = i.command;
    if (typeof command !== "string") return LOCAL;
    const m = LEADING_CD.exec(command);
    if (m) {
      const folder = m[2] ?? m[3] ?? m[4]!;
      // Into another computer's folder, a `cd` goes there wherever the shell is (the spec's `cd home/Studio/x && …`;
      // nothing of this computer's is touched). Into this computer's tree, only from the start folder.
      const anywhere = this.#place(folder);
      const p = anywhere !== null && "other" in anywhere ? anywhere : this.#bashPlace(folder);
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
    // A plain `mv` or `cp` between tree paths: against a folder that is never in the tree, so only ends written as
    // tree paths count.
    const t = transferCommand(command, "\0");
    if (t) {
      const ends = [this.#bashPlace(t.from), this.#bashPlace(t.to)];
      for (const e of ends) if (e !== null && "refused" in e) return { kind: "refused", reason: e.refused };
      const away = ends.find((e): e is { other: string; online: boolean } => e !== null && "other" in e);
      if (away) return { kind: "other", computer: away.other, online: away.online, cwd: `home/${this.#d.directory.self()}` };
      // Both ends here: the same command on their real paths.
      if (ends.every((e) => e !== null && "here" in e)) {
        const [from, to] = ends as { here: string }[];
        return { kind: "here", input: { ...i, command: `${t.move ? "mv" : `cp${t.recursive ? " -R" : ""}`} ${shellQuote(from!.here)} ${shellQuote(to!.here)}` } };
      }
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

  /** A Bash call has run: its folder afterwards. `other`: where the holder left it (a tree path); anything else, the
   *  call ran here, where its shell's folder may have moved. */
  settled(route: TreeRoute, cwd?: string, command?: string): void {
    if (route.kind === "other" && cwd !== undefined) {
      const p = this.#place(cwd);
      this.#treeCwd = p !== null && "other" in p ? cwd : undefined;
      return;
    }
    if (route.kind !== "here" && route.kind !== "local") return;
    this.#treeCwd = undefined;
    // The command as it ran here: a `cd` (ours to a real folder, or the bot's own) moves the shell out of its start folder.
    const ran = route.kind === "here" ? route.input.command : command;
    if (typeof ran === "string" && MOVES_FOLDER.test(ran)) this.#shellMoved = true;
  }
}

/** A search pattern's leading literal folders, when they name the tree: `home/memory/**\/*.md` is `home/memory` and
 *  `**\/*.md`. Undefined when the pattern doesn't begin with `home/` or `bots/`, or has no literal folder part. */
function splitPattern(pattern: string): { root: string; rest: string } | undefined {
  if (!/^(home|bots)\//.test(pattern)) return undefined;
  const parts = pattern.split("/");
  let n = 0;
  while (n < parts.length - 1 && !GLOB_CHARS.test(parts[n]!)) n++;
  if (n < 2) return undefined;
  const rest = parts.slice(n).join("/");
  return { root: parts.slice(0, n).join("/"), rest: rest === "" ? "*" : rest };
}
