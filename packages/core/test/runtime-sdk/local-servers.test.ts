// A local server the person HAS is one that answers (the controller's ruling, 2026-11-24): asked on demand only, at a
// loopback endpoint unless the person typed it, at most 1.5 s, the answer kept 30 s. No socket opens here: the ask is
// a fake, and the clock is ours.
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import { catalogModelListings } from "../../src/runtime-sdk/models-list";
import { isLoopbackUrl, isLocalServerProvider, LOCAL_SERVER_TIMEOUT_MS, localRecommendation, LocalServers, type LocalServerAnswer, type LocalServerEndpoint } from "../../src/runtime-sdk/model-plugins/local-servers";
import { readProviders, SetupService } from "../../src/setup-state";
import { recommended } from "../../src/default-model";

const catalog = loadCatalog();
const OLLAMA: LocalServerEndpoint = { provider: "ollama-local", baseUrl: "http://127.0.0.1:11434/v1", personSet: false };
const LM: LocalServerEndpoint = { provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1", personSet: false };

function rig(endpoints: LocalServerEndpoint[], serve: (e: LocalServerEndpoint) => LocalServerAnswer | undefined) {
  let now = 1_000_000;
  const asked: { provider: string; timeoutMs: number }[] = [];
  const servers = new LocalServers({
    endpoints: () => endpoints,
    now: () => now,
    list: async (e, timeoutMs) => {
      asked.push({ provider: e.provider, timeoutMs });
      const a = serve(e);
      if (a === undefined) throw new Error("connection refused");
      return a;
    },
  });
  return { servers, asked, advance: (ms: number) => { now += ms; } };
}

describe("the prober", () => {
  test("the catalog's local servers are local-none providers", () => {
    expect(isLocalServerProvider(catalog, "ollama-local")).toBe(true);
    expect(isLocalServerProvider(catalog, "lm-studio")).toBe(true);
    expect(isLocalServerProvider(catalog, "anthropic")).toBe(false);
  });

  test("no call is made while nothing asks", async () => {
    const r = rig([OLLAMA, LM], () => ({ models: [{ id: "qwen3:8b" }] }));
    expect(r.servers.answers().size).toBe(0);
    expect(r.servers.silent().size).toBe(0);
    expect(r.asked).toEqual([]);
    await r.servers.refresh();
    expect(r.asked.map((a) => a.provider).sort()).toEqual(["lm-studio", "ollama-local"]);
    expect(r.asked.every((a) => a.timeoutMs <= LOCAL_SERVER_TIMEOUT_MS && LOCAL_SERVER_TIMEOUT_MS === 1_500)).toBe(true);
  });

  test("an answer is kept 30 s: asks within it make no call; asks at once share one", async () => {
    const r = rig([OLLAMA], () => ({ models: [{ id: "qwen3:8b" }] }));
    await Promise.all([r.servers.refresh(), r.servers.refresh(), r.servers.refresh()]);
    expect(r.asked.length).toBe(1);
    r.advance(29_000);
    await r.servers.refresh();
    expect(r.asked.length).toBe(1);
    r.advance(1_000);
    await r.servers.refresh();
    expect(r.asked.length).toBe(2);
  });

  test("a server that stops answering stops counting within the cache time", async () => {
    let up = true;
    const r = rig([OLLAMA], () => (up ? { models: [{ id: "qwen3:8b" }] } : undefined));
    expect([...(await r.servers.ask()).keys()]).toEqual(["ollama-local"]);
    up = false;
    r.advance(30_000);
    // Not asked again yet: its old answer has expired, so it counts no more.
    expect(r.servers.answers().size).toBe(0);
    await r.servers.refresh();
    expect(r.servers.answers().size).toBe(0);
    expect([...r.servers.silent()]).toEqual(["ollama-local"]);
  });

  test("a declared endpoint off this computer is never asked; one the person typed is", async () => {
    for (const url of ["http://127.0.0.1:11434/v1", "http://127.8.9.10:1/v1", "http://localhost:1234/v1", "http://[::1]:8080/v1"]) expect({ url, loopback: isLoopbackUrl(url) }).toEqual({ url, loopback: true });
    for (const url of ["http://192.168.1.20:11434/v1", "https://example.com/v1", "http://127.0.0.1.example.com/v1", "http://10.0.0.1/v1", "not a url"]) expect({ url, loopback: isLoopbackUrl(url) }).toEqual({ url, loopback: false });
    const lan: LocalServerEndpoint = { provider: "ollama-local", baseUrl: "http://192.168.1.20:11434/v1", personSet: false };
    const r = rig([lan], () => ({ models: [{ id: "x" }] }));
    await r.servers.refresh();
    expect(r.asked).toEqual([]);
    expect(r.servers.answers().size).toBe(0);
    const typed = rig([{ ...lan, personSet: true }], () => ({ models: [{ id: "x" }] }));
    await typed.servers.refresh();
    expect(typed.asked.map((a) => a.provider)).toEqual(["ollama-local"]);
  });

  test("a local server's default is the first model it lists; none listed, none", () => {
    expect(localRecommendation("ollama-local", new Map([["ollama-local", { models: [{ id: "qwen3:8b" }, { id: "llama3.2" }] }]]))).toEqual({ model: "ollama-local/qwen3:8b" });
    expect(localRecommendation("ollama-local", new Map([["ollama-local", { models: [] }]]))).toBeUndefined();
    expect(localRecommendation("ollama-local", undefined)).toBeUndefined();
  });
});

describe("the model list: a local server's live models replace its catalog rows", () => {
  test("only Ollama answers: its live models, signed in; LM Studio and the static Ollama row are not offered", () => {
    const listed = catalogModelListings(catalog, new Set(), new Map([["ollama-local", { models: [{ id: "qwen3:8b", name: "qwen3:8b" }, { id: "gemma3" }] }]]));
    const local = listed.filter((m) => m.provider === "ollama-local" || m.provider === "lm-studio");
    expect(local.map((m) => [m.id, m.signedIn])).toEqual([["ollama-local/qwen3:8b", true], ["ollama-local/gemma3", true]]);
    expect(listed.some((m) => m.id === "ollama-local/llama3.1:8b")).toBe(false);
  });
  test("nothing answers: no local server's model is offered (a fresh install)", () => {
    const listed = catalogModelListings(catalog, new Set(), new Map());
    expect(listed.filter((m) => isLocalServerProvider(catalog, m.provider))).toEqual([]);
  });
});

describe("setup: a local server that answers is a provider the person has", () => {
  function service(answers: ReadonlyMap<string, LocalServerAnswer>) {
    const written: string[] = [];
    let stored: string | undefined;
    const s = new SetupService({
      readPresent: () => readProviders({
        presence: async () => ({ byProvider: {} }),
        auth: () => ({ signedInProviders: async () => new Set<string>(), keylessProviders: () => new Set<string>(), modelPluginsReady: () => true }),
        local: () => answers,
      }),
      storedModel: () => stored,
      storedEffort: () => undefined,
      recommend: (p) => recommended(catalog, p) ?? localRecommendation(p, answers),
      effortFor: () => undefined,
      writeModel: (m) => { stored = m; written.push(m); },
      clearModel: () => { stored = undefined; },
      dismissed: () => false,
      writeDismissed: () => {},
      offered: () => true,
      emit: () => {},
      log: () => {},
    });
    return { s, written };
  }

  test("only Ollama answers: one provider, a default set from what it serves", async () => {
    const { s, written } = service(new Map([["ollama-local", { models: [{ id: "qwen3:8b" }] }]]));
    const state = await s.refresh();
    expect(state.providers).toEqual(["ollama-local"]);
    expect(state.local).toEqual({ "ollama-local": 1 });
    expect(written).toEqual(["ollama-local/qwen3:8b"]);
    expect(state.default?.model).toBe("ollama-local/qwen3:8b");
    expect(state.missing).toEqual([]);
  });

  test("Ollama answers with no model: counted, said, and no default", async () => {
    const { s, written } = service(new Map([["ollama-local", { models: [] }]]));
    const state = await s.refresh();
    expect(state.providers).toEqual(["ollama-local"]);
    expect(state.local).toEqual({ "ollama-local": 0 });
    expect(written).toEqual([]);
    expect(state.default).toBeUndefined();
  });

  test("a fresh install where nothing answers: nothing counted", async () => {
    const { s } = service(new Map());
    const state = await s.refresh();
    expect(state.providers).toEqual([]);
    expect(state.missing).toContain("provider");
    expect(state.local).toBeUndefined();
  });

  test("setup.state asks the local servers first; a plain refresh (a key, a plugin change) asks nothing", async () => {
    let asks = 0;
    const s = new SetupService({
      readPresent: async () => ({ present: new Set(), complete: true }),
      askLocal: async () => { asks++; },
      storedModel: () => undefined, storedEffort: () => undefined, recommend: () => undefined, effortFor: () => undefined,
      writeModel: () => {}, clearModel: () => {}, dismissed: () => false, writeDismissed: () => {}, offered: () => true, emit: () => {}, log: () => {},
    });
    await s.refresh();
    expect(asks).toBe(0);
    await s.ask();
    expect(asks).toBe(1);
  });
});
