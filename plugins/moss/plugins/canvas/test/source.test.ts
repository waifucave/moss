import { describe, expect, test } from "bun:test";
import { SAMPLE_SESSION_SCENE, foldSessionEvents } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { decodePlaces, EMPTY_GRAPH, encodePlaces, graphReducer, LAST_LINE_MAX, lastLineOf, PLACES_MAX_CHARS, readLastLine } from "../client/source";
import { LAST_LINES } from "../gallery/fixtures";

describe("the source", () => {
  test("folds as the protocol does: a newer view wins, an older one never replaces it, a list merges by the same rule", () => {
    const events = SAMPLE_SESSION_SCENE.map((s) => s.event);
    let state = EMPTY_GRAPH;
    for (const e of events) state = e.type === "session_changed" ? graphReducer(state, { t: "view", view: e.session as SessionView }) : graphReducer(state, { t: "link", link: e as never });
    expect(state.sessions).toEqual(foldSessionEvents(events).sessions as Record<string, SessionView>);
    const old = { ...state.sessions.s_a!, updatedAt: 1, title: "stale" };
    expect(graphReducer(state, { t: "view", view: old })).toBe(state);
    expect(graphReducer(state, { t: "list", views: [old] }).sessions.s_a!.title).toBe("Fix the login flow");
  });

  test("the last line: the agent's last words' last line, else the last tool", () => {
    expect(lastLineOf(LAST_LINES.s_a!)).toBe("Moved it after; the login test passes now.");
    expect(lastLineOf(LAST_LINES.s_d!)).toBe("Write notes/release-0.4.md");
    expect(lastLineOf([])).toBeUndefined();
  });

  test("places: only known blocks, rounded, newest kept under the setting's size; a bad value reads as none", () => {
    const known = new Set(["a", "b"]);
    expect(encodePlaces({ a: { x: 1.4, y: 2.6 }, gone: { x: 0, y: 0 } }, known)).toBe('{"a":{"x":1,"y":3}}');
    expect(encodePlaces({}, known)).toBe("");
    const many: Record<string, { x: number; y: number }> = {};
    const ids = new Set<string>();
    for (let i = 0; i < 1_000; i++) { many[`session-${i}`] = { x: i, y: i }; ids.add(`session-${i}`); }
    const kept = encodePlaces(many, ids);
    // As the page's write measures it: the string's own JSON, quotes escaped (the layer's cap is 8,300).
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(PLACES_MAX_CHARS);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(8_300);
    expect(JSON.parse(kept)["session-999"]).toEqual({ x: 999, y: 999 });
    expect(decodePlaces(kept)["session-999"]).toEqual({ x: 999, y: 999 });
    expect(decodePlaces("not json")).toEqual({});
    expect(decodePlaces('{"a":{"x":"1","y":2}}')).toEqual({});
    expect(decodePlaces(undefined)).toEqual({});
  });
});

describe("an opened block's last line", () => {
  test("one line, cut at its most with an ellipsis", () => {
    const long = "x".repeat(500);
    const l = lastLineOf([{ type: "assistant_message", text: `first\n  ${long}  ` }])!;
    expect(l.length).toBe(LAST_LINE_MAX);
    expect(l.endsWith("…")).toBe(true);
    expect(lastLineOf([{ type: "assistant_message", text: "a\tb   c" }])).toBe("a b c");
  });

  test("when the last 40 events hold no line and there is more, read once from further back", async () => {
    const asked: { before?: number; limit: number }[] = [];
    const pages = [
      { events: [{ type: "user_message", text: "hi", seq: 41 }], hasMore: true },
      { events: [{ type: "assistant_message", text: "Earlier: done.", seq: 3 }], hasMore: true },
    ];
    expect(await readLastLine(async (p) => { asked.push(p); return pages[asked.length - 1]; })).toBe("Earlier: done.");
    expect(asked).toEqual([{ limit: 40 }, { before: 41, limit: 200 }]);
    // Nothing further back: none, after one more read only.
    const none: { before?: number; limit: number }[] = [];
    expect(await readLastLine(async (p) => { none.push(p); return { events: [{ type: "user_message", text: "hi", seq: 9 }], hasMore: none.length === 1 }; })).toBeUndefined();
    expect(none.length).toBe(2);
  });
});
