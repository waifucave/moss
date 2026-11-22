// The relay choice's methods (spec §8.3): n0's relays by default; off; the person's own server by an `https:` address only; each
// kept and put to the links at once; a settings file's odd value never becomes a relay the person didn't mean.
import { describe, expect, test } from "bun:test";
import { DEVICES_METHODS, type Caller, type RelayView } from "@waifucave/moss-protocol";
import { deviceRelayMethods } from "../relay";
import { relayChoiceFrom, sidecarRelayOf, validRelayUrl, type Settings } from "../../settings";

const user: Caller = { kind: "user", client: "app" } as Caller;
const set = DEVICES_METHODS.deviceRelaySet.name;
const get = DEVICES_METHODS.deviceRelayGet.name;

function service(initial: RelayView = { mode: "n0" }) {
  let now = initial;
  const applied: RelayView[] = [];
  const m = deviceRelayMethods({ get: () => now, set: (c) => { now = c; applied.push(c); } });
  return { m, applied };
}

describe("device.relay.get and device.relay.set", () => {
  test("n0's public relays are the choice until the person picks another", async () => {
    expect(await service().m[get]!({}, { caller: user })).toEqual({ mode: "n0" });
  });

  test("off and n0 are kept and applied; a custom relay is kept by its normalised https address", async () => {
    const { m, applied } = service();
    expect(await m[set]!({ mode: "off" }, { caller: user })).toEqual({ mode: "off" });
    expect(await m[set]!({ mode: "custom", url: " https://relay.example.test " }, { caller: user })).toEqual({ mode: "custom", url: "https://relay.example.test/" });
    expect(await m[set]!({ mode: "n0" }, { caller: user })).toEqual({ mode: "n0" });
    expect(applied).toEqual([{ mode: "off" }, { mode: "custom", url: "https://relay.example.test/" }, { mode: "n0" }]);
  });

  test("a custom relay without a usable address is refused, and nothing is applied", async () => {
    const { m, applied } = service();
    for (const url of [undefined, "", "http://relay.example.test/", "https://user:pw@relay.example.test/", "https://relay.example.test/?k=1", "relay.example.test", "ftp://x/", "https://"]) {
      await expect(m[set]!({ mode: "custom", ...(url !== undefined ? { url } : {}) }, { caller: user })).rejects.toThrow();
    }
    expect(applied).toEqual([]);
  });

  test("a plugin's part, a session or a peer can't choose the relay", async () => {
    const { m, applied } = service();
    for (const caller of [{ kind: "plugin", pluginId: "acme/pairer" }, { kind: "session", sessionId: "ses_abcdef12", sessionKind: "bot" }, { kind: "peer", device: "dev_x" }] as unknown as Caller[]) {
      await expect(m[set]!({ mode: "off" }, { caller })).rejects.toThrow();
    }
    expect(applied).toEqual([]);
  });

  test("the method is the user's own press, for the app and the CLI, not a remote client's", () => {
    expect(DEVICES_METHODS.deviceRelaySet.userOnly).toBe(true);
    expect([...DEVICES_METHODS.deviceRelaySet.roles].sort()).toEqual(["app", "cli"]);
    expect([...DEVICES_METHODS.deviceRelayGet.roles].sort()).toEqual(["app", "cli"]);
  });
});

describe("the settings' relay choice", () => {
  const s = (relay: unknown): Settings => ({ links: { relay } } as unknown as Settings);
  test("what a settings file says becomes the sidecar's relay; anything odd is n0's relays, never a relay the person didn't mean", () => {
    expect(sidecarRelayOf(relayChoiceFrom(undefined))).toBe("default");
    expect(sidecarRelayOf(relayChoiceFrom(s({ mode: "off" })))).toBe("disabled");
    expect(sidecarRelayOf(relayChoiceFrom(s({ mode: "custom", url: "https://relay.example.test/" })))).toBe("https://relay.example.test/");
    for (const bad of [{ mode: "custom" }, { mode: "custom", url: "http://relay.example.test/" }, { mode: "custom", url: "https://u:p@x.test/" }, { mode: "nonsense" }]) {
      expect(sidecarRelayOf(relayChoiceFrom(s(bad)))).toBe("default");
    }
    expect(validRelayUrl("https://relay.example.test:8443/path")).toBe("https://relay.example.test:8443/path");
  });
});
