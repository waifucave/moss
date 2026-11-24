// A paired phone may start a coding session on the computer it is linked to (the owner's decision of 2026-11-24), read what its
// new-session sheet offers (`agent.backends`, `agent.options`, `agent.recent`, the three the desktop's own start panel reads), make a
// bot (`bot.create`), send a file to a bot or a coding session (`session.stageFile`) and read what a conversation's composer offers
// (`session.composerOffers`), and may do nothing more than before. The remote role's calls are pinned: the 47 it had before (the frozen
// list below), the four of the start (PH2) and the three of PH3, exactly. A call that is added or taken away breaks this until its
// author says so here and in the report.
import { describe, expect, test } from "bun:test";
import { AGENTS_METHODS } from "../src/agents";
import { BOT_FILE_MAX_BYTES, BOT_FILES_MAX } from "../src/app";
import { BOTS_METHODS } from "../src/bots";
import { IROH_MAX_FRAME_BYTES } from "../src/methods";
import { SESSIONS_METHODS, STAGE_FILE_CHUNK_B64_MAX_LENGTH, STAGE_FILE_MAX_BYTES, STAGE_FILE_PENDING_MAX_BYTES, STAGE_FILE_DAY_MAX_BYTES, STAGE_FILES_PER_MESSAGE_MAX } from "../src/sessions";
import { MOSS_METHODS, allowedMethods } from "../src/moss";

const BEFORE = [
  "account.status", "activity.list", "bot.conversation", "bot.get", "bot.instructions.get", "bot.list", "bot.markRead", "bot.records",
  "bot.summaries", "bots.pause", "browser.stream", "card.answer", "card.get", "card.list", "command.list", "command.run", "computer.get",
  "computer.setLevel", "computer.list", "device.list", "device.rename", "device.revoke", "events.subscribe", "events.unsubscribe", "main.get",
  "main.set", "models.list", "protocol.hello", "routine.list", "routine.runs", "session.answer", "session.attach", "session.connectors",
  "session.context", "session.detach", "session.diff", "session.get", "session.history", "session.interrupt", "session.links", "session.list",
  "session.outputs", "session.send", "session.setModel", "session.stageImage", "session.stop", "usage.summary",
];

describe("the remote role's calls", () => {
  test("are the 47 they were, plus agent.start and the three reads of its sheet, bot.create, session.stageFile and session.composerOffers", () => {
    expect(BEFORE).toHaveLength(47);
    expect([...allowedMethods("remote")].sort()).toEqual([...BEFORE, "agent.backends", "agent.options", "agent.recent", "agent.start", "bot.create", "session.stageFile", "session.composerOffers"].sort());
    expect(allowedMethods("remote").size).toBe(54);
  });

  test("bot.create, session.stageFile and session.composerOffers are the person's own calls (userOnly) with no `change` class; the file door and the offers are the phone's alone", () => {
    for (const spec of [BOTS_METHODS.botCreate, SESSIONS_METHODS.sessionStageFile, SESSIONS_METHODS.sessionComposerOffers]) {
      expect([spec.name, spec.userOnly]).toEqual([spec.name, true]);
      expect([spec.name, (spec as { change?: unknown }).change]).toEqual([spec.name, undefined]);
    }
    expect([...BOTS_METHODS.botCreate.roles]).toEqual(["app", "cli", "remote"]);
    expect([...SESSIONS_METHODS.sessionStageFile.roles]).toEqual(["remote"]);
    expect([...SESSIONS_METHODS.sessionComposerOffers.roles]).toEqual(["remote"]);
    for (const role of ["layer", "plugin-host", "bridge", "web", "peer", "app", "cli"] as const) {
      expect([role, allowedMethods(role).has("session.stageFile")]).toEqual([role, false]);
      expect([role, allowedMethods(role).has("session.composerOffers")]).toEqual([role, false]);
    }
  });

  test("the file door's limits are no looser than the desktop's drop", () => {
    expect(STAGE_FILE_MAX_BYTES).toBe(BOT_FILE_MAX_BYTES);
    expect(STAGE_FILES_PER_MESSAGE_MAX).toBe(BOT_FILES_MAX);
    // A chunk's request fits the phone link's 1 MiB frame with room for the envelope.
    const request = JSON.stringify({ jsonrpc: "2.0", id: 9007199254740991, method: "session.stageFile", params: { id: "s_" + "x".repeat(126), upload: "u".repeat(64), offset: STAGE_FILE_MAX_BYTES, dataBase64: "A".repeat(STAGE_FILE_CHUNK_B64_MAX_LENGTH) } });
    expect(Buffer.byteLength(request)).toBeLessThan(IROH_MAX_FRAME_BYTES - 64 * 1024);
    expect(STAGE_FILE_PENDING_MAX_BYTES).toBeLessThan(STAGE_FILE_DAY_MAX_BYTES);
  });

  test("the three reads change nothing: no `change` class, no userOnly start, and each is the app's and the CLI's too", () => {
    for (const spec of [AGENTS_METHODS.agentBackends, AGENTS_METHODS.agentOptions, AGENTS_METHODS.agentRecent]) {
      expect([spec.name, [...spec.roles]]).toEqual([spec.name, ["app", "cli", "remote"]]);
      expect([spec.name, (spec as { change?: unknown }).change]).toEqual([spec.name, undefined]);
    }
    // The other read of the agents area stays off the phone's list: the sheet doesn't need a plugin's presets.
    expect(allowedMethods("remote").has("agent.definitions")).toBe(false);
  });

  test("agent.start is the person's own call (userOnly) for the app, the CLI and a phone, and no other role", () => {
    const spec = AGENTS_METHODS.agentStart;
    expect(spec.userOnly).toBe(true);
    expect([...spec.roles]).toEqual(["app", "cli", "remote"]);
    for (const role of ["layer", "plugin-host", "bridge", "web", "peer"] as const) expect([role, allowedMethods(role).has("agent.start")]).toEqual([role, false]);
  });

  test("nothing that creates, pairs, installs or configures is on the phone's list", () => {
    const remote = allowedMethods("remote");
    const reach = [...MOSS_METHODS.keys()].filter((m) => /^(bot\.(edit|remove|restore|archived|setModel|rename|archive|setUserLayer|pluginSettings|move)|pair\.|plugin\.|plugins\.|settings\.|setting\.|account\.(register|sign|link)|devices?\.(pair|add|code)|agent\.definitions|codeAgent\.|tree\.|routine\.(create|set|remove|run$))/.test(m));
    expect(reach.length).toBeGreaterThan(5);
    for (const m of reach) expect([m, remote.has(m)]).toEqual([m, false]);
  });
});
