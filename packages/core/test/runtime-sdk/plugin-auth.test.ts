// `plugin.auth.*` (runtime-sdk/plugin-auth.ts): a plugin's sign-ins, where each key lands, the OAuth and device flows
// in the background, signing out, and the user-only gate. Every store here is in memory; no flow touches the network.
import { describe, expect, test } from "bun:test";
import type { PluginAuthView } from "@waifucave/moss-protocol";
import type { SecretStore } from "../../src/auth/secret-store";
import { readCredentialMaterial } from "../../src/auth/credential-material";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import type { PluginRecord } from "../../src/contracts/plugin-registry";
import { authEntriesOf, createPluginAuth, pluginAuthMethods, type OAuthRun } from "../../src/runtime-sdk/plugin-auth";
import { modelPluginSlotFor } from "../../src/runtime-sdk/model-plugins/keychain-tokens";
import { secretStoreCredentials } from "../../src/runtime-sdk/model-plugins/plugin-api";
import { LocalServers, setLocalServers } from "../../src/runtime-sdk/model-plugins/local-servers";

class DaemonStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(name: string): Promise<string | null> { return this.values.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.values.set(name, value); }
  async delete(name: string): Promise<boolean> { return this.values.delete(name); }
}

const rec = (id: string, source: string, manifest: unknown): PluginRecord => ({ id, source, manifest } as unknown as PluginRecord);
const GROQ = rec("moss/model-groq", "bundled", { contributes: { models: [{ provider: "groq", auth: [{ method: "api-key", secret: "api-key" }] }] } });
const CODEX = rec("moss/model-codex-oauth", "bundled", { contributes: { models: [{ provider: "codex-oauth", auth: [{ method: "oauth-pkce", authorizeUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "c", scopes: ["a", "b"], secret: "chatgpt" }] }] } });
const XAI = rec("moss/model-xai-oauth", "bundled", { contributes: { models: [{ provider: "xai-oauth", auth: [{ method: "custom", handler: "signIn" }] }] } });
const THIRD = rec("acme/models", "folder", { contributes: { models: [{ provider: "acme", auth: [{ method: "api-key", secret: "key" }] }] }, auth: [{ method: "api-key", secret: "extra" }] });

const LOCAL = rec("acme/local", "folder", { contributes: { models: [{ provider: "acme-local" }] } });
/** A plugin whose only sign-in is the manifest's own: it covers both providers the plugin serves. */
const SHARED = rec("acme/shared", "folder", { contributes: { models: [{ provider: "acme-a" }, { provider: "acme-b" }] }, auth: [{ method: "api-key", secret: "account" }] });

function world(o: { oauth?: () => OAuthRun; xaiDevice?: Parameters<typeof createPluginAuth>[0]["xaiDevice"]; invoke?: (req: { handler: string }) => unknown } = {}) {
  const records = new Map([GROQ, CODEX, XAI, THIRD, LOCAL, SHARED].map((r) => [r.id, r]));
  const secrets = new DaemonStore();
  const pluginSecrets = new MemorySecretStore();
  const events: { id: string; auth: PluginAuthView }[] = [];
  const refreshed: string[] = [];
  const logs: string[] = [];
  const auth = createPluginAuth({
    registry: { get: (id) => records.get(id) },
    host: { invoke: async (req) => o.invoke?.(req) as never },
    secrets, pluginSecrets,
    changed: (id, view) => { events.push({ id, auth: view }); },
    credentialChanged: (p) => { refreshed.push(p); },
    ...(o.oauth ? { oauth: o.oauth } : {}),
    ...(o.xaiDevice ? { xaiDevice: o.xaiDevice } : {}),
    modelProviders: () => [{ provider: "groq", pluginId: GROQ.id }, { provider: "acme", pluginId: THIRD.id }, { provider: "acme-local", pluginId: LOCAL.id }, { provider: "gone", pluginId: "acme/gone" }, { provider: "acme-a", pluginId: SHARED.id }, { provider: "acme-b", pluginId: SHARED.id }],
    log: (line) => logs.push(line),
  });
  return { auth, secrets, pluginSecrets, events, refreshed, logs };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("keylessProviders: only a local server is had with no key (2026-11-24)", () => {
  test("a bundled local provider (local-none) is keyless; a bundled REMOTE one with no key entry (uncloseai, whose keyless beta closed) is not", async () => {
    const OLLAMA = rec("moss/model-ollama-local", "bundled", { contributes: { models: [{ provider: "ollama-local", endpoint: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1" } }] } });
    const UNCLOSE = rec("moss/model-uncloseai", "bundled", { contributes: { models: [{ provider: "uncloseai", endpoint: { protocol: "openai-chat", baseUrl: "https://hermes.ai.unturf.com/v1" } }] } });
    const records = new Map([OLLAMA, UNCLOSE].map((r) => [r.id, r]));
    const auth = createPluginAuth({
      registry: { get: (id) => records.get(id) }, host: { invoke: async () => undefined as never },
      secrets: new DaemonStore(), pluginSecrets: new MemorySecretStore(), changed: () => {}, credentialChanged: () => {},
      modelProviders: () => [{ provider: "ollama-local", pluginId: OLLAMA.id }, { provider: "uncloseai", pluginId: UNCLOSE.id }],
    });
    expect([...auth.keylessProviders()]).toEqual(["ollama-local"]);
    // Neither counts as a provider the person added (a bundled plugin is never "signed in" without a key).
    expect([...await auth.signedInProviders()]).toEqual([]);
  });
  test("a local server the prober asked and found silent is not keyless; one not asked yet is; the provider page reads running and its chat models", async () => {
    const OLLAMA = rec("moss/model-ollama-local", "bundled", { contributes: { models: [{ provider: "ollama-local", endpoint: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1" } }] } });
    const records = new Map([OLLAMA].map((r) => [r.id, r]));
    const auth = createPluginAuth({
      registry: { get: (id) => records.get(id) }, host: { invoke: async () => undefined as never },
      secrets: new DaemonStore(), pluginSecrets: new MemorySecretStore(), changed: () => {}, credentialChanged: () => {},
      modelProviders: () => [{ provider: "ollama-local", pluginId: OLLAMA.id }],
    });
    let up = false;
    let now = 1_000_000;
    const servers = new LocalServers({
      endpoints: () => [{ provider: "ollama-local", baseUrl: "http://127.0.0.1:11434/v1", personSet: false }],
      now: () => now,
      list: async () => { if (!up) throw new Error("refused"); return { models: [{ id: "qwen3:8b" }, { id: "nomic-embed-text" }] }; },
    });
    setLocalServers(servers);
    try {
      expect([...auth.keylessProviders()]).toEqual(["ollama-local"]); // not asked yet: a named default still works
      expect(await auth.localStatus!(OLLAMA.id)).toEqual({ running: false, models: 0 });
      expect([...auth.keylessProviders()]).toEqual([]); // asked, silent
      expect(await auth.localStatus!(GROQ.id)).toBeUndefined();
      up = true;
      now += 1_000; // the page's ask is forced: again after a second, though a failure is kept 5 s
      expect(await auth.localStatus!(OLLAMA.id)).toEqual({ running: true, models: 1 }); // the embedding model isn't counted
      expect([...auth.keylessProviders()]).toEqual(["ollama-local"]);
    } finally {
      setLocalServers(undefined);
    }
  });
});

describe("plugin.auth", () => {
  test("the sign-ins are numbered: the models entries' first, then the manifest's own", () => {
    expect(authEntriesOf(THIRD).map((e) => [e.index, e.provider ?? null, (e.entry as { secret: string }).secret])).toEqual([[0, "acme", "key"], [1, null, "extra"]]);
  });

  test("a bundled plugin's key lands in its provider's slot (where the model plugin reads it), and shows signed in", async () => {
    const w = world();
    expect(await w.auth.list(GROQ.id)).toEqual([{ index: 0, method: "api-key", secret: "api-key", state: "signed-out" }]);
    expect(await w.auth.signIn(GROQ.id, 0, "  gsk-the-key  ")).toEqual({ state: "signed-in" });
    expect(await readCredentialMaterial(w.secrets, modelPluginSlotFor("groq").account)).toEqual({ kind: "api-key", key: "gsk-the-key" });
    expect((await w.auth.list(GROQ.id))[0]!.state).toBe("signed-in");
    expect(w.refreshed).toEqual(["groq"]);
    expect(w.events.at(-1)).toEqual({ id: GROQ.id, auth: { index: 0, method: "api-key", secret: "api-key", state: "signed-in" } });
    await w.auth.signOut(GROQ.id, 0);
    expect((await w.auth.list(GROQ.id))[0]!.state).toBe("signed-out");
    expect(w.refreshed).toEqual(["groq", "groq"]);
  });

  test("a key stored before the plugins existed (the provider's slot) shows as signed in", async () => {
    const w = world();
    w.secrets.values.set(modelPluginSlotFor("groq").account, JSON.stringify({ kind: "api-key", key: "older" }));
    expect((await w.auth.list(GROQ.id))[0]!.state).toBe("signed-in");
  });

  test("another plugin's key is its own secret, never a provider slot", async () => {
    const w = world();
    await w.auth.signIn(THIRD.id, 1, "k2");
    expect((await w.pluginSecrets.get({ owner: { kind: "plugin", pluginId: THIRD.id }, name: "extra" }))?.value.reveal()).toBe("k2");
    expect(w.secrets.values.size).toBe(0);
    // The manifest's own sign-in covers every provider the plugin serves: their live sessions are replaced.
    expect(w.refreshed).toEqual(["acme"]);
    expect((await w.auth.list(THIRD.id)).map((a) => a.state)).toEqual(["signed-out", "signed-in"]);
  });

  test("signedInProviders: a third party's provider once its own key is in, one taking no sign-in always; never a bundled one (its slot says) or a plugin gone", async () => {
    const w = world();
    expect([...await w.auth.signedInProviders()]).toEqual(["acme-local"]);
    await w.auth.signIn(GROQ.id, 0, "gsk");
    expect([...await w.auth.signedInProviders()]).toEqual(["acme-local"]);
    await w.auth.signIn(THIRD.id, 0, "k1");
    expect([...await w.auth.signedInProviders()].sort()).toEqual(["acme", "acme-local"]);
    await w.auth.signOut(THIRD.id, 0);
    expect([...await w.auth.signedInProviders()]).toEqual(["acme-local"]);
    // The manifest's own sign-in covers the provider too.
    await w.auth.signIn(THIRD.id, 1, "extra");
    expect([...await w.auth.signedInProviders()].sort()).toEqual(["acme", "acme-local"]);
  });

  test("a cloud computer provider's sign-in covers no model provider: it neither signs a model in nor makes it need a key", async () => {
    const BOTH = rec("acme/both", "folder", { contributes: { models: [{ provider: "acme-both" }], computerProviders: [{ id: "acme-cloud", handler: "h", auth: [{ method: "api-key", secret: "cloud-token" }] }] } });
    const auth = createPluginAuth({
      registry: { get: (id) => (id === BOTH.id ? BOTH : undefined) }, host: { invoke: async () => undefined as never },
      secrets: new DaemonStore(), pluginSecrets: new MemorySecretStore(), changed: () => {}, credentialChanged: () => {},
      modelProviders: () => [{ provider: "acme-both", pluginId: BOTH.id }],
    });
    // The entry is there for the sign-in listing and the keyed fetch, numbered after the models' own, and marked.
    expect(authEntriesOf(BOTH).map((e) => [e.index, e.computer ?? false, (e.entry as { secret: string }).secret])).toEqual([[0, true, "cloud-token"]]);
    // The model "acme-both" takes no key of its own, so it is usable with nothing; the cloud token neither is needed nor counts.
    expect([...await auth.signedInProviders()]).toEqual(["acme-both"]);
    await auth.signIn(BOTH.id, 0, "the-cloud-token");
    expect([...await auth.signedInProviders()]).toEqual(["acme-both"]);
    await auth.signOut(BOTH.id, 0);
    expect([...await auth.signedInProviders()]).toEqual(["acme-both"]);
  });

  test("signedInProviders: a plugin whose only sign-in is the manifest's own needs that key for every provider it serves (never \"takes no key\")", async () => {
    const w = world();
    expect([...await w.auth.signedInProviders()].filter((p) => p.startsWith("acme-") && p !== "acme-local")).toEqual([]);
    await w.auth.signIn(SHARED.id, 0, "shared-key");
    expect([...await w.auth.signedInProviders()].filter((p) => p !== "acme-local").sort()).toEqual(["acme-a", "acme-b"]);
    expect(w.refreshed.sort()).toEqual(["acme-a", "acme-b"]);
    await w.auth.signOut(SHARED.id, 0);
    expect([...await w.auth.signedInProviders()].filter((p) => p !== "acme-local")).toEqual([]);
  });

  test("a bad key is refused without echoing it; a key for a flow that takes none is refused", async () => {
    const w = world();
    const err = await w.auth.signIn(GROQ.id, 0, "bad​key").catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain("bad");
    await expect(w.auth.signIn(CODEX.id, 0, "x")).rejects.toThrow(/takes no key/);
    await expect(w.auth.signIn("nope/x", 0, "x")).rejects.toThrow(/no plugin/);
    await expect(w.auth.signIn(GROQ.id, 3, "x")).rejects.toThrow(/no sign-in 3/);
  });

  test("oauth-pkce: the URL comes back at once, the tokens land in the slot on the redirect, and the event says so", async () => {
    let finish!: () => void;
    const w = world({
      oauth: () => ({
        authorizeUrl: Promise.resolve("https://auth.example/authorize?x=1"),
        tokens: new Promise((res) => { finish = () => res({ accessToken: "at", refreshToken: "rt", idToken: null, accountId: "acct", expiresAt: 9e12 }); }),
      }),
    });
    expect(await w.auth.signIn(CODEX.id, 0)).toEqual({ state: "refreshing", authorizeUrl: "https://auth.example/authorize?x=1" });
    expect((await w.auth.list(CODEX.id))[0]!.state).toBe("refreshing");
    await expect(w.auth.signIn(CODEX.id, 0)).rejects.toThrow(/already running/);
    finish();
    await settle(); await settle(); await settle();
    expect(await readCredentialMaterial(w.secrets, modelPluginSlotFor("codex-oauth").account)).toMatchObject({ kind: "oauth", accessToken: "at", refreshToken: "rt", accountId: "acct" });
    expect(w.events.at(-1)?.auth.state).toBe("signed-in");
    expect(w.refreshed).toEqual(["codex-oauth"]);
  });

  test("an OAuth sign-in that fails shows failed with a reason, and the event says so", async () => {
    const w = world({ oauth: () => ({ authorizeUrl: Promise.resolve("https://auth.example/a"), tokens: Promise.reject(new Error("login timed out")) }) });
    await w.auth.signIn(CODEX.id, 0);
    await settle(); await settle();
    const v = (await w.auth.list(CODEX.id))[0]!;
    expect(v.state).toBe("failed");
    // The error's class, never its message.
    expect(v.reason).toBe("the sign-in didn't finish (Error)");
    expect(w.events.at(-1)?.auth.state).toBe("failed");
  });

  test("a failed OAuth sign-in's reason never carries the provider's text: the error's class only, in Settings, the event and the log", async () => {
    const said = "provider says: invalid_client SENTINEL-OAUTH-6b1f";
    const late = world({ oauth: () => ({ authorizeUrl: Promise.resolve("https://auth.example/a"), tokens: Promise.reject(Object.assign(new TypeError(said), { name: "TypeError" })) }) });
    await late.auth.signIn(CODEX.id, 0);
    await settle(); await settle();
    expect((await late.auth.list(CODEX.id))[0]!.reason).toBe("the sign-in didn't finish (TypeError)");
    // A forged class name (the error's own `name`, set by whoever threw it) falls back to a fixed word.
    const forged = world({ oauth: () => ({ authorizeUrl: Promise.resolve("https://auth.example/a"), tokens: Promise.reject(Object.assign(new Error("x"), { name: `bad ${said}` })) }) });
    await forged.auth.signIn(CODEX.id, 0);
    await settle(); await settle();
    expect((await forged.auth.list(CODEX.id))[0]!.reason).toBe("the sign-in didn't finish (Error)");
    // A flow that can't start: refused with the class only.
    const early = world({ oauth: () => { const p = Promise.reject(new Error(said)); p.catch(() => {}); return { authorizeUrl: p, tokens: new Promise<never>(() => {}) }; } });
    const err = (await early.auth.signIn(CODEX.id, 0).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("the sign-in couldn't start (Error)");
    for (const w of [late, forged, early]) expect(JSON.stringify([w.events, w.logs, await w.auth.list(CODEX.id)])).not.toContain("SENTINEL");
  });

  test("no log line, event, refresh or error carries a key: a bundled one, a third party's, a refused one", async () => {
    const KEY = "SENTINEL-KEY-plugin-auth-91c2";
    const w = world();
    await w.auth.signIn(GROQ.id, 0, KEY);
    await w.auth.signIn(THIRD.id, 0, `${KEY}-third`);
    await w.auth.signIn(SHARED.id, 0, `${KEY}-shared`);
    const refused = (await w.auth.signIn(GROQ.id, 0, `${KEY}\u200bbad`).catch((e: unknown) => e)) as Error;
    expect(refused).toBeInstanceOf(Error);
    for (const id of [GROQ.id, THIRD.id, SHARED.id]) { await w.auth.list(id); await w.auth.signOut(id, 0); }
    const seen = JSON.stringify({ events: w.events, logs: w.logs, refreshed: w.refreshed, refused: refused.message, lists: await Promise.all([GROQ.id, THIRD.id, SHARED.id].map((id) => w.auth.list(id))) });
    expect(seen).not.toContain("SENTINEL");
    expect(w.events.length).toBeGreaterThan(0);
  });

  test("a third party's sign-out stops live sessions using the key: its sessions are replaced, and the keyed fetch finds no key at its next request", async () => {
    const w = world();
    const api = secretStoreCredentials(w.pluginSecrets);
    await w.auth.signIn(THIRD.id, 0, "third-key");
    expect(await api.secret(THIRD.id, "key")).toBe("third-key");
    expect((await api.tokens(THIRD.id, "key").current())?.value).toBe("third-key");
    w.refreshed.length = 0;
    await w.auth.signOut(THIRD.id, 0);
    expect(w.refreshed).toEqual(["acme"]);
    expect(await api.secret(THIRD.id, "key")).toBeUndefined();
    expect(await api.tokens(THIRD.id, "key").current()).toBeNull();
  });

  test("custom: the plugin's handler names the core's xAI device flow, whose URL comes back and whose token lands in the slot", async () => {
    const w = world({
      invoke: (req) => (req.handler === "signIn" ? { flow: "core", id: "xai-device" } : undefined),
      xaiDevice: async (store, onUrl) => {
        onUrl("https://accounts.x.ai/device?user_code=ABCD");
        await store.set({ kind: "keychain", account: "xai-oauth:someone" }, { kind: "oauth", accessToken: "xat", refreshToken: "xrt", expiresAt: 9e12 });
      },
    });
    expect(await w.auth.signIn(XAI.id, 0)).toEqual({ state: "refreshing", authorizeUrl: "https://accounts.x.ai/device?user_code=ABCD" });
    await settle(); await settle();
    expect(await readCredentialMaterial(w.secrets, modelPluginSlotFor("xai-oauth").account)).toMatchObject({ kind: "oauth", accessToken: "xat" });
    expect((await w.auth.list(XAI.id))[0]!.state).toBe("signed-in");
  });

  test("a custom handler that names no core flow is refused", async () => {
    const w = world({ invoke: () => ({ something: "else" }) });
    await expect(w.auth.signIn(XAI.id, 0)).rejects.toThrow(/names no sign-in flow/);
  });

  test("signing in and out is the user's alone; anyone may list", async () => {
    const w = world();
    const m = pluginAuthMethods(w.auth);
    const asSession = { caller: { kind: "session", sessionId: "s1", sessionKind: "bot" } as never };
    const asUser = { caller: { kind: "user", client: "app" } as never };
    await expect(m["plugin.auth.signIn"]!({ id: GROQ.id, index: 0, key: "k" }, asSession)).rejects.toThrow(/only the user/);
    await expect(m["plugin.auth.signOut"]!({ id: GROQ.id, index: 0 }, asSession)).rejects.toThrow(/only the user/);
    expect(await m["plugin.auth.signIn"]!({ id: GROQ.id, index: 0, key: "k" }, asUser)).toEqual({ state: "signed-in" });
    expect(await m["plugin.auth.list"]!({ id: GROQ.id }, asSession)).toEqual({ auth: [{ index: 0, method: "api-key", secret: "api-key", state: "signed-in" }] });
    expect(await m["plugin.auth.signOut"]!({ id: GROQ.id, index: 0 }, asUser)).toEqual({ ok: true });
  });
});
