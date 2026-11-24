// MOSS's window under happy-dom, with a stub bridge: what a bot wrote is drawn as text and never as markup (the
// reviewer's list for lane MA, item 4), every face has its mood in words beside it, a piece the engine doesn't serve
// yet shows as waiting, and the cards go where the router placed them (the conversation's own, else the strip).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import type { ConversationPage, MossBridge, MossView } from "../src/shared/view";

GlobalRegistrator.register();
// The kit draws on a canvas, which happy-dom has none of: a 2D context that draws nothing.
const noop = new Proxy({}, { get: () => () => undefined });
(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => noop;
afterAll(async () => { await GlobalRegistrator.unregister(); });

const { act, render } = await import("@testing-library/react");
const { App } = await import("../src/window/App");
const { createElement: h } = await import("react");

const EVIL = `<img src=x onerror="window.__pwned=1"><b>bold</b><script>window.__pwned=2</script>`;

function view(over: Partial<MossView> = {}): MossView {
  return {
    connection: { kind: "connected" }, pieces: { bots: "ready" },
    bots: [
      { id: "juniper", name: "Juniper", mood: "working", tool: "mcp__moss__Browser", last: { text: EVIL, from: "bot", at: Date.now() - 60_000 }, unread: true },
      { id: "kite", name: "Kite", mood: "asking", unread: false },
    ],
    cards: [], ...over,
  };
}

let retried: string[] = [];
let opened: string[] = [];
let messageTo: ((bot: string, m: import("../src/shared/view").Message) => void)[] = [];
let viewTo: ((v: MossView) => void)[] = [];
let pendingBot: { bot: string } | undefined;
let showTo: ((w: { bot: string }) => void)[] = [];
let saidTo: ((cardId: string, words: string) => void)[] = [];
function stub(v: MossView, page: ConversationPage | { waiting: true }): MossBridge {
  const none = () => () => {};
  return {
    view: async () => v, onView: (fn) => { viewTo.push(fn); return () => {}; }, showing: () => {}, pendingShow: async () => pendingBot, onShow: (fn) => { showTo.push(fn); return () => {}; }, conversation: async () => page, onMessage: (fn) => { messageTo.push(fn); return () => {}; },
    send: async () => ({ ok: true }), pickAttachments: async () => [], dropAttachments: async () => [], releaseAttachments: () => {}, createBot: async () => ({ ok: false, why: "no" }), markRead: () => {},
    routines: async () => [], routineInstructions: async () => ({ ok: false, why: "no" }), runRoutine: async () => ({ ok: false, why: "no" }),
    editRoutine: async () => ({ ok: false, why: "no" }), memory: async () => ({ waiting: true }), memoryFile: async () => ({ ok: false, why: "no" }),
    pictures: async () => [], openPicture: async () => false, closePicture: () => {}, onPictureFrame: none,
    cardFrame: async () => undefined, onCardHeight: none, onCardSaid: (fn) => { saidTo.push(fn); return () => {}; }, talk: () => {}, plugins: async () => [], setAvailability: async () => false,
    addPlugin: async () => ({ ok: false, why: "no" }), settings: async () => ({ account: "waiting", signIns: "waiting", computers: "waiting", devices: "waiting" }),
    botSettings: async () => ({ waiting: true }), setBotSetting: async () => false, setLevel: async () => false, relay: async () => ({ mode: "n0" as const }), setRelay: async (c) => ({ ok: true as const, relay: c }), pairBegin: async () => ({ ok: true }), pairJoin: async () => ({ ok: true }), pairCancel: async () => true, removeDevice: async () => false,
    setPermission: async () => false, signIn: async () => ({ ok: false, why: "no" }), signOut: async () => false,
    botRecord: async () => ({ waiting: true }), botInstructions: async () => ({ waiting: true }), editBot: async () => false, models: async () => ({ waiting: true }),
    setup: async () => ({ waiting: true }), setupProviders: async () => ({ waiting: true }), openTerms: async () => false, setDefaultModel: async () => ({ ok: false, why: "no" }), skipSetup: async () => false,
    archiveBot: async () => false, archivedBots: async () => [], restoreBot: async () => false, retry: async (bot) => { retried.push(bot); return { ok: true }; }, pictureInput: () => {},
    openLink: async (url) => { opened.push(url); return true; },
  };
}

async function draw(v: MossView, page: ConversationPage | { waiting: true }) {
  (window as unknown as { moss: MossBridge }).moss = stub(v, page);
  const r = render(h(App));
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
  return r;
}

describe("MOSS's window", () => {
  test("\"Open in MOSS\": the bot the engine asked the window to show is the one drawn, at load and while open", async () => {
    pendingBot = { bot: "kite" };
    const r = await draw(view(), { bot: "kite", hasMore: false, messages: [] });
    expect(r.container.querySelector("[data-bot-row=kite]")?.getAttribute("aria-current")).toBe("true");
    expect(r.container.querySelector("[data-bot-row=juniper]")?.getAttribute("aria-current")).toBeNull();
    r.unmount();
    pendingBot = undefined;
    const r2 = await draw(view(), { bot: "kite", hasMore: false, messages: [] });
    await act(async () => { for (const fn of showTo) fn({ bot: "kite" }); await new Promise((res) => setTimeout(res, 30)); });
    expect(r2.container.querySelector("[data-bot-row=kite]")?.getAttribute("aria-current")).toBe("true");
    r2.unmount();
  });

  test("a bot's markup is text: no element, no script runs", async () => {
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [{ id: "1", from: "bot", text: EVIL, at: Date.now() }, { id: "2", from: "user", text: "<i>me</i>", at: Date.now() }] });
    const bubbles = [...r.container.querySelectorAll("[data-bubble]")];
    expect(bubbles.length).toBe(2);
    // The reply is Markdown: its one paragraph holds the raw HTML as the text it is (no element came from it).
    expect(bubbles[0]?.textContent).toBe(EVIL);
    expect([...bubbles[0]!.children].map((c) => c.tagName)).toEqual(["P"]);
    expect(bubbles[0]!.querySelector("p")!.children.length).toBe(0);
    // The person's own words stay plain text.
    expect(bubbles[1]?.textContent).toBe("<i>me</i>");
    expect(bubbles[1]?.children.length).toBe(0);
    // The list's last line too.
    expect(r.container.querySelector("[data-bot-row=juniper] .row__last")?.textContent).toBe(EVIL);
    expect(r.container.querySelector("[data-bot-row=juniper] .row__last")?.children.length).toBe(0);
    expect(r.container.querySelectorAll("img, b, i, script").length).toBe(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    r.unmount();
  });

  test("a bot's reply is drawn as Markdown: list, bold, italics, inline code, a code block and a link, never raw", async () => {
    opened = [];
    const REPLY = [
      "Here is what I can do for you:",
      "",
      "- **Start a coding agent for you.** You tell me what to build and where, and I start it.",
      "- **Look things up.** I search the web and read `notes.txt` for you.",
      "",
      "Then _you_ decide. Run it with:",
      "",
      "```sh",
      "npm test",
      "```",
      "",
      "See [the docs](https://example.com/docs), [mail me](mailto:a@example.com), [a script](javascript:alert(1)) and <b>raw</b>.",
    ].join("\n");
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [{ id: "1", from: "bot", text: REPLY, at: Date.now() }] });
    const bubble = r.container.querySelector("[data-bubble=bot]")!;
    // No dash or asterisk of the Markdown is left on the screen.
    expect(bubble.textContent).not.toContain("**");
    expect(bubble.textContent).not.toMatch(/^\s*- /m);
    expect(bubble.textContent).not.toContain("```");
    const items = [...bubble.querySelectorAll("ul > li")];
    expect(items.length).toBe(2);
    expect(items[0]!.querySelector("strong")?.textContent).toBe("Start a coding agent for you.");
    expect(items[1]!.querySelector("strong")?.textContent).toBe("Look things up.");
    expect(items[1]!.querySelector("code")?.textContent).toBe("notes.txt");
    expect(bubble.querySelector("em")?.textContent).toBe("you");
    expect(bubble.querySelector("pre code")?.textContent).toBe("npm test\n");
    // Raw HTML in a reply is the text it is.
    expect(bubble.querySelector("b")).toBeNull();
    expect(bubble.textContent).toContain("<b>raw</b>");
    // Links: http(s) and mailto open in the person's browser through main, on a click; a script address is no link at all.
    const links = [...bubble.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(["the docs", "mail me"]);
    await act(async () => { links[0]!.click(); links[1]!.click(); await new Promise((res) => setTimeout(res, 10)); });
    expect(opened).toEqual(["https://example.com/docs", "mailto:a@example.com"]);
    expect([...bubble.querySelectorAll("[data-blocked]")].map((a) => a.textContent)).toEqual(["a script"]);
    expect(r.container.querySelector("script")).toBeNull();
    r.unmount();
  });

  test("every face has its mood in words beside it", async () => {
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [] });
    for (const row of r.container.querySelectorAll("[data-bot-row]")) {
      expect(row.querySelector("canvas[data-face]")).not.toBeNull();
      expect(row.querySelector("[data-mood-words]")?.textContent?.length).toBeGreaterThan(0);
    }
    expect(r.container.querySelector("[data-bot-row=kite] [data-mood-words]")?.textContent).toBe("Needs you");
    expect(r.container.querySelector("[data-bot-row=juniper] [data-mood-words]")?.textContent).toBe("Using the browser");
    r.unmount();
  });

  test("a running turn shows ONE status line, not a control; no tool row is drawn; an idle bot shows none", async () => {
    const page = { bot: "juniper", hasMore: false, messages: [{ id: "1", from: "user" as const, text: "go", at: Date.now() }] };
    const r = await draw(view({ bots: [{ id: "juniper", name: "Juniper", mood: "working", tool: "Read", detail: "notes.txt", unread: false }] }), page);
    const lines = r.container.querySelectorAll("[data-status-line]");
    expect(lines.length).toBe(1);
    expect(lines[0]?.querySelector("[data-status-text]")?.textContent).toBe("Reading notes.txt");
    expect(lines[0]?.querySelector("button, a, input, [tabindex], [role=button]")).toBeNull();
    expect(lines[0]?.querySelector("[role=status][aria-live=polite]")).not.toBeNull();
    // The words of a tool call never appear as a row of the conversation.
    expect(r.container.querySelectorAll("[data-bubble]").length).toBe(1);
    expect(r.container.textContent).not.toMatch(/Used |Bash|tool_/);
    r.unmount();
    const idle = await draw(view({ bots: [{ id: "juniper", name: "Juniper", mood: "idle", unread: false }] }), page);
    expect(idle.container.querySelector("[data-status-line]")).toBeNull();
    idle.unmount();
  });

  test("a reply hides the status line for that state only; the next turn's line shows again", async () => {
    messageTo = []; viewTo = [];
    const page = { bot: "juniper", hasMore: false, messages: [] };
    const running = (mood: "thinking" | "idle") => view({ bots: [{ id: "juniper", name: "Juniper", mood, unread: false }] });
    const r = await draw(running("thinking"), page);
    expect(r.container.querySelector("[data-status-text]")?.textContent).toBe("Thinking");
    await act(async () => { for (const f of messageTo) f("juniper", { id: "m1", from: "bot", text: "Here you go.", at: Date.now() }); });
    expect(r.container.querySelector("[data-status-line]")).toBeNull();
    await act(async () => { for (const f of viewTo) f(running("idle")); });
    expect(r.container.querySelector("[data-status-line]")).toBeNull();
    await act(async () => { for (const f of viewTo) f(running("thinking")); });
    expect(r.container.querySelector("[data-status-text]")?.textContent).toBe("Thinking");
    r.unmount();
  });

  test("a conversation the engine doesn't serve yet says so", async () => {
    const r = await draw(view(), { waiting: true });
    expect(r.container.textContent).toContain("Waiting for the engine to serve Juniper's conversation.");
    r.unmount();
  });

  test("a failed turn shows Try again while it is the last thing; one press asks for it once, and an older failure offers none", async () => {
    retried = [];
    const failed = { id: "f1", from: "note" as const, text: "The turn ended with an error.", at: Date.now(), failed: true as const };
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [{ id: "u1", from: "user", text: "hello", at: Date.now() }, failed] });
    const button = r.container.querySelector<HTMLButtonElement>("[data-try-again]");
    expect(button?.textContent).toBe("Try again");
    await act(async () => { button!.click(); await new Promise((res) => setTimeout(res, 20)); });
    expect(retried).toEqual(["juniper"]);
    expect(r.container.querySelector("[data-try-again]")).toBeNull();
    r.unmount();
    const later = await draw(view(), { bot: "juniper", hasMore: false, messages: [failed, { id: "u2", from: "user", text: "again", at: Date.now() }] });
    expect(later.container.querySelector("[data-try-again]")).toBeNull();
    later.unmount();
  });

  test("a refused press says why beside its card, in plain words drawn as text", async () => {
    saidTo = [];
    const r = await draw(view({ cards: [{ id: "card_a1b2c3", bot: "juniper", kind: "tool", place: "conversation" }] }), { bot: "juniper", hasMore: false, messages: [] });
    await act(async () => { for (const f of saidTo) f("card_a1b2c3", "Computer use is acting right now."); await new Promise((res) => setTimeout(res, 10)); });
    expect(r.container.querySelector("[data-card=card_a1b2c3] [data-card-said]")?.textContent).toBe("Computer use is acting right now.");
    await act(async () => { for (const f of saidTo) f("card_zzz", "<b>not this one</b>"); await new Promise((res) => setTimeout(res, 10)); });
    expect(r.container.querySelectorAll("[data-card-said]").length).toBe(1);
    r.unmount();
  });

  test("the cards go where the router placed them", async () => {
    const r = await draw(view({ cards: [{ id: "card_a1b2c3", bot: "juniper", kind: "tool", place: "conversation" }, { id: "card_d4e5f6", bot: "kite", kind: "tool", place: "strip" }] }), { bot: "juniper", hasMore: false, messages: [] });
    expect(r.container.querySelector(".messages [data-card=card_a1b2c3]")).not.toBeNull();
    expect(r.container.querySelector(".strip [data-card=card_d4e5f6]")).not.toBeNull();
    expect(r.container.querySelector(".strip")?.textContent).toContain("Kite needs you");
    r.unmount();
  });
});

describe("the composer and dropped things", () => {
  // 2026-11-22: was "a file dropped on it is said plainly (pictures only, with the + button), and nothing is sent": a dropped file
  // is now carried. Its path is read by the preload (webUtils), main keeps it, and the window holds only the name and an id.
  test("a file dropped on it is named in the composer and Send carries its id; the engine's refusal is shown as it is", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [] });
    const composer = r.container.querySelector("[data-composer]")!;
    const bridge = (window as unknown as { moss: MossBridge }).moss;
    const dropped: File[][] = [];
    bridge.dropAttachments = async (files) => (dropped.push([...files]), [{ id: "f1", name: "report.pdf", kind: "file" }]);
    const sent: unknown[][] = [];
    let answer: { ok: true } | { ok: false; why: string } = { ok: false, why: "“big.bin” is 51 MB: a file can be at most 50 MB." };
    bridge.send = async (...a: unknown[]) => { sent.push(a); return answer; };
    await act(async () => { fireEvent.drop(composer, { dataTransfer: { files: [new File(["x"], "report.pdf", { type: "application/pdf" })] } }); });
    expect(dropped).toHaveLength(1);
    expect(r.container.querySelector("[data-attached-file]")?.textContent).toContain("report.pdf");
    await act(async () => { fireEvent.click(r.container.querySelector("button.send")!); });
    expect(sent).toEqual([["juniper", "", [], ["f1"]]]);
    expect(r.container.querySelector(".composer__why")?.textContent).toBe("“big.bin” is 51 MB: a file can be at most 50 MB.");
    expect(r.container.querySelector("[data-attached-file]")).not.toBeNull(); // kept: the person can remove it and try again
    answer = { ok: true };
    await act(async () => { fireEvent.click(r.container.querySelector("button.send")!); });
    expect(r.container.querySelector("[data-attached-file]")).toBeNull();
    r.unmount();
  });

  test("a send the press check refused (a busy machine) says why, keeps the words, and pressing Send again goes; a call that fails outright says so the same way", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [] });
    const bridge = (window as unknown as { moss: MossBridge }).moss;
    const sent: unknown[][] = [];
    const busy = "Your computer was too busy to confirm that press in time. Nothing was lost: press again.";
    const answers: (() => Promise<{ ok: true } | { ok: false; why: string }>)[] = [
      async () => ({ ok: false, why: busy }),
      async () => { throw new Error("Error invoking remote method 'moss:send': Error: not MOSS's window"); },
      async () => ({ ok: true }),
    ];
    bridge.send = (...a: unknown[]) => { sent.push(a); return answers.shift()!(); };
    const box = r.container.querySelector("textarea")!;
    await act(async () => { fireEvent.change(box, { target: { value: "hello juniper" } }); });
    await act(async () => { fireEvent.click(r.container.querySelector("button.send")!); });
    expect(r.container.querySelector(".composer__why")?.textContent).toBe(busy);
    expect((r.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello juniper");
    await act(async () => { fireEvent.click(r.container.querySelector("button.send")!); });
    expect(r.container.querySelector(".composer__why")?.textContent).toBe("MOSS couldn't send just now. Your message is still here: press Send again.");
    expect((r.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello juniper");
    await act(async () => { fireEvent.click(r.container.querySelector("button.send")!); });
    expect(sent).toHaveLength(3);
    expect((r.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(r.container.querySelector(".composer__why")).toBeNull();
    r.unmount();
  });

  test("an eleventh file in one message is said, a chip's x and another bot shown both tell main to let go of the ids", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [] });
    const composer = r.container.querySelector("[data-composer]")!;
    const bridge = (window as unknown as { moss: MossBridge }).moss;
    const released: string[][] = [];
    bridge.releaseAttachments = (ids) => { released.push([...ids]); };
    const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, name: `n${i}.txt`, kind: "file" as const }));
    bridge.dropAttachments = async () => twelve;
    await act(async () => { fireEvent.drop(composer, { dataTransfer: { files: [new File(["x"], "n.txt")] } }); });
    expect(r.container.querySelectorAll("[data-attached-file]")).toHaveLength(10);
    expect(r.container.querySelector(".composer__why")?.textContent).toBe("A message can carry at most 10 files: 2 not attached.");
    expect(released).toEqual([["f10", "f11"]]); // the two that didn't fit are given back at once
    await act(async () => { fireEvent.click(r.container.querySelector("[data-attached-file] button")!); });
    expect(released[1]).toEqual(["f0"]);
    expect(r.container.querySelectorAll("[data-attached-file]")).toHaveLength(9);
    r.unmount(); // the composer goes away: what it still held is given back
    expect(released[2]!.sort()).toEqual(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"]);
  });

  test("a picture over 10 MB that went as a file is said in one plain line", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [] });
    const composer = r.container.querySelector("[data-composer]")!;
    (window as unknown as { moss: MossBridge }).moss.dropAttachments = async () => [{ id: "b1", name: "big.png", kind: "file", note: "“big.png” is over 10 MB, so it goes as a file, not as a picture." }];
    await act(async () => { fireEvent.drop(composer, { dataTransfer: { files: [new File(["x"], "big.png", { type: "image/png" })] } }); });
    expect(r.container.querySelector(".composer__why")?.textContent).toBe("“big.png” is over 10 MB, so it goes as a file, not as a picture.");
    r.unmount();
  });

  test("a routine that failed shows why in the conversation, marked as a failure", async () => {
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [{ id: "n1", from: "note", text: 'Routine "Brief": The run failed (provider): the model refused the key.', at: Date.now(), routineFailed: true }] });
    const note = r.container.querySelector("[data-routine-failed]");
    expect(note?.textContent).toContain("The run failed (provider)");
    r.unmount();
  });
});

describe("the setup guide (2026-11-20)", () => {
  const NOT_SET = { ready: false, missing: ["provider", "model"] as ("provider" | "model")[], providers: [], dismissed: false };
  async function withGuide(v: MossView, over: Partial<MossBridge>) {
    const b = { ...stub(v, { bot: "juniper", hasMore: false, messages: [] }), ...over };
    (window as unknown as { moss: MossBridge }).moss = b;
    const r = render(h(App));
    await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
    return r;
  }

  test("a card waiting in this window comes first: the guide steps aside, kept at its step, and is back after", async () => {
    viewTo = [];
    const r = await withGuide(view({ setup: NOT_SET }), {
      setupProviders: async () => [{ pluginId: "moss/model-anthropic", name: "Anthropic", auth: [{ index: 0, method: "api-key", state: "signed-out" }] }],
    });
    const holder = () => r.container.querySelector(".setup-holder") as HTMLDivElement | null;
    expect(holder()?.hidden).toBe(false);
    await act(async () => { for (const f of viewTo) f(view({ setup: NOT_SET, cards: [{ id: "k1", bot: "juniper", kind: "approval", place: "conversation" }] })); await new Promise((res) => setTimeout(res, 10)); });
    expect(holder()?.hidden).toBe(true);
    expect(holder()?.dataset.setupAside).toBe("yes");
    expect(r.container.querySelector("[data-setup-step=providers]")).not.toBeNull();
    await act(async () => { for (const f of viewTo) f(view({ setup: NOT_SET, cards: [] })); await new Promise((res) => setTimeout(res, 10)); });
    expect(holder()?.hidden).toBe(false);
    // The old home's copy, pending though drawn elsewhere, holds it aside too.
    await act(async () => { for (const f of viewTo) f(view({ setupWaits: true })); await new Promise((res) => setTimeout(res, 10)); });
    expect(holder()?.hidden).toBe(true);
    r.unmount();
  });

  test("a home that isn't set up opens it by itself; a skip goes to the engine and closes it", async () => {
    let skipped = 0;
    const r = await withGuide(view({ setup: NOT_SET }), {
      setupProviders: async () => [{ pluginId: "moss/model-anthropic", name: "Anthropic", terms: { text: "Be kind." }, auth: [{ index: 0, method: "api-key", state: "signed-out" }] }],
      skipSetup: async () => { skipped++; return true; },
    });
    expect(r.container.querySelector("[data-setup-step=providers]")).not.toBeNull();
    expect(r.container.querySelector("[data-setup-provider='moss/model-anthropic']")).not.toBeNull();
    // Next waits for a provider.
    expect((r.container.querySelector("[data-setup=next]") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { (r.container.querySelector("[data-setup=skip]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 10)); });
    expect(skipped).toBe(1);
    expect(r.container.querySelector("[data-setup-step]")).toBeNull();
    r.unmount();
  });

  test("the default model's provider signed out: one plain line in the guide's provider step, and where the guide was skipped, a banner with a way in; general for any provider", async () => {
    const OUT = { ready: false, missing: ["default-provider"] as ("default-provider")[], providers: [], signedOut: "dark/x", dismissed: false };
    const models = async () => [{ id: "dark/x", title: "Moon X", provider: "Dark Labs", ready: false }];
    const r = await withGuide(view({ setup: OUT }), { models, setupProviders: async () => [{ pluginId: "moss/model-dark", name: "Dark Labs", auth: [{ index: 0, method: "api-key", state: "signed-out" }] }] });
    expect(r.container.querySelector("[data-setup-signed-out]")?.textContent).toBe("Your default model, Moon X, needs you signed in to Dark Labs.");
    expect(r.container.querySelector("[data-signed-out-banner]")).toBeNull();
    r.unmount();
    // The guide skipped before: no guide, the line is a banner whose Sign in opens the guide at its provider step.
    const skipped = await withGuide(view({ setup: { ...OUT, dismissed: true } }), { models, setupProviders: async () => [{ pluginId: "moss/model-dark", name: "Dark Labs", auth: [{ index: 0, method: "api-key", state: "signed-out" }] }] });
    expect(skipped.container.querySelector("[data-setup-step]")).toBeNull();
    expect(skipped.container.querySelector("[data-signed-out-banner]")?.textContent).toContain("Your default model, Moon X, needs you signed in to Dark Labs.");
    await act(async () => { (skipped.container.querySelector("[data-setup=sign-in]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 10)); });
    expect(skipped.container.querySelector("[data-setup-step=providers]")).not.toBeNull();
    expect(skipped.container.querySelector("[data-signed-out-banner]")).toBeNull();
    skipped.unmount();
  });

  test("a home that works, or a guide skipped before, doesn't show it", async () => {
    for (const setup of [{ ...NOT_SET, ready: true, missing: [] }, { ...NOT_SET, dismissed: true }]) {
      const r = await withGuide(view({ setup }), {});
      expect(r.container.querySelector("[data-setup-step]")).toBeNull();
      r.unmount();
    }
  });

  test("the terms come before a provider's way in", async () => {
    const r = await withGuide(view({ setup: NOT_SET }), {
      setupProviders: async () => [{ pluginId: "moss/model-anthropic", name: "Anthropic", terms: { text: "Be kind." }, auth: [{ index: 0, method: "api-key", state: "signed-out" }] }],
    });
    // One provider listed: it is open, its way in disabled until the terms are accepted.
    expect((r.container.querySelector(".setup__ways") as HTMLFieldSetElement).disabled).toBe(true);
    await act(async () => { (r.container.querySelector("[data-setup-terms]") as HTMLInputElement).click(); });
    expect((r.container.querySelector(".setup__ways") as HTMLFieldSetElement).disabled).toBe(false);
    r.unmount();
  });

  test("two providers, the default shown at step 2: done names the same model, effort and provider, and nothing is re-stored", async () => {
    const set = { ready: true, missing: [] as ("provider" | "model")[], providers: ["anthropic", "deepseek-anthropic"], default: { model: "anthropic/claude-opus-5-5", source: "chosen" as const, effort: "medium" }, dismissed: false };
    const stored: string[] = [];
    const r = await withGuide(view({ setup: { ...set, ready: false } }), {
      setupProviders: async () => [{ pluginId: "moss/model-anthropic", name: "Anthropic", auth: [{ index: 0, method: "api-key", state: "signed-in" }] }],
      setup: async () => set,
      models: async () => [{ id: "anthropic/claude-opus-5-5", title: "Claude Opus 5.5", provider: "Anthropic", ready: true }, { id: "deepseek-anthropic/deepseek-v4-pro", title: "DeepSeek V4 Pro", provider: "DeepSeek (Anthropic dialect)", ready: true }],
      setDefaultModel: async (m) => { stored.push(m); return { ok: true, setup: set }; },
    });
    await act(async () => { (r.container.querySelector("[data-setup=next]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 20)); });
    const chosen = r.container.querySelector("[data-setup-step=model] .setup__chosen")!;
    const muted = chosen.querySelectorAll("span.muted");
    const step2 = `${chosen.querySelector("strong")!.textContent}${muted[muted.length - 1]!.textContent}`;
    expect(step2).toBe("Claude Opus 5.5 · medium · Anthropic");
    await act(async () => { (r.container.querySelector("[data-setup=next]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 20)); });
    expect(r.container.querySelector("[data-setup-done-model]")?.getAttribute("data-setup-done-model")).toBe(step2);
    expect(r.container.querySelector("[data-setup-step=done]")?.textContent).toContain(step2);
    expect(stored).toEqual([]);
    r.unmount();
  });

  test("with several providers the person picks; the pick goes to the engine and done lands in the default bot's conversation", async () => {
    const two = { ready: false, missing: ["model"] as ("provider" | "model")[], providers: ["anthropic", "openai"], recommended: { anthropic: { model: "anthropic/b", effort: "medium" }, openai: { model: "openai/a" } }, dismissed: false };
    const picked: string[] = [];
    const r = await withGuide(view({ setup: two }), {
      setupProviders: async () => [{ pluginId: "moss/model-anthropic", name: "Anthropic", auth: [{ index: 0, method: "api-key", state: "signed-in" }] }],
      setup: async () => two,
      models: async () => [{ id: "anthropic/b", title: "B", provider: "Anthropic", ready: true }, { id: "openai/a", title: "A", provider: "OpenAI", ready: true }, { id: "x/off", title: "Off", provider: "X", ready: false }],
      setDefaultModel: async (m) => { picked.push(m); return { ok: true, setup: { ...two, ready: true, missing: [], default: { model: m, source: "chosen" } } }; },
    });
    await act(async () => { (r.container.querySelector("[data-setup=next]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 20)); });
    expect(r.container.querySelector("[data-setup-step=model]")).not.toBeNull();
    const select = r.container.querySelector("[data-setup-model-picker]") as HTMLSelectElement;
    // Only the added providers' models, the first added provider's recommended one pre-filled.
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual(["anthropic/b", "openai/a"]);
    expect(select.value).toBe("anthropic/b");
    await act(async () => { select.value = "openai/a"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { (r.container.querySelector("[data-setup=next]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 20)); });
    expect(picked).toEqual(["openai/a"]);
    expect(r.container.querySelector("[data-setup-step=done]")?.textContent).toContain("A · OpenAI answers Juniper's first message");
    await act(async () => { (r.container.querySelector("[data-setup=start]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 80)); });
    expect(r.container.querySelector("[data-setup-step]")).toBeNull();
    r.unmount();
  });
});
