/**
 * A code session's title runs on the light model of ITS OWN model's family (spec revision 20, §9.5 "Titles"), not the
 * default's: the router's `lightOf`. Its provider must serve the light model and hold a credential; otherwise the titles
 * job's usual answer. An explicit setting for titles still wins. Over a throwaway secret store, never a real credential.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../src/auth/credential-material";
import { createInternalProviderView } from "../../src/providers/internal-view";
import { createInternalRouter, isInternalRefusal, type InternalRouter } from "../../src/providers/internal-router";
import type { ModelTag } from "../../src/runtime-sdk/model-tag";
import { mossSessionTitles } from "../../src/agent/titles";
import { Settings, setModelRole } from "../../src/settings";

const settingsWith = (model: string, extra: Record<string, unknown> = {}): Settings => Settings.parse({ schemaVersion: 3, provider: { model }, ...extra });

async function routerWith(keys: string[]): Promise<InternalRouter> {
  const secrets = new FileSecretStore(mkdtempSync(join(tmpdir(), "moss-cg-title-secrets-")));
  for (const k of keys) await writeCredentialMaterial(secrets, `${k}:default`, { kind: "api-key", key: `sk-${k}` });
  const view = createInternalProviderView({ secrets, log: () => {} });
  await view.refresh();
  return createInternalRouter({ view, secrets });
}

const tagOf = (r: InternalRouter, s: Settings, lightOf?: string) => {
  const c = r.resolve("titles.model", s, lightOf === undefined ? undefined : { lightOf: lightOf as ModelTag });
  if (isInternalRefusal(c)) throw new Error(c.reason);
  return String(c.tag);
};

describe("a session's title on its own family's light model", () => {
  test("a GPT session in a home whose default is Claude is titled on luna; a Claude session on Haiku", async () => {
    const r = await routerWith(["anthropic", "openai"]);
    const s = settingsWith("anthropic/claude-opus-5-5");
    expect(tagOf(r, s)).toBe("anthropic/claude-haiku-5-5");
    expect(tagOf(r, s, "openai/gpt-6.1-terra")).toBe("openai/gpt-6-luna");
    expect(tagOf(r, s, "anthropic/claude-sonnet-5")).toBe("anthropic/claude-haiku-5-5");
    // The light model itself names its own family.
    expect(tagOf(r, s, "openai/gpt-6-luna")).toBe("openai/gpt-6-luna");
  });

  test("a model in no family, or an outside agent's own model name: the titles job's usual answer (the default's family on the default's provider)", async () => {
    const r = await routerWith(["anthropic"]);
    const s = settingsWith("anthropic/claude-opus-5-5");
    expect(tagOf(r, s, "anthropic/not-a-model")).toBe("anthropic/claude-haiku-5-5");
    expect(tagOf(r, s, "opus")).toBe("anthropic/claude-haiku-5-5");
    expect(tagOf(r, s, "gpt-5-codex")).toBe("anthropic/claude-haiku-5-5");
  });

  // 2026-11-22 (backlog 521; was: the titles job's usual answer, which could be any other provider): a session on a model the
  // catalog knows is titled on ITS provider's light model or not at all.
  test("a session whose own provider holds no key: no title job, never another provider", async () => {
    const r = await routerWith(["anthropic"]);
    const s = settingsWith("anthropic/claude-opus-5-5");
    const c = r.resolve("titles.model", s, { lightOf: "openai/gpt-6.1-terra" as ModelTag });
    expect(isInternalRefusal(c)).toBe(true);
    // The same with the default's provider the only other one signed in, and with a coding-plan key beside it.
    const plan = await routerWith(["anthropic", "groq"]);
    expect(isInternalRefusal(plan.resolve("titles.model", s, { lightOf: "openai/gpt-6.1-terra" as ModelTag }))).toBe(true);
  });

  // The brief: a title of a code session on an ACP agent stays on MOSS's own providers as today. OpenCode's models are
  // `provider/model` of its own account, so the string can parse as a catalog tag of a provider with no key of MOSS's here.
  test("an ACP agent's session whose model reads as another provider's tag is titled on the default's light model, through the host's titles", async () => {
    const { EngineSessionTitles } = await import("../../src/sessions/session-titles");
    const r = await routerWith(["anthropic"]);
    const s = settingsWith("anthropic/claude-opus-5-5");
    const t = mossSessionTitles(r, () => s);
    const used: string[] = [];
    const titles = new EngineSessionTitles({ titler: async (_text, model) => (used.push(model), "A title"), lightModelFor: t.lightModelFor });
    await titles.turnEnded({ session: "s_acp", kind: "agent", model: "openai/gpt-6.1-terra", backend: "opencode", firstMessage: "fix it" });
    expect(titles.title("s_acp")?.title).toBe("A title");
    // The same string on MOSS's own runtime has no key for its provider: no title, not another provider's.
    await titles.turnEnded({ session: "s_own", kind: "coding", model: "openai/gpt-6.1-terra", backend: "moss-code", firstMessage: "fix it" });
    expect(titles.title("s_own")).toBeUndefined();
    expect(used).toEqual(["anthropic/claude-haiku-5-5"]); // only the ACP session's title ran, on the default's light model
  });

  test("a session on a provider that serves no light model of its family: not run on its main model", async () => {
    const r = await routerWith(["groq", "anthropic"]);
    const s = settingsWith("anthropic/claude-opus-5-5");
    expect(isInternalRefusal(r.resolve("titles.model", s, { lightOf: "groq/llama-3.3-70b-versatile" as ModelTag }))).toBe(true);
  });

  test("an explicit setting for titles wins over the session's family", async () => {
    const r = await routerWith(["anthropic", "openai"]);
    const s = setModelRole(settingsWith("anthropic/claude-opus-5-5"), "titles.model", "anthropic/claude-sonnet-5" as ModelTag);
    expect(tagOf(r, s, "openai/gpt-6.1-terra")).toBe("anthropic/claude-sonnet-5");
  });

  test("the host's titles source: the light tag for a session, and a failed try when titles are off or nothing can run", async () => {
    const r = await routerWith(["anthropic", "openai"]);
    let s: Settings = settingsWith("anthropic/claude-opus-5-5");
    const t = mossSessionTitles(r, () => s);
    expect(t.lightModelFor("openai/gpt-6.1-terra")).toBe("openai/gpt-6-luna");
    expect(t.lightModelFor(undefined)).toBe("anthropic/claude-haiku-5-5");
    s = settingsWith("anthropic/claude-opus-5-5", { titles: { enabled: false } });
    expect(() => t.lightModelFor(undefined)).toThrow("titles are turned off");
    const none = mossSessionTitles(await routerWith([]), () => settingsWith("anthropic/claude-opus-5-5"));
    expect(() => none.lightModelFor(undefined)).toThrow();
    const gone = mossSessionTitles(r, () => settingsWith("anthropic/claude-opus-5-5"));
    expect(() => gone.lightModelFor("deepseek/deepseek-v4-pro")).toThrow(); // deepseek holds no key here: no other provider is tried
  });
});
