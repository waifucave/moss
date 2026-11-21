// The engine's session titles (spec revision 20, §9.5 "Titles"; contract `SessionTitles`, contracts/session-titles.ts).
// Owner: lane CG.
//
// A code session (`coding` or `agent`) with no title is titled once a turn of it ends, from its first message, on the
// light model of its own model's family (`lightModelFor`: lane LM's light model, the default's as the fallback). The
// person's title and a spawn's are never replaced by the engine; a titler that fails, or answers nothing, leaves the
// session untitled and is tried again at its next turn's end (one try in flight per session). A bot's conversation and a
// side thread are never titled. A title is one line, trimmed, at most 200 characters (`titleLine`).
//
// Where titles live is the store's (`TitleStore`): the session host keeps them in each session's meta, with who gave
// them, so a restart never retitles one; with none they live in memory.
import { Listeners, type Unsubscribe } from "../contracts/common";
import { titleLine, type SessionTitles, type TitleSource } from "../contracts/session-titles";

export type TitleKind = "bot" | "side-thread" | "agent" | "coding";

/** Where titles are kept: the host's metas, or memory. */
export interface TitleStore {
  get(session: string): { title: string; by: TitleSource } | undefined;
  put(session: string, title: string, by: TitleSource): void;
}

/** What the titler is asked: the session's first message, on a model tag. */
export type Titler = (text: string, model: string) => Promise<string>;

export class MemoryTitleStore implements TitleStore {
  readonly #titles = new Map<string, { title: string; by: TitleSource }>();
  get(session: string): { title: string; by: TitleSource } | undefined {
    return this.#titles.get(session);
  }
  put(session: string, title: string, by: TitleSource): void {
    this.#titles.set(session, { title, by });
  }
}

export class EngineSessionTitles implements SessionTitles {
  readonly #titler: Titler;
  readonly #lightModelFor: (model: string | undefined) => string;
  readonly #store: TitleStore;
  readonly #warn: (line: string) => void;
  readonly #changes = new Listeners<{ session: string; title: string; by: TitleSource }>();
  /** Sessions whose title is being made: a turn that ends meanwhile doesn't ask again. */
  readonly #inFlight = new Set<string>();
  /** Sessions whose failed try has been said: once each, so a home with titles turned off doesn't log every turn. */
  readonly #said = new Set<string>();

  constructor(o: { titler: Titler; lightModelFor: (model: string | undefined) => string; store?: TitleStore; warn?: (line: string) => void }) {
    this.#titler = o.titler;
    this.#lightModelFor = o.lightModelFor;
    this.#store = o.store ?? new MemoryTitleStore();
    this.#warn = o.warn ?? (() => {});
  }

  async turnEnded(s: { session: string; kind: TitleKind; model?: string; firstMessage?: string }): Promise<void> {
    if (s.kind !== "coding" && s.kind !== "agent") return;
    if (this.#store.get(s.session) !== undefined || this.#inFlight.has(s.session)) return;
    const first = s.firstMessage?.trim() ?? "";
    if (first === "") return;
    this.#inFlight.add(s.session);
    try {
      let model: string;
      let made: string;
      try {
        model = this.#lightModelFor(s.model);
        made = titleLine(await this.#titler(first, model));
      } catch (err) {
        // Never the turn's failure: the session stays untitled and its next turn's end tries again (said once a session).
        if (this.#said.has(s.session)) return;
        this.#said.add(s.session);
        this.#warn(`session ${s.session}: no title yet (${err instanceof Error ? err.message.slice(0, 200) : "the titler failed"}); tried again after its next turn`);
        return;
      }
      // Titled meanwhile (the person, a spawn): theirs stays.
      if (made === "" || this.#store.get(s.session) !== undefined) return;
      this.#put(s.session, made, "engine");
    } finally {
      this.#inFlight.delete(s.session);
    }
  }

  set(session: string, title: string, by: "user" | "spawn"): void {
    const line = titleLine(title);
    if (line === "") return;
    const old = this.#store.get(session);
    if (by === "spawn" && old !== undefined && old.by === "user") return;
    this.#put(session, line, by);
  }

  #put(session: string, title: string, by: TitleSource): void {
    this.#store.put(session, title, by);
    this.#changes.emit({ session, title, by });
  }

  title(session: string): { title: string; by: TitleSource } | undefined {
    return this.#store.get(session);
  }

  watch(fn: (change: { session: string; title: string; by: TitleSource }) => void): Unsubscribe {
    return this.#changes.add(fn);
  }
}
