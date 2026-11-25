// A local server the person HAS (the controller's ruling, 2026-11-24): a local-server provider (the catalog's
// `local-none`: Ollama, LM Studio, llama.cpp, ...) counts as one the person has exactly when it answers. MOSS asks it for
// its models through the agent SDK's local adapter (`createLocalOpenAIAdapter`'s `listModels`, under `discoverModels`'
// bounds and validation) at the endpoint its plugin declares or the person set (`providers.<id>.baseUrl`).
//
// * LOOPBACK ONLY: a declared endpoint that is not 127.0.0.0/8, `::1` or `localhost` is never asked; an endpoint the
//   person typed themselves is asked wherever it is.
// * ON DEMAND ONLY: `refresh()` asks, and only when something asks for an answer (the setup state, the model list, the
//   provider page, a session on a local model). Nothing here polls: an idle engine makes no call.
// * At most `timeoutMs` (1.5 s) per server, all servers at once; an answer is kept `ttlMs` (30 s), a failed ask only
//   `failureTtlMs` (5 s), so a server started just after is seen at the next ask; asks while one runs share it. An
//   explicit re-ask (`refresh({ force: true })`: the guide's and the provider page's) asks again at most once a second
//   per server. A server that stops answering stops counting within the cache time.
// * A model that can't chat (an embedding model, which Ollama's `/v1/models` lists too) is never a default and never
//   counts as one to use (`chatModels`).
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
  failureTtlMs?: number;
  timeoutMs?: number;
}

export const LOCAL_SERVER_TTL_MS = 30_000;
export const LOCAL_SERVER_FAILURE_TTL_MS = 5_000;
/** The least time between two asks of one server, a forced re-ask included. */
export const LOCAL_SERVER_MIN_GAP_MS = 1_000;
export const LOCAL_SERVER_TIMEOUT_MS = 1_500;
const MAX_MODELS = 500;

/** Whether a URL names this computer: 127.0.0.0/8 written as four decimal parts, `[::1]` or `localhost`. Anything
 *  unparseable is not, nor a URL with a user name or password, nor a host the parser had to rewrite (`127.1`, hex or octal
 *  parts, `[::ffff:127.0.0.1]`): the host as written must be the host as parsed. */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  let host = url.hostname.toLowerCase();
  const written = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1]?.toLowerCase().replace(/:\d*$/, "");
  if (written !== host) return false;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Whether a provider is a local server by the catalog: its auth kinds hold `local-none`. */
export function isLocalServerProvider(catalog: Pick<WinterCatalog, "providers">, providerId: string): boolean {
  return (catalog.providers.find((p) => p.id === providerId)?.authKinds ?? []).includes("local-none");
}

/** The endpoints to ask, from the model plugins that are on: each local-server provider's, the one the person set
 *  (`providers.<id>.baseUrl`, `personSet`) else the one its plugin declares. `askable()` then holds a declared one to
 *  this computer. */
export function localServerEndpoints(
  catalog: Pick<WinterCatalog, "providers">,
  served: Iterable<readonly [string, { input: { entry: unknown } }]>,
  personSetFor: (provider: string) => string | undefined,
): LocalServerEndpoint[] {
  const out: LocalServerEndpoint[] = [];
  for (const [provider, e] of served) {
    if (!isLocalServerProvider(catalog, provider)) continue;
    const personSet = personSetFor(provider);
    const declared = (e.input.entry as { endpoint?: { baseUrl?: unknown } }).endpoint?.baseUrl;
    const baseUrl = personSet ?? (typeof declared === "string" ? declared : undefined);
    if (baseUrl !== undefined) out.push({ provider, baseUrl, personSet: personSet !== undefined });
  }
  return out;
}

/** The SDK's local adapter, asked for its models with no credential, under `timeoutMs`. */
export const sdkListLocalModels: ListLocalModels = async (endpoint, timeoutMs) => {
  // Listing models reads no row: the adapter's descriptor lookup knows none here.
  const adapter = createLocalOpenAIAdapter({ headerTimeoutMs: timeoutMs, descriptors: () => undefined });
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

/** Ids that plainly name an embedding model, which can't chat: kept short, each named in a test. `embed` covers
 *  `nomic-embed`, `mxbai-embed` and `snowflake-arctic-embed`; `minilm` covers `all-minilm`; `e5-` is matched at a word's
 *  start (`e5-large`, `multilingual-e5-small`), never inside one. A chat model whose id merely contains `embed` is the
 *  accepted false positive: it is left out of the list and the default, and the person can still name it. */
export const EMBEDDING_ID_MARKS: readonly RegExp[] = [/embed/i, /minilm/i, /(^|[/:-])bge-/i, /(^|[/:-])e5-/i, /(^|[/:-])gte-/i];

/** The models of an answer that can chat: an id that plainly names an embedding model is left out (the listing says
 *  nothing else of what a model does). */
export function chatModels(answer: LocalServerAnswer | undefined): LocalServerAnswer["models"] {
  return (answer?.models ?? []).filter((m) => !EMBEDDING_ID_MARKS.some((re) => re.test(m.id)));
}

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

  /** How long an entry is good for: an answer the cache time, a failed ask a few seconds. */
  #ttlOf(entry: Entry): number {
    return entry.answer === undefined ? (this.#o.failureTtlMs ?? LOCAL_SERVER_FAILURE_TTL_MS) : (this.#o.ttlMs ?? LOCAL_SERVER_TTL_MS);
  }

  /** Asks every local server whose entry is out of date (or never asked), and waits for them. `force` (an explicit
   *  re-ask): every server not asked within the last second. */
  refresh(opts: { force?: boolean } = {}): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    const now = this.#now;
    const endpoints = this.askable();
    const known = new Set(endpoints.map((e) => e.provider));
    for (const p of [...this.#entries.keys()]) if (!known.has(p)) this.#entries.delete(p);
    const stale = endpoints.filter((e) => {
      const entry = this.#entries.get(e.provider);
      if (entry === undefined) return true;
      const age = now - entry.at;
      return age >= this.#ttlOf(entry) || (opts.force === true && age >= LOCAL_SERVER_MIN_GAP_MS);
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
    const now = this.#now;
    const out = new Set<string>();
    for (const [p, entry] of this.#entries) if (entry.answer === undefined && now - entry.at < this.#ttlOf(entry)) out.add(p);
    return out;
  }

  /** `refresh()`, then `answers()`. */
  async ask(opts: { force?: boolean } = {}): Promise<ReadonlyMap<string, LocalServerAnswer>> {
    await this.refresh(opts);
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

/** A local server's recommended default: the first model it lists that can chat (its listing says nothing of tool
 *  use), or none. */
export function localRecommendation(provider: string, answers: ReadonlyMap<string, LocalServerAnswer> | undefined): { model: string } | undefined {
  const first = chatModels(answers?.get(provider))[0];
  return first === undefined ? undefined : { model: `${provider}/${first.id}` };
}

/** Whether a model can be picked by what MOSS knows of its local server now: `offered` unless that server was asked and
 *  found silent (`not-running`); never refused on an answer that merely expired. Undefined for a model that isn't on a
 *  local server, or with no prober. */
export function localModelOffer(catalog: Pick<WinterCatalog, "providers">, model: string): "offered" | "not-running" | "absent" | undefined {
  const servers = localServers();
  const slash = model.indexOf("/");
  if (servers === undefined || slash <= 0) return undefined;
  const provider = model.slice(0, slash);
  if (!isLocalServerProvider(catalog, provider)) return undefined;
  // An empty model id after the slash names no model at all.
  if (model.length === slash + 1) return "absent";
  return servers.silent().has(provider) ? "not-running" : "offered";
}

/** The words for a model whose local server isn't running. */
export function notRunningReason(model: string): string {
  const provider = model.slice(0, Math.max(0, model.indexOf("/")));
  return `${model} is on ${provider}, which isn't running: start it, then try again`;
}
