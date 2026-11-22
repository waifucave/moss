// What the preview's canvas has to show: the default bot and seven code sessions in the states that matter for the look,
// made through the engine's own doors (the app's `agent.start`, `session.send`, `session.stop`, as the canvas acceptance rows
// do), against the acceptance run's fake model and a fake ACP agent standing in for three agents' programs. No real model call,
// no network.
//
//   idle                 MOSS's agent: a first turn ended
//   running              MOSS's agent: a second turn held open on the fake provider (ACCEPTANCE-SLOW)
//   waiting              MOSS's agent: a background command running after its turn (counted on the view)
//   started by the bot   MOSS's agent: a child of the default bot's conversation (its `Agent` tool)
//   idle                 Codex (a fake ACP agent behind a `codex-acp` shim): a first turn ended
//   started by another   Claude Code (behind `claude-agent-acp`): its SendMessage reaches the Codex session, a line between them
//   ended                Gemini (behind `gemini`): a turn, then stopped
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { MossClient } from "../acceptance/client";
import { RpcError } from "../acceptance/client";
import type { Layout } from "./lib";

type Ev = Record<string, unknown> & { type?: string };
interface CardRow { id: string; hash: string; options: { id: string; kind: string }[] }

/** The titles the fake model gives a session's title request, by a phrase of its first message (the preview's `titleFor`). */
export const TITLES: readonly [phrase: string, title: string][] = [
  ["Fix the login redirect loop", "Fix login redirect loop"],
  ["Profile the checkout page", "Profile checkout page load"],
  ["Start the dev server", "Run the dev server"],
  ["ACCEPTANCE-CHILD", "Summarize the docs folder"],
  ["Review the settings screen", "Review settings screen layout"],
  ["Hand the API changes", "Hand API changes to mobile"],
  ["Bump the terraform", "Bump Terraform providers"],
];
export const titleFor = (requestText: string): string | undefined => TITLES.find(([phrase]) => requestText.includes(phrase))?.[1];

export interface SeedInput {
  c: MossClient;
  layout: Layout;
  keyedModel: string;
  dummyKey: string;
  fakeAcpAgent: string;
  /** Each seeded backend's quirks, read from its bundled plugin's quirks.json. */
  quirks: Record<string, unknown>;
  say(line: string): void;
}

export interface Seeded { sessions: { id: string; what: string }[]; bot: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined> | T | undefined, every = 400): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${Math.round(ms / 1000)} s`);
    await sleep(every);
  }
}

export async function seed(i: SeedInput): Promise<Seeded> {
  const { c } = i;
  const made: Seeded["sessions"] = [];
  // Every card the seeding raises (an agent that carries no sandbox of its own asks once; a background command asks) is approved here, so none waits when the window opens.
  const answered = new Set<string>();
  const sweep = async (): Promise<void> => {
    const listed = await c.request<{ cards: CardRow[] }>("card.list").catch(() => ({ cards: [] as CardRow[] }));
    for (const card of listed.cards) {
      if (answered.has(card.id)) continue;
      const approve = card.options.find((o) => o.kind === "approve");
      if (approve === undefined) continue;
      answered.add(card.id);
      try {
        const frame = await c.request<{ channel: string }>("card.frame", { id: card.id });
        await c.request("card.answer", { id: card.id, hash: card.hash, option: approve.id, proof: { via: "sealed-frame", frame: frame.channel, input: "click", at: Date.now() } });
      } catch (err) {
        i.say(`seed: a card (${card.id}) was not answered: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const poller = setInterval(() => void sweep(), 600);
  try {
    await signIn(i);
    const computer = (await c.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
    if (computer === undefined) throw new Error("computer.list lists no computer");
    const folder = (name: string): string => { mkdirSync(join(i.layout.work, name), { recursive: true }); return `home/${computer}/work/${name}`; };
    const history = async (id: string): Promise<Ev[]> => (await c.request<{ events: Ev[] }>("session.history", { id, limit: 500 })).events;
    const turnsDone = async (id: string): Promise<number> => (await history(id)).filter((e) => e.type === "turn_completed").length;
    const turnEnded = (id: string, n = 1): Promise<true> => until(`a turn of ${id} to end`, 120_000, async () => ((await turnsDone(id)) >= n ? true : undefined));
    const titled = (id: string): Promise<string> => until(`${id}'s title`, 90_000, async () => ((await c.request<{ session: { title?: string } }>("session.get", { id })).session.title ?? undefined));
    const send = (session: string, text: string): Promise<unknown> => c.request("session.send", { id: session, message: { text, clientMessageId: randomUUID() } }, 30_000);
    const start = async (backend: string, root: string, prompt: string, extra: Record<string, unknown> = {}): Promise<string> =>
      (await c.request<{ session: string }>("agent.start", { backend, computer, root, prompt, ...extra }, 60_000)).session;
    const agentConfig = (backend: string, version: string, script: unknown[][]): void => {
      writeFileSync(join(i.layout.agents, `${backend}.json`), JSON.stringify({
        quirks: i.quirks[backend], version, report: join(i.layout.agents, `${backend}-report.ndjson`), selection: join(i.layout.agents, "selection.json"),
        mcpEnv: { MOSS_TEST_KEYCHAIN: i.layout.keychain }, script,
      }));
    };
    const note = (id: string, what: string): void => { made.push({ id, what }); i.say(`seeded ${what}: ${id}`); };

    // MOSS's agent: idle.
    const idle = await start("moss-code", folder("web-app"), "Fix the login redirect loop ACCEPTANCE-TAG-PREVIEWA", { model: i.keyedModel });
    await turnEnded(idle); await titled(idle);
    note(idle, "idle (MOSS's agent)");

    // MOSS's agent: waiting on a background command after its turn.
    const waiting = await start("moss-code", folder("api-server"), 'ACCEPTANCE-CALL Bash {"command":"sleep 7200","run_in_background":true,"description":"Start the dev server"}', { model: i.keyedModel });
    await turnEnded(waiting); await titled(waiting);
    await until("the waiting session to count its command", 60_000, async () => {
      const v = (await c.request<{ session: { waiting?: { tasks: number } } }>("session.get", { id: waiting })).session;
      return (v.waiting?.tasks ?? 0) >= 1 ? true : undefined;
    });
    note(waiting, "waiting on a background command (MOSS's agent)");

    // MOSS's agent: a child of the default bot's conversation.
    const bot = (await c.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {})).bots[0];
    if (bot === undefined) throw new Error("bot.list lists no bot");
    const before = new Set((await c.request<{ sessions: { id: string }[] }>("session.list", { kinds: ["agent"] })).sessions.map((s) => s.id));
    await send(bot.mainSession, `ACCEPTANCE-AGENT ${folder("docs-site")}`);
    const child = await until("the bot's child session", 150_000, async () => (await c.request<{ sessions: { id: string; parent?: string }[] }>("session.list", { kinds: ["agent"] })).sessions.find((s) => !before.has(s.id) && s.parent === bot.mainSession)?.id);
    await turnEnded(child); await titled(child);
    note(child, "started by the default bot (MOSS's agent)");

    // Codex (a fake ACP agent): idle. Claude Code's SendMessage to it is the line.
    agentConfig("codex", "2.6.0", [[{ say: "Ready. Which screen should I start with?" }]]);
    const codex = await start("codex", folder("mobile-app"), "Review the settings screen layout");
    await turnEnded(codex); await titled(codex);
    note(codex, "idle (Codex)");

    agentConfig("claude-code", "0.150.0", [[{ mcp: { server: "$bridge", tool: "SendMessage", input: { message: "The /v2/orders endpoint now returns `total` as a string; please update the client.", to: codex }, ask: false } }, { say: "Sent the API notes to the mobile session." }]]);
    const claude = await start("claude-code", folder("api-server"), "Hand the API changes over to the mobile session");
    await turnEnded(claude); await titled(claude);
    await until("the link from Claude Code's session to Codex's", 60_000, async () =>
      (await c.request<{ pairs: { from: { session?: string }; to: { session: string } }[] }>("session.links", {})).pairs.find((p) => p.from.session === claude && p.to.session === codex) === undefined ? undefined : true);
    note(claude, "started a line to the Codex session (Claude Code)");

    // Gemini (a fake ACP agent): a turn, then stopped: ended.
    agentConfig("gemini", "0.50.0", [[{ say: "Updated the provider versions in the Terraform module." }]]);
    const gemini = await start("gemini", folder("infra"), "Bump the terraform provider versions");
    await turnEnded(gemini); await titled(gemini);
    await c.request("session.stop", { id: gemini }, 60_000);
    await until("the Gemini session to read ended", 60_000, async () => {
      const status = (await c.request<{ session: { status: string } }>("session.get", { id: gemini })).session.status;
      return /ended|stopped|done/i.test(status) ? true : undefined;
    });
    note(gemini, "ended (Gemini)");

    // MOSS's agent: running, a second turn held open on the fake provider. Last, so it has run the least when the window opens.
    const running = await start("moss-code", folder("web-app"), "Profile the checkout page load", { model: i.keyedModel });
    await turnEnded(running); await titled(running);
    await send(running, "Keep going, the profile is not done yet ACCEPTANCE-SLOW");
    await until("the running session to read running", 60_000, async () => ((await c.request<{ session: { status: string } }>("session.get", { id: running })).session.status === "running" ? true : undefined));
    note(running, "running (MOSS's agent, a turn held open)");

    await sleep(1_200);
    await sweep();
    const left = (await c.request<{ cards: CardRow[] }>("card.list")).cards;
    if (left.length > 0) i.say(`seed: ${left.length} card(s) are still waiting (the preview's window can show them only while it is in front)`);
    return { sessions: made, bot: bot.mainSession };
  } finally {
    clearInterval(poller);
  }
}

async function signIn(i: SeedInput): Promise<void> {
  const { c } = i;
  const plugin = "moss/model-anthropic";
  const auth = await until("plugin.auth.list served", 90_000, async () => {
    try {
      return await c.request<{ auth: { index: number; method: string }[] }>("plugin.auth.list", { id: plugin });
    } catch (err) {
      if (err instanceof RpcError && /is not served yet/.test(err.message)) return undefined;
      throw err;
    }
  }, 500);
  const entry = auth.auth.find((a) => a.method === "api-key");
  if (entry === undefined) throw new Error(`plugin.auth.list ${plugin} has no api-key entry`);
  const signed = await c.request<{ state: string }>("plugin.auth.signIn", { id: plugin, index: entry.index, key: i.dummyKey });
  if (signed.state !== "signed-in") throw new Error(`plugin.auth.signIn left ${plugin} ${signed.state}`);
  await until("Alpha's record, to pick her model", 60_000, async () => ((await c.request<{ ok?: boolean }>("bot.edit", { id: "alpha", patch: { model: i.keyedModel } }).catch(() => undefined)) !== undefined ? true : undefined), 500);
}

/** A bundled agent plugin's quirks (the `quirks` object of its quirks.json). */
export function quirksOf(repo: string, backend: string): unknown {
  return (JSON.parse(readFileSync(join(repo, "plugins", "moss", "plugins", `agent-${backend}`, "quirks.json"), "utf8")) as { quirks: unknown }).quirks;
}
