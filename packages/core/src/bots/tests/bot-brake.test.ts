// The exchange brake over the bots' own `SendMessage` (lane CM3): two bots answering each other, a ring of three, and a bot and
// its own agent all stop at EXCHANGE_DEPTH_LIMIT messages without the person, whatever the order turns start and end in (a
// message that finds the receiver mid-turn folds into it and still counts); the person writing to one of them lifts that one's
// count and the exchange can go on. Generated: seeded random schedules over each shape.
import { afterEach, describe, expect, test } from "bun:test";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { EXCHANGE_DEPTH_LIMIT } from "../../sessions/exchange-depth";
import { botToolDefs, SendLimiter } from "../tools";
import { ALPHA_FOLDER, boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin } from "./fixtures";

afterEach(() => removeTemps());

const BRAKE = (n: number) => `This exchange has gone ${n} messages between sessions without the person; stop here and wait for them to write to you.`;

/** A small seeded generator: the same seeds, the same schedules. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function world() {
  const root = tempDir();
  const extra = [];
  for (const [id, name] of [["luna", "Luna"], ["mira", "Mira"]] as const) {
    extra.push(...(await pluginFromFolder(writePlugin(root, id, { "moss.json": botManifest(id, name), "bot/instructions.md": `You are ${name}.` }))).inputs);
  }
  const clock = new FakeClock();
  const b = await boot({ home: tempDir(), plugins: [...(await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, ...extra], clock });
  const mine = new FakeSessionDriver();
  b.host.open({ id: "s_mine", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, mine);
  return Object.assign(b, { mine });
}
type World = Awaited<ReturnType<typeof world>>;
const driverOf = (w: World, session: string): FakeSessionDriver => (session === "s_mine" ? w.mine : w.drivers.for(session));

/** One step of a cycle: `from` sends to `to` (a bot's name or a session id). */
type Step = { from: string; to: string };
const SHAPES: Record<string, Step[]> = {
  "two bots": [{ from: "b_alpha", to: "luna" }, { from: "b_luna", to: "alpha" }],
  "a ring of three": [{ from: "b_alpha", to: "luna" }, { from: "b_luna", to: "mira" }, { from: "b_mira", to: "alpha" }],
  "a bot and its own agent": [{ from: "b_alpha", to: "s_mine" }, { from: "s_mine", to: "alpha" }],
};

async function runShape(w: World, steps: Step[], seed: number): Promise<{ delivered: number; refusal: string }> {
  const rand = rng(seed);
  const limiter = new SendLimiter(() => w.clock.now());
  const tools = new Map<string, (to: string, message: string) => Promise<{ text: string; isError: boolean }>>();
  for (const s of steps) {
    if (tools.has(s.from)) continue;
    const [send] = botToolDefs({ host: w.host, bots: w.bots, limiter }, s.from);
    tools.set(s.from, (to, message) => send!.run({ to, message }));
  }
  // The person writes to each of them: a turn starts (after the one running ends) at depth 0, so nothing the last schedule
  // left counts.
  for (const [k, s] of [...new Set(steps.map((x) => x.from))].entries()) {
    if (driverOf(w, s).running) driverOf(w, s).end();
    await flush();
    await w.host.sendUser(s, { text: "start", device: "studio", sentAt: w.clock.now(), clientMessageId: `p${seed}-${k}` });
    await flush();
    expect(w.host.depths.depthOf(s)).toBe(0);
  }
  const received: number[] = [];
  let delivered = 0;
  for (let i = 0; i < 4 * EXCHANGE_DEPTH_LIMIT; i++) {
    const step = steps[i % steps.length]!;
    const before = w.host.history(stepTarget(w, step.to)).length;
    const r = await tools.get(step.from)!(step.to, `m${i}`);
    if (r.isError) {
      expect(i).toBe(delivered);
      return { delivered, refusal: r.text };
    }
    delivered++;
    await flush();
    const got = w.host.history(stepTarget(w, step.to)).slice(before).flatMap((x) => (x.type === "input" && "depth" in x.input && typeof x.input.depth === "number" ? [x.input.depth] : []));
    received.push(...got);
    // The sender's turn ends after the send, or goes on (so the answer folds into it): either way the answer counts.
    const driver = driverOf(w, step.from);
    if (rand() < 0.5 && driver.running) driver.end();
    await flush();
    // A turn that was idle starts on the message; one already running takes it folded. Neither lets a depth past the limit.
    expect(Math.max(...received)).toBeLessThanOrEqual(EXCHANGE_DEPTH_LIMIT);
  }
  throw new Error(`the exchange never stopped (seed ${seed}); ${delivered} delivered`);
}
const stepTarget = (w: World, to: string): string => (w.bots.has(to) ? w.bots.mainSession(to) : to);

describe("the bots' own SendMessage is under the exchange brake", () => {
  for (const [name, steps] of Object.entries(SHAPES)) {
    test(`${name}: stops after ${EXCHANGE_DEPTH_LIMIT} messages whatever the order, and the person's message lets it go on`, async () => {
      const w = await world();
      for (let seed = 1; seed <= 12; seed++) {
        // Each seed starts from the person's message (which also lifts what the last seed left).
        const { delivered, refusal } = await runShape(w, steps, seed);
        expect([seed, delivered]).toEqual([seed, EXCHANGE_DEPTH_LIMIT]);
        expect(refusal).toBe(BRAKE(EXCHANGE_DEPTH_LIMIT));
      }
      await w.shutdown();
    });
  }

  test("the 21st message in a minute is still the limiter's, and the brake is the same words whoever sends", async () => {
    const w = await world();
    const [send] = botToolDefs({ host: w.host, bots: w.bots }, "b_alpha");
    for (let i = 0; i < EXCHANGE_DEPTH_LIMIT; i++) w.host.depths.turnStarted("b_alpha", { from: "bot", bot: "luna", session: "b_luna", text: "x", depth: 8 });
    expect(await send!.run({ to: "luna", message: "again" })).toEqual({ text: BRAKE(8), isError: true });
    await w.shutdown();
  });
});
