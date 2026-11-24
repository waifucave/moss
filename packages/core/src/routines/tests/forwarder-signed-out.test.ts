// What the bot is told when a webhook routine can't get its URL because no waifucave account is signed in on this
// computer: the moss/forwarder plugin's own host half, its keyed fetch failing `no_account` as the core's does before any
// request, and the engine's Routine tool. The routine is made (it runs on its schedule meanwhile), and the reason is said
// in words a person can act on, never a raw fetch error. Nothing leaves the machine.
import { afterAll, expect, test } from "bun:test";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakePluginHost } from "../../contracts/fakes/plugin-host";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "../../bots/tests/fixtures";
import * as forwarder from "../../../../../plugins/moss/plugins/forwarder/host/index";
import type { HostApi } from "../../../../../plugins/moss/plugins/forwarder/host/api";
import { memoryKeys } from "../../../../../plugins/moss/plugins/forwarder/src/keys";
import { noAccount } from "../../runtime-sdk/model-plugins/plugin-api";

afterAll(async () => {
  await forwarder.stop();
  removeTemps();
});

test("signed out: the routine is made, and the bot is told in plain words why it has no webhook URL yet; nothing was sent", async () => {
  const keys = await memoryKeys();
  const sent: string[] = [];
  const api = {
    plugin: { id: "moss/forwarder", namespace: "moss", version: "0.0.0", computer: "Studio" },
    settings: { get: async () => undefined },
    keys: { publicKey: async () => keys.publicKey(), open: async () => new Uint8Array(0), delete: async () => {} },
    net: {
      fetch: async (url: string) => {
        sent.push(url);
        throw noAccount();
      },
    },
  } as unknown as HostApi;
  await forwarder.stop();
  await forwarder.start(api);
  const host = new FakePluginHost({ clock: new FakeClock() });
  host.define("moss/forwarder", { ingress: forwarder.ingress } as never, { source: "bundled" });
  const registry = {
    entries: (point: string) => (point === "triggers" ? [{ pluginId: "moss/trigger-webhook", entryId: "webhook", state: "active", value: { type: "webhook" } }]
      : point === "webhook.ingress" ? [{ pluginId: "moss/forwarder", entryId: "waifucave", state: "active", value: { handler: "ingress" } }] : []),
  } as never;
  const b = await boot({
    home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, clock: new FakeClock(),
    routines: { secrets: new MemorySecretStore(), watchFiles: false, triggers: registry, ingress: { registry, host, poll: false } },
  });
  const r = await b.side.tools("b_alpha").find((t) => t.name === "Routine")!.run({ name: "Deploys", instructions: "Check the deploy.", webhook: true, schedule: "every 1h" });
  expect(r.isError).toBe(false);
  expect(r.text).toContain("It has no webhook URL yet (");
  expect(r.text).toContain("no waifucave account is signed in on this computer, and webhooks come in through hooks.waifucave.com with one (a tunnel or a cloud computer can take them instead)");
  // The keyed fetch failed before anything went out (the core's does so; here the stand-in records the URL it was asked).
  expect(sent.every((u) => u.startsWith("https://hooks.waifucave.com/"))).toBe(true);
  await b.shutdown();
});
