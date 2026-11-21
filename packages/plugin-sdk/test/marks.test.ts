// The agent mark: the plugin's icon as an image only, a `currentColor` glyph as a mask in the backend's colour or the text's,
// our letter mark otherwise (spec revision 20, §9.5; the owner's final picks in the logos' READY.md).
import { describe, expect, test } from "bun:test";
import { AgentMark, botFaceLook } from "../src/ui";
import { makeBot } from "../src/ui/faces";
import { agentMark, isChromatic } from "../src/ui/marks";

const svg = (fill: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path fill="${fill}" d="M0 0h8v8z"/></svg>`).toString("base64");
const icon = (fill: string) => ({ mediaType: "image/svg+xml" as const, data: svg(fill), at: 1 });

describe("agentMark", () => {
  test("a one-colour glyph (currentColor) is a mask in the backend's colour when it has one with a hue, else the theme's text", () => {
    expect(agentMark({ id: "codex", name: "Codex", icon: icon("currentColor"), color: "#484FF6", color2: "#7893F9" })).toMatchObject({ kind: "mask", fill: "#484FF6", fill2: "#7893F9" });
    expect(agentMark({ id: "cursor", name: "Cursor", icon: icon("currentColor") })).toEqual({ kind: "mask", src: `data:image/svg+xml;base64,${svg("currentColor")}` });
    expect(agentMark({ id: "x", name: "X", icon: icon("currentColor"), color: "#222222" })).not.toHaveProperty("fill");
    expect(agentMark({ id: "x", name: "X", icon: icon("currentColor"), color: "#ffffff" })).not.toHaveProperty("fill");
  });

  test("a mark with its own colours stays an image; with no icon it is the letter on the colour", () => {
    expect(agentMark({ id: "claude-code", name: "Claude Code", icon: icon("#D97757"), color: "#D97757" }).kind).toBe("icon");
    expect(agentMark({ id: "gemini", name: "Gemini", icon: { mediaType: "image/png", data: "AAAA", at: 1 } }).kind).toBe("icon");
    expect(agentMark({ id: "devin", name: "Devin" })).toMatchObject({ kind: "letter", letter: "D" });
  });

  test("what the page gets is an image or a plain span, never the file's markup", () => {
    // AgentMark uses no hook: called as a function it answers its element.
    const el = (backend: Parameters<typeof AgentMark>[0]["backend"]) => AgentMark({ backend }) as unknown as { type: string; props: Record<string, unknown> };
    const img = el({ id: "c", name: "C", icon: icon("#D97757") });
    expect([img.type, String(img.props.src).startsWith("data:image/svg+xml;base64,")]).toEqual(["img", true]);
    const mask = el({ id: "d", name: "D", icon: icon("currentColor"), color: "#484FF6" });
    expect([mask.type, mask.props["data-agent-mark"], (mask.props.style as { background: string }).background]).toEqual(["span", "mask", "#484FF6"]);
    const plain = el({ id: "e", name: "E", icon: icon("currentColor") });
    expect((plain.props.style as { background: string }).background).toBe("currentColor");
    expect(el({ id: "z", name: "Zed" }).props.children).toBe("Z");
    for (const x of [img, mask, plain]) expect(JSON.stringify(x.props)).not.toContain("<path");
    // The owner's correction (2026-11-21): a real icon is drawn BARE (no tile, border or tinted background; a one-colour glyph's
    // only paint is its own colour, or the text's), at the size asked; only the no-icon fallback is a letter on a colour. A brand
    // colour is never mixed toward grey: it reaches the paint as given (a gradient of the two when there are two).
    const sized = AgentMark({ backend: { id: "c", name: "C", icon: icon("#D97757") }, size: 40 }) as unknown as { props: { width: number; height: number; style: Record<string, unknown> } };
    expect([sized.props.width, sized.props.height]).toEqual([40, 40]);
    for (const k of ["background", "backgroundColor", "border", "borderRadius", "padding", "boxShadow", "opacity", "filter"]) expect(sized.props.style[k]).toBeUndefined();
    const two = el({ id: "g", name: "G", icon: icon("currentColor"), color: "#484FF6", color2: "#7893F9" });
    expect((two.props.style as { background: string }).background).toBe("linear-gradient(135deg, #484FF6, #7893F9)");
    // A backend with a mark for each theme: the dark one where the theme is dark, the same bare image otherwise.
    const themed = AgentMark({ backend: { id: "t", name: "T", icon: icon("#1B1D2B"), iconDark: icon("#F6F4EE") } }) as unknown as { type: string; props: { children: unknown[] } };
    expect(themed.type).toBe("picture");
    const [source, themedImg] = themed.props.children as { type: string; props: Record<string, string | undefined> }[];
    expect([source!.type, source!.props.media, source!.props.srcSet!.startsWith("data:image/svg+xml;base64,"), themedImg!.props["data-agent-mark"]]).toEqual(["source", "(prefers-color-scheme: dark)", true, "icon"]);
    const letter = el({ id: "x", name: "Xy", color: "#4D6BFE" });
    expect((letter.props.style as { background: string }).background).toBe("#4D6BFE");
  });

  test("black, white and grey have no hue", () => {
    expect(["#000000", "#ffffff", "#8a8f98", "#1F1F1F"].map(isChromatic)).toEqual([false, false, false, false]);
    expect(["#D97757", "#484FF6", "#4D6BFE"].map(isChromatic)).toEqual([true, true, true]);
  });
});

describe("botFaceLook: a bot's face as the faces kit resolves it", () => {
  // The three sample bots (the session canvas's gallery): pinned traits, and the rest drawn from the name.
  const SAMPLES = [
    { name: "MOSS", face: { shape: "tile", color: "coral", eyes: "round" } },
    { name: "Pip", face: { shape: "drop", color: "sky", eyes: "tall", temper: "restless" } },
    { name: "Juno", face: { shape: "gem", color: "mint", eyes: "dot", temper: "slow" } },
  ] as const;

  test("answers as the kit's makeBot does, for the pins and for the name alone", () => {
    for (const s of SAMPLES) {
      for (const face of [s.face, undefined]) {
        const kit = makeBot(s.name, face ?? {});
        expect(botFaceLook(s.name, face)).toEqual({ shape: kit.shape, colorName: kit.colorName, color: kit.color, eyes: kit.eye.kind, temper: kit.temper });
      }
    }
    expect(SAMPLES.map((s) => botFaceLook(s.name, s.face).color)).toEqual(["#F0694C", "#4A9CEC", "#3DBE8B"]);
    expect(botFaceLook("Pip", { color: "#a1b2c3" }).color).toBe("#A1B2C3");
  });
});
