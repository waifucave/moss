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

  test("one window's frames together write at most 30 lines and the reserve a minute, however many keys they are; the lines left out are said on the first line after", () => {
    let t = 1_000;
    const l = new LineLimiter(5, 10_000, 256, () => t);
    // A plugin that makes a new frame for every line: each key is new, so no key's own limit ever applies.
    const written = Array.from({ length: 100 }, (_, i) => l.check(`press:${i}`, "w1")).filter((r) => r.ok).length;
    // The cap of 30, and the reserve of 10 first lines that frames not yet heard get at the cap (a new key each time spends it).
    expect(written).toBe(40);
    // Another window has its own count, and an ungrouped caller is limited by its key alone.
    expect(l.check("press:x", "w2")).toEqual({ ok: true, left: 0 });
    for (let i = 0; i < 10; i++) expect(l.check("press:u").ok).toBe(i < 5);
    // Within the minute nothing more from w1; at the next minute's first line the 70 left out are counted.
    t += 59_000;
    expect(l.check("press:late", "w1")).toEqual({ ok: false, left: 0 });
    t += 1_000;
    expect(l.check("press:again", "w1")).toEqual({ ok: true, left: 60 + 1 });
    expect(l.check("press:again2", "w1")).toEqual({ ok: true, left: 0 });
  });

  test("a line the key's own limit refuses in a new minute does not lose the group's count, and the groups kept are bounded", () => {
    let t = 0;
    const l = new LineLimiter(1, 120_000, 256, () => t, 2, 60_000, 3, 0);
    expect(l.check("a", "g").ok).toBe(true);
    expect(l.check("b", "g").ok).toBe(true);
    expect(l.check("c", "g").ok).toBe(false); // the group's cap of 2: one left out
    t += 60_000;
    expect(l.check("a", "g")).toEqual({ ok: false, left: 0 }); // the key's own limit (one per two minutes); the count of 1 stays
    expect(l.check("d", "g")).toEqual({ ok: true, left: 1 });
    for (let i = 0; i < 100; i++) l.check(`k${i}`, `g${i}`);
    expect(l.check("e", "g")).toEqual({ ok: true, left: 0 }); // long forgotten: a fresh group
  });

  test("a looping frame cannot bury the first line of a frame that has not spoken: a reserve per group, once per frame, bounded", () => {
    let t = 1_000;
    const l = new LineLimiter(5, 10_000, 256, () => t);
    // One frame loops across the whole minute: 5 lines per 10 s, 30 a minute, which is the group's cap.
    let looped = 0;
    for (let s = 0; s < 6; s++) { for (let i = 0; i < 50; i++) if (l.check("press:loop", "w1").ok) looped++; t += 10_000; }
    expect(looped).toBe(30);
    t -= 1_000;
    // The Settings frame has said nothing yet: its first line passes at the cap, and its second does not (the reserve is one line per frame).
    expect(l.check("press:settings", "w1").ok).toBe(true);
    expect(l.check("press:settings", "w1").ok).toBe(false);
    expect(l.check("press:loop", "w1").ok).toBe(false);
    // Another window is untouched, and the reserve is bounded: 10 frames at most get a first line at the cap.
    expect(l.check("press:s", "w2").ok).toBe(true);
    const firsts = Array.from({ length: 30 }, (_, i) => l.check(`press:new${i}`, "w1")).filter((r) => r.ok).length;
    expect(firsts).toBe(9); // the settings frame used 1 of the 10
  });

  test("it keeps a bounded number of keys", () => {
    const l = new LineLimiter(1, 10_000, 4, () => 1);
    for (let i = 0; i < 100; i++) l.check(`k${i}`);
    expect(l.check("k0")).toEqual({ ok: true, left: 0 }); // long forgotten: a fresh key
  });
});
