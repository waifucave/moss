// The display names of the agent backends (`useBackendNames`): one read, and a read that failed or came back empty is asked
// again by a later lookup, not never (a part showed "codex" for "Codex" for good when the first read fell in the engine's start-up).
import { describe, expect, test } from "bun:test";
import { BACKEND_NAMES_RETRY_MS, BackendNamesReader, namesOf } from "../src/ui/backend-names";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("namesOf", () => {
  test("a string name or an English entry; a backend with none, or a blank one, is left out", () => {
    expect([...namesOf({ backends: [{ id: "codex", name: "Codex" }, { id: "a", name: { en: "A" } }, { id: "b" }, { id: "c", name: "" }, { name: "x" }] })]).toEqual([["codex", "Codex"], ["a", "A"]]);
    expect(namesOf(undefined).size).toBe(0);
  });
});

describe("BackendNamesReader", () => {
  function setup(answers: (() => Promise<{ backends?: { id?: unknown; name?: unknown }[] } | undefined>)[]) {
    let now = 1_000;
    let calls = 0;
    const got: Map<string, string>[] = [];
    const reader = new BackendNamesReader(() => answers[Math.min(calls++, answers.length - 1)]!(), () => now, (n) => got.push(n));
    return { reader, got, calls: () => calls, advance: (ms: number) => (now += ms) };
  }
  const ok = () => Promise.resolve({ backends: [{ id: "codex", name: "Codex" }] });

  test("reads once however many lookups ask, and never again once it has the names", async () => {
    const s = setup([ok]);
    s.reader.ask();
    s.reader.ask();
    await flush();
    s.advance(60_000);
    s.reader.ask();
    await flush();
    expect(s.calls()).toBe(1);
    expect(s.got).toEqual([new Map([["codex", "Codex"]])]);
  });

  test("a read that fails is asked again by a later lookup after the gap, not before it, and not by a timer", async () => {
    const s = setup([() => Promise.reject(new Error("MOSS's agents aren't running yet")), ok]);
    s.reader.ask();
    await flush();
    expect(s.calls()).toBe(1);
    s.reader.ask(); // straight after: the gap hasn't passed
    await flush();
    expect(s.calls()).toBe(1);
    await new Promise((r) => setTimeout(r, 30)); // time passing alone asks nothing
    expect(s.calls()).toBe(1);
    s.advance(BACKEND_NAMES_RETRY_MS);
    s.reader.ask();
    await flush();
    expect(s.calls()).toBe(2);
    expect(s.got).toEqual([new Map([["codex", "Codex"]])]);
  });

  test("an empty reply is a read that didn't find the names: asked again the same way", async () => {
    const s = setup([() => Promise.resolve({ backends: [] }), ok]);
    s.reader.ask();
    await flush();
    expect(s.got).toEqual([]);
    s.advance(BACKEND_NAMES_RETRY_MS);
    s.reader.ask();
    await flush();
    expect(s.got.length).toBe(1);
  });

  test("a read in flight is not doubled, and a part that left changes nothing", async () => {
    let finish!: () => void;
    const slow = () => new Promise<{ backends: { id: string; name: string }[] }>((r) => (finish = () => r({ backends: [{ id: "codex", name: "Codex" }] })));
    const s = setup([slow]);
    s.reader.ask();
    s.reader.ask();
    expect(s.calls()).toBe(1);
    s.reader.stop();
    finish();
    await flush();
    expect(s.got).toEqual([]);
  });
});
