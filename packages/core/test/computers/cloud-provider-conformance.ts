// What every `computerProviders` handler must do, whichever cloud it speaks to (spec §9.2): the same suite runs against
// each provider plugin's real host code, through the core's own glue and the daemon's keyed fetch, on a stand-in of that
// cloud's API (`cloud-rig.ts`). General: it names no provider, only the handler's shape and the rules around it.
import { describe, expect, test } from "bun:test";
import { cloudRig, RIG_TOKEN, type Rig, type RigKind } from "./cloud-rig";

const USER_DATA = "#cloud-config\nhostname: \"cloud1\"\n";

const create = (r: Rig) => r.handler.create({ name: "Cloud1", size: r.sizes.small, region: r.folder.region, userData: USER_DATA, label: r.label });
const fails = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a failure");
};

export function runCloudProviderConformance(kind: RigKind): void {
  describe(`computerProviders conformance: ${kind}`, () => {
    test("create makes one labelled VM and says where it is; list and status find it by its label", async () => {
      const r = await cloudRig(kind);
      const made = await create(r);
      expect(made.serverId).toMatch(/^\d+$/);
      expect(typeof made.address).toBe("string");
      expect(r.cloud.billed()).toBe(1);
      expect(r.cloud.labels()).toEqual([r.label]);
      expect(r.cloud.userData(made.serverId)).toBe(USER_DATA);
      expect(await r.handler.list({ label: r.label })).toMatchObject([{ serverId: made.serverId, label: r.label, state: "running" }]);
      expect(await r.handler.list({ label: "someone-else" })).toEqual([]);
      expect(await r.handler.status({ serverId: made.serverId, label: r.label, region: r.folder.region })).toMatchObject({ state: "running" });
    });

    test("resize changes the size, delete removes the VM, and a VM that is gone is gone (a second delete is not an error)", async () => {
      const r = await cloudRig(kind);
      const { serverId } = await create(r);
      const at = { serverId, label: r.label, region: r.folder.region };
      await r.handler.resize({ ...at, size: r.sizes.big });
      expect(r.cloud.size(serverId)).toBe(r.sizes.big);
      expect(await r.handler.status(at)).toMatchObject({ state: "running" });
      await r.handler.delete(at);
      expect(r.cloud.billed()).toBe(0);
      expect(await r.handler.status(at)).toEqual({ state: "gone" });
      await r.handler.delete(at);
    });

    test("it acts only on the VM with that id AND that label: a VM made by hand, or another folder's, is refused and untouched", async () => {
      const r = await cloudRig(kind);
      await create(r);
      const byHand = r.cloud.foreign();
      const other = r.cloud.foreign("computer-other");
      for (const f of [byHand, other]) {
        const at = { serverId: f.serverId, label: r.label, region: f.region };
        expect(await fails(r.handler.delete(at))).toContain("isn't the MOSS computer");
        expect(await fails(r.handler.resize({ ...at, size: r.sizes.big }))).toContain("isn't the MOSS computer");
        expect(await fails(r.handler.status(at))).toContain("isn't the MOSS computer");
      }
      expect(r.cloud.billed()).toBe(3);
      // A name where an id goes is refused, not looked up.
      expect(await fails(r.handler.delete({ serverId: "../x", label: r.label, region: r.folder.region }))).toMatch(/isn't (a server|an instance) id/);
      // list shows the MOSS-labelled VMs only, never the one made by hand.
      expect((await r.handler.list({})).map((v) => v.label).sort()).toEqual(["computer-cloud1", "computer-other"]);
    });

    test("a create that fails half-way leaves nothing billing, and says so plainly without the key", async () => {
      const r = await cloudRig(kind);
      r.cloud.failNextCreate();
      const why = await fails(create(r));
      expect(why.length).toBeGreaterThan(0);
      expect(why).not.toContain(RIG_TOKEN);
      expect(r.cloud.billed()).toBe(0);
      // And the next create works: nothing dangling blocks it.
      await create(r);
      expect(r.cloud.billed()).toBe(1);
    });

    test("a VM that was already there under the name (not made by this create) is never deleted by its failed rollback", async () => {
      const r = await cloudRig(kind);
      const byHand = r.cloud.foreign();
      r.cloud.failNextCreate();
      await fails(create(r));
      expect(r.cloud.billed()).toBe(1);
      expect((await r.handler.status({ serverId: byHand.serverId, label: "computer-x", region: byHand.region }).catch(() => ({ state: "refused" }))).state).toBe("refused");
    });

    test("not signed in: it fails with a plain reason, makes nothing, and the reason says nothing of any key", async () => {
      const r = await cloudRig(kind, { signedIn: false });
      const why = await fails(create(r));
      expect(why).not.toContain(RIG_TOKEN);
      expect(r.cloud.billed()).toBe(0);
      expect(r.cloud.requests).toEqual([]);
    });

    test("a wrong key is refused by the cloud, plainly, and the key is in no message", async () => {
      const r = await cloudRig(kind);
      await r.secrets.set({ owner: { kind: "plugin", pluginId: r.pluginId }, name: kind === "hetzner" ? "hetzner-api-token" : "gcp-oauth" }, "wrong-key-value-123456");
      const why = await fails(create(r));
      expect(why).not.toContain("wrong-key-value-123456");
      expect(why).not.toContain(RIG_TOKEN);
      expect(r.cloud.billed()).toBe(0);
    });
  });
}
