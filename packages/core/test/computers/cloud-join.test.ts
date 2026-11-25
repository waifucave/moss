// How a cloud computer joins (spec §9.2, `computers/cloud-join.ts`): the main begins one pairing for the VM and puts its
// QR in the VM's cloud-init; the VM's daemon joins with it. Two real PairingServices over the in-memory wire, a real
// device registry each, the real `CloudComputers` on the main, and a fake provider that plays the cloud.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudComputers, FileCloudStateStore, type CloudAuthority, type CloudCard, type CloudFolder, type CloudProviderHandler } from "../../src/computers/cloud";
import { automaticMain } from "../../src/lease/main-choice";
import { answerKeyOf, mayAnswerCards } from "../../src/contracts/device-registry";
import { cloudCardRequest } from "../../src/approvals/cloud-cards";
import { CUSTOM_IMAGE_USER_DATA } from "../../src/computers/cloud";
import { CloudPairer, joinCloudComputer, joinCloudComputerUntilPaired } from "../../src/computers/cloud-join";
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

async function device(net: MemoryNetwork, name: string, kind: "desktop" | "server" | "cloud" = "desktop") {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "moss-cc-join-")), key, clock, self: { name, os: kind === "desktop" ? "macos" : "linux", kind } });
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
  failNextCreate = false;
  /** The machine disappeared from the cloud (deleted by hand). */
  vanished = false;
  async create(a: { userData: string; label: string }) {
    if (this.failNextCreate) { this.failNextCreate = false; throw new Error("the cloud refused the create"); }
    this.calls.push("create"); this.userData.push(a.userData); return { serverId: "srv-1", address: "203.0.113.1" };
  }
  async list(a: { label?: string }) { return this.userData.length && !this.vanished ? [{ serverId: "srv-1", label: a.label ?? "computer-hetzner-1", region: "fsn1", state: "running" as const }] : []; }
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

function setup(net: MemoryNetwork, main: Dev, o: { authority?: Authority; folderOf?: CloudFolder } = {}) {
  const provider = new Cloud();
  const authority = o.authority ?? new Authority();
  const cards: CloudCard[] = [];
  let cloud!: CloudComputers;
  const pairer = new CloudPairer({ pairing: main.pairing, door: () => cloud.door(() => [o.folderOf ?? folder]) });
  cleanup.push(pairer.start());
  cloud = new CloudComputers({
    clock, store: new FileCloudStateStore(mkdtempSync(join(tmpdir(), "moss-cc-state-"))), provider: () => provider, providerIds: () => ["hetzner"], authority,
    confirm: async (c) => { cards.push(c); return true; },
    userData: async ({ name, token }) => cloudInit({
      name, join: await pairer.offer(name, token),
      daemon: { url: "https://example.invalid/moss-core-linux-x64.tar.gz", sha256: SHA }, browser: { url: "https://example.invalid/chrome.zip", sha256: SHA },
    }),
    dropTicket: (n) => pairer.drop(n),
    isPaired: (n) => main.registry.list().some((d) => d.computer === n),
    // No makeMain, as in the daemon: nothing in the lease can make another computer the main yet (NOT BUILT, spec §6.4
    // [D]), so the make-main card is never asked in production and this test says so.
  });
  return { provider, cloud, cards, pairer, authority };
}

/** What the image writes to the VM's `/etc/moss` from the cloud-init: the name and the join ticket. */
function etcMoss(userData: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "moss-cc-etc-")), "moss");
  mkdirSync(dir, { recursive: true });
  for (const [file, path] of [["name", "/etc/moss/name"], ["join", "/etc/moss/join"]] as const) {
    const at = userData.indexOf(`path: ${path}\n`);
    const content = /content: ("(?:[^"\\]|\\.)*")/.exec(userData.slice(at))![1]!;
    writeFileSync(join(dir, file), JSON.parse(content) as string);
  }
  return dir;
}

const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };

describe("a cloud computer joins its main computer", () => {
  test("the VM pairs once with its ticket: it is added, the cloud clears its user-data, the device record says it was a cloud join, the ticket is gone", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const vm = await device(net, "Cloud1", "cloud");
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
    // What production asks: the create card only. The make-main question isn't built (no lease call makes another computer
    // the main), so it isn't claimed here; `cloud.test.ts` covers the door's card with an injected `makeMain`.
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    expect(main.registry.list().find((d) => d.computer === "Cloud1")?.addedBy).toBe("cloud");
    // The ticket and the token are gone from the VM's disk; its name stays.
    expect(readCloudJoinFiles(dir)).toBeNull();
    expect(existsSync(join(dir, "join"))).toBe(false);
    expect(existsSync(join(dir, "name"))).toBe(true);
    // Pairing alone never makes the VM the main computer: that is the person's answer to the make-main card (§9.2), and
    // the automatic choice never picks a cloud computer.
    expect(automaticMain(main.registry.list())).toBe(main.key.id);
    expect(main.registry.list().find((d) => d.computer === "Cloud1")?.kind).toBe("cloud");
  });

  test("a main that is away when the VM first tries is tried again with a back-off, and the VM pairs when it is back", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const vm = await device(net, "Cloud1", "cloud");
    const { provider, cloud } = setup(net, main);
    await cloud.reconcile([folder]);
    const dir = etcMoss(provider.userData[0]!);
    let tries = 0;
    const waits: number[] = [];
    // The first two attempts find nobody home.
    const flaky = {
      get: vm.pairing.get.bind(vm.pairing), watch: vm.pairing.watch.bind(vm.pairing), confirm: vm.pairing.confirm.bind(vm.pairing),
      join: async (t: string) => { if (++tries <= 2) throw new Error("the other device can't be reached"); return vm.pairing.join(t); },
    };
    await joinCloudComputerUntilPaired({ pairing: flaky, ticket: readCloudJoinFiles(dir)!.join, dir, sleep: async (ms) => { waits.push(ms); }, firstWaitMs: 5_000 });
    expect(tries).toBe(3);
    expect(waits).toEqual([5_000, 10_000]);
    await until(() => cloud.get("Cloud1")?.state === "paired");
    expect(cloud.get("Cloud1")?.state).toBe("paired");
  });

  test("the VM stops trying once its ticket is spent or its hour is over", async () => {
    const net = new MemoryNetwork();
    const vm = await device(net, "Cloud1", "cloud");
    const never = { get: vm.pairing.get.bind(vm.pairing), watch: vm.pairing.watch.bind(vm.pairing), confirm: vm.pairing.confirm.bind(vm.pairing), join: async () => { throw new Error("the pairing has expired"); } };
    await expect(joinCloudComputerUntilPaired({ pairing: never, ticket: "x", sleep: async () => {} })).rejects.toThrow("expired");
    let t = 0;
    const down = { ...never, join: async () => { throw new Error("the other device can't be reached"); } };
    await expect(joinCloudComputerUntilPaired({ pairing: down, ticket: "x", sleep: async (ms) => { t += ms; }, now: () => t, giveUpAfterMs: 60_000 })).rejects.toThrow("can't be reached");
    expect(t).toBeLessThanOrEqual(60_000);
  });

  test("the ticket works once: a second device with it is turned away, and the spent pairing adds nothing", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const vm = await device(net, "Cloud1", "cloud");
    const copy = await device(net, "Cloud1", "cloud");
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
    const intruder = await device(net, "Mallory", "cloud");
    const { provider, cloud } = setup(net, main);
    await cloud.reconcile([folder]);
    const ticket = readCloudJoinFiles(etcMoss(provider.userData[0]!))!.join;
    // The intruder does everything the VM would, confirming its own end too.
    await expect(joinCloudComputer({ pairing: intruder.pairing, ticket, dir: mkdtempSync(join(tmpdir(), "moss-cc-x-")) })).rejects.toThrow();
    expect(main.registry.list().map((d) => d.computer)).not.toContain("Mallory");
    expect(intruder.registry.list().map((d) => d.computer)).not.toContain("Studio");
  });

  test("a device that names itself right but isn't a cloud computer that runs the core is not confirmed, with the right ticket", async () => {
    for (const kind of ["server", "desktop"] as const) {
      const net = new MemoryNetwork();
      const main = await device(net, "Studio");
      const mallory = await device(net, "Cloud1", kind);
      const { provider, cloud } = setup(net, main);
      await cloud.reconcile([folder]);
      const ticket = readCloudJoinFiles(etcMoss(provider.userData[0]!))!.join;
      await expect(joinCloudComputer({ pairing: mallory.pairing, ticket, dir: mkdtempSync(join(tmpdir(), "moss-cc-x-")) })).rejects.toThrow();
      expect(main.registry.list().map((d) => d.computer)).not.toContain("Cloud1");
    }
  });

  test("a bot-written folder naming another image: the card shows the image and says nothing pairs by itself; after a yes nothing is confirmed", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const { provider, cloud, cards, pairer } = setup(net, main);
    const foreign: CloudFolder = { ...folder, image: "projects/someone-else/global/images/free-vm" };
    expect(await cloud.reconcile([foreign])).toMatchObject({ created: ["Cloud1"] });
    expect(cards).toEqual([expect.objectContaining({ kind: "cloud-create", image: "projects/someone-else/global/images/free-vm" })]);
    // The card as the person reads it: the image in words they can judge, and that MOSS won't pair it.
    const text = JSON.stringify(cloudCardRequest(cards[0] as never).fields);
    expect(text).toContain("a custom image: projects/someone-else/global/images/free-vm");
    expect(text).toContain("will not pair it by itself");
    // No ticket went into the VM, no pairing was begun, no token is waiting: nothing for the main to confirm.
    expect(provider.userData[0]).toBe(CUSTOM_IMAGE_USER_DATA);
    expect(pairer.waiting).toBe(0);
    expect(cloud.pairing.waiting("Cloud1", "-:1")).toBe(false);
    // The person's own pairing of it later is theirs: the main never confirms it for them, and no repair is asked.
    expect(await cloud.reconcile([foreign])).toMatchObject({ repaired: [], declined: [], failed: [] });
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    // MOSS's own image says so too.
    expect(JSON.stringify(cloudCardRequest({ kind: "cloud-create", name: "Cloud1", provider: "hetzner", size: "cx22", region: "fsn1", folder: "f" }).fields)).toContain("MOSS's own image");
  });

  test("a create that fails leaves no pending pairing; a retry replaces, never adds; a lost lease cancels", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const { provider, cloud, pairer } = setup(net, main);
    provider.failNextCreate = true;
    expect((await cloud.reconcile([folder])).failed).toHaveLength(1);
    expect(pairer.waiting).toBe(0);
    expect(main.pairing.list().filter((p) => p.status === "waiting")).toEqual([]);
    expect(await cloud.reconcile([folder])).toMatchObject({ created: ["Cloud1"] });
    expect(pairer.waiting).toBe(1);
    // Offered again for the same VM (a repair): the first pairing is cancelled, one stays.
    await pairer.offer("Cloud1", "t".repeat(43));
    expect(pairer.waiting).toBe(1);
    expect(main.pairing.list().filter((p) => p.status === "waiting")).toHaveLength(1);
    pairer.cancelAll();
    expect(pairer.waiting).toBe(0);
    await until(() => main.pairing.list().every((p) => p.status !== "waiting"));
    expect(main.pairing.list().filter((p) => p.status === "waiting")).toEqual([]);
  });

  test("an own-image machine that disappears from the cloud takes its pairing and token with it, not an hour later", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const { provider, cloud, pairer } = setup(net, main);
    await cloud.reconcile([folder]);
    expect(pairer.waiting).toBe(1);
    provider.vanished = true;
    await cloud.reconcile([]);
    expect(cloud.get("Cloud1")).toBeUndefined();
    expect(pairer.waiting).toBe(0);
    expect(cloud.pairing.waiting("Cloud1", "-:1")).toBe(false);
    await until(() => main.pairing.list().every((p) => p.status !== "waiting"));
  });

  test("a cloud computer can never answer a card, even if its record later carried an answer key", () => {
    const rec = { kind: "cloud" as const, publicKey: "k", revokedAt: undefined, answerKey: { publicKey: "ak", held: "keychain" as const } };
    expect(answerKeyOf(rec)).toBeUndefined();
    expect(mayAnswerCards(rec)).toBe(false);
    expect(answerKeyOf({ ...rec, kind: "desktop" as const })).toBe("ak");
  });

  test("the person's own pairing is never confirmed by the main for them, whatever the other device calls itself", async () => {
    const net = new MemoryNetwork();
    const main = await device(net, "Studio");
    const vm = await device(net, "Cloud1", "cloud");
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
    const vm = await device(net, "Cloud1", "cloud");
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
