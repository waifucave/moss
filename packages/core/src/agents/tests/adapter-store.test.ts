// The store that places an adapter MOSS provides (agents/adapter/store.ts, spec §9.3 "An adapter MOSS provides"): what it
// fetches and from where, that every tarball is checked against its integrity BEFORE it is unpacked, where it keeps
// it, and what each way of failing leaves. Against a fake registry: no test reaches the network.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "../../contracts/common";
import { AdapterStore, adaptersRoot } from "../adapter/store";
import { AdapterDeclSchema, LockFileSchema, tarballUrl } from "../adapter/types";
import { FAKE_REGISTRY, FakeRegistry, integrityOf, packageTarball, publishAdapter } from "../testing/fake-npm";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const home = () => {
  const d = mkdtempSync(join(tmpdir(), "moss-adapter-"));
  temps.push(d);
  return d;
};
const failure = async (p: Promise<unknown>): Promise<ContractError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ContractError);
    return err as ContractError;
  }
  throw new Error("it should have failed");
};
/** Everything under the adapters' folder: after a refusal there is nothing, not even a staging folder. */
const leftovers = (h: string): string[] => {
  const root = adaptersRoot(h);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const n of readdirSync(dir, { withFileTypes: true })) (n.isDirectory() ? walk(join(dir, n.name), `${rel}${n.name}/`) : out.push(`${rel}${n.name}`));
  };
  walk(root, "");
  return out.filter((f) => f !== "bunfig.toml");
};

describe("the declaration", () => {
  test("a tarball's address is npm's own layout, scoped or not", () => {
    expect(tarballUrl(FAKE_REGISTRY, "@fake/adapter", "1.2.3")).toBe("https://registry.npmjs.org/@fake/adapter/-/adapter-1.2.3.tgz");
    expect(tarballUrl(FAKE_REGISTRY, "zod", "4.6.7")).toBe("https://registry.npmjs.org/zod/-/zod-4.6.7.tgz");
  });

  test("a declaration pins an exact version and a SHA-512; a range, a tag, a SHA-1 or a path out of the package are refused", () => {
    const ok = { package: "@fake/adapter", version: "1.0.0", integrity: integrityOf(new Uint8Array([1])), run: "dist/index.js", runtime: "moss-bun" };
    expect(AdapterDeclSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, version: "^1.0.0" }, { ...ok, version: "latest" }, { ...ok, version: "1.0.0-beta.1" },
      { ...ok, integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }, { ...ok, run: "../x.js" }, { ...ok, run: "/etc/x" },
      { ...ok, runtime: "node" }, { ...ok, package: "Fake/Adapter" }, { ...ok, extra: 1 },
    ]) expect(AdapterDeclSchema.safeParse(bad).success).toBe(false);
  });

  test("a lock's paths stay inside node_modules, end in the package's name, and are listed once", () => {
    const p = { path: "node_modules/zod", name: "zod", version: "4.6.7", integrity: integrityOf(new Uint8Array([2])) };
    expect(LockFileSchema.safeParse({ lock: 1, source: "x", packages: [p] }).success).toBe(true);
    expect(LockFileSchema.safeParse({ lock: 1, source: "x", packages: [{ ...p, path: "node_modules/a/node_modules/zod" }] }).success).toBe(true);
    for (const bad of [{ ...p, path: "../zod" }, { ...p, path: "node_modules/../zod" }, { ...p, path: "/node_modules/zod" }, { ...p, path: "node_modules/other" }, { ...p, path: "zod" }]) {
      expect(LockFileSchema.safeParse({ lock: 1, source: "x", packages: [bad] }).success).toBe(false);
    }
    expect(LockFileSchema.safeParse({ lock: 1, source: "x", packages: [p, p] }).success).toBe(false);
  });
});

describe("placing an adapter", () => {
  test("fetches the adapter and what it needs from the registry, at the lock's own paths, under the run folder, and nothing else", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg, { deps: [{ name: "zod", version: "4.6.7" }, { name: "@fake/sdk", version: "2.0.0" }, { name: "zod", version: "3.0.0", path: "node_modules/@fake/sdk/node_modules/zod" }] });
    const store = new AdapterStore({ home: h, download: reg.fetch });
    expect(store.status(d)).toEqual({ state: "absent" });
    const ready = await store.ensure(d);
    expect(ready.dir).toBe(join(adaptersRoot(h), "@fake__adapter", "1.0.0"));
    expect(ready.entry).toBe(join(ready.dir, "node_modules", "@fake", "adapter", "dist", "index.js"));
    expect(readFileSync(ready.entry, "utf8")).toContain("adapter");
    expect(JSON.parse(readFileSync(join(ready.dir, "node_modules", "zod", "package.json"), "utf8")).version).toBe("4.6.7");
    expect(JSON.parse(readFileSync(join(ready.dir, "node_modules", "@fake", "sdk", "node_modules", "zod", "package.json"), "utf8")).version).toBe("3.0.0");
    // Exactly the four pinned tarballs were asked for, each at npm's layout, over the fake registry's https address.
    expect([...reg.asked].sort()).toEqual([
      tarballUrl(FAKE_REGISTRY, "@fake/adapter", "1.0.0"), tarballUrl(FAKE_REGISTRY, "@fake/sdk", "2.0.0"), tarballUrl(FAKE_REGISTRY, "zod", "3.0.0"), tarballUrl(FAKE_REGISTRY, "zod", "4.6.7"),
    ].sort());
    expect(store.status(d)).toMatchObject({ state: "ready", digest: ready.digest });
    expect(store.verify(d)).toEqual({ ok: true, digest: ready.digest });
    // Nothing of the person's home outside the run folder's own folder was written, and no staging folder is left.
    expect(readdirSync(h)).toEqual(["run"]);
    expect(readdirSync(adaptersRoot(h)).sort()).toEqual(["@fake__adapter"]);
    expect(readdirSync(join(adaptersRoot(h), "@fake__adapter"))).toEqual(["1.0.0"]);
  });

  test("a copy that is there and whole is used as it is: no second fetch", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg, { deps: [{ name: "zod", version: "4.6.7" }] });
    const store = new AdapterStore({ home: h, download: reg.fetch });
    await store.ensure(d);
    const asked = reg.asked.length;
    await store.ensure(d);
    expect(reg.asked.length).toBe(asked);
    // Another store over the same home (the daemon restarted) finds it too.
    const again = new AdapterStore({ home: h, download: reg.fetch });
    expect(again.status(d).state).toBe("ready");
    await again.ensure(d);
    expect(reg.asked.length).toBe(asked);
  });

  test("two sessions starting at once share one fetch", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg, { deps: [{ name: "zod", version: "4.6.7" }] });
    let release!: () => void;
    reg.gate = new Promise<void>((r) => (release = r));
    const store = new AdapterStore({ home: h, download: reg.fetch });
    const a = store.ensure(d);
    const b = store.ensure(d);
    expect(a).toBe(b);
    release();
    const [x, y] = await Promise.all([a, b]);
    expect(x.digest).toBe(y.digest);
    expect(reg.asked.length).toBe(2); // the adapter and zod, once each
  });

  test("a download that doesn't match its integrity is refused before anything is unpacked, and nothing is kept", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg, { deps: [{ name: "zod", version: "4.6.7" }] });
    // The registry (or something on the way) serves other bytes for the adapter than the plugin pinned.
    reg.files.set(tarballUrl(FAKE_REGISTRY, "@fake/adapter", "1.0.0"), packageTarball("@fake/adapter", "1.0.0", { "dist/index.js": "evil()\n" }));
    const store = new AdapterStore({ home: h, download: reg.fetch });
    const err = await failure(store.ensure(d));
    expect(err.code).toBe("invalid");
    expect(err.message).toContain("doesn't match the fingerprint");
    expect(err.message).toContain("nothing was kept");
    expect(leftovers(h)).toEqual([]);
    expect(store.status(d)).toEqual({ state: "absent" });
  });

  test("the integrity is checked first: bytes that aren't even an archive fail as a mismatch, never reaching the unpacker", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg);
    reg.files.set(tarballUrl(FAKE_REGISTRY, "@fake/adapter", "1.0.0"), new TextEncoder().encode("<html>a captive portal</html>"));
    const err = await failure(new AdapterStore({ home: h, download: reg.fetch }).ensure(d));
    expect(err.message).toContain("doesn't match the fingerprint");
    expect(err.message).not.toContain("isn't a package MOSS can place");
    expect(leftovers(h)).toEqual([]);
  });

  test("a locked dependency that doesn't match stops the whole placement: the adapter itself is not kept either", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg, { deps: [{ name: "zod", version: "4.6.7" }, { name: "diff", version: "9.0.0" }] });
    reg.files.set(tarballUrl(FAKE_REGISTRY, "diff", "9.0.0"), packageTarball("diff", "9.0.0", { "index.js": "steal()\n" }));
    const err = await failure(new AdapterStore({ home: h, download: reg.fetch }).ensure(d));
    expect(err.message).toContain("diff 9.0.0");
    expect(leftovers(h)).toEqual([]);
  });

  test("a partial download (cut short) fails the integrity check: nothing is kept", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg);
    const whole = reg.files.get(tarballUrl(FAKE_REGISTRY, "@fake/adapter", "1.0.0"))!;
    reg.files.set(tarballUrl(FAKE_REGISTRY, "@fake/adapter", "1.0.0"), whole.subarray(0, Math.floor(whole.byteLength / 2)));
    const err = await failure(new AdapterStore({ home: h, download: reg.fetch }).ensure(d));
    expect(err.message).toContain("nothing was kept");
    expect(leftovers(h)).toEqual([]);
  });

  test("offline, or a registry that fails: a plain failure naming what couldn't be downloaded, nothing kept", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg, { deps: [{ name: "zod", version: "4.6.7" }] });
    reg.failing.add("*");
    const err = await failure(new AdapterStore({ home: h, download: reg.fetch }).ensure(d));
    expect(err.code).toBe("failed");
    expect(err.message).toContain("couldn't be downloaded from registry.npmjs.org");
    expect(err.message).toContain("the network is down");
    expect(leftovers(h)).toEqual([]);
    // Back online, the same store places it.
    reg.failing.clear();
    expect((await new AdapterStore({ home: h, download: reg.fetch }).ensure(d)).state).toBe("ready");
  });

  test("an address the registry has no tarball for is a plain failure too", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg);
    reg.files.clear();
    const err = await failure(new AdapterStore({ home: h, download: reg.fetch }).ensure(d));
    expect(err.message).toContain("it answered 404");
  });

  test("a home that can't be written (read-only, or something in the way) says so and downloads nothing", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg);
    // `run` is a file where the folder should be: the closest thing to a read-only disk that holds as root too.
    writeFileSync(join(h, "run"), "not a folder");
    const err = await failure(new AdapterStore({ home: h, download: reg.fetch }).ensure(d));
    expect(err.code).toBe("failed");
    expect(err.message).toMatch(/couldn't make a place to keep @fake\/adapter 1\.0\.0/);
    expect(err.message).toContain("nothing was downloaded");
    expect(reg.asked).toEqual([]);
    if (process.getuid?.() !== 0 && process.platform !== "win32") {
      const h2 = home();
      mkdirSync(join(h2, "run"), { mode: 0o700 });
      chmodSync(join(h2, "run"), 0o500);
      try {
        const err2 = await failure(new AdapterStore({ home: h2, download: reg.fetch }).ensure(d));
        expect(err2.message).toContain("nothing was downloaded");
        expect(reg.asked).toEqual([]);
      } finally {
        chmodSync(join(h2, "run"), 0o700);
      }
    }
  });

  test("an archive with a link, a path out of its folder, or another package inside is refused whole", async () => {
    const hostile: Record<string, Uint8Array> = {
      "a link": packageTarball("@fake/adapter", "1.0.0", { "dist/index.js": "x" }, [{ path: "package/evil", type: "2", linkname: "/etc/passwd" }]),
      "a path out": packageTarball("@fake/adapter", "1.0.0", { "dist/index.js": "x" }, [{ path: "package/../../escape", data: "x" }]),
      "another package": packageTarball("@fake/other", "1.0.0", { "dist/index.js": "x" }),
      "another version": packageTarball("@fake/adapter", "9.9.9", { "dist/index.js": "x" }),
    };
    for (const [what, bytes] of Object.entries(hostile)) {
      const h = home();
      const reg = new FakeRegistry();
      // The plugin pinned exactly these bytes (a hostile package that was published, or a plugin that names one).
      const d = { ...publishAdapter(reg), integrity: reg.publish("@fake/adapter", "1.0.0", bytes) };
      const err = await failure(new AdapterStore({ home: h, download: reg.fetch }).ensure(d));
      expect([what, err.code]).toEqual([what, "invalid"]);
      expect([what, leftovers(h)]).toEqual([what, []]);
    }
  });

  test("an adapter whose run file isn't in it is not kept", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = { ...publishAdapter(reg, { run: "dist/index.js", files: { "other.js": "x" } }) };
    const err = await failure(new AdapterStore({ home: h, download: reg.fetch }).ensure(d));
    expect(err.message).toContain("run file");
    expect(leftovers(h).some((f) => f.includes("index.js"))).toBe(false);
  });
});

describe("a copy that was changed after MOSS placed it", () => {
  async function placed() {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg, { deps: [{ name: "zod", version: "4.6.7" }] });
    const store = new AdapterStore({ home: h, download: reg.fetch });
    const ready = await store.ensure(d);
    return { h, reg, d, store, ready };
  }

  test("an edited file, an added file, a removed file and a link are each found, and the next ensure fetches afresh", async () => {
    const { d, store, ready, reg } = await placed();
    const dep = join(ready.dir, "node_modules", "zod", "index.js");
    const original = readFileSync(dep, "utf8");
    const cases: [string, () => void, () => void][] = [
      ["an edit", () => writeFileSync(dep, "evil()"), () => undefined],
      ["an added file", () => writeFileSync(join(ready.dir, "node_modules", "zod", "extra.js"), "x"), () => undefined],
      ["a removed file", () => rmSync(dep), () => undefined],
      ["a link", () => symlinkSync("/etc/hosts", join(ready.dir, "node_modules", "zod", "link")), () => undefined],
    ];
    for (const [what, damage] of cases) {
      damage();
      const v = store.verify(d);
      expect([what, v.ok]).toEqual([what, false]);
      const before = reg.asked.length;
      const fresh = await store.ensure(d);
      expect([what, reg.asked.length > before]).toEqual([what, true]);
      expect([what, store.verify(d).ok]).toEqual([what, true]);
      expect(fresh.digest).toBe(ready.digest);
      expect(readFileSync(dep, "utf8")).toBe(original);
    }
  });

  test("a different declaration under the same version (another integrity, or another lock) isn't this copy", async () => {
    const { d, store } = await placed();
    expect(store.status({ ...d, integrity: integrityOf(new Uint8Array([9])) }).state).toBe("changed");
    expect(store.status({ ...d, packages: [] }).state).toBe("changed");
  });

  test("a run file that is gone, or became a link, isn't ready", async () => {
    const { d, store, ready } = await placed();
    rmSync(ready.entry);
    expect(store.status(d).state).toBe("changed");
    symlinkSync("/etc/hosts", ready.entry);
    expect(store.status(d).state).toBe("changed");
  });
});

describe("updates and old copies", () => {
  test("a new version is placed beside the old, then the old goes when no active plugin names it", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const v1 = publishAdapter(reg, { version: "1.0.0" });
    const v2 = publishAdapter(reg, { version: "1.1.0" });
    const other = publishAdapter(reg, { name: "@fake/other", version: "5.0.0" });
    let named = [{ package: v1.package, version: "1.0.0" }];
    const store = new AdapterStore({ home: h, download: reg.fetch, keep: () => named });
    await store.ensure(v1);
    await store.ensure(other);
    named = [{ package: v2.package, version: "1.1.0" }];
    await store.ensure(v2);
    expect(readdirSync(join(adaptersRoot(h), "@fake__adapter"))).toEqual(["1.1.0"]);
    // Another package's copy is not touched.
    expect(store.status(other).state).toBe("ready");
  });

  test("a version another active declaration still names stays", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const v1 = publishAdapter(reg, { version: "1.0.0" });
    const v2 = publishAdapter(reg, { version: "1.1.0" });
    const store = new AdapterStore({ home: h, download: reg.fetch, keep: () => [{ package: v1.package, version: "1.0.0" }, { package: v1.package, version: "1.1.0" }] });
    await store.ensure(v1);
    await store.ensure(v2);
    expect(readdirSync(join(adaptersRoot(h), "@fake__adapter")).sort()).toEqual(["1.0.0", "1.1.0"]);
  });

  test("nothing is fetched in the background: constructing, looking and verifying never ask the registry", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg, { deps: [{ name: "zod", version: "4.6.7" }] });
    const store = new AdapterStore({ home: h, download: reg.fetch });
    store.status(d);
    store.verify(d);
    store.offerOf(d);
    store.bunfig();
    await new Promise((r) => setTimeout(r, 20));
    expect(reg.asked).toEqual([]);
  });

  test("a staging folder an old, stopped fetch left is removed at the next fetch; a young one is left", async () => {
    const h = home();
    const reg = new FakeRegistry();
    const d = publishAdapter(reg);
    const parent = join(adaptersRoot(h), "@fake__adapter");
    mkdirSync(join(parent, ".stage-old"), { recursive: true });
    mkdirSync(join(parent, ".stage-young"), { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(parent, ".stage-old"), old, old);
    await new AdapterStore({ home: h, download: reg.fetch }).ensure(d);
    expect(readdirSync(parent).sort()).toEqual([".stage-young", "1.0.0"]);
  });

  test("the card's offer names the package, the registry, the count and the size where every package has one", () => {
    const reg = new FakeRegistry();
    const d = publishAdapter(reg, { deps: [{ name: "zod", version: "4.6.7" }], uses: [{ program: "claude", env: "CLAUDE_CODE_EXECUTABLE" }] });
    const store = new AdapterStore({ home: "/h", download: reg.fetch });
    const offer = store.offerOf(d);
    expect(offer).toMatchObject({ package: "@fake/adapter", version: "1.0.0", registry: FAKE_REGISTRY, packages: 2, uses: ["claude"] });
    expect(offer.bytes).toBe((d.size ?? 0) + (d.packages[0]!.size ?? 0));
    expect(store.offerOf({ ...d, size: undefined } as never).bytes).toBeUndefined();
  });
});
