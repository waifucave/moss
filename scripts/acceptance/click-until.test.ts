import { expect, test } from "bun:test";
import { pressUntilShown } from "./click-until";

const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

test("a press that lands on what moved into the row's place is made again, and the page showing ends it", async () => {
  const c = clock();
  let presses = 0;
  const n = await pressUntilShown({ press: async () => { presses++; }, shown: async () => presses >= 2, tries: 4, waitMs: 1_000, ...c });
  expect(n).toBe(2);
  expect(presses).toBe(2);
});

test("a page that shows at once is pressed for once", async () => {
  const c = clock();
  let presses = 0;
  expect(await pressUntilShown({ press: async () => { presses++; }, shown: async () => presses > 0, tries: 4, waitMs: 1_000, ...c })).toBe(1);
  expect(presses).toBe(1);
});

test("a page that never shows ends after the tries, answering 0", async () => {
  const c = clock();
  let presses = 0;
  expect(await pressUntilShown({ press: async () => { presses++; }, shown: async () => false, tries: 3, waitMs: 600, ...c })).toBe(0);
  expect(presses).toBe(3);
});
