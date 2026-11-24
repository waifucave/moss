// The site's switches (site.json) and where things are. One reader, so the build, the check and the tests agree.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** services/site */
export const SITE_DIR = join(import.meta.dir, "..");
/** The repository's root. */
export const REPO_ROOT = join(SITE_DIR, "..", "..");

export type ReleaseState = "unreleased" | "released";
export type Hero = "list" | "name";

export interface SiteConfig {
  release: {
    state: ReleaseState;
    /** The version the "released" state names its files by (scripts/release/artifacts.ts). Never shown while unreleased. */
    version: string;
    /** Whether the owner has published the Homebrew casks (waifucave/homebrew-moss) and the winget manifests. */
    homebrew: boolean;
    winget: boolean;
  };
  hero: Hero;
  /** The repository's https address, the base of every download (`<repository>/releases/download/v<version>/<file>`). */
  repository: string;
}

/** Why `value` is not a site config, or undefined when it is. */
export function configProblem(value: unknown): string | undefined {
  const v = value as Partial<SiteConfig> | null;
  if (v === null || typeof v !== "object") return "site.json is not an object";
  const r = v.release;
  if (r === undefined || typeof r !== "object") return "site.json has no release";
  if (r.state !== "unreleased" && r.state !== "released") return `release.state is ${JSON.stringify(r.state)}: "unreleased" or "released"`;
  if (typeof r.version !== "string" || !/^\d+\.\d+\.\d+$/.test(r.version)) return `release.version ${JSON.stringify(r.version)} is not N.N.N`;
  if (typeof r.homebrew !== "boolean" || typeof r.winget !== "boolean") return "release.homebrew and release.winget are true or false";
  if (v.hero !== "list" && v.hero !== "name") return `hero is ${JSON.stringify(v.hero)}: "list" or "name"`;
  if (typeof v.repository !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(v.repository)) return `repository ${JSON.stringify(v.repository)} is not a GitHub repository's address`;
  return undefined;
}

export function readConfig(file = join(SITE_DIR, "site.json")): SiteConfig {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  const problem = configProblem(value);
  if (problem !== undefined) throw new Error(`${file}: ${problem}`);
  return value as SiteConfig;
}

/** A copy of `base` with some switches changed: how the check and the tests build both states and both openings. */
export function withSwitches(base: SiteConfig, change: { state?: ReleaseState; hero?: Hero; homebrew?: boolean; winget?: boolean }): SiteConfig {
  return {
    ...base,
    hero: change.hero ?? base.hero,
    release: {
      ...base.release,
      state: change.state ?? base.release.state,
      homebrew: change.homebrew ?? base.release.homebrew,
      winget: change.winget ?? base.release.winget,
    },
  };
}
