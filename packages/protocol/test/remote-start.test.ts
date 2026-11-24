// A paired phone may start a coding session on the computer it is linked to (the owner's decision of 2026-11-24), read what its
// new-session sheet offers (`agent.backends`, `agent.options`, `agent.recent`, the three the desktop's own start panel reads),
// and may do nothing more than before. The remote role's calls are pinned: the 47 it had before this change (the frozen list
// below) plus those four, exactly. A call that is added or taken away breaks this until its author says so here and in the report.
import { describe, expect, test } from "bun:test";
import { AGENTS_METHODS } from "../src/agents";
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
  test("are the 47 they were, plus agent.start and the three reads of its sheet", () => {
    expect(BEFORE).toHaveLength(47);
    expect([...allowedMethods("remote")].sort()).toEqual([...BEFORE, "agent.backends", "agent.options", "agent.recent", "agent.start"].sort());
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
    const reach = [...MOSS_METHODS.keys()].filter((m) => /^(bot\.(create|remove|setModel|rename|archive)|pair\.|plugin\.|plugins\.|settings\.|setting\.|account\.(register|sign|link)|devices?\.(pair|add|code)|agent\.definitions|codeAgent\.|tree\.|routine\.(create|set|remove|run$))/.test(m));
    expect(reach.length).toBeGreaterThan(5);
    for (const m of reach) expect([m, remote.has(m)]).toEqual([m, false]);
  });
});
