// How long each step of an agent's start took, as ONE line in the engine's log (`[agents] <session>: start took 5512 ms:
// provide 2, detect 640, ...`). The owner measured 21.6 s for "hi" on a Codex session, of which about 5.5 s passed in MOSS
// before the first request to the adapter; this says where. Real time (`performance.now`), never the injected clock:
// a step is what a person waited. A step that waits for the person (a card) is named so, and is not a cost of MOSS's.
export class StepTimer {
  readonly #now: () => number;
  readonly #began: number;
  #last: number;
  readonly #steps: { step: string; ms: number }[] = [];

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#began = now();
    this.#last = this.#began;
  }

  /** The step that ends now: the time since the one before. */
  mark(step: string): void {
    const at = this.#now();
    this.#steps.push({ step, ms: Math.round(at - this.#last) });
    this.#last = at;
  }

  /** The steps, in order, and the total. */
  line(): string {
    const total = Math.round(this.#last - this.#began);
    return `start took ${total} ms: ${this.#steps.map((s) => `${s.step} ${s.ms}`).join(", ")}`;
  }

  get steps(): readonly { step: string; ms: number }[] {
    return this.#steps;
  }
}
