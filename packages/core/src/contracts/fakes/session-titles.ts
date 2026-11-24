// FakeSessionTitles: titles in memory, over a titler and a light-model lookup the test gives.
import { Listeners, type Unsubscribe } from "../common";
import { titleLine, type SessionTitles, type TitleSource } from "../session-titles";

export class FakeSessionTitles implements SessionTitles {
  readonly #titles = new Map<string, { title: string; by: TitleSource }>();
  readonly #changes = new Listeners<{ session: string; title: string; by: TitleSource }>();

  constructor(
    private readonly titler: (text: string, model: string) => Promise<string>,
    private readonly lightModelFor: (model: string | undefined) => string,
  ) {}

  async turnEnded(s: { session: string; kind: "bot" | "side-thread" | "agent" | "coding"; model?: string; firstMessage?: string }): Promise<void> {
    if (s.kind !== "coding" && s.kind !== "agent") return;
    if (this.#titles.has(s.session) || s.firstMessage === undefined || s.firstMessage.trim() === "") return;
    let made: string;
    try {
      made = titleLine(await this.titler(s.firstMessage, this.lightModelFor(s.model)));
    } catch {
      return;
    }
    if (made === "" || this.#titles.has(s.session)) return;
    this.#put(s.session, made, "engine");
  }

  set(session: string, title: string, by: "user" | "spawn"): void {
    const line = titleLine(title);
    if (line === "") return;
    const old = this.#titles.get(session);
    if (by === "spawn" && old !== undefined && old.by === "user") return;
    this.#put(session, line, by);
  }

  #put(session: string, title: string, by: TitleSource): void {
    this.#titles.set(session, { title, by });
    this.#changes.emit({ session, title, by });
  }

  title(session: string): { title: string; by: TitleSource } | undefined {
    return this.#titles.get(session);
  }

  watch(fn: (change: { session: string; title: string; by: TitleSource }) => void): Unsubscribe {
    return this.#changes.add(fn);
  }
}
