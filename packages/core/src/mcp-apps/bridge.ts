// The MCP Apps bridge (spec §5.5): what a page's frame may say to the host, and what the host answers. A page is
// UNTRUSTED CODE a server sent; every message it posts is parsed here, as data, before anything acts on it.
//
// What a page may ask (the extension's list, 2026-01-26, cut to what the spec lets it have):
//   ui/initialize, ui/notifications/initialized, ui/notifications/size-changed, ui/request-display-mode, ping,
//   notifications/message                  answered here, touching nothing
//   ui/open-link                           an http(s) address, for the person's browser, only inside the person's press in the view
//   ui/message                             words for the conversation, never the user's (the host labels them), only inside the person's press
//   tools/call                             a tool of ITS OWN server whose `_meta.ui.visibility` has `app`, through the
//                                          SAME approval a model's call to it gets (`host.approve`): a refusal is the page's answer
//   resources/read                         a ui:// resource of its own server, bounded
// Everything else, `ui/update-model-context` included, is refused with "method not found": the page is told, nothing runs.
//
// What a page can never do, by construction: name a server (the binding is the host's, made when the result was
// stamped), call a tool the listing doesn't hold or one that leaves out `app`, press a card (it has no channel to one),
// or make the host send it anything before it said `initialized`.
import { MCP_APP_HEIGHT_MAX, MCP_APP_MESSAGE_MAX, type McpAppReply } from "@waifucave/moss-protocol";
import { McpAppRefusal, MCP_APPS_SPEC_VERSION, toolVisibilityOf, UI_URI_MAX, type UiResourceContent } from "./resource";

/** JSON-RPC error codes the bridge answers with. */
export const RPC = { invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, refused: -32000 } as const;

export interface BridgeTool { name: string; description?: string; inputSchema?: unknown; _meta?: unknown }

/** What a binding gives its bridge: its own server's doors, already scoped to one server of one session. */
export interface BridgeHost {
  /** The product's name for the extension's `hostInfo`. */
  hostInfo: { name: string; version: string };
  /** The tool this page came with, and the arguments and result of the call it belongs to (the page's first two messages). */
  tool: BridgeTool;
  input: Record<string, unknown>;
  result: { content: unknown[]; isError?: boolean };
  /** The server's own tool listing (fresh or cached; never another server's). */
  listTools(): Promise<readonly BridgeTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, ticket?: unknown): Promise<{ content: unknown[]; isError?: boolean }>;
  readResource(uri: string): Promise<readonly UiResourceContent[]>;
  /** The session's own approval for this tool call (what a model's call gets): allowed, or the words it was refused with. */
  approve(toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ allowed: true; input?: Record<string, unknown>; ticket?: unknown } | { allowed: false; message: string }>;
  /** `ui/message`: put these words in the conversation as outside content, labelled. */
  message(text: string): Promise<void>;
  /** How many messages this PAGE (its binding: every opening of it, not one bridge) has sent; the bridge counts into it. */
  budget?: { sent: number };
  log?(line: string): void;
}

export const TEXT_MESSAGE_MAX = 10_000;
export const MESSAGES_PER_PAGE_MAX = 20;
export const TOOL_ARGS_MAX = 200_000;
export const RESULT_MAX = MCP_APP_MESSAGE_MAX;
export const TOOL_CALL_TIMEOUT_MS = 60_000;
export const OPEN_LINK_MAX = UI_URI_MAX;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const METHOD = /^[A-Za-z0-9_./-]{1,128}$/;

type Id = string | number;
const fail = (id: Id, code: number, message: string): Record<string, unknown> => ({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id: Id, result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });

/** The size of a value once serialised, in UTF-16 units; `undefined` for a value that isn't JSON at all. */
function jsonLength(v: unknown): number | undefined {
  try {
    return JSON.stringify(v)?.length;
  } catch {
    return undefined;
  }
}

export class AppBridge {
  #state: "new" | "initializing" | "ready" = "new";
  #sent = false;
  #own = { sent: 0 };
  #calling = false;
  #size: { width: number; height: number } | undefined;
  #open = new AbortController();

  constructor(private readonly host: BridgeHost) {}

  /** The page went (the view closed, the session ended): a call still waiting is cancelled. */
  close(): void {
    this.#open.abort();
  }

  /** One message from the page's frame, as received (anything at all). Never throws: whatever the page sent, the answer
   *  is a reply the app can post back, possibly empty. */
  async handle(raw: unknown, pressed = false): Promise<McpAppReply> {
    const out: McpAppReply = { messages: [] };
    const length = jsonLength(raw);
    if (!isObject(raw) || length === undefined || length > MCP_APP_MESSAGE_MAX) return out;
    const idRaw = raw["id"];
    const id: Id | undefined = (typeof idRaw === "string" && idRaw.length > 0 && idRaw.length <= 128) || (typeof idRaw === "number" && Number.isFinite(idRaw)) ? idRaw : undefined;
    const answer = (m: Record<string, unknown>): void => { out.messages.push(m); };
    if (raw["jsonrpc"] !== "2.0" || typeof raw["method"] !== "string" || !METHOD.test(raw["method"]) || (raw["params"] !== undefined && !isObject(raw["params"]))) {
      // A response from the page (it has no method) or anything malformed: nothing asked, nothing to answer, unless it had an id to be told.
      if (id !== undefined && raw["method"] !== undefined) answer(fail(id, RPC.invalidRequest, "that isn't a JSON-RPC 2.0 request"));
      return out;
    }
    const method = raw["method"];
    const params = (raw["params"] ?? {}) as Record<string, unknown>;
    try {
      await this.#route(method, params, id, out, answer, pressed);
    } catch (err) {
      const refusal = err instanceof McpAppRefusal ? err : undefined;
      if (id !== undefined) answer(fail(id, refusal?.code === "bad_message" ? RPC.invalidParams : RPC.refused, refusal?.message ?? "the host couldn't do that"));
      this.host.log?.(`mcp-apps: ${method} failed (${refusal?.code ?? "error"})`);
    }
    if (this.#size !== undefined) out.size = this.#size;
    return out;
  }

  async #route(method: string, params: Record<string, unknown>, id: Id | undefined, out: McpAppReply, answer: (m: Record<string, unknown>) => void, pressed: boolean): Promise<void> {
    const needId = (): Id => {
      if (id === undefined) throw new McpAppRefusal("bad_message", `${method} is a request`);
      return id;
    };
    switch (method) {
      case "ui/initialize": {
        const rid = needId();
        this.#state = this.#state === "new" ? "initializing" : this.#state;
        answer(ok(rid, {
          protocolVersion: MCP_APPS_SPEC_VERSION,
          hostInfo: this.host.hostInfo,
          hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {} },
          hostContext: {
            toolInfo: { tool: { name: this.host.tool.name, ...(typeof this.host.tool.description === "string" ? { description: this.host.tool.description.slice(0, 2_000) } : {}), inputSchema: isObject(this.host.tool.inputSchema) ? this.host.tool.inputSchema : { type: "object" } } },
            displayMode: "inline", availableDisplayModes: ["inline"], platform: "desktop",
            containerDimensions: { maxHeight: MCP_APP_HEIGHT_MAX },
          },
        }));
        return;
      }
      case "ui/notifications/initialized": {
        // The host sends the page nothing before this (the extension's rule), and the input and the result once.
        if (this.#state !== "initializing" || this.#sent) return;
        this.#state = "ready";
        this.#sent = true;
        answer({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: this.host.input } });
        answer({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: this.host.result });
        return;
      }
      case "ui/notifications/size-changed": {
        const n = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.ceil(v), max) : undefined);
        const width = n(params["width"], 10_000);
        const height = n(params["height"], MCP_APP_HEIGHT_MAX);
        if (width !== undefined && height !== undefined) this.#size = { width, height };
        return;
      }
      case "ui/request-display-mode": {
        // Only the inline view exists here: whatever the page asks for, this is the mode it has.
        answer(ok(needId(), { mode: "inline" }));
        return;
      }
      case "ping": {
        answer(ok(needId(), {}));
        return;
      }
      case "notifications/message":
        return;
      case "ui/open-link": {
        const rid = needId();
        // THE PRESS RULE: `pressed` is the app's own word that the person's press landed in THIS view just before (never from the page).
        if (!pressed) throw new McpAppRefusal("refused_by_user", "a page may open a link only right after you press in it");
        const url = params["url"];
        let ok_ = false;
        if (typeof url === "string" && url.length <= OPEN_LINK_MAX) {
          try {
            const u = new URL(url);
            ok_ = (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "" && u.hostname !== "";
            ok_ = ok_ && u.href.length <= OPEN_LINK_MAX;
            if (ok_) out.openLink = u.href;
          } catch { /* not a URL */ }
        }
        if (!ok_) {
          answer(fail(rid, RPC.refused, "only an http or https address opens"));
          return;
        }
        answer(ok(rid, {}));
        return;
      }
      case "ui/message": {
        const rid = needId();
        if (!pressed) throw new McpAppRefusal("refused_by_user", "a page may send a message only right after you press in it");
        const content = params["content"];
        const text = isObject(content) && content["type"] === "text" && typeof content["text"] === "string" ? content["text"] : undefined;
        if (params["role"] !== "user" || text === undefined || text.trim() === "" || text.length > TEXT_MESSAGE_MAX) throw new McpAppRefusal("bad_message", "a message is { role: \"user\", content: { type: \"text\", text } } of at most 10,000 characters");
        const budget = this.host.budget ?? this.#own;
        if (budget.sent >= MESSAGES_PER_PAGE_MAX) throw new McpAppRefusal("refused_by_user", "this page has sent as many messages as it may");
        budget.sent++;
        await this.host.message(text);
        answer(ok(rid, {}));
        return;
      }
      case "tools/call": {
        const rid = needId();
        await this.#toolCall(rid, params, answer);
        return;
      }
      case "resources/read": {
        const rid = needId();
        const uri = params["uri"];
        if (typeof uri !== "string" || uri.length === 0 || uri.length > UI_URI_MAX) throw new McpAppRefusal("bad_message", "resources/read takes a uri");
        // A page reads only `ui://` resources (pages) of ITS OWN server (the host's door is that server's); never a file or any other scheme.
        if (!/^ui:\/\/[!-~]+$/.test(uri)) throw new McpAppRefusal("bad_message", "a page may read only ui:// resources of its own server");
        const contents = await this.host.readResource(uri);
        const result = { contents: contents.map((c) => ({ uri: c.uri, ...(c.mimeType !== undefined ? { mimeType: c.mimeType } : {}), ...(c.text !== undefined ? { text: c.text } : {}), ...(c.blobBase64 !== undefined ? { blob: c.blobBase64 } : {}) })) };
        const size = jsonLength(result);
        if (size === undefined || size > RESULT_MAX) throw new McpAppRefusal("too_large", "that resource is bigger than a page may read");
        answer(ok(rid, result));
        return;
      }
      default:
        if (id !== undefined) answer(fail(id, RPC.methodNotFound, `${method} isn't offered to a page here`));
        return;
    }
  }

  async #toolCall(rid: Id, params: Record<string, unknown>, answer: (m: Record<string, unknown>) => void): Promise<void> {
    const name = params["name"];
    const args = params["arguments"] === undefined ? {} : params["arguments"];
    if (typeof name !== "string" || name.length === 0 || name.length > 256 || !isObject(args)) throw new McpAppRefusal("bad_message", "tools/call takes a tool name and an object of arguments");
    const size = jsonLength(args);
    if (size === undefined || size > TOOL_ARGS_MAX) throw new McpAppRefusal("too_large", "the arguments are bigger than a page may send");
    // ONE call waiting at a time: a page cannot stack cards.
    if (this.#calling) throw new McpAppRefusal("refused_by_user", "this page already has a call waiting");
    this.#calling = true;
    try {
      // Its own server's listing, and only a tool that lists `app` among who may call it.
      const listing = await this.host.listTools();
      const tool = listing.find((t) => t.name === name);
      if (tool === undefined) throw new McpAppRefusal("no_such_tool", `this page's server has no tool ${JSON.stringify(name.slice(0, 80))}`);
      if (!toolVisibilityOf(tool).includes("app")) throw new McpAppRefusal("not_app_visible", `${JSON.stringify(name.slice(0, 80))} isn't one a page may call`);
      const signal = this.#open.signal;
      const verdict = await this.host.approve(name, args, signal);
      if (!verdict.allowed) {
        answer(fail(rid, RPC.refused, verdict.message.slice(0, 2_000)));
        return;
      }
      if (signal.aborted) throw new McpAppRefusal("failed", "the page was closed");
      const timeout = AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS);
      // On the input the session's hooks and approval left (a hook may have rewritten it), never the page's own words once changed.
      const result = await this.host.callTool(name, verdict.input ?? args, AbortSignal.any([signal, timeout]), verdict.ticket);
      const len = jsonLength(result);
      if (len === undefined || len > RESULT_MAX) throw new McpAppRefusal("too_large", "the tool's answer is bigger than a page may take");
      answer(ok(rid, result));
    } finally {
      this.#calling = false;
    }
  }
}
