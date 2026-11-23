// How a cloud computer joins (spec §9.2, `computers/cloud-join.ts`): the main begins one pairing for the VM and puts its
// QR in the VM's cloud-init; the VM's daemon joins with it. Two real PairingServices over the in-memory wire, a real
// device registry each, the real `CloudComputers` on the main, and a fake provider that plays the cloud.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudComputers, FileCloudStateStore, type CloudAuthority, type CloudCard, type CloudFolder, type CloudProviderHandler } from "../../src/computers/cloud";
import { CloudPairer, joinCloudComputer } from "../../src/computers/cloud-join";
import { cloudInit, readCloudJoinFiles } from "../../src/computers/image";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import { SystemClock } from "../../src/clock/system-clock";
import { FileDeviceRegistry } from "../../src/devices/registry";
import { DeviceKey } from "../../src/identity/device-key";
import { MemoryNetwork } from "../../src/links/memory-wire";
import { PairingService } from "../../src/links/pairing";

const clock = new SystemClock();
let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

async function device(net: MemoryNetwork, name: string, kind: "desktop" | "server" = "desktop") {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "moss-cc-join-")), key, clock, self: { name, os: kind === "server" ? "linux" : "macos", kind } });
  const pairing = new PairingService({ self: key, registry, wire: net.endpoint(key.publicKey), clock, store, selfTarget: () => ({ relay: "https://relay.test/" }), account: () => null });
  cleanup.push(() => pairing.close());
  return { name, key, registry, pairing };
}
type Dev = Awaited<ReturnType<typeof device>>;

const SHA = "c".repeat(64);
const folder: CloudFolder = { folder: "computer-hetzner-1", provider: "hetzner", name: "Cloud1", size: "cx22", region: "fsn1" };

class Cloud implements CloudProviderHandler {
  readonly calls: string[] = [];
  readonly userData: string[] = [];
  async create(a: { userData: string; label: string }) { this.calls.push("create"); this.userData.push(a.userData); return { serverId: "srv-1", address: "203.0.113.1" }; }
  async list(a: { label?: string }) { return this.userData.length ? [{ serverId: "srv-1", label: a.label ?? "computer-hetzner-1", region: "fsn1", state: "running" as const }] : []; }
  async resize() {}
  async delete() {}
  async status() { return { state: "running" as const }; }
  async paired() { this.calls.push("paired"); }
}

/** The authority of a main whose tenure a test can change (the lease's scope appears when the VM founds the group). */
class Authority implements CloudAuthority {
  tenureNow: string | undefined = "-:1";
  canAct() { return this.tenureNow !== undefined; }
  tenure() { return this.tenureNow; }
}

function setup(net: MemoryNetwork, main: Dev, o: { authority?: Authority } = {}) {
  const provider = new Cloud();
  const authority = o.authority ?? new Authority();
  const cards: CloudCard[] = [];
  let cloud!: CloudComputers;
  const pairer = new CloudPairer({ pairing: main.pairing, door: () => cloud.door(() => [folder]) });
  cleanup.push(pairer.start());
  cloud = new CloudComputers({
    clock, store: new FileCloudStateStore(mkdtempSync(join(tmpdir(), "moss-cc-state-"))), provider: () => provider, providerIds: () => ["hetzner"], authority,
    confirm: async (c) => { cards.push(c); return true; },
    userData: async ({ name, token }) => cloudInit({
      name, token, join: await pairer.offer(name, token),
      daemon: { url: "https://example.invalid/moss-core-linux-x64.tar.gz", sha256: SHA }, browser: { url: "https://example.invalid/chrome.zip", sha256: SHA },
    }),
    isPaired: (n) => main.registry.list().some((d) => d.computer === n),
    makeMain: async () => {},
  });
  return { provider, cloud, cards, pairer, authority };
}

/** What the image writes to the VM's `/etc/moss` from the cloud-init: the name, the join ticket and the token. */
function etcMoss(userData: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "moss-cc-etc-")), "moss");
  mkdirSync(dir, { recursive: true });
  for (const [file, path] of [["name", "/etc/moss/name"], ["join", "/etc/moss/join"], ["pairing-token", "/etc/moss/pairing-token"]] as const) {
    const at = userData.indexOf(`path: ${path}\n`);
    const content = /content: ("(?:[^"\\]|\\.)*")/.exec(userData.slice(at))![1]!;
    writeFileSync(join(dir, file), JSON.parse(content) as string);
  }
  return dir;
}

const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };

describe("a cloud computer joins its main computer", () => {
  test("the VM pairs once with its ticket: it is added, the cloud clears its user-data, the person is asked about the main, the ticket is gone", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const vm = await device(net, "Cloud1", "server");
    const { provider, cloud, cards } = setup(net, main);
    expect(await cloud.reconcile([folder])).toMatchObject({ created: ["Cloud1"] });
    const dir = etcMoss(provider.userData[0]!);
    expect(readCloudJoinFiles(dir)).toMatchObject({ name: "Cloud1" });

    await joinCloudComputer({ pairing: vm.pairing, ticket: readCloudJoinFiles(dir)!.join, dir });

    expect(main.registry.list().map((d) => d.computer)).toContain("Cloud1");
    expect(vm.registry.list().map((d) => d.computer)).toContain("Studio");
    await until(() => cloud.get("Cloud1")?.state === "paired");
    expect(cloud.get("Cloud1")).toMatchObject({ state: "paired", device: vm.key.id });
    expect(provider.calls).toContain("paired");
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create", "cloud-make-main"]);
    // The ticket and the token are gone from the VM's disk; its name stays.
    expect(readCloudJoinFiles(dir)).toBeNull();
    expect(existsSync(join(dir, "join")) || existsSync(join(dir, "pairing-token"))).toBe(false);
    expect(existsSync(join(dir, "name"))).toBe(true);
  });

  test("the ticket works once: a second device with it is turned away, and the spent pairing adds nothing", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const vm = await device(net, "Cloud1", "server");
    const copy = await device(net, "Cloud1", "server");
    const { provider, cloud } = setup(net, main);
    await cloud.reconcile([folder]);
    const dir = etcMoss(provider.userData[0]!);
    const ticket = readCloudJoinFiles(dir)!.join;
    await joinCloudComputer({ pairing: vm.pairing, ticket, dir: mkdtempSync(join(tmpdir(), "moss-cc-x-")) });
    await expect(copy.pairing.join(ticket)).rejects.toThrow();
    expect(main.registry.list().filter((d) => d.computer?.startsWith("Cloud1"))).toHaveLength(1);
  });

  test("a device that doesn't call itself the VM's computer is not confirmed by the main, even with the right ticket", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const intruder = await device(net, "Mallory", "server");
    const { provider, cloud } = setup(net, main);
    await cloud.reconcile([folder]);
    const ticket = readCloudJoinFiles(etcMoss(provider.userData[0]!))!.join;
    // The intruder does everything the VM would, confirming its own end too.
    await expect(joinCloudComputer({ pairing: intruder.pairing, ticket, dir: mkdtempSync(join(tmpdir(), "moss-cc-x-")) })).rejects.toThrow();
    expect(main.registry.list().map((d) => d.computer)).not.toContain("Mallory");
    expect(intruder.registry.list().map((d) => d.computer)).not.toContain("Studio");
  });

  test("the person's own pairing is never confirmed by the main for them, whatever the other device calls itself", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const vm = await device(net, "Cloud1", "server");
    setup(net, main);
    const view = await main.pairing.begin();
    await vm.pairing.join(view.qr!);
    await until(() => main.pairing.get(view.pairingId)?.status === "words");
    await new Promise((r) => setTimeout(r, 100));
    expect(main.pairing.get(view.pairingId)?.status).toBe("words");
    expect(main.registry.list().map((d) => d.computer)).not.toContain("Cloud1");
  });

  test("a lone main that founded the group while the VM paired (its tenure changed scope) still finishes the VM's pairing", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const vm = await device(net, "Cloud1", "server");
    const authority = new Authority();
    const { provider, cloud } = setup(net, main, { authority });
    await cloud.reconcile([folder]);
    authority.tenureNow = "group-1:1";
    const dir = etcMoss(provider.userData[0]!);
    await joinCloudComputer({ pairing: vm.pairing, ticket: readCloudJoinFiles(dir)!.join, dir });
    await until(() => cloud.get("Cloud1")?.state === "paired");
    expect(cloud.get("Cloud1")?.state).toBe("paired");
  });
});
