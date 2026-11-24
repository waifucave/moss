// The deletion lane: an "Erase everything" said yes to from the app runs after the engine stopped; its outcome waits
// beside the home and is shown once at the next open (main/erase-outcome.ts), then removed.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eraseOutcomePath, takeEraseOutcome } from "../src/main/erase-outcome";

const home = () => join(mkdtempSync(join(tmpdir(), "moss-erase-out-")), "home");

describe("the erase's outcome at the next open", () => {
  test("none: nothing is shown", () => {
    expect(takeEraseOutcome(home())).toBeUndefined();
  });

  test("done: said once, with what stays, then the file is gone", () => {
    const h = home();
    writeFileSync(eraseOutcomePath(h), JSON.stringify({ v: 1, at: 1, ok: true, keeps: ["the apps themselves"] }));
    const o = takeEraseOutcome(h);
    expect(o?.ok).toBe(true);
    expect(o?.detail).toContain("the apps themselves");
    expect(existsSync(eraseOutcomePath(h))).toBe(false);
    expect(takeEraseOutcome(h)).toBeUndefined();
  });

  test("refused or partly done after the person's yes: the engine's reason and the keys left are shown", () => {
    const h = home();
    writeFileSync(eraseOutcomePath(h), JSON.stringify({ v: 1, at: 1, ok: false, secretsLeft: 2, error: "erase refused: not a MOSS home; nothing was removed", keeps: [] }));
    const o = takeEraseOutcome(h);
    expect(o?.ok).toBe(false);
    expect(o?.detail).toContain("nothing was removed");
    expect(o?.detail).toContain("2 saved key(s)");
  });

  test("the path is the engine's: beside the home, named after it", () => {
    expect(eraseOutcomePath("/x/y/.moss")).toBe("/x/y/.moss-erase.json");
  });
});
