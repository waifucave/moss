// The pure parts of the services deploy: settings from the environment, each Worker's rendered configuration, the plan,
// fresh secret values. No command runs here and nothing reads the environment by itself (deploy.ts passes it in).
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ENV_NAMES, SERVICES, type EnvName, type GeneratorId, type ServiceId, type ServiceSpec, type Settings } from "./manifest";

export type Env = Readonly<Record<string, string | undefined>>;

/** The domain the plan shows when none is given: `.invalid` never resolves, so a dry run can't name a real host. */
export const PLACEHOLDER_DOMAIN = "example.invalid";

// ---- reading files ----

/** JSONC to JSON: line and block comments and trailing commas outside strings removed. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** `KEY=value` lines (an optional `export `, optional quotes, `#` comments). Values are returned, never printed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

export function loadEnvFile(path: string): Record<string, string> {
  return parseEnvFile(readFileSync(path, "utf8"));
}

// ---- settings ----

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** The web page's production host in services/web/wrangler.jsonc without its zone (`app.moss` for app.moss.waifucave.com): the name the web companion plugin has built in. The owner picks the final host. */
export function defaultWebPrefix(root = REPO_ROOT): string {
  const base = parseJsonc(readFileSync(join(root, "services/web/wrangler.jsonc"), "utf8")) as { env: { production: { routes: { pattern: string }[] } } };
  return base.env.production.routes[0]!.pattern.replace(/\.waifucave\.com$/, "");
}

/** The Worker's name: `env.production.name` in its wrangler.jsonc. */
export function workerName(root: string, spec: ServiceSpec): string {
  const base = parseJsonc(readFileSync(join(root, spec.dir, "wrangler.jsonc"), "utf8")) as { env: { production: { name: string } } };
  return base.env.production.name;
}

export function resolveSettings(env: Env): Settings {
  const set = (name: string) => (env[name] ?? "").trim();
  const domain = set("MOSS_SERVICES_DOMAIN").toLowerCase() || PLACEHOLDER_DOMAIN;
  const host = (override: string, label: string) => set(override).toLowerCase() || `${label}.${domain}`;
  const ownHost = set("MOSS_ACCOUNTS_HOST") !== "";
  const hosts = {
    accounts: set("MOSS_ACCOUNTS_HOST").toLowerCase() || domain,
    hooks: host("MOSS_HOOKS_HOST", "hooks"),
    handshake: host("MOSS_HANDSHAKE_HOST", "handshake"),
    push: host("MOSS_PUSH_HOST", "push"),
    web: host("MOSS_WEB_HOST", defaultWebPrefix()),
  };
  const accountsPrefix = ownHost ? "" : "/auth";
  const issuer = `https://${hosts.accounts}${accountsPrefix}`;
  return { domain, hosts, issuer, accountsPrefix, jwksUrl: `${issuer}/.well-known/jwks.json`, env };
}

/** Problems with the values given (shape only; a value is never echoed). */
export function settingsProblems(s: Settings): string[] {
  const problems: string[] = [];
  const hostNames: [string, string][] = [["the domain", s.domain], ["the accounts host", s.hosts.accounts], ["the hooks host", s.hosts.hooks], ["the handshake host", s.hosts.handshake], ["the push host", s.hosts.push], ["the web host", s.hosts.web]];
  for (const [name, value] of hostNames) if (!HOST_RE.test(value)) problems.push(`${name} is not a plain host name`);
  const url = s.env.MOSS_SUPABASE_URL;
  if (url && !/^https:\/\/[^\s/]+\/?$/.test(url)) problems.push("MOSS_SUPABASE_URL must be an https origin with no path");
  return problems;
}

// ---- what is missing ----

export interface NameState {
  name: string;
  kind: "var" | "secret";
  required: boolean;
  set: boolean;
}

/** Each name the chosen services read, set or not: never its value. */
export function nameStates(env: Env, ids: readonly ServiceId[]): NameState[] {
  const needed = namesFor(ids);
  return ENV_NAMES.filter((n) => needed.has(n.name)).map((n) => ({
    name: n.name,
    kind: n.kind,
    required: needed.get(n.name)!,
    set: (env[n.name] ?? "").trim() !== "",
  }));
}

/** The names the chosen services read: name to whether they need it. The relay alone needs neither the domain nor the sign-in. */
export function namesFor(ids: readonly ServiceId[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const add = (name: string, required = true) => out.set(name, (out.get(name) ?? false) || required);
  const has = (id: ServiceId) => ids.includes(id);
  if (ids.some((id) => id !== "relay")) {
    add("MOSS_SERVICES_DOMAIN");
    for (const n of ["MOSS_ACCOUNTS_HOST", "MOSS_HOOKS_HOST", "MOSS_HANDSHAKE_HOST", "MOSS_PUSH_HOST", "MOSS_WEB_HOST"]) add(n, false);
  }
  if (has("accounts")) for (const n of ["MOSS_SUPABASE_URL", "MOSS_SUPABASE_ANON_KEY", "MOSS_SIGNING_JWKS"]) add(n);
  if (has("forwarder")) for (const n of ["MOSS_TAG_KEYS", "MOSS_ACCOUNT_ID_KEY", "MOSS_FORWARDER_TICKET_SECRET"]) add(n);
  if (has("handshake")) add("MOSS_HANDSHAKE_TICKET_SECRET");
  if (has("push")) {
    for (const n of ["MOSS_APNS_KEY_ID", "MOSS_APNS_TEAM_ID", "MOSS_APNS_TOPIC_MOSS", "MOSS_APNS_TOPIC_CODE", "MOSS_APNS_PRIVATE_KEY", "MOSS_VAPID_PUBLIC_KEY", "MOSS_VAPID_PRIVATE_KEY"]) add(n);
    add("MOSS_VAPID_SUBJECT", false);
  }
  if (has("relay")) for (const n of ["MOSS_RELAY_ORIGIN", "MOSS_RELAY_KEY"]) add(n);
  return out;
}

// ---- ordering ----

/** The services to deploy: `only`, or the default group. Every one comes after the ones it must follow. */
export function orderServices(only?: readonly string[]): ServiceSpec[] {
  const wanted = new Set<ServiceId>();
  if (only && only.length > 0) {
    for (const id of only) {
      const spec = SERVICES.find((s) => s.id === id);
      if (!spec) throw new Error(`no service called "${id}" (${SERVICES.map((s) => s.id).join(", ")})`);
      wanted.add(spec.id);
    }
  } else {
    for (const s of SERVICES) if (s.group === "default") wanted.add(s.id);
  }
  const ordered: ServiceSpec[] = [];
  const visit = (id: ServiceId, stack: ServiceId[]) => {
    if (ordered.some((s) => s.id === id)) return;
    if (stack.includes(id)) throw new Error(`a cycle in the services' order: ${[...stack, id].join(" > ")}`);
    const spec = SERVICES.find((s) => s.id === id)!;
    for (const dep of spec.after) if (wanted.has(dep)) visit(dep, [...stack, id]);
    ordered.push(spec);
  };
  for (const s of SERVICES) if (wanted.has(s.id)) visit(s.id, []);
  return ordered;
}

// ---- rendering ----

export interface RenderedConfig {
  id: ServiceId;
  worker: string;
  config: Record<string, unknown>;
}

/**
 * The production profile of a service's wrangler.jsonc as one flat configuration (wrangler does not inherit `vars`,
 * bindings or limits into an environment, so nothing is left to inherit), with the owner's settings over it: its
 * routes, and each variable the manifest names. `main` and the asset folder become absolute so the file may live anywhere.
 */
export function renderConfig(root: string, spec: ServiceSpec, settings: Settings): RenderedConfig {
  const file = join(root, spec.dir, "wrangler.jsonc");
  const base = parseJsonc(readFileSync(file, "utf8")) as Record<string, unknown>;
  const prod = (base.env as Record<string, Record<string, unknown>> | undefined)?.production;
  if (!prod) throw new Error(`${spec.dir}/wrangler.jsonc has no env.production`);
  const config: Record<string, unknown> = {};
  for (const key of ["main", "compatibility_date", "send_metrics", "migrations"]) if (key in base) config[key] = base[key];
  Object.assign(config, prod);
  delete config.$schema;
  const dir = join(root, spec.dir);
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(dir, p));
  config.main = abs(String(config.main));
  const assets = config.assets as { directory?: string } | undefined;
  if (assets?.directory) config.assets = { ...assets, directory: abs(assets.directory) };
  const baseVars = (prod.vars ?? {}) as Record<string, string>;
  const computed = spec.vars(settings);
  for (const k of Object.keys(computed)) if (!(k in baseVars)) throw new Error(`${spec.id}: the manifest sets ${k}, which ${spec.dir}/wrangler.jsonc's production profile does not have`);
  config.vars = { ...baseVars, ...computed };
  const routes = spec.routes(settings);
  if (routes.length > 0) config.routes = routes;
  else delete config.routes;
  return { id: spec.id, worker: String(config.name), config };
}

// ---- the plan ----

export interface PlanStep {
  n: number;
  id: ServiceId;
  worker: string;
  where: string[];
  secrets: { remote: string; env: string; set: boolean }[];
  why: string;
  build: string | null;
}

export function buildPlan(root: string, ordered: readonly ServiceSpec[], settings: Settings): PlanStep[] {
  return ordered.map((spec, i) => {
    const rendered = renderConfig(root, spec, settings);
    const routes = (rendered.config.routes as { pattern: string; custom_domain?: boolean }[] | undefined) ?? [];
    const after = spec.after.filter((a) => ordered.slice(0, i).some((b) => b.id === a));
    return {
      n: i + 1,
      id: spec.id,
      worker: rendered.worker,
      where: routes.length > 0 ? routes.map((r) => `${r.pattern}${r.custom_domain ? " (custom domain)" : ""}`) : ["a workers.dev address of the account"],
      secrets: spec.secrets.map((s) => ({ remote: s.remote, env: s.env, set: (settings.env[s.env] ?? "").trim() !== "" })),
      why: after.length > 0 ? `after ${after.join(", ")}: ${spec.why}` : i === 0 && spec.id === "accounts" ? `first: ${spec.why}` : "needs nothing deployed before it",
      build: spec.build ? spec.build.command.join(" ") : null,
    };
  });
}

// ---- fresh secret values ----

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** A fresh value for a secret the product makes up itself (never one Apple or the sign-in project gives). Printed by --generate; the owner keeps it. */
export async function generateSecret(kind: GeneratorId, now = new Date()): Promise<{ name: string; value: string }[]> {
  switch (kind) {
    case "random":
      return [{ name: "value", value: b64u(crypto.getRandomValues(new Uint8Array(32))) }];
    case "tag-keys":
      return [{ name: "value", value: JSON.stringify({ "1": b64u(crypto.getRandomValues(new Uint8Array(32))) }) }];
    case "signing-jwks": {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
      const kid = `k${now.toISOString().slice(0, 10).replaceAll("-", "")}-${b64u(crypto.getRandomValues(new Uint8Array(4)))}`;
      return [{ name: "value", value: JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d, kid, alg: "EdDSA", use: "sig" }] }) }];
    }
    case "vapid": {
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
      return [
        { name: "MOSS_VAPID_PUBLIC_KEY", value: b64u(pub) },
        { name: "MOSS_VAPID_PRIVATE_KEY", value: priv.d! },
      ];
    }
  }
}

export function generatorFor(name: string): EnvName | undefined {
  return ENV_NAMES.find((n) => n.name === name && n.generate);
}

/** The checkout this script is in. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
