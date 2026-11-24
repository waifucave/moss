// A failed source call says which contract failure it was in the engine's log (the owner's log only said
// `{"error":"ContractError"}`): its code and message, never anything a reader of numbers could hold.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ContractError } from "../../src/contracts/common";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService, failureFacts } from "../../src/usage/service";
import type { UsageSourceEntry, UsageSourcePort } from "../../src/usage/sources";
import { tempDir } from "./fixtures";

const entry: UsageSourceEntry = { pluginId: "moss/usage-codex", id: "codex", name: "Codex", handler: "source", provides: ["plan", "usage"] };

function serviceFailing(err: unknown) {
  const logs: string[] = [];
  const port: UsageSourcePort = { entries: () => [entry], call: () => Promise.reject(err) };
  const db = new UsageDb(join(tempDir("home"), "usage", "usage.db"));
  const svc = new UsageService({
    db, pricer: new UsagePricer(), tracking: () => ({ codex: true }), sources: port, planWaitMs: 5_000, ingestEveryMs: 0,
    log: { warn: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`), info: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`) },
  });
  return { svc, logs };
}

describe("a failed usage source call names its failure", () => {
  test("failureFacts: a contract failure gives code and message on one line, cut; another error its name and string code", () => {
    expect(failureFacts(new ContractError("timeout", "moss/usage-codex.source ran past 90000 ms"))).toEqual({ error: "ContractError", code: "timeout", message: "moss/usage-codex.source ran past 90000 ms" });
    const long = failureFacts(new ContractError("failed", `the plugin crashed:\n${"x".repeat(1000)}`));
    expect(long.message!.length).toBe(300);
    expect(long.message).not.toContain("\n");
    expect(failureFacts(Object.assign(new Error("secret-ish text"), { code: "SQLITE_BUSY" }))).toEqual({ error: "Error", code: "SQLITE_BUSY" });
    expect(failureFacts("boom")).toEqual({ error: "error" });
  });

  test("the plan line and the ingest line carry the code and the message", async () => {
    const { svc, logs } = serviceFailing(new ContractError("plugin_stopped", "plugin stopped: crashed 3 times in 10 minutes: the worker crashed"));
    await svc.sourcePlan("codex");
    await svc.ingest(true);
    const plan = logs.find((l) => l.includes("plan call failed"))!;
    expect(plan).toContain('"code":"plugin_stopped"');
    expect(plan).toContain("crashed 3 times in 10 minutes");
    const ingest = logs.find((l) => l.startsWith("[usage] ingest failed"))!;
    expect(ingest).toContain('"source":"codex"');
    expect(ingest).toContain('"code":"plugin_stopped"');
  });
});
