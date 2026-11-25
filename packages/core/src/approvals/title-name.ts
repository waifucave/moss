// The one place that decides whether a NAME may stand in a card's title (spec 5.5; the owner's ruling of 2026-11-24).
//
// A card's title and sentences are the engine's own words, so a name someone else chose can't be a word of them: it could end the
// sentence early or say a different level ("Let "x" run at automatic?"). The default is a FIXED title with the name as a row of its own
// marked as a name (`name: true`). The owner settled the wording of the cards for MOSS's own agents and plugins by hand ("Start Codex?",
// "Download Claude Code's adapter?"), and for those the name is not the risk, so a title may carry a name only when the name is
//   - the engine's own constant, or
//   - the name of a plugin of MOSS's own bundled tree (the `moss/...` plugins shipped in the app), known by where the plugin was
//     loaded from (its install record), never by what its manifest says of itself.
// A third party's plugin or agent, an adapter registry's entry, an index's or npm's name, a routine's name (a bot chooses it), a
// session's title, a device's name and a tool's name from another computer never reach a title: always the fixed one.
//
// No builder interpolates a name into a title on its own: it asks `titleWithName`, so this file is the single decision.
import { nameProblem } from "../devices/names";
import { isBundledMoss } from "../runtime-sdk/model-plugins/load";
import type { PluginRecord } from "../contracts/plugin-registry";

/** The longest name a title carries (a bundled plugin's names are short; a long one reads as a sentence). */
export const TITLE_NAME_MAX = 40;

/** Who the name belongs to, as the builder knows it. */
export type TitleNameOwner =
  /** The engine's own constant. */
  | { kind: "engine" }
  /** A plugin, as its install record says it was loaded; `undefined`: not in the registry (never trusted). */
  | { kind: "plugin"; record: Pick<PluginRecord, "id" | "source"> | undefined }
  /** A plugin whose bundled-ness the caller already read from the install record (`isBundledMoss`). */
  | { kind: "bundled"; bundled: boolean }
  /** Anyone else: a bot, a session, a device, an index, npm, another computer. Never trusted. */
  | { kind: "other" };

/** The name to put in a title, or undefined when the title is the fixed one. A trusted name is still held to the device-name rule
 *  (nothing invisible, no joiner beside an ASCII letter) and to a short length, and is drawn through the sealed pages' escape. */
export function trustedTitleName(owner: TitleNameOwner, name: string): string | undefined {
  const trusted = owner.kind === "engine" || (owner.kind === "plugin" && owner.record !== undefined && isBundledMoss(owner.record)) || (owner.kind === "bundled" && owner.bundled);
  if (!trusted) return undefined;
  if (name.length === 0 || name.length > TITLE_NAME_MAX || nameProblem(name) !== null) return undefined;
  // Letters, digits, spaces, dots, plus and hyphen: a name of ours is a word or two, never punctuation that could end or open a sentence.
  if (!/^[\p{L}\p{N} .+-]+$/u.test(name)) return undefined;
  return name;
}

/** A title: `named(name)` for a name that may stand in it, else `fixed`. */
export function titleWithName(owner: TitleNameOwner, name: string, named: (name: string) => string, fixed: string): string {
  const n = trustedTitleName(owner, name);
  return n === undefined ? fixed : named(n);
}
