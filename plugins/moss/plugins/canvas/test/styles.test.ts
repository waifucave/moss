import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssVariable, TOKENS } from "../client/tokens";
import { COLOR_LITERAL, frameUnsafeRules, parseCss, positionedRules } from "./css";

const css = readFileSync(join(import.meta.dir, "../client/styles.css"), "utf8");
const rules = parseCss(css);

/** What may move, fade, blur or transform. The canvas holds no sealed frame anywhere (no card, no `Card*` element:
 *  approvals stay in the session's tab), so these are listed to say what each one is, not to fence a frame. */
const LEAVES = [
  ".cv-ring::before", // the light round a running block (rotates)
  ".cv-dot", // the status dot (breathes while waiting)
  ".cv-card", // an ended block, dimmed
  ".cv-ring[data-handover]::before", // the running light taking over from an arriving message (appears at its point)
  ".cv-mlight--glow", // a message's light's blurred glow
  ".cv-msg__timer", // the unseen timer that ends a message
  ".cv-react__from", ".cv-react__to", // a block's effect reacting to a message: fades, a ripple scales
  ".cv-dotflash", // a point the light passes through
  ".cv-part", // reduced motion: the line highlighted
  ".cv-port", // a point showing as the cursor comes near
  ".cv-send", // disabled
  ".cv-chip", // an agent this computer lacks
  ".cv-create", // disabled
  ".cv-eye", // a bot's face: its eyes blink and move by its state
];

/** Everything out of the flow, each named. Those that reach outside a block (its points, its ring, the 30px "near"
 *  area) are all inside `.cv-world`, which `.cv-viewport` clips: nothing reaches outside the part. */
const POSITIONED = [
  ".cv-viewport", ".cv-world", ".cv-lines,\n.cv-over", ".cv-node", ".cv-node::before", ".cv-ring", ".cv-ring::before", ".cv-march", ".cv-react", ".cv-react__from,\n.cv-react__to",
  ".cv-port", ".cv-panel", ".cv-empty",
];
const INSIDE_THE_WORLD = new Set([".cv-node::before", ".cv-ring", ".cv-ring::before", ".cv-react", ".cv-react__from,\n.cv-react__to"]);

describe("the canvas stylesheet", () => {
  test("uses exactly the tokens tokens.ts names", () => {
    const used = new Set([...css.matchAll(/var\((--moss-[a-z0-9_-]+)/g)].map((m) => m[1]));
    const listed = new Set(TOKENS.map(cssVariable));
    expect([...used].filter((v) => !listed.has(v!))).toEqual([]);
    expect([...listed].filter((v) => !used.has(v))).toEqual([]);
  });

  test("holds no colour literals: every colour is a token, or the agent's own (`--brand`, data)", () => {
    const offenders = rules.flatMap((rule) => rule.declarations.filter((d) => COLOR_LITERAL.test(d.value)).map((d) => `${rule.prelude} { ${d.property}: ${d.value} }`));
    expect(offenders).toEqual([]);
  });

  test("only the listed leaves move, fade, blur or transform", () => {
    expect(frameUnsafeRules(css, LEAVES)).toEqual([]);
  });

  test("positions only its listed elements; what reaches past a block stays inside the clipped viewport", () => {
    const positioned = positionedRules(css);
    expect(positioned.map((p) => p.selector).sort()).toEqual([...POSITIONED].sort());
    expect(positioned.filter((p) => p.escapes && !INSIDE_THE_WORLD.has(p.selector)).map((p) => p.selector)).toEqual([]);
    const viewport = rules.find((r) => r.prelude === ".cv-viewport")!;
    expect(viewport.declarations).toContainEqual({ property: "overflow", value: "hidden" });
    // The points sit at -6px through calc(), which the escape check doesn't read: they are inside the world too.
    expect(rules.filter((r) => r.prelude.startsWith(".cv-port[data-port")).length).toBe(4);
  });

  test("animations run only on a running or waiting block and on a wave: a still canvas animates nothing", () => {
    const animated = rules.filter((r) => r.context.length === 0 && r.declarations.some((d) => d.property === "animation" && d.value !== "none")).map((r) => r.prelude);
    expect(animated.sort()).toEqual([
      ".cv-dotflash", ".cv-march__rect", ".cv-node[data-motion=\"running\"] .cv-dot", ".cv-node[data-motion=\"waiting\"] .cv-dot", ".cv-ring::before", ".cv-ring[data-handover]::before",
      // A message, only while one crosses (Canvas.tsx draws it then): its light, the timer, the blocks' reactions.
      ".cv-mlight", ".cv-msg__timer", ".cv-react__from,\n.cv-react__to",
      // A bot's face: the one thing that may move while no session runs, as it does in MOSS (the owner, 2026-11-21).
      ".cv-eye", ".cv-face[data-state=\"thinking\"] .cv-eye", ".cv-face[data-state=\"working\"] .cv-eye",
    ].sort());
    // The ring and the dashes exist only while their block runs or waits (Block.tsx draws them then), and a wave or a
    // hit only while a message crosses: so nothing here can run on a still canvas.
  });

  test("the running light turns with a transform (the compositor's), never by repainting a gradient's angle", () => {
    const spin = rules.filter((r) => r.context.some((c) => c.startsWith("@keyframes cv-spin")));
    expect(spin.flatMap((r) => r.declarations.map((d) => d.property))).toEqual(["transform", "transform"]);
    expect(css).not.toContain("@property");
  });

  test("reduced motion: the ring is solid, the dashes and dots still, a wave a brief highlight", () => {
    const reduced = rules.filter((r) => r.context.includes("@media (prefers-reduced-motion: reduce)"));
    const decl = (prelude: string) => reduced.find((r) => r.prelude === prelude)?.declarations ?? [];
    expect(decl(".cv-ring::before")).toContainEqual({ property: "animation", value: "none" });
    expect(decl(".cv-ring::before")).toContainEqual({ property: "background", value: "linear-gradient(135deg, var(--c1), var(--c2))" });
    expect(decl(".cv-eye,\n  .cv-face[data-state] .cv-eye")).toContainEqual({ property: "animation", value: "none" });
    expect(decl(".cv-node[data-motion=\"running\"] .cv-dot,\n  .cv-node[data-motion=\"waiting\"] .cv-dot,\n  .cv-march__rect")).toContainEqual({ property: "animation", value: "none" });
    // A message: each stretch in turn (its own delay), a brief highlight, no travel.
    expect(decl(".cv-mlight")).toContainEqual({ property: "display", value: "none" });
    expect(decl(".cv-part")).toContainEqual({ property: "animation", value: "cv-flash calc(0.6s * var(--cv-slow, 1)) ease-out calc(var(--delay) * var(--cv-slow, 1)) both" });
    expect(decl(".cv-dotflash")).toContainEqual({ property: "animation", value: "cv-flash calc(0.6s * var(--cv-slow, 1)) ease-out calc(var(--delay) * var(--cv-slow, 1)) both" });
  });

  test("never toward grey: every colour mix is toward transparent (clearer), none toward a neutral", () => {
    const all = css.match(/color-mix\(/g)?.length ?? 0;
    const clear = css.match(/color-mix\(in srgb, var\(--[a-z0-9-]+\) \d+%, transparent\)/g)?.length ?? 0;
    expect(all).toBeGreaterThan(0);
    expect(clear).toBe(all);
  });

  test("a hidden window pauses every animation", () => {
    const paused = rules.find((r) => r.declarations.some((d) => d.property === "animation-play-state" && d.value === "paused"))!;
    const selectors = paused.prelude.split(",").map((s) => s.trim());
    for (const animated of [".cv-ring::before", ".cv-dot", ".cv-march__rect", ".cv-mlight", ".cv-dotflash", ".cv-part", ".cv-msg__timer", ".cv-react__from", ".cv-react__to", ".cv-eye"]) expect(selectors).toContain(`.cv[data-hidden] ${animated}`);
  });
});
