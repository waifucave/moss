// Deploys the Workers under services/ (the accounts, the pairing handshake, the content-free push, the webhook forwarder,
// the web companion; the relay on request). The owner runs it himself; a dry run is what it does unless told otherwise.
//
//   bun scripts/services/deploy.ts --env-file <file> [--only accounts,push] [--out <dir>] [--strict] [--no-build]
//       the dry run: checks which names are set (never prints a value), builds, runs wrangler's own `deploy --dry-run`
//       (no login, nothing sent) for each Worker, and prints what a real deploy would do, where, and in what order.
//   bun scripts/services/deploy.ts --deploy --env-file <file> [--skip-secrets] [--rotate <NAME,...>] [--rotate-account-id-key]
//       the real thing. Refused unless CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are set (in the env file, which must
//       be mode 600, or in the environment) and every required name is set. It reads each Worker's secret list first
//       (names only), puts the secrets a Worker lacks together with its code, leaves the ones already there alone (a re-run
//       never re-puts them), and asks for a typed confirmation before the first deploy. Secrets go to wrangler on its
//       standard input, never on a command line or to a file.
//   bun scripts/services/deploy.ts --generate <NAME,...|all> --out <file>
//       writes fresh values for the secrets this product makes up itself to a new mode-600 file and prints only their names.
//
// docs/services-deploy.md has the whole story. Exit codes: 0 done, 1 something failed or is missing, 2 refused.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  buildPlan, generateSecret, loadEnvFile, nameStates, orderServices, renderConfig, resolveSettings, settingsProblems,
  PLACEHOLDER_DOMAIN, REPO_ROOT, type Env, type PlanStep,
} from "./lib";
import { CLOUDFLARE_CREDENTIALS, ENV_NAMES, type GeneratorId, type ServiceSpec } from "./manifest";

export interface RunResult { status: number; stdout: string; stderr: string }
export type Runner = (cmd: readonly string[], opts: { cwd: string; env: Record<string, string>; input?: string }) => RunResult;

export interface Io {
  out(line: string): void;
  err(line: string): void;
  run: Runner;
  root: string;
  /** One typed line from the person at the terminal; "" when there is no terminal (a real deploy is then refused). */
  ask(prompt: string): Promise<string>;
}

const realRunner: Runner = (cmd, opts) => {
  // `bun` is the Bun running this script (the pinned one), whatever is first on the PATH.
  const r = spawnSync(cmd[0] === "bun" ? process.execPath : cmd[0]!, cmd.slice(1), { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
};

async function askTerminal(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(prompt, resolve));
  } finally {
    rl.close();
  }
}

export function defaultIo(): Io {
  return { out: (l) => console.log(l), err: (l) => console.error(l), run: realRunner, root: REPO_ROOT, ask: askTerminal };
}

interface Args {
  deploy: boolean;
  strict: boolean;
  noBuild: boolean;
  skipSecrets: boolean;
  rotateAccountIdKey: boolean;
  rotate: string[];
  envFile?: string;
  only?: string[];
  out?: string;
  generate?: string;
}

export function parseArgs(argv: readonly string[]): Args | string {
  const a: Args = { deploy: false, strict: false, noBuild: false, skipSecrets: false, rotateAccountIdKey: false, rotate: [] };
  let problem: string | null = null;
  for (let i = 0; i < argv.length && problem === null; i++) {
    const k = argv[i]!;
    // A flag that takes a value must be given one that is not another flag.
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--")) {
        problem = `${k} needs a value`;
        return "";
      }
      i++;
      return v;
    };
    const list = () => value().split(",").map((x) => x.trim()).filter(Boolean);
    if (k === "--dry-run") continue;
    else if (k === "--deploy") a.deploy = true;
    else if (k === "--strict") a.strict = true;
    else if (k === "--no-build") a.noBuild = true;
    else if (k === "--skip-secrets") a.skipSecrets = true;
    else if (k === "--rotate-account-id-key") a.rotateAccountIdKey = true;
    else if (k === "--rotate") a.rotate.push(...list());
    else if (k === "--env-file") a.envFile = value();
    else if (k === "--out") a.out = value();
    else if (k === "--only") a.only = list();
    else if (k === "--generate") a.generate = value();
    else problem = `unknown argument ${k}`;
  }
  if (problem) return problem;
  if (a.deploy && argv.includes("--dry-run")) return "--deploy and --dry-run together: pick one";
  if (a.skipSecrets && (a.rotate.length > 0 || a.rotateAccountIdKey)) return "--skip-secrets and --rotate together: pick one";
  if (a.generate !== undefined && !a.out) return "--generate needs --out <file>: the values are written to a new mode-600 file, never printed";
  return a;
}

/** What wrangler is given for a dry run: no Cloudflare credential, and a home of its own, so it can neither log in nor read this machine's wrangler login. */
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

/** What wrangler is given for a real run. Its debug log goes to a folder of ours (mode 700, removed afterwards), not under HOME. */
function realEnv(env: Env, logDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: tmpdir(),
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG: "none",
    WRANGLER_LOG_PATH: logDir,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN ?? "",
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID ?? "",
  };
}

function wranglerFor(root: string, spec: ServiceSpec): string | null {
  for (const p of [join(root, spec.dir, "node_modules/.bin/wrangler"), join(root, "node_modules/.bin/wrangler")]) if (existsSync(p)) return p;
  return null;
}

/** Why an env file is not read, or null. It holds keys, so a file that group or others can read is refused. */
export function envFileProblem(path: string, uid: number | undefined = process.getuid?.()): string | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return `the env file ${path} can't be read`;
  }
  if (!st.isFile()) return `${path} is not a file`;
  if (process.platform === "win32") return null;
  if ((st.mode & 0o077) !== 0) return `the env file ${path} can be read by group or others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${path}`;
  if (uid !== undefined && st.uid !== uid) return `the env file ${path} is not owned by the person running this`;
  try {
    const parent = statSync(dirname(path));
    if ((parent.mode & 0o022) !== 0) return `the folder holding ${path} can be written by group or others (mode ${(parent.mode & 0o777).toString(8)}), so the file could be swapped; keep it in a folder only you can write to`;
  } catch {
    return `the folder holding ${path} can't be read`;
  }
  return null;
}

const ACCOUNT_ID_KEY = "MOSS_ACCOUNT_ID_KEY";

/** The names of a Worker's secrets, from `wrangler secret list`; null when the Worker doesn't exist yet; throws on any other failure (so a flaky answer never reads as "none there"). */
function remoteSecrets(run: Runner, wrangler: string, configPath: string, cwd: string, env: Record<string, string>): Set<string> | null {
  const r = run([wrangler, "secret", "list", "--format", "json", "--config", configPath], { cwd, env });
  if (r.status !== 0) {
    // Only wrangler's own code for a missing Worker means "none there yet". Any other failure, whatever words it uses, throws: a wrong "none" would make every secret look missing and put the env file's values over the deployed ones.
    if (/\[code:\s*10007\]/.test(r.stderr + r.stdout)) return null;
    throw new Error(tail(r.stderr || r.stdout));
  }
  try {
    const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf("["))) as { name?: unknown }[];
    return new Set(parsed.flatMap((x) => (typeof x.name === "string" ? [x.name] : [])));
  } catch {
    throw new Error("the secret list wasn't JSON");
  }
}

type SecretAction = "put" | "keep" | "rotate";

export async function main(argv: readonly string[], env: Env, io: Io = defaultIo()): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    io.err(`deploy: ${parsed}`);
    return 2;
  }
  const args = parsed;

  if (args.generate !== undefined) return generate(args.generate, args.out!, io);

  let merged: Env = env;
  if (args.envFile) {
    const bad = envFileProblem(args.envFile);
    if (bad) {
      io.err(`deploy: ${bad}`);
      return 2;
    }
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
  // A real deploy learns which secrets a Worker already has before it asks for them (below), so only the names that are not secrets are required up front.
  const unset = states.filter((s) => s.required && !s.set && !(args.deploy && s.kind === "secret") && !(args.skipSecrets && s.kind === "secret"));
  const placeholderDomain = settings.domain === PLACEHOLDER_DOMAIN;
  const secretNames = new Set(ordered.flatMap((o) => o.secrets.map((x) => x.env)));

  io.out(args.deploy ? "DEPLOY (real)" : "DRY RUN: nothing is deployed, no account is touched");
  io.out(`services: ${ids.join(", ")}`);
  io.out(placeholderDomain ? `domain: none given, showing ${PLACEHOLDER_DOMAIN}` : `domain: ${settings.domain}`);
  io.out("");
  io.out("names (set / not set; values are never printed)");
  for (const st of states) io.out(`  ${st.set ? "set    " : "not set"}  ${st.name}  (${st.kind}${st.required ? "" : ", optional"})`);
  for (const p of problems) io.out(`  PROBLEM: ${p}`);
  io.out("");

  if (args.deploy) {
    const refusals: string[] = [];
    for (const c of CLOUDFLARE_CREDENTIALS) if ((merged[c] ?? "").trim() === "") refusals.push(`${c} is not set (in the env file or the environment)`);
    if (placeholderDomain && ids.some((id) => id !== "relay")) refusals.push("MOSS_SERVICES_DOMAIN is not set");
    for (const st of unset) refusals.push(`${st.name} is not set`);
    for (const p of problems) refusals.push(p);
    for (const r of args.rotate) if (!secretNames.has(r)) refusals.push(`--rotate ${r}: not a secret of the services being deployed`);
    if (args.rotate.includes(ACCOUNT_ID_KEY) && !args.rotateAccountIdKey) {
      refusals.push(`--rotate ${ACCOUNT_ID_KEY} also needs --rotate-account-id-key: a new value names every account's object differently, so every account's held webhooks become unreachable and cannot be recovered`);
    }
    if (args.rotateAccountIdKey && !args.rotate.includes(ACCOUNT_ID_KEY)) refusals.push(`--rotate-account-id-key only goes with --rotate ${ACCOUNT_ID_KEY}`);
    for (const r of args.rotate) if (secretNames.has(r) && (merged[r] ?? "").trim() === "") refusals.push(`--rotate ${r}: the new value is not set`);
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

  const configs = new Map<string, string>();
  for (const spec of ordered) {
    const rendered = renderConfig(io.root, spec, settings);
    const dir = join(outDir, spec.id);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "wrangler.jsonc");
    writeFileSync(configPath, `${JSON.stringify(rendered.config, null, 2)}\n`);
    configs.set(spec.id, configPath);
  }

  if (args.deploy) return realDeploy(args, merged, ordered, settings, configs, io);

  // ---- the dry run ----
  let failed = false;
  const bundleNotes: string[] = [];
  for (const spec of ordered) {
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
    const r = io.run([wrangler, "deploy", "--dry-run", "--outdir", join(outDir, spec.id, "bundle"), "--config", configs.get(spec.id)!], { cwd, env: dryRunEnv(home) });
    const upload = /Total Upload: ([^\n]+)/.exec(r.stdout + r.stderr)?.[1]?.trim();
    if (r.status !== 0) {
      io.out(`  ${spec.id}: wrangler's dry run FAILED\n${indent(tail(r.stderr || r.stdout))}`);
      failed = true;
    } else {
      bundleNotes.push(`  ${spec.id}: packaged${upload ? `, ${upload}` : ""}`);
    }
  }
  io.out("wrangler dry run (packaging only; the bundles are in the output folder)");
  for (const n of bundleNotes) io.out(n);
  io.out("");
  io.out("a real deploy (--deploy) would do, in this order:");
  printPlan(io, buildPlan(io.root, ordered, settings), null);
  io.out("");
  io.out(unset.length > 0 ? `still to supply before a real deploy: ${unset.map((x) => x.name).join(", ")}` : "every required name is set");
  io.out("to deploy for real: put CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the env file (mode 600), then run this again with --deploy");
  io.out("afterwards: bun scripts/services/post-deploy.ts (prints the settings the product needs, and --smoke checks the live Workers)");
  return failed ? 1 : 0;
}

async function realDeploy(args: Args, merged: Env, ordered: ServiceSpec[], settings: ReturnType<typeof resolveSettings>, configs: Map<string, string>, io: Io): Promise<number> {
  // Wrangler's debug log goes here, not under HOME: a folder only we can open, removed when this ends.
  const logDir = mkdtempSync(join(tmpdir(), "moss-wrangler-log-"));
  chmodSync(logDir, 0o700);
  try {
    const env = realEnv(merged, logDir);

    // 1. Before anything is deployed: wrangler for every Worker, and each Worker's secret NAMES, so a refusal leaves nothing half done.
    const actions = new Map<string, Record<string, SecretAction>>();
    const values = new Map<string, Record<string, string>>();
    const refusals: string[] = [];
    for (const spec of ordered) {
      const wrangler = wranglerFor(io.root, spec);
      if (!wrangler) {
        io.err(`deploy: ${spec.id}: wrangler is not installed (run the repo's install first); nothing was deployed`);
        return 1;
      }
      const act: Record<string, SecretAction> = {};
      const put: Record<string, string> = {};
      if (!args.skipSecrets && spec.secrets.length > 0) {
        let remote: Set<string> | null;
        try {
          remote = remoteSecrets(io.run, wrangler, configs.get(spec.id)!, join(io.root, spec.dir), env);
        } catch (e) {
          io.err(`deploy: can't read ${spec.id}'s secret list, so nothing was deployed (${(e as Error).message})`);
          return 1;
        }
        for (const sec of spec.secrets) {
          const rotating = args.rotate.includes(sec.env);
          const there = remote?.has(sec.remote) ?? false;
          if (there && !rotating) {
            act[sec.remote] = "keep";
          } else if ((merged[sec.env] ?? "").trim() === "") {
            refusals.push(`${sec.env} is not on the ${spec.id} Worker and is not set`);
          } else {
            act[sec.remote] = rotating && there ? "rotate" : "put";
            put[sec.remote] = merged[sec.env]!;
          }
        }
      }
      actions.set(spec.id, act);
      values.set(spec.id, put);
    }
    if (refusals.length > 0) {
      io.err("deploy: refused, so nothing was deployed:");
      for (const r of refusals) io.err(`  - ${r}`);
      return 2;
    }

    // 2. The plan, and a typed confirmation that names the account.
    const account = (merged.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
    const last4 = account.slice(-4);
    io.out(`account: ...${last4}`);
    io.out("this will deploy, in this order:");
    printPlan(io, buildPlan(io.root, ordered, settings), actions);
    if (args.rotate.includes(ACCOUNT_ID_KEY)) io.out(`WARNING: ${ACCOUNT_ID_KEY} is being replaced: every account's held webhooks become unreachable, for good.`);
    io.out("");
    const answer = (await io.ask(`type "deploy ${last4}" to continue: `)).trim();
    if (answer !== `deploy ${last4}`) {
      io.err("deploy: not confirmed (a real deploy asks for the typed words at a terminal), so nothing was deployed");
      return 2;
    }

    // 3. Each Worker: its code and the secrets it lacks in ONE deploy (wrangler's --secrets-file, read from standard input), so there is no moment a Worker is live without them.
    const done: string[] = [];
    for (const spec of ordered) {
      const cwd = join(io.root, spec.dir);
      const stop = (why: string): number => {
        io.err(`deploy: STOPPED at ${spec.id}: ${why}`);
        io.err(`  already deployed: ${done.length > 0 ? done.join(", ") : "nothing"}. Fix the cause and run the same command again: it redeploys code and leaves the secrets already on a Worker alone.`);
        return 1;
      };
      if (spec.build && !args.noBuild) {
        const b = io.run([...spec.build.command], { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() } });
        if (b.status !== 0) return stop(`its build failed\n${indent(tail(b.stderr || b.stdout))}`);
      }
      const wrangler = wranglerFor(io.root, spec)!;
      const put = values.get(spec.id)!;
      const cmd = [wrangler, "deploy", "--config", configs.get(spec.id)!, ...(Object.keys(put).length > 0 ? ["--secrets-file", "/dev/stdin"] : [])];
      const d = io.run(cmd, { cwd, env, ...(Object.keys(put).length > 0 ? { input: JSON.stringify(put) } : {}) });
      if (d.status !== 0) return stop(`wrangler's deploy failed\n${indent(tail(d.stderr || d.stdout))}`);
      // The secrets this deploy was to put must now be on the Worker: the secrets file is wrangler's to read, so check rather than trust.
      if (Object.keys(put).length > 0) {
        let after: Set<string> | null = null;
        try {
          after = remoteSecrets(io.run, wrangler, configs.get(spec.id)!, cwd, env);
        } catch (e) {
          return stop(`deployed, but its secret list can't be read to check the secrets (${(e as Error).message})`);
        }
        const absent = Object.keys(put).filter((n) => !after?.has(n));
        if (absent.length > 0) return stop(`deployed, but ${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} not on the Worker afterwards; the Worker is live without ${absent.length === 1 ? "it" : "them"}. Run the same command again`);
      }
      done.push(spec.id);
      io.out(`deployed ${spec.id}${Object.keys(put).length > 0 ? ` (secrets put: ${Object.keys(put).join(", ")})` : ""}`);
    }
    io.out("");
    io.out("done. Next: bun scripts/services/post-deploy.ts --smoke (the settings the product needs, and a check of the live Workers).");
    io.out("After the first live run, search this machine's wrangler logs for the first characters of a secret's value (the doc says where): wrangler's log was pointed at a folder that is now removed.");
    return 0;
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

function printPlan(io: Io, steps: PlanStep[], actions: Map<string, Record<string, SecretAction>> | null): void {
  for (const step of steps) {
    io.out(`  ${step.n}. ${step.id}  ->  Worker ${step.worker}`);
    io.out(`       where: ${step.where.join(", ")}`);
    if (step.build) io.out(`       first builds: ${step.build}`);
    if (step.secrets.length > 0) {
      if (actions) {
        const a = actions.get(step.id) ?? {};
        io.out(`       secrets: ${step.secrets.map((s) => `${s.remote} (${a[s.remote] === "keep" ? "already there, left alone" : a[s.remote] === "rotate" ? "REPLACED" : a[s.remote] === "put" ? "put" : "not touched"})`).join(", ")}`);
      } else {
        io.out(`       secrets put if the Worker lacks them: ${step.secrets.map((s) => `${s.remote} (from ${s.env}, ${s.set ? "set" : "not set"})`).join(", ")}`);
      }
    }
    io.out(`       why here: ${step.why}`);
  }
}

/** Fresh values for the secrets the product makes up itself, into a NEW file of mode 600; only the names are printed. */
async function generate(spec: string, out: string, io: Io): Promise<number> {
  const generatable = ENV_NAMES.filter((n) => n.generate && n.name !== "MOSS_RELAY_KEY");
  const wanted = spec === "all" ? generatable.map((n) => n.name) : spec.split(",").map((x) => x.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !ENV_NAMES.some((n) => n.name === w && n.generate));
  if (wanted.length === 0 || unknown.length > 0) {
    io.err(`deploy: --generate takes "all" or names from: ${ENV_NAMES.filter((n) => n.generate).map((n) => n.name).join(", ")}`);
    return 2;
  }
  const lines: string[] = [];
  const done = new Set<GeneratorId | string>();
  for (const name of wanted) {
    const kind = ENV_NAMES.find((n) => n.name === name)!.generate!;
    // The VAPID public and private halves come from one key pair.
    if (kind === "vapid") {
      if (done.has("vapid")) continue;
      done.add("vapid");
      for (const v of await generateSecret("vapid")) lines.push(`${v.name}=${v.value}`);
    } else {
      lines.push(`${name}=${(await generateSecret(kind))[0]!.value}`);
    }
  }
  try {
    // "wx": never over an existing file (it could hold the key a deployment already uses).
    writeFileSync(out, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(out, 0o600);
  } catch (e) {
    io.err(`deploy: ${(e as NodeJS.ErrnoException).code === "EEXIST" ? `${out} already exists; --generate never overwrites` : `can't write ${out}`}`);
    return 2;
  }
  io.out(`wrote ${lines.length} value(s) to ${out} (mode 600): ${lines.map((l) => l.slice(0, l.indexOf("="))).join(", ")}`);
  io.out("merge them into your env file, keep a copy somewhere safe, and delete this file; MOSS_ACCOUNT_ID_KEY must never be lost or changed");
  return 0;
}

const tail = (s: string) => s.trim().split("\n").slice(-12).join("\n");
const indent = (s: string) => s.split("\n").map((l) => `      ${l}`).join("\n");

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env));
}
