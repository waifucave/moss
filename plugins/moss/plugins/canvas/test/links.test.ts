import { describe, expect, test } from "bun:test";
import { SAMPLE_SESSION_SCENE, foldSessionEvents } from "@waifucave/moss-protocol";
import { applyLink, EMPTY_LINKS, livePeers, peerId, waveDone, WAVE_STALE_MS, WAVES_MAX, type LinkEvent, type LinkState } from "../client/links";
import { botBlockId, buildModel } from "../client/model";
import { BACKENDS } from "../gallery/fixtures";

const looks = new Map(BACKENDS.map((b) => [b.id, b]));

/** Plays the scene's events in order, as the canvas hears them: each link against the model as it stands then. */
function play(until = Infinity): { links: LinkState; seen: { link: LinkEvent; state: LinkState }[] } {
  let state = foldSessionEvents([]);
  let links = EMPTY_LINKS;
  const seen: { link: LinkEvent; state: LinkState }[] = [];
  for (const step of SAMPLE_SESSION_SCENE) {
    if (step.at > until) break;
    state = foldSessionEvents([step.event], state);
    if (step.event.type === "session_link") {
      links = applyLink(links, step.event as LinkEvent, buildModel(state.sessions, looks));
      seen.push({ link: step.event as LinkEvent, state: links });
    }
  }
  return { links, seen };
}

describe("the link bookkeeping", () => {
  test("a message between two main sessions draws their line the first time, and it stays (one line, either way)", () => {
    const { seen } = play();
    const firstMessage = seen.findIndex((s) => s.link.from.end === "session" && s.link.from.session === "s_a" && s.link.to.session === "s_b");
    expect(seen[firstMessage - 1]!.state.peers).toEqual([]);
    expect(seen[firstMessage]!.state.peers.map((e) => e.id)).toEqual([peerId("s_a", "s_b")]);
    // s_b answers s_a at 9 s: the same line, not a second; it carried two links.
    expect(play().links.peers.map((e) => e.id)).toEqual([peerId("s_a", "s_b")]);
    expect(play().links.heard[peerId("s_a", "s_b")]).toBe(2);
    expect(play().links.heard["to:s_a"]).toBe(1);
  });

  test("a wave runs on the line from the sender to the receiver, in the sender's colour", () => {
    const { seen } = play();
    const spawn = seen.find((s) => s.link.link === "spawn" && s.link.to.session === "s_c")!;
    expect(spawn.state.waves.at(-1)).toMatchObject({ edge: "child:s_c", from: "s_a", to: "s_c", color: looks.get("claude-code")!.color });
    const answer = seen.find((s) => s.link.from.end === "session" && s.link.from.session === "s_b" && s.link.to.session === "s_a")!;
    expect(answer.state.waves.at(-1)).toMatchObject({ edge: peerId("s_a", "s_b"), from: "s_b", to: "s_a", color: looks.get("codex")!.color });
    const report = seen.find((s) => s.link.link === "report" && s.link.to.session === "s_a")!;
    expect(report.state.waves.at(-1)).toMatchObject({ edge: "child:s_c", from: "s_c", to: "s_a", link: "report" });
  });

  test("a bot's message to its agent and the agent's report run on the bot's line", () => {
    const { seen } = play();
    const toAgent = seen.find((s) => s.link.link === "spawn" && s.link.to.session === "s_d")!;
    expect(toAgent.state.waves.at(-1)).toMatchObject({ edge: "bot:s_d", from: botBlockId("moss"), to: "s_d" });
    const back = seen.find((s) => s.link.link === "report" && s.link.to.session === "s_moss")!;
    expect(back.state.waves.at(-1)).toMatchObject({ edge: "bot:s_d", from: "s_d", to: botBlockId("moss") });
  });

  test("the person's message has no block to start from: only the receiving point lights", () => {
    const { seen } = play();
    expect(seen[0]!.state.waves).toEqual([expect.objectContaining({ to: "s_a", link: "message" })]);
    expect(seen[0]!.state.waves[0]!.edge).toBeUndefined();
    expect(seen[0]!.state.waves[0]!.from).toBeUndefined();
  });

  test("a wave goes when its view ends it; stale ones go on the next link; at most WAVES_MAX", () => {
    const { links } = play();
    const first = links.waves[0]!.id;
    expect(waveDone(links, first).waves.some((w) => w.id === first)).toBe(false);
    expect(waveDone(links, 99_999)).toBe(links);
    const model = buildModel(foldSessionEvents(SAMPLE_SESSION_SCENE.map((s) => s.event)).sessions, looks);
    const later: LinkEvent = { ts: links.waves.at(-1)!.ts + WAVE_STALE_MS + 1, from: { end: "user" }, to: { session: "s_b", kind: "coding" }, link: "message" };
    expect(applyLink(links, later, model).waves.map((w) => w.to)).toEqual(["s_b"]);
    let many = EMPTY_LINKS;
    for (let i = 0; i < WAVES_MAX + 10; i++) many = applyLink(many, { ...later, ts: later.ts + i }, model);
    expect(many.waves.length).toBe(WAVES_MAX);
  });

  test("a link to a session the canvas doesn't show, or within one block, does nothing", () => {
    const model = buildModel(foldSessionEvents(SAMPLE_SESSION_SCENE.map((s) => s.event)).sessions, looks);
    const nowhere: LinkEvent = { ts: 1, from: { end: "session", session: "s_a", kind: "coding" }, to: { session: "s_gone", kind: "coding" }, link: "message" };
    expect(applyLink(EMPTY_LINKS, nowhere, model)).toBe(EMPTY_LINKS);
    const self: LinkEvent = { ts: 1, from: { end: "session", session: "s_a", kind: "coding" }, to: { session: "s_a", kind: "coding" }, link: "message" };
    expect(applyLink(EMPTY_LINKS, self, model).waves).toEqual([]);
  });

  test("a peer line whose block left the canvas is not drawn", () => {
    const { links } = play();
    const sessions = foldSessionEvents(SAMPLE_SESSION_SCENE.map((s) => s.event)).sessions;
    const model = buildModel({ ...sessions, s_b: { ...sessions.s_b!, archived: true } }, looks);
    expect(livePeers(links, model)).toEqual([]);
  });
});
