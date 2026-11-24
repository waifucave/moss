/**
 * Publishes MOSS's two Homebrew casks to the tap `waifucave/homebrew-moss`, the owner's own step:
 *   - Casks/moss-code.rb   <- <from>/casks/moss-code.rb
 *   - Casks/moss.rb        <- <from>/casks/moss.rb
 * `<from>` is the folder `release/publish.ts --dry-run --render-to <from>` wrote from the release's own checksums
 * (scripts/release/package-managers.ts): read verbatim here, never re-interpolated.
 *
 * Usage: bun run scripts/publish-tap.ts --from <dir> [--publish]
 *
 * With no `--publish` it is a DRY RUN and the default: it prints each file's final content and the path it would commit
 * to, checks that each cask names the version in VERSION and has no unfilled slot, and makes NO network call (not even a
 * read). Only `--publish` (the owner's, on their Mac) fetches each target path's current blob `sha` through
 * `gh api repos/<repo>/contents/<path>` (absent -> a new file, present -> an update: the Contents API wants the sha on
 * an update) and PUTs the content, base64-encoded. Nothing else here ever pushes. The underlying logic
 * (`tapPlan`/`currentSha`/`putArgsFor`/`publishFile`) is unit-tested with a FAKE `GhRunner`.
 *
 * Still HELD (scripts/held-scripts.ts, CLAUDE.md): `refuseHeldScript("tap:publish")` stops every run until the owner lifts the
 * hold, which is his call alone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCanonical } from "./version-lib";
import { refuseHeldScript } from "./held-scripts";

export const TAP_REPO = "waifucave/homebrew-moss";

export interface TapFile {
  /** Repo-relative path under the tap, e.g. "Casks/moss-code.rb". */
  repoPath: string;
  /** Local path this file's content is read from (verbatim — never interpolated here). */
  localPath: string;
}

/** The two casks a release publishes, from `from` (publish.ts's `--render-to` folder). Pure: no filesystem reads. */
export function tapPlan(from: string): TapFile[] {
  return CASK_TOKENS.map((token) => ({ repoPath: `Casks/${token}.rb`, localPath: join(from, "casks", `${token}.rb`) }));
}

/** The cask tokens, MOSS Code's first (the same as scripts/release/package-managers.ts's CASKS). */
export const CASK_TOKENS = ["moss-code", "moss"] as const;

/** What is wrong with a cask's text for `version`: it must say that version and have no unfilled slot. */
export function caskProblems(repoPath: string, text: string, version: string): string[] {
  const out: string[] = [];
  const slot = findUnfilledTemplateSlot(text);
  if (slot) out.push(`${repoPath} still contains an unfilled template slot ${slot}`);
  if (!text.includes(`version "${version}"`)) out.push(`${repoPath} does not say version "${version}" (VERSION): render it again from this release`);
  return out;
}

/** Matches an un-substituted `{{slot_name}}` template placeholder — the exact shape
 *  a template's own header names (`{{version}}`, `{{sha256}}`) for the
 *  controller to hand-fill before a real handoff-release publish. */
const TEMPLATE_SLOT_RE = /\{\{[a-z0-9_]+\}\}/;

/** Fix wave M3 (whole-branch review, Major): the first still-unfilled template slot in `content`,
 *  or `undefined` once every slot has been replaced. `packaging/norma-deprecated.rb` ships in this
 *  repo with `{{version}}`/`{{sha256}}` literally in place — a `--dry-run` or `--publish` before the
 *  controller hand-fills them must never treat that text as ready-to-ship cask content. */
export function findUnfilledTemplateSlot(content: string): string | undefined {
  // Ruby comment lines are skipped: packaging/norma-deprecated.rb's own header comments SPELL the
  // slot names (`{{version}}`, `{{sha256}}`, "no `{{token}}`-substitution pass") as instructions to
  // the controller — only a placeholder in a live stanza is an unfilled slot (found at the first
  // real --publish, 2026-09-13: the filled template was refused on its comments alone).
  const live = content
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  return live.match(TEMPLATE_SLOT_RE)?.[0];
}

/** Runs `gh` with the given args and returns its stdout. Thrown on a nonzero exit — mirrors
 *  `gh`'s own behaviour, so a fake test runner can `throw` to simulate any failure (a 404 on a
 *  not-yet-existing cask included) without needing to shape a fake exit code. */
export type GhRunner = (args: string[]) => string;

/**
 * The current blob `sha` of `repoPath` on the tap, or `undefined` if it does not exist yet (a
 * brand-new cask — the Contents API 404s, `gh api` exits nonzero, and that is the ONLY reason
 * this treats a `runner` throw as "absent" rather than propagating it; a real network/auth
 * failure looks identical to a caller with just a GhRunner, which is why `publishFile` calling
 * this before every PUT is deliberate — it always re-checks rather than assuming from a prior
 * call, so a cask that gets created between a dry preview and a real publish is still handled).
 */
export function currentSha(runner: GhRunner, repoPath: string): string | undefined {
  try {
    const out = runner(["api", `repos/${TAP_REPO}/contents/${repoPath}`, "--jq", ".sha"]).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** The commit message every tap publish uses — one per file, so each cask's history on the tap
 *  names exactly what changed. */
export function commitMessageFor(repoPath: string): string {
  return `chore(tap): publish ${repoPath}`;
}

/** The exact `gh api` argv for one PUT — base64 content per the Contents API's contract, `sha`
 *  included only when updating an existing file (omitting it on a create is required; including
 *  a stale one on an update 409s). Exported so the test can assert the argv shape directly
 *  without a real `gh` process. */
export function putArgsFor(repoPath: string, content: string, sha: string | undefined): string[] {
  const args = [
    "api",
    "-X",
    "PUT",
    `repos/${TAP_REPO}/contents/${repoPath}`,
    "-f",
    `message=${commitMessageFor(repoPath)}`,
    "-f",
    `content=${Buffer.from(content, "utf8").toString("base64")}`,
  ];
  if (sha !== undefined) args.push("-f", `sha=${sha}`);
  return args;
}

/** Reads `file.localPath`, fetches its current tap `sha` (if any), and PUTs it. The one function
 *  that actually publishes a single file — `main`'s `--publish` branch calls this twice, once per
 *  `tapPlan()` entry, with the real `gh` runner; the test calls it with a fake one. Fix wave M3
 *  (whole-branch review, Major): refuses BEFORE any network call when `content` still contains an
 *  unfilled `{{slot}}` — this is the defense-in-depth check; `main`'s `--publish` branch also
 *  preflights the WHOLE plan before touching either file, so a bad second file never lands after a
 *  good first one already published. */
export function publishFile(runner: GhRunner, file: TapFile): void {
  const content = readFileSync(file.localPath, "utf8");
  const slot = findUnfilledTemplateSlot(content);
  if (slot) {
    throw new Error(`refusing to publish ${file.repoPath} (from ${file.localPath}): still contains an unfilled template slot ${slot} — fill it in before publishing`);
  }
  const sha = currentSha(runner, file.repoPath);
  runner(putArgsFor(file.repoPath, content, sha));
}

function realGhRunner(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" });
}

/** What `--dry-run` prints for ONE file: its full content, a "missing on disk" note, or — fix wave
 *  M3, Critical — a REFUSAL naming the still-unfilled slot, so a rehearsal never quietly shows
 *  literal `{{version}}` text as though it were ready-to-ship cask content. Pure (no console I/O),
 *  so the refusal path is unit-testable without a real release build on disk. */
export function renderDryRunEntry(file: TapFile): string {
  const header = `--- ${file.repoPath}  (from ${file.localPath}) ---`;
  if (!existsSync(file.localPath)) {
    return `${header}\n  (missing on disk — run a rehearsal or a real release first to produce this file)\n`;
  }
  const content = readFileSync(file.localPath, "utf8");
  const slot = findUnfilledTemplateSlot(content);
  if (slot) {
    return `${header}\n  REFUSED: still contains an unfilled template slot ${slot} — fill it in before publishing.\n`;
  }
  return `${header}\n${content}`;
}

/** The script's whole behaviour, for a given argv, VERSION and `gh` runner: returns the exit code. A dry run (the default) never
 *  calls `runner`; only `--publish` does. Exported so a test can drive it with a fake runner, as the script itself is held. */
export function tapRun(argv: readonly string[], version: string, runner: GhRunner, log: (line: string) => void, err: (line: string) => void): number {
  const publish = argv.includes("--publish");
  const fromAt = argv.indexOf("--from");
  const from = fromAt >= 0 ? argv[fromAt + 1] : undefined;
  if (from === undefined || from.startsWith("--") || argv.some((a) => a !== "--publish" && a !== "--dry-run" && a !== "--from" && a !== from)) {
    err("usage: bun run scripts/publish-tap.ts --from <the --render-to folder> [--dry-run | --publish]   (a dry run is the default)");
    return 1;
  }
  if (publish && argv.includes("--dry-run")) {
    err("--publish and --dry-run together: pick one");
    return 1;
  }
  const files = tapPlan(from);
  const problems = files.flatMap((f) => (existsSync(f.localPath) ? caskProblems(f.repoPath, readFileSync(f.localPath, "utf8"), version) : [`${f.localPath} does not exist: run release/publish.ts --dry-run --from <builds> --render-to ${from} first`]));
  if (!publish) {
    log(`Tap: ${TAP_REPO}\n`);
    for (const f of files) log(renderDryRunEntry(f));
    for (const p of problems) err(`REFUSED: ${p}`);
    log(`DRY RUN: would PUT the above to ${TAP_REPO}, one commit each. No network calls made; add --publish to publish.`);
    return problems.length > 0 ? 1 : 0;
  }
  // --publish: the owner's. The whole plan is checked before either file is touched, so a bad second file never lands after a good first.
  if (problems.length > 0) {
    for (const p of problems) err(`FAIL: ${p}`);
    return 1;
  }
  for (const f of files) {
    log(`Publishing ${f.repoPath}...`);
    publishFile(runner, f);
  }
  log(`Published ${files.map((f) => f.repoPath).join(" + ")} to ${TAP_REPO}.`);
  return 0;
}

if (import.meta.main) {
  refuseHeldScript("tap:publish"); // C0 review S6: until C7 (`held-scripts.ts`); the owner lifts the hold
  process.exit(tapRun(process.argv.slice(2), readCanonical(), realGhRunner, console.log, console.error));
}
