// The engine's session graph (sessions/session-graph.ts) against the SessionGraph conformance suite, plus generated
// sequences for its two folds: the waiting counts and the subagent rows (lane-common: code that turns a sequence of
// events into a state gets a property test of its invariant).
import { describe, expect, test } from "bun:test";
import { SESSION_LINK_PAIRS_MAX, SESSION_LINKS_RECENT_MAX, SUBAGENTS_MAX, type SessionStarter, type SessionSubagent } from "@waifucave/moss-protocol";
import { runSessionGraphConformance } from "../../contracts/conformance/session-graph";
import { EngineSessionGraph, derivedStarter } from "../session-graph";

runSessionGraphConformance((now) => new EngineSessionGraph(now));

/** A small seeded generator (mulberry32), so a failing sequence can be played again from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("waiting counts over generated sequences", () => {
  test("each session's counts equal a plain model of its running children and tasks; absent exactly when both are zero", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      const g = new EngineSessionGraph(() => 1);
      // The model: each session's starter session, whether it ended, its tasks.
      const model = new Map<string, { starter?: string; ended: boolean; tasks: Set<string> }>();
      const ids: string[] = [];
      const steps: string[] = [];
      for (let i = 0; i < 80; i++) {
        const op = r();
        if (op < 0.3 || ids.length === 0) {
          const id = `s_${ids.length}`;
          const parent = ids.length > 0 && r() < 0.6 ? pick(ids) : undefined;
          const by: SessionStarter = parent === undefined ? { kind: "user" } : r() < 0.5 ? { kind: "session", session: parent } : { kind: "bot", bot: "moss", session: parent };
          g.started(id, parent === undefined ? "coding" : "agent", by, by.kind === "bot" ? "moss" : undefined);
          model.set(id, { ...(parent === undefined ? {} : { starter: parent }), ended: false, tasks: new Set() });
          ids.push(id);
          steps.push(`start ${id}<${parent ?? "-"}`);
        } else if (op < 0.45) {
          const id = pick(ids);
          g.ended(id);
          const m = model.get(id)!;
          m.ended = true;
          m.tasks.clear();
          steps.push(`end ${id}`);
        } else if (op < 0.75) {
          const id = pick(ids);
          const task = `t${Math.floor(r() * 4)}`;
          g.taskStarted(id, task);
          const m = model.get(id)!;
          if (!m.ended) m.tasks.add(task);
          steps.push(`task+ ${id} ${task}`);
        } else {
          const id = pick(ids);
          const task = `t${Math.floor(r() * 4)}`;
          g.taskEnded(id, task);
          model.get(id)!.tasks.delete(task);
          steps.push(`task- ${id} ${task}`);
        }
        for (const id of ids) {
          const children = [...model.values()].filter((c) => !c.ended && c.starter === id).length;
          const tasks = model.get(id)!.tasks.size;
          const want = tasks + children > 0 ? { tasks, children } : undefined;
          const got = g.fields(id).waiting;
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            throw new Error(`seed ${seed}, after ${steps.join("; ")}: ${id} waits ${JSON.stringify(got)}, the model says ${JSON.stringify(want)}`);
          }
          if (got !== undefined) expect(got.tasks >= 0 && got.children >= 0 && got.tasks + got.children > 0).toBe(true);
        }
      }
    }
  });

  test("every change is heard once, and a step that changes nothing is not heard", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = rng(seed);
      const g = new EngineSessionGraph(() => 1);
      const heard = new Map<string, string>();
      g.watch((c) => {
        const key = JSON.stringify(c.fields);
        expect(heard.get(c.session)).not.toBe(key);
        heard.set(c.session, key);
      });
      const ids: string[] = [];
      for (let i = 0; i < 60; i++) {
        if (ids.length === 0 || r() < 0.25) {
          const id = `s_${ids.length}`;
          const parent = ids.length > 0 && r() < 0.5 ? ids[Math.floor(r() * ids.length)] : undefined;
          g.started(id, "coding", parent === undefined ? { kind: "user" } : { kind: "session", session: parent });
          ids.push(id);
        } else {
          const id = ids[Math.floor(r() * ids.length)]!;
          const t = `t${Math.floor(r() * 2)}`;
          if (r() < 0.2) g.ended(id);
          else if (r() < 0.6) g.taskStarted(id, t);
          else g.taskEnded(id, t);
        }
        // What was last heard of each session is what it is now.
        for (const id of ids) expect(heard.get(id)).toBe(JSON.stringify(g.fields(id)));
      }
    }
  });
});

describe("subagent rows over generated sequences", () => {
  test("bounded, ids unique and kept, no running row dropped while an ended one remains, an ended row never runs again", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      let t = 1_000;
      const g = new EngineSessionGraph(() => t);
      g.started("s_a", "coding", { kind: "user" });
      const endedAt = new Map<string, number>();
      const startedAt = new Map<string, number>();
      let next = 0;
      for (let i = 0; i < 160; i++) {
        t += 1 + Math.floor(r() * 5);
        const known = [...startedAt.keys()];
        const fresh = known.length === 0 || r() < 0.55;
        const id = fresh ? `call_${next++}` : known[Math.floor(r() * known.length)]!;
        const state: SessionSubagent["state"] = fresh ? (r() < 0.8 ? "running" : "done") : r() < 0.3 ? "running" : r() < 0.6 ? "done" : "failed";
        const before = g.fields("s_a").subagents ?? [];
        const runningBefore = before.filter((s) => s.state === "running").map((s) => s.id);
        const endedBefore = before.filter((s) => s.state !== "running").length;
        g.subagent("s_a", { id, name: `n ${id}`, state, startedAt: t });
        if (!startedAt.has(id)) startedAt.set(id, t);
        const rows = g.fields("s_a").subagents ?? [];
        expect(rows.length).toBeLessThanOrEqual(SUBAGENTS_MAX);
        expect(new Set(rows.map((s) => s.id)).size).toBe(rows.length);
        for (const row of rows) {
          // Its start is its first report's; its end is set exactly when it ended, and never moves.
          expect(row.startedAt).toBe(startedAt.get(row.id)!);
          expect(row.endedAt !== undefined).toBe(row.state !== "running");
          if (row.state !== "running") {
            if (!endedAt.has(row.id)) endedAt.set(row.id, row.endedAt!);
            expect(row.endedAt).toBe(endedAt.get(row.id)!);
          } else expect(endedAt.has(row.id)).toBe(false);
        }
        // A row was dropped only to keep the bound: a running one only when no ended one was there to go.
        const dropped = runningBefore.filter((x) => !rows.some((s) => s.id === x));
        if (dropped.length > 0) expect(endedBefore).toBe(0);
        // A row the bound dropped is gone: reported again, it is a new row.
        for (const x of [...startedAt.keys()]) {
          if (rows.some((s) => s.id === x)) continue;
          startedAt.delete(x);
          endedAt.delete(x);
        }
      }
    }
  });

  test("rows still running when their parent's calls are cut off end failed, at that time", () => {
    let t = 10;
    const g = new EngineSessionGraph(() => t);
    g.started("s_a", "coding", { kind: "user" });
    g.subagent("s_a", { id: "c1", name: "Explore", state: "running", startedAt: 5 });
    g.subagent("s_a", { id: "c2", name: "Review", state: "done", startedAt: 6 });
    t = 20;
    g.subagentsCutOff("s_a");
    expect(g.fields("s_a").subagents).toEqual([
      { id: "c1", name: "Explore", state: "failed", startedAt: 5, endedAt: 20 },
      { id: "c2", name: "Review", state: "done", startedAt: 6, endedAt: 10 },
    ]);
  });
});

describe("links and starters", () => {
  test("the first delivery from a session's starter is its spawn; every later one a message", () => {
    const g = new EngineSessionGraph(() => 1);
    g.started("b_moss", "bot", { kind: "user" }, "moss");
    g.started("agent_1", "agent", { kind: "bot", bot: "moss", session: "b_moss" }, "moss");
    g.started("s_x", "coding", { kind: "user" });
    expect(g.deliveryKind("s_x", "agent_1")).toBe("message");
    expect(g.deliveryKind("b_moss", "agent_1")).toBe("spawn");
    expect(g.deliveryKind("b_moss", "agent_1")).toBe("message");
  });

  test("a session from before revision 20 reads its starter from its kind, bot, parent and routine", () => {
    expect(derivedStarter({ kind: "coding" })).toEqual({ kind: "user" });
    expect(derivedStarter({ kind: "bot", bot: "moss" })).toEqual({ kind: "user" });
    expect(derivedStarter({ kind: "agent", bot: "moss", parent: "b_moss" })).toEqual({ kind: "bot", bot: "moss", session: "b_moss" });
    expect(derivedStarter({ kind: "side-thread", bot: "moss", parent: "b_moss", routine: "r_daily" })).toEqual({ kind: "routine", routine: "r_daily", bot: "moss" });
    expect(derivedStarter({ kind: "side-thread", bot: "moss", parent: "b_moss" })).toEqual({ kind: "bot", bot: "moss", session: "b_moss" });
    expect(derivedStarter({ kind: "agent", parent: "s_a" })).toEqual({ kind: "session", session: "s_a" });
  });

  test("a reader that throws doesn't stop the others", () => {
    const g = new EngineSessionGraph(() => 1);
    g.started("s_a", "coding", { kind: "user" });
    const heard: string[] = [];
    g.watchLinks({ kind: "user" }, () => { throw new Error("mine"); });
    g.watchLinks({ kind: "user" }, (l) => heard.push(l.link));
    g.link(undefined, "s_a", "message");
    expect(heard).toEqual(["message"]);
  });
});

describe("the record of links", () => {
  const memory = () => {
    let kept: unknown;
    return { load: () => (kept === undefined ? undefined : JSON.parse(JSON.stringify(kept))), save: (k: unknown) => { kept = k; }, raw: () => kept };
  };

  test("it survives a restart through its store; the person's messages aren't kept; a file that doesn't read is an empty record", () => {
    const store = memory();
    const g = new EngineSessionGraph(() => 5, store);
    g.started("s_a", "coding", { kind: "user" });
    g.started("s_b", "coding", { kind: "user" });
    g.link("s_a", "s_b", "message");
    g.link(undefined, "s_a", "message");
    const again = new EngineSessionGraph(() => 6, store);
    again.started("s_a", "coding", { kind: "user" }, undefined, { quiet: true });
    again.started("s_b", "coding", { kind: "user" }, undefined, { quiet: true });
    const r = again.links({ kind: "user" });
    expect(r.pairs.map((p) => [p.to.session, p.count, p.lastAt])).toEqual([["s_b", 1, 5]]);
    expect(r.links.length).toBe(1);
    // A pair whose session has ended by the time it is read is not drawn; one never registered isn't either.
    const third = new EngineSessionGraph(() => 7, store);
    third.started("s_a", "coding", { kind: "user" }, undefined, { quiet: true });
    third.started("s_b", "coding", { kind: "user" }, undefined, { ended: true, quiet: true });
    expect(third.links({ kind: "user" })).toEqual({ pairs: [], links: [] });
    for (const bad of [{ v: 2 }, "junk", { v: 1, pairs: [{ nope: 1 }], recent: [{ type: "x" }] }]) {
      const g2 = new EngineSessionGraph(() => 1, { load: () => bad, save: () => {} });
      expect(g2.links({ kind: "user" })).toEqual({ pairs: [], links: [] });
    }
    const throwing = new EngineSessionGraph(() => 1, { load: () => { throw new Error("disk"); }, save: () => { throw new Error("disk"); } });
    throwing.started("s_a", "coding", { kind: "user" });
    throwing.started("s_b", "coding", { kind: "user" });
    throwing.link("s_a", "s_b", "message");
    expect(throwing.links({ kind: "user" }).pairs.length).toBe(1);
  });

  test("under a generated flood the bounds hold, each pair's count and last link are right, and what is kept on disk is the same", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed);
      let t = 1;
      const store = memory();
      const g = new EngineSessionGraph(() => t, store);
      const ids = Array.from({ length: 60 }, (_, i) => `s_${i}`);
      for (const id of ids) g.started(id, "coding", { kind: "user" });
      const model = new Map<string, { count: number; lastAt: number; last: string }>();
      const order: { from: string; to: string; ts: number }[] = [];
      for (let i = 0; i < 3_000; i++) {
        t++;
        const from = ids[Math.floor(r() * ids.length)]!;
        let to = ids[Math.floor(r() * ids.length)]!;
        if (to === from) to = ids[(ids.indexOf(from) + 1) % ids.length]!;
        const kind = (["message", "spawn", "report"] as const)[Math.floor(r() * 3)]!;
        g.link(from, to, kind);
        const k = `${from}>${to}`;
        const was = model.get(k)?.count ?? 0;
        model.delete(k);
        model.set(k, { count: was + 1, lastAt: t, last: kind });
        // Past the bound the least lately used pair goes, and counts afresh if it comes back.
        while (model.size > SESSION_LINK_PAIRS_MAX) model.delete(model.keys().next().value!);
        order.push({ from, to, ts: t });
      }
      const got = g.links({ kind: "user" });
      expect(got.links.length).toBe(SESSION_LINKS_RECENT_MAX);
      expect(got.links.map((l) => l.ts)).toEqual(order.slice(-SESSION_LINKS_RECENT_MAX).map((o) => o.ts));
      expect(got.pairs.length).toBeLessThanOrEqual(SESSION_LINK_PAIRS_MAX);
      for (const p of got.pairs) {
        const want = model.get(`${p.from.end === "session" ? p.from.session : "?"}>${p.to.session}`)!;
        expect([p.count, p.lastAt, p.last as string]).toEqual([want.count, want.lastAt, want.last]);
      }
      // The pairs kept are the most lately used.
      const newest = [...model.values()].map((m) => m.lastAt).sort((a, b) => b - a).slice(0, SESSION_LINK_PAIRS_MAX);
      expect(got.pairs.map((p) => p.lastAt).sort((a, b) => b - a)).toEqual(newest);
      expect(got.links.every((l) => l.ts > t - 3_000)).toBe(true);
      const disk = store.raw() as { pairs: unknown[]; recent: unknown[] };
      expect(disk.pairs.length).toBe(got.pairs.length);
      expect(disk.recent.length).toBe(SESSION_LINKS_RECENT_MAX);
      expect(JSON.stringify(disk).length).toBeLessThan(600_000);
      // Since a time: only what came after it.
      expect(g.links({ kind: "user" }, t - 10).links.map((l) => l.ts)).toEqual(order.slice(-10).map((o) => o.ts));
    }
  });

  test("a plugin that may not read one end learns nothing of the pair; an ended or forgotten session's records go, on disk too", () => {
    const store = memory();
    const g = new EngineSessionGraph(() => 1, store);
    g.started("b_moss", "bot", { kind: "user" }, "moss");
    g.started("agent_1", "agent", { kind: "bot", bot: "moss", session: "b_moss" }, "moss");
    g.started("s_a", "coding", { kind: "user" });
    g.started("s_b", "coding", { kind: "user" });
    g.link("b_moss", "agent_1", "spawn");
    g.link("s_a", "s_b", "message");
    g.link("s_b", "agent_1", "message");
    const code = g.links({ kind: "plugin", capabilities: ["sessions.read"] });
    // agent_1 is a bot's: its kind is `agent`, read with sessions.read; b_moss is a bot's conversation, which it can't read.
    expect(code.pairs.map((p) => `${p.from.end === "session" ? p.from.session : ""}>${p.to.session}`).sort()).toEqual(["s_a>s_b", "s_b>agent_1"]);
    expect(code.links.some((l) => l.from.end === "session" && l.from.session === "b_moss")).toBe(false);
    expect(g.links({ kind: "plugin", capabilities: [] })).toEqual({ pairs: [], links: [] });
    g.ended("agent_1");
    expect(g.links({ kind: "user" }).pairs.map((p) => p.to.session)).toEqual(["s_b"]);
    g.forget("s_b");
    expect(g.links({ kind: "user" })).toEqual({ pairs: [], links: [] });
    expect(store.raw()).toEqual({ v: 1, pairs: [], recent: [] });
  });
});
