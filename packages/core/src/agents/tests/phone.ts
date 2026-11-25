// A paired phone for the agent tests: a device registry (the real contract's fake) holding one phone with its own answer key,
// the broker's verifier over it (`deviceProofVerifier`, the one the engine's broker uses), the caller its connection would be, and
// its signed answer to a card. A phone answers only with its answer key, over `cardAnswerSigningInput`.
import { cardAnswerSigningInput, type Caller } from "@waifucave/moss-protocol";
import { deviceProofVerifier } from "../../contracts/approval-broker";
import { mayStartSessions } from "../../contracts/device-registry";
import { cardMethods } from "../../approvals/card-methods";
import type { MossConn } from "../../ipc/moss";
import { FakeDeviceRegistry, makeFakePhone, type FakePhone } from "../../contracts/fakes/device-registry";
import type { Clock } from "../../contracts/clock";
import type { Card } from "@waifucave/moss-protocol";
import type { World } from "./world";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

export interface TestPhone {
  readonly phone: FakePhone;
  readonly registry: FakeDeviceRegistry;
  /** The broker's verifier over the registry. */
  readonly verify: ReturnType<typeof deviceProofVerifier>;
  /** What the daemon's `phoneMayStart` is: the registry's record now. */
  readonly mayStart: (device: string) => boolean;
  /** The caller a connection of this phone is (`ios`, or `android` for an Android phone). */
  caller(client?: "ios" | "android"): Caller;
  /** The phone's signed answer to a card, sent as the phone sends it: `card.answer` on its `remote` connection, through the
   *  engine's own handler (`cardMethods`), which takes a device link's signed proof and applies no window's press gate. */
  answer(w: World, card: Card, kind: "approve" | "deny", signer?: FakePhone, proof?: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }>;
  /** `card.list` as the phone's screen asks it. */
  cards(w: World): Promise<{ cards: Card[] }>;
  revoke(): Promise<void>;
}

export async function pairedPhone(clock: Pick<Clock, "now">, o: { answerKey?: boolean; os?: "ios" | "android" } = {}): Promise<TestPhone> {
  const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio", kind: "desktop" });
  const phone = await makeFakePhone();
  await registry.add({
    id: phone.id, name: "Phone", kind: "phone", runsCore: false, os: o.os ?? "ios", publicKey: phone.publicKey, app: "code",
    ...(o.answerKey === false ? {} : { answerKey: phone.answerKey }),
  }, { via: "terminal" });
  const conn = (): MossConn => ({ connId: 9, role: "remote", caller: { kind: "user", client: o.os ?? "ios", device: phone.id } }) as unknown as MossConn;
  return {
    phone, registry,
    verify: deviceProofVerifier(registry),
    mayStart: (device) => mayStartSessions(registry.get(device)),
    caller: (client = "ios") => ({ kind: "user", client, device: phone.id }) as Caller,
    async answer(w, card, kind, signer = phone, proof) {
      const option = card.options.find((x) => x.kind === kind)!;
      const at = w.clock.now();
      const signature = b64(await signer.sign(enc(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: option.id, at, children: [] }))));
      const methods = cardMethods(() => w.approvals);
      return methods["card.answer"]!(conn(), { id: card.id, hash: card.hash, option: option.id, proof: proof ?? { via: "device", device: phone.id, at, signature } }) as Promise<{ accepted: boolean; reason?: string }>;
    },
    cards: (w) => cardMethods(() => w.approvals)["card.list"]!(conn(), {}) as Promise<{ cards: Card[] }>,
    revoke: () => registry.revoke(phone.id, "test"),
  };
}
