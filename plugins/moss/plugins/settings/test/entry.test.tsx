// Settings on the runtime: MOSS's own settings from the core and the plugin API, every change through them.
import { computerView, deviceView, fakeApi, fakeCore, pluginDetail, pluginSummary, settle, runtimeWith, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { EntryComponent } from "../client/local";
import type { PluginDetail, PluginSummary } from "@waifucave/moss-plugin-sdk";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NOT_AVAILABLE_YET as PROTOCOL_REASON } from "@waifucave/moss-plugin-sdk";
import { NOT_AVAILABLE_YET, okWords, SettingsEntry } from "../client/entry";

/** A running plugin's UI as `plugin.ui` lists it: its themes and string tables, the rest left plain. */
const uiPluginView = (pluginId: string, themes: { id: string; file: string }[] = [], locales: { lang: string; file: string }[] = []) =>
  ({ pluginId, name: pluginId, treeHash: "sha256-test", layer: pluginId.split("/")[0]!, assetBase: `moss-asset://${pluginId}/`, ui: [] as Record<string, unknown>[], themes, locales, bots: "all" as const });


afterEach(cleanup);

const summary = (id: string, name: string, extra: Partial<PluginSummary> = {}): PluginSummary => pluginSummary(id, name, extra);
const PLUGINS = [
  summary("moss", "MOSS"),
  summary("weather-routine", "Weather routine", { state: "found", enabled: false, source: "index" }),
  summary("story-mode", "Story mode", { state: "stopped", reason: "Stopped after three crashes in two minutes", source: "local" }),
  // MOSS's own plugin this build can't run yet: the registry keeps its switch on, and it is off with the reason.
  summary("moss/forwarder", "waifucave forwarder", { state: "off", enabled: true, reason: NOT_AVAILABLE_YET }),
];
const detail = (p: PluginSummary, capabilities: string[], networkHosts: string[] = []): PluginDetail => pluginDetail(p, { capabilities, networkHosts });

let uiSetFails = false;
let setEnabledFails = false;
let setupFails = false;
let uiAppearance: "light" | "dark" | "system" | undefined;
let relayNow: { mode: "n0" | "off" | "custom"; url?: string } = { mode: "n0" };
let relaySetFails = false;

async function mount(params: { section?: string; item?: string } = {}, extra: { component?: EntryComponent; holdReads?: Promise<void>; seed?: Record<string, unknown> } = {}) {
  uiAppearance = undefined;
  relayNow = { mode: "n0" };
  relaySetFails = false;
  const core = fakeCore({
    "plugin.list": () => ({ plugins: PLUGINS }),
    "plugin.get": ({ id }) => ({ plugin: detail(PLUGINS.find((p) => p.id === id)!, id === "weather-routine" ? ["notify", "network:api.weather.example"] : ["conversation.read", "call:moss"], id === "weather-routine" ? ["api.weather.example"] : []) }),
    "plugin.setEnabled": () => { if (setEnabledFails) throw new Error("the plugin couldn't be switched"); return { applied: true }; },
    "plugin.logs": () => ({ lines: ["14:05 started", "14:06 TypeError: scene"] }),
    "plugin.ui": () => ({ plugins: [uiPluginView("moss/base-theme", [{ id: "base", file: "base.css" }], []), uiPluginView("midnight", [{ id: "night", file: "night.css" }], [{ lang: "de", file: "de.json" }])] }),
    "account.status": () => ({ signedIn: true, provider: "email", user: { id: "u1", name: "Sam" } }),
    "ui.settings": () => ({ picks: [], lists: [], language: "en-US", globalTheme: "midnight#night", ...(uiAppearance === undefined ? {} : { appearance: uiAppearance }) }),
    "ui.set": (p) => { if (uiSetFails) throw new Error("refused"); const a = (p as { patch?: { appearance?: "light" | "dark" | "system" } }).patch?.appearance; if (a) uiAppearance = a; return { applied: true }; },
    "computer.setLevel": () => ({ applied: false, card: "card-1" }),
    "device.revoke": () => ({ applied: false, card: "card-2" }),
    "main.set": () => ({ applied: false, card: "card-3" }),
    "device.pair.begin": () => ({ pairingId: "p1", code: "KQ7-M2P", qr: "clover-pair:1:abcdefghij", expiresAt: Date.now() + 9 * 60_000 }),
    // The engine and the door give a page no words; a result that carried them anyway is not drawn.
    "device.pair.join": () => ({ pairingId: "p2", words: ["amber", "river", "lantern", "moss"], expiresAt: 0 }),
    "device.pair.confirm": () => ({ applied: false, card: "card-4" }),
    "device.pair.cancel": () => ({ ok: true }),
    "device.relay.get": () => relayNow,
    "device.relay.set": (p) => { if (relaySetFails) throw new Error("refused"); relayNow = p as typeof relayNow; return relayNow; },
    "app.openSetup": () => { if (setupFails) throw new Error("refused"); return { opened: true }; },
    // The deletion lane: from a page each is the engine's card.
    "account.delete": () => ({ applied: false, card: "card-5" }),
    "home.erase": () => ({ applied: false, card: "card-6" }),
  });
  const api = fakeApi({
    ...(extra.seed ? { settings: extra.seed } : {}),
    computers: { list: async () => [computerView("Studio", { device: "d1", level: "ask-risky", link: "self", isMain: true }), computerView("Laptop", { device: "d2", level: "ask", link: "lan" })] },
    devices: { list: async () => [deviceView("d1", "Studio", { kind: "desktop", runsCore: true, isThis: true, isMain: true, keys: [{ program: "moss", words: ["cedar", "quill", "basin", "otter"] }] }), deviceView("d2", "Laptop", { kind: "desktop", runsCore: true }), deviceView("d3", "iPhone", { kind: "phone", runsCore: false })], watch: () => () => undefined },
    bots: { list: async () => [{ id: "alpha", name: "Alpha", model: "m", userLayer: [], state: "idle", mainSession: "s" }], get: async () => { throw new Error("x"); }, watch: () => () => undefined },
  });
  // A read the page asked for before a press and that is answered after it (a slow runner's first read): the value as it was asked.
  if (extra.holdReads) {
    const get = api.settings.get;
    api.settings.get = (async (...a: Parameters<typeof get>) => { const v = await get(...a); await extra.holdReads; return v; }) as typeof get;
  }
  const routes: unknown[] = [];
  let closed = 0;
  const runtime = runtimeWith({
    api: () => api,
    core: () => core,
    spot: (name) => (name === "settings.section" ? { shape: "list" } : undefined),
    entries: extra.component ? [{ pluginId: "tarot-panel", id: "settings", spot: "settings.section", component: "Section", fields: { title: "Tarot" }, source: "installed", enabledAt: 1 }] : [],
    component: () => extra.component,
  });
  const tree = (at: typeof params) => (
    <TestLayer runtime={runtime}>
      <SettingsEntry props={{ route: "settings", params: at, navigate: (r) => routes.push(r), close: () => closed++ }} />
    </TestLayer>
  );
  const { rerender } = render(tree(params));
  await act(() => settle());
  /** A place opens Settings again while it is open (lane E's `useOpen`). */
  const reopen = async (at: typeof params) => {
    rerender(tree(at));
    await act(() => settle());
  };
  return { core, api, routes, closed: () => closed, reopen };
}

describe("settings on the runtime", () => {
  test("a plugin's OKs read in plain words", () => {
    expect(okWords({ capabilities: ["conversation.read", "call:tarot", "network:x.example", "something.new"], networkHosts: ["x.example"] })).toEqual([
      "Reads your bots' conversations", "Runs tarot's commands", "something.new", "Reaches x.example",
    ]);
  });

  test("the plugins page: each plugin's state and reason from one plugin.list; the switch, details, the logs and the plugin index", async () => {
    const { core, routes } = await mount({ section: "plugins" });
    // Never a call per plugin: what each may do is the Plugins page's, for the one opened.
    expect(core.calls.filter((c) => c.method === "plugin.get")).toEqual([]);
    const weather = screen.getByText("Weather routine").closest(".cl-settings__row") as HTMLElement;
    expect(weather.textContent).toContain("Waits for your OK");
    fireEvent.click(within(weather).getByRole("button", { name: "Weather routine's details" }));
    expect(routes).toEqual([{ route: "plugins", params: { id: "weather-routine" } }]);
    routes.length = 0;
    expect(screen.getByText("Story mode").closest(".cl-settings__row")!.textContent).toContain("Stopped after three crashes in two minutes");
    fireEvent.click(within(weather).getByRole("switch"));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.setEnabled").map((c) => c.params)).toEqual([{ id: "weather-routine", enabled: true }]);
    // A plugin not available in this build yet: its reason, word for word the registry's, and nothing to switch, open
    // or read.
    expect(NOT_AVAILABLE_YET).toBe(PROTOCOL_REASON);
    const parked = screen.getByText("waifucave forwarder").closest(".cl-settings__row") as HTMLElement;
    expect(parked.textContent).toContain(NOT_AVAILABLE_YET);
    expect(within(parked).queryByRole("switch")).toBeNull();
    expect(within(parked).queryAllByRole("button")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Story mode's logs" }));
    await act(() => settle());
    expect(screen.getByText(/TypeError: scene/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Weather routine")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the plugin manager" }));
    expect(routes).toEqual([{ route: "plugins", params: {} }]);
  });

  test("a computer's level is not offered; Make main is, and opening the page calls neither", async () => {
    const lv = await mount({ section: "levels" });
    const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    expect(select.value).toBe("ask-risky");
    expect(select.disabled).toBe(true);
    cleanup();
    const dv = await mount({ section: "devices" });
    expect(screen.getByRole("button", { name: "Make Laptop the main computer" })).toBeTruthy();
    // The main one has no such button.
    expect(screen.queryByRole("button", { name: "Make Studio the main computer" })).toBeNull();
    for (const { core } of [lv, dv]) expect(core.calls.some((c) => /^(computer\.setLevel|main\.set)/.test(c.method))).toBe(false);
    // Opening the page starts nothing: no pairing, no removal, until the user presses a control.
    expect(dv.core.calls.some((c) => /^device\.(pair|revoke)/.test(c.method))).toBe(false);
  });

  test("Devices: Make main asks the engine (main.set for that computer), which comes back its sealed card; the page applies nothing", async () => {
    const { core } = await mount({ section: "devices" });
    fireEvent.click(screen.getByRole("button", { name: "Make Laptop the main computer" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "main.set").map((c) => c.params)).toEqual([{ device: "d2" }]);
    // Until the card is answered, Studio is still the main one.
    expect(screen.queryByRole("button", { name: "Make Studio the main computer" })).toBeNull();
  });

  test("appearance: the theme plugin through `ui.set`; light or dark only as the core's `appearance` (the one main applies), the text size as this plugin's setting; the language", async () => {
    const { core, api } = await mount({ section: "appearance" });
    const theme = screen.getByRole("combobox", { name: /theme/i }) as HTMLSelectElement;
    expect([...theme.options].map((o) => o.textContent)).toEqual(["Plain", "midnight"]);
    expect(theme.value).toBe("midnight#night");
    fireEvent.change(theme, { target: { value: "moss/base-theme#base" } });
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "ui.set").map((c) => c.params)).toEqual([{ patch: { globalTheme: "moss/base-theme#base" } }, { patch: { appearance: "dark" } }]);
    // One source: the core's `appearance`. The plugin keeps no copy of it.
    expect(api.stored.has("appearance.theme")).toBe(false);
    expect((screen.getByRole("radio", { name: "Dark" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("English (United States)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const chooser = screen.getByRole("dialog", { name: "Language" });
    fireEvent.click(within(chooser).getByRole("radio", { name: /Deutsch/ }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "ui.set").map((c) => c.params)).toContainEqual({ patch: { language: "de" } });
  });

  test("a change that isn't saved (refused: the shared budget spent) goes back to the stored value and says so beside it", async () => {
    const { api } = await mount({ section: "notifications" });
    const sw = () => screen.getByRole("switch", { name: /needs you/i });
    expect(sw().getAttribute("aria-checked")).toBe("true");
    const set = api.settings.set;
    api.settings.set = async () => { throw new Error("moss's pages changed its settings 30 times this minute; try again in a moment"); };
    fireEvent.click(sw());
    await act(() => settle());
    expect(sw().getAttribute("aria-checked")).toBe("true");
    const said = sw().parentElement!.querySelector("[role=alert]")!;
    expect(said.textContent).toContain("wasn't changed. Try again.");
    // Tried again and saved: the line goes, the switch shows the change.
    api.settings.set = set;
    fireEvent.click(sw());
    await act(() => settle());
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().parentElement!.querySelector("[role=alert]")).toBeNull();
    expect(api.stored.get("notifications.needsYou")).toBe(false);
  });

  test("a plugin's switch whose change fails stays as it was and says so beside it", async () => {
    await mount({ section: "plugins" });
    const sw = screen.getByRole("switch", { name: "Story mode" });
    const was = sw.getAttribute("aria-checked");
    setEnabledFails = true;
    try {
      fireEvent.click(sw);
      await act(() => settle());
      expect(screen.getByRole("switch", { name: "Story mode" }).getAttribute("aria-checked")).toBe(was);
      expect(screen.getByRole("switch", { name: "Story mode" }).parentElement!.querySelector("[role=alert]")!.textContent).toContain("Story mode wasn't changed");
    } finally {
      setEnabledFails = false;
    }
  });

  test("a press made while the page's first read of its settings is still on its way is kept when that read is answered (window row 13: the switch went back to true though the daemon held false)", async () => {
    let answer!: () => void;
    const { api } = await mount({ section: "notifications" }, { holdReads: new Promise<void>((r) => { answer = r; }), seed: { "notifications.needsYou": true } });
    const sw = () => screen.getByRole("switch", { name: /needs you/i });
    expect(sw().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw());
    await act(() => settle());
    expect(sw().getAttribute("aria-checked")).toBe("false");
    // The read, asked before the press, is answered now with the value it saw.
    await act(async () => { answer(); await settle(); });
    expect(api.stored.get("notifications.needsYou")).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  test("while a change is being saved its control takes no second press", async () => {
    const { api } = await mount({ section: "notifications" });
    let release!: () => void;
    let writes = 0;
    api.settings.set = () => { writes++; return new Promise<void>((r) => { release = r; }); };
    const sw = () => screen.getByRole("switch", { name: /needs you/i });
    fireEvent.click(sw());
    await act(() => settle());
    expect(sw().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(sw());
    await act(() => settle());
    expect(writes).toBe(1);
    expect(sw().getAttribute("aria-checked")).toBe("false");
    await act(async () => { release(); await settle(); });
    expect(sw().hasAttribute("aria-busy")).toBe(false);
  });

  test("appearance: with no `appearance` in the core the theme shows System, whatever an old plugin-only copy says", async () => {
    await mount({ section: "appearance" });
    expect((screen.getByRole("radio", { name: "System" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  test("appearance: a ui.set that fails puts the theme control back and says so; a change made elsewhere shows after a pick", async () => {
    await mount({ section: "appearance" });
    const dark = screen.getByRole("radio", { name: "Dark" });
    uiSetFails = true;
    fireEvent.click(dark);
    await act(() => settle());
    expect(screen.getByRole("alert").textContent).toContain("wasn't changed");
    expect((screen.getByRole("radio", { name: "System" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    uiSetFails = false;
  });

  test("Devices: Remove asks the engine to revoke, which comes back a sealed card (the page applies nothing); a device the engine drops leaves the list", async () => {
    const { core, api } = await mount({ section: "devices" });
    fireEvent.click(screen.getByRole("button", { name: "Remove iPhone" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "device.revoke").map((c) => c.params)).toEqual([{ id: "d3" }]);
    // The card is the engine's: until it is answered the device is still there.
    expect(screen.getByText("iPhone")).toBeTruthy();
    void api;
  });

  test("Devices: pairing by a code shown here: the code, its picture and when it stops, the step the engine's card is at (never the four words), the end", async () => {
    const { core } = await mount({ section: "devices" });
    fireEvent.click(screen.getByRole("button", { name: "Show a code" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "device.pair.begin").length).toBe(1);
    expect(screen.getByText("KQ7-M2P")).toBeTruthy();
    // What a phone scans, and the time the code stops working.
    expect(screen.getByRole("img", { name: /scan this/i })).toBeTruthy();
    expect(document.querySelector("[data-pairing-expiry]")?.textContent).toMatch(/^Works until \d/);
    // A device turned away at this code's door: the engine's own words, with the code still shown; another pairing's note is not this one's.
    await act(async () => { core.emit("pairing_changed", { pairingId: "other", step: "waiting", reason: "A device tried to join and was turned away: elsewhere." }); await settle(); });
    expect(document.querySelector("[data-pairing-note]")).toBeNull();
    await act(async () => { core.emit("pairing_changed", { pairingId: "p1", step: "waiting", reason: "A device tried to join and was turned away: its name isn't one MOSS takes. This code still works." }); await settle(); });
    expect(document.querySelector("[data-pairing-note]")?.textContent).toBe("A device tried to join and was turned away: its name isn't one MOSS takes. This code still works.");
    expect(screen.getByText("KQ7-M2P")).toBeTruthy();
    // Another pairing's step is not this one's.
    await act(async () => { core.emit("pairing_changed", { pairingId: "other", step: "words", peerName: "Stranger" }); await settle(); });
    expect(screen.queryByText(/Stranger/)).toBeNull();
    // The engine's step brings the other device's name; if the words came with it anyway the page would still not draw them.
    await act(async () => { core.emit("pairing_changed", { pairingId: "p1", step: "words", peerName: "Pixel", words: ["amber", "river", "lantern", "moss"] }); await settle(); });
    expect(screen.getByText(/Pixel is in\. A card on this computer asks you/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/amber|lantern/);
    expect(screen.queryByRole("button", { name: "They match" })).toBeNull();
    await act(async () => { core.emit("pairing_changed", { pairingId: "p1", step: "card", peerName: "Pixel" }); await settle(); });
    // Nothing on this page confirms: the card is the engine's, pressed by the person.
    expect(core.calls.some((c) => c.method === "device.pair.confirm")).toBe(false);
    await act(async () => { core.emit("pairing_changed", { pairingId: "p1", step: "done" }); await settle(); });
    expect(screen.getByText("The device was added.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByRole("button", { name: "Show a code" })).toBeTruthy();
  });

  test("Devices: joining with the other device's code waits for the engine's card (no words drawn, none sent back); a pairing that fails or expires says so; Cancel tells the engine", async () => {
    const { core } = await mount({ section: "devices" });
    fireEvent.change(screen.getByRole("textbox", { name: "Code from another device" }), { target: { value: " KQ7-M2P " } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "device.pair.join").map((c) => c.params)).toEqual([{ code: "KQ7-M2P" }]);
    expect(screen.getByText(/A card on this computer asks you to compare four words/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/amber|lantern/);
    await act(async () => { core.emit("pairing_changed", { pairingId: "p2", step: "failed", reason: "the words didn't match" }); await settle(); });
    expect(screen.getByText("The pairing didn't finish: the words didn't match")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    fireEvent.click(screen.getByRole("button", { name: "Show a code" }));
    await act(() => settle());
    await act(async () => { core.emit("pairing_changed", { pairingId: "p1", step: "expired" }); await settle(); });
    expect(screen.getByText("The code expired. Show a new one to try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    fireEvent.click(screen.getByRole("button", { name: "Show a code" }));
    await act(() => settle());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "device.pair.cancel").map((c) => c.params)).toEqual([{ pairingId: "p1" }]);
    expect(core.calls.some((c) => c.method === "device.pair.confirm")).toBe(false);
  });

  test("Devices: each row says what the device is and when it was last seen; the relay is read, chosen and saved at once; a relay plugin is listed and not offered", async () => {
    const { core } = await mount({ section: "devices" });
    const row = (name: string) => screen.getByText(name).closest("[data-item]") as HTMLElement;
    expect(row("Studio").textContent).toContain("Computer");
    expect(row("Studio").textContent).toContain("Online now");
    expect(row("iPhone").textContent).toContain("Phone");
    // A computer's answer keys as four words, read-only (lane XC, xc-6): what a "new key" card on another computer shows.
    expect(row("Studio").textContent).toContain("MOSS key: cedar quill basin otter");
    expect(row("Laptop").textContent).not.toContain("key:");
    await act(() => settle());
    // The engine's choice, read when the page opens.
    expect(core.calls.some((c) => c.method === "device.relay.get")).toBe(true);
    const n0 = document.querySelector('[data-relay="n0"]') as HTMLElement;
    expect(n0.getAttribute("aria-checked")).toBe("true");
    // A server of one's own takes an https address only; Save sends the choice and the engine applies it.
    fireEvent.click(document.querySelector('[data-relay="custom"]') as HTMLElement);
    fireEvent.change(screen.getByRole("textbox", { name: "Relay server's address" }), { target: { value: "http://relay.example.test" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Relay server's address" }), { target: { value: "https://relay.example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "device.relay.set").map((c) => c.params)).toEqual([{ mode: "custom", url: "https://relay.example.test" }]);
    expect(screen.getByText("Saved. The links use it now.")).toBeTruthy();
    fireEvent.click(document.querySelector('[data-relay="off"]') as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "device.relay.set").map((c) => c.params)).toEqual([{ mode: "custom", url: "https://relay.example.test" }, { mode: "off" }]);
  });

  test("Devices: a relay choice the engine refuses puts the control back on what the engine holds, and says so", async () => {
    const { core } = await mount({ section: "devices" });
    await act(() => settle());
    relaySetFails = true;
    fireEvent.click(document.querySelector('[data-relay="off"]') as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "device.relay.set").length).toBe(1);
    expect(screen.getByText("Relay wasn't changed. Try again.")).toBeTruthy();
    expect((document.querySelector('[data-relay="n0"]') as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  test("opened at an item (lane E's useOpen): the row is brought into view and marked, until the user moves on", async () => {
    const shown: string[] = [];
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      shown.push(this.dataset.item ?? "");
    };
    try {
      const { reopen } = await mount({ section: "devices", item: "d2" });
      const marked = () => [...document.querySelectorAll<HTMLElement>("[data-marked]")].map((el) => [el.dataset.item, el.getAttribute("aria-current")]);
      // The devices arrive after the page: the row is shown once it is there, and only once.
      expect(marked()).toEqual([["d2", "true"]]);
      expect(shown).toEqual(["d2"]);
      await reopen({ section: "devices", item: "d3" });
      expect(marked()).toEqual([["d3", "true"]]);
      await reopen({ section: "levels", item: "Laptop" });
      expect(screen.getByRole("region", { name: "Levels" })).toBeTruthy();
      expect(marked()).toEqual([["Laptop", "true"]]);
      expect(shown).toEqual(["d2", "d3", "Laptop"]);
      fireEvent.click(within(screen.getByRole("navigation", { name: "Sections" })).getByRole("button", { name: "Plugins" }));
      expect(marked()).toEqual([]);
    } finally {
      HTMLElement.prototype.scrollIntoView = scroll;
    }
  });

  test("no Bots page: bots are MOSS's to show; a kept card rule names its bot by its id", async () => {
    await mount({ section: "tools" });
    expect(screen.queryByRole("button", { name: "Bots" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Alpha" })).toBeNull();
  });

  test("a section a plugin adds shows after MOSS's own and draws its page", async () => {
    const Section: EntryComponent = () => <p>Tarot settings</p>;
    await mount({}, { component: Section });
    fireEvent.click(screen.getByRole("button", { name: "Tarot" }));
    await act(() => settle()); // the section's spot resolves through the layer, as in the app
    expect(screen.getByText("Tarot settings")).toBeTruthy();
  });

  test("Account: Delete account and Erase everything each ask the engine once on the person's press (its card decides), and Settings steps aside", async () => {
    const { core, closed } = await mount({ section: "account" });
    expect(core.calls.some((c) => c.method === "account.delete" || c.method === "home.erase")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete account…" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "account.delete")).toHaveLength(1);
    expect(closed()).toBe(1);
    cleanup();
    const again = await mount({ section: "account" });
    fireEvent.click(screen.getByRole("button", { name: "Erase everything…" }));
    await act(() => settle());
    expect(again.core.calls.filter((c) => c.method === "home.erase")).toHaveLength(1);
  });

  test("Account has a way back to the setup guide (the app menu's item is macOS only): one press asks the app to open it, Settings steps aside; a refusal says so and stays", async () => {
    setupFails = false;
    const { core, closed } = await mount({ section: "account" });
    expect(core.calls.some((c) => c.method === "app.openSetup")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open the setup guide" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "app.openSetup")).toHaveLength(1);
    expect(closed()).toBe(1);
    cleanup();
    setupFails = true;
    const again = await mount({ section: "account" });
    fireEvent.click(screen.getByRole("button", { name: "Open the setup guide" }));
    await act(() => settle());
    expect(again.closed()).toBe(0);
    expect(screen.getByText("The setup guide didn't open. Try again.")).toBeTruthy();
    setupFails = false;
  });

  test("Close closes", async () => {
    const { closed } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(closed()).toBe(1);
  });
});
