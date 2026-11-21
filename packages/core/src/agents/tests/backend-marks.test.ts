// The nine agent plugins' marks (lane CA, the owner's ruling of 2026-11-21: each plugin ships its mark; removing one is its
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

const NINE = readdirSync(BUNDLED_PLUGINS_DIR).filter((n) => n.startsWith("agent-"));
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
  test("there are nine agent plugins, each with a mark file its manifest names,  (the manifests validate and run in plugin-backends.test.ts)", async () => {
    expect(NINE).toHaveLength(9);
    for (const d of NINE) {
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
