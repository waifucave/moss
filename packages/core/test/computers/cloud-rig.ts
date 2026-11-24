// A cloud computer provider as the daemon runs it, against a local stand-in of the provider's API (plan §4 J, M3):
//
//   a computer folder and the provider plugin, validated from their real folders, in a registry
//   → `cloudFolders` / `pluginProviders` (the core's own glue)
//   → the plugin host's `invoke` (the fake in-process host)
//   → the provider's REAL host code, loaded from the entry its manifest names
//   → `ctx.api.net.fetch(..., { auth })`, answered by the REAL keyed fetch the daemon serves plugins
//     (`modelPluginApiHandlers`: the plugin's own `network:` hosts, the key added by the core from the secret store,
//     the key masked out of every response and error)
//   → the stand-in (`FakeHetzner`, `FakeCompute`), an in-process fake that speaks the calls the plugin makes.
//
// The stand-in is a plain `fetch` the test hands the keyed fetch as its platform fetch, the same seam the model plugins'
// tests use. Nothing here is a setting or an environment variable of a shipped build: no URL can be pointed anywhere.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogPointDecl } from "../../../plugin-sdk/src/catalogs/index";
import { pluginFromFolder, REPO, tempDir, writePlugin } from "../../src/bots/tests/fixtures";
import { cloudFolders, pluginProviders } from "../../src/computers/cloud-point";
import type { CloudFolder, CloudProviderHandler } from "../../src/computers/cloud";
import { ContractError } from "../../src/contracts/common";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { FakePluginHost } from "../../src/contracts/fakes/plugin-host";
import { FakePluginRegistry } from "../../src/contracts/fakes/plugin-registry";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import type { HostModule } from "../../src/contracts/sdk-types";
import { modelPluginApiHandlers, secretStoreCredentials } from "../../src/runtime-sdk/model-plugins/plugin-api";
import { FakeCompute } from "../../../../plugins/moss/plugins/provider-gcp/test/fake-compute";
import { FakeHetzner } from "../../../../plugins/moss/plugins/provider-hetzner/test/fake-hetzner";

export type RigKind = "hetzner" | "gcp";

/** The token the user "signed in with"; every failure message is checked not to carry it. */
export const RIG_TOKEN = "test-token-not-a-secret-0123456789";

/** What a stand-in cloud shows a test: what is billing now, and the things only a test can do to it. */
export interface RigCloud {
  readonly requests: string[];
  /** The VMs billing now. */
  billed(): number;
  /** A VM the user (or another tool) made by hand, with no MOSS label or another folder's. */
  foreign(label?: string): { serverId: string; region: string };
  /** The next create is made and then fails (the cloud's own action or operation ends in an error). */
  failNextCreate(): void;
  /** What this VM is, as the stand-in holds it. */
  size(serverId: string): string | undefined;
  /** The user-data the VM was made with. */
  userData(serverId: string): string | undefined;
  /** The label values of the VMs there are. */
  labels(): string[];
}

export interface Rig {
  kind: RigKind;
  pluginId: string;
  /** The provider's id, as the folder names it. */
  providerId: string;
  folder: CloudFolder;
  label: string;
  registry: FakePluginRegistry;
  host: FakePluginHost;
  secrets: MemorySecretStore;
  cloud: RigCloud;
  /** The handler the core calls, through the real glue and the host. */
  handler: CloudProviderHandler;
  /** The size the folder says, and a bigger one. */
  sizes: { small: string; big: string };
}

const FOLDER_ID = "computer-cloud1";

export async function cloudRig(kind: RigKind, o: { signedIn?: boolean; project?: string | null } = {}): Promise<Rig> {
  const dir = kind === "hetzner" ? "provider-hetzner" : "provider-gcp";
  const pluginId = `moss/${dir}`;
  const root = join(tempDir("cloud-rig-"), "moss");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "moss.json"), readFileSync(join(REPO, "plugins", "moss", "moss.json"), "utf8"));
  cpSync(join(REPO, "plugins", "moss", "plugins", dir), join(root, "plugins", dir), { recursive: true });
  // The providers are parked in a shipped build (`availability: not-yet`): staged as a build that runs it would read it.
  const file = join(root, "plugins", dir, "moss.json");
  const { availability: _parked, ...runs } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify(runs, null, 2)}\n`);
  const bundled = await pluginFromFolder(root, { bundled: true });
  const providerId = kind;
  const size = kind === "hetzner" ? { small: "cx22", big: "cx32", region: "fsn1" } : { small: "e2-small", big: "e2-medium", region: "europe-west4-a" };
  const folderDir = writePlugin(tempDir("cloud-rig-folder-"), FOLDER_ID, {
    "moss.json": { manifest: 1, id: FOLDER_ID, name: "Cloud1", contributes: { computer: { provider: providerId, name: "Cloud1", size: size.small, region: size.region } } },
  });
  const folder = await pluginFromFolder(folderDir);
  const registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [...bundled.inputs, ...folder.inputs] });
  const host = new FakePluginHost({ clock: new FakeClock() });
  const record = registry.get(pluginId)!;
  host.define(pluginId, (await import(join(record.folder, record.manifest!.host!.entry))) as HostModule);

  const secrets = new MemorySecretStore();
  const secretName = kind === "hetzner" ? "hetzner-api-token" : "gcp-oauth";
  if (o.signedIn !== false) await secrets.set({ owner: { kind: "plugin", pluginId }, name: secretName }, RIG_TOKEN);

  const project = o.project === undefined ? "my-moss-123" : o.project;
  const hetzner = new FakeHetzner(RIG_TOKEN);
  const compute = new FakeCompute(RIG_TOKEN, "my-moss-123");
  const stand = kind === "hetzner" ? hetzner.fetch : compute.fetch;
  // The daemon's keyed fetch, with the stand-in as its platform fetch.
  const keyed = modelPluginApiHandlers({ registry, ...secretStoreCredentials(secrets), fetch: (url, init) => stand(url, init) });
  host.serveApi(async (call) => {
    if (call.path === "settings.get") return call.args[0] === "project" && project !== null ? project : undefined;
    const h = keyed[call.path as keyof typeof keyed];
    if (!h) throw new ContractError("refused", `${call.path} isn't served in this test`);
    return h({ pluginId: call.pluginId, process: call.process as "moss", caller: call.caller, record: registry.get(call.pluginId)!, path: call.path as never }, call.args);
  });

  const f = cloudFolders(registry).folders[0]!;
  const handler = pluginProviders(registry, host)(providerId)!;
  const cloud: RigCloud = kind === "hetzner"
    ? {
      requests: hetzner.requests, billed: () => hetzner.servers.size,
      foreign: (label) => {
        const id = 900 + hetzner.servers.size;
        hetzner.servers.set(id, { id, name: `hand-${id}`, server_type: size.small, location: size.region, image: "x", user_data: "", status: "running", ip: "203.0.113.9", labels: label ? { "moss-computer": label } : {} });
        return { serverId: String(id), region: size.region };
      },
      failNextCreate: () => { hetzner.failNextCreateAction = "server_create_failed"; },
      size: (id) => hetzner.servers.get(Number(id))?.server_type,
      userData: (id) => hetzner.servers.get(Number(id))?.user_data,
      labels: () => [...hetzner.servers.values()].map((s) => s.labels["moss-computer"] ?? ""),
    }
    : {
      requests: compute.requests, billed: () => compute.instances.size,
      foreign: (label) => {
        const i = compute.add({ name: `hand-${compute.instances.size}`, zone: size.region, ...(label ? { labels: { "moss-computer": label } } : {}) });
        return { serverId: i.id, region: size.region };
      },
      failNextCreate: () => { compute.failNextInsert = "QUOTA_EXCEEDED"; },
      size: (id) => [...compute.instances.values()].find((i) => i.id === id)?.machineType.split("/").pop(),
      userData: (id) => [...compute.instances.values()].find((i) => i.id === id)?.metadata.items.find((x) => x.key === "user-data")?.value,
      labels: () => [...compute.instances.values()].map((i) => i.labels["moss-computer"] ?? ""),
    };
  return { kind, pluginId, providerId, folder: f, label: "computer-cloud1", registry, host, secrets, cloud, handler, sizes: size };
}
