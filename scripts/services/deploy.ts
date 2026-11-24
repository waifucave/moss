// Deploys the Workers under services/ (the accounts, the pairing handshake, the content-free push, the webhook forwarder,
// the web companion; the relay on request). The owner runs it himself; a dry run is what it does unless told otherwise.
//
//   bun scripts/services/deploy.ts [--env-file <file>] [--only accounts,push] [--out <dir>] [--strict] [--no-build]
//       the dry run: checks which names are set (never prints a value), builds, runs wrangler's own `deploy --dry-run`
//       (no login, nothing sent) for each Worker, and prints what a real deploy would do, where, and in what order.
//   bun scripts/services/deploy.ts --deploy [--skip-secrets] ...
//       the real thing. Refused unless CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are in the environment and every
//       required name is set. Secrets go to wrangler on its standard input, never on a command line or to a file.
//   bun scripts/services/deploy.ts --generate <signing-jwks|tag-keys|random|vapid>
//       prints a fresh value for a secret this product makes up itself (see services/deploy.env.example).
//
// docs/services-deploy.md has the whole story. Exit codes: 0 done, 1 something failed or is missing, 2 refused.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlan, generateSecret, loadEnvFile, nameStates, orderServices, renderConfig, resolveSettings, settingsProblems,
  PLACEHOLDER_DOMAIN, REPO_ROOT, type Env,
} from "./lib";
import { CLOUDFLARE_CREDENTIALS, type GeneratorId, type ServiceSpec } from "./manifest";

export interface RunResult { status: number; stdout: string; stderr: string }
export type Runner = (cmd: readonly string[], opts: { cwd: string; env: Record<string, string>; input?: string }) => RunResult;

export interface Io {
  out(line: string): void;
  err(line: string): void;
  run: Runner;
  root: string;
}

const realRunner: Runner = (cmd, opts) => {
  // `bun` is the Bun running this script (the pinned one), whatever is first on the PATH.
  const r = spawnSync(cmd[0] === "bun" ? process.execPath : cmd[0]!, cmd.slice(1), { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
};

export function defaultIo(): Io {
  return { out: (l) => console.log(l), err: (l) => console.error(l), run: realRunner, root: REPO_ROOT };
}

interface Args {
  deploy: boolean;
  strict: boolean;
  noBuild: boolean;
  skipSecrets: boolean;
  envFile?: string;
  only?: string[];
  out?: string;
  generate?: string;
}

export function parseArgs(argv: readonly string[]): Args | string {
  const a: Args = { deploy: false, strict: false, noBuild: false, skipSecrets: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const next = () => argv[++i];
    if (k === "--dry-run") continue;
    else if (k === "--deploy") a.deploy = true;
    else if (k === "--strict") a.strict = true;
    else if (k === "--no-build") a.noBuild = true;
    else if (k === "--skip-secrets") a.skipSecrets = true;
    else if (k === "--env-file") a.envFile = next();
    else if (k === "--out") a.out = next();
    else if (k === "--only") a.only = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--generate") a.generate = next();
    else return `unknown argument ${k}`;
  }
  if (a.deploy && argv.includes("--dry-run")) return "--deploy and --dry-run together: pick one";
  return a;
}

/** What wrangler is given: no Cloudflare credential, and a home of its own, so a dry run can neither log in nor read this machine's wrangler login. */
function dryRunEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    WRANGLER_HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: tmpdir(),
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
  };
}

function realEnv(env: Env): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: tmpdir(),
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN ?? "",
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID ?? "",
  };
}

function wranglerFor(root: string, spec: ServiceSpec): string | null {
  for (const p of [join(root, spec.dir, "node_modules/.bin/wrangler"), join(root, "node_modules/.bin/wrangler")]) if (existsSync(p)) return p;
  return null;
}

export async function main(argv: readonly string[], env: Env, io: Io = defaultIo()): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    io.err(`deploy: ${parsed}`);
    return 2;
  }
  const args = parsed;

  if (args.generate !== undefined) return generate(args.generate, io);

  let merged: Env = env;
  if (args.envFile) {
    try {
      const fromEnv = Object.entries(env).filter(([k, v]) => (k.startsWith("MOSS_") || k.startsWith("CLOUDFLARE_")) && v !== undefined && v !== "");
      merged = { ...loadEnvFile(args.envFile), ...Object.fromEntries(fromEnv) };
    } catch {
      io.err(`deploy: the env file ${args.envFile} can't be read`);
      return 2;
    }
  }

  let ordered: ServiceSpec[];
  try {
    ordered = orderServices(args.only);
  } catch (e) {
    io.err(`deploy: ${(e as Error).message}`);
    return 2;
  }
  const settings = resolveSettings(merged);
  const ids = ordered.map((s) => s.id);
  const states = nameStates(merged, ids);
  const problems = settingsProblems(settings);
  const unset = states.filter((s) => s.required && !s.set && !(args.skipSecrets && s.kind === "secret"));
  const placeholderDomain = settings.domain === PLACEHOLDER_DOMAIN;

  io.out(args.deploy ? "DEPLOY (real)" : "DRY RUN: nothing is deployed, no account is touched");
  io.out(`services: ${ids.join(", ")}`);
  io.out(placeholderDomain ? `domain: none given, showing ${PLACEHOLDER_DOMAIN}` : `domain: ${settings.domain}`);
  io.out("");
  io.out("names (set / not set; values are never printed)");
  for (const s of states) io.out(`  ${s.set ? "set    " : "not set"}  ${s.name}  (${s.kind}${s.required ? "" : ", optional"})`);
  for (const p of problems) io.out(`  PROBLEM: ${p}`);
  io.out("");

  if (args.deploy) {
    const refusals: string[] = [];
    for (const c of CLOUDFLARE_CREDENTIALS) if ((merged[c] ?? "").trim() === "") refusals.push(`${c} is not in the environment`);
    if (placeholderDomain && ids.some((id) => id !== "relay")) refusals.push("MOSS_SERVICES_DOMAIN is not set");
    for (const s of unset) refusals.push(`${s.name} is not set`);
    for (const p of problems) refusals.push(p);
    if (refusals.length > 0) {
      io.err("deploy: refused, so nothing was deployed:");
      for (const r of refusals) io.err(`  - ${r}`);
      return 2;
    }
  } else if (args.strict && (unset.length > 0 || problems.length > 0)) {
    io.out(`strict: ${unset.length} required name(s) not set, ${problems.length} problem(s)`);
    return 1;
  }

  const outDir = args.out ?? mkdtempSync(join(tmpdir(), "moss-services-"));
  mkdirSync(outDir, { recursive: true });
  const home = join(outDir, "wrangler-home");
  mkdirSync(home, { recursive: true });
  let failed = false;
  const bundleNotes: string[] = [];

  for (const spec of ordered) {
    const rendered = renderConfig(io.root, spec, settings);
    const dir = join(outDir, spec.id);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "wrangler.jsonc");
    writeFileSync(configPath, `${JSON.stringify(rendered.config, null, 2)}\n`);
    const cwd = join(io.root, spec.dir);

    if (spec.build && !args.noBuild) {
      const b = io.run([...spec.build.command], { cwd, env: { ...dryRunEnv(home), PATH: process.env.PATH ?? "" } });
      if (b.status !== 0) {
        io.out(`  ${spec.id}: build FAILED\n${indent(tail(b.stderr || b.stdout))}`);
        failed = true;
        continue;
      }
    }
    const wrangler = wranglerFor(io.root, spec);
    if (!wrangler) {
      io.out(`  ${spec.id}: wrangler is not installed (run the repo's install first)`);
      failed = true;
      continue;
    }

    if (args.deploy) {
      const d = io.run([wrangler, "deploy", "--config", configPath], { cwd, env: realEnv(merged) });
      if (d.status !== 0) {
        io.err(`deploy: ${spec.id} FAILED\n${indent(tail(d.stderr || d.stdout))}`);
        return 1;
      }
      io.out(`deployed ${spec.id} (${rendered.worker})`);
      if (!args.skipSecrets && spec.secrets.length > 0) {
        const body: Record<string, string> = {};
        for (const s of spec.secrets) body[s.remote] = merged[s.env] ?? "";
        // Over standard input: a value never appears in a process list or in a file.
        const r = io.run([wrangler, "secret", "bulk", "--config", configPath], { cwd, env: realEnv(merged), input: JSON.stringify(body) });
        if (r.status !== 0) {
          io.err(`deploy: ${spec.id}'s secrets FAILED (the Worker is deployed without them)\n${indent(tail(r.stderr || r.stdout))}`);
          return 1;
        }
        io.out(`  put ${spec.secrets.map((s) => s.remote).join(", ")}`);
      }
      continue;
    }

    const bundle = join(dir, "bundle");
    const r = io.run([wrangler, "deploy", "--dry-run", "--outdir", bundle, "--config", configPath], { cwd, env: dryRunEnv(home) });
    const upload = /Total Upload: ([^\n]+)/.exec(r.stdout + r.stderr)?.[1]?.trim();
    if (r.status !== 0) {
      io.out(`  ${spec.id}: wrangler's dry run FAILED\n${indent(tail(r.stderr || r.stdout))}`);
      failed = true;
    } else {
      bundleNotes.push(`  ${spec.id}: packaged${upload ? `, ${upload}` : ""}`);
    }
  }

  io.out(args.deploy ? "" : "wrangler dry run (packaging only; the bundles are in the output folder)");
  if (!args.deploy) for (const n of bundleNotes) io.out(n);

  io.out("");
  io.out(args.deploy ? "done, in this order:" : "a real deploy (--deploy) would do, in this order:");
  for (const step of buildPlan(io.root, ordered, settings)) {
    io.out(`  ${step.n}. ${step.id}  ->  Worker ${step.worker}`);
    io.out(`       where: ${step.where.join(", ")}`);
    if (step.build) io.out(`       first builds: ${step.build}`);
    if (step.secrets.length > 0) io.out(`       secrets put: ${step.secrets.map((s) => `${s.remote} (from ${s.env}, ${s.set ? "set" : "not set"})`).join(", ")}`);
    io.out(`       why here: ${step.why}`);
  }
  io.out("");
  if (!args.deploy) {
    io.out(unset.length > 0 ? `still to supply before a real deploy: ${unset.map((s) => s.name).join(", ")}` : "every required name is set");
    io.out("to deploy for real: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, then run this again with --deploy");
  }
  io.out("afterwards: bun scripts/services/post-deploy.ts (prints the settings the product needs, and --smoke checks the live Workers)");
  return failed ? 1 : 0;
}

async function generate(name: string, io: Io): Promise<number> {
  const kinds: GeneratorId[] = ["signing-jwks", "tag-keys", "random", "vapid"];
  if (!kinds.includes(name as GeneratorId)) {
    io.err(`deploy: --generate takes one of ${kinds.join(", ")}`);
    return 2;
  }
  for (const v of await generateSecret(name as GeneratorId)) io.out(v.name === "value" ? v.value : `${v.name}=${v.value}`);
  return 0;
}

const tail = (s: string) => s.trim().split("\n").slice(-12).join("\n");
const indent = (s: string) => s.split("\n").map((l) => `      ${l}`).join("\n");

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env));
}
