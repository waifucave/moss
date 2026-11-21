// The canvas spine's SDK shapes (spec revision 20, §9.5): a scene played into the test core, the agent's fallback mark,
// the start page key and the session tab's corner spot, the link event's area, and a backend's look in the manifest.
import { describe, expect, test } from "bun:test";
import { SAMPLE_SESSION_SCENE } from "@waifucave/moss-protocol";
import { fakeCore, playSessionScene } from "../src/ui/testing";
import { agentMark } from "../src/ui/marks";
import { EVENT_AREAS } from "../src/ui/event-areas";
import { MAIN_ROUTES, spotInfo } from "../src/catalogs/spots";
import { AgentBackendSchema } from "../src/manifest/schema";

describe("the canvas spine's SDK shapes", () => {
  test("a scene played into the test core: parts hear each event and session.list answers the sessions as they stand", async () => {
    const handlers: Record<string, (p: any) => unknown> = {};
    const core = fakeCore(handlers);
    const heard: string[] = [];
    core.on("session_link", (e) => heard.push(String(e["link"])));
    const pending: (() => void)[] = [];
    playSessionScene(core, SAMPLE_SESSION_SCENE, handlers, (_ms, fn) => { pending.push(fn); return () => {}; });
    for (const fn of pending.slice(0, 3)) fn();
    expect(((await core.call("session.list", {})) as { sessions: unknown[] }).sessions.length).toBe(3);
    for (const fn of pending.slice(3)) fn();
    expect(heard).toContain("spawn");
    expect(heard).toContain("report");
    expect(((await core.call("session.get", { id: "s_c" })) as { session: { status: string } }).session.status).toBe("stopped");
  });

  test("the agent's mark: its install's logo as an image only, else the name's first letter on its colour", () => {
    expect(agentMark({ id: "codex", name: "Codex", color: "#10a37f" })).toEqual({ kind: "letter", letter: "C", background: "#10a37f", foreground: "#ffffff" });
    expect(agentMark({ id: "x", name: "opencode", color: "#f5f5f5", color2: "#c0c0c0" })).toMatchObject({ letter: "O", background2: "#c0c0c0", foreground: "#1b1d21" });
    expect(agentMark({ id: "x", name: "  " }).kind).toBe("letter");
    expect(agentMark({ id: "x", name: "X", icon: { mediaType: "image/png", data: "AAAA", at: 1 } })).toEqual({ kind: "icon", src: "data:image/png;base64,AAAA" });
  });

  test("the start page is a main key, the corner a list spot of the session tab, the link event in the sessions area", () => {
    expect(MAIN_ROUTES).toContain("start");
    expect([spotInfo("session.corner")!.shape, spotInfo("session.corner")!.declaredBy, spotInfo("session.corner")!.botsOffer]).toEqual(["list", "session-tab", false]);
    expect(EVENT_AREAS["session_link"]).toBe("sessions");
  });

  test("a backend's entry names its own icon file and its colours", () => {
    const entry = { id: "codex", name: "Codex", protocol: "acp", icon: "marks/codex.svg", color: "#10a37f", color2: "#0b7d62" };
    expect(AgentBackendSchema.safeParse(entry).success).toBe(true);
    // That the path stays inside the folder is checked with the plugin's other paths, at validation and load (lane CA).
    expect(AgentBackendSchema.safeParse({ ...entry, color: "terracotta" }).success).toBe(false);
    expect(AgentBackendSchema.safeParse({ ...entry, logo: { candidates: [] } }).success).toBe(false);
  });
});
