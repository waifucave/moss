// A bot's Bash and PowerShell on Windows (spec §4: "Git for Windows' bash plus a PowerShell tool, as Claude Code does",
// both under the same fence as on the Mac). The agent runtime has no Windows sandbox (its Bash refuses every command
// there, and its PowerShell is a stub), so on Windows the core serves both tools itself under their plain names,
// shadowing the runtime's (`shadowBuiltins`: the driver leaves them out of `tools`). Each call runs through the fenced
// spawner's Windows leg (`win-fenced.ts`), held to the very sandbox settings the runtime's Seatbelt or bubblewrap get
// on macOS and Linux (`botSandboxSettings` through the driver's `botSandbox`), so the three OSes keep one seam.
//
// The approval is unchanged: the names are Bash and PowerShell, which the bot check classifies as commands (they are
// not among the daemon's `hostTools`), and the driver's own PreToolUse hook sends every call that asks to leave the
// sandbox to its sealed card. What runs is decided here, by the session (rule E below), never by the input flag alone.
//
// Rule B, a background command (`run_in_background`, lane WS7; spec §6.7: background commands stay core, and "a daemon
// restart stops ... background commands"): the same fenced run as a foreground one, not awaited. It holds its pool
// account's lease and its plan for as long as it lives (the spawner's own run), so `sandbox remove` ends it as it ends
// any command, and the engine's exit ends it (the launcher's kill-on-close job). Its output is written as it comes to a
// log in the session's folder (`.moss-background/<id>.log`, capped), the call answers at once with the task's id and
// that path, `TaskStop` with the id stops it (`stopWindowsBackground`), and its end comes back to the conversation as a
// background task's notification (`wake`). At most `WIN_SHELL_BACKGROUND_PER_SESSION` run at once in one session (the
// pool is shared by every session), each for at most `WIN_SHELL_BACKGROUND_MAX_MS`; a command outside the sandbox
// never runs in the background (the approval check refuses that pair before any card, and so does this tool).
//
// What these don't do that the runtime's Bash does on macOS and Linux (reported, not hidden): Monitor and the runtime's
// TaskOutput over them (the bot reads the log with Read), and the working folder carried from one call to the next
// (each call starts in the session's folder).
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { Caller } from "@waifucave/moss-protocol";
import type { CoreToolDef, CoreToolResult } from "../runtime-sdk/turn-loop/servers";
import type { FencedSpawner } from "./spawn";

/** How long a call runs when it doesn't say, and the longest it may ask for (Claude Code's limits). */
export const WIN_SHELL_DEFAULT_TIMEOUT_MS = 120_000;
export const WIN_SHELL_MAX_TIMEOUT_MS = 600_000;

/** Rule B's bounds: running background commands per session, how long one may run, and how much of its output the
 *  log keeps (past it, one line says the rest was dropped). */
export const WIN_SHELL_BACKGROUND_PER_SESSION = 2;
export const WIN_SHELL_BACKGROUND_MAX_MS = 24 * 3_600_000;
export const WIN_SHELL_BACKGROUND_LOG_CAP = 64 * 1024 * 1024;

/** A running background command (rule B). */
interface BackgroundTask {
  readonly id: string;
  readonly session: string;
  readonly log: string;
  readonly abort: AbortController;
  readonly ended: Promise<void>;
}
/** Every running background command of this engine, by id. */
const background = new Map<string, BackgroundTask>();

/** `TaskStop` for a Windows background command: the session's own only (never another session's, whatever the id).
 *  Ends it and everything it started, and waits for its end to be recorded; null when the id names none of them. */
export async function stopWindowsBackground(session: string, id: string): Promise<CoreToolResult | null> {
  const t = background.get(id);
  if (t === undefined || t.session !== session) return null;
  t.abort.abort();
  await t.ended;
  return { text: `Stopped ${id}. Its output is in ${t.log}.`, isError: false };
}

/** The ids of a session's running background commands. */
export function windowsBackgroundOf(session: string): string[] {
  return [...background.values()].filter((t) => t.session === session).map((t) => t.id);
}

/** The tools' input, as the runtime's Bash and PowerShell take it. */
const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command to run" },
    timeout: { type: "number", description: `Optional timeout in milliseconds (max ${WIN_SHELL_MAX_TIMEOUT_MS})` },
    description: { type: "string", description: "A short description of what the command does" },
    run_in_background: { type: "boolean", description: "Run the command in the background: the call answers at once with its task id and a log file to Read; you are told when it ends, and TaskStop stops it" },
    dangerouslyDisableSandbox: { type: "boolean", description: "Ask the user, on a card, to run this one command outside the sandbox's folder limits" },
  },
  required: ["command"],
  additionalProperties: false,
};

/** One session's Bash and PowerShell. */
export interface WindowsShellToolsOptions {
  readonly spawner: FencedSpawner;
  readonly caller: Extract<Caller, { kind: "session" }>;
  /** A bot's own conversation (`kind: "bot"`), the only session whose command may leave the sandbox after the user's
   *  yes on its card; a side thread's never does (the driver's `BOT_SANDBOX` against `BOT_CONVERSATION_SANDBOX`). */
  readonly kind: "bot" | "side-thread";
  /** The session's working folder: every call starts there. */
  readonly cwd: () => string;
  /** The sandbox settings the runtime is given for this session now (the driver's `botSandbox(…)` of the host's). */
  readonly sandbox: () => SandboxSettingsConfig;
  /** For a command the user let out (rule E): the user's home and temp folder, and the MOSS home, which stays denied. */
  readonly userHome: string;
  readonly temp: string;
  readonly mossHome: string;
  /** Rule B: a background command's end, as the session's background-task notification (`BotSessionContext.wake`).
   *  Without it no command runs in the background (refused with the reason). */
  readonly wake?: (input: { task: string; status: "completed" | "failed" | "stopped"; text: string }) => Promise<unknown>;
}

/** Rule E, a command outside the sandbox on Windows: still a sandbox principal (there is no fenced way to run as the
 *  user), but its writes are the user's home and temp folder (`allowWrite` of the fence at its widest) instead of the
 *  level's, while every deny of the session's sandbox stays (the escape floor: the fenced set is never written, the
 *  MOSS home included). It runs as the escape account (`FencedRun.network`, `escapeMember`), which reaches the network
 *  but the cloud metadata address (srt-win patch 0003; the controller's ruling: as the spec and the Mac give it); no
 *  command in the sandbox ever runs as that account. */
export function escapedSandbox(s: SandboxSettingsConfig, o: { userHome: string; temp: string; mossHome: string }): SandboxSettingsConfig {
  const f = s.filesystem ?? {};
  return {
    ...s,
    filesystem: {
      ...f,
      allowWrite: [...new Set([...(f.allowWrite ?? []), o.userHome, o.temp])],
      denyWrite: [...new Set([...(f.denyWrite ?? []), o.mossHome])],
    },
  };
}

/** What the model reads of a finished command. */
function resultText(r: { stdout: string; stderr: string; code?: number | null; timedOut?: boolean }): string {
  const parts = [r.stdout.replace(/\s+$/, ""), r.stderr.replace(/\s+$/, "")].filter((s) => s.length > 0);
  if (r.timedOut) parts.push("Command timed out");
  else if (r.code !== undefined && r.code !== null && r.code !== 0) parts.push(`Exit code ${r.code}`);
  return parts.length === 0 ? "(no output)" : parts.join("\n");
}

/** The two tools, for a session on Windows. */
export function windowsShellTools(o: WindowsShellToolsOptions): CoreToolDef[] {
  const tool = (name: "Bash" | "PowerShell", shell: "bash" | "powershell", description: string): CoreToolDef => ({
    name,
    description,
    inputSchema: INPUT_SCHEMA,
    async run(input: unknown, extra?: { signal?: AbortSignal }): Promise<CoreToolResult> {
      const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
      if (typeof i.command !== "string" || i.command.trim() === "") return { text: `${name}: no command`, isError: true };
      const escape = i.dangerouslyDisableSandbox === true;
      const inBackground = i.run_in_background === true;
      if (inBackground && escape) return { text: `${name}: a command outside the sandbox runs in the foreground; run it without run_in_background`, isError: true };
      if (inBackground && o.wake === undefined) return { text: `${name}: this session can't be told when a background command ends; run it in the foreground`, isError: true };
      if (inBackground && windowsBackgroundOf(o.caller.sessionId).length >= WIN_SHELL_BACKGROUND_PER_SESSION) {
        return { text: `${name}: ${WIN_SHELL_BACKGROUND_PER_SESSION} background commands of this conversation are running already; stop one (TaskStop) or wait for one to end`, isError: true };
      }
      // Rule E: only a bot's own conversation's command leaves the sandbox, and only past its card (the driver's
      // PreToolUse hook sends it there); anywhere else the flag is refused, whatever it says.
      if (escape && o.kind !== "bot") return { text: `${name}: this session's commands never leave the sandbox`, isError: true };
      const asked = typeof i.timeout === "number" && Number.isFinite(i.timeout) && i.timeout > 0 ? Math.floor(i.timeout) : WIN_SHELL_DEFAULT_TIMEOUT_MS;
      const base = o.sandbox();
      const sandbox = escape ? escapedSandbox(base, o) : base;
      const cwd = o.cwd();
      if (inBackground) return startBackground(name, shell, i.command, cwd, sandbox);
      const r = await o.spawner.run({
        command: i.command, cwd, env: { TMPDIR: win32.normalize(cwd) }, timeoutMs: Math.min(asked, WIN_SHELL_MAX_TIMEOUT_MS),
        who: { caller: o.caller }, shell, sandbox,
        // Rule E: the approved escape runs as the escape account, with the network (the controller's ruling).
        ...(escape ? { network: true } : {}),
        // The runtime's abort of this call (a stop, a pause): it ends the command and everything it started at once
        // (`runCommand` kills the broker, whose kill-on-close job takes the rest), never waiting for the time limit.
        ...(extra?.signal === undefined ? {} : { signal: extra.signal }),
      });
      if (r.kind === "refused") return { text: `${name} was refused: ${r.reason}`, isError: true };
      if (extra?.signal?.aborted === true) return { text: `${name}: stopped`, isError: true };
      if (r.kind === "timeout") return { text: resultText({ ...r, timedOut: true }), isError: true };
      return { text: resultText(r), isError: r.code !== 0 };
    },
  });
  /** Rule B: start a background command and answer at once (or with the refusal, when it comes within a second). */
  const startBackground = async (name: string, shell: "bash" | "powershell", command: string, cwd: string, sandbox: SandboxSettingsConfig): Promise<CoreToolResult> => {
    const id = `win_bg_${randomBytes(4).toString("hex")}`;
    const dir = join(cwd, ".moss-background");
    const log = join(dir, `${id}.log`);
    try { mkdirSync(dir, { recursive: true }); writeFileSync(log, ""); } catch (e) {
      return { text: `${name}: the background command's log couldn't be made (${(e as Error).message})`, isError: true };
    }
    let written = 0;
    let dropped = false;
    const onOutput = (text: string) => {
      if (dropped) return;
      const bytes = Buffer.byteLength(text);
      if (written + bytes > WIN_SHELL_BACKGROUND_LOG_CAP) {
        dropped = true;
        try { appendFileSync(log, `\n[moss: the log reached ${WIN_SHELL_BACKGROUND_LOG_CAP / 1048576} MB; later output is dropped]\n`); } catch { /* gone */ }
        return;
      }
      written += bytes;
      try { appendFileSync(log, text); } catch { /* the folder went away */ }
    };
    const abort = new AbortController();
    const run = o.spawner.run({
      command, cwd, env: { TMPDIR: win32.normalize(cwd) }, timeoutMs: WIN_SHELL_BACKGROUND_MAX_MS,
      who: { caller: o.caller }, shell, sandbox, signal: abort.signal, onOutput: (t) => onOutput(t),
    });
    let settle!: () => void;
    const ended = new Promise<void>((res) => { settle = res; });
    background.set(id, { id, session: o.caller.sessionId, log, abort, ended });
    const finished = run.then(async (r) => {
      const status: "completed" | "failed" | "stopped" = abort.signal.aborted ? "stopped" : r.kind === "exited" && r.code === 0 ? "completed" : "failed";
      const how = r.kind === "refused" ? `was refused: ${r.reason}` : abort.signal.aborted ? "was stopped" : r.kind === "timeout" ? `ran past ${WIN_SHELL_BACKGROUND_MAX_MS / 3_600_000} hours and was ended` : `exited with code ${r.code}`;
      try { appendFileSync(log, `\n[moss: the command ${how}]\n`); } catch { /* gone */ }
      background.delete(id);
      settle();
      const tail = r.kind === "refused" ? "" : resultText(r).slice(-2_000);
      const text = `Background ${name} command ${id} ${how}. Its whole output is in ${log}.${tail === "" ? "" : `\nThe end of its output:\n${tail}`}`;
      try { await o.wake?.({ task: id, status, text }); } catch { /* the session is gone */ }
      return { r, how };
    });
    // A refusal that comes at once (no setup, a launcher that isn't there) is the call's answer; a later one (a pool
    // still busy past its wait) comes back as the task's notification.
    const early = await Promise.race([finished, Bun.sleep(1_000).then(() => null)]);
    if (early !== null && early.r.kind === "refused") return { text: `${name} was refused: ${early.r.reason}`, isError: true };
    return { text: `Command running in the background with ID: ${id}. Its output is being written to ${log} (read it with Read). You will be told when it ends; TaskStop with this id stops it.`, isError: false };
  };
  return [
    tool("Bash", "bash", "Run a bash command (Git for Windows' bash) in MOSS's sandbox on this Windows computer. It writes only the folders the sandbox allows, reaches no network (a command the user approves to leave the sandbox does), and starts in the session's folder each time."),
    tool("PowerShell", "powershell", "Run a Windows PowerShell command in MOSS's sandbox on this computer. It writes only the folders the sandbox allows, reaches no network (a command the user approves to leave the sandbox does), and starts in the session's folder each time."),
  ];
}
