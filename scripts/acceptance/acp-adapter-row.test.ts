// The adapter row's own parts, held without a run: its fixture, with the run's paths and the package's integrity written in,
// is a valid plugin whose one entry is an ACP backend declaring an adapter, and the package it names unpacks with MOSS's own
// reader and is the one MOSS's store accepts for that integrity.
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdapterStore } from "../../packages/core/src/agents/adapter/store";
import { readAdapter, readQuirksFile } from "../../packages/core/src/agents/plugin-backends";
import { validatePluginFolder } from "../../packages/core/src/registry/validate";
import { tarballUrl } from "../../packages/core/src/agents/adapter/types";
import { FULL_STEPS } from "./steps";
import { ACP_BACKEND_STEP, FAKE_ACP_AGENT, fixtureWith } from "./acp-backend-step";
import { ADAPTER_ID, ADAPTER_PACKAGE, ADAPTER_VERSION, adapterFiles, sriOf } from "./acp-adapter-row";
import { FAKE_NPM_HOST } from "./fake-exa";
import { publishNpm } from "./plugin-world";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const FIXTURE = resolve(import.meta.dir, "fixtures", "acceptance-acp-adapter");

test("the row is part of the acp unit's step, and the fixture holds placeholders only for the run's values", () => {
  expect(FULL_STEPS).toContain(ACP_BACKEND_STEP);
  expect(ACP_BACKEND_STEP).toContain("adapter MOSS provides");
  const all = ["moss.json", "quirks.json"].map((f) => readFileSync(join(FIXTURE, f), "utf8")).join("\n");
  expect([...new Set(all.match(/__[A-Z]+__/g))].sort()).toEqual(["__CONFIG__", "__INTEGRITY__"]);
});

test("with the run's values in, the fixture validates, its declaration reads, and the published package is the one MOSS's store accepts for it", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lane-ad-row-")));
  temps.push(root);
  const world = join(root, "world");
  await publishNpm(world, ADAPTER_PACKAGE, ADAPTER_VERSION, adapterFiles({ fake: FAKE_ACP_AGENT, ran: join(root, "ran.ndjson") }));
  const bytes = new Uint8Array(readFileSync(join(world, FAKE_NPM_HOST, ADAPTER_PACKAGE, "-", `${ADAPTER_PACKAGE}-${ADAPTER_VERSION}.tgz`)));
  const folder = join(root, ADAPTER_ID);
  cpSync(FIXTURE, folder, { recursive: true });
  const written = fixtureWith({ "moss.json": readFileSync(join(folder, "moss.json"), "utf8"), "quirks.json": readFileSync(join(folder, "quirks.json"), "utf8") }, { bun: process.execPath, fake: FAKE_ACP_AGENT, config: join(root, "agent.json") });
  writeFileSync(join(folder, "moss.json"), written["moss.json"]!);
  writeFileSync(join(folder, "quirks.json"), written["quirks.json"]!.replaceAll("__INTEGRITY__", sriOf(bytes)));
  const v = await validatePluginFolder(folder, { os: "macos" });
  expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
  const file = readQuirksFile(folder, "quirks.json");
  const decl = readAdapter(folder, file.adapter!);
  expect(decl).toMatchObject({ package: ADAPTER_PACKAGE, version: ADAPTER_VERSION, integrity: sriOf(bytes), run: "dist/index.js", runtime: "moss-bun", packages: [] });
  // MOSS's store places exactly these bytes, and the run file is the one that starts the fake agent.
  const store = new AdapterStore({ home: join(root, "home"), download: async (url) => { expect(url).toBe(tarballUrl(`https://${FAKE_NPM_HOST}`, ADAPTER_PACKAGE, ADAPTER_VERSION)); return bytes; } });
  const ready = await store.ensure(decl);
  expect(readFileSync(ready.entry, "utf8")).toContain(FAKE_ACP_AGENT);
});
