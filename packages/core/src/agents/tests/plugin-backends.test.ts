// Every agent backend is a plugin's entry (spec §5.3 `agentBackends`): the bundled `moss/agent-<id>` plugins load in
// lane B's real registry, each entry's quirks file reads into a backend's row, a third-party plugin adds one the same
// way after its OK, a quirks file that leaves the plugin's folder or doesn't hold quirks is left out, and only MOSS's
// own plugin for an id gets what the core grants by id.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, catalogPointDecl } from "@waifucave/moss-plugin-sdk";
import { RegistryCore } from "../../registry/core";
import { PluginFolders } from "../../registry/folders";
import { fileRegistryStore } from "../../registry/state";
import type { Contribution, PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import { ContributedBackendCache, RESERVED_BACKEND_IDS, contributedBackends, looksLikeSecret, readAdapter, readQuirksFile } from "../plugin-backends";
import { BUNDLED_PLUGINS_DIR, bundledBackends } from "../testing/bundled-backends";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world() {
  const home = mkdtempSync(join(tmpdir(), "moss-k-plugins-"));
  temps.push(home);
  const pluginsDir = join(home, "plugins");
  const bundledDir = join(home, "app", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  // The bundled `moss` tree, with only its agent backends' children.
  const moss = join(bundledDir, "moss");
  mkdirSync(join(moss, "plugins"), { recursive: true });
  cpSync(join(BUNDLED_PLUGINS_DIR, "..", "moss.json"), join(moss, "moss.json"));
  for (const name of readdirSync(BUNDLED_PLUGINS_DIR).filter((n) => n.startsWith("agent-"))) cpSync(join(BUNDLED_PLUGINS_DIR, name), join(moss, "plugins", name), { recursive: true });
  const store = fileRegistryStore(join(home, "plugins-state"));
  let folders: PluginFolders;
  const core = new RegistryCore({ catalog: catalogPointDecl, store, onOk: (id, hash) => folders.okGiven(id, hash) });
  folders = new PluginFolders({ core, store, pluginsDir, bundledDirs: [bundledDir], settleMs: 0 });
  return { home, pluginsDir, core, folders };
}

const QUIRKS_OF = (id: string) => bundledBackends()[id]!.file;

describe("agent backends from plugins", () => {
  test("the bundled agent-<id> plugins validate, run, and give every backend's row as its quirks file holds it", async () => {
    const w = world();
    await w.folders.scan();
    const rows = bundledBackends();
    for (const r of Object.values(rows)) {
      const record = w.core.get(r.pluginId)!;
      expect([r.pluginId, record.state, record.issues.filter((i) => i.severity === "error")]).toEqual([r.pluginId, "running", []]);
    }
    const lines: string[] = [];
    const got = contributedBackends(w.core, (l) => lines.push(l));
    expect(lines).toEqual([]);
    expect(got.map((c) => c.id).sort()).toEqual(Object.keys(rows).sort());
    for (const c of got) {
      expect(c).toMatchObject({ pluginId: `moss/agent-${c.id}`, bundled: true, name: rows[c.id]!.name });
      expect(c.file).toEqual(rows[c.id]!.file);
      // The program is the manifest entry's, on every OS (what the OK covers); the file holds no command.
      expect(c.quirks.launch.command).toEqual({ macos: [c.command.program, ...c.command.acpArgs], linux: [c.command.program, ...c.command.acpArgs], windows: [c.command.program, ...c.command.acpArgs] });
      expect("command" in c.file.quirks.launch).toBe(false);
    }
    expect(got.find((c) => c.id === "cursor")!.file.readOnlyMode).toEqual({ option: "mode", values: ["ask", "plan"] });
    expect(got.find((c) => c.id === "devin-cloud")!.file.quirks.placement).toBe("cloud");
  });

  test("a third-party plugin adds an ACP backend the same way, after its OK; it isn't MOSS's own", async () => {
    const w = world();
    const folder = join(w.pluginsDir, "my-agent");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "moss.json"), JSON.stringify({
      manifest: 1, id: "my-agent", name: "My agent", version: "1.0.0", engines: { moss: `^${PLUGIN_API_VERSION}` },
      contributes: { agentBackends: [{ id: "my-agent", name: "My agent", protocol: "acp", command: "my-agent", args: ["acp"], quirks: "rows/quirks.json" }] },
    }));
    mkdirSync(join(folder, "rows"));
    writeFileSync(join(folder, "rows", "quirks.json"), JSON.stringify({ ...QUIRKS_OF("grok"), source: "its own" }));
    await w.folders.scan();
    // Found: it waits for the user's OK, and nothing of it is offered.
    expect(contributedBackends(w.core).some((c) => c.id === "my-agent")).toBe(false);
    expect(await w.core.approve("my-agent", w.core.get("my-agent")!.treeHash!)).toBe("approved");
    const mine = contributedBackends(w.core).find((c) => c.id === "my-agent")!;
    expect(mine).toMatchObject({ pluginId: "my-agent", bundled: false, command: { program: "my-agent", acpArgs: ["acp"] }, file: { source: "its own" } });
  });

  test("a model list declared by another plugin is dropped whole with one log line, whatever it names; only the bundled codex declares its own", async () => {
    const w = world();
    const reader = { list: "models", id: "slug" };
    const command = (program: string) => ({ program, args: ["models"], identity: { versionArgs: ["--version"], versionPattern: "." } });
    const make = (id: string, modelList: unknown) => {
      const folder = join(w.pluginsDir, id);
      mkdirSync(join(folder, "rows"), { recursive: true });
      writeFileSync(join(folder, "moss.json"), JSON.stringify({
        manifest: 1, id, name: id, version: "1.0.0", engines: { moss: `^${PLUGIN_API_VERSION}` },
        contributes: { agentBackends: [{ id, name: id, protocol: "acp", command: "own-program", args: ["acp"], quirks: "rows/quirks.json" }] },
      }));
      writeFileSync(join(folder, "rows", "quirks.json"), JSON.stringify({ ...QUIRKS_OF("grok"), modelList }));
    };
    make("same-program", { command: command("own-program"), file: { home: ".x", path: "m.json" }, reader });
    make("other-program", { command: command("/bin/sh"), reader });
    make("file-only", { file: { home: ".x", path: "m.json" }, reader });
    await w.folders.scan();
    for (const id of ["same-program", "other-program", "file-only"]) await w.core.approve(id, w.core.get(id)!.treeHash!);
    const lines: string[] = [];
    const got = contributedBackends(w.core, (l) => lines.push(l));
    for (const id of ["same-program", "other-program", "file-only"]) expect(got.find((c) => c.id === id)!.modelList).toBeUndefined();
    expect(lines.filter((l) => /declares a model list/.test(l)).length).toBe(3);
    expect(got.find((c) => c.id === "codex")!.modelList?.command?.program).toBe("codex");
  });

  test("a quirks file outside the plugin, through a link, or that isn't a backend's quirks is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "moss-k-quirks-"));
    temps.push(root);
    const folder = join(root, "p");
    mkdirSync(folder);
    writeFileSync(join(root, "outside.json"), JSON.stringify(QUIRKS_OF("grok")));
    expect(() => readQuirksFile(folder, "../outside.json")).toThrow(/inside the plugin/);
    expect(() => readQuirksFile(folder, join(root, "outside.json"))).toThrow(/inside the plugin/);
    require("node:fs").symlinkSync(join(root, "outside.json"), join(folder, "q.json"));
    expect(() => readQuirksFile(folder, "q.json")).toThrow(/leads out of the plugin/);
    const bad = { ...QUIRKS_OF("grok"), quirks: { ...QUIRKS_OF("grok").quirks, launch: { ...QUIRKS_OF("grok").quirks.launch, identity: { versionArgs: [], versionPattern: "", signer: "not-a-team" } } } };
    writeFileSync(join(folder, "bad.json"), JSON.stringify(bad));
    expect(() => readQuirksFile(folder, "bad.json")).toThrow(/doesn't hold a backend's quirks/);
    writeFileSync(join(folder, "extra.json"), JSON.stringify({ ...QUIRKS_OF("grok"), quirks: { ...QUIRKS_OF("grok").quirks, sneaky: true } }));
    expect(() => readQuirksFile(folder, "extra.json")).toThrow(/doesn't hold a backend's quirks/);
  });

  test("no plugin takes a core id or a bundled one's; among other plugins the first claim wins; each refusal is logged", () => {
    const root = mkdtempSync(join(tmpdir(), "moss-k-ids-"));
    temps.push(root);
    const folder = join(root, "p");
    mkdirSync(folder);
    writeFileSync(join(folder, "quirks.json"), JSON.stringify(QUIRKS_OF("cursor")));
    const rec = (by: string, hash: string) => ({ folder, treeHash: hash.repeat(64), provenance: { by, at: 1 } as PluginRecord["provenance"] });
    const records: Record<string, Partial<PluginRecord>> = {
      "someone/agents": rec("found", "a"), "moss/agent-cursor": rec("bundled", "b"), "first/agents": rec("found", "c"), "second/agents": rec("found", "d"),
    };
    const entry = (pluginId: string, id: string, n: number): Contribution => ({
      point: "agentBackends", pluginId, ref: `agentBackends/${n}`, entryId: id, state: "active",
      value: { id, name: `${pluginId}'s ${id}`, protocol: "acp", command: "/opt/evil/bin/agent", args: ["acp"], quirks: "quirks.json" },
    });
    // The reviewer's probe: a third party contributes `cursor` and `moss-code`, listed before MOSS's own.
    const entries: Contribution[] = [
      entry("someone/agents", "cursor", 0), entry("someone/agents", "moss-code", 1), entry("someone/agents", "moss", 2),
      { ...entry("moss/agent-cursor", "cursor", 0), value: { id: "cursor", name: "Cursor", protocol: "acp", command: "cursor-agent", args: ["acp"], quirks: "quirks.json" } },
      entry("first/agents", "thing", 0), entry("second/agents", "thing", 0),
    ];
    const registry = { entries: () => entries, get: (id: string) => records[id] as PluginRecord | undefined } as unknown as Pick<PluginRegistry, "entries" | "get">;
    const lines: string[] = [];
    const got = contributedBackends(registry, (l) => lines.push(l));
    expect(got.map((c) => [c.id, c.pluginId])).toEqual([["cursor", "moss/agent-cursor"], ["thing", "first/agents"]]);
    expect([...RESERVED_BACKEND_IDS].every((id) => !got.some((c) => c.id === id))).toBe(true);
    expect(lines.filter((l) => l.includes("someone/agents"))).toHaveLength(3);
    expect(lines.join("\n")).toContain("second/agents's backend thing isn't offered: first/agents claimed that id first");
    // As the manager finds a backend: the core's own `moss-code` comes after the plugins' and is the only one.
    const core = { id: "moss-code", core: true };
    const offered = [...got.map((c) => ({ id: c.id, pluginId: c.pluginId })), core];
    expect(offered.find((b) => b.id === "moss-code")).toBe(core);
    expect(offered.find((b) => b.id === "cursor")).toMatchObject({ pluginId: "moss/agent-cursor" });
    // The cache builds each kept entry once, and a refused duplicate never rebuilds it.
    let built = 0;
    const cache = new ContributedBackendCache((c) => ({ id: c.id, pluginId: c.pluginId, n: ++built }) as never);
    const first = cache.backends(registry);
    const again = cache.backends(registry);
    expect(again[0]).toBe(first[0]);
    expect(again[1]).toBe(first[1]);
    expect(built).toBe(2);
  });

  test("another plugin's backend counts as acting without asking, and may not ask for a secret-looking name", () => {
    // The reviewer's misses, and the rest of the table.
    const secret = [
      "OPENAI_API_KEY", "GH_TOKEN", "MY_SECRET_X", "db_password", "AWS_CREDENTIALS", "x_secret",
      "AWS_ACCESS_KEY_ID", "OPENAI_APIKEY", "GH_PAT", "SENTRY_DSN", "NPM_AUTH", "PRIVATE_KEY_PATH", "MY_PASS", "MYSQL_PASSWD", "AWS_SECRETS", "ANTHROPIC_KEYS",
      "DATABASE_URL", "DB_URL", "REDIS_URL", "MONGODB_URL", "POSTGRES_URL", "MYSQL_URL", "DATABASE_READ_URL",
      "SSH_AUTH_SOCK", "GPG_AGENT_INFO", "ssh_auth_sock",
      // The second review's misses.
      "OPENAI-API-KEY", "OPENAI.API.KEY", "openaiApiKey", "githubToken", "dbPassword", "GITHUBTOKEN", "OPENAIAPIKEY", "MYSECRET", "PGPASSWORD", "MYSQL_PWD",
      "SLACK_WEBHOOK_URL", "TOKENIZERS_PARALLELISM", "awsPrivateKey",
      // The third review's words.
      "GPG_PASSPHRASE", "SESSION_COOKIE", "authCookie", "BEARER", "API_BEARER", "DB_CONNECTIONSTRING", "AzureConnectionString", "SLACK_WEBHOOK", "discordWebhook",
    ];
    for (const n of secret) expect([n, looksLikeSecret(n)]).toEqual([n, true]);
    const ordinary = ["PATH", "HOME", "LANG", "KEYBOARD", "PATHEXT", "AUTHOR", "PASSENGER", "PWD", "OLDPWD", "XDG_DATA_HOME", "TERM", "USER", "HOMEPAGE_URL", "API_URL", "NODE_ENV", "SHELL", "TMPDIR"];
    for (const n of ordinary) expect([n, looksLikeSecret(n)]).toEqual([n, false]);
    const root = mkdtempSync(join(tmpdir(), "moss-k-marks-"));
    temps.push(root);
    const plain = join(root, "plain");
    const greedy = join(root, "greedy");
    mkdirSync(plain);
    mkdirSync(greedy);
    const grok = QUIRKS_OF("grok");
    writeFileSync(join(plain, "quirks.json"), JSON.stringify({ ...grok, quirks: { ...grok.quirks, marks: [] } }));
    writeFileSync(join(greedy, "quirks.json"), JSON.stringify({ ...grok, quirks: { ...grok.quirks, launch: { ...grok.quirks.launch, envAllow: ["PATH", "OPENAI_API_KEY"] } } }));
    const records: Record<string, Partial<PluginRecord>> = {
      "someone/plain": { folder: plain, treeHash: "a".repeat(64), provenance: { by: "found", at: 1 } as PluginRecord["provenance"] },
      "someone/greedy": { folder: greedy, treeHash: "b".repeat(64), provenance: { by: "found", at: 1 } as PluginRecord["provenance"] },
      "moss/agent-devin": { folder: join(BUNDLED_PLUGINS_DIR, "agent-devin"), treeHash: "c".repeat(64), provenance: { by: "bundled", at: 1 } as PluginRecord["provenance"] },
    };
    const entries: Contribution[] = [
      { point: "agentBackends", pluginId: "someone/plain", ref: "agentBackends/0", entryId: "plain", state: "active", value: { id: "plain", name: "Plain", protocol: "acp", command: "plain", quirks: "quirks.json" } },
      { point: "agentBackends", pluginId: "someone/greedy", ref: "agentBackends/0", entryId: "greedy", state: "active", value: { id: "greedy", name: "Greedy", protocol: "acp", command: "greedy", quirks: "quirks.json" } },
      { point: "agentBackends", pluginId: "moss/agent-devin", ref: "agentBackends/0", entryId: "devin", state: "active", value: { id: "devin", name: "Devin", protocol: "acp", command: "devin", args: ["acp"], quirks: "quirks.json" } },
    ];
    const registry = { entries: () => entries, get: (id: string) => records[id] as PluginRecord | undefined } as unknown as Pick<PluginRegistry, "entries" | "get">;
    const lines: string[] = [];
    const got = contributedBackends(registry, (l) => lines.push(l));
    // Its file says it asks before acting; it is taken as one that doesn't (read-only then needs a read-only mode).
    expect(got.find((c) => c.id === "plain")!.quirks.marks).toContain("unasked-actions");
    expect(got.find((c) => c.id === "plain")!.file.quirks.marks).toEqual([]);
    // A secret-looking name from the daemon's environment: refused, and said why.
    expect(got.some((c) => c.id === "greedy")).toBe(false);
    expect(lines.join("\n")).toContain("OPENAI_API_KEY");
    // Another plugin's backend is listed with its plugin's id beside its name.
    expect(got.find((c) => c.id === "plain")!.name).toBe("Plain (someone/plain)");
    // MOSS's own Devin row keeps its measured marks and the login it needs.
    const devin = got.find((c) => c.id === "devin")!;
    expect(devin.bundled).toBe(true);
    expect(devin.quirks.launch.envAllow).toContain("WINDSURF_API_KEY");
    expect(devin.quirks.marks).toEqual(devin.file.quirks.marks);
  });

  test("a backend from another plugin may not be named MOSS", () => {
    const root = mkdtempSync(join(tmpdir(), "moss-k-name-"));
    temps.push(root);
    writeFileSync(join(root, "quirks.json"), JSON.stringify(QUIRKS_OF("grok")));
    const records: Record<string, Partial<PluginRecord>> = { "someone/agents": { folder: root, treeHash: "a".repeat(64), provenance: { by: "found", at: 1 } as PluginRecord["provenance"] } };
    const entries: Contribution[] = ["MOSS", "moss pro", " MossCode", "My agent"].map((name, n) => ({
      point: "agentBackends", pluginId: "someone/agents", ref: `agentBackends/${n}`, entryId: `a${n}`, state: "active",
      value: { id: `a${n}`, name, protocol: "acp", command: "agent", quirks: "quirks.json" },
    }));
    const registry = { entries: () => entries, get: (id: string) => records[id] as PluginRecord | undefined } as unknown as Pick<PluginRegistry, "entries" | "get">;
    const lines: string[] = [];
    expect(contributedBackends(registry, (l) => lines.push(l)).map((c) => c.name)).toEqual(["My agent (someone/agents)"]);
    expect(lines.filter((l) => l.includes("named MOSS"))).toHaveLength(3);
  });

  test("only MOSS's own plugin for an id is bundled; a broken entry is left out with its reason; a backend is built once per tree", () => {
    const root = mkdtempSync(join(tmpdir(), "moss-k-reg-"));
    temps.push(root);
    const good = join(root, "good");
    mkdirSync(good);
    writeFileSync(join(good, "quirks.json"), JSON.stringify(QUIRKS_OF("cursor")));
    const records: Record<string, Partial<PluginRecord>> = {
      "someone/agents": { folder: good, treeHash: "a".repeat(64), provenance: { by: "found", at: 1 } as PluginRecord["provenance"] },
      "moss/agent-cursor": { folder: good, treeHash: "b".repeat(64), provenance: { by: "found", at: 1 } as PluginRecord["provenance"] },
    };
    let entries: Contribution[] = [
      { point: "agentBackends", pluginId: "someone/agents", ref: "agentBackends/0", entryId: "cursor", state: "active", value: { id: "cursor", name: "Not Cursor", protocol: "acp", command: "cursor-agent", args: ["acp"], quirks: "quirks.json" } },
      { point: "agentBackends", pluginId: "someone/agents", ref: "agentBackends/1", entryId: "nope", state: "active", value: { id: "nope", name: "Nope", protocol: "acp", command: "nope", quirks: "missing.json" } },
      { point: "agentBackends", pluginId: "someone/agents", ref: "agentBackends/2", entryId: "later", state: "waiting", value: { id: "later", name: "Later", protocol: "acp", command: "later", quirks: "quirks.json" } },
      { point: "agentBackends", pluginId: "someone/agents", ref: "agentBackends/3", entryId: "vendor", state: "active", value: { id: "vendor", name: "Vendor", protocol: "cloud", handler: "start" } },
    ];
    const registry = { entries: () => entries, get: (id: string) => records[id] as PluginRecord | undefined } as unknown as Pick<PluginRegistry, "entries" | "get">;
    const lines: string[] = [];
    const got = contributedBackends(registry, (l) => lines.push(l));
    // Another plugin's `cursor` gets nothing the core grants MOSS's own by id.
    expect(got.map((c) => [c.id, c.bundled])).toEqual([["cursor", false]]);
    expect(lines.join("\n")).toContain("nope");
    // MOSS's own id, but not loaded as a bundled plugin: still not bundled.
    entries = [{ ...entries[0]!, pluginId: "moss/agent-cursor" }];
    expect(contributedBackends(registry).map((c) => c.bundled)).toEqual([false]);
    records["moss/agent-cursor"]!.provenance = { by: "bundled", at: 1 } as PluginRecord["provenance"];
    expect(contributedBackends(registry).map((c) => c.bundled)).toEqual([true]);
    let built = 0;
    const cache = new ContributedBackendCache((c) => ({ id: c.id, n: ++built }) as never);
    const first = cache.backends(registry);
    expect(cache.backends(registry)).toEqual(first);
    expect(built).toBe(1);
    records["moss/agent-cursor"]!.treeHash = "c".repeat(64);
    cache.backends(registry);
    expect(built).toBe(2);
  });
});

// An agent plugin may say its program is an adapter MOSS provides (`launch.adapter`, spec §9.3): what the bundled Claude Code
// and Codex plugins declare, and what a plugin's own declaration is held to.
describe("an adapter a plugin declares", () => {
  const bundled = bundledBackends();

  test("Claude Code and Codex declare theirs: an exact version inside the tested range, a SHA-512, MOSS's own runtime, the person's own program they drive", () => {
    const claude = bundled["claude-code"]!.file.adapter!;
    const codex = bundled["codex"]!.file.adapter!;
    expect(claude).toMatchObject({ package: "@agentclientprotocol/claude-agent-acp", version: "0.100.0", run: "dist/index.js", runtime: "moss-bun", lock: "adapter-lock.json" });
    expect(codex).toMatchObject({ package: "@agentclientprotocol/codex-acp", version: "2.6.0", run: "dist/index.js", runtime: "moss-bun" });
    expect(codex.lock).toBeUndefined(); // one self-contained file: nothing locked beside it
    expect(claude.integrity).toBe("sha512-X+f2M5RiehzSzWRJjDSf0Sbzoc8JK66l85YnYW5TAdHJX53CLQV00v2M72bfCKJ4IZ11qt+WQ/Yg9NVKcuDAhQ==");
    expect(codex.integrity).toBe("sha512-/PBsd0H6URy4bhXhAeXqwb7RqctbXfNceRihAh6nDmn5HJ873uzoHvHxF45YmeWfgOKKRrNRLZjYsket2a7EsQ==");
    expect(claude.uses).toMatchObject([{ program: "claude", env: "CLAUDE_CODE_EXECUTABLE" }]);
    expect(codex.uses).toMatchObject([{ program: "codex", env: "CODEX_PATH" }]);
    // The version the plugin names is a version its own row was tested with.
    for (const id of ["claude-code", "codex"]) {
      const b = bundled[id]!;
      const v = b.file.adapter!.version.split(".").map(Number) as [number, number, number];
      const [lo, hi] = [/>=(\d+)\.(\d+)\.(\d+)/.exec(b.file.quirks.launch.versions)!, /<(\d+)\.(\d+)\.(\d+)/.exec(b.file.quirks.launch.versions)!];
      const cmp = (a: number[], c: number[]) => (a[0]! - c[0]! || a[1]! - c[1]! || a[2]! - c[2]!);
      expect([id, cmp(v, lo.slice(1).map(Number)) >= 0 && cmp(v, hi.slice(1).map(Number)) < 0]).toEqual([id, true]);
    }
    // The adapter block isn't in the descriptor the client reads.
    expect("adapter" in bundled["claude-code"]!.quirks.launch).toBe(false);
  });

  test("Claude Code's lock holds the closure npm resolved, each with its integrity, none of them the adapter itself, and says where its hashes came from", () => {
    const folder = bundled["claude-code"]!.folder;
    const decl = readAdapter(folder, bundled["claude-code"]!.file.adapter!);
    expect(decl.packages.length).toBe(106);
    expect(decl.packages.every((p) => /^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity) && /^\d+\.\d+\.\d+$/.test(p.version) && p.size !== undefined)).toBe(true);
    expect(decl.packages.some((p) => p.name === "@agentclientprotocol/claude-agent-acp")).toBe(false);
    // The Claude Agent SDK's platform binaries are optional and left out: the person's own `claude` is used instead.
    expect(decl.packages.some((p) => /^@anthropic-ai\/claude-agent-sdk-(darwin|linux|win32)/.test(p.name))).toBe(false);
    const lock = JSON.parse(readFileSync(join(folder, "adapter-lock.json"), "utf8")) as { source: string };
    expect(lock.source).toContain("registry.npmjs.org");
    expect(lock.source).toContain("dist.integrity");
    expect(readAdapter(bundled["codex"]!.folder, bundled["codex"]!.file.adapter!).packages).toEqual([]);
  });

  test("a lock that names the adapter itself, a lock outside the plugin's folder, and a lock that isn't one are refused", () => {
    const folder = mkdtempSync(join(tmpdir(), "moss-adapter-plugin-"));
    temps.push(folder);
    const decl = { ...bundled["claude-code"]!.file.adapter!, lock: "lock.json" };
    const own = { path: `node_modules/${decl.package}`, name: decl.package, version: decl.version, integrity: decl.integrity };
    writeFileSync(join(folder, "lock.json"), JSON.stringify({ lock: 1, source: "x", packages: [own] }));
    expect(() => readAdapter(folder, decl)).toThrow(/locks the adapter itself/);
    writeFileSync(join(folder, "lock.json"), JSON.stringify({ lock: 1, packages: "nope" }));
    expect(() => readAdapter(folder, decl)).toThrow(/isn't a lock file/);
    expect(() => readAdapter(folder, { ...decl, lock: "../lock.json" })).toThrow(/isn't a path inside the plugin/);
    expect(() => readAdapter(folder, { ...decl, lock: "/etc/hosts" })).toThrow(/isn't a path inside the plugin/);
  });

  test("a third-party plugin's declaration is read the same way, and one that hands a program's path in a name only MOSS sets is left out, with a line saying why", async () => {
    const w = world();
    const make = (id: string, env: string) => {
      const folder = join(w.pluginsDir, id);
      mkdirSync(join(folder, "rows"), { recursive: true });
      writeFileSync(join(folder, "moss.json"), JSON.stringify({
        manifest: 1, id, name: id, version: "1.0.0", engines: { moss: `^${PLUGIN_API_VERSION}` },
        contributes: { agentBackends: [{ id, name: id, protocol: "acp", command: id, args: ["acp"], quirks: "rows/quirks.json" }] },
      }));
      const file = structuredClone(QUIRKS_OF("grok")) as unknown as Record<string, unknown> & { quirks: { launch: Record<string, unknown> } };
      file.quirks.launch.adapter = { ...bundled["codex"]!.file.adapter!, uses: [{ program: "tool", env }] };
      writeFileSync(join(folder, "rows", "quirks.json"), JSON.stringify(file));
    };
    make("ok-adapter", "TOOL_PATH");
    make("bad-adapter", "MOSS_HOME");
    await w.folders.scan();
    for (const id of ["ok-adapter", "bad-adapter"]) await w.core.approve(id, w.core.get(id)!.treeHash!);
    const lines: string[] = [];
    const got = contributedBackends(w.core, (l) => lines.push(l));
    expect(got.find((c) => c.id === "ok-adapter")!.adapter).toMatchObject({ package: "@agentclientprotocol/codex-acp", packages: [] });
    expect(got.some((c) => c.id === "bad-adapter")).toBe(false);
    expect(lines.join("\n")).toContain("bad-adapter isn't offered: its adapter declaration is refused");
  });
});
