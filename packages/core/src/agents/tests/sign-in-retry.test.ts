// "Try again" after an agent's sign-in error: the failed turn lets the agent's process go, and the next turn (the retry the
// host sends) asks a NEW process, which finds the person signed in. A process that had decided it was signed out is never
// the one asked again. Any ACP agent: the driver and the client are general, the stand-in agent's `signedIn` is its own login.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStartSpec } from "../../contracts/agent-backend";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeFence } from "../../contracts/fakes/fence";
import type { SessionRecord, TurnControl } from "../../contracts/session-host";
import { AgentDriver } from "../driver";
import { acpHarness, readReport } from "../testing/harness";

const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-sign-in-retry-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const spec = (): AgentStartSpec => ({
  sessionId: "s_code", root: "/Users/me/project1", fence: new FakeFence({ home: "/Users/me", mossHome: "/Users/me/.moss" }).policy(),
  bridge: { name: "moss-bridge", command: "/opt/moss/moss-core", args: ["bridge"], env: { MOSS_BRIDGE_TOKEN: "placeholder" }, tools: ["SendMessage", "Glossary"] },
});

describe("a sign-in failure, then the retry", () => {
  test("the retry starts the agent's program afresh and works once the person has signed in", async () => {
    const h = acpHarness(join(root, "agent"), { id: "fake", clock: new FakeClock(), quirks: WELL_BEHAVED_QUIRKS, signedIn: false, script: [[{ say: "OK" }]] as never });
    const driver = new AgentDriver({ start: () => h.start(spec()), promptOf: async (i) => ({ text: (i as { text?: string }).text ?? "" }), coalesceMs: 0 });
    const recorded: { type: string; [k: string]: unknown }[] = [];
    const ctl = { origin: "user", signal: new AbortController().signal, onFold: () => () => {}, record: (e: { type: string }) => recorded.push(e as never) } as unknown as TurnControl;
    const input = { from: "user", text: "hi", device: "d", sentAt: 1, clientMessageId: "m1" } as never;
    try {
      const first = await driver.turn(input, ctl);
      expect(first).toMatchObject({ reason: "failed", failure: "sign-in" });
      expect(first.text).toMatch(/sign in to it yourself/);
      const spawned = readReport(h.run.report).filter((r) => r.type === "started").length;
      expect(spawned).toBeGreaterThan(0);
      // The person signs in outside MOSS: a process started now reads the agent's own login as it is.
      const config = JSON.parse(readFileSync(h.run.config, "utf8")) as Record<string, unknown>;
      writeFileSync(h.run.config, JSON.stringify({ ...config, signedIn: true }));
      const second = await driver.turn(input, ctl);
      expect(second).toMatchObject({ reason: "end_turn", text: "OK" });
      expect(readReport(h.run.report).filter((r) => r.type === "started").length).toBe(spawned + 1);
      // The wire's notice told the person why before the retry.
      const records = recorded.map((event, seq) => ({ type: "driver", seq, sessionId: "s_code", ts: 1, event })) as SessionRecord[];
      expect(records.some((r) => JSON.stringify(r).includes("sign-in"))).toBe(true);
    } finally {
      await driver.stop();
    }
  }, 60_000);
});
