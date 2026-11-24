// An ACP backend (spec §5.3 `agentBackends` with `protocol: "acp"`, §9.3 "Local placement"): the spine's
// `AgentBackend` for an agent that runs as a local process speaking ACP over stdio.
//
// * `detect` never trusts a command name on PATH (S5 edit 1: `agent` is both Cursor's and Grok's). It resolves the
//   program to its real path, runs its version command with an allow-listed environment and a time limit, matches the
//   output against the quirks' pattern, and on macOS verifies the code signature (`codesign --verify --strict`) with
//   a requirement naming the publisher's team, where the quirks name one.
// * `start` launches one contained process per delegation in the root folder (process/launch.ts), hands it the
//   bridge as its one stdio MCP server, and opens the ACP session (acp/session.ts). At read-only, an agent that acts
//   without asking starts in its read-only mode (`readOnlyMode`), or `start` refuses it; the manager switches a
//   running one at its next turn.
// * Its own sandbox (sandbox/admission.ts): `detect` reports `sandboxed: true` only where the backend's sandbox is
//   admitted for this OS and version, and `start` then writes the fenced set in the backend's own format into the
//   session's setup folder. Every other agent, and one outside its tested versions, starts only after the user's OK
//   (sandbox/oks.ts, asked by the manager).
import { spawn } from "node:child_process";
import { noteSpawned } from "../auth/moss-caller";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { Level, Os } from "@waifucave/moss-protocol";
import type { AgentPauseGate } from "./manager";
import type { McpSdkServerConfigWithInstance } from "@waifucave/clover-agent-sdk";
import type { AgentBackend, AgentDetection, AgentQuirks, AgentStartSpec, BridgeServer } from "../contracts/agent-backend";
import type { Clock } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserSelections } from "./acp/selections";
import { AcpAgentSession, type WireTap } from "./acp/session";
import { ADMISSIONS, admissionFor, type SandboxAdmission } from "./sandbox/admission";
import type { PluginParts } from "./placement";
import type { StdioMcpServer } from "@waifucave/clover-agent-sdk/acp";
import { AgentJob } from "../platform/win-job";
import { programHash } from "./sandbox/oks";
import { buildAgentEnv, launchContained, spawnPlan, type AgentJobLike } from "./process/launch";
import { versionSatisfies } from "./version";
import type { ModelListDecl } from "./model-list";
import { adapterPin, type AdapterStore } from "./adapter/store";
import { adapterDeclinedLine, adapterFailedLine, type AdapterBackend, type AdapterDecl, type AdapterOffer, type AdapterPlaced, type AdapterStartFacts, type AdapterUse } from "./adapter/types";

export { versionSatisfies } from "./version";
import type { ProcessTableReader } from "./process/table";

/** How a backend's program is run: `program` resolved on PATH, `prefixArgs` before both the version arguments and
 *  the ACP arguments (a script's path, when the program is an interpreter). */
export interface BackendCommand {
  program: string;
  prefixArgs?: readonly string[];
  acpArgs: readonly string[];
}

export interface AcpBackendOptions {
  id: string;
  pluginId: string;
  /** MOSS's own bundled `moss/agent-<id>` entry (what the core grants by id applies). */
  bundled?: boolean;
  /** Its `agentBackends` entry's name, for Settings. */
  name?: string;
  quirks: AgentQuirks;
  clock: Clock;
  /** Overrides the quirks' command (an `agentBackends` entry's `command` and `args`). */
  command?: BackendCommand;
  os?: Os;
  /** Where each session's wire goes, and its stderr: the transcript (transcript.ts). */
  wire?: (sessionId: string) => AgentWire;
  /** The environment the allow-list reads from; the daemon's own by default. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  clientInfo?: { name: string; version: string };
  table?: ProcessTableReader;
  versionTimeoutMs?: number;
  startTimeoutMs?: number;
  /** How long an agent has to confirm a mode the floor switched it to (the session's `MODE_CONFIRM_MS`). */
  modeConfirmMs?: number;
  /** Which sandboxes hold the fence (S8); the built-in table by default. */
  admissions?: Parameters<typeof admissionFor>[0];
  /** Where a session's sandbox files go: a folder inside the fenced run folder (`<home>/run/agents/<session>`). */
  setupDir?: (sessionId: string) => string;
  /** Places plugins' skills, agent definitions and hooks where this backend reads its own (Claude Code), returning the
   *  `_meta` that points the agent at them. */
  place?: (parts: PluginParts, ctx: { dir: string }) => { meta: Record<string, unknown> };
  /** The record of the user's own selections where the agent saves a session's choice as theirs (review 10); one per
   *  backend instance in memory by default. */
  selections?: UserSelections;
  /** Makes the Windows job object for one agent; lane C's `AgentJob.create` by default. */
  makeJob?: () => AgentJobLike | null;
  /** The agent's read-only mode, for an agent that acts without asking (its quirks file's `readOnlyMode`). */
  readOnlyMode?: { option: string; values: readonly string[] };
  /** Where the agent keeps its own model list (its quirks file's `modelList`, a bundled plugin's only). */
  modelList?: ModelListDecl;
  /** The program is an adapter MOSS provides (the quirks file's `launch.adapter`, with its lock read): `adapters` is the
   *  place MOSS keeps them and `runtime` the Bun that runs one (MOSS's own, never the person's `node`). */
  adapter?: AdapterDecl;
  adapters?: AdapterStore;
  runtime?: () => string;
}

/** What checking the person's programs an adapter drives found: their paths for the adapter's variables, or why not. */
type UsesResult = { ok: true; env: Record<string, string> } | { ok: false; found: boolean; reason: string };

/** `AgentStartSpec`, plus what lane K's own backends read. */
export interface AcpStartSpec extends AgentStartSpec {
  /** The session runs at read-only: an agent that acts without asking must start in its read-only mode. */
  readOnly?: boolean;
  /** The session's level, for its sandbox writer (which modes it may run in). */
  level?: Level;
  /** The program the manager admitted (and the user OK'd, with its file's hash): `start` refuses another. */
  admitted?: { path: string; version?: string; sha256?: string };
  /** For a backend that runs inside the daemon (`inProcess`): the session's bridge as an in-process MCP server, which it
   *  serves in place of the stdio `bridge` (there is no process to bind a token to). */
  inProcessBridge?: McpSdkServerConfigWithInstance;
  /** The pause this session answers to, for a backend that holds its own tool calls (the in-process ones): the
   *  manager's switch, and for an agent run for another computer, that computer's forwarded switch too (remote.ts). */
  pause?: AgentPauseGate;
  /** What the manager's admission just detected, when nothing waited on the person since: `start` uses it in place of
   *  detecting again (a program probe and a signature check are run once a start, not twice). */
  detected?: AgentDetection;
  /** The start's step timer: each step of `start` that ends is named here (the manager logs the line). */
  mark?: (step: string) => void;
}

/** One session's hooks into the daemon: its transcript (the wire and stderr), and `launched`, called with the agent's
 *  pid right after it starts and before `initialize`, so the bridge's token is bound before the bridge can connect. */
export interface AgentWire {
  tap?: WireTap;
  stderr?: (chunk: Uint8Array) => void;
  /** `contains`: on Windows, the agent's job, which the bridge's caller check reads instead of the process tree. */
  launched?: (pid: number, contains?: (pid: number) => boolean) => void;
  /** The agent's process exited, for whatever reason (its pid). */
  exited?: (pid: number) => void;
  /** Where its sandbox files go: inside the fenced run folder, so no bot or agent can rewrite them. */
  setupDir?: string;
  /** The plugins' skills, agent definitions and hooks in this session's scope. */
  parts?: PluginParts;
}

export function currentOs(): Os {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
}

/** The flags MOSS's Bun runs an adapter with: nothing is fetched at run time (a module the adapter's closure lacks fails
 *  instead of being downloaded), no `.env` of the folder it works in is read, and the run folder's own config is the only
 *  one (a `bunfig.toml` in the person's project configures nothing). */
export const ADAPTER_BUN_FLAGS = (bunfig: string): string[] => ["--no-install", "--no-env-file", `--config=${bunfig}`];

export class AcpAgentBackend implements AgentBackend, AdapterBackend {
  readonly id: string;
  readonly pluginId: string;
  readonly bundled: boolean;
  readonly name: string | undefined;
  readonly quirks: AgentQuirks;
  readonly #opts: AcpBackendOptions;
  readonly #selections: UserSelections;
  /** What happened at the last offer of the adapter's download (`noteAdapter`), for `detect`'s reason. */
  #adapterNote: { declined: true } | { failed: string } | undefined;
  /** The person's programs the adapter drives, as last checked (a check runs a process, and `detect` is called often). */
  #usesSeen = new Map<string, { at: number; result: UsesResult }>();

  constructor(opts: AcpBackendOptions) {
    this.id = opts.id;
    this.pluginId = opts.pluginId;
    this.bundled = opts.bundled === true;
    this.name = opts.name;
    this.quirks = opts.quirks;
    this.#opts = opts;
    this.#selections = opts.selections ?? new UserSelections();
  }

  /** The command for this OS: the override, or the quirks' own. */
  command(): BackendCommand | undefined {
    if (this.#opts.command) return this.#opts.command;
    const argv = this.quirks.launch.command[this.#opts.os ?? currentOs()];
    if (!argv || argv.length === 0) return undefined;
    return { program: argv[0]!, acpArgs: argv.slice(1) };
  }

  /** Where this agent's own model list is declared (`agents/model-list.ts`). */
  get modelList(): ModelListDecl | undefined {
    return this.#opts.modelList;
  }

  /** The agent's read-only mode (the approval level's option), which MOSS owns. */
  get readOnlyMode(): { option: string; values: readonly string[] } | undefined {
    return this.#opts.readOnlyMode;
  }

  /** The backend's own program and identity: a list command of the same program is checked against these. */
  get ownProgram(): { program: string; identity: { versionArgs: readonly string[]; versionPattern: string } } | undefined {
    const c = this.command();
    return c === undefined ? undefined : { program: c.program, identity: this.quirks.launch.identity };
  }

  /** The environment this agent's launch gives a program: the list command runs under the same allow-list. */
  listEnv(): Record<string, string> {
    return this.#env();
  }

  #env(): Record<string, string> {
    return buildAgentEnv(this.quirks.launch.envAllow, this.quirks.launch.envSet, this.#opts.baseEnv);
  }

  async detect(): Promise<AgentDetection> {
    const a = this.#opts.adapter;
    if (a === undefined || this.#opts.adapters === undefined) return this.#detectOwn();
    return this.#detectWithAdapter(a, this.#opts.adapters);
  }

  /** An agent whose adapter MOSS provides. Never fetches and never asks: it says what is there.
   *  1. The person's own program the adapter drives (`claude`, `codex`) must be on this computer, and be that agent's.
   *  2. MOSS's own copy of the adapter, where it was placed, is what runs (the tested one).
   *  3. Else the person's own installed adapter, as before, when the plugin's rules accept it.
   *  4. Else the agent is startable once the adapter is downloaded (installed, not yet usable), and the reason says so. */
  async #detectWithAdapter(a: AdapterDecl, store: AdapterStore): Promise<AgentDetection> {
    const env = this.#env();
    const uses = await this.#usesOf(a, env);
    const st = store.status(a);
    if (uses.ok && st.state === "ready") {
      let runtime: string | undefined;
      let why: string | undefined;
      try {
        runtime = (this.#opts.runtime ?? (() => { throw new Error("MOSS has no runtime for it here"); }))();
      } catch (err) {
        why = `MOSS's own runtime can't start it: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (runtime !== undefined) {
        const f = this.#providedFacts(a);
        return {
          installed: true, path: st.entry, version: a.version, sha256: st.digest,
          // The identity is the integrity MOSS verified when it placed the files itself, not a `--version` line.
          identityOk: true, versionOk: f.versionOk, sandboxed: f.sandboxed, reason: f.reason,
        };
      }
      return { installed: true, identityOk: false, versionOk: false, sandboxed: false, reason: why! };
    }
    const own = await this.#detectOwn();
    if (own.installed && own.identityOk) return own;
    if (!uses.ok) return { installed: uses.found, identityOk: false, versionOk: false, sandboxed: false, reason: uses.reason };
    const label = this.name ?? this.id;
    const note = this.#adapterNote;
    return {
      installed: true, identityOk: false, versionOk: false, sandboxed: false,
      reason: note === undefined
        ? `${label}'s adapter (${a.package} ${a.version}) isn't on this computer yet: MOSS downloads it the first time you start ${label}, after you say yes`
        : "declined" in note ? adapterDeclinedLine(label) : adapterFailedLine(label, note.failed),
    };
  }

  /** What `detect` says of the provided adapter's version and sandbox: all of it from the declaration and this computer. */
  #providedFacts(a: AdapterDecl): { versionOk: boolean; sandboxed: boolean; reason: string } {
    const sandbox = this.admission(a.version);
    const versionOk = versionSatisfies(a.version, this.quirks.launch.versions);
    return {
      versionOk, sandboxed: sandbox.status === "protected",
      reason: !versionOk ? `version ${a.version} is outside the tested range ${this.quirks.launch.versions}` : sandbox.status === "protected" ? sandbox.evidence : `no sandbox: ${sandbox.reason}`,
    };
  }

  /** The person's programs the adapter drives, found on the agent's PATH and identity-checked; each one's path goes to
   *  the adapter in its environment variable (unless the person set that variable themselves, and the plugin lets it
   *  through). A short memory, since a check runs the program. */
  async #usesOf(a: AdapterDecl, env: Record<string, string>): Promise<UsesResult> {
    const key = `${env["PATH"] ?? env["Path"] ?? ""}\u0000${JSON.stringify(a.uses ?? [])}`;
    const now = this.#opts.clock.now();
    const seen = this.#usesSeen.get(key);
    if (seen !== undefined && now - seen.at < 10_000) return seen.result;
    const result = await this.#checkUses(a.uses ?? [], env);
    this.#usesSeen.set(key, { at: now, result });
    return result;
  }

  async #checkUses(uses: readonly AdapterUse[], env: Record<string, string>): Promise<UsesResult> {
    const set: Record<string, string> = {};
    const label = this.name ?? this.id;
    for (const u of uses) {
      const given = env[u.env];
      if (given !== undefined && given !== "") continue; // the person's own choice, passed through
      const path = resolveProgram(u.program, env["PATH"] ?? env["Path"]);
      if (!path) return { ok: false, found: false, reason: `${u.program} isn't installed on this computer, and ${label}'s adapter drives it` };
      if (u.identity !== undefined) {
        const out = await runCapture(path, [...u.identity.versionArgs], env, this.#opts.versionTimeoutMs ?? 10_000).catch(() => undefined);
        if (out === undefined || !new RegExp(u.identity.versionPattern, "m").test(out.trim())) {
          return { ok: false, found: true, reason: `${path} doesn't answer ${u.identity.versionArgs.join(" ")} as ${u.program} does` };
        }
      }
      set[u.env] = path;
    }
    return { ok: true, env: set };
  }

  async adapterOffer(): Promise<AdapterOffer | undefined> {
    const a = this.#opts.adapter;
    const store = this.#opts.adapters;
    if (a === undefined || store === undefined) return undefined;
    // A copy that is there and whole needs nothing; one that was changed is fetched afresh (behind the card again).
    const there = store.verify(a);
    if (there.ok) return undefined;
    const uses = await this.#usesOf(a, this.#env());
    // An agent whose own program isn't here gets no download: `detect` says what is missing.
    if (!uses.ok) return undefined;
    // The person said no and their own adapter works: they are not asked again until MOSS restarts.
    if (this.#adapterNote !== undefined && "declined" in this.#adapterNote) {
      const own = await this.#detectOwn();
      if (own.installed && own.identityOk) return undefined;
    }
    const st = store.status(a);
    return store.offerOf(a, st.state === "changed" ? `the copy MOSS kept ${st.why}` : undefined);
  }

  /** What the start will be once the adapter is placed: the same version, sandbox and run file `detect` will then say. */
  async adapterStart(): Promise<AdapterStartFacts | undefined> {
    const a = this.#opts.adapter;
    const store = this.#opts.adapters;
    if (a === undefined || store === undefined) return undefined;
    try {
      (this.#opts.runtime ?? (() => { throw new Error("MOSS has no runtime for it here"); }))();
    } catch {
      return undefined; // `detect` says why it can't start
    }
    const f = this.#providedFacts(a);
    return { path: store.entryOf(a), version: a.version, versionOk: f.versionOk, sandboxed: f.sandboxed, pin: adapterPin(a) };
  }

  async provideAdapter(): Promise<AdapterPlaced> {
    const a = this.#opts.adapter;
    const store = this.#opts.adapters;
    if (a === undefined || store === undefined) throw new ContractError("not_installed", `${this.id} has no adapter for MOSS to provide`);
    const ready = await store.ensure(a);
    this.#usesSeen.clear();
    // The whole copy, checked now: what a yes for the start is bound to is exactly this one.
    const whole = store.verify(a);
    if (!whole.ok) throw new ContractError("failed", `${a.package} ${a.version} was placed but ${whole.why}, so it won't be run`);
    if (whole.digest !== ready.digest) throw new ContractError("failed", `${a.package} ${a.version}'s copy isn't the one that was placed, so it won't be run`);
    return { path: ready.entry, version: a.version, digest: whole.digest };
  }

  noteAdapter(outcome: { declined: true } | { failed: string } | { ok: true }): void {
    this.#adapterNote = "ok" in outcome ? undefined : outcome;
  }

  async #detectOwn(): Promise<AgentDetection> {
    const cmd = this.command();
    const none = { installed: false, identityOk: false, versionOk: false, sandboxed: false };
    if (!cmd) return { ...none, reason: `${this.id} has no command for this OS` };
    const env = this.#env();
    const path = resolveProgram(cmd.program, env["PATH"] ?? env["Path"]);
    if (!path) return { ...none, reason: `${cmd.program} isn't installed on this computer` };
    const id = this.quirks.launch.identity;
    const out = await runCapture(path, [...(cmd.prefixArgs ?? []), ...id.versionArgs], env, this.#opts.versionTimeoutMs ?? 10_000).catch(() => undefined);
    const m = out === undefined ? null : new RegExp(id.versionPattern, "m").exec(out.trim());
    const version = m ? (m[1] ?? m[0]).trim() : undefined;
    let identityOk = m !== null;
    let reason: string | undefined = identityOk ? undefined : `${path} doesn't answer ${id.versionArgs.join(" ")} as ${this.id} does`;
    if (identityOk && id.signer && (this.#opts.os ?? currentOs()) === "macos") {
      if (!(await signedByTeam(path, id.signer))) {
        identityOk = false;
        reason = `${path} isn't signed by ${this.id}'s publisher, or its signature doesn't verify`;
      }
    }
    const versionOk = version !== undefined && versionSatisfies(version, this.quirks.launch.versions);
    const sandbox = this.admission(version);
    return {
      installed: true, path, ...(version === undefined ? {} : { version }), identityOk, versionOk,
      sandboxed: sandbox.status === "protected",
      reason: reason ?? (!versionOk ? `version ${version ?? "unknown"} is outside the tested range ${this.quirks.launch.versions}` : sandbox.status === "protected" ? sandbox.evidence : `no sandbox: ${sandbox.reason}`),
    };
  }

  /** This backend's sandbox on this OS at this version (S8). */
  admission(version: string | undefined): SandboxAdmission {
    return admissionFor(this.#opts.admissions ?? ADMISSIONS, this.id, this.#opts.os ?? currentOs(), version);
  }

  /** The plugins' parts placed again for a running session (a plugin turned on, off, removed or updated): the
   *  session's own placed folder is written afresh, so what was turned off or removed is gone from it. Only a backend
   *  that reads its own folders places anything. */
  placeAgain(_sessionId: string, parts: PluginParts, dir: string): void {
    if (!this.#opts.place) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#opts.place(parts, { dir });
  }

  async start(spec: AcpStartSpec): Promise<AcpAgentSession> {
    const mark = spec.mark ?? (() => {});
    const d = spec.detected ?? await this.detect();
    mark("backend.detect");
    if (!d.installed || !d.path) throw new ContractError("not_installed", d.reason ?? `${this.id} isn't installed on this computer`);
    if (!d.identityOk) throw new ContractError("refused", d.reason ?? `${d.path} isn't ${this.id}'s program`);
    // An adapter MOSS provides: the whole copy is checked against what MOSS placed, now, before it runs.
    const adapter = this.#opts.adapter;
    const provided = adapter !== undefined && this.#opts.adapters !== undefined && d.path === this.#opts.adapters.entryOf(adapter);
    let digest = d.sha256;
    if (provided) {
      const v = this.#opts.adapters!.verify(adapter!);
      if (!v.ok) throw new ContractError("refused", `${this.id} wasn't started: its adapter changed after MOSS placed it (${v.why}), so it won't be run`);
      digest = v.digest;
      mark("backend.verify");
    }
    // The program MOSS admitted, not another one that took its place since (K-M2 review 5).
    if (spec.admitted) {
      const a = spec.admitted;
      if (d.path !== a.path || d.version !== a.version || (a.sha256 !== undefined && (digest ?? await programHash(d.path)) !== a.sha256)) {
        throw new ContractError("refused", `${this.id} wasn't started: its program changed after it was checked`);
      }
      mark("backend.program-check");
    }
    if (!this.quirks.mcp.transports.includes("stdio")) throw new ContractError("refused", `${this.id} takes no stdio MCP server, so the bridge can't reach it`);
    const readOnly = spec.readOnly === true && this.quirks.marks.includes("unasked-actions");
    if (readOnly && !this.#opts.readOnlyMode) throw new ContractError("refused", `${this.id} acts without asking and has no read-only mode, so it can't start at read-only`);
    const cmd = this.command()!;
    const wire = this.#opts.wire?.(spec.sessionId) ?? {};
    // The fenced set, in the backend's own format, where its sandbox is admitted.
    const sandbox = this.admission(d.version);
    let setup: ReturnType<Extract<SandboxAdmission, { status: "protected" }>["writer"]> = {};
    if (sandbox.status === "protected") {
      const dir = wire.setupDir ?? this.#opts.setupDir?.(spec.sessionId);
      if (!dir) throw new ContractError("refused", `${this.id}'s sandbox needs a setup folder`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      setup = sandbox.writer(spec.fence, { root: spec.root, dir, home: homedir(), env: this.#env(), ...(spec.level ? { level: spec.level } : {}) });
      for (const f of setup.files ?? []) writeFileSync(join(dir, f.name), f.content, { mode: 0o600 });
    }
    mark("backend.sandbox-setup");
    // The plugins' skills, agents and hooks, where this backend reads its own.
    const parts = wire.parts;
    let placedMeta: Record<string, unknown> | undefined;
    if (this.#opts.place && parts && (parts.skills.length + parts.agents.length + parts.hooks.length) > 0) {
      const dir = wire.setupDir ?? this.#opts.setupDir?.(spec.sessionId);
      if (dir) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        placedMeta = this.#opts.place(parts, { dir }).meta;
      }
    }
    const meta = setup.meta || placedMeta ? mergeObjects(setup.meta ?? {}, placedMeta ?? {}) : undefined;
    // Windows: every agent runs in its own job object (lane C's), or not at all.
    let job: AgentJobLike | undefined;
    if ((this.#opts.os ?? currentOs()) === "windows") {
      job = (this.#opts.makeJob ?? (() => AgentJob.create()))() ?? undefined;
      if (!job) throw new ContractError("refused", `${this.id} wasn't started: Windows wouldn't make a job object to hold it`);
    }
    // MOSS's own Bun runs the adapter's run file, with the person's own program handed in its variable.
    let command = d.path;
    let prefix: readonly string[] = cmd.prefixArgs ?? [];
    let usesEnv: Record<string, string> = {};
    if (provided) {
      try {
        command = (this.#opts.runtime ?? (() => { throw new Error("MOSS has no runtime for it here"); }))();
      } catch (err) {
        throw new ContractError("refused", `${this.id} wasn't started: MOSS's own runtime can't start its adapter (${err instanceof Error ? err.message : String(err)})`);
      }
      prefix = [...ADAPTER_BUN_FLAGS(this.#opts.adapters!.bunfig()), d.path];
      const uses = await this.#usesOf(adapter!, this.#env());
      if (!uses.ok) throw new ContractError("not_installed", `${this.id} wasn't started: ${uses.reason}`);
      usesEnv = uses.env;
    }
    mark("backend.place+uses");
    const proc = launchContained({
      command,
      args: [...prefix, ...cmd.acpArgs, ...(setup.args ?? [])],
      cwd: spec.root,
      env: { ...this.#env(), ...usesEnv, ...(setup.env ?? {}) },
      ...(wire.stderr ? { onStderr: wire.stderr } : {}),
    }, { ...(this.#opts.table ? { table: this.#opts.table } : {}), ...(job ? { job } : {}) });
    if (!proc.contained) throw new ContractError("refused", `${this.id} wasn't started: it couldn't be put in its job object`);
    if (proc.pid) wire.launched?.(proc.pid, proc.contains);
    void proc.exited.then(() => wire.exited?.(proc.pid));
    mark("backend.spawn");
    return AcpAgentSession.open({
      ...(spec.mark ? { mark: spec.mark } : {}),
      quirks: this.quirks,
      clock: this.#opts.clock,
      process: proc,
      cwd: spec.root,
      mcpServers: [stdioServerOf(spec.bridge)],
      ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
      ...(meta ? { meta } : {}),
      ...(spec.reattach === undefined ? {} : { reattach: spec.reattach }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      ...(wire.tap ? { tap: wire.tap } : {}),
      ...(this.#opts.clientInfo ? { clientInfo: this.#opts.clientInfo } : {}),
      selections: { keeper: this.#selections, backend: this.id },
      ...(this.#opts.readOnlyMode ? { readOnlyMode: this.#opts.readOnlyMode } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(setup.modeFloor ? { modeFloor: setup.modeFloor, ...(spec.level ? { level: spec.level } : {}) } : {}),
      ...(this.#opts.modeConfirmMs === undefined ? {} : { modeConfirmMs: this.#opts.modeConfirmMs }),
      ...(this.#opts.startTimeoutMs === undefined ? {} : { startTimeoutMs: this.#opts.startTimeoutMs }),
    });
  }
}

function mergeObjects(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = v && cur && typeof v === "object" && typeof cur === "object" && !Array.isArray(v) && !Array.isArray(cur) ? mergeObjects(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

/** The bridge as `session/new` takes it: its token only in `env` (S5 edit 4). */
export function stdioServerOf(b: BridgeServer): StdioMcpServer {
  return { name: b.name, command: b.command, args: [...b.args], env: Object.entries(b.env).map(([name, value]) => ({ name, value })) };
}

/** A program's real path: as given when it has a separator, else the first match on PATH. */
export function resolveProgram(program: string, pathVar: string | undefined): string | undefined {
  const found = /[\\/]/.test(program) ? program : Bun.which(program, { PATH: pathVar ?? "" });
  if (!found) return undefined;
  try {
    return realpathSync(found);
  } catch {
    return undefined;
  }
}

/** Runs `cmd` and gives its stdout (64 KiB at most): an agent's version probe. Exported for the spawn-note test. */
export function runCapture(cmd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let plan: ReturnType<typeof spawnPlan>;
    try {
      plan = spawnPlan(cmd, args);
    } catch (e) {
      reject(e);
      return;
    }
    const child = spawn(plan.file, plan.args, { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, windowsVerbatimArguments: plan.verbatim });
    noteSpawned(child.pid, child); // C-M1: an agent's version probe is never the user
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (out.length < 64 * 1024) out += c;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out"));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** macOS: whether the signature verifies (`--strict`) and its leaf certificate is the team's, an Apple-issued one. */
async function signedByTeam(path: string, team: string): Promise<boolean> {
  if (!/^[A-Z0-9]{10}$/.test(team)) return false;
  const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
  return new Promise<boolean>((resolve) => {
    const c = spawn("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, path], { stdio: "ignore", windowsHide: true });
    c.on("close", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}
