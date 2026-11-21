// The agent mark: the plugin's icon as an image only, a `currentColor` glyph as a mask in the backend's colour or the text's,
// our letter mark otherwise (spec revision 20, §9.5; the owner's final picks in the logos' READY.md).
import { describe, expect, test } from "bun:test";
import { AgentMark } from "../src/ui";
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
  });

  test("black, white and grey have no hue", () => {
    expect(["#000000", "#ffffff", "#8a8f98", "#1F1F1F"].map(isChromatic)).toEqual([false, false, false, false]);
    expect(["#D97757", "#484FF6", "#4D6BFE"].map(isChromatic)).toEqual([true, true, true]);
  });
});
