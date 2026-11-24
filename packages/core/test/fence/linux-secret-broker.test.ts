// The Linux credential broker on any OS (docs/linux-credential-broker.md): the sandbox's whole bus, driven frame by
// frame as the relay would, over a fake keyring. The real keyring, bwrap and real clients are the e2e file's
// (`linux-secret-broker.e2e.test.ts`, Linux CI only).
import { describe, expect, test } from "bun:test";
import { dataFrames, encodeFrame, FrameReader, FrameType } from "../../src/fence/bus-frames";
import { decodeMessage, encodeMessage, type DValue, type Message, MessageReader, MessageType, splitSignature, Variant, WireError } from "../../src/fence/dbus-wire";
import { BROKER_LIMITS, type CredentialGrant, grantMatches, isMossItem, type KeyringItem, REFUSAL, type SecretBackend, serveSandboxBus, unixBusPath } from "../../src/fence/linux-secret-broker";

const MOSS_NAMES = ["com.waifucave.", "moss.test.override"];

/** A keyring of three items: a git login, gh's token and MOSS's own secrets-file key. */
function fakeKeyring(): SecretBackend & { reads: string[]; searches: Record<string, string>[] } {
  const items: Record<string, KeyringItem & { value: string }> = {
    "/real/1": { ref: "/real/1", label: "Git: https://github.com/", attributes: { "xdg:schema": "org.git.Password", server: "github.com", protocol: "https", user: "octo" }, locked: false, value: "git-token" },
    "/real/2": { ref: "/real/2", label: "gh:github.com", attributes: { service: "gh:github.com", username: "" }, locked: false, value: "gh-token" },
    "/real/3": { ref: "/real/3", label: "secrets file key", attributes: { service: "com.waifucave.moss.core.key", account: "file" }, locked: false, value: "moss-key" },
    "/real/4": { ref: "/real/4", label: "Git: https://gitlab.com/", attributes: { "xdg:schema": "org.git.Password", server: "gitlab.com", protocol: "https" }, locked: false, value: "other" },
  };
  const reads: string[] = [];
  const searches: Record<string, string>[] = [];
  return {
    reads, searches,
    async search(a) { searches.push(a); return Object.values(items).filter((i) => Object.entries(a).every(([k, v]) => i.attributes[k] === v)).map((i) => i.ref); },
    async item(ref) { const i = items[ref]; return i ? { ref, label: i.label, attributes: i.attributes, locked: i.locked } : null; },
    async secret(ref) { reads.push(ref); const i = items[ref]; return i ? { value: new TextEncoder().encode(i.value), contentType: "text/plain" } : null; },
    close() {},
  };
}

/** An input stream the test pushes frames into. */
function channel() {
  const q: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const input: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (q.length) yield q.shift()!;
        if (closed) return;
        await new Promise<void>((r) => { wake = r; });
      }
    },
  };
  return { input, push(b: Uint8Array) { q.push(b); wake?.(); }, end() { closed = true; wake?.(); } };
}

function broker(grants: CredentialGrant[], refused: { label: string }[] = []) {
  const ch = channel();
  const frames = new FrameReader();
  const byConn = new Map<number, Uint8Array[]>();
  const closedConns = new Set<number>();
  const keyring = fakeKeyring();
  const server = serveSandboxBus({
    input: ch.input,
    write: (b) => { for (const f of frames.push(b)) { if (f.type === FrameType.Close) closedConns.add(f.conn); else (byConn.get(f.conn) ?? byConn.set(f.conn, []).get(f.conn)!).push(f.data); } },
    policy: { grants, refused: (i) => refused.push(i) },
    backend: () => keyring,
    mossNames: MOSS_NAMES,
  });
  let nextConn = 1;
  const client = (opts: { auth?: string; lines?: number } = {}) => {
    const id = nextConn++;
    ch.push(encodeFrame(FrameType.Open, id));
    const send = (b: Uint8Array) => { for (const f of dataFrames(id, b)) ch.push(f); };
    send(Buffer.from(`\0${opts.auth ?? "AUTH ANONYMOUS 6d6f7373"}\r\nBEGIN\r\n`, "latin1"));
    let serial = 1;
    const reader = new MessageReader();
    let consumed = 0;
    let saslLeft = opts.lines ?? 1;
    const replies = async (): Promise<Message[]> => {
      await Bun.sleep(20);
      const chunks = byConn.get(id) ?? [];
      for (const c of chunks.slice(consumed)) reader.push(c);
      consumed = chunks.length;
      while (saslLeft > 0) {
        const b = reader.peek();
        const nl = b.indexOf("\r\n");
        if (nl < 0) return [];
        reader.take(nl + 2);
        saslLeft--;
      }
      const out: Message[] = [];
      for (let m = reader.next(); m !== null; m = reader.next()) out.push(m);
      return out;
    };
    const call = async (dest: string, path: string, iface: string | undefined, member: string, signature = "", body: DValue[] = []): Promise<Message> => {
      const s = serial++;
      send(encodeMessage({ type: MessageType.Call, flags: 0, serial: s, dest, path, ...(iface ? { iface } : {}), member, signature, body }));
      for (let k = 0; k < 50; k++) {
        const hit = (await replies()).find((m) => m.replySerial === s);
        if (hit) return hit;
      }
      throw new Error(`no reply to ${member}`);
    };
    return { id, send, call, closed: () => closedConns.has(id), hello: () => call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello") };
  };
  return { client, keyring, server, end: () => ch.end(), closedConns };
}

const SVC = "org.freedesktop.Secret.Service";
const SECRETS = "org.freedesktop.secrets";
const GIT: CredentialGrant = { label: "GitHub (git)", attributes: { "xdg:schema": "org.git.Password", server: "github.com" } };
const attrs = (o: Record<string, string>): DValue => Object.entries(o).map(([k, v]) => [k, v]);
const text = (m: Message) => String(m.body[0] ?? "");

describe("the D-Bus codec", () => {
  test("a message round-trips, variants and dicts included", () => {
    const m = { type: MessageType.Call, flags: 0, serial: 7, dest: "a.b", path: "/a/b", iface: "a.b", member: "M", signature: "sva{sv}ay(ux)",
      body: ["x", new Variant("as", ["p", "q"]), [["k", new Variant("t", 5n)]], [1, 2, 3], [4, -9n]] as DValue[] };
    const back = decodeMessage(encodeMessage(m as Message));
    expect(back.member).toBe("M");
    expect(back.body[0]).toBe("x");
    expect((back.body[1] as Variant).value).toEqual(["p", "q"]);
    expect(((back.body[2] as DValue[][])[0]![1] as Variant).value).toBe(5n);
    expect(back.body[3]).toEqual([1, 2, 3]);
    expect(back.body[4]).toEqual([4, -9n]);
  });

  test("malformed input throws, never reads past the message", () => {
    expect(() => splitSignature("a")).toThrow(WireError);
    expect(() => splitSignature("(")).toThrow(WireError);
    expect(() => splitSignature("a".repeat(40) + "y")).toThrow(WireError);
    const good = encodeMessage({ type: MessageType.Call, flags: 0, serial: 1, path: "/", member: "M", signature: "s", body: ["hello"] });
    const cut = Buffer.from(good);
    cut.writeUInt32LE(9999, cut.length - 10); // the string's length now runs past the end
    expect(() => decodeMessage(cut)).toThrow(WireError);
    const big = Buffer.from(good);
    big.writeUInt32LE(64 * 1024 * 1024, 4);
    const r = new MessageReader();
    r.push(big);
    expect(() => r.next()).toThrow(WireError);
  });

  test("a deeply nested variant is refused", () => {
    // v holding v holding v ... built by hand: each level is sig "v" (01 76 00).
    const depth = 200;
    const body = Buffer.concat([...Array.from({ length: depth }, () => Buffer.from([1, 0x76, 0])), Buffer.from([1, 0x79, 0, 7])]);
    const head = encodeMessage({ type: MessageType.Call, flags: 0, serial: 1, path: "/", member: "M", signature: "v", body: [new Variant("y", 7)] });
    const bodyStart = head.length - 4; // the original body: [01 'y' 00 07]
    const msg = Buffer.concat([head.subarray(0, bodyStart), body]);
    msg.writeUInt32LE(body.length, 4);
    expect(() => decodeMessage(msg)).toThrow(WireError);
  });
});

describe("the item rules", () => {
  test("MOSS's own items, by any attribute value or the label, every form", () => {
    expect(isMossItem({ label: "x", attributes: { service: "com.waifucave.moss.core.key" } }, MOSS_NAMES)).toBe(true);
    expect(isMossItem({ label: "x", attributes: { service: "COM.WaifuCave.moss.core.dev.items" } }, MOSS_NAMES)).toBe(true);
    expect(isMossItem({ label: "com.waifucave.moss.core.dev", attributes: {} }, MOSS_NAMES)).toBe(true);
    expect(isMossItem({ label: "x", attributes: { a: "moss.test.override.items" } }, MOSS_NAMES)).toBe(true);
    expect(isMossItem({ label: "x", attributes: { service: "gh:github.com" } }, MOSS_NAMES)).toBe(false);
    expect(isMossItem({ label: "x", attributes: { service: "moss.test.overridex" } }, MOSS_NAMES)).toBe(false);
  });

  test("a grant needs an attribute besides the schema, and matches only every attribute it names", () => {
    expect(grantMatches({ label: "", attributes: {} }, { a: "1" })).toBe(false);
    expect(grantMatches({ label: "", attributes: { "xdg:schema": "org.git.Password" } }, { "xdg:schema": "org.git.Password" })).toBe(false);
    expect(grantMatches(GIT, { "xdg:schema": "org.git.Password", server: "github.com", user: "o" })).toBe(true);
    expect(grantMatches(GIT, { "xdg:schema": "org.git.Password", server: "gitlab.com" })).toBe(false);
    expect(grantMatches({ label: "", attributes: { toString: "x" } }, {})).toBe(false);
  });

  test("the session bus address: a path, an abstract name, none", () => {
    expect(unixBusPath("unix:path=/tmp/dbus-x,guid=ab")).toBe("/tmp/dbus-x");
    expect(unixBusPath("tcp:host=1.2.3.4,port=1;unix:abstract=/tmp/dbus-y")).toBe("\0/tmp/dbus-y");
    expect(unixBusPath("tcp:host=1.2.3.4,port=1")).toBeNull();
    expect(unixBusPath(undefined)).toBeNull();
  });
});

describe("the sandbox's bus", () => {
  test("the granted item is found and read; the others are not even listed", async () => {
    const refused: { label: string }[] = [];
    const b = broker([GIT], refused);
    const c = b.client();
    expect((await c.hello()).type).toBe(MessageType.Return);
    const s = await c.call(SECRETS, "/org/freedesktop/secrets", SVC, "OpenSession", "sv", ["plain", new Variant("s", "")]);
    const session = s.body[1] as string;
    const all = await c.call(SECRETS, "/org/freedesktop/secrets", SVC, "SearchItems", "a{ss}", [attrs({})]);
    expect(all.body[0]).toHaveLength(1);
    const found = await c.call(SECRETS, "/org/freedesktop/secrets", SVC, "SearchItems", "a{ss}", [attrs({ server: "github.com" })]);
    const [path] = found.body[0] as string[];
    expect(path).toMatch(/^\/org\/freedesktop\/secrets\/collection\/login\/\d+$/);
    const got = await c.call(SECRETS, "/org/freedesktop/secrets", SVC, "GetSecrets", "aoo", [[path!], session]);
    const value = ((got.body[0] as DValue[][])[0]![1] as DValue[])[2] as number[];
    expect(Buffer.from(value).toString()).toBe("git-token");
    // A non-granted item asked for raises the card's callback; MOSS's own never does.
    expect(refused.map((r) => r.label)).toEqual(["gh:github.com", "Git: https://gitlab.com/"]);
    b.end();
  });

  test("MOSS's own item is refused even when a grant names it exactly", async () => {
    const b = broker([{ label: "the key", attributes: { service: "com.waifucave.moss.core.key", account: "file" } }]);
    const c = b.client();
    await c.hello();
    const found = await c.call(SECRETS, "/org/freedesktop/secrets", SVC, "SearchItems", "a{ss}", [attrs({ service: "com.waifucave.moss.core.key" })]);
    expect(found.body).toEqual([[], []]);
    expect(b.keyring.reads).toEqual([]);
    b.end();
  });

  test("a path the broker never handed out, a real path, or one in a mixed GetSecrets body is refused", async () => {
    const b = broker([GIT]);
    const c = b.client();
    await c.hello();
    const session = (await c.call(SECRETS, "/org/freedesktop/secrets", SVC, "OpenSession", "sv", ["plain", new Variant("s", "")])).body[1] as string;
    const [granted] = (await c.call(SECRETS, "/org/freedesktop/secrets", SVC, "SearchItems", "a{ss}", [attrs({ server: "github.com" })])).body[0] as string[];
    for (const paths of [["/real/3"], ["/org/freedesktop/secrets/collection/login/99"], [granted!, "/real/2"]]) {
      const r = await c.call(SECRETS, "/org/freedesktop/secrets", SVC, "GetSecrets", "aoo", [paths, session]);
      expect(r.type).toBe(MessageType.Error);
      expect(text(r)).toContain(REFUSAL);
    }
    expect(b.keyring.reads).toEqual([]);
    b.end();
  });

  test("writes, unlocks of the real keyring, prompts and other services are refused; no name is owned", async () => {
    const b = broker([GIT]);
    const c = b.client();
    await c.hello();
    const cases: [string, string, string, string, string, DValue[], string][] = [
      ["org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ss", ["x", "y"], "ServiceUnknown"],
      ["org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Settings", "Read", "ss", ["a", "b"], "ServiceUnknown"],
      ["org.freedesktop.Flatpak", "/org/freedesktop/Flatpak/Development", "org.freedesktop.Flatpak.Development", "HostCommand", "", [], "ServiceUnknown"],
      ["org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", "su", ["org.freedesktop.secrets", 0], "AccessDenied"],
      ["org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "BecomeMonitor", "asu", [[], 0], "AccessDenied"],
      [SECRETS, "/org/freedesktop/secrets/collection/login", "org.freedesktop.Secret.Collection", "CreateItem", "", [], "AccessDenied"],
      [SECRETS, "/org/freedesktop/secrets", SVC, "Lock", "ao", [[]], "AccessDenied"],
      [SECRETS, "/org/freedesktop/secrets/collection/login", "org.freedesktop.DBus.Properties", "Set", "ssv", ["a", "b", new Variant("s", "")], "AccessDenied"],
      [SECRETS, "/org/freedesktop/secrets/prompt/u1", "org.freedesktop.Secret.Prompt", "Prompt", "s", [""], "NoSuchObject"],
    ];
    for (const [dest, path, iface, member, sig, body, err] of cases) {
      const r = await c.call(dest, path, iface, member, sig, body);
      expect(r.type).toBe(MessageType.Error);
      expect(r.error).toContain(err);
      expect(text(r)).toContain("moss:");
    }
    // Unlock answers from the broker alone: what it serves is unlocked, nothing else is named.
    const u = await c.call(SECRETS, "/org/freedesktop/secrets", SVC, "Unlock", "ao", [["/org/freedesktop/secrets/collection/login", "/real/1"]]);
    expect(u.body).toEqual([["/org/freedesktop/secrets/collection/login"], "/"]);
    b.end();
  });

  test("a hostile client: no fd passing, garbage, a flood and too many connections close only themselves", async () => {
    const b = broker([GIT]);
    const fd = b.client({ auth: "AUTH ANONYMOUS\r\nNEGOTIATE_UNIX_FD", lines: 2 });
    await fd.hello();
    // A header that claims a gigantic message: the connection is dropped.
    const raw = encodeMessage({ type: MessageType.Call, flags: 0, serial: 9, dest: SECRETS, path: "/org/freedesktop/secrets", member: "Ping", signature: "", body: [] });
    fd.send(Buffer.concat([raw.subarray(0, 12), Buffer.from([0xff, 0xff, 0xff, 0x7f])]));
    await Bun.sleep(50);
    expect(fd.closed()).toBe(true);
    const flood = b.client();
    await flood.hello();
    flood.send(Buffer.alloc(BROKER_LIMITS.buffered + 1024, 0x6c));
    await Bun.sleep(50);
    expect(flood.closed()).toBe(true);
    const many = Array.from({ length: BROKER_LIMITS.connections + 2 }, () => b.client());
    await Bun.sleep(50);
    expect(many.filter((m) => m.closed()).length).toBeGreaterThanOrEqual(2);
    // And a well-behaved client still gets its answer afterwards (a fresh broker: the cap above is per run).
    const fresh = broker([GIT]).client();
    expect((await fresh.hello()).type).toBe(MessageType.Return);
    b.end();
  });

  test("a call before Hello and a call with no destination are refused", async () => {
    const b = broker([GIT]);
    const c = b.client();
    const r = await c.call(SECRETS, "/org/freedesktop/secrets", SVC, "SearchItems", "a{ss}", [attrs({})]);
    expect(r.type).toBe(MessageType.Error);
    expect(b.keyring.searches).toEqual([]);
    b.end();
  });

  test("the run's end closes every connection", async () => {
    const b = broker([GIT]);
    const c = b.client();
    await c.hello();
    b.end();
    await b.server.done;
    expect(c.closed()).toBe(true);
  });
});
