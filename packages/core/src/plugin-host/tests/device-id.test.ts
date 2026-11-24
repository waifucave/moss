// `api.plugin.device`, this device's id, as the core hands it to a host half (`HostedRecord.self`): only to a plugin whose
// OK granted `devices.read` (which shows every paired device's id already), never to one without it, whatever its manifest
// says it wants; and nothing before this device's links are up.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPointDecl } from "@waifucave/moss-plugin-sdk";
import type { Manifest } from "../../contracts/sdk-types";
import { RegistryCore } from "../../registry/core";
import { memoryRegistryStore } from "../../registry/state";
import { DEVICE_ID_CAPABILITY, deviceIdFor, hostedRecordOf } from "../daemon-host";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const plugin = (id: string, capabilities: string[]) => ({
  id,
  manifest: { manifest: 1, id, name: id, host: { entry: "host/index.ts" }, ...(capabilities.length > 0 ? { capabilities } : {}) } as unknown as Manifest,
  treeHash: `sha256:${id}`,
  approved: true,
  folder: `/tmp/${id}`,
});

describe("this device's id for a plugin", () => {
  const home = mkdtempSync(join(tmpdir(), "moss-device-id-"));
  temps.push(home);
  const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
  reg.putAll([plugin("relay", [DEVICE_ID_CAPABILITY]), plugin("plain", []), plugin("network", ["network:example.com"])]);
  const DEVICE = "dev0000000000abc";

  test("a plugin granted devices.read is told this device's id", () => {
    expect(reg.get("relay")?.granted).toContain(DEVICE_ID_CAPABILITY);
    expect(hostedRecordOf(reg, home, "relay", undefined, "linux-x64", DEVICE)?.self).toEqual({ namespace: "relay", version: "0.0.0", device: DEVICE });
  });

  test("a plugin without devices.read is never told it (refused by leaving it out), nor before the links are up", () => {
    for (const id of ["plain", "network"]) {
      const self = hostedRecordOf(reg, home, id, undefined, "linux-x64", DEVICE)?.self;
      expect(self).toEqual({ namespace: id, version: "0.0.0" });
      expect(self && "device" in self).toBe(false);
    }
    expect(hostedRecordOf(reg, home, "relay", undefined, "linux-x64", undefined)?.self).toEqual({ namespace: "relay", version: "0.0.0" });
  });

  test("the rule reads the grant the user's OK gave, not what the manifest asks for", () => {
    expect(deviceIdFor({ granted: [] }, DEVICE)).toBeUndefined();
    expect(deviceIdFor({ granted: ["devices.manage", "devices.relay"] }, DEVICE)).toBeUndefined();
    expect(deviceIdFor({ granted: [DEVICE_ID_CAPABILITY] }, DEVICE)).toBe(DEVICE);
    expect(deviceIdFor(undefined, DEVICE)).toBeUndefined();
  });
});
