// Cloud computers end to end on a stand-in cloud (spec §9.2): the person's folder in a registry → the core's reconcile
// (`CloudPoint`) → the person's card → the provider plugin's real host code → the daemon's real keyed fetch → the
// stand-in's API. Per provider. No VM, no account, no network, and no setting or environment variable of a shipped build
// is involved: the stand-in is the keyed fetch's platform fetch, given by the test alone.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudComputers, FileCloudStateStore, type CloudAnswer, type CloudAuthority, type CloudCard } from "../../src/computers/cloud";
import { isContractError } from "../../src/contracts/common";
import { askBeforeProviderGoes, CloudPoint, pluginProviders, providerIds } from "../../src/computers/cloud-point";
import { authEntriesOf } from "../../src/runtime-sdk/plugin-auth";
import { authEntriesOf as keyedEntriesOf } from "../../src/runtime-sdk/model-plugins/plugin-api";
import { declaredPointFor } from "../../src/plugin-host/api/points";
import { cloudRig, RIG_TOKEN, type Rig, type RigKind } from "./cloud-rig";
import { testUserData } from "./cloud-support";

const authority: CloudAuthority = { canAct: () => true, tenure: () => "group-1:1" };

async function boot(kind: RigKind, o: { answers?: (c: CloudCard) => CloudAnswer; signedIn?: boolean } = {}) {
  const rig = await cloudRig(kind, o.signedIn === undefined ? {} : { signedIn: o.signedIn });
  const home = mkdtempSync(join(tmpdir(), "moss-cc-e2e-"));
  const cards: CloudCard[] = [];
  const answers = { current: o.answers ?? ((): CloudAnswer => true) };
  const cloud = new CloudComputers({
    clock: { now: () => Date.now() }, store: new FileCloudStateStore(home), authority,
    provider: pluginProviders(rig.registry, rig.host), providerIds: () => providerIds(rig.registry),
    confirm: async (c) => { cards.push(c); return answers.current(c); }, userData: testUserData,
  });
  const point = new CloudPoint({ registry: rig.registry, cloud, active: () => true });
  return { rig, home, cards, cloud, point, answers };
}

/** Every file under `dir`, read: the secret must be in none of them. */
function everyFile(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...everyFile(p));
    else if (statSync(p).isFile()) out.push(readFileSync(p, "utf8"));
  }
  return out;
}

for (const kind of ["hetzner", "gcp"] as const) {
  describe(`a cloud computer on a stand-in ${kind}`, () => {
    test("the person's OK makes it: one card, one VM, in the cloud's list and in the registry of computers; resize and delete each ask", async () => {
      const { rig, home, cards, cloud, point } = await boot(kind);
      expect(await point.sync()).toMatchObject({ created: ["Cloud1"], failed: [] });
      expect(cards).toEqual([{ kind: "cloud-create", name: "Cloud1", provider: rig.providerId, size: rig.sizes.small, region: rig.folder.region, folder: "computer-cloud1" }]);
      expect(rig.cloud.billed()).toBe(1);
      const vm = cloud.get("Cloud1")!;
      expect(vm).toMatchObject({ state: "created", label: rig.label, provider: rig.providerId });
      expect(rig.cloud.size(vm.serverId!)).toBe(rig.sizes.small);
      // The cloud-init the VM was made with carries the single-use token and is the only place the token travels.
      expect(rig.cloud.userData(vm.serverId!)).toContain("#cloud-config");
      expect(everyFile(home).join("\n")).not.toContain(RIG_TOKEN);
      // A second pass changes nothing and asks nothing.
      expect(await point.sync()).toMatchObject({ created: [], failed: [] });
      expect(cards).toHaveLength(1);
      // The size is edited in the folder: asks, then resizes.
      expect(await cloud.reconcile([{ ...rig.folder, size: rig.sizes.big }])).toMatchObject({ resized: ["Cloud1"] });
      expect(cards.at(-1)).toMatchObject({ kind: "cloud-resize", from: rig.sizes.small, to: rig.sizes.big });
      expect(rig.cloud.size(vm.serverId!)).toBe(rig.sizes.big);
      // The folder is removed: asks whether to delete the VM, then deletes it, and nothing is left in the registry.
      expect(await cloud.reconcile([])).toMatchObject({ deleted: ["Cloud1"] });
      expect(cards.at(-1)).toMatchObject({ kind: "cloud-delete", why: "folder-removed" });
      expect(rig.cloud.billed()).toBe(0);
      expect(cloud.list()).toEqual([]);
    });

    test("a refusal creates nothing, and neither does a card nobody answered", async () => {
      for (const answer of [false, "unanswered"] as const) {
        const { rig, cards, cloud, point } = await boot(kind, { answers: () => answer });
        expect(await point.sync()).toMatchObject({ created: [], declined: ["Cloud1"] });
        expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
        expect(rig.cloud.billed()).toBe(0);
        expect(rig.cloud.requests.filter((r) => r.startsWith("POST") || r.startsWith("DELETE"))).toEqual([]);
        expect(cloud.list()).toEqual([]);
      }
    });

    test("not signed in: no card at all, a plain reason, and nothing was asked of the cloud", async () => {
      const { rig, cards, point } = await boot(kind, { signedIn: false });
      const r = await point.sync();
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]!.reason).toContain("sign in first");
      expect(r.failed[0]!.reason).not.toContain(RIG_TOKEN);
      expect(cards).toEqual([]);
      expect(rig.cloud.requests).toEqual([]);
    });

    test("a create that fails half-way (after the OK) leaves nothing billing and nothing dangling in the registry; the next pass tries again", async () => {
      const { rig, cards, cloud, point } = await boot(kind);
      rig.cloud.failNextCreate();
      const r = await point.sync();
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]!.reason).not.toContain(RIG_TOKEN);
      expect(rig.cloud.billed()).toBe(0);
      expect(cloud.list()).toEqual([]);
      expect(await point.sync()).toMatchObject({ created: ["Cloud1"] });
      expect(rig.cloud.billed()).toBe(1);
      // Each attempt was the person's own yes: two create cards.
      expect(cards.filter((c) => c.kind === "cloud-create")).toHaveLength(2);
    });

    test("the secret is kept by the core in the plugin's own secret items: in no file, in no card, and in no message", async () => {
      const { rig, home, cards, point } = await boot(kind);
      rig.cloud.failNextCreate();
      const r = await point.sync();
      await point.sync();
      const everything = [...everyFile(home), JSON.stringify(cards), JSON.stringify(r)].join("\n");
      expect(everything).not.toContain(RIG_TOKEN);
      expect((await rig.secrets.get({ owner: { kind: "plugin", pluginId: rig.pluginId }, name: kind === "hetzner" ? "hetzner-api-token" : "gcp-oauth" }))?.value.reveal()).toBe(RIG_TOKEN);
    });

    test("the provider's sign-in is one of the plugin's auth entries, for the keyed fetch and for the sign-in listing", async () => {
      const { rig } = await boot(kind);
      const record = rig.registry.get(rig.pluginId)!;
      const secret = kind === "hetzner" ? "hetzner-api-token" : "gcp-oauth";
      expect(keyedEntriesOf(record).get(secret)).toMatchObject({ secret });
      expect(authEntriesOf(record).map((n) => (n.entry as { secret?: string }).secret)).toEqual([secret]);
    });
  });
}

describe("what can reach a provider's handler", () => {
  test("no plugin calls a computerProviders entry through `points.call`: the point is the core's, which reads it", async () => {
    const rig = await cloudRig("hetzner");
    // (The real registry answers "a core point; the core reads it"; the fake declares no core points at all.)
    expect(() => declaredPointFor(rig.registry, "computerProviders", rig.pluginId)).toThrow();
    expect(() => declaredPointFor(rig.registry, "computerProviders", "someone/else")).toThrow();
  });

  test("a computer that is not the main refuses to remove a provider plugin: only the main holds the machines, and a removal syncs as a delete", async () => {
    const { rig, cards, cloud } = await boot("hetzner");
    const notMain = new CloudPoint({ registry: rig.registry, cloud, active: () => false });
    const e = await notMain.guardRemoval(rig.pluginId).catch((x) => x);
    expect((e as Error).message).toContain("only the main computer manages them");
    // The main asks; a plugin that provides nothing goes at once on any computer.
    const main = new CloudPoint({ registry: rig.registry, cloud, active: () => true });
    await main.sync();
    cards.length = 0;
    expect(await notMain.guardRemoval("someone/else")).toBeUndefined();
    const guard = await main.guardRemoval(rig.pluginId);
    expect(cards.map((c) => c.kind)).toEqual(["cloud-provider-removal"]);
    expect(rig.cloud.billed()).toBe(1);
    expect(guard!.note).toContain("will be deleted when you confirm this");
    await guard!.commit();
    expect(rig.cloud.billed()).toBe(0);
  });

  test("before the computers run, or on a computer whose node never started, removing or switching off a provider plugin is refused with a plain reason; a plugin that provides nothing goes", async () => {
    const { rig } = await boot("hetzner");
    for (const action of ["remove", "switch-off"] as const) {
      const lone = (machines: () => string[], others: string[] | undefined = []) => ({ otherComputers: () => others, machinesOf: machines });
      // Machines listed in this computer's record: refused, saying which and what the person can do.
      const e = await askBeforeProviderGoes(undefined, rig.registry, rig.pluginId, action, lone(() => ["Cloud1"])).catch((x) => x);
      expect(isContractError(e, "refused")).toBe(true);
      expect((e as Error).message).toContain("aren't running");
      expect((e as Error).message).toContain("Cloud1");
      expect((e as Error).message).toContain("on the main computer");
      expect((e as Error).message).toContain(rig.pluginId);
      // Its record lists none: nothing can be left billing, so it goes (it could otherwise never be removed when the parts never start).
      expect(await askBeforeProviderGoes(undefined, rig.registry, rig.pluginId, action, lone(() => []))).toBeUndefined();
      expect(await askBeforeProviderGoes(undefined, rig.registry, rig.pluginId, action)).toBeUndefined();
      // A record that can't be read is not "no machines".
      const bad = await askBeforeProviderGoes(undefined, rig.registry, rig.pluginId, action, lone(() => { throw new Error("not json"); })).catch((x) => x);
      expect(isContractError(bad, "refused")).toBe(true);
      expect((bad as Error).message).toContain("can't be read");
      // A group member (a computer that isn't the only one, the main included): refused with no record at all, pointing to the main by name.
      for (const machines of [() => [], () => { throw new Error("missing"); }]) {
        const g = await askBeforeProviderGoes(undefined, rig.registry, rig.pluginId, action, lone(machines, ["Studio"])).catch((x) => x);
        expect(isContractError(g, "refused")).toBe(true);
        expect((g as Error).message).toContain("main computer (Studio)");
      }
      // The list of other computers can't be read: refused, never "alone".
      const unk = await askBeforeProviderGoes(undefined, rig.registry, rig.pluginId, action, { otherComputers: () => undefined, machinesOf: () => [] }).catch((x) => x);
      expect(isContractError(unk, "refused")).toBe(true);
    }
    expect(await askBeforeProviderGoes(undefined, rig.registry, "someone/else", "remove", { otherComputers: () => ["Studio"], machinesOf: () => ["Cloud1"] })).toBeUndefined();
    // No registry at all (nothing to look in): nothing to refuse.
    expect(await askBeforeProviderGoes(undefined, undefined, rig.pluginId, "remove")).toBeUndefined();
  });

  test("switching a provider plugin off asks the same question (a card that says so), and its answer is carried out before it goes", async () => {
    const { rig, cards, cloud } = await boot("hetzner");
    const main = new CloudPoint({ registry: rig.registry, cloud, active: () => true });
    await main.sync();
    cards.length = 0;
    const guard = await askBeforeProviderGoes(main, rig.registry, rig.pluginId, "switch-off");
    expect(cards).toEqual([expect.objectContaining({ kind: "cloud-provider-removal", action: "switch-off" })]);
    expect(rig.cloud.billed()).toBe(1);
    await guard!.commit();
    expect(rig.cloud.billed()).toBe(0);
  });

  test("a provider that isn't installed or off is not reached, and nothing is asked", async () => {
    const { rig, cards, point } = await boot("hetzner");
    await rig.registry.setEnabled(rig.pluginId, false);
    expect((await point.sync()).failed).toHaveLength(1);
    expect(cards).toEqual([]);
    expect(rig.cloud.requests).toEqual([]);
  });
});
