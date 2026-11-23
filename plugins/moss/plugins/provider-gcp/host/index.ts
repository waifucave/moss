// The Google Cloud provider's host half (moss/provider-gcp): the handler of its `computerProviders` entry
// (moss.json), which the core calls on the main computer after the user approves each card (spec §9.2). The shape
// is lane J's proposal for the point (`CloudProviderHandler` in the core's `computers/cloud.ts`). A computer's
// `region` is a Compute Engine zone, and its server id is the instance's numeric id: the provider finds the instance
// by that id and acts on it by name only when it carries the computer's label.
//
// The plugin never holds the user's token: every request goes through the core's keyed fetch with the entry's
// `auth`, `gcp-oauth`, the user's own sign-in. Instances get no service account.
import type { HostPluginApi, SettingsApi } from "@waifucave/moss-plugin-sdk";
import { ComputeClient, GcpError, LABEL, type Instance } from "../src/client";

export const GCP_SECRET = "gcp-oauth";

export interface ProviderContext {
  readonly signal?: AbortSignal;
  /** A test's seam for the waits between reads; the core gives none. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly api: Pick<HostPluginApi, "net"> & { readonly settings: Pick<SettingsApi, "get"> };
}

async function client(ctx: ProviderContext): Promise<ComputeClient> {
  const project = await ctx.api.settings.get<string>("project");
  if (typeof project !== "string" || project === "") throw new Error("Google Cloud: set the project ID in the plugin's settings first");
  return new ComputeClient({
    project, ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    fetch: (url, init) => ctx.api.net.fetch(url, { ...init, ...(ctx.signal ? { signal: ctx.signal } : {}) }, { auth: GCP_SECRET }),
  });
}

/** Compute Engine's names: lower case, a letter first. */
const instanceName = (name: string) => {
  const n = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 63);
  return n || "moss";
};

const plain = (e: unknown): Error => (e instanceof GcpError ? new Error(`Google Cloud: ${e.message} (${e.code})`) : (e as Error));

type State = "creating" | "running" | "off" | "gone";
const stateOf = (i: Instance): State =>
  i.status === "RUNNING" ? "running" : i.status === "TERMINATED" || i.status === "STOPPED" || i.status === "SUSPENDED" ? "off" : "creating";
const ipOf = (i: Instance) => i.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
/** The last segment of a resource URL (`.../zones/europe-west4-a` → `europe-west4-a`). */
const last = (url?: string) => url?.split("/").pop() ?? "";

/** The instance with that id in that zone, when it carries that label; null when it is gone. One with another label
 *  (or none) is refused: the core never acts on an instance by a bare name (#254). */
async function labelled(c: ComputeClient, zone: string, serverId: string, label: string): Promise<Instance | null> {
  const i = await c.byId(zone, serverId);
  if (!i) return null;
  if (i.labels?.[LABEL] !== label) throw new Error(`Google Cloud: instance ${serverId} isn't the MOSS computer ${label}; nothing was done`);
  return i;
}

export const provider = {
  async create(a: { name: string; size: string; region: string; image?: string; userData: string; label: string }, ctx: ProviderContext): Promise<{ serverId: string; address?: string }> {
    try {
      const c = await client(ctx);
      const name = instanceName(a.name);
      // Deleted again ONLY when the create is KNOWN to have failed: the cloud's operation finished with an error. A read that
      // failed or found nothing after an accepted create, a poll that couldn't be read or a timeout leave it unknown, and
      // an instance the person approved is never deleted on a guess: the core looks for it by its label and keeps it.
      let known = false;
      try {
        try {
          await c.insert({ name, zone: a.region, machineType: a.size, ...(a.image ? { image: a.image } : {}), userData: a.userData, label: a.label });
        } catch (e) {
          known = e instanceof GcpError && e.opFailed;
          throw e;
        }
        const i = await c.getAfterCreate(a.region, name);
        if (!i?.id) throw new Error(`Google Cloud: the instance ${name} was accepted but can't be read yet; MOSS looks for it again by its label and keeps it if it is there`);
        const ip = ipOf(i);
        return { serverId: i.id, ...(ip ? { address: ip } : {}) };
      } catch (e) {
        // A create that failed (known) leaves nothing billing: the instance THIS call made (the user approved this create)
        // is deleted again, but only when it carries this create's label, so an instance that was already there under the
        // same name is never touched. It rolls back the one approved operation; it deletes nothing else.
        const removed = known ? await c.undoCreate(a.region, name, a.label).catch(() => "left" as const) : "none";
        const e2 = plain(e);
        throw removed === "left" ? new Error(`${e2.message}. The half-made instance ${name} could not be removed: delete it in your Google Cloud project`) : e2;
      }
    } catch (e) {
      throw plain(e);
    }
  },
  async list(a: { label?: string }, ctx: ProviderContext): Promise<{ serverId: string; label: string; region: string; size?: string; state: State; address?: string }[]> {
    try {
      return (await (await client(ctx)).listLabelled())
        .filter((i) => typeof i.labels?.[LABEL] === "string" && typeof i.id === "string" && (a.label === undefined || i.labels[LABEL] === a.label))
        .map((i) => {
          const ip = ipOf(i);
          return { serverId: i.id!, label: i.labels![LABEL]!, region: last(i.zone), ...(i.machineType ? { size: last(i.machineType) } : {}), state: stateOf(i), ...(ip ? { address: ip } : {}) };
        });
    } catch (e) {
      throw plain(e);
    }
  },
  async resize(a: { serverId: string; label: string; region: string; size: string }, ctx: ProviderContext): Promise<void> {
    try {
      const c = await client(ctx);
      const i = await labelled(c, a.region, a.serverId, a.label);
      if (!i) throw new Error(`Google Cloud: instance ${a.serverId} is gone`);
      await c.setMachineType(a.region, i.name, a.size);
    } catch (e) {
      throw plain(e);
    }
  },
  async delete(a: { serverId: string; label: string; region: string }, ctx: ProviderContext): Promise<void> {
    try {
      const c = await client(ctx);
      const i = await labelled(c, a.region, a.serverId, a.label);
      if (i) await c.delete(a.region, i.name);
    } catch (e) {
      throw plain(e);
    }
  },
  async status(a: { serverId: string; label: string; region: string }, ctx: ProviderContext): Promise<{ state: State; address?: string }> {
    try {
      const i = await labelled(await client(ctx), a.region, a.serverId, a.label);
      if (!i) return { state: "gone" };
      const ip = ipOf(i);
      return { state: stateOf(i), ...(ip ? { address: ip } : {}) };
    } catch (e) {
      throw plain(e);
    }
  },
  /** The VM has paired: its `user-data` (the cloud-init, with the spent token) is taken out of its metadata. */
  async paired(a: { serverId: string; label: string; region: string }, ctx: ProviderContext): Promise<void> {
    try {
      const c = await client(ctx);
      const i = await labelled(c, a.region, a.serverId, a.label);
      if (i) await c.removeMetadata(a.region, i.name, "user-data");
    } catch (e) {
      throw plain(e);
    }
  },
};
