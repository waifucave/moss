// MCP Apps' service (`mcp-apps/service.ts`): a binding is the host's, a page is read from the site's own server, and its calls
// are the session's own.
import { describe, expect, test } from "bun:test";
import { McpAppsService, ToolApps, type AppSite } from "../../src/mcp-apps/service";
import { McpAppRefusal, UI_MIME, type UiResourceContent } from "../../src/mcp-apps/resource";

const PAGE = "<!doctype html><title>chart</title><p>chart</p>";
const listing = (uri = "ui://charts/p") => [
  { name: "plot", _meta: { ui: { resourceUri: uri, visibility: ["model", "app"] } } },
  { name: "refresh", _meta: { ui: { visibility: ["app"] } } },
  { name: "plain" },
];

interface Log { reads: string[]; called: string[]; asked: string[] }
function site(o: { uri?: string; resource?: Partial<UiResourceContent>; tools?: ReturnType<typeof listing>; allow?: boolean; log?: Log } = {}): AppSite {
  const log = o.log ?? { reads: [], called: [], asked: [] };
  return {
    pluginId: "acme/charts", server: "acme-charts", tool: "plot", resourceUri: o.uri ?? "ui://charts/p",
    input: { q: 1 }, result: { content: [{ type: "text", text: "Rendered a chart." }] },
    listTools: async () => o.tools ?? listing(o.uri),
    readResource: async (uri) => { log.reads.push(uri); return [{ uri, mimeType: UI_MIME, text: PAGE, ...(o.resource ?? {}) }]; },
    callTool: async (name) => { log.called.push(name); return { content: [{ type: "text", text: `ran ${name}` }] }; },
    approve: async (name, _args, _signal, cardId) => { log.asked.push(`${name}@${cardId}`); return o.allow === false ? { allowed: false, message: "You said no." } : { allowed: true }; },
  };
}
const code = async (p: Promise<unknown>): Promise<string | undefined> => { try { await p; return undefined; } catch (e) { return e instanceof McpAppRefusal ? e.code : `other:${String(e)}`; } };
const make = (said: { pluginId: string; callId: string; text: string }[] = []) => new McpAppsService({ version: "0", deliver: async (_s, m) => { said.push(m); } });
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

describe("binding a page to a result", () => {
  test("the stamp is the site's page address", () => {
    expect(make().bind("s_1", "c1", site())).toEqual({ resourceUri: "ui://charts/p" });
  });
  test("ToolApps hands a stamp over once, and drops one on request", () => {
    const a = new ToolApps();
    a.put("c1", { resourceUri: "ui://x/y" });
    expect(a.take("c1")).toEqual({ resourceUri: "ui://x/y" });
    expect(a.take("c1")).toBeUndefined();
    a.put("c2", { resourceUri: "ui://x/z" });
    a.drop("c2");
    expect(a.take("c2")).toBeUndefined();
  });
});

describe("opening the page", () => {
  test("reads the bound page and answers a policy built from nothing declared", async () => {
    const svc = make();
    const log: Log = { reads: [], called: [], asked: [] };
    svc.bind("s_1", "c1", site({ log }));
    const open = await svc.open("s_1", "c1");
    expect(open.html).toBe(PAGE);
    expect(open.csp).toContain("connect-src 'none'");
    expect(open.maxHeight).toBe(1200);
    expect(log.reads).toEqual(["ui://charts/p"]);
  });
  test("a call id never bound, another session's, a detached session's and a request before open are refused", async () => {
    const svc = make();
    svc.bind("s_1", "c1", site());
    expect(await code(svc.open("s_1", "forged"))).toBe("not_here");
    expect(await code(svc.open("s_other", "c1"))).toBe("not_here");
    expect(await code(svc.request("s_1", "c1", rpc(1, "ping")))).toBe("not_here");
    await svc.open("s_1", "c1");
    svc.detach("s_1");
    expect(await code(svc.open("s_1", "c1"))).toBe("not_here");
    expect(await code(svc.request("s_1", "c1", rpc(2, "ping")))).toBe("not_here");
  });
  test("a wrong mime type, a huge page and a malformed declaration are refused when opened", async () => {
    for (const [resource, want] of [[{ mimeType: "text/html" }, "wrong_mime_type"], [{ text: "x".repeat(1_100_000) }, "too_large"], [{ _meta: { ui: { csp: { connectDomains: ["*"] } } } }, "bad_csp"]] as const) {
      const svc = make();
      svc.bind("s_1", "c1", site({ resource }));
      expect(await code(svc.open("s_1", "c1"))).toBe(want);
    }
  });
  test("a server that changed its tool's page since the result is refused: the event's address proves nothing", async () => {
    const svc = make();
    const log: Log = { reads: [], called: [], asked: [] };
    const s = site({ log });
    svc.bind("s_1", "c1", { ...s, listTools: async () => listing("ui://charts/other") });
    expect(await code(svc.open("s_1", "c1"))).toBe("not_found");
    svc.bind("s_1", "c2", { ...s, listTools: async () => [{ name: "plain" }] });
    expect(await code(svc.open("s_1", "c2"))).toBe("not_found");
    expect(log.reads).toEqual([]);
  });
});

describe("the bridge's calls are the session's own", () => {
  test("a page's tool call asks the site's approval under its own card id, then runs, only for the site's own server", async () => {
    const svc = make();
    const log: Log = { reads: [], called: [], asked: [] };
    svc.bind("s_1", "c1", site({ log }));
    await svc.open("s_1", "c1");
    await svc.request("s_1", "c1", rpc(1, "ui/initialize", {}));
    const r = await svc.request("s_1", "c1", rpc(2, "tools/call", { name: "refresh", arguments: { a: 1 } }));
    expect(log.asked).toEqual(["refresh@app-c1-1"]);
    expect(log.called).toEqual(["refresh"]);
    expect((r.messages[0] as { result: { content: { text: string }[] } }).result.content[0]!.text).toBe("ran refresh");
  });
  test("a refused call tells the page and never runs", async () => {
    const svc = make();
    const log: Log = { reads: [], called: [], asked: [] };
    svc.bind("s_1", "c1", site({ allow: false, log }));
    await svc.open("s_1", "c1");
    const r = await svc.request("s_1", "c1", rpc(2, "tools/call", { name: "refresh" }));
    expect((r.messages[0] as { error: { message: string } }).error.message).toBe("You said no.");
    expect(log.called).toEqual([]);
  });
  test("a tool the server's listing doesn't hold never reaches the approval", async () => {
    const svc = make();
    const log: Log = { reads: [], called: [], asked: [] };
    svc.bind("s_1", "c1", site({ log }));
    await svc.open("s_1", "c1");
    const r = await svc.request("s_1", "c1", rpc(2, "tools/call", { name: "someone-elses-tool" }));
    expect((r.messages[0] as { error: unknown }).error).toBeDefined();
    expect(log.asked).toEqual([]);
    expect(log.called).toEqual([]);
  });
  test("ui/message is delivered as its plugin's message, with the call that drew the page", async () => {
    const said: { pluginId: string; callId: string; text: string }[] = [];
    const svc = make(said);
    svc.bind("s_1", "c1", site());
    await svc.open("s_1", "c1");
    await svc.request("s_1", "c1", rpc(1, "ui/message", { role: "user", content: { type: "text", text: "pick the red one" } }));
    expect(said).toEqual([{ pluginId: "acme/charts", callId: "c1", text: "pick the red one" }]);
  });
});
