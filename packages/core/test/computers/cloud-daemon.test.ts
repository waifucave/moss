// Cloud computers as the daemon starts them (`startDaemonParts`, spec §9.2): the plugin registry's folder and provider
// plugin run on the lone computer's own lease, the person's card goes through the daemon's approval broker (a stand-in
// here that answers it), the VM is made on the stand-in cloud with a join ticket in its cloud-init, and a card the
// broker never answered makes nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../src/clock/system-clock";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import { startDaemonParts } from "../../src/daemon-parts";
import { startDaemonLinks } from "../../src/ipc/device-links";
import { MemoryNetwork } from "../../src/links/memory-wire";
import { MossSecretStore, KeychainValues, memoryVault } from "../../src/secrets/moss-secret-store";
import { catalogPointDecl } from "../../../plugin-sdk/src/catalogs/index";
import { FakePluginRegistry } from "../../src/contracts/fakes/plugin-registry";
import { Drivers } from "../../src/bots/tests/fixtures";
import { cloudRig } from "./cloud-rig";

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const clock = new SystemClock();
const SHA = "d".repeat(64);
const downloads = () => ({ daemon: { url: "https://example.invalid/moss-core-linux-x64.tar.gz", sha256: SHA }, browser: { url: "https://example.invalid/chrome.zip", sha256: SHA } });

let stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function start(answer: (r: ApprovalRequest) => { allowed: boolean; by: string } | Promise<never>, withDownloads = true) {
  const rig = await cloudRig("hetzner");
  const home = temp("cloud-daemon-home-");
  const store = new MossSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
  const net = new MemoryNetwork();
  const d = await startDaemonLinks({
    home, store, clock, self: { name: "Studio", os: "macos" }, handlers: {}, binary: null, wire: (k) => net.endpoint(k.publicKey),
    handshake: null, publicTime: null, mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, dispatch: async () => null,
  });
  const fakes = new Drivers();
  const asked: ApprovalRequest[] = [];
  const parts = await startDaemonParts({
    mossHome: home, userHome: temp("cloud-daemon-user-"), clock, links: d.links, handlers: {},
    bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => fakes.factory, defaultModel: () => ({ model: "moss-test/calls" }) },
    approvals: { request: async (r: ApprovalRequest) => { asked.push(r); return (await answer(r)) as never; }, get: () => undefined },
    cloud: { plugins: rig.registry, host: rig.host, ...(withDownloads ? { downloads } : {}) },
  });
  stops.push(async () => { await parts.close(); await d.close(); });
  return { rig, parts, asked };
}

const until = async (ok: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); };

describe("cloud computers in the daemon's parts", () => {
  test("the folder in the registry makes a VM after the person's card is approved, with a join ticket in its cloud-init", async () => {
    const { rig, parts, asked } = await start(() => ({ allowed: true, by: "card" }));
    await until(() => rig.cloud.billed() === 1);
    expect(rig.cloud.billed()).toBe(1);
    expect(asked.map((r) => (r as { change?: string }).change)).toEqual(["computer-create"]);
    expect(parts.node!.cloud).toBeDefined();
    const vm = [...Array(1)].map(() => rig.cloud.userData("101"))[0]!;
    expect(vm).toContain("clover-pair:1:");
    expect(vm).toContain("/etc/moss/join");
  }, 30_000);

  test("a card the broker never answered makes nothing, and the same ask comes back on the next pass", async () => {
    const { rig, parts, asked } = await start(() => ({ allowed: false, by: "timeout" }));
    await until(() => asked.length >= 1);
    await parts.node!.cloud!.sync();
    expect(rig.cloud.billed()).toBe(0);
    expect(asked.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("with no Linux build of the engine pinned (this build), nothing is made and nothing is asked twice in vain", async () => {
    const { rig, parts, asked } = await start(() => ({ allowed: true, by: "card" }), false);
    await until(() => false, 500);
    const r = await parts.node!.cloud!.sync();
    expect(rig.cloud.billed()).toBe(0);
    expect(asked).toEqual([]);
    expect(r.failed[0]!.reason).toContain("no Linux build of its engine");
  }, 30_000);
});
