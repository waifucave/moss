// The download card and what follows it (manager.ts `#provideAdapter`, spec §9.3 "An adapter MOSS provides"): a backend
// whose adapter isn't in MOSS's home raises one sealed card before anything is fetched; the yes fetches, checks and
// starts it and a turn runs; the no fetches nothing and the agent says why; a tampered tarball and a network that is down
// are refused plainly; two sessions starting together share one card and one fetch; and the person's own installed
// adapter starts the agent when the download is refused or fails.
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import type { AgentQuirks } from "../../contracts/agent-backend";
import { AcpAgentBackend } from "../backend";
import { AdapterStore } from "../adapter/store";
import { FAKE_REGISTRY, FakeRegistry, packageTarball, publishAdapter } from "../testing/fake-npm";
import { FAKE_AGENT_PATH, fakeLaunch, writeFakeAgent } from "../testing/harness";
import { tarballUrl } from "../adapter/types";
import { agentMethods } from "../rpc";
import { fakeAdmissions, waitFor, World } from "./world";

setDefaultTimeout(60_000);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const QUIRKS: AgentQuirks = fakeLaunch({
  ...WELL_BEHAVED_QUIRKS,
  launch: { ...WELL_BEHAVED_QUIRKS.launch, envAllow: ["PATH", "HOME"] },
});
const USES = [{ program: "claude", env: "CLAUDE_CODE_EXECUTABLE", identity: { versionArgs: ["--version"], versionPattern: "^\\d+\\.\\d+\\.\\d+ \\(Claude Code\\)" } }];
const REPLY = "ADAPTER-REPLY";

interface Setup {
  w: World;
  reg: FakeRegistry;
  store: AdapterStore;
  backend: AcpAgentBackend;
  bin: string;
}

/** A world whose manager also knows `claude-code`, an adapter backend: its adapter's run file is the scripted fake agent
 *  (what a published adapter package would hold); `claude` is a stand-in program on its PATH. `own`: the person's own
 *  adapter installed too (a program that is the same scripted agent, saying "OWN"). */
function make(o: { own?: boolean; claude?: boolean } = {}): Setup {
  const reg = new FakeRegistry();
  let setup!: Setup;
  const w = new World({
    extraBackends: (wire, world) => {
      const bin = join(world.root, "bin");
      mkdirSync(bin, { recursive: true });
      if (o.claude !== false) {
        writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.316 (Claude Code)'\n");
        chmodSync(join(bin, "claude"), 0o755);
      }
      const run = writeFakeAgent(join(world.root, "adapter-agent"), { quirks: QUIRKS, script: [[{ say: REPLY }]], version: "x" });
      const entry = `await import(${JSON.stringify(FAKE_AGENT_PATH)});\n`;
      const decl = publishAdapter(reg, { name: "@fake/claude-adapter", version: "1.0.0", files: { "dist/index.js": entry }, uses: USES, deps: [{ name: "zod", version: "4.6.7" }] });
      const store = new AdapterStore({ home: world.mossHome, download: reg.fetch });
      if (o.own) {
        const ownRun = writeFakeAgent(join(world.root, "own-agent"), { quirks: QUIRKS, script: [[{ say: "OWN" }]], version: "x" });
        writeFileSync(join(bin, "claude-agent-acp"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT_PATH)} ${JSON.stringify(ownRun.config)} "$@"\n`);
        chmodSync(join(bin, "claude-agent-acp"), 0o755);
      }
      const backend = new AcpAgentBackend({
        id: "claude-code", pluginId: "moss/agent-claude-code", bundled: true, name: "Claude Code", clock: world.clock, wire,
        quirks: { ...QUIRKS, launch: { ...QUIRKS.launch, identity: { versionArgs: ["--version"], versionPattern: "^(\\d+\\.\\d+\\.\\d+)\\s*$" }, versions: ">=1.0.0 <2.0.0" } },
        command: { program: "claude-agent-acp", acpArgs: [run.config, "acp"] },
        baseEnv: { PATH: bin, HOME: world.userHome },
        // The adapter's own sandbox is admitted, so the only card is the download's.
        admissions: { "claude-code": fakeAdmissions("protected").fake },
        adapter: decl, adapters: store, runtime: () => process.execPath,
      });
      setup = { w: undefined as never, reg, store, backend, bin };
      return [backend];
    },
  });
  setup.w = w;
  world = w;
  return setup;
}

const adapterCards = (w: World) => w.approvals.cards().filter((c) => c.kind === "change" && (c as { change?: string }).change === "agent-adapter");
const notification = (w: World) => w.parentInputs("task-notification")[0]?.input as { text: string } | undefined;
async function answer(w: World, card: ReturnType<World["approvals"]["cards"]>[number], kind: "approve" | "deny") {
  const option = card.options.find((o) => o.kind === kind)!;
  const frame = w.approvals.frameChannel(card.id)!;
  return w.approvals.answer(card.id, { optionId: option.id, hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: w.clock.now() } }, { role: "app" });
}

describe("the download card", () => {
  test("raises one sealed card naming the package, the version, where from, its size and what it is; nothing is fetched until the yes; then it is fetched, started, and a turn runs", async () => {
    const s = make();
    await s.w.delegate("Fix the tests.", { backend: "claude-code" });
    const card = await waitFor(() => adapterCards(s.w)[0], "the download card");
    expect(card).toMatchObject({ kind: "change", change: "agent-adapter" });
    expect(card.fields["title"]).toEqual({ type: "text", text: "Download Claude Code's adapter?" });
    const what = (card.fields["what"] as { text: string }).text;
    expect(what).toContain("@fake/claude-adapter 1.0.0 from npm");
    expect(what).toContain("code from npm that MOSS will run");
    expect(what).toContain("Nothing is downloaded unless you say yes");
    const rows = Object.fromEntries([...(card.fields["source"] as { rows: { label: string; value: string }[] }).rows, ...(card.fields["detail"] as { rows: { label: string; value: string }[] }).rows].map((r) => [r.label, r.value]));
    expect(rows["Package"]).toBe("@fake/claude-adapter 1.0.0");
    expect(rows["Downloaded from"]).toBe(FAKE_REGISTRY);
    expect(rows["Size"]).toMatch(/under 1 MB, 2 packages/);
    expect(rows["Kept in"]).toBe(join(s.w.mossHome, "run", "agent-adapters", "@fake__claude-adapter", "1.0.0"));
    expect(rows["Runs on"]).toBe("MOSS's own runtime, never your own node");
    expect(rows["Drives, from your computer"]).toBe("claude");
    // Nothing is fetched while the card waits, and an answer that isn't the app's sealed card (a bot's) is no yes.
    await new Promise((r) => setTimeout(r, 300));
    expect(s.reg.asked).toEqual([]);
    expect(await s.w.approvals.answer(card.id, { optionId: card.options.find((o) => o.kind === "approve")!.id, hash: card.hash, proof: { via: "sealed-frame", frame: "forged", input: "click", at: s.w.clock.now() } }, { role: "bot" as never })).toBe("bad-origin");
    expect(s.reg.asked).toEqual([]);
    // The yes.
    expect(await answer(s.w, card, "approve")).toBe("accepted");
    const n = await waitFor(() => notification(s.w), "the turn's end");
    expect(n.text).toBe(REPLY);
    expect(s.reg.asked.sort()).toEqual([tarballUrl(FAKE_REGISTRY, "@fake/claude-adapter", "1.0.0"), tarballUrl(FAKE_REGISTRY, "zod", "4.6.7")]);
    expect(await s.backend.adapterOffer()).toBeUndefined(); // in place now: no second card
  });

  test("the no: nothing is fetched, the agent doesn't start, and the notice says why in a plain line", async () => {
    const s = make();
    await s.w.delegate("Fix the tests.", { backend: "claude-code" });
    const card = await waitFor(() => adapterCards(s.w)[0], "the download card");
    expect(await answer(s.w, card, "deny")).toBe("accepted");
    const n = await waitFor(() => notification(s.w), "the notice");
    expect(n.text).toContain("Claude Code's adapter wasn't downloaded, because you said no");
    expect(s.reg.asked).toEqual([]);
    expect(s.w.report("started")).toEqual([]);
  });

  test("a tampered tarball is refused after the yes: the notice names the fingerprint, nothing is kept, the agent doesn't start", async () => {
    const s = make();
    s.reg.files.set(tarballUrl(FAKE_REGISTRY, "zod", "4.6.7"), packageTarball("zod", "4.6.7", { "index.js": "steal()\n" }));
    await s.w.delegate("Fix the tests.", { backend: "claude-code" });
    await answer(s.w, await waitFor(() => adapterCards(s.w)[0], "the download card"), "approve");
    const n = await waitFor(() => notification(s.w), "the notice");
    expect(n.text).toContain("zod 4.6.7's download doesn't match the fingerprint MOSS expects for it");
    expect(n.text).toContain("nothing was kept");
    expect(s.w.report("started")).toEqual([]);
    expect(await s.backend.adapterOffer()).toBeDefined(); // nothing kept: it would be asked again
  });

  test("offline after the yes: the notice says it couldn't be downloaded, and nothing is kept", async () => {
    const s = make();
    s.reg.failing.add("*");
    await s.w.delegate("Fix the tests.", { backend: "claude-code" });
    await answer(s.w, await waitFor(() => adapterCards(s.w)[0], "the download card"), "approve");
    const n = await waitFor(() => notification(s.w), "the notice");
    expect(n.text).toContain("Claude Code's adapter couldn't be downloaded");
    expect(n.text).toContain("the network is down");
    expect(s.w.report("started")).toEqual([]);
  });

  test("two sessions starting together share one card and one fetch, and both start", async () => {
    const s = make();
    await Promise.all([s.w.delegate("one", { backend: "claude-code" }), s.w.delegate("two", { backend: "claude-code" })]);
    const card = await waitFor(() => adapterCards(s.w)[0], "the download card");
    await new Promise((r) => setTimeout(r, 300));
    expect(adapterCards(s.w).length).toBe(1);
    await answer(s.w, card, "approve");
    await waitFor(() => s.w.parentInputs("task-notification").length >= 2 || undefined, "both turns' ends");
    expect(s.reg.asked.length).toBe(2); // the adapter and zod, once each
    expect(s.w.parentInputs("task-notification").map((i) => (i.input as { text: string }).text)).toEqual([REPLY, REPLY]);
  });

  test("with no card at all once the adapter is in place: the next start goes straight through", async () => {
    const s = make();
    await s.backend.provideAdapter();
    await s.w.delegate("Fix the tests.", { backend: "claude-code" });
    const n = await waitFor(() => notification(s.w), "the turn's end");
    expect(n.text).toBe(REPLY);
    expect(adapterCards(s.w)).toEqual([]);
  });

  test("no `claude` on this computer: no card, no fetch, the notice says which program is missing", async () => {
    const s = make({ claude: false });
    await s.w.delegate("Fix the tests.", { backend: "claude-code" }).catch(() => undefined);
    const n = await waitFor(() => notification(s.w), "the notice");
    expect(n.text).toContain("claude isn't installed on this computer");
    expect(adapterCards(s.w)).toEqual([]);
    expect(s.reg.asked).toEqual([]);
  });
});

describe("the person's own installed adapter", () => {
  test("refusing the download starts the agent on their own adapter, and the card is not raised again in this run", async () => {
    const s = make({ own: true });
    await s.w.delegate("one", { backend: "claude-code" });
    await answer(s.w, await waitFor(() => adapterCards(s.w)[0], "the download card"), "deny");
    const n = await waitFor(() => notification(s.w), "the turn's end");
    expect(n.text).toBe("OWN");
    expect(s.reg.asked).toEqual([]);
    await s.w.delegate("two", { backend: "claude-code" });
    await waitFor(() => s.w.parentInputs("task-notification").length >= 2 || undefined, "the second turn's end");
    expect(adapterCards(s.w)).toEqual([]);
    expect(s.w.parentInputs("task-notification").map((i) => (i.input as { text: string }).text)).toEqual(["OWN", "OWN"]);
  });

  test("a download that fails starts it on their own adapter too", async () => {
    const s = make({ own: true });
    s.reg.failing.add("*");
    await s.w.delegate("one", { backend: "claude-code" });
    await answer(s.w, await waitFor(() => adapterCards(s.w)[0], "the download card"), "approve");
    expect((await waitFor(() => notification(s.w), "the turn's end")).text).toBe("OWN");
  });

  test("when both exist MOSS's own pinned copy wins (it is the tested one)", async () => {
    const s = make({ own: true });
    await s.w.delegate("one", { backend: "claude-code" });
    await answer(s.w, await waitFor(() => adapterCards(s.w)[0], "the download card"), "approve");
    expect((await waitFor(() => notification(s.w), "the turn's end")).text).toBe(REPLY);
  });
});


describe("agent.backends", () => {
  test("every backend is looked at at once, one that fails to be looked at is listed not installed, and the names stay what the plugins give", async () => {
    const s = make();
    const slow = s.backend.detect.bind(s.backend);
    let running = 0;
    let most = 0;
    const watch = (b: { detect: () => Promise<unknown> }, fn: () => Promise<unknown>) => (b.detect = async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 30));
      try {
        return await fn();
      } finally {
        running--;
      }
    });
    watch(s.backend, slow);
    watch(s.w.backend, async () => { throw new Error("it can't be looked at"); });
    const methods = agentMethods({ manager: s.w.manager, backends: () => [s.w.backend, s.backend], computer: "Studio", localDevice: () => "a".repeat(32) });
    const r = await methods["agent.backends"]!({}, { caller: { kind: "user" } as never }) as { backends: { id: string; name: string; computers: { installed: boolean }[] }[] };
    expect(most).toBe(2);
    expect(r.backends.map((b) => [b.id, b.name, b.computers[0]!.installed])).toEqual([["fake", "fake", false], ["claude-code", "Claude Code", true]]);
  });
});
