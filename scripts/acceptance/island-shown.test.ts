import { expect, test } from "bun:test";
import { cardShownJs } from "./island-shown";

const run = (id: string, doc: { querySelector(sel: string): unknown }, visibility: string): unknown =>
  new Function("document", "getComputedStyle", `return ${cardShownJs(id)}`)(doc, () => ({ visibility }));

test("a card held back by the island (visibility hidden) is not shown; once visible it is", () => {
  const card = {};
  const doc = { querySelector: (sel: string) => (sel === '[data-moss-card="card_abc"]' ? card : null) };
  expect(run("card_abc", doc, "hidden")).toBe(false);
  expect(run("card_abc", doc, "visible")).toBe(true);
});

test("a card that is not on the page is not shown", () => {
  expect(run("card_abc", { querySelector: () => null }, "visible")).toBe(false);
});
