// Which ingress a webhook routine comes in through: the one its file names, else MOSS's own forwarder by its id. A third
// party's ingress that happens to be first in the synced list never takes a routine that named none (its deliveries reach
// the engine with no key checked there).
import { describe, expect, test } from "bun:test";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakePluginHost } from "../../contracts/fakes/plugin-host";
import { WebhookIngress } from "../webhooks";

function world(ids: string[]) {
  const calls: string[] = [];
  const host = new FakePluginHost({ clock: new FakeClock() });
  for (const id of ids) {
    host.define(id, { ingress: { register: async (a: { routine: string }) => (calls.push(`${id}:${a.routine}`), { url: `https://${id.replace("/", ".")}.test/${a.routine}` }) } } as never);
  }
  const registry = { entries: (point: string) => (point === "webhook.ingress" ? ids.map((pluginId) => ({ pluginId, entryId: pluginId.split("/").pop(), state: "active", value: { handler: "ingress" } })) : []) } as never;
  const ingress = new WebhookIngress({
    registry, host, clock: new FakeClock(),
    engine: { deliverWebhook: async () => "refused", webhookRoutines: () => [], webhook: async () => ({ url: "", key: "" }) } as never,
  });
  return { ingress, calls };
}

describe("a webhook routine's ingress", () => {
  test("named none: MOSS's forwarder, even when a third party's ingress is first in the list", async () => {
    const w = world(["pack/hooks", "moss/forwarder"]);
    expect(await w.ingress.register("r_one", "k".repeat(43))).toBe("https://moss.forwarder.test/r_one");
    expect(w.calls).toEqual(["moss/forwarder:r_one"]);
  });

  test("named none, and only a third party's ingress is on: no URL, and nothing registered there", async () => {
    const w = world(["pack/hooks"]);
    await expect(w.ingress.register("r_one", "k".repeat(43))).rejects.toThrow("MOSS's webhook forwarder isn't on here");
    expect(w.calls).toEqual([]);
  });

  test("a third party's ingress takes the routine when its file names it", async () => {
    const w = world(["moss/forwarder", "pack/hooks"]);
    expect(await w.ingress.register("r_two", "k".repeat(43), "pack/hooks")).toBe("https://pack.hooks.test/r_two");
    expect(w.calls).toEqual(["pack/hooks:r_two"]);
  });
});
