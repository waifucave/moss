import { expect, test } from "bun:test";
import { loadWithRetry } from "../src/main/pair/setup-retry";

const harness = (fails: number, o: { goneAfter?: number } = {}) => {
  let tries = 0;
  const waited: number[] = [];
  const lines: string[] = [];
  let firsts = 0;
  return {
    waited, lines, tries: () => tries, firsts: () => firsts,
    run: () => loadWithRetry({
      load: async () => { tries++; if (tries <= fails) throw new Error("plugin.ui took longer than 10000 ms"); },
      waits: [10, 20, 40], current: () => o.goneAfter === undefined || tries <= o.goneAfter, sleep: async (ms) => { waited.push(ms); },
      log: (l) => lines.push(l), onFirstFailure: () => { firsts++; },
    }),
  };
};

test("a reading that timed out once is asked again and the setup completes (builder-examples row 91: the island never connected)", async () => {
  const h = harness(1);
  expect(await h.run()).toBe(true);
  expect(h.tries()).toBe(2);
  expect(h.waited).toEqual([10]);
  expect(h.firsts()).toBe(1);
  expect(h.lines).toEqual(["pair: setting up the connection failed: plugin.ui took longer than 10000 ms; asking again in 10 ms"]);
});

test("a healthy first reading asks once and says nothing", async () => {
  const h = harness(0);
  expect(await h.run()).toBe(true);
  expect([h.tries(), h.waited, h.lines, h.firsts()]).toEqual([1, [], [], 0]);
});

test("the waits grow, the tries end, and the last failure is said", async () => {
  const h = harness(99);
  expect(await h.run()).toBe(false);
  expect(h.tries()).toBe(4);
  expect(h.waited).toEqual([10, 20, 40]);
  expect(h.lines.at(-1)).toBe("pair: setting up the connection failed: plugin.ui took longer than 10000 ms; given up after 4 tries");
});

test("a connection that is no longer the app's is not asked for again", async () => {
  const h = harness(99, { goneAfter: 1 });
  expect(await h.run()).toBe(false);
  expect(h.tries()).toBe(2);
});
