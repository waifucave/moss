// The canvas on the SDK's own test layer (`TestLayer`: the real `useCore`, `usePluginApi`, `useUserSend`), fed by the
// spine's `playSessionScene` with SAMPLE_SESSION_SCENE on a clock the test turns.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SAMPLE_SESSION_SCENE, type SessionSceneStep } from "@waifucave/moss-plugin-sdk/ui/testing";
import { fakeCore, playSessionScene, runtimeWith, TestLayer, type FakeCore } from "@waifucave/moss-plugin-sdk/ui/testing";
import { CanvasBar, CanvasCorner, CanvasStart, type ShellRoute } from "../client/entry";
import { BACKENDS, FOLDERS, LAST_LINES, OPTIONS, RECENT } from "../gallery/fixtures";

afterEach(() => cleanup());

/** A clock the test turns: each step runs when the test reaches its time. */
function clock() {
  const queue: { ms: number; fn: () => void; done: boolean }[] = [];
  let now = 0;
  return {
    schedule: (ms: number, fn: () => void) => {
      const item = { ms, fn, done: false };
      queue.push(item);
      return () => { item.done = true; };
    },
    to(t: number) {
      now = t;
      for (const item of queue.filter((q) => !q.done && q.ms <= now).sort((a, b) => a.ms - b.ms)) {
        item.done = true;
        item.fn();
      }
    },
  };
}

/** A real press: the browser marks the person's own input `isTrusted`; a page's own click or dispatched event is not. */
function press(el: Element, init: { key?: string; repeat?: boolean; shiftKey?: boolean } = {}) {
  const e = init.key !== undefined ? new KeyboardEvent("keydown", { key: init.key, repeat: init.repeat ?? false, shiftKey: init.shiftKey ?? false, bubbles: true, cancelable: true }) : new MouseEvent("click", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "isTrusted", { value: true });
  act(() => { el.dispatchEvent(e); });
}

interface Harness {
  core: FakeCore;
  sends: { to: unknown; message: unknown }[];
  routes: ShellRoute[];
  settings: Map<string, unknown>;
  /** The sessions whose history the canvas read, in order (an opened block's last line). */
  histories: string[];
  to(t: number): void;
  botState(bot: string, state: string): void;
}

function mount(o: { scene?: readonly SessionSceneStep[]; playedTo?: number; params?: { session?: string }; send?: () => Promise<void>; places?: string; unserved?: readonly string[]; backends?: unknown[]; pairs?: unknown[]; seen?: number; barHeight?: number } = {}): Harness {
  const handlers: Record<string, (p: any) => unknown> = {
    "agent.backends": () => ({ backends: o.backends ?? BACKENDS }),
    "computer.list": () => ({ computers: [{ name: "Studio", link: "self" }] }),
    "agent.recent": () => ({ ...RECENT, roots: [] }),
    "agent.options": (p: { backend: string }) => OPTIONS[p.backend] ?? { backend: p.backend, known: false, source: "unknown", models: [] },
    "ui.pick": (p: { recent?: boolean }) => (p.recent ? { recent: FOLDERS } : { picked: { token: "pick-9", name: "elsewhere" } }),
    "agent.start": () => ({ session: "s_new" }),
    "app.openIn": () => ({ opened: true, started: false }),
    "session.links": () => ({ pairs: o.pairs ?? [], links: [] }),
  };
  for (const m of o.unserved ?? []) delete handlers[m];
  const core = fakeCore(handlers);
  const c = clock();
  playSessionScene(core, (o.scene ?? SAMPLE_SESSION_SCENE) as never, handlers, c.schedule);
  if (o.playedTo !== undefined) c.to(o.playedTo);
  const sends: Harness["sends"] = [];
  const routes: ShellRoute[] = [];
  const settings = new Map<string, unknown>([...(o.places !== undefined ? [["places", o.places] as const] : []), ...(o.seen !== undefined ? [["seen", o.seen] as const] : [])]);
  const activity: unknown[] = [];
  const histories: string[] = [];
  const feed: ((a: unknown) => void)[] = [];
  const api = {
    settings: { get: async (k: string) => settings.get(k), set: async (k: string, v: unknown) => void settings.set(k, v) },
    sessions: { history: async (s: string) => { histories.push(s); return { events: LAST_LINES[s] ?? [], hasMore: false }; } },
    bots: { list: async () => [{ id: "moss", name: "MOSS" }] },
    activity: { list: async () => activity, watch: (_kind: string, l: (a: unknown) => void) => { feed.push(l); return () => undefined; } },
  };
  const runtime = runtimeWith({
    core: () => core,
    api: () => api,
    userSend: () => async (to, message) => {
      sends.push({ to, message });
      await o.send?.();
    },
  });
  render(
    // The page and its line on the window's bar, as the shell draws them (`main` and `page.bar`, both keyed `start`).
    <>
      {/* The bar's entry reads only the page's word (bar.ts): no layer of its own (a second test layer would share the scene's feed). */}
      <header className="test-bar">
        <CanvasBar props={{ route: "start", barHeight: o.barHeight ?? 45 }} />
      </header>
      <TestLayer runtime={runtime} pluginId="moss/canvas" entry="start" spot="main" spotKey="start">
        <CanvasStart props={{ route: "start", params: o.params ?? {}, navigate: (r) => routes.push(r), ...(o.barHeight !== undefined ? { barHeight: o.barHeight } : {}) }} />
      </TestLayer>
    </>,
  );
  return { core, sends, routes, settings, histories, to: (t) => act(() => c.to(t)), botState: (bot, state) => act(() => { for (const l of feed) l({ subject: { kind: "bots", id: bot }, state, since: 0 }); }) };
}

const block = (id: string) => document.querySelector(`[data-block="${id}"]`) as HTMLElement | null;
const head = (id: string) => block(id)!.querySelector(".cv-head") as HTMLButtonElement;

/** The end of a message's timer, as the browser reports it. */
const runEnd = () => Object.assign(new Event("animationend", { bubbles: true }), { animationName: "cv-timer" });

describe("the canvas plays the sample scene", () => {
  test("blocks appear as sessions start; the child and the subagent join their parent; the bot's session joins the bot", async () => {
    const h = mount();
    await waitFor(() => expect(screen.getByRole("list", { name: "Sessions" })).toBeDefined());
    h.to(600);
    await waitFor(() => expect(block("s_a")).not.toBeNull());
    expect(block("s_b")).not.toBeNull();
    expect(block("bot:moss")).not.toBeNull();
    h.to(3_000);
    await waitFor(() => expect(block("sub:s_a:call_explore_1")).not.toBeNull());
    h.to(7_600);
    await waitFor(() => expect(block("s_d")).not.toBeNull());
    expect(block("s_c")).not.toBeNull();
    expect(block("sub:s_a:call_explore_1")).not.toBeNull();
    const lines = [...document.querySelectorAll(".cv-lines .cv-line")].map((l) => l.getAttribute("data-kind"));
    expect(lines.sort()).toEqual(["bot", "child", "child", "peer"]);
    // Joined points always show (data-on): s_a's right (its child, its subagent), s_c's left, s_d's left, the bot's right.
    const on = (id: string) => [...block(id)!.querySelectorAll(".cv-port[data-on]")].map((p) => p.getAttribute("data-port")).sort();
    expect(on("s_c")).toEqual(["l"]);
    expect(on("s_d")).toEqual(["l"]);
    expect(on("bot:moss")).toEqual(["r"]);
    expect(on("s_a")).toContain("r");
  });

  test("a message between two main sessions draws their dotted line and a wave runs from the sender to the receiver; the hit's end ends it", async () => {
    const h = mount();
    h.to(5_400);
    await waitFor(() => expect(block("s_b")).not.toBeNull());
    expect(document.querySelector('.cv-line[data-kind="peer"]')).toBeNull();
    h.to(5_500);
    await waitFor(() => expect(document.querySelector('.cv-line[data-kind="peer"]')).not.toBeNull());
    const msgs = [...document.querySelectorAll(".cv-msg")] as SVGGElement[];
    const wave = msgs[msgs.length - 1]!;
    // The light on the line, in the sender's colour (Claude Code's), in small dashes of the running light's look; the
    // points light as it passes; the sender's effect swells as it leaves, the receiver's (Codex) as it lands, turning
    // from the sender's colour into its own.
    expect(wave.querySelectorAll(".cv-mlight").length).toBeGreaterThan(10);
    expect(new Set([...wave.querySelectorAll(".cv-mlight")].map((l) => l.getAttribute("d"))).size).toBe(1);
    expect([...wave.querySelectorAll(".cv-dotflash")].map((d) => d.getAttribute("data-dot"))).toEqual(["sender", "receiver"]);
    expect(wave.getAttribute("style")).toContain("--brand: #D97757");
    expect(block("s_a")!.querySelector('.cv-react[data-kind="swell"]:not([data-morph])')).not.toBeNull();
    const landing = block("s_b")!.querySelector('.cv-react[data-kind="swell"][data-morph]') as HTMLElement;
    expect(landing.style.getPropertyValue("--from")).toBe("#D97757");
    expect(landing.querySelector(".cv-react__to")).not.toBeNull();
    expect(document.querySelector(".cv-hit")).toBeNull();
    const id = wave.getAttribute("data-wave")!;
    act(() => { wave.querySelector("[data-last]")!.dispatchEvent(runEnd()); });
    await waitFor(() => expect(document.querySelector(`.cv-msg[data-wave="${id}"]`)).toBeNull());
    expect(block("s_b")!.querySelector(".cv-react")).toBeNull();
    // The line stays, and says how many links it carried (a steady mark: what an acceptance row reads).
    expect(document.querySelector('.cv-line[data-kind="peer"]')!.getAttribute("data-links")).toBe("1");
    h.to(9_000);
    await waitFor(() => expect(document.querySelector('.cv-line[data-kind="peer"]')!.getAttribute("data-links")).toBe("2"));
  });

  test("a message that starts its receiver running starts its running light with the crest at its point, as it arrives", async () => {
    const h = mount();
    h.to(1_000);
    await waitFor(() => expect(block("s_a")?.getAttribute("data-motion")).toBe("running"));
    // The person's message at 1 s reached s_a as it began to run (both at 1 s): from its left point (270°).
    const ring = block("s_a")!.querySelector(".cv-ring[data-handover]") as HTMLElement;
    expect(ring.style.getPropertyValue("--a0")).toBe(`${(270 - 317 + 360) % 360}deg`);
    // s_a waits from 6 s and runs again with s_b's message at 9 s: s_b sits below, so from its bottom point (180°).
    h.to(6_000);
    await waitFor(() => expect(block("s_a")!.getAttribute("data-motion")).toBe("waiting"));
    h.to(9_000);
    await waitFor(() => expect((block("s_a")!.querySelector(".cv-ring[data-handover]") as HTMLElement | null)?.style.getPropertyValue("--a0")).toBe(`${(180 - 317 + 360) % 360}deg`));
  });

  test("running shows the light, waiting the dashes, running wins; at the end, still and idle, nothing animates", async () => {
    const h = mount();
    h.to(1_000);
    await waitFor(() => expect(block("s_a")!.getAttribute("data-motion")).toBe("running"));
    expect(block("s_a")!.querySelector(".cv-ring")).not.toBeNull();
    h.to(6_000);
    await waitFor(() => expect(block("s_a")!.getAttribute("data-motion")).toBe("waiting"));
    expect(block("s_a")!.querySelector(".cv-ring")).toBeNull();
    expect(block("s_a")!.querySelector(".cv-march")).not.toBeNull();
    h.to(9_000);
    await waitFor(() => expect(block("s_a")!.getAttribute("data-motion")).toBe("running"));
    expect(block("s_a")!.querySelector(".cv-march")).toBeNull();
    h.to(20_000);
    await waitFor(() => expect(block("s_a")!.getAttribute("data-motion")).toBe("still"));
    // Every trip ends (as the browser would end its last stretch's animation).
    for (const last of [...document.querySelectorAll(".cv-msg [data-last]")]) act(() => { last.dispatchEvent(runEnd()); });
    await waitFor(() => expect(document.querySelectorAll(".cv-ring, .cv-march, .cv-msg, .cv-react").length).toBe(0));
  });

  test("opened again, the lines are drawn from the engine's record; one that carried a link while it was away is marked once", async () => {
    const T = 1_781_270_000_000;
    const pair = { from: { end: "session", session: "s_a", kind: "coding" }, to: { session: "s_b", kind: "coding" }, last: "message", lastAt: T + 9_000, count: 2 };
    mount({ playedTo: 9_500, pairs: [pair], seen: T + 8_000 });
    await waitFor(() => expect(document.querySelector('.cv-line[data-kind="peer"]')).not.toBeNull());
    const line = document.querySelector('.cv-line[data-kind="peer"]')!;
    expect(line.getAttribute("data-away")).not.toBeNull();
    // Nothing plays for an old link.
    expect(document.querySelector(".cv-msg")).toBeNull();
  });

  test("sessions that ended before the canvas opened fold into a count that expands; ones that end while it is open stay", async () => {
    mount({ playedTo: 20_000 });
    await waitFor(() => expect(block("s_a")).not.toBeNull());
    expect(block("s_c")).toBeNull();
    expect(block("s_d")).toBeNull();
    // s_c, s_d and the subagent row ended before it opened.
    const folded = screen.getByRole("button", { name: "3 ended" });
    fireEvent.click(folded);
    expect(block("s_c")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Hide ended" })).toBeDefined();
    cleanup();
    const live = mount();
    await waitFor(() => expect(screen.getByRole("list", { name: "Sessions" })).toBeDefined());
    // Played as it happens: each step renders before the next.
    for (const step of SAMPLE_SESSION_SCENE) live.to(step.at);
    await waitFor(() => expect(block("s_c")?.getAttribute("data-motion")).toBe("ended"));
    expect(screen.queryByRole("button", { name: /\d ended/ })).toBeNull();
  });
});

describe("a block, pressed", () => {
  test("it grows and shows the last line, a composer and Open tab; Escape or a click elsewhere closes it", async () => {
    const h = mount({ playedTo: 1_000 });
    await waitFor(() => expect(block("s_a")).not.toBeNull());
    fireEvent.click(head("s_a"));
    expect(block("s_a")!.hasAttribute("data-open")).toBe(true);
    expect(block("s_a")!.style.width).toBe("322px");
    await waitFor(() => expect(within(block("s_a")!).getByText("Moved it after; the login test passes now.")).toBeDefined());
    expect(within(block("s_a")!).getByRole("textbox", { name: "Message Fix the login flow" })).toBeDefined();
    fireEvent.click(within(block("s_a")!).getByRole("button", { name: /Open tab/ }));
    expect(h.routes).toEqual([{ route: "agent", params: { session: "s_a" } }]);
    fireEvent.keyDown(block("s_a")!, { key: "Escape" });
    expect(block("s_a")!.hasAttribute("data-open")).toBe(false);
    fireEvent.click(head("s_a"));
    fireEvent.pointerDown(document.querySelector(".cv-viewport")!, { button: 0, pointerId: 1 });
    expect(block("s_a")!.hasAttribute("data-open")).toBe(false);
  });

  test("its last line is read each time it opens and again when its session changes while open; no tooltip holds it", async () => {
    const h = mount({ playedTo: 1_000 });
    await waitFor(() => expect(block("s_a")).not.toBeNull());
    fireEvent.click(head("s_a"));
    await waitFor(() => expect(h.histories.filter((s) => s === "s_a").length).toBe(1));
    expect(block("s_a")!.querySelector(".cv-last")!.hasAttribute("title")).toBe(false);
    h.to(2_500);
    await waitFor(() => expect(h.histories.filter((s) => s === "s_a").length).toBe(2));
    fireEvent.keyDown(block("s_a")!, { key: "Escape" });
    fireEvent.click(head("s_a"));
    await waitFor(() => expect(h.histories.filter((s) => s === "s_a").length).toBe(3));
  });

  test("its composer sends as the person, once per press: Enter or Send, never a held key's repeat, a page's own event, or a press while one is on its way", async () => {
    let release!: () => void;
    const h = mount({ playedTo: 1_000, send: () => new Promise<void>((r) => { release = r; }) });
    await waitFor(() => expect(block("s_a")).not.toBeNull());
    fireEvent.click(head("s_a"));
    const box = within(block("s_a")!).getByRole("textbox", { name: "Message Fix the login flow" });
    fireEvent.change(box, { target: { value: "Also check the logout" } });
    // A page's own events: none.
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(within(block("s_a")!).getByRole("button", { name: "Send" }));
    (within(block("s_a")!).getByRole("button", { name: "Send" }) as HTMLButtonElement).click();
    expect(h.sends).toEqual([]);
    // A held Enter's repeat: none.
    press(box, { key: "Enter", repeat: true });
    expect(h.sends).toEqual([]);
    // The person's Enter: one, to this session, with their words.
    press(box, { key: "Enter" });
    expect(h.sends).toEqual([{ to: { session: "s_a" }, message: { text: "Also check the logout" } }]);
    // Another press while it is on its way: none.
    press(box, { key: "Enter" });
    expect(h.sends.length).toBe(1);
    await act(async () => { release(); });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
    fireEvent.change(box, { target: { value: "Thanks" } });
    press(within(block("s_a")!).getByRole("button", { name: "Send" }));
    expect(h.sends.map((s) => s.message)).toEqual([{ text: "Also check the logout" }, { text: "Thanks" }]);
    // What the person types while a send is on its way stays.
    fireEvent.change(box, { target: { value: "Thanks, and the docs" } });
    await act(async () => { release(); });
    expect((box as HTMLTextAreaElement).value).toBe("Thanks, and the docs");
  });

  test("a subagent's block has no composer (no one can message it) and opens its session's tab", async () => {
    const h = mount({ playedTo: 3_000 });
    await waitFor(() => expect(block("sub:s_a:call_explore_1")).not.toBeNull());
    fireEvent.click(head("sub:s_a:call_explore_1"));
    expect(within(block("sub:s_a:call_explore_1")!).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(block("sub:s_a:call_explore_1")!).getByRole("button", { name: /Open its session's tab/ }));
    expect(h.routes).toEqual([{ route: "agent", params: { session: "s_a" } }]);
  });

  test("a bot's block offers Open in MOSS, which asks the engine (app.openIn) only on the person's press", async () => {
    const h = mount({ playedTo: 8_000 });
    await waitFor(() => expect(block("bot:moss")).not.toBeNull());
    expect(within(block("bot:moss")!).getByText("MOSS")).toBeDefined();
    fireEvent.click(head("bot:moss"));
    const open = within(block("bot:moss")!).getByRole("button", { name: /Open in MOSS/ });
    expect(within(block("bot:moss")!).queryByRole("textbox")).toBeNull();
    fireEvent.click(open);
    expect(h.core.calls.filter((c) => c.method === "app.openIn")).toEqual([]);
    press(open);
    expect(h.core.calls.filter((c) => c.method === "app.openIn")).toEqual([{ method: "app.openIn", params: { program: "moss", what: { kind: "bot", bot: "moss" } } }]);
  });

  test("a bot's face follows its live state from the activity feed, and says it in words", async () => {
    const h = mount({ playedTo: 8_000 });
    await waitFor(() => expect(block("bot:moss")).not.toBeNull());
    // The SDK's living face (the same drawing MOSS makes), in the feed's mood.
    expect(block("bot:moss")!.querySelector("canvas.face")!.getAttribute("data-mood")).toBe("idle");
    h.botState("moss", "thinking");
    await waitFor(() => expect(block("bot:moss")!.querySelector("canvas.face")!.getAttribute("data-mood")).toBe("thinking"));
    expect(within(block("bot:moss")!).getByText("bot · Thinking")).toBeDefined();
    // Busy itself, it is drawn running, not waiting.
    expect(block("bot:moss")!.getAttribute("data-motion")).toBe("running");
  });

  test("a mark is bare: no tile; a black-and-white brand's block sets no colour (the theme's text colour)", async () => {
    const T0 = 1_781_270_000_000;
    mount({ scene: [{ at: 0, event: { type: "session_changed", ts: T0, session: { id: "s_o", kind: "coding", computer: "Studio", status: "prompting", startedAt: T0, updatedAt: T0, title: "Port the parser", backend: "opencode", startedBy: { kind: "user" } } } }], playedTo: 0 });
    await waitFor(() => expect(block("s_o")).not.toBeNull());
    expect(block("s_o")!.style.getPropertyValue("--brand")).toBe("");
    // The SDK's mark (no icon in this data: its letter), its only wrapper the name's tooltip.
    const mark = block("s_o")!.querySelector("[data-agent-mark]")!;
    expect(mark.getAttribute("data-agent-mark")).toBe("letter");
    // Its only wrapper carries the agent's name as a tooltip and draws nothing (no tile, no border, no background).
    expect(mark.parentElement!.className).toBe("cv-markwrap");
    expect(mark.parentElement!.getAttribute("title")).toBe("OpenCode");
  });

  test("with an icon, the line under the title is model · effort only; the agent's name is the mark's tooltip and in the announcement; an unknown model leaves the line empty at its height", async () => {
    const T0 = 1_781_270_000_000;
    const icon = { mediaType: "image/svg+xml", data: btoa('<svg><path fill="#D97757"/></svg>'), at: 0 };
    mount({
      scene: [
        { at: 0, event: { type: "session_changed", ts: T0, session: { id: "s_x", kind: "coding", computer: "Studio", status: "idle", startedAt: T0, updatedAt: T0, title: "With a model", backend: "claude-code", model: "anthropic/claude-opus-5-5", effort: "medium", startedBy: { kind: "user" } } } },
        { at: 0, event: { type: "session_changed", ts: T0, session: { id: "s_y", kind: "coding", computer: "Studio", status: "idle", startedAt: T0 + 1, updatedAt: T0, title: "No model yet", backend: "claude-code", startedBy: { kind: "user" } } } },
      ],
      playedTo: 0,
      backends: BACKENDS.map((b) => (b.id === "claude-code" ? { ...b, icon } : b)),
    });
    await waitFor(() => expect(block("s_x")).not.toBeNull());
    expect(block("s_x")!.querySelector(".cv-meta")!.textContent).toBe("Claude Opus 5.5 · medium");
    expect(block("s_x")!.querySelector(".cv-markwrap")!.getAttribute("title")).toBe("Claude Code");
    expect(head("s_x").getAttribute("aria-label")).toBe("With a model, Claude Code · Claude Opus 5.5 · medium, Idle");
    expect(block("s_y")!.querySelector(".cv-meta")!.textContent).toBe(" ");
  });

  test("blocks are a list, each announced with its state and reachable from the keyboard", async () => {
    mount({ playedTo: 8_000 });
    await waitFor(() => expect(block("s_b")).not.toBeNull());
    const list = screen.getByRole("list", { name: "Sessions" });
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBe(5);
    expect(within(list).getByRole("button", { name: "Docs pass, Codex · GPT 6 · medium, Waiting · 1 background job" })).toBeDefined();
    expect(within(list).getByRole("button", { name: "MOSS, bot, Waiting · 1 session" })).toBeDefined();
    for (const b of within(list).getAllByRole("button")) expect(b.tagName).toBe("BUTTON");
  });

  test("dragging a block moves it and keeps where it went in the plugin's own setting; it comes back there next time", async () => {
    const h = mount({ playedTo: 1_000 });
    await waitFor(() => expect(block("s_b")).not.toBeNull());
    const before = { left: block("s_b")!.style.left, top: block("s_b")!.style.top };
    const vp = document.querySelector(".cv-viewport")!;
    fireEvent.pointerDown(head("s_b"), { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(vp, { pointerId: 7, clientX: 160, clientY: 400 });
    fireEvent.pointerUp(vp, { pointerId: 7, clientX: 160, clientY: 400 });
    // The click that ends a drag (the browser sends it right after the pointer's release) doesn't open the block.
    fireEvent.click(head("s_b"));
    expect(block("s_b")!.hasAttribute("data-open")).toBe(false);
    await waitFor(() => expect(h.settings.get("places")).toBeDefined());
    const kept = JSON.parse(h.settings.get("places") as string) as Record<string, { x: number; y: number }>;
    expect(kept.s_b).toEqual({ x: Number.parseInt(before.left) + 60, y: Number.parseInt(before.top) + 300 });
    // But only that click: once it has had its chance, the next press opens another block. (A captured pointer's click
    // may never reach the head: the next press, or Enter on a focused block, still counts.)
    fireEvent.pointerDown(head("s_b"), { button: 0, pointerId: 8, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(vp, { pointerId: 8, clientX: 130, clientY: 120 });
    fireEvent.pointerUp(vp, { pointerId: 8, clientX: 130, clientY: 120 });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(head("s_a"));
    expect(block("s_a")!.hasAttribute("data-open")).toBe(true);
    fireEvent.keyDown(block("s_a")!, { key: "Escape" });
    fireEvent.pointerDown(head("s_b"), { button: 0, pointerId: 9, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(vp, { pointerId: 9, clientX: 140, clientY: 90 });
    fireEvent.pointerUp(vp, { pointerId: 9, clientX: 140, clientY: 90 });
    fireEvent.pointerDown(head("s_a"), { button: 0, pointerId: 10, clientX: 0, clientY: 0 });
    fireEvent.click(head("s_a"));
    expect(block("s_a")!.hasAttribute("data-open")).toBe(true);
    const places = h.settings.get("places") as string;
    const last = JSON.parse(places) as Record<string, { x: number; y: number }>;
    cleanup();
    mount({ playedTo: 1_000, places });
    await waitFor(() => expect(block("s_b")?.style.top).toBe(`${last.s_b!.y}px`));
  });
});

test("drags in quick succession write the setting once, and the newest place is written when the canvas closes", async () => {
  const h = mount({ playedTo: 1_000 });
  await waitFor(() => expect(block("s_b")).not.toBeNull());
  const vp = document.querySelector(".cv-viewport")!;
  const sets: string[] = [];
  const set = h.settings.set.bind(h.settings);
  h.settings.set = (k: string, v: unknown) => { if (k === "places") sets.push(v as string); return set(k, v); };
  for (const [i, dy] of [[1, 40], [2, 80], [3, 120]] as const) {
    fireEvent.pointerDown(head("s_b"), { button: 0, pointerId: 20 + i, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(vp, { pointerId: 20 + i, clientX: 100, clientY: 100 + dy });
    fireEvent.pointerUp(vp, { pointerId: 20 + i, clientX: 100, clientY: 100 + dy });
  }
  await waitFor(() => expect(sets.length).toBe(1));
  const top = block("s_b")!.style.top;
  cleanup();
  await waitFor(() => expect(sets.length).toBe(2));
  expect((JSON.parse(sets.at(-1)!) as Record<string, { y: number }>).s_b!.y).toBe(Number.parseInt(top));
});

describe("+ New session", () => {
  test("every step comes preselected, so Create at once starts the last used agent, model, effort and folder, and opens its tab", async () => {
    const h = mount({ playedTo: 1_000 });
    await waitFor(() => expect(block("s_a")).not.toBeNull());
    const before = h.core.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    // Asked inside the press: the last start at once, the recent folders as soon as it answers (the dialog's door
    // answers a press only, within its second).
    expect(h.core.calls.slice(before).map((c) => c.method)).toEqual(["agent.recent"]);
    await waitFor(() => expect(h.core.calls.slice(before).map((c) => c.method)).toEqual(["agent.recent", "ui.pick"]));
    expect(h.core.calls.find((c) => c.method === "ui.pick")!.params).toEqual({ kind: "folder", use: "agent.start", recent: true, dialog: false });
    const panel = await screen.findByRole("dialog", { name: "New session" });
    await waitFor(() => expect(within(panel).getByRole("radio", { name: /Claude Code/ }).getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect(within(panel).getByText("Opus 5.5 · high")).toBeDefined());
    expect(within(panel).getByText("app")).toBeDefined();
    const create = within(panel).getByRole("button", { name: "Create session" });
    // A held Enter (focus lands on Create once every step is chosen): its repeats don't press it.
    expect(fireEvent.keyDown(create, { key: "Enter", repeat: true })).toBe(false);
    expect(fireEvent.keyDown(create, { key: "Enter" })).toBe(true);
    fireEvent.click(create);
    expect(h.core.calls.filter((c) => c.method === "agent.start")).toEqual([]);
    press(create);
    expect(h.core.calls.filter((c) => c.method === "agent.start")).toEqual([{ method: "agent.start", params: { backend: "claude-code", root: "pick-1", model: "anthropic/claude-opus-5-5", effort: "high" } }]);
    await waitFor(() => expect(h.routes).toEqual([{ route: "agent", params: { session: "s_new" } }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("another agent: its own default model; one unknown until started sends no model; another folder comes from the dialog", async () => {
    const h = mount({ playedTo: 1_000 });
    fireEvent.click(await screen.findByRole("button", { name: "New session" }));
    const panel = await screen.findByRole("dialog", { name: "New session" });
    await waitFor(() => expect(within(panel).getByRole("radio", { name: /Claude Code/ }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(within(panel).getByRole("radio", { name: /MOSS's coding agent/ }));
    await waitFor(() => expect(within(panel).getByText("Opus 5.5 · medium")).toBeDefined());
    fireEvent.click(within(panel).getByRole("radio", { name: /Gemini CLI/ }));
    await waitFor(() => expect(within(panel).getByText(/Gemini CLI's own default/)).toBeDefined());
    expect(within(panel).getByRole("radio", { name: /Qwen/ }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: "Change" }));
    press(within(panel).getByRole("button", { name: "Choose another folder…" }));
    await waitFor(() => expect(within(panel).getByRole("radio", { name: "elsewhere" }).getAttribute("aria-checked")).toBe("true"));
    press(within(panel).getByRole("button", { name: "Create session" }));
    expect(h.core.calls.filter((c) => c.method === "agent.start").map((c) => c.params)).toEqual([{ backend: "gemini", root: "pick-9" }]);
  });
});

test("+ before the engine serves agent.recent: no folder dialog opens; the folder step asks for one", async () => {
  const h = mount({ playedTo: 1_000, unserved: ["agent.recent"] });
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));
  const panel = await screen.findByRole("dialog", { name: "New session" });
  await waitFor(() => expect(within(panel).getByRole("radio", { name: /MOSS's coding agent/ }).getAttribute("aria-checked")).toBe("true"));
  expect(h.core.calls.filter((c) => c.method === "ui.pick")).toEqual([]);
  expect(within(panel).getByText("Choose a folder to start in.")).toBeDefined();
  expect((within(panel).getByRole("button", { name: "Create session" }) as HTMLButtonElement).disabled).toBe(true);
});

describe("the tab's corner", () => {
  test("switches to the canvas with that session's block in view", () => {
    const routes: ShellRoute[] = [];
    render(
      <TestLayer runtime={runtimeWith({ api: () => ({}) })} pluginId="moss/canvas" entry="canvas-corner" spot="session.corner">
        <CanvasCorner props={{ session: "s_a", kind: "coding", navigate: (r) => routes.push(r) }} />
      </TestLayer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show on the canvas" }));
    expect(routes).toEqual([{ route: "start", params: { session: "s_a" } }]);
  });

  test("the canvas opened for a session centres its block", async () => {
    mount({ playedTo: 8_000, params: { session: "s_d" } });
    await waitFor(() => expect(block("s_d")).not.toBeNull());
    const r = block("s_d")!;
    const cx = Number.parseInt(r.style.left) + 126;
    const cy = Number.parseInt(r.style.top) + 43;
    const world = document.querySelector(".cv-world") as HTMLElement;
    await waitFor(() => expect(world.style.transform).toBe(`translate(${600 - cx}px, ${380 - cy}px) scale(1)`));
  });
});

describe("the line on the window's bar", () => {
  test("the bar holds the line and a plain + (named New session); no zoom buttons and no Fit anywhere", async () => {
    mount({ playedTo: 8_000 });
    await waitFor(() => expect(block("s_a")).not.toBeNull());
    const bar = document.querySelector(".test-bar")!;
    expect(bar.querySelector("[role=status]")?.textContent).toMatch(/^\d+ sessions?$/);
    const plus = within(bar as HTMLElement).getByRole("button", { name: "New session" });
    expect(plus.getAttribute("title")).toBe("New session");
    expect(plus.textContent).toBe("");
    expect(screen.queryByRole("button", { name: /zoom/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^fit/i })).toBeNull();
    expect(document.querySelector(".cv-bar, .cv-zoom")).toBeNull();
    // The page has no bar of its own: its section starts with the stage.
    expect(document.querySelector(".cv")!.firstElementChild?.className).toBe("cv-stage");
  });

  test("with the window's bar over its top, a session brought into view is centred in the room below the bar", async () => {
    mount({ playedTo: 8_000, params: { session: "s_d" }, barHeight: 45 });
    await waitFor(() => expect(block("s_d")).not.toBeNull());
    const r = block("s_d")!;
    const cx = Number.parseInt(r.style.left) + 126;
    const cy = Number.parseInt(r.style.top) + 43;
    const world = document.querySelector(".cv-world") as HTMLElement;
    await waitFor(() => expect(world.style.transform).toBe(`translate(${600 - cx}px, ${Math.round(45 + (760 - 45) / 2 - cy)}px) scale(1)`));
  });

  test("the first view starts below the bar: no block is born under it", async () => {
    mount({ playedTo: 8_000, barHeight: 45 });
    await waitFor(() => expect(block("s_a")).not.toBeNull());
    const world = document.querySelector(".cv-world") as HTMLElement;
    await waitFor(() => expect(world.style.transform).toMatch(/translate/));
    const m = /translate\((-?\d+)px, (-?\d+)px\) scale\(([\d.]+)\)/.exec(world.style.transform)!;
    const y = Number(m[2]);
    const k = Number(m[3]);
    const tops = [...document.querySelectorAll<HTMLElement>(".cv-node")].map((n) => y + Number.parseInt(n.style.top) * k);
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(45);
  });
});

describe("none and many", () => {
  test("an empty canvas says what to do", async () => {
    mount({ scene: [] });
    await waitFor(() => expect(screen.getByText("No sessions yet")).toBeDefined());
    expect(screen.getByText(/Press \+ on the bar to start one/)).toBeDefined();
    // The bar's line: a plain short line when there are none.
    expect(document.querySelector(".test-bar [role=status]")?.textContent).toBe("No sessions");
  });

  test("a long title is cut with the whole title on hover", async () => {
    const T0 = 1_781_270_000_000;
    const long = "Clean up the old migrations and every file that still names the previous app after the rename, then run the upgrade rows";
    mount({ scene: [{ at: 0, event: { type: "session_changed", ts: T0, session: { id: "s_l", kind: "coding", computer: "Studio", status: "idle", startedAt: T0, updatedAt: T0, title: long, backend: "codex", startedBy: { kind: "user" } } } }], playedTo: 0 });
    await waitFor(() => expect(block("s_l")).not.toBeNull());
    expect(block("s_l")!.querySelector(".cv-title")!.getAttribute("title")).toBe(long);
  });
});
