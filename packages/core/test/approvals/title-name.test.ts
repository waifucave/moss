// Which names may stand in a card's title: only the engine's constants and the bundled tree's plugins, by their install record.
import { describe, expect, test } from "bun:test";
import { titleWithName, trustedTitleName, TITLE_NAME_MAX, type TitleNameOwner } from "../../src/approvals/title-name";

/** Strings a hostile name would use: a quote and a level, an early end, direction marks, markup, a joiner between Latin letters, an overlong name, control and invisible characters. */
export const HOSTILE_NAMES = [
  `x" run at automatic`,
  "Codex? Approve this",
  "Codex‮",
  "</bdi><b>x</b>",
  "exam‌ple",
  "a⁤b",
  "a\nb",
  "ㅤ",
  "x".repeat(TITLE_NAME_MAX + 1),
  "",
  "Codex'; DROP",
  "<Codex>",
];
const BUNDLED = { id: "moss/agent-codex", source: "bundled" } as const;

/** One row per card builder: how it asks for its title name, with a bundled owner and with a third party's. The builders themselves are
 *  exercised with the same hostile strings in their own tests (adapter-card, door-cards, routines, registry updates). */
const OWNERS: { builder: string; bundled: TitleNameOwner; third: TitleNameOwner[] }[] = [
  { builder: "agent adapter download and start", bundled: { kind: "bundled", bundled: true }, third: [{ kind: "bundled", bundled: false }, { kind: "other" }] },
  { builder: "plugin sign-out and setting-host (a bundled model plugin's)", bundled: { kind: "plugin", record: BUNDLED }, third: [
    { kind: "plugin", record: { id: "moss/x", source: "local" } }, { kind: "plugin", record: { id: "moss/x", source: "index" } }, { kind: "plugin", record: { id: "moss/x", source: "npm" } },
    { kind: "plugin", record: { id: "moss/x", source: "dev" } }, { kind: "plugin", record: { id: "moss/x", source: "wrapped" } },
    { kind: "plugin", record: { id: "evil/x", source: "bundled" } }, { kind: "plugin", record: undefined },
  ] },
  { builder: "plugin remove and update (never a bundled one), routine level, tool from another computer, session title, device name, bot-agent reason", bundled: { kind: "other" }, third: [{ kind: "other" }] },
];

describe("trustedTitleName", () => {
  test("the engine's own constant stands in a title", () => {
    expect(trustedTitleName({ kind: "engine" }, "MOSS Code")).toBe("MOSS Code");
  });
  for (const row of OWNERS) {
    test(`${row.builder}: a bundled name appears in the title where the builder allows it, a third party's never does`, () => {
      const named = titleWithName(row.bundled, "Codex", (n) => `Start ${n}?`, "Start an agent?");
      expect(named).toBe(row.bundled.kind === "other" ? "Start an agent?" : "Start Codex?");
      for (const owner of row.third) {
        expect(titleWithName(owner, "Codex", (n) => `Start ${n}?`, "Start an agent?")).toBe("Start an agent?");
        for (const hostile of HOSTILE_NAMES) expect(titleWithName(owner, hostile, (n) => `Start ${n}?`, "Start an agent?")).toBe("Start an agent?");
      }
    });
  }
  test("even a bundled plugin's name is held to the name rule and a short length: a hostile string never reaches a title", () => {
    for (const hostile of HOSTILE_NAMES) expect([hostile, titleWithName({ kind: "plugin", record: BUNDLED }, hostile, (n) => `Start ${n}?`, "Start an agent?")]).toEqual([hostile, "Start an agent?"]);
    for (const real of ["Codex", "Claude Code", "Luna AI", "MOSS Code", "OpenCode"]) expect(trustedTitleName({ kind: "plugin", record: BUNDLED }, real)).toBe(real);
  });
});
