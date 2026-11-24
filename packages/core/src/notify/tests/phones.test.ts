// Where the core's own updates are pushed (spec §8, §10; protocol `phonesToWake`): a notifier is told, with each update,
// which paired phones it is for. A bot's update is for the phones paired as MOSS, a coding or agent session's for those paired
// as MOSS Code, and for the person's other phones when none is of that app; a plugin's notice names none (every phone). And a
// notifier that is busy while updates come in loses no one's phones when they coalesce.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotifierUpdate } from "@waifucave/moss-plugin-sdk";
import type { PairedPhone } from "@waifucave/moss-protocol";
import type { InvokeRequest } from "../../contracts/plugin-host";
import { mergePhones, NotifyService } from "../service";

const MOSS = "m".repeat(20);
const CODE = "c".repeat(20);
const OLD = "o".repeat(20);

function world(phones: PairedPhone[] | undefined) {
  const home = mkdtempSync(join(tmpdir(), "moss-notify-phones-"));
  const seen: NotifierUpdate[] = [];
  let release: (() => void) | undefined;
  let hold = false;
  const service = new NotifyService({
    home, computer: "Studio", clock: { now: () => 1_800_000_000_000 },
    registry: {
      get: () => undefined,
      entries: (point: string) => (point === "notifiers" ? [{ point, pluginId: "pinger", ref: "notifiers/0", value: { id: "ping", handler: "notifier" }, state: "active" }] : []) as never,
    },
    host: () => ({
      invoke: (async (req: InvokeRequest) => {
        seen.push(req.args as NotifierUpdate);
        if (hold) await new Promise<void>((r) => (release = r));
        return undefined;
      }) as never,
    }),
    ...(phones === undefined ? {} : { phones: () => phones }),
  });
  return {
    service, seen,
    settle: () => new Promise((r) => setTimeout(r, 5)),
    hold: (on: boolean) => { hold = on; if (!on) release?.(); },
    done: () => rmSync(home, { recursive: true, force: true }),
  };
}

const BOTH: PairedPhone[] = [{ id: MOSS, app: "moss" }, { id: CODE, app: "code" }];

test("the core's updates name the phones they are for: a bot's to MOSS, a coding or agent session's to MOSS Code", async () => {
  const table: [string, Parameters<NotifyService["core"]>[0], PairedPhone[], string[] | undefined][] = [
    ["a bot's card", { kind: "card", bot: "luna", session: "b_luna" }, BOTH, [MOSS]],
    ["a bot's message", { kind: "message", bot: "luna", session: "b_luna" }, BOTH, [MOSS]],
    ["a bot's question", { kind: "question", bot: "luna", session: "b_luna" }, BOTH, [MOSS]],
    ["a coding session's card", { kind: "card", sessionKind: "coding", session: "s_1" }, BOTH, [CODE]],
    ["an agent session's finish", { kind: "agent-finished", sessionKind: "agent", session: "s_2" }, BOTH, [CODE]],
    ["a coding session's card with no MOSS Code phone: the other phones", { kind: "card", sessionKind: "coding", session: "s_1" }, [{ id: MOSS, app: "moss" }, { id: OLD }], [MOSS, OLD]],
    ["a bot's card with only an old phone", { kind: "card", bot: "luna", session: "b_luna" }, [{ id: OLD }], [OLD]],
    ["a revoked phone of the app is not woken", { kind: "card", bot: "luna", session: "b_luna" }, [{ id: MOSS, app: "moss", revokedAt: 4 }, { id: CODE, app: "code" }], [CODE]],
    ["no paired phone at all", { kind: "card", bot: "luna", session: "b_luna" }, [], []],
    ["an update that names neither a bot nor a session kind: every phone", { kind: "routine-result" }, BOTH, undefined],
  ];
  for (const [name, update, phones, want] of table) {
    const w = world(phones);
    w.service.core(update);
    await w.settle();
    expect([name, w.seen[0]!.phones]).toEqual([name, want]);
    w.done();
  }
});

test("a computer that knows no phones, and a plugin's notice, name none: a notifier wakes every phone", async () => {
  const none = world(undefined);
  none.service.core({ kind: "card", bot: "luna", session: "b_luna" });
  await none.settle();
  expect("phones" in none.seen[0]!).toBe(false);
  none.done();
});

test("mergePhones: absent is every phone, and the rest of the two lists are kept", () => {
  const u = (phones?: string[]): NotifierUpdate => ({ seq: 1, kind: "card", unseen: 1, at: 1, sender: { pluginId: "moss", name: "MOSS", bundled: true }, ...(phones === undefined ? {} : { phones }) });
  expect(mergePhones(u(["a"]), u(["b"])).phones).toEqual(["b", "a"]);
  expect(mergePhones(u(["a", "b"]), u(["b"])).phones).toEqual(["b", "a"]);
  expect("phones" in mergePhones(u(), u(["b"]))).toBe(false);
  expect("phones" in mergePhones(u(["a"]), u())).toBe(false);
  expect(mergePhones(u(["a"]), u(["b"])).seq).toBe(1);
});

// A generated sequence: whatever order updates for each audience come in while the notifier is busy, every update's phones
// are in what the notifier is handed after it, and the last one handed is the latest update.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test("while a notifier is busy, coalesced updates keep every audience (generated sequences)", async () => {
  const shapes: Parameters<NotifyService["core"]>[0][] = [
    { kind: "card", bot: "luna", session: "b_luna" },
    { kind: "message", bot: "luna", session: "b_luna" },
    { kind: "card", sessionKind: "coding", session: "s_1" },
    { kind: "agent-finished", sessionKind: "agent", session: "s_2" },
    { kind: "routine-result" },
  ];
  const wantOf = (shape: (typeof shapes)[number]): string[] | undefined => (shape.kind === "routine-result" ? undefined : shape.bot !== undefined ? [MOSS] : [CODE]);
  for (let seed = 1; seed <= 60; seed++) {
    const next = rng(seed);
    const w = world(BOTH);
    w.hold(true);
    w.service.core(shapes[0]!);
    await w.settle();
    const count = 1 + Math.floor(next() * 6);
    const sent: (typeof shapes)[number][] = [shapes[0]!];
    for (let i = 0; i < count; i++) {
      const shape = shapes[Math.floor(next() * shapes.length)]!;
      sent.push(shape);
      w.service.core(shape);
    }
    w.hold(false);
    await w.settle();
    await w.settle();
    // The first update ran alone (the notifier was handed it before it blocked); the rest coalesced into one.
    const handed = w.seen.slice(1);
    const waiting = sent.slice(1);
    const label = `seed ${seed}: ${JSON.stringify(waiting.map((s) => s.kind + (s.bot ?? s.sessionKind ?? "")))}`;
    expect([label, handed.length]).toEqual([label, 1]);
    const got = handed[0]!.phones;
    for (const shape of waiting) {
      const want = wantOf(shape);
      // An update for every phone leaves no list; otherwise its phones are all in the list that was handed.
      if (want === undefined) expect([label, got]).toEqual([label, undefined]);
      else if (got !== undefined) for (const id of want) expect([label, got.includes(id)]).toEqual([label, true]);
    }
    expect([label, handed[0]!.kind]).toEqual([label, waiting[waiting.length - 1]!.kind]);
    w.done();
  }
});
