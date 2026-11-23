// A fake npm registry for the adapter tests: tarballs by their address, a fetch that serves them and records what was asked
// for, and the declaration that pins them. No test reaches the network: the store's `download` is this fetch.
import { createHash } from "node:crypto";
import { tgz, type TarEntry } from "../../registry/indexes/tests/tar-fixture";
import type { IndexFetch } from "../../registry/indexes/client";
import { tarballUrl, type AdapterDecl, type LockedPackage } from "../adapter/types";

export const FAKE_REGISTRY = "https://registry.npmjs.org";

export const integrityOf = (bytes: Uint8Array): string => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** An npm tarball: `package/package.json` naming it, and `files` under `package/`. */
export function packageTarball(name: string, version: string, files: Record<string, string>, extra: TarEntry[] = []): Uint8Array {
  return tgz([
    { path: "package/package.json", data: JSON.stringify({ name, version }) },
    ...Object.entries(files).map(([path, data]) => ({ path: `package/${path}`, data })),
    ...extra,
  ]);
}

export class FakeRegistry {
  readonly files = new Map<string, Uint8Array>();
  /** Every address asked for, in order. */
  readonly asked: string[] = [];
  /** An address that fails (offline, 500) rather than answers. */
  failing = new Set<string>();
  /** Holds every answer until released: for the one-fetch rule. */
  gate: Promise<void> | undefined;

  publish(name: string, version: string, bytes: Uint8Array): string {
    this.files.set(tarballUrl(FAKE_REGISTRY, name, version), bytes);
    return integrityOf(bytes);
  }

  readonly fetch: IndexFetch = async (url, maxBytes) => {
    this.asked.push(url);
    if (this.gate) await this.gate;
    if (this.failing.has(url) || this.failing.has("*")) throw new Error("the network is down");
    const bytes = this.files.get(url);
    if (bytes === undefined) throw new Error("it answered 404");
    if (bytes.byteLength > maxBytes) throw new Error(`it is larger than ${maxBytes} bytes`);
    return bytes;
  };
}

/** A declaration for an adapter published in `registry`, with `deps` locked beside it (path, name, version, files). */
export function publishAdapter(registry: FakeRegistry, o: { name?: string; version?: string; run?: string; deps?: { name: string; version: string; files?: Record<string, string>; path?: string }[]; files?: Record<string, string>; uses?: AdapterDecl["uses"] } = {}): AdapterDecl {
  const name = o.name ?? "@fake/adapter";
  const version = o.version ?? "1.0.0";
  const run = o.run ?? "dist/index.js";
  const main = packageTarball(name, version, o.files ?? { [run]: "console.log('adapter')\n" });
  const integrity = registry.publish(name, version, main);
  const packages: LockedPackage[] = (o.deps ?? []).map((d) => {
    const bytes = packageTarball(d.name, d.version, d.files ?? { "index.js": "module.exports = 1\n" });
    return { path: d.path ?? `node_modules/${d.name}`, name: d.name, version: d.version, integrity: registry.publish(d.name, d.version, bytes), size: bytes.byteLength };
  });
  return { package: name, version, integrity, size: main.byteLength, run, runtime: "moss-bun", packages, ...(o.uses === undefined ? {} : { uses: o.uses }) };
}
