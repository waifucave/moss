// Lane HC: a window in which nothing takes the keyboard's focus never ends a Tab (Chromium walks the page, hands the focus to the
// window, and the window walks the page again at once: the background host's island spun about 55% of a core for 37 minutes).
// The core root's focus stop ends every walk (src/core/root.ts syncFocusStop); the host idle acceptance row presses that Tab on
// the real host. This test keeps the stop where a Tab can land on it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, "../src/core", file), "utf8");

describe("the core root's focus stop", () => {
  test("the root document holds it, last in its order, tabbable from the first paint", () => {
    const html = read("index.html");
    const stop = /<div id="moss-focus-stop" tabindex="(-?\d+)"><\/div>/.exec(html);
    expect(stop?.[1]).toBe("0");
    // Last: a Tab walks the plugin's frame first and ends on the stop only when nothing there takes it.
    expect(html.indexOf("moss-focus-stop")).toBeGreaterThan(html.indexOf('id="moss-stage"'));
    expect(html.indexOf("moss-focus-stop")).toBeGreaterThan(html.indexOf('id="moss-page"'));
  });

  test("it is rendered (a Tab can't land on an element that isn't) and takes no pointer", () => {
    const rule = /#moss-focus-stop \{([^}]*)\}/.exec(read("root.css"))?.[1] ?? "";
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden|content-visibility/);
    expect(rule).toMatch(/pointer-events:\s*none/);
  });

  test("it is tabbable in every surface window and in a window no plugin frame fills, and only there", () => {
    const ts = read("root.ts");
    const body = /function syncFocusStop\(\): void \{([\s\S]*?)\n\}/.exec(ts)?.[1] ?? "";
    expect(body).toContain('info?.context.surface !== undefined || stage.querySelector("iframe") === null');
    expect(body).toContain("stop.tabIndex = needed ? 0 : -1");
    // It follows every change of what the stage shows: syncDrag runs after each render, note, mount and page.
    expect(/function syncDrag\(\): void \{\s*syncFocusStop\(\);/.test(ts)).toBe(true);
  });
});
