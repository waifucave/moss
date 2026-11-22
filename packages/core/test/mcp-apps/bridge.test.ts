// MCP Apps' bridge (`mcp-apps/bridge.ts`): what a page's frame may ask, with hostile input.
import { describe, expect, test } from "bun:test";
import { AppBridge, MESSAGES_PER_PAGE_MAX, RPC, type BridgeHost, type BridgeTool } from "../../src/mcp-apps/bridge";

interface Calls { approved: { name: string; args: Record<string, unknown> }[]; called: string[]; said: string[]; read: string[] }

function host(over: Partial<BridgeHost> = {}, tools: BridgeTool[] = []): { host: BridgeHost; calls: Calls } {
  const calls: Calls = { approved: [], called: [], said: [], read: [] };
  const listing: BridgeTool[] = tools.length > 0 ? tools : [
    { name: "plot", _meta: { ui: { resourceUri: "ui://c/p" } } },
    { name: "refresh", _meta: { ui: { visibility: ["app"] } } },
    { name: "secret_for_model", _meta: { ui: { visibility: ["model"] } } },
  ];
  return {
    calls,
    host: {
      hostInfo: { name: "MOSS Code", version: "0" },
      tool: listing[0]!, input: { q: 1 }, result: { content: [{ type: "text", text: "Rendered." }] },
      listTools: async () => listing,
      callTool: async (name) => { calls.called.push(name); return { content: [{ type: "text", text: `ran ${name}` }] }; },
      readResource: async (uri) => { calls.read.push(uri); return [{ uri, mimeType: "text/plain", text: "data" }]; },
      approve: async (name, args) => { calls.approved.push({ name, args }); return { allowed: true }; },
      message: async (text) => { calls.said.push(text); },
      ...over,
    },
  };
}
const req = (method: string, params?: unknown, id: string | number = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const note = (method: string, params?: unknown) => ({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
const errorOf = (r: { messages: Record<string, unknown>[] }) => (r.messages[0] as { error?: { code: number; message: string } } | undefined)?.error;
const resultOf = (r: { messages: Record<string, unknown>[] }) => (r.messages[0] as { result?: Record<string, unknown> } | undefined)?.result;

async function ready(b: AppBridge) {
  await b.handle(req("ui/initialize", { protocolVersion: "x", appCapabilities: {}, clientInfo: { name: "p", version: "1" } }));
  return await b.handle(note("ui/notifications/initialized"));
}

describe("the handshake", () => {
  test("initialize is answered with the version built against; the input and result come only after `initialized`, once", async () => {
    const { host: h } = host();
    const b = new AppBridge(h);
    const first = await b.handle(req("ui/initialize", { protocolVersion: "x" }));
    expect(first.messages).toHaveLength(1);
    expect(resultOf(first)!.protocolVersion).toBe("2026-01-26");
    expect((resultOf(first)!.hostContext as { displayMode: string }).displayMode).toBe("inline");
    const after = await b.handle(note("ui/notifications/initialized"));
    expect(after.messages.map((m) => m.method)).toEqual(["ui/notifications/tool-input", "ui/notifications/tool-result"]);
    expect((after.messages[0] as { params: unknown }).params).toEqual({ arguments: { q: 1 } });
    expect((await b.handle(note("ui/notifications/initialized"))).messages).toEqual([]);
  });
  test("`initialized` with no initialize before it sends nothing", async () => {
    const b = new AppBridge(host().host);
    expect((await b.handle(note("ui/notifications/initialized"))).messages).toEqual([]);
  });
  test("display modes other than inline are never granted", async () => {
    const b = new AppBridge(host().host);
    for (const mode of ["fullscreen", "pip", "inline", 5]) expect(resultOf(await b.handle(req("ui/request-display-mode", { mode })))).toEqual({ mode: "inline" });
  });
  test("size-changed is clamped and reported; nonsense is ignored", async () => {
    const b = new AppBridge(host().host);
    expect((await b.handle(note("ui/notifications/size-changed", { width: 300.2, height: 99_999 }))).size).toEqual({ width: 301, height: 1200 });
    const kept = await b.handle(note("ui/notifications/size-changed", { width: -1, height: "tall" }));
    expect(kept.size).toEqual({ width: 301, height: 1200 });
  });
});

describe("a page's call to a tool", () => {
  test("its own server's app-visible tool: approved, then run, with the arguments it sent", async () => {
    const { host: h, calls } = host();
    const b = new AppBridge(h);
    const r = await b.handle(req("tools/call", { name: "refresh", arguments: { n: 2 } }));
    expect(calls.approved).toEqual([{ name: "refresh", args: { n: 2 } }]);
    expect(calls.called).toEqual(["refresh"]);
    expect((resultOf(r) as { content: { text: string }[] }).content[0]!.text).toBe("ran refresh");
  });
  test("a tool that leaves out `app` is refused with no card and no call; so is one the server doesn't list (another server's)", async () => {
    const { host: h, calls } = host();
    const b = new AppBridge(h);
    expect(errorOf(await b.handle(req("tools/call", { name: "secret_for_model" })))!.code).toBe(RPC.refused);
    expect(errorOf(await b.handle(req("tools/call", { name: "mcp__other__delete_everything" })))!.code).toBe(RPC.refused);
    expect(errorOf(await b.handle(req("tools/call", { name: "Bash", arguments: { command: "id" } })))!.code).toBe(RPC.refused);
    expect(calls.approved).toEqual([]);
    expect(calls.called).toEqual([]);
  });
  test("a refusal is the page's answer, and the tool never runs", async () => {
    const { host: h, calls } = host({ approve: async () => ({ allowed: false, message: "denied by the user" }) });
    const b = new AppBridge(h);
    const r = await b.handle(req("tools/call", { name: "refresh" }));
    expect(errorOf(r)).toEqual({ code: RPC.refused, message: "denied by the user" });
    expect(calls.called).toEqual([]);
  });
  test("one call waits at a time: a second is refused while the first waits for its card", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { host: h, calls } = host({ approve: async () => { await gate; return { allowed: true }; } });
    const b = new AppBridge(h);
    const first = b.handle(req("tools/call", { name: "refresh" }, 1));
    await Promise.resolve();
    const second = await b.handle(req("tools/call", { name: "refresh" }, 2));
    expect(errorOf(second)!.message).toContain("already has a call waiting");
    release();
    expect(resultOf(await first)).toBeDefined();
    expect(calls.called).toEqual(["refresh"]);
  });
  test("malformed or huge arguments and names are refused before anything is asked", async () => {
    const { host: h, calls } = host();
    const b = new AppBridge(h);
    for (const params of [{}, { name: 5 }, { name: "" }, { name: "x".repeat(300) }, { name: "refresh", arguments: [] }, { name: "refresh", arguments: "x" }, { name: "refresh", arguments: { blob: "x".repeat(300_000) } }]) {
      expect(errorOf(await b.handle(req("tools/call", params)))).toBeDefined();
    }
    expect(calls.approved).toEqual([]);
  });
  test("a page closed while its card waits does not run the tool", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { host: h, calls } = host({ approve: async () => { await gate; return { allowed: true }; } });
    const b = new AppBridge(h);
    const pending = b.handle(req("tools/call", { name: "refresh" }));
    await Promise.resolve();
    b.close();
    release();
    expect(errorOf(await pending)).toBeDefined();
    expect(calls.called).toEqual([]);
  });
  test("an answer bigger than a page may take is refused", async () => {
    const { host: h } = host({ callTool: async () => ({ content: [{ type: "text", text: "x".repeat(1_100_000) }] }) });
    expect(errorOf(await new AppBridge(h).handle(req("tools/call", { name: "refresh" })))!.message).toContain("bigger");
  });
});

describe("links, messages and resources", () => {
  test("only an http(s) address opens, and it is reported for the app to open", async () => {
    const b = new AppBridge(host().host);
    const good = await b.handle(req("ui/open-link", { url: "https://example.com/a?b=1" }));
    expect(good.openLink).toBe("https://example.com/a?b=1");
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "moss-core://app/", "data:text/html,x", "https://u:p@example.com/", "not a url", 5, "https://example.com/" + "a".repeat(3000)]) {
      const r = await b.handle(req("ui/open-link", { url }));
      expect(r.openLink).toBeUndefined();
      expect(errorOf(r)).toBeDefined();
    }
  });
  test("ui/message: user text only, bounded, at most so many; it reaches the host as data", async () => {
    const { host: h, calls } = host();
    const b = new AppBridge(h);
    expect(resultOf(await b.handle(req("ui/message", { role: "user", content: { type: "text", text: "hello" } })))).toEqual({});
    expect(calls.said).toEqual(["hello"]);
    for (const params of [{ role: "assistant", content: { type: "text", text: "x" } }, { role: "user", content: { type: "image", data: "x" } }, { role: "user", content: { type: "text", text: "" } }, { role: "user", content: { type: "text", text: "x".repeat(10_001) } }, { role: "user" }, {}]) {
      expect(errorOf(await b.handle(req("ui/message", params)))).toBeDefined();
    }
    for (let i = 1; i < MESSAGES_PER_PAGE_MAX; i++) await b.handle(req("ui/message", { role: "user", content: { type: "text", text: "again" } }));
    expect(errorOf(await b.handle(req("ui/message", { role: "user", content: { type: "text", text: "one too many" } })))).toBeDefined();
    expect(calls.said).toHaveLength(MESSAGES_PER_PAGE_MAX);
  });
  test("resources/read goes to its own server and is bounded", async () => {
    const { host: h, calls } = host();
    const b = new AppBridge(h);
    expect((resultOf(await b.handle(req("resources/read", { uri: "ui://c/p" }))) as { contents: unknown[] }).contents).toHaveLength(1);
    expect(calls.read).toEqual(["ui://c/p"]);
    expect(errorOf(await b.handle(req("resources/read", { uri: 5 })))).toBeDefined();
    const big = host({ readResource: async (uri) => [{ uri, text: "x".repeat(1_200_000) }] }).host;
    expect(errorOf(await new AppBridge(big).handle(req("resources/read", { uri: "ui://c/p" })))!.message).toContain("bigger");
  });
});

describe("everything else, and malformed input", () => {
  test("another method is told 'method not found' and nothing runs; ui/update-model-context isn't offered", async () => {
    const { host: h, calls } = host();
    const b = new AppBridge(h);
    for (const method of ["ui/update-model-context", "tools/list", "resources/list", "prompts/get", "sampling/createMessage", "elicitation/create", "ui/resource-teardown", "initialize", "card.answer", "approval.respond", "user.send"]) {
      expect(errorOf(await b.handle(req(method, {})))!.code).toBe(RPC.methodNotFound);
    }
    expect(calls).toEqual({ approved: [], called: [], said: [], read: [] });
  });
  test("malformed messages never throw and never act", async () => {
    const { host: h, calls } = host();
    const b = new AppBridge(h);
    const cyclic: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method: "ping" };
    cyclic["self"] = cyclic;
    for (const raw of [null, undefined, 5, "x", [], {}, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, method: 5 }, { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", id: 1, method: "ping", params: [1] }, { jsonrpc: "2.0", id: 1, method: "a b" }, { jsonrpc: "2.0", id: 1, method: "x".repeat(200) }, cyclic, { jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1_100_000) }]) {
      const r = await b.handle(raw);
      expect(Array.isArray(r.messages)).toBe(true);
    }
    expect(calls).toEqual({ approved: [], called: [], said: [], read: [] });
    // A response from the page (no method) is nothing to answer.
    expect((await b.handle({ jsonrpc: "2.0", id: 9, result: {} })).messages).toEqual([]);
  });
  test("ping is answered", async () => {
    expect(resultOf(await new AppBridge(host().host).handle(req("ping")))).toEqual({});
  });
  test("a handshake with a view is complete: the whole sequence in order", async () => {
    const b = new AppBridge(host().host);
    const r = await ready(b);
    expect(r.messages).toHaveLength(2);
  });
});
