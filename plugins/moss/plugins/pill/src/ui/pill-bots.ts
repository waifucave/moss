// The pill's bots (`bots.read` through the pill's own plugin API): read once per API object, and kept current from
// `bot_changed` events instead of asked for again. The effect is keyed on `api.bots`, which `usePluginApi()` keeps
// stable. A key that changes on every render, such as a freshly bound `list`, re-runs the effect after each `setBots`,
// and that loops `bot.list` against the daemon without a pause.
import { useEffect, useState } from "react";
import type { usePluginApi } from "@waifucave/moss-plugin-sdk/ui";

export interface PillBotRow {
  id: string;
  name: string;
}

const row = (b: { id: unknown; name?: unknown }): PillBotRow => ({ id: String(b.id), name: String(b.name ?? b.id) });

/** A first read that fails (the link to the core not open yet, a refusal while the plugin is being switched on) is tried again after
 *  these waits, then left: with no bot the pill draws nothing at all, so one lost read would leave it blank for good. */
export const PILL_BOTS_RETRY_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 8_000];

export function usePillBots(api: ReturnType<typeof usePluginApi>): readonly PillBotRow[] {
  const bots = api.bots;
  const [rows, setRows] = useState<readonly PillBotRow[]>([]);
  useEffect(() => {
    if (bots === undefined) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (attempt: number): void => {
      void bots.list().then((r) => {
        if (live) setRows((r as readonly { id: unknown; name?: unknown }[]).map(row));
      }).catch(() => {
        const wait = PILL_BOTS_RETRY_MS[attempt];
        if (live && wait !== undefined) timer = setTimeout(() => read(attempt + 1), wait);
      });
    };
    read(0);
    const stop = bots.watch?.((b) => {
      const next = row(b as { id: unknown; name?: unknown });
      setRows((list) => (list.some((x) => x.id === next.id) ? list.map((x) => (x.id === next.id ? next : x)) : [...list, next]));
    });
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      stop?.();
    };
  }, [bots]);
  return rows;
}
