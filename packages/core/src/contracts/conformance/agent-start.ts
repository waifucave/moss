// The AgentStartOptions conformance suite (spec revision 20, §9.5). `runAgentStartOptionsConformance(make)` registers
// every case against what `make` builds over the backends and catalog it is given; `tests/agent-start.test.ts` runs it
// against FakeAgentStartOptions, and lane CA against the engine's.
import { describe, expect, test } from "bun:test";
import { RECENT_FOLDERS_MAX, type BackendModelOption } from "@waifucave/moss-protocol";
import { isContractError } from "../common";
import type { AgentStartOptions } from "../agent-start";
import type { BackendOptionSource } from "../fakes/agent-start";

export type AgentStartOptionsFactory = (
  backends: Readonly<Record<string, BackendOptionSource>>,
  catalog: { models: BackendModelOption[]; default?: { model: string; effort?: string } },
) => AgentStartOptions;

const OPUS: BackendModelOption = { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" };
const BACKENDS: Record<string, BackendOptionSource> = {
  "moss-code": { from: "catalog" },
  codex: { from: "quirks", models: [{ id: "gpt-6", name: "GPT-6", efforts: ["low", "high"] }], default: { model: "gpt-6", effort: "high" } },
  devin: { from: "unknown" },
};

export function runAgentStartOptionsConformance(make: AgentStartOptionsFactory): void {
  describe("AgentStartOptions", () => {
    test("before any session: the catalog for MOSS's coding agent, the quirks for an ACP agent, or unknown until started", async () => {
      const o = make(BACKENDS, { models: [OPUS], default: { model: OPUS.id, effort: "high" } });
      expect(await o.options("moss-code")).toEqual({ backend: "moss-code", known: true, source: "catalog", models: [OPUS], default: { model: OPUS.id, effort: "high" } });
      expect((await o.options("codex")).default).toEqual({ model: "gpt-6", effort: "high" });
      expect(await o.options("devin")).toEqual({ backend: "devin", known: false, source: "unknown", models: [] });
      let err: unknown;
      try { await o.options("nope"); } catch (e) { err = e; }
      expect(isContractError(err, "not_found")).toBe(true);
    });

    test("the person's last start: backend, model, effort, and the folders newest first, each once, bounded", () => {
      const o = make(BACKENDS, { models: [OPUS] });
      expect(o.recent()).toEqual({ roots: [] });
      o.remember({ backend: "codex", computer: "Studio", root: "home/Studio/app", model: "gpt-6", effort: "high" }, 1);
      o.remember({ backend: "moss-code", computer: "Studio", root: "home/Studio/docs" }, 2);
      o.remember({ backend: "codex", computer: "Studio", root: "home/Studio/app", model: "gpt-6" }, 3);
      expect(o.recent()).toEqual({ backend: "codex", computer: "Studio", model: "gpt-6", roots: [{ root: "home/Studio/app", at: 3 }, { root: "home/Studio/docs", at: 2 }] });
      for (let i = 0; i < 20; i++) o.remember({ backend: "codex", computer: "Studio", root: `home/Studio/p${i}` }, 10 + i);
      expect(o.recent().roots.length).toBe(RECENT_FOLDERS_MAX);
      expect(o.recent().roots[0]!.root).toBe("home/Studio/p19");
    });
  });
}
