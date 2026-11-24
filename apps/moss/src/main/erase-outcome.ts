// What an "Erase everything" started from the app came to (the deletion lane). The engine erases after it has stopped,
// where nothing can answer the app, and its log goes with the home; so it leaves `<home>-erase.json` beside the home
// (packages/core `deletion/erase-home.ts`, `eraseOutcomePath`). The app reads it at its next open, shows it once, and
// removes it. The file holds no secret: whether it worked, how many saved keys are left, the engine's reason, what stays.
import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The engine's own suffix (`ERASE_OUTCOME_SUFFIX`). */
export const ERASE_OUTCOME_SUFFIX = "-erase.json";

export function eraseOutcomePath(home: string): string {
  const h = resolve(home);
  return join(dirname(h), `${basename(h)}${ERASE_OUTCOME_SUFFIX}`);
}

export interface ShownOutcome {
  ok: boolean;
  message: string;
  detail: string;
}

/** Reads and removes the outcome, as words to show; undefined when there is none (or it can't be read). */
export function takeEraseOutcome(home: string): ShownOutcome | undefined {
  const path = eraseOutcomePath(home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  rmSync(path, { force: true });
  let o: { ok?: unknown; secretsLeft?: unknown; error?: unknown; keeps?: unknown };
  try {
    o = JSON.parse(raw.slice(0, 16_384)) as typeof o;
  } catch {
    return undefined;
  }
  const keeps = Array.isArray(o.keeps) ? o.keeps.filter((k): k is string => typeof k === "string").slice(0, 12).map((k) => k.slice(0, 300)) : [];
  const stays = keeps.length > 0 ? `\n\nWhat stays:\n${keeps.map((k) => `• ${k}`).join("\n")}` : "";
  if (o.ok === true) return { ok: true, message: "Everything MOSS kept on this computer was erased.", detail: `MOSS starts fresh now.${stays}` };
  const why = typeof o.error === "string" ? o.error.slice(0, 300) : "the erase stopped before it finished";
  const left = typeof o.secretsLeft === "number" && o.secretsLeft > 0 ? ` ${o.secretsLeft} saved key(s) are still in your keychain: remove the items named after MOSS there.` : "";
  return { ok: false, message: "MOSS couldn't erase everything.", detail: `${why}.${left}${stays}` };
}
