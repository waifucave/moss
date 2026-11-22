// The SessionMessenger conformance suite (spec revision 20, §9.5). `runSessionMessengerConformance(make)` registers every
// case against the door `make` builds over the world it is given; `tests/session-reach.test.ts` runs it against
// FakeSessionMessenger, and lane CM against the engine's (the bridge's `SendMessage` and `ListSessions`).
import { describe, expect, test } from "bun:test";
import { SESSION_SEND_LIMIT, SESSION_SEND_WINDOW_MS, type SessionView } from "@waifucave/moss-protocol";
import type { SessionMessenger, SessionMessengerWorld } from "../session-reach";
import type { DeliveredInput } from "../session-host";

export type SessionMessengerFactory = (world: SessionMessengerWorld) => SessionMessenger;

const v = (id: string, extra: Partial<SessionView> = {}): SessionView => ({ id, kind: "coding", computer: "Studio", status: "idle", startedAt: 1, updatedAt: 1, ...extra });

function world(sessions: SessionView[]) {
  let t = 1_000;
  const delivered: { to: string; input: DeliveredInput }[] = [];
  const links: string[] = [];
  const w: SessionMessengerWorld = {
    sessions: () => sessions,
    deliver: (to, input) => void delivered.push({ to, input }),
    link: (from, to) => void links.push(`${from}>${to}`),
    now: () => t,
  };
  return { w, delivered, links, advance: (ms: number) => { t += ms; } };
}

const SESSIONS = [
  v("s_a", { title: "Fix the login flow" }), v("s_b", { title: "Docs pass" }), v("s_c", { kind: "agent", parent: "s_a", startedBy: { kind: "session", session: "s_a" }, title: "Tests" }),
  v("s_old", { status: "stopped", title: "Old" }),
  v("s_moss", { kind: "bot", bot: "moss", title: "MOSS" }), v("s_side", { kind: "side-thread", bot: "moss" }),
  v("s_d", { kind: "agent", bot: "moss", parent: "s_moss" }), v("s_luna", { kind: "bot", bot: "luna" }), v("s_e", { kind: "agent", bot: "luna", parent: "s_luna" }),
];

export function runSessionMessengerConformance(make: SessionMessengerFactory): void {
  describe("SessionMessenger", () => {
    test("a session the person drives reaches the person's other code sessions and children, by id or title; never a bot's", async () => {
      const { w, delivered, links } = world(SESSIONS);
      const m = make(w);
      expect(await m.send("s_a", { message: "hi", to: "docs pass" })).toEqual({ delivered: "s_b" });
      expect(await m.send("s_a", { message: "go", to: "s_c" })).toEqual({ delivered: "s_c" });
      expect(await m.send("s_c", { message: "done", to: "s_b" })).toEqual({ delivered: "s_b" });
      for (const to of ["s_moss", "s_side", "s_d", "MOSS", "s_a", "s_old"]) expect([to, "refused" in (await m.send("s_a", { message: "x", to }))]).toEqual([to, true]);
      expect("refused" in (await m.send("s_a", { message: "no target" }))).toBe(true);
      // `depth` (the loop brake, messenger.ts) may ride along; the sender and the words are the contract.
      expect(delivered[0]).toMatchObject({ to: "s_b", input: { from: "session", session: "s_a", text: "hi" } });
      expect(delivered.length).toBe(3);
      expect(links).toEqual(["s_a>s_b", "s_a>s_c", "s_c>s_b"]);
    });

    test("a bot's session reaches its own bot's sessions, every bot's conversation and the sessions the person started, never a session another session started", async () => {
      const { w, delivered } = world(SESSIONS);
      const m = make(w);
      expect(await m.send("s_d", { message: "progress" })).toEqual({ delivered: "s_moss" });
      expect(await m.send("s_moss", { message: "and?", to: "s_d" })).toEqual({ delivered: "s_d" });
      expect(await m.send("s_moss", { message: "hello", to: "s_luna" })).toEqual({ delivered: "s_luna" });
      // The owner's ruling of 2026-11-22: a session the person started takes a bot's message, as that session's.
      expect(await m.send("s_moss", { message: "for you", to: "s_b" })).toEqual({ delivered: "s_b" });
      expect(await m.send("s_d", { message: "from my agent", to: "s_a" })).toEqual({ delivered: "s_a" });
      // The person's child (started by a session), another bot's agent and an ended session: no.
      for (const to of ["s_c", "s_e", "s_old"]) expect([to, "refused" in (await m.send("s_moss", { message: "x", to }))]).toEqual([to, true]);
      expect(delivered.map((d) => d.input.from)).toEqual(["agent", "bot", "bot", "session", "session"]);
      expect(delivered[3]).toMatchObject({ to: "s_b", input: { from: "session", session: "s_moss", text: "for you" } });
    });

    test("a session the person started cannot answer a bot's session: it reaches no bot", async () => {
      const { w, delivered } = world(SESSIONS);
      const m = make(w);
      for (const to of ["s_moss", "s_side", "s_d", "s_luna", "s_e"]) expect([to, "refused" in (await m.send("s_b", { message: "x", to }))]).toEqual([to, true]);
      expect(delivered).toEqual([]);
    });

    test("ListSessions lists exactly what SendMessage would deliver to", () => {
      const { w } = world(SESSIONS);
      const m = make(w);
      expect(m.reachable("s_a").map((s) => s.id).sort()).toEqual(["s_b", "s_c"]);
      expect(m.reachable("s_d").map((s) => s.id).sort()).toEqual(["s_a", "s_b", "s_luna", "s_moss", "s_side"]);
      expect(Object.keys(m.reachable("s_a")[0]!)).not.toContain("root");
    });

    test(`at most ${SESSION_SEND_LIMIT} sends a minute per sending session; over it nothing is delivered`, async () => {
      const { w, delivered, advance } = world(SESSIONS);
      const m = make(w);
      for (let i = 0; i < SESSION_SEND_LIMIT; i++) expect(await m.send("s_a", { message: `m${i}`, to: "s_b" })).toEqual({ delivered: "s_b" });
      expect("refused" in (await m.send("s_a", { message: "one more", to: "s_b" }))).toBe(true);
      expect(await m.send("s_b", { message: "another sender", to: "s_a" })).toEqual({ delivered: "s_a" });
      advance(SESSION_SEND_WINDOW_MS);
      expect(await m.send("s_a", { message: "later", to: "s_b" })).toEqual({ delivered: "s_b" });
      expect(delivered.length).toBe(SESSION_SEND_LIMIT + 2);
    });

    test("two sessions with the title refuse a send by it, naming both", async () => {
      const { w } = world([...SESSIONS, v("s_b2", { title: "Docs pass" })]);
      const r = await make(w).send("s_a", { message: "x", to: "Docs pass" });
      expect("refused" in r && r.refused.includes("s_b") && r.refused.includes("s_b2")).toBe(true);
    });
  });
}
