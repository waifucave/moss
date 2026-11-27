// The bot driver (plan §4 A, M3 "the turn loop"; spec §6.1, §6.3, §6.4, §6.7): lane D's `SessionDriver` for a bot's
// conversation and its side threads, over the embedded agent runtime (one Bun Worker per session, `embedded.ts`).
// Owner: lane A. Lane D's `BotService` gets one per session from `botDriverFactory` (its `DriverFactory`).
//
// * **One runtime per session, kept between turns.** The session's input is a host prompt queue: each turn pushes the
//   message that starts it, and what folds in is pushed while the turn runs, so the runtime takes it after its next
//   tool call (agent SDK 0.0.44's fold, `fold.ts`). A push the runtime didn't fold before its turn ended runs as the
//   runtime's next turn, which the same host turn covers: the host turn ends once every push has been answered.
// * **The transcript is the runtime's own,** under the MOSS home, keyed by a backend id this driver keeps in
//   `<home>/sessions-runtime/<session>.json`; a new runtime (a restart, a rebuild) resumes it.
// * **The harness owns the system prompt** (prompt.ts): rebuilt at the first turn, after every compaction, and when the
//   cached prompt has expired (`cacheCold()`), each time by resuming the transcript under the new prompt. MCP servers
//   that change in between reach the conversation as a note at the next turn.
// * **The user's interrupt** stops the step at once: the runtime's turn is interrupted (its model call cancelled, a
//   running tool call cancelled and recorded interrupted), and what was pushed to fold but not yet taken is cleared
//   and carried into the next turn, ahead of the user's message.
// * **Before each tool call** the driver asks `mayAct()` (§6.4 fencing, §9.2 pause): while the pause switch holds the
//   session the call waits (`whenMayAct`), and once this computer stops running the bots it is refused. Then the
//   plugins' `tool.before` hooks run, then the approval check (`canUseTool`), then the call; `tool.after` after it.
// * **After each tool call** the next request waits while the pause holds (`PostToolUse`): the call is never cut off.
// * **Before each model turn** too (the runtime's `UserPromptSubmit`): a turn the runtime starts on its own, when a
//   background task finishes or is stopped and its notification comes in, waits while the pause holds the session, as
//   does an input about to fold in; the turn starts once the user resumes, and never on a computer that stopped
//   running the bot.
// * **The pause stops background work** (the owner's rule: the pause stops everything): once the switch says no, the
//   session's background shells and monitors are stopped through the runtime (`Query.stopTask`, by the host). Resuming
//   doesn't restart them; the runtime's own notification of each stop reaches the model once the user resumes.
// * **At each turn's end** the session lets go of its holds on every computer's screen (J's `releaseSession`); at the
//   session's end its terminals close (J's `TerminalRouter.closeSession`).
// * **Compaction:** `compact()` on the host's word (lane D's cache-timed or forced compaction), and the runtime's own
//   when the context fills mid-turn, recorded as `compaction` records; either way the harness blocks rebuild next.
// * **Usage:** each turn's `usage` sums its requests; `contextTokens` is the runtime's `context_tokens`, the last
//   main-loop request's whole prompt, cache included (lane D's ask).
// * **Records** are the inherited session events, projected from the runtime's frames by the core's projector: tool
//   calls and results, the reply, thinking and the streaming deltas (which the host never logs).
import { runtimeStderrSink } from "./runtime-stderr";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { reservedMcpServerNames } from "../../capabilities/names";
import { query as sdkQuery, requireBrand, type CanUseTool, type HookCallbackMatcher, type McpServerConfig, type Options, type Query, type SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { Caller, Level, Os, TurnOrigin } from "@waifucave/moss-protocol";
import { strictestLevel } from "../../contracts/approval-broker";
import type { Unsubscribe } from "../../contracts/common";
import type { SessionDriver, TurnControl, TurnEnd, TurnInput } from "../../contracts/session-host";
import type { BotSessionContext } from "../../bots/service";
import { writeJsonAtomic } from "../../sessions/atomic-file";
import { createProjector, type Projector } from "../../projector";
import { ToolDisplays } from "../tool-display";
import { ToolApps, type AppSite, type McpAppsService } from "../../mcp-apps/service";
import type { UiResourceContent } from "../../mcp-apps/resource";
import { hostInputFoldedCount } from "../fold";
import { createHostPromptQueue, type HostPromptQueue } from "../prompt-queue";
import { testProviderNameFor } from "../provider-selection";
import { modelProviderKey } from "../model-plugins";
import { mossSessions } from "../sessions";
import { NO_HOOKS, turnOutcomeOf, type HookSession, type TurnHooks } from "./hooks";
import { harnessPrompt, mcpChangesSince, mcpFingerprint, type PromptComputer, type PromptMcpServer } from "./prompt";
import { coreToolsServer, routedMcpServer, type BotMcpServer, type CallIds, type CoreToolDef, type McpRunner } from "./servers";
import { formatTurnInput, TASK_NOTIFICATION_FRAME } from "./input";
import { botPageCalls, type PageCallDoors } from "./page-calls";
import { embeddedSessionOptions, fillProvider } from "./embedded-session";
import { mergedHooks } from "./hook-merge";
import { NAMESPACE_RE } from "@waifucave/moss-plugin-sdk";
import { GLOSSARY_TOOL_NAME, glossaryTool, type GlossaryDeps } from "./glossary";
import { partsServe } from "./only-backends";
import { MISPLACED_SANDBOX_FLAG_REFUSAL, misplacedSandboxFlag, outsideSandboxFlagOf, windowsFileToolInput } from "../../approvals/bot-check";
import { BOT_KEY_PATHS, RUNTIME_STATE_STORES, RUNTIME_STATE_SUFFIXES, fenceSearchOutput, fileToolFenceRefusal, type FileFence } from "./file-fence";
import { secretReadPlaces, type Fence } from "../../contracts/fence";
import { runtimeDenyForms } from "../../fence/runtime-deny-forms";
import { leftOutRoots, type LeftOutRoot } from "../../fence/sandbox-settings";
import { TreeRouter, type TreeRoute, type TreeRouteDeps } from "../../tree/route";
import type { TreeToolResult, TreeTools } from "../../tree/tools";

/** The runtime's built-in tools a bot's session is offered (spec §6.7). The runtime's own `SendMessage`, `ListAgents`,
 *  `TaskStop` and `Agent` are not: the core's take those names. Nor are `Skill` and `ToolSearch` (retired for
 *  `Glossary`), `NotebookEdit`, worktrees and plan mode (the coding agents'), or the web tools (the web plugin's). */
export const BOT_BUILTIN_TOOLS: readonly string[] = [
  // On Windows the core serves Bash and PowerShell itself (`fence/win-shell-tools.ts`, the daemon's core tools): the
  // runtime has no Windows sandbox, so its own are left out here and the core's plain names take theirs.
  ...(process.platform === "win32" ? [] : ["Bash"]), "Read", "Write", "Edit", "Glob", "Grep", "AskUserQuestion",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "Monitor",
  "ListMcpResourcesTool", "ReadMcpResourceTool",
];

/** What the runtime was given of the plugins' servers: each server's name and each of its tools with how it loads. A tool turned
 *  off, preloaded or put behind `Glossary` by the user's tool setting (§6.7) changes it, so the next turn opens the runtime
 *  again with the list as it is now (the agent SDK takes `mcpServers` only when a runtime opens). */
function serversSignature(servers: readonly BotMcpServer[]): string {
  return ["moss_core", ...servers.filter((s) => s.server !== "moss_core").map((s) => `${s.server}\u0001${s.tools.map((t) => `${t.name}:${t.load ?? "on-demand"}`).sort().join("\u0002")}`)].sort().join("\u0000");
}

/** The built-ins that start on-demand (§6.7 [D]), with what `Glossary` says of them. */
export const ON_DEMAND_BUILTINS: readonly { name: string; description: string }[] = [
  { name: "Glob", description: "Find files by name pattern (\"**/*.ts\"), anywhere in the folder tree; the search runs on the computer that holds the files." },
  { name: "Grep", description: "Search file contents with a regular expression, anywhere in the folder tree; the search runs on the computer that holds the files." },
];

/** The fields every hook and tool hook sees of a tool call. */
interface ToolUseInput { tool_name?: string; tool_input?: unknown; tool_use_id?: string; tool_response?: unknown }

/** What every bot's and agent's sandbox is, whatever the host gives: on, no unsandboxed command (a call's
 *  `dangerouslyDisableSandbox` is refused), and the paths to launchd closed (F8). Side threads, subagents and
 *  in-process agents never run a command unsandboxed (the owner's ruling). */
export const BOT_SANDBOX = { enabled: true, allowUnsandboxedCommands: false, denyLaunchServices: true } as const;

/** A bot-side session's sandbox (a bot, its side threads and routines, an in-process agent, MOSS's coding agent as a
 *  bot's child): the host's, with `BOT_SANDBOX` set last, and the runtime's file tools held to the same write roots as
 *  the shell (agent SDK 0.0.77's `filesystem.enforceWriteRootsInFileTools`: a Write, Edit or NotebookEdit outside them
 *  runs only on a `canUseTool` allow of that exact, link-free path; a hard-linked file is refused). Hard-link writes
 *  are never allowed here, whatever the host's settings say. Its deny lists go to the runtime spelled so that none can
 *  make its file-tool check refuse every path (`runtimeDenyForms`: a secret place macOS keeps MOSS out of, or a name
 *  under a file), each still denying the same place; `userHome` names the user's secret places. */
export function botSandbox(sandbox: SandboxSettingsConfig, o: { userHome?: string; os?: Os } = {}): SandboxSettingsConfig {
  const { allowHardLinkWrites: _never, ...filesystem } = sandbox.filesystem ?? {};
  const os: Os = o.os ?? (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");
  const forms = (paths: readonly string[] | undefined) => runtimeDenyForms(paths ?? [], { os, ...(o.userHome === undefined ? {} : { userHome: o.userHome }) });
  return {
    ...sandbox,
    filesystem: {
      ...filesystem,
      ...(filesystem.denyRead === undefined ? {} : { denyRead: forms(filesystem.denyRead) }),
      ...(filesystem.denyWrite === undefined ? {} : { denyWrite: forms(filesystem.denyWrite) }),
      enforceWriteRootsInFileTools: true,
    },
    ...BOT_SANDBOX,
  };
}

/** A bot's own conversation with the user present: the same sandbox, except one command may leave it when the person
 *  approves it on its own card (lane C's outside-sandbox approval): the settings let the runtime honor a call's
 *  `dangerouslyDisableSandbox: true`, and the driver's PreToolUse hook plus the approval check card every such call
 *  before any allow rule or permission mode is consulted. Anything else keeps `BOT_SANDBOX`. */
export const BOT_CONVERSATION_SANDBOX = { ...BOT_SANDBOX, allowUnsandboxedCommands: true } as const;

/** What the driver's own PreToolUse hook answers a call carrying the run-outside-the-sandbox flag: `ask` for
 *  exactly `true` on a shell tool (the runtime handles a hook's ask before its own allow rules and permission mode,
 *  so the call always reaches the approval check and its card), `deny` for any other value present on one (never
 *  passed through unflagged), `deny` for the flag on any other tool but a plugin's or MCP server's (`mcp__…`: the
 *  field means nothing there), and nothing for a call that stays in the sandbox. */
export function outsideSandboxHookDecision(tool: string, input: unknown, o: { agentId?: string } = {}): { decision: "ask" | "deny"; reason: string } | undefined {
  if (misplacedSandboxFlag(tool, input)) {
    return { decision: "deny", reason: `${tool} was refused: ${MISPLACED_SANDBOX_FLAG_REFUSAL}.` };
  }
  const flag = outsideSandboxFlagOf(tool, input);
  if (flag === "off") return undefined;
  // A call made inside a subagent (the hook input's `agent_id`): its commands never leave the sandbox (spec: a subagent's
  // such call is refused with no card), whatever tool carries the flag.
  if (typeof o.agentId === "string" && o.agentId.length > 0) {
    return { decision: "deny", reason: `${tool} was refused: a subagent's commands always run in the sandbox; a command can't run outside it here. Run the command in the sandbox instead.` };
  }
  if (flag === "escape") {
    return { decision: "ask", reason: "This command asks to run outside the sandbox: the user approves each such command on its own card." };
  }
  return { decision: "deny", reason: "`dangerouslyDisableSandbox` must be either left out (to stay in the sandbox) or exactly true (to ask to leave it on a card); anything else is refused." };
}

/** The host's sandbox with the user's secret places (`SECRET_READ_PLACES`) in its `denyRead`, when the session's file
 *  fence knows the user's home: the runtime then refuses them to Read, leaves them out of Grep's and Glob's scans
 *  (index-q1vv1628.js: read.ts asserts the session sandbox's `denyRead`; grep.ts and glob.ts filter by it), and the
 *  sandboxed shell can't read them (Seatbelt `(deny file-read* …)`). */
export function withSecretReads(sandbox: SandboxSettingsConfig | undefined, fence: Pick<FileFence, "userHome" | "os"> | undefined): SandboxSettingsConfig {
  const base = sandbox ?? {};
  if (fence?.userHome === undefined) return base;
  const os = fence.os ?? (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");
  const places = secretReadPlaces(os, fence.userHome).map((p) => p.path);
  return { ...base, filesystem: { ...(base.filesystem ?? {}), denyRead: [...new Set([...(base.filesystem?.denyRead ?? []), ...places])] } };
}

/** The host's sandbox with the MOSS home's key places (`BOT_KEY_PATHS`: credentials, the runtimes, the runtime's
 *  checkpoint store and image copies, …) in its `denyRead` too, when the session's file fence knows the home: the
 *  sandboxed shell can't read them either, as the file tools can't (`botReadDenied`). */
export function withBotKeyReads(sandbox: SandboxSettingsConfig, fence: Pick<FileFence, "home"> | undefined): SandboxSettingsConfig {
  if (fence?.home === undefined) return sandbox;
  // The key places, and the runtime's per-session state files beside its transcripts (`RUNTIME_STATE_SUFFIXES`), by glob.
  const keys = [...BOT_KEY_PATHS.map((rel) => join(fence.home, ...rel)),
    ...RUNTIME_STATE_STORES.flatMap((rel) => RUNTIME_STATE_SUFFIXES.map((suffix) => join(fence.home, ...rel, "**", `*${suffix}`)))];
  return { ...sandbox, filesystem: { ...(sandbox.filesystem ?? {}), denyRead: [...new Set([...(sandbox.filesystem?.denyRead ?? []), ...keys])] } };
}

/** The daemon's fence for a bot's own Read, Glob and Grep: lane C's fence as the session meets it (`forCaller`), so
 *  inside the MOSS home only its own folders are readable (`fileToolFenceRefusal`). */
/** Lane XC: what another computer's tree call gave back, as the model reads a tool's result: the runtime's own shapes
 *  where there is one (Bash's output, Glob's paths one per line, Grep's `path:line:text`), the reason for an error. */
/** A refused write's words, as the shell and the sandbox say them. */
const WRITE_REFUSED = /Read-only file system|Operation not permitted|Permission denied|EROFS|EPERM|EACCES/;

/** A Bash result with the note on the roots the sandbox left out (Linux, lane XC 3c), when its output says a write was
 *  refused and some were; undefined otherwise. The note goes on its stderr (or after a plain text result). */
export function leftOutNote(response: unknown, leftOut: readonly { root: string; why: string }[]): unknown {
  if (leftOut.length === 0) return undefined;
  const text = typeof response === "string" ? response : response !== null && typeof response === "object" ? JSON.stringify(response) : "";
  if (!WRITE_REFUSED.test(text)) return undefined;
  const note = `[MOSS] Shell commands can't write ${leftOut.map((l) => `${l.root} (${l.why})`).join("; ")}. Use Write or Edit there, which ask when they need to.`;
  if (typeof response === "string") return `${response}\n${note}`;
  if (response === null || typeof response !== "object") return undefined;
  const r = response as Record<string, unknown>;
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  return { ...r, stderr: stderr === "" ? note : `${stderr.replace(/\n+$/, "")}\n${note}` };
}

/** The agent runtime's own line (0.0.89 and later, Linux) for the write roots its walk couldn't finish this command. */
const RUNTIME_DROPPED = /\[sandbox\] not writable this run, too large to check for protected paths[^\n]*?\):\s*([^\n]+)/;

/** A Bash result the runtime marked with the roots it dropped this command (on a big home, the largest folders): the
 *  same in plain words after it (the owner's ruling, 2026-11-27: the bot is told), so the bot knows to use Write or Edit
 *  there rather than retry. Undefined when the result has no such line. */
export function droppedRootsNote(response: unknown): unknown {
  const text = typeof response === "string" ? response : response !== null && typeof response === "object" ? String((response as Record<string, unknown>).stderr ?? "") : "";
  const m = RUNTIME_DROPPED.exec(text);
  if (m === null) return undefined;
  const roots = m[1]!.split(",").map((s) => s.trim()).filter((s) => s !== "").slice(0, 20);
  const shown = roots.map((r) => r.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 200)).join(", ");
  const note = `[MOSS] This computer's sandbox couldn't finish checking ${shown}${roots.length === 20 ? " (and more)" : ""} in time, so shell commands can't write there this time; Write and Edit still can.`;
  if (typeof response === "string") return `${response}\n${note}`;
  const r = response as Record<string, unknown>;
  return { ...r, stderr: `${String(r.stderr ?? "").replace(/\n+$/, "")}\n${note}` };
}

export function treeResultText(tool: string, output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || typeof output !== "object") return String(output ?? "");
  const o = output as Record<string, unknown>;
  // The holder's own word on what the command's folder got (lane XC step 3b: why it ran without access to it).
  const note = typeof o.note === "string" && o.note !== "" ? `(${o.note})` : "";
  if (typeof o.error === "string" && (typeof o.message === "string" || Object.keys(o).length <= 2)) {
    return `Error: ${o.error}${typeof o.message === "string" ? `: ${o.message}` : ""}${note === "" ? "" : `\n${note}`}`;
  }
  if (tool === "Bash") {
    const out = [o.stdout, o.stderr].map((s) => (typeof s === "string" ? s.replace(/\n+$/, "") : "")).filter((s) => s !== "").join("\n");
    const notes = [o.timedOut === true ? "(timed out)" : "", o.aborted === true ? "(stopped)" : "", typeof o.code === "number" && o.code !== 0 ? `Exit code ${o.code}` : "", note].filter((s) => s !== "");
    return [out, ...notes].filter((s) => s !== "").join("\n");
  }
  if (tool === "Glob" && Array.isArray(o.paths)) {
    const paths = o.paths.filter((p): p is string => typeof p === "string");
    return paths.length === 0 ? "No files found" : `${paths.join("\n")}${o.truncated === true ? "\n(more files: narrow the pattern)" : ""}`;
  }
  if (tool === "Grep" && Array.isArray(o.matches)) {
    const lines = o.matches.map((m) => (m !== null && typeof m === "object" ? `${String((m as { path?: unknown }).path)}:${String((m as { line?: unknown }).line)}:${String((m as { text?: unknown }).text)}` : "")).filter((l) => l !== "");
    return lines.length === 0 ? "No matches found" : `${lines.join("\n")}${o.truncated === true ? "\n(more matches: narrow the search)" : ""}`;
  }
  return JSON.stringify(output);
}

export function botFileFence(fence: Pick<Fence, "forCaller">, home: string, os?: Os, userHome?: string): (ctx: BotSessionContext) => FileFence {
  return (ctx) => {
    const own = fence.forCaller(ctx.caller);
    // The roots the session was granted (its policy's writes, a person's grants among them): on Windows a share is read
    // only inside one of these (`windowsPathRefused`, lane WS8).
    const roots = () => { try { return own.policy().allowWrite; } catch { return []; } };
    return { check: (op) => own.check(op), home, roots, ...(os === undefined ? {} : { os }), ...(userHome === undefined ? {} : { userHome }) };
  };
}

export interface BotDriverDeps {
  /** The MOSS home: this driver's state; the runtime's own home (`MOSS_HOME`) and its transcripts are its store home under it (`storeHomeFor`). */
  home: string;
  profile?: string;
  /** The embedded runtime's spawn hook (`createEmbeddedSessionHost().spawn`). */
  spawn: SpawnClaudeCodeProcess;
  /** macOS: the process holder (`EmbeddedSessionDeps.processHolder`); default, the one beside the daemon. */
  processHolder?: string;
  /** Test seam: the agent SDK's `query`. */
  query?: typeof sdkQuery;
  /** The drop (the owner's ask on 14c): the plugins folder, and who made a new folder there. A bot's own session's shell
   *  call is compared before and after: each top-level name that appeared in between is that bot's
   *  (`PluginFolders.dropped`), so the registry's read names it as the builder. A name made after the call returned
   *  (a background command) isn't attributed: it is an ordinary found plugin. */
  pluginDrops?: { folder: string; dropped(name: string, bot: string): void };
  /** The approval check for a session's tool calls (lanes B and C's broker, through the approval bridge). */
  canUseTool(ctx: BotSessionContext, origin: () => TurnOrigin | undefined): CanUseTool;
  /** What the conversation saw, for the approvals (lane C's `SeenUrls`: a page whose address came from the user or a
   *  search hit runs without asking, a few a user's turn): each new turn's start (never a fold) with the origin the
   *  host gave it, each input as it arrived (folds too), and each tool's result as the tool returned it, before any
   *  plugin's hook changed it. */
  observe?: {
    turn?(ctx: BotSessionContext, origin: TurnOrigin): void;
    input?(ctx: BotSessionContext, input: TurnInput): void;
    toolResult?(ctx: BotSessionContext, tool: string, response: unknown, input?: unknown): void;
    /** How many background commands and monitors the session's runtime runs now, at each change (0 when it closes):
     *  lane C's link-race interim (a file tool's write inside the shell's folders isn't contained while one runs). */
    tasks?(ctx: BotSessionContext, live: number): void;
  };
  /** The core tools the session gets: lane D's `SendMessage` and `ListAgents` (`BotSide.tools`), lane K's `Agent` and
   *  `TaskStop` (`agentToolDefs`), and `Glossary`. Read at each build. */
  coreTools?(ctx: BotSessionContext, origin: () => TurnOrigin | undefined): readonly CoreToolDef[];
  /** The plugins' MCP servers for this session (lanes B and D's host, J's placement), and lane J's router
   *  (`ComputerNode.mcp`), which runs each call where its server is. */
  /** `settled`: waits (briefly) for the first listing of a server just installed or enabled, so the turn that starts
   *  right after sees its tools (`PluginMcp.settled`). */
  mcp?: { servers(ctx: BotSessionContext): readonly BotMcpServer[]; runner: McpRunner; settled?(): Promise<void>;
    /** MCP Apps: every tool of a server with the page it names (even an app-only one), and `resources/read` of a page on the
     *  connection that serves the tool (`PluginMcp.uiTools`, `readUi`). */
    ui?: { tools(server: string, tool: string): { name: string; ui?: { resourceUri?: string; visibility: readonly ("model" | "app")[] } }[]; read(server: string, tool: string, uri: string, as: Caller, o?: { signal?: AbortSignal }): Promise<UiResourceContent[]> } };
  /** MCP Apps (`mcp-apps/`): a plugin tool that names a page gets it bound here, under the session and the call. */
  mcpApps?: McpAppsService;
  /** What the model plugins give a session on `provider` now (`modelProviderKey`: its catalog rows and how its adapter
   *  is served, or `absent`). The runtime takes them only when it opens, so a change for the bot's own provider reopens
   *  it at the next turn; another provider's change never does. Default: `modelProviderKey`. */
  modelCatalogKey?(provider: string): string;
  /** Lane J's holds (`ComputerNode.holds`): the session lets go of them at each turn's end. */
  holds?: { releaseSession(session: string): Promise<number> | number };
  /** Lane J's terminals (`ComputerNode.terminals`): the session's close at its end. */
  terminals?: { closeSession(session: string): Promise<number> | number };
  /** The folder tree (lane XC, `tree/route.ts`): a call on a tree path this computer holds runs on its real path; one
   *  on another computer's goes there. Without it every call is the runtime's own, as before. */
  tree?: TreeRouteDeps & {
    /** The node's tree tools (`ComputerNode.tools`): a call on another computer's path runs there, fenced and judged
     *  by that computer. Without them such a call is refused with the reason. */
    tools?: Pick<TreeTools, "run">;
    /** This computer's own floor for a call on another computer, before it goes there: why it is refused (a file tool's
     *  write to a place that runs later, by name: `runLaterByName`), or undefined. */
    remoteFloor?: (tool: string, input: unknown, cwd?: string) => string | undefined;
    /** A plugin's ask for a call on another computer: this computer's card (its broker), naming the plugin, its reason
     *  (quoted, clamped) and where the call runs. True: the person said yes. */
    askHere?: (q: { ctx: BotSessionContext; tool: string; input: unknown; computer: string; reason: string; plugin?: string; origin: TurnOrigin | undefined; signal: AbortSignal }) => Promise<boolean>;
  };
  /** The plugin registry, for `Glossary`'s skills, agent definitions, plugins and points. */
  registry?: GlossaryDeps["registry"];
  /** The plugins' hooks (`pluginHooks`); none without it. */
  hooks?: TurnHooks;
  /** The computers for the devices block (lane J's registry). */
  computers?(): readonly PromptComputer[];
  /** The lease epoch the calls are made under (§6.4); 0 outside a lease. */
  epoch?(): number;
  /** Fills what a real model needs (the provider, the credential broker, the model plugins' adapters) into a
   *  session's options; the daemon's. A `winter-test/*` model needs nothing. */
  provider?(model: string, options: Options, ctx: BotSessionContext): void | Promise<void>;
  /** The Bash sandbox, read at each turn start (a change reopens the runtime); the runtime's default floor when left
   *  out. Given, it must answer: undefined or a throw fails the turn, never "floor only". Whatever it says, a bot's
   *  commands run sandboxed (`BOT_SANDBOX`). */
  sandbox?(ctx: BotSessionContext): SandboxSettingsConfig | undefined;
  /** The fence for the session's own Read, Glob and Grep (`fileToolFenceRefusal`): the MOSS home's default-deny, as
   *  its Bash meets it in `sandbox`. None without it. */
  fileFence?(ctx: BotSessionContext): FileFence | undefined;
  /** Extra environment for the runtime (never secrets). */
  env?: Record<string, string>;
  /** How long `stop` waits for the runtime to end. */
  stopGraceMs?: number;
  /** How often a session with background tasks looks at the pause (`PAUSE_POLL_MS`); a test's seam. */
  pausePollMs?: number;
  /** How long a tool call waits for the pause to lift before it's refused (`TOOL_HOLD_MS`); a test's seam. */
  toolHoldMs?: number;
  log?(line: string): void;
}

/** The persisted half of a session's runtime: the transcript's id. */
interface DriverState { backendSessionId: string }

/** One running host turn. */
interface RunningTurn {
  ctl: TurnControl;
  /** Pushes not yet answered: the first, and each one folded in that the runtime hasn't taken. */
  owed: number;
  /** What was pushed to fold in and not yet taken, oldest first. */
  unfolded: string[];
  usage: { inputTokens: number; outputTokens: number; contextTokens?: number };
  text?: string;
  interrupted: boolean;
  /** The text that started the turn: carried into the next one when an interrupt lands while the pause holds it. */
  first: string;
  /** Why the pause hold blocked the turn's start (the session ended, or the lease went): it ends `stopped`. */
  heldOff?: string;
  offFold: Unsubscribe;
  offAbort: () => void;
  /** The last record a `message.out` hook holds back; the turn ends after it. */
  pending?: Promise<void>;
  finish(end: TurnEnd): void;
  ended: boolean;
}

interface Incarnation {
  query: Query;
  /** What this incarnation's plugin tool results showed, waiting for their `tool_result` (`ToolDisplays`). */
  displays: ToolDisplays;
  /** The pages their calls named, waiting for the same (`ToolApps`). */
  apps: ToolApps;
  queue: HostPromptQueue;
  abort: AbortController;
  projector: Projector;
  pump: Promise<void>;
  closed: boolean;
  /** The runtime's background tasks (shells, monitors) still running, by task id. */
  tasks: Set<string>;
  /** Tasks that ended, in the runtime's order, not yet handed to the host (`#promptHold`, `ctx.wake`). */
  ended: TaskWake[];
  /** Wakes for the runtime's own turns `#promptHold` ended: each goes to the host once that turn's result is in, so
   *  the turn the host starts never takes the ended one's result for its own. */
  wakes: TaskWake[];
  /** Task ids a stop is under way for. */
  stopping: Set<string>;
  /** Looks at the pause while `tasks` isn't empty. */
  taskWatch?: ReturnType<typeof setInterval>;
}

/** A background task of the session's runtime that ended (lane D's `BotSessionContext.wake`). */
export interface TaskWake {
  task: string;
  /** How it ended; `event` for a monitor's event, the task still running. */
  status: "completed" | "failed" | "stopped" | "event";
  text: string;
}

/** The wake for the runtime's own turn: the ended task its notification names (by `<task-id>`), else read from the
 *  notification itself (a monitor's event has no ending of its own). Never another task's. */
function wakeFor(prompt: string, ended: TaskWake[]): TaskWake {
  const field = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(prompt)?.[1];
  const id = field("task-id");
  if (id !== undefined) {
    const i = ended.findIndex((e) => e.task === id);
    if (i >= 0) return ended.splice(i, 1)[0]!;
  }
  const raw = field("status");
  const status: TaskWake["status"] = raw === "failed" ? "failed" : raw === "stopped" || raw === "killed" ? "stopped" : raw === "completed" ? "completed" : "event";
  const event = /<event>([\s\S]*?)<\/event>/.exec(prompt)?.[1];
  const text = [field("summary"), event].filter((x): x is string => x !== undefined && x !== "").join("\n");
  return { task: id ?? "unknown", status, text: text !== "" ? text : prompt };
}

/** The session's context, with lane D's `wake` where the host has it: the runtime's own notification turn is handed to
 *  the host as input instead of running unseen. */
type WakeContext = BotSessionContext & { wake?(w: TaskWake): unknown };

/** How long the tool hook may run (seconds): a call the pause holds waits inside it (`TOOL_HOLD_MS`). */
const TOOL_HOOK_TIMEOUT_S = 3600;
/** The test-build define (scripts/build-daemon.ts): `false` in a release build, a label in a test build, undeclared from
 *  source. */
declare const __MOSS_TEST_BUILD__: string | false | undefined;
/** The longest answer the hand-off gives (agent SDK 0.0.87's `toolOutputReplacement` bound). */
const TREE_ANSWER_MAX = 100_000;
/** The most calls marked for the hand-off at once (lane XC): far above a turn's concurrent calls. */
const REMOTE_MARKS_MAX = 256;
/** How long a tool call waits for the pause to lift before it's refused, saying why (a minute inside the hook's hour). */
const TOOL_HOLD_MS = (TOOL_HOOK_TIMEOUT_S - 60) * 1000;

/** Whether `stopTask` failed because the runtime has no such task (it ended, or isn't this session's). */
export function isUnknownTask(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "unknown_task" || (err instanceof Error && /unknown_task/.test(err.message));
}

/** How often a session with background tasks looks at the pause switch (it has no event for it). */
const PAUSE_POLL_MS = 1_000;

/** The events the host projects itself; the runtime's echoes of them are dropped. */
const HOST_OWNED = new Set(["user_message", "turn_started", "turn_completed"]);

/** How long the runtime lets the model-turn hold run (seconds): the longest a timer can wait, about 24.8 days. A pause
 *  that outlasts it ends the held turn blocked, never started. */
const PROMPT_HOLD_TIMEOUT_S = Math.floor(2_147_483_647 / 1000);
/** The most times one host turn goes on after a core tool ended the runtime's turn (`CoreToolResult.endTurn`). */
export const MAX_CONTINUATIONS = 4;

/** A plugin id's top-level tree (`moss` for `moss/web`). */
const top = (id: string) => (id.includes("/") ? id.slice(0, id.indexOf("/")) : id);

/** Server names the agent runtime keeps for itself: its standing server's (the brand's `mcpServerName`, `moss`, which
 *  the runtime refuses for any configured server and then exits before init) and the daemon's capability servers'
 *  (`moss__<key>`). A plugin server under one is left out of the session, never handed to the runtime. */
export function runtimeReservedServerNames(): ReadonlySet<string> {
  return new Set([requireBrand().mcpServerName, ...reservedMcpServerNames()]);
}

/** Names no tree but their own may take, installed or not: the bundled tree's. */
export const RESERVED_SERVER_NAMES: readonly string[] = ["moss"];

/** Servers that share a name prefix (the bundled tree's children all read `mcp__moss__…`: the browser's, the web
 *  plugin's) are one server to the runtime, with every tool; a tool name two of them give keeps the first, by plugin
 *  id, as the registry keeps a name (§6.7 "Tool names are unique"). Only one plugin tree may hold a name (§6.7: one
 *  enabled plugin per namespace): the name belongs to the plugin tree whose top-level id it is (`moss` for
 *  `mcp__moss__…`), else to the first tree by plugin id; a server of any other tree under it is left out, never merged
 *  in (`onRefused`), so no plugin can slip its tools under another's name. */
export function mergedServers(servers: readonly BotMcpServer[], onRefused?: (s: BotMcpServer, holder: string) => void, reserved: Iterable<string> | ReadonlyMap<string, string> = RESERVED_SERVER_NAMES): BotMcpServer[] {
  const sorted = [...servers].sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
  // Who holds each name, compared without case: an installed tree's namespace is its own even when it gives no server
  // (`reserved`: name → the tree's top-level id; a plain name is its own tree's), else the tree whose top-level id is
  // the name (`moss` holds `mcp__moss__…`), else the first by plugin id.
  const holder = new Map<string, string>();
  for (const entry of reserved) {
    const [name, tree] = typeof entry === "string" ? [entry, entry] : entry;
    // The first claim holds: `moss` stays the bundled tree's whatever another tree's id or namespace spells.
    if (!holder.has(name.toLowerCase())) holder.set(name.toLowerCase(), tree);
  }
  const fixed = new Set(holder.keys());
  for (const s of sorted) {
    const key = s.server.toLowerCase();
    if (fixed.has(key)) continue;
    const h = holder.get(key);
    if (h === undefined || (top(s.plugin).toLowerCase() === key && h.toLowerCase() !== key)) holder.set(key, top(s.plugin));
  }
  const out = new Map<string, BotMcpServer>();
  for (const s of sorted) {
    // A server name is a namespace (lane B's wire name): lower-case letters and digits, joined by single hyphens.
    if (!NAMESPACE_RE.test(s.server)) {
      onRefused?.(s, "no one (the name isn't a namespace)");
      continue;
    }
    const h = holder.get(s.server.toLowerCase())!;
    if (top(s.plugin) !== h) {
      onRefused?.(s, h);
      continue;
    }
    const had = out.get(s.server);
    if (had === undefined) {
      out.set(s.server, { ...s, tools: [...s.tools] });
      continue;
    }
    const names = new Set(had.tools.map((t) => t.name));
    out.set(s.server, { ...had, tools: [...had.tools, ...s.tools.filter((t) => !names.has(t.name))] });
  }
  return [...out.values()];
}

/** The servers `mergedServers` keeps, each as its plugin gave it (for the prompt, which lists every server's text). */
export function keptServers(servers: readonly BotMcpServer[], reserved: Iterable<string> | ReadonlyMap<string, string> = RESERVED_SERVER_NAMES): BotMcpServer[] {
  const refused = new Set<BotMcpServer>();
  mergedServers(servers, (r) => refused.add(r), reserved);
  return servers.filter((s) => !refused.has(s));
}

/** A uuid from a session id: the runtime keys its transcript by a uuid. */
function backendIdFor(): string {
  return crypto.randomUUID();
}

export class BotSessionDriver implements SessionDriver {
  readonly canFold = true;
  readonly #ctx: BotSessionContext;
  readonly #fileFence: FileFence | undefined;
  /** The session's tree router (lane XC), with Bash's folder on another computer. */
  readonly #router: TreeRouter | undefined;
  /** Calls `#preTool` found on another computer's path, by call id: `#treeHandOff` answers them; their results are the
   *  holder's, fenced there, so `#postTool` leaves them unfiltered. */
  /** The write roots the host's sandbox left out (`leftOutRoots`), from its last read. */
  #leftOut: readonly LeftOutRoot[] = [];
  readonly #remoteCalls = new Map<string, { ask?: string; askBy?: string; answered?: true; result?: Record<string, unknown> }>();

  /** Marks a call for the hand-off, with a plugin's ask. Bounded: the oldest mark goes past `REMOTE_MARKS_MAX` (a call
   *  whose turn ended with no PostToolUse of any kind, the review's should-fix 5). */
  #markRemote(callId: string, ask: string | undefined, askBy?: string): void {
    // A second pass of the call's hooks keeps the answer already given (`#treeHandOff`).
    if (this.#remoteCalls.get(callId)?.result !== undefined) return;
    this.#remoteCalls.delete(callId);
    this.#remoteCalls.set(callId, { ...(ask === undefined ? {} : { ask }), ...(askBy === undefined ? {} : { askBy }) });
    while (this.#remoteCalls.size > REMOTE_MARKS_MAX) this.#remoteCalls.delete(this.#remoteCalls.keys().next().value!);
  }
  readonly #d: BotDriverDeps;
  readonly #log: (line: string) => void;
  readonly #statePath: string;
  #state: DriverState | undefined;
  #inc: Incarnation | undefined;
  #generation = 0;
  #rebuild = true;
  /** The sandbox the open runtime was given (canonical JSON): the agent SDK takes `sandbox` only when a runtime opens,
   *  so each turn start compares the host's sandbox now with it and reopens on a difference (`#ensureOpen`). The bound
   *  is one turn: what a turn runs, a message folded into it mid-turn included, runs under the sandbox read at the
   *  turn's start; a change made during a turn reaches the next. */
  #builtSandbox: string | undefined;
  /** The MCP servers the open runtime was given, by name: the agent SDK takes `mcpServers` only when a runtime opens,
   *  so a server a plugin adds (an install, an enable) or takes away since reopens it at the next turn start
   *  (`#serversChanged`). A server whose tools change keeps the runtime and is told in the turn (`mcpChangesSince`). */
  #builtServers: string | undefined;
  /** The model and effort the open runtime was given: the runtime takes both, and the provider fill computes the bot's
   *  credential allowlist from the model (#350's ruling), only when it opens, so a switch reopens it (`#ensureOpen`). */
  #builtModel: string | undefined;
  /** The bot's provider and what the model plugins gave the open runtime for it (`modelCatalogKey`): a change for that
   *  provider since (the model plugins coming up after this runtime opened, its plugin installed, updated, turned on
   *  or off) reopens it at the next turn, so a provider the plugins bring is never missing from a runtime that opened
   *  before it was there; another plugin's change leaves it alone. */
  #builtCatalog: { provider: string; key: string } | undefined;
  /** The provider key a reopen was held back for (background work running), said once. */
  #catalogHeldSaid: string | undefined;
  /** The bot's instructions the open runtime's prompt carries: the runtime takes the prompt only when it opens, so an
   *  edit (its plugin's file, or the user layer's) reopens it at the next turn start, resuming the transcript under the
   *  new prompt, however long or short the conversation (one cache miss per edit). */
  #builtInstructions: string | undefined;
  /** The instructions a reopen was held back for (background work running), said once. */
  #instructionsHeldSaid: string | undefined;
  #builtMcp: Map<string, string> = new Map();
  /** Plugin servers already logged as left out for a runtime-reserved name. */
  readonly #runtimeReservedSaid = new Set<string>();
  #turn: RunningTurn | undefined;
  #origin: TurnOrigin | undefined;
  /** Pushes an interrupt cleared, carried into the next turn ahead of its message. */
  #carry: string[] = [];
  #stopped = false;
  /** A core tool asked for the runtime's turn to end and the host turn to go on (`CoreToolResult.endTurn`): its note. */
  #continueWith: string | undefined;
  /** Model turns the pause holds at their start (`#promptHold`), and what let each go other than the resume. */
  readonly #promptHolds = new Set<{ release: AbortController; why?: "interrupt" | "closing" }>();
  /** The records a `message.out` hook holds back, in order. */
  #recordChain: Promise<void> = Promise.resolve();
  /** The ids of the tool calls starting, by `mcp__<server>__<tool>`, oldest first (`CallIds`). */
  readonly #callIds = new Map<string, string[]>();

  constructor(ctx: BotSessionContext, deps: BotDriverDeps) {
    this.#ctx = ctx;
    this.#d = deps;
    this.#fileFence = deps.fileFence?.(ctx);
    this.#router = deps.tree === undefined ? undefined : new TreeRouter(deps.tree, ctx.caller);
    this.#log = deps.log ?? (() => {});
    this.#statePath = join(deps.home, "sessions-runtime", `${ctx.sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  get #hookSession(): HookSession {
    return { id: this.#ctx.sessionId, kind: this.#ctx.kind, caller: this.#ctx.caller, bot: this.#ctx.botId, computer: this.#ctx.computer };
  }

  get #hooks(): TurnHooks {
    return this.#d.hooks ?? NO_HOOKS;
  }

  #readState(): DriverState {
    if (this.#state !== undefined) return this.#state;
    try {
      const raw = JSON.parse(readFileSync(this.#statePath, "utf8")) as Partial<DriverState>;
      if (typeof raw.backendSessionId === "string" && /^[0-9a-f-]{36}$/.test(raw.backendSessionId)) return (this.#state = { backendSessionId: raw.backendSessionId });
    } catch {
      // none yet
    }
    const state = { backendSessionId: backendIdFor() };
    mkdirSync(join(this.#d.home, "sessions-runtime"), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.#statePath, state);
    return (this.#state = state);
  }

  async #hasTranscript(id: string): Promise<boolean> {
    try {
      await mossSessions(this.#d.home).getSessionInfo(id);
      return true;
    } catch {
      return false;
    }
  }

  #mcpServers(): readonly BotMcpServer[] {
    try {
      const reserved = runtimeReservedServerNames();
      return (this.#d.mcp?.servers(this.#ctx) ?? []).filter((s) => {
        if (!reserved.has(s.server)) return true;
        const said = `${s.plugin}\u0000${s.server}`;
        if (!this.#runtimeReservedSaid.has(said)) {
          this.#runtimeReservedSaid.add(said);
          this.#log(`bot driver ${this.#ctx.sessionId}: ${s.plugin}'s MCP server ${s.server} is left out: the agent runtime keeps that name for its own server`);
        }
        return false;
      });
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: listing MCP servers failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Every installed tree's namespace (the registry's, lane B's wire name), and the bundled tree's: names only that
   *  tree's servers may take, by name → the tree's top-level id. */
  #reservedNames(): Map<string, string> {
    const names = new Map<string, string>(RESERVED_SERVER_NAMES.map((n) => [n, n]));
    try {
      for (const p of this.#d.registry?.list() ?? []) {
        const ns = typeof p.namespace === "string" && p.namespace !== "" ? p.namespace.toLowerCase() : top(p.id).toLowerCase();
        if (!names.has(ns)) names.set(ns, top(p.id));
      }
    } catch {
      // a registry that can't list: the bundled tree's name still holds
    }
    return names;
  }

  #promptServers(servers: readonly BotMcpServer[]): PromptMcpServer[] {
    return servers.map((s) => ({
      plugin: s.plugin, server: s.server,
      ...(s.instructions === undefined ? {} : { instructions: s.instructions }),
      ...(s.computers === undefined ? {} : { computers: s.computers }),
      ...(s.reachable === undefined ? {} : { reachable: s.reachable }),
    }));
  }

  /** The pause and the lease (§6.4, §9.2): undefined when the session may act now, after waiting while the pause
   *  switch holds it; otherwise why the call is refused (the lease went elsewhere, or the turn ended). */
  async #gate(signal: AbortSignal): Promise<string | undefined> {
    if (!this.#ctx.mayAct()) {
      // Held at most `TOOL_HOLD_MS`, inside the tool hook's own hour: past it the call is refused, saying why.
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), this.#d.toolHoldMs ?? TOOL_HOLD_MS);
      try {
        await this.#ctx.whenMayAct(AbortSignal.any([signal, limit.signal, ...(this.#turn ? [this.#turn.ctl.signal] : [])]));
      } catch {
        if (limit.signal.aborted && !signal.aborted) {
          return "Not run: the user paused the bots and the pause outlasted how long a call can wait (an hour). Nothing was done; try the call again once the bots are resumed.";
        }
        return "Stopped: this computer may not act for the bot now (the user paused bots, or another computer runs them).";
      } finally {
        clearTimeout(timer);
      }
    }
    return this.#ctx.mayAct() ? undefined : "Stopped: this computer no longer runs the bot.";
  }

  /** A queued MCP call id the runtime won't use: its call was refused or failed before it reached the router. */
  #dropCallId(name: string, id: string | undefined): void {
    if (id === undefined || !name.startsWith("mcp__")) return;
    const q = this.#callIds.get(name);
    const i = q?.indexOf(id) ?? -1;
    if (q !== undefined && i >= 0) q.splice(i, 1);
  }

  /** The approval check, then the pause and the lease again (review B1): the switch may have come on, or the lease
   *  gone, while the card was open, and an allow given then must not run the call. */
  #gatedCanUseTool(inner: CanUseTool): CanUseTool {
    return async (name, input, opts) => {
      // A call the hand-off answered (lane XC) ran on its holder, judged there: this computer's check never judges it (it
      // would read another computer's path as one in this session's folder). Reached only when a hook asks after an
      // answer, which none of this driver's does for such a call (#preTool sends a plugin's ask to the holder, and the
      // session loads no settings' hooks); denying now would only misreport a call already run.
      const mark = opts.toolUseID === undefined ? undefined : this.#remoteCalls.get(opts.toolUseID);
      if (mark?.answered === true) return { behavior: "allow", updatedInput: input };
      // Marked for another computer but not answered there (a path the hand-off didn't reach): never judged here as a
      // local path, never run on this disk.
      if (mark !== undefined) {
        this.#remoteCalls.delete(opts.toolUseID!);
        return { behavior: "deny", message: "This call names another computer's path and wasn't run there; try it again." };
      }
      const r = await inner(name, input, opts);
      if (r === null || r.behavior !== "allow") {
        this.#dropCallId(name, opts.toolUseID);
        return r;
      }
      const stop = await this.#gate(opts.signal);
      if (stop === undefined) return r;
      this.#dropCallId(name, opts.toolUseID);
      return { behavior: "deny", message: stop };
    };
  }

  #releasePromptHolds(why: "interrupt" | "closing"): void {
    for (const h of this.#promptHolds) {
      h.why ??= why;
      h.release.abort();
    }
  }

  /** The pause at a model turn's start (§9.2: a paused bot starts no model turn). The runtime runs `UserPromptSubmit`
   *  before every turn's first request, its own included (a background task's notification starts one when the task
   *  finishes or is stopped, with no host turn asking), and before an input folds in. While the pause holds the
   *  session it waits; resumed, the turn goes on. The user's interrupt, the session's end and a lease that went
   *  elsewhere let it go blocked instead, so no request goes out; an interrupted turn's text leads the next turn. */
  #promptHold(): HookCallbackMatcher {
    return {
      timeout: PROMPT_HOLD_TIMEOUT_S,
      hooks: [async (raw, _id, { signal }) => {
        // A turn no host turn covers (the runtime's own) asks what a host turn asked before it started: `mayStart`,
        // no while paused, or while this computer isn't the runner or hands its bots back. One the host started, and
        // an input folding into it, ask `mayAct`: a hand-back lets the running turn finish.
        const own = this.#turn === undefined || this.#turn.ended;
        const ctx = this.#ctx as WakeContext;
        // A turn of the runtime's own, where the host takes wakes (lane D): it ends here before any request, and the
        // notification goes to the host, which folds it into a running turn or starts one (through its `mayStart`) that
        // reaches this driver as any turn does, logged, its usage counted.
        if (own && typeof ctx.wake === "function") {
          const inc = this.#inc;
          const prompt = (raw as { prompt?: unknown }).prompt;
          // Matched by the task id its notification names: a notification taken inside a host turn leaves an entry
          // behind (bounded), which no later wake takes for its own.
          const w = wakeFor(typeof prompt === "string" ? prompt : "", inc?.ended ?? []);
          inc?.wakes.push(w);
          return { decision: "block" as const, reason: "Handed to the host as a background task's input." };
        }
        const may = own && ctx.mayStart !== undefined && ctx.whenMayStart !== undefined
          ? { now: () => ctx.mayStart!(), when: (sig: AbortSignal) => ctx.whenMayStart!(sig) }
          : { now: () => ctx.mayAct(), when: (sig: AbortSignal) => ctx.whenMayAct(sig) };
        if (may.now()) return {};
        const hold: { release: AbortController; why?: "interrupt" | "closing" } = { release: new AbortController() };
        this.#promptHolds.add(hold);
        try {
          await may.when(AbortSignal.any([signal, hold.release.signal]));
        } catch {
          // let go, timed out, or the lease went elsewhere: decided below
        } finally {
          this.#promptHolds.delete(hold);
        }
        if (hold.why === undefined && !signal.aborted && !this.#stopped && may.now()) return {};
        const t = this.#turn;
        const prompt = (raw as { prompt?: unknown }).prompt;
        const reason = hold.why === "interrupt" ? "Interrupted while the bots were paused."
          : hold.why === "closing" || this.#stopped ? "The session ended while the bots were paused."
            : signal.aborted ? "The bots stayed paused too long." : "Stopped: this computer no longer runs the bot.";
        if (t !== undefined && typeof prompt === "string" && prompt === t.first) {
          if (hold.why === "interrupt") this.#carry.push(prompt);
          else t.heldOff = reason;
        }
        return { decision: "block" as const, reason };
      }],
    };
  }

  /** Why the fence refuses one of the session's own file tool calls (`fileToolFenceRefusal`), or undefined. */
  /** The user's home and OS for the sandbox's deny spellings (`botSandbox`), as the session's file fence knows them. */
  #denyFormsHome(): { userHome?: string; os?: Os } {
    const f = this.#fileFence;
    return { ...(f?.userHome === undefined ? {} : { userHome: f.userHome }), ...(f?.os === undefined ? {} : { os: f.os }) };
  }

  /** Where a call runs (`TreeRouter`): local without a tree. A Bash call that runs on this computer clears its folder
   *  on another one. A router that throws never lets the call through untouched: it is refused. */
  #route(name: string, toolInput: unknown): TreeRoute {
    if (this.#router === undefined) return { kind: "local" };
    try {
      const route = this.#router.route(name, toolInput);
      if (name === "Bash" && route.kind !== "other" && route.kind !== "refused") {
        this.#router.settled(route, undefined, typeof (toolInput as { command?: unknown } | null)?.command === "string" ? (toolInput as { command: string }).command : undefined);
      }
      return route;
    } catch (e) {
      return { kind: "refused", reason: `MOSS couldn't tell which computer this call runs on: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  #fileFenceRefusal(input: ToolUseInput): string | undefined {
    if (this.#fileFence === undefined) return undefined;
    return fileToolFenceRefusal(input.tool_name ?? "", input.tool_input, this.#fileFence, this.#ctx.paths.scratch);
  }

  /** Lane XC, the very last `PreToolUse` hook: a call `#preTool` found on another computer's path runs there through
   *  the tree (`TreeTools.run`), and this hook ANSWERS it (agent SDK 0.0.87's `toolResult`): the runtime's own tool
   *  never runs, and the result carries a true error flag. Last, so every other hook (the pause, the plugins, the fence,
   *  the trailing gate) has had its say and a deny from any of them wins before anything runs elsewhere. The holder
   *  judges the call by its own level, saved rules and fence (`service.ts`, `judgePeer`); a card it needs comes back
   *  through this computer's broker (`askUser`). Bash on another computer moves the session's tree folder, shown on
   *  the result's first line when it changes.
   *
   *  The limit (agent SDK 0.0.87): the answer is made INSIDE PreToolUse, so the other computer acts before this
   *  computer's runtime reaches its own final decision for the call. So this computer's checks are made here first:
   *  the pause and the lease (#preTool, the trailing gate, again here, and after any card there); the plugins'
   *  tool.before (a deny refuses, a rewrite is what runs, an ask raises this computer's card before anything goes); the
   *  tree router's refusals; the run-later floor for a file tool's write (`remoteFloor`); and the level, never wider
   *  than the session's own, the bot's on this computer or the holder's. A later deny can't come in this driver's
   *  session: every PreToolUse hook is this driver's (no base hooks, `settingSources: []`, so no settings' hooks or
   *  rules), this hook is the last, the session runs in permission mode "default" (never plan), none of this computer's
   *  saved rules or Tools-tab settings applies to a built-in tool (the rules only allow; the settings are plugin
   *  tools'), and `#gatedCanUseTool` lets through a call this hook answered (keyed on the answer it recorded) without
   *  judging it again. */
  #treeHandOff(): HookCallbackMatcher {
    return {
      failClosed: true,
      timeout: TOOL_HOOK_TIMEOUT_S,
      hooks: [async (raw, toolUseId, { signal }) => {
        const input = raw as ToolUseInput;
        const callId = input.tool_use_id ?? toolUseId ?? "";
        const name = input.tool_name ?? "";
        const deny = (why: string) => {
          this.#remoteCalls.delete(callId);
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } };
        };
        const mark = this.#remoteCalls.get(callId);
        // On the input as every earlier hook left it (the runtime hands each hook the one before's rewrite), routed
        // again: what runs there is what was judged here.
        const route = this.#router?.route(name, input.tool_input) ?? { kind: "local" as const };
        if (mark === undefined) {
          // Not marked, yet on another computer's path (a mark taken by the bound, or a path a later hook made): never
          // left to the runtime's own tool, which would write it into the session's folder past the file fence.
          return route.kind === "other" ? deny(`${route.computer} holds that path, and this call wasn't set to run there; try it again`) : {};
        }
        // The runtime may evaluate a call's hooks again (a policy change mid-evaluation, `evaluateWithFreshPolicy`): the
        // answer given once is given again, and the call never runs a second time there.
        if (mark.result !== undefined) return mark.result;
        const tools = this.#d.tree?.tools;
        // The one way out with a result: recorded on the mark as it answers (`#gatedCanUseTool` lets through only a call
        // answered here, never one merely marked), and kept for a second pass.
        const answer = (text: string, isError: boolean) => {
          // Clamped to what the runtime takes as a tool's answer (agent SDK 0.0.87, 100,000 characters) before it is kept.
          // The kept answer stays bound to this first pass's input: a second pass (the runtime's re-evaluation) gets this
          // answer whatever input it carries, and nothing runs again on the holder.
          const content = text.length > TREE_ANSWER_MAX ? `${text.slice(0, TREE_ANSWER_MAX - 40)}\n… (cut at ${TREE_ANSWER_MAX} characters)` : text;
          const out = { hookSpecificOutput: { hookEventName: "PreToolUse", toolResult: { content, isError } } };
          mark.answered = true;
          mark.result = out;
          return out;
        };
        if (route.kind === "refused") return deny(route.reason);
        if (route.kind !== "other" || tools === undefined) return deny("this call no longer names another computer's path; run it again");
        if (!route.online) return answer(`Error: computer offline: ${route.computer} is offline`, true);
        // This computer's own floors for the call, before anything runs there (the review's should-fix 3): a write by a
        // file tool to a place that runs later is refused by name, as bot-check refuses it for a path it can't resolve.
        const floor = this.#d.tree?.remoteFloor?.(name, input.tool_input, route.cwd);
        if (floor !== undefined) return deny(floor);
        // The pause and the lease again, right before the call goes (the earlier hooks took time).
        const held = await this.#gate(signal);
        if (held !== undefined) return deny(held);
        const ctx = this.#ctx;
        // A plugin's ask (its hook here, on this computer): the card is this computer's, raised here before anything
        // goes, for every tool, reads included (the holder never asks about a read). A no stops the call. The holder's
        // own card, where its rules ask, still follows: two askers, two cards.
        if (mark.ask !== undefined) {
          const askHere = this.#d.tree?.askHere;
          if (askHere === undefined) return deny(`a plugin asks before this call, and this computer can't show its card for a call on ${route.computer}`);
          const yes = await askHere({ ctx, tool: name, input: input.tool_input, computer: route.computer, reason: mark.ask, ...(mark.askBy === undefined ? {} : { plugin: mark.askBy }), origin: this.#origin, signal });
          if (!yes) return deny(`${name} was refused: the person declined the plugin's card for it`);
          const after = await this.#gate(signal);
          if (after !== undefined) return deny(after);
        }
        // The level the holder judges at, never wider than any of (the review's blocker 2, the controller's ruling): the
        // session's own (a side thread's or a routine's), the bot's level on the computer it runs on, the holder's.
        const dir = this.#d.tree!.directory;
        const levels = [ctx.level, dir.get(ctx.computer)?.level, dir.get(route.computer)?.level].filter((l): l is Level => l !== undefined);
        const level = strictestLevel(levels) ?? "read-only";
        const before = this.#router?.treeCwd;
        let r: TreeToolResult;
        try {
          r = await tools.run(name, input.tool_input, {
            session: ctx.sessionId, sessionKind: ctx.caller.sessionKind, ...(ctx.caller.bot === undefined ? {} : { bot: ctx.caller.bot }),
            callId, ...(route.cwd === undefined ? {} : { cwd: route.cwd }), signal, level,
            ...(this.#origin === undefined ? {} : { origin: this.#origin }),
            ...(this.#d.epoch === undefined ? {} : { epoch: this.#d.epoch() }),
            // After the user's answer on the holder's card, before the call goes with it: the pause and the lease again.
            afterAnswer: async () => {
              const stop = await this.#gate(signal);
              if (stop !== undefined) throw new Error(stop);
            },
          });
        } catch (e) {
          return answer(`Error: ${route.computer}: ${e instanceof Error ? e.message : String(e)}`, true);
        }
        // The mark stays until the answer's PostToolUse (which then leaves the holder's result unrefiltered); a call
        // denied after this hook gets none, and the bound takes its mark.
        let text = treeResultText(name, r.output);
        if (name === "Bash") {
          this.#router?.settled(route, r.cwd);
          const after = this.#router?.treeCwd;
          if (after !== before) text = `${after !== undefined ? `now on ${r.computer}: ${after} (the commands after this run there; file tools need the full path: ${after}/…)` : `back on ${ctx.computer}: the commands after this run here`}\n${text}`;
        }
        return answer(text, r.isError);
      }],
    };
  }

  /** Test seam (lane XC): what a call on another computer meets, as the runtime calls it: this driver's PreToolUse
   *  (`#preTool`), the hand-off (`#treeHandOff`), and the approval check's gate over `inner`. Nothing else uses it. Never
   *  in a release build: there `__MOSS_TEST_BUILD__` is defined `false` (scripts/build-daemon.ts), the check below folds
   *  to a throw and the rest is dead code the bundler drops; from source (`bun test`) and in a test build it works. */
  treeHooksForTest(): {
    preTool: (raw: unknown, toolUseId: string | undefined, signal: AbortSignal) => Promise<Record<string, unknown>>;
    handOff: (raw: unknown, toolUseId: string | undefined, signal: AbortSignal) => Promise<unknown>;
    canUse: (inner: CanUseTool) => CanUseTool;
  } {
    if (typeof __MOSS_TEST_BUILD__ !== "undefined" && __MOSS_TEST_BUILD__ === false) throw new Error("treeHooksForTest isn't in a release build");
    const hook = this.#treeHandOff().hooks[0]!;
    return {
      preTool: (raw, id, signal) => this.#preTool(raw, id, signal),
      handOff: (raw, id, signal) => Promise.resolve(hook(raw as never, id, { signal } as never)),
      canUse: (inner) => this.#gatedCanUseTool(inner),
    };
  }

  /** The pause and the lease once more, after every other `PreToolUse` hook (`mergedHooks`' trailing check). */
  #trailingGate(): HookCallbackMatcher {
    return {
      failClosed: true,
      timeout: TOOL_HOOK_TIMEOUT_S,
      hooks: [async (raw, _id, { signal }) => {
        const stop = await this.#gate(signal);
        if (stop !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: stop } };
        // The fence again, on the input as the earlier hooks left it.
        const fenced = this.#fileFenceRefusal(raw as ToolUseInput);
        return fenced === undefined ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: fenced } };
      }],
    };
  }

  /** A tool call's PreToolUse, in one place: a MODEL's call reaches it as the runtime's hook, and a PAGE's call (MCP Apps) is
   *  made to meet this very function (`#appsFor`), so the page gets all the model's call gets: the pause and the lease, the
   *  plugins' `tool.before` (deny, ask, a rewritten input), the file fence and the sandbox-escape rule. */
  async #preTool(raw: unknown, toolUseId: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>> {
    const input = raw as ToolUseInput;
    const name = input.tool_name ?? "";
    const callId = input.tool_use_id ?? toolUseId ?? "";
    this.#dropsBefore(name, callId);
    const stop = await this.#gate(signal);
    if (stop !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: stop } };
    let r = await this.#hooks.toolBefore(this.#hookSession, { name, callId }, input.tool_input, signal);
    if (r.deny !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.deny } };
    // The plugins' hooks take time: the pause may have come on, or the lease gone, meanwhile. A call that asks no
    // one (a read-only tool) has no later check (`#gatedCanUseTool`), so the gate is asked again here.
    const after = await this.#gate(signal);
    if (after !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: after } };
    // The folder tree (lane XC): a tree path this computer holds becomes its real path, judged below as any local path;
    // one on another computer doesn't run here. A call that names no tree path is untouched.
    const route = this.#route(name, r.input !== input.tool_input && r.input !== null && typeof r.input === "object" && !Array.isArray(r.input) ? r.input : input.tool_input);
    if (route.kind === "refused") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: route.reason } };
    if (route.kind === "other") {
      // Another computer's path: answered by the last hook (`#treeHandOff`), once every other hook has had its say, and
      // never without the tree's tools, nor for a call with no id to know it by (it would fall through to the runtime's
      // own tool, on a path in this computer's scratch folder: refused, never misfiled).
      if (this.#d.tree?.tools === undefined || callId === "") {
        const why = callId === "" ? `${route.computer} holds that path, and this call has no id to run it there by; try it again`
          : route.online ? `${route.computer} holds that path, and this computer can't reach another's tree` : `computer offline: ${route.computer} is offline`;
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } };
      }
      // The plugins' say goes with the call (the review's blocker 1): their ask makes the holder ask the user for it
      // (`#treeHandOff`, level "ask"), and their rewritten input is what the later hooks see and what runs there.
      this.#markRemote(callId, r.ask, r.askBy);
      const rewritten = r.input !== input.tool_input && r.input !== null && typeof r.input === "object" && !Array.isArray(r.input);
      return rewritten ? { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: r.input as Record<string, unknown> } } : {};
    }
    if (route.kind === "here") r = { ...r, input: route.input };
    // The MOSS home's default-deny for the session's own file tools, on the input a plugin's hook may have changed.
    const changedInput = r.input !== input.tool_input && r.input !== null && typeof r.input === "object" && !Array.isArray(r.input);
    // Windows (lane WS9): judged in the very spelling the tool will be given (`windowsFileToolInput`, below), so the fence
    // decides on the path that is opened, never on another spelling of it.
    // Both spellings are judged, the one written and the one opened: either refused is refused.
    const writtenInput = changedInput ? r.input : input.tool_input;
    const openedInput = windowsFileToolInput(name, writtenInput, this.#ctx.paths.scratch);
    const fenced = this.#fileFenceRefusal({ tool_name: name, tool_input: writtenInput })
      ?? (openedInput === undefined ? undefined : this.#fileFenceRefusal({ tool_name: name, tool_input: openedInput }));
    if (fenced !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: fenced } };
    // A command asking to leave the sandbox always reaches the approval check: the runtime handles a hook's ask
    // before its own allow rules and permission mode, and the check cards every such call. Seen on the input as
    // the plugins left it (a hook that strips the flag leaves a sandboxed call, which needs no card; one that
    // adds it is caught here). Anything but exactly `true` is refused outright, never passed through unflagged.
    const escape = outsideSandboxHookDecision(name, changedInput ? r.input : input.tool_input, typeof (raw as { agent_id?: unknown }).agent_id === "string" ? { agentId: (raw as { agent_id: string }).agent_id } : {});
    if (escape !== undefined) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: escape.decision,
          permissionDecisionReason: escape.reason,
          ...(changedInput ? { updatedInput: r.input as Record<string, unknown> } : {}),
        },
      };
    }
    // The call id the router gets, queued only for a call that goes on; a refusal after this drops it
    // (`#gatedCanUseTool`, `PostToolUseFailure`), so the next call of the tool never takes a stale one (review S1).
    if (name.startsWith("mcp__") && callId !== "") {
      const q = this.#callIds.get(name) ?? [];
      q.push(callId);
      this.#callIds.set(name, q);
    }
    const changed = r.input !== input.tool_input && r.input !== null && typeof r.input === "object" && !Array.isArray(r.input);
    // Windows (lane WS9): a file tool's path in the disk's one spelling (`windowsFileToolInput`), so the runtime's
    // read-before-edit check keys a Read and the Edit of the same file alike, whatever spellings the model used. The very
    // input the fence judged above (`openedInput`), never one resolved a second time (the reviewer's nit).
    const updated = openedInput ?? (changed ? (r.input as Record<string, unknown>) : undefined);
    if (r.ask !== undefined || updated !== undefined) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          ...(r.ask !== undefined ? { permissionDecision: "ask" as const, permissionDecisionReason: r.ask } : {}),
          ...(updated !== undefined ? { updatedInput: updated } : {}),
        },
      };
    }
    return {};
  }

  /** A tool call's PostToolUse, in one place (the model's and a page's, as `#preTool`): the plugins' `tool.after` and the observer. */
  async #postTool(raw: unknown, toolUseId: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>> {
    const input = raw as ToolUseInput;
    const name = input.tool_name ?? "";
    this.#dropCallId(name, input.tool_use_id ?? toolUseId);
    this.#dropsAfter(input.tool_use_id ?? toolUseId ?? "");
    // A call another computer answered was fenced there (its holder's fence, on its own disk): this computer's search
    // fence has no say over its paths.
    const remote = this.#remoteCalls.delete(input.tool_use_id ?? toolUseId ?? "");
    // A search's hits through a link out of the session's folders are dropped before anyone sees them, plugins too.
    const fenced = this.#fileFence === undefined || remote ? undefined : fenceSearchOutput(name, input.tool_response, this.#fileFence, this.#ctx.paths.scratch, input.tool_input);
    // Linux (lane XC 3c): a command whose write was refused under a root the sandbox left out is told why.
    const left = remote || name !== "Bash" ? undefined : leftOutNote(fenced ?? input.tool_response, this.#leftOut);
    // Linux (0.0.90): the roots the runtime's own walk dropped this command, said in plain words too.
    const noted = remote || name !== "Bash" ? left : (droppedRootsNote(left ?? fenced ?? input.tool_response) ?? left);
    const result = await this.#hooks.toolAfter(this.#hookSession, { name, callId: input.tool_use_id ?? toolUseId ?? "" }, input.tool_input, noted ?? fenced ?? input.tool_response, signal);
    try { this.#d.observe?.toolResult?.(this.#ctx, name, input.tool_response, input.tool_input); } catch { /* an observer never fails the call */ }
    // A core tool asked for the turn to end here (`#continueWith`): the runtime stops after this round, and `turn`
    // goes on in a new runtime turn.
    const stop = this.#continueWith !== undefined ? { continue: false, stopReason: "MOSS continues this turn under a changed sandbox." } : {};
    if (result === input.tool_response) return stop;
    return { ...stop, hookSpecificOutput: { hookEventName: "PostToolUse", ...(name.startsWith("mcp__") ? { updatedMCPToolOutput: result } : { updatedToolOutput: result }) } };
  }

  /** The tool hooks: the pause and the lease first, then the plugins' `tool.before`; `tool.after` after the call. */
  #toolHooks(): Partial<Record<"PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "UserPromptSubmit", HookCallbackMatcher[]>> {
    const pre: HookCallbackMatcher = {
      // A hook that breaks must never wave the call through.
      failClosed: true,
      timeout: TOOL_HOOK_TIMEOUT_S,
      hooks: [(raw, toolUseId, { signal }) => this.#preTool(raw, toolUseId, signal)],
    };
    const post: HookCallbackMatcher = {
      timeout: 600,
      hooks: [(raw, toolUseId, { signal }) => this.#postTool(raw, toolUseId, signal)],
    };
    const failed: HookCallbackMatcher = {
      hooks: [async (raw, toolUseId) => {
        const input = raw as ToolUseInput;
        this.#dropCallId(input.tool_name ?? "", input.tool_use_id ?? toolUseId);
        this.#dropsAfter(input.tool_use_id ?? toolUseId ?? "");
        this.#remoteCalls.delete(input.tool_use_id ?? toolUseId ?? "");
        return {};
      }],
    };
    // After a call (done or failed), the next request waits while the pause holds: the call itself is never cut off,
    // and no model request goes out until the user resumes (the owner's rule: the pause stops everything).
    const after: HookCallbackMatcher = {
      timeout: TOOL_HOOK_TIMEOUT_S,
      hooks: [async (_raw, _id, { signal }) => {
        if (!this.#ctx.mayAct()) await this.#gate(signal);
        return {};
      }],
    };
    return { PreToolUse: [pre], PostToolUse: [post, after], PostToolUseFailure: [failed, after], UserPromptSubmit: [this.#promptHold()] };
  }

  /** The plugins folder's names before each of this bot session's shell calls (the drop), by call. */
  readonly #pluginNamesBefore = new Map<string, Set<string>>();

  #pluginNames(): Set<string> | undefined {
    const d = this.#d.pluginDrops;
    if (d === undefined) return undefined;
    try { return new Set(readdirSync(d.folder).filter((n) => !n.startsWith("."))); } catch { return undefined; }
  }

  /** A bot's own session (its conversation or a side thread) about to run a shell call: the plugins folder as it is. */
  #dropsBefore(tool: string, callId: string): void {
    const caller = this.#ctx.caller;
    if (this.#d.pluginDrops === undefined || callId === "" || (tool !== "Bash" && tool !== "PowerShell")) return;
    if (caller.kind !== "session" || (caller.sessionKind !== "bot" && caller.sessionKind !== "side-thread")) return;
    const names = this.#pluginNames();
    if (names !== undefined) this.#pluginNamesBefore.set(callId, names);
  }

  /** The call returned: each name that appeared in the plugins folder meanwhile is this bot's drop. */
  #dropsAfter(callId: string): void {
    const before = this.#pluginNamesBefore.get(callId);
    if (before === undefined) return;
    this.#pluginNamesBefore.delete(callId);
    const now = this.#pluginNames();
    for (const name of now ?? []) if (!before.has(name)) this.#d.pluginDrops!.dropped(name, this.#ctx.botId);
  }

  readonly #callIdSource: CallIds = {
    take: (server, tool) => {
      const q = this.#callIds.get(`mcp__${server}__${tool}`);
      return q?.shift();
    },
  };

  async #open(hostSandbox?: { settings: SandboxSettingsConfig | undefined }): Promise<Incarnation> {
    const ctx = this.#ctx;
    const bot = ctx.current();
    const state = this.#readState();
    const resume = await this.#hasTranscript(state.backendSessionId);
    const all = this.#mcpServers();
    const refused = new Set<string>();
    const merged = mergedServers(all, (r, holder) => {
      refused.add(`${r.plugin}\u0000${r.server}`);
      this.#log(`bot driver ${ctx.sessionId}: ${r.plugin}'s MCP server ${r.server} is left out: ${holder} holds that name`);
    }, this.#reservedNames());
    const servers = all.filter((s) => !refused.has(`${s.plugin}\u0000${s.server}`));
    const promptServers = this.#promptServers(servers);
    const systemPrompt = harnessPrompt({
      bot: { id: bot.id, name: typeof bot.name === "string" ? bot.name : (bot.name as { en: string }).en, instructions: bot.instructions },
      kind: ctx.kind, computer: ctx.computer, memory: ctx.memoryBlock(),
      ...(this.#d.computers === undefined ? {} : { computers: this.#d.computers() }),
      mcpServers: promptServers,
    });
    this.#builtMcp = mcpFingerprint(promptServers);
    const origin = () => this.#origin;
    const mcpServers: Record<string, McpServerConfig> = {};
    // The core tools, and `Glossary` over everything the session has (spec §6.8): it loads the on-demand tools.
    const others = (): readonly CoreToolDef[] => (this.#d.coreTools?.(ctx, origin) ?? []).filter((t) => t.name !== GLOSSARY_TOOL_NAME).map((t) => this.#endTurnAware(t));
    const glossary = glossaryTool({
      tools: () => [...ON_DEMAND_BUILTINS, ...others(), ...mergedServers(this.#mcpServers(), undefined, this.#reservedNames()).flatMap((s) => s.tools.map((t) => ({ name: `mcp__${s.server}__${t.name}`, ...(t.description === undefined ? {} : { description: t.description }), inputSchema: t.inputSchema })))],
      ...(this.#d.registry === undefined ? {} : { registry: this.#d.registry }),
      // A plugin's skills and agent definitions reach the session its `scope` serves (`servesScope`: an `agents` plugin's
      // no bot's, an `own-bot` one's only its own bot's) and, for an agent's or a coding session, only from plugins whose
      // `onlyBackends` name MOSS's own backend, which runs it (only-backends.ts).
      ...(this.#d.registry === undefined ? {} : { serves: (pluginId: string, entryScope?: unknown) => partsServe(this.#d.registry!, pluginId, { kind: ctx.kind, bot: bot.id }, entryScope) }),
      // What each plugin offers (its servers' tools and instructions), and its builder's own stopped plugins.
      servers: () => mergedServers(this.#mcpServers(), undefined, this.#reservedNames()),
      bot: bot.id,
    });
    mcpServers.moss_core = coreToolsServer(() => [...others(), glossary]);
    // What the conversation shows of a plugin tool beside its real name (`runtime-sdk/tool-display.ts`): its title, by
    // the runtime's name, and what its successful result showed, by call id. Display only: the cards, the rules and
    // the reviewer read the served name, never these.
    const titles = new Map<string, string>();
    const displays = new ToolDisplays();
    const apps = new ToolApps();
    if (this.#d.mcp !== undefined) {
      for (const server of merged) {
        if (server.server === "moss_core" || mcpServers[server.server] !== undefined) continue;
        for (const t of server.tools) if (t.title !== undefined) titles.set(`mcp__${server.server}__${t.name}`, t.title);
        mcpServers[server.server] = routedMcpServer({
          server, runner: this.#d.mcp.runner, session: ctx.sessionId, as: ctx.caller, callIds: this.#callIdSource, displays,
          apps: this.#appsFor(ctx, origin, server, apps),
          ...(this.#d.epoch === undefined ? {} : { epoch: () => this.#d.epoch!() }),
        });
      }
    }
    this.#builtServers = serversSignature(this.#d.mcp === undefined ? [] : merged);
    const cwd = ctx.paths.scratch;
    mkdirSync(cwd, { recursive: true });
    const queue = createHostPromptQueue();
    const abort = new AbortController();
    const testProvider = testProviderNameFor(bot.model);
    const sandbox = hostSandbox !== undefined ? hostSandbox.settings : this.#hostSandbox();
    this.#builtSandbox = canonicalSandbox(sandbox);
    this.#builtModel = modelKey(bot);
    this.#builtCatalog = { provider: providerOfModel(bot.model), key: this.#catalogKey(providerOfModel(bot.model)) };
    this.#catalogHeldSaid = undefined;
    this.#builtInstructions = bot.instructions;
    this.#instructionsHeldSaid = undefined;
    const base = embeddedSessionOptions(this.#d, { model: bot.model, ...(bot.effort === undefined ? {} : { effort: bot.effort }), cwd });
    const options: Options = {
      ...base,
      systemPrompt,
      tools: [...BOT_BUILTIN_TOOLS],
      // `Glossary` finds and loads what isn't loaded (the agent SDK's `hostToolSearch`); `Glob` and `Grep` start
      // on-demand (§6.7 [D]), as do plugin tools their manifest doesn't preload.
      hostToolSearch: GLOSSARY_TOOL_NAME,
      toolSearchEnabled: true,
      deferTools: ON_DEMAND_BUILTINS.map((t) => t.name),
      mcpServers,
      canUseTool: this.#gatedCanUseTool(this.#d.canUseTool(ctx, origin)),
      // The driver's hooks first, the base's kept but never allowing, and the pause and the lease again last, behind any
      // hook the runtime ranks first (hook-merge.ts).
      hooks: mergedHooks(base.hooks, this.#toolHooks(), { last: { PreToolUse: [this.#trailingGate(), this.#treeHandOff()] } }),
      permissionMode: "default",
      abortController: abort,
      includePartialMessages: true,
      // The runtime's stderr is the session's content (an error echoing a request, a tool's output): kept with the session's
      // runtime state and deleted with it, never copied into the engine log (the deletion lane, item 6).
      stderr: runtimeStderrSink({ home: this.#d.home, sessionId: ctx.sessionId, log: this.#log }),
      additionalDirectories: [ctx.paths.root],
      // The host's sandbox, or the runtime's default floor, with the bot's own floor over it (`botSandbox`: `BOT_SANDBOX`
      // last, the file tools held to the write roots): nothing a host asks for turns it off. A command of a bot's own
      // conversation with the user present may leave it when the person approves it on its own card
      // (`BOT_CONVERSATION_SANDBOX`, set after `botSandbox()`): the runtime then honors the call's flag, and every such
      // call was already forced to the check by the PreToolUse hook above. Anything else (a side thread, a subagent,
      // the coding agent) keeps `BOT_SANDBOX`: its commands never leave it, and a call asking to is refused by its
      // approval check. Their commands never get launchd to start what the pause can't stop (F8). The user's secret
      // places and the MOSS home's key places are read-denied in it whatever the host gives (`withSecretReads`,
      // `withBotKeyReads`): Read, Grep, Glob and the shell all meet them.
      sandbox: this.#ctx.kind === "bot"
        ? { ...botSandbox(withBotKeyReads(withSecretReads(sandbox, this.#fileFence), this.#fileFence), this.#denyFormsHome()), ...BOT_CONVERSATION_SANDBOX }
        : botSandbox(withBotKeyReads(withSecretReads(sandbox, this.#fileFence), this.#fileFence), this.#denyFormsHome()),
      // Every notification the runtime delivers, a completion or a Monitor event folded into a running turn included,
      // opens with the same "data, not instructions" frame as the core's own (agent SDK 0.0.71).
      notificationPreamble: TASK_NOTIFICATION_FRAME,
      ...(resume ? { resume: state.backendSessionId } : { sessionId: state.backendSessionId }),
    };
    // Through the guarded fill (`fillProvider`): the provider sets the model's own keys and nothing else.
    if (testProvider === undefined && this.#d.provider !== undefined) await fillProvider({ provider: (m, o) => this.#d.provider!(m, o, ctx) }, options);
    const q = (this.#d.query ?? sdkQuery)({ prompt: queue, options });
    this.#generation += 1;
    let claimed = 0;
    const projector = createProjector({
      sessionId: ctx.sessionId, mode: "chat", generation: this.#generation, winterSessionId: ctx.sessionId, runtimeKind: "winter-agent",
      nextSeq: () => ++claimed,
      checkpoint: { begin: () => "begun", complete: () => undefined },
      now: () => new Date().toISOString(),
      log: { warn: (message, fields) => this.#log(`bot driver ${ctx.sessionId}: ${message} ${fields === undefined ? "" : JSON.stringify(fields)}`.trim()) },
      toolDisplayTitle: (name) => titles.get(name),
      takeToolDisplay: (callId) => displays.take(callId),
      takeToolApp: (callId) => apps.take(callId),
    });
    const inc: Incarnation = { query: q, queue, abort, projector, displays, apps, pump: Promise.resolve(), closed: false, tasks: new Set(), stopping: new Set(), ended: [], wakes: [] };
    inc.pump = this.#pump(inc);
    this.#rebuild = false;
    return inc;
  }

  /** MCP Apps: for one plugin server of this session, what happens when a call of its succeeds: a tool that names a page is
   *  bound (the site: this server's doors only, a page's call asking this session's own gate, hooks and approval). */
  #appsFor(ctx: BotSessionContext, origin: () => TurnOrigin | undefined, server: BotMcpServer, apps: ToolApps): { put: (callId: string, call: { tool: string; input: Record<string, unknown>; result: { content: unknown[]; isError?: boolean } }) => void; drop: (callId: string) => void } | undefined {
    const svc = this.#d.mcpApps;
    const ui = this.#d.mcp?.ui;
    const runner = this.#d.mcp?.runner;
    if (svc === undefined || ui === undefined || runner === undefined) return undefined;
    // The driver's own pieces: a page's call goes through the very functions a model's call does (`page-calls.ts`).
    const doors: PageCallDoors = {
      preTool: (raw, id, signal) => this.#preTool(raw, id, signal),
      postTool: (raw, id, signal) => this.#postTool(raw, id, signal),
      dropCallId: (name, id) => this.#dropCallId(name, id),
      canUse: (pageCtx) => this.#gatedCanUseTool(this.#d.canUseTool(pageCtx, origin)),
    };
    return {
      drop: (callId) => apps.drop(callId),
      put: (callId, call) => {
        const resourceUri = server.tools.find((t) => t.name === call.tool)?.ui?.resourceUri;
        if (resourceUri === undefined) return;
        const site: AppSite = {
          pluginId: server.plugin, server: server.server, tool: call.tool, resourceUri, input: call.input, result: call.result,
          listTools: async () => ui.tools(server.server, call.tool).map((t) => ({ name: t.name, ...(t.ui === undefined ? {} : { _meta: { ui: t.ui } }) })),
          readResource: (uri) => ui.read(server.server, call.tool, uri, ctx.caller),
          ...botPageCalls({ ctx, server, runner, doors }),
        };
        apps.put(callId, svc.bind(ctx.sessionId, callId, site));
      },
    };
  }

  async #pump(inc: Incarnation): Promise<void> {
    try {
      for await (const msg of inc.query) this.#accept(inc, msg as Record<string, unknown>);
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: the runtime ended: ${err instanceof Error ? err.message : String(err)}`);
      const t = this.#turn;
      if (t !== undefined && this.#inc === inc) {
        for (const e of inc.projector.acceptError(err).persist) this.#emit(e);
        t.finish({ reason: t.interrupted ? "interrupted" : "failed", failure: "crashed", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      inc.closed = true;
      if (this.#inc === inc) this.#inc = undefined;
      const t = this.#turn;
      if (t !== undefined && !t.ended) t.finish({ reason: t.interrupted ? "interrupted" : this.#stopped ? "stopped" : "failed", failure: "crashed", text: "the runtime ended during the turn" });
    }
  }

  #emit(event: { type: string; [k: string]: unknown }): void {
    if (HOST_OWNED.has(event.type)) return;
    const t = this.#turn;
    // A turn the runtime runs on its own (a background task's notification) has no host turn: where the host takes
    // wakes (lane D's `ctx.wake`), `#promptHold` hands it over before it runs, and nothing reaches here; where it
    // doesn't, that turn's records are dropped (it was held while paused, and ran after).
    if (t === undefined || t.ended) return;
    // While a `message.out` hook is on, the bot's text shows only after it ran (§5.3): no streaming deltas, and each
    // record waits its turn behind the reply before it, so the log keeps the runtime's order.
    if (this.#hooks.rewritesReplies()) {
      if (event.type === "assistant_delta") return;
      const ctl = t.ctl;
      this.#recordChain = this.#recordChain.then(async () => {
        if (event.type === "assistant_message" && typeof event.text === "string") {
          const text = await this.#hooks.messageOut(this.#hookSession, event.text).catch(() => event.text as string);
          ctl.record({ ...event, text });
          this.#heard(text);
        } else ctl.record(event);
      });
      t.pending = this.#recordChain;
      return;
    }
    t.ctl.record(event);
    if (event.type === "assistant_message" && typeof event.text === "string") this.#heard(event.text);
  }

  /** A reply stored: the `message.out` hooks that only observe hear it (with the bot and the session), never awaited. */
  #heard(text: string): void {
    try {
      this.#hooks.hearReply?.(this.#hookSession, text);
    } catch { /* an observer never fails the turn */ }
  }

  #accept(inc: Incarnation, msg: Record<string, unknown>): void {
    const batch = inc.projector.accept(msg as never);
    const t = this.#turn;
    const main = !(typeof msg.parent_tool_use_id === "string" && msg.parent_tool_use_id.length > 0);
    if (msg.type === "system" && typeof msg.task_id === "string") {
      // Every task but a foreground command the runtime tracks (`is_backgrounded: false`), which is a running tool call
      // the pause never cuts off; one moved to the background later counts from then. A task whose start doesn't say
      // (a WebSocket monitor) counts.
      const patch = msg.subtype === "task_updated" ? (msg.patch as { is_backgrounded?: unknown } | undefined) : undefined;
      if ((msg.subtype === "task_started" && msg.is_backgrounded !== false) || patch?.is_backgrounded === true) {
        inc.tasks.add(msg.task_id);
        this.#tasksChanged(inc);
        this.#watchTasks(inc);
      } else if (msg.subtype === "task_notification") {
        inc.tasks.delete(msg.task_id);
        this.#tasksChanged(inc);
        // Its notification reaches the model inside a running turn (after a tool round), or as a turn of the runtime's
        // own, which `#promptHold` hands to the host. Kept for that.
        const status = msg.status === "failed" || msg.status === "stopped" ? msg.status : "completed";
        const summary = typeof msg.summary === "string" ? msg.summary : `Background task ${msg.task_id} ${status}.`;
        const out = typeof msg.output_file === "string" ? `\nIts output: ${msg.output_file}` : "";
        inc.ended.push({ task: msg.task_id, status, text: `${summary}${out}` });
        if (inc.ended.length > 64) inc.ended.splice(0, inc.ended.length - 64);
      }
    }
    // In-turn compaction: the runtime's own, when the context fills (§6.3).
    if (main && msg.type === "system" && msg.subtype === "status" && msg.status === "compacting") {
      this.#emit({ type: "compaction", phase: "started", reason: "full" });
      void this.#hooks.compactBefore(this.#hookSession).catch(() => {});
    }
    if (main && msg.type === "system" && msg.subtype === "compact_boundary") {
      this.#emit({ type: "compaction", phase: "ended", reason: "full" });
      this.#rebuild = true;
      void this.#hooks.compactAfter(this.#hookSession).catch(() => {});
    }
    for (const e of batch.broadcast) this.#emit(e as never);
    for (const e of batch.persist) this.#emit(e as never);
    // The runtime's own turn `#promptHold` ended for the host: its wake goes now, and its result is no host turn's.
    if (main && msg.type === "result" && msg.terminal_reason === "hook_stopped" && inc.wakes.length > 0) {
      const w = inc.wakes.shift()!;
      const ctx = this.#ctx as WakeContext;
      void Promise.resolve().then(() => ctx.wake?.(w)).catch((err: unknown) => this.#log(`bot driver ${ctx.sessionId}: the host refused a background task's wake: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    // A turn the runtime ran on its own (a background task's notification), with no host turn: its holds on the
    // computers' screens go at its end too.
    if (main && msg.type === "result" && (t === undefined || t.ended)) {
      void Promise.resolve().then(() => this.#d.holds?.releaseSession(this.#ctx.sessionId)).catch((err: unknown) => this.#log(`bot driver ${this.#ctx.sessionId}: releasing holds failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    if (t === undefined || t.ended) return;
    const folded = hostInputFoldedCount(msg);
    if (folded !== undefined) {
      const n = Math.min(folded, t.unfolded.length);
      t.unfolded.splice(0, n);
      t.owed -= n;
      return;
    }
    if (main && msg.type === "result") {
      // The runtime's turn is over: every result it reported has been projected, so a display still waiting belongs to
      // a call that was cancelled, timed out or never reported; it goes now, never onto a later call.
      inc.displays.clear();
      inc.apps.clear();
      const usage = msg.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
      t.usage.inputTokens += (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
      t.usage.outputTokens += usage?.output_tokens ?? 0;
      const ctxTokens = msg.context_tokens;
      if (typeof ctxTokens === "number" && Number.isInteger(ctxTokens) && ctxTokens > 0) t.usage.contextTokens = ctxTokens;
      if (typeof msg.result === "string") t.text = msg.result;
      t.owed -= 1;
      const interrupted = msg.interrupted === true || t.interrupted;
      // A push the runtime didn't fold runs as its next turn, which this host turn covers.
      if (!interrupted && t.owed > 0 && t.unfolded.length > 0) {
        t.unfolded.shift();
        return;
      }
      if (interrupted) {
        t.finish({ reason: "interrupted", usage: { ...t.usage }, ...(t.text === undefined ? {} : { text: t.text }) });
        return;
      }
      const terminal = msg.terminal_reason;
      if (terminal === "hook_stopped" && t.heldOff !== undefined) {
        t.finish({ reason: "stopped", text: t.heldOff });
        return;
      }
      const isError = msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype.startsWith("error_"));
      if (terminal === "refusal") t.finish({ reason: "refusal", usage: { ...t.usage }, ...(t.text === undefined ? {} : { text: t.text }) });
      else if (isError) t.finish({ reason: "failed", failure: "error", usage: { ...t.usage }, text: typeof msg.result === "string" && msg.result !== "" ? msg.result : `the turn failed (${String(msg.subtype)})` });
      else t.finish({ reason: "end_turn", usage: { ...t.usage }, ...(t.text === undefined ? {} : { text: t.text }) });
    }
  }

  async #ensureOpen(): Promise<Incarnation> {
    const coldCache = (() => {
      try {
        return this.#ctx.cacheCold();
      } catch {
        return false;
      }
    })();
    // The host's sandbox now. One that can't be read (it throws, or the host has a sandbox and gives none) fails the
    // turn, and the runtime open under the old one is closed first: nothing runs on a stale sandbox.
    let settings: SandboxSettingsConfig | undefined;
    try {
      settings = this.#hostSandbox();
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: the sandbox could not be read: ${err instanceof Error ? err.message : String(err)}`);
      if (this.#inc !== undefined) {
        await this.#closeIncarnation(this.#inc);
        this.#inc = undefined;
      }
      throw err;
    }
    const open = this.#inc !== undefined && !this.#inc.closed;
    const sandboxChanged = open && canonicalSandbox(settings) !== this.#builtSandbox;
    // The bot's model now (a model switch, its manifest's or the user's): a new model reopens the runtime, resuming
    // the transcript, with its own provider and credential allowlist. One that can't be read is taken as changed.
    // An effort change alone goes to the open runtime live (`setEffort`, applied at its next quiescent boundary,
    // which a turn start is): the model, its provider and its allowlist are unchanged, so nothing reopens. A runtime
    // without it, or one that refuses the level, reopens with it.
    let modelChanged = false;
    if (open) {
      try {
        const bot = this.#ctx.current();
        const now = modelKey(bot);
        if (now !== this.#builtModel) {
          modelChanged = !(this.#builtModel !== undefined && modelOf(this.#builtModel) === bot.model && await this.#setEffortLive(this.#inc!, bot.effort));
          if (!modelChanged) this.#builtModel = now;
        }
      } catch { modelChanged = true; }
    }
    // The session's MCP servers now, as the sandbox: a set that can't be read fails the turn, and the runtime open under
    // the old set is closed first, so no tool of a server that went keeps answering.
    let serversChanged = false;
    try {
      serversChanged = open && this.#serversChanged();
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: its MCP servers could not be read: ${err instanceof Error ? err.message : String(err)}`);
      if (this.#inc !== undefined) {
        await this.#closeIncarnation(this.#inc);
        this.#inc = undefined;
      }
      throw err;
    }
    // Its own provider's key moved. Held back while the runtime runs background work (a shell, a monitor, an agent),
    // which a reopen would end, unless the provider became unusable (`absent`): its next turn's error then says why.
    let catalogChanged = false;
    if (open && this.#builtCatalog !== undefined) {
      const now = this.#catalogKey(this.#builtCatalog.provider);
      if (now !== this.#builtCatalog.key) {
        if (this.#inc!.tasks.size > 0 && now !== "absent") {
          if (this.#catalogHeldSaid !== now) this.#log(`bot driver ${this.#ctx.sessionId}: its provider ${this.#builtCatalog.provider} changed; it reopens once its background work ends`);
          this.#catalogHeldSaid = now;
        } else {
          catalogChanged = true;
        }
      }
    }
    // Its instructions now: an edit reaches the next turn, not only the next compaction (which refuses a conversation
    // inside its retention window). Held back while background work runs, which a reopen would end.
    let instructionsChanged = false;
    if (open && this.#builtInstructions !== undefined) {
      let now: string | undefined;
      try {
        now = this.#ctx.current().instructions;
      } catch { now = undefined; }
      if (now !== undefined && now !== this.#builtInstructions) {
        if (this.#inc!.tasks.size > 0) {
          if (this.#instructionsHeldSaid !== now) this.#log(`bot driver ${this.#ctx.sessionId}: its instructions changed; it reopens once its background work ends`);
          this.#instructionsHeldSaid = now;
        } else {
          instructionsChanged = true;
        }
      }
    }
    if (open && !this.#rebuild && !coldCache && !sandboxChanged && !modelChanged && !serversChanged && !catalogChanged && !instructionsChanged) return this.#inc!;
    if (sandboxChanged) this.#log(`bot driver ${this.#ctx.sessionId}: reopening: sandbox changed`);
    if (modelChanged) this.#log(`bot driver ${this.#ctx.sessionId}: reopening: model changed`);
    if (catalogChanged) this.#log(`bot driver ${this.#ctx.sessionId}: reopening: its provider ${this.#builtCatalog?.provider} changed in the model plugins`);
    if (instructionsChanged) this.#log(`bot driver ${this.#ctx.sessionId}: reopening: its instructions changed`);
    // A rebuild resumes the transcript under the new prompt; the old runtime ends first (one engine per transcript).
    if (this.#inc !== undefined) await this.#closeIncarnation(this.#inc);
    this.#inc = await this.#open({ settings });
    return this.#inc;
  }

  /** What the model plugins give a session on `provider` now (`BotDriverDeps.modelCatalogKey`). */
  #catalogKey(provider: string): string {
    return this.#d.modelCatalogKey?.(provider) ?? modelProviderKey(provider);
  }

  /** Whether the session's MCP servers differ from the set the open runtime got (an install, an enable, a removal):
   *  the agent SDK takes `mcpServers` only when a runtime opens, so it then reopens before the turn. A set that can't be
   *  read throws (`#ensureOpen` fails the turn), never "unchanged". */
  #serversChanged(): boolean {
    if (this.#d.mcp === undefined || this.#builtServers === undefined) return false;
    const now = serversSignature(mergedServers(this.#mcpServers(), undefined, this.#reservedNames()));
    if (now === this.#builtServers) return false;
    this.#log(`bot driver ${this.#ctx.sessionId}: reopening: its MCP servers changed`);
    return true;
  }

  /** The host's sandbox for this session now; undefined only when the host gives none at all (the runtime's floor and
   *  `BOT_SANDBOX`). A host that has a sandbox and answers undefined fails closed: it throws, never "floor only". */
  #hostSandbox(): SandboxSettingsConfig | undefined {
    if (this.#d.sandbox === undefined) return undefined;
    const settings = this.#d.sandbox(this.#ctx);
    if (settings === undefined) throw new Error("the host gave no sandbox for this session");
    // What it left out (Linux, lane XC 3c): a refused write's result says why (`#postTool`). A change of it changes
    // `allowWrite`, so the runtime reopens on the settings read here.
    this.#leftOut = leftOutRoots(settings);
    return settings;
  }

  /** The bot's new effort, on the open runtime: true when it took it; false (logged) when it has no `setEffort` or
   *  refused the level, and the runtime then reopens with it. */
  async #setEffortLive(inc: Incarnation, effort: string | undefined): Promise<boolean> {
    const set = (inc.query as { setEffort?: (e?: string | null) => Promise<void> }).setEffort;
    if (typeof set !== "function") {
      this.#log(`bot driver ${this.#ctx.sessionId}: reopening: effort changed, and this runtime can't change it live`);
      return false;
    }
    try {
      await set.call(inc.query, effort ?? null);
      this.#log(`bot driver ${this.#ctx.sessionId}: effort changed live (${effort ?? "default"})`);
      return true;
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: reopening: the runtime refused the effort live (${err instanceof Error ? err.name : "Error"})`);
      return false;
    }
  }

  async #closeIncarnation(inc: Incarnation): Promise<void> {
    this.#releasePromptHolds("closing");
    if (inc.taskWatch !== undefined) clearInterval(inc.taskWatch);
    inc.taskWatch = undefined;
    if (!inc.queue.closed) inc.queue.close();
    const grace = this.#d.stopGraceMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([inc.pump, new Promise<void>((r) => { timer = setTimeout(r, grace); })]);
    if (timer !== undefined) clearTimeout(timer);
    if (!inc.closed) {
      inc.abort.abort();
      await Promise.race([inc.pump, new Promise<void>((r) => setTimeout(r, 1_000))]);
    }
    if (this.#inc === inc) this.#inc = undefined;
    // Its runtime is gone, and its background tasks with it.
    inc.tasks.clear();
    this.#tasksChanged(inc);
  }

  /** Tells the observer how many background tasks the session runs now. */
  #tasksChanged(inc: Incarnation): void {
    if (this.#inc !== undefined && this.#inc !== inc) return;
    try { this.#d.observe?.tasks?.(this.#ctx, inc.tasks.size); } catch { /* an observer never fails the session */ }
  }

  /** While background tasks run, looks at the pause; once it says no, they are stopped (`#stopTasks`). */
  #watchTasks(inc: Incarnation): void {
    if (inc.taskWatch !== undefined) return;
    const look = () => {
      if (inc.closed || inc.tasks.size === 0 || this.#inc !== inc) {
        if (inc.taskWatch !== undefined) clearInterval(inc.taskWatch);
        inc.taskWatch = undefined;
        return;
      }
      if (this.#ctx.mayAct()) return;
      // Kept looking while tasks remain and the pause holds: a stop that failed is tried again at the next look.
      void this.#stopTasks(inc);
    };
    inc.taskWatch = setInterval(look, this.#d.pausePollMs ?? PAUSE_POLL_MS);
    (inc.taskWatch as { unref?: () => void }).unref?.();
    look();
  }

  /** The pause stops the session's background shells and monitors (the owner's rule), as the host (the model is told
   *  "stopped by the host" when its turn may start again). Resuming doesn't restart them. */
  async #stopTasks(inc: Incarnation): Promise<void> {
    for (const id of [...inc.tasks]) {
      if (inc.stopping.has(id)) continue;
      inc.stopping.add(id);
      try {
        if (typeof inc.query.stopTask !== "function") throw new Error("this runtime can't stop a task (agent SDK 0.0.69's stopTask)");
        await inc.query.stopTask(id, { by: "host" });
        inc.tasks.delete(id);
        this.#tasksChanged(inc);
      } catch (err) {
        // A task the runtime no longer has (it ended meanwhile) is done with; any other failure is tried again.
        if (isUnknownTask(err)) {
          inc.tasks.delete(id);
          this.#tasksChanged(inc);
        }
        else this.#log(`bot driver ${this.#ctx.sessionId}: stopping background task ${id} failed (tried again while paused): ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        inc.stopping.delete(id);
      }
    }
  }

  #push(inc: Incarnation, text: string): void {
    for (const e of inc.projector.beginTurn({ text }).persist) this.#emit(e as never);
    inc.queue.push(text);
  }

  async turn(input: TurnInput, ctl: TurnControl): Promise<TurnEnd> {
    if (this.#stopped) return { reason: "stopped" };
    this.#origin = ctl.origin;
    const hs = this.#hookSession;
    let inc: Incarnation;
    // A server just installed or enabled is listed first (briefly), so the open below gives the runtime its tools.
    await this.#d.mcp?.settled?.().catch(() => {});
    try {
      inc = await this.#ensureOpen();
    } catch (err) {
      return { reason: "failed", failure: "error", text: `the runtime could not start: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      this.#d.observe?.turn?.(this.#ctx, ctl.origin);
      this.#d.observe?.input?.(this.#ctx, input);
    } catch { /* an observer never fails the turn */ }
    const notes = await this.#hooks.turnStart(hs, ctl.signal).catch(() => []);
    const first = await this.#hooks.messageIn(hs, formatTurnInput(input, this.#ctx.kind), ctl.signal).catch(() => formatTurnInput(input, this.#ctx.kind));
    const nowServers = this.#promptServers(keptServers(this.#mcpServers(), this.#reservedNames()));
    const mcpNote = mcpChangesSince(this.#builtMcp, nowServers);
    if (mcpNote !== undefined) this.#builtMcp = mcpFingerprint(nowServers);
    const carried = this.#carry.splice(0);
    const lead = [
      ...(mcpNote === undefined ? [] : [mcpNote]),
      ...notes.map((n) => formatTurnInput({ from: "note", label: n.label, text: n.text, by: { kind: "hook", pluginId: n.pluginId, hook: n.hook } }, this.#ctx.kind)),
      ...carried,
    ];
    const text = lead.length === 0 ? first : `${lead.join("\n\n")}\n\n${first}`;
    if (ctl.signal.aborted) return { reason: "interrupted" };
    this.#continueWith = undefined;
    let end = await this.#runtimeTurn(inc, text, ctl);
    // A core tool ended the runtime's turn to go on (`CoreToolResult.endTurn`): the runtime opens again if the host's
    // sandbox changed (`#ensureOpen`), and a new runtime turn led by the tool's note runs inside this host turn. No new
    // turn for the observers (a fetch budget never starts again here) nor for the plugins' turn hooks.
    for (let n = 0; this.#continueWith !== undefined && n < MAX_CONTINUATIONS; n++) {
      const note = this.#continueWith;
      this.#continueWith = undefined;
      if (end.reason !== "end_turn" || ctl.signal.aborted || this.#stopped) break;
      try {
        inc = await this.#ensureOpen();
      } catch (err) {
        end = { reason: "failed", failure: "error", text: `the runtime could not open again: ${err instanceof Error ? err.message : String(err)}` };
        break;
      }
      const before = end.usage;
      end = await this.#runtimeTurn(inc, formatTurnInput({ from: "note", label: "MOSS", text: note, by: { kind: "core" } }, this.#ctx.kind), ctl);
      if (before !== undefined) {
        end = { ...end, usage: { inputTokens: before.inputTokens + (end.usage?.inputTokens ?? 0), outputTokens: before.outputTokens + (end.usage?.outputTokens ?? 0), ...(end.usage?.contextTokens === undefined ? {} : { contextTokens: end.usage.contextTokens }) } };
      }
    }
    this.#continueWith = undefined;
    // What a `message.out` hook held back is recorded before the turn ends.
    await this.#recordChain.catch(() => {});
    await this.#settleTurn(end);
    return end.text === undefined ? end : { ...end, text: await this.#hooks.messageOut(hs, end.text).catch(() => end.text!) };
  }

  /** A core tool whose result asks the turn to go on (`endTurn`) noted for `turn`, while a host turn runs. */
  #endTurnAware(t: CoreToolDef): CoreToolDef {
    return {
      ...t,
      run: async (input, extra) => {
        const r = await t.run(input, extra);
        if (r.endTurn !== undefined && this.#turn !== undefined && !this.#turn.ended) this.#continueWith = r.endTurn.note;
        return r;
      },
    };
  }

  /** One runtime turn of a host turn: `text` pushed, inputs folded into it, until its result. */
  #runtimeTurn(inc: Incarnation, text: string, ctl: TurnControl): Promise<TurnEnd> {
    const hs = this.#hookSession;
    return new Promise<TurnEnd>((resolve) => {
      const t: RunningTurn = {
        ctl, owed: 1, unfolded: [], usage: { inputTokens: 0, outputTokens: 0 }, interrupted: false, ended: false, first: text,
        offFold: () => {}, offAbort: () => {},
        finish: (e) => {
          if (t.ended) return;
          t.ended = true;
          t.offFold();
          t.offAbort();
          if (this.#turn === t) this.#turn = undefined;
          resolve(e);
        },
      };
      this.#turn = t;
      const onAbort = () => void this.interrupt();
      ctl.signal.addEventListener("abort", onAbort, { once: true });
      t.offAbort = () => ctl.signal.removeEventListener("abort", onAbort);
      try {
        this.#push(inc, text);
      } catch (err) {
        t.finish({ reason: "failed", failure: "crashed", text: err instanceof Error ? err.message : String(err) });
        return;
      }
      t.offFold = ctl.onFold((folded) => {
        try { this.#d.observe?.input?.(this.#ctx, folded); } catch { /* an observer never fails the turn */ }
        const raw = formatTurnInput(folded, this.#ctx.kind);
        void this.#hooks.messageIn(hs, raw, ctl.signal).catch(() => raw).then((tx) => {
          // Taken after the turn ended (a slow hook): it leads the next turn instead.
          if (t.ended || t.interrupted || this.#inc !== inc || inc.queue.closed) {
            this.#carry.push(tx);
            return;
          }
          t.owed += 1;
          t.unfolded.push(tx);
          this.#push(inc, tx);
        });
      });
    });
  }

  async #settleTurn(end: TurnEnd): Promise<void> {
    const session = this.#ctx.sessionId;
    try {
      await this.#d.holds?.releaseSession(session);
    } catch (err) {
      this.#log(`bot driver ${session}: releasing holds failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.#hooks.turnEnd(this.#hookSession, end.text, turnOutcomeOf(end.reason)).catch(() => {});
    this.#callIds.clear();
  }

  async interrupt(): Promise<void> {
    const t = this.#turn;
    const inc = this.#inc;
    if (t === undefined || t.ended || inc === undefined) return;
    if (t.interrupted) return;
    t.interrupted = true;
    // What was pushed to fold and not yet taken is cleared from the runtime and leads the next turn (§6.4: other
    // bots' messages are never lost to the user's interrupt).
    if (t.unfolded.length > 0 && typeof inc.query.clearQueuedInput === "function") {
      try {
        const { cleared } = await inc.query.clearQueuedInput();
        const n = typeof cleared === "number" ? Math.min(cleared, t.unfolded.length) : 0;
        if (n > 0) this.#carry.push(...t.unfolded.splice(t.unfolded.length - n, n));
      } catch {
        // an older runtime: they run as its next turns, inside this one
      }
    }
    try {
      await inc.query.interrupt();
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A turn the pause holds at its start ends without a request (`#promptHold`).
    this.#releasePromptHolds("interrupt");
  }

  async compact(req: { reason: "cache" | "full" | "user"; signal: AbortSignal }): Promise<{ compacted: boolean }> {
    if (this.#stopped || req.signal.aborted) return { compacted: false };
    // A compaction is a model request: none while the pause holds or this computer doesn't run the bot (lane D's host
    // asks `mayStart` first too).
    if (!this.#ctx.mayAct()) return { compacted: false };
    const state = this.#readState();
    if (this.#inc === undefined && !(await this.#hasTranscript(state.backendSessionId))) return { compacted: false };
    const inc = await this.#ensureOpen();
    if (typeof inc.query.compact !== "function") return { compacted: false };
    await this.#hooks.compactBefore(this.#hookSession).catch(() => {});
    let off: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      const on = () => resolve("aborted");
      req.signal.addEventListener("abort", on, { once: true });
      off = () => req.signal.removeEventListener("abort", on);
    });
    try {
      const r = await Promise.race([inc.query.compact().then(() => "done" as const), aborted]);
      if (r === "aborted") return { compacted: false };
    } catch (err) {
      this.#log(`bot driver ${this.#ctx.sessionId}: compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      return { compacted: false };
    } finally {
      off?.();
    }
    // The harness blocks (the MCP block, the devices, the memory index, the instructions) rebuild at the next turn.
    this.#rebuild = true;
    await this.#hooks.compactAfter(this.#hookSession).catch(() => {});
    return { compacted: true };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.interrupt();
    const inc = this.#inc;
    if (inc !== undefined) await this.#closeIncarnation(inc);
    const session = this.#ctx.sessionId;
    for (const step of [() => this.#d.terminals?.closeSession(session), () => this.#d.holds?.releaseSession(session)]) {
      try {
        await step();
      } catch (err) {
        this.#log(`bot driver ${session}: ending failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Lets the runtime go without ending the session (a shutdown): it resumes with the next daemon. */
  async release(): Promise<void> {
    const inc = this.#inc;
    if (inc !== undefined) await this.#closeIncarnation(inc);
  }
}

/** Lane D's `DriverFactory` for bots and side threads. */
export function botDriverFactory(deps: BotDriverDeps): (ctx: BotSessionContext) => BotSessionDriver {
  return (ctx) => new BotSessionDriver(ctx, deps);
}

/** Whether the driver's state for a session exists (a test's check). */
export function botDriverStateExists(home: string, sessionId: string): boolean {
  return existsSync(join(home, "sessions-runtime", `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`));
}

/** A list whose order means nothing: the paths, hosts, sockets and commands a sandbox allows or denies. Any other
 *  list (`ripgrep.args`, say) keeps its order. */
const UNORDERED_SANDBOX_LIST = /^(allow|deny|excluded)/i;

/** A sandbox as canonical JSON: keys sorted, the unordered lists sorted, every other list in its order, and an
 *  undefined list entry as null, so the same settings compare equal however they were built. */
export function canonicalSandbox(sandbox: unknown): string {
  const norm = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) {
      const items = v.map((x) => (x === undefined ? null : norm(x)));
      return key !== undefined && UNORDERED_SANDBOX_LIST.test(key) ? items.map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x) as unknown) : items;
    }
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, norm((v as Record<string, unknown>)[k], k)]));
    return v;
  };
  return JSON.stringify(norm(sandbox ?? null));
}

/** A bot's model and effort as the runtime was opened with them. */
function modelKey(bot: { model: string; effort?: string }): string {
  return `${bot.model}\u0000${bot.effort ?? ""}`;
}

/** The model part of a `modelKey`. */
/** The provider of a model tag (`<provider>/<model>`); the whole tag when it has none. */
function providerOfModel(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
}

function modelOf(key: string): string {
  return key.slice(0, key.indexOf("\u0000"));
}
