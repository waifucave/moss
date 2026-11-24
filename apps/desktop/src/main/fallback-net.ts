// The app's own card (the safety net, and the window's strip): which cards have a timer running or a window open, and the
// rules for arming, standing down and showing one now. A Map of entries so every one-line caller in index.ts keeps working;
// the window itself is made by the injected `show` (index.ts `showFallbackCard`), the only thing a test stands in for.
//  * `arm` starts a card's timer over; `armIfNone` never moves one that runs or one that is open;
//  * `disarm` clears the timer, closes the window and forgets the card;
//  * `showNow` draws the card at once: the entry is made first (the window's maker holds one for the card), an open window is
//    kept, and a running timer is replaced by the window.
export interface NetEntry<W> {
  timer: ReturnType<typeof setTimeout>;
  win?: W;
  token?: string;
  strip?: boolean;
  /** The timer ran out (or the card was shown at once): a card with no window after that has nothing running. */
  fired?: boolean;
}

export interface NetDeps<W> {
  delayMs: number;
  /** The timers (a test's fake clock); setTimeout and clearTimeout by default. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Makes the card's window and sets `win` on the entry it finds for the card. */
  show(cardId: string, strip: boolean): void | Promise<void>;
  closeWindow(win: W): void;
  isAlive(win: W): boolean;
  /** After a card's entry is cleared (the stacking is decided again). */
  changed?(): void;
}

export class FallbackNet<W> extends Map<string, NetEntry<W>> {
  constructor(private readonly d: NetDeps<W>) {
    super();
  }

  #schedule(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return this.d.schedule !== undefined ? this.d.schedule(fn, ms) : setTimeout(fn, ms);
  }

  #unschedule(timer: ReturnType<typeof setTimeout>): void {
    if (this.d.unschedule !== undefined) this.d.unschedule(timer); else clearTimeout(timer);
  }

  /** The card's timer starts over (any window of its closes first). */
  arm(cardId: string): void {
    this.disarm(cardId);
    const entry: NetEntry<W> = { timer: undefined as never };
    entry.timer = this.#schedule(() => { entry.fired = true; void this.d.show(cardId, false); }, this.d.delayMs);
    entry.timer.unref?.();
    this.set(cardId, entry);
  }

  /** Whether a timer still runs or a window is open for the card. */
  isLive(cardId: string): boolean {
    const own = this.get(cardId);
    return own !== undefined && (this.isOpen(cardId) || own.fired !== true);
  }

  /** A timer that runs, or a window that is open, is left as it is (a deadline is never moved). */
  armIfNone(cardId: string): void {
    if (!this.isLive(cardId)) this.arm(cardId);
  }

  disarm(cardId: string): void {
    const own = this.get(cardId);
    if (own === undefined) return;
    this.#unschedule(own.timer);
    if (own.win !== undefined && this.d.isAlive(own.win)) this.d.closeWindow(own.win);
    this.delete(cardId);
    this.d.changed?.();
  }

  isOpen(cardId: string): boolean {
    const own = this.get(cardId);
    return own?.win !== undefined && this.d.isAlive(own.win);
  }

  /** The card's own window now, with no timer: kept as it is if already open. */
  showNow(cardId: string, strip = false): void {
    if (this.isOpen(cardId)) return;
    const own = this.get(cardId);
    if (own !== undefined) this.#unschedule(own.timer);
    this.set(cardId, { timer: this.#schedule(() => undefined, 0), fired: true, ...(strip ? { strip: true } : {}) });
    void this.d.show(cardId, strip);
  }
}
