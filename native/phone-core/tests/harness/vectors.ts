// The engine's own functions over fixed inputs, printed as one JSON object: tests/vectors.rs recomputes each with the
// phone core and requires the same bytes. Inputs are fixed and public (no real key or secret).
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const core = join(repo, "packages/core/src");
const { encode } = await import(join(core, "links/codec"));
const sas = await import(join(core, "identity/sas"));
const { ed25519FromSeed } = await import(join(core, "identity/keys"));
const { isStrictEd25519Point } = await import(join(core, "identity/ed25519-strict"));
const { deviceIdFor } = await import(join(core, "contracts/device-registry"));
const { pairStatement, admitStatement } = await import(join(core, "links/handshake"));
const { answerKeyStatement } = await import(join(core, "devices/registry"));
const { canonicalJson, cardHashInput, cardAnswerSigningInput, userMessageHashInput, userMessageSigningInput } = await import(Bun.resolveSync("@waifucave/moss-protocol", core));
const { createHash } = await import("node:crypto");
const { nameProblem, safeDeviceName } = await import(join(core, "devices/names"));

// The device-name rule's edge cases (devices/names.ts): every class it refuses, the joiners' places, the lengths.
const NAMES = [
  "Studio", "Kim's phone", "a", "x".repeat(63), "x".repeat(64), "😀".repeat(31) + "x", "😀".repeat(32), "", " ", "   ",
  "a\u202Eb", "a\u200Bb", "\u00ADab", "a\u2028b", "a\u2029b", "a\u0007b", "\u2800", "\u3164", "a\uFFA0", "a\u115F", "\u17B4a",
  "\u0301a", "a\u0301", "a\u0301\u0301\u0301\u0301", "a\u0301\u0301\u0301\u0301\u0301", " \u0301", "a \u0301",
  "👩\u200D💻", "👩🏽\u200D💻", "🏳\uFE0F\u200D🌈", "می\u200Cخواهم", "\u200Da", "a\u200D", "a\u200D\u200Db", "a \u200Db", "a\u200D b",
  "🏴\uDB40\uDC67\uDB40\uDC62\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67\uDB40\uDC7F", "🇯🇵", "a\u00A0b", "\u00A0", "\u3000x",
  "Ⅻ", "ﬁ", "\uFFF9a", "a\u180Eb", "\uFEFFa", "\u061C", "e\u0308\u0332", "\u{1F600}\u{1F3FB}", "ab\u{E0001}",
];
const RAW_NAMES = ["  My\u0007  Phone  ", "\u202E", "", "x".repeat(70), "😀".repeat(40), "a\u0301\u0301\u0301\u0301\u0301\u0301b", " \u0301 Lab ", "iPhone\u2028(2)"];

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);
const seq = (n: number, start: number) => Uint8Array.from({ length: n }, (_, i) => (start + i * 7) & 0xff);

const seed = seq(32, 3);
const key = ed25519FromSeed(seed);
const host = ed25519FromSeed(seq(32, 101));
const msg = new TextEncoder().encode("clover/card-answer/2\ncard_x\nab\napprove\n1781270000000\n");

const recordPhone = { id: "phoneid", name: "Phone ü", kind: "phone", os: "ios", runsCore: false, publicKey: "cGhvbmU=", answerKey: { publicKey: "YWs=", held: "keychain" } };
const recordHost = { id: "hostid", name: "Studio", kind: "desktop", os: "macos", runsCore: true, computer: "Studio", hasDisplay: true, publicKey: "aG9zdA==", answerKey: { publicKey: "cDI1Ng==", held: "app-keychain", alg: "p256" } };
const recordBare = { id: "x", name: "y", kind: "phone", runsCore: false, publicKey: "eg==" };

const commit = sas.nonceCommitment(fill(32, 9));
const joinerSide = { key: key.publicKey, record: sas.canonicalRecord(recordPhone), pairKey: seq(32, 11), groupKey: seq(32, 13), group: null };
const hostSide = { key: host.publicKey, record: sas.canonicalRecord(recordHost), pairKey: seq(32, 17), groupKey: seq(32, 19), group: null };
const joiner = sas.joinerTranscript("pairing-id_1", host.publicKey, joinerSide, commit);
const full = sas.fullTranscript(joiner, hostSide, { t: 1781270000123, group: "group-1", nonce: fill(32, 21) });
const fin = sas.finalTranscript(full, fill(32, 9));
const secret = seq(32, 200);
const pairSecret = sas.derivePairSecret(secret, fin);

const card = {
  id: "card_0a1b", kind: "tool", computer: "Studio", issuedAt: 1781270000000, expiresAt: 1781270600000, hash: "x",
  fields: { title: { type: "text", text: "Run \"it\"\n\t\u0001 é 😀  " }, n: 1.5, big: 1e21, neg: -3, tiny: 5e-7, z: 0 },
  options: [{ id: "approve", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }],
  "": 1, "😀": 2, B: null, a: [true, false, null],
};

const points = {
  valid: hex(key.publicKey),
  identity: hex(Uint8Array.from([1, ...new Array(31).fill(0)])),
  nonCanonical: "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  orderTwo: "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  smallOrder8: "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  notOnCurve: "0200000000000000000000000000000000000000000000000000000000000000",
  zeroSignBit: "0100000000000000000000000000000000000000000000000000000000000080",
};

console.log(JSON.stringify({
  cbor: hex(encode(["x", 0, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296, 1781270000123, -1, -24, -25, -4294967297, 1.5, -0, 9007199254740992, null, undefined, true, false, new Uint8Array([1, 2]), { b: 1, a: [] }, "é😀"])),
  seed: hex(seed),
  publicKey: hex(key.publicKey),
  deviceId: await deviceIdFor(key.publicKey),
  signature: hex(key.sign(msg)),
  message: hex(msg),
  commit: hex(commit),
  records: {
    phone: hex(sas.canonicalRecord(recordPhone)), host: hex(sas.canonicalRecord(recordHost)), bare: hex(sas.canonicalRecord(recordBare)),
    moss: hex(sas.canonicalRecord({ ...recordPhone, app: "moss" })), code: hex(sas.canonicalRecord({ ...recordPhone, app: "code" })),
  },
  hostPublicKey: hex(host.publicKey),
  joiner: hex(joiner),
  full: hex(full),
  final: hex(fin),
  secret: hex(secret),
  proofJoiner: hex(sas.pairProof(secret, sas.PAIR_PROOF_JOINER, joiner)),
  proofHost: hex(sas.pairProof(secret, sas.PAIR_PROOF_HOST, full)),
  words: sas.sasWords(secret, fin),
  pairSecret: hex(pairSecret),
  pairId: hex(sas.derivePairId(pairSecret)),
  pairStatement: hex(pairStatement("pairid", ["k1", "k2"], 1781270000123)),
  admitStatement: hex(admitStatement("group-1", "gk", 1781270000123)),
  answerKeyEd: hex(answerKeyStatement("dev", "pk", "keychain")),
  answerKeyP256: hex(answerKeyStatement("dev", "pk", "secure-enclave", "p256")),
  card: JSON.stringify(card),
  canonical: canonicalJson(card),
  cardHash: createHash("sha256").update(cardHashInput(card)).digest("hex"),
  userMessageHash: createHash("sha256").update(userMessageHashInput({ text: "Hi \"there\"\n😀", images: [{ n: 1, path: "bots/a/staged/1.png" }], files: [{ n: 1, path: "home/notes.md" }, { n: 2, path: "bots/a/x.txt" }] })).digest("hex"),
  userMessageInput: userMessageSigningInput({ session: "s_alpha", clientMessageId: "m-1", hash: "ab", sentAt: 1781270000123 }),
  signingInput: cardAnswerSigningInput({ id: "card_x", hash: "ab", option: "approve", at: 1781270000000, children: ["zeta", "Alpha", "beta", "", "😀"] }),
  names: NAMES.map((n) => ({ name: n, ok: nameProblem(n) === null })),
  safeNames: RAW_NAMES.map((n) => ({ raw: n, safe: safeDeviceName(n, "Phone") })),
  points: Object.fromEntries(Object.entries(points).map(([k, v]) => [k, { hex: v, strict: isStrictEd25519Point(Uint8Array.from(Buffer.from(v, "hex"))) }])),
}));
