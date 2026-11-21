import { describe, expect, test } from "bun:test";
import { agentChoices, effortsFor, pickAgent, pickFolder, pickModel, startParams } from "../client/preselect";
import { BACKENDS, FOLDERS, OPTIONS, RECENT } from "../gallery/fixtures";

describe("the + flow's preselection", () => {
  const choices = agentChoices(BACKENDS, "Studio");

  test("only agents a person can start; the ones this computer has first, MOSS's own first among them", () => {
    expect(choices.map((c) => [c.id, c.installed])).toEqual([
      ["moss-code", true], ["claude-code", true], ["codex", true], ["cursor", true], ["gemini", true], ["kilo", true], ["opencode", true], ["qwen", false],
    ]);
    expect(choices.some((c) => c.id === "moss-subagent")).toBe(false);
  });

  test("the agent: the last used, else MOSS's own, else the first this computer has; never one it lacks", () => {
    expect(pickAgent(choices, RECENT)).toEqual({ agent: "claude-code", from: "last" });
    expect(pickAgent(choices, undefined)).toEqual({ agent: "moss-code", from: "moss" });
    expect(pickAgent(choices, { backend: "qwen" })).toEqual({ agent: "moss-code", from: "moss" });
    expect(pickAgent(choices.filter((c) => c.id !== "moss-code"), undefined)).toEqual({ agent: "claude-code", from: "first" });
    expect(pickAgent([], undefined)).toEqual({ from: "none" });
  });

  test("model and effort: the last used for that agent, else its default; a model's own default effort fills in", () => {
    expect(pickModel("claude-code", OPTIONS["claude-code"], RECENT)).toEqual({ model: "anthropic/claude-opus-5-5", effort: "high", from: "last" });
    expect(pickModel("moss-code", OPTIONS["moss-code"], RECENT)).toEqual({ model: "anthropic/claude-opus-5-5", effort: "medium", from: "default" });
    // The last used model is no longer offered: the default.
    expect(pickModel("claude-code", OPTIONS["claude-code"], { backend: "claude-code", model: "anthropic/gone" })).toEqual({ model: "anthropic/claude-opus-5-5", effort: "high", from: "default" });
    // The last effort isn't one this model has: the model's default effort.
    expect(pickModel("claude-code", OPTIONS["claude-code"], { backend: "claude-code", model: "anthropic/claude-opus-5-5", effort: "turbo" })).toEqual({ model: "anthropic/claude-opus-5-5", effort: "high", from: "last" });
  });

  test("unknown until started is the agent's own default: nothing is sent", () => {
    expect(pickModel("gemini", OPTIONS.gemini, undefined)).toEqual({ from: "unknown" });
    expect(pickModel("gemini", undefined, undefined)).toEqual({ from: "unknown" });
    expect(startParams("gemini", FOLDERS[0]!, pickModel("gemini", OPTIONS.gemini, undefined))).toEqual({ backend: "gemini", root: "pick-1" });
  });

  test("the folder: the newest recent one; none when there is none", () => {
    expect(pickFolder(FOLDERS)).toEqual(FOLDERS[0]);
    expect(pickFolder([])).toBeUndefined();
    expect(pickFolder(undefined)).toBeUndefined();
  });

  test("Create's params carry the choices as they stand", () => {
    expect(startParams("claude-code", FOLDERS[1]!, { model: "anthropic/claude-opus-5-5", effort: "high" })).toEqual({ backend: "claude-code", root: "pick-2", model: "anthropic/claude-opus-5-5", effort: "high" });
    expect(effortsFor(OPTIONS["claude-code"], "anthropic/claude-opus-5-5")).toEqual(["low", "medium", "high", "max"]);
  });
});
