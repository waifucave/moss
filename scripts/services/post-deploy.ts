// After a deploy: the settings the product needs, and a check of the live Workers.
//
//   bun scripts/services/post-deploy.ts [--env-file <file>] [--domain <domain>]
//       prints which engine setting gets which address, which plugin's "not yet" this lifts and what else it still needs
//   bun scripts/services/post-deploy.ts --smoke [...]
//       also asks each live Worker one thing that needs no account (its public keys, its page's config, or a refusal that
//       only our Worker would give) and says pass or fail for each. Exit 1 when one fails.
//
// Names come from the same environment as deploy.ts (services/deploy.env.example); no secret is read or printed.
import { defaultWebLabel, loadEnvFile, resolveSettings, type Env } from "./lib";
import { BUILT_IN_ADDRESSES, PARKED_PLUGINS, SERVICES, type ServiceId, type Settings, type SmokeSpec } from "./manifest";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  fetch: typeof fetch;
}

export interface SmokeResult {
  service: ServiceId;
  url: string;
  ok: boolean;
  detail: string;
}

export function addresses(s: Settings): { accounts: string; hooks: string; push: string; handshake: string; web: string } {
  return {
    accounts: s.issuer,
    hooks: `https://${s.hosts.hooks}`,
    push: `https://${s.hosts.push}`,
    handshake: `https://${s.hosts.handshake}`,
    web: `https://${s.hosts.web}`,
  };
}

export function settingsReport(s: Settings, domainGiven: boolean): string[] {
  const a = addresses(s);
  const lines: string[] = [];
  const builtIn: Record<keyof typeof a, string> = { ...Object.fromEntries(Object.entries(BUILT_IN_ADDRESSES).map(([k, v]) => [k, v.url])), web: `https://${defaultWebLabel()}.waifucave.com` } as Record<keyof typeof a, string>;
  const same = (Object.keys(a) as (keyof typeof a)[]).every((k) => a[k] === builtIn[k]);
  lines.push("deployed addresses");
  for (const k of Object.keys(a) as (keyof typeof a)[]) lines.push(`  ${k.padEnd(10)} ${a[k]}`);
  lines.push("");
  lines.push("the engine");
  lines.push("  1. the sign-in project: put its URL and its public anon key in <MOSS home>/account.json, and nothing else in it:");
  lines.push(`       { "authUrl": "${s.env.MOSS_SUPABASE_URL || "<the sign-in project's URL>"}", "anonKey": "<the project's public anon key>" }`);
  lines.push("     (a release build takes only these two from the file; the file is refused whole if it holds any other key)");
  if (!domainGiven) {
    lines.push("  2. no domain given: run again with --domain <your domain> to see the addresses");
  } else if (same) {
    lines.push("  2. the addresses above are the ones every build already has built in: no other engine setting changes.");
  } else {
    lines.push("  2. these are NOT the addresses built into today's builds (a release build ignores the environment, on purpose), so:");
    lines.push("     - a dev or test build: MOSS_ACCOUNT_SERVICE_URL, MOSS_HANDSHAKE_URL in its environment;");
    lines.push("     - a release build: change the built-in addresses and rebuild. They are in");
    for (const f of [...new Set([...Object.values(BUILT_IN_ADDRESSES).map((v) => v.file), "plugins/moss/plugins/companion-web/host/index.ts"])]) lines.push(`         ${f}`);
    lines.push("       plus packages/core/src/links/handshake.ts (HANDSHAKE_AUDIENCE), packages/core/src/routines/engine.ts (the webhook base),");
    lines.push("       the push and forwarder plugins' host/index.ts (DEFAULT_ORIGIN) and the `network:` lines in their moss.json;");
    lines.push("       the token audiences are the Workers' host names, so the engine and the Workers must name the same ones.");
  }
  lines.push("");
  lines.push("the plugins (in the product, \"not yet\" lifts only when the deploy AND what is listed beside it are done)");
  for (const p of PARKED_PLUGINS) {
    lines.push(`  ${p.plugin}  (now: not-yet, ${p.reason})`);
    lines.push(`       this deploy: ${p.needs.join(" + ")}`);
    lines.push(`       still needed: ${p.stillNeeds}`);
  }
  lines.push("  relay-cloudflare's own setting: `origin` = the address of the user's own relay Worker (deploy it with --only relay in their account), and its secret relay-key = that Worker's RELAY_KEY.");
  return lines;
}

async function probe(spec: SmokeSpec, url: string, s: Settings, f: typeof fetch): Promise<{ ok: boolean; detail: string }> {
  let res: Response;
  try {
    res = await f(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  } catch (e) {
    return { ok: false, detail: `no answer (${(e as Error).name})` };
  }
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: judged below.
  }
  if (spec.kind === "jwks") {
    const keys = (body as { keys?: unknown } | null)?.keys;
    if (res.status !== 200 || !Array.isArray(keys) || keys.length === 0) return { ok: false, detail: `${res.status}, no public keys (is SIGNING_JWKS set?)` };
    if (keys.some((k) => typeof k !== "object" || k === null || "d" in k || typeof (k as { kid?: unknown }).kid !== "string")) return { ok: false, detail: "a key has no kid or carries a private part" };
    return { ok: true, detail: `${keys.length} public key(s)` };
  }
  if (spec.kind === "vapid") {
    // The one public answer that shows the push Worker's own configuration is in place: the web push key it was given.
    const key = (body as { publicKey?: unknown } | null)?.publicKey;
    if (res.status !== 200 || typeof key !== "string" || key === "") return { ok: false, detail: `${res.status}, no VAPID public key (is VAPID_PUBLIC_KEY set?)` };
    const want = s.env.MOSS_VAPID_PUBLIC_KEY;
    return want && want !== key ? { ok: false, detail: "serves a different VAPID public key than the one in the settings" } : { ok: true, detail: "serves its VAPID public key" };
  }
  if (spec.kind === "config-json") {
    const h = (body as { handshake?: unknown } | null)?.handshake;
    if (res.status !== 200 || typeof h !== "string") return { ok: false, detail: `${res.status}, not the page's config` };
    return h === `https://${s.hosts.handshake}` ? { ok: true, detail: "points at the handshake" } : { ok: false, detail: "points at a different handshake than the one deployed" };
  }
  // worker-refusal: our Workers answer an unknown path with a JSON error; a missing route or DNS gives Cloudflare's page instead.
  const error = (body as { error?: unknown } | null)?.error;
  if (res.status >= 400 && res.status < 500 && type.includes("json") && typeof error === "string") return { ok: true, detail: `${res.status} ${error} (the Worker answers)` };
  return { ok: false, detail: `${res.status}, not our Worker's answer (is the route or custom domain set up?)` };
}

export async function smoke(s: Settings, ids: readonly ServiceId[], f: typeof fetch): Promise<SmokeResult[]> {
  const a = addresses(s);
  const base: Record<string, string> = { accounts: a.accounts, handshake: a.handshake, push: a.push, forwarder: a.hooks, web: a.web };
  if (s.env.MOSS_RELAY_ORIGIN) base.relay = s.env.MOSS_RELAY_ORIGIN.replace(/\/+$/, "");
  const out: SmokeResult[] = [];
  for (const spec of SERVICES) {
    if (!ids.includes(spec.id) || !base[spec.id]) continue;
    const url = `${base[spec.id]}${spec.smoke.path}`;
    out.push({ service: spec.id, url, ...(await probe(spec.smoke, url, s, f)) });
  }
  return out;
}

export async function main(argv: readonly string[], env: Env, io: Io = { out: console.log, err: console.error, fetch }): Promise<number> {
  let merged: Record<string, string | undefined> = { ...env };
  let doSmoke = false;
  let domain: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--smoke") doSmoke = true;
    else if (k === "--domain") domain = argv[++i];
    else if (k === "--env-file") {
      try {
        merged = { ...loadEnvFile(argv[++i] ?? ""), ...Object.fromEntries(Object.entries(env).filter(([n, v]) => n.startsWith("MOSS_") && v)) };
      } catch {
        io.err("post-deploy: the env file can't be read");
        return 2;
      }
    } else {
      io.err(`post-deploy: unknown argument ${k}`);
      return 2;
    }
  }
  if (domain) merged.MOSS_SERVICES_DOMAIN = domain;
  const domainGiven = (merged.MOSS_SERVICES_DOMAIN ?? "").trim() !== "";
  const s = resolveSettings(merged);
  for (const l of settingsReport(s, domainGiven)) io.out(l);
  if (!doSmoke) {
    io.out("");
    io.out("to check the live Workers: run again with --smoke");
    return 0;
  }
  if (!domainGiven) {
    io.err("post-deploy: --smoke needs the domain (MOSS_SERVICES_DOMAIN or --domain)");
    return 2;
  }
  io.out("");
  io.out("smoke check (public requests only)");
  const ids = SERVICES.filter((x) => x.group === "default" || (x.id === "relay" && s.env.MOSS_RELAY_ORIGIN)).map((x) => x.id);
  const results = await smoke(s, ids, io.fetch);
  for (const r of results) io.out(`  ${r.ok ? "pass" : "FAIL"}  ${r.service.padEnd(10)} ${r.url}  ${r.detail}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.env));
