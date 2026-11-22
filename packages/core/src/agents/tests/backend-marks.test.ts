// The agent plugins' marks (lane CA, the owner's ruling of 2026-11-21: each plugin ships its mark; removing one is its
// file and its manifest line). Every shipped mark is served by the real reader from the real bundled folders; with a mark's
// file removed, or its manifest line, the plugin still runs and its backend is offered, with no icon (the SDK draws the
// fallback letter mark) and its colours kept.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendLooks } from "../backend-look";
import { EngineBackendIcons } from "../backend-icons";
import { contributedBackends } from "../plugin-backends";
import { BUNDLED_PLUGINS_DIR } from "../testing/bundled-backends";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const AGENT_PLUGINS = readdirSync(BUNDLED_PLUGINS_DIR).filter((n) => n.startsWith("agent-"));
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, "moss.json"), "utf8")) as { contributes: { agentBackends: { id: string; icon?: string; color?: string; color2?: string }[] } };

/** The one-plugin registry `BackendLooks` reads. */
function registryOf(dir: string) {
  const m = manifestOf(dir);
  const record = { id: "moss/agent-codex", folder: dir, treeHash: "h", state: "running" as const, provenance: { by: "bundled" } };
  return {
    entries: () => m.contributes.agentBackends.map((value) => ({ pluginId: "moss/agent-codex", entryId: value.id, state: "active", value })),
    get: () => record,
  } as never;
}

describe("the shipped marks", () => {
  test("there are thirteen agent plugins, each with a mark file its manifest names (the manifests validate and run in plugin-backends.test.ts)", async () => {
    expect(AGENT_PLUGINS).toHaveLength(13);
    for (const d of AGENT_PLUGINS) {
      const dir = join(BUNDLED_PLUGINS_DIR, d);
      const b = manifestOf(dir).contributes.agentBackends[0]!;
      expect(b.icon, d).toBeDefined();
      const r = await new EngineBackendIcons().read(dir, b.icon!);
      expect("icon" in r, `${d}: ${JSON.stringify(r)}`).toBe(true);
    }
  });

  test("removing a mark's file, or its manifest line, leaves a working plugin with no icon and its colours", async () => {
    for (const how of ["file", "line"] as const) {
      const root = mkdtempSync(join(tmpdir(), "moss-marks-"));
      temps.push(root);
      const dir = join(root, "agent-codex");
      cpSync(join(BUNDLED_PLUGINS_DIR, "agent-codex"), dir, { recursive: true });
      const m = manifestOf(dir);
      const entry = m.contributes.agentBackends[0]!;
      if (how === "file") rmSync(join(dir, entry.icon!));
      else { delete entry.icon; writeFileSync(join(dir, "moss.json"), JSON.stringify(m)); }
      const lines: string[] = [];
      const looks = await new BackendLooks({ registry: registryOf(dir), icons: new EngineBackendIcons(), log: (l) => lines.push(l) }).ofAll(["codex"]);
      expect(looks.get("codex"), how).toEqual({ color: "#484FF6", color2: "#7893F9" });
      // The plugin's backend is still offered.
      expect(contributedBackends(registryOf(dir)).map((c) => c.id), how).toEqual(["codex"]);
      // The missing file is said once; a removed line is nothing to say.
      expect(lines.length, how).toBe(how === "file" ? 1 : 0);
    }
  });
});

describe("MOSS's own coding agent's mark", () => {
  test("is MOSS Code's Shards mark, bare, one file for each theme, in the mark's gold (never MOSS's face or coral)", async () => {
    const { MOSS_CODE_COLOR, MOSS_CODE_ICON, MOSS_CODE_ICON_DARK } = await import("../moss-code/look");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const brand = (f: string) => readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "assets", "brand", "moss-code", "mark", f), "utf8").trim();
    expect(Buffer.from(MOSS_CODE_ICON.data, "base64").toString()).toBe(brand("shards-mark-on-light.svg"));
    expect(Buffer.from(MOSS_CODE_ICON_DARK.data, "base64").toString()).toBe(brand("shards-mark-on-dark.svg"));
    expect(MOSS_CODE_COLOR).toBe("#E5A72E");
    expect(Buffer.from(MOSS_CODE_ICON.data, "base64").toString()).not.toContain("F0694C");
  });
});

describe("the OpenCode, Copilot, Qwen and Kimi plugins (lane AP)", () => {
  const LOOKS: Record<string, { color?: string; command: string; args: string[]; version: string; got: string }> = {
    opencode: { command: "opencode", args: ["acp"], version: "v2.2.5\n", got: "2.2.5" },
    copilot: { color: "#218BFF", command: "copilot", args: ["--acp"], version: "GitHub Copilot CLI 1.0.109.\nRun 'copilot update' to check for updates.\n", got: "1.0.109" },
    qwen: { color: "#082DFF", command: "qwen", args: ["--acp"], version: "0.26.5\n", got: "0.26.5" },
    kimi: { color: "#1783FF", command: "kimi", args: ["acp"], version: "2.4.1\n", got: "2.4.1" },
  };

  test("each one's entry, mark and colour are as the owner's ruling says, and its mark passes the engine's icon screen", async () => {
    for (const [id, want] of Object.entries(LOOKS)) {
      const dir = join(BUNDLED_PLUGINS_DIR, `agent-${id}`);
      const entry = manifestOf(dir).contributes.agentBackends[0]! as { id: string; command: string; args: string[]; protocol: string; icon: string; color?: string; iconDark?: string };
      expect(entry, id).toMatchObject({ id, protocol: "acp", command: want.command, args: want.args, icon: `${id}.svg` });
      expect(entry.color, id).toBe(want.color);
      expect(entry.iconDark, id).toBe(id === "kimi" ? "kimi-dark.svg" : undefined);
      if (entry.iconDark !== undefined) expect("icon" in (await new EngineBackendIcons().read(dir, entry.iconDark)), id).toBe(true);
      const r = await new EngineBackendIcons().read(dir, entry.icon);
      expect("icon" in r, `${id}: ${JSON.stringify(r)}`).toBe(true);
    }
  });

  test("Kimi's two marks are bare, the K black on light and white on dark, the dot the vendor's blue, no currentColor (drawn as pictures)", () => {
    const read = (f: string) => readFileSync(join(BUNDLED_PLUGINS_DIR, "agent-kimi", f), "utf8");
    for (const [file, k] of [["kimi.svg", "#000000"], ["kimi-dark.svg", "#FFFFFF"]] as const) {
      const svg = read(file);
      expect(svg, file).not.toContain("<rect");
      expect(svg, file).not.toMatch(/currentColor/i);
      expect(svg, file).toContain(`fill="${k}"`);
      expect(svg, file).toContain('fill="#1783FF"');
    }
    // Only the K's fill differs between the two files.
    expect(read("kimi.svg").replace('fill="#000000"', 'fill="#FFFFFF"')).toBe(read("kimi-dark.svg"));
  });

  test("any plugin's iconDark is served beside its icon; a bad or missing one is no iconDark, the icon stays, one line is logged; the other plugins' looks are as before", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-icondark-"));
    temps.push(root);
    const dir = join(root, "agent-kimi");
    cpSync(join(BUNDLED_PLUGINS_DIR, "agent-kimi"), dir, { recursive: true });
    const looks = async (d: string, log: (l: string) => void) => (await new BackendLooks({ registry: registryOf(d), icons: new EngineBackendIcons(), log }).ofAll(["kimi"])).get("kimi")!;
    const lines: string[] = [];
    const ok = await looks(dir, (l) => lines.push(l));
    expect(ok.icon?.mediaType).toBe("image/svg+xml");
    expect(ok.iconDark?.mediaType).toBe("image/svg+xml");
    expect(Buffer.from(ok.iconDark!.data, "base64").toString()).toContain('fill="#FFFFFF"');
    expect(ok.color).toBe("#1783FF");
    expect(lines).toEqual([]);
    for (const how of ["missing", "script"] as const) {
      if (how === "missing") rmSync(join(dir, "kimi-dark.svg"));
      else writeFileSync(join(dir, "kimi-dark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>1</script></svg>');
      const l2: string[] = [];
      const got = await looks(dir, (l) => l2.push(l));
      expect(got.icon, how).toBeDefined();
      expect(got.iconDark, how).toBeUndefined();
      expect(l2.length, how).toBe(1);
      expect(l2[0], how).toContain("iconDark");
    }
    // The other twelve plugins name no iconDark, so none is served for them.
    for (const d of AGENT_PLUGINS.filter((n) => n !== "agent-kimi")) expect(manifestOf(join(BUNDLED_PLUGINS_DIR, d)).contributes.agentBackends[0], d).not.toHaveProperty("iconDark");
  });

  test("each one's version pattern reads the real `--version` line, and nothing from an unrelated tool", () => {
    for (const [id, want] of Object.entries(LOOKS)) {
      const q = JSON.parse(readFileSync(join(BUNDLED_PLUGINS_DIR, `agent-${id}`, "quirks.json"), "utf8")).quirks.launch.identity as { versionPattern: string };
      const re = new RegExp(q.versionPattern, "m");
      const m = re.exec(want.version);
      expect(m?.[1], id).toBe(want.got);
      expect(re.test("grok 1.0.70 (abc123)"), id).toBe(false);
    }
  });
});
