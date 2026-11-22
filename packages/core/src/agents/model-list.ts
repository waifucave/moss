// An agent's own model list, learned before any session exists (lane MS). General: an agent plugin DECLARES where its
// agent keeps the list, as data in its quirks file (`modelList`), and nothing here knows an agent by name. Sources, in
// the order they are tried, cheapest and safest first:
//   a. `command`: the agent's own list command (`codex debug models`). It runs only after the same launch checks a
//      session gets: the program is resolved to a real path from the backend's environment allow-list, and answers its
//      version command as the declared identity (`versionArgs`, `versionPattern`) says. It is run with no session and no
//      prompt, in an empty temp folder, stdin closed, a hard time limit and a byte cap, and ended by its pid.
//   b. `file`: ONE file the agent keeps in its own config folder. Only that file is opened: no listing of the folder, no
//      other file in it, and what is parsed is data from outside (a hostile file gives nothing, never an error). Only
//      ids, names and efforts are kept; contents are never logged.
//   c. `session`: what a real session of the agent reported (its ACP `configOptions`), remembered per agent in one
//      small file under the run folder, `<home>/run/agents/session-models.json` (0600, atomic, bounded).
// A declared list is cached with its age; one past `ttlMs` is still answered while it is read again in the background.
// A read that fails falls to the next source and leaves one plain log line, never an error in a panel.
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { BackendModelOption, type ModelListing } from "@waifucave/moss-protocol";
import { noteSpawned } from "../auth/moss-caller";
import { resolveProgram, runCapture } from "./backend";
import { spawnPlan } from "./process/launch";

/** A path inside a folder: relative, no `..`, no drive or root. */
const RelPath = z.string().min(1).max(256).refine((p) => !isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes(".."), "a relative path with no `..`");
const Key = z.string().min(1).max(64);

/** How to read a list out of JSON. `list` is the dotted path to the array ("" for the root); an item is an object with
 *  its model id under `id`, its name under `name`, and its efforts (strings, or objects holding `efforts.id`) under
 *  `efforts.list`. An item is left out when `hideUnless` names a key whose value isn't the one given. */
export const ModelReaderSchema = z.strictObject({
  list: z.string().max(256),
  id: Key,
  name: Key.optional(),
  hideUnless: z.strictObject({ key: Key, value: z.string().max(64) }).optional(),
  efforts: z.strictObject({ list: Key, id: Key.optional() }).optional(),
  defaultEffort: Key.optional(),
});
export type ModelReader = z.infer<typeof ModelReaderSchema>;

const HARD_MAX_BYTES = 8 * 1024 * 1024;

export const ModelListDeclSchema = z.strictObject({
  /** a. The agent's own list command. */
  command: z.strictObject({
    program: z.string().min(1).max(256),
    args: z.array(z.string().max(256)).max(16),
    identity: z.strictObject({ versionArgs: z.array(z.string().max(256)).max(8), versionPattern: z.string().min(1).max(512) }),
    timeoutMs: z.number().int().min(500).max(30_000).default(10_000),
    maxBytes: z.number().int().min(1024).max(HARD_MAX_BYTES).default(4 * 1024 * 1024),
  }).optional(),
  /** b. One file in the agent's own folder: `home` under the user's home (or the folder `env` names, if set), then `path`. */
  file: z.strictObject({
    home: RelPath,
    env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
    path: RelPath,
    maxBytes: z.number().int().min(1024).max(HARD_MAX_BYTES).default(4 * 1024 * 1024),
  }).optional(),
  reader: ModelReaderSchema,
}).refine((d) => d.command !== undefined || d.file !== undefined, "a list command or a file");
export type ModelListDecl = z.infer<typeof ModelListDeclSchema>;

export type ListSource = "command" | "file" | "session";
export interface ListedModels { source: ListSource; models: BackendModelOption[]; at: number }

const MODELS_MAX = 1_000;
const ITEMS_SCANNED_MAX = 5_000;
const noControl = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s);

/** Own data property of a plain object, else undefined (no prototype chain, no `__proto__`). */
function own(o: unknown, key: string): unknown {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return undefined;
  return Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;
}

/** Reads a list out of untrusted text: models with their ids, names and efforts, or nothing. Never throws. */
export function parseModelList(text: string, reader: ModelReader): BackendModelOption[] | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  let at: unknown = root;
  if (reader.list !== "") for (const k of reader.list.split(".")) at = own(at, k);
  if (!Array.isArray(at)) return undefined;
  const out: BackendModelOption[] = [];
  const seen = new Set<string>();
  for (const item of at.slice(0, ITEMS_SCANNED_MAX)) {
    if (out.length >= MODELS_MAX) break;
    if (reader.hideUnless !== undefined && own(item, reader.hideUnless.key) !== reader.hideUnless.value) continue;
    const id = own(item, reader.id);
    if (typeof id !== "string" || id.length === 0 || id.length > 200 || !noControl(id) || seen.has(id)) continue;
    const nameRaw = reader.name === undefined ? undefined : own(item, reader.name);
    const name = typeof nameRaw === "string" && nameRaw.length > 0 && nameRaw.length <= 200 && noControl(nameRaw) ? nameRaw : id;
    const efforts: string[] = [];
    if (reader.efforts !== undefined) {
      const list = own(item, reader.efforts.list);
      if (Array.isArray(list)) {
        for (const e of list.slice(0, 64)) {
          const v = reader.efforts.id === undefined ? e : own(e, reader.efforts.id);
          if (typeof v === "string" && v.length > 0 && v.length <= 32 && noControl(v) && !efforts.includes(v) && efforts.length < 16) efforts.push(v);
        }
      }
    }
    const d = reader.defaultEffort === undefined ? undefined : own(item, reader.defaultEffort);
    const option = { id, name, efforts, ...(typeof d === "string" && efforts.includes(d) ? { defaultEffort: d } : {}) };
    if (!BackendModelOption.safeParse(option).success) continue;
    seen.add(id);
    out.push(option);
  }
  return out.length === 0 ? undefined : out;
}

/** Whether `child` is inside `base` (both real paths). */
function inside(base: string, child: string): boolean {
  const rel = relative(base, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/** b. Reads the ONE declared file. The folder is the user's home plus `home`, or the folder an environment variable
 *  names (absolute only); the file is refused unless it is a regular file, not a link (`lstat`), with one name (no hard
 *  link planted beside a sensitive file), whose real path stays inside the folder's real path, and no bigger than
 *  `maxBytes`. Nothing else in the folder is opened or listed. Returns its text, or undefined. */
export function readListFile(f: NonNullable<ModelListDecl["file"]>, ctx: { userHome: string; env: Readonly<Record<string, string | undefined>> }): string | undefined {
  try {
    const named = f.env === undefined ? undefined : ctx.env[f.env];
    const folder = named !== undefined && named !== "" && isAbsolute(named) ? named : join(ctx.userHome, f.home);
    const base = realpathSync(folder);
    const target = join(base, f.path);
    const st = lstatSync(target);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > f.maxBytes) return undefined;
    const real = realpathSync(target);
    if (!inside(base, real)) return undefined;
    const fd = openSync(real, "r");
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile() || fst.nlink !== 1 || fst.size > f.maxBytes || fst.ino !== st.ino) return undefined;
      const buf = Buffer.alloc(fst.size);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, got);
        if (n === 0) break;
        got += n;
      }
      return buf.subarray(0, got).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Runs the list command: no shell, an empty temp folder as its cwd, stdin closed, stderr dropped, stdout read up to
 *  `maxBytes` (more ends it), a hard time limit; it is ended by its pid at either limit. Undefined unless it exits 0. */
export function runBounded(program: string, args: readonly string[], env: Record<string, string>, timeoutMs: number, maxBytes: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let dir: string;
    let plan: ReturnType<typeof spawnPlan>;
    try {
      dir = mkdtempSync(join(tmpdir(), "moss-list-"));
      plan = spawnPlan(program, args);
    } catch {
      resolve(undefined);
      return;
    }
    const done = (v: string | undefined): void => {
      clearTimeout(timer);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      resolve(v);
    };
    const child = spawn(plan.file, plan.args, { cwd: dir, env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, windowsVerbatimArguments: plan.verbatim });
    noteSpawned(child.pid, child); // a list read is never the user
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        over = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(c);
    });
    const timer = setTimeout(() => { over = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", () => done(undefined));
    child.on("close", (code) => done(!over && code === 0 ? Buffer.concat(chunks).toString("utf8") : undefined));
  });
}

/** a. The list command, after the launch checks: the program found on the backend's own PATH, and its version command
 *  answering as the declared identity says. Undefined when any check or the run fails. */
export async function runListCommand(c: NonNullable<ModelListDecl["command"]>, env: Record<string, string>): Promise<string | undefined> {
  const path = resolveProgram(c.program, env["PATH"] ?? env["Path"]);
  if (path === undefined) return undefined;
  const said = await runCapture(path, [...c.identity.versionArgs], env, 10_000).catch(() => undefined);
  let ok = false;
  try {
    ok = said !== undefined && new RegExp(c.identity.versionPattern, "m").test(said.trim());
  } catch {
    ok = false;
  }
  if (!ok) return undefined;
  return runBounded(path, c.args, env, c.timeoutMs, c.maxBytes);
}

/** What a backend gives the service: its declaration and the environment its launch would give a program. */
export interface ListableBackend {
  readonly id: string;
  readonly modelList?: ModelListDecl;
  listEnv?(): Record<string, string>;
}

/** The loose shape of an ACP session's config options (`ConfigOption`). */
export interface ReportedOption { id: string; category?: string; currentValue?: string; values: readonly string[] }

/** The models and efforts an ACP session reported, as its quirks name the options. A session's efforts apply to every
 *  model of it, and an agent that folds effort into the model's id (`effortInModel`) lists none. */
export function reportedModels(options: readonly ReportedOption[] | undefined, config: { modelOption: string | null; effortOption: string | null; effortInModel: boolean }): BackendModelOption[] {
  if (options === undefined) return [];
  const model = options.find((o) => (config.modelOption !== null && o.id === config.modelOption) || o.category === "model");
  if (model === undefined) return [];
  const effort = config.effortInModel ? undefined : options.find((o) => (config.effortOption !== null && o.id === config.effortOption) || o.category === "thought_level");
  const efforts = (effort?.values ?? []).filter((e) => e.length > 0 && e.length <= 32 && noControl(e)).slice(0, 16);
  const out: BackendModelOption[] = [];
  for (const id of model.values) {
    if (out.length >= MODELS_MAX) break;
    const option = { id, name: id, efforts: [...efforts] };
    if (BackendModelOption.safeParse(option).success && noControl(id)) out.push(option);
  }
  return out;
}

const SessionMemory = z.object({
  v: z.literal(1),
  byBackend: z.record(z.string().max(128), z.object({ at: z.number(), models: z.array(BackendModelOption).max(MODELS_MAX) })),
});
const BACKENDS_KEPT = 32;
const MEMORY_MAX_BYTES = 4 * 1024 * 1024;

export interface BackendModelListsOptions {
  home: string;
  userHome: string;
  now?: () => number;
  ttlMs?: number;
  log?: (line: string) => void;
  /** Test seams. */
  runCommand?: typeof runListCommand;
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

export class BackendModelLists {
  readonly #o: BackendModelListsOptions;
  readonly #declared = new Map<string, ListedModels>();
  readonly #reading = new Map<string, Promise<void>>();
  readonly #failed = new Set<string>();
  #memory: z.infer<typeof SessionMemory> | undefined;

  constructor(o: BackendModelListsOptions) {
    this.#o = o;
  }

  get #path(): string {
    return join(this.#o.home, "run", "agents", "session-models.json");
  }

  /** The backend's list: its declared one (cached, read again in the background when old), else what a session of it
   *  reported; undefined when neither is known. */
  async get(b: ListableBackend): Promise<ListedModels | undefined> {
    if (b.modelList !== undefined) {
      const now = this.#o.now?.() ?? Date.now();
      const had = this.#declared.get(b.id);
      if (had === undefined) await this.#read(b);
      else if (now - had.at > (this.#o.ttlMs ?? 10 * 60_000)) void this.#read(b);
      const got = this.#declared.get(b.id);
      if (got !== undefined) return got;
    }
    return this.#remembered(b.id);
  }

  #read(b: ListableBackend): Promise<void> {
    const decl = b.modelList!;
    const going = this.#reading.get(b.id);
    if (going !== undefined) return going;
    const job = (async () => {
      let found: ListedModels | undefined;
      if (decl.command !== undefined) {
        const text = await (this.#o.runCommand ?? runListCommand)(decl.command, b.listEnv?.() ?? {}).catch(() => undefined);
        const models = text === undefined ? undefined : parseModelList(text, decl.reader);
        if (models !== undefined) found = { source: "command", models, at: this.#o.now?.() ?? Date.now() };
      }
      if (found === undefined && decl.file !== undefined) {
        const text = readListFile(decl.file, { userHome: this.#o.userHome, env: this.#o.baseEnv ?? process.env });
        const models = text === undefined ? undefined : parseModelList(text, decl.reader);
        if (models !== undefined) found = { source: "file", models, at: this.#o.now?.() ?? Date.now() };
      }
      if (found !== undefined) {
        this.#declared.set(b.id, found);
        this.#failed.delete(b.id);
      } else if (!this.#failed.has(b.id)) {
        // One plain line per agent until a read works again; the panel just doesn't get this source.
        this.#failed.add(b.id);
        this.#o.log?.(`agents: ${b.id}'s own model list couldn't be read, so the models it reported in a session (if any) are offered`);
      }
    })().finally(() => this.#reading.delete(b.id));
    this.#reading.set(b.id, job);
    return job;
  }

  #load(): z.infer<typeof SessionMemory> {
    if (this.#memory !== undefined) return this.#memory;
    let parsed: ReturnType<typeof SessionMemory.safeParse> | undefined;
    try {
      const fd = openSync(this.#path, "r");
      try {
        const st = fstatSync(fd);
        if (st.isFile() && st.size <= MEMORY_MAX_BYTES) parsed = SessionMemory.safeParse(JSON.parse(readFileSync(fd, "utf8")));
      } finally {
        closeSync(fd);
      }
    } catch {
      parsed = undefined;
    }
    this.#memory = parsed?.success === true ? parsed.data : { v: 1, byBackend: {} };
    return this.#memory;
  }

  #remembered(id: string): ListedModels | undefined {
    const row = Object.hasOwn(this.#load().byBackend, id) ? this.#load().byBackend[id] : undefined;
    return row === undefined || row.models.length === 0 ? undefined : { source: "session", models: row.models, at: row.at };
  }

  /** c. A session reported these models: kept for the backend, newest backend first, at most `BACKENDS_KEPT` backends. */
  noteSession(backend: string, models: readonly BackendModelOption[]): void {
    if (models.length === 0 || backend.length === 0 || backend.length > 128) return;
    const mem = this.#load();
    const was = Object.hasOwn(mem.byBackend, backend) ? mem.byBackend[backend] : undefined;
    if (was !== undefined && JSON.stringify(was.models) === JSON.stringify(models)) return;
    const rest = Object.entries(mem.byBackend).filter(([k]) => k !== backend);
    const next = { v: 1 as const, byBackend: Object.fromEntries([[backend, { at: this.#o.now?.() ?? Date.now(), models: [...models] }], ...rest].slice(0, BACKENDS_KEPT)) };
    this.#memory = next;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      renameSync(tmp, this.#path);
      try { chmodSync(this.#path, 0o600); } catch { /* best effort */ }
    } catch {
      // The run folder can't be written: what the session reported is still held in memory.
    }
  }
}

/** `models.list {session}` for a session on an ACP agent: the models that session's agent reported, or, before its first
 *  turn has started it, the agent's list as known (declared, else what an earlier session reported). A listing's `id` is
 *  the agent's own model id (what `session.setModel` hands the agent), and `provider` is the agent's backend id, so it
 *  never reads as a catalog id. Empty when nothing is known: the picker then just doesn't offer a choice. */
export async function agentSessionListing(
  backend: ListableBackend & { pluginId: string; name?: string; quirks: { config: { modelOption: string | null; effortOption: string | null; effortInModel: boolean } } },
  options: readonly ReportedOption[] | undefined,
  lists: Pick<BackendModelLists, "get">,
): Promise<ModelListing[]> {
  const reported = reportedModels(options, backend.quirks.config);
  const models = reported.length > 0 ? reported : (await lists.get(backend).catch(() => undefined))?.models ?? [];
  return models.map((m) => ({
    id: m.id, name: m.name, provider: backend.id, providerName: backend.name ?? backend.id, plugin: backend.pluginId,
    efforts: m.efforts, ...(m.defaultEffort !== undefined ? { defaultEffort: m.defaultEffort } : {}), images: false, signedIn: true,
  }));
}
