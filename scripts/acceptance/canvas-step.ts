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
//    as another session's. A `session_link` of kind `message` from A to B is heard (lane CG's graph), and the engine's
//    record of links (`session.links`) keeps the pair.
// 2. C, a third session, is scripted to `SendMessage` to the default bot's conversation: its answer is an error that says no
//    session of that name may be messaged, and nothing reaches the bot's conversation.
// Removed afterwards, whatever happened.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fail, leave, until, type ExampleCtx } from "./example-steps";
import { sessionMotion } from "../../packages/protocol/src/session-graph";
import { activeCatalog } from "../../packages/core/src/runtime-sdk/model-plugins/catalog-source";
import { familyOfModel, lightModelOn } from "../../packages/core/src/runtime-sdk/model-plugins/light-model";
import { fixtureWith } from "./acp-backend-step";
import { CHILD_REPORT } from "./fake-anthropic";

export const CANVAS_CROSS_SESSION_STEP = "a code session's SendMessage to another code session lands in its conversation as a session_message from the sender (heard as a session_link, and kept in session.links) and its ListSessions names that session and no bot's; its SendMessage to a bot's conversation is refused and delivers nothing";


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
export function crossConfig(quirksFile: string, o: { report: string; selection: string; mcpEnv: Record<string, string>; turn: unknown[]; then?: unknown[] }): string {
  const file = JSON.parse(quirksFile) as { quirks: unknown };
  return JSON.stringify({ quirks: file.quirks, version: "fake-agent 1.0.0", report: o.report, selection: o.selection, mcpEnv: o.mcpEnv, script: [o.turn, ...(o.then === undefined ? [] : [o.then])] });
}

const bridge = (tool: string, input: unknown) => ({ mcp: { server: "$bridge", tool, input, ask: false } });

export async function canvasCrossSessionStep(ctx: ExampleCtx): Promise<string> {
  try {
    return await run(ctx);
  } finally {
    await leave(ctx, CROSS_ID);
  }
}

/** The fixture plugin installed (its OK card pressed in the window), its backend listed, and what the rows over it use. */
async function crossWorld(ctx: ExampleCtx) {
  const { rpc, root } = ctx;
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
  const cfg = (report: string, turn: unknown[], then?: unknown[]) => writeFileSync(config, crossConfig(written["quirks.json"]!, { report, selection: join(work, "agent", "selection.json"), mcpEnv: { MOSS_TEST_KEYCHAIN: ctx.keychainFile }, turn, ...(then === undefined ? {} : { then }) }));

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
  return { rpc, work, reportA, reportB, reportC, cfg, computer, start, heard, history, mcpResult, links, bot: bot! };
}

async function run(ctx: ExampleCtx): Promise<string> {
  const { rpc, reportA, reportB, reportC, cfg, start, heard, history, mcpResult, links, bot } = await crossWorld(ctx);
  const done: string[] = [];

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
  // The link, announced at the delivery (lane CG's graph): heard, a message from A, with no words; and kept in the
  // engine's record of links (`session.links`), which a canvas opened later reads.
  // B's own first prompt was the person's (a link from the person to B): the one asked for is A's.
  const link = await until("the session_link from A to B", 30_000, async () => links.find((l) => (l.to as { session?: string } | undefined)?.session === b && (l.from as { session?: string } | undefined)?.session === a),
    async () => `links heard: ${links.map((l) => JSON.stringify(l).slice(0, 160)).join(" | ") || "none"} [packages/core/src/sessions/durable-host.ts deliver]`);
  const from = link.from as { end?: string; session?: string } | undefined;
  if (link.link !== "message" || from?.session !== a) fail(`the link reads ${JSON.stringify(link).slice(0, 300)}, not a message from ${a}`);
  if (Object.keys(link).sort().join(",") !== "from,link,to,ts,type") fail(`the link carries more than who, whom, what and when: ${JSON.stringify(link).slice(0, 300)}`);
  const kept = await rpc.request<{ pairs: { from: { session?: string }; to: { session: string }; count: number; last: string }[] }>("session.links", {});
  const pair = kept.pairs.find((p) => p.from.session === a && p.to.session === b);
  if (pair === undefined || pair.last !== "message" || pair.count < 1) fail(`session.links keeps no pair from A to B: ${JSON.stringify(kept.pairs).slice(0, 300)} [packages/core/src/sessions/session-graph.ts links]`);
  done.push(`1 A (${a}) listed sessions ("${listText.replace(/\s+/g, " ").slice(0, 90)}…": B, no bot's conversation) and sent to B (${b}) by id: B's conversation holds a session_message from ${a} with the words and no user_message; B's agent read it as another session's; a session_link of kind message from A to B was heard, and session.links keeps the pair (${pair!.count})`);

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

/** Row (lane CM, the owner's rule of 2026-11-22: "a session created by a bot may message that bot and any other session. that session
 *  cannot message other bots unless they message it first. a session created by the user may message any other session, it still
 *  cannot message bots unless these bots message it first"): Alpha's `Agent` starts a session K on the fixture's fake agent, scripted
 *  to list its sessions and message B, a session the person started. B holds the message as a `session_message` from that session,
 *  with its words, never a `user_message`; B's agent reads it as another session's and a `session_link` from K to B is heard. Then C,
 *  a session the person started, is scripted to message K (a session a bot created: delivered) and Alpha's conversation (refused in
 *  the one sentence while Alpha has never written to C, nothing delivered). Alpha's conversation then writes to C; C's agent, woken
 *  by it, answers Alpha's conversation, and that reply now lands there as a `session_message` from C, never the person's. */
export async function canvasBotReachStep(ctx: ExampleCtx): Promise<string> {
  try {
    return await botReach(ctx);
  } finally {
    await leave(ctx, CROSS_ID);
  }
}

const FROM_BOT = "CROSS-FROM-BOT-SESSION: the nightly report is ready for you.";
const ANSWER = "CROSS-ANSWER: thanks, noted.";
const FROM_ALPHA = "CROSS-FROM-ALPHA: please confirm you have the report.";
const REPLY = "CROSS-REPLY: confirmed, I have the report.";

async function botReach(ctx: ExampleCtx): Promise<string> {
  const { rpc, work, reportB, reportC, cfg, computer, start, heard, history, mcpResult, links, bot } = await crossWorld(ctx);
  const reportK = join(work, "agent", "report-k.ndjson");
  const done: string[] = [];

  // B, the person's own session, is up.
  const b = await start("B");
  await heard("B's ready line", b, (evs) => (evs.some((e) => JSON.stringify(e).includes(READY)) && evs.some((e) => e.type === "turn_completed") ? true : undefined));

  // K: a session Alpha starts on the fake agent, scripted to list its sessions and message B.
  cfg(reportK, [bridge("ListSessions", {}), bridge("SendMessage", { message: FROM_BOT, to: b }), { say: "K-DONE" }]);
  const before = new Set((await rpc.request<{ sessions: { id: string }[] }>("session.list", { kinds: ["agent"] })).sessions.map((x) => x.id));
  const input = JSON.stringify({ agent: "alpha:study-buddy", backend: CROSS_ID, root: `home/${computer}/cross-work`, description: "Cross probe", prompt: "Tell the user's session B the report is ready." });
  await ctx.turn(bot.mainSession, `ACCEPTANCE-CALL Agent ${input}`, 150_000);
  const k = await until("the session Alpha started", 60_000, async () => (await rpc.request<{ sessions: { id: string; bot?: string; parent?: string; startedBy?: { kind: string } }[] }>("session.list", { kinds: ["agent"] })).sessions.find((x) => !before.has(x.id) && x.parent === bot.mainSession));
  if (k.bot !== "alpha" || k.startedBy?.kind !== "bot") fail(`the session Alpha started reads ${JSON.stringify(k).slice(0, 300)}: a bot's session`);
  const listed = await mcpResult(reportK, "ListSessions");
  if (listed.isError === true) fail(`K's ListSessions answered an error: ${String(listed.text).slice(0, 300)}`);
  const listText = String(listed.text);
  if (!listText.includes(b)) fail(`K's ListSessions doesn't name B (${b}), a session the person started: "${listText.slice(0, 400)}"`);
  if (listText.includes(k.id)) fail(`K's ListSessions names K itself: "${listText.slice(0, 400)}"`);
  const sent = await mcpResult(reportK, "SendMessage");
  if (sent.isError === true || !String(sent.text).includes("Sent")) fail(`K's SendMessage to B answered "${String(sent.text).slice(0, 300)}"`);
  const message = await heard("B's conversation to hold K's message", b, (evs) => evs.find((e) => e.type === "session_message"));
  if (message.fromSession !== k.id || message.text !== FROM_BOT) fail(`B's session_message reads ${JSON.stringify(message).slice(0, 300)}, not from ${k.id} with the words`);
  if ((await history(b)).some((e) => e.type === "user_message" && JSON.stringify(e).includes("CROSS-FROM-BOT"))) fail("the bot's session's message reached B as the user's own");
  const prompted = await until("B's agent to be prompted with the message", 60_000, async () => reportOf(reportB).find((x) => x.type === "prompt" && String(x.text).includes("CROSS-FROM-BOT")));
  if (!String(prompted.text).includes(`from-session="${k.id}"`) || !String(prompted.text).includes("not the person's words")) fail(`B's agent read the message as "${String(prompted.text).slice(0, 300)}"`);
  const link = await until("the session_link from K to B", 30_000, async () => links.find((l) => (l.to as { session?: string } | undefined)?.session === b && (l.from as { session?: string } | undefined)?.session === k.id),
    async () => `links heard: ${links.map((l) => JSON.stringify(l).slice(0, 160)).join(" | ") || "none"} [packages/core/src/sessions/durable-host.ts deliver]`);
  if (link.link !== "message" || Object.keys(link).sort().join(",") !== "from,link,to,ts,type") fail(`the link reads ${JSON.stringify(link).slice(0, 300)}, not a message from ${k.id} with no words`);
  done.push(`1 K (${k.id}, a session Alpha started) listed sessions (B among them) and sent to B (${b}): B's conversation holds a session_message from ${k.id} with the words and no user_message; B's agent read it as another session's; a session_link of kind message from K to B was heard`);

  // C, a session the person started: it may message K (a session a bot created), and not Alpha's conversation, which has never written to it.
  // Its second turn, started by Alpha's message later, is its reply to Alpha's conversation.
  cfg(reportC, [bridge("ListSessions", {}), bridge("SendMessage", { message: ANSWER, to: k.id }), bridge("SendMessage", { message: ANSWER, to: bot.mainSession }), { say: "C-DONE" }],
    [bridge("SendMessage", { message: REPLY, to: bot.mainSession }), { say: "C-REPLIED" }]);
  // This row's own report: the file may hold an earlier row's C (the rows share the work folder).
  writeFileSync(reportC, "");
  const c = await start("C");
  const results = await until("C's two SendMessage answers", 60_000, async () => {
    const r = reportOf(reportC).filter((x) => x.type === "mcp-result" && x.tool === "SendMessage");
    return r.length >= 2 ? r : undefined;
  }, async () => `C's report: ${reportOf(reportC).map((x) => x.type).join(", ") || "none"}`);
  // The two answers are told apart by what they say (the report is written as each call finishes, not in the order they were made).
  const toBot = results.find((r) => String(r.text).includes(`"${bot.mainSession}"`));
  const toK = results.find((r) => r !== toBot);
  if (toK === undefined || toK.isError === true || !String(toK.text).includes("Sent")) fail(`C's SendMessage to K answered ${JSON.stringify(toK).slice(0, 300)}: a session the person started may message a session a bot created`);
  if (toBot === undefined || toBot.isError !== true || !String(toBot.text).includes("No session you may message")) fail(`C's SendMessage to Alpha's conversation answered ${JSON.stringify(toBot ?? results).slice(0, 300)}, not a refusal (Alpha has not written to C)`);
  const fromC = await heard("K's conversation to hold C's message", k.id, (evs) => evs.find((e) => e.type === "session_message" && e.fromSession === c));
  if (fromC.text !== ANSWER) fail(`K's session_message from C reads ${JSON.stringify(fromC).slice(0, 300)}, not C's words`);
  const cList = reportOf(reportC).find((x) => x.type === "mcp-result" && x.tool === "ListSessions");
  const cText = String(cList?.text ?? "");
  if (!cText.includes(b) || !cText.includes(k.id) || cText.includes(bot.mainSession)) fail(`C's ListSessions reads "${cText.slice(0, 1500)}": it must name B (${b}: ${cText.includes(b)}) and K (${k.id}: ${cText.includes(k.id)}), and not Alpha's conversation (${bot.mainSession}: ${cText.includes(bot.mainSession)}; Alpha has not written to C)`);
  await heard("C's first turn to end", c, (evs) => (evs.some((e) => e.type === "turn_completed") ? true : undefined));
  if (JSON.stringify(await history(bot.mainSession)).includes("CROSS-ANSWER")) fail("C's message reached Alpha's conversation before Alpha had written to C");
  done.push(`2 C (${c}), a session the person started, sent to K ("Sent": K's conversation holds a session_message from C) and was refused for Alpha's conversation ("${String(toBot!.text).slice(0, 60)}…"): nothing reached it, and C's ListSessions names B and K and no bot's conversation`);

  // Alpha's conversation writes to C (a bot's own message to a session the person started); C's agent answers, and the answer now reaches it.
  await ctx.turn(bot.mainSession, `ACCEPTANCE-CALL SendMessage ${JSON.stringify({ to: c, message: FROM_ALPHA })}`, 150_000);
  const wrote = await heard("C's conversation to hold Alpha's message", c, (evs) => evs.find((e) => e.type === "session_message" || e.type === "bot_message"));
  if (!JSON.stringify(wrote).includes("CROSS-FROM-ALPHA")) fail(`C's conversation holds ${JSON.stringify(wrote).slice(0, 300)}, not Alpha's words`);
  const reply = await until("C's reply to Alpha's conversation", 60_000, async () => {
    const r = reportOf(reportC).filter((x) => x.type === "mcp-result" && x.tool === "SendMessage");
    return r.length >= 3 ? r[2] : undefined;
  }, async () => `C's report: ${reportOf(reportC).map((x) => x.type).join(", ") || "none"}`);
  if (reply!.isError === true || !String(reply!.text).includes("Sent")) fail(`C's reply to Alpha's conversation answered ${JSON.stringify(reply).slice(0, 300)}: Alpha had written to C, so C may answer it`);
  const landed = await heard("Alpha's conversation to hold C's reply", bot.mainSession, (evs) => evs.find((e) => e.type === "session_message" && e.fromSession === c));
  if (landed.text !== REPLY) fail(`Alpha's conversation holds ${JSON.stringify(landed).slice(0, 300)}, not C's reply`);
  if ((await history(bot.mainSession)).some((e) => e.type === "user_message" && JSON.stringify(e).includes("CROSS-REPLY"))) fail("C's reply reached Alpha's conversation as the user's own");
  const back = await until("the session_link from C to Alpha's conversation", 30_000, async () => links.find((l) => (l.from as { session?: string } | undefined)?.session === c && (l.to as { session?: string } | undefined)?.session === bot.mainSession));
  if (back.link !== "message") fail(`the link reads ${JSON.stringify(back).slice(0, 300)}, not a message from ${c}`);
  done.push(`3 Alpha's conversation wrote to C; C answered it and the reply landed in Alpha's conversation as a session_message from ${c} with its words, never the user's, and a session_link from C to it was heard`);
  return done.join("; ");
}


// ---------------------------------------------------------------------------------------------------------------
// Lane CG's rows (the engine's session graph), each read as the app hears it: the core events `session_changed` and
// `session_link` on the app's own connection (the `sessions` area), never the engine's insides.
//   1. A child: Alpha's `Agent` starts a session on MOSS's coding agent; its view names her conversation as its parent and
//      her as its starter, her view waits on it, and the links of the spawn and of its report are heard, with no words.
//   2. A subagent row: an agent backend declaring Claude Code's own `subagents` quirk (the bundled plugin's, copied into a
//      fixture whose program is the fake ACP agent) plays a `Task` call as Claude Code's ACP adapter sends it; the session's
//      view lists the row running under it, then ended.
//   3. Waiting: a coding session on MOSS's coding agent runs a command in the background; while its turn runs its view is
//      `running` with the task counted (running wins), after the turn `waiting`, and once the command ends neither.
//   4. A title: a coding session on the default model is titled after its first turn; the fake provider's request for the
//      title names the default's family's light model, its turn's the default.

export const CANVAS_BOT_REACH_STEP = "the canvas · a session a bot started messages a session the person started (a session_message from that session, heard as a session_link, never the person's); a session the person started may message a session a bot created but is refused for a bot's conversation until that bot has written to it, and once it has, its reply lands there as a session_message from that session";
export const CANVAS_CHILD_STEP = "the canvas · a child session joins its parent: Alpha's Agent starts a session whose view names her conversation as its parent and her as its starter, her view waits on it, and the app hears the spawn's and the report's session_link (no words)";
export const CANVAS_SUBAGENT_STEP = "the canvas · a subagent row: an agent declaring Claude Code's subagents quirk plays a Task call as Claude Code's adapter sends it, and the session's view lists the row under it, running, then ended";
export const CANVAS_WAITING_STEP = "the canvas · waiting: a coding session's command in the background is counted on its view; while its turn runs the session reads running (running wins), after it waiting, and once the command ends neither";
export const CANVAS_TITLE_STEP = "the canvas · a code session is titled after its first turn: the title's request to the fake provider names the default's family's light model, the turn's the default";

/** The rows of the canvas unit: lane CM's, then lane CG's. */
export const CANVAS_STEPS: readonly string[] = [CANVAS_CROSS_SESSION_STEP, CANVAS_BOT_REACH_STEP, CANVAS_CHILD_STEP, CANVAS_SUBAGENT_STEP, CANVAS_WAITING_STEP, CANVAS_TITLE_STEP];


type CgEv = Record<string, unknown> & { type?: string };
interface View {
  id: string; kind: string; status: string; bot?: string; parent?: string; title?: string; model?: string; updatedAt: number;
  startedBy?: { kind: string; bot?: string; session?: string };
  waiting?: { tasks: number; children: number };
  subagents?: { id: string; name: string; model?: string; state: string; startedAt: number; endedAt?: number }[];
}
interface Link { type: "session_link"; ts: number; from: { end: string; session?: string; kind?: string }; to: { session: string; kind: string }; link: string }

/** The core events the app's connection hears from now on: every session's views and every link. */
function heard(ctx: ExampleCtx): { views: (id: string) => View[]; links: () => Link[]; stop(): void } {
  const views: View[] = [];
  const links: Link[] = [];
  let on = true;
  ctx.rpc.onNotification((method, params) => {
    if (!on || method !== "core.event") return;
    const e = params as { type?: string; session?: View };
    if (e.type === "session_changed" && e.session !== undefined) views.push(e.session);
    else if (e.type === "session_link") links.push(e as unknown as Link);
  });
  return { views: (id) => views.filter((v) => v.id === id), links: () => [...links], stop: () => { on = false; } };
}

const computerOf = async (ctx: ExampleCtx): Promise<string> => {
  const c = (await ctx.rpc.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
  return c ?? fail("computer.list lists no computer");
};

const viewOf = async (ctx: ExampleCtx, id: string): Promise<View | undefined> =>
  (await ctx.rpc.request<{ session: View }>("session.get", { id }).catch(() => undefined))?.session;

const shortView = (v: View | undefined) => (v === undefined ? "none" : `${v.status}${v.waiting ? ` waiting ${v.waiting.tasks}+${v.waiting.children}` : ""}${v.subagents ? ` rows ${v.subagents.map((s) => s.state).join("/")}` : ""}`);

/** Row 1: a child session joined to its parent. `bot` is Alpha's conversation. */
export async function canvasChildStep(ctx: ExampleCtx, bot: string): Promise<string> {
  const ears = heard(ctx);
  try {
    const computer = await computerOf(ctx);
    mkdirSync(join(ctx.userHome, "canvas-child"), { recursive: true });
    writeFileSync(join(ctx.userHome, "canvas-child", "notes.md"), "The canvas row's notes.\n");
    const root = `home/${computer}/canvas-child`;
    const before = new Set((await ctx.rpc.request<{ sessions: { id: string }[] }>("session.list", { kinds: ["agent"] })).sessions.map((s) => s.id));
    const t = await ctx.turn(bot, `ACCEPTANCE-AGENT ${root}`, 150_000);
    if (t.cards.length > 0) fail(`Alpha's Agent raised ${t.cards.join("; ")}`);
    const child = await until("the child's session_changed with its parent", 60_000, async () => {
      const r = await ctx.rpc.request<{ sessions: View[] }>("session.list", { kinds: ["agent"] });
      const mine = r.sessions.find((s) => !before.has(s.id) && s.parent === bot);
      return mine === undefined ? undefined : ears.views(mine.id).at(-1) === undefined ? undefined : mine;
    }, async () => `heard views of: ${[...new Set(ears.links().map((l) => l.to.session))].join(", ") || "none"}`);
    const view = ears.views(child.id).at(-1)!;
    if (view.parent !== bot) fail(`the child's view names parent ${view.parent ?? "none"}, not Alpha's conversation ${bot}`);
    if (view.startedBy?.kind !== "bot" || view.startedBy.bot !== "alpha" || view.startedBy.session !== bot) fail(`the child's view says it was started by ${JSON.stringify(view.startedBy)}, not Alpha from ${bot} [packages/core/src/sessions/session-graph.ts derivedStarter]`);
    const spawn = await until("the spawn's session_link", 30_000, async () => ears.links().find((l) => l.to.session === child.id && l.from.session === bot && l.link === "spawn"),
      async () => `links heard: ${ears.links().map((l) => `${l.from.session ?? l.from.end}>${l.to.session}:${l.link}`).join(", ") || "none"}`);
    const waited = await until("Alpha's view waiting on her child", 30_000, async () => {
      const heardWait = ears.views(bot).find((v) => (v.waiting?.children ?? 0) >= 1);
      const now = await viewOf(ctx, bot);
      return heardWait ?? ((now?.waiting?.children ?? 0) >= 1 ? now : undefined);
    }, async () => `her views: ${ears.views(bot).map(shortView).join(", ") || "none heard"}`);
    const report = await until("the child's report, as a session_link to Alpha", 120_000, async () => ears.links().find((l) => l.from.session === child.id && l.to.session === bot && l.link === "report"),
      async () => `links heard: ${ears.links().map((l) => `${l.from.session ?? l.from.end}>${l.to.session}:${l.link}`).join(", ") || "none"}; her conversation has the report: ${JSON.stringify(await ctx.history(bot).catch(() => [])).includes(CHILD_REPORT)}`);
    for (const l of [spawn, report]) if (Object.keys(l).sort().join(",") !== "from,link,to,ts,type") fail(`a session_link carries more than who, whom, what and when: ${JSON.stringify(l).slice(0, 300)}`);
    return `the child ${child.id} (parent ${view.parent}, started by ${view.startedBy!.kind} ${view.startedBy!.bot} from ${view.startedBy!.session}); Alpha waits on ${waited.waiting!.children} child(ren); heard ${spawn.link} ${bot}>${child.id} and ${report.link} ${child.id}>${bot}, no words`;
  } finally {
    ears.stop();
  }
}

/** Claude Code's `Task` call as its ACP adapter sends it (read from `@zed-industries/claude-agent-acp` 0.23.1's code): the
 *  call while its input streams, then its whole input, one of the subagent's own calls, and its end. */
function claudeTaskFrames(id: string): Record<string, unknown>[] {
  const meta = { claudeCode: { toolName: "Task" } };
  return [
    { sessionUpdate: "tool_call", toolCallId: id, title: "Task", kind: "think", status: "pending", rawInput: {}, _meta: meta },
    { sessionUpdate: "tool_call_update", toolCallId: id, title: "Explore the auth module", kind: "think", rawInput: { description: "Explore the auth module", prompt: "Find where sessions are made.", subagent_type: "Explore", model: "haiku" }, _meta: meta },
    { sessionUpdate: "tool_call", toolCallId: `${id}_inner`, title: "Read auth.ts", kind: "read", status: "pending", rawInput: { file_path: "auth.ts" }, _meta: { claudeCode: { toolName: "Read", parentToolUseId: id } } },
    { sessionUpdate: "tool_call_update", toolCallId: `${id}_inner`, status: "completed", _meta: { claudeCode: { toolName: "Read", parentToolUseId: id } } },
    { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: [{ type: "text", text: "Sessions are made in host.ts." }], _meta: meta },
  ];
}

const SUBAGENTS_ID = "acceptance-subagents";
const ACP_FIXTURE = resolve(import.meta.dir, "fixtures", "acceptance-acp");
const CLAUDE_QUIRKS = resolve(import.meta.dir, "..", "..", "plugins", "moss", "plugins", "agent-claude-code", "quirks.json");

/** Row 2: a subagent row under its session, running then ended. */
export async function canvasSubagentStep(ctx: ExampleCtx): Promise<string> {
  const ears = heard(ctx);
  try {
    return await subagentRow(ctx, ears);
  } finally {
    ears.stop();
    await leave(ctx, SUBAGENTS_ID);
  }
}

async function subagentRow(ctx: ExampleCtx, ears: ReturnType<typeof heard>): Promise<string> {
  const { rpc, root } = ctx;
  const work = join(root, "canvas-subagents");
  const folder = join(work, "plugin-src", SUBAGENTS_ID);
  const config = join(work, "agent", "agent.json");
  mkdirSync(dirname(config), { recursive: true });
  cpSync(ACP_FIXTURE, folder, { recursive: true });
  // The ACP fixture under its own id, its quirks with the bundled Claude Code plugin's `subagents` (what ships).
  const claude = (JSON.parse(readFileSync(CLAUDE_QUIRKS, "utf8")) as { quirks: { subagents?: unknown } }).quirks.subagents;
  if (claude === undefined || claude === null) fail(`the bundled Claude Code plugin declares no subagents quirk [${CLAUDE_QUIRKS}]`);
  const quirksFile = JSON.parse(readFileSync(join(folder, "quirks.json"), "utf8")) as { quirks: Record<string, unknown> };
  quirksFile.quirks.subagents = claude;
  const manifest = readFileSync(join(folder, "moss.json"), "utf8").replaceAll("acceptance-acp", SUBAGENTS_ID).replaceAll("Acceptance ACP", "Acceptance Subagents");
  const written = fixtureWith({ "moss.json": manifest, "quirks.json": JSON.stringify(quirksFile, null, 2) }, { bun: process.execPath, fake: FAKE_ACP_AGENT, config });
  for (const [name, body] of Object.entries(written)) writeFileSync(join(folder, name), body);
  writeFileSync(config, JSON.stringify({
    quirks: (JSON.parse(written["quirks.json"]!) as { quirks: unknown }).quirks, version: "fake-agent 1.0.0",
    report: join(work, "agent", "report.ndjson"), selection: join(work, "agent", "selection.json"), mcpEnv: { MOSS_TEST_KEYCHAIN: ctx.keychainFile },
    script: [[{ raw: claudeTaskFrames("toolu_canvas_1") }, { say: "Explored." }]],
  }));
  const installed = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
  if (installed.id !== SUBAGENTS_ID) fail(`the fixture installed as ${installed.id}`);
  await ctx.pressCard(`${SUBAGENTS_ID}'s OK card`, (c) => c.kind === "plugin-ok" && c.pluginId === SUBAGENTS_ID);
  await until("its backend in agent.backends", 60_000, async () => (await rpc.request<{ backends: { id: string }[] }>("agent.backends", {})).backends.find((b) => b.id === SUBAGENTS_ID));
  const computer = await computerOf(ctx);
  mkdirSync(join(ctx.userHome, "canvas-subagents"), { recursive: true });
  const session = (await rpc.request<{ session: string }>("agent.start", { backend: SUBAGENTS_ID, computer, root: `home/${computer}/canvas-subagents`, prompt: "Explore the auth module." }, 60_000)).session;
  // An agent with no sandbox of its own starts only after the person's OK (§9.3): its session's cards are approved, as
  // the ACP row does.
  const answered = new Set<string>();
  const ended = await until("the subagent row ended on the session's view", 90_000, async () => {
    for (const c of (await rpc.request<{ cards: { id: string; session?: string }[] }>("card.list")).cards) {
      if (c.session !== session || answered.has(c.id)) continue;
      answered.add(c.id);
      await ctx.approveCard(c.id);
    }
    const v = ears.views(session).at(-1);
    return v?.subagents?.find((s) => s.id === "toolu_canvas_1" && s.state !== "running") === undefined ? undefined : v;
  }, async () => `its views: ${ears.views(session).map(shortView).join(", ") || "none heard"}; now ${shortView(await viewOf(ctx, session))}`);
  const running = ears.views(session).find((v) => v.subagents?.some((s) => s.id === "toolu_canvas_1" && s.state === "running"));
  if (running === undefined) fail(`the row was never heard running: ${ears.views(session).map(shortView).join(", ")}`);
  const row = ended.subagents!.find((s) => s.id === "toolu_canvas_1")!;
  if (row.state !== "done" || row.endedAt === undefined || row.endedAt < row.startedAt) fail(`the row ended ${JSON.stringify(row)}`);
  if (row.name !== "Explore the auth module" || row.model !== "haiku") fail(`the row reads ${JSON.stringify(row)}: not the Task call's description and model`);
  if (ended.subagents!.some((s) => s.id === "toolu_canvas_1_inner")) fail("the subagent's own call became a row of its own");
  return `session ${session}: the row "${row.name}" (${row.model}) heard running, then ${row.state} after ${row.endedAt! - row.startedAt} ms; the subagent's own Read is no row`;
}

/** Row 3: waiting on a background command; running wins. */
export async function canvasWaitingStep(ctx: ExampleCtx): Promise<string> {
  const ears = heard(ctx);
  try {
    const computer = await computerOf(ctx);
    mkdirSync(join(ctx.userHome, "canvas-waiting"), { recursive: true });
    const session = (await ctx.rpc.request<{ session: string }>("agent.start", { backend: "moss-code", computer, root: `home/${computer}/canvas-waiting` }, 30_000)).session;
    const t = await ctx.turn(session, 'ACCEPTANCE-CALL Bash {"command":"sleep 6","run_in_background":true,"description":"the canvas row\'s wait"}', 150_000);
    // An agent's call is shown by its title (the command, for a Bash).
    const called = t.events.some((e: CgEv) => e.type === "tool_call" && JSON.stringify(e).includes("sleep 6"));
    if (!called) fail(`the turn made no background command (${t.events.filter((e: CgEv) => e.type === "tool_call").map((e) => JSON.stringify(e).slice(0, 200)).join(" | ") || "no tool call"})`);
    const whileRunning = ears.views(session).find((v) => (v.waiting?.tasks ?? 0) >= 1 && sessionMotion(v) === "running");
    if (whileRunning === undefined) fail(`no view while the turn ran counted the task and read running: ${ears.views(session).map(shortView).join(", ")} [packages/core/src/agents/moss-code/backend.ts reportingTasks]`);
    const after = await until("the session waiting after its turn", 30_000, async () => {
      const v = ears.views(session).at(-1);
      return v !== undefined && sessionMotion(v) === "waiting" ? v : undefined;
    }, async () => `its views: ${ears.views(session).map(shortView).join(", ")}`);
    const done = await until("the command's end ending the wait", 90_000, async () => {
      const v = await viewOf(ctx, session);
      return v !== undefined && v.waiting === undefined && ears.views(session).at(-1)?.waiting === undefined ? v : undefined;
    }, async () => `its views: ${ears.views(session).map(shortView).join(", ")}`);
    return `session ${session}: while its turn ran it read ${sessionMotion(whileRunning!)} with ${whileRunning!.waiting!.tasks} task; after it ${sessionMotion(after)} (${after.waiting!.tasks} task); once the command ended ${sessionMotion(done)}, nothing waited`;
  } finally {
    ears.stop();
  }
}

/** Row 4: the title after the first turn, on the light model. */
export async function canvasTitleStep(ctx: ExampleCtx): Promise<string> {
  const ears = heard(ctx);
  try {
    const keyed = (await ctx.rpc.request<{ bots: { id: string; model?: string }[] }>("bot.list", {})).bots.find((b) => b.id === "alpha")?.model;
    if (keyed === undefined) fail("Alpha has no model: the run's default is unknown");
    const provider = keyed!.split("/")[0]!;
    const family = familyOfModel(activeCatalog(), provider, keyed!);
    const light = family === undefined ? undefined : lightModelOn(activeCatalog(), provider, family);
    if (light === undefined) fail(`the default ${keyed} has no light model on ${provider}: the row can't tell the two requests apart`);
    const bare = (tag: string) => tag.slice(tag.indexOf("/") + 1);
    const computer = await computerOf(ctx);
    mkdirSync(join(ctx.userHome, "canvas-title"), { recursive: true });
    const session = (await ctx.rpc.request<{ session: string }>("agent.start", { backend: "moss-code", computer, root: `home/${computer}/canvas-title`, model: keyed }, 30_000)).session;
    const seen = ctx.requests().length;
    const message = "ACCEPTANCE-TAG-canvas-title the login page loops";
    await ctx.turn(session, message, 150_000);
    const titled = await until("the session's title, heard as session_changed", 90_000, async () => ears.views(session).find((v) => v.title !== undefined && v.title !== ""),
      async () => `its views: ${ears.views(session).map((v) => `${v.status}:${v.title ?? "-"}`).join(", ")}; requests since: ${ctx.requests().slice(seen).map((r) => `${String((r as { model?: string }).model)}:${r.lastUserText.slice(0, 40)}`).join(" | ")}`);
    const mine = ctx.requests().slice(seen) as { model?: string; lastUserText: string }[];
    const turnReq = mine.find((r) => r.lastUserText.includes(message) && !r.lastUserText.startsWith("USER MESSAGE:"));
    const titleReq = mine.find((r) => r.lastUserText.startsWith("USER MESSAGE:") && r.lastUserText.includes(message));
    if (turnReq === undefined) fail("the fake provider never got the turn's request");
    if (titleReq === undefined) fail(`the fake provider never got a title request (${mine.map((r) => `${r.model}:${r.lastUserText.slice(0, 30)}`).join(" | ")}) [packages/core/src/sessions/durable-host.ts #titleAfterTurn]`);
    if (turnReq!.model !== bare(keyed!)) fail(`the turn's request names ${turnReq!.model}, not the default ${bare(keyed!)}`);
    if (titleReq!.model !== bare(light!.tag)) fail(`the title's request names ${titleReq!.model}, not the light model ${bare(light!.tag)} [packages/core/src/agent/titles.ts mossSessionTitles]`);
    const later = await viewOf(ctx, session);
    if (later?.title !== titled.title) fail(`session.get reads the title "${later?.title}", the event "${titled.title}"`);
    return `session ${session} titled "${titled.title}" after its first turn; the turn's request on ${turnReq!.model}, the title's on ${titleReq!.model}`;
  } finally {
    ears.stop();
  }
}
