// MOSS protocol area: agents (spec §9.3). Owner: lane K (the Agent tool, ACP backends, the bridge). Pinned by lane
// B at M0, from spike S5 (lane K's report of November 5, §8 "For the spine").
//
// A background agent is a session like any other (`session.*` in sessions.ts): `SendMessage` becomes its next
// prompt, `TaskStop` is `session.stop`, and its task notification is `agent_finished`. Bots start agents with the
// `Agent` tool, in-process; the user starts a coding session directly with `agent.start` (`moss code`). An ACP
// agent reaches MOSS's plugins only through one bridge MCP server, whose connection (role `bridge`) is bound to
// that agent session by its token: its tools, `SendMessage` and `Glossary` (glossary.query, plugins.ts), nothing
// else. Everything handed to an agent counts as stored in plain text; the bridge token is the only secret, in the
// bridge entry's `env` (S5 edit 4).
import { z } from "zod";
import { utf16 } from "./strings";
import { AnyPluginId, ComputerName, Empty, Ok, SessionId, Text, Timestamp, TreePath } from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";
import { LIST_SESSIONS_MAX, ReachableSession } from "./reach";

/** Facts Settings marks on a backend (S5 edit 4, edit 6; §9.3 "Settings marks it"). */
export const BackendMark = z.enum([
  /** It stores what it is given (env, headers, prompts) in plain text (Antigravity). */
  "stores-plain-text",
  /** It hands its whole environment to the servers it starts (Antigravity). */
  "passes-environment",
  /** It can't take the fenced set as a deny list in its own settings (§9.3). */
  "no-deny-list",
  /** It has no sandbox on this computer, so it starts only after the user's OK (§9.3). */
  "unsandboxed",
  /** Some of its actions never reach a card (Cursor: edits and allowlisted commands inside the root, S5 edit 6). */
  "unasked-actions",
  /** A delegation's model choice becomes the user's own selection (Cursor, S5 edit 11). */
  "persists-model-choice",
]);
export type BackendMark = z.infer<typeof BackendMark>;

/** A colour as a backend's look gives it: `#rrggbb`. */
export const LookColor = z.string().regex(/^#[0-9a-f]{6}$/i);

/** The kinds a backend's icon file may be (its bytes', never its name's): PNG, or SVG only when inert. */
export const ICON_FILE_TYPES = ["png", "svg"] as const;
/** The largest icon file a plugin's `agentBackends` entry may name; a bigger one is no icon (the plugin still loads). */
export const ICON_FILE_MAX_BYTES = 64 * 1024;

/** A backend's icon as `agent.backends` serves it: its plugin's file, checked where the plugin's other files are (at
 *  validation and load: inside the plugin's folder, no symlink out, `ICON_FILE_MAX_BYTES`, its bytes' type, an SVG only
 *  when inert), inline, in a form a sandboxed page shows as an image only (an `<img>` of a `data:` URL; never markup in the
 *  page). `at` is when it was read. */
export const BackendIcon = z.object({
  mediaType: z.enum(["image/png", "image/svg+xml"]),
  /** Base64. */
  data: z.string().max(Math.ceil(ICON_FILE_MAX_BYTES / 3) * 4),
  at: Timestamp,
});
export type BackendIcon = z.infer<typeof BackendIcon>;

export const AgentBackendView = z.object({
  id: utf16(128, 1),
  name: Text,
  pluginId: AnyPluginId,
  /** Its look (spec revision 20, §9.5; lane CA serves it), from its plugin's `agentBackends` entry: `icon`, the plugin's own
   *  icon file (the owner's ruling of 2026-11-21: each agent's plugin ships its mark); absent when the entry names none or
   *  the file was refused. A reader then draws the SDK's fallback mark (`agentMark`: the name's first letter on `color`,
   *  or on a neutral). `color` and `color2` (a gradient's second) are the entry's. */
  icon: BackendIcon.optional(),
  color: LookColor.optional(),
  color2: LookColor.optional(),
  protocol: z.enum(["acp", "cloud"]),
  placement: z.enum(["local", "cloud"]),
  /** Whether a person can open a session with it (`agent.start`). False for a backend only a turn's own subagents use. */
  userStartable: z.boolean().default(true),
  /** Per computer: installed, its version, sandboxed there, and the marks that apply there. */
  computers: z.array(z.object({
    computer: ComputerName,
    installed: z.boolean(),
    version: utf16(64).optional(),
    sandboxed: z.boolean().optional(),
    marks: z.array(BackendMark).max(16),
  })).max(256),
});
export type AgentBackendView = z.infer<typeof AgentBackendView>;

/** An agent definition from a plugin's `agents` (§5.3): a preset for `Agent`. */
export const AgentDefView = z.object({
  id: utf16(128, 1),
  name: Text,
  pluginId: AnyPluginId,
  backend: utf16(128),
  model: utf16(200).optional(),
  effort: utf16(32).optional(),
  computer: ComputerName.optional(),
  root: TreePath.optional(),
});
export type AgentDefView = z.infer<typeof AgentDefView>;

/** A model a backend offers before any session exists (`agent.options`), with its efforts in order. */
export const BackendModelOption = z.object({
  id: utf16(200, 1),
  name: Text,
  efforts: z.array(utf16(32, 1)).max(16),
  defaultEffort: utf16(32, 1).optional(),
});
export type BackendModelOption = z.infer<typeof BackendModelOption>;

/** What a backend offers to start with (spec revision 20, §9.5), before a session exists: MOSS's coding agent answers
 *  from the model catalog (`source: "catalog"`, its default the person's default model); an ACP agent from its quirks
 *  or a probe where they give them (`quirks`, `probe`); otherwise `known: false`, a valid answer meaning "unknown until
 *  started" (the session's own picker lists them once it runs). An effort list with no model is the backend's own
 *  efforts where it has them apart from models. */
export const AgentBackendOptions = z.object({
  backend: utf16(128, 1),
  known: z.boolean(),
  source: z.enum(["catalog", "quirks", "probe", "unknown"]),
  models: z.array(BackendModelOption).max(1_000),
  efforts: z.array(utf16(32, 1)).max(16).optional(),
  default: z.object({ model: utf16(200, 1).optional(), effort: utf16(32, 1).optional() }).optional(),
});
export type AgentBackendOptions = z.infer<typeof AgentBackendOptions>;

/** How many folders `RecentStart` keeps. */
export const RECENT_FOLDERS_MAX = 8;

/** The person's last start (spec revision 20, §9.5): the backend, model, effort and folder of the session they started
 *  last, in either app or the CLI, kept by the engine per person (`<home>/settings`, lane CA). `root` is a tree path: it
 *  reaches the app's main process and the CLI only, never a page, which gets the folder as a pick token
 *  (`UiPickResult.recent`). */
export const RecentStart = z.object({
  backend: utf16(128, 1).optional(),
  model: utf16(200, 1).optional(),
  effort: utf16(32, 1).optional(),
  computer: ComputerName.optional(),
  /** The folders started in last, newest first, at most `RECENT_FOLDERS_MAX`. */
  roots: z.array(z.object({ root: TreePath, at: Timestamp })).max(RECENT_FOLDERS_MAX),
});
export type RecentStart = z.infer<typeof RecentStart>;

/** A bridge tool as the agent sees it: one of the plugin tools in its scope, with a description that stands on its
 *  own, since Cursor and Antigravity keep server instructions out of the prompt (S5 edit 3). */
export const BridgeTool = z.object({
  name: utf16(64, 1),
  description: utf16(10_000),
  inputSchema: z.record(z.string(), z.unknown()),
});

/** The longest ACP line `moss-core code-agent` relays either way (K-M3b), in characters. Escaped inside a JSON string,
 *  a line this long can still pass the socket's 8 MiB (`NDJSON_MAX_LINE_BYTES`), so the relay also checks each request's
 *  encoded size before it sends it. */
export const CODE_AGENT_MAX_LINE = 2 * 1024 * 1024;

/** The notification that carries one ACP line from the coding agent to `moss-core code-agent`, on its bound
 *  connection only (a notification, not a request: nothing answers it). */
export const CODE_AGENT_LINE_NOTIFICATION = "codeAgent.line";
export const CodeAgentLine = z.object({ line: utf16(CODE_AGENT_MAX_LINE, 1) });
export type CodeAgentLine = z.infer<typeof CodeAgentLine>;

/** The notification the daemon sends a bridge connection when the tools its session may see changed (an install, an
 *  update, a removal, an enable or disable, the user's tool setting): the bridge forgets its list and tells its agent
 *  (`notifications/tools/list_changed`). A notification, not a request: nothing answers it. */
export const BRIDGE_TOOLS_CHANGED_NOTIFICATION = "bridge.toolsChanged";

export const AGENTS_METHODS = {
  agentBackends: defineMethod({
    name: "agent.backends", owner: "K", roles: ["app", "cli"],
    params: Empty, result: z.object({ backends: z.array(AgentBackendView) }),
    doc: "The agent backends plugins contribute, with what each computer has (§5.3, §9.3).",
  }),
  agentDefinitions: defineMethod({
    name: "agent.definitions", owner: "K", roles: ["app", "cli"],
    params: Empty, result: z.object({ definitions: z.array(AgentDefView) }),
    doc: "Agent definitions from plugins, the presets `Agent` offers.",
  }),
  agentStart: defineMethod({
    name: "agent.start", owner: "K", roles: ["app", "cli"], userOnly: true,
    params: z.object({
      backend: utf16(128, 1),
      computer: ComputerName,
      /** A folder in the tree; refused if it contains the MOSS home (§9.3). */
      root: TreePath,
      model: utf16(200).optional(),
      effort: utf16(32).optional(),
      definition: utf16(128).optional(),
      prompt: utf16(1_000_000).optional(),
    }),
    result: z.object({ session: SessionId }),
    doc: "Starts a coding session the user drives directly, with no bot (`moss code`, §9.3). From a plugin part (`sessions.start`, the app's door) it takes the model, the effort and a first message too (§9.5).",
  }),
  agentOptions: defineMethod({
    name: "agent.options", owner: "CA", roles: ["app", "cli"],
    params: z.object({ backend: utf16(128, 1), computer: ComputerName.optional() }),
    result: AgentBackendOptions,
    doc: "What a backend offers to start with, before any session exists: its models with their efforts and its defaults, or that they are unknown until it starts (§9.5).",
  }),
  agentRecent: defineMethod({
    name: "agent.recent", owner: "CA", roles: ["app", "cli"],
    params: Empty,
    result: RecentStart,
    doc: "The person's last start: backend, model, effort and the folders started in last (tree paths, for the app's main process and the CLI only; a page gets a pick token) (§9.5).",
  }),

  // `moss-core code-agent` (K-M3b): an outside ACP client's (Zed's) relay to MOSS's coding agent, on a `cli`
  // connection that counts as the user. `codeAgent.open` binds the connection to one session; after it the connection
  // takes only `codeAgent.send`, and the session ends when the connection does.
  codeAgentOpen: defineMethod({
    name: "codeAgent.open", owner: "K", roles: ["cli"], userOnly: true,
    params: z.object({
      /** The folder the client opened, as an absolute path: a folder of this computer's tree, under the fence. */
      cwd: utf16(4096, 1),
      model: utf16(200).optional(),
      effort: utf16(32).optional(),
    }),
    result: z.object({ session: SessionId }),
    doc: "Opens a coding session the user drives from an outside ACP client, bound to this connection (§9.3).",
  }),
  codeAgentSend: defineMethod({
    name: "codeAgent.send", owner: "K", roles: ["cli"], userOnly: true,
    params: z.object({ line: utf16(CODE_AGENT_MAX_LINE, 1) }), result: Ok,
    doc: "One ACP line from the outside client to the coding agent of this connection's session.",
  }),

  // The bridge (role `bridge`): bound to one agent session by its token.
  bridgeTools: defineMethod({
    name: "bridge.tools", owner: "K", roles: ["bridge"],
    params: Empty, result: z.object({ tools: z.array(BridgeTool), instructions: utf16(64_000) }),
    doc: "The plugin tools in this agent's scope, plus `SendMessage` and `Glossary`, and the instructions the bridge sends as its own.",
  }),
  bridgeCall: defineMethod({
    name: "bridge.call", owner: "K", roles: ["bridge"],
    params: z.object({ callId: utf16(128, 1), tool: utf16(64, 1), input: z.unknown() }),
    result: z.object({ content: z.array(z.unknown()), isError: z.boolean() }),
    doc: "Runs a bridged tool wherever it actually runs, under the same approval rules (§9.3).",
  }),
  bridgeSendMessage: defineMethod({
    name: "bridge.sendMessage", owner: "K", roles: ["bridge"],
    /** `to`: a session's id, or its title when one session this agent may reach has it (spec revision 20, §9.5; lane CM
     *  resolves it under `reachRefusal`). Absent: a bot's agent's bot; refused for a session the person drives. */
    params: z.object({ text: utf16(1_000_000, 1), to: utf16(200, 1).optional() }),
    result: z.object({ ok: z.literal(true) }),
    doc: "The agent messages its bot or another session it may reach (§9.3, §9.5); it folds in like any session's message.",
  }),
  bridgeListSessions: defineMethod({
    name: "bridge.listSessions", owner: "CM", roles: ["bridge"],
    params: Empty,
    result: z.object({ sessions: z.array(ReachableSession).max(LIST_SESSIONS_MAX) }),
    doc: "The sessions this agent's session may message now (`ListSessions`): exactly those `SendMessage` would deliver to (§9.5).",
  }),
} as const;

export const AgentBackendsChangedEvent = coreEvent("agent_backends_changed", {});

export const AGENTS_EVENTS = {
  agentBackendsChanged: defineEvent({
    type: "agent_backends_changed", owner: "K", roles: ["app", "cli"], schema: AgentBackendsChangedEvent,
    fixture: { type: "agent_backends_changed", ts: 1781270000000 },
    doc: "A backend was added, removed or detected anew; clients re-read `agent.backends`.",
  }),
} as const;
