// The services deploy, on fixtures: the manifest against each Worker's own configuration and Env, the rendered
// configuration, the order, a dry run, the refusals of a real run, the generated secrets, and the post-deploy report.
// Nothing here logs in, deploys or reads a real value: every secret below is a sentinel the output must never contain.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io, type RunResult } from "./deploy";
import { generateSecret, nameStates, orderServices, parseEnvFile, parseJsonc, renderConfig, resolveSettings, settingsProblems, REPO_ROOT } from "./lib";
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

function fakeIo(root = REPO_ROOT, handler?: (cmd: readonly string[], input?: string, env?: Record<string, string>) => RunResult) {
  const out: string[] = [];
  const err: string[] = [];
  const runs: { cmd: readonly string[]; cwd: string; env: Record<string, string>; input?: string }[] = [];
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    root,
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
      expect(prod.name).toBe(spec.worker);
      const computed = Object.keys(spec.vars(resolveSettings(fixtureEnv())));
      for (const k of computed) expect(Object.keys(prod.vars)).toContain(k);
      // Every required string field of the Worker's Env is a production variable or a secret the manifest puts.
      const envTs = read(existsSync(join(REPO_ROOT, spec.dir, "src/env.ts")) ? `${spec.dir}/src/env.ts` : `${spec.dir}/src/worker.ts`);
      const required = [...envTs.matchAll(/^\s+([A-Z][A-Z0-9_]*): string;/gm)].map((m) => m[1]!);
      const secrets = spec.secrets.map((s) => s.remote);
      for (const f of required) expect(Object.keys(prod.vars).concat(secrets)).toContain(f);
      for (const s of secrets) expect(envTs).toContain(`${s}`);
      // The service binding points at the accounts Worker.
      for (const b of prod.services ?? []) expect(b.service).toBe(accounts.worker);
      // A computed variable that the owner supplies is empty (or a placeholder) in the committed profile, never a live value.
    }
  });

  test("the addresses the engine has built in are the ones post-deploy compares against", () => {
    for (const { url, file } of Object.values(BUILT_IN_ADDRESSES)) expect(read(file)).toContain(url);
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
    expect(web.routes).toEqual([{ pattern: "clover.example.test", custom_domain: true }]);
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
    expect(order).toEqual(["1:accounts:clover-accounts", "2:handshake:clover-handshake", "3:push:clover-push", "4:forwarder:clover-forwarder", "5:web:clover-web"]);
    expect(text).toContain("why here: after accounts");
    expect(text).toContain("clover.example.test (custom domain)");
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

describe("a real deploy", () => {
  test("is refused without its flag's conditions: no credential, no domain, a name unset", async () => {
    const f = fakeIo();
    expect(await main(["--deploy"], fixtureEnv(), f.io)).toBe(2);
    expect(f.err.join("\n")).toContain("CLOUDFLARE_API_TOKEN is not in the environment");
    const g = fakeIo();
    const env = fixtureEnv({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", MOSS_APNS_PRIVATE_KEY: "" });
    expect(await main(["--deploy"], env, g.io)).toBe(2);
    expect(g.err.join("\n")).toContain("MOSS_APNS_PRIVATE_KEY is not set");
    expect(f.runs).toHaveLength(0);
    expect(g.runs).toHaveLength(0);
    const h = fakeIo();
    expect(await main(["--deploy"], { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }, h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("MOSS_SERVICES_DOMAIN is not set");
  });

  test("is never what a plain run or --dry-run does, and the two flags together are refused", async () => {
    const f = fakeIo();
    await main(["--no-build"], fixtureEnv({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }), f.io);
    expect(f.runs.every((r) => r.cmd.includes("--dry-run"))).toBe(true);
    expect(await main(["--deploy", "--dry-run"], fixtureEnv(), fakeIo().io)).toBe(2);
  });

  test("deploys in order, then puts each Worker's secrets over standard input only", async () => {
    const f = fakeIo();
    const env = fixtureEnv({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" });
    expect(await main(["--deploy", "--no-build", "--only", "accounts,handshake"], env, f.io)).toBe(0);
    const kinds = f.runs.map((r) => (r.cmd.includes("secret") ? "secret" : "deploy"));
    expect(kinds).toEqual(["deploy", "secret", "deploy", "secret"]);
    for (const r of f.runs) {
      expect(r.cmd).not.toContain("--dry-run");
      expect(r.cmd.join(" ")).not.toContain(SENTINEL);
      expect(r.env.CLOUDFLARE_API_TOKEN).toBe("t");
    }
    const body = JSON.parse(f.runs[1]!.input!) as Record<string, string>;
    expect(Object.keys(body)).toEqual(["SIGNING_JWKS"]);
    expect(body.SIGNING_JWKS).toContain(SENTINEL);
    expect(f.out.join("\n")).not.toContain(SENTINEL);
  });

  test("--skip-secrets deploys code only and does not need the secrets", async () => {
    const f = fakeIo();
    const env = fixtureEnv({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", MOSS_SIGNING_JWKS: "" });
    expect(await main(["--deploy", "--skip-secrets", "--no-build", "--only", "accounts"], env, f.io)).toBe(0);
    expect(f.runs).toHaveLength(1);
  });

  test("a failed deploy stops before the next Worker", async () => {
    const f = fakeIo(REPO_ROOT, () => ({ status: 1, stdout: "", stderr: "boom" }));
    const env = fixtureEnv({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" });
    expect(await main(["--deploy", "--no-build"], env, f.io)).toBe(1);
    expect(f.runs).toHaveLength(1);
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

  test("--generate prints a value and an unknown kind is refused", async () => {
    const f = fakeIo();
    expect(await main(["--generate", "random"], {}, f.io)).toBe(0);
    expect(f.out[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await main(["--generate", "x"], {}, fakeIo().io)).toBe(2);
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
    expect(other).toContain("https://clover.example.test");
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
    const io: Io = { out: (l) => out.push(l), err: (l) => out.push(l), root: REPO_ROOT, run: defaultRun() };
    const code = await main(["--out", mkdtempSync(join(tmpdir(), "dp-real-"))], fixtureEnv(), io);
    expect(out.join("\n")).not.toContain("FAILED");
    expect(code).toBe(0);
    expect(out.filter((l) => /packaged/.test(l))).toHaveLength(5);
  }, 240_000);
});

function defaultRun(): Io["run"] {
  return require("./deploy").defaultIo().run;
}
