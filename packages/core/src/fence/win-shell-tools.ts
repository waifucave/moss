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
// What these don't do that the runtime's Bash does on macOS and Linux (reported, not hidden): `run_in_background`
// (refused with the reason), Monitor and KillShell over them, the working folder carried from one call to the next
// (each call starts in the session's folder), and output streamed while the command runs (it comes at the end).
import { win32 } from "node:path";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { Caller } from "@waifucave/moss-protocol";
import type { CoreToolDef, CoreToolResult } from "../runtime-sdk/turn-loop/servers";
import type { FencedSpawner } from "./spawn";

/** How long a call runs when it doesn't say, and the longest it may ask for (Claude Code's limits). */
export const WIN_SHELL_DEFAULT_TIMEOUT_MS = 120_000;
export const WIN_SHELL_MAX_TIMEOUT_MS = 600_000;

/** The tools' input, as the runtime's Bash and PowerShell take it. */
const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command to run" },
    timeout: { type: "number", description: `Optional timeout in milliseconds (max ${WIN_SHELL_MAX_TIMEOUT_MS})` },
    description: { type: "string", description: "A short description of what the command does" },
    run_in_background: { type: "boolean", description: "Not available on Windows yet: a command runs in the foreground" },
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
}

/** Rule E, a command outside the sandbox on Windows: still a pool principal (there is no fenced way to run as the
 *  user), but its writes are the user's home and temp folder (`allowWrite` of the fence at its widest) instead of the
 *  level's, while every deny of the session's sandbox stays (the escape floor: the fenced set is never written, the
 *  MOSS home included) and the network stays closed (the principal's filters don't open for one command). */
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
      if (i.run_in_background === true) return { text: `${name}: a background command isn't available on Windows yet; run it in the foreground`, isError: true };
      const escape = i.dangerouslyDisableSandbox === true;
      // Rule E: only a bot's own conversation's command leaves the sandbox, and only past its card (the driver's
      // PreToolUse hook sends it there); anywhere else the flag is refused, whatever it says.
      if (escape && o.kind !== "bot") return { text: `${name}: this session's commands never leave the sandbox`, isError: true };
      const asked = typeof i.timeout === "number" && Number.isFinite(i.timeout) && i.timeout > 0 ? Math.floor(i.timeout) : WIN_SHELL_DEFAULT_TIMEOUT_MS;
      const base = o.sandbox();
      const sandbox = escape ? escapedSandbox(base, o) : base;
      const cwd = o.cwd();
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
  return [
    tool("Bash", "bash", "Run a bash command (Git for Windows' bash) in MOSS's sandbox on this Windows computer. It writes only the folders the sandbox allows, reaches no network, and starts in the session's folder each time."),
    tool("PowerShell", "powershell", "Run a Windows PowerShell command in MOSS's sandbox on this computer. It writes only the folders the sandbox allows, reaches no network, and starts in the session's folder each time."),
  ];
}
