// Contract: SessionTitles (spec revision 20, §9.5 "Titles"). Owner: lane CG, over the engine's titler (`agent/titles.ts`,
// `SessionTitler`) on the session's model family's light model (lane LM's `lightModelOn`, `runtime-sdk/model-plugins/
// light-model.ts`, with the default as the fallback).
//
// Who titles a code session and when, so whatever draws a session has a title: the shape on the wire is `SessionView.title`,
// and its change reaches every reader as `session_changed`.
//
// What the contract promises:
// * A code session (`coding` or `agent`) with no title is titled once its first turn ends, from its first message, on
//   the light model of its own model's family (`lightModelFor`). A bot's conversation and a side thread are not: a bot has
//   a name, a routine run its routine's.
// * A title the person gave (`set(…, "user")`) or a spawn gave (`"spawn"`) is never replaced by the engine; the person's
//   rename replaces any title.
// * A titler that fails leaves the session untitled, and it is tried again at its next turn's end. A title is one line,
//   trimmed, at most 200 characters.
import type { Unsubscribe } from "./common";

export type TitleSource = "user" | "spawn" | "engine";

export interface SessionTitles {
  /** A turn of `session` ended. `firstMessage` is the session's first message (the person's, or the spawn's prompt). */
  turnEnded(s: { session: string; kind: "bot" | "side-thread" | "agent" | "coding"; model?: string; firstMessage?: string }): Promise<void>;
  set(session: string, title: string, by: "user" | "spawn"): void;
  title(session: string): { title: string; by: TitleSource } | undefined;
  watch(fn: (change: { session: string; title: string; by: TitleSource }) => void): Unsubscribe;
}

/** A title as kept: one line, trimmed, at most 200 characters; empty when nothing is left. */
export function titleLine(text: string): string {
  return (text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "").slice(0, 200).trim();
}
