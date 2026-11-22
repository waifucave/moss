// What a person starts a session with, before any session exists, and what they started last (spec revision 20, §9.5
// "Starting from a part"; the contract is `contracts/agent-start.ts`, whose conformance suite `tests/start-options.test.ts`
// runs against this). General: `agent.options` and `agent.recent` answer any client (a plugin's start page, the CLI, the Mac
// app) the same; nothing here knows a page.
//   * `options`: MOSS's coding agent from the model catalog (the models the person can run now, its default the person's
//     default model and effort); an ACP agent from its quirks or a probe where it gives them; otherwise `known: false`,
//     "unknown until started", which is a valid answer. A backend no plugin gives is `not_found`.
//   * `remember` keeps the person's LAST start only (the caller passes the person's, never a bot's, a spawn's or a routine's):
//     its backend, model, effort and computer, and the folders newest first, each once, at most `RECENT_FOLDERS_MAX`.
//   * The folders are tree paths: they reach main's process and the CLI, never a page (the app's door turns them into pick
//     tokens). Kept in one small file under the run folder, written whole and atomically on a start and read on the first
//     ask; a missing, unreadable or malformed file is "nothing yet", never an error, and a late reload of an older engine's
//     home finds no such file at all.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RECENT_BACKENDS_MAX, RECENT_FOLDERS_MAX, RecentStart, type AgentBackendOptions, type BackendModelOption } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import type { AgentStartOptions, PersonStart } from "../contracts/agent-start";

/** How a backend knows its options. */
export type BackendOptionSource =
  | { from: "catalog" }
  /** An ACP agent: the list its plugin declares (its own command, or one file of its folder), else what a session of it
   *  reported (`EngineStartOptionsDeps.listed`); unknown while neither is known. */
  | { from: "listed" }
  | { from: "quirks" | "probe" | "command" | "file" | "session"; models: BackendModelOption[]; default?: { model?: string; effort?: string } }
  | { from: "unknown" };

/** Where the person's last start is kept. */
export interface RecentStore {
  read(): unknown;
  write(recent: RecentStart): void;
}

export class MemoryRecentStore implements RecentStore {
  #held: RecentStart | undefined;
  read(): unknown { return this.#held; }
  write(recent: RecentStart): void { this.#held = recent; }
}

/** `<home>/run/agents/recent-start.json`: private to the person (0600), atomic. */
export class FileRecentStore implements RecentStore {
  constructor(private readonly path: string) {}

  static in(home: string): FileRecentStore {
    return new FileRecentStore(join(home, "run", "agents", "recent-start.json"));
  }

  read(): unknown {
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return undefined;
    }
  }

  write(recent: RecentStart): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(recent), { mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
  }
}

export interface EngineStartOptionsDeps {
  /** How the backend knows its options; undefined: no such backend (or one a person can't start). */
  source(backend: string): BackendOptionSource | undefined;
  /** The models a person can run now and their default, read at each ask (the catalog and the setup state move). */
  catalog(): Promise<{ models: BackendModelOption[]; default?: { model: string; effort?: string } }> | { models: BackendModelOption[]; default?: { model: string; effort?: string } };
  store: RecentStore;
  /** What an ACP agent's list says now: where it came from and its models (`BackendModelLists.get`); none: not known. */
  listed?(backend: string): Promise<{ source: "command" | "file" | "session"; models: BackendModelOption[] } | undefined>;
}

export class EngineAgentStartOptions implements AgentStartOptions {
  #recent: RecentStart | undefined;

  constructor(private readonly deps: EngineStartOptionsDeps) {}

  async options(backend: string, _computer?: string): Promise<AgentBackendOptions> {
    const src = this.deps.source(backend);
    if (src === undefined) throw new ContractError("not_found", `no agent backend ${backend.slice(0, 64)}`);
    if (src.from === "catalog") {
      const c = await this.deps.catalog();
      return { backend, known: true, source: "catalog", models: c.models, ...(c.default ? { default: c.default } : {}) };
    }
    if (src.from === "listed") {
      const l = await this.deps.listed?.(backend).catch(() => undefined);
      return l === undefined ? { backend, known: false, source: "unknown", models: [] } : { backend, known: true, source: l.source, models: l.models };
    }
    if (src.from === "unknown") return { backend, known: false, source: "unknown", models: [] };
    return { backend, known: true, source: src.from, models: src.models, ...(src.default ? { default: src.default } : {}) };
  }

  remember(start: PersonStart, at: number): void {
    const was = this.#load();
    const roots = [{ root: start.root, at }, ...was.roots.filter((r) => r.root !== start.root)].slice(0, RECENT_FOLDERS_MAX);
    // Each agent's own last choice, newest first: the model the person picked for THAT agent. Only the person's starts
    // come here, so a bot's or another session's start never moves it; a start with no model clears this agent's choice
    // (they chose the agent's own default).
    const byBackend = [
      { backend: start.backend, ...(start.model !== undefined ? { model: start.model } : {}), ...(start.effort !== undefined ? { effort: start.effort } : {}) },
      ...(was.byBackend ?? []).filter((b) => b.backend !== start.backend),
    ].slice(0, RECENT_BACKENDS_MAX);
    const next: RecentStart = {
      backend: start.backend, computer: start.computer, roots, byBackend,
      ...(start.model !== undefined ? { model: start.model } : {}), ...(start.effort !== undefined ? { effort: start.effort } : {}),
    };
    this.#recent = next;
    try {
      this.deps.store.write(next);
    } catch {
      // The folder can't be written (full disk, read-only home): the start itself went ahead; the next ask has the memory.
    }
  }

  recent(): RecentStart {
    const r = this.#load();
    return { ...r, roots: [...r.roots], ...(r.byBackend === undefined ? {} : { byBackend: r.byBackend.map((b) => ({ ...b })) }) };
  }

  #load(): RecentStart {
    if (this.#recent !== undefined) return this.#recent;
    const parsed = RecentStart.safeParse(this.deps.store.read());
    this.#recent = parsed.success ? parsed.data : { roots: [] };
    return this.#recent;
  }
}
