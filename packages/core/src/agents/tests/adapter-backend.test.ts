// An agent backend whose adapter MOSS provides (backend.ts `launch.adapter`, spec §9.3 "An adapter MOSS provides"): what
// `detect` reports at each stage (never fetching, never asking), which adapter wins (MOSS's own pinned copy; the person's
// own installed one is the fallback), the person's own program the adapter drives, and what `start` runs: MOSS's Bun, with
// the flags that keep the person's folder out of its config, the person's program handed in its variable, and the whole
// copy checked against what MOSS placed.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentQuirks, AgentStartSpec } from "../../contracts/agent-backend";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeFence } from "../../contracts/fakes/fence";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import { AcpAgentBackend, ADAPTER_BUN_FLAGS } from "../backend";
import { AdapterStore } from "../adapter/store";
import type { AdapterDecl } from "../adapter/types";
import { FakeRegistry, publishAdapter } from "../testing/fake-npm";
import { writeFakeAgent } from "../testing/harness";

const FAKE_AGENT = resolve(import.meta.dir, "..", "testing", "fake-acp-agent.ts");
const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const folder = (what: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `moss-adapter-${what}-`)));
  temps.push(d);
  return d;
};
const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

const QUIRKS: AgentQuirks = {
  ...WELL_BEHAVED_QUIRKS,
  launch: {
    ...WELL_BEHAVED_QUIRKS.launch,
    identity: { versionArgs: ["--version"], versionPattern: "^(\\d+\\.\\d+\\.\\d+)\\s*$" },
    envAllow: ["PATH", "HOME", "CLAUDE_CODE_EXECUTABLE_PASSED"],
    versions: ">=0.100.0 <0.200.0",
  },
};
const USES = [{ program: "claude", env: "CLAUDE_CODE_EXECUTABLE", identity: { versionArgs: ["--version"], versionPattern: "^\\d+\\.\\d+\\.\\d+ \\(Claude Code\\)" } }];

interface World {
  home: string;
  bin: string;
  reg: FakeRegistry;
  decl: AdapterDecl;
  store: AdapterStore;
  backend: AcpAgentBackend;
}

function world(o: { claude?: string | false; ownAdapter?: string; run?: string; adapterFiles?: Record<string, string>; version?: string; command?: AcpAgentBackend["command"] extends () => infer R ? R : never } = {}): World {
  const home = folder("home");
  const bin = folder("bin");
  if (o.claude !== false) script(join(bin, "claude"), `echo '${o.claude ?? "2.1.316 (Claude Code)"}'`);
  if (o.ownAdapter !== undefined) script(join(bin, "claude-agent-acp"), `echo '${o.ownAdapter}'`);
  const reg = new FakeRegistry();
  const decl = publishAdapter(reg, { name: "@fake/claude-adapter", version: o.version ?? "0.100.0", ...(o.adapterFiles ? { files: o.adapterFiles } : {}), uses: USES, deps: [{ name: "zod", version: "4.6.7" }] });
  const store = new AdapterStore({ home, download: reg.fetch });
  const backend = new AcpAgentBackend({
    id: "claude-code", pluginId: "moss/agent-claude-code", bundled: true, name: "Claude Code", quirks: QUIRKS, clock: new FakeClock(), os: "macos",
    command: { program: "claude-agent-acp", acpArgs: [] },
    baseEnv: { PATH: bin, HOME: home },
    adapter: decl, adapters: store, runtime: () => process.execPath,
  });
  return { home, bin, reg, decl, store, backend };
}

describe("detect, with an adapter MOSS provides", () => {
  test("the person's own program isn't on this computer: not installed, and it says which program, and nothing is fetched", async () => {
    const w = world({ claude: false });
    const d = await w.backend.detect();
    expect(d.installed).toBe(false);
    expect(d.reason).toContain("claude isn't installed on this computer");
    expect(await w.backend.adapterOffer()).toBeUndefined();
    expect(w.reg.asked).toEqual([]);
  });

  test("the program is there but isn't that agent's: installed, not usable, and it says why", async () => {
    const w = world({ claude: "some other tool 1.0" });
    const d = await w.backend.detect();
    expect(d).toMatchObject({ installed: true, identityOk: false });
    expect(d.reason).toMatch(/doesn't answer --version as claude does/);
    expect(await w.backend.adapterOffer()).toBeUndefined();
  });

  test("the program is there and no adapter is: startable once downloaded; detect says so, never fetches, and the offer names it", async () => {
    const w = world();
    const d = await w.backend.detect();
    expect(d).toMatchObject({ installed: true, identityOk: false, versionOk: false });
    expect(d.reason).toContain("MOSS downloads it the first time you start Claude Code, after you say yes");
    const offer = await w.backend.adapterOffer();
    expect(offer).toMatchObject({ package: "@fake/claude-adapter", version: "0.100.0", packages: 2, uses: ["claude"] });
    expect(w.reg.asked).toEqual([]);
  });

  test("after the adapter is placed: installed at the adapter's version, its identity the integrity MOSS verified, its run file the path, the copy's digest the hash", async () => {
    const w = world();
    await w.backend.provideAdapter();
    const d = await w.backend.detect();
    expect(d).toMatchObject({ installed: true, identityOk: true, versionOk: true, version: "0.100.0", path: w.store.entryOf(w.decl) });
    expect(d.sha256).toBe(w.store.verify(w.decl).ok ? (w.store.verify(w.decl) as { digest: string }).digest : "");
    expect(d.sandboxed).toBe(false);
    expect(await w.backend.adapterOffer()).toBeUndefined();
  });

  test("a version outside the plugin's tested range reads as outside it (the outside-tested-versions card then applies)", async () => {
    const w = world({ version: "0.300.0" });
    await w.backend.provideAdapter();
    const d = await w.backend.detect();
    expect(d).toMatchObject({ installed: true, identityOk: true, versionOk: false });
    expect(d.reason).toContain("outside the tested range");
  });

  test("the person's own installed adapter: it is the fallback while MOSS's copy isn't there, MOSS's own copy wins once it is, and a refusal keeps the fallback without asking again", async () => {
    const w = world({ ownAdapter: "0.100.0" });
    // Before: the person's own adapter is what detect reports, and MOSS still offers its own (the tested one).
    const own = await w.backend.detect();
    expect(own).toMatchObject({ installed: true, identityOk: true, version: "0.100.0" });
    expect(own.path).toBe(realpathSync(join(w.bin, "claude-agent-acp")));
    expect(await w.backend.adapterOffer()).toMatchObject({ package: "@fake/claude-adapter" });
    // Refused: the person's own stays, and MOSS doesn't ask again.
    w.backend.noteAdapter({ declined: true });
    expect((await w.backend.detect()).path).toBe(realpathSync(join(w.bin, "claude-agent-acp")));
    expect(await w.backend.adapterOffer()).toBeUndefined();
    // Provided later: MOSS's own wins.
    await w.backend.provideAdapter();
    w.backend.noteAdapter({ ok: true });
    expect((await w.backend.detect()).path).toBe(w.store.entryOf(w.decl));
  });

  test("a refusal with no adapter of the person's own leaves the agent unavailable with a plain line, and the next start asks again", async () => {
    const w = world();
    w.backend.noteAdapter({ declined: true });
    const d = await w.backend.detect();
    expect(d.identityOk).toBe(false);
    expect(d.reason).toBe("Claude Code's adapter wasn't downloaded, because you said no; MOSS asks again the next time you start Claude Code");
    expect(await w.backend.adapterOffer()).toBeDefined();
    expect(w.reg.asked).toEqual([]);
  });

  test("a failed download is said plainly in detect's reason", async () => {
    const w = world();
    w.backend.noteAdapter({ failed: "registry.npmjs.org couldn't be reached" });
    expect((await w.backend.detect()).reason).toBe("Claude Code's adapter couldn't be downloaded: registry.npmjs.org couldn't be reached");
  });

  test("a copy found changed is offered again, saying why, and heals once provided", async () => {
    const w = world();
    await w.backend.provideAdapter();
    writeFileSync(w.store.entryOf(w.decl), "evil()");
    const offer = await w.backend.adapterOffer();
    expect(offer).toBeDefined();
    await w.backend.provideAdapter();
    expect(w.store.verify(w.decl).ok).toBe(true);
    expect(await w.backend.adapterOffer()).toBeUndefined();
  });

  test("a backend with no declaration is as before: no offer, and detect is the plain one", async () => {
    const home = folder("plain");
    const bin = folder("plainbin");
    script(join(bin, "claude-agent-acp"), "echo 0.100.0");
    const b = new AcpAgentBackend({ id: "claude-code", pluginId: "x", quirks: QUIRKS, clock: new FakeClock(), command: { program: "claude-agent-acp", acpArgs: [] }, baseEnv: { PATH: bin, HOME: home } });
    expect(await b.adapterOffer()).toBeUndefined();
    expect(await b.detect()).toMatchObject({ installed: true, identityOk: true, version: "0.100.0" });
  });
});

describe("start, with an adapter MOSS provides", () => {
  /** The adapter's run file: records how it was started, then is the scripted fake ACP agent. */
  const entryFor = (dump: string) => [
    `import { writeFileSync, existsSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ execArgv: process.execArgv, argv: process.argv.slice(2), claude: process.env.CLAUDE_CODE_EXECUTABLE ?? null, secret: process.env.MOSS_SECRET ?? null, dotenv: process.env.FROM_DOTENV ?? null, preload: existsSync(process.cwd() + "/preloaded.marker"), cwd: process.cwd() }));`,
    `await import(${JSON.stringify(FAKE_AGENT)});`,
  ].join("\n");

  const spec = (root: string, over: Partial<AgentStartSpec> = {}): AgentStartSpec => ({
    sessionId: "s_agent", root, fence: new FakeFence({ home: "/Users/me", mossHome: "/Users/me/.moss" }).policy(),
    bridge: { name: "moss-bridge", command: "/opt/moss/moss-core", args: ["bridge"], env: { MOSS_BRIDGE_TOKEN: "placeholder" }, tools: ["Glossary"] },
    ...over,
  });

  async function started() {
    const dump = join(folder("dump"), "dump.json");
    const w = world({ adapterFiles: { "dist/index.js": entryFor(dump) } });
    const run = writeFakeAgent(folder("agent"), { quirks: QUIRKS, script: [[{ say: "from the adapter" }]], version: "x" });
    const backend = new AcpAgentBackend({
      id: "claude-code", pluginId: "moss/agent-claude-code", bundled: true, name: "Claude Code", quirks: QUIRKS, clock: new FakeClock(), os: "macos",
      command: { program: "claude-agent-acp", acpArgs: [run.config, "acp"] },
      baseEnv: { PATH: w.bin, HOME: w.home, MOSS_SECRET: "dummy123", CLAUDE_CODE_EXECUTABLE: "/not/the/persons" },
      adapter: w.decl, adapters: w.store, runtime: () => process.execPath,
    });
    await backend.provideAdapter();
    const root = folder("project");
    // The person's own folder holds a `.env`, a `bunfig.toml` that would preload a file, and the file.
    writeFileSync(join(root, ".env"), "FROM_DOTENV=1\n");
    writeFileSync(join(root, "preload.js"), `require("node:fs").writeFileSync("preloaded.marker", "1")\n`);
    writeFileSync(join(root, "bunfig.toml"), `preload = ["./preload.js"]\n`);
    const detected = await backend.detect();
    const s = await backend.start(spec(root, { admitted: { path: detected.path!, version: detected.version!, ...(detected.sha256 === undefined ? {} : { sha256: detected.sha256 }) } }));
    return { w, backend, s, dump, root, detected };
  }

  test("runs MOSS's own Bun on the adapter's run file with the closed flags; the person's folder configures nothing; the person's own program is handed in its variable; a MOSS name never passes", async () => {
    const { s, dump, w, root } = await started();
    try {
      const end = await s.prompt({ text: "hi" });
      expect(end.text).toBe("from the adapter");
      const seen = JSON.parse(readFileSync(dump, "utf8")) as { execArgv: string[]; argv: string[]; claude: string; secret: string | null; dotenv: string | null; preload: boolean; cwd: string };
      expect(seen.execArgv).toEqual(ADAPTER_BUN_FLAGS(w.store.bunfig()));
      expect(seen.execArgv).toContain("--no-install");
      expect(seen.cwd).toBe(root);
      // The person's `claude` on the agent's PATH, resolved, not the one a daemon variable named (envAllow doesn't pass it).
      expect(seen.claude).toBe(realpathSync(join(w.bin, "claude")));
      expect(seen.secret).toBeNull();
      // Nothing of the folder it works in configured the run: no `.env`, no `bunfig.toml` preload.
      expect(seen.dotenv).toBeNull();
      expect(seen.preload).toBe(false);
    } finally {
      await s.stop();
    }
  });

  test("a file of the adapter's copy changed after the OK: start refuses it, and a swapped copy of the whole is not what the OK named", async () => {
    const { w, backend, detected, root } = await started().then(async (x) => {
      await x.s.stop();
      return x;
    });
    writeFileSync(join(w.store.dirOf(w.decl), "node_modules", "zod", "index.js"), "evil()");
    const err = await backend.start(spec(root, { admitted: { path: detected.path!, version: detected.version!, sha256: detected.sha256! } })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("its adapter changed after MOSS placed it");
  });

  test("an OK that names another copy's digest refuses: a program swapped for another one asks again", async () => {
    const { backend, detected, root, s } = await started();
    await s.stop();
    const err = await backend.start(spec(root, { admitted: { path: detected.path!, version: detected.version!, sha256: "0".repeat(64) } })).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("its program changed after it was checked");
  });

  test("the person's own program gone since: start says so and does not run the adapter", async () => {
    const { w, backend, detected, root, s } = await started();
    await s.stop();
    rmSync(join(w.bin, "claude"));
    // `detect`'s short memory of the check is the only thing that could still say yes: the program is looked for again.
    await new Promise((r) => setTimeout(r, 0));
    const fresh = new AcpAgentBackend({
      id: "claude-code", pluginId: "moss/agent-claude-code", bundled: true, quirks: QUIRKS, clock: new FakeClock(), os: "macos",
      command: { program: "claude-agent-acp", acpArgs: [] }, baseEnv: { PATH: w.bin, HOME: w.home },
      adapter: w.decl, adapters: w.store, runtime: () => process.execPath,
    });
    void backend;
    const err = await fresh.start(spec(root, { admitted: { path: detected.path!, version: detected.version! } })).catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/claude isn't installed/);
  });
});

void mkdirSync;
