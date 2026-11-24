// A real-agents preview's way to the public npm registry (scripts/acceptance/daemon.ts loads this file only when the preview
// set MOSS_PREVIEW_REAL_NPM=1; an acceptance run never loads it). The run's own fake registry answers first; what it lacks
// (the pinned adapters an agent plugin declares, fetched only after the person's yes on their card, every hash checked by
// the engine's store) is asked of the real registry. Every other name stays with the run's own seam: answered there or refused.
// The owner allowed that download for the preview (2026-11-23).
import type { PinnedFetchSeam } from "../../packages/core/src/plugin-host/pinned-fetch";

export const REAL_NPM = "registry.npmjs.org";

export interface RealNetwork {
  /** The addresses a name resolves to. */
  resolve(name: string): Promise<string[]>;
  fetch(url: string, init: RequestInit): Promise<Response>;
}

const system: RealNetwork = {
  // `node:dns` is loaded here, on the first real lookup, never at module load.
  resolve: async (name) => (await (await import("node:dns/promises")).lookup(name, { all: true })).map((a) => a.address),
  fetch: (url, init) => fetch(url, init),
};

/** `base` with the public npm registry reachable for what `base` answers 404 to. */
export function withRealNpm(base: PinnedFetchSeam, real: RealNetwork = system, note: (line: string) => void = (line) => console.error(line)): PinnedFetchSeam {
  return {
    ...base,
    resolve: async (name) => (name.toLowerCase() === REAL_NPM ? real.resolve(name) : base.resolve!(name)),
    fetch: async (url, init) => {
      const host = (new Headers(init.headers).get("host") ?? new URL(url).host).replace(/:\d+$/, "").toLowerCase();
      if (host !== REAL_NPM) return base.fetch!(url, init);
      const own = await base.fetch!(url, init);
      if (own.status !== 404) return own;
      note(`acceptance daemon: the real npm registry is asked for ${new URL(url).pathname} (a real-agents preview)`);
      return real.fetch(url, init);
    },
  };
}
