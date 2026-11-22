// The engine's side of MCP Apps (spec §5.5): the page a tool result names, read from the tool's own server, and the bridge
// its frame talks through. GENERAL: any plugin's MCP server (host, stdio or http), on any session that runs its tools
// through the plugin path (a bot's, MOSS's own coding agent's, any ACP agent's through the bridge). Nothing here is
// specific to one server.
//
// HOW A PAGE GETS TO A RESULT. Every plugin tool call goes through the plugin MCP path (`PluginMcp`, the router, the
// bridge), whose listing keeps a tool's `_meta.ui` (`McpToolDef.ui`). At the place a call's result comes back to the engine,
// when the tool names a page and the call succeeded, the session's driver builds a SITE (the doors of that one server, as
// closures of the host) and `bind`s it under (session, call id); the event carries only the page's address
// (`tool_result.app`). The window asks for the page by (session, call id) alone (`open`): what is read is the binding's
// address, checked against the server's live listing first, never what an event or a page says.
//
// THE BINDING IS THE HOST'S, NEVER THE PAGE'S. A page can only name a tool; the server it is called on is the site's, so
// it can never reach another server's tool. A call from a page asks the session's OWN approval (`site.approve`, the same
// door a model's call to that tool meets: its level, the tool setting, the saved answers, the card), so what the
// person sees and can refuse is what they see for the model.
import { MCP_APP_HEIGHT_MAX, type McpAppOpen, type McpAppReply, type ToolApp } from "@waifucave/moss-protocol";
import { AppBridge, type BridgeHost, type BridgeTool } from "./bridge";
import { McpAppRefusal, parseUiResource, uiCspHeader, uiResourceUriOf, type UiResourceContent } from "./resource";

/** One page's doors to its own server, made at the place its result came back. */
export interface AppSite {
  /** The plugin whose server it is (a page's `ui/message` is that plugin's message, never the user's), the server's name as the
   *  session names it, and the tool and page. */
  pluginId: string;
  server: string;
  tool: string;
  resourceUri: string;
  /** The call the page belongs to: its input, and its result's content (the page's first messages). */
  input: Record<string, unknown>;
  result: { content: unknown[]; isError?: boolean };
  /** The server's own tool listing now (`_meta.ui` kept), never another server's. */
  listTools(): Promise<readonly BridgeTool[]>;
  /** `resources/read` on the same connection that serves the tool. */
  readResource(uri: string): Promise<readonly UiResourceContent[]>;
  /** Runs a tool of the server (called only after `approve` allowed it). */
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, ticket?: unknown): Promise<{ content: unknown[]; isError?: boolean }>;
  /** The session's own approval for that tool call: what a model's call gets, with `callId` as the card's id. */
  approve(name: string, args: Record<string, unknown>, signal: AbortSignal, callId: string): Promise<{ allowed: true; input?: Record<string, unknown>; ticket?: unknown } | { allowed: false; message: string }>;
}

export interface McpAppsDeps {
  version: string;
  /** `ui/message`: the page's words, delivered to the session as its plugin's message (`from: "plugin"`, with the call that
   *  drew the page), which is never the user's. */
  deliver(sessionId: string, message: { pluginId: string; callId: string; text: string }): Promise<void>;
  log?: (line: string) => void;
}

const BINDINGS_MAX = 64;
const READ_MS = 15_000;

interface Binding { site: AppSite; bridge?: AppBridge; approvals: number; budget: { sent: number } }

/** What a driver keeps between a call's result and its projected `tool_result`: the page's address, taken once. */
export class ToolApps {
  readonly #pending = new Map<string, ToolApp>();
  put(callId: string, app: ToolApp): void {
    this.#pending.delete(callId);
    this.#pending.set(callId, app);
    while (this.#pending.size > BINDINGS_MAX) this.#pending.delete(this.#pending.keys().next().value!);
  }
  drop(callId: string): void { this.#pending.delete(callId); }
  take(callId: string): ToolApp | undefined {
    const a = this.#pending.get(callId);
    if (a !== undefined) this.#pending.delete(callId);
    return a;
  }
  clear(): void { this.#pending.clear(); }
}

export class McpAppsService {
  readonly #sessions = new Map<string, Map<string, Binding>>();

  constructor(private readonly deps: McpAppsDeps) {}

  /** A successful call's result names a page: keeps its site under (session, call id) and answers the event's stamp. */
  bind(sessionId: string, callId: string, site: AppSite): ToolApp {
    let mine = this.#sessions.get(sessionId);
    if (mine === undefined) this.#sessions.set(sessionId, (mine = new Map()));
    mine.get(callId)?.bridge?.close();
    mine.delete(callId);
    mine.set(callId, { site, approvals: 0, budget: { sent: 0 } });
    while (mine.size > BINDINGS_MAX) {
      const oldest = mine.keys().next().value!;
      mine.get(oldest)?.bridge?.close();
      mine.delete(oldest);
    }
    return { resourceUri: site.resourceUri };
  }

  /** The session ended: its pages' calls stop. */
  detach(sessionId: string): void {
    for (const b of this.#sessions.get(sessionId)?.values() ?? []) b.bridge?.close();
    this.#sessions.delete(sessionId);
  }

  #binding(sessionId: string, callId: string): Binding {
    // Not bound: the session isn't running on this computer (its tool, and so its server, belong to another one), the page
    // is older than this run of the engine, or it was never stamped. Said plainly; the result shows as text.
    const b = this.#sessions.get(sessionId)?.get(callId);
    if (b === undefined) throw new McpAppRefusal("not_here", "this page isn't available on this computer (its session isn't running here, or the page is older than this run)");
    return b;
  }

  /** `mcpApp.open`: reads the page and starts its bridge. */
  async open(sessionId: string, callId: string): Promise<McpAppOpen> {
    const b = this.#binding(sessionId, callId);
    const { site } = b;
    // The server must still list the tool with this very page: what the event said, or a changed server, proves nothing.
    const tool = (await withTimeout(site.listTools(), READ_MS)).find((t) => t.name === site.tool);
    if (tool === undefined || uiResourceUriOf(tool) !== site.resourceUri) throw new McpAppRefusal("not_found", "the server no longer names this page for that tool");
    const page = parseUiResource(site.resourceUri, await withTimeout(site.readResource(site.resourceUri), READ_MS));
    b.bridge?.close();
    b.bridge = new AppBridge(this.#hostFor(sessionId, callId, b, tool));
    return { csp: uiCspHeader(page.csp), html: page.html, ...(page.prefersBorder !== undefined ? { prefersBorder: page.prefersBorder } : {}), maxHeight: MCP_APP_HEIGHT_MAX };
  }

  /** `mcpApp.request`: one message from the page's frame. */
  async request(sessionId: string, callId: string, message: unknown, pressed = false): Promise<McpAppReply> {
    const b = this.#binding(sessionId, callId);
    if (b.bridge === undefined) throw new McpAppRefusal("not_here", "this page isn't open");
    return await b.bridge.handle(message, pressed);
  }

  #hostFor(sessionId: string, callId: string, b: Binding, tool: BridgeTool): BridgeHost {
    const { site } = b;
    return {
      hostInfo: { name: "MOSS Code", version: this.deps.version },
      tool, input: site.input, result: site.result,
      listTools: () => site.listTools(),
      callTool: (name, args, signal, ticket) => site.callTool(name, args, signal, ticket),
      readResource: (uri) => site.readResource(uri),
      // A card of its own (an id no model call has), so it is placed and answered as any card is.
      approve: (name, args, signal) => site.approve(name, args, signal, `app-${callId}-${++b.approvals}`),
      message: async (text) => {
        await this.deps.deliver(sessionId, { pluginId: site.pluginId, callId, text });
      },
      // Counted by the binding, so closing and opening the same page again never earns a fresh allowance.
      budget: b.budget,
      log: this.deps.log,
    };
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new McpAppRefusal("timeout", "the server didn't answer in time")), ms); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
