// One block on the canvas (spec revision 20, §9.5): the agent's mark, the title, `agent · model · effort` and one status
// line; light going round it while it runs, slow marching dashes while it waits on background jobs (running wins), nothing
// while it is still. Its four connection points: left, who started it; right, what it started; top and bottom, other main
// sessions it talks to. A joined point always shows; the others while the cursor is near.
//
// Pressed (a click, Enter or Space), it grows a little and shows the session's last line, a composer that sends as the
// person, and "Open tab". A bot's block offers "Open in MOSS" instead. A subagent's has no composer (no one can message
// it) and opens its session's tab.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type SyntheticEvent } from "react";
import type { Rect } from "./layout";
import type { BackendLook } from "./look";
import { Face, Mark } from "./Mark";
import type { Block } from "./model";
import { S } from "./strings";

export type Port = "l" | "r" | "t" | "b";

/** The points each kind of block has: a bot starts sessions (right) and may talk to one (top, bottom); a subagent is
 *  started (left) and starts nothing a person can see. */
export const PORTS: Readonly<Record<Block["type"], readonly Port[]>> = { main: ["l", "r", "t", "b"], sub: ["l", "r"], bot: ["r", "t", "b"] };

/** Whether an event is the person's own: a page's own `click()` or a dispatched event is not, and sends nothing (the app
 *  refuses it too; this keeps the page from even asking). */
export const byPerson = (e: SyntheticEvent): boolean => e.nativeEvent.isTrusted === true;

export interface BlockViewProps {
  block: Block;
  rect: Rect;
  look?: BackendLook;
  open: boolean;
  joined: ReadonlySet<Port>;
  dragging?: boolean;
  /** How many of the person's messages it got while the canvas was open (a steady mark beside the point's light). */
  heard?: number;
  /** The session's last line while open: undefined while it is read, null when it has none. */
  line?: string | null;
  onToggle(id: string): void;
  onClose(): void;
  onHeadPointerDown?(e: PointerEvent<HTMLButtonElement>, id: string): void;
  onSend(session: string, text: string): Promise<void>;
  onOpenTab(session: string): void;
  onOpenInMoss(bot: string): Promise<void>;
}

export function BlockView(p: BlockViewProps) {
  const { block: b, rect, open } = p;
  // Open, it grows a little to the right; its points stay where its lines meet it (`--bw`, `--bh`: its closed size).
  const grow = open ? (b.type === "bot" ? 40 : 70) : 0;
  const style = { left: rect.x, top: rect.y, width: rect.w + grow, "--bw": `${rect.w}px`, "--bh": `${rect.h}px`, minHeight: rect.h, "--brand": b.brand } as CSSProperties;
  const label = S.state(b.title, b.type === "bot" ? S.bot : b.meta, b.status);
  const head = useRef<HTMLButtonElement>(null);
  const close = () => {
    p.onClose();
    head.current?.focus();
  };
  return (
    <li
      className="cv-node"
      data-type={b.type}
      data-motion={b.motion}
      data-open={open || undefined}
      data-dragging={p.dragging || undefined}
      data-block={b.id}
      {...(p.heard !== undefined && p.heard > 0 ? { "data-heard": p.heard } : {})}
      style={style}
      onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); close(); } }}
    >
      {b.motion === "running" && <span className="cv-ring" aria-hidden="true" />}
      {b.motion === "waiting" && (
        <svg className="cv-march" aria-hidden="true">
          <rect className="cv-march__rect" />
        </svg>
      )}
      <div className="cv-card">
        <button
          ref={head}
          type="button"
          className="cv-head"
          aria-expanded={open}
          aria-label={label}
          onPointerDown={(e) => p.onHeadPointerDown?.(e, b.id)}
          onClick={() => p.onToggle(b.id)}
        >
          {b.type === "bot" ? (
            <span className="cv-bothead">
              <Face color={b.brand} />
              <span className="cv-text">
                <span className="cv-title" title={b.title}>{b.title}</span>
                <span className="cv-meta">{S.bot}</span>
              </span>
            </span>
          ) : (
            <>
              <span className="cv-row">
                <Mark look={p.look ?? { id: b.backend ?? b.title, name: b.meta.split(" · ")[0] ?? b.title, color: b.brand, ...(b.brand2 !== undefined ? { color2: b.brand2 } : {}) }} size={b.type === "sub" ? 22 : 26} />
                <span className="cv-text">
                  <span className="cv-title" title={b.title}>
                    {b.title}
                    {b.type === "sub" && <span className="cv-tag">{S.sub}</span>}
                  </span>
                  <span className="cv-meta" title={b.meta}>{b.meta}</span>
                </span>
              </span>
              <span className="cv-status">
                <span className="cv-dot" aria-hidden="true" />
                <span className="cv-status__text">{b.status}</span>
              </span>
            </>
          )}
        </button>
        {open && <More {...p} onClose={close} />}
      </div>
      {PORTS[b.type].map((port) => (
        <span key={port} className="cv-port" data-port={port} data-on={p.joined.has(port) || undefined} aria-hidden="true" />
      ))}
    </li>
  );
}

function More(p: BlockViewProps) {
  const b = p.block;
  const [error, setError] = useState<string | undefined>();
  if (b.type === "bot") {
    return (
      <div className="cv-more">
        <div className="cv-actions">
          <button
            type="button"
            className="cv-button"
            onClick={(e) => {
              if (!byPerson(e) || b.bot === undefined) return;
              setError(undefined);
              void p.onOpenInMoss(b.bot).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
            }}
          >
            {S.openInMoss} <span aria-hidden="true">↗</span>
          </button>
        </div>
        {error !== undefined && <p className="cv-error" role="alert">{error}</p>}
      </div>
    );
  }
  return (
    <div className="cv-more">
      <p className="cv-last" title={p.line ?? undefined}>{p.line === undefined ? S.readingLine : p.line === null ? S.noLine : p.line}</p>
      {b.messageable && b.session !== undefined && <Composer session={b.session} title={b.title} onSend={p.onSend} />}
      <div className="cv-actions">
        <button type="button" className="cv-button" onClick={() => b.session !== undefined && p.onOpenTab(b.session)}>
          {b.type === "sub" ? S.openParent : S.openTab} <span aria-hidden="true">↗</span>
        </button>
      </div>
    </div>
  );
}

/** The block's composer: the person's own words to this session, sent from inside their own key press or click
 *  (`useUserSend`, through `onSend`), one send per press: a held Enter's repeats, a press while one is on its way and an
 *  event the page makes itself send nothing. */
export function Composer({ session, title, onSend }: { session: string; title: string; onSend(session: string, text: string): Promise<void> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const busy = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const fire = (e: SyntheticEvent) => {
    if (!byPerson(e)) return;
    const words = text.trim();
    if (words === "" || busy.current) return;
    busy.current = true;
    setSending(true);
    setError(undefined);
    // Called here, inside the press: the app counts it as the person's only then.
    void onSend(session, words).then(
      () => setText(""),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    ).finally(() => {
      busy.current = false;
      setSending(false);
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!e.repeat) fire(e);
  };
  return (
    <div className="cv-composer">
      <textarea
        ref={field}
        className="cv-composer__field"
        rows={1}
        value={text}
        placeholder={S.message}
        aria-label={S.messageLabel(title)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <button type="button" className="cv-send" disabled={sending || text.trim() === ""} onClick={fire}>
        {sending ? S.sending : S.send}
      </button>
      {error !== undefined && <p className="cv-error" role="alert">{error}</p>}
    </div>
  );
}
