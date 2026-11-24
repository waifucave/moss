// What the person deleted here never comes back by sync (the review of f836c1544, blocker 2): the rules
// session-record sync and memory sync read (`deletion/tombstones.ts`).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { botIdFromName } from "../../contracts/bot-records";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeletedBot, isDeletedSession, refusedSessionRecords, tombstoneBot, tombstoneConversation, tombstonePath, tombstoneProblem, tombstoneSessions } from "../tombstones";

const home = () => mkdtempSync(join(tmpdir(), "moss-tomb-"));

describe("tombstones", () => {
  test("a deleted session's records are refused whatever their time; a live one's never", () => {
    const h = home();
    tombstoneSessions(h, ["c_aaaa11112222"], 1_000);
    expect(isDeletedSession(h, "c_aaaa11112222")).toBe(true);
    expect(refusedSessionRecords(h, "c_aaaa11112222", undefined, 5_000)).toBe(true);
    expect(refusedSessionRecords(h, "c_bbbb11112222", undefined, 5)).toBe(false);
  });

  test("a deleted bot refuses its memory and every session that names it", () => {
    const h = home();
    tombstoneBot(h, "nova", 1_000);
    expect(isDeletedBot(h, "nova")).toBe(true);
    expect(isDeletedBot(h, "orbit")).toBe(false);
    expect(refusedSessionRecords(h, "s_side1", "nova", 9_999)).toBe(true);
  });

  test("a conversation opened again empty: what was written before its deletion is refused, what came after is taken", () => {
    const h = home();
    tombstoneConversation(h, "b_nova", 1_000);
    expect(refusedSessionRecords(h, "b_nova", "nova", 999)).toBe(true);
    expect(refusedSessionRecords(h, "b_nova", "nova", 1_000)).toBe(false);
    // A catch-up asks with no time to see whether to skip the stream: it isn't skipped for a reopened conversation.
    expect(refusedSessionRecords(h, "b_nova", "nova", Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("a damaged record fails closed: every bot and session counts as deleted, the doctor names it, and no deletion writes over it", () => {
    const h = home();
    writeFileSync(tombstonePath(h), "{ not json");
    expect(tombstoneProblem(h)).toContain("can't be read");
    expect(isDeletedBot(h, "anyone")).toBe(true);
    expect(isDeletedSession(h, "c_live11112222")).toBe(true);
    expect(refusedSessionRecords(h, "c_live11112222", undefined, 1)).toBe(true);
    expect(() => tombstoneBot(h, "nova", 1)).toThrow("nothing was deleted");
    expect(readFileSync(tombstonePath(h), "utf8")).toBe("{ not json");
  });

  test("an id the record can't hold stops the deletion before anything goes", () => {
    const h = home();
    expect(() => tombstoneBot(h, "bad id with spaces", 1)).toThrow("nothing was deleted");
    expect(() => tombstoneSessions(h, ["c_ok11112222", "../x y"], 1)).toThrow("nothing was deleted");
    expect(isDeletedSession(h, "c_ok11112222")).toBe(false);
    expect(tombstoneProblem(h)).toBeUndefined();
  });

  test("an id from a name is found within a bound whatever the check answers: a check that says yes to all throws, never spins", () => {
    expect(botIdFromName("Nova", (id) => id === "nova")).toBe("nova-2");
    expect(() => botIdFromName("Nova", () => true)).toThrow("no free bot id");
  });

  test("a hand-edited file keeps only well-formed ids and times", () => {
    const h = home();
    writeFileSync(tombstonePath(h), JSON.stringify({ v: 1, bots: { "../x": 1, ok: "no", fine: 2 }, sessions: [] }));
    expect(isDeletedBot(h, "fine")).toBe(true);
    expect(isDeletedBot(h, "ok")).toBe(false);
    expect(isDeletedBot(h, "../x")).toBe(false);
  });
});
