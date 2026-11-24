// The shared log writer (src/app-log.ts) never writes through a symbolic link, and a looping caller can't rotate the log away.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  test.skipIf(!posix)("an existing log and older file that others could read are made owner-only, through the opened descriptor", () => {
    const home = mkdtempSync(join(tmpdir(), "app-log-mode-"));
    try {
      const file = appLogPath(home);
      mkdirSync(join(home, "logs"), { recursive: true });
      writeFileSync(file, "old\n", { mode: 0o644 });
      writeFileSync(`${file}.1`, "older\n", { mode: 0o644 });
      chmodSync(file, 0o644);
      chmodSync(`${file}.1`, 0o644);
      new AppLog(file).write("hello");
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
      expect(lstatSync(`${file}.1`).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)("a hard link planted as the older file is not chmod-ed (it may be somebody else's file), and a pipe planted there does not hang the write", () => {
    const home = mkdtempSync(join(tmpdir(), "app-log-hard-"));
    try {
      const file = appLogPath(home);
      mkdirSync(join(home, "logs"), { recursive: true });
      const target = join(home, "victim.txt");
      writeFileSync(target, "keep me\n");
      chmodSync(target, 0o644);
      linkSync(target, `${file}.1`);
      new AppLog(file).write("hello");
      expect(lstatSync(target).mode & 0o777).toBe(0o644);
      expect(readFileSync(target, "utf8")).toBe("keep me\n");
      rmSync(`${file}.1`);
      execFileSync("mkfifo", [`${file}.1`]);
      new AppLog(file).write("after the pipe"); // returns: the open does not wait for a writer
      expect(readFileSync(file, "utf8")).toContain("after the pipe");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix)("the append path: a hard link planted as the log is not appended to, and a pipe planted as the log does not block the open", () => {
    const home = mkdtempSync(join(tmpdir(), "app-log-append-"));
    try {
      const file = appLogPath(home);
      mkdirSync(join(home, "logs"), { recursive: true });
      const target = join(home, "victim.txt");
      writeFileSync(target, "keep me\n");
      linkSync(target, file); // the log is a second name of somebody's file
      const log = new AppLog(file);
      log.write("one line that must not reach the target");
      log.write("another");
      expect(readFileSync(target, "utf8")).toBe("keep me\n");
      // The same on a log that was fine when the first line went in and was swapped for a link after it (each write looks again).
      const home2 = mkdtempSync(join(tmpdir(), "app-log-append-"));
      try {
        const f2 = appLogPath(home2);
        const log2 = new AppLog(f2);
        log2.write("before");
        const t2 = join(home2, "victim2.txt");
        writeFileSync(t2, "keep me too\n");
        rmSync(f2);
        linkSync(t2, f2);
        log2.write("after");
        expect(readFileSync(t2, "utf8")).toBe("keep me too\n");
      } finally {
        rmSync(home2, { recursive: true, force: true });
      }
      // A pipe: with no reader the open fails at once (the write returns); with a reader it is opened, found not to be a plain file, and not written.
      rmSync(file);
      execFileSync("mkfifo", [file]);
      const started = Date.now();
      new AppLog(file).write("must not block main");
      expect(Date.now() - started).toBeLessThan(2_000);
      const reader = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); // a reader is there now
      try {
        new AppLog(file).write("not into a pipe");
        let got = 0;
        try { got = readSync(reader, Buffer.alloc(256)); } catch { got = 0; } // EAGAIN: nothing in the pipe
        expect(got).toBe(0);
      } finally {
        closeSync(reader);
      }
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
