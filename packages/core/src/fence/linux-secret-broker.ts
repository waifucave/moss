// The Linux credential broker (docs/linux-credential-broker.md; spec §4, §9.1, items 8 and 76). A fenced command
// can't make a Unix socket, so it never reaches the user's session bus. When its run carries grants, the sandbox's
// relay (`linux-bus-relay.ts`) hands each of its D-Bus connections here, and this module is that command's WHOLE bus:
//   * a minimal `org.freedesktop.DBus` answered here (Hello, matches accepted and ignored, the secrets name's owner);
//   * a read-only `org.freedesktop.secrets` answered here, over items the engine reads from the user's real keyring
//     with its own connection (`sessionBusSecrets`), judged by the REAL item's attributes at each request;
//   * everything else refused: another destination is `ServiceUnknown` (systemd1, portals, Flatpak, ...), another
//     method `AccessDenied`; no name is owned, no descriptor is passed, nothing is ever forwarded to the real bus.
// An item is served only when it isn't MOSS's own (`isMossItem`, checked first: no grant opens one) and a grant of the
// run matches it (`grantMatches`). The command sees paths this module made for its connection, one per item that passed;
// it never sees a real path, a locked item or an item it wasn't granted.
import { createConnection, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { keychainService } from "../profile";
import { dataFrames, encodeFrame, FrameReader, FrameType } from "./bus-frames";
import { type DValue, encodeMessage, Flag, isObjectPath, type Message, MessageReader, MessageType, Variant, WireError } from "./dbus-wire";

/** One saved login a run may use: a label for the person, and the attributes an item must carry (each, equal). */
export interface CredentialGrant {
  readonly label: string;
  readonly attributes: Readonly<Record<string, string>>;
}

/** What a run may reach in the user's keyring, and who hears of an item it was refused (for the card). */
export interface CredentialPolicy {
  readonly grants: readonly CredentialGrant[];
  /** An item the command asked for that no grant matched: its label and attributes, never its value. */
  readonly refused?: (item: { label: string; attributes: Record<string, string> }) => void;
}

/** An item of the user's keyring as the engine reads it. `ref` is the real object path, never shown to the command. */
export interface KeyringItem {
  readonly ref: string;
  readonly label: string;
  readonly attributes: Record<string, string>;
  readonly locked: boolean;
}

/** The user's real keyring, read by the engine alone. */
export interface SecretBackend {
  /** The unlocked items matching `attributes`, as real paths. */
  search(attributes: Record<string, string>): Promise<string[]>;
  item(ref: string): Promise<KeyringItem | null>;
  secret(ref: string): Promise<{ value: Uint8Array; contentType: string } | null>;
  close(): void;
}

/** The names MOSS keeps its own items under, every form: every MOSS store (dev and dist, `.key`, `.items`, and the
 *  old product's: all under `com.waifucave.`), and this engine's
 *  own service with its override. */
export function mossItemNames(): string[] {
  const names = ["com.waifucave."];
  try { names.push(keychainService()); } catch { /* the base names cover it */ }
  const o = process.env.MOSS_KEYCHAIN_SERVICE;
  if (o) names.push(o);
  return [...new Set(names.map((n) => n.toLowerCase()))];
}

/** Whether an item is MOSS's own: its label or any attribute value is a MOSS store name, or starts with one. */
export function isMossItem(item: { label: string; attributes: Record<string, string> }, names: readonly string[] = mossItemNames()): boolean {
  const hit = (v: string): boolean => {
    const s = v.toLowerCase();
    return names.some((n) => s === n || s.startsWith(n.endsWith(".") ? n : `${n}.`));
  };
  return hit(item.label) || Object.values(item.attributes).some(hit);
}

/** Whether `grant` matches an item's attributes: it names at least one attribute besides `xdg:schema`, and the item
 *  carries every one it names, equal. */
export function grantMatches(grant: CredentialGrant, attributes: Record<string, string>): boolean {
  const keys = Object.keys(grant.attributes);
  if (!keys.some((k) => k !== "xdg:schema")) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(attributes, k) && attributes[k] === grant.attributes[k]);
}

// ---- bounds ----
export const BROKER_LIMITS = { connections: 16, buffered: 4 * 1024 * 1024, attributes: 32, attributeLength: 1024, items: 256, searchResults: 256, saslLine: 1024, saslLines: 16, refusalsPerCall: 4 } as const;

const DBUS = "org.freedesktop.DBus";
const SECRETS = "org.freedesktop.secrets";
/** The secrets name's owner on the sandbox's bus (a made-up unique name: the real one is never shown). */
export const SECRETS_OWNER = ":1.0";
const SERVICE_PATH = "/org/freedesktop/secrets";
const COLLECTION_PATH = "/org/freedesktop/secrets/collection/login";
const ALIAS_PATH = "/org/freedesktop/secrets/aliases/default";
const SESSION_PREFIX = "/org/freedesktop/secrets/session/s";
const I_SERVICE = "org.freedesktop.Secret.Service";
const I_COLLECTION = "org.freedesktop.Secret.Collection";
const I_ITEM = "org.freedesktop.Secret.Item";
const I_SESSION = "org.freedesktop.Secret.Session";
const I_PROPS = "org.freedesktop.DBus.Properties";
const I_PEER = "org.freedesktop.DBus.Peer";
const E_DENIED = "org.freedesktop.DBus.Error.AccessDenied";
const E_UNKNOWN_SERVICE = "org.freedesktop.DBus.Error.ServiceUnknown";
const E_UNKNOWN_METHOD = "org.freedesktop.DBus.Error.UnknownMethod";
const E_ARGS = "org.freedesktop.DBus.Error.InvalidArgs";
const E_NOT_SUPPORTED = "org.freedesktop.DBus.Error.NotSupported";
const E_NO_OBJECT = "org.freedesktop.Secret.Error.NoSuchObject";
const E_NO_SESSION = "org.freedesktop.Secret.Error.NoSession";
const E_LOCKED = "org.freedesktop.Secret.Error.IsLocked";

/** The broker's refusal texts start with this, so a test (and a person) can tell the fence from a missing daemon. */
export const REFUSAL = "moss: the fence";

class Refusal extends Error {
  constructor(readonly name: string, message: string) { super(message); }
}
const denied = (why: string) => new Refusal(E_DENIED, `${REFUSAL} refuses ${why}`);

type Attrs = Record<string, string>;

function attributesArg(v: DValue | undefined): Attrs {
  if (!Array.isArray(v)) throw new Refusal(E_ARGS, "attributes expected");
  if (v.length > BROKER_LIMITS.attributes) throw new Refusal(E_ARGS, "too many attributes");
  const out: Attrs = {};
  for (const e of v) {
    const [k, val] = e as [DValue, DValue];
    if (typeof k !== "string" || typeof val !== "string") throw new Refusal(E_ARGS, "attributes are strings");
    if (k.length > BROKER_LIMITS.attributeLength || val.length > BROKER_LIMITS.attributeLength) throw new Refusal(E_ARGS, "attribute too long");
    out[k] = val;
  }
  return out;
}

/** One D-Bus connection of the sandbox. */
class SandboxConnection {
  #sasl = true;
  #saslLines = 0;
  #saslOk = false;
  #saslAwaitData = false;
  #hello = false;
  #serial = 1;
  readonly #in = new MessageReader(BROKER_LIMITS.buffered);
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  /** Paths handed out on this connection: ours → the real item, and back. */
  readonly #items = new Map<string, string>();
  readonly #byRef = new Map<string, string>();
  #nextItem = 1;
  readonly #sessions = new Set<string>();
  #nextSession = 1;
  #firstByte = true;

  constructor(private readonly id: number, private readonly ctx: BrokerContext, private readonly out: (b: Uint8Array) => void, private readonly closeMe: () => void) {}

  get closed(): boolean { return this.#closed; }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.closeMe();
  }

  push(data: Uint8Array): void {
    if (this.#closed) return;
    try {
      this.#in.push(data);
      if (this.#sasl) this.#saslStep();
      if (!this.#sasl) this.#drain();
    } catch {
      this.close();
    }
  }

  #saslStep(): void {
    if (this.#firstByte) {
      const b = this.#in.peek();
      if (b.length === 0) return;
      if (b[0] !== 0) throw new WireError("the first byte must be NUL");
      this.#in.take(1);
      this.#firstByte = false;
    }
    for (;;) {
      const b = this.#in.peek();
      const nl = b.indexOf("\r\n");
      if (nl < 0) { if (b.length > BROKER_LIMITS.saslLine) throw new WireError("auth line too long"); return; }
      if (nl > BROKER_LIMITS.saslLine || ++this.#saslLines > BROKER_LIMITS.saslLines) throw new WireError("auth too long");
      const line = this.#in.take(nl + 2).subarray(0, nl).toString("latin1");
      const [cmd, mech, arg] = line.split(" ");
      const say = (s: string) => this.out(Buffer.from(`${s}\r\n`, "latin1"));
      if (cmd === "AUTH") {
        // Who the peer is means nothing here: the channel is this sandbox's own. EXTERNAL (sd-bus, godbus) and
        // ANONYMOUS (GDBus over TCP) are both accepted; no cookie files are read.
        if (mech === "EXTERNAL" && arg === undefined) { this.#saslAwaitData = true; say("DATA"); continue; }
        if (mech === "EXTERNAL" || mech === "ANONYMOUS") { this.#saslOk = true; say(`OK ${this.ctx.guid}`); continue; }
        say("REJECTED EXTERNAL ANONYMOUS");
      } else if (cmd === "DATA" && this.#saslAwaitData) {
        this.#saslAwaitData = false; this.#saslOk = true; say(`OK ${this.ctx.guid}`);
      } else if (cmd === "NEGOTIATE_UNIX_FD") {
        say("ERROR fd passing is not available");
      } else if (cmd === "BEGIN" && this.#saslOk) {
        this.#sasl = false;
        return;
      } else if (cmd === "CANCEL" || cmd === "ERROR") {
        this.#saslOk = false; say("REJECTED EXTERNAL ANONYMOUS");
      } else {
        say("ERROR");
      }
    }
  }

  #drain(): void {
    for (;;) {
      const m = this.#in.next();
      if (m === null) return;
      if (m.unixFds !== undefined) throw new WireError("descriptors are not passed");
      // One message at a time, in order: a flood waits in the bounded input buffer, past which the connection closes.
      this.#queue = this.#queue.then(() => this.#handle(m)).catch(() => this.close());
    }
  }

  #send(m: Omit<Message, "serial">): void {
    if (this.#closed) return;
    this.out(encodeMessage({ ...m, serial: this.#serial++ } as Message));
  }

  #reply(call: Message, signature: string, body: DValue[]): void {
    if (call.flags & Flag.NoReply) return;
    this.#send({ type: MessageType.Return, flags: Flag.NoReply, replySerial: call.serial, dest: this.#unique, sender: this.#senderFor(call), signature, body });
  }

  #error(call: Message, name: string, text: string): void {
    if (call.flags & Flag.NoReply) return;
    this.#send({ type: MessageType.Error, flags: Flag.NoReply, replySerial: call.serial, error: name, dest: this.#unique, sender: this.#senderFor(call), signature: "s", body: [text] });
  }

  get #unique(): string { return `:1.${this.id + 1}`; }
  #senderFor(call: Message): string { return call.dest === DBUS ? DBUS : SECRETS_OWNER; }

  async #handle(m: Message): Promise<void> {
    if (this.#closed || m.type !== MessageType.Call) return; // replies and signals from the sandbox go nowhere
    try {
      if (!this.#hello && !(m.dest === DBUS && m.member === "Hello")) throw denied("a call before Hello");
      if (m.dest === DBUS) return this.#driver(m);
      if (m.dest === SECRETS || m.dest === SECRETS_OWNER) return await this.#secrets(m);
      if (m.dest === undefined) throw denied("a call with no destination");
      throw new Refusal(E_UNKNOWN_SERVICE, `${REFUSAL} has no ${m.dest} here: only the user's saved logins this run was allowed`);
    } catch (e) {
      if (e instanceof Refusal) this.#error(m, e.name, e.message);
      else if (e instanceof WireError) throw e;
      else this.#error(m, "org.freedesktop.DBus.Error.Failed", `${REFUSAL}: the keyring didn't answer`);
    }
  }

  #driver(m: Message): void {
    const arg = m.body[0];
    const iface = m.iface ?? DBUS;
    if (iface === I_PEER && m.member === "Ping") return this.#reply(m, "", []);
    if (iface !== DBUS) throw denied(`${iface}.${m.member} on the bus`);
    switch (m.member) {
      case "Hello":
        if (this.#hello) throw denied("a second Hello");
        this.#hello = true;
        return this.#reply(m, "s", [this.#unique]);
      case "AddMatch": case "RemoveMatch":
        // Accepted and ignored: no signal is ever delivered from here.
        return this.#reply(m, "", []);
      case "GetNameOwner":
        if (arg === SECRETS || arg === SECRETS_OWNER) return this.#reply(m, "s", [SECRETS_OWNER]);
        if (arg === DBUS) return this.#reply(m, "s", [DBUS]);
        throw new Refusal("org.freedesktop.DBus.Error.NameHasNoOwner", `${REFUSAL}: no ${String(arg)} here`);
      case "NameHasOwner":
        return this.#reply(m, "b", [arg === SECRETS || arg === SECRETS_OWNER || arg === DBUS || arg === this.#unique]);
      case "StartServiceByName":
        if (arg === SECRETS) return this.#reply(m, "u", [2]);
        throw new Refusal(E_UNKNOWN_SERVICE, `${REFUSAL} starts nothing: no ${String(arg)} here`);
      case "ListNames":
        return this.#reply(m, "as", [[DBUS, SECRETS, SECRETS_OWNER, this.#unique]]);
      case "ListActivatableNames":
        return this.#reply(m, "as", [[DBUS]]);
      case "GetId":
        return this.#reply(m, "s", [this.ctx.guid]);
      default:
        throw denied(`${DBUS}.${m.member}`);
    }
  }

  async #secrets(m: Message): Promise<void> {
    const path = m.path!;
    const kind = path === SERVICE_PATH ? "service"
      : path === COLLECTION_PATH || path === ALIAS_PATH ? "collection"
      : this.#items.has(path) ? "item"
      : this.#sessions.has(path) ? "session" : null;
    if (kind === null) throw new Refusal(E_NO_OBJECT, `${REFUSAL}: no object ${path} here`);
    const member = m.member!;
    const iface = m.iface ?? ({ service: I_SERVICE, collection: I_COLLECTION, item: I_ITEM, session: I_SESSION } as const)[kind];
    if (iface === I_PEER && member === "Ping") return this.#reply(m, "", []);
    if (iface === I_PROPS) return this.#properties(m, kind, path);
    const key = `${kind} ${iface}.${member}`;
    switch (key) {
      case `service ${I_SERVICE}.OpenSession`: {
        if (m.signature !== "sv") throw new Refusal(E_ARGS, "OpenSession takes (sv)");
        if (m.body[0] !== "plain") throw new Refusal(E_NOT_SUPPORTED, `${REFUSAL} serves the plain session only`);
        if (this.#sessions.size >= 8) throw denied("more sessions");
        const s = `${SESSION_PREFIX}${this.#nextSession++}`;
        this.#sessions.add(s);
        return this.#reply(m, "vo", [new Variant("s", ""), s]);
      }
      case `service ${I_SERVICE}.SearchItems`: {
        if (m.signature !== "a{ss}") throw new Refusal(E_ARGS, "SearchItems takes a{ss}");
        return this.#reply(m, "aoao", [await this.#search(attributesArg(m.body[0])), []]);
      }
      case `collection ${I_COLLECTION}.SearchItems`: {
        if (m.signature !== "a{ss}") throw new Refusal(E_ARGS, "SearchItems takes a{ss}");
        return this.#reply(m, "ao", [await this.#search(attributesArg(m.body[0]))]);
      }
      case `service ${I_SERVICE}.GetSecrets`: {
        if (m.signature !== "aoo") throw new Refusal(E_ARGS, "GetSecrets takes (aoo)");
        const paths = m.body[0] as string[];
        const session = this.#session(m.body[1]);
        if (paths.length > BROKER_LIMITS.items) throw denied("that many items at once");
        // Every path in the body is judged; one that isn't granted refuses the whole call.
        const judged: [string, string][] = [];
        for (const p of paths) judged.push([p, (await this.#judge(p)).ref]);
        const out: DValue[] = [];
        for (const [p, ref] of judged) out.push([p, await this.#secretStruct(ref, session)]);
        return this.#reply(m, "a{o(oayays)}", [out]);
      }
      case `item ${I_ITEM}.GetSecret`: {
        if (m.signature !== "o") throw new Refusal(E_ARGS, "GetSecret takes (o)");
        const session = this.#session(m.body[0]);
        const item = await this.#judge(path);
        return this.#reply(m, "(oayays)", [await this.#secretStruct(item.ref, session)]);
      }
      case `service ${I_SERVICE}.Unlock`: {
        // Never the real Unlock (it can raise a password dialog): what is ours is unlocked already, nothing else is.
        if (m.signature !== "ao") throw new Refusal(E_ARGS, "Unlock takes (ao)");
        const mine = (m.body[0] as string[]).filter((p) => p === COLLECTION_PATH || p === ALIAS_PATH || this.#items.has(p));
        return this.#reply(m, "aoo", [mine, "/"]);
      }
      case `service ${I_SERVICE}.ReadAlias`: {
        if (m.signature !== "s") throw new Refusal(E_ARGS, "ReadAlias takes (s)");
        return this.#reply(m, "o", [m.body[0] === "default" || m.body[0] === "login" ? COLLECTION_PATH : "/"]);
      }
      case `session ${I_SESSION}.Close`:
        this.#sessions.delete(path);
        return this.#reply(m, "", []);
      default:
        throw denied(`${iface}.${member}: the sandbox's keyring is read-only`);
    }
  }

  #session(v: DValue | undefined): string {
    if (typeof v !== "string" || !this.#sessions.has(v)) throw new Refusal(E_NO_SESSION, `${REFUSAL}: no such session`);
    return v;
  }

  async #secretStruct(ref: string, session: string): Promise<DValue[]> {
    const s = await this.ctx.backend().secret(ref);
    if (s === null) throw new Refusal(E_NO_OBJECT, `${REFUSAL}: the item is gone`);
    return [session, [], [...s.value], s.contentType];
  }

  /** Our path → the real item, judged now: refused unless it is still there, not MOSS's, granted and unlocked. */
  async #judge(path: unknown): Promise<KeyringItem> {
    const ref = typeof path === "string" ? this.#items.get(path) : undefined;
    if (ref === undefined) throw denied(`${String(path)}: not an item this run was allowed`);
    const item = await this.ctx.backend().item(ref);
    if (item === null) throw new Refusal(E_NO_OBJECT, `${REFUSAL}: the item is gone`);
    const verdict = this.ctx.verdict(item);
    if (verdict !== "allow") throw denied(verdict === "moss" ? "MOSS's own secrets" : `the saved login "${item.label}": it isn't allowed for this run`);
    if (item.locked) throw new Refusal(E_LOCKED, `${REFUSAL}: the item is locked`);
    return item;
  }

  async #search(attributes: Attrs): Promise<string[]> {
    const refs = (await this.ctx.backend().search(attributes)).slice(0, BROKER_LIMITS.searchResults);
    const out: string[] = [];
    let told = 0;
    for (const ref of refs) {
      const item = await this.ctx.backend().item(ref);
      if (item === null || item.locked) continue;
      const v = this.ctx.verdict(item);
      if (v === "moss") continue;
      if (v === "refuse") {
        if (told++ < BROKER_LIMITS.refusalsPerCall) this.ctx.refused(item);
        continue;
      }
      out.push(this.#handOut(ref));
    }
    return out;
  }

  #handOut(ref: string): string {
    const known = this.#byRef.get(ref);
    if (known !== undefined) return known;
    if (this.#items.size >= BROKER_LIMITS.items) throw denied("more items");
    const p = `${COLLECTION_PATH}/${this.#nextItem++}`;
    this.#items.set(p, ref);
    this.#byRef.set(ref, p);
    return p;
  }

  async #properties(m: Message, kind: string, path: string): Promise<void> {
    const member = m.member;
    if (member === "Set") throw denied("setting a property: the sandbox's keyring is read-only");
    if (member !== "Get" && member !== "GetAll") throw denied(`${I_PROPS}.${member}`);
    if (member === "Get" && m.signature !== "ss") throw new Refusal(E_ARGS, "Get takes (ss)");
    if (member === "GetAll" && m.signature !== "s") throw new Refusal(E_ARGS, "GetAll takes (s)");
    const iface = m.body[0];
    let props: [string, Variant][];
    if (kind === "service" && iface === I_SERVICE) props = [["Collections", new Variant("ao", [COLLECTION_PATH])]];
    else if (kind === "collection" && iface === I_COLLECTION) {
      props = [["Items", new Variant("ao", [...this.#items.keys()])], ["Label", new Variant("s", "Login")], ["Locked", new Variant("b", false)],
        ["Created", new Variant("t", 0n)], ["Modified", new Variant("t", 0n)]];
    } else if (kind === "item" && iface === I_ITEM) {
      const item = await this.#judge(path);
      props = [["Attributes", new Variant("a{ss}", Object.entries(item.attributes).map(([k, v]) => [k, v]))], ["Label", new Variant("s", item.label)],
        ["Locked", new Variant("b", false)], ["Created", new Variant("t", 0n)], ["Modified", new Variant("t", 0n)]];
    } else throw denied(`the properties of ${String(iface)} on ${path}`);
    if (member === "GetAll") return this.#reply(m, "a{sv}", [props]);
    const hit = props.find(([n]) => n === m.body[1]);
    if (hit === undefined) throw new Refusal(E_ARGS, `${REFUSAL}: no property ${String(m.body[1])}`);
    return this.#reply(m, "v", [hit[1]]);
  }
}

interface BrokerContext {
  guid: string;
  backend(): SecretBackend;
  verdict(item: KeyringItem): "allow" | "moss" | "refuse";
  refused(item: KeyringItem): void;
}

export interface SandboxBusOptions {
  /** Frames from the relay. */
  readonly input: AsyncIterable<Uint8Array>;
  /** Frames to the relay. */
  readonly write: (b: Uint8Array) => void;
  readonly policy: CredentialPolicy;
  /** The user's keyring, opened on first need (one per run) and closed with it. */
  readonly backend: () => SecretBackend;
  /** MOSS's own store names (`mossItemNames()` by default). */
  readonly mossNames?: readonly string[];
}

/** Serves one run's sandbox bus until its input ends or `close()`; `done` settles then. */
export function serveSandboxBus(o: SandboxBusOptions): { done: Promise<void>; close(): void } {
  const names = o.mossNames ?? mossItemNames();
  let backend: SecretBackend | null = null;
  const conns = new Map<number, SandboxConnection>();
  let ended = false;
  const ctx: BrokerContext = {
    guid: randomBytes(16).toString("hex"),
    backend: () => (backend ??= o.backend()),
    verdict: (item) => (isMossItem(item, names) ? "moss" : o.policy.grants.some((g) => grantMatches(g, item.attributes)) ? "allow" : "refuse"),
    refused: (item) => { try { o.policy.refused?.({ label: item.label, attributes: { ...item.attributes } }); } catch { /* the card is best effort */ } },
  };
  const write = (b: Uint8Array) => { if (!ended) { try { o.write(b); } catch { /* the relay is gone */ } } };
  const close = () => {
    if (ended) return;
    for (const c of [...conns.values()]) c.close(); // each says Close to the relay first
    conns.clear();
    ended = true;
    try { backend?.close(); } catch { /* closed */ }
  };
  const done = (async () => {
    const frames = new FrameReader();
    try {
      for await (const chunk of o.input) {
        if (ended) break;
        for (const f of frames.push(chunk)) {
          if (f.type === FrameType.Open) {
            if (conns.has(f.conn) || conns.size >= BROKER_LIMITS.connections) { write(encodeFrame(FrameType.Close, f.conn)); continue; }
            const id = f.conn;
            const c: SandboxConnection = new SandboxConnection(id, ctx, (b) => { for (const fr of dataFrames(id, b)) write(fr); }, () => {
              if (conns.get(id) === c) conns.delete(id);
              write(encodeFrame(FrameType.Close, id));
            });
            conns.set(id, c);
          } else if (f.type === FrameType.Data) {
            conns.get(f.conn)?.push(f.data);
          } else {
            const c = conns.get(f.conn);
            if (c !== undefined) { conns.delete(f.conn); c.close(); }
          }
        }
      }
    } catch { /* a bad frame: the whole channel ends */ }
    close();
  })();
  return { done, close };
}

// ---- the engine's own connection to the user's session bus ----

/** The first `unix:` address in a D-Bus address list, as a socket path (`\0`-prefixed for an abstract one). */
export function unixBusPath(address: string | undefined): string | null {
  if (!address) return null;
  for (const entry of address.split(";")) {
    const [transport, rest] = [entry.slice(0, entry.indexOf(":")), entry.slice(entry.indexOf(":") + 1)];
    if (transport !== "unix") continue;
    const kv = Object.fromEntries(rest.split(",").map((p) => [p.slice(0, p.indexOf("=")), decodeURIComponent(p.slice(p.indexOf("=") + 1))]));
    if (kv.path) return kv.path;
    if (kv.abstract) return `\0${kv.abstract}`;
  }
  return null;
}

/** A minimal D-Bus client over a Unix socket (the engine's side, outside every sandbox). */
export class BusClient {
  #sock: Socket;
  #reader = new MessageReader(16 * 1024 * 1024);
  #serial = 1;
  #pending = new Map<number, { ok: (m: Message) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #ready: Promise<void>;
  #authed = false;
  #closed = false;

  constructor(path: string, readonly timeoutMs = 10_000) {
    this.#sock = createConnection({ path });
    this.#ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("the session bus didn't answer")), timeoutMs);
      this.#sock.once("connect", () => {
        const uid = String(process.getuid?.() ?? 0);
        this.#sock.write(`\0AUTH EXTERNAL ${Buffer.from(uid).toString("hex")}\r\n`);
      });
      this.#sock.on("data", (d: Buffer) => {
        try {
          this.#reader.push(d);
          if (!this.#authed) {
            const b = this.#reader.peek();
            const nl = b.indexOf("\r\n");
            if (nl < 0) return;
            const line = this.#reader.take(nl + 2).toString("latin1");
            if (!line.startsWith("OK ")) { clearTimeout(t); reject(new Error("the session bus refused us")); this.close(); return; }
            this.#authed = true;
            this.#sock.write("BEGIN\r\n");
            clearTimeout(t);
            resolve();
          }
          for (let m = this.#reader.next(); m !== null; m = this.#reader.next()) {
            if ((m.type === MessageType.Return || m.type === MessageType.Error) && m.replySerial !== undefined) {
              const p = this.#pending.get(m.replySerial);
              if (p === undefined) continue;
              this.#pending.delete(m.replySerial);
              clearTimeout(p.timer);
              if (m.type === MessageType.Error) p.fail(new Error(`${m.error}: ${typeof m.body[0] === "string" ? m.body[0] : ""}`));
              else p.ok(m);
            }
          }
        } catch (e) { this.close(); reject(e as Error); }
      });
      this.#sock.on("error", (e) => { clearTimeout(t); reject(e); this.close(); });
      this.#sock.on("close", () => this.close());
    });
    this.#ready.catch(() => { /* surfaced on the first call */ });
  }

  async call(dest: string, path: string, iface: string, member: string, signature = "", body: DValue[] = []): Promise<Message> {
    await this.#ready;
    if (this.#closed) throw new Error("the session bus connection closed");
    const serial = this.#serial++;
    const msg = encodeMessage({ type: MessageType.Call, flags: 0, serial, dest, path, iface, member, signature, body });
    return new Promise<Message>((ok, fail) => {
      const timer = setTimeout(() => { this.#pending.delete(serial); fail(new Error(`${member} timed out`)); }, this.timeoutMs);
      this.#pending.set(serial, { ok, fail, timer });
      this.#sock.write(msg);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.fail(new Error("the session bus connection closed")); }
    this.#pending.clear();
    this.#sock.destroy();
  }
}

/** The user's real Secret Service, read through the engine's own bus connection: search, an item's attributes, label
 *  and lock state, and a secret through a plain session. Nothing else is ever called (no Unlock, no prompt, no write). */
export function sessionBusSecrets(address: string | undefined = process.env.DBUS_SESSION_BUS_ADDRESS): SecretBackend | null {
  const path = unixBusPath(address);
  if (path === null) return null;
  const bus = new BusClient(path);
  let hello: Promise<unknown> | null = null;
  let session: Promise<string> | null = null;
  const ready = () => (hello ??= bus.call(DBUS, "/org/freedesktop/DBus", DBUS, "Hello"));
  const plain = () => (session ??= ready().then(() => bus.call(SECRETS, SERVICE_PATH, I_SERVICE, "OpenSession", "sv", ["plain", new Variant("s", "")])).then((m) => m.body[1] as string));
  return {
    async search(attributes) {
      await ready();
      const m = await bus.call(SECRETS, SERVICE_PATH, I_SERVICE, "SearchItems", "a{ss}", [Object.entries(attributes).map(([k, v]) => [k, v])]);
      return (m.body[0] as string[]).filter(isObjectPath);
    },
    async item(ref) {
      await ready();
      try {
        const m = await bus.call(SECRETS, ref, I_PROPS, "GetAll", "s", [I_ITEM]);
        const props = new Map((m.body[0] as [string, Variant][]).map(([k, v]) => [k, v.value]));
        const attributes: Record<string, string> = {};
        for (const [k, v] of (props.get("Attributes") as [string, string][] | undefined) ?? []) attributes[k] = v;
        return { ref, label: String(props.get("Label") ?? ""), attributes, locked: props.get("Locked") !== false };
      } catch { return null; }
    },
    async secret(ref) {
      const s = await plain();
      try {
        const m = await bus.call(SECRETS, SERVICE_PATH, I_SERVICE, "GetSecrets", "aoo", [[ref], s]);
        const hit = (m.body[0] as [string, DValue[]][]).find(([p]) => p === ref);
        if (hit === undefined) return null;
        const [, , value, contentType] = hit[1] as [string, number[], number[], string];
        return { value: Uint8Array.from(value), contentType };
      } catch { return null; }
    },
    close: () => bus.close(),
  };
}
