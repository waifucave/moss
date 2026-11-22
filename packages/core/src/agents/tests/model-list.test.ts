// An agent's own model list (lane MS): the readers of each declared source against hostile input, the cache, the memory of
// what a session reported, `models.list {session}`'s listing, and the person's choice staying their own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentSessionListing, BackendModelLists, ModelListDeclSchema, parseModelList, readListFile, reportedModels, runListCommand,
  type ListableBackend, type ModelListDecl, type ModelReader,
} from "../model-list";
import { EngineAgentStartOptions, MemoryRecentStore } from "../start-options";
import { agentMethods } from "../rpc";

const READER: ModelReader = { list: "models", id: "slug", name: "display_name", hideUnless: { key: "visibility", value: "list" }, efforts: { list: "levels", id: "effort" }, defaultEffort: "def" };
const GOOD = JSON.stringify({ models: [
  { slug: "m1", display_name: "Model One", visibility: "list", levels: [{ effort: "low" }, { effort: "high" }], def: "high" },
  { slug: "hidden", visibility: "hide" },
  { slug: "m2", visibility: "list" },
] });

const root = mkdtempSync(join(tmpdir(), "moss-model-list-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fresh = (name: string): string => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };

describe("parseModelList: untrusted text gives models or nothing, never an error", () => {
  test("reads ids, names, efforts and a default effort; hides what the reader hides", () => {
    expect(parseModelList(GOOD, READER)).toEqual([
      { id: "m1", name: "Model One", efforts: ["low", "high"], defaultEffort: "high" },
      { id: "m2", name: "m2", efforts: [] },
    ]);
  });
  test("wrong shapes, junk and prototype tricks", () => {
    for (const bad of ["", "not json", "null", "[]", "{}", '{"models":{}}', '{"models":[1,"a",null,[]]}', '{"models":[{"slug":42}]}', '{"models":[{"slug":""}]}',
      JSON.stringify({ models: [{ slug: "x".repeat(201), visibility: "list" }] }), JSON.stringify({ models: [{ slug: "a\nb", visibility: "list" }] }),
      '{"__proto__":{"models":[{"slug":"p","visibility":"list"}]}}']) expect(parseModelList(bad, READER)).toBeUndefined();
    // `list` through the prototype chain finds nothing.
    expect(parseModelList("{}", { ...READER, list: "constructor.name" })).toBeUndefined();
    // Bogus efforts are dropped one by one; a default effort the list doesn't hold is dropped.
    const r = parseModelList(JSON.stringify({ models: [{ slug: "m", visibility: "list", levels: [{ effort: 1 }, { effort: "" }, { effort: "x".repeat(33) }, { effort: "ok" }, { effort: "ok" }], def: "nope" }] }), READER);
    expect(r).toEqual([{ id: "m", name: "m", efforts: ["ok"] }]);
  });
  test("a huge list is cut at the bound, duplicates once", () => {
    const many = JSON.stringify({ models: Array.from({ length: 9_000 }, (_, i) => ({ slug: `m${i % 3_000}`, visibility: "list" })) });
    const r = parseModelList(many, READER)!;
    expect(r.length).toBe(1_000);
    expect(new Set(r.map((m) => m.id)).size).toBe(1_000);
  });
});

describe("the declaration is data with bounds", () => {
  const ok = { command: { program: "x", args: [], identity: { versionArgs: ["--version"], versionPattern: "." } }, reader: READER };
  test("a command, a file or both; neither is refused; a path leaving the folder is refused", () => {
    expect(ModelListDeclSchema.safeParse(ok).success).toBe(true);
    expect(ModelListDeclSchema.safeParse({ reader: READER }).success).toBe(false);
    for (const path of ["../secret.json", "a/../../b", "/etc/passwd", "C:\\x.json", "a\\..\\b"]) {
      expect(ModelListDeclSchema.safeParse({ file: { home: ".x", path }, reader: READER }).success).toBe(false);
      expect(ModelListDeclSchema.safeParse({ file: { home: path, path: "m.json" }, reader: READER }).success).toBe(false);
    }
    expect(ModelListDeclSchema.safeParse({ ...ok, command: { ...ok.command, timeoutMs: 10 * 60_000 } }).success).toBe(false);
    expect(ModelListDeclSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe("b. the one declared file", () => {
  const decl = (over: Partial<NonNullable<ModelListDecl["file"]>> = {}): NonNullable<ModelListDecl["file"]> => ({ home: ".agent", path: "models.json", maxBytes: 4096, ...over });
  const setup = (name: string): { uh: string; dir: string } => { const uh = fresh(name); const dir = join(uh, ".agent"); mkdirSync(dir, { recursive: true }); return { uh, dir }; };

  test("reads that file and nothing else in the folder", () => {
    const { uh, dir } = setup("b-ok");
    writeFileSync(join(dir, "models.json"), GOOD);
    writeFileSync(join(dir, "auth.json"), "SECRET-TOKEN-do-not-read");
    expect(readListFile(decl(), { userHome: uh, env: {} })).toBe(GOOD);
  });
  test("missing folder or file, a directory, a file over the cap", () => {
    expect(readListFile(decl(), { userHome: fresh("b-none"), env: {} })).toBeUndefined();
    const { uh, dir } = setup("b-big");
    mkdirSync(join(dir, "models.json"));
    expect(readListFile(decl(), { userHome: uh, env: {} })).toBeUndefined();
    rmSync(join(dir, "models.json"), { recursive: true });
    writeFileSync(join(dir, "models.json"), "x".repeat(5000));
    expect(readListFile(decl(), { userHome: uh, env: {} })).toBeUndefined();
  });
  test.skipIf(process.platform === "win32")("a symlink in place of the file, a hard link to another file, and a folder link leading out are all refused", () => {
    const { uh, dir } = setup("b-links");
    const outside = join(fresh("b-outside"), "elsewhere.json");
    writeFileSync(outside, GOOD);
    symlinkSync(outside, join(dir, "models.json"));
    expect(readListFile(decl(), { userHome: uh, env: {} })).toBeUndefined();
    rmSync(join(dir, "models.json"));
    linkSync(outside, join(dir, "models.json"));
    expect(readListFile(decl(), { userHome: uh, env: {} })).toBeUndefined();
    rmSync(join(dir, "models.json"));
    // A subfolder that is a link out: the file's real path leaves the folder.
    symlinkSync(join(outside, ".."), join(dir, "sub"));
    expect(readListFile(decl({ path: "sub/elsewhere.json" }), { userHome: uh, env: {} })).toBeUndefined();
    // The folder itself may be a link (a dotfiles layout): its real path is the base.
    const real = fresh("b-realdir");
    writeFileSync(join(real, "models.json"), GOOD);
    const uh2 = fresh("b-linkhome");
    symlinkSync(real, join(uh2, ".agent"));
    expect(readListFile(decl(), { userHome: uh2, env: {} })).toBe(GOOD);
  });
  test("a folder an environment variable names counts only when absolute", () => {
    const { uh } = setup("b-env");
    const named = fresh("b-named");
    writeFileSync(join(named, "models.json"), GOOD);
    expect(readListFile(decl({ env: "AGENT_HOME" }), { userHome: uh, env: { AGENT_HOME: named } })).toBe(GOOD);
    expect(readListFile(decl({ env: "AGENT_HOME" }), { userHome: uh, env: { AGENT_HOME: "relative/dir" } })).toBeUndefined();
  });
});

describe("a. the list command", () => {
  const dir = fresh("a-scripts");
  const script = (name: string, body: string): string => { const p = join(dir, name); writeFileSync(p, body); return p; };
  const env = { PATH: process.env["PATH"] ?? "" };
  const cmd = (args: string[], over: Partial<NonNullable<ModelListDecl["command"]>> = {}): NonNullable<ModelListDecl["command"]> => ({
    program: process.execPath, args, identity: { versionArgs: ["--version"], versionPattern: "^\\d+\\.\\d+\\.\\d+" }, timeoutMs: 3_000, maxBytes: 4096, ...over,
  });

  test("runs after the identity check and gives its stdout", async () => {
    const s = script("good.js", `console.log(${JSON.stringify(GOOD)});`);
    expect(await runListCommand(cmd([s]), env)).toContain('"slug":"m1"');
  });
  test("a program that doesn't answer as the declared identity never runs its list command", async () => {
    const marker = join(dir, "ran.txt");
    const s = script("marker.js", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); console.log("{}");`);
    expect(await runListCommand(cmd([s], { identity: { versionArgs: ["--version"], versionPattern: "^definitely-not-this$" } }), env)).toBeUndefined();
    expect(await runListCommand(cmd([s], { program: "no-such-program-moss" }), env)).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });
  test("junk, a failing exit, and more than the byte cap give nothing", async () => {
    expect(parseModelList((await runListCommand(cmd([script("junk.js", `process.stdout.write("\\u0000\\u0001 not json <<<");`)]), env)) ?? "", READER)).toBeUndefined();
    expect(await runListCommand(cmd([script("fail.js", `console.log("{}"); process.exit(3);`)]), env)).toBeUndefined();
    expect(await runListCommand(cmd([script("big.js", `process.stdout.write("x".repeat(100000));`)]), env)).toBeUndefined();
  });
  test("a command that hangs is ended by its pid at the time limit", async () => {
    const pidFile = join(dir, "hang.pid");
    const s = script("hang.js", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const t = Date.now();
    expect(await runListCommand(cmd([s], { timeoutMs: 600 }), env)).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(5_000);
    if (process.platform !== "win32") {
      const pid = Number(readFileSync(pidFile, "utf8"));
      await Bun.sleep(300);
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });
  test("it runs with the given environment only, in an empty folder with its input closed", async () => {
    const s = script("env.js", `console.log(JSON.stringify({ models: [{ slug: "e", visibility: "list", display_name: String(process.env.PROBE_SECRET === undefined) + ":" + require("fs").readdirSync(process.cwd()).length }] }));`);
    process.env["PROBE_SECRET"] = "dummy123";
    try {
      const out = parseModelList((await runListCommand(cmd([s]), env)) ?? "", READER)!;
      expect(out[0]!.name).toBe("true:0");
    } finally {
      delete process.env["PROBE_SECRET"];
    }
  });
});

describe("the service: declared list cached with its age, else what a session reported", () => {
  const decl: ModelListDecl = ModelListDeclSchema.parse({ command: { program: "x", args: [], identity: { versionArgs: [], versionPattern: "." } }, reader: READER });
  const backend: ListableBackend = { id: "demo", modelList: decl };
  test("a read is cached; an old one is answered again while it is read afresh; a failure keeps the old and logs once", async () => {
    const home = fresh("svc-1");
    let clock = 1_000;
    let calls = 0;
    let text: string | undefined = GOOD;
    const logs: string[] = [];
    const lists = new BackendModelLists({ home, userHome: home, now: () => clock, ttlMs: 100, log: (l) => logs.push(l), runCommand: async () => { calls++; return text; } });
    const first = (await lists.get(backend))!;
    expect(first.source).toBe("command");
    expect(first.models.map((m) => m.id)).toEqual(["m1", "m2"]);
    await lists.get(backend);
    expect(calls).toBe(1);
    clock += 500;
    text = JSON.stringify({ models: [{ slug: "m3", visibility: "list" }] });
    expect((await lists.get(backend))!.models.map((m) => m.id)).toEqual(["m1", "m2"]);
    await Bun.sleep(20);
    expect(calls).toBe(2);
    expect((await lists.get(backend))!.models.map((m) => m.id)).toEqual(["m3"]);
    clock += 500;
    text = undefined;
    await lists.get(backend);
    await Bun.sleep(20);
    clock += 500;
    await lists.get(backend);
    await Bun.sleep(20);
    expect((await lists.get(backend))!.models.map((m) => m.id)).toEqual(["m3"]);
    expect(logs.length).toBe(1);
    expect(logs[0]).not.toContain("m3");
  });
  test("with no list, or a list that can't be read, what a session reported is offered; and kept for the next daemon", async () => {
    const home = fresh("svc-2");
    const logs: string[] = [];
    const lists = new BackendModelLists({ home, userHome: home, log: (l) => logs.push(l), runCommand: async () => undefined });
    expect(await lists.get(backend)).toBeUndefined();
    expect(logs.length).toBe(1);
    expect(await lists.get({ id: "plain" })).toBeUndefined();
    lists.noteSession("demo", [{ id: "s1", name: "s1", efforts: ["low"] }]);
    lists.noteSession("plain", []);
    expect((await lists.get(backend))).toMatchObject({ source: "session", models: [{ id: "s1" }] });
    const file = join(home, "run", "agents", "session-models.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    const again = new BackendModelLists({ home, userHome: home });
    expect((await again.get({ id: "demo" }))).toMatchObject({ source: "session", models: [{ id: "s1", efforts: ["low"] }] });
    expect(await again.get({ id: "plain" })).toBeUndefined();
  });
  test("a malformed, oversized or foreign memory file is nothing yet; the memory is bounded; a prototype name finds nothing", async () => {
    const home = fresh("svc-3");
    const file = join(home, "run", "agents", "session-models.json");
    mkdirSync(join(home, "run", "agents"), { recursive: true });
    for (const bad of ["x", "[]", '{"v":2}', '{"v":1,"byBackend":{"demo":{"at":1,"models":[{"id":1}]}}}', JSON.stringify({ v: 1, byBackend: { demo: { at: 1, models: Array.from({ length: 1_001 }, (_, i) => ({ id: `m${i}`, name: "n", efforts: [] })) } } })]) {
      writeFileSync(file, bad);
      expect(await new BackendModelLists({ home, userHome: home }).get({ id: "demo" })).toBeUndefined();
    }
    rmSync(file);
    const lists = new BackendModelLists({ home, userHome: home });
    for (let i = 0; i < 40; i++) lists.noteSession(`b${i}`, [{ id: "m", name: "m", efforts: [] }]);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).byBackend).length).toBe(32);
    expect(await lists.get({ id: "__proto__" })).toBeUndefined();
    expect(await lists.get({ id: "constructor" })).toBeUndefined();
  });
});

describe("what a session reported", () => {
  const config = { modelOption: "model", effortOption: "thought_level", effortInModel: false };
  const options = [
    { id: "model", category: "model", currentValue: "a", values: ["a", "b"] },
    { id: "thought_level", category: "thought_level", currentValue: "low", values: ["low", "high"] },
  ];
  test("models with the session's efforts; none when the agent folds effort into the model's id or reports no model", () => {
    expect(reportedModels(options, config)).toEqual([{ id: "a", name: "a", efforts: ["low", "high"] }, { id: "b", name: "b", efforts: ["low", "high"] }]);
    expect(reportedModels(options, { ...config, effortInModel: true })[0]!.efforts).toEqual([]);
    expect(reportedModels([options[1]!], config)).toEqual([]);
    expect(reportedModels(undefined, config)).toEqual([]);
    expect(reportedModels([{ id: "model", values: ["ok", "bad\nid"] }], config).map((m) => m.id)).toEqual(["ok"]);
  });
  test("models.list {session}'s listing: the agent's own ids under the agent's backend id; before its first turn, the agent's list as known", async () => {
    const lists = { get: async () => ({ source: "file" as const, at: 1, models: [{ id: "known", name: "Known", efforts: ["low"] }] }) };
    const backend = { id: "demo", pluginId: "moss/agent-demo", name: "Demo", quirks: { config } };
    expect(await agentSessionListing(backend, options, lists)).toEqual([
      { id: "a", name: "a", provider: "demo", providerName: "Demo", plugin: "moss/agent-demo", efforts: ["low", "high"], images: false, signedIn: true },
      { id: "b", name: "b", provider: "demo", providerName: "Demo", plugin: "moss/agent-demo", efforts: ["low", "high"], images: false, signedIn: true },
    ]);
    expect((await agentSessionListing(backend, undefined, lists)).map((m) => m.id)).toEqual(["known"]);
    expect(await agentSessionListing(backend, undefined, { get: async () => undefined })).toEqual([]);
  });
});

describe("the person's choice stays their own", () => {
  const BOT = { kind: "bot", bot: "helper" } as never;
  const USER = { kind: "user", client: "app" } as never;
  const make = () => {
    const starts: unknown[] = [];
    const start = new EngineAgentStartOptions({ source: () => ({ from: "unknown" }), catalog: () => ({ models: [] }), store: new MemoryRecentStore() });
    const methods = agentMethods({
      manager: { start: async (r: unknown) => { starts.push(r); return { sessionId: "s1" }; } } as never,
      backends: () => [{ id: "codex", pluginId: "moss/agent-codex", quirks: { placement: "local", marks: [] }, detect: async () => ({}) } as never],
      computer: "Studio", localDevice: () => "a".repeat(32), startOptions: start, now: () => 5,
    });
    return { methods, start, starts };
  };
  const params = (over: Record<string, unknown>) => ({ backend: "codex", computer: "Studio", root: "home/Studio/app", ...over });

  test("a person's start with a model is remembered for that agent and goes to the session; one with none leaves the agent's own default", async () => {
    const { methods, start, starts } = make();
    await methods["agent.start"]!(params({ model: "gpt-6", effort: "high" }), { caller: USER } as never);
    expect(start.recent().byBackend).toEqual([{ backend: "codex", model: "gpt-6", effort: "high" }]);
    expect(starts[0]).toMatchObject({ model: "gpt-6", effort: "high" });
    await methods["agent.start"]!(params({}), { caller: USER } as never);
    expect(starts[1]).not.toHaveProperty("model");
    expect(start.recent().byBackend).toEqual([{ backend: "codex" }]);
  });
  test("a start by a bot, or by any other caller, is refused and never reaches the memory; nor does a start of another agent move this one", async () => {
    const { methods, start } = make();
    await methods["agent.start"]!(params({ model: "mine" }), { caller: USER } as never);
    const before = JSON.stringify(start.recent());
    for (const caller of [BOT, { kind: "session" } as never, { kind: "plugin" } as never]) {
      let err: unknown;
      try { await methods["agent.start"]!(params({ model: "theirs" }), { caller } as never); } catch (e) { err = e; }
      expect(err).toBeDefined();
    }
    expect(JSON.stringify(start.recent())).toBe(before);
  });
});

beforeAll(() => { try { chmodSync(root, 0o700); } catch { /* best effort */ } });
