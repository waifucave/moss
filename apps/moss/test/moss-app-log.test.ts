// MOSS's own log file: the shared writer (packages/app-release/src/app-log.ts, the one MOSS Code's app.log uses) under its own
// name, so the two programs' lines never interleave; the same size cap and owner-only mode; and index.ts wires it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_LOG_FILE, APP_LOG_MAX_BYTES, AppLog, appLogPath, MOSS_APP_LOG_FILE } from "@waifucave/moss-app-release/app-log";

describe("MOSS's log file", () => {
  test("it is <home>/logs/moss-app.log, beside MOSS Code's app.log and never in it", () => {
    const home = mkdtempSync(join(tmpdir(), "moss-app-log-"));
    try {
      expect(appLogPath(home, MOSS_APP_LOG_FILE)).toBe(join(home, "logs", "moss-app.log"));
      expect(appLogPath(home)).toBe(join(home, "logs", APP_LOG_FILE));
      const moss = new AppLog(appLogPath(home, MOSS_APP_LOG_FILE));
      const code = new AppLog(appLogPath(home));
      moss.write("send: refused by the press check (the write came too late, 151 ms past its bound)");
      code.write("press: a call from frame 1:2 found no press of its own");
      expect(readFileSync(join(home, "logs", "moss-app.log"), "utf8")).toContain("send: refused by the press check");
      expect(readFileSync(join(home, "logs", "moss-app.log"), "utf8")).not.toContain("press: a call from frame");
      expect(readFileSync(join(home, "logs", "app.log"), "utf8")).not.toContain("send: refused");
      if (process.platform !== "win32") expect(statSync(join(home, "logs", "moss-app.log")).mode & 0o077).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the same cap as MOSS Code's, a line never carries a URL's query or a long token, and a log that can't be written stops nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "moss-app-log-"));
    try {
      const log = new AppLog(appLogPath(home, MOSS_APP_LOG_FILE), 600);
      for (let i = 0; i < 20; i++) log.write(`line ${i} ${"x ".repeat(40)}`);
      expect(readdirSync(join(home, "logs")).sort()).toEqual(["moss-app.log", "moss-app.log.1"]);
      expect(APP_LOG_MAX_BYTES).toBe(1_000_000);
      const one = new AppLog(appLogPath(home, "one.log"));
      one.write("open https://example.test/cb?code=SECRET123 with abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
      const text = readFileSync(join(home, "logs", "one.log"), "utf8");
      expect(text).not.toContain("SECRET123");
      expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(() => new AppLog("/dev/null/nope/moss-app.log").write("x")).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("main's log() writes through it, and a refused send and a refused press name their check (the wiring, read from the source)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "main", "index.ts"), "utf8");
    expect(src).toContain('new AppLog(appLogPath(home, MOSS_APP_LOG_FILE))');
    expect(src).toMatch(/console\.log\(`moss: \$\{line\}`\);\s*appLog\.write\(line\);/);
    expect(src).toContain("refused by the press check (");
    const engine = readFileSync(join(import.meta.dir, "..", "src", "main", "engine.ts"), "utf8");
    expect(engine).toContain("send: the engine took nothing (");
    // Never the error's own words: the engine's message can quote the call.
    expect(engine.slice(engine.indexOf("send: the engine took nothing"), engine.indexOf("send: the engine took nothing") + 200)).not.toContain("err.message");
  });
});
