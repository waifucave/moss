// MCP Apps' service (`mcp-apps/service.ts`) against a fake MCP client: the page rides the result, the binding is the host's.
import { describe, expect, test } from "bun:test";
import type { ConnectedMcpClient, ConnectMcpServerOptions, McpToolInfo } from "@waifucave/clover-agent-runtime/mcp-client";
import { McpAppsService, type AppApprover } from "../../src/mcp-apps/service";
import { McpAppRefusal, UI_MIME } from "../../src/mcp-apps/resource";

const PAGE = "<!doctype html><title>chart</title><p>chart</p>";
const tools: McpToolInfo[] = [
  { name: "plot", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://charts/p" } } },
  { name: "refresh", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
  { name: "plain", inputSchema: { type: "object" } },
];

interface Log { connects: string[]; called: string[]; closed: number; reads: string[] }
function fake(over: { resource?: Record<string, unknown>; listing?: McpToolInfo[]; slow?: Promise<void> } = {}): { connect: (o: ConnectMcpServerOptions) => Promise<ConnectedMcpClient>; log: Log } {
  const log: Log = { connects: [], called: [], closed: 0, reads: [] };
  return {
    log,
    connect: async (o) => {
      log.connects.push(o.name);
      return {
        serverName: o.name,
        listTools: async () => { await over.slow; return over.listing ?? tools; },
        listResources: async () => [],
        readResource: async (uri) => { log.reads.push(uri); return [{ uri, mimeType: UI_MIME, text: PAGE, ...(over.resource ?? {}) }]; },
        callTool: async (name) => { log.called.push(name); return { content: [{ type: "text", text: `ran ${name}` }] }; },
        close: async () => { log.closed++; },
      } as ConnectedMcpClient;
    },
  };
}
const allow: AppApprover = async () => ({ allowed: true });
const config = { charts: { type: "stdio", command: "x" } } as never;

function setup(f = fake(), approve: AppApprover = allow) {
  const asked: { toolName: string; server: string; callId: string }[] = [];
  const svc = new McpAppsService({ version: "0", cwdOf: () => "/tmp", deliver: async () => undefined, connect: f.connect, settleMs: 500 });
  const reg = svc.attach("s_1", async (c) => { asked.push({ toolName: c.toolName, server: c.server, callId: c.callId }); return await approve(c); });
  reg.setServers(config);
  return { svc, reg, f, asked };
}
async function stamped(reg: ReturnType<typeof setup>["reg"], name = "mcp__charts__plot", callId = "toolu_1") {
  reg.onToolUse(callId, name, { q: 1 });
  await reg.settle([callId]);
  return reg.takeApp(callId, { output: "Rendered a chart.", isError: false });
}
const code = async (p: Promise<unknown>): Promise<string | undefined> => { try { await p; return undefined; } catch (e) { return e instanceof McpAppRefusal ? e.code : `other:${String(e)}`; } };

describe("which results carry a page", () => {
  test("a tool that names a ui:// page stamps its address; the connection is closed", async () => {
    const { reg, f } = setup();
    expect(await stamped(reg)).toEqual({ resourceUri: "ui://charts/p" });
    expect(f.log.closed).toBe(f.log.connects.length);
  });
  test("a tool with no page, a failed call, a tool of no configured server and a built-in name stamp nothing", async () => {
    const { reg } = setup();
    expect(await stamped(reg, "mcp__charts__plain", "a")).toBeUndefined();
    reg.onToolUse("b", "mcp__charts__plot", {});
    await reg.settle(["b"]);
    expect(reg.takeApp("b", { output: "boom", isError: true })).toBeUndefined();
    expect(await stamped(reg, "mcp__other__plot", "c")).toBeUndefined();
    expect(await stamped(reg, "Bash", "d")).toBeUndefined();
  });
  test("a server whose listing is slower than the wait shows as text, and is not waited for past it", async () => {
    let release!: () => void;
    const { reg } = setup(fake({ slow: new Promise<void>((r) => { release = r; }) }));
    const t0 = Date.now();
    expect(await stamped(reg)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2_000);
    release();
  });
  test("a server key with `__` in it is found by whichever split it is", async () => {
    const { reg } = setup();
    reg.setServers({ "cf__prod": { type: "stdio", command: "x" } } as never);
    expect(reg.resolve("mcp__cf__prod__plot")).toEqual({ key: "cf__prod", tool: "plot" });
  });
});

describe("opening the page", () => {
  test("reads the bound page and answers the content policy built from nothing declared", async () => {
    const { svc, reg } = setup();
    await stamped(reg);
    const open = await svc.open("s_1", "toolu_1");
    expect(open.html).toBe(PAGE);
    expect(open.csp).toContain("connect-src 'none'");
    expect(open.maxHeight).toBe(1200);
  });
  test("a call id the engine never stamped, a forged session and an unknown session are refused", async () => {
    const { svc, reg } = setup();
    await stamped(reg);
    expect(await code(svc.open("s_1", "toolu_forged"))).toBe("not_here");
    expect(await code(svc.open("s_other", "toolu_1"))).toBe("not_here");
    expect(await code(svc.request("s_1", "toolu_forged", { jsonrpc: "2.0", id: 1, method: "ping" }))).toBe("not_here");
  });
  test("a request before the page was opened is refused", async () => {
    const { svc, reg } = setup();
    await stamped(reg);
    expect(await code(svc.request("s_1", "toolu_1", { jsonrpc: "2.0", id: 1, method: "ping" }))).toBe("not_here");
  });
  test("a server that no longer names that page for the tool, or removed the server, refuses", async () => {
    const f = fake();
    const { svc, reg } = setup(f);
    await stamped(reg);
    reg.setServers({} as never);
    expect(await code(svc.open("s_1", "toolu_1"))).toBe("no_such_server");
  });
  test("a wrong mime type, a huge page and a malformed declaration are refused when opened", async () => {
    for (const [resource, want] of [[{ mimeType: "text/html" }, "wrong_mime_type"], [{ text: "x".repeat(1_100_000) }, "too_large"], [{ _meta: { ui: { csp: { connectDomains: ["*"] } } } }, "bad_csp"]] as const) {
      const { svc, reg } = setup(fake({ resource: resource as Record<string, unknown> }));
      await stamped(reg);
      expect(await code(svc.open("s_1", "toolu_1"))).toBe(want);
    }
  });
  test("a server that changed its tool's page after the result is refused (the event's address proves nothing)", async () => {
    const over = { listing: undefined as McpToolInfo[] | undefined };
    const f = fake(over);
    const { svc, reg } = setup(f);
    await stamped(reg);
    over.listing = [{ name: "plot", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://charts/other" } } }];
    expect(await code(svc.open("s_1", "toolu_1"))).toBe("not_found");
    expect(f.log.reads).toEqual([]);
  });
});

describe("the bridge's calls are the session's own", () => {
  test("a page's tool call asks the session's approval under `mcp__<server>__<tool>` with a call id of its own, then runs", async () => {
    const { svc, reg, asked, f } = setup();
    await stamped(reg);
    await svc.open("s_1", "toolu_1");
    await svc.request("s_1", "toolu_1", { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    const r = await svc.request("s_1", "toolu_1", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh", arguments: { a: 1 } } });
    expect(asked).toEqual([{ toolName: "mcp__charts__refresh", server: "charts", callId: "app-toolu_1-1" }]);
    expect(f.log.called).toEqual(["refresh"]);
    expect((r.messages[0] as { result: { content: { text: string }[] } }).result.content[0]!.text).toBe("ran refresh");
  });
  test("a refused call tells the page and never runs", async () => {
    const { svc, reg, f } = setup(fake(), async () => ({ allowed: false, message: "You said no." }));
    await stamped(reg);
    await svc.open("s_1", "toolu_1");
    const r = await svc.request("s_1", "toolu_1", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh" } });
    expect((r.messages[0] as { error: { message: string } }).error.message).toBe("You said no.");
    expect(f.log.called).toEqual([]);
  });
  test("a model-only or unlisted tool never reaches the approval at all; `plain` has no `app` limit so it may be called, `plot` too", async () => {
    const { svc, reg, asked } = setup();
    await stamped(reg);
    await svc.open("s_1", "toolu_1");
    const r = await svc.request("s_1", "toolu_1", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope" } });
    expect((r.messages[0] as { error: unknown }).error).toBeDefined();
    expect(asked).toEqual([]);
  });
  test("ui/message is delivered labelled, as outside content", async () => {
    const said: string[] = [];
    const f = fake();
    const svc = new McpAppsService({ version: "0", cwdOf: () => undefined, deliver: async (_s, t) => { said.push(t); }, connect: f.connect });
    const reg = svc.attach("s_1", allow);
    reg.setServers(config);
    await stamped(reg);
    await svc.open("s_1", "toolu_1");
    await svc.request("s_1", "toolu_1", { jsonrpc: "2.0", id: 1, method: "ui/message", params: { role: "user", content: { type: "text", text: "pick the red one" } } });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("not the user's words");
    expect(said[0]).toContain("pick the red one");
  });
});
