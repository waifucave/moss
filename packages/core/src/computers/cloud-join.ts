// How a cloud computer joins the person's devices (spec §9.2: the provider "creates the VM, installs the image and pairs
// it in one step"; plan §4 J, M3). It is the ordinary pairing (`links/pairing.ts`, the QR's secret and key), driven by
// the two ends with nobody at either screen, because the person's OK already happened:
//
// * THE MAIN, which made the VM (`CloudPairer`): after the person approved the create card it begins one pairing for
//   that VM and puts the pairing's QR text into the VM's cloud-init as the join ticket. Only a device holding the QR's
//   secret can say hello to that pairing (`links/pairing.ts` checks the proof), so the ticket is the single-use token:
//   one pairing, one device, then it is gone (a used or expired pairing answers no hello). The main confirms the
//   words by itself ONLY for a pairing it began for a VM it made from MOSS's OWN image (a folder naming any other image
//   gets no ticket at all: the person pairs it themselves, `CUSTOM_IMAGE_USER_DATA`), and only when the device that said
//   hello is a cloud computer that runs the core, holds no answer key (so it can never answer the person's cards as a
//   phone would) and names that same computer; any other pairing is the person's, with the words and the card.
//   One pending pairing per VM: a new ticket replaces the old, and a create that fails, a revoked token or a lost lease
//   cancels it (`drop`, `cancelAll`).
// * THE VM (`joinCloudComputer`): its daemon reads the ticket from `/etc/moss/join`, joins, confirms its own end as
//   its own terminal's (the cloud-init is the person's own act on that VM), and then deletes the ticket and the token
//   from its disk (`removeCloudJoinFiles`).
//
// What the main does when the VM has paired is the cloud's own door (`CloudComputers.door`): the spent token, the
// provider told to clear what it handed the VM, and the person asked whether to make it the main computer.
import type { Unsubscribe } from "../contracts/common";
import type { PairingChange, PairingService, PairingState } from "../links/pairing";
import type { CloudPairingDoor } from "./cloud";
import { removeCloudJoinFiles } from "./image";

/** How long a VM's pairing waits: as long as its token (an hour), since the VM must boot and download first. */
export const CLOUD_PAIRING_TTL_MS = 60 * 60_000;

type MainPairing = Pick<PairingService, "begin" | "watch" | "confirm" | "cancel">;

export interface CloudPairerOptions {
  pairing: MainPairing;
  /** The cloud's pairing door (`CloudComputers.door`); none while this computer is not the main. */
  door: () => CloudPairingDoor | undefined;
  log?: (line: string) => void;
}

/** The main's side: one pairing per VM it makes. */
export class CloudPairer {
  readonly #o: CloudPairerOptions;
  /** Pairings begun for a VM, by pairing id. Only these are ever confirmed without the person. */
  readonly #pending = new Map<string, { name: string; token: string; confirming: boolean }>();

  constructor(o: CloudPairerOptions) {
    this.#o = o;
  }

  /** Starts watching the pairing service; returns the stop. */
  start(): Unsubscribe {
    return this.#o.pairing.watch((c) => void this.#on(c));
  }

  /** The join ticket for a VM named `name` that carries `token`: a pairing begun now, as its QR's text. */
  async offer(name: string, token: string): Promise<string> {
    // A retry replaces: never two pending pairings for one VM.
    this.drop(name);
    const view = await this.#o.pairing.begin({ ttlMs: CLOUD_PAIRING_TTL_MS, qrOnly: true });
    if (view.qr === undefined) {
      void this.#cancel(view.pairingId);
      throw new Error("the pairing gave no QR text");
    }
    this.#pending.set(view.pairingId, { name, token, confirming: false });
    return view.qr;
  }

  /** Cancels this VM's pending pairing, if any (the VM it was for will not exist, or its token was taken back). */
  drop(name: string): void {
    for (const [id, p] of [...this.#pending]) {
      if (p.name !== name) continue;
      this.#pending.delete(id);
      void this.#cancel(id);
    }
  }

  /** Cancels every pending VM pairing (this computer no longer holds the lease: the one that does decides). */
  cancelAll(): void {
    for (const id of [...this.#pending.keys()]) {
      this.#pending.delete(id);
      void this.#cancel(id);
    }
  }

  #cancel(id: string): Promise<void> {
    return this.#o.pairing.cancel(id).catch(() => undefined);
  }

  /** How many VM pairings wait. */
  get waiting(): number {
    return this.#pending.size;
  }

  async #on(c: PairingChange): Promise<void> {
    if (c.type === "removed") {
      this.#pending.delete(c.pairingId);
      return;
    }
    const s: PairingState = c.pairing;
    const mine = this.#pending.get(s.view.pairingId);
    if (mine === undefined || s.role !== "host") return;
    try {
      if (s.status === "words" && !mine.confirming) {
        mine.confirming = true;
        // Only the VM this pairing was made for, and only what such a VM is: a cloud computer that runs the core and holds
        // no answer key. The ticket opens the pairing, so whoever holds it says hello; it must never become a phone that
        // answers the person's cards, or a device under another name.
        const p = s.peer;
        const isVm = p !== undefined && p.computer === mine.name && p.kind === "cloud" && p.runsCore === true
          && p.answerKey === undefined && (p.answerKeys === undefined || Object.keys(p.answerKeys).length === 0);
        if (!isVm || s.view.words === undefined) {
          this.#o.log?.(`cloud computer ${mine.name}: a device that isn't it used its pairing; refused`);
          await this.#o.pairing.cancel(s.view.pairingId);
          return;
        }
        // The person's OK was the create card; the device record says it was a cloud join (`via: "cloud"`), not a card
        // answered or four words compared.
        await this.#o.pairing.confirm(s.view.pairingId, s.view.words, { cloud: mine.name });
      } else if (s.status === "paired" && s.peer !== undefined) {
        this.#pending.delete(s.view.pairingId);
        await this.#o.door()?.consume(mine.token, s.peer.id);
      } else if (s.status === "failed" || s.status === "cancelled") {
        this.#pending.delete(s.view.pairingId);
      }
    } catch (e) {
      this.#o.log?.(`cloud computer ${mine.name}: its pairing didn't finish (${(e as Error).message})`);
    }
  }
}

type VmPairing = Pick<PairingService, "join" | "watch" | "confirm" | "get">;

/** `joinCloudComputer`, again and again until it pairs or the ticket's hour is over: a main that is asleep, offline or
 *  restarting when the VM finishes booting is the usual case, not an edge, and a VM left unpaired is deleted and made
 *  again (billed again) by the main's pair-again card. Backs off from 5 seconds to 5 minutes; stops on a pairing that
 *  has expired or was refused for good. `sleep` and `now` are test seams. */
export async function joinCloudComputerUntilPaired(o: {
  pairing: VmPairing; ticket: string; dir?: string; log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>; now?: () => number; firstWaitMs?: number; maxWaitMs?: number; giveUpAfterMs?: number;
}): Promise<void> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const until = now() + (o.giveUpAfterMs ?? CLOUD_PAIRING_TTL_MS);
  let wait = o.firstWaitMs ?? 5_000;
  for (;;) {
    try {
      await joinCloudComputer(o);
      return;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (now() + wait >= until || /expired/.test(why)) throw e;
      o.log?.(`not paired yet (${why}); trying again in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      wait = Math.min(wait * 2, o.maxWaitMs ?? 5 * 60_000);
    }
  }
}

/** The VM's side: joins with the ticket and confirms, with nobody at its screen. Resolves when it is paired, rejects
 *  when the pairing failed or ended. The ticket and the token are deleted from the disk once it is paired. */
export async function joinCloudComputer(o: { pairing: VmPairing; ticket: string; dir?: string; log?: (line: string) => void }): Promise<void> {
  const view = await o.pairing.join(o.ticket);
  await new Promise<void>((resolve, reject) => {
    let confirming = false;
    let off: Unsubscribe = () => {};
    // The pairing is often at its words already when `join` returns, so its state is read now as well as watched.
    const step = (s: PairingState) => {
      if (s.view.pairingId !== view.pairingId) return;
      if (s.status === "words" && !confirming && s.view.words !== undefined) {
        confirming = true;
        // The VM's end: the cloud-init that holds this ticket is the person's own act on this machine, as a terminal's.
        o.pairing.confirm(view.pairingId, s.view.words, { terminal: true }).catch((e: Error) => { off(); reject(e); });
      } else if (s.status === "paired") {
        off();
        resolve();
      } else if (s.status === "failed" || s.status === "cancelled") {
        off();
        reject(new Error(s.error ?? "the pairing ended"));
      }
    };
    off = o.pairing.watch((c) => { if (c.type === "changed") step(c.pairing); });
    const now = o.pairing.get(view.pairingId);
    if (now) step(now);
  });
  removeCloudJoinFiles(o.dir);
  o.log?.("cloud computer: paired; the join ticket and the pairing token are deleted from this disk");
}
