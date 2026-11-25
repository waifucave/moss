// MOSS Code's setup guide steps aside for a card waiting in its window (the same rule as MOSS's guide): the window's
// logic (main's guideStepsAside over the router's placements) and the page's (pages.ts stepAside: the guide kept at its
// step, only not drawn). The headless harness can't put a card in MOSS Code's window (it is never in front there), so
// the in-window case is proven here.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { guideStepsAside } from "../src/main/core-pages";

GlobalRegistrator.register();
const { showWelcome, stepAside } = await import("../src/core/pages");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Place = { kind: string; program?: string; window?: string } | undefined;

describe("guideStepsAside", () => {
  const aside = (places: [string, Place][], pending: string[], copyWaits = false) =>
    guideStepsAside({ places, pending: (id) => pending.includes(id), program: "code", copyWaits });

  test("a pending card placed in this window (its conversation or its strip) puts the guide aside; answered, it is back", () => {
    expect(aside([], [])).toBe(false);
    expect(aside([["k1", { kind: "conversation", program: "code", window: "main" }]], ["k1"])).toBe(true);
    expect(aside([["k1", { kind: "strip", program: "code", window: "main" }]], ["k1"])).toBe(true);
    // Answered: no longer pending.
    expect(aside([["k1", { kind: "strip", program: "code", window: "main" }]], [])).toBe(false);
  });

  test("a card placed elsewhere leaves it: the island, nowhere, MOSS's window, another window", () => {
    expect(aside([["k1", { kind: "island" }]], ["k1"])).toBe(false);
    expect(aside([["k1", { kind: "elsewhere" }]], ["k1"])).toBe(false);
    expect(aside([["k1", { kind: "conversation", program: "moss", window: "main" }]], ["k1"])).toBe(false);
    expect(aside([["k1", { kind: "strip", program: "code", window: "other" }]], ["k1"])).toBe(false);
    expect(aside([["k1", undefined]], ["k1"])).toBe(false);
  });

  test("the old home's copy card waiting puts it aside too", () => {
    expect(aside([], [], true)).toBe(true);
  });
});

describe("the guide page steps aside and comes back at its step", () => {
  test("at the model step: aside while a card waits, then back, the same step and the same page", async () => {
    const host = document.createElement("div");
    host.id = "moss-page";
    document.body.append(host);
    const setup = { ready: true, missing: [], providers: ["anthropic"], default: { model: "anthropic/claude-opus-5-5", source: "chosen", effort: "medium" }, dismissed: false };
    const call = async (name: string): Promise<unknown> => {
      if (name === "welcome.providers") return { providers: [{ id: "moss/model-anthropic", name: "Anthropic", auth: [{ index: 0, method: "api-key", state: "signed-in" }] }] };
      if (name === "welcome.setup") return setup;
      if (name === "welcome.models") return { models: [{ id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", providerName: "Anthropic" }] };
      return {};
    };
    const t = (key: string) => key;
    await showWelcome(host, t as never, call as never, () => {});
    await new Promise((r) => setTimeout(r, 20));
    (host.querySelector("[data-moss-welcome=next]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const section = host.querySelector("[data-moss-welcome-step=model]");
    expect(section).not.toBeNull();
    // Main's word: a card waits in this window.
    stepAside(host, true);
    expect(host.dataset.aside).toBe("yes");
    expect(host.querySelector("[data-moss-welcome-step=model]")).toBe(section);
    // Answered: back, the same page at the same step.
    stepAside(host, false);
    expect(host.dataset.aside).toBeUndefined();
    expect(host.querySelector("[data-moss-welcome-step=model]")).toBe(section);
    expect(host.querySelector("[data-moss-default]")?.getAttribute("data-moss-default")).toBe("anthropic/claude-opus-5-5");
    host.remove();
  });
});

describe("the guide's provider step says when the default model's provider is signed out", () => {
  const draw = async (setup: Record<string, unknown>) => {
    const host = document.createElement("div");
    host.id = "moss-page";
    document.body.append(host);
    const call = async (name: string): Promise<unknown> => {
      if (name === "welcome.providers") return { providers: [{ id: "moss/model-anthropic", name: "Anthropic", auth: [{ index: 0, method: "api-key", state: "signed-out" }] }] };
      if (name === "welcome.setup") return setup;
      return {};
    };
    await showWelcome(host, ((key: string, vars?: Record<string, unknown>) => (vars === undefined ? key : `${key} ${JSON.stringify(vars)}`)) as never, call as never, () => {});
    await new Promise((r) => setTimeout(r, 20));
    return host;
  };

  test("one plain line, with the names; nothing when the default's provider is there", async () => {
    const out = await draw({ ready: false, missing: ["default-provider"], providers: [], dismissed: false, signedOut: "anthropic/claude-opus-5-5", signedOutAs: { model: "Claude Opus 5.5", provider: "Anthropic" } });
    const line = out.querySelector<HTMLElement>("[data-moss-signed-out]")!;
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe('welcome.signed-out {"model":"Claude Opus 5.5","provider":"Anthropic"}');
    out.remove();
    const fine = await draw({ ready: false, missing: ["provider"], providers: [], dismissed: false });
    expect(fine.querySelector<HTMLElement>("[data-moss-signed-out]")!.hidden).toBe(true);
    fine.remove();
  });
});

describe("the guide's provider step counts a local server the engine counts (it answers), with no key (2026-11-24)", () => {
  const OLLAMA: { id: string; name: string; providers: string[]; auth: never[]; local?: { running: boolean; models: number } } = { id: "moss/model-ollama-local", name: "Ollama (local)", providers: ["ollama-local"], auth: [] };
  const draw = async (setup: Record<string, unknown>) => {
    const host = document.createElement("div");
    host.id = "moss-page";
    document.body.append(host);
    const call = async (name: string): Promise<unknown> => {
      if (name === "welcome.providers") return { providers: [OLLAMA] };
      if (name === "welcome.setup") return setup;
      return {};
    };
    await showWelcome(host, ((key: string, vars?: Record<string, unknown>) => (vars === undefined ? key : `${key} ${JSON.stringify(vars)}`)) as never, call as never, () => {});
    await new Promise((r) => setTimeout(r, 20));
    return host;
  };

  test("only Ollama answers: Next on, one ready; nothing answers: Next off; running with no model: the line says to pull one", async () => {
    const has = await draw({ ready: true, missing: [], providers: ["ollama-local"], local: { "ollama-local": 2 }, dismissed: false });
    expect((has.querySelector("[data-moss-welcome=next]") as HTMLButtonElement).disabled).toBe(false);
    expect(has.querySelector("[data-moss-local-empty]")).toBeNull();
    has.remove();
    const fresh = await draw({ ready: false, missing: ["provider"], providers: [], dismissed: false });
    expect((fresh.querySelector("[data-moss-welcome=next]") as HTMLButtonElement).disabled).toBe(true);
    fresh.remove();
    const empty = await draw({ ready: false, missing: ["model"], providers: ["ollama-local"], local: { "ollama-local": 0 }, dismissed: false });
    expect((empty.querySelector("[data-moss-welcome=next]") as HTMLButtonElement).disabled).toBe(false);
    expect(empty.querySelector("[data-moss-local-empty]")?.textContent).toBe('welcome.local-empty {"provider":"Ollama (local)"}');
    empty.remove();
    // Not running: the row says so, with Check again.
    OLLAMA.local = { running: false, models: 0 };
    const stopped = await draw({ ready: false, missing: ["provider"], providers: [], dismissed: false });
    expect(stopped.querySelector("[data-moss-local-stopped]")?.textContent).toContain('welcome.local-stopped {"provider":"Ollama (local)"}');
    expect(stopped.querySelector("[data-moss-welcome=check-again]")).not.toBeNull();
    stopped.remove();
  });
});
