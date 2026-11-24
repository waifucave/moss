// Contract: BackendIcons (spec revision 20, §9.5 "A backend's look"; the owner's ruling of 2026-11-21: "lets just ship
// logos ourselves, if they complain we then remove them and figure another way"). Owner: lane CA (the reader where a
// plugin's other files are checked: the manifest's validation and the registry's load, `agents/plugin-backends.ts`;
// `agent.backends` serves the result as `AgentBackendView.icon`).
//
// An agent plugin's `agentBackends` entry may name an icon file in its own folder (`icon`, PNG or SVG). The engine reads
// nothing from an agent's install for it. General: the same rule for any agent plugin; removing a mark is its file and its
// manifest line, after which the SDK draws the fallback mark (`agentMark`).
//
// What the contract promises:
// * The file's real path (symlinks followed) stays inside the plugin folder's real path; at most `ICON_FILE_MAX_BYTES`;
//   its type is what its bytes are (`sniffIcon`) and matches its name's extension; an SVG only when inert (`svgIsInert`:
//   no script, no foreignObject, no `on…` attribute, no DOCTYPE or entity, no reference that isn't `#…`).
// * The answer is the file inline (`BackendIcon`, base64, an image only), or none with why: `missing` or `refused`. Never
//   a throw: a bad icon never fails its plugin.
import type { BackendIcon, ICON_FILE_TYPES } from "@waifucave/moss-protocol";

/** What the reader stands on (real implementation: `fs.realpath`, `stat`, `readFile`). */
export interface IconFiles {
  realpath(path: string): string | undefined;
  size(path: string): number | undefined;
  read(path: string): Uint8Array;
  now(): number;
}

export type IconRead = { icon: BackendIcon } | { none: "missing" | "refused"; why: string };

export interface BackendIcons {
  /** `pluginRoot`: the plugin's folder; `icon`: the entry's `icon`, relative to it. */
  read(pluginRoot: string, icon: string): Promise<IconRead>;
}

/** What a file's bytes are, by their magic (never its name). */
export function sniffIcon(bytes: Uint8Array): (typeof ICON_FILE_TYPES)[number] | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 1024)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return "svg";
  return undefined;
}

/** Whether an SVG can only be drawn: no script, no foreignObject, no event-handler attribute, no DOCTYPE or entity, and
 *  every reference (`href`, `xlink:href`, `src`, `url(…)`, `@import`) local (`#…`). */
export function svgIsInert(text: string): boolean {
  if (/<\s*script\b/i.test(text) || /<\s*foreignObject\b/i.test(text)) return false;
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return false;
  if (/\son[a-z]+\s*=/i.test(text)) return false;
  if (/@import/i.test(text)) return false;
  for (const m of text.matchAll(/(?:\s(?:xlink:)?href|\ssrc)\s*=\s*["']\s*([^"']*)["']/gi)) if (!m[1]!.startsWith("#")) return false;
  for (const m of text.matchAll(/url\(\s*["']?\s*([^)"']*)/gi)) if (!m[1]!.startsWith("#")) return false;
  return true;
}
