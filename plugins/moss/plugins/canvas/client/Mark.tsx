// An agent's mark and a bot's face, as the canvas draws them until lane CA's SDK components land (`AgentMark`, `BotFace`
// in `@waifucave/moss-plugin-sdk/ui`; spec revision 20, §9.5). Both take those components' props, so the swap is a rename.
//
// The mark is drawn BARE (the owner, 2026-11-21: no tile, no border, nothing behind it), at the size the block gives it:
// * an icon in its own colours (a multi-colour SVG, a PNG): the image as it is;
// * a one-colour glyph (an SVG in `currentColor`): its shape filled with the agent's colour (a gradient for two), or the
//   theme's text colour for a black-and-white brand, as an image mask: never markup in the page;
// * no icon: ours, the name's first letter on the agent's colour (`agentMark`), or on the text colour for a brand with none.
//
// The face is a stand-in with `BotFace`'s props for the SDK's living face (the same drawing MOSS makes, from the bot's
// record, in the activity feed's state). It blinks and changes expression by state in CSS; it is the one thing on the
// canvas that may move while no session runs, as the face does in MOSS; it pauses with the window hidden and is still
// under reduced motion.
import { agentMark, type BotFaceProps } from "@waifucave/moss-plugin-sdk/ui";
import type { CSSProperties } from "react";
import { isGlyph, MOSS_CORAL, type BackendLook } from "./look";

export function Mark({ look, size = 26 }: { look: Pick<BackendLook, "id" | "name" | "icon" | "color" | "color2">; size?: number }) {
  const box = { width: size, height: size } satisfies CSSProperties;
  if (look.icon !== undefined && isGlyph(look.icon)) {
    const url = `url("data:${look.icon.mediaType};base64,${look.icon.data}")`;
    return <span className="cv-mark" data-kind="glyph" style={{ ...box, WebkitMaskImage: url, maskImage: url }} aria-hidden="true" />;
  }
  const m = agentMark(look);
  if (m.kind === "icon") return <img className="cv-mark" data-kind="icon" src={m.src} alt="" style={box} draggable={false} />;
  // A letter: on the agent's colour, or on the text colour when the brand has none (the page's own ink, never a grey).
  const style = { ...box, fontSize: Math.round(size * 0.52), ...(look.color !== undefined ? { background: m.background2 !== undefined ? `linear-gradient(135deg, ${m.background}, ${m.background2})` : m.background, color: m.foreground } : {}) } satisfies CSSProperties;
  return <span className="cv-mark" data-kind="letter" data-mono={look.color === undefined || undefined} style={style} aria-hidden="true">{m.letter}</span>;
}

/** The face's ink: the eyes, dark on any face colour. Data, as the face's colour is. */
const FACE_INK = "#1c1c1e";

/** Stand-in for the SDK's `BotFace` (same props): the bot's colour from its record's pins, else MOSS's coral, and an
 *  expression for its state. */
export function BotFace({ bot, face, size = 38, state = "idle" }: BotFaceProps) {
  const eye = { width: Math.round(size * 0.13), height: Math.round(size * 0.21), background: FACE_INK } satisfies CSSProperties;
  const color = face?.color ?? MOSS_CORAL;
  return (
    <span className="cv-face" data-face={bot} data-state={state} style={{ width: size, height: size, background: color, gap: Math.round(size * 0.16) }} aria-hidden="true">
      <i className="cv-eye" style={eye} />
      <i className="cv-eye" style={eye} />
    </span>
  );
}
