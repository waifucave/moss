import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SEALED_SCHEME_CHANNEL, isCardFrame, schemeOf, tellCardPages, type SchemeFrame } from "../src/main/sealed-scheme";

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
