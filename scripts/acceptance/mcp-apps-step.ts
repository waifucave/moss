// MCP Apps views (spec §14.2 item 66, §5.5; the extension `io.modelcontextprotocol/ui`, SEP-1865, 2026-01-26), on the real path:
// an MCP server (pasted by URL, so wrapped in a plugin as every added server is) has a tool that names a `ui://` page. The
// window's code session on MOSS's own agent calls it through the plugin bridge; the result carries the page, the window draws it in an isolated view of its own (`moss-app://`), and
// the page, which does what a hostile one would, says what it could reach. Its own calls go through the session's approvals.
import { MCP_APP_MARK, REPORT, mcpAppFixture, type McpAppFixture } from "./mcp-app-fixture";
import { callTurn, fail, sleep, toSessionTab, until, type ExampleCtx } from "./example-steps";

export const MCP_APPS_VIEW_STEP = "MCP Apps · a tool whose server names a ui:// page: the result carries it, the window draws it in an isolated view of its own (moss-app://), and the page, trying its parent, a navigation away and the network, reaches none of them";
export const MCP_APPS_CALL_STEP = "MCP Apps · the page's own tool calls: its call raises the session's approval card and runs only after OK, a refused one tells the page and never runs, another server's tool is refused before any card; a forged call id and a page over the size cap are refused";
export const MCP_APPS_STEPS: readonly string[] = [MCP_APPS_VIEW_STEP, MCP_APPS_CALL_STEP];

type Ev = Record<string, unknown> & { type?: string };
interface Card { id: string; kind: string; session?: string; pluginId?: string }

/** The two rows share one fixture and one conversation: the first row sets it up and leaves its state for the second. */
interface Run { app: McpAppFixture; other: McpAppFixture; appPlugin: string; otherPlugin: string; callId: string }
let run: Run | undefined;

async function installUrl(ctx: ExampleCtx, url: string): Promise<string> {
  const r = await ctx.rpc.request<{ id: string; card?: string }>("plugin.install", { source: { from: "wrap", kind: "mcp-url", value: url } }, 60_000);
  const card = await until(`${r.id}'s OK card`, 30_000, async () =>
    (await ctx.rpc.request<{ cards: Card[] }>("card.list", {})).cards.find((k) => k.kind === "plugin-ok" && ((r.card !== undefined && k.id === r.card) || k.pluginId === r.id)));
  await ctx.approveCard(card.id);
  await until(`${r.id} on after its OK`, 60_000, async () => {
    const st = (await ctx.rpc.request<{ plugin?: { state?: string } }>("plugin.get", { id: r.id }).catch(() => undefined))?.plugin?.state;
    return st === "running" || st === "enabled" ? true : undefined;
  });
  return r.id;
}

/** Everything the page said so far: what it read as `ui://acc/report/…` of its own server (a page's `ui/message` needs the person's press). */
let reporter: McpAppFixture | undefined;
const said = (_ctx: ExampleCtx): string => (reporter?.reports() ?? []).map((t) => `${REPORT} ${t}`).join("\n");

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

export async function mcpAppsViewStep(ctx: ExampleCtx, session: string): Promise<string> {
  const done: string[] = [];
  const app = mcpAppFixture({ name: "acc-app", tools: "app" });
  const other = mcpAppFixture({ name: "acc-other", tools: "other" });
  run = undefined;
  reporter = app;
  try {
    const appPlugin = await installUrl(ctx, app.url);
    const otherPlugin = await installUrl(ctx, other.url);
    await toSessionTab(ctx);
    const turn = await callTurn(ctx, session, "Chart", {});
    if (!turn.result.text.includes(MCP_APP_MARK)) fail(`the model's call of Chart answered "${turn.result.text.slice(0, 120)}"`);
    const stamped = (await ctx.history(session)).filter((e: Ev) => e.type === "tool_result" && (e.app as { resourceUri?: string } | undefined)?.resourceUri === "ui://acc/chart");
    if (stamped.length !== 1) fail(`the Chart result carries its page's address ${stamped.length} time(s), not once`);
    const callId = String(stamped[0]!.callId);
    done.push("the result carries app.resourceUri ui://acc/chart");
    run = { app, other, appPlugin, otherPlugin, callId };
    // The window draws it: a document of its own on moss-app://, in no plugin layer's or the app's origin.
    const doc = await until("the page's view (moss-app://)", 60_000, async () => (await ctx.cdp.documents()).find((d) => d.url.startsWith("moss-app://")),
      async () => (await ctx.cdp.documents()).map((d) => d.url.slice(0, 50)).join(" || "));
    if (!/^moss-app:\/\/[0-9a-f]{24}\//.test(doc.url)) fail(`the view is on ${doc.url.slice(0, 60)}`);
    done.push(`drawn on ${doc.url.replace(/^(moss-app:\/\/[^/]*\/).*/, "$1…")}`);
    // What the page could reach, in its own words (it ran its attempts, then said so).
    const report = await until("the page's isolation report", 60_000, async () => /ACC-APP-REPORT isolation[^\n]*/.exec(said(ctx))?.[0], async () => said(ctx).slice(0, 300));
    if (!/parent=blocked nav=blocked net=blocked file=blocked/.test(report)) fail(`the page reached something: ${report}`);
    // A page's message and link need the person's press in the view: with none they are refused, no turn starts, and a file:// resource is refused.
    const nopress = await until("the page's report of an unpressed message and link", 60_000, async () => /ACC-APP-REPORT nopress[^\n]*/.exec(said(ctx))?.[0], async () => said(ctx).slice(0, 300));
    if (!/message=error:[^ ]*.* link=error:/.test(nopress) || /file=\{/.test(nopress)) fail(`the page's unpressed message or link wasn't refused: ${nopress}`);
    if (ctx.requests().some((q) => q.lastUserText.includes("ACC-NOPRESS-TURN"))) fail("a page's message with no press reached the model");
    done.push("a message and a link with no press in the view were refused (no turn started)");
    if (app.probes() !== 0) fail(`the page's network attempt reached its server ${app.probes()} time(s)`);
    done.push(`the page reports "${report.replace(REPORT + " ", "")}", and its server saw no probe`);
    return done.join("; ");
  } catch (err) {
    run = undefined;
    app.stop();
    other.stop();
    throw err;
  }
}

export async function mcpAppsCallStep(ctx: ExampleCtx, session: string): Promise<string> {
  const r = run;
  if (r === undefined) return fail("the first MCP Apps row didn't leave its page up");
  const done: string[] = [];
  try {
    // The page waits at a gate: no card of its own exists until now, so the run's turn helper (which answers any card of the session
    // that shows while it waits for a turn to end) can't have answered one before this row looks for it.
    if (r.app.refreshes() !== 0) fail(`Refresh ran before the page was let ask (${r.app.refreshes()} time(s))`);
    r.app.openGate();
    // Another server's tool: refused with no card, and the other server never saw it.
    const other = await until("the page's report of the other server's tool", 60_000, async () => /ACC-APP-REPORT other=[^\n]*/.exec(said(ctx))?.[0], async () => said(ctx).slice(0, 300));
    if (!/other=error:/.test(other)) fail(`the page reached another server's tool: ${other}`);
    if (r.other.seen.some((m) => m.startsWith("tools/call"))) fail("the other server was asked to run a tool for the page");
    done.push("another server's tool refused");
    // Its own app-only tool: a card first, and nothing runs while it waits.
    const first = await pendingCard(ctx, session, "Refresh");
    await sleep(500);
    if (r.app.refreshes() !== 0) fail(`Refresh ran with its card unanswered (${r.app.refreshes()} run(s) at ${r.app.refreshTimes().join(", ")})`);
    // The answer is sent at answeredFrom and accepted by the engine when approveCard returns; the tool's run, which the server
    // times itself, can only begin after the engine recorded the answer, so it must not precede answeredFrom.
    const answeredFrom = Date.now();
    await ctx.approveCard(first);
    const answeredTo = Date.now();
    const ok = await until("the page's report of Refresh #1", 60_000, async () => /ACC-APP-REPORT refresh1=[^\n]*/.exec(said(ctx))?.[0], async () => said(ctx).slice(0, 300));
    if (!ok.includes("acc-refresh-done") || r.app.refreshes() !== 1) fail(`Refresh after OK: "${ok}", ran ${r.app.refreshes()} time(s)`);
    const ranAt = r.app.refreshTimes()[0]!;
    if (ranAt < answeredFrom) fail(`Refresh began at ${ranAt}, before its card's answer was sent at ${answeredFrom}`);
    done.push(`its call raised a card, waited, and ran once after OK (answer sent ${answeredFrom}, accepted ${answeredTo}, the tool began ${ranAt}: ${ranAt - answeredFrom} ms after the answer was sent)`);
    // The second is refused: the page is told, and it never runs.
    const second = await pendingCard(ctx, session, "Refresh");
    await ctx.denyCard(second);
    const no = await until("the page's report of Refresh #2", 60_000, async () => /ACC-APP-REPORT refresh2=[^\n]*/.exec(said(ctx))?.[0], async () => said(ctx).slice(0, 300));
    if (!/refresh2=error:/.test(no) || r.app.refreshes() !== 1) fail(`Refresh after No: "${no}", ran ${r.app.refreshes()} time(s)`);
    done.push(`a refused call told the page ("${no.replace(REPORT + " ", "").slice(0, 80)}") and never ran`);
    // A forged call id, and a page over the size cap.
    const forged = await ctx.rpc.request("mcpApp.open", { session, callId: "toolu_forged" }, 30_000).then(() => "opened", (e: unknown) => String(e instanceof Error ? e.message : e));
    if (forged === "opened") fail("a call id the engine never stamped opened a page");
    const huge = await callTurn(ctx, session, "Huge", {});
    const hugeCall = huge.events.find((e: Ev) => e.type === "tool_result" && (e.app as { resourceUri?: string } | undefined)?.resourceUri === "ui://acc/huge")
      ?? (await ctx.history(session)).find((e: Ev) => e.type === "tool_result" && (e.app as { resourceUri?: string } | undefined)?.resourceUri === "ui://acc/huge");
    if (hugeCall === undefined) fail("the Huge result carries no page address");
    const refused = await ctx.rpc.request("mcpApp.open", { session, callId: String(hugeCall!.callId) }, 30_000).then(() => "opened", (e: unknown) => String(e instanceof Error ? e.message : e));
    if (refused === "opened") fail(`the 2 MB page: ${refused.slice(0, 160)}`);
    done.push(`a forged call id and a 2 MB page refused ("${refused.slice(0, 60)}")`);
    return done.join("; ");
  } finally {
    for (const id of [r.appPlugin, r.otherPlugin]) {
      const rm = await ctx.rpc.request<{ card?: string }>("plugin.remove", { id }).catch(() => undefined);
      if (rm?.card !== undefined) await ctx.approveCard(rm.card).catch(() => undefined);
    }
    r.app.stop();
    r.other.stop();
    run = undefined;
  }
}
