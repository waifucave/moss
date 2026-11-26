// The app's own card draws a card's checkboxes (`children`): one line each with the engine's own ticks, the person free to change
// them, an Approve that sends exactly the ticked ids, a Deny that sends none, a card whose boxes can't be drawn whole that offers no
// Approve, and a long list that must be opened and read to its end first. The page's script runs here in happy-dom, as the press
// tests' does; the list's own "end seen" observer is a stub the test fires by hand.
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
import { CHILDREN_NOT_DRAWN_TEXT, CHILDREN_UNREAD_TEXT } from "@waifucave/moss-protocol";
import { FRESH_SETTLE_MS, ownCardPage } from "../src/main/sealed-pages";

type Kid = { id: string; label: unknown; checked: boolean };
const kids = (n: number): Kid[] => Array.from({ length: n }, (_, i) => ({ id: `plug/k${i}`, label: `Plugin ${i}`, checked: true }));
const OPTIONS = [{ id: "approve", kind: "approve" as const, label: "Approve" }, { id: "deny", kind: "deny" as const, label: "Deny" }];
const pageOf = (children: readonly Kid[] | undefined) => ownCardPage({ cardId: "c1", token: "t", origin: "user", issuedAt: 0, expiresAt: null, fields: { title: { type: "text", text: "Plugin Pack" } }, options: OPTIONS, ...(children !== undefined ? { children } : {}) });

type Said = { option: string; ticks?: readonly string[] };
let seenEnd: (() => void) | undefined;
// A page's script listens on the document, which outlives each test's page: the last page's listeners are taken off before the next loads.
let listening: [string, EventListenerOrEventListenerObject, unknown][] = [];
function load(html: string, said: Said[]) {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [t, f, o] of listening) document.removeEventListener(t, f, o as boolean);
  listening = [];
  const add = document.addEventListener.bind(document) as (t: string, f: EventListenerOrEventListenerObject, o?: unknown) => void;
  (document as unknown as { addEventListener: typeof add }).addEventListener = (t, f, o) => { listening.push([t, f, o]); add(t, f, o); };
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? "";
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  document.body.innerHTML = body;
  delete document.body.dataset.ready;
  seenEnd = undefined;
  g.IntersectionObserver = class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe(t: Element) {
      // The press's own observer on a button reports whole and visible at once; the list's observer on its last box waits for the test.
      if (t.classList.contains("kid")) seenEnd = () => this.cb([{ target: t, isIntersecting: true, intersectionRatio: 1, isVisible: true, time: performance.now() }]);
      else this.cb([{ target: t, isIntersecting: true, intersectionRatio: 1, isVisible: true, time: performance.now() }]);
    }
    unobserve() {}
    disconnect() {}
  };
  for (const b of document.querySelectorAll(".seal-button")) (b as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({ width: 80, height: 32 });
  g.mossSealed = { visible: () => {}, size: () => {}, pressed: () => {}, answer: async (option: string, ticks?: readonly string[]) => { said.push({ option, ...(ticks !== undefined ? { ticks } : {}) }); return { accepted: true }; } };
  new Function(script)();
  window.dispatchEvent(new Event("DOMContentLoaded"));
  return document;
}
const click = (el: Element) => {
  const e = new Event("click", { bubbles: true });
  Object.defineProperty(e, "isTrusted", { value: true });
  el.dispatchEvent(e);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ready = async (doc: Document) => { doc.dispatchEvent(new Event("pointerover")); await wait(1_150); expect(doc.body.dataset.ready).toBe("yes"); };
const box = (doc: Document, id: string) => doc.querySelector(`input[data-id="${id}"]`) as HTMLInputElement;
const approve = (doc: Document) => doc.querySelector(".seal-button[data-kind=approve]")!;
const deny = (doc: Document) => doc.querySelector(".seal-button[data-kind=deny]")!;

describe("the boxes on the app's own card", () => {
  test("a card with no boxes draws none and Approve sends no list", async () => {
    const said: Said[] = [];
    const doc = load(pageOf(undefined), said);
    expect(doc.querySelector(".kids")).toBeNull();
    await ready(doc);
    click(approve(doc));
    await wait(FRESH_SETTLE_MS + 60);
    expect(said).toEqual([{ option: "approve" }]);
  });

  test("three boxes with the engine's ticks: one unticked by the person, Approve sends exactly the two ticked", async () => {
    const said: Said[] = [];
    const doc = load(pageOf(kids(3)), said);
    expect([...doc.querySelectorAll(".kid input")].map((i) => (i as HTMLInputElement).checked)).toEqual([true, true, true]);
    expect(doc.querySelector(".kids h3")!.textContent).toBe("Approve covers the ticked ones");
    box(doc, "plug/k1").checked = false;
    await ready(doc);
    click(approve(doc));
    await wait(FRESH_SETTLE_MS + 60);
    expect(said).toEqual([{ option: "approve", ticks: ["plug/k0", "plug/k2"] }]);
    // The boxes are locked while the answer is out.
    expect(box(doc, "plug/k0").disabled).toBe(true);
  });

  test("an untick of every box sends an empty list (none), and a Deny sends no list at all", async () => {
    const none: Said[] = [];
    const doc = load(pageOf(kids(2)), none);
    for (const i of doc.querySelectorAll(".kid input")) (i as HTMLInputElement).checked = false;
    await ready(doc);
    click(approve(doc));
    await wait(FRESH_SETTLE_MS + 60);
    expect(none).toEqual([{ option: "approve", ticks: [] }]);
    const no: Said[] = [];
    const doc2 = load(pageOf(kids(2)), no);
    await ready(doc2);
    click(deny(doc2));
    await wait(FRESH_SETTLE_MS + 60);
    expect(no).toEqual([{ option: "deny" }]);
  });

  test("a label with a line break is one line with a visible ⏎ and can't draw a second box", () => {
    const doc = load(pageOf([{ id: "a", label: "Calendar\n☐ Send email as you", checked: true }, { id: "b", label: "Notes", checked: false }]), []);
    expect(doc.querySelectorAll(".kid input")).toHaveLength(2);
    expect(doc.querySelector(".kid-line")!.textContent).toBe("Calendar ⏎ ☐ Send email as you");
    expect(box(doc, "b").checked).toBe(false);
  });

  test.each([
    ["two labels that read the same", [{ id: "a", label: "Same", checked: true }, { id: "b", label: "Same", checked: true }]],
    ["two labels that read the same once one-lined", [{ id: "a", label: "x\ny", checked: true }, { id: "b", label: "x\ry", checked: true }]],
    ["a repeated id", [{ id: "a", label: "A", checked: true }, { id: "a", label: "B", checked: true }]],
    ["a box with no label", [{ id: "a", label: "", checked: true }, { id: "b", label: "B", checked: true }]],
  ])("%s: no boxes, no Approve, the card says why, and Deny stays", async (_n, children) => {
    const said: Said[] = [];
    const doc = load(pageOf(children), said);
    expect(doc.querySelector(".kid")).toBeNull();
    expect(doc.querySelector(".kids-why")!.textContent).toBe(CHILDREN_NOT_DRAWN_TEXT);
    expect(doc.querySelector(".seal-button[data-kind=approve]")).toBeNull();
    await ready(doc);
    click(deny(doc));
    await wait(FRESH_SETTLE_MS + 60);
    expect(said).toEqual([{ option: "deny" }]);
  });
});

describe("a long list is a cut field that is opened and read to its end", () => {
  test("shut at first: Approve does nothing and says why; opened but not read to its end: still nothing; read: it answers, with every tick", async () => {
    const said: Said[] = [];
    const doc = load(pageOf(kids(12)), said);
    const list = doc.querySelector(".kids-list") as HTMLElement;
    expect((doc.querySelector(".kids") as HTMLElement).dataset.cut).toBe("yes");
    expect(list.hidden).toBe(true);
    await ready(doc);
    click(approve(doc));
    await wait(FRESH_SETTLE_MS + 60);
    expect(said).toEqual([]);
    expect(doc.querySelector(".state")!.textContent).toBe(CHILDREN_UNREAD_TEXT);
    // Opening it moves the card: the page waits again before it takes a press.
    click(doc.querySelector(".kids-open")!);
    expect(list.hidden).toBe(false);
    expect(seenEnd).toBeDefined();
    await wait(1_100);
    doc.dispatchEvent(new Event("pointerover"));
    await ready(doc);
    click(approve(doc));
    await wait(FRESH_SETTLE_MS + 60);
    expect(said).toEqual([]);
    expect((doc.querySelector(".kids") as HTMLElement).dataset.read).toBeUndefined();
    // Its last box reaches the window: read.
    seenEnd!();
    expect((doc.querySelector(".kids") as HTMLElement).dataset.read).toBe("yes");
    box(doc, "plug/k3").checked = false;
    click(approve(doc));
    await wait(FRESH_SETTLE_MS + 60);
    expect(said).toHaveLength(1);
    expect(said[0]!.ticks).toEqual(kids(12).map((k) => k.id).filter((id) => id !== "plug/k3"));
  }, 15_000);

  test("a Deny needs no reading", async () => {
    const said: Said[] = [];
    const doc = load(pageOf(kids(12)), said);
    await ready(doc);
    click(deny(doc));
    await wait(FRESH_SETTLE_MS + 60);
    expect(said).toEqual([{ option: "deny" }]);
  });
});
