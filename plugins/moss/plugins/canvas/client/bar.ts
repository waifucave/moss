// What the canvas's page and its line on the window's bar (`page.bar`, keyed `start`) share. Both are this plugin's
// entries, drawn in the same document: the page says what the line reads and what + is doing, and the bar's + and
// "N ended" ask the page to act, inside the person's press (the page then makes the calls a press may make).
import { useSyncExternalStore } from "react";

export interface BarState {
  /** False until a page is there to read: the bar shows no counts and + does nothing until then. */
  ready: boolean;
  sessions: number;
  running: number;
  waiting: number;
  /** Ended sessions folded out of view, and whether they are shown. */
  folded: number;
  showEnded: boolean;
  /** The + panel is open. */
  panel: boolean;
}

export interface BarActions {
  plus(): void;
  toggleEnded(): void;
}

export const IDLE_BAR: BarState = { ready: false, sessions: 0, running: 0, waiting: 0, folded: 0, showEnded: false, panel: false };

export interface BarLink {
  state(): BarState;
  /** The page's word on what the line reads (a change of nothing tells nobody). */
  publish(next: BarState): void;
  /** The page's actions, while it is shown; the returned function takes them back (and the line goes idle). */
  attach(actions: BarActions): () => void;
  plus(): void;
  toggleEnded(): void;
  subscribe(listener: () => void): () => void;
}

export function createBarLink(): BarLink {
  let state = IDLE_BAR;
  let actions: BarActions | undefined;
  const listeners = new Set<() => void>();
  const tell = () => { for (const l of [...listeners]) l(); };
  const same = (a: BarState, b: BarState) => (Object.keys(a) as (keyof BarState)[]).every((k) => a[k] === b[k]);
  return {
    state: () => state,
    publish(next) {
      if (same(state, next)) return;
      state = next;
      tell();
    },
    attach(a) {
      actions = a;
      return () => {
        if (actions !== a) return;
        actions = undefined;
        state = IDLE_BAR;
        tell();
      };
    },
    plus: () => actions?.plus(),
    toggleEnded: () => actions?.toggleEnded(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The one link of this document (a window is one document: its page and its bar). */
export const barLink = createBarLink();

export function useBar(link: BarLink = barLink): BarState {
  return useSyncExternalStore(link.subscribe, link.state, link.state);
}
