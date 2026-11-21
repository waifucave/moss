// What `agent.backends` serves of each backend's look (spec revision 20, §9.5 "A backend's look"): its colours and its
// icon. A plugin's backend gets them from its `agentBackends` entry (`icon`, `color`, `color2`; the icon read inside its
// own folder by `EngineBackendIcons`, cached until its plugin's tree changes); a core backend (MOSS's coding agent, which no
// plugin gives) from the table the daemon passes. A refused or missing icon is no icon, with the reason logged once: the
// backend is still offered, and a reader draws the SDK's fallback mark.
import { LookColor, type BackendIcon } from "@waifucave/moss-protocol";
import type { BackendIcons } from "../contracts/backend-icons";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { contributedBackends } from "./plugin-backends";

export interface BackendLook {
  icon?: BackendIcon;
  iconDark?: BackendIcon;
  color?: string;
  color2?: string;
}

export class BackendLooks {
  readonly #held = new Map<string, { key: string; read: Promise<BackendIcon | undefined> }>();
  readonly #said = new Set<string>();

  constructor(private readonly o: {
    registry: Pick<PluginRegistry, "entries" | "get">;
    icons: BackendIcons;
    /** The looks of the core's own backends, by id. */
    core?: Readonly<Record<string, BackendLook>>;
    log?: (line: string) => void;
  }) {}

  /** The look of each of these backends (one read of the plugins' entries for all of them). */
  async ofAll(ids: readonly string[]): Promise<Map<string, BackendLook>> {
    const entries = contributedBackends(this.o.registry);
    const out = new Map<string, BackendLook>();
    for (const id of ids) {
      const core = this.o.core?.[id];
      if (core !== undefined) { out.set(id, core); continue; }
      const c = entries.find((b) => b.id === id);
      if (c === undefined) { out.set(id, {}); continue; }
      const look: BackendLook = {};
      const color = LookColor.safeParse(c.look.color);
      if (color.success) look.color = color.data;
      const color2 = LookColor.safeParse(c.look.color2);
      if (color2.success) look.color2 = color2.data;
      const icon = c.look.icon === undefined ? undefined : await this.#icon(c.pluginId, c.id, c.look.icon);
      if (icon !== undefined) look.icon = icon;
      out.set(id, look);
    }
    return out;
  }

  #icon(pluginId: string, id: string, path: string): Promise<BackendIcon | undefined> {
    const record = this.o.registry.get(pluginId);
    if (record === undefined) return Promise.resolve(undefined);
    const key = `${record.folder}\0${record.treeHash}\0${path}`;
    const had = this.#held.get(id);
    if (had?.key === key) return had.read;
    const read = this.o.icons.read(record.folder, path).then((r) => {
      if ("icon" in r) return r.icon;
      const line = `agents: ${pluginId}'s backend ${id} has no icon: ${r.why}`;
      if (!this.#said.has(line)) { this.#said.add(line); this.o.log?.(line); }
      return undefined;
    });
    this.#held.set(id, { key, read });
    return read;
  }
}
