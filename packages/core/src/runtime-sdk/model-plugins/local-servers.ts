// A local server the person HAS (the controller's ruling, 2026-11-24): a local-server provider (the catalog's
// `local-none`: Ollama, LM Studio, llama.cpp, ...) counts as one the person has exactly when it answers. MOSS asks it for
// its models through the agent SDK's local adapter (`createLocalOpenAIAdapter`'s `listModels`, under `discoverModels`'
// bounds and validation) at the endpoint its plugin declares or the person set (`providers.<id>.baseUrl`).
//
// * LOOPBACK ONLY: a declared endpoint that is not 127.0.0.0/8, `::1` or `localhost` is never asked; an endpoint the
//   person typed themselves is asked wherever it is.
// * ON DEMAND ONLY: `refresh()` asks, and only when something asks for an answer (the setup state, the model list, the
//   provider page, a session on a local model). Nothing here polls: an idle engine makes no call.
// * At most `timeoutMs` (1.5 s) per server, all servers at once; each answer is kept `ttlMs` (30 s), and asks while one
//   runs share it. A server that stops answering stops counting within that time.
// * `answers()` is the last answer, synchronously, for the readers that cannot wait (`keylessProviders`).
// Model ids and names a server returns are untrusted: `discoverModels` bounds and validates them.
import type { WinterCatalog } from "@waifucave/clover-provider-catalog";
import { createLocalOpenAIAdapter, createMemoryCredentialStore, discoverModels } from "@waifucave/clover-provider-runtime";

/** A local server that answered: its models (ids as the server names them), in its own order. */
export interface LocalServerAnswer {
  models: { id: string; name?: string }[];
}

/** Where a local-server provider is asked, and whether the person set that endpoint. */
export interface LocalServerEndpoint {
  provider: string;
  baseUrl: string;
  personSet: boolean;
}

export type ListLocalModels = (endpoint: LocalServerEndpoint, timeoutMs: number) => Promise<LocalServerAnswer>;

export interface LocalServersOptions {
  /** Every local-server provider a plugin that is on serves, with its endpoint (read at each refresh). */
  endpoints(): LocalServerEndpoint[];
  /** Test seam: the ask. The SDK's local adapter by default. */
  list?: ListLocalModels;
  now?(): number;
  ttlMs?: number;
  timeoutMs?: number;
}

export const LOCAL_SERVER_TTL_MS = 30_000;
export const LOCAL_SERVER_TIMEOUT_MS = 1_500;
const MAX_MODELS = 500;

/** Whether a URL names this computer: 127.0.0.0/8, `::1` or `localhost`. Anything unparseable is not. */
export function isLoopbackUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Whether a provider is a local server by the catalog: its auth kinds hold `local-none`. */
export function isLocalServerProvider(catalog: Pick<WinterCatalog, "providers">, providerId: string): boolean {
  return (catalog.providers.find((p) => p.id === providerId)?.authKinds ?? []).includes("local-none");
}

/** The SDK's local adapter, asked for its models with no credential, under `timeoutMs`. */
export const sdkListLocalModels: ListLocalModels = async (endpoint, timeoutMs) => {
  const adapter = createLocalOpenAIAdapter({ headerTimeoutMs: timeoutMs });
  const result = await discoverModels(adapter, {
    connection: { providerId: endpoint.provider, baseUrl: endpoint.baseUrl, local: true, endpointOrigin: endpoint.personSet ? "user" : "reviewed" },
    credentials: createMemoryCredentialStore(),
    authRef: { kind: "none" },
    stallTimeoutMs: timeoutMs,
    log: () => {},
    signal: AbortSignal.timeout(timeoutMs),
    limits: { maxBytes: 1024 * 1024, maxItems: MAX_MODELS, timeoutMs },
  });
  return { models: result.models.map((m) => ({ id: m.id, ...(m.displayName !== undefined ? { name: m.displayName } : {}) })) };
};

interface Entry {
  at: number;
  answer: LocalServerAnswer | undefined;
}

export class LocalServers {
  readonly #o: LocalServersOptions;
  readonly #entries = new Map<string, Entry>();
  #running: Promise<void> | undefined;

  constructor(o: LocalServersOptions) {
    this.#o = o;
  }

  get #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  /** The endpoints MOSS may ask: a declared one only on this computer, one the person set wherever it is. */
  askable(): LocalServerEndpoint[] {
    return this.#o.endpoints().filter((e) => e.personSet || isLoopbackUrl(e.baseUrl));
  }

  /** Asks every local server whose answer is older than the cache time (or never asked), and waits for them. */
  refresh(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    const ttl = this.#o.ttlMs ?? LOCAL_SERVER_TTL_MS;
    const now = this.#now;
    const endpoints = this.askable();
    const known = new Set(endpoints.map((e) => e.provider));
    for (const p of [...this.#entries.keys()]) if (!known.has(p)) this.#entries.delete(p);
    const stale = endpoints.filter((e) => {
      const entry = this.#entries.get(e.provider);
      return entry === undefined || now - entry.at >= ttl;
    });
    if (stale.length === 0) return Promise.resolve();
    const list = this.#o.list ?? sdkListLocalModels;
    const timeout = Math.min(this.#o.timeoutMs ?? LOCAL_SERVER_TIMEOUT_MS, LOCAL_SERVER_TIMEOUT_MS);
    this.#running = Promise.all(stale.map(async (e) => {
      const answer = await list(e, timeout).then((a) => ({ models: a.models.slice(0, MAX_MODELS) }), () => undefined);
      this.#entries.set(e.provider, { at: this.#now, answer });
    })).then(() => undefined).finally(() => { this.#running = undefined; });
    return this.#running;
  }

  /** The servers that answered at their last ask (within the cache time), synchronously; asks nothing. */
  answers(): ReadonlyMap<string, LocalServerAnswer> {
    const ttl = this.#o.ttlMs ?? LOCAL_SERVER_TTL_MS;
    const now = this.#now;
    const askable = new Set(this.askable().map((e) => e.provider));
    const out = new Map<string, LocalServerAnswer>();
    for (const [p, entry] of this.#entries) if (entry.answer !== undefined && now - entry.at < ttl && askable.has(p)) out.set(p, entry.answer);
    return out;
  }

  /** The servers asked within the cache time that did NOT answer: known not running now. A server never asked (or asked
   *  longer ago) is unknown, so a default named on it keeps working until the next ask says otherwise. */
  silent(): ReadonlySet<string> {
    const ttl = this.#o.ttlMs ?? LOCAL_SERVER_TTL_MS;
    const now = this.#now;
    const out = new Set<string>();
    for (const [p, entry] of this.#entries) if (entry.answer === undefined && now - entry.at < ttl) out.add(p);
    return out;
  }

  /** `refresh()`, then `answers()`. */
  async ask(): Promise<ReadonlyMap<string, LocalServerAnswer>> {
    await this.refresh();
    return this.answers();
  }
}

let installed: LocalServers | undefined;

/** The engine's one prober (the daemon sets it at boot); none in a test that sets none. */
export function setLocalServers(servers: LocalServers | undefined): void {
  installed = servers;
}

export function localServers(): LocalServers | undefined {
  return installed;
}

/** A local server's recommended default: the first model it lists (its listing says nothing of tool use), or none. */
export function localRecommendation(provider: string, answers: ReadonlyMap<string, LocalServerAnswer> | undefined): { model: string } | undefined {
  const first = answers?.get(provider)?.models[0];
  return first === undefined ? undefined : { model: `${provider}/${first.id}` };
}
