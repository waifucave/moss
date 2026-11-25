// `devices.revoked` (behind `devices.read`, like `devices.list`): the ids and times of the devices this computer's registry
// holds as revoked, nothing else of them; refused to a plugin without the grant.
import { expect, test } from "bun:test";
import { ContractError } from "../../contracts/common";
import { areasParts, type AreaServices } from "../api/areas";
import { createApiRouter } from "../api/router";

const record = (id: string, granted: string[]) => ({ id, enabled: true, state: "running", granted, capabilities: granted }) as never;

test("revoked devices' ids and times, to a devices.read holder only", async () => {
  const all = [
    { id: "self0000000000aa", name: "Studio", kind: "desktop" },
    { id: "phone000000000bb", name: "Phone", kind: "phone" },
    { id: "lost0000000000cc", name: "Lost phone", kind: "phone", revokedAt: 1_790_000_000_000, publicKey: "secret-ish" },
  ];
  const services = { bots: () => undefined, node: () => undefined, links: () => ({ registry: { all: () => all } }) } as unknown as AreaServices;
  const parts = areasParts(services);
  const router = (granted: string[]) => createApiRouter({ registry: { get: (id: string) => (id === "p" ? record(id, granted) : undefined) }, handlers: [parts.handlers] });
  const call = (granted: string[]) => router(granted)({ pluginId: "p", process: "shared", path: "devices.revoked", args: [], caller: { kind: "plugin", pluginId: "p" } });
  expect(await call(["devices.read"])).toEqual([{ id: "lost0000000000cc", revokedAt: 1_790_000_000_000 }]);
  const refused = await call([]).then(() => undefined, (e: unknown) => e as ContractError);
  expect(refused?.message).toContain("needs the capability devices.read");
});
