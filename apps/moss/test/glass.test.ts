// MOSS's glass (the owner, 2026-11-22): the list column and the top bars look as MOSS Code's sidebar and bar do. Three things
// are held here: the window asks for a material only where there is one (a real visible macOS window), the page's styles
// go see-through only when the page was told it has one, and the tint and the blur are MOSS Code's numbers (the SDK
// catalog's), which MOSS's own token block must never drift from.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenInfo } from "@waifucave/moss-plugin-sdk";
import { CLEAR_BACKING, materialOf, materialOptions } from "../src/main/window-plan";

const here = import.meta.dir;
const css = readFileSync(join(here, "..", "src", "window", "window.css"), "utf8");
const pages = readFileSync(join(here, "..", "src", "window", "pages.css"), "utf8");

/** The value of a custom property in the light block (`:root {`) or the dark one (the `prefers-color-scheme: dark` block). */
function token(scheme: "light" | "dark", name: string): string | undefined {
  const dark = css.indexOf("@media (prefers-color-scheme: dark)");
  const block = scheme === "light" ? css.slice(css.indexOf(":root {"), dark) : css.slice(dark, css.indexOf("* { box-sizing"));
  return new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}
/** The same colour as a lower-case `#rrggbbaa`, however it is written. */
const norm = (v: string | undefined): string | undefined => (v === undefined ? undefined : v.toLowerCase());

describe("the window's material", () => {
  const real = { platform: "darwin" as const, headless: false, offscreen: false };
  test("only a real, visible macOS window has one", () => {
    expect(materialOf(real)).toBe("vibrancy");
    expect(materialOf({ ...real, headless: true })).toBe("none");
    expect(materialOf({ ...real, offscreen: true })).toBe("none");
    expect(materialOf({ ...real, headless: true, offscreen: true })).toBe("none");
    // No acrylic, no other system's material: Windows and Linux keep their solid colour.
    expect(materialOf({ ...real, platform: "win32" })).toBe("none");
    expect(materialOf({ ...real, platform: "linux" })).toBe("none");
  });
  test("it asks for MOSS Code's material and a clear backing; without one, today's solid colour", () => {
    expect(materialOptions("vibrancy", "#FFFFFF")).toEqual({ backgroundColor: CLEAR_BACKING, vibrancy: "sidebar", visualEffectState: "followWindow" });
    expect(CLEAR_BACKING).toBe("#00000000");
    expect(materialOptions("none", "#121212")).toEqual({ backgroundColor: "#121212" });
    expect("vibrancy" in materialOptions("none", "#121212")).toBe(false);
  });
});

describe("the glass tint and blur are MOSS Code's, one source of numbers", () => {
  test("the list's and the bars' tint is the catalog's sidebar tint and title bar tint, light and dark", () => {
    const side = tokenInfo("sidebar.tint")!;
    const bar = tokenInfo("titlebar.tint")!;
    // MOSS Code's sidebar and bar are one tint (the owner, 2026-11-22), so MOSS's list and bars are too.
    expect([side.default, side.dark]).toEqual([bar.default, bar.dark]);
    expect(norm(token("light", "--glass-tint"))).toBe(norm(String(side.default)));
    expect(norm(token("dark", "--glass-tint"))).toBe(norm(String(side.dark)));
  });
  test("the blur is the catalog's title bar blur", () => {
    expect(token("light", "--glass-blur")).toBe(String(tokenInfo("titlebar.blur")!.default));
  });
  test("the bars use that tint and that blur, over the column they float on", () => {
    const rule = /\.conversation__head, \.page__head, \.panel__head \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("background: var(--glass-tint)");
    expect(rule).toContain("backdrop-filter: blur(var(--glass-blur)) saturate(1.6)");
  });
});

describe("the page goes see-through only where it has a material", () => {
  test("the list is the glass only under data-translucent; its solid colour stays the rule everywhere else", () => {
    expect(css).toMatch(/\.list \{[^}]*background: var\(--list-bg\)/);
    expect(css).toMatch(/:root\[data-translucent\] \.list \{ background: var\(--glass-tint\); \}/);
    expect(css).toMatch(/:root\[data-translucent\] body \{ background: transparent; \}/);
    // Nothing else of the page goes see-through: the middle and the panel keep their own planes.
    expect(css).toMatch(/\.middle \{[^}]*background: var\(--bg\)/);
    expect(css).toMatch(/\.panel \{[^}]*background: var\(--panel-bg\)/);
  });
  test("the glass is neutral: the tint and its ring are greys with no hue", () => {
    for (const scheme of ["light", "dark"] as const) {
      const tint = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})[0-9a-f]{2}$/i.exec(token(scheme, "--glass-tint") ?? "");
      expect(tint, `${scheme} tint`).not.toBeNull();
      expect(tint![1]).toBe(tint![2]);
      expect(tint![2]).toBe(tint![3]);
      const ring = /rgba\((\d+), (\d+), (\d+), [\d.]+\)/.exec(token(scheme, "--glass-ring") ?? "");
      expect(ring, `${scheme} ring`).not.toBeNull();
      expect(ring![1]).toBe(ring![2]);
      expect(ring![2]).toBe(ring![3]);
    }
  });
  test("the unread dot's ring is the glass's where the list is, never the solid list colour", () => {
    expect(css).toMatch(/:root\[data-translucent\] \.row\.is-unread::after \{ border-color: var\(--glass-ring\); \}/);
  });
  test("no colour is written outside the token block: the glass rules use tokens only", () => {
    const outside = css.slice(css.indexOf("* { box-sizing")) + pages;
    expect(outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });
});

describe("nothing is born hidden under a bar", () => {
  test("the scrolling areas start below the bar (their top padding holds it), unless a card strip is there", () => {
    expect(css).toMatch(/\.messages \{[^}]*padding: calc\(var\(--under\) \+ 18px\) 22px 8px/);
    expect(css).toMatch(/\.page__body \{[^}]*padding: calc\(var\(--under\) \+ 18px\) 22px 28px/);
    expect(pages).toMatch(/\.ma2-settings__nav \{[^}]*padding: calc\(var\(--under\) \+ 14px\)/);
    expect(css).toMatch(/--under: var\(--bar-h\)/);
    expect(css).toMatch(/\.conversation:has\(> \.strip\), \.page:has\(> \.strip\) \{ --under: 0px; \}/);
    expect(css).toMatch(/\.conversation > \.strip, \.page > \.strip \{ margin-top: var\(--bar-h\); \}/);
  });
  test("the bars are as tall as the room the columns keep for them", () => {
    expect(css).toMatch(/\.conversation__head, \.page__head \{[^}]*height: var\(--bar-h\)/);
    expect(css).toMatch(/\.panel__head \{[^}]*height: var\(--bar-h\)/);
    expect(css).toMatch(/\.panel \{[^}]*padding-top: var\(--bar-h\)/);
  });
  test("the bars still drag the window and their buttons still press", () => {
    expect(css).toMatch(/\.conversation__head, \.page__head \{[^}]*-webkit-app-region: drag/);
    expect(css).toMatch(/\.panel__head \{[^}]*-webkit-app-region: drag/);
    expect(css).toContain(".conversation__head > *, .page__head > * { -webkit-app-region: no-drag; }");
    expect(css).toContain(".panel__head > * { -webkit-app-region: no-drag; }");
  });
});
