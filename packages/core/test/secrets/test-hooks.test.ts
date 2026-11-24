import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renameRetryDelays, testHooksAllowed } from "../../src/secrets/private-file";

// Lane SE, round 3: the secrets' test hooks are inert in every real build, decided at build time; renames on Windows
// wait out an antivirus scan, for a bounded time.

describe("the test hooks (setWindowsAclForTests, setSecretStatForTests)", () => {
  test("inert where the build defines __MOSS_TEST_BUILD__=false (every real build, dev and release); live from source and in a test-marked build", () => {
    expect(testHooksAllowed(false)).toBe(false);
    expect(testHooksAllowed(undefined)).toBe(true); // `bun test` from source
    expect(testHooksAllowed("acceptance-label")).toBe(true); // a test-marked build
    expect(testHooksAllowed()).toBe(true); // this process: from source
  });

  test("each hook goes through the check, and nothing in the environment is read for it", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/secrets/private-file.ts"), "utf8");
    for (const hook of ["setWindowsAclForTests", "setSecretStatForTests"]) {
      const line = src.split("\n").find((l) => l.startsWith(`export function ${hook}(`));
      expect([hook, line?.includes("if (testHooksAllowed())")]).toEqual([hook, true]);
    }
    const fn = src.slice(src.indexOf("export function testHooksAllowed("), src.indexOf("export function renameRetryDelays("));
    expect(fn).not.toContain("process.env");
  });

  test("every real build defines the marker false (the build script's own define)", () => {
    const build = readFileSync(join(import.meta.dir, "../../../../scripts/build-daemon.ts"), "utf8");
    expect(build).toContain("__MOSS_TEST_BUILD__=false");
  });
});

describe("renames on Windows wait out an antivirus scan, bounded", () => {
  test("Windows doubles from 25 ms to at most 1 s, about 5.6 s in all; elsewhere 300 ms as before", () => {
    const win = renameRetryDelays("win32");
    expect(win[0]).toBe(25);
    expect(Math.max(...win)).toBe(1000);
    expect(win.reduce((a, b) => a + b, 0)).toBe(5575);
    const posix = renameRetryDelays("linux");
    expect(posix.reduce((a, b) => a + b, 0)).toBe(300);
  });
});
