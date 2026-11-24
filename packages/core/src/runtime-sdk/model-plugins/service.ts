// The model plugins on this computer (spec §3.3, §5.3 `models`): every provider a session can use is an enabled
// model plugin's entry, loaded through the plugin registry and, for a code plugin, the plugin host (lane B's
// contracts; their fakes until B-M1 and B-M2). Owner: lane A.
//
// What it keeps, rebuilt whenever the registry changes:
// * the catalog of the enabled entries (`load.ts`), written to `<home>/run/models/catalog-<sha256>.json`, content-
//   addressed, which each session reads at its start (`Options.modelProviders.catalog`; a session's options carry the
//   path and the digest, never the megabytes);
// * for each code plugin, its adapter's identity (`describe`, asked once per load), so a session registers a stub
//   for it and its calls come back here (`sessionOption`'s `serve`), to run on the plugin through the plugin host.
// A code plugin whose adapter can't describe itself, or describes another id than its bundled catalog file names,
// is left out of the served set with the reason: its rows stay, and a turn on them refuses `no-adapter`, typed.
//
// The keys: a declarative provider's key reaches its session as today (the host credential broker, by provider
// slot); a code plugin's key never reaches a session at all. The plugin reaches its provider through the core's
// keyed fetch (`plugin-api.ts`), which reads it through `tokens`.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import type { HostServedAdapter, ModelProvidersOption } from "@waifucave/clover-agent-sdk";
import { createHostModelAdapterServer, createShippedAdapters, hostServedProviderAdapter, ProviderRequestError, type HostModelAdapter, type ModelAdapterDescription, type ProviderAdapter } from "@waifucave/clover-provider-runtime";
import { loadCatalog, type WinterCatalog } from "@waifucave/clover-provider-catalog";
import type { Clock, TimerHandle } from "../../contracts/clock";
import { isContractError, type Unsubscribe } from "../../contracts/common";
import type { PluginHost } from "../../contracts/plugin-host";
import type { PluginRegistry } from "../../contracts/plugin-registry";
import { describeModelAdapter, pluginHostModelAdapter } from "./host-adapter";
import { buildModelPluginSet, readModelPlugins, type ModelPluginSet } from "./load";
import { modelPluginId } from "./bundled";

/** A served code adapter: which plugin's handler it is, and who it says it is. */
export interface ServedModelAdapter {
  adapterId: string;
  pluginId: string;
  provider: string;
  handler: string;
  description: ModelAdapterDescription;
}

export interface ModelPluginRefusalView {
  pluginId: string;
  provider: string;
  code: string;
  message: string;
  /** Set on an adapter that didn't answer: it is asked again later. */
  retryable?: boolean;
}

class IdentityMismatch extends Error {}

export interface ModelPluginsOptions {
  registry: PluginRegistry;
  host: PluginHost;
  /** The MOSS home: the catalog file goes in `<home>/run/models/`. */
  home: string;
  /** After each rebuild (the daemon's: `modelCatalogMaybeChanged`, which tells the sessions when what they are given
   *  moved). */
  changed?: () => void;
  /** Fills what a code adapter reads off its connection beside the key (a sign-in's account id), per plugin. */
  connectionFor?: (pluginId: string, connection: HostModelAdapterContextConnection) => HostModelAdapterContextConnection | Promise<HostModelAdapterContextConnection>;
  readFile?: (path: string) => string;
  log?: (line: string) => void;
  /** The clock the retry of a left-out adapter waits on (a test's `FakeClock`); the machine's timers otherwise. */
  clock?: Clock;
  /** How long a code adapter has to describe itself, its plugin's start included. Default `DESCRIBE_LIMIT_MS`. */
  describeLimitMs?: number;
  /** When a left-out adapter is asked again after a build, in order (one entry per attempt). Default `DESCRIBE_RETRY_MS`. */
  retryAfterMs?: readonly number[];
  /** False when the plugin API can't carry a code plugin's keyed `net.fetch` (a host without `addApiHandlers`) or
   *  serving is turned off: no code adapter is served, so every code provider stays on the compiled path
   *  (`mergeWithCompiled`). */
  serveCodeAdapters?: boolean;
}

type HostModelAdapterContextConnection = Parameters<HostModelAdapter["validateCredential"]>[0]["connection"];

export interface ModelPluginsSnapshot {
  set: ModelPluginSet;
  /** Whether the merged catalog overrides the SDK's own (a model plugin is on, or one was turned off). */
  override: boolean;
  catalogPath: string;
  catalogSha256: string;
  served: Map<string, ServedModelAdapter>;
  refused: ModelPluginRefusalView[];
}

/** This build's own adapter ids: a provider whose code adapter isn't served stays on one of these (the agent SDK
 *  registers it for a host-catalog provider, 0.0.75). */
const COMPILED_ADAPTER_IDS: ReadonlySet<string> = new Set(createShippedAdapters(loadCatalog()).map((a) => a.id));

/**
 * What a session on `provider` is given, as one string: its catalog entry and rows (hashed) and how its adapter is
 * served (`host:<adapter>@<version>` by its plugin through the plugin host, `compiled:<adapter>` this build's own,
 * `generic:<adapter>` a declarative provider's generic one), or `absent` when the catalog has no such provider. A
 * session is replaced or reopened only when its own provider's key changes, so another plugin's install, update or
 * restart leaves it alone.
 */
export function providerKeyIn(catalog: WinterCatalog, provider: string, served: ReadonlyMap<string, { provider: string; description: { version: string } }>): string {
  const p = catalog.providers.find((x) => x.id === provider);
  if (p === undefined) return "absent";
  const rows = catalog.models.filter((m) => m.providerId === provider);
  const hash = createHash("sha256").update(JSON.stringify({ p, rows })).digest("hex").slice(0, 24);
  const host = served.get(p.adapterId);
  const how = host !== undefined && host.provider === provider ? `host:${p.adapterId}@${host.description.version}`
    : COMPILED_ADAPTER_IDS.has(p.adapterId) ? `compiled:${p.adapterId}` : `generic:${p.adapterId}`;
  return `${how}:${hash}`;
}

/** `providerKeyIn` on the SDK's compiled catalog (no model plugin up). */
export function compiledProviderKey(provider: string): string {
  return providerKeyIn(loadCatalog(), provider, new Map());
}

/**
 * MERGE, never replace (#302's review, B3): the plugins' catalog, and
 * - a provider whose code plugin's adapter isn't served (serving is off, or its plugin couldn't start or describe
 *   itself) keeps the compiled catalog's provider and rows, on this build's own adapter; a third party's has no compiled
 *   adapter, so its rows go: never a row without a working adapter;
 * - a compiled provider no plugin brings (its plugin failed to load, or there is none) stays, unless the user turned
 *   its bundled plugin off.
 */
export function mergeWithCompiled(set: ModelPluginSet, served: ReadonlyMap<string, unknown>, turnedOff: (provider: string) => boolean): WinterCatalog {
  const sdk = loadCatalog();
  const unserved = new Set<string>();
  for (const [provider, a] of set.adapters) if (a.handler !== undefined && !served.has(a.adapterId)) unserved.add(provider);
  const keepFromPlugins = (provider: string) => !unserved.has(provider);
  const fromCompiled = (provider: string): boolean => {
    if (turnedOff(provider) || (!unserved.has(provider) && set.byProvider.has(provider))) return false;
    const adapter = sdk.providers.find((p) => p.id === provider)?.adapterId;
    return adapter !== undefined && COMPILED_ADAPTER_IDS.has(adapter);
  };
  const providers = [
    ...set.catalog.providers.filter((p) => keepFromPlugins(p.id)),
    ...sdk.providers.filter((p) => !set.catalog.providers.some((q) => q.id === p.id && keepFromPlugins(q.id)) && fromCompiled(p.id)),
  ];
  const ids = new Set(providers.map((p) => p.id));
  const pluginRows = set.catalog.models.filter((m) => keepFromPlugins(m.providerId) && ids.has(m.providerId));
  const fromPlugins = new Set(pluginRows.map((m) => m.providerId));
  const models = [...pluginRows, ...sdk.models.filter((m) => ids.has(m.providerId) && !fromPlugins.has(m.providerId))];
  return { ...set.catalog, providers, models };
}

/** A code adapter's `describe` limit. The plugin host's default (10 s) counts from the call, and the call waits for the
 *  plugin's worker to start: after an install the whole bundled tree is new and starts cold at once, and that took longer
 *  (the owner's log: "ran past 10000 ms", at the first start after each of four installs). */
export const DESCRIBE_LIMIT_MS = 60_000;
/** A left-out adapter is asked again after these waits (each build that still leaves one out arms the next). */
export const DESCRIBE_RETRY_MS: readonly number[] = [15_000, 60_000, 180_000, 600_000];

/** How many catalog files are kept: the current one and the one before it, which a session starting during a rebuild may still be reading. */
const KEPT_CATALOG_FILES = 2;

export class ModelPlugins {
  readonly #o: ModelPluginsOptions;
  #snapshot: ModelPluginsSnapshot | undefined;
  #pending: Promise<ModelPluginsSnapshot> | undefined;
  #dirty = false;
  #off: Unsubscribe | undefined;
  #retryTimer: TimerHandle | ReturnType<typeof setTimeout> | undefined;
  #retries = 0;

  constructor(opts: ModelPluginsOptions) {
    this.#o = opts;
  }

  /** The current snapshot; undefined before the first `refresh`. */
  get snapshot(): ModelPluginsSnapshot | undefined {
    return this.#snapshot;
  }

  /** Whether the current snapshot carries any model plugin's provider. With none (none installed or every one off),
   *  nothing is overridden: the sessions resolve on the SDK's own catalog and routing, and they move onto the plugins'
   *  set live, as the registry gains one (and back as it loses the last). */
  get active(): boolean {
    return this.#snapshot?.override === true;
  }

  /** Whether a rebuild is running (a plugin just installed, turned on or off): its catalog isn't the sessions' yet. */
  get rebuilding(): boolean {
    return this.#pending !== undefined;
  }

  /** The catalog the sessions resolve against; undefined (the SDK's own) while no model plugin is active. */
  get catalog(): WinterCatalog | undefined {
    return this.active ? this.#snapshot?.set.catalog : undefined;
  }

  /** Loads now, then follows the registry: each change rebuilds (one rebuild at a time, the last change always seen). */
  async start(): Promise<ModelPluginsSnapshot> {
    this.#off ??= this.#o.registry.watch((change) => {
      if (change.type === "entries" && change.point !== "models") return;
      this.#retries = 0;
      void this.refresh().catch((err: unknown) => this.#o.log?.(`model plugins: rebuild failed (${err instanceof Error ? err.message : String(err)})`));
    });
    return this.refresh();
  }

  stop(): void {
    this.#off?.();
    this.#off = undefined;
    this.#cancelRetry();
  }

  #cancelRetry(): void {
    if (this.#retryTimer === undefined) return;
    if (this.#o.clock !== undefined) this.#o.clock.clearTimeout(this.#retryTimer as TimerHandle);
    else clearTimeout(this.#retryTimer as ReturnType<typeof setTimeout>);
    this.#retryTimer = undefined;
  }

  /** After a build that left an adapter out because it didn't answer (not because it says it is another one), asks again
   *  later: a slow start costs the person a provider only until it has come up, not until the engine restarts. */
  #armRetry(snap: ModelPluginsSnapshot): void {
    this.#cancelRetry();
    if (this.#off === undefined) return; // stopped
    if (!snap.refused.some((r) => r.code === "adapter-unavailable" && r.retryable === true)) {
      this.#retries = 0;
      return;
    }
    const waits = this.#o.retryAfterMs ?? DESCRIBE_RETRY_MS;
    const wait = waits[this.#retries];
    if (wait === undefined) return;
    this.#retries++;
    const fire = () => {
      this.#retryTimer = undefined;
      this.#o.log?.(`model plugins: asking the adapters left out again (attempt ${this.#retries} of ${waits.length})`);
      void this.refresh().catch((err: unknown) => this.#o.log?.(`model plugins: retry failed (${err instanceof Error ? err.message : String(err)})`));
    };
    if (this.#o.clock !== undefined) this.#retryTimer = this.#o.clock.setTimeout(fire, wait);
    else {
      const t = setTimeout(fire, wait);
      (t as { unref?: () => void }).unref?.();
      this.#retryTimer = t;
    }
  }

  /** Rebuilds from the registry. Calls made while one runs are folded into one more run after it. */
  async refresh(): Promise<ModelPluginsSnapshot> {
    if (this.#pending !== undefined) {
      this.#dirty = true;
      return this.#pending;
    }
    const run = async (): Promise<ModelPluginsSnapshot> => {
      try {
        let snap: ModelPluginsSnapshot;
        do {
          this.#dirty = false;
          snap = await this.#build();
        } while (this.#dirty);
        this.#snapshot = snap;
        this.#o.changed?.();
        this.#armRetry(snap);
        return snap;
      } finally {
        this.#pending = undefined;
      }
    };
    this.#pending = run();
    return this.#pending;
  }

  async #build(): Promise<ModelPluginsSnapshot> {
    const set = buildModelPluginSet(readModelPlugins(this.#o.registry, this.#o.readFile));
    const refused: ModelPluginRefusalView[] = set.refused.map((r) => ({ pluginId: r.pluginId, provider: r.provider, code: r.code, message: r.message }));
    const served = new Map<string, ServedModelAdapter>();
    // All at once: each is its own plugin's worker, and the start of one never waits for another's (a cold start of
    // several, one after the other, cost the sum of their waits). A third party's code adapter is served as a bundled
    // one's: its keyed fetch reaches only its own declared hosts with only its own stored keys (plugin-api.ts), and its
    // processes are fenced to those hosts (B's 2f, 2g).
    const limit = this.#o.describeLimitMs ?? DESCRIBE_LIMIT_MS;
    const now = (): number => (this.#o.clock !== undefined ? this.#o.clock.monotonic() : performance.now());
    const asked = [...set.adapters].filter(([, a]) => a.handler !== undefined && this.#o.serveCodeAdapters !== false);
    const answers = await Promise.all(asked.map(async ([provider, a]) => {
      const began = now();
      try {
        const description = await describeModelAdapter(this.#o.host, { pluginId: a.pluginId, handler: a.handler! }, { timeoutMs: limit });
        if (description.id !== a.adapterId) throw new IdentityMismatch(`its adapter says it is ${description.id}, and its catalog file names ${a.adapterId}`);
        const took = Math.round(now() - began);
        if (took >= 2000) this.#o.log?.(`model plugins: ${a.pluginId} described its adapter in ${took} ms`);
        return { provider, a, description } as const;
      } catch (err) {
        return { provider, a, err, took: Math.round(now() - began) } as const;
      }
    }));
    for (const r of answers) {
      if (!("err" in r)) {
        served.set(r.a.adapterId, { adapterId: r.a.adapterId, pluginId: r.a.pluginId, provider: r.provider, handler: r.a.handler!, description: r.description });
      } else {
        // An adapter that answered as another one, or on another interface version, stays out until its plugin changes;
        // one that didn't answer in time or whose worker failed to start is asked again (`#armRetry`).
        const permanent = r.err instanceof IdentityMismatch || (isContractError(r.err) && r.err.code === "failed" && /adapter (interface|did not describe)/.test(r.err.message));
        refused.push({ pluginId: r.a.pluginId, provider: r.provider, code: "adapter-unavailable", message: `${r.err instanceof Error ? r.err.message : String(r.err)} (after ${r.took} ms)`, retryable: !permanent });
      }
    }
    for (const r of refused) this.#o.log?.(`model plugins: ${r.pluginId} (${r.provider}) left out: ${r.code}: ${r.message}`);
    const turnedOff = (provider: string): boolean => {
      const r = this.#o.registry.get(modelPluginId(provider));
      return r !== undefined && r.source === "bundled" && !r.enabled;
    };
    const merged = mergeWithCompiled(set, served, turnedOff);
    // Nothing is overridden while no model plugin is on and none was turned off (a test daemon's own store).
    const override = set.byProvider.size > 0 || loadCatalog().providers.some((p) => turnedOff(p.id));
    const { path, sha256 } = this.#writeCatalog(merged);
    return { set: { ...set, catalog: merged }, catalogPath: path, catalogSha256: sha256, served, refused, override };
  }

  #writeCatalog(catalog: WinterCatalog): { path: string; sha256: string } {
    const dir = join(this.#o.home, "run", "models");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify(catalog);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(dir, `catalog-${sha256}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, path);
    // Keep the newest few: the file names carry no time, so order by when this process wrote them.
    this.#written = [path, ...this.#written.filter((p) => p !== path)];
    for (const old of this.#written.splice(KEPT_CATALOG_FILES)) rmSync(old, { force: true });
    for (const name of readdirSync(dir)) if (name.endsWith(".tmp")) rmSync(join(dir, name), { force: true });
    return { path, sha256 };
  }

  #written: string[] = [];

  /** What a session on `provider` is given now (`providerKeyIn`): its catalog rows and how its adapter is served. */
  providerKey(provider: string): string {
    const snap = this.#snapshot;
    if (snap === undefined || !this.active) return compiledProviderKey(provider);
    return providerKeyIn(snap.set.catalog, provider, snap.served);
  }

  /** What a session's `modelProviders` option is made of now: the catalog file and the code adapters served, or
   *  "compiled" while no model plugin is active (the SDK's own catalog). A runtime opened on another reopens (the bot
   *  driver's `modelCatalogKey`). */
  sessionKey(): string {
    const snap = this.#snapshot;
    if (snap === undefined || !this.active) return "compiled";
    return `${snap.catalogSha256}:${[...snap.served.keys()].sort().join(",")}`;
  }

  /**
   * One session's `Options.modelProviders`: the current catalog file and the code adapters it may call, answered
   * here through the plugin host as `caller` (the session, R7). Undefined before the first load. `providers`, when
   * given, narrows the code adapters to the providers it allows (a bot's allowlist): any other code plugin's adapter
   * is neither offered nor answered, so its provider isn't reachable through the plugin's own key.
   */
  sessionOption(opts: { caller: Caller; session?: string; providers?: (provider: string) => boolean }): ModelProvidersOption | undefined {
    const snap = this.#snapshot;
    if (snap === undefined || !this.active) return undefined;
    const allows = opts.providers;
    const served = allows === undefined ? snap.served : new Map([...snap.served].filter(([, s]) => allows(s.provider)));
    const hostAdapters: HostServedAdapter[] = [...served.values()].map((s) => ({ id: s.adapterId, version: s.description.version, family: s.description.family, protocol: s.description.protocol, ...(s.description.countTokens ? { countTokens: true } : {}) }));
    const connectionFor = this.#o.connectionFor;
    const server = createHostModelAdapterServer((id) => {
      const s = served.get(id);
      if (s === undefined) return undefined;
      const named = this.#o.registry.get(s.pluginId)?.manifest?.name;
      const name = (typeof named === "string" ? named : named?.en) ?? s.pluginId;
      const adapter = pluginHostModelAdapter(this.#o.host, { pluginId: s.pluginId, handler: s.handler }, { caller: opts.caller, ...(opts.session !== undefined ? { session: opts.session } : {}), countTokens: s.description.countTokens, name });
      if (connectionFor === undefined) return adapter;
      const fill = async <C extends { connection: HostModelAdapterContextConnection }>(ctx: C): Promise<C> => ({ ...ctx, connection: await connectionFor(s.pluginId, ctx.connection) });
      const filled: HostModelAdapter = {
        streamTurn: (req, ctx) => (async function* () { yield* adapter.streamTurn(req, await fill(ctx)); })(),
        listModels: async (ctx) => adapter.listModels(await fill(ctx)),
        validateCredential: async (ctx) => adapter.validateCredential(await fill(ctx)),
      };
      if (adapter.countTokens !== undefined) {
        const count = adapter.countTokens.bind(adapter);
        filled.countTokens = async (req, ctx) => count(req, await fill(ctx));
      }
      return filled;
    });
    return {
      catalog: { path: snap.catalogPath, sha256: snap.catalogSha256 },
      ...(hostAdapters.length > 0 ? { hostAdapters, serve: (subtype: string, payload: unknown) => server.handle(subtype, payload) } : {}),
    };
  }

  /**
   * The core's own calls on a provider (its internal jobs: titles, the bash reviewer, the dreamer, the cleaner): the
   * provider's code adapter as a `ProviderAdapter`, run on its plugin through the plugin host as `caller`, the same
   * path a session's stub takes. Undefined when the provider has no served code adapter (a declarative provider runs
   * on its protocol's generic adapter in the core, which the caller builds as before).
   */
  providerAdapterFor(providerId: string, opts: { caller: Caller }): ProviderAdapter | undefined {
    const served = this.#snapshot === undefined ? undefined : [...this.#snapshot.served.values()].find((s) => s.provider === providerId);
    if (served === undefined) return undefined;
    const option = this.sessionOption({ caller: opts.caller });
    const identity = option?.hostAdapters?.find((a) => a.id === served.adapterId);
    const serve = option?.serve;
    if (identity === undefined || serve === undefined) return undefined;
    // The agent SDK spells `family` as a string on the wire; the identity came from this adapter's own `describe`.
    return hostServedProviderAdapter(identity as Parameters<typeof hostServedProviderAdapter>[0], {
      async request<T>(subtype: string, payload: unknown): Promise<T> {
        const answer = await serve(subtype, payload, { signal: new AbortController().signal });
        if (!answer.ok) throw new ProviderRequestError({ code: "network", message: answer.error.message, retryable: false });
        return answer.value as T;
      },
    });
  }
}
