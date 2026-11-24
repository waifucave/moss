// C-M3 item 3: a paired phone speaks the MOSS protocol over its link to the real MOSS server: its hello takes the
// core's token for that device only, it is the user on that device, `remote`'s allow list holds, and the server's own
// core.event sender reaches it, once.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOSS_ERR, MOSS_PROTOCOL_VERSION, ERR, STAGE_FILE_CHUNK_B64_MAX_LENGTH } from "@waifucave/moss-protocol";
import { phoneAppOf } from "../../src/contracts/device-registry";
import { SystemClock } from "../../src/clock/system-clock";
import { MossTokens, ERR_UNAUTHORIZED } from "../../src/auth/moss-tokens";
import { SessionProcesses } from "../../src/auth/moss-caller";
import { createMossServer, laneMethodHandlers } from "../../src/ipc/moss";
import { LINK_CONN_ID_BASE, linkClientServer, mountMossRemoteClients } from "../../src/ipc/link-clients";
import { REMOTE_RPC_LABEL } from "../../src/links/remote-clients";
import { makeLinkCluster } from "../../src/links/testing";
import { MossLinkTransport } from "../../src/links/transport";
import { FileDeviceRegistry } from "../../src/devices/registry";
import { DeviceKey } from "../../src/identity/device-key";
import { generateEd25519 } from "../../src/identity/keys";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

const server = () => {
  const tokens = new MossTokens({ appToken: "a".repeat(43), verifyCli: async () => false });
  const s = createMossServer({ tokens, processes: new SessionProcesses(), serverVersion: "test", deviceId: "d".repeat(32) });
  stops.push(() => s.dispose());
  return { tokens, server: s };
};

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

/** The calls on a bot a phone still cannot make: change its record, remove (archive) or bring it back, read the archive or its plugins' settings, set its user layer (its model, effort, instructions layer). */
const PHONE_STILL_REFUSED_BOT = ["bot.edit", "bot.remove", "bot.restore", "bot.archived", "bot.pluginSettings", "bot.setUserLayer"];

describe("remote clients over links, on the MOSS server", () => {
  test("a phone is the user on that device, under remote's list, and gets its subscribed core events once", async () => {
    const c = await makeLinkCluster(["Studio"], { clock });
    stops.push(() => c.close());
    const studio = c.devices.get("Studio")!;
    const phoneKey = await DeviceKey.fromKey(generateEd25519());
    const phoneReg = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "moss-c-phone-")), key: phoneKey, clock, self: { name: "Phone", kind: "phone" } });
    await studio.registry.add({ id: phoneKey.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phoneKey.publicKeyBase64 }, { via: "terminal" });
    await phoneReg.add({ id: studio.id, name: "Studio", kind: "desktop", runsCore: true, computer: "Studio", publicKey: studio.key.publicKeyBase64 }, { via: "terminal" });
    const phone = new MossLinkTransport({ self: phoneKey.id, wire: c.net.endpoint(phoneKey.publicKey), registry: phoneReg, clock, directory: { target: () => ({ key: studio.key.publicKey }) } });
    stops.push(() => phone.close());

    const { tokens, server: s } = server();
    stops.push(mountMossRemoteClients({ transport: studio.transport, registry: studio.registry, server: s, tokens }));

    const st = (await phone.connect(studio.id)).openStream(REMOTE_RPC_LABEL, "control");
    const got: Record<string, unknown>[] = [];
    st.onData((chunk) => got.push(JSON.parse(new TextDecoder().decode(chunk)) as Record<string, unknown>));
    const send = (m: unknown) => st.write(new TextEncoder().encode(JSON.stringify(m)));
    await send({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: MOSS_PROTOCOL_VERSION, role: "app", token: "a".repeat(43), clientName: "MOSS iOS" } });
    await waitFor(() => got.some((m) => m.id === 1));
    expect(got.find((m) => m.id === 1)!.result).toMatchObject({ ok: true, caller: { kind: "user", client: "ios", device: phoneKey.id } });
    const conn = s.connections().find((x) => x.role === "remote")!;
    expect(conn.connId).toBeGreaterThan(LINK_CONN_ID_BASE);
    await send({ jsonrpc: "2.0", id: 2, method: "pair.quit", params: { handOver: false } });
    await send({ jsonrpc: "2.0", id: 3, method: "events.subscribe", params: { areas: ["approvals"] } });
    await waitFor(() => got.some((m) => m.id === 2) && got.some((m) => m.id === 3));
    expect((got.find((m) => m.id === 2)!.error as { code: number }).code).toBe(MOSS_ERR.ROLE_REFUSED);
    expect(got.find((m) => m.id === 3)!.result).toEqual({ ok: true });
    expect(s.coreEvent({ type: "card_resolved", ts: 1, id: "card_0a1b2c3d", outcome: "denied" })).toBe(1);
    expect(s.coreEvent({ type: "device_removed", ts: 1, id: "x", revoked: true })).toBe(0); // not subscribed
    await waitFor(() => got.some((m) => m.method === "core.event"));
    await Bun.sleep(50);
    expect(got.filter((m) => m.method === "core.event")).toEqual([{ jsonrpc: "2.0", method: "core.event", params: { type: "card_resolved", ts: 1, id: "card_0a1b2c3d", outcome: "denied" } }]);
    st.end();
    await waitFor(() => s.connections().length === 0);
  });

  test("linkHello takes only the core's token for that device and role", async () => {
    const { tokens, server: s } = server();
    const hello = (token: string, role: string, device: string) => ({ protocolVersion: MOSS_PROTOCOL_VERSION, role, device, token, clientName: "x" });
    const phone = "p".repeat(32), other = "q".repeat(32);
    const forOther = tokens.mint({ role: "remote", device: other });
    await expect(s.linkHello(1, hello(forOther, "remote", phone), { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: ERR_UNAUTHORIZED });
    const asWeb = tokens.mint({ role: "web", device: phone });
    await expect(s.linkHello(2, hello(asWeb, "remote", phone), { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: ERR_UNAUTHORIZED });
    await expect(s.linkHello(3, hello(tokens.mint({ role: "remote", device: phone }), "web", phone), { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: MOSS_ERR.ROLE_REFUSED });
    const ok = await s.linkHello(5, hello(tokens.mint({ role: "remote", device: phone }), "remote", phone), { device: phone, role: "remote" }, () => {});
    expect(ok.conn.caller).toEqual({ kind: "user", client: "ios", device: phone });
    await expect(s.linkHello(5, hello(tokens.mint({ role: "remote", device: phone }), "remote", phone), { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: ERR.INVALID_REQUEST });
  });

  test("which phone app a connection is comes from its device's record at pairing, never from the hello", async () => {
    const { tokens, server: s } = server();
    const mossPhone = "m".repeat(32), codePhone = "c".repeat(32), oldPhone = "o".repeat(32);
    const records = new Map<string, { kind: "phone" | "desktop"; app?: "moss" | "code"; revokedAt?: number }>([
      [mossPhone, { kind: "phone", app: "moss" }], [codePhone, { kind: "phone", app: "code" }], [oldPhone, { kind: "phone" }], ["r".repeat(32), { kind: "phone", app: "code", revokedAt: 3 }], ["d".repeat(32), { kind: "desktop" }],
    ]);
    // A phone that says it is the other app, or a surface, in its hello: the surface is refused, and the app field is nothing the engine reads.
    const hello = (device: string, extra: Record<string, unknown> = {}) => ({ protocolVersion: MOSS_PROTOCOL_VERSION, role: "remote", device, clientName: "x", token: tokens.mint({ role: "remote", device }), ...extra });
    const link = (device: string) => ({ device, role: "remote" as const });
    await expect(s.linkHello(21, hello(codePhone, { surface: "moss" }), link(codePhone), () => {})).rejects.toMatchObject({ code: MOSS_ERR.SURFACE_REFUSED });
    await expect(s.linkHello(22, hello(codePhone, { surface: "host" }), link(codePhone), () => {})).rejects.toMatchObject({ code: MOSS_ERR.SURFACE_REFUSED });
    const lying = await s.linkHello(23, hello(codePhone, { app: "moss", phoneApp: "moss", program: "moss" }), link(codePhone), () => {});
    expect(lying.conn.caller).toEqual({ kind: "user", client: "ios", device: codePhone });
    expect("surface" in lying.conn).toBe(false);
    expect("app" in lying.conn || "program" in lying.conn).toBe(false);
    const appOf = (conn: { caller: { kind: string; device?: string } }) => phoneAppOf(conn.caller.device === undefined ? undefined : (records.get(conn.caller.device) as never));
    expect(appOf(lying.conn)).toBe("code");
    expect(appOf((await s.linkHello(24, hello(mossPhone), link(mossPhone), () => {})).conn)).toBe("moss");
    expect(appOf((await s.linkHello(25, hello(oldPhone), link(oldPhone), () => {})).conn)).toBeUndefined();
    // A revoked phone has none, and a desktop never does.
    expect([phoneAppOf(records.get("r".repeat(32)) as never), phoneAppOf(records.get("d".repeat(32)) as never), phoneAppOf(undefined)]).toEqual([undefined, undefined, undefined]);
  });

  test("the door's server: the device from the door's socket, the role from the registry, never the hello", async () => {
    const { tokens, server: s } = server();
    const phone = "p".repeat(32), laptop = "l".repeat(32);
    const devices = new Map<string, { kind: string; revokedAt?: number }>([[phone, { kind: "phone" }], [laptop, { kind: "desktop" }], ["r".repeat(32), { kind: "phone", revokedAt: 1 }]]);
    const door = linkClientServer(s, { get: (id) => devices.get(id) as never });
    const hello = (role: string, device: string) => ({ protocolVersion: MOSS_PROTOCOL_VERSION, role, device, clientName: "x", token: tokens.mint({ role: "remote", device: phone }) });
    await expect(door.hello({ device: phone }, 1, hello("remote", phone), () => {})).rejects.toMatchObject({ code: MOSS_ERR.ROLE_REFUSED }); // no link mark
    await expect(door.hello({ device: laptop, link: true }, 2, hello("remote", laptop), () => {})).rejects.toMatchObject({ code: MOSS_ERR.ROLE_REFUSED }); // a computer
    await expect(door.hello({ device: "r".repeat(32), link: true }, 3, hello("remote", "r".repeat(32)), () => {})).rejects.toMatchObject({ code: MOSS_ERR.ROLE_REFUSED }); // revoked
    await expect(door.hello({ device: phone, link: true }, 4, hello("web", phone), () => {})).rejects.toMatchObject({ code: MOSS_ERR.ROLE_REFUSED }); // the hello's role isn't the registry's
    expect((await door.hello({ device: phone, link: true }, 5, hello("remote", phone), () => {})).conn.role).toBe("remote");
    // A refusal before linkHello still spends the token the door minted for that hello.
    const spent: string[] = [];
    const spending = linkClientServer(s, { get: (id) => devices.get(id) as never }, (t) => { spent.push(t); tokens.revoke(t); });
    const h = hello("remote", laptop);
    await expect(spending.hello({ device: laptop, link: true }, 6, h, () => {})).rejects.toMatchObject({ code: MOSS_ERR.ROLE_REFUSED });
    expect(spent).toEqual([h.token]);
  });

  test("a phone's connection is labelled by the OS its record has: android for an Android phone, ios for the rest; the hello can't change it", async () => {
    const os = new Map<string, string>([["a".repeat(32), "android"], ["i".repeat(32), "ios"]]);
    const tokens = new MossTokens({ appToken: "a".repeat(43), verifyCli: async () => false });
    const s = createMossServer({ tokens, processes: new SessionProcesses(), serverVersion: "test", deviceId: "d".repeat(32), deviceOs: (d) => os.get(d) });
    stops.push(() => s.dispose());
    const hello = (device: string, extra: Record<string, unknown> = {}) => ({ protocolVersion: MOSS_PROTOCOL_VERSION, role: "remote", device, clientName: "iPhone", token: tokens.mint({ role: "remote", device }), ...extra });
    const link = (device: string) => ({ device, role: "remote" as const });
    const clients: [string, string][] = [];
    let n = 40;
    for (const [name, device, extra] of [["android record", "a".repeat(32), { clientName: "iPhone", client: "ios" }], ["ios record", "i".repeat(32), { client: "android", os: "android" }], ["no record", "n".repeat(32), {}]] as const) {
      const r = await s.linkHello(n++, hello(device, extra), link(device), () => {});
      clients.push([name, (r.conn.caller as { client: string }).client]);
    }
    expect(clients).toEqual([["android record", "android"], ["ios record", "ios"], ["no record", "ios"]]);
  });

  test("a phone's link connection may call agent.start, as the person's own call from its device, and nothing that creates, pairs or installs", async () => {
    const tokens = new MossTokens({ appToken: "a".repeat(43), verifyCli: async () => false });
    const calls: { method: string; caller: unknown; params: unknown }[] = [];
    const record = (method: string) => async (params: unknown, ctx: { caller: unknown }) => { calls.push({ method, caller: ctx.caller, params }); return { session: "s_x" }; };
    const s = createMossServer({
      tokens, processes: new SessionProcesses(), serverVersion: "test", deviceId: "d".repeat(32),
      deviceOs: (d) => (d === "a".repeat(32) ? "android" : "ios"),
      handlers: laneMethodHandlers({ "agent.start": record("agent.start"), "agent.backends": record("agent.backends"), "agent.options": record("agent.options"), "agent.recent": record("agent.recent"), "bot.create": record("bot.create"), "session.stageFile": record("session.stageFile"), "session.stagePicture": record("session.stagePicture"), "session.composerOffers": record("session.composerOffers"), "agent.definitions": record("agent.definitions"), "plugin.install": record("plugin.install"), ...Object.fromEntries(PHONE_STILL_REFUSED_BOT.map((m) => [m, record(m)])) }),
    });
    stops.push(() => s.dispose());
    const open = async (device: string, id: number) => {
      const hello = { protocolVersion: MOSS_PROTOCOL_VERSION, role: "remote", device, clientName: "x", token: tokens.mint({ role: "remote", device }) };
      return (await s.linkHello(id, hello, { device, role: "remote" }, () => {})).conn;
    };
    const ios = await open("i".repeat(32), 60);
    const android = await open("a".repeat(32), 61);
    const start = { backend: "moss-code", computer: "Studio", root: "home/Studio/new", prompt: "go" };
    await expect(s.handle(ios, "agent.start", start)).resolves.toEqual({ session: "s_x" });
    await expect(s.handle(android, "agent.start", start)).resolves.toEqual({ session: "s_x" });
    expect(calls.map((c) => c.caller)).toEqual([{ kind: "user", client: "ios", device: "i".repeat(32) }, { kind: "user", client: "android", device: "a".repeat(32) }]);
    // The sheet's three reads are the phone's too.
    for (const method of ["agent.backends", "agent.options", "agent.recent"]) await expect(s.handle(ios, method, method === "agent.options" ? { backend: "moss-code" } : {})).resolves.toEqual({ session: "s_x" });
    // A phone may make a bot (PH3), as the person's own call from its device, and do nothing else to one.
    await expect(s.handle(ios, "bot.create", { name: "Nova" })).resolves.toEqual({ session: "s_x" });
    expect(calls.at(-1)).toMatchObject({ method: "bot.create", caller: { kind: "user", client: "ios", device: "i".repeat(32) } });
    // A phone's file (in chunks, then dropped) and the composer's offers are its calls too, as the person's own from its device.
    await expect(s.handle(ios, "session.stageFile", { id: "s_x", name: "a.txt", size: 2, dataBase64: "aGk=" })).resolves.toEqual({ session: "s_x" });
    await expect(s.handle(ios, "session.stageFile", { id: "s_x", upload: "u1", offset: 2, dataBase64: "aGk=" })).resolves.toEqual({ session: "s_x" });
    await expect(s.handle(ios, "session.stageFile", { id: "s_x", upload: "u1", cancel: true })).resolves.toEqual({ session: "s_x" });
    // A picture, in chunks, is the same (a phone's link cannot carry the desktop's single request for a photo).
    await expect(s.handle(ios, "session.stagePicture", { id: "s_x", mediaType: "image/jpeg", size: 4 * 1024 * 1024, dataBase64: "aGk=" })).resolves.toEqual({ session: "s_x" });
    await expect(s.handle(ios, "session.stagePicture", { id: "s_x", upload: "u1", offset: 2, dataBase64: "aGk=" })).resolves.toEqual({ session: "s_x" });
    await expect(s.handle(ios, "session.stagePicture", { id: "s_x", upload: "u1", cancel: true })).resolves.toEqual({ session: "s_x" });
    await expect(s.handle(ios, "session.composerOffers", { id: "s_x" })).resolves.toEqual({ session: "s_x" });
    expect(calls.slice(-7).map((c) => c.caller)).toEqual(Array(7).fill({ kind: "user", client: "ios", device: "i".repeat(32) }));
    // A chunk past the frame, a stray field and an upload with neither a size nor an offset are refused before a handler runs.
    for (const params of [{ id: "s_x", name: "a.txt", size: 2, dataBase64: "A".repeat(STAGE_FILE_CHUNK_B64_MAX_LENGTH + 4) }, { id: "s_x", name: "a.txt", size: 2, dataBase64: "aGk=", path: "/etc/x" }, { id: "s_x", upload: "u1", dataBase64: "aGk=" }]) {
      await expect(s.handle(ios, "session.stageFile", params)).rejects.toMatchObject({ code: ERR.INVALID_PARAMS });
    }
    for (const params of [{ id: "s_x", mediaType: "image/jpeg", size: 2, dataBase64: "A".repeat(STAGE_FILE_CHUNK_B64_MAX_LENGTH + 4) }, { id: "s_x", mediaType: "image/jpeg", size: 2, dataBase64: "aGk=", path: "/etc/x" }, { id: "s_x", mediaType: "text/html", size: 2, dataBase64: "aGk=" }, { id: "s_x", mediaType: "image/jpeg", size: 400 * 1024 * 1024, dataBase64: "aGk=" }, { id: "s_x", dataBase64: "aGk=" }]) {
      await expect(s.handle(ios, "session.stagePicture", params)).rejects.toMatchObject({ code: ERR.INVALID_PARAMS });
    }
    // What a phone could not do before it still cannot: the role's list does not name these.
    for (const method of ["agent.definitions", "plugin.install", ...PHONE_STILL_REFUSED_BOT]) {
      await expect(s.handle(ios, method, {})).rejects.toMatchObject({ code: MOSS_ERR.ROLE_REFUSED });
    }
    expect(calls).toHaveLength(13);
  });

  test("each minted token is spent by its hello, and the server closes a link connection itself", async () => {
    const { tokens, server: s } = server();
    const phone = "p".repeat(32);
    const size = () => (tokens as unknown as { minted: Map<string, unknown> }).minted.size;
    let ended = 0;
    for (let i = 0; i < 5; i++) {
      const token = tokens.mint({ role: "remote", device: phone });
      const p = { protocolVersion: MOSS_PROTOCOL_VERSION, role: "remote", device: phone, token, clientName: "x" };
      await s.linkHello(10 + i, p, { device: phone, role: "remote" }, () => {}, () => { ended++; });
      await expect(s.linkHello(100 + i, p, { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: ERR_UNAUTHORIZED }); // spent
    }
    // A refused hello spends its token too.
    await expect(s.linkHello(200, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "web", device: phone, token: tokens.mint({ role: "remote", device: phone }), clientName: "x" }, { device: phone, role: "remote" }, () => {})).rejects.toBeDefined();
    expect(size()).toBe(0);
    expect(s.endConnections((c) => c.caller.kind === "user" && c.caller.device === phone)).toBe(5);
    expect(ended).toBe(5);
  });

  test("a hello that doesn't parse still spends its token; a device revoked during the hello isn't registered", async () => {
    const { tokens, server: s } = server();
    const phone = "p".repeat(32);
    const size = () => (tokens as unknown as { minted: Map<string, unknown> }).minted.size;
    const token = tokens.mint({ role: "remote", device: phone });
    await expect(s.linkHello(1, { role: "remote", device: phone, token }, { device: phone, role: "remote" }, () => {})).rejects.toMatchObject({ code: ERR.INVALID_PARAMS });
    expect(size()).toBe(0);
    // Revoked while its token was checked: the door's registry says so by the time it would be registered.
    const devices = new Map<string, { kind: string; revokedAt?: number }>([[phone, { kind: "phone" }]]);
    const realVerify = tokens.verify.bind(tokens);
    tokens.verify = async (h) => { const b = await realVerify(h); devices.set(phone, { kind: "phone", revokedAt: 1 }); return b; };
    const door = linkClientServer(s, { get: (id) => devices.get(id) as never });
    const hello = { protocolVersion: MOSS_PROTOCOL_VERSION, role: "remote", device: phone, clientName: "x", token: tokens.mint({ role: "remote", device: phone }) };
    await expect(door.hello({ device: phone, link: true }, 2, hello, () => {})).rejects.toMatchObject({ code: MOSS_ERR.ROLE_REFUSED });
    expect(s.connections()).toEqual([]);
    expect(size()).toBe(0);
  });

  test("revoking a device drops the tokens still minted for it and closes its connections", async () => {
    const { tokens, server: s } = server();
    const phone = "p".repeat(32), other = "o".repeat(32);
    let fire!: (c: { type: "revoked"; id: string }) => void;
    const off = mountMossRemoteClients({
      transport: { onStream: () => () => {} }, server: s, tokens,
      registry: { get: () => undefined, watch: (fn) => { fire = fn as never; return () => {}; } },
    });
    stops.push(off);
    const size = () => (tokens as unknown as { minted: Map<string, unknown> }).minted.size;
    tokens.mint({ role: "remote", device: phone });
    tokens.mint({ role: "web", device: phone });
    tokens.mint({ role: "remote", device: other });
    let ended = false;
    await s.linkHello(1, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "remote", device: phone, token: tokens.mint({ role: "remote", device: phone }), clientName: "x" }, { device: phone, role: "remote" }, () => {}, () => { ended = true; });
    expect(size()).toBe(3);
    fire({ type: "revoked", id: phone });
    expect(size()).toBe(1);
    expect(ended).toBe(true);
  });
});
