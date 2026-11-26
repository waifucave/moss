// The memory mailbox over the relay plugin the person turned on (lane XC 5b, the TODO(B-M2) in links/node.ts): what a
// computer changed reaches one that is off when it is back, from the relay's mail, not only over a live link.
//
// * Late-bound: the links (and the memory sync with them) start before the plugin registry, and a relay plugin can be
//   turned on or off at any time, so each call looks again at which relays are on now.
// * Exactly one relay on: its `relays` entry's handler gets `putMail`, `takeMail` and `ackMail`, called as the core
//   (`caller: { kind: "core" }`), naming this device for a take or an ack, so the plugin reads and deletes only this
//   device's mailbox (relay-cloudflare's `mailboxOf`).
// * No relay on (the default: each person deploys their own): nothing is kept and nothing fails. A put does nothing
//   (said once in the log), a take finds nothing; memory reaches a computer that was off over its link once it is back,
//   as before.
// * Two or more on: none is used (MOSS never picks between the person's relays), and the person is told once, plainly
//   (`onMany`), until it is back to one or none.
//
// What the relay holds is only ever sealed (memory.ts): each piece to its one recipient's box key, signed with this
// computer's link key, checked by the recipient against its own registry.
import type { SyncMailbox } from "./mailbox";

/** The person's words when two relays are on. */
export const TWO_RELAYS_NOTICE = "Two relays are on, so MOSS keeps no mail for your computers that are off. Turn one off.";

/** One relay that is on: the plugin and its `relays` entry's handler. */
export interface RelayOn { pluginId: string; handler: string }

export interface RelayMailSource {
  /** The `relays` entries that are on now. */
  relays(): readonly RelayOn[];
  /** Calls the relay's handler as the core. */
  invoke(relay: RelayOn, method: "putMail" | "takeMail" | "ackMail", args: Record<string, unknown>): Promise<unknown>;
}

export interface PluginRelayMailboxOptions {
  /** The plugin host's side, once it is up; undefined before (and after it closes). */
  source(): RelayMailSource | undefined;
  /** This device's id, the mailbox a take and an ack read. */
  self(): string | undefined;
  log?(line: string): void;
  /** Two or more relays are on: tell the person once (`TWO_RELAYS_NOTICE`). */
  onMany?(text: string): void;
}

export class PluginRelayMailbox implements SyncMailbox {
  readonly #o: PluginRelayMailboxOptions;
  #said: "none" | "many" | undefined;

  constructor(o: PluginRelayMailboxOptions) {
    this.#o = o;
  }

  /** The one relay to use now, or why there is none. */
  #pick(): { relay: RelayOn; source: RelayMailSource } | "none" | "many" {
    const source = this.#o.source();
    const on = source?.relays() ?? [];
    if (source === undefined || on.length === 0) return this.#say("none");
    if (on.length > 1) return this.#say("many");
    this.#said = undefined;
    return { relay: on[0]!, source };
  }

  #say(why: "none" | "many"): "none" | "many" {
    if (this.#said === why) return why;
    this.#said = why;
    if (why === "none") this.#o.log?.("[memory] no relay is on: memory changes reach a computer that was off over its link once it's back");
    else {
      this.#o.log?.("[memory] two or more relays are on: no memory mail is kept until one is turned off");
      try { this.#o.onMany?.(TWO_RELAYS_NOTICE); } catch { /* a notice never fails the sync */ }
    }
    return why;
  }

  async put(args: { to: string; id: string; sealed: Uint8Array; expiresAt: number }): Promise<void> {
    const p = this.#pick();
    if (typeof p === "string") return;
    await p.source.invoke(p.relay, "putMail", { to: args.to, id: args.id, sealed: args.sealed, expiresAt: args.expiresAt });
  }

  async take(args?: { max?: number }): Promise<{ id: string; sealed: Uint8Array }[]> {
    const p = this.#pick();
    const device = this.#o.self();
    if (typeof p === "string" || device === undefined) return [];
    const r = (await p.source.invoke(p.relay, "takeMail", { device, ...(args?.max === undefined ? {} : { max: args.max }) })) as { mail?: unknown } | undefined;
    const mail = Array.isArray(r?.mail) ? r.mail : [];
    // Only well-formed pieces; the memory sync bounds and checks each before it opens one.
    return mail.filter((m): m is { id: string; sealed: Uint8Array } =>
      m !== null && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" && (m as { sealed?: unknown }).sealed instanceof Uint8Array);
  }

  async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const p = this.#pick();
    const device = this.#o.self();
    if (typeof p === "string" || device === undefined) return;
    await p.source.invoke(p.relay, "ackMail", { device, ids });
  }
}
