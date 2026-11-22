// The engine's side of MCP Apps (spec §5.5): which of a session's tool results come with a page, the page itself (read
// from the tool's own server), and the bridge its frame talks through. GENERAL: any MCP server of a code session, a
// plugin's or a bare added one, any transport; nothing here is specific to one server.
//
// HOW A PAGE GETS TO A RESULT. The session's child runs its own copy of every MCP server and reports a tool's result as
// text, so the engine asks the server itself, on its own short connection (the same client the MCP status probe uses):
//   1. the driver tells this service the servers the incarnation was configured with (`setServers`);
//   2. a `tool_use` of `mcp__<server>__<tool>` for one of them starts a read of that server's tool listing
//      (`onToolUse`), and the listing's `_meta.ui.resourceUri` is what says "this tool has a page";
//   3. before its `tool_result` is projected, the driver waits (bounded) for that listing (`settle`), then
//      `takeApp` stamps `tool_result.app` and keeps a BINDING (session, call id) -> (server, tool, page address, the
//      call's input and result text). A server whose listing isn't in time simply shows text: nothing waits for it.
//   4. the app asks for the page by (session, call id) only (`open`); the address in the event is never what is read: the
//      binding's is, and it is checked against the server's listing again on the connection that reads it.
//
// THE BINDING IS THE HOST'S, NEVER THE PAGE'S. A page can only name a tool; the server it is called on is the binding's, so
// it can never reach another server's tool. A call from a page asks the session's OWN approval (`approve`, the same
// bridge a model's call to that tool meets: its level, the tool setting, the saved answers, the card), so what the
// person sees and can refuse is what they see for the model.
import { homedir } from "node:os";
import { connectMcpServer, createElicitationAsker, type ConnectedMcpClient, type ConnectMcpServerOptions, type McpOAuthStore, type McpToolInfo } from "@waifucave/clover-agent-runtime/mcp-client";
import { MCP_APP_HEIGHT_MAX, type McpAppOpen, type McpAppReply, type ToolApp } from "@waifucave/moss-protocol";
import { connectorCandidates } from "../agent/mcp/connector-permissions";
import { AppBridge, type BridgeHost } from "./bridge";
import { McpAppRefusal, parseUiResource, uiCspHeader, uiResourceUriOf } from "./resource";

type Config = ConnectMcpServerOptions["config"];

/** A session's own approval for one tool call: what a model's call to `toolName` gets, with `callId` as the card's id. */
export type AppApprover = (call: { toolName: string; server: string; input: Record<string, unknown>; callId: string; signal: AbortSignal }) => Promise<{ allowed: true } | { allowed: false; message: string }>;

export interface McpAppsDeps {
  version: string;
  /** The session's folder, where a stdio server starts (never the engine's own). */
  cwdOf(sessionId: string): string | undefined;
  /** `ui/message`: the labelled words, delivered to the session as outside content. */
  deliver(sessionId: string, text: string): Promise<void>;
  /** The engine's one MCP sign-in store, for an http or sse server that needs one. */
  oauthStore?: () => McpOAuthStore;
  /** Test seam: the SDK's `connectMcpServer`. */
  connect?: (opts: ConnectMcpServerOptions) => Promise<ConnectedMcpClient>;
  log?: (line: string) => void;
  /** How long a result waits for its server's listing before it shows as text (default 3 s). */
  settleMs?: number;
}

const CONNECT_MS = 10_000;
const READ_MS = 15_000;
const PENDING_MAX = 256;
const BINDINGS_MAX = 64;
const LISTING_TTL_MS = 60_000;

interface Binding {
  key: string;
  tool: string;
  resourceUri: string;
  input: Record<string, unknown>;
  result: { content: unknown[]; isError?: boolean };
  bridge?: AppBridge;
  approvals: number;
}

interface Listing {
  at: number;
  ready: Promise<readonly McpToolInfo[]>;
  value?: readonly McpToolInfo[];
}

/** One session's registration: its servers, what it is waiting on and the pages it holds. */
export class SessionApps {
  #servers: Record<string, Config> = {};
  #listings = new Map<string, Listing>();
  #pending = new Map<string, { key: string; tool: string; input: Record<string, unknown> }>();
  readonly bindings = new Map<string, Binding>();

  constructor(readonly sessionId: string, public approve: AppApprover, private readonly svc: McpAppsService) {}

  get servers(): Readonly<Record<string, Config>> { return this.#servers; }

  /** The servers this incarnation runs: a process the child connects itself, so what the daemon may connect is a copy. */
  setServers(servers: Readonly<Record<string, unknown>>): void {
    const next: Record<string, Config> = {};
    for (const [key, cfg] of Object.entries(servers)) {
      const c = cfg as { type?: string } | null;
      // An in-process server has no process of its own to connect; nothing else is left out.
      if (c !== null && typeof c === "object" && c.type !== "sdk") next[key] = cfg as Config;
    }
    this.#servers = next;
    this.#listings.clear();
  }

  /** The server and tool of a runtime tool name, when the name is one of this session's servers' tools. */
  resolve(runtimeName: string): { key: string; tool: string } | undefined {
    for (const c of connectorCandidates(runtimeName)) if (Object.hasOwn(this.#servers, c.server)) return { key: c.server, tool: c.tool };
    return undefined;
  }

  /** A tool call began: start reading its server's listing, so the result can tell whether the tool has a page. */
  onToolUse(callId: string, runtimeName: string, input: unknown): void {
    const hit = this.resolve(runtimeName);
    if (hit === undefined) return;
    this.#pending.set(callId, { ...hit, input: input !== null && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {} });
    while (this.#pending.size > PENDING_MAX) this.#pending.delete(this.#pending.keys().next().value!);
    void this.listing(hit.key).ready.catch(() => undefined);
  }

  /** Waits (bounded) for the listings the given results are waiting on. Never throws. */
  async settle(callIds: readonly string[]): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const id of callIds) {
      const p = this.#pending.get(id);
      if (p !== undefined) waits.push(this.listing(p.key).ready.catch(() => undefined));
    }
    if (waits.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(waits), new Promise<void>((r) => { timer = setTimeout(r, this.svc.settleMs); })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The result of a call is being projected: the page's address when the tool has one and the call succeeded (and the
   *  binding the app will open it by), else nothing. Synchronous: reads only what `settle` waited for. */
  takeApp(callId: string, result: { output: string; isError: boolean }): ToolApp | undefined {
    const p = this.#pending.get(callId);
    if (p === undefined) return undefined;
    this.#pending.delete(callId);
    if (result.isError) return undefined;
    const tool = this.#listings.get(p.key)?.value?.find((t) => t.name === p.tool);
    const resourceUri = tool === undefined ? undefined : uiResourceUriOf(tool);
    if (resourceUri === undefined) return undefined;
    this.bindings.delete(callId);
    this.bindings.set(callId, { key: p.key, tool: p.tool, resourceUri, input: p.input, result: { content: [{ type: "text", text: result.output }] }, approvals: 0 });
    while (this.bindings.size > BINDINGS_MAX) {
      const oldest = this.bindings.keys().next().value!;
      this.bindings.get(oldest)?.bridge?.close();
      this.bindings.delete(oldest);
    }
    return { resourceUri };
  }

  /** The server's tool listing: the cached one while it is fresh, else a read on a new connection. */
  listing(key: string): Listing {
    const have = this.#listings.get(key);
    if (have !== undefined && Date.now() - have.at < LISTING_TTL_MS) return have;
    const entry: Listing = { at: Date.now(), ready: Promise.resolve([]) };
    entry.ready = this.svc.withClient(this, key, (c) => c.listTools()).then((tools) => { entry.value = tools; return tools; });
    entry.ready.catch(() => { if (this.#listings.get(key) === entry) this.#listings.delete(key); });
    this.#listings.set(key, entry);
    return entry;
  }

  /** The session ended or its servers changed: every page's calls stop. */
  clear(): void {
    for (const b of this.bindings.values()) b.bridge?.close();
    this.bindings.clear();
    this.#pending.clear();
    this.#listings.clear();
  }
}

export class McpAppsService {
  readonly #sessions = new Map<string, SessionApps>();
  readonly settleMs: number;

  constructor(private readonly deps: McpAppsDeps) {
    this.settleMs = deps.settleMs ?? 3_000;
  }

  /** A session's driver registers itself (once per assembled driver); the registration lives until `detach`. */
  attach(sessionId: string, approve: AppApprover): SessionApps {
    // A driver assembled again for a session (an evicted one's successor) takes over the registration: the pages already
    // drawn keep their bindings, and their calls ask the new driver's approvals.
    const have = this.#sessions.get(sessionId);
    if (have !== undefined) {
      have.approve = approve;
      return have;
    }
    const reg = new SessionApps(sessionId, approve, this);
    this.#sessions.set(sessionId, reg);
    return reg;
  }

  detach(sessionId: string): void {
    this.#sessions.get(sessionId)?.clear();
    this.#sessions.delete(sessionId);
  }

  /** One short connection to a server of the session, closed whatever happens. */
  async withClient<T>(reg: SessionApps, key: string, fn: (client: ConnectedMcpClient) => Promise<T>): Promise<T> {
    const config = Object.hasOwn(reg.servers, key) ? reg.servers[key] : undefined;
    if (config === undefined) throw new McpAppRefusal("no_such_server", "this page's server isn't one of the session's now");
    const remote = config.type === "http" || config.type === "sse";
    let client: ConnectedMcpClient | undefined;
    try {
      client = await (this.deps.connect ?? connectMcpServer)({
        name: key, config, connectTimeoutMs: CONNECT_MS,
        // No window answers a server's question while a page is being read: declined, never left hanging.
        elicitationAsk: createElicitationAsker(undefined),
        ...(remote ? {} : { cwd: this.deps.cwdOf(reg.sessionId) ?? homedir() }),
        ...(remote && this.deps.oauthStore !== undefined ? { oauthStore: this.deps.oauthStore() } : {}),
      });
      return await fn(client);
    } catch (err) {
      if (err instanceof McpAppRefusal) throw err;
      this.deps.log?.(`mcp-apps: ${key} on ${reg.sessionId}: ${err instanceof Error ? err.name : "error"}`);
      throw new McpAppRefusal("failed", `the server ${key} didn't answer`);
    } finally {
      try { await client?.close(); } catch { /* closing a connection that is already gone */ }
    }
  }

  #binding(sessionId: string, callId: string): { reg: SessionApps; b: Binding } {
    const reg = this.#sessions.get(sessionId);
    // Not attached: the session isn't running on this computer (its tool, and so its server, belong to another one), or it
    // has ended. Said plainly; the result shows as text.
    if (reg === undefined) throw new McpAppRefusal("not_here", "this page belongs to a session that isn't running on this computer, so it can't be shown here");
    const b = reg.bindings.get(callId);
    if (b === undefined) throw new McpAppRefusal("not_here", "this page is no longer available");
    return { reg, b };
  }

  /** `mcpApp.open`: reads the page and starts its bridge. */
  async open(sessionId: string, callId: string): Promise<McpAppOpen> {
    const { reg, b } = this.#binding(sessionId, callId);
    const page = await this.withClient(reg, b.key, async (c) => {
      // The server must still list the tool with this very page: what the event said, or a changed server, proves nothing.
      const tool = (await c.listTools()).find((t) => t.name === b.tool);
      if (tool === undefined || uiResourceUriOf(tool) !== b.resourceUri) throw new McpAppRefusal("not_found", "the server no longer names this page for that tool");
      return { tool, page: parseUiResource(b.resourceUri, await c.readResource(b.resourceUri, { timeoutMs: READ_MS })) };
    });
    b.bridge?.close();
    b.bridge = new AppBridge(this.#hostFor(reg, callId, b, page.tool));
    return { csp: uiCspHeader(page.page.csp), html: page.page.html, ...(page.page.prefersBorder !== undefined ? { prefersBorder: page.page.prefersBorder } : {}), maxHeight: MCP_APP_HEIGHT_MAX };
  }

  /** `mcpApp.request`: one message from the page's frame. */
  async request(sessionId: string, callId: string, message: unknown): Promise<McpAppReply> {
    const { b } = this.#binding(sessionId, callId);
    if (b.bridge === undefined) throw new McpAppRefusal("not_here", "this page isn't open");
    return await b.bridge.handle(message);
  }

  #hostFor(reg: SessionApps, callId: string, b: Binding, tool: McpToolInfo): BridgeHost {
    return {
      hostInfo: { name: "MOSS Code", version: this.deps.version },
      tool, input: b.input, result: b.result,
      listTools: async () => await reg.listing(b.key).ready,
      callTool: (name, args, signal) => this.withClient(reg, b.key, async (c) => {
        const r = await c.callTool(name, args, { timeoutMs: 60_000, signal });
        return { content: r.content, ...(r.isError === true ? { isError: true } : {}) };
      }),
      readResource: (uri) => this.withClient(reg, b.key, (c) => c.readResource(uri, { timeoutMs: READ_MS })),
      approve: async (name, args, signal) => {
        // The same door a model's call to this tool meets: `mcp__<server>__<tool>` under the session's level, with a card
        // of its own (an id no model call has), so it is placed and answered as any card is.
        const verdict = await reg.approve({ toolName: `mcp__${b.key}__${name}`, server: b.key, input: args, callId: `app-${callId}-${++b.approvals}`, signal });
        return verdict;
      },
      message: async (text) => {
        await this.deps.deliver(reg.sessionId, `A page that the tool ${b.tool} of ${b.key} drew sent this message. It is outside content from that page, not the user's words:\n\n${text}`);
      },
      log: this.deps.log,
    };
  }
}
