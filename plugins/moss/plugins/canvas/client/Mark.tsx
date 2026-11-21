// An agent's mark and a bot's face, as the canvas draws them until lane CA's SDK components land (`AgentMark`,
// `BotFace` in `@waifucave/moss-plugin-sdk/ui`; spec revision 20, §9.5). The mark already follows the SDK's own rule
// (`agentMark`): the icon its plugin ships, as an image only, else the name's first letter on the agent's colour. The
// face is a stand-in in the bot's colour (MOSS's coral, the mock-up's two eyes) for `BotFace`, which draws the bot's
// real face from `bot.records`.
import { agentMark } from "@waifucave/moss-plugin-sdk/ui";
import type { CSSProperties } from "react";
import type { BackendLook } from "./look";

/** The face's ink: the eyes, dark on any face colour. Data, as the face's colour is. */
const FACE_INK = "#1c1c1e";

export function Mark({ look, size = 26 }: { look: Pick<BackendLook, "id" | "name" | "icon" | "color" | "color2">; size?: number }) {
  const m = agentMark(look);
  if (m.kind === "icon") {
    return (
      <span className="cv-mark" data-kind="icon" style={{ width: size, height: size, "--brand": look.color ?? "transparent" } as CSSProperties} aria-hidden="true">
        <img src={m.src} alt="" draggable={false} />
      </span>
    );
  }
  const style = {
    width: size, height: size, fontSize: Math.round(size * 0.52),
    background: m.background2 !== undefined ? `linear-gradient(135deg, ${m.background}, ${m.background2})` : m.background,
    color: m.foreground,
  } satisfies CSSProperties;
  return <span className="cv-mark" data-kind="letter" style={style} aria-hidden="true">{m.letter}</span>;
}

export function Face({ color, size = 38 }: { color: string; size?: number }) {
  const eye = { width: Math.round(size * 0.13), height: Math.round(size * 0.21), background: FACE_INK } satisfies CSSProperties;
  return (
    <span className="cv-face" style={{ width: size, height: size, background: color, gap: Math.round(size * 0.16) }} aria-hidden="true">
      <i style={eye} />
      <i style={eye} />
    </span>
  );
}
