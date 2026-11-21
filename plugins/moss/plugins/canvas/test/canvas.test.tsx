// The canvas on the SDK's own test layer (`TestLayer`: the real `useCore`, `usePluginApi`, `useUserSend`), fed by the
// spine's `playSessionScene` with SAMPLE_SESSION_SCENE on a clock the test turns.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SAMPLE_SESSION_SCENE, type SessionSceneStep } from "../gallery/scene";
import { fakeCore, playSessionScene, runtimeWith, TestLayer, type FakeCore } from "@waifucave/moss-plugin-sdk/ui/testing";
import { CanvasCorner, CanvasStart, type ShellRoute } from "../client/entry";
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
  to(t: number): void;
}

function mount(o: { scene?: readonly SessionSceneStep[]; playedTo?: number; params?: { session?: string }; send?: () => Promise<void>; places?: string; unserved?: readonly string[] } = {}): Harness {
  const handlers: Record<string, (p: any) => unknown> = {
    "agent.backends": () => ({ backends: BACKENDS }),
    "computer.list": () => ({ computers: [{ name: "Studio", link: "self" }] }),
    "agent.recent": () => ({ ...RECENT, roots: [] }),
    "agent.options": (p: { backend: string }) => OPTIONS[p.backend] ?? { backend: p.backend, known: false, source: "unknown", models: [] },
    "ui.pick": (p: { recent?: boolean }) => (p.recent ? { recent: FOLDERS } : { picked: { token: "pick-9", name: "elsewhere" } }),
    "agent.start": () => ({ session: "s_new" }),
    "app.openIn": () => ({ opened: true, started: false }),
  };
  for (const m of o.unserved ?? []) delete handlers[m];
  const core = fakeCore(handlers);
  const c = clock();
  playSessionScene(core, (o.scene ?? SAMPLE_SESSION_SCENE) as never, handlers, c.schedule);
  if (o.playedTo !== undefined) c.to(o.playedTo);
  const sends: Harness["sends"] = [];
  const routes: ShellRoute[] = [];
  const settings = new Map<string, unknown>(o.places !== undefined ? [["places", o.places]] : []);
  const api = {
    settings: { get: async (k: string) => settings.get(k), set: async (k: string, v: unknown) => void settings.set(k, v) },
    sessions: { history: async (s: string) => ({ events: LAST_LINES[s] ?? [], hasMore: false }) },
    bots: { list: async () => [{ id: "moss", name: "MOSS" }] },
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
    <TestLayer runtime={runtime} pluginId="moss/canvas" entry="start" spot="main" spotKey="start">
      <CanvasStart props={{ route: "start", params: o.params ?? {}, navigate: (r) => routes.push(r) }} />
    </TestLayer>,
  );
  return { core, sends, routes, settings, to: (t) => act(() => c.to(t)) };
}

const block = (id: string) => document.querySelector(`[data-block="${id}"]`) as HTMLElement | null;
const head = (id: string) => block(id)!.querySelector(".cv-head") as HTMLButtonElement;

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
    const wave = document.querySelector(".cv-wave:last-of-type") as SVGGElement;
    expect(wave).not.toBeNull();
    // The sender's colour (Claude Code's), and the path starts at the sender's point: s_a sits above s_b, so its bottom.
    expect(wave.getAttribute("style")).toContain("#D97757");
    const id = wave.getAttribute("data-wave")!;
    const hit = document.querySelector(`.cv-hit[data-hit="${id}"]`)!;
    expect(hit.getAttribute("data-travel")).toBe("true");
    act(() => { hit.dispatchEvent(new Event("animationend", { bubbles: true })); });
    await waitFor(() => expect(document.querySelector(`.cv-wave[data-wave="${id}"]`)).toBeNull());
    // The line stays, and says how many links it carried (a steady mark: what an acceptance row reads).
    expect(document.querySelector('.cv-line[data-kind="peer"]')!.getAttribute("data-links")).toBe("1");
    h.to(9_000);
    await waitFor(() => expect(document.querySelector('.cv-line[data-kind="peer"]')!.getAttribute("data-links")).toBe("2"));
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
    // Every wave's hit ends (as the browser would end its animation).
    for (const hit of [...document.querySelectorAll(".cv-hit")]) act(() => { hit.dispatchEvent(new Event("animationend", { bubbles: true })); });
    await waitFor(() => expect(document.querySelectorAll(".cv-ring, .cv-march, .cv-wave, .cv-hit").length).toBe(0));
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
    await act(async () => { release(); });
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

  test("blocks are a list, each announced with its state and reachable from the keyboard", async () => {
    mount({ playedTo: 8_000 });
    await waitFor(() => expect(block("s_b")).not.toBeNull());
    const list = screen.getByRole("list", { name: "Sessions" });
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBe(5);
    expect(within(list).getByRole("button", { name: "Docs pass, Codex · GPT 6 · medium, Waiting · 1 background job" })).toBeDefined();
    expect(within(list).getByRole("button", { name: "MOSS, bot" })).toBeDefined();
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
    await waitFor(() => expect(h.settings.get("places")).toBeDefined());
    const kept = JSON.parse(h.settings.get("places") as string) as Record<string, { x: number; y: number }>;
    expect(kept.s_b).toEqual({ x: Number.parseInt(before.left) + 60, y: Number.parseInt(before.top) + 300 });
    // The click that ends a drag doesn't open the block.
    fireEvent.click(head("s_b"));
    expect(block("s_b")!.hasAttribute("data-open")).toBe(false);
    const places = h.settings.get("places") as string;
    cleanup();
    mount({ playedTo: 1_000, places });
    await waitFor(() => expect(block("s_b")?.style.top).toBe(`${kept.s_b!.y}px`));
  });
});

describe("+ New session", () => {
  test("every step comes preselected, so Create at once starts the last used agent, model, effort and folder, and opens its tab", async () => {
    const h = mount({ playedTo: 1_000 });
    await waitFor(() => expect(block("s_a")).not.toBeNull());
    const before = h.core.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "＋ New session" }));
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
    fireEvent.click(create);
    expect(h.core.calls.filter((c) => c.method === "agent.start")).toEqual([]);
    press(create);
    expect(h.core.calls.filter((c) => c.method === "agent.start")).toEqual([{ method: "agent.start", params: { backend: "claude-code", root: "pick-1", model: "anthropic/claude-opus-5-5", effort: "high" } }]);
    await waitFor(() => expect(h.routes).toEqual([{ route: "agent", params: { session: "s_new" } }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("another agent: its own default model; one unknown until started sends no model; another folder comes from the dialog", async () => {
    const h = mount({ playedTo: 1_000 });
    fireEvent.click(await screen.findByRole("button", { name: "＋ New session" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "＋ New session" }));
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

describe("none and many", () => {
  test("an empty canvas says what to do", async () => {
    mount({ scene: [] });
    await waitFor(() => expect(screen.getByText("No sessions yet")).toBeDefined());
    expect(screen.getByText(/Press ＋ New session to start one/)).toBeDefined();
  });

  test("a long title is cut with the whole title on hover", async () => {
    const T0 = 1_781_270_000_000;
    const long = "Clean up the old migrations and every file that still names the previous app after the rename, then run the upgrade rows";
    mount({ scene: [{ at: 0, event: { type: "session_changed", ts: T0, session: { id: "s_l", kind: "coding", computer: "Studio", status: "idle", startedAt: T0, updatedAt: T0, title: long, backend: "codex", startedBy: { kind: "user" } } } }], playedTo: 0 });
    await waitFor(() => expect(block("s_l")).not.toBeNull());
    expect(block("s_l")!.querySelector(".cv-title")!.getAttribute("title")).toBe(long);
  });
});
