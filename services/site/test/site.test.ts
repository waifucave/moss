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
import { renderDoc } from "../src/markdown";
import { templateFiles } from "../../../packages/plugin-sdk/src/templates/index";
import { runCodeCommand } from "../../../packages/cli/src/code-cli";
import { MOSS_PLUGIN_VERBS, runPluginCommand, runPluginDev, runPluginList } from "../../../packages/cli/src/moss-plugin-cli";

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

  test("every `moss code` line runs as printed, in a shell with no MOSS_COMPUTER", async () => {
    const lines = commands.filter((c) => c.startsWith("moss code "));
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
    for (const c of commands) {
      const [, word, verb] = c.split(/\s+/);
      expect([c, top.has(word!)]).toEqual([c, true]);
      if (word === "plugin") expect([c, pluginVerbs.has(verb!)]).toEqual([c, true]);
    }
  });

  test("every printed plugin command runs as printed through the CLI's own code", async () => {
    const lines = commands.filter((c) => c.startsWith("moss plugin "));
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
    const answers: Record<string, unknown> = {
      "plugin.list": { plugins: [] }, "plugin.setEnabled": { applied: true }, "plugin.install": { id: "x", state: "found" },
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
    for (const c of commands) expect([c, /^moss plugin (enable|disable|install|remove|dev|info|logs)\s*$/.test(c)]).toEqual([c, false]);
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
