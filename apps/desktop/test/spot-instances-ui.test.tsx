// The SDK's `<Spot>` against the real runtime (no Electron): a part that draws one spot once for each message of a transcript.
// Each instance mints its own id, so each gets its own mount and its own frame; it lets them go when it unmounts, and an
// answer that lands after it unmounted is let go too; a frame placed away from the screen holds no document until it comes near.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { LayerBridge, LayerMessage, MountInfo, SpotView } from "@waifucave/moss-plugin-sdk/ui/bridge";
import { readUiEntry, readUiPlugins, type UiPlugin } from "../src/main/ui/model";
import { UiRuntime, type FrameRef } from "../src/main/ui/runtime";
import { alphaView, mossViews } from "./fake-core/registry";

// Frames never load here: their documents are the main process's.
GlobalRegistrator.register({ settings: { navigation: { disableChildFrameNavigation: true } } });
process.env.RTL_SKIP_AUTO_CLEANUP = "true";
const { act, cleanup, render } = await import("@testing-library/react");
const ui = await import("@waifucave/moss-plugin-sdk/ui");
const { createElement: h, useSyncExternalStore } = await import("react");

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

// IntersectionObserver as the frames see it: it answers once for each element observed, from the test's own say on where each is.
let isNear: (el: Element) => boolean = () => true;
const observed = new Set<{ cb: (e: { isIntersecting: boolean }[]) => void; el: Element }>();
let answers = true;
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  private seen = new Set<{ cb: (e: { isIntersecting: boolean }[]) => void; el: Element }>();
  constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
  observe(el: Element) {
    const o = { cb: this.cb, el };
    this.seen.add(o);
    observed.add(o);
    if (answers) queueMicrotask(() => { if (this.seen.has(o)) this.cb([{ isIntersecting: isNear(el) }]); });
  }
  disconnect() {
    for (const o of this.seen) observed.delete(o);
    this.seen.clear();
  }
};
const scrollTo = () => { for (const o of observed) o.cb([{ isIntersecting: isNear(o.el) }]); };

let pid = 9000;
const frameAt = (url: string, parent: FrameRef | null = null): FrameRef => ({ processId: ++pid, routingId: ++pid, url, osPid: pid, parent });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
/** Waits (in act, so the layer draws) until `done` holds, at most `ms`. */
const until = async (done: () => boolean, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end && !done(); ) await wait(10); };

const extra = {
  id: "acc-extra", topId: "acc-extra", layer: "acc-extra", treeHash: "0".repeat(64), assetBase: "/plugins/acc-extra", css: [], source: "installed", enabledAt: 1000, capabilities: new Set(["sessions.read"]),
  bots: "all", isBot: false, themes: [], locales: [], dataFiles: [], entries: [readUiEntry("acc-extra", { spot: "conversation.message.extra", component: "Extra" })!],
} as UiPlugin;

/** The runtime with the conversation part placed, and a bridge that is the real runtime's door for that document. */
function world(delay?: { resolve?: () => Promise<void> }) {
  const listeners = new Set<(m: LayerMessage) => void>();
  let shellProcess = -1;
  let n = 0;
  // What the runtime tells the shell's document reaches the layer's listeners (the other documents are not drawn here).
  const rt = new UiRuntime({ os: "macos", platform: "darwin", token: () => `t${++n}`, send: (f, m) => { if (f.processId === shellProcess) for (const l of listeners) l(m); } });
  rt.setRegistry([...readUiPlugins([...mossViews(), alphaView()] as never), extra]);
  rt.openWindow(1, { material: "vibrancy" });
  const rootFrame = frameAt("moss-core://app/");
  const root = rt.describe(rootFrame, 1, undefined);
  const shellItem = rt.resolve(rootFrame, root.mount, "app.root").items[0]!;
  if (shellItem.kind !== "frame") throw new Error("the shell is not a frame");
  const token = new URL(shellItem.url).searchParams.get("mount")!;
  rt.serveDocument("moss", token);
  const shell = frameAt(shellItem.url, rootFrame);
  shellProcess = shell.processId;
  const info = rt.describe(shell, 1, token);
  const tab = rt.resolve(shell, info.mount, "main", "agent").items[0]!;
  const conv = rt.resolve(shell, tab.mount, "conversation").items[0]!;
  const calls: { op: string; args: unknown[] }[] = [];
  const none = () => { throw new Error("not in this test"); };
  const bridge = {
    token: "t",
    describe: async () => ({}) as MountInfo,
    resolve: async (mount: string, spot: string, key?: string, hints?: object) => {
      calls.push({ op: "resolve", args: [mount, spot, key, hints] });
      const view = rt.resolve(shell, mount, spot, key, hints);
      if (delay?.resolve !== undefined) await delay.resolve();
      return view as SpotView;
    },
    setProps: (child: string, props: unknown) => { calls.push({ op: "setProps", args: [child] }); rt.setProps(shell, child, props); },
    release: (mounts: readonly string[]) => { calls.push({ op: "release", args: [mounts] }); rt.release(shell, mounts); },
    sleep: (child: string) => { calls.push({ op: "sleep", args: [child] }); rt.sleep(shell, child); },
    wake: async (child: string) => { calls.push({ op: "wake", args: [child] }); return rt.wake(shell, child); },
    reload: async (child: string) => rt.reload(shell, child),
    onMessage: (l: (m: LayerMessage) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    callback: () => undefined, reportSize: () => undefined, entries: async () => [], rectReply: () => undefined,
    shell: none, shellReport: none, menu: none, surface: none, surfaceEnvironment: async () => undefined, open: none,
    viewFrame: none, webFrame: none, activeSession: none, windowDrag: none, composer: none,
  } as unknown as LayerBridge;
  const mounts = (rt as unknown as { mounts: Map<string, { kind: string; plugin?: { id: string }; tokenState?: string; props: unknown; parent?: string }> }).mounts;
  const mine = () => [...mounts.entries()].filter(([, m]) => m.plugin?.id === "acc-extra" && m.parent === conv.mount);
  const info2: MountInfo = { mount: conv.mount, pluginId: "moss/conversation", entryId: "conversation", component: "Transcript", spot: "conversation", props: {}, tokens: {}, context: { os: "macos", material: "vibrancy", safeMode: false, window: { narrow: false } }, css: [] };
  return { rt, calls, bridge, mine, info: info2, conv: conv.mount };
}

/** The messages the transcript draws, changed by the test. */
const store = { ids: [] as readonly string[], listeners: new Set<() => void>() };
const subscribe = (l: () => void) => { store.listeners.add(l); return () => { store.listeners.delete(l); }; };

function Transcript() {
  const ids = useSyncExternalStore(subscribe, () => store.ids);
  return h("div", null, ids.map((id) => h("section", { key: id, "data-message": id }, h(ui.Spot, { name: "conversation.message.extra", props: { item: { id } } }))));
}

function mountTranscript(w: ReturnType<typeof world>, ids: string[], sleepAfterMs = 20) {
  store.ids = ids;
  ui.configureLayer({ bridge: w.bridge, modules: { "moss/conversation": { Transcript } }, sleepAfterMs });
  const view = render(h(ui.SpotHints.Provider, { value: { session: "coding" } }, h(ui.LayerRoot, { info: w.info })));
  return {
    view,
    set: async (next: string[]) => { store.ids = next; await act(async () => { for (const l of store.listeners) l(); }); await wait(20); },
  };
}

const iframes = () => [...document.querySelectorAll('iframe[data-moss-entry^="acc-extra#"]')] as HTMLIFrameElement[];
const placeholders = () => [...document.querySelectorAll('[data-moss-entry^="acc-extra#"][data-moss-asleep]')];

beforeEach(() => {
  cleanup();
  isNear = () => true;
  answers = true;
  observed.clear();
});

describe("<Spot> instances against the real runtime", () => {
  test("a spot drawn once for each message: each gets a mount and a frame of its own, with its own address and its own props", async () => {
    const w = world();
    const ids = ["m1", "m2", "m3", "m4"];
    const t = mountTranscript(w, ids);
    await until(() => iframes().length === 4);
    expect(w.mine()).toHaveLength(4);
    expect(iframes()).toHaveLength(4);
    expect(new Set(iframes().map((f) => f.getAttribute("src"))).size).toBe(4);
    expect(new Set(iframes().map((f) => f.getAttribute("data-moss-mount"))).size).toBe(4);
    // Each frame's mount holds the props of the message it is under.
    const under = iframes().map((f) => [f.closest("[data-message]")!.getAttribute("data-message"), w.mine().find(([id]) => id === f.getAttribute("data-moss-mount"))![1].props as { item?: { id: string } }] as const);
    for (const [message, props] of under) expect(props.item?.id).toBe(message!);
    t.view.unmount();
  });

  test("a message that goes (its instance unmounts) lets its mount go and no other's; the others keep their frames and addresses", async () => {
    const w = world();
    const t = mountTranscript(w, ["m1", "m2", "m3"]);
    await until(() => iframes().length === 3);
    const before = iframes().map((f) => [f.closest("[data-message]")!.getAttribute("data-message"), f.getAttribute("src"), f.getAttribute("data-moss-mount")]);
    await t.set(["m1", "m3"]);
    expect(w.mine()).toHaveLength(2);
    const after = iframes().map((f) => [f.closest("[data-message]")!.getAttribute("data-message"), f.getAttribute("src"), f.getAttribute("data-moss-mount")]);
    expect(after).toEqual(before.filter((b) => b[0] !== "m2"));
    t.view.unmount();
    await until(() => w.mine().length === 0);
    expect(w.mine()).toHaveLength(0);
  });

  test("an answer that lands after its instance unmounted is let go (no mount nobody shows is left holding a place)", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const w = world({ resolve: () => gate });
    const t = mountTranscript(w, ["m1", "m2"]);
    await wait(10);
    expect(w.mine()).toHaveLength(2); // made by the runtime, the answers still on their way
    t.view.unmount();
    await wait(10);
    open();
    await until(() => w.mine().length === 0);
    expect(w.mine()).toHaveLength(0);
  });

  test("a frame placed away from the screen loads as ever and sleeps after a while, its address let go, and wakes with a fresh one when it comes near", async () => {
    const w = world();
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    // The first two are near; the rest are far.
    isNear = (el) => [...document.querySelectorAll("[data-message]")].findIndex((s) => s.contains(el)) < 2;
    const t = mountTranscript(w, ids);
    await until(() => w.mine().filter(([, m]) => m.tokenState === "asleep").length === 10);
    expect(w.mine()).toHaveLength(12);
    expect(iframes()).toHaveLength(2);
    expect(placeholders()).toHaveLength(10);
    // In the runtime: two frames with an address, ten asleep with none (each loaded as it was placed, as ever, then slept).
    const states = w.mine().map(([, m]) => m.tokenState);
    expect(states.filter((s) => s === "asleep")).toHaveLength(10);
    expect(states.filter((s) => s !== "asleep")).toHaveLength(2);
    // Scrolled: the next one comes near, wakes with a fresh single-use address, and loads.
    isNear = (el) => [...document.querySelectorAll("[data-message]")].findIndex((s) => s.contains(el)) < 3;
    await act(async () => scrollTo());
    await until(() => iframes().length === 3);
    expect(iframes()).toHaveLength(3);
    expect(w.calls.filter((c) => c.op === "wake")).toHaveLength(1);
    expect(new Set(iframes().map((f) => f.getAttribute("src"))).size).toBe(3);
    t.view.unmount();
  });

  test("three hundred messages, one add-on each, the reader at the end: 300 mounts, each loads as ever and the far ones sleep, ten documents settle", async () => {
    const w = world();
    const ids = Array.from({ length: 300 }, (_, i) => `m${i}`);
    isNear = (el) => [...document.querySelectorAll("[data-message]")].findIndex((s) => s.contains(el)) >= 290;
    // The most documents live at once (sampled on every turn of the loop while the transcript opens and settles).
    let peak = 0;
    const sampler = setInterval(() => { peak = Math.max(peak, iframes().length); }, 1);
    const t = mountTranscript(w, ids);
    await until(() => w.mine().filter(([, m]) => m.tokenState === "asleep").length === 290 && iframes().length === 10, 20000);
    clearInterval(sampler);
    const states = w.mine().map(([, m]) => m.tokenState);
    expect(states).toHaveLength(300);
    expect(states.filter((s) => s === "asleep")).toHaveLength(290);
    expect(iframes()).toHaveLength(10);
    // The idle part of the cost: nothing is asked of the runtime again while nothing changes.
    const before = w.calls.length;
    await wait(300);
    expect(w.calls.length).toBe(before);
    process.stdout.write(`300 messages: ${states.length} mounts, ${iframes().length} live frames, ${states.filter((s) => s === "asleep").length} asleep, ${w.calls.filter((c) => c.op === "resolve").length} resolves, ${w.calls.filter((c) => c.op === "sleep").length} sleeps, at most ${peak} documents at once\n`);
    t.view.unmount();
  });

  // A part that runs once as it appears (a sidebar badge's frame whose page says it is ready, an add-on that registers what it takes)
  // must run even where the first word says it is away: a frame is never held back from its first load, only slept after a while.
  test("a frame whose first word is that it is away still loads when it is placed, and sleeps only after its time", async () => {
    isNear = () => false;
    const w = world();
    const t = mountTranscript(w, ["m1", "m2"], 10_000);
    await until(() => iframes().length === 2);
    await wait(150);
    expect(iframes()).toHaveLength(2);
    expect(w.mine().every(([, m]) => m.tokenState !== "asleep")).toBe(true);
    expect(w.calls.filter((c) => c.op === "sleep")).toHaveLength(0);
    t.view.unmount();
  });

  test("where no observer exists, a frame loads at once, as it did", async () => {
    const saved = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    try {
      const w = world();
      const t = mountTranscript(w, ["m1", "m2"]);
      await until(() => iframes().length === 2);
      expect(iframes()).toHaveLength(2);
      expect(w.calls.filter((c) => c.op === "sleep")).toHaveLength(0);
      t.view.unmount();
    } finally {
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = saved;
    }
  });

  test("a document that never says where a frame is: it loads at once and stays", async () => {
    answers = false;
    const w = world();
    const t = mountTranscript(w, ["m1"]);
    await until(() => iframes().length === 1);
    await wait(100);
    expect(iframes()).toHaveLength(1);
    expect(w.calls.filter((c) => c.op === "sleep")).toHaveLength(0);
    t.view.unmount();
  });

  test("an old client's resolve (no instance) still shares one place per entry", async () => {
    const w = world();
    const a = w.bridge.resolve(w.conv, "conversation.message.extra", undefined, { session: "coding" });
    const b = w.bridge.resolve(w.conv, "conversation.message.extra", undefined, { session: "coding" });
    const [va, vb] = await Promise.all([a, b]);
    expect(va.items[0]!.mount).toBe(vb.items[0]!.mount);
  });
});
