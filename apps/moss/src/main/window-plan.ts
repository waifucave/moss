// MOSS's window material (the owner, 2026-11-22: MOSS's list and bars look as MOSS Code's sidebar and bar do). On macOS a
// real, visible window asks the system for the same material MOSS Code's does (`sidebar` vibrancy) and a clear backing,
// and its page is told, so the list column goes see-through only where there is a material to see. Every other window
// (headless, offscreen, a test's, Windows, Linux) keeps the solid colour it always had. Pure: the options are data; index.ts
// makes the window and tells the page.
import type { BrowserWindowConstructorOptions } from "electron";

/** What is behind MOSS's page: the system's material, or nothing (the window's own solid colour). */
export type Material = "vibrancy" | "none";

/** The clear backing a window with a material has (MOSS Code's main window's). */
export const CLEAR_BACKING = "#00000000";

/** The material a window gets. Only a real visible macOS window has one: a headless run draws nothing on the screen and an
 *  offscreen one has no window server behind it. */
export function materialOf(input: { platform: NodeJS.Platform; headless: boolean; offscreen: boolean; glass?: boolean }): Material {
  if (input.glass === true) return "vibrancy";
  return input.platform === "darwin" && !input.headless && !input.offscreen ? "vibrancy" : "none";
}

/** The window options that depend on the material: a clear backing and the sidebar vibrancy, or today's solid colour. */
export function materialOptions(material: Material, solid: string): Pick<BrowserWindowConstructorOptions, "backgroundColor" | "vibrancy" | "visualEffectState"> {
  return material === "vibrancy"
    ? { backgroundColor: CLEAR_BACKING, vibrancy: "sidebar", visualEffectState: "followWindow" }
    : { backgroundColor: solid };
}
