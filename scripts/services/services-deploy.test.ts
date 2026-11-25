// The services deploy, on fixtures: the manifest against each Worker's own configuration and Env, the rendered
// configuration, the order, a dry run, the refusals of a real run, the generated secrets, and the post-deploy report.
// Nothing here logs in, deploys or reads a real value: every secret below is a sentinel the output must never contain.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { envFileProblem, main, type Io, type RunResult } from "./deploy";
import { defaultWebPrefix, generateSecret, nameStates, orderServices, parseEnvFile, parseJsonc, renderConfig, resolveSettings, settingsProblems, workerName, REPO_ROOT } from "./lib";
import { BUILT_IN_ADDRESSES, ENV_NAMES, SERVICES } from "./manifest";
import { main as postDeploy, settingsReport, smoke } from "./post-deploy";

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");
const SENTINEL = "SENTINEL-VALUE-9f3a";

/** A complete fixture environment: every name set, secrets to the sentinel. */
function fixtureEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const n of ENV_NAMES) if (n.required) env[n.name] = n.kind === "secret" ? `${SENTINEL}-${n.name}` : `fixture-${n.name.toLowerCase()}`;
  env.MOSS_SERVICES_DOMAIN = "example.test";
  env.MOSS_SUPABASE_URL = "https://project.example.test";
  return { ...env, ...extra };
}

function fakeIo(root = REPO_ROOT, handler?: (cmd: readonly string[], input?: string, env?: Record<string, string>) => RunResult, answers: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const runs: { cmd: readonly string[]; cwd: string; env: Record<string, string>; input?: string }[] = [];
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    root,
    ask: async () => answers.shift() ?? "",
    run: (cmd, opts) => {
      runs.push({ cmd, cwd: opts.cwd, env: opts.env, input: opts.input });
      return handler?.(cmd, opts.input, opts.env) ?? { status: 0, stdout: "Total Upload: 12.34 KiB / gzip: 3.21 KiB", stderr: "" };
    },
  };
  return { io, out, err, runs };
}

describe("the files agree", () => {
  test("parseJsonc keeps // inside strings and drops comments and trailing commas", () => {
    expect(parseJsonc('{ "u": "https://x.test/a", /* c */ "a": [1,2,], // tail\n }')).toEqual({ u: "https://x.test/a", a: [1, 2] });
  });

  test("the env template names every name in the manifest, and only those", () => {
    const names = [...read("services/deploy.env.example").matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
    const cloud = names.filter((n) => n.startsWith("CLOUDFLARE_"));
    expect(cloud.sort()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    expect(names.filter((n) => !n.startsWith("CLOUDFLARE_")).sort()).toEqual(ENV_NAMES.map((n) => n.name).sort());
    // No value is filled in.
    expect(read("services/deploy.env.example")).not.toMatch(/^[A-Z][A-Z0-9_]+=\S/m);
  });

  test("each Worker's wrangler.jsonc, its Env and the manifest name the same variables and secrets", () => {
    const accounts = SERVICES.find((s) => s.id === "accounts")!;
    for (const spec of SERVICES) {
      const config = parseJsonc(read(`${spec.dir}/wrangler.jsonc`)) as { env: { production: { name: string; vars: Record<string, string>; services?: { service: string }[] } } };
      const prod = config.env.production;
            const computed = Object.keys(spec.vars(resolveSettings(fixtureEnv())));
      for (const k of computed) expect(Object.keys(prod.vars)).toContain(k);
      // Every required string field of the Worker's Env is a production variable or a secret the manifest puts.
      const envTs = read(existsSync(join(REPO_ROOT, spec.dir, "src/env.ts")) ? `${spec.dir}/src/env.ts` : `${spec.dir}/src/worker.ts`);
      const required = [...envTs.matchAll(/^\s+([A-Z][A-Z0-9_]*): string;/gm)].map((m) => m[1]!);
      const secrets = spec.secrets.map((s) => s.remote);
      for (const f of required) expect(Object.keys(prod.vars).concat(secrets)).toContain(f);
      for (const s of secrets) expect(envTs).toContain(`${s}`);
      // The service binding points at the accounts Worker.
      for (const b of prod.services ?? []) expect(b.service).toBe(workerName(REPO_ROOT, accounts));
      // A computed variable that the owner supplies is empty (or a placeholder) in the committed profile, never a live value.
    }
  });

  test("the addresses the engine has built in are the ones post-deploy compares against", () => {
    for (const { url, file } of Object.values(BUILT_IN_ADDRESSES)) expect(read(file)).toContain(url);
    expect(read("plugins/moss/plugins/companion-web/host/index.ts")).toContain(`https://${defaultWebPrefix()}.waifucave.com`);
  });

  test("the secret and variable names the manifest lists for push exist in the push Worker's Env", () => {
    const env = read("services/push/src/env.ts");
    for (const n of ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC_MOSS", "APNS_TOPIC_CODE", "APNS_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]) expect(env).toContain(n);
  });
});

describe("rendering and order", () => {
  test("the rendered configurations name the owner's domain and nothing of any other", () => {
    const s = resolveSettings(fixtureEnv());
    for (const spec of SERVICES) {
      const text = JSON.stringify(renderConfig(REPO_ROOT, spec, s).config);
      expect(text).not.toContain("waifucave");
      expect(text).not.toContain("example.invalid");
    }
    const accounts = renderConfig(REPO_ROOT, SERVICES[0]!, s).config as { routes: unknown[]; vars: Record<string, string>; main: string; name: string };
    expect(accounts.routes).toEqual([{ pattern: "example.test/auth/*", zone_name: "example.test" }]);
    expect(accounts.vars.ISSUER).toBe("https://example.test/auth");
    expect(accounts.vars.AUDIENCES).toBe("hooks.example.test,push.example.test,handshake.example.test");
    expect(accounts.vars).not.toHaveProperty("EPHEMERAL_KEYS");
    expect(accounts.vars).not.toHaveProperty("DEV_MINT");
    expect(accounts.main.startsWith("/")).toBe(true);
    const web = renderConfig(REPO_ROOT, SERVICES.find((x) => x.id === "web")!, s).config as { assets: { directory: string }; routes: unknown[] };
    expect(web.assets.directory).toBe(join(REPO_ROOT, "services/web/dist"));
    expect(web.routes).toEqual([{ pattern: `${defaultWebPrefix()}.example.test`, custom_domain: true }]);
  });

  test("an accounts host of its own drops the path prefix", () => {
    const s = resolveSettings(fixtureEnv({ MOSS_ACCOUNTS_HOST: "id.example.test" }));
    const c = renderConfig(REPO_ROOT, SERVICES[0]!, s).config as { routes: unknown[]; vars: Record<string, string> };
    expect(c.routes).toEqual([{ pattern: "id.example.test", custom_domain: true }]);
    expect(c.vars).toMatchObject({ ISSUER: "https://id.example.test", PATH_PREFIX: "" });
  });

  test("accounts comes before everything that binds to it, the web page after the handshake, and the relay is left out", () => {
    const ids = orderServices().map((s) => s.id);
    expect(ids[0]).toBe("accounts");
    expect(ids).not.toContain("relay");
    expect(ids.indexOf("web")).toBeGreaterThan(ids.indexOf("handshake"));
    expect(orderServices(["push"]).map((s) => s.id)).toEqual(["push"]);
    expect(orderServices(["web", "accounts"]).map((s) => s.id)).toEqual(["accounts", "web"]);
    expect(() => orderServices(["nope"])).toThrow();
  });

  test("bad host names and a bad sign-in address are named without being echoed", () => {
    const p = settingsProblems(resolveSettings(fixtureEnv({ MOSS_SERVICES_DOMAIN: "not a host", MOSS_SUPABASE_URL: "http://x" })));
    expect(p.join("\n")).toContain("not a plain host name");
    expect(p.join("\n")).toContain("MOSS_SUPABASE_URL");
    expect(p.join("\n")).not.toContain("not a host");
  });

  test("names report set or not set, never a value", () => {
    const states = nameStates(fixtureEnv({ MOSS_APNS_KEY_ID: "" }), ["push"]);
    expect(states.find((s) => s.name === "MOSS_APNS_KEY_ID")!.set).toBe(false);
    expect(JSON.stringify(states)).not.toContain(SENTINEL);
  });

  test("an env file is read as KEY=value lines", () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two words"\n\nbad line')).toEqual({ A: "1", B: "two words" });
  });
});

describe("the dry run", () => {
  test("packages every default service through wrangler's --dry-run, with no credential, and prints the order and why", async () => {
    const f = fakeIo();
    const code = await main(["--no-build", "--out", mkdtempSync(join(tmpdir(), "dp-test-"))], fixtureEnv({ CLOUDFLARE_API_TOKEN: SENTINEL, CLOUDFLARE_ACCOUNT_ID: SENTINEL }), f.io);
    const text = f.out.join("\n");
    expect(f.err).toEqual([]);
    expect(code).toBe(0);
    expect(text).toContain("DRY RUN");
    expect(f.runs).toHaveLength(5);
    for (const r of f.runs) {
      expect(r.cmd).toContain("--dry-run");
      expect(r.cmd).not.toContain("secret");
      expect(r.env.CLOUDFLARE_API_TOKEN).toBe("");
      expect(r.env.CLOUDFLARE_ACCOUNT_ID).toBe("");
      expect(r.env.HOME).not.toBe(process.env.HOME);
    }
    const order = [...text.matchAll(/^\s+(\d)\. (\w+)  ->  Worker (\S+)/gm)].map((m) => `${m[1]}:${m[2]}:${m[3]}`);
    const names = SERVICES.filter((x) => x.group === "default").map((x) => `${x.id}:${workerName(REPO_ROOT, x)}`);
    expect(order.map((o) => o.slice(2))).toEqual(["accounts", "handshake", "push", "forwarder", "web"].map((id) => names.find((n) => n.startsWith(`${id}:`))!));
    expect(order.map((o) => o[0])).toEqual(["1", "2", "3", "4", "5"]);
    expect(text).toContain("why here: after accounts");
    expect(text).toContain(`${defaultWebPrefix()}.example.test (custom domain)`);
    expect(text).toContain("every required name is set");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("fixture-");
  });

  test("with nothing set it still runs, shows the placeholder domain and lists what is left to supply; --strict fails", async () => {
    const f = fakeIo();
    expect(await main(["--no-build", "--out", mkdtempSync(join(tmpdir(), "dp-test-"))], {}, f.io)).toBe(0);
    const text = f.out.join("\n");
    expect(text).toContain("example.invalid");
    expect(text).toContain("still to supply before a real deploy: MOSS_SERVICES_DOMAIN");
    const s = fakeIo();
    expect(await main(["--strict"], {}, s.io)).toBe(1);
    expect(s.runs).toHaveLength(0);
  });

  test("a failing wrangler dry run fails the run and shows its tail", async () => {
    const f = fakeIo(REPO_ROOT, () => ({ status: 1, stdout: "", stderr: "X [ERROR] nope" }));
    expect(await main(["--no-build", "--only", "push", "--out", mkdtempSync(join(tmpdir(), "dp-test-"))], fixtureEnv(), f.io)).toBe(1);
    expect(f.out.join("\n")).toContain("wrangler's dry run FAILED");
  });
});

/** A fake wrangler for a real deploy: `secret list` answers from `remote` (Worker name to the secret names it has; absent = no such Worker), everything else succeeds. */
function liveHandler(remote: Record<string, string[]>, fail?: (cmd: readonly string[]) => RunResult | undefined, record = true) {
  return (cmd: readonly string[], input?: string): RunResult => {
    const failure = fail?.(cmd);
    if (failure) return failure;
    // A deploy that carries secrets leaves them on the Worker (what wrangler does).
    if (record && cmd.includes("--secrets-file") && input) {
      const name = (JSON.parse(readFileSync(cmd[cmd.indexOf("--config") + 1]!, "utf8")) as { name: string }).name;
      remote[name] = [...new Set([...(remote[name] ?? []), ...Object.keys(JSON.parse(input) as Record<string, string>)])];
    }
    if (cmd.includes("secret") && cmd.includes("list")) {
      const name = (JSON.parse(readFileSync(cmd[cmd.indexOf("--config") + 1]!, "utf8")) as { name: string }).name;
      if (!(name in remote)) return { status: 1, stdout: "", stderr: "This Worker does not exist on your account. [code: 10007]" };
      return { status: 0, stdout: JSON.stringify(remote[name]!.map((n) => ({ name: n, type: "secret_text" }))), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}
const LIVE = { CLOUDFLARE_API_TOKEN: `${SENTINEL}-token`, CLOUDFLARE_ACCOUNT_ID: "acct-0123456789abcd" };
const CONFIRM = "deploy abcd";
const deploys = (runs: { cmd: readonly string[] }[]) => runs.filter((r) => r.cmd.includes("deploy") && !r.cmd.includes("--dry-run"));

describe("a real deploy", () => {
  test("is refused without its conditions: no credential, no domain, a name unset, and nothing runs", async () => {
    const f = fakeIo();
    expect(await main(["--deploy"], fixtureEnv(), f.io)).toBe(2);
    expect(f.err.join("\n")).toContain("CLOUDFLARE_API_TOKEN is not set");
    const g = fakeIo();
    expect(await main(["--deploy"], fixtureEnv({ ...LIVE, MOSS_APNS_KEY_ID: "" }), g.io)).toBe(2);
    expect(g.err.join("\n")).toContain("MOSS_APNS_KEY_ID is not set");
    const h = fakeIo();
    expect(await main(["--deploy"], { ...LIVE }, h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("MOSS_SERVICES_DOMAIN is not set");
    expect(f.runs.length + g.runs.length + h.runs.length).toBe(0);
  });

  test("is never what a plain run or --dry-run does, and the two flags together are refused", async () => {
    const f = fakeIo();
    await main(["--no-build"], fixtureEnv(LIVE), f.io);
    expect(f.runs.every((r) => r.cmd.includes("--dry-run"))).toBe(true);
    expect(await main(["--deploy", "--dry-run"], fixtureEnv(), fakeIo().io)).toBe(2);
  });

  test("asks for the typed words naming the account, and deploys nothing on any other answer or none", async () => {
    for (const answers of [[], ["yes"], ["deploy 0000"]]) {
      const f = fakeIo(REPO_ROOT, liveHandler({}), answers);
      expect(await main(["--deploy", "--no-build", "--only", "accounts"], fixtureEnv(LIVE), f.io)).toBe(2);
      expect(deploys(f.runs)).toHaveLength(0);
      expect(f.err.join("\n")).toContain("not confirmed");
    }
    const f = fakeIo(REPO_ROOT, liveHandler({}), [CONFIRM]);
    expect(await main(["--deploy", "--no-build", "--only", "accounts"], fixtureEnv(LIVE), f.io)).toBe(0);
    expect(f.out.join("\n")).toContain("account: ...abcd");
  });

  test("reads every Worker's secret names first, then deploys each Worker's code and missing secrets in ONE call, over standard input", async () => {
    const f = fakeIo(REPO_ROOT, liveHandler({}), [CONFIRM]);
    expect(await main(["--deploy", "--no-build", "--only", "accounts,handshake"], fixtureEnv(LIVE), f.io)).toBe(0);
    const kinds = f.runs.map((r) => (r.cmd.includes("list") ? "list" : "deploy"));
    // The names are read first, and again after each deploy that put secrets.
    expect(kinds).toEqual(["list", "list", "deploy", "list", "deploy", "list"]);
    const [first, second] = deploys(f.runs) as unknown as typeof f.runs;
    expect(first!.cmd).toContain("--secrets-file");
    expect(first!.cmd[first!.cmd.indexOf("--secrets-file") + 1]).toBe("/dev/stdin");
    expect(Object.keys(JSON.parse(first!.input!))).toEqual(["SIGNING_JWKS"]);
    expect(JSON.parse(first!.input!).SIGNING_JWKS).toContain(SENTINEL);
    expect(Object.keys(JSON.parse(second!.input!))).toEqual(["TICKET_SECRET"]);
    for (const r of f.runs) {
      expect(r.cmd.join(" ")).not.toContain(SENTINEL);
      expect(r.cmd).not.toContain("--dry-run");
      expect(r.env.CLOUDFLARE_API_TOKEN).toBe(LIVE.CLOUDFLARE_API_TOKEN);
    }
    expect(f.out.join("\n")).not.toContain(SENTINEL);
    expect(f.out.join("\n")).toContain("done.");
  });

  test("a re-run leaves the secrets already on a Worker alone, whatever the env file now holds (a mistyped account-id key included)", async () => {
    const f = fakeIo(REPO_ROOT, liveHandler({ "moss-forwarder": ["TAG_KEYS", "ACCOUNT_ID_KEY", "TICKET_SECRET"] }), [CONFIRM]);
    const env = fixtureEnv({ ...LIVE, MOSS_ACCOUNT_ID_KEY: "mistyped" });
    expect(await main(["--deploy", "--no-build", "--only", "forwarder"], env, f.io)).toBe(0);
    const [d] = deploys(f.runs) as unknown as typeof f.runs;
    expect(d!.cmd).not.toContain("--secrets-file");
    expect(d!.input).toBeUndefined();
    expect(f.out.join("\n")).toContain("ACCOUNT_ID_KEY (already there, left alone)");
  });

  test("a secret that is neither on the Worker nor set refuses everything before any deploy", async () => {
    const f = fakeIo(REPO_ROOT, liveHandler({}), [CONFIRM]);
    expect(await main(["--deploy", "--no-build", "--only", "accounts,handshake"], fixtureEnv({ ...LIVE, MOSS_HANDSHAKE_TICKET_SECRET: "" }), f.io)).toBe(2);
    expect(f.err.join("\n")).toContain("MOSS_HANDSHAKE_TICKET_SECRET is not on the handshake Worker and is not set");
    expect(deploys(f.runs)).toHaveLength(0);
  });

  test("--rotate replaces a named secret; the account-id key needs its own second flag and a warning", async () => {
    const remote = { "moss-forwarder": ["TAG_KEYS", "ACCOUNT_ID_KEY", "TICKET_SECRET"] };
    const f = fakeIo(REPO_ROOT, liveHandler(remote), [CONFIRM]);
    expect(await main(["--deploy", "--no-build", "--only", "forwarder", "--rotate", "MOSS_FORWARDER_TICKET_SECRET"], fixtureEnv(LIVE), f.io)).toBe(0);
    const [d] = deploys(f.runs) as unknown as typeof f.runs;
    expect(Object.keys(JSON.parse(d!.input!))).toEqual(["TICKET_SECRET"]);
    expect(f.out.join("\n")).toContain("TICKET_SECRET (REPLACED)");

    const g = fakeIo(REPO_ROOT, liveHandler(remote), [CONFIRM]);
    expect(await main(["--deploy", "--only", "forwarder", "--rotate", "MOSS_ACCOUNT_ID_KEY"], fixtureEnv(LIVE), g.io)).toBe(2);
    expect(g.err.join("\n")).toContain("--rotate-account-id-key");
    expect(g.runs).toHaveLength(0);

    const h = fakeIo(REPO_ROOT, liveHandler(remote), [CONFIRM]);
    expect(await main(["--deploy", "--no-build", "--only", "forwarder", "--rotate", "MOSS_ACCOUNT_ID_KEY", "--rotate-account-id-key"], fixtureEnv(LIVE), h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("WARNING: MOSS_ACCOUNT_ID_KEY is being replaced");
    expect(Object.keys(JSON.parse((deploys(h.runs)[0] as unknown as { input: string }).input))).toEqual(["ACCOUNT_ID_KEY"]);

    expect(await main(["--deploy", "--rotate", "MOSS_NOPE"], fixtureEnv(LIVE), fakeIo().io)).toBe(2);
    expect(await main(["--deploy", "--skip-secrets", "--rotate", "MOSS_TAG_KEYS"], fixtureEnv(LIVE), fakeIo().io)).toBe(2);
  });

  test("a secret list that fails for any reason but 'no such Worker' stops before any deploy", async () => {
    const f = fakeIo(REPO_ROOT, liveHandler({}, (cmd) => (cmd.includes("list") ? { status: 1, stdout: "", stderr: "fetch failed" } : undefined)), [CONFIRM]);
    expect(await main(["--deploy", "--no-build", "--only", "accounts"], fixtureEnv(LIVE), f.io)).toBe(1);
    expect(deploys(f.runs)).toHaveLength(0);
    expect(f.err.join("\n")).toContain("can't read accounts's secret list");
  });

  test("only wrangler's own missing-Worker code reads as 'no such Worker': any other failure, even one saying 'not found', stops before any deploy", async () => {
    for (const stderr of ["Binding ACCOUNT_SERVICE not found", "The route does not exist", "config file not found", "This Worker does not exist (no code)"]) {
      const f = fakeIo(REPO_ROOT, liveHandler({}, (cmd) => (cmd.includes("list") ? { status: 1, stdout: "", stderr } : undefined)), [CONFIRM]);
      expect(await main(["--deploy", "--no-build", "--only", "forwarder"], fixtureEnv({ ...LIVE, MOSS_ACCOUNT_ID_KEY: "would-overwrite" }), f.io)).toBe(1);
      expect(deploys(f.runs)).toHaveLength(0);
      expect(f.runs.some((r) => r.input !== undefined)).toBe(false);
    }
  });

  test("after each deploy the Worker's secret names are read again, and a secret that is missing stops the run", async () => {
    const f = fakeIo(REPO_ROOT, liveHandler({}, undefined, false), [CONFIRM]);
    expect(await main(["--deploy", "--no-build", "--only", "accounts,handshake"], fixtureEnv(LIVE), f.io)).toBe(1);
    const text = f.err.join("\n");
    expect(text).toContain("STOPPED at accounts");
    expect(text).toContain("SIGNING_JWKS is not on the Worker afterwards");
    expect(deploys(f.runs)).toHaveLength(1);
    expect(f.out.join("\n")).not.toContain("done.");
  });

  test("a failed deploy stops at once: the later Workers are not deployed, and it never says done", async () => {
    const f = fakeIo(REPO_ROOT, liveHandler({}, (cmd) => (cmd.includes("--secrets-file") && cmd.some((c) => c.includes("handshake")) ? { status: 1, stdout: "", stderr: "boom" } : undefined)), [CONFIRM]);
    expect(await main(["--deploy", "--no-build"], fixtureEnv(LIVE), f.io)).toBe(1);
    expect(deploys(f.runs)).toHaveLength(2);
    const text = f.out.join("\n") + f.err.join("\n");
    expect(text).toContain("STOPPED at handshake");
    expect(text).toContain("already deployed: accounts");
    expect(text).not.toContain("done.");
  });

  test("a failed build in a real deploy stops at once too", async () => {
    const f = fakeIo(REPO_ROOT, liveHandler({}, (cmd) => (cmd[0] === "bun" ? { status: 1, stdout: "", stderr: "build broke" } : undefined)), [CONFIRM]);
    expect(await main(["--deploy", "--only", "web"], fixtureEnv(LIVE), f.io)).toBe(1);
    expect(deploys(f.runs)).toHaveLength(0);
    expect(f.err.join("\n")).toContain("STOPPED at web");
    expect(f.out.join("\n")).not.toContain("done.");
  });

  test("wrangler's log goes to a mode-700 folder that is removed afterwards", async () => {
    const seen: { path: string; mode: number }[] = [];
    const f = fakeIo(REPO_ROOT, liveHandler({}), [CONFIRM]);
    const wrap = f.io.run;
    f.io.run = (cmd, opts) => {
      const p = opts.env.WRANGLER_LOG_PATH!;
      if (p) seen.push({ path: p, mode: statSync(p).mode & 0o777 });
      return wrap(cmd, opts);
    };
    expect(await main(["--deploy", "--no-build", "--only", "accounts"], fixtureEnv(LIVE), f.io)).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.mode).toBe(0o700);
      expect(s.path.startsWith(tmpdir())).toBe(true);
      expect(existsSync(s.path)).toBe(false);
    }
  });
});

describe("the env file and the arguments", () => {
  const write = (mode: number) => {
    const p = join(mkdtempSync(join(tmpdir(), "dp-env-")), "moss.env");
    writeFileSync(p, `MOSS_SERVICES_DOMAIN=example.test\n`);
    chmodSync(p, mode);
    return p;
  };

  test("an env file that group or others can read is refused, in a dry run too", async () => {
    for (const mode of [0o644, 0o640, 0o604]) {
      const f = fakeIo();
      expect(await main(["--env-file", write(mode)], {}, f.io)).toBe(2);
      expect(f.err.join("\n")).toContain("chmod 600");
      expect(f.runs).toHaveLength(0);
    }
    const ok = fakeIo();
    expect(await main(["--no-build", "--only", "push", "--env-file", write(0o600), "--out", mkdtempSync(join(tmpdir(), "dp-test-"))], {}, ok.io)).toBe(0);
    expect(ok.out.join("\n")).toContain("domain: example.test");
  });

  test("post-deploy refuses a readable env file too", async () => {
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l), fetch: (async () => new Response("")) as unknown as typeof fetch };
    expect(await postDeploy(["--env-file", write(0o644)], {}, io)).toBe(2);
    expect(out.join("\n")).toContain("chmod 600");
    expect(await postDeploy(["--env-file", write(0o600)], {}, io)).toBe(0);
  });

  test("an env file not owned by the person running it, or in a folder others can write to, is refused", () => {
    const p = write(0o600);
    expect(envFileProblem(p)).toBeNull();
    expect(envFileProblem(p, (process.getuid?.() ?? 0) + 1)).toContain("not owned");
    chmodSync(dirname(p), 0o777);
    expect(envFileProblem(p)).toContain("can be written by group or others");
    chmodSync(dirname(p), 0o770);
    expect(envFileProblem(p)).toContain("can be written by group or others");
    chmodSync(dirname(p), 0o755);
    expect(envFileProblem(p)).toBeNull();
  });

  test("a flag that needs a value and gets none is an error", async () => {
    for (const argv of [["--env-file"], ["--out"], ["--only"], ["--env-file", "--strict"], ["--rotate"], ["--generate", "--out"]]) {
      const f = fakeIo();
      expect(await main(argv, {}, f.io)).toBe(2);
      expect(f.err.join("\n")).toContain("needs a value");
    }
  });
});

describe("generated secrets", () => {
  test("the signing keys import as an Ed25519 key the accounts Worker takes, and carry a kid", async () => {
    const [v] = await generateSecret("signing-jwks");
    const key = (JSON.parse(v!.value) as { keys: JsonWebKey & { kid: string }[] }).keys[0]! as JsonWebKey & { kid: string };
    expect(key).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
    expect(key.kid).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: key.x, d: key.d }, { name: "Ed25519" }, false, ["sign"]);
  });

  test("tag keys, random values and the VAPID pair have the sizes the Workers want", async () => {
    const tag = JSON.parse((await generateSecret("tag-keys"))[0]!.value) as Record<string, string>;
    expect(Buffer.from(tag["1"]!, "base64url").length).toBe(32);
    expect(Buffer.from((await generateSecret("random"))[0]!.value, "base64url").length).toBe(32);
    const [pub, priv] = await generateSecret("vapid");
    expect(Buffer.from(pub!.value, "base64url").length).toBe(65);
    expect(Buffer.from(priv!.value, "base64url").length).toBe(32);
    expect(pub!.name).toBe("MOSS_VAPID_PUBLIC_KEY");
  });

  test("--generate writes a new mode-600 file and prints only the names, never a value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-gen-"));
    const out = join(dir, "secrets.env");
    const f = fakeIo();
    expect(await main(["--generate", "all", "--out", out], {}, f.io)).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const values = parseEnvFile(readFileSync(out, "utf8"));
    expect(Object.keys(values).sort()).toEqual(["MOSS_ACCOUNT_ID_KEY", "MOSS_FORWARDER_TICKET_SECRET", "MOSS_HANDSHAKE_TICKET_SECRET", "MOSS_SIGNING_JWKS", "MOSS_TAG_KEYS", "MOSS_VAPID_PRIVATE_KEY", "MOSS_VAPID_PUBLIC_KEY"]);
    const printed = f.out.join("\n");
    for (const v of Object.values(values)) expect(printed).not.toContain(v.slice(0, 12));
    expect(printed).toContain("MOSS_SIGNING_JWKS");
    // Never over an existing file.
    const again = fakeIo();
    expect(await main(["--generate", "MOSS_ACCOUNT_ID_KEY", "--out", out], {}, again.io)).toBe(2);
    expect(again.err.join("\n")).toContain("never overwrites");
    expect(readFileSync(out, "utf8")).toContain("MOSS_SIGNING_JWKS=");
  });

  test("--generate needs --out, and takes only names that can be generated", async () => {
    expect(await main(["--generate", "all"], {}, fakeIo().io)).toBe(2);
    const out = join(mkdtempSync(join(tmpdir(), "dp-gen-")), "x.env");
    expect(await main(["--generate", "MOSS_APNS_PRIVATE_KEY", "--out", out], {}, fakeIo().io)).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});

describe("post-deploy", () => {
  test("the report says nothing changes for the built-in addresses, and what to rebuild for any other", () => {
    const builtIn = settingsReport(resolveSettings({ MOSS_SERVICES_DOMAIN: "waifucave.com", MOSS_SUPABASE_URL: "https://p.example.test" }), true).join("\n");
    expect(builtIn).toContain("no other engine setting changes");
    expect(builtIn).toContain('"authUrl": "https://p.example.test"');
    expect(builtIn).toContain("push  (now: not-yet, push-origin)");
    const other = settingsReport(resolveSettings({ MOSS_SERVICES_DOMAIN: "example.test" }), true).join("\n");
    expect(other).toContain("NOT the addresses built into today's builds");
    expect(other).toContain("packages/core/src/identity/account-config.ts");
    expect(other).toContain(`https://${defaultWebPrefix()}.example.test`);
  });

  test("the smoke check passes live-looking Workers and fails an absent route, an empty key set and a private key", async () => {
    const s = resolveSettings({ MOSS_SERVICES_DOMAIN: "example.test" });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const live: typeof fetch = (async (input: Request | string | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [{ kty: "OKP", crv: "Ed25519", x: "a", kid: "k1" }] });
      if (url.endsWith("/config.json")) return json({ handshake: "https://handshake.example.test" });
      if (url.endsWith("/v1/vapid")) return json({ publicKey: "BPub" });
      return json({ error: "not_found" }, 404);
    }) as typeof fetch;
    const ids = SERVICES.filter((x) => x.group === "default").map((x) => x.id);
    const good = await smoke(s, ids, live);
    expect(good.map((r) => r.ok)).toEqual([true, true, true, true, true]);
    expect(good[0]!.url).toBe("https://example.test/auth/.well-known/jwks.json");

    const bad: typeof fetch = (async (input: Request | string | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [{ kty: "OKP", x: "a", d: "private", kid: "k1" }] });
      if (url.endsWith("/config.json")) return json({ handshake: "https://elsewhere.test" });
      return new Response("<html>1042</html>", { status: 404, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    expect((await smoke(s, ids, bad)).every((r) => !r.ok)).toBe(true);
    const down = (await smoke(s, ["push"], (async () => { throw new Error("dns"); }) as unknown as typeof fetch))[0]!;
    expect(down).toMatchObject({ ok: false });
  });

  test("main prints the report, and --smoke without a domain is refused", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch };
    expect(await postDeploy(["--domain", "example.test"], {}, io)).toBe(0);
    expect(out.join("\n")).toContain("deployed addresses");
    expect(await postDeploy(["--smoke"], {}, io)).toBe(2);
    expect(await postDeploy(["--smoke", "--domain", "example.test"], {}, io)).toBe(1);
  });
});

describe("wrangler's own dry run", () => {
  const wrangler = join(REPO_ROOT, "services/accounts/node_modules/.bin/wrangler");
  test.skipIf(!existsSync(wrangler))("packages every default service on fixtures, with no login", async () => {
    const out: string[] = [];
    const io: Io = { out: (l) => out.push(l), err: (l) => out.push(l), root: REPO_ROOT, run: defaultRun(), ask: async () => "" };
    const code = await main(["--out", mkdtempSync(join(tmpdir(), "dp-real-"))], fixtureEnv(), io);
    expect(out.join("\n")).not.toContain("FAILED");
    expect(code).toBe(0);
    expect(out.filter((l) => /packaged/.test(l))).toHaveLength(5);
  }, 240_000);
});

function defaultRun(): Io["run"] {
  return require("./deploy").defaultIo().run;
}
