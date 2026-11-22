// The engine's SessionMessenger (lane CM): the contract's conformance suite on the real class, the property that the
// listing equals the rule and the send delivers exactly there, and what a guess at a session learns.
import { describe, expect, test } from "bun:test";
import { LIST_SESSIONS_MAX, SESSION_SEND_LIMIT, SESSION_SEND_WINDOW_MS, reachRefusal, type SessionKind, type SessionView } from "@waifucave/moss-protocol";
import { runSessionMessengerConformance } from "../../contracts/conformance/session-reach";
import type { DeliveredInput } from "../../contracts/session-host";
import { EngineSessionMessenger, type EngineMessengerWorld } from "../bridge/messenger";

runSessionMessengerConformance((world) => new EngineSessionMessenger(world));

// ---------------------------------------------------------------------------------------------------------------------
// The property: for generated sets of sessions, `ListSessions(s)` is exactly the `t` with `reachRefusal(s, t)` null (ended
// ones aside), and `SendMessage` delivers exactly there, by id and by title.
// ---------------------------------------------------------------------------------------------------------------------

/** A small deterministic generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]! };
}

const TITLES = ["Docs pass", "docs pass", "Fix login", "Tests", undefined, undefined, "MOSS"] as const;

function generate(seed: number): SessionView[] {
  const r = rng(seed);
  const out: SessionView[] = [];
  const bots = ["moss", "luna", "sora"];
  const n = 4 + r.int(14);
  for (let i = 0; i < n; i++) {
    const kind = r.pick(["coding", "coding", "agent", "agent", "bot", "side-thread"] as const satisfies readonly SessionKind[]);
    const status = r.pick(["idle", "idle", "prompting", "ready", "stopped", "failed"] as const);
    const view: SessionView = { id: `s_${i}`, kind, computer: "Studio", status, startedAt: i, updatedAt: i };
    const title = r.pick(TITLES);
    if (title !== undefined) view.title = title;
    if (kind === "bot") view.bot = r.pick(bots);
    else if (kind === "side-thread") { view.bot = r.pick(bots); }
    else if (kind === "agent" && i > 0 && r.next() < 0.8) {
      // A child: of a bot's session (carrying the bot, or only its parent's: the bot is read through the chain) or of a code session.
      const parent = out[r.int(out.length)]!;
      view.parent = parent.id;
      view.startedBy = { kind: "session", session: parent.id };
      if (parent.bot !== undefined && r.next() < 0.5) view.bot = parent.bot;
    } else if (kind === "agent") view.bot = r.pick(bots);
    else if (kind === "coding") {
      // The person's own (started by them, or from before revision 20 with no record of it) or a child another session started.
      const pick = r.next();
      if (pick < 0.55) view.startedBy = { kind: "user" };
      else if (pick > 0.8 && i > 0) { const parent = out[r.int(out.length)]!; view.parent = parent.id; view.startedBy = { kind: "session", session: parent.id }; }
    }
    out.push(view);
  }
  return out;
}

/** The bot of a session as `host.callerOf` reads it: its own, else its parent's, up the chain. */
function botOf(all: readonly SessionView[], s: SessionView): string | undefined {
  for (let at: SessionView | undefined = s, i = 0; at !== undefined && i < 20; at = all.find((x) => x.id === at!.parent), i++) if (at.bot !== undefined) return at.bot;
  return undefined;
}

describe("the property: ListSessions is the rule, and SendMessage delivers exactly there", () => {
  for (const seed of Array.from({ length: 60 }, (_, i) => i + 1)) {
    test(`generated sessions, seed ${seed}`, async () => {
      const all = generate(seed);
      const delivered: { to: string; input: DeliveredInput }[] = [];
      const world: EngineMessengerWorld = { sessions: () => all, deliver: (to, input) => void delivered.push({ to, input }), now: () => 0 };
      const m = new EngineSessionMessenger(world, { take: () => true });
      for (const s of all) {
        const me = { id: s.id, bot: botOf(all, s) };
        const want = all.filter((t) => t.status !== "stopped" && t.status !== "failed" && reachRefusal(me, { id: t.id, kind: t.kind, bot: botOf(all, t), startedBy: t.startedBy, parent: t.parent }) === undefined).map((t) => t.id);
        expect([s.id, m.reachable(s.id).map((x) => x.id).sort()]).toEqual([s.id, [...want].sort()]);
        // By id: delivered exactly to the listed ones.
        for (const t of all) {
          delivered.length = 0;
          const r = await m.send(s.id, { message: "x", to: t.id });
          expect([s.id, t.id, "delivered" in r]).toEqual([s.id, t.id, want.includes(t.id)]);
          expect(delivered.map((d) => d.to)).toEqual(want.includes(t.id) ? [t.id] : []);
        }
        // By title: a title reaches only the one listed session that has it, never a session the id form would refuse, and a title two share is refused.
        for (const title of new Set(all.flatMap((t) => (t.title === undefined ? [] : [t.title])))) {
          delivered.length = 0;
          const holders = want.filter((id) => all.find((x) => x.id === id)!.title?.toLowerCase() === title.toLowerCase());
          const r = await m.send(s.id, { message: "x", to: title });
          if (holders.length === 1) expect([title, r]).toEqual([title, { delivered: holders[0]! }]);
          else expect([title, "refused" in r, delivered.length]).toEqual([title, true, 0]);
          // A refusal names no session the sender may not reach.
          if ("refused" in r) for (const t of all) if (!want.includes(t.id)) expect([title, t.id, new RegExp(`\\b${t.id}\\b`).test(r.refused)]).toEqual([title, t.id, false]);
        }
      }
    });
  }

  test("a listing is at most LIST_SESSIONS_MAX long, and a stranger's id lists nothing", () => {
    const many: SessionView[] = Array.from({ length: LIST_SESSIONS_MAX + 30 }, (_, i) => ({ id: `s_${i}`, kind: "coding", computer: "Studio", status: "idle", startedAt: i, updatedAt: i }));
    const m = new EngineSessionMessenger({ sessions: () => many, deliver: () => {}, now: () => 0 });
    expect(m.reachable("s_0").length).toBe(LIST_SESSIONS_MAX);
    expect(m.reachable("s_stranger")).toEqual([]);
  });
});

describe("what the real messenger does that the contract's fake does not", () => {
  const v = (id: string, extra: Partial<SessionView> = {}): SessionView => ({ id, kind: "coding", computer: "Studio", status: "idle", startedAt: 1, updatedAt: 1, ...extra });

  test("a child of a bot's session that carries no bot itself is the bot's, so a session the person drives can't reach it (line 5)", async () => {
    const sessions = [v("s_me"), v("s_moss", { kind: "bot", bot: "moss" }), v("s_kid", { kind: "agent", parent: "s_moss", title: "Kid" }), v("s_grand", { kind: "agent", parent: "s_kid", title: "Grand" })];
    const delivered: string[] = [];
    const m = new EngineSessionMessenger({ sessions: () => sessions, deliver: (to) => void delivered.push(to), now: () => 0 });
    expect(m.reachable("s_me")).toEqual([]);
    for (const to of ["s_kid", "Kid", "s_grand", "Grand"]) expect([to, "refused" in (await m.send("s_me", { message: "x", to }))]).toEqual([to, true]);
    // And from the bot's side the child is its own.
    // (and, by the owner's ruling of 2026-11-22, the person's own session: it started it itself.)
    expect(m.reachable("s_grand").map((s) => s.id).sort()).toEqual(["s_kid", "s_me", "s_moss"]);
    expect(delivered).toEqual([]);
  });

  test("a refused send counts toward the limit, before anything is read", async () => {
    let t = 0;
    const sessions = [v("s_a"), v("s_b")];
    const delivered: string[] = [];
    const m = new EngineSessionMessenger({ sessions: () => sessions, deliver: (to) => void delivered.push(to), now: () => t });
    for (let i = 0; i < SESSION_SEND_LIMIT; i++) expect("refused" in (await m.send("s_a", { message: "x", to: `s_nobody${i}` }))).toBe(true);
    expect(await m.send("s_a", { message: "x", to: "s_b" })).toMatchObject({ refused: expect.stringContaining("Too many") });
    expect(delivered).toEqual([]);
    t += SESSION_SEND_WINDOW_MS;
    expect(await m.send("s_a", { message: "x", to: "s_b" })).toEqual({ delivered: "s_b" });
  });

  test("a delivery the host refuses is a refusal that names nothing more, and no link is told", async () => {
    const links: string[] = [];
    const m = new EngineSessionMessenger({
      sessions: () => [v("s_a"), v("s_b")], deliver: () => { throw new Error("session s_b is closing"); }, link: (f, t) => void links.push(`${f}>${t}`), now: () => 0,
    });
    expect(await m.send("s_a", { message: "x", to: "s_b" })).toEqual({ refused: "The message wasn't sent: session s_b is closing" });
    expect(links).toEqual([]);
  });

  test("an over-long message and a message that is not one are refused", async () => {
    const m = new EngineSessionMessenger({ sessions: () => [v("s_a"), v("s_b")], deliver: () => {}, now: () => 0 });
    expect(await m.send("s_a", { message: "x".repeat(100_001), to: "s_b" })).toMatchObject({ refused: expect.stringContaining("at most 100000") });
    expect("refused" in (await m.send("s_a", { message: "", to: "s_b" }))).toBe(true);
  });
});
