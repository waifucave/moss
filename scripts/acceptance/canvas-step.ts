// The session canvas's acceptance rows (spec revision 20, §9.5): MOSS Code from source, its start page the canvas plugin.
// Registered by lane CS with an empty table; lanes CG, CM, CA and CP add rows here (the lane map in the spec's §9.5 says
// which). While it is empty, `units()` leaves the unit out; the lane that adds the first row also adds `canvas` to the
// acceptance matrix line of `.github/workflows/ci.yml` (it runs on GitHub: an app from source, like `moss`), and gives
// each row its body in this file.
//
// Lane CM's row (the cross-session tools): a fake ACP agent in place of a vendor's CLI (the acp unit's way, its own fixture
// plugin `acceptance-cross`), one process per coding session, each scripted through its own config file, which is rewritten
// before each start (a process reads its config once):
//
// 1. B, a coding session, says it is ready. A, a second coding session, is scripted to call the bridge's `ListSessions`
//    and then `SendMessage` to B by id, through the real bridge process and the daemon: `ListSessions` names B and not
//    the default bot's conversation, `SendMessage` answers "Sent.", and B's conversation holds a `session_message` that
//    names A as its sender and carries the words (never a `user_message`); B's agent was prompted with the words framed
//    as another session's. A `session_link` of kind `message` from A to B is heard when the engine emits it (lane CG's
//    graph; until it has merged the row says so and asserts the delivery alone).
// 2. C, a third session, is scripted to `SendMessage` to the default bot's conversation: its answer is an error that says no
//    session of that name may be messaged, and nothing reaches the bot's conversation.
// Removed afterwards, whatever happened.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fail, leave, sleep, until, type ExampleCtx } from "./example-steps";

export const CANVAS_CROSS_SESSION_STEP = "a code session's SendMessage to another code session lands in its conversation as a session_message from the sender (heard as a session_link where the engine emits it) and its ListSessions names that session and no bot's; its SendMessage to a bot's conversation is refused and delivers nothing";

/** The rows of the canvas unit. */
export const CANVAS_STEPS: readonly string[] = [CANVAS_CROSS_SESSION_STEP];

const CROSS_ID = "acceptance-cross";
const CROSS_NAME = "Acceptance Cross";
const FIXTURE = resolve(import.meta.dir, "fixtures", CROSS_ID);
const FAKE_ACP_AGENT = resolve(import.meta.dir, "..", "..", "packages", "core", "src", "agents", "testing", "fake-acp-agent.ts");
const READY = "CROSS-READY: this session is up";
const HELLO = "CROSS-HELLO: the API moved to v2; please update the client.";
const TO_BOT = "CROSS-TO-BOT: a message nobody may receive";

type Ev = Record<string, unknown> & { type?: string };
interface Card { id: string; kind: string; session?: string; pluginId?: string }
interface Report { type: string; [k: string]: unknown }

const reportOf = (file: string): Report[] => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Report);
  } catch {
    return [];
  }
};

/** The fixture's files with the run's paths written in (pure, so a test can check the result). */
export function crossFixtureWith(files: Record<string, string>, paths: { bun: string; fake: string; config: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(files)) out[name] = body.replaceAll("__BUN__", paths.bun).replaceAll("__FAKE__", paths.fake).replaceAll("__CONFIG__", paths.config);
  return out;
}

/** One session's config: the quirks file's quirks, where it reports, and its one turn. */
export function crossConfig(quirksFile: string, o: { report: string; selection: string; mcpEnv: Record<string, string>; turn: unknown[] }): string {
  const file = JSON.parse(quirksFile) as { quirks: unknown };
  return JSON.stringify({ quirks: file.quirks, version: "fake-agent 1.0.0", report: o.report, selection: o.selection, mcpEnv: o.mcpEnv, script: [o.turn] });
}

const bridge = (tool: string, input: unknown) => ({ mcp: { server: "$bridge", tool, input, ask: false } });

export async function canvasCrossSessionStep(ctx: ExampleCtx): Promise<string> {
  try {
    return await run(ctx);
  } finally {
    await leave(ctx, CROSS_ID);
  }
}

async function run(ctx: ExampleCtx): Promise<string> {
  const { rpc, root } = ctx;
  const done: string[] = [];
  const work = join(root, "canvas-cross");
  const folder = join(work, "plugin-src", CROSS_ID);
  const config = join(work, "agent", "agent.json");
  const reportB = join(work, "agent", "report-b.ndjson");
  const reportA = join(work, "agent", "report-a.ndjson");
  const reportC = join(work, "agent", "report-c.ndjson");
  mkdirSync(dirname(config), { recursive: true });
  cpSync(FIXTURE, folder, { recursive: true });
  const written = crossFixtureWith({ "moss.json": readFileSync(join(folder, "moss.json"), "utf8"), "quirks.json": readFileSync(join(folder, "quirks.json"), "utf8") }, { bun: process.execPath, fake: FAKE_ACP_AGENT, config });
  for (const [name, body] of Object.entries(written)) writeFileSync(join(folder, name), body);
  // The MOSS server the agent starts is this core's own binary: a test-marked one refuses to start without the run's keychain file's variable.
  const cfg = (report: string, turn: unknown[]) => writeFileSync(config, crossConfig(written["quirks.json"]!, { report, selection: join(work, "agent", "selection.json"), mcpEnv: { MOSS_TEST_KEYCHAIN: ctx.keychainFile }, turn }));

  // The plugin, behind its OK card pressed in the window, and its backend listed.
  cfg(reportB, [{ say: READY }]);
  const installed = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
  if (installed.id !== CROSS_ID) fail(`the fixture installed as ${installed.id}`);
  const ok = await until(`${CROSS_ID}'s OK card`, 60_000, async () => (await rpc.request<{ cards: Card[] }>("card.list")).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === CROSS_ID));
  const okText = JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: ok.id })).card);
  if (!okText.includes(CROSS_NAME)) fail(`its OK card doesn't name it: ${okText.slice(0, 300)}`);
  await ctx.pressCard(`${CROSS_ID}'s OK card`, (c) => c.id === ok.id);
  await until("its backend in agent.backends", 60_000, async () => (await rpc.request<{ backends: { id: string }[] }>("agent.backends", {})).backends.find((b) => b.id === CROSS_ID));

  const computer = (await rpc.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
  if (computer === undefined) fail("computer.list lists no computer");
  mkdirSync(join(ctx.userHome, "cross-work"), { recursive: true });
  const start = async (prompt: string): Promise<string> => (await rpc.request<{ session: string }>("agent.start", { backend: CROSS_ID, computer, root: `home/${computer}/cross-work`, prompt }, 60_000)).session;
  const answered = new Set<string>();
  const history = (session: string): Promise<Ev[]> => ctx.history(session).catch(() => [] as Ev[]);
  /** Waits for `probe` over a session's events, answering the cards its turns raise (this row's agents ask for nothing, but a card left would hold the island). */
  const heard = <T>(what: string, session: string, probe: (evs: Ev[]) => T | undefined, extra?: () => string) => until(what, 90_000, async () => {
    for (const c of (await rpc.request<{ cards: Card[] }>("card.list")).cards) {
      if (c.session !== session || answered.has(c.id)) continue;
      answered.add(c.id);
      await ctx.approveCard(c.id);
    }
    return probe(await history(session));
  }, async () => `${extra?.() ?? ""} events: ${(await history(session)).slice(-6).map((e) => String(e.type)).join(", ") || "none"}`);
  const mcpResult = (report: string, tool: string) => until(`the ${tool} call's answer`, 60_000, async () => reportOf(report).find((x) => x.type === "mcp-result" && x.tool === tool),
    async () => `the agent's report: ${reportOf(report).map((x) => x.type).join(", ") || "none (it never started)"}`);

  // The links the engine announces from here on (a `core.event` of the sessions area; a plugin hears one only when it may read both ends).
  const links: Ev[] = [];
  await rpc.request("events.subscribe", { areas: ["sessions"] }).catch(() => undefined);
  rpc.onNotification((method, params) => { if (method === "core.event" && (params as Ev | undefined)?.type === "session_link") links.push(params as Ev); });

  const bot = (await rpc.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {})).bots[0];
  if (bot === undefined) fail("bot.list lists no bot");

  // 1. B is up; A lists its sessions and sends to B.
  const b = await start("B");
  await heard("B's ready line", b, (evs) => (evs.some((e) => JSON.stringify(e).includes(READY)) && evs.some((e) => e.type === "turn_completed") ? true : undefined));
  cfg(reportA, [bridge("ListSessions", {}), bridge("SendMessage", { message: HELLO, to: b }), { say: "A-DONE" }]);
  const a = await start("A");
  const listed = await mcpResult(reportA, "ListSessions");
  if (listed.isError === true) fail(`A's ListSessions answered an error: ${String(listed.text).slice(0, 300)}`);
  const listText = String(listed.text);
  if (!listText.includes(b)) fail(`A's ListSessions doesn't name B (${b}): "${listText.slice(0, 400)}"`);
  if (listText.includes(bot!.mainSession) || listText.includes(a)) fail(`A's ListSessions names the bot's conversation or A itself: "${listText.slice(0, 400)}"`);
  const sent = await mcpResult(reportA, "SendMessage");
  if (sent.isError === true || !String(sent.text).includes("Sent")) fail(`A's SendMessage to B answered "${String(sent.text).slice(0, 300)}"`);
  const message = await heard("B's conversation to hold A's message", b, (evs) => evs.find((e) => e.type === "session_message"));
  if (message.fromSession !== a || message.text !== HELLO) fail(`B's session_message reads ${JSON.stringify(message).slice(0, 300)}, not from ${a} with the words`);
  if ((await history(b)).some((e) => e.type === "user_message" && JSON.stringify(e).includes("CROSS-HELLO"))) fail("the message reached B as the user's own");
  // B's agent was prompted with it, as another session's words.
  const prompted = await until("B's agent to be prompted with the message", 60_000, async () => reportOf(reportB).find((x) => x.type === "prompt" && String(x.text).includes("CROSS-HELLO")));
  if (!String(prompted.text).includes(`from-session="${a}"`) || !String(prompted.text).includes("not the person's words")) fail(`B's agent read the message as "${String(prompted.text).slice(0, 300)}"`);
  // A link is announced in the moment of the delivery; a moment later it has been heard or the engine does not emit one yet.
  await sleep(1_500);
  const link = links.find((l) => (l.to as { session?: string } | undefined)?.session === b);
  if (link !== undefined) {
    const from = link.from as { end?: string; session?: string } | undefined;
    if (link.link !== "message" || from?.session !== a) fail(`the link reads ${JSON.stringify(link).slice(0, 300)}, not a message from ${a}`);
  }
  done.push(`1 A (${a}) listed sessions ("${listText.replace(/\s+/g, " ").slice(0, 90)}…": B, no bot's conversation) and sent to B (${b}) by id: B's conversation holds a session_message from ${a} with the words and no user_message; B's agent read it as another session's ${link === undefined ? "(no session_link was emitted: the engine's graph, lane CG, has not merged; delivery asserted alone)" : "(and a session_link of kind message from A to B was heard)"}`);

  // 2. C sends to the default bot's conversation: refused, nothing delivered.
  const botBefore = (await history(bot!.mainSession)).length;
  cfg(reportC, [bridge("SendMessage", { message: TO_BOT, to: bot!.mainSession }), { say: "C-DONE" }]);
  const c = await start("C");
  const refused = await mcpResult(reportC, "SendMessage");
  if (refused.isError !== true || !String(refused.text).includes("No session you may message")) fail(`C's SendMessage to the bot's conversation answered ${JSON.stringify(refused).slice(0, 300)}, not a refusal`);
  await heard("C's turn to end", c, (evs) => (evs.some((e) => e.type === "turn_completed") ? true : undefined));
  const after = await history(bot!.mainSession);
  if (JSON.stringify(after).includes("CROSS-TO-BOT") || after.some((e) => e.type === "session_message")) fail("the message reached the bot's conversation");
  void botBefore;
  done.push(`2 C (${c}) sent to the default bot's conversation (${bot!.mainSession}): refused ("${String(refused.text).slice(0, 70)}…"), nothing in the conversation`);
  return done.join("; ");
}
