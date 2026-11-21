import { describe, expect, test } from "bun:test";
import { faceColour } from "../client/faceColour";

// The faces kit's own answers (`makeBot(name).color` in MOSS's living-bots.js, read 2026-11-21; 160 names and pins
// checked against it with no difference). A bundled plugin can't import the kit, so they are written down here.
const FROM_NAME: [string, string][] = [
  ["MOSS", "#4A9CEC"], ["Pip", "#F4893A"], ["Juno", "#4A9CEC"], ["Alpha", "#4A9CEC"], ["Scout", "#9A7BF0"], ["  river ", "#1FB2BE"], ["", "#9A7BF0"],
  ["Nova", "#9A7BF0"], ["Bramble", "#1FB2BE"], ["Quill", "#E5A72E"], ["Atlas", "#1FB2BE"], ["Wren", "#4A9CEC"], ["Moth", "#3DBE8B"], ["Fig", "#5F70E2"],
  ["Echo", "#1FB2BE"], ["Tansy", "#5F70E2"], ["Orbit", "#1FB2BE"], ["Zed", "#4A9CEC"], ["Kiwi", "#1FB2BE"], ["Lumen", "#3DBE8B"],
];

describe("a bot's face colour, as the faces kit resolves it", () => {
  test("from its name when its record pins none", () => {
    for (const [name, hex] of FROM_NAME) expect([name, faceColour(name)]).toEqual([name, hex]);
  });

  test("a pinned palette name (any case) or #rrggbb wins; anything else falls back to the name's", () => {
    expect(faceColour("Pip", { color: "sky" })).toBe("#4A9CEC");
    expect(faceColour("Juno", { color: "MINT" })).toBe("#3DBE8B");
    expect(faceColour("MOSS", { color: "coral" })).toBe("#F0694C");
    expect(faceColour("Pip", { color: "#a1b2c3" })).toBe("#A1B2C3");
    expect(faceColour("Pip", { color: "nope" })).toBe("#F4893A");
  });
});
