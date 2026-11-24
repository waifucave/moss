// A pending card's place went away (a window closed, or one of its documents loaded again): the card is placed again by the
// same rule as its first place, at once, and the safety net runs if no place shows its buttons. Narrow by construction:
//  * only the cards that had frames in THAT window are touched (a reload in an unrelated window leaves every other card alone);
//  * a running fallback deadline is never moved (a plugin that reloads itself every second must not hold a card's net back);
//  * a card still inside the beat its conversation is given to ask for it is left to that beat (`placeArrivedCard`);
//  * a card is re-placed at most MAX_REPLACEMENTS times in its life: after that it goes straight to the net and stays there, so
//    no pattern of closes keeps a card moving.
// Pure over `ReplaceDeps` (index.ts gives the real ones), so each rule is tested.
import { replacement } from "./card-place";
import type { CardPlacement } from "@waifucave/moss-protocol";

export const MAX_REPLACEMENTS = 5;

export interface ReplaceDeps {
  /** The pending cards that have frames in this window (a closed window's marks are dropped; a reloaded document's are cleared). */
  cardsIn(windowId: number, closed: boolean, documentKey?: string): string[];
  isPending(cardId: string): boolean;
  /** The app has been told of the card (`cardArrived`). */
  arrived(cardId: string): boolean;
  /** The card has been placed at least once (a card still in its conversation's beat has not). */
  placedOnce(cardId: string): boolean;
  /** Places the card by the first rule again (forgets the old place, `placeCardNow`). */
  place(cardId: string): void;
  restack(): void;
  engineplace(cardId: string): CardPlacement | undefined;
  front(): boolean;
  drawnInWindow(cardId: string): boolean;
  buttonsShown(cardId: string): boolean;
  fallbackHere(cardId: string): boolean;
  fallbackRunning(cardId: string): boolean;
  fallbackWindowOpen(cardId: string): boolean;
  armFallback(cardId: string): void;
  /** The net's own card at once (no timer). */
  showFallbackNow(cardId: string): void;
  log(line: string): void;
}

export class CardReplacer {
  readonly #counts = new Map<string, number>();
  constructor(private readonly d: ReplaceDeps) {}

  lost(windowId: number, closed: boolean, documentKey?: string): void {
    for (const id of this.d.cardsIn(windowId, closed, documentKey)) this.#replace(id, closed ? "its surface closed" : "a document loaded again");
  }

  /** The card resolved: its count goes. */
  forget(cardId: string): void {
    this.#counts.delete(cardId);
  }

  countOf(cardId: string): number {
    return this.#counts.get(cardId) ?? 0;
  }

  #replace(cardId: string, why: string): void {
    const d = this.d;
    if (!d.isPending(cardId) || !d.arrived(cardId) || !d.placedOnce(cardId)) return;
    const n = (this.#counts.get(cardId) ?? 0) + 1;
    this.#counts.set(cardId, n);
    if (this.#counts.size > 256) this.#counts.delete(this.#counts.keys().next().value!);
    if (n > MAX_REPLACEMENTS) {
      // Enough: the app's own card draws it and nothing moves the card again. Asked on every later loss (an open one is kept), so
      // a card whose buttons showed again and went again is never left with nowhere.
      if (d.fallbackHere(cardId) && !d.fallbackWindowOpen(cardId) && !d.buttonsShown(cardId)) {
        if (n === MAX_REPLACEMENTS + 1) d.log(`card: ${cardId} its place went away too often: the app's own card draws it`);
        d.showFallbackNow(cardId);
      }
      return;
    }
    d.log(`card: ${cardId} its place went away (${why}): placed again`);
    d.place(cardId);
    d.restack();
    const again = replacement({ placed: d.engineplace(cardId), front: d.front(), drawnInWindow: d.drawnInWindow(cardId), buttonsShown: d.buttonsShown(cardId), fallbackHere: d.fallbackHere(cardId), fallbackWindowOpen: d.fallbackWindowOpen(cardId) });
    // A deadline already running is kept: only a card with none gets one.
    if (again.armFallback && !d.fallbackRunning(cardId)) d.armFallback(cardId);
  }
}
