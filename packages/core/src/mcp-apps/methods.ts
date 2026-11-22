// `mcpApp.open` and `mcpApp.request` (protocol `APP_METHODS`) over the engine's MCP Apps service. Both are the window's own
// (an `app` connection of a program with windows, the user's: the method spec says so and the dispatcher checks it before
// a handler runs); the params are already parsed against the spec. The page is untrusted, so the only thing a handler
// takes from the app is the (session, call id) pair and the page's message as data: what the service does with them is
// `service.ts`'s and `bridge.ts`'s.
import { APP_METHODS, ERR } from "@waifucave/moss-protocol";
import { MossRpcError, type MossHandler } from "../ipc/moss";
import { McpAppRefusal } from "./resource";
import type { McpAppsService } from "./service";

function refused(err: unknown): MossRpcError {
  if (err instanceof McpAppRefusal) return new MossRpcError(err.code === "not_here" || err.code === "not_found" ? ERR.NOT_FOUND : ERR.INVALID_PARAMS, err.message, { code: err.code });
  return new MossRpcError(ERR.INTERNAL, "the page couldn't be shown");
}

export function mcpAppMethods(service: () => McpAppsService | undefined): Record<string, MossHandler> {
  const up = (): McpAppsService => {
    const s = service();
    if (s === undefined) throw new MossRpcError(ERR.RETRY, "MCP Apps isn't running on this computer yet: try again in a moment");
    return s;
  };
  return {
    [APP_METHODS.mcpAppOpen.name]: async (_conn, params) => {
      const p = params as { session: string; callId: string };
      try { return await up().open(p.session, p.callId); } catch (err) { throw refused(err); }
    },
    [APP_METHODS.mcpAppRequest.name]: async (_conn, params) => {
      const p = params as { session: string; callId: string; message: unknown };
      try { return await up().request(p.session, p.callId, p.message); } catch (err) { throw refused(err); }
    },
  };
}
