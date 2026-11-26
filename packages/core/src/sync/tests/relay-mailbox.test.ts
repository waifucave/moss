// Lane XC 5b: the memory mailbox over the relay plugin that is on (sync/relay-mailbox.ts). One relay: the plugin is
// called as the core, naming this device for a take or an ack. None (the default): nothing kept, nothing fails. Two or
// more: none is used, and the person is told once.
import { describe, expect, test } from "bun:test";
import { MemoryMailRelay } from "../mailbox";
import { mailRelaysOf, PluginRelayMailbox, TWO_RELAYS_NOTICE, type RelayMailSource, type RelayOn } from "../relay-mailbox";
import { CLOUDFLARE_RELAY as CF, fakeRelayPlugin } from "./relay-plugin-fake";
const OTHER: RelayOn = { pluginId: "someone/relay", handler: "relay" };
const piece = (id: string, to = "laptop0000000000aa") => ({ to, id, sealed: new Uint8Array([1, 2, 3]), expiresAt: Date.now() + 60_000 });

describe("PluginRelayMailbox", () => {
  test("one relay on: put, take and ack reach it as the core, a take and an ack naming this device", async () => {
    const relay = new MemoryMailRelay();
    const plugin = fakeRelayPlugin(relay);
    const studio = new PluginRelayMailbox({ source: () => ({ relays: () => [CF], invoke: plugin.invoke }), self: () => "studio000000000aaa" });
    const laptop = new PluginRelayMailbox({ source: () => ({ relays: () => [CF], invoke: plugin.invoke }), self: () => "laptop0000000000aa" });
    await studio.put(piece("m1"));
    expect(relay.held("laptop0000000000aa").length).toBe(1);
    const got = await laptop.take({ max: 4 });
    expect(got.map((m) => m.id)).toEqual(["m1"]);
    await laptop.ack(["m1"]);
    expect(relay.held("laptop0000000000aa")).toEqual([]);
    expect(plugin.calls.map((c) => [c.method, c.relay.pluginId, c.args["device"] ?? null])).toEqual([
      ["putMail", CF.pluginId, null], ["takeMail", CF.pluginId, "laptop0000000000aa"], ["ackMail", CF.pluginId, "laptop0000000000aa"],
    ]);
    // A take reads only its own mailbox: the studio finds nothing of the laptop's.
    await studio.put(piece("m2"));
    expect(await studio.take()).toEqual([]);
  });

  test("no relay on (the default), or the plugin host not up yet: nothing kept, nothing fails, said once", async () => {
    const lines: string[] = [];
    const relay = new MemoryMailRelay();
    const plugin = fakeRelayPlugin(relay);
    let up = false;
    const box = new PluginRelayMailbox({ source: () => (up ? { relays: () => [], invoke: plugin.invoke } : undefined), self: () => "studio000000000aaa", log: (l) => lines.push(l) });
    await box.put(piece("m1"));
    up = true;
    await box.put(piece("m2"));
    expect(await box.take()).toEqual([]);
    await box.ack(["x"]);
    expect(plugin.calls).toEqual([]);
    expect(relay.held("laptop0000000000aa")).toEqual([]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("no relay is on");
  });

  test("two relays on: none is used, and the person is told once, plainly; back to one, the mail flows again", async () => {
    const relay = new MemoryMailRelay();
    const plugin = fakeRelayPlugin(relay);
    let on: RelayOn[] = [CF, OTHER];
    const told: string[] = [];
    const box = new PluginRelayMailbox({ source: () => ({ relays: () => on, invoke: plugin.invoke }), self: () => "laptop0000000000aa", onMany: (t) => told.push(t) });
    await box.put(piece("m1"));
    await box.put(piece("m2"));
    expect(await box.take()).toEqual([]);
    expect(plugin.calls).toEqual([]);
    expect(told).toEqual([TWO_RELAYS_NOTICE]);
    expect(TWO_RELAYS_NOTICE).toBe("Two relays are on, so MOSS keeps no mail for your computers that are off. Turn one off.");
    on = [CF];
    await box.put(piece("m3"));
    expect(relay.held("laptop0000000000aa").length).toBe(1);
    // Two again later: told again, once.
    on = [CF, OTHER];
    await box.put(piece("m4"));
    await box.put(piece("m5"));
    expect(told.length).toBe(2);
  });

  test("only relays that declare mail count: one mail relay and one link-only relay is the mailbox, with no notice", async () => {
    const entries = [
      { pluginId: "moss/relay-cloudflare", entryId: "cloudflare", state: "active", value: { id: "cloudflare", handler: "relay", mail: true } },
      { pluginId: "someone/iroh-relay", entryId: "iroh", state: "active", value: { id: "iroh", handler: "relay" } },
      { pluginId: "someone/off-relay", entryId: "off", state: "off", value: { id: "off", handler: "relay", mail: true } },
      { pluginId: "someone/odd", entryId: "odd", state: "active", value: { id: "odd", mail: "yes", handler: "relay" } },
    ];
    expect(mailRelaysOf(entries)).toEqual([{ pluginId: "moss/relay-cloudflare", handler: "relay" }]);
    const relay = new MemoryMailRelay();
    const plugin = fakeRelayPlugin(relay);
    const told: string[] = [];
    const box = new PluginRelayMailbox({ source: () => ({ relays: () => mailRelaysOf(entries), invoke: plugin.invoke }), self: () => "s0000000000000000a", onMany: (t) => told.push(t) });
    await box.put(piece("m1"));
    expect(relay.held("laptop0000000000aa").length).toBe(1);
    expect(told).toEqual([]);
    // The link-only relay is never called.
    expect(plugin.calls.every((c) => c.relay.pluginId === "moss/relay-cloudflare")).toBe(true);
  });

  test("a relay's malformed answer gives no pieces; a relay that fails makes the put fail (the sync queues it again)", async () => {
    const odd: RelayMailSource = { relays: () => [CF], invoke: async (_r, method) => (method === "takeMail" ? { mail: [{ id: 5 }, { id: "ok", sealed: "not bytes" }, null, { id: "good", sealed: new Uint8Array([9]) }] } : {}) };
    const box = new PluginRelayMailbox({ source: () => odd, self: () => "laptop0000000000aa" });
    expect((await box.take()).map((m) => m.id)).toEqual(["good"]);
    const failing = new PluginRelayMailbox({ source: () => ({ relays: () => [CF], invoke: async () => { throw new Error("relay down"); } }), self: () => "s0000000000000000a" });
    await expect(failing.put(piece("m1"))).rejects.toThrow("relay down");
  });
});
