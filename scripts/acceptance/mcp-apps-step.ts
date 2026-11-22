// MCP Apps views (spec §14.2 item 66, §5.5; the extension `io.modelcontextprotocol/ui`, SEP-1865, 2026-01-26), on the real path:
// an MCP server (pasted by URL, so a plugin's server on the engine's own door) has a tool that names a `ui://` page. Alpha's
// conversation calls it; the result carries the page, the window draws it in an isolated view of its own (`moss-app://`), and
// the page, which does what a hostile one would, says what it could reach. Its own calls go through the session's approvals.
import { MCP_APP_MARK, REPORT, mcpAppFixture, type McpAppFixture } from "./mcp-app-fixture";
import { callTurn, fail, sleep, until, type ExampleCtx } from "./example-steps";

export const MCP_APPS_VIEW_STEP = "MCP Apps · a tool whose server names a ui:// page: the result carries its address and the engine reads the page from that server under a policy with no network and no frames;";
export const MCP_APPS_CALL_STEP = "MCP Apps · the page's own tool calls: its call raises the session's approval card and runs only after OK, a refused one tells the page and never runs, another server's tool is refused before any card; a forged call id and a page over the size cap are refused";
export const MCP_APPS_STEPS: readonly string[] = [MCP_APPS_VIEW_STEP, MCP_APPS_CALL_STEP];

type Ev = Record<string, unknown> & { type?: string };
interface Card { id: string; kind: string; session?: string; pluginId?: string }

/** The two rows share one fixture and one conversation: the first row sets it up and leaves its state for the second. */
interface Run { app: McpAppFixture; other: McpAppFixture; appPlugin: string; otherPlugin: string; callId: string }
let run: Run | undefined;

/** A bare added MCP server (`mcp.add`, the user's scope): the session's own child connects to it under `mcp__<name>__<tool>`. */
async function addServer(ctx: ExampleCtx, name: string, url: string): Promise<string> {
  await ctx.rpc.request("mcp.add", { name, entry: { type: "http", url }, scope: "user" }, 60_000);
  return name;
}

/** Everything the page said so far (its `ui/message`s reach the model as the session's next input). */
const said = (ctx: ExampleCtx): string => ctx.requests().map((r) => r.lastUserText).filter((t) => t.includes(REPORT)).join("\n");

async function pendingCard(ctx: ExampleCtx, session: string, word: string): Promise<string> {
  return await until(`a pending card for ${word}`, 60_000, async () => {
    for (const k of (await ctx.rpc.request<{ cards: Card[] }>("card.list", {})).cards) {
      if (k.kind === "plugin-ok") continue;
      const text = JSON.stringify((await ctx.rpc.request<{ card: unknown }>("card.get", { id: k.id }).catch(() => ({ card: "" }))).card);
      if (text.includes(word)) return k.id;
    }
    return undefined;
  }, async () => said(ctx).slice(0, 400));
}

export async function mcpAppsViewStep(ctx: ExampleCtx, bot: string): Promise<string> {
  const done: string[] = [];
  const app = mcpAppFixture({ name: "acc-app", tools: "app" });
  const other = mcpAppFixture({ name: "acc-other", tools: "other" });
  run = undefined;
  try {
    const appPlugin = await addServer(ctx, "accapp", app.url);
    const otherPlugin = await addServer(ctx, "accother", other.url);
    const turn = await callTurn(ctx, bot, "Chart", {});
    if (!turn.result.text.includes(MCP_APP_MARK)) fail(`the model's call of Chart answered "${turn.result.text.slice(0, 120)}"`);
    const stamped = (await ctx.history(bot)).filter((e: Ev) => e.type === "tool_result" && (e.app as { resourceUri?: string } | undefined)?.resourceUri === "ui://acc/chart");
    if (stamped.length !== 1) fail(`the Chart result carries its page's address ${stamped.length} time(s), not once`);
    const callId = String(stamped[0]!.callId);
    done.push("the result carries app.resourceUri ui://acc/chart");
    run = { app, other, appPlugin, otherPlugin, callId };
    // The engine reads the page from its own server, and gives it the policy with no network.
    const page = await ctx.rpc.request<{ html: string; csp: string; maxHeight: number }>("mcpApp.open", { session: bot, callId }, 30_000);
    if (!page.html.includes("ACC-CHART-PAGE")) fail("the page the engine read isn't the server's");
    if (!page.csp.includes("connect-src 'none'") || !page.csp.includes("frame-src 'none'")) fail(`the page's policy allows network or frames: ${page.csp}`);
    done.push(`the engine read the page (${page.html.length} chars) under "${page.csp.slice(0, 60)}…", height cap ${page.maxHeight}`);
    return done.join("; ");
  } catch (err) {
    run = undefined;
    for (const name of ["accapp", "accother"]) await ctx.rpc.request("mcp.remove", { name, scope: "user" }).catch(() => undefined);
    app.stop();
    other.stop();
    throw err;
  }
}

export async function mcpAppsCallStep(ctx: ExampleCtx, bot: string): Promise<string> {
  const r = run;
  if (r === undefined) return fail("the first MCP Apps row didn't leave its page up");
  const done: string[] = [];
  try {
    type Reply = { messages: { id?: number; result?: unknown; error?: { message: string } }[] };
    let n = 0;
    const ask = (method: string, params: unknown): Promise<Reply> => ctx.rpc.request<Reply>("mcpApp.request", { session: bot, callId: r.callId, message: { jsonrpc: "2.0", id: ++n, method, params } }, 120_000);
    const answer = (x: Reply): { result?: unknown; error?: { message: string } } | undefined => x.messages.find((m) => m.id === n);
    await ask("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "acc", version: "1" }, appCapabilities: {} });
    // Another server's tool: refused with no card, and the other server never saw it.
    const other = answer(await ask("tools/call", { name: "Other", arguments: {} }));
    if (other?.error === undefined) fail(`the page reached another server's tool: ${JSON.stringify(other)}`);
    if (r.other.seen.some((m) => m.startsWith("tools/call"))) fail("the other server was asked to run a tool for the page");
    done.push("another server's tool refused");
    // Its own app-only tool: a card first, and nothing runs while it waits.
    const firstCall = ask("tools/call", { name: "Refresh", arguments: { n: 1 } });
    const first = await pendingCard(ctx, bot, "Refresh");
    await sleep(500);
    if (r.app.refreshes() !== 0) fail("Refresh ran before the card was answered");
    await ctx.approveCard(first);
    const ok = answer(await firstCall);
    if (JSON.stringify(ok?.result ?? ok).includes("acc-refresh-done") === false || r.app.refreshes() !== 1) fail(`Refresh after OK: ${JSON.stringify(ok)}, ran ${r.app.refreshes()} time(s)`);
    done.push("its call raised a card, waited, and ran once after OK");
    // The second is refused: the page is told, and it never runs.
    const secondCall = ask("tools/call", { name: "Refresh", arguments: { n: 2 } });
    const second = await pendingCard(ctx, bot, "Refresh");
    await ctx.denyCard(second);
    const no = answer(await secondCall);
    if (no?.error === undefined || r.app.refreshes() !== 1) fail(`Refresh after No: ${JSON.stringify(no)}, ran ${r.app.refreshes()} time(s)`);
    done.push(`a refused call told the page ("${no!.error!.message.slice(0, 80)}") and never ran`);
    // A forged call id, and a page over the size cap.
    const forged = await ctx.rpc.request("mcpApp.open", { session: bot, callId: "toolu_forged" }, 30_000).then(() => "opened", (e: unknown) => String(e instanceof Error ? e.message : e));
    if (forged === "opened") fail("a call id the engine never stamped opened a page");
    const huge = await callTurn(ctx, bot, "Huge", {});
    const hugeCall = huge.events.find((e: Ev) => e.type === "tool_result" && (e.app as { resourceUri?: string } | undefined)?.resourceUri === "ui://acc/huge")
      ?? (await ctx.history(bot)).find((e: Ev) => e.type === "tool_result" && (e.app as { resourceUri?: string } | undefined)?.resourceUri === "ui://acc/huge");
    if (hugeCall === undefined) fail("the Huge result carries no page address");
    const refused = await ctx.rpc.request("mcpApp.open", { session: bot, callId: String(hugeCall!.callId) }, 30_000).then(() => "opened", (e: unknown) => String(e instanceof Error ? e.message : e));
    if (refused === "opened" || !/bigger|large|size/i.test(refused)) fail(`the 2 MB page: ${refused.slice(0, 160)}`);
    done.push(`a forged call id and a 2 MB page refused ("${refused.slice(0, 60)}")`);
    return done.join("; ");
  } finally {
    for (const name of [r.appPlugin, r.otherPlugin]) await ctx.rpc.request("mcp.remove", { name, scope: "user" }).catch(() => undefined);
    r.app.stop();
    r.other.stop();
    run = undefined;
  }
}
