// The account service's tests run inside workerd through @cloudflare/vitest-plugin. The one outbound call the Worker
// makes, Supabase's GET /auth/v1/user, is answered here by a fake project (https://auth.test) whose sessions the
// tests open and close. Every key is made fresh for the run, in memory; nothing is written to disk.
// test/node/e2e.test.ts runs the same Worker against lane M's real sign-in stub instead.

import { generateKeyPairSync, randomBytes } from "node:crypto";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const ed25519 = generateKeyPairSync("ed25519");
const es256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
// The first key signs; both are published, as during a rotation.
const signingJwks = JSON.stringify({
  keys: [
    { ...ed25519.privateKey.export({ format: "jwk" }), kid: "test-ed25519" },
    { ...es256.privateKey.export({ format: "jwk" }), kid: "test-es256" },
  ],
});

const ANON_KEY = "test-anon-key";
const SERVICE_ROLE_KEY = "test-service-role-key";
/** What the deletion told the fake services (hooks, push, the handshake), and whether they answer. */
const erases: { host: string; path: string; method: string; claims: Record<string, unknown> }[] = [];
let servicesDown = false;
let adminDown = false;
const sessions = new Map<string, { id: string; anonymous: boolean }>();
let down = false;
let userCalls = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  switch (`${request.method} ${url.pathname}`) {
    case "GET /auth/v1/user": {
      userCalls++;
      if (down) return json({ msg: "unavailable" }, 503);
      if (request.headers.get("apikey") !== ANON_KEY) return json({ msg: "no api key" }, 401);
      const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const user = token ? sessions.get(token) : undefined;
      if (!user) return json({ code: 403, error_code: "bad_jwt", msg: "invalid JWT" }, 403);
      return json({ id: user.id, aud: "authenticated", role: "authenticated", is_anonymous: user.anonymous });
    }
    case "POST /__session": {
      const body = (await request.json()) as { id: string; anonymous?: boolean };
      const token = randomBytes(24).toString("base64url");
      sessions.set(token, { id: body.id, anonymous: body.anonymous ?? false });
      return json({ token });
    }
    case "POST /__signout": {
      sessions.delete(((await request.json()) as { token: string }).token);
      return json({});
    }
    case "POST /__down":
      down = ((await request.json()) as { down: boolean }).down;
      return json({});
    case "GET /__calls":
      return json({ userCalls });
    case "POST /__admin-down":
      adminDown = ((await request.json()) as { down: boolean }).down;
      return json({});
  }
  // GoTrue's admin delete: the person's sign-in goes, and every session of theirs with it.
  const deleted = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(url.pathname);
  if (deleted && request.method === "DELETE") {
    if (adminDown) return json({ msg: "unavailable" }, 503);
    if (request.headers.get("authorization") !== `Bearer ${SERVICE_ROLE_KEY}`) return json({ msg: "not admin" }, 403);
    const id = decodeURIComponent(deleted[1]!);
    erases.push({ host: "auth.test", path: url.pathname, method: "DELETE", claims: {} });
    for (const [token, user] of sessions) if (user.id === id) sessions.delete(token);
    return json({ id });
  }
  return json({ msg: "not found" }, 404);
}

/** The other services' account wipe, recorded with the token's claims (read, not verified: the services' own tests
 *  check the erase token; this checks what was sent). */
async function fakeService(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host === "push.test" && url.pathname === "/__erases") return json(erases);
  if (url.host === "push.test" && url.pathname === "/__down") {
    servicesDown = ((await request.json()) as { down: boolean }).down;
    return json({});
  }
  if (servicesDown) return json({ error: "unavailable" }, 503);
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  let claims: Record<string, unknown> = {};
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    // recorded as sent
  }
  erases.push({ host: url.host, path: url.pathname, method: request.method, claims });
  return new Response(null, { status: 204 });
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ISSUER: "https://accounts.test",
          AUTH_URL: "https://auth.test",
          AUTH_ANON_KEY: ANON_KEY,
          SIGNING_JWKS: signingJwks,
          AUTH_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
          HOOKS_URL: "https://hooks.test",
          PUSH_URL: "https://push.test",
          HANDSHAKE_URL: "https://handshake.test",
        },
        cf: false,
        // Only the fake project answers; anything else fails loudly instead of reaching a network.
        outboundService: (request: Request) => {
          if (new URL(request.url).host === "auth.test") return fakeSupabase(request);
          if (["hooks.test", "push.test", "handshake.test"].includes(new URL(request.url).host)) return fakeService(request);
          return new Response(`outbound request refused in tests: ${new URL(request.url).host}`, { status: 599 });
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/node/**"],
    testTimeout: 20_000,
    // The files share the fake project above (its outage switch and its call count): one file at a time.
    fileParallelism: false,
  },
});
