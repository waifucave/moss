// Lane XC, the computers unit's row 155 (the tip red on 1d57b30a0): a restarted computer whose peer's hello came in
// before it listened (a notify with no listener is dropped) never learned where the peer's tree is, so every tree call
// there said "offline" for good. Its own hello now asks for the peer's back while it holds nothing of the peer's
// (`reply: true`); the peer answers once, without the bit; an older engine takes the field as nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerHello, ComputerPeers } from "../../src/computers/peers";
import { CoreComputerRegistry } from "../../src/computers/registry";
import { FakeDeviceRegistry } from "../../src/contracts/fakes/device-registry";
import { FakeLinkNetwork } from "../../src/contracts/fakes/link-transport";
import { ContractError } from "../../src/contracts/common";
import { TreeRouter } from "../../src/tree/route";
import type { TreeDirectory } from "../../src/tree/tree";
import { hostOs } from "../../src/tree/names";
import { ClusterDevices } from "../tree/cluster-support";

const clock = { now: () => Date.now() };
const offs: (() => void)[] = [];
afterEach(() => { for (const off of offs.splice(0)) off(); });

async function pairOf() {
  const net = new FakeLinkNetwork();
  const a = await FakeDeviceRegistry.create({ clock, name: "Alpha", computer: "Alpha", os: hostOs() });
  const b = await FakeDeviceRegistry.create({ clock, name: "Beta", computer: "Beta", os: hostOs() });
  const aDevices = new ClusterDevices(a.registry);
  const bDevices = new ClusterDevices(b.registry);
  await aDevices.add({ id: b.device.id, name: "Beta", kind: "desktop", runsCore: true, computer: "Beta", publicKey: b.device.publicKey }, { via: "terminal" });
  await bDevices.add({ id: a.device.id, name: "Alpha", kind: "desktop", runsCore: true, computer: "Alpha", publicKey: a.device.publicKey }, { via: "terminal" });
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "xc-hello-")));
  // Both links' ends exist from the start (the transport is up before the computer node, as in the daemon).
  net.endpoint(a.device.id);
  net.endpoint(b.device.id);
  /** One computer's peers, as its computer node makes them; `sent` counts the hellos it sends to the other. */
  const peersOf = (name: "Alpha" | "Beta") => {
    const me = name === "Alpha" ? a : b;
    const transport = net.endpoint(me.device.id);
    const registry = new CoreComputerRegistry({ clock, self: { name, device: me.device.id, os: hostOs(), hasDisplay: true, agents: [] } });
    const peers = new ComputerPeers({ registry, transport, roots: () => ({ home: join(root, name), os: hostOs() }), devices: name === "Alpha" ? aDevices : bDevices });
    offs.push(() => peers.close());
    return peers;
  };
  return { net, a: a.device.id, b: b.device.id, peersOf, root };
}

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

describe("a computer whose link is up but whose home isn't known yet is not called offline", () => {
  test("the route says it hasn't said where its home is yet; a computer whose link is down is offline", () => {
    const at = (online: boolean) => new TreeRouter({
      directory: { self: () => "Alpha", get: (n: string) => (n === "Beta" ? { name: "Beta", aliases: [], online, level: "ask-risky" } : { name: "Alpha", aliases: [], online: true, level: "ask-risky", home: "/a", os: hostOs() }) } as TreeDirectory,
      resolve: () => { throw new ContractError("computer_offline", "Beta hasn't said where its home folder is yet", { computer: "Beta" }); },
      names: () => ["Alpha", "Beta"],
    }, { kind: "session", sessionId: "s_luna", sessionKind: "bot", bot: "luna" });
    expect(at(true).route("Write", { file_path: "home/Beta/x.md", content: "x" })).toEqual({ kind: "refused", reason: "Beta hasn't said where its home is yet; try again in a moment" });
    expect(at(false).route("Write", { file_path: "home/Beta/x.md", content: "x" })).toMatchObject({ kind: "other", computer: "Beta", online: false });
  });
});

describe("a hello asks for the peer's back while nothing of the peer's is held (row 155)", () => {
  test("Beta's hello lost before Alpha listened: Alpha's own hello asks, Beta answers once, Alpha learns Beta's home", async () => {
    const { net, a, b, peersOf, root } = await pairOf();
    const beta = peersOf("Beta");
    // The link comes up before Alpha's peers listen (Alpha's computer node starts after its links part): Beta's
    // hello on the link coming up reaches no one on Alpha.
    await net.endpoint(b).connect(a);
    await Bun.sleep(20);
    const alpha = peersOf("Alpha");
    await until(() => alpha.directory().get("Beta")?.home !== undefined);
    expect(alpha.directory().get("Beta")?.home).toBe(join(root, "Beta"));
    expect(beta.roots(a)?.home).toBe(join(root, "Alpha"));
  });

  test("a peer's asking hellos get one answer per link-up and per few seconds, never a loop", async () => {
    const { net, a, b, peersOf } = await pairOf();
    const beta = peersOf("Beta");
    await net.endpoint(b).connect(a);
    const got: unknown[] = [];
    offs.push(net.endpoint(a).onNotify("computer.hello", (p) => got.push(p)));
    await Bun.sleep(20);
    got.length = 0;
    const link = await net.endpoint(a).connect(b);
    const asking = { name: "Alpha", os: hostOs(), hasDisplay: true, agents: [], level: "ask-risky", tree: { home: "/x/Alpha", os: hostOs() }, reply: true };
    for (let i = 0; i < 5; i++) link.notify("computer.hello", asking);
    await Bun.sleep(50);
    // One answer for the five, and it asks for nothing in turn.
    expect(got.length).toBe(1);
    expect((got[0] as { reply?: unknown }).reply).toBeUndefined();
    expect(beta.roots(a)?.home).toBe("/x/Alpha");
  });

  test("an older engine takes a hello with the field as before, and a hello without it gets no answer", async () => {
    // An older engine's schema has no `reply`: the field is dropped, the hello parses.
    const Older = ComputerHello.omit({ reply: true });
    const parsed = Older.safeParse({ name: "Alpha", os: hostOs(), hasDisplay: true, agents: [], level: "ask", tree: { home: "/x", os: hostOs() }, reply: true });
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>).reply).toBeUndefined();
    // A hello without it (an older engine's, or one sent while the sender holds the receiver's roots) gets none.
    const { net, a, b, peersOf } = await pairOf();
    peersOf("Beta");
    await net.endpoint(b).connect(a);
    const got: unknown[] = [];
    offs.push(net.endpoint(a).onNotify("computer.hello", (p) => got.push(p)));
    await Bun.sleep(20);
    got.length = 0;
    (await net.endpoint(a).connect(b)).notify("computer.hello", { name: "Alpha", os: hostOs(), hasDisplay: true, agents: [], level: "ask", tree: { home: "/x", os: hostOs() } });
    await Bun.sleep(50);
    expect(got).toEqual([]);
  });
});
