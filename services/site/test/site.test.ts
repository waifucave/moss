// The site builds, in both release states, with no broken link and nothing loaded from another host; its download area names the files the release scripts make; its docs outline points at files that exist.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSite, type BuildResult } from "../src/build";
import { checkSite } from "../src/check";
import { configProblem, readConfig, REPO_ROOT, SITE_DIR, withSwitches } from "../src/config";
import { docFile, readOutline, sourcePath } from "../src/docs";
import { allInstallerNames, releaseUrl } from "../src/downloads";
import { pendingMarks, PENDING_KINDS, renderDoc } from "../src/markdown";
import { templateFiles } from "../../../packages/plugin-sdk/src/templates/index";
import { runCodeCommand } from "../../../packages/cli/src/code-cli";
import { parseRoutine } from "../../../packages/core/src/routines/file";
import { MOSS_PLUGIN_VERBS, runPluginCommand, runPluginDev, runPluginList } from "../../../packages/cli/src/moss-plugin-cli";
import { loginEnable, loginRemove, loginStatus, type LoginOsDeps } from "../../../packages/core/src/platform/login/manager";
import { engineBinaryPath } from "../../../packages/core/src/update/engine-copy";
import { keychainService } from "../../../packages/core/src/profile";
import { SPOTS } from "../../../packages/plugin-sdk/src/catalogs/spots";
import { AgentBackendSchema, CORE_CONTRIBUTION_KEYS, ManifestSchema, SettingSchema, UiSchema } from "../../../packages/plugin-sdk/src/manifest/schema";
import { ThemeSchema } from "../../../packages/plugin-sdk/src/formats/theme";

const root = mkdtempSync(join(tmpdir(), "moss-site-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const base = readConfig();
const built = new Map<string, BuildResult>();
async function build(key: string, change: Parameters<typeof withSwitches>[1]): Promise<BuildResult> {
  const have = built.get(key);
  if (have !== undefined) return have;
  const r = await buildSite({ out: join(root, key), config: withSwitches(base, change) });
  built.set(key, r);
  return r;
}
const read = (r: BuildResult, path: string) => readFileSync(join(r.out, ...path.split("/").filter(Boolean), path.endsWith("/") || path === "" ? "index.html" : ""), "utf8");

function allText(dir: string): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out += allText(p);
    else if (/\.(html|json|css|js|txt)$/.test(name)) out += readFileSync(p, "utf8");
  }
  return out;
}

describe("the built site", () => {
  for (const [key, change] of [
    ["unreleased", { state: "unreleased" }],
    ["released", { state: "released", homebrew: true, winget: true }],
  ] as const) {
    test(`${key}: no broken link, nothing from another host, within the page budget`, async () => {
      const r = await build(key, change);
      const c = checkSite(r.out);
      expect(c.problems).toEqual([]);
      // Every load is a path on this site.
      for (const list of Object.values(c.loads)) for (const u of list) expect(u.startsWith("/")).toBe(true);
      // Links out go to the project's own GitHub pages only.
      for (const u of c.outbound) expect(u.startsWith(base.repository)).toBe(true);
    }, 60_000);
  }

  test("not released: no version, no download, the repository and the docs instead", async () => {
    const r = await build("unreleased", { state: "unreleased" });
    const page = read(r, "/");
    expect(page).not.toContain(base.release.version);
    expect(page).not.toContain("/releases/download/");
    expect(page).toContain("Not released yet");
    expect(page).toContain(`href="${base.repository}"`);
  }, 60_000);

  test("released: a button for every installer the release scripts name, at the release's address", async () => {
    const r = await build("released", { state: "released", homebrew: true, winget: true });
    const page = read(r, "/");
    const hrefs = [...page.matchAll(/href="([^"]+\/releases\/download\/[^"]+)"/g)].map((m) => m[1]!);
    const want = allInstallerNames(base.release.version).map((n) => releaseUrl(base.repository, base.release.version, n));
    expect([...hrefs].sort()).toEqual([...want].sort());
    expect(want.length).toBe(16);
    expect(page).toContain("brew install --cask waifucave/moss/moss");
    expect(page).toContain("winget install waifucave.MOSS");
  }, 60_000);

  test("the package managers' lines show only once they are switched on", async () => {
    const r = await build("released-plain", { state: "released", homebrew: false, winget: false });
    const page = read(r, "/");
    expect(page).not.toContain("brew install");
    expect(page).not.toContain("winget install");
  }, 60_000);

  test("one opening, the bot list; the name-a-bot moment is part of the bots band", async () => {
    const page = read(await build("unreleased", { state: "unreleased" }), "/");
    expect(page.match(/<h1[ >]/g)?.length).toBe(1);
    expect(page).toContain("Bots that do the work on your computer.");
    expect(page).toContain("data-botlist");
    const bots = page.slice(page.indexOf('id="bots"'), page.indexOf('id="can-do"'));
    expect(bots).toContain("data-tryname");
  }, 60_000);

  test("Privacy and Terms: in every page's foot, each a placeholder until the first release", async () => {
    const r = await build("unreleased", { state: "unreleased" });
    for (const path of ["/", "/docs/", "/docs/install/"]) {
      expect(read(r, path)).toContain('href="/privacy/"');
      expect(read(r, path)).toContain('href="/terms/"');
    }
    for (const path of ["/privacy/", "/terms/"]) expect(read(r, path)).toContain("coming with the first release");
  }, 60_000);

  test("today's facts are said plainly: searches go to Exa, updates can't be turned off, no model comes with it, 13 and older", async () => {
    const r = await build("unreleased", { state: "unreleased" });
    const text = (path: string) => read(r, path).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const home = text("/");
    expect(home).toContain("Web searches go to Exa");
    expect(home).toContain("every 4 hours");
    expect(home).toContain("There is no switch to turn this off.");
    expect(home).toContain("MOSS doesn't come with a model");
    expect(home).toContain("13 and older");
    expect(text("/docs/").length).toBeGreaterThan(0);
    expect(text("/docs/install/")).toContain("13 and older");
    expect(text("/docs/overview/")).toContain("Web searches go to Exa");
  }, 60_000);

  test("no old product name, no character model, nothing of the owner's", async () => {
    const text = allText((await build("unreleased", { state: "unreleased" })).out).toLowerCase();
    // The old product names are written backwards here, so this file never spells them (the repo's rename tests read every file).
    const old = ["revolc", "retniw", "amron"].map((w) => [...w].reverse().join(""));
    for (const word of [...old, "alpha", "live2d", "vrm", "pngtuber", "deepseek-chan"]) expect([word, text.includes(word)]).toEqual([word, false]);
  }, 60_000);

  test("no price: the word \"free\" is on no page, in either release state", async () => {
    for (const [key, change] of [["unreleased", { state: "unreleased" }], ["released", { state: "released", homebrew: true, winget: true }]] as const) {
      const out = (await build(key, change)).out;
      const said = allText(out).match(/[^.<>"]{0,40}\bfree\b[^.<>"]{0,40}/gi) ?? [];
      expect([key, said]).toEqual([key, []]);
    }
  }, 60_000);

  test("the docs: every written page is in the navigation and the search index", async () => {
    const r = await build("unreleased", { state: "unreleased" });
    const written = readOutline().flatMap((g) => g.pages).filter((p) => existsSync(docFile(p.slug)));
    expect(written.length).toBeGreaterThanOrEqual(6);
    const home = read(r, "/docs/");
    const index = JSON.parse(readFileSync(join(r.out, "docs", "search.json"), "utf8")) as { u: string }[];
    for (const p of written) {
      expect(home).toContain(`href="/docs/${p.slug}/"`);
      expect(index.some((e) => e.u === `/docs/${p.slug}/`)).toBe(true);
    }
  }, 60_000);
});

describe("the docs' sources", () => {
  test("every page's sources are files or folders in the repository", () => {
    const missing = readOutline().flatMap((g) => g.pages).flatMap((p) => p.sources.map(sourcePath).filter((s) => !existsSync(join(REPO_ROOT, s))).map((s) => `${p.slug}: ${s}`));
    expect(missing).toEqual([]);
  });

  test("every Markdown page has its place in the outline", () => {
    const slugs = new Set(readOutline().flatMap((g) => g.pages.map((p) => p.slug)));
    const files = readdirSync(join(SITE_DIR, "content", "docs")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
    expect(files.filter((f) => !slugs.has(f))).toEqual([]);
  });

  test("sentences waiting on unmerged work carry a known pending mark, which never reaches a page", async () => {
    const r = await build("unreleased", { state: "unreleased" });
    const marked: string[] = [];
    for (const f of readdirSync(join(SITE_DIR, "content", "docs")).filter((x) => x.endsWith(".md"))) {
      for (const kind of pendingMarks(readFileSync(join(SITE_DIR, "content", "docs", f), "utf8"))) {
        expect([f, (PENDING_KINDS as readonly string[]).includes(kind)]).toEqual([f, true]);
        marked.push(`${f}:${kind}`);
      }
    }
    // Deletion and local model servers merged (2026-11-25): no sentence waits on them any more.
    expect(marked).toEqual([]);
    expect(allText(r.out)).not.toContain("pending:");
    expect(() => renderDoc("---\ntitle: T\ndescription: D\n---\n\nA sentence. <!-- pending: nonsense -->\n", "z.md")).toThrow();
  }, 60_000);

  test("the Markdown renderer gives headings ids and refuses a page without front matter", () => {
    const r = renderDoc("---\ntitle: T\ndescription: D\n---\n\n## One thing\n\n## One thing\n", "x.md");
    expect(r.headings.map((h) => h.id)).toEqual(["one-thing", "one-thing-2"]);
    expect(() => renderDoc("## No front matter\n", "y.md")).toThrow();
  });
});

describe("the commands the docs print", () => {
  const plugin = readFileSync(docFile("first-plugin"), "utf8");
  const commands = [
    ...[...readdirSync(join(SITE_DIR, "content", "docs"))].flatMap((f) =>
      [...readFileSync(join(SITE_DIR, "content", "docs", f), "utf8").matchAll(/`(moss [^`]+)`|^(moss .+)$/gm)].map((m) => (m[1] ?? m[2])!.trim())),
    // The engine's own binary inside an app, run by its path (`…/moss-core autostart remove`): the same command line.
    ...[...readdirSync(join(SITE_DIR, "content", "docs"))].flatMap((f) =>
      [...readFileSync(join(SITE_DIR, "content", "docs", f), "utf8").matchAll(/`\S*[\\/]moss-core(?:\.exe)? ([^`]+)`/g)].map((m) => `moss ${m[1]!.trim()}`)),
    // The landing page's own: in <code>, or a line of its developers' block.
    ...[...readFileSync(join(SITE_DIR, "src", "landing.ts"), "utf8").matchAll(/<code>(moss [^<]+)<\/code>|^(moss plugin .+?)(?:<\/code><\/pre>)?$/gm)].map((m) => (m[1] ?? m[2])!.trim()),
  ];

  test("the plugin page's manifest and code are what `moss plugin new tool hello-tool` writes, word for word", () => {
    const made = templateFiles("tool", { id: "hello-tool", name: "Hello tool" });
    if ("error" in made) throw new Error(made.error);
    const block = (lang: string) => plugin.match(new RegExp("```" + lang + "\\n([\\s\\S]*?)```"))![1]!;
    expect(JSON.parse(block("json"))).toEqual(JSON.parse(made.files["moss.json"]!));
    expect(block("ts").trim()).toBe(made.files["host/index.ts"]!.trim());
    expect(plugin).toContain("moss plugin new tool hello-tool");
  });

  test("the model provider page's manifest is what `moss plugin new model my-provider` writes, word for word", () => {
    const page = readFileSync(docFile("model-plugin"), "utf8");
    const made = templateFiles("model", { id: "my-provider", name: "My provider" });
    if ("error" in made) throw new Error(made.error);
    expect(page).toContain("moss plugin new model my-provider");
    expect(JSON.parse(page.match(/```json\n([\s\S]*?)```/)![1]!)).toEqual(JSON.parse(made.files["moss.json"]!));
  });

  test("every `moss code` line runs as printed, in a shell with no MOSS_COMPUTER", async () => {
    // A line with <placeholders> or [optional parts] is a command's form, checked by the test above, not run.
    const lines = commands.filter((c) => c.startsWith("moss code ") && !/[<[]/.test(c));
    expect(lines.length).toBeGreaterThan(0);
    const home = "/Users/someone";
    for (const line of lines) {
      const argv = [...line.slice("moss code ".length).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2])!.replace(/^~\//, `${home}/`));
      const calls: { method: string; params: unknown }[] = [];
      const errors: string[] = [];
      const code = await runCodeCommand(argv, {
        connect: async () => ({ request: async (method: string, params?: unknown) => { calls.push({ method, params }); return { session: "s1" }; }, close() {} }),
        log: () => {}, error: (l) => errors.push(l), cwd: home, home, env: {},
      });
      expect([line, code, errors]).toEqual([line, 0, []]);
      expect(calls.map((c) => c.method)).toEqual(["agent.start"]);
    }
  });

  test("every printed command is one the moss command has", () => {
    const top = new Set([...readFileSync(join(REPO_ROOT, "packages", "cli", "src", "main.ts"), "utf8").matchAll(/^  case "([a-z-]+)":/gm)].map((m) => m[1]!));
    const pluginVerbs = new Set<string>(["list", "dev", "logs", "new", "validate", ...MOSS_PLUGIN_VERBS]);
    // `moss autostart`'s subcommands, from its own usage line (the command acts on the OS, so it is read, never run, here).
    const usage = /const AUTOSTART_USAGE = "usage: moss autostart ([^"]+)"/.exec(readFileSync(join(REPO_ROOT, "packages", "cli", "src", "main.ts"), "utf8"))![1]!;
    const autostartSubs = new Set(usage.replace(/\[[^\]]*\]/g, "").split(/[\s|]+/).filter((w) => /^[a-z]+$/.test(w)));
    expect([...autostartSubs].sort()).toEqual(["disable", "enable", "remove", "start", "status", "stop"]);
    const engineText = readFileSync(join(REPO_ROOT, "packages", "core", "src", "update", "engine-install-command.ts"), "utf8");
    const engineSubs = new Set([...engineText.matchAll(/usage: moss-core engine ([a-z]+)/g)].map((m) => m[1]!));
    expect([...engineSubs].sort()).toEqual(["install", "reset"]);
    expect(autostartSubs.has("remove")).toBe(true);
    for (const c of commands) {
      const [, word, verb] = c.split(/\s+/);
      expect([c, top.has(word!)]).toEqual([c, true]);
      if (word === "plugin") expect([c, pluginVerbs.has(verb!)]).toEqual([c, true]);
      if (word === "autostart") expect([c, autostartSubs.has(verb!)]).toEqual([c, true]);
      if (word === "engine") expect([c, engineSubs.has(verb!)]).toEqual([c, true]);
    }
  });

  test("every printed plugin command runs as printed through the CLI's own code", async () => {
    const lines = commands.filter((c) => c.startsWith("moss plugin ") && !/[<[]/.test(c));
    expect(lines.length).toBeGreaterThan(5);
    // The folders the pages make with `moss plugin new`, made here the same way, for the commands that name them.
    const work = mkdtempSync(join(root, "plugin-commands-"));
    for (const line of lines) {
      const [, , verb, ...args] = line.split(/\s+/);
      if (verb !== "new") continue;
      const [template, folder] = args;
      const made = templateFiles(template!, { id: folder!, name: folder! });
      if ("error" in made) throw new Error(`${line}: ${made.error}`);
      for (const [file, text] of Object.entries(made.files)) {
        mkdirSync(dirname(join(work, folder!, file)), { recursive: true });
        writeFileSync(join(work, folder!, file), text);
      }
    }
    // What a printed `wrap` names: a folder for a skill or a Claude Code plugin, a file for an agent or an MCP configuration.
    for (const line of lines) {
      const [, , verb, kind, value] = line.split(/\s+/);
      if (verb !== "wrap" || kind === "mcp-url" || value === undefined) continue;
      const at = join(work, value!);
      if (kind === "skill-folder" || kind === "claude-plugin") mkdirSync(at, { recursive: true });
      else { mkdirSync(dirname(at), { recursive: true }); writeFileSync(at, kind === "mcp-config" ? '{ "mcpServers": {} }' : "---\nname: x\n---\n"); }
    }
    const answers: Record<string, unknown> = {
      "plugin.list": { plugins: [] }, "plugin.index.list": { indexes: [] }, "plugin.setEnabled": { applied: true }, "plugin.install": { id: "x", state: "found" },
      "plugin.dev.add": { applied: false }, "plugin.dev.renew": { expiresAt: Date.now() + 86_400_000 },
    };
    for (const line of lines) {
      const [, , verb, ...args] = line.split(/\s+/);
      if (verb === "new" || verb === "validate") {
        // new: made above; validate: of a folder a printed `new` made.
        if (verb === "validate") expect([line, existsSync(join(work, args[0]!))]).toEqual([line, true]);
        continue;
      }
      const calls: string[] = [];
      const call = async (method: string): Promise<unknown> => { calls.push(method); return answers[method] ?? {}; };
      const r = verb === "list" ? await runPluginList(args, call)
        : verb === "dev" ? await runPluginDev(args, call, work)
        : await runPluginCommand(verb!, args, call, { cwd: work, confirm: async () => true });
      expect([line, r.code, calls.length > 0]).toEqual([line, 0, true]);
    }
    // No printed plugin command is a bare verb missing what it acts on.
    for (const c of commands) expect([c, /^moss plugin (enable|disable|install|remove|dev|info|logs|wrap)\s*$/.test(c)]).toEqual([c, false]);
  });

  test("every routine file and schedule the docs print is one MOSS reads", () => {
    const page = readFileSync(docFile("routines"), "utf8");
    const files = [...page.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const r = parseRoutine(f, "example");
      expect([f.slice(0, 40), r.ok ? "ok" : (r as { reason: string }).reason]).toEqual([f.slice(0, 40), "ok"]);
    }
    // Each schedule in the page's table, as a routine's only trigger.
    const schedules = [...page.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
    expect(schedules.length).toBeGreaterThan(1);
    for (const s of schedules) {
      const r = parseRoutine(`---\nname: T\ntriggers:\n  - schedule: "${s}"\n---\nDo it.\n`, "t");
      expect([s, r.ok]).toEqual([s, true]);
    }
  });

  test("no page tells anyone to make a bot plugin, a format bots no longer use", () => {
    expect(commands.length).toBeGreaterThan(5);
    for (const c of commands) expect([c, /^moss plugin new bot\b/.test(c)]).toEqual([c, false]);
    // And none sends a reader to the bare template list, which still offers it.
    for (const c of commands) expect([c, /^moss plugin new\s*$/.test(c)]).toEqual([c, false]);
  });
});

describe("site.json", () => {
  test("the committed switches are valid, and a wrong one is named", () => {
    expect(configProblem(JSON.parse(readFileSync(join(SITE_DIR, "site.json"), "utf8")))).toBeUndefined();
    expect(configProblem({ ...base, release: { ...base.release, state: "soon" } })).toContain("release.state");
    expect(configProblem({ ...base, repository: "https://example.com/x" })).toContain("repository");
  });
});

describe("removing MOSS, as the page says", () => {
  const page = readFileSync(join(SITE_DIR, "content", "docs", "uninstall.md"), "utf8");
  // The Homebrew casks' lines are checked by reading them, not here: CI's map runs no site test when the cask templates change.

  test("`autostart remove` takes away the login start the page names, through the engine's own login code (the OS faked)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "site-uninstall-"));
    try {
      const calls: string[] = [];
      const os: LoginOsDeps = {
        register: async () => { calls.push("register"); return true; },
        unregister: async () => { calls.push("unregister"); },
        query: async () => (calls.at(-1) === "register" ? "on" : "absent"),
      };
      const home = join(tmp, ".moss");
      const spec = { os: "darwin" as const, bin: engineBinaryPath(home, "darwin"), home, logsDir: join(home, "logs"), profile: "dist" as const, homedir: tmp };
      const on = await loginEnable(spec, os);
      expect(on.unitPath).toBe(join(tmp, "Library", "LaunchAgents", "com.waifucave.moss.core.plist"));
      expect(existsSync(on.unitPath!)).toBe(true);
      const off = await loginRemove(spec, os);
      expect([off.state, existsSync(on.unitPath!), calls.includes("unregister")]).toEqual(["not-installed", false, true]);
      expect((await loginStatus(spec, os)).state).toBe("not-installed");
      expect(page).toContain("`~/Library/LaunchAgents/com.waifucave.moss.core.plist`");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    // What the command prints, as the page quotes it: the CLI's own line (main.ts runs the stop and the remove above).
    const main = readFileSync(join(REPO_ROOT, "packages", "cli", "src", "main.ts"), "utf8");
    expect(main).toContain("console.log(`autostart removed (${spec.profile}); the daemon: ${stopped}`);");
    expect(page).toContain("`autostart removed (dist); the daemon:`");
  });

  test("the engine's own copy is where the page runs it from, on every system", () => {
    expect(engineBinaryPath("~/.moss", "darwin")).toBe("~/.moss/bin/daemon/moss-core");
    expect(engineBinaryPath("~/.moss", "linux")).toBe("~/.moss/bin/daemon/moss-core");
    expect(page).toContain("`~/.moss/bin/daemon/moss-core autostart remove`");
    expect(engineBinaryPath("%USERPROFILE%\\.moss", "win32").replaceAll("/", "\\")).toBe("%USERPROFILE%\\.moss\\bin\\daemon\\moss-core.exe");
    expect(page).toContain("`%USERPROFILE%\\.moss\\bin\\daemon\\moss-core.exe autostart remove`");
  });

  test("Erase everything, and what it leaves, in the engine's and the app's own words", () => {
    const src = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf8");
    const outcome = src("apps", "moss", "src", "main", "erase-outcome.ts");
    for (const said of ["MOSS is starting fresh on this computer.", "MOSS couldn't erase everything."]) {
      expect(outcome).toContain(`"${said}"`);
      expect(page).toContain(`**${said}**`);
    }
    // Every kept item but the previous app's folder (its name is an old one, never on the site) is on the page.
    const keeps = /export const ERASE_KEEPS = \[([\s\S]*?)\] as const;/.exec(src("packages", "core", "src", "deletion", "erase-home.ts"))![1]!;
    expect(keeps).toContain("the apps' own folders: their browser cookies and the key that signs your approvals");
    expect(page).toContain("the apps' own folders: their browser cookies and the key that signs your approvals");
    expect(page).toContain("files your bots or agents wrote outside MOSS's folder");
    expect(keeps).toContain("files your bots or agents wrote outside MOSS's folder");
    expect(src("packages", "core", "src", "deletion", "erase-command.ts")).toContain('export const ERASE_WORD = "ERASE"');
    expect(page).toContain("`moss erase`");
    expect(src("plugins", "moss", "plugins", "settings", "client", "strings.ts")).toContain('eraseEverything: "Erase everything"');
  });

  test("deleting, as the archiving page says it", () => {
    const src = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf8");
    const archiving = readFileSync(join(SITE_DIR, "content", "docs", "archiving.md"), "utf8");
    const settings = src("apps", "moss", "src", "window", "settings", "SettingsPage.tsx");
    expect(settings).toContain(">Delete the conversation with {rec.name}</button>");
    expect(settings).toContain(">Delete {rec.name}</button>");
    expect(settings).toContain('<Card title="Archived bots"');
    expect(src("packages", "core", "src", "deletion", "session-rpc.ts")).toContain('"Your other computers keep their copies until you delete it there too. This computer never takes them back."');
    expect(archiving).toContain("Your other computers keep their copies until you delete it there too, and this computer never takes them back.");
    expect(src("packages", "cli", "src", "delete-cli.ts")).toContain('export const DELETE_WORD = "DELETE"');
    expect(archiving).toContain("after you type DELETE");
  });

  test("a local model server, as the setup page says it", () => {
    const guide = readFileSync(join(REPO_ROOT, "apps", "moss", "src", "window", "setup", "SetupGuide.tsx"), "utf8");
    const setup = readFileSync(join(SITE_DIR, "content", "docs", "setup.md"), "utf8");
    expect(guide).toContain('checkAgain: "Check again"');
    expect(guide).toContain("isn't running: start it, then check again.");
    expect(setup).toContain("press **Check again**");
    expect(readFileSync(join(REPO_ROOT, "packages", "core", "src", "setup-state.ts"), "utf8")).toContain("A local server that answers is a provider the person has");
  });

  test("the keys are where the page says", () => {
    expect(keychainService("dist")).toBe("com.waifucave.moss.core");
    const store = readFileSync(join(REPO_ROOT, "packages", "core", "src", "secrets", "moss-secret-store.ts"), "utf8");
    expect(store).toContain("vault(`${o.service}.key`)");
    expect(page).toContain("`com.waifucave.moss.core.key`");
    expect(page).toContain("`~/.moss/secrets.enc`");
  });
});

describe("the reference pages name what the SDK and the engine really have", () => {
  const doc = (slug: string) => readFileSync(join(SITE_DIR, "content", "docs", `${slug}.md`), "utf8");
  const named = (page: string) => new Set([...page.matchAll(/`([A-Za-z$][A-Za-z0-9.$]*)`/g)].map((m) => m[1]!));

  test("the manifest page names every field of moss.json, and none it hasn't", () => {
    const page = named(doc("manifest"));
    const top = Object.keys(ManifestSchema.shape);
    for (const k of top) expect([k, page.has(k)]).toEqual([k, true]);
    // The retired `bot` point is left out on purpose: bots are made in the app.
    for (const k of CORE_CONTRIBUTION_KEYS.filter((k) => k !== "bot")) expect([k, page.has(k)]).toEqual([k, true]);
    for (const k of Object.keys(SettingSchema.shape)) expect([k, page.has(k)]).toEqual([k, true]);
    const host = (ManifestSchema.shape.host.unwrap() as unknown as { shape: Record<string, unknown> }).shape;
    for (const k of Object.keys(host)) expect([k, page.has(k)]).toEqual([k, true]);
  });

  test("the agent page names every field of an agentBackends entry", () => {
    const page = named(doc("agent-plugin"));
    for (const k of Object.keys(AgentBackendSchema.shape).filter((k) => k !== "handler" && k !== "declares")) expect([k, page.has(k)]).toEqual([k, true]);
    expect(AgentBackendSchema.shape.protocol.options).toContain("acp");
  });

  test("the window page lists every spot the catalog has, and the fields a theme and a ui entry take", () => {
    const text = doc("window-parts");
    const rows = new Set([...text.matchAll(/^\| `([a-z.]+)` \|/gm)].map((m) => m[1]!));
    const spots = SPOTS.map((s) => s.name);
    for (const name of spots) expect([name, rows.has(name)]).toEqual([name, true]);
    for (const name of rows) if (name.includes(".") || spots.includes(name)) expect([name, spots.includes(name)]).toEqual([name, true]);
    const page = named(text);
    for (const k of ["appearance", "tokens", "dark", "css", "fonts", "icons"]) expect([k, k in ThemeSchema.shape, page.has(k)]).toEqual([k, true, true]);
    for (const k of ["spot", "key", "id", "style", "hide", "target", "component", "web", "order", "when"]) expect([k, k in UiSchema.shape, page.has(k)]).toEqual([k, true, true]);
    const composer = SPOTS.find((s) => s.name === "composer.action")!.doc;
    for (const key of ["attach", "model", "level", "send", "stop"]) expect(composer).toContain(`\`${key}\``);
  });

  test("the computers page's server commands are the ones the engine has", () => {
    // Read from the source, not imported: server-install.ts imports the whole engine, which the site's typecheck doesn't take.
    const SERVER_USAGE = /export const SERVER_USAGE = "([^"]+)"/.exec(readFileSync(join(REPO_ROOT, "packages", "cli", "src", "server-install.ts"), "utf8"))![1]!;
    expect(SERVER_USAGE).toContain("server install");
    expect(SERVER_USAGE).toContain("server uninstall");
    const page = doc("computers");
    expect(page).toContain("server install\n");
    expect(page).toContain("~/.moss/bin/daemon/moss-core server uninstall");
    expect(engineBinaryPath("~/.moss", "linux")).toBe("~/.moss/bin/daemon/moss-core");
  });
});
