// FakeAgentStartOptions: what each backend offers from a table the test gives, and the person's last start in memory.
import { RECENT_FOLDERS_MAX, type AgentBackendOptions, type BackendModelOption, type RecentStart } from "@waifucave/moss-protocol";
import { ContractError } from "../common";
import type { AgentStartOptions, PersonStart } from "../agent-start";

/** How a backend knows its options: from the catalog (MOSS's coding agent), its quirks or a probe, or not at all. */
export type BackendOptionSource =
  | { from: "catalog" }
  | { from: "quirks" | "probe"; models: BackendModelOption[]; default?: { model?: string; effort?: string } }
  | { from: "unknown" };

export class FakeAgentStartOptions implements AgentStartOptions {
  #recent: RecentStart = { roots: [] };

  constructor(
    private readonly backends: Readonly<Record<string, BackendOptionSource>>,
    private readonly catalog: { models: BackendModelOption[]; default?: { model: string; effort?: string } },
  ) {}

  async options(backend: string): Promise<AgentBackendOptions> {
    const src = this.backends[backend];
    if (src === undefined) throw new ContractError("not_found", `no agent backend ${backend}`);
    if (src.from === "catalog") return { backend, known: true, source: "catalog", models: this.catalog.models, ...(this.catalog.default ? { default: this.catalog.default } : {}) };
    if (src.from === "unknown") return { backend, known: false, source: "unknown", models: [] };
    return { backend, known: true, source: src.from, models: src.models, ...(src.default ? { default: src.default } : {}) };
  }

  remember(start: PersonStart, at: number): void {
    const roots = [{ root: start.root, at }, ...this.#recent.roots.filter((r) => r.root !== start.root)].slice(0, RECENT_FOLDERS_MAX);
    this.#recent = {
      backend: start.backend, computer: start.computer, roots,
      ...(start.model !== undefined ? { model: start.model } : {}), ...(start.effort !== undefined ? { effort: start.effort } : {}),
    };
  }

  recent(): RecentStart {
    return { ...this.#recent, roots: [...this.#recent.roots] };
  }
}
