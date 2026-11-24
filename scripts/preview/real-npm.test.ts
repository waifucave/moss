import { describe, expect, test } from "bun:test";
import type { PinnedFetchSeam } from "../../packages/core/src/plugin-host/pinned-fetch";
import { REAL_NPM, withRealNpm } from "./real-npm";

describe("the real-agents preview's way to the public npm registry", () => {
  const asked: string[] = [];
  const base: PinnedFetchSeam = {
    resolve: async (name) => [`base:${name}`],
    fetch: async (url, init) => {
      const host = new Headers(init.headers).get("host") ?? "";
      asked.push(`base ${host} ${new URL(url).pathname}`);
      if (host === REAL_NPM && new URL(url).pathname === "/in-the-fake-world") return new Response("from the fake world");
      if (host === REAL_NPM) return new Response("not here", { status: 404 });
      return new Response(`base answered ${host}`);
    },
  };
  const real = {
    resolve: async (name: string) => [`real:${name}`],
    fetch: async (url: string) => { asked.push(`real ${new URL(url).pathname}`); return new Response("from the real registry"); },
  };
  const notes: string[] = [];
  const seam = withRealNpm(base, real, (l) => notes.push(l));
  const get = (host: string, path: string) => seam.fetch!(`https://93.184.216.34${path}`, { headers: { host } });

  test("only the registry's name resolves for real; every other name stays with the run's own seam", async () => {
    expect(await seam.resolve!(REAL_NPM)).toEqual([`real:${REAL_NPM}`]);
    expect(await seam.resolve!("REGISTRY.NPMJS.ORG")).toEqual(["real:REGISTRY.NPMJS.ORG"]);
    expect(await seam.resolve!("example.com")).toEqual(["base:example.com"]);
  });

  test("the fake registry answers first; only what it lacks is asked of the real one, and it is noted", async () => {
    asked.length = 0; notes.length = 0;
    expect(await (await get(REAL_NPM, "/in-the-fake-world")).text()).toBe("from the fake world");
    expect(asked).toEqual([`base ${REAL_NPM} /in-the-fake-world`]);
    expect(await (await get(REAL_NPM, "/zod/-/zod-1.0.0.tgz")).text()).toBe("from the real registry");
    expect(asked.slice(1)).toEqual([`base ${REAL_NPM} /zod/-/zod-1.0.0.tgz`, "real /zod/-/zod-1.0.0.tgz"]);
    expect(notes).toEqual(["acceptance daemon: the real npm registry is asked for /zod/-/zod-1.0.0.tgz (a real-agents preview)"]);
  });

  test("another host never reaches the real network, whatever it answers", async () => {
    asked.length = 0;
    expect(await (await get("example.com", "/x")).text()).toBe("base answered example.com");
    expect(asked).toEqual(["base example.com /x"]);
  });
});
