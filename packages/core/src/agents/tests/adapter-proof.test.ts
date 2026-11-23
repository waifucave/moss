// The adapter proof's own logic (agents/testing/adapter-proof.ts), offline: a fake registry holds an adapter whose run file
// starts the scripted fake ACP agent, so the fetch, the detect, the start on a Bun with the closed flags and the wire reading
// all run, and the failures the proof exists to catch (a module the closure lacks, a run file that crashes at import, an
// initialize that never comes) fail it with the adapter's stderr tail.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import type { AgentQuirks } from "../../contracts/agent-backend";
import { AdapterProofError, proveAdapter } from "../testing/adapter-proof";
import { FakeRegistry, publishAdapter } from "../testing/fake-npm";
import { FAKE_AGENT_PATH, fakeLaunch, writeFakeAgent } from "../testing/harness";

setDefaultTimeout(60_000);
const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const folder = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "moss-proof-"))); temps.push(d); return d; };

const QUIRKS: AgentQuirks = {
  ...fakeLaunch(WELL_BEHAVED_QUIRKS),
  launch: { ...fakeLaunch(WELL_BEHAVED_QUIRKS).launch, identity: { versionArgs: ["--version"], versionPattern: "^(\\d+\\.\\d+\\.\\d+)$" }, envAllow: ["PATH", "HOME"], versions: ">=1.0.0 <2.0.0" },
};

function input(entry: string, extra: { deps?: { name: string; version: string }[]; uses?: boolean } = {}) {
  const reg = new FakeRegistry();
  const work = folder();
  const run = writeFakeAgent(join(work, "agent"), { quirks: QUIRKS, script: [[{ say: "ok" }]], version: "x" });
  const adapter = publishAdapter(reg, { name: "@fake/adapter", version: "1.0.0", files: { "dist/index.js": entry }, ...(extra.deps ? { deps: extra.deps } : {}), ...(extra.uses ? { uses: [{ program: "stand", env: "STAND_PATH", identity: { versionArgs: ["--version"], versionPattern: "^stand \\d" } }] } : {}) });
  return { reg, run, i: { id: "fakeadapter", quirks: QUIRKS, adapter, home: join(work, "moss"), work: join(work, "w"), runtime: process.execPath, download: reg.fetch, command: { program: "fakeadapter", acpArgs: [run.config, "acp"] }, standIns: { stand: "stand 1" }, startMs: 20_000 } };
}

describe("proveAdapter", () => {
  test("an adapter that loads and speaks ACP: fetched, detected, started with the closed flags, initialize answered; the stand-in is reached when the adapter runs the program", async () => {
    const { i, reg } = input(`await import(${JSON.stringify(FAKE_AGENT_PATH)});\n`, { uses: true });
    const p = await proveAdapter(i);
    expect(p).toMatchObject({ version: "1.0.0", packages: 1, session: { ok: true } });
    expect(p.initialize.protocolVersion).toBeGreaterThan(0);
    expect(reg.asked.length).toBe(1);
    // The person's program was identity-checked; the fake agent never runs it.
    expect(p.standIns["stand"]).toMatchObject({ runs: [], methods: [] });
    expect(p.standIns["stand"]!.versionChecks).toBeGreaterThan(0);
  });

  test("a module the adapter's closure lacks fails under --no-install, with the stderr tail, and nothing is downloaded at run time", async () => {
    const { i } = input(`import "left-pad-that-is-not-locked";\nawait import(${JSON.stringify(FAKE_AGENT_PATH)});\n`);
    const err = await proveAdapter(i).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(AdapterProofError);
    expect((err as Error).message).toContain("didn't load");
    expect((err as Error).message).toMatch(/left-pad-that-is-not-locked/);
  });

  test("a run file that crashes at import fails with its stderr", async () => {
    const { i } = input(`throw new Error("boom at import");\n`);
    const err = await proveAdapter(i).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(AdapterProofError);
    expect((err as Error).message).toContain("boom at import");
  });

  test("an adapter that starts and says nothing fails as hung or unanswered, not as a pass", async () => {
    const { i } = input(`setInterval(() => {}, 1000);\n`);
    const err = await proveAdapter({ ...i, startMs: 3_000 }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(AdapterProofError);
    expect((err as Error).message).toMatch(/initialize|neither answered/);
  });

  test("a declared program with no stand-in line is refused by the proof itself", async () => {
    const { i } = input(`await import(${JSON.stringify(FAKE_AGENT_PATH)});\n`, { uses: true });
    const err = await proveAdapter({ ...i, standIns: {} }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("the proof has no stand-in version line for it");
  });
  test("a JSON-RPC stand-in answers the adapter's requests with an empty result and records the method names it was asked", async () => {
    const entry = [
      `import { spawn } from "node:child_process";`,
      `const p = spawn(process.env.STAND_PATH, ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });`,
      `p.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\\n");`,
      `const answer = await new Promise((r) => p.stdout.once("data", (d) => r(String(d))));`,
      `if (!answer.includes('"id":1') || !answer.includes("stand-in")) throw new Error("the stand-in answered " + answer);`,
      `p.kill();`,
      `await import(${JSON.stringify(FAKE_AGENT_PATH)});`,
      "",
    ].join("\n");
    const { i } = input(entry, { uses: true });
    const p = await proveAdapter({ ...i, standIns: { stand: { version: "stand 1", jsonRpc: true } } });
    expect(p.session).toEqual({ ok: true });
    expect(p.standIns["stand"]).toMatchObject({ runs: [1], methods: ["initialize"] });
  });
});
