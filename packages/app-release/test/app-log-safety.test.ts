// The shared log writer (src/app-log.ts) never writes through a symbolic link, and a looping caller can't rotate the log away.
import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLog, appLogPath, LineLimiter } from "../src/app-log";

const posix = process.platform !== "win32";

describe("the log writer and links", () => {
  test.skipIf(!posix)("a link planted as the log is not written through, not chmod-ed and not replaced", () => {
    const home = mkdtempSync(join(tmpdir(), "app-log-link-"));
    try {
      mkdirSync(join(home, "logs"), { recursive: true });
      const target = join(home, "victim.txt");
      writeFileSync(target, "keep me\n", { mode: 0o644 });
      const file = appLogPath(home);
      symlinkSync(target, file);
      const log = new AppLog(file);
      log.write("one line that must not reach the target");
      log.write("another");
      expect(readFileSync(target, "utf8")).toBe("keep me\n");
      expect(lstatSync(target).mode & 0o777).toBe(0o644); // not made owner-only through the link
      expect(lstatSync(file).isSymbolicLink()).toBe(true); // left as it is
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)("a link planted as the older file is not renamed over or written through", () => {
    const home = mkdtempSync(join(tmpdir(), "app-log-link-"));
    try {
      const file = appLogPath(home);
      const log = new AppLog(file, 300);
      log.write("first");
      const target = join(home, "victim.txt");
      writeFileSync(target, "keep me\n");
      symlinkSync(target, `${file}.1`);
      for (let i = 0; i < 20; i++) log.write(`line ${i} ${"x ".repeat(30)}`); // would rotate onto .1
      expect(readFileSync(target, "utf8")).toBe("keep me\n");
      expect(lstatSync(`${file}.1`).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)("a link planted AFTER the first line is refused too (each write looks again, and opens without following)", () => {
    const home = mkdtempSync(join(tmpdir(), "app-log-link-"));
    try {
      const file = appLogPath(home);
      const log = new AppLog(file);
      log.write("before");
      rmSync(file);
      const target = join(home, "victim.txt");
      writeFileSync(target, "keep me\n");
      symlinkSync(target, file);
      log.write("after");
      expect(readFileSync(target, "utf8")).toBe("keep me\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a plain log still works, owner-only", () => {
    const home = mkdtempSync(join(tmpdir(), "app-log-link-"));
    try {
      const file = appLogPath(home);
      new AppLog(file).write("hello");
      expect(readFileSync(file, "utf8")).toContain("hello");
      if (posix) expect(lstatSync(file).mode & 0o077).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the line limiter", () => {
  test("five lines per key per window, the rest counted and said on the first line after the quiet; another key is its own", () => {
    let t = 1_000;
    const l = new LineLimiter(5, 10_000, 256, () => t);
    const said = Array.from({ length: 12 }, () => l.check("frame:1")).map((r) => r.ok);
    expect(said).toEqual([true, true, true, true, true, false, false, false, false, false, false, false]);
    expect(l.check("frame:2")).toEqual({ ok: true, left: 0 });
    t += 10_000;
    expect(l.check("frame:1")).toEqual({ ok: true, left: 7 });
    expect(l.check("frame:1")).toEqual({ ok: true, left: 0 });
  });

  test("it keeps a bounded number of keys", () => {
    const l = new LineLimiter(1, 10_000, 4, () => 1);
    for (let i = 0; i < 100; i++) l.check(`k${i}`);
    expect(l.check("k0")).toEqual({ ok: true, left: 0 }); // long forgotten: a fresh key
  });
});
