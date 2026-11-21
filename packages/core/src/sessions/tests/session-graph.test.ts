// The engine's session graph (sessions/session-graph.ts) against the SessionGraph conformance suite, plus generated
// sequences for its two folds: the waiting counts and the subagent rows (lane-common: code that turns a sequence of
// events into a state gets a property test of its invariant).
import { describe, expect, test } from "bun:test";
import { SUBAGENTS_MAX, type SessionStarter, type SessionSubagent } from "@waifucave/moss-protocol";
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
