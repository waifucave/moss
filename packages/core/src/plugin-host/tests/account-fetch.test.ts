// `net.fetch` with `auth: "waifucave"` (spec §5.4 item 84; the SDK's `WAIFUCAVE_AUTH` rules), as the daemon's keyed fetch
// serves it: a token minted for the request's host alone goes in `authorization: Bearer`, never into anything the plugin
// gets back; with no account it fails `no_account` before any request; and it is refused, before anything is minted, to a
// plugin outside MOSS's own tree, from any process but `moss`, and to any URL but an https waifucave.com host.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { FakePluginRegistry } from "../../contracts/fakes/plugin-registry";
import { Secret, type KeyedTokenSource } from "../../contracts/secret-store";
import { modelPluginApiHandlers } from "../../runtime-sdk/model-plugins/plugin-api";
import type { ApiCallContext } from "../api/router";

const TOKEN = "acct.token.minted-for-push-0001";

function world(o: { signedIn?: boolean; account?: boolean } = {}) {
  const registry = new FakePluginRegistry({
    catalog: catalogPointDecl,
    plugins: [
      { id: "moss", manifest: { manifest: 1, id: "moss", name: "MOSS" } as never, source: "bundled" },
      { id: "moss/push", manifest: { manifest: 1, name: "push", capabilities: ["network:push.waifucave.com", "network:evil.example"] } as never, source: "bundled" },
      { id: "luna", manifest: { manifest: 1, id: "luna", name: "Luna", capabilities: ["network:push.waifucave.com"] } as never, source: "index" },
    ],
  });
  const minted: string[] = [];
  let generation = 0;
  const source: KeyedTokenSource = {
    current: async (audience) => {
      minted.push(audience);
      return o.signedIn === false ? null : { value: new Secret(`${TOKEN}.${++generation}`), generation };
    },
    newer: async (_g, audience) => {
      minted.push(`newer:${audience}`);
      return { value: new Secret(`${TOKEN}.${++generation}`), generation };
    },
  };
  const sent: { url: string; authorization: string | null }[] = [];
  let answer = (_n: number): Response => new Response("ok", { status: 200, headers: { "x-echo": "" } });
  const handlers = modelPluginApiHandlers({
    registry,
    tokens: () => ({ current: async () => null, newer: async () => null }),
    secret: async () => undefined,
    fetch: async (url, init) => {
      const authorization = new Headers(init.headers).get("authorization");
      sent.push({ url, authorization });
      const r = answer(sent.length);
      // The service echoes what it got: the keyed fetch must take it out of what the plugin sees.
      return new Response(r.body, { status: r.status, headers: { "x-echo": authorization ?? "" } });
    },
    ...(o.account === false ? {} : { accountTokens: () => source }),
  });
  const call = (pluginId: string, url: string, process: ApiCallContext["process"] = "moss") =>
    (handlers["net.fetch"] as (ctx: ApiCallContext, args: unknown[]) => Promise<Response>)(
      { pluginId, process, caller: { kind: "plugin", pluginId }, record: registry.get(pluginId)!, path: "net.fetch" } as ApiCallContext,
      [url, { method: "POST", body: "{\"badge\":1}" }, { auth: "waifucave" }],
    );
  return { call, sent, minted, setAnswer: (f: (n: number) => Response) => void (answer = f) };
}

describe("the account token in a plugin's keyed fetch", () => {
  test("a token minted for the request's host goes as Bearer; the plugin never gets it back", async () => {
    const w = world();
    const r = await w.call("moss/push", "https://push.waifucave.com/v1/notify");
    expect(r.status).toBe(200);
    expect(w.minted).toEqual(["push.waifucave.com"]);
    expect(w.sent).toEqual([{ url: "https://push.waifucave.com/v1/notify", authorization: `Bearer ${TOKEN}.1` }]);
    expect(r.headers.get("x-echo")).toBeNull();
    expect(await r.text()).toBe("ok");
  });

  test("after a 401 a newer token is minted for the same host and the request tried once more", async () => {
    const w = world();
    w.setAnswer((n) => new Response(null, { status: n === 1 ? 401 : 204 }));
    const r = await w.call("moss/push", "https://push.waifucave.com/v1/devices/x");
    expect(r.status).toBe(204);
    expect(w.minted).toEqual(["push.waifucave.com", "newer:push.waifucave.com"]);
    expect(w.sent.map((s) => s.authorization)).toEqual([`Bearer ${TOKEN}.1`, `Bearer ${TOKEN}.2`]);
  });

  test("no account set up, or signed out: no_account, and nothing is sent", async () => {
    for (const w of [world({ account: false }), world({ signedIn: false })]) {
      const err = await w.call("moss/push", "https://push.waifucave.com/v1/notify").then(() => undefined, (e: unknown) => e as { code?: string });
      expect(err?.code).toBe("no_account");
      expect(w.sent).toEqual([]);
    }
  });

  test("refused before anything is minted: a plugin outside MOSS's tree, another process, another host, plain http", async () => {
    const w = world();
    const cases: [string, string, ApiCallContext["process"]][] = [
      ["luna", "https://push.waifucave.com/v1/notify", "moss"],
      ["luna", "https://push.waifucave.com/v1/notify", "shared"],
      ["moss/push", "https://push.waifucave.com/v1/notify", "shared"],
      ["moss/push", "https://push.waifucave.com/v1/notify", "ui"],
      ["moss/push", "https://evil.example/steal", "moss"],
      ["moss/push", "https://push.waifucave.com.evil.example/x", "moss"],
      ["moss/push", "http://push.waifucave.com/v1/notify", "moss"],
      ["moss/push", "https://u:p@push.waifucave.com/v1/notify", "moss"],
    ];
    for (const [plugin, url, process] of cases) {
      const err = await w.call(plugin, url, process).then(() => undefined, (e: unknown) => e as { code?: string });
      expect([plugin, url, process, err?.code]).toEqual([plugin, url, process, "refused"]);
    }
    expect(w.minted).toEqual([]);
    expect(w.sent).toEqual([]);
  });
});
