// `moss:app-view` through the real handler (`installIpc`): only a part that reads sessions or bots' conversations may place an
// MCP Apps page. A part with neither capability changes nothing: no placement, no hook, the answer is "hidden".
import { describe, expect, mock, test } from "bun:test";

const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
mock.module("electron", () => ({
  app: {}, protocol: {}, webFrameMain: { fromId: () => undefined },
  ipcMain: { handle: (c: string, fn: never) => handlers.set(c, fn), on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: { fromWebContents: () => ({ id: 7 }) },
}));

const frame = { processId: 1, routingId: 2, detached: false, url: "moss-plugin://p/", osProcessId: 9, parent: null };
const event = { senderFrame: frame, sender: {} };

async function setup(capabilities: string[]) {
  const { installIpc } = await import("../src/main/ui/electron");
  const placed: unknown[] = [];
  const logs: string[] = [];
  const runtime = {
    partOf: () => "acme/other", capabilitiesOf: () => new Set(capabilities), send: () => {},
    placeOf: () => ({ steps: [] }),
  };
  const hooks = { appFrame: (...a: unknown[]) => { placed.push(a); return "shown"; } };
  installIpc(runtime as never, hooks as never, (l) => logs.push(l));
  return { placed, logs, call: (arg: unknown) => handlers.get("moss:app-view")!(event, arg) };
}

describe("who may place an MCP Apps page", () => {
  test("a part with neither capability changes nothing", async () => {
    const t = await setup(["browser", "user.send", "approvals"]);
    expect(await t.call({ mount: "m1", session: "s_1", callId: "c1", rect: null })).toEqual({ state: "hidden" });
    expect(t.placed).toEqual([]);
    expect(t.logs.some((l) => l.includes("may not place an app view"))).toBe(true);
  });
  test("a part that reads sessions reaches the placement hook", async () => {
    const t = await setup(["sessions.read"]);
    await t.call({ mount: "m1", session: "s_1", callId: "c1", rect: null });
    expect(t.placed).toHaveLength(1);
  });
});
