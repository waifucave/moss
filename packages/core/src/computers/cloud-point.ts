// The `computer` point (spec §9.2; plan §4 J, M3): the cloud computer folders the plugin registry holds, and the
// `computerProviders` handlers that make their VMs, wired into `CloudComputers`.
//
// * A folder is a plugin whose `computer` entry is active. One that is still there but off, or waiting for the user's
//   OK, is held: its VM is left alone, neither changed nor asked about. Only a folder that is gone asks about
//   deleting its VM.
// * A provider is the active `computerProviders` entry with that id; the core calls its handler (an object with
//   `create`, `resize`, `delete` and `status`) through the plugin host, on the main computer, as the core. The handler
//   reaches its cloud only through the keyed fetch, with the user's own credentials.
// * Every change in the registry, and every change of the lease, runs one reconcile after the one in flight, never two
//   at once. Only the lease's holder acts (lane H's lease, not the registry's main flag: #254's review, B1).
import { ContractError, isContractError, type Unsubscribe } from "../contracts/common";
import type { Lease } from "../contracts/lease";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";
import type { CloudAuthority, CloudComputers, CloudFolder, CloudPairingDoor, CloudProviderHandler, ReconcileResult } from "./cloud";

/** Lane H's lease as the cloud's authority: this device acts while it can and holds the lease, and its tenure is the
 *  lease's scope and epoch, so a change started under one epoch never finishes under another. */
export function leaseAuthority(lease: Lease): CloudAuthority {
  // Hand-overs: how many times this computer stopped holding the lease since it started. A cloud pairing token made
  // while it was alone is the same main's after the group's founding, but not after a hand-over and a return.
  // Counted: this computer stopped holding the lease, or held it again under a NEW epoch of the same scope (another
  // tenure, which another computer may have held in between without this one ever seeing it). Not counted: the scope
  // appearing when the group is founded (`-` to a group's), which is the same holder's own pairing.
  let last = lease.state();
  let handovers = 0;
  lease.watch((s) => {
    const was = last;
    last = s;
    const wasMine = was.holder === lease.self;
    const mine = s.holder === lease.self;
    if (wasMine && !mine) handovers += 1;
    else if (wasMine && mine && (was.scope ?? "-") === (s.scope ?? "-") && was.epoch !== s.epoch) handovers += 1;
  });
  return {
    handovers: () => handovers,
    canAct: () => lease.canAct(),
    tenure: () => {
      const s = lease.state();
      return s.holder === lease.self ? `${s.scope ?? "-"}:${s.epoch}` : undefined;
    },
  };
}

const none = (): ReconcileResult => ({ created: [], adopted: [], resized: [], deleted: [], repaired: [], declined: [], failed: [] });

/** How long a provider call may take: a VM's create or resize waits for the cloud's own actions. */
export const PROVIDER_CALL_TIMEOUT_MS = 10 * 60_000;

interface ComputerValue {
  provider: string;
  name: string;
  size: string;
  region: string;
  image?: string;
  makeMain?: "ask" | "no";
  onRemove?: "ask" | "keep";
}

/** The folders there are now, and the folders that are there but off or waiting (`held`). */
export function cloudFolders(registry: PluginRegistry): { folders: CloudFolder[]; held: Set<string> } {
  const folders: CloudFolder[] = [];
  const active = new Set<string>();
  for (const c of registry.entries("computer")) {
    if (c.state !== "active") continue;
    const v = c.value as ComputerValue;
    active.add(c.pluginId);
    folders.push({
      folder: c.pluginId, provider: v.provider, name: v.name, size: v.size, region: v.region,
      ...(v.image ? { image: v.image } : {}), ...(v.makeMain ? { makeMain: v.makeMain } : {}), ...(v.onRemove ? { onRemove: v.onRemove } : {}),
    });
  }
  // Any plugin still listed that isn't an active folder: off, waiting, refused or stopped. Its folder is there.
  const held = new Set(registry.list().map((r) => r.id).filter((id) => !active.has(id)));
  return { folders, held };
}

/** The ids of a plugin's (or its children's) `computerProviders` entries, active or not. */
export function providerEntryIds(registry: PluginRegistry, pluginId: string): string[] {
  return registry.entries("computerProviders")
    .filter((c) => (c.pluginId === pluginId || c.pluginId.startsWith(`${pluginId}/`)) && c.entryId)
    .map((c) => c.entryId!);
}

/** What stops a plugin that provides cloud computers from being removed or switched off while this computer's cloud
 *  computers aren't running: its machines could not be asked about, and would be left billing unasked. `undefined` for a
 *  plugin that provides none. Used until the computer node is up, and for good on a computer whose node never started. */
export function cloudNotRunningRefusal(
  registry: PluginRegistry, pluginId: string, action: "remove" | "switch-off" = "remove", machinesOf: (providerIds: string[]) => string[] = () => [],
): ContractError | undefined {
  const ids = providerEntryIds(registry, pluginId);
  if (ids.length === 0) return undefined;
  // This computer's own record lists no machine of these providers: nothing can be left billing, so nothing to ask.
  const machines = machinesOf(ids);
  if (machines.length === 0) return undefined;
  const verb = action === "remove" ? "remove it" : "switch it off";
  return new ContractError("refused", `${pluginId} provides cloud computers (${machines.join(", ")}), and this computer's cloud computers aren't running (still starting, or they did not start: see the daemon log), so what to do with the machines can't be asked: wait a minute or restart MOSS and ${verb} again, or ${verb} on the main computer if another computer is the main`);
}

/** The question before a plugin goes (removed or switched off), whichever state this computer's cloud computers are in:
 *  `point` once they run (it asks, or refuses on a computer that isn't the main); `undefined` before that or when the node
 *  never started, where a plugin that provides cloud computers is refused. */
export function askBeforeProviderGoes(
  point: CloudPoint | undefined, registry: PluginRegistry | undefined, pluginId: string, action: "remove" | "switch-off",
  machinesOf?: (providerIds: string[]) => string[],
): Promise<{ commit: () => Promise<void>; note: string } | undefined> {
  if (point) return point.guardRemoval(pluginId, action);
  const refusal = registry ? cloudNotRunningRefusal(registry, pluginId, action, machinesOf) : undefined;
  return refusal ? Promise.reject(refusal) : Promise.resolve(undefined);
}

/** The ids of the active `computerProviders` entries. */
export function providerIds(registry: PluginRegistry): string[] {
  return registry.entries("computerProviders").flatMap((c) => (c.state === "active" && c.entryId ? [c.entryId] : []));
}

/** The active `computerProviders` handler with that id, called through the plugin host. */
export function pluginProviders(registry: PluginRegistry, host: PluginHost): (id: string) => CloudProviderHandler | undefined {
  return (id) => {
    const entry = registry.entries("computerProviders").find((c) => c.state === "active" && c.entryId === id);
    if (!entry) return undefined;
    const { pluginId } = entry;
    const handler = (entry.value as { handler: string }).handler;
    const call = <R>(method: keyof CloudProviderHandler, args: unknown, signal?: AbortSignal) =>
      host.invoke<R>({ pluginId, handler, method, args, caller: { kind: "core" }, timeoutMs: PROVIDER_CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    return {
      create: (a, ctx) => call("create", a, ctx?.signal),
      list: (a, ctx) => call("list", a, ctx?.signal),
      resize: (a, ctx) => call("resize", a, ctx?.signal),
      delete: (a, ctx) => call("delete", a, ctx?.signal),
      status: (a, ctx) => call("status", a, ctx?.signal),
      // A provider without `paired` (Hetzner, whose user-data stays): the plugin host has no such handler; fine.
      paired: (a, ctx) => call<void>("paired", a, ctx?.signal).catch((e: unknown) => {
        if (isContractError(e, "not_installed") && /has no handler/.test((e as Error).message)) return;
        throw e;
      }),
    };
  };
}

/** Keeps `CloudComputers` in line with the registry: one reconcile at a time, and one more after it when anything
 *  changed meanwhile. */
export class CloudPoint {
  readonly #registry: PluginRegistry;
  readonly #cloud: CloudComputers;
  readonly #log: ((line: string) => void) | undefined;
  readonly #active: () => boolean;
  #running: Promise<ReconcileResult> | undefined;
  #again = false;

  /** `active`: whether this computer acts on cloud computers now (the lease's holder alone); a sync on any other does
   *  nothing. `CloudComputers` checks its own authority again around every card and provider call. */
  constructor(o: { registry: PluginRegistry; cloud: CloudComputers; active: () => boolean; log?: (line: string) => void }) {
    this.#active = o.active;
    this.#registry = o.registry;
    this.#cloud = o.cloud;
    this.#log = o.log;
  }

  /** Watches the registry; the first sync runs at once. */
  start(): Unsubscribe {
    const off = this.#registry.watch(() => void this.sync());
    void this.sync();
    return off;
  }

  /** One reconcile, after the one in flight (and only one more, however many changes came meanwhile). */
  sync(): Promise<ReconcileResult> {
    if (!this.#active()) return Promise.resolve(none());
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    const run = async (): Promise<ReconcileResult> => {
      let last = none();
      do {
        this.#again = false;
        if (!this.#active()) break;
        const { folders, held } = cloudFolders(this.#registry);
        last = await this.#cloud.reconcile(folders, held);
        for (const f of last.failed) this.#log?.(`cloud computer ${f.name} not changed: ${f.reason}`);
      } while (this.#again);
      return last;
    };
    const p = run().finally(() => {
      this.#running = undefined;
    });
    this.#running = p;
    return p;
  }

  /** Before a provider plugin is removed: its machines are asked about first (`CloudComputers.askRetire`); what the answer
   *  means is done by the returned `commit`, once the removal itself is confirmed. A plugin that is no provider, or has no
   *  machines, goes at once (`undefined`). Throws when the removal must not go on.
   *
   *  ONLY THE MAIN COMPUTER holds the machines and acts on them (§9.2), and a removal syncs as a delete (§5.1): removing a
   *  provider anywhere else would remove it on the main with no question, and the machines would keep billing. So on any
   *  other computer removing a plugin that provides cloud computers is refused, naming where to do it (the question is not
   *  forwarded: the main may be asleep or away, and a question that can't be answered anywhere holds the removal open). */
  async guardRemoval(pluginId: string, action: "remove" | "switch-off" = "remove"): Promise<{ commit: () => Promise<void>; note: string } | undefined> {
    const ids = providerEntryIds(this.#registry, pluginId);
    if (ids.length === 0) return undefined;
    if (!this.#active()) {
      throw new ContractError("refused", `${pluginId} provides cloud computers, and only the main computer manages them: ${action === "remove" ? "remove" : "switch"} it ${action === "remove" ? "" : "off "}on the main computer, where you are asked what to do with their machines`.replace("  ", " "));
    }
    const r = await this.#cloud.askRetire(ids, action);
    return r === undefined ? undefined : { note: r.note, commit: async () => void (await r.commit()) };
  }

  /** What lane H's authenticated pairing door calls when a device presents a cloud computer's token. */
  door(): CloudPairingDoor {
    return this.#cloud.door(() => cloudFolders(this.#registry).folders);
  }
}
