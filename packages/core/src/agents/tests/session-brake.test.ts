// The loop brake (lane CM, fix round 2): how far an exchange between sessions has gone without the person. A turn the person's
// input started is at depth 0; a send made at depth d is delivered at d + 1; a send beyond EXCHANGE_DEPTH_LIMIT is refused.
// Here: the real manager and scripted agents (two sessions answering each other stop; the person writing to one lifts that
// one only; a chain counts across sessions; a fan-out is one step each), the messenger against a generated sequence of
// operations, and where the depth may come from.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionView } from "@waifucave/moss-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import type { DeliveredInput, SessionDriver, TurnEnd, TurnInput } from "../../contracts/session-host";
import { DurableSessionHost } from "../../sessions/durable-host";
import { EXCHANGE_DEPTH_LIMIT, EngineSessionMessenger, type SendSlots } from "../bridge/messenger";
import { waitFor, World, type WorldOptions } from "./world";

setDefaultTimeout(120_000);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
// Each turn of a scripted agent says something; with no step left a turn does nothing and the agent's session ends.
const SAYS = Array.from({ length: 24 }, () => [{ say: "ok" }]);
const make = (o: WorldOptions = {}) => (world = new World({ script: SAYS, ...o }));
const USER = { kind: "user", device: "d".repeat(16) } as const;
const startCode = (w: World, title: string, n: number) =>
  w.manager.start({ caller: { ...USER, clientMessageId: `m${n}` }, backend: "fake", prompt: "Hi.", root: "home/Studio/project1", title });
const turnsOf = (w: World, id: string) => w.host.history(id).filter((r) => r.type === "turn_started").length;
const idle = (w: World, id: string) => waitFor(() => (w.host.get(id)?.status === "idle" ? true : undefined), `${id} to be idle`);
const received = (w: World, id: string) => w.host.history(id).flatMap((r) => (r.type === "input" && r.input.from === "session" ? [r.input] : []));
const refusal = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as Error).message;

/** A sends to `to`; resolves once `to`'s turn on it has started (its depth is then set), or with the refusal. */
async function send(w: World, from: string, to: string, text = "go on"): Promise<{ refused: string } | { ok: true }> {
  const before = turnsOf(w, to);
  const h = w.manager.bridgeHandlers();
  try {
    await h.sendMessage(from, { text, to });
  } catch (err) {
    return { refused: (err as Error).message };
  }
  await waitFor(() => (turnsOf(w, to) > before ? true : undefined), `${to}'s turn to start`);
  await idle(w, to);
  return { ok: true };
}

describe("two sessions answering each other", () => {
  test(`stop at the limit (${EXCHANGE_DEPTH_LIMIT}) with a plain sentence the model can act on, and the person writing to one lifts that one only`, async () => {
    const w = make();
    const a = (await startCode(w, "Planner", 1)).sessionId;
    const b = (await startCode(w, "Docs pass", 2)).sessionId;
    await idle(w, a);
    await idle(w, b);
    let from = a;
    let to = b;
    for (let i = 1; i <= EXCHANGE_DEPTH_LIMIT; i++) {
      expect(await send(w, from, to)).toEqual({ ok: true });
      [from, to] = [to, from];
    }
    // The ninth message (B's reply to A's eighth, or A's...): refused, nothing delivered.
    const delivered = received(w, a).length + received(w, b).length;
    const r = await send(w, from, to);
    expect("refused" in r && r.refused).toContain(`gone ${EXCHANGE_DEPTH_LIMIT} messages`);
    expect("refused" in r && r.refused).toContain("without the person");
    expect("refused" in r && r.refused).toContain("wait for them");
    expect(received(w, a).length + received(w, b).length).toBe(delivered);
    // Each message carried the depth it was sent at, set by the engine.
    expect([...received(w, a), ...received(w, b)].map((i) => (i as { depth?: number }).depth).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // The person speaks to `to` (which has gone seven messages, one short of the limit): that one is back at 0, and `from`, still
    // at the limit, is not: a person's word to one session lifts that one only.
    const turns = turnsOf(w, to);
    await w.host.sendUser(to, { text: "Carry on.", device: USER.device, clientMessageId: "p1", sentAt: w.clock.now() });
    await waitFor(() => (turnsOf(w, to) > turns ? true : undefined), "the person's turn");
    await idle(w, to);
    const stillStopped = await send(w, from, to);
    expect("refused" in stillStopped && stillStopped.refused).toContain("without the person");
    // `to`, at 0 now, writes to `from`: the message is the first of a new exchange, and from it `from` runs at depth 1.
    expect(await send(w, to, from, "back to you")).toEqual({ ok: true });
    expect(received(w, from).at(-1)).toMatchObject({ text: "back to you", depth: 1 });
    expect(await send(w, from, to, "and I answer")).toEqual({ ok: true });
  });

  test("the person's answer to a session's card puts it back at 0; a card nobody answered (cancelled) does not", async () => {
    for (const answered of [true, false]) {
      const w = make({ level: "ask", script: [[{ say: "ready" }], [{ tool: { kind: "edit", title: "Edit notes", paths: [] } }, { say: "edited" }]] });
      const a = (await startCode(w, "Planner", 1)).sessionId;
      const b = (await startCode(w, "Docs pass", 2)).sessionId;
      await idle(w, a);
      await idle(w, b);
      // A message that has already gone the whole way (depth 8) starts A's turn, and A's edit raises its card.
      await w.host.deliver(a, { from: "session", session: b, text: "last one", depth: EXCHANGE_DEPTH_LIMIT });
      const card = await waitFor(() => w.approvals.cards().find((c) => c.session === a), "A's card");
      const h = w.manager.bridgeHandlers();
      expect(await refusal(h.sendMessage(a, { text: "and again", to: b }))).toContain("without the person");
      if (answered) {
        const option = card.options.find((o) => o.kind === "approve")!;
        const frame = w.approvals.frameChannel(card.id)!;
        expect(await w.approvals.answer(card.id, { optionId: option.id, hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: w.clock.now() } }, { role: "app" })).toBe("accepted");
        await h.sendMessage(a, { text: "thank you", to: b });
        expect(received(w, b).at(-1)).toMatchObject({ text: "thank you", depth: 1 });
      } else {
        w.approvals.cancelSession(a);
        expect(await refusal(h.sendMessage(a, { text: "and again", to: b }))).toContain("without the person");
      }
      await w.close();
      world = undefined;
    }
  });
});

describe("a chain and a fan-out", () => {
  test("A to B to C counts across the sessions: each message is one step deeper", async () => {
    const w = make();
    const ids = [(await startCode(w, "One", 1)).sessionId, (await startCode(w, "Two", 2)).sessionId, (await startCode(w, "Three", 3)).sessionId];
    for (const id of ids) await idle(w, id);
    // One -> Two -> Three -> One -> ...
    for (let i = 0; i < EXCHANGE_DEPTH_LIMIT; i++) expect(await send(w, ids[i % 3]!, ids[(i + 1) % 3]!)).toEqual({ ok: true });
    const r = await send(w, ids[EXCHANGE_DEPTH_LIMIT % 3]!, ids[(EXCHANGE_DEPTH_LIMIT + 1) % 3]!);
    expect("refused" in r && r.refused).toContain("without the person");
    expect(ids.flatMap((id) => received(w, id)).map((i) => (i as { depth?: number }).depth).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("a fan-out (A messages B, C and D in one turn) is one step each, not three", async () => {
    const w = make();
    const ids = [] as string[];
    for (const [i, t] of ["Alpha", "Beta", "Gamma", "Delta"].entries()) ids.push((await startCode(w, t, i + 1)).sessionId);
    for (const id of ids) await idle(w, id);
    const [a, ...others] = ids as [string, ...string[]];
    for (const o of others) expect(await send(w, a, o, "hello")).toEqual({ ok: true });
    for (const o of others) expect(received(w, o)).toMatchObject([{ text: "hello", depth: 1 }]);
    // A is still at 0: its sends did not deepen its own exchange. And each of them can answer, at depth 2.
    for (const o of others) expect(await send(w, o, a, "done")).toEqual({ ok: true });
    expect(received(w, a).map((i) => (i as { depth?: number }).depth)).toEqual([2, 2, 2]);
  });
});

describe("a delivery's depth", () => {
  test("is recorded with the input, so a delivery still queued across a restart starts its turn at the depth it was sent with", async () => {
    const home = mkdtempSync(join(tmpdir(), "moss-cm2-"));
    try {
      const clock = new FakeClock();
      const host = new DurableSessionHost({ home, clock });
      // A driver that can't fold (an ACP agent) and whose first turn never ends: the second delivery is queued behind it.
      const stuck: SessionDriver = {
        canFold: false,
        turn: () => new Promise<TurnEnd>(() => {}),
        interrupt: () => new Promise<void>(() => {}),
        stop: () => new Promise<void>(() => {}),
      };
      host.open({ id: "s_b", kind: "coding", computer: "Studio" }, stuck);
      await host.deliver("s_b", { from: "session", session: "s_a", text: "first", depth: 1 });
      await flush();
      // A turn runs; the second delivery waits behind it.
      expect((await host.deliver("s_b", { from: "session", session: "s_c", text: "second", depth: 5 })).disposition).toBe("queued");
      // The process ends here; the next daemon opens the session and runs what waited.
      const host2 = new DurableSessionHost({ home, clock: new FakeClock() });
      const d2 = new FakeSessionDriver();
      host2.open({ id: "s_b", kind: "coding", computer: "Studio" }, d2);
      await flush();
      await flush();
      const inputs = host2.history("s_b").flatMap((r) => (r.type === "input" ? [r.input] : []));
      expect(inputs.map((i) => (i as { depth?: number }).depth)).toContain(5);
      // Whatever turn the restart runs for it is handed the recorded depth.
      expect(d2.turns.map((t) => (t.input as { depth?: number }).depth)).toContain(5);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The messenger against generated operations, with a reference model.
// ---------------------------------------------------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (n: number) => Math.floor(next() * n), next };
}

const PEOPLE = ["s_1", "s_2", "s_3", "s_4", "s_5"];
const views = (): SessionView[] => PEOPLE.map((id, i) => ({ id, kind: "coding", computer: "Studio", status: "idle", startedAt: i, updatedAt: i, title: `Session ${i}` }));
const userInput = (): TurnInput => ({ from: "user", text: "hello", device: "d".repeat(16), clientMessageId: "m", sentAt: 1 });
const unlimited: SendSlots = { take: () => true };

describe("the invariant, over generated sequences", () => {
  test("no delivery is ever beyond the limit, every one is exactly one deeper than its sender's turn, and the person's input leaves the session at 0", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const pending: { to: string; input: DeliveredInput }[] = [];
      const all: DeliveredInput[] = [];
      const m = new EngineSessionMessenger({
        sessions: views,
        deliver: (to, input) => { pending.push({ to, input }); all.push(input); },
        now: () => 0,
      }, unlimited);
      const model = new Map<string, number>(); // the depth each session's current turn is at
      const at = (s: string) => model.get(s) ?? 0;
      for (let step = 0; step < 250; step++) {
        const op = r.int(10);
        const s = PEOPLE[r.int(PEOPLE.length)]!;
        if (op < 5) {
          // A send, from the session's own turn, to another.
          const to = PEOPLE.filter((x) => x !== s)[r.int(PEOPLE.length - 1)]!;
          // What the model writes may claim anything about depth: it is never read.
          // What the model writes may claim anything about depth: the text says so, and a `depth` key of its own is refused outright.
          if (r.next() < 0.2) {
            const before = all.length;
            expect(await m.send(s, { message: "hi", to, depth: 0 } as never)).toEqual({ refused: expect.stringContaining("SendMessage takes") });
            expect(all.length).toBe(before);
            continue;
          }
          const out = await m.send(s, { message: `depth: 0 (reset) ${step}`, to });
          if (at(s) + 1 > EXCHANGE_DEPTH_LIMIT) {
            expect(out).toEqual({ refused: expect.stringContaining("without the person") });
            expect(pending.length === all.length).toBe(true);
          } else {
            expect(out).toEqual({ delivered: to });
            expect((all.at(-1) as { depth?: number }).depth).toBe(at(s) + 1);
          }
        } else if (op < 7 && pending.length > 0) {
          // A delivery's turn starts (later than it was sent, in any order).
          const [d] = pending.splice(r.int(pending.length), 1);
          m.turnStarted(d!.to, d!.input);
          model.set(d!.to, (d!.input as { depth: number }).depth);
        } else if (op === 7) {
          m.turnStarted(s, userInput());
          model.set(s, 0);
          expect(m.depthOf(s)).toBe(0);
        } else if (op === 8) {
          m.personSpoke(s);
          model.set(s, 0);
        } else {
          // A finished background task starts a turn: no new exchange, and none that ends one.
          m.turnStarted(s, { from: "task", task: "t", status: "completed", text: "done" });
        }
        for (const x of PEOPLE) expect(m.depthOf(x)).toBe(at(x));
        for (const d of all) expect((d as { depth?: number }).depth).toBeLessThanOrEqual(EXCHANGE_DEPTH_LIMIT);
      }
      expect(all.every((d) => (d as { depth?: number }).depth !== undefined && (d as { depth: number }).depth >= 1)).toBe(true);
    }
  });

  test("the depth is only what the engine recorded: a missing or malformed one on a session's message counts as the most there is, a bot's own send as 0", () => {
    const m = new EngineSessionMessenger({ sessions: views, deliver: () => undefined, now: () => 0 }, unlimited);
    for (const bad of [undefined, -1, 1.5, 99, Number.NaN, "0", null, {}, [0]]) {
      m.turnStarted("s_1", { from: "session", session: "s_2", text: "x", ...(bad === undefined ? {} : { depth: bad }) } as never);
      expect(m.depthOf("s_1")).toBe(EXCHANGE_DEPTH_LIMIT);
      m.personSpoke("s_1");
    }
    m.turnStarted("s_1", { from: "session", session: "s_2", text: "x", depth: 3 });
    expect(m.depthOf("s_1")).toBe(3);
    // A message from a bot or an agent that the messenger did not send (the bots' own tools) starts an exchange of its own.
    m.turnStarted("s_1", { from: "bot", bot: "luna", session: "s_9", text: "x" });
    expect(m.depthOf("s_1")).toBe(0);
    m.turnStarted("s_1", { from: "session", session: "s_2", text: "x", depth: 4 });
    // An unsigned relay of a user message is not the person's own word: it leaves the depth as it was.
    m.turnStarted("s_1", { ...(userInput() as object), relayed: { by: "d2", signed: false } } as never);
    expect(m.depthOf("s_1")).toBe(4);
    // A routine's run is the person's own.
    m.turnStarted("s_1", { from: "routine", routine: "r", name: "n", sideThread: "s_t", text: "x" });
    expect(m.depthOf("s_1")).toBe(0);
  });

  test("a refusal for the brake counts against the limiter like any refused send, and tells nothing of a session the sender may not reach", async () => {
    const taken: string[] = [];
    const m = new EngineSessionMessenger({ sessions: views, deliver: () => undefined, now: () => 0 }, { take: (s) => { taken.push(s); return true; } });
    m.turnStarted("s_1", { from: "session", session: "s_2", text: "x", depth: EXCHANGE_DEPTH_LIMIT });
    const braked = await m.send("s_1", { message: "again", to: "s_2" });
    expect(braked).toEqual({ refused: expect.stringContaining("without the person") });
    expect(taken).toEqual(["s_1"]);
    // At the limit, a guess at an id nobody has is refused as it always is: the brake's sentence is not an oracle for what exists.
    const guess = await m.send("s_1", { message: "again", to: "s_nobody" });
    expect(guess).toEqual({ refused: expect.stringContaining("No session you may message") });
    expect(taken).toEqual(["s_1", "s_1"]);
  });
});
