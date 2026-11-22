// The place MOSS keeps the adapters it provides, and how one gets there (spec §9.3 "An adapter MOSS provides").
//
// * One folder per package and version, under the MOSS home's fenced run folder: `run/agent-adapters/<package>/<version>/`
//   (a scoped name's `/` is `__`). Never `-g`, never the person's own `node_modules`, never touching their installs. It
//   holds `node_modules/<each package>` at the lock's own paths, and `.moss-adapter.json`, what MOSS placed.
// * The fetch is the registry's own tarballs, over the same pinned https fetch the plugin installer uses (public
//   addresses only, redirects checked, size and time limits), and NOTHING is unpacked until its SHA-512 matches the
//   integrity the declaration or its lock names. A mismatch, a short or failed download, a disk that won't take it:
//   nothing is kept, and the error says plainly which.
// * It is made whole in a staging folder beside its final one and renamed into place, so a copy is either complete or
//   absent; a leftover staging folder is removed at the next fetch.
// * Two callers asking for the same package and version share one fetch.
// * `.moss-adapter.json` records every file's SHA-256; `verify` walks the folder and refuses a changed, added or removed
//   file or any link, and its digest is what the user's OK for the agent names (so a swapped file asks again).
// * The pinned version changes only with the plugin that names it. Once a new one is placed, the same package's other
//   versions that no active declaration names are removed. Nothing updates in the background, and there is no `latest`.
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContractError } from "../../contracts/common";
import { DOWNLOAD_LIMITS, httpsFetch, type IndexFetch } from "../../registry/indexes/client";
import { NPM_REGISTRY } from "../../registry/indexes/npm";
import { unpackTarGz } from "../../registry/indexes/unpack";
import { tarballUrl, type AdapterDecl, type AdapterOffer } from "./types";

/** The most one package's tarball may be, compressed; and the most all of an adapter's may be. */
export const PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const ADAPTER_MAX_BYTES = 400 * 1024 * 1024;
/** What a leftover staging folder must be older than to be removed (another fetch may still be filling a younger one). */
const STALE_STAGE_MS = 60 * 60_000;
const STAMP = ".moss-adapter.json";
/** The one config an adapter's Bun reads (`--config`): a `bunfig.toml` in the folder the agent works in configures nothing,
 *  and nothing is installed at run time. */
const BUNFIG = "# MOSS: the config an adapter runs under. Nothing is installed at run time.\n[install]\nauto = \"disable\"\n";

export const adaptersRoot = (home: string): string => join(home, "run", "agent-adapters");
const folderOf = (name: string): string => name.replace("/", "__");

interface Stamp {
  v: 1;
  package: string;
  version: string;
  integrity: string;
  /** The lock's digest: a plugin that changes what it locks under the same version asks again. */
  lock: string;
  /** Every file placed, by its path under the folder, with its SHA-256. */
  files: Record<string, string>;
  digest: string;
}

export type AdapterStatus =
  | { state: "ready"; dir: string; entry: string; digest: string }
  | { state: "absent" }
  /** A copy is there, but isn't what MOSS placed (a file changed, added or removed), or it isn't this declaration's. */
  | { state: "changed"; why: string };

export interface AdapterStoreOptions {
  home: string;
  /** The tarball fetch: the pinned https fetch with the plugin downloads' limits by default; tests pass a fake registry's. */
  download?: IndexFetch;
  registry?: string;
  /** The package and version every active declaration names: other versions of a package just placed are removed. */
  keep?: () => readonly { package: string; version: string }[];
  now?: () => number;
  log?: (line: string) => void;
}

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export class AdapterStore {
  readonly #o: AdapterStoreOptions;
  readonly #download: IndexFetch;
  readonly #registry: string;
  /** One fetch per package and version, shared by everyone who asks while it runs. */
  readonly #flights = new Map<string, Promise<Extract<AdapterStatus, { state: "ready" }>>>();

  constructor(o: AdapterStoreOptions) {
    this.#o = o;
    this.#download = o.download ?? httpsFetch(DOWNLOAD_LIMITS);
    this.#registry = o.registry ?? NPM_REGISTRY;
  }

  get root(): string {
    return adaptersRoot(this.#o.home);
  }

  /** The config file an adapter runs under, written if it isn't there as MOSS writes it. */
  bunfig(): string {
    const path = join(this.root, "bunfig.toml");
    try {
      if (readFileSync(path, "utf8") === BUNFIG) return path;
    } catch { /* written below */ }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileSync(path, BUNFIG, { mode: 0o600 });
    return path;
  }

  dirOf(d: Pick<AdapterDecl, "package" | "version">): string {
    return join(this.root, folderOf(d.package), d.version);
  }

  /** The adapter's run file's path in its folder. */
  entryOf(d: Pick<AdapterDecl, "package" | "version" | "run">): string {
    return join(this.dirOf(d), "node_modules", ...d.package.split("/"), ...d.run.split("/"));
  }

  /** What a card says about fetching this declaration. */
  offerOf(d: AdapterDecl, again?: string): AdapterOffer {
    const sizes = [d.size, ...d.packages.map((p) => p.size)];
    return {
      package: d.package, version: d.version, registry: this.#registry, packages: 1 + d.packages.length,
      ...(sizes.every((s) => s !== undefined) ? { bytes: sizes.reduce<number>((n, s) => n + (s as number), 0) } : {}),
      folder: this.dirOf(d),
      ...(again === undefined ? {} : { again }),
    };
  }

  /** A light look, for `detect` (it runs often and never fetches): the copy's stamp is this declaration's and its run
   *  file is there as a plain file. The whole folder is checked at a start (`verify`). */
  status(d: AdapterDecl): AdapterStatus {
    const dir = this.dirOf(d);
    let stamp: Stamp;
    try {
      if (!lstatSync(dir).isDirectory()) return { state: "changed", why: `${dir} isn't a folder` };
      stamp = JSON.parse(readFileSync(join(dir, STAMP), "utf8")) as Stamp;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "changed", why: "its record can't be read" };
    }
    if (stamp.v !== 1 || stamp.package !== d.package || stamp.version !== d.version || stamp.integrity !== d.integrity || stamp.lock !== lockDigest(d)) {
      return { state: "changed", why: "it isn't what this version of the plugin names" };
    }
    const entry = this.entryOf(d);
    try {
      if (!lstatSync(entry).isFile()) return { state: "changed", why: "its run file isn't a plain file" };
    } catch {
      return { state: "changed", why: "its run file is gone" };
    }
    return { state: "ready", dir, entry, digest: stamp.digest };
  }

  /** The whole copy against what MOSS recorded: every file's hash, no file added or removed, no link. */
  verify(d: AdapterDecl): { ok: true; digest: string } | { ok: false; why: string } {
    const st = this.status(d);
    if (st.state !== "ready") return { ok: false, why: st.state === "changed" ? st.why : "it isn't there" };
    let stamp: Stamp;
    try {
      stamp = JSON.parse(readFileSync(join(st.dir, STAMP), "utf8")) as Stamp;
    } catch {
      return { ok: false, why: "its record can't be read" };
    }
    let found: Record<string, string>;
    try {
      found = hashTree(st.dir);
    } catch (err) {
      return { ok: false, why: err instanceof Error ? err.message : String(err) };
    }
    const want = Object.keys(stamp.files);
    const have = Object.keys(found);
    if (want.length !== have.length) return { ok: false, why: "a file was added or removed" };
    for (const f of want) if (found[f] !== stamp.files[f]) return { ok: false, why: `${f} changed` };
    if (digestOf(found) !== stamp.digest) return { ok: false, why: "its record doesn't match its files" };
    return { ok: true, digest: stamp.digest };
  }

  /** Places the adapter, fetching what isn't there. A copy that is there and whole is used as it is. Shared by every
   *  caller that asks for the same package and version while it runs. */
  ensure(d: AdapterDecl): Promise<Extract<AdapterStatus, { state: "ready" }>> {
    const key = `${d.package}@${d.version}`;
    const running = this.#flights.get(key);
    if (running !== undefined) return running;
    const flight = this.#place(d).finally(() => this.#flights.delete(key));
    this.#flights.set(key, flight);
    return flight;
  }

  async #place(d: AdapterDecl): Promise<Extract<AdapterStatus, { state: "ready" }>> {
    const whole = this.verify(d);
    if (whole.ok) return this.status(d) as Extract<AdapterStatus, { state: "ready" }>;
    const dir = this.dirOf(d);
    const parent = join(this.root, folderOf(d.package));
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new ContractError("failed", `MOSS couldn't make a place to keep ${d.package} ${d.version} (${(err as NodeJS.ErrnoException).code ?? "an error"}: is its home read-only or full?), so nothing was downloaded`);
    }
    this.#sweep(parent);
    const stage = join(parent, `.stage-${randomBytes(6).toString("hex")}`);
    try {
      mkdirSync(stage, { mode: 0o700 });
    } catch (err) {
      throw new ContractError("failed", `MOSS couldn't write to ${parent} (${(err as NodeJS.ErrnoException).code ?? "an error"}: is its home read-only or full?), so nothing was downloaded`);
    }
    try {
      const entries = [{ path: `node_modules/${d.package}`, name: d.package, version: d.version, integrity: d.integrity }, ...d.packages];
      let total = 0;
      let next = 0;
      // A few at a time; the first failure stops the rest from starting.
      let failed: unknown;
      const worker = async () => {
        while (failed === undefined && next < entries.length) {
          const p = entries[next++]!;
          try {
            total += await this.#fetchOne(p, join(stage, ...p.path.split("/")));
            if (total > ADAPTER_MAX_BYTES) throw new ContractError("invalid", `${d.package} ${d.version} and what it needs are more than ${ADAPTER_MAX_BYTES / (1024 * 1024)} MB, so nothing was kept`);
          } catch (err) {
            failed ??= err;
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      if (failed !== undefined) throw failed;
      const files = hashTree(stage);
      const stamp: Stamp = { v: 1, package: d.package, version: d.version, integrity: d.integrity, lock: lockDigest(d), files, digest: digestOf(files) };
      writeFileSync(join(stage, STAMP), `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o600 });
      // Whole, or not there: a copy that changed is replaced, and a whole one that another caller placed first is kept.
      const there = this.verify(d);
      if (there.ok) {
        rmSync(stage, { recursive: true, force: true });
      } else {
        rmSync(dir, { recursive: true, force: true });
        renameSync(stage, dir);
      }
    } catch (err) {
      rmSync(stage, { recursive: true, force: true });
      if (err instanceof ContractError) throw err;
      throw new ContractError("failed", `${d.package} ${d.version} couldn't be saved (${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message.slice(0, 160) : "an error")}), so nothing was kept`);
    }
    this.#prune(d);
    const ready = this.status(d);
    if (ready.state !== "ready") throw new ContractError("failed", `${d.package} ${d.version} was placed but its run file ${d.run} isn't in it, so nothing was kept`);
    this.#o.log?.(`agents: placed ${d.package} ${d.version} (${1 + d.packages.length} packages) in ${ready.dir}`);
    return ready;
  }

  /** One package: its tarball fetched, checked against its integrity BEFORE it is unpacked, then unpacked (links,
   *  devices, `..`, a path under a file, over-large and over-many are refused by MOSS's own reader) to `dest`. Gives
   *  the tarball's bytes. */
  async #fetchOne(p: { path: string; name: string; version: string; integrity: string }, dest: string): Promise<number> {
    const url = tarballUrl(this.#registry, p.name, p.version);
    let bytes: Uint8Array;
    try {
      bytes = await this.#download(url, PACKAGE_MAX_BYTES);
    } catch (err) {
      throw new ContractError("failed", `${p.name} ${p.version} couldn't be downloaded from ${this.#registry.replace(/^https:\/\//, "")} (${(err instanceof Error ? err.message : String(err)).slice(0, 160)}), so nothing was kept`);
    }
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== p.integrity) {
      throw new ContractError("invalid", `${p.name} ${p.version}'s download doesn't match the fingerprint MOSS expects for it, so it was not unpacked and nothing was kept`);
    }
    try {
      unpackTarGz(bytes, dest, { root: "package" });
    } catch (err) {
      throw new ContractError("invalid", `${p.name} ${p.version} isn't a package MOSS can place (${(err instanceof Error ? err.message : String(err)).replace(/^the download isn't a plugin archive MOSS takes: /, "").slice(0, 160)}), so nothing was kept`);
    }
    let named: { name?: unknown; version?: unknown };
    try {
      named = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    } catch {
      throw new ContractError("invalid", `${p.name} ${p.version} has no readable package.json, so nothing was kept`);
    }
    if (named.name !== p.name || named.version !== p.version) {
      throw new ContractError("invalid", `${p.name} ${p.version}'s download is ${String(named.name)} ${String(named.version)}, so nothing was kept`);
    }
    return bytes.byteLength;
  }

  /** Staging folders a fetch left (it was stopped) and nobody is filling any more. */
  #sweep(parent: string): void {
    const now = (this.#o.now ?? Date.now)();
    try {
      for (const name of readdirSync(parent)) {
        if (!name.startsWith(".stage-")) continue;
        try {
          if (now - statSync(join(parent, name)).mtimeMs > STALE_STAGE_MS) rmSync(join(parent, name), { recursive: true, force: true });
        } catch { /* gone already */ }
      }
    } catch { /* nothing to sweep */ }
  }

  /** The same package's other versions, when no active declaration names them: an old copy goes once a new one is in. */
  #prune(d: AdapterDecl): void {
    const keep = new Set((this.#o.keep?.() ?? []).filter((k) => k.package === d.package).map((k) => k.version));
    keep.add(d.version);
    const parent = join(this.root, folderOf(d.package));
    try {
      for (const name of readdirSync(parent)) {
        if (name.startsWith(".") || keep.has(name)) continue;
        rmSync(join(parent, name), { recursive: true, force: true });
        this.#o.log?.(`agents: removed ${d.package} ${name}: no plugin names it any more`);
      }
    } catch { /* it stays */ }
  }
}

/** The lock's identity: what a plugin that changes it under the same version asks again for. */
export function lockDigest(d: Pick<AdapterDecl, "packages">): string {
  return sha256(d.packages.map((p) => `${p.path}\0${p.name}\0${p.version}\0${p.integrity}`).sort().join("\n"));
}

/** Every file under `dir` (but the record itself), by path, with its SHA-256. Throws on a link or anything not a plain
 *  file or folder. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const at = rel === "" ? name : `${rel}/${name}`;
      if (at === STAMP) continue;
      const st = lstatSync(join(dir, at));
      if (st.isDirectory()) walk(at);
      else if (st.isFile()) out[at] = sha256(readFileSync(join(dir, at)));
      else throw new Error(`${at} isn't a plain file`);
    }
  };
  walk("");
  return out;
}

export const digestOf = (files: Record<string, string>): string => sha256(Object.keys(files).sort().map((f) => `${f}\0${files[f]}`).join("\n"));
