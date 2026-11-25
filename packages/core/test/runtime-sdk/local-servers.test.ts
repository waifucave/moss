// A local server the person HAS is one that answers (the controller's ruling, 2026-11-24): asked on demand only, at a
// loopback endpoint unless the person typed it, at most 1.5 s, the answer kept 30 s. No socket opens here: the ask is
// a fake, and the clock is ours.
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import { catalogModelListings } from "../../src/runtime-sdk/models-list";
import { chatModels, EMBEDDING_ID_MARKS, isLoopbackUrl, isLocalServerProvider, LOCAL_SERVER_TIMEOUT_MS, localModelOffer, localRecommendation, localServerEndpoints, LocalServers, setLocalServers, type LocalServerAnswer, type LocalServerEndpoint } from "../../src/runtime-sdk/model-plugins/local-servers";
import { modelOffer } from "../../src/runtime-sdk/models-list";
import { isRetiredCatalogTag } from "../../src/providers/catalog-role-problems";
import { buildMossOptions, type MossOptionsInput } from "../../src/runtime-sdk/mode-options";
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

  test("a failed ask is kept 5 s, not 30: a server started just after is seen at the next ask past that", async () => {
    let up = false;
    const r = rig([OLLAMA], () => (up ? { models: [{ id: "qwen3:8b" }] } : undefined));
    await r.servers.refresh();
    expect([...r.servers.silent()]).toEqual(["ollama-local"]);
    up = true;
    r.advance(4_000);
    await r.servers.refresh();
    expect(r.asked.length).toBe(1);
    r.advance(1_000);
    await r.servers.refresh();
    expect(r.asked.length).toBe(2);
    expect([...r.servers.answers().keys()]).toEqual(["ollama-local"]);
    expect(r.servers.silent().size).toBe(0);
  });

  test("an explicit re-ask (force) asks again, at most once a second per server", async () => {
    const r = rig([OLLAMA], () => ({ models: [{ id: "qwen3:8b" }] }));
    await r.servers.refresh({ force: true });
    await r.servers.refresh({ force: true });
    expect(r.asked.length).toBe(1);
    r.advance(999);
    await r.servers.refresh({ force: true });
    expect(r.asked.length).toBe(1);
    r.advance(1);
    await r.servers.refresh({ force: true });
    expect(r.asked.length).toBe(2);
    // Without force, the 30 s answer stands.
    r.advance(5_000);
    await r.servers.refresh();
    expect(r.asked.length).toBe(2);
  });

  test("a declared endpoint off this computer is never asked; one the person typed is", async () => {
    for (const url of ["http://127.0.0.1:11434/v1", "http://127.8.9.10:1/v1", "http://localhost:1234/v1", "http://[::1]:8080/v1"]) expect({ url, loopback: isLoopbackUrl(url) }).toEqual({ url, loopback: true });
    for (const url of ["http://192.168.1.20:11434/v1", "https://example.com/v1", "http://127.0.0.1.example.com/v1", "http://10.0.0.1/v1", "not a url",
      // Forms a parser rewrites into a loopback address, and a user name or password: refused.
      "http://127.1/v1", "http://[::ffff:127.0.0.1]:11434/v1", "http://0x7f.0.0.1/v1", "http://2130706433/v1", "http://user@127.0.0.1:11434/v1", "http://u:p@localhost/v1", "file:///tmp/x"]) expect({ url, loopback: isLoopbackUrl(url) }).toEqual({ url, loopback: false });
    const lan: LocalServerEndpoint = { provider: "ollama-local", baseUrl: "http://192.168.1.20:11434/v1", personSet: false };
    const r = rig([lan], () => ({ models: [{ id: "x" }] }));
    await r.servers.refresh();
    expect(r.asked).toEqual([]);
    expect(r.servers.answers().size).toBe(0);
    const typed = rig([{ ...lan, personSet: true }], () => ({ models: [{ id: "x" }] }));
    await typed.servers.refresh();
    expect(typed.asked.map((a) => a.provider)).toEqual(["ollama-local"]);
  });

  test("the daemon's endpoint builder: the person's endpoint, else the plugin's; a declared one off this computer is never asked", async () => {
    const served = [
      ["ollama-local", { input: { entry: { endpoint: { baseUrl: "http://192.168.1.20:11434/v1" } } } }],
      ["lm-studio", { input: { entry: { endpoint: { baseUrl: "http://127.0.0.1:1234/v1" } } } }],
      ["anthropic", { input: { entry: {} } }],
    ] as const;
    expect(localServerEndpoints(catalog, served, () => undefined)).toEqual([
      { provider: "ollama-local", baseUrl: "http://192.168.1.20:11434/v1", personSet: false },
      { provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1", personSet: false },
    ]);
    const asked: string[] = [];
    const servers = new LocalServers({ endpoints: () => localServerEndpoints(catalog, served, () => undefined), list: async (e) => { asked.push(e.baseUrl); return { models: [] }; } });
    await servers.refresh();
    expect(asked).toEqual(["http://127.0.0.1:1234/v1"]);
    // The person's own endpoint is asked wherever it is.
    expect(localServerEndpoints(catalog, served, (p) => (p === "ollama-local" ? "http://10.0.0.5:11434/v1" : undefined))[0]).toEqual({ provider: "ollama-local", baseUrl: "http://10.0.0.5:11434/v1", personSet: true });
  });

  test("a model that can't chat is never the default nor counted: the embedding marks, by name", () => {
    expect(EMBEDDING_ID_MARKS.map(String)).toEqual(["/embed/i", "/minilm/i", "/(^|[/:-])bge-/i", "/(^|[/:-])e5-/i", "/(^|[/:-])gte-/i"]);
    // Each embedding family by name: none can chat.
    const embeddings = ["nomic-embed-text", "mxbai-embed-large", "snowflake-arctic-embed:l", "all-minilm", "all-minilm:l6-v2", "paraphrase-multilingual-minilm", "bge-m3", "BAAI/bge-large-en", "e5-large-v2", "intfloat/multilingual-e5-small", "multilingual-e5-large", "gte-qwen2", "thenlper/gte-base", "granite-embedding:30m"];
    for (const id of embeddings) expect({ id, chat: chatModels({ models: [{ id }] }).length === 1 }).toEqual({ id, chat: false });
    // Chat models are never hidden, those with e5 or gte inside a word included.
    const chats = ["qwen3:8b", "llama3.2", "gemma3:12b", "mistral-small3.2", "deepseek-r1:14b", "phi4-mini", "gpt-oss:20b", "qwen2.5-coder:7b", "smollm2:1.7b", "huge5-chat", "together-7b"];
    for (const id of chats) expect({ id, chat: chatModels({ models: [{ id }] }).length === 1 }).toEqual({ id, chat: true });
    const answer = { models: [{ id: "nomic-embed-text" }, { id: "mxbai-embed-large" }, { id: "bge-m3" }, { id: "e5-large-v2" }, { id: "qwen3:8b" }, { id: "llama3.2" }] };
    expect(chatModels(answer).map((m) => m.id)).toEqual(["qwen3:8b", "llama3.2"]);
    expect(localRecommendation("ollama-local", new Map([["ollama-local", answer]]))).toEqual({ model: "ollama-local/qwen3:8b" });
    expect(localRecommendation("ollama-local", new Map([["ollama-local", { models: [{ id: "nomic-embed-text" }] }]]))).toBeUndefined();
    const listed = catalogModelListings(catalog, new Set(), new Map([["ollama-local", answer]]));
    expect(listed.filter((m) => m.provider === "ollama-local").map((m) => m.id)).toEqual(["ollama-local/qwen3:8b", "ollama-local/llama3.2"]);
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

describe("a local server's model past the cache time (the review's blocker)", () => {
  test("offered unless its server was asked and found silent; never refused on an expired answer; a cloud model as before", async () => {
    const r = rig([OLLAMA], () => ({ models: [{ id: "qwen3:8b" }] }));
    setLocalServers(r.servers);
    try {
      const offer = (m: string) => modelOffer(m, { catalog, settling: false, contributed: () => [] });
      expect(offer("ollama-local/qwen3:8b")).toBe("offered"); // never asked
      await r.servers.refresh();
      r.advance(31_000); // expired
      expect(offer("ollama-local/qwen3:8b")).toBe("offered");
      expect(localModelOffer(catalog, "anthropic/claude-opus-5-5")).toBeUndefined();
      // An empty id after the slash names no model.
      expect(localModelOffer(catalog, "ollama-local/")).toBe("absent");
      expect(offer("ollama-local/")).toBe("absent");
      expect(offer("acme/none")).toBe("absent");
    } finally {
      setLocalServers(undefined);
    }
    const silent = rig([OLLAMA], () => undefined);
    setLocalServers(silent.servers);
    try {
      await silent.servers.refresh();
      expect(modelOffer("ollama-local/qwen3:8b", { catalog, settling: false, contributed: () => [] })).toBe("not-running");
    } finally {
      setLocalServers(undefined);
    }
  });

  test("setup's setDefault asks again first: past the cache time it holds while the server answers, and says it isn't running when silent", async () => {
    let up = true;
    const r = rig([OLLAMA], () => (up ? { models: [{ id: "qwen3:8b" }] } : undefined));
    setLocalServers(r.servers);
    try {
      const written: string[] = [];
      const s = new SetupService({
        readPresent: () => readProviders({ presence: async () => ({ byProvider: {} }), auth: () => undefined, local: () => r.servers.answers() }),
        askLocal: (o) => r.servers.refresh(o),
        storedModel: () => written.at(-1), storedEffort: () => undefined,
        recommend: (p) => localRecommendation(p, r.servers.answers()), effortFor: () => undefined,
        writeModel: (m) => { written.push(m); }, clearModel: () => {}, dismissed: () => false, writeDismissed: () => {},
        offered: (m) => { const l = localModelOffer(catalog, m); return l === undefined || l === "absent" ? false : l === "offered" ? true : "not-running"; },
        emit: () => {}, log: () => {},
      });
      await s.ask();
      r.advance(31_000);
      await s.setDefault("ollama-local/qwen3:8b");
      expect(written.at(-1)).toBe("ollama-local/qwen3:8b");
      up = false;
      r.advance(31_000);
      await expect(s.setDefault("ollama-local/qwen3:8b")).rejects.toThrow("isn't running");
    } finally {
      setLocalServers(undefined);
    }
  });
});

describe("a local server's own model names reach its runtime; a cloud provider's never", () => {
  const input = (model: string): MossOptionsInput => ({
    mode: "chat", policy: "ask", sessionId: "11111111-2222-3333-4444-555555555555", home: "/tmp/moss-home", cwd: "/repo",
    credentials: { byProvider: {} }, spawn: { pathToClaudeCodeExecutable: "/opt/winter" },
    canUseTool: (async () => ({ behavior: "allow" as const })) as never, abort: new AbortController(), baseEnv: { PATH: "/usr/bin" },
    model: model as MossOptionsInput["model"],
  });
  test("buildMossOptions: allowUnlisted for ollama-local only", () => {
    expect((buildMossOptions(input("ollama-local/qwen3:8b")).provider as { allowUnlisted?: boolean }).allowUnlisted).toBe(true);
    expect((buildMossOptions(input("openai/gpt-6-luna")).provider as { allowUnlisted?: boolean }).allowUnlisted).toBeUndefined();
  });
  test("isRetiredCatalogTag: a local server's live model is never retired; a cloud tag the catalog lacks is", () => {
    expect(isRetiredCatalogTag("ollama-local/qwen3:8b")).toBe(false);
    expect(isRetiredCatalogTag("lm-studio/google/gemma-4-26b-a4b")).toBe(false);
    expect(isRetiredCatalogTag("openai/gpt-0-not-a-model")).toBe(true);
  });
});
