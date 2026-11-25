import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cardPageScheme, SEALED_SCHEME_CHANNEL, isCardFrame, schemeOf, tellCardPages, type SchemeFrame } from "../src/main/sealed-scheme";

const frame = (url: string, sent: string[], throws = false): SchemeFrame => ({ url, send: (c, s) => { if (throws) throw new Error("gone"); sent.push(`${url} ${c} ${s}`); } });

describe("a card page's scheme is told by the app", () => {
  test("every card page, shown or not, is told on a change; other pages and a frame that went away are not a problem", () => {
    const sent: string[] = [];
    const frames = [
      frame("moss-sealed://card/c1/own?token=a", sent), frame("moss-sealed://card/c1/button:approve?token=b", sent),
      frame("moss-sealed://card/c2/button:deny?token=c", sent), frame("moss-sealed://card/c3/own?token=d", sent, true),
      frame("moss-plugin://moss/island/index.html", sent), frame("moss-sealed://placeholder/x", sent), frame("https://example.test/", sent),
    ];
    expect(tellCardPages(frames, true)).toBe(3);
    expect(sent).toEqual([
      `moss-sealed://card/c1/own?token=a ${SEALED_SCHEME_CHANNEL} dark`,
      `moss-sealed://card/c1/button:approve?token=b ${SEALED_SCHEME_CHANNEL} dark`,
      `moss-sealed://card/c2/button:deny?token=c ${SEALED_SCHEME_CHANNEL} dark`,
    ]);
    sent.length = 0;
    expect(tellCardPages(frames, false)).toBe(3);
    expect(sent.every((l) => l.endsWith(" light"))).toBe(true);
  });
  test("the scheme words, and which frames are card pages", () => {
    expect([schemeOf(true), schemeOf(false)]).toEqual(["dark", "light"]);
    expect(isCardFrame("moss-sealed://card/x/own")).toBe(true);
    expect(isCardFrame("moss-sealed://placeholder/x")).toBe(false);
  });
  test("the card pages' styles follow data-scheme, with the media query only as the guess before it arrives", () => {
    const css = readFileSync(new URL("../src/main/sealed-pages.ts", import.meta.url), "utf8");
    expect(css).toContain(':root[data-scheme="dark"] { --seal-surface');
    expect(css).toContain(":root:not([data-scheme]) { --seal-surface");
    expect(css).not.toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root \{/);
    expect(css).toContain(':root[data-scheme="dark"] .own-head .shield');
  });
});

describe("a card page never waits for the scheme", () => {
  const rootOf = () => { const attrs: Record<string, string> = {}; return { attrs, root: { setAttribute: (n: string, v: string) => { attrs[n] = v; } } }; };
  test("a page that is never told still has a root with no data-scheme, so it draws by the media query", () => {
    const { attrs, root } = rootOf();
    const page = cardPageScheme(() => root);
    page.apply();
    page.hear("not a scheme"); page.hear(undefined);
    expect(attrs).toEqual({});
  });
  test("a late message switches it, a change switches it again, and one that came before the root existed is applied when the root is there", () => {
    const { attrs, root } = rootOf();
    let have = false;
    const page = cardPageScheme(() => (have ? root : null));
    page.hear("dark");
    expect(attrs).toEqual({});
    have = true;
    page.apply();
    expect(attrs["data-scheme"]).toBe("dark");
    page.hear("light");
    expect(attrs["data-scheme"]).toBe("light");
    page.hear("dark");
    expect(attrs["data-scheme"]).toBe("dark");
  });
  test("the preload never asks and never blocks: no sendSync for the scheme, the app pushes it when a card frame has loaded and at each change", () => {
    const pre = readFileSync(new URL("../src/main/preload.ts", import.meta.url), "utf8");
    expect(pre).not.toContain('sendSync("moss:sealed-scheme")');
    const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(main).toContain("tellCardPages([{ url: f.url");
    expect(main).not.toContain("SEALED_SCHEME_ASK");
  });
  test("a card pending while the theme changes is told on the change, and one whose frame loads later is told on load", () => {
    const sent: string[] = [];
    const early = frame("moss-sealed://card/c1/button:approve?token=a", sent);
    expect(tellCardPages([early], true)).toBe(1); // the change
    const late = frame("moss-sealed://card/c1/button:deny?token=b", sent);
    expect(tellCardPages([late], false)).toBe(1); // its load, under the new scheme
    expect(sent.map((l) => l.split(" ").pop())).toEqual(["dark", "light"]);
  });
});

describe("every colour variable the card pages' dark rule sets has a light value, and the three forms agree", () => {
  const css = readFileSync(new URL("../src/main/sealed-pages.ts", import.meta.url), "utf8");
  const vars = (block: string) => [...block.matchAll(/(--seal-[a-z-]+):/g)].map((m) => m[1]!).sort();
  const base = /PAGE_CSS = `\n:root \{([^}]*)\}/.exec(css)![1]!;
  const dark = /:root\[data-scheme="dark"\] \{ (--seal-surface[^}]*)\}/.exec(css)![1]!;
  const unset = /:root:not\(\[data-scheme\]\) \{ (--seal-surface[^}]*)\}/.exec(css)![1]!;
  test("the light (base) rule defines every variable the dark rule and the unset media-query form do, with the same values in both dark forms", () => {
    for (const v of vars(dark)) expect(vars(base)).toContain(v);
    expect(vars(unset)).toEqual(vars(dark));
    expect(unset.replace(/\s+/g, " ").trim()).toBe(dark.replace(/\s+/g, " ").trim());
  });
  test("a switch back to light needs no reset: data-scheme=light matches no dark rule", () => {
    expect(css).not.toContain(':root[data-scheme="light"] { --seal');
    expect(css).toContain(':root[data-scheme="light"] { color-scheme: light }');
  });
});
