// Who starts a session is told by its opener (lane CM3): the host derives the starter from kind, bot and parent, and a session
// opened with neither a bot nor a parent counts as the person's own, which any session may now message. So every opener the
// engine has must pass a bot and a parent for a session a bot started, and a session with neither is only ever one the person
// asked for. Here: what the manager passes the host for each way a session is opened (the others, read and listed in the report:
// the bots' conversation and side threads carry their bot; `codeAgent.open` is user-only by its role).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { SessionSpec } from "../../contracts/session-host";
import { derivedStarter } from "../../sessions/session-graph";
import { World, type WorldOptions } from "./world";

setDefaultTimeout(120_000);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** A world whose host remembers every spec it was asked to open. */
function make(o: WorldOptions = {}): { w: World; opened: SessionSpec[] } {
  const w = (world = new World({ script: [[{ say: "ok" }], [{ say: "ok" }]], ...o }));
  const opened: SessionSpec[] = [];
  const open = w.host.open.bind(w.host);
  w.host.open = (spec, driver) => {
    opened.push(spec);
    return open(spec, driver);
  };
  return { w, opened };
}
const USER = { kind: "user", device: "d".repeat(16), clientMessageId: "m1" } as const;

describe("every opener names who started the session", () => {
  test("a session the person asks for carries neither bot nor parent: the person's own", async () => {
    const { w, opened } = make();
    const r = await w.manager.start({ caller: USER, backend: "fake", prompt: "Hi.", root: "home/Studio/project1" });
    const spec = opened.find((s) => s.id === r.sessionId)!;
    expect(spec).toMatchObject({ kind: "coding" });
    expect(spec.bot).toBeUndefined();
    expect(spec.parent).toBeUndefined();
    expect(derivedStarter(spec)).toEqual({ kind: "user" });
  });

  test("a session a bot starts carries its bot and the session that asked: a bot's agent, never the person's", async () => {
    const { w, opened } = make();
    const r = await w.manager.start({
      caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" },
      backend: "fake", prompt: "Do it.", root: "home/Studio/project1",
    });
    const spec = opened.find((s) => s.id === r.sessionId)!;
    expect(spec).toMatchObject({ kind: "agent", bot: "alpha", parent: "s_alpha" });
    expect(derivedStarter(spec)).toEqual({ kind: "bot", bot: "alpha", session: "s_alpha" });
  });

  test("a bot's routine run and a bot's conversation carry their bot, so neither reads as a session the person started", () => {
    for (const spec of [{ kind: "side-thread", bot: "alpha", parent: "b_alpha", routine: "r1" }, { kind: "side-thread", bot: "alpha", parent: "b_alpha" }, { kind: "agent", bot: "alpha", parent: "b_alpha" }] as const) {
      expect(derivedStarter(spec).kind).not.toBe("user");
    }
  });
});
