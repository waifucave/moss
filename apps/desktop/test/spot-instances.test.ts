// A part that draws one spot more than once (a message's add-on under each message of a transcript): each `<Spot>` instance
// is its own place (spec §14.2 item 77: one frame for each place a part appears). Its entries get their own mounts, each with
// its own single-use address, props, size, sleep and wake, and they go when that instance lets them go. The runtime's side:
// `resolve`'s `instance` hint, the place keys, what one instance's resolve may drop, the cap on a part's children, and a
// generated sequence of every kind of caller and operation holding the invariants.
import { describe, expect, test } from "bun:test";
import type { LayerMessage, SpotItem } from "@waifucave/moss-plugin-sdk/ui/bridge";
import { readUiEntry, readUiPlugins, type UiPlugin } from "../src/main/ui/model";
import { MAX_PART_CHILDREN, UiRuntime, isInstanceId, type FrameRef } from "../src/main/ui/runtime";
import { alphaView, mossViews } from "./fake-core/registry";

const WIN = 1;
let pid = 5000;
const frameAt = (url: string, parent: FrameRef | null = null): FrameRef => ({ processId: ++pid, routingId: ++pid, url, osPid: pid, parent });

/** A third-party plugin with entries, each `[spot, key?]`, drawn in its own layer (a frame), holding the reads a code session's spots ask. */
function filler(id: string, entries: [string, string | undefined][], layer = id): UiPlugin {
  return {
    id, topId: id, layer, treeHash: "0".repeat(64), assetBase: `/plugins/${id}`, css: [], source: "installed", enabledAt: 1000, capabilities: new Set(["sessions.read"]),
    bots: "all", isBot: false, themes: [], locales: [], dataFiles: [],
    entries: entries.map(([spot, key], i) => readUiEntry(id, { spot, component: "Extra", id: `e${i}`, ...(key !== undefined ? { key } : {}) })!),
  } as UiPlugin;
}

function setup(extra: UiPlugin[], opts: { maxPartChildren?: number; log?: (line: string) => void; now?: () => number } = {}) {
  const sent: { to: string; m: LayerMessage }[] = [];
  let n = 0;
  const rt = new UiRuntime({
    os: "macos", platform: "darwin", token: () => `t${++n}`, ...(opts.maxPartChildren !== undefined ? { maxPartChildren: opts.maxPartChildren } : {}),
    ...(opts.log ? { log: opts.log } : {}), ...(opts.now ? { now: opts.now } : {}),
    send: (f, m) => sent.push({ to: `${f.processId}:${f.routingId}`, m }),
  });
  rt.setRegistry([...readUiPlugins([...mossViews(), alphaView()] as never), ...extra]);
  rt.openWindow(WIN, { material: "vibrancy" });
  const rootFrame = frameAt("moss-core://app/");
  const root = rt.describe(rootFrame, WIN, undefined);
  // The shell's document, and the conversation part the session's tab places in it (an inline part of the shell's layer).
  const shellItem = rt.resolve(rootFrame, root.mount, "app.root").items[0]!;
  if (shellItem.kind !== "frame") throw new Error("the shell is not a frame");
  const token = new URL(shellItem.url).searchParams.get("mount")!;
  rt.serveDocument("moss", token);
  const shell = frameAt(shellItem.url, rootFrame);
  const info = rt.describe(shell, WIN, token);
  const tab = rt.resolve(shell, info.mount, "main", "agent").items[0]!;
  const conv = rt.resolve(shell, tab.mount, "conversation").items[0]!;
  return { rt, sent, shell, conv: conv.mount, sidebarPart: info.mount };
}

type FrameItem = Extract<SpotItem, { kind: "frame" }>;
const frames = (items: readonly SpotItem[]) => items.filter((i): i is FrameItem => i.kind === "frame");
const tokenOf = (url: string) => new URL(url).searchParams.get("mount")!;
const SESSION = { session: "coding" };

describe("an instance of a spot is its own place", () => {
  const extra = filler("acc-extra", [["conversation.message.extra", undefined]]);

  test("two instances of one spot and key get two mounts with two single-use addresses, each served once", () => {
    const s = setup([extra]);
    const a = frames(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance: "a1" }).items);
    const b = frames(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance: "b1" }).items);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.mount).not.toBe(b[0]!.mount);
    expect(a[0]!.url).not.toBe(b[0]!.url);
    // Each address loads once: the first load of each is served; a second load of either is refused.
    expect(s.rt.serveDocument("acc-extra", tokenOf(a[0]!.url))).toBeDefined();
    expect(s.rt.serveDocument("acc-extra", tokenOf(b[0]!.url))).toBeDefined();
    expect(s.rt.serveDocument("acc-extra", tokenOf(a[0]!.url))).toBeUndefined();
  });

  test("an instance asking again keeps its mount (same address, no reload); a sibling's mount is never touched by it", () => {
    const s = setup([extra]);
    const ask = (instance: string) => frames(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance }).items)[0]!;
    const a = ask("a1");
    const b = ask("b1");
    for (let i = 0; i < 3; i++) {
      expect(ask("a1")).toEqual(a);
      expect(ask("b1")).toEqual(b);
    }
  });

  test("props are each mount's own: new props for one reach its document alone", () => {
    const s = setup([extra]);
    const ask = (instance: string) => frames(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance }).items)[0]!;
    const a = ask("a1");
    const b = ask("b1");
    const docs = [a, b].map((it) => {
      const token = tokenOf(it.url);
      s.rt.serveDocument("acc-extra", token);
      const f = frameAt(it.url, s.shell);
      s.rt.describe(f, WIN, token);
      return f;
    });
    s.sent.length = 0;
    s.rt.setProps(s.shell, a.mount, { item: "first" });
    s.rt.setProps(s.shell, b.mount, { item: "second" });
    const to = (f: FrameRef) => `${f.processId}:${f.routingId}`;
    expect(s.sent.filter((x) => x.to === to(docs[0]!)).map((x) => (x.m as { props: unknown }).props)).toEqual([{ item: "first" }]);
    expect(s.sent.filter((x) => x.to === to(docs[1]!)).map((x) => (x.m as { props: unknown }).props)).toEqual([{ item: "second" }]);
  });

  test("a resolve lets go only its own instance's places: one that stops showing its entry drops its mount, never a sibling's", () => {
    const s = setup([extra]);
    const ask = (instance: string, hints: object = SESSION) => s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...hints, instance });
    const a = frames(ask("a1").items)[0]!;
    const b = frames(ask("b1").items)[0]!;
    // The kind of session changes under `a1` alone (a bot's session: this plugin reads code sessions only): its mount goes.
    expect(ask("a1", { session: "bot" }).items).toEqual([]);
    expect(() => s.rt.setProps(s.shell, a.mount, {})).toThrow();
    expect(() => s.rt.setProps(s.shell, b.mount, {})).not.toThrow();
    expect(frames(ask("b1").items)[0]!.mount).toBe(b.mount);
  });

  test("release names mounts: one instance's release drops its mount and no other", () => {
    const s = setup([extra]);
    const ask = (instance: string) => frames(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance }).items)[0]!;
    const [a, b, c] = [ask("a1"), ask("b1"), ask("c1")];
    s.rt.release(s.shell, [b!.mount]);
    expect(() => s.rt.setProps(s.shell, b!.mount, {})).toThrow();
    for (const keep of [a!, c!]) expect(() => s.rt.setProps(s.shell, keep.mount, {})).not.toThrow();
    // Asking again after a release places it anew (a new mount and address).
    const again = ask("b1");
    expect(again.mount).not.toBe(b!.mount);
    expect(again.url).not.toBe(b!.url);
  });

  test("each mount sleeps and wakes on its own: one asleep leaves the others' documents", () => {
    const s = setup([extra]);
    const ask = (instance: string) => frames(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance }).items)[0]!;
    const a = ask("a1");
    const b = ask("b1");
    const docs = [a, b].map((it) => {
      const token = tokenOf(it.url);
      s.rt.serveDocument("acc-extra", token);
      const f = frameAt(it.url, s.shell);
      s.rt.describe(f, WIN, token);
      return f;
    });
    expect(s.rt.sleep(s.shell, a.mount)).toBe(true);
    expect(() => s.rt.reportSize(docs[0]!, 10)).toThrow();
    expect(() => s.rt.reportSize(docs[1]!, 10)).not.toThrow();
    expect(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance: "a1" }).items[0]).toMatchObject({ asleep: true, url: "" });
    expect(frames(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance: "b1" }).items)[0]).toMatchObject({ url: b.url });
    const woken = s.rt.wake(s.shell, a.mount)!;
    expect(tokenOf(woken)).not.toBe(tokenOf(a.url));
    expect(tokenOf(woken)).not.toBe(tokenOf(b.url));
  });

  test("a frame loading a spent address is refused and the parent is sent a fresh one for that mount alone (a reload, a wake, a plugin updated while its frames show)", () => {
    const s = setup([extra]);
    const ask = (instance: string) => frames(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance }).items)[0]!;
    const a = ask("a1");
    const b = ask("b1");
    for (const it of [a, b]) {
      const token = tokenOf(it.url);
      s.rt.serveDocument("acc-extra", token);
      s.rt.describe(frameAt(it.url, s.shell), WIN, token);
    }
    // a's frame loads its spent address again (a document that reloaded itself): refused, and only a's parent hears of a new address for a.
    s.sent.length = 0;
    expect(s.rt.serveDocument("acc-extra", tokenOf(a.url))).toBeUndefined();
    const reloads = s.sent.filter((x) => x.m.type === "child-reload").map((x) => x.m as { child: string; url: string });
    expect(reloads.map((r) => r.child)).toEqual([a.mount]);
    expect(tokenOf(reloads[0]!.url)).not.toBe(tokenOf(a.url));
    // The plugin's client changes while both show: each loads again with its own new address.
    s.sent.length = 0;
    const built = (n: number) => ({ ...extra, clientBuild: { base: "/x", file: "index.js", sha256: n.toString(16).repeat(64).slice(0, 64) } }) as UiPlugin;
    const base = [...readUiPlugins([...mossViews(), alphaView()] as never)];
    s.rt.setRegistry([...base, built(1)]);
    const changed = s.sent.filter((x) => x.m.type === "child-reload").map((x) => x.m as { child: string; url: string });
    expect(changed.map((r) => r.child).sort()).toEqual([b.mount].sort());
    // (a's address was already replaced and unspent when the client changed: it takes the plugin as it is, with no second reload.)
    expect(new Set(changed.map((r) => tokenOf(r.url))).size).toBe(changed.length);
  });

  test("a caller that sends no instance keeps today's shared place, and never touches an instance's mounts (nor they its)", () => {
    const s = setup([extra]);
    const legacy = () => frames(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, SESSION).items)[0]!;
    const inst = (instance: string, hints: object = SESSION) => s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...hints, instance });
    const l = legacy();
    const a = frames(inst("a1").items)[0]!;
    expect(l.mount).not.toBe(a.mount);
    expect(legacy().mount).toBe(l.mount);
    // The legacy caller's place goes when it stops showing; the instance's stays.
    expect(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { session: "bot" }).items).toEqual([]);
    expect(() => s.rt.setProps(s.shell, l.mount, {})).toThrow();
    expect(() => s.rt.setProps(s.shell, a.mount, {})).not.toThrow();
    // And an instance's resolve that drops its place leaves the legacy caller's.
    const l2 = legacy();
    expect(inst("a1", { session: "bot" }).items).toEqual([]);
    expect(() => s.rt.setProps(s.shell, l2.mount, {})).not.toThrow();
  });

  test("an instance id is a page's word: 1 to 64 of A-Z a-z 0-9 _ -, and a bad one is refused, never answered as no instance", () => {
    const s = setup([extra]);
    for (const bad of ["", "x".repeat(65), "a|b", "a\"b", "a b", "../x", "a,b", "é", "a\u0000", 7, null, {}]) {
      expect(isInstanceId(bad)).toBe(false);
      expect(() => s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance: bad as never })).toThrow("bad request");
    }
    for (const ok of ["a", "A-z_9", "x".repeat(64), "s0123456789abcdef01234567"]) expect(isInstanceId(ok)).toBe(true);
  });

  test("an instance can name nothing but its own places under the part the document placed: not another part's, not another document's", () => {
    const s = setup([extra]);
    const a = frames(s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance: "a1" }).items)[0]!;
    // The same instance id under another part (the sidebar's) is another place set: nothing is shared, and the spot isn't declared there.
    expect(s.rt.resolve(s.shell, s.sidebarPart, "conversation.message.extra", undefined, { ...SESSION, instance: "a1" })).toMatchObject({ items: [], undeclared: true });
    expect(() => s.rt.setProps(s.shell, a.mount, {})).not.toThrow();
    // Another document (the root's) can't resolve under the conversation part, nor release its mounts.
    const otherRoot = frameAt("moss-core://app/");
    expect(() => s.rt.resolve(otherRoot, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance: "a1" })).toThrow();
    s.rt.release(otherRoot, [a.mount]);
    expect(() => s.rt.setProps(s.shell, a.mount, {})).not.toThrow();
  });
});

describe("inline entries: one mount for each instance", () => {
  test("N instances of one inline entry each get a mount of their own (before, all N shared one, and one's release took the rest's)", () => {
    const s = setup([]);
    const ask = (instance?: string) => s.rt.resolve(s.shell, s.sidebarPart, "sidebar", undefined, instance === undefined ? {} : { instance }).items[0]!;
    // Before instances (and still for a caller that sends none): the same mount for every drawing.
    expect(new Set([ask(), ask(), ask()].map((i) => i.mount)).size).toBe(1);
    const mounts = ["i1", "i2", "i3", "i4"].map((i) => ask(i).mount);
    expect(new Set(mounts).size).toBe(4);
    s.rt.release(s.shell, [mounts[1]!]);
    for (const keep of [mounts[0]!, mounts[2]!, mounts[3]!]) expect(() => s.rt.setProps(s.shell, keep, {})).not.toThrow();
    expect(() => s.rt.setProps(s.shell, mounts[1]!, {})).toThrow();
  });
});

describe("`<Spot entry>`: the runner-up case keeps working, and its instances hold their own", () => {
  const extra = filler("acc-extra", [["conversation.message.extra", undefined]]);
  const entryRef = "acc-extra#e0";

  test("with an instance, the entry is placed for that instance only; another instance of the same entry holds its own", () => {
    const s = setup([extra]);
    const ask = (instance: string | undefined, hints: object = {}) => s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, entry: entryRef, ...hints, ...(instance !== undefined ? { instance } : {}) });
    const a = frames(ask("a1").items)[0]!;
    const b = frames(ask("b1").items)[0]!;
    expect(a.mount).not.toBe(b.mount);
    expect(ask("a1" as string, { session: "bot" }).items).toEqual([]);
    expect(() => s.rt.setProps(s.shell, a.mount, {})).toThrow();
    expect(() => s.rt.setProps(s.shell, b.mount, {})).not.toThrow();
  });

  test("with no instance (an older client), the entry's place is shared per entry as before, and held by its own entry alone", () => {
    const s = setup([extra]);
    const ask = (hints: object) => s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, ...hints });
    const one = frames(ask({ entry: entryRef }).items)[0]!;
    expect(frames(ask({ entry: entryRef }).items)[0]!.mount).toBe(one.mount);
    // Another entry's `<Spot entry>` (one that isn't shown) lets go of nothing of this one's.
    expect(ask({ entry: "nobody#x" }).items).toEqual([]);
    expect(() => s.rt.setProps(s.shell, one.mount, {})).not.toThrow();
  });
});

describe("the cap on a part's children", () => {
  const extra = filler("acc-extra", [["conversation.message.extra", undefined]]);

  test("a part at the cap places no more: the instance gets no items (its fallback), the log says so once, the others keep theirs", () => {
    const log: string[] = [];
    let now = 1_000;
    const s = setup([extra], { maxPartChildren: 5, log: (l) => log.push(l), now: () => now });
    const base = (s.rt as unknown as { mounts: Map<string, { children: Map<string, string> }> }).mounts.get(s.conv)!.children.size;
    const room = 5 - base;
    const ask = (i: number) => s.rt.resolve(s.shell, s.conv, "conversation.message.extra", undefined, { ...SESSION, instance: `i${i}` });
    const placed = Array.from({ length: room }, (_, i) => frames(ask(i).items)[0]!);
    expect(placed.every((p) => p !== undefined)).toBe(true);
    const refused = ask(room);
    expect(refused).toMatchObject({ items: [], hidden: false });
    expect((refused as { undeclared?: boolean }).undeclared).toBeUndefined();
    ask(room + 1);
    ask(room);
    expect(log.filter((l) => l.includes("the most it may"))).toHaveLength(1);
    expect(log.find((l) => l.includes("the most it may"))).toContain("conversation.message.extra");
    // The ones placed keep their mounts, and ask again as often as they like.
    for (let i = 0; i < room; i++) expect(frames(ask(i).items)[0]!.mount).toBe(placed[i]!.mount);
    // A release makes room: the refused instance's next resolve (at its next respot) is placed.
    s.rt.release(s.shell, [placed[0]!.mount]);
    expect(frames(ask(room).items)).toHaveLength(1);
    // Said again after a minute.
    now += 61_000;
    ask(room + 5);
    expect(log.filter((l) => l.includes("the most it may"))).toHaveLength(2);
  });

  test("the cap is large: a transcript of a thousand messages, each with its add-on, a tool result and a kind's view, is nowhere near it", () => {
    expect(MAX_PART_CHILDREN).toBeGreaterThanOrEqual(4096);
    expect(MAX_PART_CHILDREN).toBeGreaterThan(1000 * 3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A generated sequence of callers and operations. A seeded generator (no dependency): a failure prints its seed and the
// operations so far, to replay.
// ---------------------------------------------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the invariants over generated sequences", () => {
  // Two plugins in two layers fill the conversation's spots: one an unkeyed list, one a keyed spot with two keys.
  const plugins = () => [
    filler("acc-extra", [["conversation.message.extra", undefined], ["tool.result", "ToolA"]]),
    filler("acc-views", [["conversation.message", "user"], ["tool.result", "ToolB"]]),
  ];
  const CELLS: { spot: string; key?: string }[] = [
    { spot: "conversation.message.extra" }, { spot: "conversation.message", key: "user" }, { spot: "tool.result", key: "ToolA" }, { spot: "tool.result", key: "ToolB" },
  ];
  const INSTANCES = ["a1", "a2", "a3", "a4", "a5", undefined as string | undefined]; // undefined: the callers that send none (they share places)

  for (const seed of [1, 2, 3, 7, 11, 2026]) {
    test(`seed ${seed}: no two live frames hold one address, a release or resolve never drops another instance's mount, an address is served once, the cap holds`, () => {
      const CAP = 9;
      let clock = 1_000;
      const s = setup(plugins(), { maxPartChildren: CAP, now: () => clock });
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      const mounts = (s.rt as unknown as { mounts: Map<string, { children: Map<string, string> }> }).mounts;
      const base = mounts.get(s.conv)!.children.size;
      // What the model believes: for each (instance, cell), the mounts last answered and still held, with their address.
      type Held = { mount: string; layer: string; url: string; asleep: boolean; served: boolean; frame?: FrameRef };
      const held = new Map<string, Map<string, Held>>(); // `${instance}|${cell}` -> mount -> Held
      const cellId = (instance: string | undefined, c: { spot: string; key?: string }) => `${instance ?? "-"}|${c.spot}|${c.key ?? ""}`;
      const log: string[] = [];
      const fail = (what: string): never => { throw new Error(`seed ${seed}: ${what}\n  ops: ${log.join("\n       ")}`); };
      const all = () => [...held.values()].flatMap((m) => [...m.values()]);

      const check = (after: string) => {
        // Every mount the model holds is live in the runtime, and its address is its own.
        const urls = new Map<string, string>();
        for (const h of all()) {
          if (!mounts.has(h.mount)) fail(`${after}: ${h.mount} was dropped though no release, resolve or reload of its own named it`);
          if (!h.asleep) {
            const t = tokenOf(h.url);
            const other = urls.get(t);
            if (other !== undefined && other !== h.mount) fail(`${after}: ${h.mount} and ${other} hold one address (${t})`);
            urls.set(t, h.mount);
          }
        }
        if (mounts.get(s.conv)!.children.size > CAP) fail(`${after}: the part holds ${mounts.get(s.conv)!.children.size} children, over the cap ${CAP}`);
        if (new Set(all().map((h) => h.mount)).size !== all().length) fail(`${after}: two cells hold one mount`);
      };

      for (let step = 0; step < 400; step++) {
        const op = pick(["resolve", "resolve", "resolve", "resolve", "release", "sleep", "wake", "load", "serve-spent", "reload", "registry", "unshow"] as const);
        const instance = pick(INSTANCES);
        const cell = pick(CELLS);
        const id = cellId(instance, cell);
        const cellHeld = held.get(id) ?? new Map<string, Held>();
        if (op === "resolve" || op === "unshow") {
          const hints = { session: op === "unshow" ? "bot" : "coding", ...(instance !== undefined ? { instance } : {}) };
          log.push(`${op} ${id}`);
          const view = s.rt.resolve(s.shell, s.conv, cell.spot, cell.key, hints);
          const answered = new Map<string, Held>();
          for (const it of frames(view.items)) {
            const before = cellHeld.get(it.mount);
            if (it.asleep !== true && before !== undefined && !before.asleep && before.url !== it.url) fail(`${id}: ${it.mount} changed its address with no reload (${before.url} to ${it.url})`);
            answered.set(it.mount, { mount: it.mount, layer: it.layer, url: it.url, asleep: it.asleep === true, served: before?.served ?? false, ...(before?.frame !== undefined ? { frame: before.frame } : {}) });
          }
          // What it held before and no longer shows is gone (dropped by this resolve); what it still shows is the same mount.
          for (const [m, h] of cellHeld) if (!answered.has(m)) { if (mounts.has(m)) fail(`${id}: ${m} stopped showing but was not dropped`); void h; }
          held.set(id, answered);
        } else if (op === "release") {
          const hs = [...cellHeld.values()];
          if (hs.length === 0) continue;
          const one = pick(hs);
          log.push(`release ${id} ${one.mount}`);
          s.rt.release(s.shell, [one.mount]);
          cellHeld.delete(one.mount);
          held.set(id, cellHeld);
          if (mounts.has(one.mount)) fail(`${id}: ${one.mount} survived its release`);
        } else if (op === "sleep" || op === "wake" || op === "reload") {
          const hs = [...cellHeld.values()];
          if (hs.length === 0) continue;
          const one = pick(hs);
          log.push(`${op} ${id} ${one.mount}`);
          if (op === "sleep") {
            s.rt.sleep(s.shell, one.mount);
            one.asleep = true;
            one.url = "";
            one.served = false;
            delete one.frame;
          } else {
            // A wake of an awake frame is a reload of it: either way a new address, the old one spent.
            const url = (op === "wake" ? s.rt.wake(s.shell, one.mount) : s.rt.reload(s.shell, one.mount))!;
            one.asleep = false;
            one.url = url;
            one.served = false;
            delete one.frame;
          }
        } else if (op === "load") {
          const hs = [...cellHeld.values()].filter((h) => !h.asleep && !h.served);
          if (hs.length === 0) continue;
          const one = pick(hs);
          log.push(`load ${id} ${one.mount}`);
          const token = tokenOf(one.url);
          if (s.rt.serveDocument(one.layer, token) === undefined) fail(`${id}: ${one.mount}'s first load of ${token} was refused`);
          one.served = true;
          one.frame = frameAt(one.url, s.shell);
          s.rt.describe(one.frame, WIN, token);
        } else if (op === "serve-spent") {
          // A frame that loads an address it spent (a document reloaded by itself): the load is refused and its parent is sent a new
          // address for that mount alone (once a second for each mount, so the clock moves on first).
          const hs = [...cellHeld.values()].filter((h) => !h.asleep && h.served);
          if (hs.length === 0) continue;
          const one = pick(hs);
          log.push(`serve-spent ${id} ${one.mount}`);
          clock += 2_000;
          s.sent.length = 0;
          if (s.rt.serveDocument(one.layer, tokenOf(one.url)) !== undefined) fail(`${id}: ${one.mount}'s spent address was served again`);
          const told = s.sent.filter((x) => x.m.type === "child-reload").map((x) => x.m as { child: string; url: string });
          if (told.length !== 1 || told[0]!.child !== one.mount) fail(`${id}: a spent load of ${one.mount} told ${JSON.stringify(told.map((t) => t.child))} of a new address`);
          one.url = told[0]!.url;
          one.served = false;
          delete one.frame;
        } else if (op === "registry") {
          log.push("registry");
          s.rt.setRegistry([...readUiPlugins([...mossViews(), alphaView()] as never), ...plugins()]);
          // A registry that hands back the same plugins changes no frame's address.
        }
        // Only what a reload/wake did on its own mount changes an address; any other op leaves every other cell's mounts as they were.
        check(`after ${log.at(-1) ?? "start"}`);
      }
      // The runtime holds no more children of the part than the model's, plus the part's own (`base`) and any a refused resolve never made.
      expect(mounts.get(s.conv)!.children.size).toBeLessThanOrEqual(CAP);
      expect(base).toBeLessThanOrEqual(CAP);
    });
  }
});
