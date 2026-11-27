// The page's half of the numbered press (press-bound.ts, lane WA): each TRUSTED press the sealed page handles gets the next number of its
// load, and that number and the load's id ride the press's "received", its fresh report and its answer; an untrusted event gets no number
// (and takes none from the count). The page's script runs here in happy-dom with the same IntersectionObserver stub the press tests use.
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
import { FRESH_SETTLE_MS, buttonPage, ownCardPage } from "../src/main/sealed-pages";
import { parsePressRef } from "../src/main/press-bound";

type Call = { what: string; press: unknown };

function load(html: string, calls: Call[]) {
  const g = globalThis as unknown as Record<string, unknown>;
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? "";
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  document.body.innerHTML = body;
  delete document.body.dataset.ready;
  g.IntersectionObserver = class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe(t: Element) { this.cb([{ target: t, intersectionRatio: 1, isVisible: true, time: performance.now() }]); }
    unobserve() {}
  };
  for (const b of document.querySelectorAll(".seal-button")) (b as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({ width: 80, height: 32 });
  g.mossSealed = {
    visible: () => {},
    size: () => {},
    pressed: (what: string, press?: unknown) => { calls.push({ what: `pressed:${what}`, press }); },
    fresh: (seen: boolean, _ms: number, press?: unknown) => { calls.push({ what: `fresh:${seen}`, press }); },
    answer: async (option: string, _children?: unknown, press?: unknown) => { calls.push({ what: `answer:${option}`, press }); return { accepted: true }; },
  };
  new Function(script)();
  window.dispatchEvent(new Event("DOMContentLoaded"));
}
const fire = (el: Element, trusted: boolean) => {
  const e = new Event("pointerdown", { bubbles: true });
  Object.defineProperty(e, "isTrusted", { value: trusted });
  el.dispatchEvent(e);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the sealed page numbers its trusted presses", () => {
  test("received, the fresh report and the answer carry one press's number and load; an untrusted event gets no number and takes none; the next trusted press is the next number", async () => {
    const calls: Call[] = [];
    load(buttonPage({ cardId: "c1", token: "t", option: "approve", label: "Approve", kind: "approve" }), calls);
    const btn = document.querySelector(".seal-button")!;
    await wait(800);
    expect(document.body.dataset.ready).toBe("yes");

    // An untrusted event: said as such, carrying no number, answering nothing.
    fire(btn, false);
    expect(calls).toEqual([{ what: "pressed:untrusted", press: undefined }]);

    // The first trusted press: number 1 on all three messages.
    fire(btn, true);
    await wait(FRESH_SETTLE_MS + 60);
    const first = calls.slice(1);
    expect(first.map((c) => c.what)).toEqual(["pressed:received", "fresh:true", "answer:approve"]);
    const p1 = parsePressRef(first[0]!.press)!;
    expect(p1).toBeDefined();
    expect(p1.n).toBe(1);
    for (const c of first) expect(c.press).toEqual(p1);

    // Another untrusted event, then the second trusted press: number 2 (the untrusted one used no number), the same load.
    fire(btn, false);
    expect(calls[calls.length - 1]).toEqual({ what: "pressed:untrusted", press: undefined });
    await wait(40);
    fire(btn, true);
    await wait(FRESH_SETTLE_MS + 60);
    const second = calls.slice(5);
    expect(second.map((c) => c.what)).toEqual(["pressed:received", "fresh:true", "answer:approve"]);
    const p2 = parsePressRef(second[0]!.press)!;
    expect(p2).toEqual({ load: p1.load, n: 2, kind: "pointer" });
    for (const c of second) expect(c.press).toEqual(p2);
    window.dispatchEvent(new Event("pagehide"));
  });

  test("another page load has its own id: two loads' presses are never one", async () => {
    const loads: string[] = [];
    for (let i = 0; i < 2; i++) {
      const calls: Call[] = [];
      load(buttonPage({ cardId: `c${i}`, token: "t", option: "approve", label: "Approve", kind: "approve" }), calls);
      await wait(800);
      fire(document.querySelector(".seal-button")!, true);
      await wait(FRESH_SETTLE_MS + 60);
      loads.push(parsePressRef(calls.find((c) => c.what === "pressed:received")!.press)!.load);
      window.dispatchEvent(new Event("pagehide"));
    }
    expect(loads[0]).not.toBe(loads[1]);
  }, 10_000);
});

describe("the page says which kind of press it was", () => {
  test("a button page's press is a pointer press; the app's own card says pointer for a click and key only for a click with no detail and no pointer type", async () => {
    const calls: Call[] = [];
    load(buttonPage({ cardId: "c1", token: "t", option: "approve", label: "Approve", kind: "approve" }), calls);
    await wait(800);
    fire(document.querySelector(".seal-button")!, true);
    expect(parsePressRef(calls.find((c) => c.what === "pressed:received")!.press)).toMatchObject({ n: 1, kind: "pointer" });
    await wait(FRESH_SETTLE_MS + 60);
    window.dispatchEvent(new Event("pagehide"));

    const kinds: (string | undefined)[] = [];
    for (const [detail, pointerType] of [[0, ""], [1, "mouse"], [0, "touch"]] as const) {
      const own: Call[] = [];
      load(ownCardPage({ cardId: "c1", token: "t", origin: "x", issuedAt: 0, expiresAt: null, options: [{ id: "approve", kind: "approve", label: "Approve" }, { id: "deny", kind: "deny", label: "Deny" }], fields: {} } as never), own);
      document.dispatchEvent(new Event("pointerover"));
      await wait(1_150);
      const e = new Event("click", { bubbles: true });
      Object.defineProperty(e, "isTrusted", { value: true });
      Object.defineProperty(e, "detail", { value: detail });
      Object.defineProperty(e, "pointerType", { value: pointerType });
      document.querySelector(".seal-button[data-kind=approve]")!.dispatchEvent(e);
      kinds.push(parsePressRef(own.find((c) => c.what === "pressed:received")?.press)?.kind);
      await wait(FRESH_SETTLE_MS + 60);
      window.dispatchEvent(new Event("pagehide"));
    }
    expect(kinds).toEqual(["key", "pointer", "pointer"]);
  }, 15_000);
});
