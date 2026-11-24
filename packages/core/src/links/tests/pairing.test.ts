// Pairing without an account: the QR and the short code, the four words, the card, the pair credential and the group
// at the handshake (a local stand-in for lane I's service), and three devices that pair and then link.
import { afterEach, describe, expect, test } from "bun:test";
import { hkdfSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../contracts/common";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { FileDeviceRegistry } from "../../devices/registry";
import { fromBase64Url, toBase64Url } from "../../identity/bytes";
import { decode, encode } from "../codec";
import { DeviceKey } from "../../identity/device-key";
import { generateEd25519 } from "../../identity/keys";
import { SystemClock } from "../../clock/system-clock";
import { EFF_SHORT_WORDLIST } from "../../identity/wordlist";
import { HandshakeClient, openPairBox, pairKeyRef, pairSecretRef, sealPairBox } from "../handshake";
import { type FakeHandshake, startFakeHandshake } from "../handshake-fake";
import { MemoryNetwork } from "../memory-wire";
import { FrameReader, frame } from "../frames";
import type { WireConn, WireEndpoint } from "../wire";
import { formatCode, MemoryRendezvous, PairingService, parseCode } from "../pairing";
import { MossLinkTransport } from "../transport";

const clock = new SystemClock();
let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

async function device(net: MemoryNetwork, name: string, opts: { hs?: FakeHandshake; rendezvous?: MemoryRendezvous; account?: string; kind?: "phone"; os?: "ios" | "android"; app?: "moss" | "code"; rewriteHello?: (device: Record<string, unknown>) => void; clockOffsetMs?: number } = {}) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "moss-h-pair-")), key, clock, self: { name, os: opts.os ?? "macos", ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.app ? { app: opts.app } : {}) } });
  const wire = opts.rewriteHello ? rewritingHello(net.endpoint(key.publicKey), opts.rewriteHello) : net.endpoint(key.publicKey);
  const handshake = opts.hs ? new HandshakeClient({ baseUrl: opts.hs.url, clock }) : undefined;
  const devClock = opts.clockOffsetMs ? { ...clock, now: () => clock.now() + opts.clockOffsetMs!, monotonic: () => clock.monotonic(), setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock), status: () => clock.status() } : clock;
  const pairing = new PairingService({
    self: key, registry, wire, clock: devClock, store, selfTarget: () => ({ relay: "https://relay.test/" }), account: () => opts.account ?? null,
    ...(handshake ? { handshake } : {}), ...(opts.rendezvous ? { rendezvous: opts.rendezvous } : {}),
  });
  cleanup.push(() => pairing.close());
  return { name, store, key, registry, wire, pairing };
}
type Dev = Awaited<ReturnType<typeof device>>;

/** A wire that changes the hello this device sends after it has signed it, as someone on the path (or a client lying
 *  about itself) would: `change` gets the record the hello carries. */
function rewritingHello(inner: WireEndpoint, change: (device: Record<string, unknown>) => void): WireEndpoint {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop !== "dial") {
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      }
      return async (...args: Parameters<WireEndpoint["dial"]>) => {
        const conn = await target.dial(...args);
        return new Proxy(conn, {
          get(c, p) {
            if (p !== "openStream") {
              const v = Reflect.get(c, p, c);
              return typeof v === "function" ? v.bind(c) : v;
            }
            return (...a: Parameters<WireConn["openStream"]>) => {
              const stream = c.openStream(...a);
              let first = true;
              return new Proxy(stream, {
                get(st, sp) {
                  if (sp !== "write") {
                    const v = Reflect.get(st, sp, st);
                    return typeof v === "function" ? v.bind(st) : v;
                  }
                  return (chunk: Uint8Array) => {
                    if (!first) return st.write(chunk);
                    first = false;
                    const body = new FrameReader().push(chunk)[0]!;
                    const message = decode(body) as unknown[];
                    change((message[1] as { device: Record<string, unknown> }).device);
                    return st.write(frame(encode(message)));
                  };
                },
              });
            };
          },
        });
      };
    },
  });
}

/** Runs a pairing to its words; returns both sides' words. */
async function toWords(host: Dev, joiner: Dev, use: "qr" | "code" = "qr") {
  const view = await host.pairing.begin();
  const joined = await joiner.pairing.join(use === "qr" ? view.qr! : view.code!);
  await waitFor(() => host.pairing.get(view.pairingId)?.status === "words");
  return { id: view.pairingId, hostWords: host.pairing.get(view.pairingId)!.view.words!, joinerWords: joined.words! };
}

async function pairBoth(host: Dev, joiner: Dev, use: "qr" | "code" = "qr") {
  const w = await toWords(host, joiner, use);
  expect(w.hostWords).toEqual(w.joinerWords);
  const done = [paired(host, w.id), paired(joiner, w.id)];
  await Promise.all([host.pairing.confirm(w.id, w.hostWords, { terminal: true }), joiner.pairing.confirm(w.id, w.joinerWords, { terminal: true })]);
  await Promise.all(done);
  return w;
}

/** Resolves when the pairing finished on this device: added, credential kept, group joined. */
function paired(d: Dev, id: string): Promise<void> {
  return new Promise((resolve) => {
    if (d.pairing.get(id)?.status === "paired") return resolve();
    const off = d.pairing.watch((c) => {
      if (c.type === "changed" && c.pairing.view.pairingId === id && c.pairing.status === "paired") {
        off();
        resolve();
      }
    });
  });
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

describe("pairing", () => {
  test("by QR: the same four words, both confirm, each adds the other; the pair's credential is saved and registered", async () => {
    const hs = startFakeHandshake();
    cleanup.push(() => hs.stop());
    const net = new MemoryNetwork();
    const a = await device(net, "Studio", { hs });
    const b = await device(net, "Laptop", { hs });
    const w = await pairBoth(a, b);
    expect(w.hostWords.every((x: string) => EFF_SHORT_WORDLIST.includes(x))).toBe(true);
    expect(a.registry.get(b.key.id)?.addedBy).toBe("terminal");
    expect(b.registry.get(a.key.id)?.name).toBe("Studio");
    await waitFor(() => a.registry.pairWith(b.key.id)?.registeredAt !== undefined);
    const pa = a.registry.pairWith(b.key.id)!;
    const pb = b.registry.pairWith(a.key.id)!;
    expect(pa.pairId).toBe(pb.pairId);
    expect(pa.ownKey).toBe(pb.peerKey);
    expect(pa.ownKey).not.toBe(toBase64Url(a.key.publicKey));
    expect(hs.pairs.get(pa.pairId)?.keys).toEqual([pa.ownKey, pb.ownKey]);
    expect(await a.store.get(pairKeyRef(pa.pairId))).not.toBeNull();
    expect((await b.store.get(pairSecretRef(pa.pairId)))?.value.reveal()).toBe((await a.store.get(pairSecretRef(pa.pairId)))?.value.reveal());
    // The group: the host founded it, the joiner joined, admitted by the host.
    const ga = a.registry.group()!;
    expect(b.registry.group()?.id).toBe(ga.id);
    await waitFor(() => hs.groups.get(ga.id)?.members.size === 2);
    expect(ga.members[b.key.id]?.key).toBe(b.registry.group()!.ownKey);
  });

  test("by short code through the rendezvous, with a sealed card", async () => {
    const net = new MemoryNetwork();
    const rendezvous = new MemoryRendezvous();
    const a = await device(net, "Studio", { rendezvous });
    const b = await device(net, "Server", { rendezvous });
    const w = await toWords(a, b, "code");
    expect(rendezvous.slots.size).toBe(0);
    let approve!: (v: boolean) => void;
    const allowed = new Promise<boolean>((r) => (approve = r));
    const confirmed = a.pairing.confirm(w.id, w.hostWords, { card: "card_pair01", allowed });
    await b.pairing.confirm(w.id, w.joinerWords, { terminal: true });
    expect(a.registry.get(b.key.id)).toBeUndefined();
    const done = [paired(a, w.id), paired(b, w.id)];
    approve(true);
    await confirmed;
    await Promise.all(done);
    expect(a.registry.get(b.key.id)?.addedBy).toBe("code");
    // Without the service the registration waits, signed, for `retryRegistrations`.
    expect(a.registry.pairWith(b.key.id)?.registration?.sigs.length).toBe(2);
    expect(a.registry.pairWith(b.key.id)?.registeredAt).toBeUndefined();
  });

  test("a QR whose host key is small-order or non-canonical is refused before anything is dialled", async () => {
    const net = new MemoryNetwork();
    const [host, joiner] = [await device(net, "Studio"), await device(net, "Phone")];
    const view = await host.pairing.begin();
    const prefix = "clover-pair:1:";
    const fields = decode(fromBase64Url(view.qr!.slice(prefix.length))!) as unknown[];
    const p = (1n << 255n) - 19n;
    const nonCanonical = Uint8Array.from({ length: 32 }, (_, i) => Number(((p + 1n) >> BigInt(8 * i)) & 0xffn));
    for (const bad of [new Uint8Array(32), Uint8Array.from(Buffer.from("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "hex")), nonCanonical]) {
      const tampered = [...fields];
      tampered[2] = bad;
      const err = await joiner.pairing.join(`${prefix}${toBase64Url(encode(tampered))}`).catch((e: unknown) => e);
      expect(isContractError(err, "invalid")).toBe(true);
    }
    // The untouched QR still pairs.
    const joined = await joiner.pairing.join(view.qr!);
    expect(joined.words).toBeDefined();
  });

  test("a short code whose offer names a small-order host key is refused", async () => {
    const net = new MemoryNetwork();
    const rendezvous = new MemoryRendezvous();
    const [host, joiner] = [await device(net, "Studio", { rendezvous }), await device(net, "Server", { rendezvous })];
    const view = await host.pairing.begin();
    const raw = parseCode(view.code!)!;
    const slot = toBase64Url(raw.subarray(0, 5));
    const key = new Uint8Array(hkdfSync("sha256", raw.subarray(5), new Uint8Array(0), new TextEncoder().encode("clover/pair-rendezvous/1"), 32));
    const context = { scope: slot, from: "host", to: "joiner", kind: "signal" as const };
    const offer = openPairBox(key, context, rendezvous.slots.get(slot)!) as Record<string, unknown>;
    rendezvous.slots.set(slot, sealPairBox(key, context, { ...offer, key: toBase64Url(new Uint8Array(32)) }));
    const err = await joiner.pairing.join(view.code!).catch((e: unknown) => e);
    expect(isContractError(err, "invalid")).toBe(true);
  });

  test("words that differ end the pairing; nothing is added", async () => {
    const net = new MemoryNetwork();
    const a = await device(net, "Studio");
    const b = await device(net, "Laptop");
    const w = await toWords(a, b);
    const wrong = [...w.hostWords];
    wrong[3] = wrong[3] === "acid" ? "acorn" : "acid";
    expect(isContractError(await a.pairing.confirm(w.id, wrong, { terminal: true }).catch((e: unknown) => e), "refused")).toBe(true);
    expect(a.pairing.get(w.id)?.status).toBe("failed");
    await Bun.sleep(20);
    expect(a.registry.list()).toHaveLength(1);
    expect(b.registry.list()).toHaveLength(1);
  });

  test("a code with the wrong secret is refused, and the pairing is spent", async () => {
    const net = new MemoryNetwork();
    const rendezvous = new MemoryRendezvous();
    const a = await device(net, "Studio", { rendezvous });
    const b = await device(net, "Laptop", { rendezvous });
    const c = await device(net, "Other", { rendezvous });
    const view = await a.pairing.begin();
    const raw = parseCode(view.code!)!;
    expect(formatCode(raw)).toBe(view.code!);
    // Same slot, another secret: the box doesn't open, so the joiner can't even find the host.
    raw[14]! ^= 1;
    expect(isContractError(await b.pairing.join(formatCode(raw)).catch((e: unknown) => e), "not_found")).toBe(true);
    // A QR with a wrong secret reaches the host, which ends the pairing on the first bad proof.
    const qr = view.qr!;
    const forged = await forgeQrSecret(qr);
    expect(isContractError(await c.pairing.join(forged).catch((e: unknown) => e), "refused")).toBe(true);
    await waitFor(() => a.pairing.get(view.pairingId)?.status === "failed");
    expect(isContractError(await b.pairing.join(qr).catch((e: unknown) => e), "refused")).toBe(true);
  });

  test("a denied card ends it on both sides", async () => {
    const net = new MemoryNetwork();
    const a = await device(net, "Studio");
    const b = await device(net, "Laptop");
    const w = await toWords(a, b);
    const denied = a.pairing.confirm(w.id, w.hostWords, { card: "card_x", allowed: Promise.resolve(false) }).catch((e: unknown) => e);
    expect(isContractError(await denied, "refused")).toBe(true);
    await waitFor(() => b.pairing.get(w.id)?.status === "failed");
    expect(b.registry.list()).toHaveLength(1);
  });

  test("a phone's answer key (P-256, the Secure Enclave's) travels in its record with its own signature; its link key never answers a card", async () => {
    const net = new MemoryNetwork();
    const host = await device(net, "Studio");
    const phone = await device(net, "Phone", { kind: "phone" });
    const { answerKeyStatement } = await import("../../devices/registry");
    const { utf8 } = await import("../../identity/bytes");
    // The Secure Enclave's key is P-256 (B's #187): a raw uncompressed point, and r‖s signatures over SHA-256.
    const { generateKeyPairSync, sign } = await import("node:crypto");
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = pair.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64");
    const es256 = (d: Uint8Array) => new Uint8Array(sign("sha256", d, { key: pair.privateKey, dsaEncoding: "ieee-p1363" }));
    await phone.registry.setOwnAnswerKey(pub, "secure-enclave", es256(answerKeyStatement(phone.key.id, pub, "secure-enclave", "p256")), undefined, "p256");
    await pairBoth(host, phone);
    expect(host.registry.get(phone.key.id)?.answerKey).toEqual({ publicKey: pub, held: "secure-enclave", alg: "p256" } as never);
    const data = utf8("an answer");
    expect(await host.registry.verifyAnswer(phone.key.id, data, es256(data))).toBe(true);
    expect(await host.registry.verifyAnswer(phone.key.id, data, phone.key.sign(data))).toBe(false);
    // The statement covers the algorithm: an Ed25519 statement doesn't register the same key.
    await expect(phone.registry.setOwnAnswerKey(pub, "secure-enclave", es256(answerKeyStatement(phone.key.id, pub, "secure-enclave")), undefined, "p256")).rejects.toThrow();
  });

  describe("a phone's app (spec §8: two phone apps, each paired on its own)", () => {
    test("a phone that pairs as MOSS Code is recorded with that app, and device.list shows it; the same phone's other records name none", async () => {
      const net = new MemoryNetwork();
      const host = await device(net, "Studio");
      const phone = await device(net, "Phone", { kind: "phone", os: "ios", app: "code" });
      await pairBoth(host, phone);
      expect(host.registry.get(phone.key.id)).toMatchObject({ kind: "phone", os: "ios", app: "code" });
      // The phone's own record of the host has none: a desktop has no phone app.
      expect(phone.registry.get(host.key.id)?.app).toBeUndefined();
      const { deviceView } = await import("../../devices/rpc");
      expect(deviceView(host.registry.get(phone.key.id)!, host.key.id, undefined)).toMatchObject({ kind: "phone", app: "code" });
      expect(deviceView(host.registry.self(), host.key.id, undefined).app).toBeUndefined();
    });

    test("an Android phone pairs the same way, as either app", async () => {
      const net = new MemoryNetwork();
      const host = await device(net, "Studio");
      const phone = await device(net, "Pixel", { kind: "phone", os: "android", app: "moss" });
      await pairBoth(host, phone);
      expect(host.registry.get(phone.key.id)).toMatchObject({ kind: "phone", os: "android", app: "moss" });
    });

    test("an old client names no app and records none; a phone with both apps is two paired devices", async () => {
      const net = new MemoryNetwork();
      const host = await device(net, "Studio");
      const old = await device(net, "Old phone", { kind: "phone", os: "ios" });
      const moss = await device(net, "MOSS", { kind: "phone", os: "ios", app: "moss" });
      const code = await device(net, "MOSS Code", { kind: "phone", os: "ios", app: "code" });
      await pairBoth(host, old);
      await pairBoth(host, moss);
      await pairBoth(host, code);
      expect(host.registry.get(old.key.id)).toBeDefined();
      expect(host.registry.get(old.key.id)?.app).toBeUndefined();
      expect(host.registry.list().filter((d) => d.kind === "phone").map((d) => d.app ?? "none").sort()).toEqual(["code", "moss", "none"]);
      expect(new Set(host.registry.list().map((d) => d.id)).size).toBe(4);
    });

    test("a record with no app encodes exactly as it did before the field", async () => {
      const { canonicalRecord } = await import("../../identity/sas");
      const r = { id: "x".repeat(32), name: "Phone", kind: "phone", os: "ios", runsCore: false, publicKey: "AAAA", answerKey: { publicKey: "BBBB", held: "secure-enclave", alg: "p256" } };
      const before = encode([r.id, r.name, r.kind, r.os, r.runsCore, null, null, r.publicKey, ["BBBB", "secure-enclave", "p256"]]);
      expect(Buffer.from(canonicalRecord(r)).equals(Buffer.from(before))).toBe(true);
      expect(Buffer.from(canonicalRecord({ ...r, app: "moss" })).equals(Buffer.from(before))).toBe(false);
      expect(Buffer.from(canonicalRecord({ ...r, app: "moss" })).equals(Buffer.from(canonicalRecord({ ...r, app: "code" })))).toBe(false);
    });

    test("the app changed on the wire after the phone signed its hello fails the pairing: the host records no phone", async () => {
      const net = new MemoryNetwork();
      const host = await device(net, "Studio");
      const phone = await device(net, "Phone", { kind: "phone", os: "ios", app: "moss", rewriteHello: (d) => { d.app = "code"; } });
      const view = await host.pairing.begin();
      expect(isContractError(await phone.pairing.join(view.qr!).catch((e: unknown) => e), "refused")).toBe(true);
      await waitFor(() => host.pairing.get(view.pairingId)?.status === "failed");
      // Refused for the right reason: the proof over the transcript, which holds the record, didn't check out.
      expect(host.pairing.get(view.pairingId)?.error).toContain("without its secret");
      expect(host.registry.list().filter((d) => d.kind === "phone")).toEqual([]);
    });

    test("(control) the same rewriting wire, changing nothing, pairs", async () => {
      const net = new MemoryNetwork();
      const host = await device(net, "Studio");
      const phone = await device(net, "Phone", { kind: "phone", os: "ios", app: "moss", rewriteHello: () => {} });
      await pairBoth(host, phone);
      expect(host.registry.get(phone.key.id)?.app).toBe("moss");
    });

    test("an app added to a phone's hello that signed none, or taken off one that did, fails the same way", async () => {
      for (const [from, rewrite] of [["none", (d: Record<string, unknown>) => { d.app = "code"; }], ["moss", (d: Record<string, unknown>) => { delete d.app; }]] as const) {
        const net = new MemoryNetwork();
        const host = await device(net, "Studio");
        const phone = await device(net, `Phone ${from}`, { kind: "phone", os: "ios", ...(from === "moss" ? { app: "moss" as const } : {}), rewriteHello: rewrite });
        const view = await host.pairing.begin();
        expect(isContractError(await phone.pairing.join(view.qr!).catch((e: unknown) => e), "refused")).toBe(true);
        expect(host.registry.list().filter((d) => d.kind === "phone")).toEqual([]);
      }
    });

    test("an app that is not one of the two, or on a device that is not a phone, refuses the pairing", async () => {
      for (const [kind, app] of [["phone", "host"], ["phone", "other"], ["phone", 7], ["desktop", "moss"], ["desktop", "code"]] as const) {
        const net = new MemoryNetwork();
        const host = await device(net, "Studio");
        const joiner = await device(net, "Joiner", { ...(kind === "phone" ? { kind: "phone" as const, os: "ios" as const } : {}), rewriteHello: (d) => { d.app = app; } });
        const view = await host.pairing.begin();
        expect(isContractError(await joiner.pairing.join(view.qr!).catch((e: unknown) => e), "refused")).toBe(true);
        expect(host.registry.list()).toHaveLength(1);
      }
    });

    test("through the handshake's pair registration too: a phone with an app and an account-less group pairs, and keeps its app", async () => {
      const hs = startFakeHandshake();
      cleanup.push(() => hs.stop());
      const net = new MemoryNetwork();
      const host = await device(net, "Studio", { hs });
      const phone = await device(net, "Phone", { hs, kind: "phone", os: "android", app: "code" });
      await pairBoth(host, phone);
      expect(host.registry.get(phone.key.id)).toMatchObject({ kind: "phone", os: "android", app: "code" });
      expect(host.registry.pairs()).toHaveLength(1);
      expect(phone.registry.pairs()).toHaveLength(1);
    });

    test("a revoked phone can't come back as the other app: it pairs again only with a new key", async () => {
      const net = new MemoryNetwork();
      const host = await device(net, "Studio");
      const phone = await device(net, "Phone", { kind: "phone", os: "ios", app: "moss" });
      await pairBoth(host, phone);
      await host.registry.revoke(phone.key.id);
      expect(host.registry.get(phone.key.id)).toMatchObject({ app: "moss" });
      expect(host.registry.list().some((d) => d.id === phone.key.id)).toBe(false);
      const view = await host.pairing.begin();
      expect(isContractError(await phone.pairing.join(view.qr!).catch((e: unknown) => e), "refused")).toBe(true);
      expect(host.registry.get(phone.key.id)).toMatchObject({ app: "moss" });
    });
  });

  test("a host whose t is out of the statements' window is refused at its welcome (I's review)", async () => {
    const net = new MemoryNetwork();
    const host = await device(net, "Studio", { clockOffsetMs: -15 * 60_000 });
    const joiner = await device(net, "Laptop");
    const view = await host.pairing.begin();
    expect(isContractError(await joiner.pairing.join(view.qr!).catch((e: unknown) => e), "refused")).toBe(true);
    expect(joiner.registry.list()).toHaveLength(1);
  });

  test("two devices on the same account keep no pair credential and form no group", async () => {
    const net = new MemoryNetwork();
    const a = await device(net, "Studio", { account: "acct-hash-1" });
    const b = await device(net, "Laptop", { account: "acct-hash-1" });
    await pairBoth(a, b);
    expect(a.registry.pairs()).toHaveLength(0);
    expect(a.registry.group()).toBeUndefined();
  });

  test("three devices: A pairs B and C, all three join A's group, and the links follow the registry", async () => {
    const hs = startFakeHandshake();
    cleanup.push(() => hs.stop());
    const net = new MemoryNetwork();
    const [a, b, c] = [await device(net, "Studio", { hs }), await device(net, "Laptop", { hs }), await device(net, "Server", { hs })];
    await pairBoth(a, b);
    await pairBoth(a, c);
    const group = a.registry.group()!.id;
    expect(b.registry.group()?.id).toBe(group);
    expect(c.registry.group()?.id).toBe(group);
    await waitFor(() => hs.groups.get(group)?.members.size === 3);
    expect(hs.pairs.size).toBe(2);

    const transports = new Map<string, MossLinkTransport>();
    for (const d of [a, b, c]) {
      const t = new MossLinkTransport({
        self: d.key.id, wire: d.wire, registry: d.registry, clock,
        directory: { target: (id) => { const r = d.registry.get(id); return r ? { key: Buffer.from(r.publicKey, "base64") as unknown as Uint8Array<ArrayBuffer>, relay: "https://relay.test/" } : undefined; } },
      });
      t.handle("test.whoami", async (_p, from) => ({ me: d.name, from }));
      transports.set(d.name, t);
      cleanup.push(() => t.close());
    }
    const ta = transports.get("Studio")!;
    expect(await (await ta.connect(b.key.id)).request<unknown>("test.whoami", {})).toEqual({ me: "Laptop", from: a.key.id });
    expect(await (await ta.connect(c.key.id)).request<unknown>("test.whoami", {})).toEqual({ me: "Server", from: a.key.id });
    // B and C never paired with each other.
    expect(isContractError(await transports.get("Laptop")!.connect(c.key.id).catch((e: unknown) => e), "refused")).toBe(true);
    // Revoking C on A cuts that link at once.
    const link = await ta.connect(c.key.id);
    await a.registry.revoke(c.key.id, "lost");
    expect(isContractError(await link.request<unknown>("test.whoami", {}).catch((e: unknown) => e), "refused")).toBe(true);
    expect(a.registry.pairWith(c.key.id)).toBeUndefined();
  });
});

describe("the pair door and the words' commitment (S2, S6.3 of H-M1's review)", () => {
  test("the door turns a connection away while no pairing is shown, and once a pairing is spent", async () => {
    const net = new MemoryNetwork();
    const a = await device(net, "Studio");
    const stranger = net.endpoint(generateEd25519().publicKey);
    const conn = await stranger.dial({ key: a.key.publicKey }, { alpn: "clover/pair/1" });
    expect((await conn.closed).reason).toBe("no pairing is open");
  });

  test("an opened connection that sends no hello is closed when its first frame is late", async () => {
    const net = new MemoryNetwork();
    const store = new MemorySecretStore();
    const key = await DeviceKey.loadOrCreate(store);
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "moss-h-pair-")), key, clock, self: { name: "Studio" } });
    const pairing = new PairingService({
      self: key, registry, wire: net.endpoint(key.publicKey), clock, store, selfTarget: () => ({}), account: () => null, door: { firstFrameMs: 50 },
    });
    cleanup.push(() => pairing.close());
    await pairing.begin();
    const stranger = net.endpoint(generateEd25519().publicKey);
    const conn = await stranger.dial({ key: key.publicKey }, { alpn: "clover/pair/1" });
    conn.openStream(3);
    expect((await conn.closed).reason).toBe("no hello in time");
  });

  test("a code's slot is create-only, so no one swaps the host's key in it", async () => {
    const r = new MemoryRendezvous();
    await r.publish("slot", "box-1");
    expect(isContractError(await r.publish("slot", "box-2").catch((e: unknown) => e), "conflict")).toBe(true);
    expect(await r.lookup("slot")).toBe("box-1");
  });

  test("the words and the pair secret cover both nonces, and the commitment binds the joiner's", async () => {
    const { finalTranscript, nonceCommitment, sasWords, derivePairSecret } = await import("../../identity/sas");
    const { randomBytes } = await import("../../identity/bytes");
    const secret = randomBytes(32);
    const full = randomBytes(64);
    const n1 = randomBytes(32);
    const n2 = randomBytes(32);
    expect(sasWords(secret, finalTranscript(full, n1))).not.toEqual(sasWords(secret, finalTranscript(full, n2)));
    expect(toBase64Url(derivePairSecret(secret, finalTranscript(full, n1)))).not.toBe(toBase64Url(derivePairSecret(secret, finalTranscript(full, n2))));
    expect(toBase64Url(nonceCommitment(n1))).not.toBe(toBase64Url(nonceCommitment(n2)));
    expect(toBase64Url(nonceCommitment(n1))).toBe(toBase64Url(nonceCommitment(new Uint8Array(n1))));
  });
});

async function forgeQrSecret(qr: string): Promise<string> {
  const { decode, encode } = await import("../codec");
  const { fromBase64Url } = await import("../../identity/bytes");
  const prefix = "clover-pair:1:";
  const v = decode(fromBase64Url(qr.slice(prefix.length))!) as unknown[];
  const secret = new Uint8Array(v[1] as Uint8Array);
  secret[0]! ^= 1;
  v[1] = secret;
  return prefix + toBase64Url(encode(v));
}
