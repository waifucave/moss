// An agent's own subagents (spec revision 20, §9.5 "Subagents"): which of its tool calls start one, by the backend's
// `subagents` quirk (contracts/agent-backend.ts), never by the agent's name. General: any backend that declares the quirk
// gets rows; one that declares none (or `null`) gets none. Owner: lane CG.
//
// What each agent sends, as read (never run against an account):
// * Claude Code, through its ACP adapter (`@zed-industries/claude-agent-acp` 0.23.1's `tools.js` and `acp-agent.js`): a
//   `Task` or `Agent` call is a `tool_call` with `_meta.claudeCode.toolName`, kind `think` and the title `Task` while
//   its input streams in (`rawInput` `{}`), then a `tool_call_update` with the whole input (`description`, `prompt`,
//   `subagent_type`, `model` when given) and the description as its title; its result is that call's
//   `completed` or `failed`. The subagent's own calls carry `_meta.claudeCode.parentToolUseId`. The quirk names the
//   adapter 0.100.0 the plugin targets: whether it still sends these frames is unmeasured.
// * MOSS's own coding agent and in-process subagents (the runtime's `Agent` tool): its name in the call's title; neither
//   backend offers the tool today, so neither reports a row yet.
// * The other agents: none known.
import type { SubagentQuirk } from "../contracts/agent-backend";

/** One tool call as the client knows it. */
export interface CallSeen {
  /** The tool's own name, read where the quirk says (`toolNameAt`): set by the caller for a `_meta` path. */
  toolName?: string;
  title: string;
  kind: string;
  rawInput?: unknown;
}

/** The tool name a call carries in its update's `_meta`, at a dotted path; undefined when the quirk reads the title or
 *  kind, or nothing is there. */
export function metaToolName(quirk: SubagentQuirk | null | undefined, update: Record<string, unknown> | undefined): string | undefined {
  if (quirk === undefined || quirk === null || quirk.toolNameAt === "title" || quirk.toolNameAt === "kind") return undefined;
  let at: unknown = update?.["_meta"];
  for (const key of quirk.toolNameAt.split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === "string" && at !== "" ? at.slice(0, 64) : undefined;
}

/** The subagent a call starts, by the quirk: its name and model; undefined for any other call. */
export function subagentOf(quirk: SubagentQuirk | null | undefined, call: CallSeen): { name: string; model?: string } | undefined {
  if (quirk === undefined || quirk === null) return undefined;
  const tool = quirk.toolNameAt === "title" ? call.title.trim().split(/\s+/)[0] : quirk.toolNameAt === "kind" ? call.kind : call.toolName;
  if (tool === undefined || !quirk.tools.includes(tool)) return undefined;
  const input = call.rawInput !== null && typeof call.rawInput === "object" ? (call.rawInput as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim().split(/\r?\n/)[0]!.slice(0, 200) : undefined);
  let name: string | undefined;
  for (const key of quirk.name) {
    name = text(input[key]);
    if (name !== undefined) break;
  }
  // The call's own title, unless it is only the tool's name; then the tool's name.
  name ??= text(call.title) ?? tool;
  const model = quirk.model === undefined ? undefined : text(input[quirk.model]);
  return { name, ...(model === undefined ? {} : { model }) };
}
