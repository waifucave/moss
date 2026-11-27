// The numbered press (press-bound.ts), lane WA: the app takes an answer only on the fresh report of its OWN press, however long the page
// takes between the report and the answer (inside PRESS_BOUND_MS of the press). The store half: the report and the answer are matched by
// the press's number and its page load's id; nothing is reusable for another press; one answer per press number.
import { describe, expect, test } from "bun:test";
import { PRESS_BOUND_MS, PressBound, parsePressRef } from "../src/main/press-bound";
import { SealedFrames } from "../src/main/sealed";

const LOAD = "a1b2c3d4e5f60718293a4b5c";
const OTHER_LOAD = "0f1e2d3c4b5a69788796a5b4";
const ref = (n: number, load = LOAD) => ({ load, n });

/** A store with a controllable clock. */
function rig() {
  let t = 1_000;
  const store = new SealedFrames("moss", () => t);
  return { store, at: (ms: number) => { t = 1_000 + ms; } };
}

describe("a press is taken on its own report, however late the answer comes inside the bound", () => {
  test("a stalled answer (report at 100 ms, answer at 3 s) is accepted", () => {
    const r = rig();
    r.store.notePress("tok", ref(1));
    r.at(100);
    expect(r.store.noteFresh("tok", ref(1), true)).toBe("ok");
    r.at(3_000);
    expect(r.store.takeFresh("tok", ref(1))).toBe("ok");
  });

  test("the answer may come up to PRESS_BOUND_MS (10 s) after the press and no later", () => {
    const r = rig();
    r.store.notePress("tok", ref(1));
    r.at(100);
    r.store.noteFresh("tok", ref(1), true);
    r.at(PRESS_BOUND_MS);
    expect(r.store.takeFresh("tok", ref(1))).toBe("ok");
    r.store.notePress("tok", ref(2));
    r.store.noteFresh("tok", ref(2), true);
    r.at(PRESS_BOUND_MS + PRESS_BOUND_MS + 1);
    expect(r.store.takeFresh("tok", ref(2))).toBe("none");
    expect(r.store.noneWhy).toBe("over the bound");
  });

  test("a covered or late report is said as such, however late the answer", () => {
    const r = rig();
    r.store.notePress("a", ref(1));
    r.store.noteFresh("a", ref(1), false, false);
    r.store.notePress("b", ref(1));
    r.store.noteFresh("b", ref(1), false, true);
    r.at(4_000);
    expect(r.store.takeFresh("a", ref(1))).toBe("covered");
    expect(r.store.takeFresh("b", ref(1))).toBe("late");
  });
});

describe("a report is never reusable for another press and never older than its press", () => {
  test("a report from an earlier press with a later answer is refused", () => {
    const r = rig();
    r.store.notePress("tok", ref(1));
    r.store.noteFresh("tok", ref(1), true);
    // The second press is heard; its answer arrives with no report of its own. The first press's report doesn't carry it.
    r.at(500);
    r.store.notePress("tok", ref(2));
    r.at(1_000);
    expect(r.store.takeFresh("tok", ref(2))).toBe("none");
    expect(r.store.noneWhy).toBe("no report");
  });

  test("the earlier press's own answer, arriving after a later press is heard, is refused and leaves the later press intact", () => {
    const r = rig();
    r.store.notePress("tok", ref(1));
    r.store.noteFresh("tok", ref(1), true);
    r.at(500);
    r.store.notePress("tok", ref(2));
    r.store.noteFresh("tok", ref(2), true);
    expect(r.store.takeFresh("tok", ref(1))).toBe("none");
    expect(r.store.noneWhy).toBe("another press");
    // The press 2 report is untouched.
    expect(r.store.takeFresh("tok", ref(2))).toBe("ok");
  });

  test("a report that comes before its press's \"received\" (or for a press never heard) counts for nothing", () => {
    const r = rig();
    expect(r.store.noteFresh("tok", ref(1), true)).toBe("no press");
    r.store.notePress("tok", ref(1));
    expect(r.store.noteFresh("tok", ref(2), true)).toBe("another press");
    expect(r.store.takeFresh("tok", ref(1))).toBe("none");
    expect(r.store.noneWhy).toBe("no report");
  });

  test("an answer for a press main never heard (a number above the last) is refused", () => {
    const r = rig();
    r.store.notePress("tok", ref(1));
    r.store.noteFresh("tok", ref(1), true);
    expect(r.store.takeFresh("tok", ref(5))).toBe("none");
    expect(r.store.noneWhy).toBe("no press");
  });

  test("a second report for a press changes nothing: the first stands", () => {
    const r = rig();
    r.store.notePress("tok", ref(1));
    expect(r.store.noteFresh("tok", ref(1), false)).toBe("ok");
    expect(r.store.noteFresh("tok", ref(1), true)).toBe("second report");
    expect(r.store.takeFresh("tok", ref(1))).toBe("covered");
  });
});

describe("one answer per press number", () => {
  test("a replayed report/answer pair is refused", () => {
    const r = rig();
    r.store.notePress("tok", ref(1));
    r.store.noteFresh("tok", ref(1), true);
    expect(r.store.takeFresh("tok", ref(1))).toBe("ok");
    // The same messages again: the press is spent, "received" for the same number reopens nothing, and the report finds it used.
    expect(r.store.notePress("tok", ref(1))).toBe("not newer");
    expect(r.store.noteFresh("tok", ref(1), true)).toBe("already used");
    expect(r.store.takeFresh("tok", ref(1))).toBe("none");
    expect(r.store.noneWhy).toBe("already used");
  });

  test("a refused answer spends its press too", () => {
    const r = rig();
    r.store.notePress("tok", ref(1));
    r.store.noteFresh("tok", ref(1), false);
    expect(r.store.takeFresh("tok", ref(1))).toBe("covered");
    expect(r.store.takeFresh("tok", ref(1))).toBe("none");
  });

  test("an older \"received\" can't replace a newer press", () => {
    const r = rig();
    r.store.notePress("tok", ref(3));
    expect(r.store.notePress("tok", ref(2))).toBe("not newer");
    r.store.noteFresh("tok", ref(3), true);
    expect(r.store.takeFresh("tok", ref(3))).toBe("ok");
  });
});

describe("a press number from another page load is refused", () => {
  test("a report and an answer under another load's id take nothing, and the token's own load goes on", () => {
    const r = rig();
    r.store.notePress("tok", ref(1));
    r.store.noteFresh("tok", ref(1), true);
    expect(r.store.notePress("tok", ref(2, OTHER_LOAD))).toBe("another page load");
    expect(r.store.noteFresh("tok", ref(1, OTHER_LOAD), true)).toBe("another page load");
    expect(r.store.takeFresh("tok", ref(1, OTHER_LOAD))).toBe("none");
    expect(r.store.noneWhy).toBe("another page load");
    expect(r.store.takeFresh("tok", ref(1))).toBe("ok");
  });

  test("another page's number is no use to a token that has none of its own, and a token never takes another token's press", () => {
    const r = rig();
    r.store.notePress("one", ref(1));
    r.store.noteFresh("one", ref(1), true);
    expect(r.store.takeFresh("two", ref(1))).toBe("none");
    expect(r.store.noneWhy).toBe("no press");
    expect(r.store.takeFresh("one", ref(1))).toBe("ok");
  });
});

describe("an answer with no number is refused; a message's number is checked before it is believed", () => {
  test("no press reference: none, and the token's real press is not spent", () => {
    const r = rig();
    r.store.notePress("tok", ref(1));
    r.store.noteFresh("tok", ref(1), true);
    expect(r.store.takeFresh("tok", undefined)).toBe("none");
    expect(r.store.noneWhy).toBe("no press");
    expect(r.store.takeFresh("tok", ref(1))).toBe("ok");
  });

  test("parsePressRef takes only a load id of 16 to 32 hex digits and a whole number from 1 to a billion", () => {
    expect(parsePressRef({ load: LOAD, n: 1 })).toEqual({ load: LOAD, n: 1 });
    for (const bad of [undefined, null, "x", 1, [], {}, { load: LOAD }, { n: 1 }, { load: LOAD, n: 0 }, { load: LOAD, n: -1 }, { load: LOAD, n: 1.5 }, { load: LOAD, n: 1e12 }, { load: LOAD, n: "1" }, { load: LOAD, n: NaN }, { load: "short", n: 1 }, { load: "G".repeat(24), n: 1 }, { load: "a".repeat(64), n: 1 }, { load: `${LOAD}\n`, n: 1 }]) {
      expect(parsePressRef(bad)).toBeUndefined();
    }
  });

  test("the store remembers a bounded number of tokens", () => {
    let t = 0;
    const b = new PressBound(() => t);
    for (let i = 0; i < 1_000; i++) b.note(`tok${i}`, ref(1));
    // The oldest are forgotten; the newest still answer.
    expect(b.take("tok0", ref(1))).toBe("none");
    b.report("tok999", ref(1), true, false);
    expect(b.take("tok999", ref(1))).toBe("ok");
  });
});
