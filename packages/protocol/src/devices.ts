// MOSS protocol area: devices and links (spec §6.4, §8). Owner: lane H (identity, devices, links, sync, the
// lease and the shared clock). Pinned by lane B at M0; spike S1 chose iroh (lane H's report of November 5).
//
// Every paired device has its own Ed25519 key, and each pair keeps one persistent encrypted link (§8.2). The main
// computer holds a short lease renewed through the waifucave handshake; another computer takes over only after it
// lapses (§6.4). Peer methods run daemon to daemon over that link; a peer acts for the user who called on its own
// computer, under the same allow lists (`peer.call`).
import { z } from "zod";
import { utf16 } from "./strings";
import {
  BotId, Caller, CardId, ChangeResult, ComputerName, DeviceId, DeviceOs, Empty, FencingToken, Ok, Os, SessionId, Text, Timestamp,
} from "./common";

/** What the account's deletion still has waifucave confirm (services/accounts PROTOCOL.md, "Deleting the account"). */
export const AccountDeletionStep = z.enum(["hooks", "push", "handshake", "sign-in"]);
export type AccountDeletionStep = z.infer<typeof AccountDeletionStep>;
import { SignedCardAnswer } from "./approvals";
import { coreEvent, defineEvent, defineMethod } from "./rpc";
import { UserMessageInput } from "./sessions";

export const DeviceKind = z.enum(["desktop", "server", "cloud", "phone", "browser"]);
export type DeviceKind = z.infer<typeof DeviceKind>;

/** Which of the two phone apps a paired phone is: MOSS (the bots) or MOSS Code (sessions with coding agents). The program
 *  names (`WindowProgram`, surfaces.ts: `PHONE_APPS` is the same list, checked in `push-routing.ts`; written out here
 *  because surfaces.ts imports this file). It is recorded once, in the pairing exchange (`DeviceRecord.app`, links/pairing.ts), and
 *  never changes: a paired phone can't later claim to be the other app. A phone that paired without one, or through the
 *  account, has none. It decides only where a push goes (push-routing.ts), never what the phone may list or answer. */
export const PHONE_APPS = ["moss", "code"] as const;
export const PhoneApp = z.enum(PHONE_APPS);
export type PhoneApp = z.infer<typeof PhoneApp>;

/** How a link reaches its peer (§8.2): the same LAN, direct over the internet, or through a relay plugin. */
export const LinkPath = z.enum(["lan", "direct", "relay"]);
export type LinkPath = z.infer<typeof LinkPath>;

export const LinkView = z.object({
  peer: DeviceId,
  up: z.boolean(),
  path: LinkPath.optional(),
  /** The relay plugin carrying it, when `path` is `relay`. */
  relay: utf16(128).optional(),
  rttMs: z.number().nonnegative().optional(),
  since: Timestamp.optional(),
  /** What the peer's `peer.hello` named on the live connection (its tree protocol among them, `treeFeature`). */
  features: z.array(utf16(64)).max(64).optional(),
});
export type LinkView = z.infer<typeof LinkView>;

/** Who may answer another computer's card with a signature (the owner's decision on review N1): a phone, with its own
 *  key, or any desktop, with a key its app holds apart from the core's link key, so plugin code can't sign with it
 *  where the OS allows: a Keychain item on macOS (`keychain`, limited to the signed app as `app-keychain`), a TPM-held
 *  key (`tpm`) on Windows. `dpapi` and `secret-service` name at-rest storage only — no protection from code running as
 *  the user — and the picker never chooses them today. Where the OS can't keep it from plugin code, the owner accepted
 *  the risk: "any desktop may answer; a compromised plugin on a Windows or Linux computer could approve actions on other
 *  computers". Servers, cloud computers and browsers never sign. `none` names a key the OS can't keep apart. Never
 *  `hello`: no biometric or passcode prompts anywhere (the owner's decision). */
export const ANSWER_KEY_HOLDERS = ["secure-enclave", "keystore", "keychain", "app-keychain", "tpm", "dpapi", "secret-service", "none"] as const;
export const AnswerKeyHolder = z.enum(ANSWER_KEY_HOLDERS);
export type AnswerKeyHolder = z.infer<typeof AnswerKeyHolder>;

/** What the OS offers the app to keep a key from other code on the same computer. Phones name their own holder at
 *  pairing; this is the desktop's choice. `dpapi` and `secret-service` name at-rest storage only — no protection
 *  from code running as the user — and the picker below never chooses them today. */
export interface AnswerKeyProtections {
  /** macOS: a Keychain item for the key. */
  keychain?: boolean;
  /** macOS: a Keychain item whose access list names only the signed app. */
  appKeychain?: boolean;
  /** Windows: the TPM can hold it, with no PIN or Hello gesture to use it. */
  tpm?: boolean;
  /** Windows: DPAPI encrypts it to this user (at rest only). */
  dpapi?: boolean;
  /** Linux: the Secret Service holds it (at rest only). */
  secretService?: boolean;
}

/** How the key will be held, from the computer's OS and what it offers; `none` when nothing keeps plugin code from
 *  it. Windows without a TPM, and Linux, return `none`: plugin code running as the user can reach DPAPI and the
 *  Secret Service. Pure, beside the type, so the core and the desktop choose from one place (no app-to-core
 *  dependency). */
export function answerKeyHolderFor(os: Os, available: AnswerKeyProtections): AnswerKeyHolder {
  if (os === "macos") {
    if (available.appKeychain === true) return "app-keychain";
    if (available.keychain === true) return "keychain";
    return "none";
  }
  if (os === "windows") {
    if (available.tpm === true) return "tpm";
    return "none";
  }
  return "none";
}

/** The answer key's algorithm (lanes H and I): `p256` for a key the Secure Enclave or a TPM holds (raw
 *  uncompressed point, 65 bytes; signatures are ECDSA over SHA-256, `r‖s`, 64 bytes), `ed25519` for one in software.
 *  Verification picks it from the record; the registration statement covers it. Absent is `ed25519`. */
export const AnswerKeyAlg = z.enum(["ed25519", "p256"]);
export type AnswerKeyAlg = z.infer<typeof AnswerKeyAlg>;

export const DeviceView = z.object({
  id: DeviceId,
  name: utf16(63, 1),
  kind: DeviceKind,
  os: DeviceOs.optional(),
  /** Runs moss-core, so it is a computer in the tree (§9.1) and can take over (§6.4). */
  runsCore: z.boolean(),
  /** Its folder-tree name, for a device that runs moss-core. */
  computer: ComputerName.optional(),
  hasDisplay: z.boolean().optional(),
  /** For a phone: the app it paired as (`PhoneApp`); absent for any other device and for a phone that recorded none. */
  app: PhoneApp.optional(),
  online: z.boolean(),
  link: LinkView.optional(),
  isThis: z.boolean(),
  isMain: z.boolean(),
  addedAt: Timestamp,
  lastSeenAt: Timestamp.optional(),
  /** How its app's answer key is held, for a device that may answer cards; absent for one that can't. */
  answers: z.object({ held: AnswerKeyHolder, alg: AnswerKeyAlg.optional() }).optional(),
  /** A desktop's answer keys per program (spec revision 19, ruling C: MOSS, MOSS Code and the host each hold their own);
   *  absent from an engine that keeps one key per device. */
  answersBy: z.array(z.object({ program: z.enum(["moss", "code", "host"]), held: AnswerKeyHolder, alg: AnswerKeyAlg.optional() })).max(3).optional(),
});
export type DeviceView = z.infer<typeof DeviceView>;

/** The main computer's lease (§6.4). Events carry its `epoch`; a main that can't renew stops starting turns, tool
 *  calls and memory writes before `expiresAt`, with a margin for clock error. */
export const LeaseView = z.object({
  /** The computer the user chose, or that was chosen automatically (§6.4). */
  main: DeviceId.nullable(),
  holder: DeviceId.nullable(),
  /** Who `holder` is to this device, so a client shows it without guessing (lane H): this device (`self`), a computer
   *  this device knows (`computer`, by its name), or a device it doesn't know (`unknown`: not paired with this one yet,
   *  or removed), shown as "held by a computer this one doesn't know". Null with no holder. The core fills it in
   *  `main.get` and `lease_changed`; a lease's own state, before the core names its holder, leaves it out. */
  heldBy: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("self") }),
    z.object({ kind: z.literal("computer"), computer: ComputerName }),
    z.object({ kind: z.literal("unknown") }),
  ]).nullable().optional(),
  /** The lease's scope: the account's, or the account-less devices' group's (item 85); with `epoch`, its fencing token. */
  scope: utf16(128, 1).optional(),
  epoch: z.number().int().nonnegative(),
  expiresAt: Timestamp.nullable(),
  /** The one device that refreshes rotating logins (§8.5). */
  refresher: DeviceId.nullable(),
  state: z.enum(["held", "lapsed", "unreachable", "handing-over"]),
});
export type LeaseView = z.infer<typeof LeaseView>;

/** The shared clock on this device (§6.4): its offset from the reference, measured over the link. */
export const ClockView = z.object({
  reference: z.union([DeviceId, z.literal("public")]),
  offsetMs: z.number(),
  accuracyMs: z.number().nonnegative(),
  synced: z.boolean(),
});
export type ClockView = z.infer<typeof ClockView>;

export const AccountView = z.object({
  signedIn: z.boolean(),
  provider: z.enum(["email", "discord", "google"]).optional(),
  user: z.object({ id: utf16(128), email: utf16(320).optional(), name: utf16(200).optional() }).optional(),
});
export type AccountView = z.infer<typeof AccountView>;

/** The relay this computer's links use (§8.3): n0's public relays (the default), none (a pair that can't connect directly then
 *  can't connect), or the person's own relay server by its address (`https://`). A cloud computer's relay and a Cloudflare
 *  relay are relay plugins, which the links don't take yet. */
export const RelayView = z.object({
  mode: z.enum(["n0", "off", "custom"]),
  url: utf16(2048, 1).optional(),
});
export type RelayView = z.infer<typeof RelayView>;

/** No-account pairing (§8.1): a code or QR, plus the inherited 4-word check. */
export const PairingView = z.object({
  pairingId: utf16(128, 1),
  code: utf16(64, 1).optional(),
  /** What the QR encodes. */
  qr: utf16(4096).optional(),
  words: z.array(utf16(32)).length(4).optional(),
  expiresAt: Timestamp,
});

/** An append-only stream two devices replicate (§8.5): `transcript:<session>`, `memory:<bot>`, `plugins`,
 *  `credentials`, `settings`, `routines`, `usage`. Lane H settles the streams and their payloads at H-M3.
 *  The rule H-M3 keeps (review N7): a receiver never takes a grant from a peer's stream (`PEER_STREAM_GRANTS`, every
 *  §5.5 sensitive change) without its own card answered here or a signed answer bound to that change
 *  (`verifySignedAnswer`). Such an entry is kept as a request that waits for that answer; it never takes effect from
 *  the stream alone. */
export const SyncStream = utf16(256, 1).regex(/^[a-z][a-z-]*(:[A-Za-z0-9._:/-]+)?$/);
/** What a peer's sync entry can never grant by itself (review N7): every §5.5 sensitive change. A plugin's OK, a
 *  computer's level, a saved rule, a raised routine level; adding or revoking a device and choosing the main computer;
 *  a development folder, a trusted repo, a connector permission; the 18+ confirmation; and a replaced provider
 *  credential. */
export const PEER_STREAM_GRANTS = [
  "plugin-ok", "computer-level", "saved-rule", "routine-level-raise", "device-add", "device-revoke", "main-computer",
  "dev-folder", "repo-trust", "connector-permission", "adult-confirmation", "provider-credential",
] as const;
export type PeerStreamGrant = (typeof PEER_STREAM_GRANTS)[number];

export const SyncEntry = z.object({
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  ts: Timestamp,
  device: DeviceId,
  /** End-to-end encrypted where the stream holds secrets (credentials). */
  payload: z.unknown(),
});
export type SyncEntry = z.infer<typeof SyncEntry>;

/** A link's connection number between two devices (H-M1's ask), which ranks their connections so both ends keep the
 *  same one: the dialer proposes one, and the answer is the larger of that and one past the last the answerer took. */
const ConnSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** An Ed25519 public key or signature, base64. */
const Base64Key = utf16(256, 1).regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const DEVICES_METHODS = {
  deviceList: defineMethod({
    name: "device.list", owner: "H", roles: ["app", "cli", "remote", "layer"], capability: "devices.read",
    params: Empty, result: z.object({ devices: z.array(DeviceView) }),
    doc: "Every paired device, phones and browsers included, with its link.",
  }),
  deviceRename: defineMethod({
    name: "device.rename", owner: "H", roles: ["app", "cli", "remote"], userOnly: true, change: "core",
    params: z.object({ id: DeviceId, name: utf16(63, 1) }), result: ChangeResult,
    doc: "Renames a device; a computer keeps its old tree name as an alias (§9.1).",
  }),
  deviceRevoke: defineMethod({
    name: "device.revoke", owner: "H", roles: ["app", "cli", "remote"], userOnly: true, change: "sensitive",
    params: z.object({ id: DeviceId }), result: ChangeResult,
    doc: "Revokes a device: its links are cut at once and a guided rotation of synced keys starts (§8.1).",
  }),
  devicePairBegin: defineMethod({
    name: "device.pair.begin", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: Empty, result: PairingView,
    doc: "Shows a pairing code and QR for a device to join, without an account (§8.1).",
  }),
  devicePairJoin: defineMethod({
    name: "device.pair.join", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: z.object({ code: utf16(4096, 1) }), result: PairingView,
    doc: "Joins another device's pairing by its code or QR payload; both then show the same four words: on the engine's sealed add card, which it raises itself for an app caller (the result carries no words), or in the user's own terminal (the words come back, and `device.pair.confirm` is the check).",
  }),
  devicePairConfirm: defineMethod({
    name: "device.pair.confirm", owner: "H", roles: ["app", "cli"], userOnly: true, change: "sensitive",
    params: z.object({ pairingId: utf16(128, 1), words: z.array(utf16(32)).length(4) }),
    result: ChangeResult,
    doc: "Confirms the four words typed by the user's own terminal (no card), or, from an app that holds them, asks for the sealed add card the engine raises anyway (once per pairing). A page of a plugin never holds the words and the app's door does not offer it this call.",
  }),
  devicePairCancel: defineMethod({
    name: "device.pair.cancel", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: z.object({ pairingId: utf16(128, 1) }), result: Ok,
    doc: "Cancels a pairing.",
  }),
  deviceRelayGet: defineMethod({
    name: "device.relay.get", owner: "H", roles: ["app", "cli"],
    params: Empty, result: RelayView,
    doc: "Which relay this computer's links use: n0's public relays by default, none, or the person's own relay server (§8.3).",
  }),
  deviceRelaySet: defineMethod({
    name: "device.relay.set", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: RelayView, result: RelayView,
    doc: "Chooses the relay (the setup guide's relay page, §8.3): `n0`, `off`, or `custom` with the relay server's `https://` address. The links use it at once; a relay sees which devices are online and how much they send, never what.",
  }),
  accountStatus: defineMethod({
    name: "account.status", owner: "H", roles: ["app", "cli", "remote"],
    params: Empty, result: AccountView,
    doc: "The waifucave account this computer is signed in with, if any (§8.1).",
  }),
  accountSignIn: defineMethod({
    name: "account.signIn", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: z.object({ provider: z.enum(["email", "discord", "google"]) }),
    result: z.object({ url: z.string().url() }),
    doc: "Starts a sign-in; the client opens the URL. Signing in is enough to add a device (§8.1).",
  }),
  accountSignOut: defineMethod({
    name: "account.signOut", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: Empty, result: Ok,
    doc: "Signs this computer out of the account: it leaves the account's device list first, then its sign-in ends here.",
  }),
  accountDelete: defineMethod({
    /** The person only (the deletion lane, item 1): from an app the engine raises its sealed card naming what goes and
     *  what stays, and deletes on its yes alone; in their own terminal `confirm: true` is the CLI's own typed
     *  confirmation. Never a bot, an agent, a plugin, a phone, the web page or another computer. */
    name: "account.delete", owner: "H", roles: ["app", "cli"], userOnly: true, change: "sensitive",
    params: z.object({ confirm: z.literal(true).optional() }),
    result: z.union([
      z.object({ applied: z.literal(true), pending: z.array(AccountDeletionStep).max(4) }),
      z.object({ applied: z.literal(false), card: CardId }),
    ]),
    doc: "Deletes the waifucave account: at waifucave the account's devices, push addresses, webhook keys and waiting webhooks, connection records and the sign-in itself; here the sign-in and the devices the account alone added. Conversations, bots, memory, settings and files stay. `pending` names what waifucave still confirms; it finishes on its own.",
  }),
  mainGet: defineMethod({
    name: "main.get", owner: "H", roles: ["app", "cli", "remote", "web"],
    params: Empty, result: z.object({ lease: LeaseView }),
    doc: "The main computer, the lease's holder and epoch, and the refresher.",
  }),
  mainSet: defineMethod({
    name: "main.set", owner: "H", roles: ["app", "cli", "remote"], userOnly: true, change: "sensitive",
    params: z.object({ device: DeviceId }), result: ChangeResult,
    doc: "Chooses the main computer; a new cloud computer becomes main only after the user confirms (§6.4).",
  }),
  mainHandOver: defineMethod({
    name: "main.handOver", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: Empty, result: z.object({ to: DeviceId.nullable() }),
    doc: "Releases the lease now so another computer takes the bots (Hand over and quit, a laptop's sleep; §3.1, §6.4).",
  }),
  clockStatus: defineMethod({
    name: "clock.status", owner: "H", roles: ["app", "cli"],
    params: Empty, result: ClockView,
    doc: "This device's shared-clock offset and accuracy (§6.4).",
  }),
  linkList: defineMethod({
    name: "link.list", owner: "H", roles: ["app", "cli"],
    params: Empty, result: z.object({ links: z.array(LinkView) }),
    doc: "This computer's links and their paths.",
  }),
  deviceAnswerKeySet: defineMethod({
    /** The app's main process hands the core the key it answers cards with (H-M1's ask; item 91): held apart from the
     *  core's link key, so plugin code can't sign with it where the OS allows. The core takes it only with the app's
     *  signature over `clover/answer-key/1\n<device>\n<publicKey>\n<held>` (`setOwnAnswerKey`), for a desktop. */
    /** The first key applies at once. Replacing one is a sensitive change (#179's review, check 2): other computers
     *  trust that key with their cards, so it ends in a sealed card (`{ applied: false, card }`). */
    name: "device.answerKey.set", owner: "H", roles: ["app"], userOnly: true,
    params: z.object({
      publicKey: Base64Key, held: AnswerKeyHolder, alg: AnswerKeyAlg.optional(), signature: Base64Key,
      /** Replacing a key this desktop already holds: the current key's hand-over, its signature over
       *  `clover/answer-key-rotate/1\n<device>\n<from>\n<to>\n<at>` (`answerKeyRotateStatement`). The user's yes on a
       *  sealed change card bound to exactly this hand-over then applies it (`{ applied: false, card }` until then). */
      rotation: z.object({ from: Base64Key, at: Timestamp, signature: Base64Key }).optional(),
    }),
    result: ChangeResult,
    doc: "Registers this desktop's app-held answer key, proved by the app's own signature; replacing a held one takes the current key's hand-over and the user's yes on a card.",
  }),

  // Daemon to daemon, over the link.
  peerHello: defineMethod({
    name: "peer.hello", owner: "H", roles: ["peer"],
    /** `epochScope`: the lease record `epoch` counts in (`account`, `group:<id>`), so the peer compares like with like. */
    params: z.object({ protocolVersion: z.number().int(), device: DeviceId, epoch: z.number().int().nonnegative(), epochScope: utf16(128, 1).optional(), features: z.array(utf16(64)).max(64), connSeq: ConnSeq }),
    result: z.object({ protocolVersion: z.number().int(), device: DeviceId, epoch: z.number().int().nonnegative(), epochScope: utf16(128, 1).optional(), features: z.array(utf16(64)), connSeq: ConnSeq }),
    doc: "Opens a link's session: links negotiate a protocol version and support one release back (§14.2 item 22).",
  }),
  peerCall: defineMethod({
    name: "peer.call", owner: "H", roles: ["peer"],
    params: z.object({
      method: utf16(128, 1),
      params: z.unknown(),
      /** Whose call it is on the calling computer, for attribution only. The receiver decides who the caller is from
       *  the link (`from`, the authenticated peer device), never from this: a peer's `user` is the user on another
       *  device, never the user's own terminal here, and it never waives the fence. A `noSessions` method (a card's
       *  sealed fields) runs only for `as.kind === "user"`. The sender, when it lands, builds `as` from the caller the
       *  call started with, never defaulting it to `user`. */
      as: Caller,
      /** The allow list the receiver applies: a remote client's (`remote`) or the web page's shorter one (`web`), never
       *  another role's (`peerCallVerdict`). */
      role: z.enum(["remote", "web"]),
      /** The sending main's fencing token; the receiver refuses a stale one (`isStaleFence`). */
      fence: FencingToken.optional(),
      /** For a `userOnly` or `change` method: the user's signed answer, bound to this call, which the receiver
       *  verifies itself; without it the call is refused. */
      answer: SignedCardAnswer.optional(),
    }),
    result: z.object({ result: z.unknown() }),
    doc: "Runs a method on this computer for a caller on another one: a message to a bot that thinks here, a card's answer.",
  }),
  linkSessionDeliver: defineMethod({
    /** Lane H's bot relay, as a protocol method (H-M2's ask, D's review S2): another session's message, never the
     *  user's (a user's message comes only through `peer.session.send`, with its device's signature). The receiver
     *  takes it only from a paired computer running moss-core, and only as what it says it is; `computer` names the
     *  sending computer, which must be the link's own peer. */
    name: "link.session.deliver", owner: "H", roles: ["peer"],
    params: z.object({
      id: SessionId,
      /** The sending computer's tree name; the receiver refuses one that isn't the link's peer. */
      computer: ComputerName,
      input: z.discriminatedUnion("from", [
        // `depth`: how far the exchange has gone without the person (the loop brake, sessions/exchange-depth.ts); the receiver
        // reads one beyond its limit as the limit.
        z.strictObject({ from: z.literal("bot"), bot: BotId, session: SessionId, text: utf16(1_000_000), depth: z.number().int().nonnegative().max(1_000).optional() }),
        z.strictObject({ from: z.literal("agent"), agent: utf16(128, 1), text: utf16(1_000_000), depth: z.number().int().nonnegative().max(1_000).optional() }),
        z.strictObject({ from: z.literal("routine"), routine: utf16(128, 1), name: utf16(200), sideThread: SessionId, text: utf16(1_000_000), failed: z.boolean().optional() }),
        /** An agent's final report reaching its bot. */
        z.strictObject({
          from: z.literal("task-notification"), agent: utf16(128, 1), backend: utf16(128, 1),
          stopReason: z.enum(["end_turn", "refusal", "cancelled", "stopped", "stalled", "sign-in", "crashed", "error"]),
          text: utf16(1_000_000), transcript: utf16(4096),
          usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(),
        }),
      ]),
    }),
    result: z.object({ disposition: z.enum(["turn", "interrupted", "folded", "queued", "note"]), seq: z.number().int().nonnegative() }),
    doc: "A bot's, an agent's or a routine's message, or an agent's final report, to a session that runs on this computer, from the computer that sent it.",
  }),
  peerSessionDeliver: defineMethod({
    name: "peer.session.send", owner: "D", roles: ["peer"],
    params: z.object({
      id: SessionId,
      /** The message as its device sent it, with its `signature` when the device has an answer key. */
      message: UserMessageInput,
      /** The device the user sent it from, whose signature the receiver checks (`message.signature`). */
      device: DeviceId,
      /** The relaying computer's stamp, in shared time; the receiver clamps it to its own clock (`clampSentAt`). */
      sentAt: Timestamp,
    }),
    result: z.object({ seq: z.number().int().nonnegative() }),
    doc: "A user's message from another device, for a bot that thinks here (§6.4). The receiver verifies the sending device's signature over the session, message id, message hash and send time; without a good one the turn it starts isn't the user's (review N3).",
  }),
  syncHeads: defineMethod({
    name: "sync.heads", owner: "H", roles: ["peer"],
    params: z.object({ streams: z.array(SyncStream).max(10_000).optional() }),
    result: z.object({ heads: z.record(z.string(), z.object({ seq: z.number().int().nonnegative(), epoch: z.number().int().nonnegative() })) }),
    doc: "The last entry of each stream this computer holds.",
  }),
  syncPull: defineMethod({
    name: "sync.pull", owner: "H", roles: ["peer"],
    params: z.object({ stream: SyncStream, after: z.number().int().min(-1), limit: z.number().int().min(1).max(10_000) }),
    result: z.object({ entries: z.array(SyncEntry), more: z.boolean() }),
    doc: "Entries of a stream after a seq.",
  }),
  syncPush: defineMethod({
    name: "sync.push", owner: "H", roles: ["peer"],
    params: z.object({ stream: SyncStream, base: z.number().int().min(-1), entries: z.array(SyncEntry).max(10_000) }),
    result: z.union([z.object({ ok: z.literal(true), head: z.number().int() }), z.object({ ok: z.literal(false), reason: z.enum(["stale_base", "not_writer", "refused"]) })]),
    doc: "Appends entries; a stale base is refused, as the inherited phone sync refuses one (`ipc/sync.ts`). An entry that grants something (`PEER_STREAM_GRANTS`) waits for this computer's own card or a bound signed answer (review N7).",
  }),
} as const;

export const DeviceChangedEvent = coreEvent("device_changed", { device: DeviceView });
export const DeviceRemovedEvent = coreEvent("device_removed", { id: DeviceId, revoked: z.boolean() });
export const LeaseChangedEvent = coreEvent("lease_changed", { lease: LeaseView });
export const LinkChangedEvent = coreEvent("link_changed", { link: LinkView });
export const PairingChangedEvent = coreEvent("pairing_changed", {
  pairingId: utf16(128, 1),
  step: z.enum(["waiting", "words", "card", "done", "failed", "expired"]),
  /** The four words to compare. Only the person's own terminal (a `cli` connection that calls as the user, never a CLI a bot's or
   *  an agent's session runs) ever gets them: an app or a plugin's page sees the step only, and the words are drawn by the engine in the add card's sealed frame (`TERMINAL_ONLY_FIELDS`, §5.5). */
  words: z.array(utf16(32)).length(4).optional(),
  /** The name the other device gave itself, from the step where it is known (shown as text, never trusted). */
  peerName: utf16(63).optional(),
  /** In words the person reads, never the other device's own text. On `failed`: why the pairing ended. On `expired`: absent (the code's
   *  expiry came, which the engine's timer ends at that time, whatever step the pairing had reached). On `waiting`: a device tried to
   *  join and was turned away over its name, kind or system; the code still works for the right device. */
  reason: Text.optional(),
});
export const AccountChangedEvent = coreEvent("account_changed", { account: AccountView });

export const DEVICES_EVENTS = {
  deviceChanged: defineEvent({
    type: "device_changed", owner: "H", roles: ["app", "cli", "remote", "layer"], capability: "devices.read", schema: DeviceChangedEvent,
    fixture: {
      type: "device_changed", ts: 1781270000000,
      device: { id: "k3x9a7mq2c4d8e1f5g6h0j2k4m6n8p0r", name: "Laptop1", kind: "desktop", os: "macos", runsCore: true, computer: "Laptop1", hasDisplay: true, online: true, link: { peer: "k3x9a7mq2c4d8e1f5g6h0j2k4m6n8p0r", up: true, path: "lan", rttMs: 2.4 }, isThis: false, isMain: false, addedAt: 1781200000000 },
    },
    doc: "A device was added or changed, or came online or went offline.",
  }),
  deviceRemoved: defineEvent({
    type: "device_removed", owner: "H", roles: ["app", "cli", "remote", "layer"], capability: "devices.read", schema: DeviceRemovedEvent,
    fixture: { type: "device_removed", ts: 1781270000000, id: "k3x9a7mq2c4d8e1f5g6h0j2k4m6n8p0r", revoked: true },
    doc: "A device was revoked or removed.",
  }),
  leaseChanged: defineEvent({
    type: "lease_changed", owner: "H", roles: ["app", "cli", "remote", "web"], schema: LeaseChangedEvent,
    fixture: { type: "lease_changed", ts: 1781270000000, lease: { main: "m4p0studio7c2d9e1f3a5b7c9d1e3f5a", holder: "m4p0studio7c2d9e1f3a5b7c9d1e3f5a", epoch: 4, expiresAt: 1781270030000, refresher: "m4p0studio7c2d9e1f3a5b7c9d1e3f5a", state: "held" } },
    doc: "The main computer, the lease's holder, its epoch or the refresher changed.",
  }),
  linkChanged: defineEvent({
    type: "link_changed", owner: "H", roles: ["app", "cli"], schema: LinkChangedEvent,
    fixture: { type: "link_changed", ts: 1781270000000, link: { peer: "k3x9a7mq2c4d8e1f5g6h0j2k4m6n8p0r", up: true, path: "relay", relay: "moss/relay-n0", rttMs: 48 } },
    doc: "A link came up, went down or changed path.",
  }),
  pairingChanged: defineEvent({
    // `layer`: a plugin's part that holds `devices.manage` (Settings' Devices page) hears the steps of the pairings on this
    // computer and the other device's name, never the four words: those go to the person's own terminal alone (a CLI that calls as the user, not one a session runs), and everyone else
    // compares them on the engine's sealed add card. No other plugin hears it (`capability`).
    type: "pairing_changed", owner: "H", roles: ["app", "cli", "layer"], capability: "devices.manage", schema: PairingChangedEvent,
    fixture: { type: "pairing_changed", ts: 1781270000000, pairingId: "pair_1", step: "words", words: ["maple", "orbit", "velvet", "canyon"] },
    doc: "A pairing moved on.",
  }),
  accountChanged: defineEvent({
    type: "account_changed", owner: "H", roles: ["app", "cli", "remote"], schema: AccountChangedEvent,
    fixture: { type: "account_changed", ts: 1781270000000, account: { signedIn: true, provider: "discord", user: { id: "u_1", name: "me" } } },
    doc: "The account was signed in or out.",
  }),
} as const;
