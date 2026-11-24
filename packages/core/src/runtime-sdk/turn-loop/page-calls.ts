// A tool's PAGE asking a bot session for a tool call (MCP Apps). GENERAL: one door for any plugin server's page.
//
// The page's call meets the SAME functions a model's call meets in the bot driver, not a copy of part of them: `preTool` (the
// pause and the lease, the plugins' `tool.before` deny / ask / rewritten input, the file fence, the sandbox-escape rule), then the
// approval check, then, after the run, `postTool` (`tool.after`, the observer). What differs is only who is asking: the check's
// context is marked as a PAGE asking (`pageAsking`, read by `approvals/bot-check.ts`: the card says a page asks, a card every
// time with no "always", no saved rule of the model's call covers it), and the wait is under the page's own signal.
import type { CanUseTool } from "@waifucave/clover-agent-sdk";
import type { BotSessionContext } from "../../bots/service";
import type { AppSite } from "../../mcp-apps/service";
import type { McpRunner } from "./servers";

type HookOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown>; updatedMCPToolOutput?: { content?: unknown; isError?: unknown } } };

/** The driver's own pieces a page's call goes through (the same ones its model calls use). */
export interface PageCallDoors {
  preTool(raw: unknown, toolUseId: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>>;
  postTool(raw: unknown, toolUseId: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>>;
  dropCallId(name: string, id: string | undefined): void;
  /** The session's approval check for a context (already behind the driver's pause and lease). */
  canUse(ctx: BotSessionContext): CanUseTool;
}

export function botPageCalls(o: {
  ctx: BotSessionContext; server: { server: string; plugin: string }; runner: McpRunner; doors: PageCallDoors;
}): Pick<AppSite, "approve" | "callTool"> {
  const { ctx, server, runner, doors } = o;
  // What `approve` hands back for a call it allowed: only a call it allowed runs (`callTool` takes nothing else).
  const issued = new WeakSet<object>();
  return {
    approve: async (name, args, signal, cardId) => {
      const served = `mcp__${server.server}__${name}`;
      try {
        const hook = ((await doors.preTool({ tool_name: served, tool_input: args, tool_use_id: cardId }, cardId, signal)) as HookOut).hookSpecificOutput;
        // The page's call has no router queue entry to wait in: the one `preTool` made is dropped at once.
        doors.dropCallId(served, cardId);
        if (hook?.permissionDecision === "deny") return { allowed: false, message: `${served} was refused: ${hook.permissionDecisionReason ?? "a plugin's hook or the session's rules"}` };
        const rewritten = hook?.updatedInput ?? args;
        const pageCtx = { ...ctx, pageAsking: { plugin: server.plugin } } as BotSessionContext;
        const verdict = await doors.canUse(pageCtx)(served, rewritten, {
          signal, toolUseID: cardId, suggestions: [], mcpServer: { name: server.server, configName: server.server },
          // A hook's ask reaches the check as it does for a model's call: the words ride as the decision reason.
          ...(hook?.permissionDecision === "ask" ? { decisionReason: { type: "hook", reason: hook.permissionDecisionReason ?? "" } } : {}),
        } as unknown as Parameters<CanUseTool>[2]);
        // No decision at all is no leave: only an allow runs the call, on the input the hooks and the check left.
        if (verdict?.behavior === "allow") {
          const ticket = {};
          issued.add(ticket);
          return { allowed: true, input: (verdict.updatedInput ?? rewritten) as Record<string, unknown>, ticket };
        }
        return { allowed: false, message: (verdict !== null && verdict.behavior === "deny" && verdict.message) || `${served} was not run.` };
      } catch {
        return { allowed: false, message: `${served} was not run: the approval couldn't be asked.` };
      }
    },
    callTool: async (name, args, signal, ticket) => {
      if (typeof ticket !== "object" || ticket === null || !issued.has(ticket)) throw new Error("this call wasn't approved");
      const served = `mcp__${server.server}__${name}`;
      const callId = `mcp-app-${crypto.randomUUID()}`;
      const r = await runner.run(server.server, name, args, { session: ctx.sessionId, as: ctx.caller, callId, signal });
      const out = { content: Array.isArray(r.result.content) ? r.result.content : [], ...(r.result.isError === true ? { isError: true } : {}) };
      const post = ((await doors.postTool({ tool_name: served, tool_input: args, tool_response: out, tool_use_id: callId }, callId, signal)) as HookOut).hookSpecificOutput;
      const changed = post?.updatedMCPToolOutput;
      return changed !== undefined && changed !== null && Array.isArray(changed.content) ? { content: changed.content, ...(changed.isError === true ? { isError: true } : {}) } : out;
    },
  };
}
