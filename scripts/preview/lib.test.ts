import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_SHIMS, PREVIEW_BANNER, PREVIEW_PREFIX, UsageError, WATCHED, appArgs, appEnv, baseEnv, daemonEnv, isolationProblems, layoutFor, ownRoot, parseOptions, parseRecord, previewPath, refusal, reloads, sameProcess, shimScript } from "./lib";

const layout = layoutFor("/tmp/mprev-abc123");
const input = { layout, service: "com.waifucave.moss.core.test.preview-deadbeef", bunDir: "/cache/moss-bun/1.2.3" };
const REAL = "/Users/someone";

describe("options", () => {
  test("the commands", () => {
    expect(parseOptions([])).toMatchObject({ mode: "start", once: false, headless: false });
    expect(parseOptions(["--once"]).once).toBe(true);
    expect(parseOptions(["--stop"]).mode).toBe("stop");
    expect(parseOptions(["--headless", "--shot", "/x/a.png", "--appearance", "dark"])).toMatchObject({ headless: true, shot: "/x/a.png", appearance: "dark" });
  });
  test("what is refused", () => {
    for (const bad of [["--headless"], ["--shot", "a.png"], ["--shot", "a.txt", "--headless"], ["--stop", "--once"], ["--appearance", "blue"], ["--nope"], ["--appearance"]]) {
      expect(() => parseOptions(bad)).toThrow(UsageError);
    }
  });
});

describe("the refusal to start where it must not", () => {
  test("CI, a test run, a run holding the acceptance's keychain, another OS", () => {
    expect(refusal({}, "darwin")).toBeUndefined();
    expect(refusal({ CI: "true" }, "darwin")).toContain("CI");
    expect(refusal({ CI: "1" }, "darwin")).toBeDefined();
    expect(refusal({ GITHUB_ACTIONS: "true" }, "darwin")).toBeDefined();
    expect(refusal({ NODE_ENV: "test" }, "darwin")).toContain("test run");
    expect(refusal({ MOSS_TEST_KEYCHAIN: "/x" }, "darwin")).toBeDefined();
    expect(refusal({ MOSS_ACCEPTANCE_RUN_PID: "5" }, "darwin")).toBeDefined();
    expect(refusal({}, "linux")).toContain("macOS");
    expect(refusal({ CI: "false" }, "darwin")).toBeUndefined();
  });

  test("the command itself exits before it makes any folder or record", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mprev-test-"));
    try {
      const r = spawnSync(process.execPath, [join(import.meta.dir, "run.ts"), "--once"], { env: { PATH: process.env.PATH ?? "", TMPDIR: tmp, CI: "1" }, encoding: "utf8", timeout: 30_000 });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("CI run");
      expect(readdirSync(tmp)).toEqual([]);
      // Under a test run (bun test sets NODE_ENV=test for itself; handed on, the command refuses the same).
      const t = spawnSync(process.execPath, [join(import.meta.dir, "run.ts"), "--stop"], { env: { PATH: process.env.PATH ?? "", TMPDIR: tmp, NODE_ENV: "test" }, encoding: "utf8", timeout: 30_000 });
      expect(t.status).toBe(2);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the isolation list", () => {
  const daemon = daemonEnv({ ...input, runPid: 4242, usageInert: { MOSS_USAGE_INERT: "1" } });
  const visible = appEnv({ ...input, headless: false, appearance: "system" });
  const headless = appEnv({ ...input, headless: true, appearance: "dark" });

  test("every path the engine and the app are given is inside the preview's own folder, with a throwaway keychain and service", () => {
    for (const env of [daemon, visible, headless]) expect(isolationProblems(env, layout, REAL)).toEqual([]);
    expect(daemon.MOSS_HOME).toBe("/tmp/mprev-abc123/user/.moss");
    expect(daemon.HOME).toBe("/tmp/mprev-abc123/user");
    expect(daemon.MOSS_TEST_KEYCHAIN).toBe("/tmp/mprev-abc123/kc/preview.keychain-db");
    expect(daemon.MOSS_KEYCHAIN_SERVICE).toMatch(/\.test\.preview-[0-9a-f]+$/);
    expect(daemon.MOSS_PROFILE).toBe("dev");
    expect(daemon.MOSS_LOGIN_SHELL_PATH).toBe("off");
  });

  test("the environment is a whitelist: nothing of the person's comes along, and the PATH is the preview's own", () => {
    for (const env of [daemon, visible, headless]) {
      expect(Object.keys(env).every((k) => /^(PATH|HOME|TMPDIR|LANG|MOSS_[A-Z_]+)$/.test(k))).toBe(true);
      expect(env.PATH!.split(":")[0]).toBe(layout.bin);
      expect(env.PATH).toBe(previewPath(layout.bin, input.bunDir));
    }
  });

  test("the window's app: no debugging door when visible; the dev opt-in only when headless, on its one loopback port", () => {
    expect(visible.MOSS_DEV_DEBUG).toBeUndefined();
    expect(headless.MOSS_DEV_DEBUG).toBe("1");
    const v = appArgs({ desktopDir: "/repo/apps/desktop", headless: false });
    expect(v.join(" ")).not.toMatch(/remote-debugging|inspect|headless/);
    expect(v).toContain("--mute-audio");
    expect(v).toContain("--use-mock-keychain");
    const h = appArgs({ desktopDir: "/repo/apps/desktop", headless: true, port: 9333 });
    expect(h).toContain("--moss-headless");
    expect(h).toContain("--remote-debugging-port=9333");
  });

  test("the app says what it is, its daemon is a stub that only fails, no login-item, host or updater variable is set", () => {
    expect(visible.MOSS_PREVIEW_BANNER).toBe(PREVIEW_BANNER);
    expect(PREVIEW_BANNER).toMatch(/PREVIEW/);
    expect(visible.MOSS_DAEMON_BIN).toBe(layout.stubBin);
    for (const env of [daemon, visible, headless]) for (const k of ["MOSS_HOST_COMMAND", "MOSS_APP_HEADLESS", "MOSS_OLD_HOME", "MOSS_USER_DATA", "MOSS_TEST_INVISIBLE", "MOSS_TEST_UPDATE_OUTCOME"]) expect(env[k]).toBeUndefined();
    expect(visible.MOSS_PREVIEW_APPEARANCE).toBeUndefined();
    expect(headless.MOSS_PREVIEW_APPEARANCE).toBe("dark");
  });

  test("a leak is found: the person's own home, a path outside, a PATH of theirs, a login-keychain service, a host command", () => {
    const bad = { ...baseEnv(input), MOSS_HOME: `${REAL}/.moss`, PATH: `${layout.bin}:${REAL}/bin:/usr/bin`, MOSS_KEYCHAIN_SERVICE: "com.waifucave.moss.core", MOSS_HOST_COMMAND: "[\"x\"]", TMPDIR: "/var/folders/x" };
    const found = isolationProblems(bad, layout, REAL).join(" | ");
    expect(found).toContain("MOSS_HOME is");
    expect(found).toContain("person's own home");
    expect(found).toContain("PATH names /Users/someone/bin");
    expect(found).toContain("not a throwaway one");
    expect(found).toContain("MOSS_HOST_COMMAND must not be set");
    expect(found).toContain("TMPDIR");
  });

  test("the shims stand in for the three agents' programs on the preview's own PATH only", () => {
    expect(AGENT_SHIMS.map((s) => s.command).sort()).toEqual(["claude-agent-acp", "codex-acp", "gemini"]);
    const text = shimScript({ bun: "/b/bun", fake: "/r/fake.ts", config: "/c/o'k.json" });
    expect(text).toContain("--version");
    expect(text).toContain("'/c/o'\\''k.json'");
    expect(text.startsWith("#!/bin/sh")).toBe(true);
  });
});

describe("the record and what --stop may end", () => {
  test("a record is read back, and anything else is not a record", () => {
    const r = { v: 1, pid: 12, start: "Sat Nov 22 10:00:00 2026", root: "/tmp/mprev-x", at: 5, children: [{ pid: 13, start: "s", what: "engine" }, { pid: "x" }] };
    expect(parseRecord(JSON.stringify(r))).toMatchObject({ pid: 12, root: "/tmp/mprev-x", children: [{ pid: 13, start: "s", what: "engine" }] });
    for (const bad of ["", "{", "[]", JSON.stringify({ v: 2, pid: 1, start: "", root: "", children: [] }), JSON.stringify({ v: 1, pid: "1" })]) expect(parseRecord(bad)).toBeUndefined();
  });
  test("a pid is the recorded process only while its start time is the same (a reused pid is not it)", () => {
    expect(sameProcess("Sat Nov 22 10:00:00 2026", "Sat Nov 22 10:00:00 2026")).toBe(true);
    expect(sameProcess("Sat Nov 22 10:00:00 2026", "Sat Nov 22 11:30:00 2026")).toBe(false);
    expect(sameProcess("Sat Nov 22 10:00:00 2026", undefined)).toBe(false);
    expect(sameProcess("", "")).toBe(false);
  });
  test("only the command's own temp folders are removed: its prefix, directly under the temp folder", () => {
    expect(ownRoot(`${tmpdir()}/${PREVIEW_PREFIX}abc123`, tmpdir())).toBe(true);
    expect(ownRoot(`${tmpdir()}/${PREVIEW_PREFIX}`, tmpdir())).toBe(false);
    expect(ownRoot(`${tmpdir()}/other-abc`, tmpdir())).toBe(false);
    expect(ownRoot(`${tmpdir()}/x/${PREVIEW_PREFIX}abc`, tmpdir())).toBe(false);
    expect(ownRoot(`${tmpdir()}/${PREVIEW_PREFIX}abc/../..`, tmpdir())).toBe(false);
    expect(ownRoot("/", tmpdir())).toBe(false);
    expect(ownRoot(`${process.env.HOME ?? "/Users/x"}/.moss`, tmpdir())).toBe(false);
  });
});

describe("what a reload watches", () => {
  test("a plugin's client folder, the base theme, the SDK's UI and the shell's own; not an engine file, a test, a swap file or a node module", () => {
    for (const yes of ["plugins/moss/plugins/canvas/client/canvas.tsx", "plugins/moss/plugins/canvas/client/styles/a.css", "plugins/moss/plugins/base-theme/theme.css", "packages/plugin-sdk/src/ui/index.tsx", "apps/desktop/src/layer/layer.css", "apps/desktop/src/core/root.ts"]) expect(reloads(yes)).toBe(true);
    for (const no of ["packages/core/src/daemon.ts", "plugins/moss/plugins/canvas/server/x.ts", "plugins/moss/plugins/canvas/client/a.tsx~", "plugins/moss/plugins/canvas/client/.a.swp", "plugins/moss/plugins/canvas/node_modules/x/client/a.js", "apps/desktop/src/main/index.ts", "docs/a.md"]) expect(reloads(no)).toBe(false);
    expect(WATCHED.length).toBeGreaterThan(2);
    expect(existsSync(join(import.meta.dir, "..", "..", "plugins", "moss", "plugins"))).toBe(true);
  });
});
