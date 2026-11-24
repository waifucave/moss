// The session canvas's acceptance rows of lane CA (spec revision 20, §9.5; the `canvas-app` unit, a home of its own; lane CM's row is in canvas-step.ts): MOSS Code from source over its own home,
// `main` entry keyed `start` (lane CA's rows here use a fixture plugin, `fixtures/acceptance-canvas`, until the canvas plugin of lane CP
// has its own). Lanes CG, CM and CP add their rows to this table beside CA's.
//
// CA's rows, in order on one home (each drives MOSS Code's window through its DevTools port, with trusted clicks, and reads the engine's
// answers beside what the window shows):
//   1. the start page: on a fresh home it is the bundled canvas plugin's (the shell's own new-session page is only the fallback
//      when no plugin fills `start`, and shows nowhere), its + panel drawing each agent's mark (the nine agent plugins ship
//      theirs; MOSS's own coding agent the Shards mark); with the canvas switched off and nothing filling `start`, the shell's
//      own page (a mark on each agent row) starts a session and the sidebar's New session leads back to it; with the
//      fixture plugin installed, its entry is the start page;
//   2. a start through the app's door: the page's button starts a session with a model, an effort, a recent folder and a first message,
//      the window opens that session's tab, the engine says the session runs on that model and effort, the first message is the
//      user's own, and `agent.recent` then offers them;
//   3. the corner control of the session's tab returns to the start page;
//   4. "Open in MOSS": MOSS isn't running, so the engine asks for it to start (a marker the run answers by starting its own MOSS from
//      source), and MOSS opens the bot's conversation.
//
// Lane CP's rows, after CA's, with the fixture plugin removed and the canvas switched on again (the real engine, the real
// window; MOSS started by CA's row 4 still running):
//   5. the start page is the canvas, and + creates a session with what it preselects (the last start's agent, model, effort and
//      folder): the engine says the new session runs on them, and the window opens its tab;
//   6. the tab's corner control returns to the canvas with that session's block in view;
//   7. a message between two code sessions (one's SendMessage to the other, scripted through the run's fake model) shows on the
//      line joining their blocks: the message's light on that line and both blocks' rings reacting are drawn when its
//      session_link is heard; the line is still there after the canvas is closed and opened again (the engine's session.links);
//   8. after a real drag of one block, one press on another opens it, and Enter on a focused block opens it; a block's composer sends as the user (a user_message in that session), and a bot's block opens "Open in MOSS" (MOSS shows
//      that bot's conversation);
//   9. the window's glass (the owner's try 21): a block panned half under the top bar passes beneath it (the bar frosts it), and a
//      vivid colour painted under the window's documents (where macOS's material is) mixes into the sidebar's pixels, in light
//      and dark, enough to read as glass, and never into the main column's.
//
// With MOSS_ACCEPT_RENDERS set, the start pages are pictured in light and dark, and a bot's face drawn by BotFace in MOSS Code beside
// MOSS's own drawing (a render, never a check).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Cdp } from "./cdp";
import type { MossClient } from "./client";
import { Doc, type SetupUnitCtx } from "./setup-step";
import { notOnLinux, onLinux } from "./not-on-linux";
import { readPng } from "./ui-steps";
import type { Status } from "./steps";

export const CANVAS_START_STEP = "the start page: on a fresh home it is the bundled canvas plugin's (the shell's own new-session page, the fallback when no plugin fills `start`, shows nowhere), its + panel drawing each agent's mark (MOSS's own agent the Shards mark, the nine agent plugins theirs, a one-colour glyph drawn in its agent's colour); with the canvas switched off and no plugin filling `start`, the shell's own new-session page, a mark on each agent row, starts a session and the sidebar's New session leads back to it; with the canvas switched off and a plugin's `main` entry keyed `start` installed, that entry is the start page, drawing the same marks and, for an agent with none, the first letter on a colour";
export const CANVAS_START_SESSION_STEP = "a start through the app's door from the start page's button: a model, an effort, a recent folder (a token, never a path) and a first message; the window opens the new session's tab, the engine says it runs on that model and effort, the first message is the user's own, and agent.recent then offers that agent, model, effort and folder";
export const CANVAS_CORNER_STEP = "a session tab's top corner holds a plugin's control (the `session.corner` spot, given the session and its kind): pressing it returns the window to the start page";
export const CANVAS_OPEN_IN_STEP = "\"Open in MOSS\" from a part of MOSS Code with MOSS not running: the engine is asked to start MOSS (it starts nothing itself in the run: a marker, answered by the run starting its own MOSS from source), and MOSS opens the bot's conversation";
export const CANVAS_PLUS_STEP = "the canvas is MOSS Code's start page under one frosted bar (the window's: the canvas's count of sessions in the title's place, a plain + named New session at its right end, no zoom buttons or Fit), and its + creates a session with what it preselects (the last start's agent, model, effort and folder): the engine says the session runs on them, and the window opens its tab";
export const CANVAS_BACK_STEP = "a session tab's corner control (the canvas's) returns the window to the canvas with that session's block in view";
export const CANVAS_LINE_STEP = "a message between two code sessions shows on the line joining their blocks: the message's light on that line and both blocks' rings reacting, drawn when its session_link is heard; the line is still there after the canvas is closed and opened again (from the engine's session.links)";
export const CANVAS_BLOCK_STEP = "after a real drag of one block, one press on another opens it, and Enter on a focused block opens it; a block's composer sends as the user (a user_message in that session), and a bot's block opens \"Open in MOSS\" (MOSS shows that bot's conversation)";
export const CANVAS_GLASS_STEP = "the window's glass: a block panned half under the top bar passes beneath it, frosted, and a vivid colour under the window's documents (where the window's material is) shows through the sidebar in light and dark, enough to read as glass, and never through the main column";
export const CANVAS_APP_STEPS: readonly string[] = [CANVAS_START_STEP, CANVAS_START_SESSION_STEP, CANVAS_CORNER_STEP, CANVAS_OPEN_IN_STEP, CANVAS_PLUS_STEP, CANVAS_BACK_STEP, CANVAS_LINE_STEP, CANVAS_BLOCK_STEP, CANVAS_GLASS_STEP];

export interface CanvasAppUnitCtx extends Pick<SetupUnitCtx, "root" | "logs" | "userHome" | "driver" | "startCodeApp" | "startMossApp" | "freePort" | "endChild" | "alive" | "readLog" | "until" | "fail" | "record" | "statusOf" | "why"> {
  /** The folder the run's engine leaves its `open-moss` marker in (MOSS_ACCEPTANCE_LAUNCH_DIR). */
  launchDir: string;
  /** Installs the fixture plugin (`fixtures/acceptance-canvas`) and answers its OK card, over the run's client. */
  installFixture(c: MossClient): Promise<void>;
  /** Removes it again (its card answered), so the bundled canvas is the start page for lane CP's rows. */
  removeFixture(c: MossClient): Promise<void>;
  /** The model a session may be started on (signed in by the run's dummy key), and the one the engine defaults to. */
  keyedModel: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function canvasAppUnit(x: CanvasAppUnitCtx): Promise<void> {
  const renders = process.env.MOSS_ACCEPT_RENDERS === undefined || process.env.MOSS_ACCEPT_RENDERS === "" ? undefined : process.env.MOSS_ACCEPT_RENDERS;
  const done = new Set<string>();
  const apps: { proc: ChildProcess; log: string }[] = [];
  const cdps: Cdp[] = [];
  let stopWatching = false;
  let code: Doc | undefined;
  const row = async (name: string, run: () => Promise<string>): Promise<void> => {
    done.add(name);
    try {
      x.record(name, "PASS", await run());
    } catch (err) {
      const n = CANVAS_APP_STEPS.indexOf(name) + 1;
      let shot = "";
      if (code !== undefined) {
        const s = await code.session().catch(() => undefined);
        const r = s === undefined ? undefined : await code.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, s).catch(() => undefined);
        if (r !== undefined) { writeFileSync(join(x.logs, `canvas-row-${n}.png`), Buffer.from(r.data, "base64")); shot = ` (picture: logs/canvas-row-${n}.png)`; }
      }
      x.record(name, x.statusOf(err), `${x.why(err)}${shot}`);
    }
  };
  try {
    const c = await x.driver();
    await c.request("events.subscribe", { areas: ["sessions", "approvals"] }).catch(() => undefined);
    const appearance = join(x.root, "canvas-appearance");
    const port = x.freePort();
    const app = x.startCodeApp(port, appearance);
    apps.push(app);
    const cdp = await x.until("MOSS Code's DevTools port", 120_000, async () => {
      if (!x.alive(app.proc)) x.fail(`MOSS Code exited: ${x.readLog(app.log).trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
      try { return await Cdp.connect(port); } catch { return undefined; }
    }, 500);
    cdps.push(cdp);
    code = new Doc(x, cdp, (u) => u === "moss-core://app/", "MOSS Code's root");
    const s: Ctx = { x, c, cdp, appearance, renders, apps, cdps, startedMoss: undefined, stop: () => { stopWatching = true; } };
    await row(CANVAS_START_STEP, () => startRow(s));
    await row(CANVAS_START_SESSION_STEP, () => sessionRow(s));
    await row(CANVAS_CORNER_STEP, () => cornerRow(s));
    await row(CANVAS_OPEN_IN_STEP, () => openInRow(s));
    // Lane CP's rows: the fixture removed and the canvas switched on again, the start page once more.
    await x.removeFixture(c);
    await c.request("plugin.setEnabled", { id: "moss/canvas", enabled: true }, 60_000);
    const cp: CpState = {};
    await row(CANVAS_PLUS_STEP, () => plusRow(s, cp));
    await row(CANVAS_BACK_STEP, () => backRow(s, cp));
    await row(CANVAS_LINE_STEP, () => lineRow(s, cp));
    await row(CANVAS_BLOCK_STEP, () => blockRow(s, cp));
    await row(CANVAS_GLASS_STEP, () => glassRow(s, cp));
  } catch (err) {
    const why = `the canvas unit's app couldn't be started and driven: ${x.why(err)}`;
    for (const name of CANVAS_APP_STEPS) if (!done.has(name)) x.record(name, x.statusOf(err), why);
  } finally {
    stopWatching = true;
    for (const d of cdps) d.close();
    for (const a of apps) await x.endChild(a.proc);
  }
}

interface Ctx {
  x: CanvasAppUnitCtx;
  c: MossClient;
  cdp: Cdp;
  appearance: string;
  renders: string | undefined;
  apps: { proc: ChildProcess; log: string }[];
  cdps: Cdp[];
  startedMoss: { doc: Doc } | undefined;
  /** MOSS's DevTools, once CA's row 4 started it. */
  mossCdp?: Cdp;
  stop(): void;
}

/** A document of MOSS Code's window by its URL: the shell's own (the root, moss-core://app/) or a plugin's layer. */
const layerDoc = (s: Ctx, id: string, name: string): Doc => new Doc(s.x, s.cdp, (u) => u.startsWith(`moss-plugin://${id}/`), name);
const rootDoc = (s: Ctx): Doc => new Doc(s.x, s.cdp, (u) => u === "moss-core://app/", "MOSS Code's root");

/** Every document that has an element: the shell's parts and a plugin's are in different frames of one window. */
async function anyDoc(s: Ctx, selector: string): Promise<Doc | undefined> {
  for (const d of await s.cdp.documents()) {
    const has = await s.cdp.evaluate(d.session, `!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
    if (has === true) return new Doc(s.x, s.cdp, (u) => u === d.url, `the document holding ${selector}`);
  }
  return undefined;
}
async function waitDoc(s: Ctx, what: string, selector: string, ms = 60_000): Promise<Doc> {
  return s.x.until(what, ms, () => anyDoc(s, selector), 400);
}

interface MarkRow { id: string; kind: string | null; src: string | null; paint: string }
/** Each agent row's mark as the window draws it: its kind (`icon` image, `mask` glyph, `letter`), and for a mask the colour it is painted in. */
async function marksIn(doc: Doc, rowSelector: string, idOf: string): Promise<MarkRow[]> {
  return doc.eval<MarkRow[]>(`[...document.querySelectorAll(${JSON.stringify(rowSelector)})].map((r) => { const m = r.querySelector('[data-agent-mark]'); return { id: ${idOf}, kind: m ? m.getAttribute('data-agent-mark') : null, src: m && m.tagName === 'IMG' ? m.getAttribute('src') : null, paint: m ? getComputedStyle(m).backgroundImage + ' ' + getComputedStyle(m).backgroundColor : '' }; })`);
}

function checkMarks(s: Ctx, where: string, marks: MarkRow[]): string {
  const by = new Map(marks.map((m) => [m.id, m]));
  const need = (id: string, kind: string): MarkRow => {
    const m = by.get(id);
    if (m === undefined) s.x.fail(`${where}: no row for ${id} (rows: ${marks.map((x) => x.id).join(", ")})`);
    if (m!.kind !== kind) s.x.fail(`${where}: ${id}'s mark is ${m!.kind}, not ${kind}`);
    return m!;
  };
  // MOSS's own agent: a face (an image: no colour in its SVG), claude-code's pixel mascot (an image), gemini's PNG (an image).
  need("moss-code", "icon");
  need("claude-code", "icon");
  const gemini = need("gemini", "icon");
  if (!(gemini.src ?? "").startsWith("data:image/png;base64,")) s.x.fail(`${where}: gemini's mark isn't its PNG`);
  // Codex's one-colour glyph is painted in its blue-violet (#484FF6 to #7893F9); Cursor's, Devin's and Grok's have no colour: the text's.
  const codex = need("codex", "mask");
  if (!/rgb\(72, 79, 246\)/.test(codex.paint)) s.x.fail(`${where}: codex's glyph isn't painted in its blue-violet (${codex.paint.slice(0, 120)})`);
  for (const id of ["cursor", "devin", "grok"]) {
    const m = need(id, "mask");
    if (/gradient/.test(m.paint)) s.x.fail(`${where}: ${id}'s glyph has a colour of its own (${m.paint.slice(0, 80)})`);
  }
  need("antigravity", "icon");
  need("deepseek", "icon");
  return `${marks.length} agent rows with marks (${marks.map((m) => `${m.id}:${m.kind}`).join(", ")})`;
}

async function startRow(s: Ctx): Promise<string> {
  // A fresh home: the bundled canvas is the start page; the shell's own new-session page (the fallback) shows nowhere.
  const canvas = await waitDoc(s, "the canvas start page", "section.cv", 90_000);
  if (await anyDoc(s, ".cl-new-session") !== undefined) s.x.fail("the shell's own new-session page shows beside the canvas");
  // Its + panel draws each agent's mark.
  await canvas.click(".cv-plus");
  await canvas.waitFor("the + panel's agent chips", "document.querySelectorAll('.cv-panel [data-agent] [data-agent-mark]').length >= 9", 60_000);
  const canvasMarks = await marksIn(canvas, ".cv-panel [data-agent]", "r.getAttribute('data-agent')");
  const canvasNote = checkMarks(s, "the canvas's + panel", canvasMarks);
  const pictures = await picture(s, canvas, "canvas-plus-panel", "moss-code-canvas-plus");
  await canvas.eval("document.querySelector('.cv-panel')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) ?? true");
  // The canvas switched off (the real plugin.setEnabled) and no other plugin filling `start`: the shell's own new-session
  // page is the start page, a mark on each agent row, and a session starts from it (a last start first, for its folder).
  const computer = await computerOf(s.c);
  mkdirSync(join(s.x.userHome, "shell-work"), { recursive: true });
  await s.c.request("agent.start", { backend: "moss-code", computer, root: `home/${computer}/shell-work`, model: s.x.keyedModel }, 60_000);
  await s.c.request("plugin.setEnabled", { id: "moss/canvas", enabled: false }, 60_000);
  const shellPage = await waitDoc(s, "the shell's own new-session page", ".cl-new-session__agent", 90_000);
  if (await anyDoc(s, "section.cv") !== undefined) s.x.fail("the canvas still shows after it was switched off");
  await shellPage.waitFor("the shell page's agent rows", "document.querySelectorAll('.cl-new-session__agent [data-agent-mark]').length >= 9", 60_000);
  const shellNote = checkMarks(s, "the shell's new-session page", await marksIn(shellPage, ".cl-new-session__agent", "r.querySelector('input').value"));
  const before = new Set((await s.c.request<{ sessions: SessionView[] }>("session.list", {})).sessions.map((v) => v.id));
  await shellPage.click(".cl-new-session__recent-folder", "shell-work");
  await shellPage.click(".cl-new-session__start");
  const started = await s.x.until("the session the shell's page started", 60_000, async () => (await s.c.request<{ sessions: SessionView[] }>("session.list", {})).sessions.find((v) => !before.has(v.id) && v.kind === "coding"), 400);
  if (!(started.root ?? "").endsWith("/shell-work")) s.x.fail(`the shell page's session is in ${started.root}, not shell-work`);
  await waitDoc(s, "the shell page's session's tab", ".cl-agent-tab", 60_000);
  // Back to the start page by the sidebar's New session: the shell's own page again.
  const side = await waitDoc(s, "the sidebar's New session", ".cl-sidebar__action", 30_000);
  await side.click(".cl-sidebar__action", "New session");
  await waitDoc(s, "the shell's own new-session page again", ".cl-new-session__agent", 30_000);
  // The fixture plugin installed: its entry keyed `start` is the start page (CA's rows drive it).
  await s.x.installFixture(s.c);
  const page = await waitDoc(s, "the plugin's start page", "[data-canvas-start]", 90_000);
  if (await anyDoc(s, "section.cv") !== undefined) s.x.fail("the canvas still shows beside the installed plugin's start page");
  if (await anyDoc(s, ".cl-new-session") !== undefined) s.x.fail("the shell's own new-session page shows beside the plugin's start page");
  await page.waitFor("the plugin's agent rows", "document.querySelectorAll('[data-canvas-agent] [data-agent-mark]').length >= 9", 60_000);
  const pluginMarks = await marksIn(page, "[data-canvas-agent]", "r.getAttribute('data-canvas-agent')");
  const pluginNote = checkMarks(s, "the plugin's start page", pluginMarks);
  // An agent whose plugin ships no mark: the SDK's letter on a colour (the page's own sample of one).
  const fallback = await page.eval<string | null>("document.querySelector('[data-canvas-fallback] [data-agent-mark]')?.getAttribute('data-agent-mark') ?? null");
  if (fallback !== "letter") s.x.fail(`an agent with no icon isn't drawn with the fallback letter mark (it is ${fallback})`);
  pictures.push(...await picture(s, page, "canvas-start-page", "moss-code-start-page"));
  // A bot's face drawn by BotFace in MOSS Code (its own drawing of the same name, as MOSS draws hers: a canvas).
  const face = await page.eval<boolean>("!!document.querySelector('[data-canvas-bot-face] canvas')");
  if (!face) s.x.fail("BotFace drew no face in MOSS Code");
  return `a fresh home: the canvas is the start page and the shell's own page shows nowhere, its + panel ${canvasNote}; the canvas switched off: the shell's own new-session page, ${shellNote}, started ${started.id} in shell-work and the sidebar's New session came back to it; the fixture plugin's start entry installed: it is the start page, ${pluginNote}; an agent with no icon is the letter mark; BotFace drew a face${pictures.length > 0 ? `; pictures: ${pictures.length}` : ""}`;
}

/** A render of the window in light and dark (a picture, never a check). */
async function picture(s: Ctx, doc: Doc, _what: string, name: string): Promise<string[]> {
  if (s.renders === undefined) return [];
  const root = rootDoc(s);
  return root.picture(s.renders, name, ["light", "dark"], async (scheme) => { writeFileSync(s.appearance, scheme); await sleep(600); }).then((r) => { void doc; return r; });
}

interface SessionView { id: string; kind: string; model?: string; effort?: string; root?: string; backend?: string }

async function sessionRow(s: Ctx): Promise<string> {
  const { x, c } = s;
  const computer = (await c.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
  if (computer === undefined) x.fail("computer.list lists no computer");
  // A recent folder for the page to offer: the person's own start (the app's way, over the run's `app` client) in a folder of their home.
  mkdirSync(join(x.userHome, "canvas-work"), { recursive: true });
  const first = (await c.request<{ session: string }>("agent.start", { backend: "moss-code", computer, root: `home/${computer}/canvas-work`, model: x.keyedModel }, 60_000)).session;
  const recent0 = await c.request<{ backend?: string; roots: { root: string }[] }>("agent.recent", {});
  if (recent0.backend !== "moss-code" || recent0.roots[0]?.root !== `home/${computer}/canvas-work`) x.fail(`agent.recent after a start isn't that start: ${JSON.stringify(recent0)}`);
  const options = await c.request<{ backend: string; known: boolean; source: string; models: { id: string; efforts: string[] }[]; default?: { model: string } }>("agent.options", { backend: "moss-code" });
  if (!options.known || options.models.length === 0) x.fail(`agent.options for MOSS's agent lists no model: ${JSON.stringify(options).slice(0, 300)}`);
  // The window is at the start page (the plugin's): its button starts a session through the door.
  const page = await waitDoc(s, "the plugin's start page", "[data-canvas-start]", 60_000);
  const before = new Set((await c.request<{ sessions: SessionView[] }>("session.list", {})).sessions.map((v) => v.id));
  await page.click("[data-canvas-go]");
  // The window takes the new session's tab at once, so the page is gone before it can say anything: the engine's list is the answer.
  const made = await x.until("the new session in the engine's list", 30_000, async () => (await c.request<{ sessions: SessionView[] }>("session.list", {})).sessions.find((v) => !before.has(v.id) && v.kind === "coding"), 400);
  const wantModel = options.models.find((m) => m.id !== options.default?.model && m.efforts.length > 0) ?? options.models[0]!;
  const wantEffort = wantModel.efforts[wantModel.efforts.length - 1];
  const detail = (await c.request<{ session: SessionView }>("session.get", { id: made.id })).session;
  if (detail.model !== wantModel.id) x.fail(`the session runs on ${detail.model}, not the model the page chose (${wantModel.id})`);
  if (wantEffort !== undefined && detail.effort !== wantEffort) x.fail(`the session's effort is ${detail.effort}, not the page's ${wantEffort}`);
  if (detail.root === undefined || !detail.root.endsWith("/canvas-work")) x.fail(`the session's folder isn't the recent one: ${detail.root}`);
  // The window shows that session's tab.
  await waitDoc(s, "the new session's tab", ".cl-agent-tab", 60_000);
  // The first message is the user's own.
  await c.request("session.attach", { id: made.id }).catch(() => undefined);
  const history = await x.until("the first message in the session", 60_000, async () => {
    const h = await c.request<{ events: { type: string; text?: string; from?: string; source?: string }[] }>("session.history", { id: made.id, limit: 200 });
    return h.events.find((e) => e.type === "user_message" && (e.text ?? "").includes("ACCEPTANCE-CANVAS-FIRST"));
  }, 500);
  void first;
  const recent = await c.request<{ backend?: string; model?: string; effort?: string; roots: { root: string }[] }>("agent.recent", {});
  if (recent.backend !== "moss-code" || recent.model !== wantModel.id || (wantEffort !== undefined && recent.effort !== wantEffort) || recent.roots[0]?.root !== `home/${computer}/canvas-work`) x.fail(`agent.recent doesn't offer the start: ${JSON.stringify(recent)}`);
  if (JSON.stringify(recent).includes(x.userHome)) x.fail("agent.recent carries an absolute path");
  return `the page's Start (model ${wantModel.id}, effort ${wantEffort ?? "none"}, a recent-folder token, a first message) started ${made.id} on ${detail.model} at ${detail.effort ?? "no effort"} in canvas-work; the window opened its tab; the first message arrived as the user's (${history.type}); agent.recent: ${recent.backend} ${recent.model} ${recent.effort ?? ""}, folders ${recent.roots.length}`;
}

async function cornerRow(s: Ctx): Promise<string> {
  const { x } = s;
  const tab = await waitDoc(s, "the session tab's corner control", "[data-canvas-corner]", 60_000);
  const info = await tab.eval<{ session: string; kind: string }>("(() => { const b = document.querySelector('[data-canvas-corner]'); return { session: b.getAttribute('data-canvas-corner'), kind: b.getAttribute('data-canvas-kind') }; })()");
  if (info.session === "") x.fail("the corner control wasn't given its session");
  if (info.kind !== "coding") x.fail(`the corner control was given kind ${info.kind}, not coding`);
  await tab.click("[data-canvas-corner]");
  await waitDoc(s, "the start page again", "[data-canvas-start]", 60_000);
  const tabGone = (await anyDoc(s, ".cl-agent-tab")) === undefined;
  if (!tabGone) x.fail("the session's tab still shows after the corner control");
  return `the corner control was given session ${info.session} of kind ${info.kind}; pressing it returned the window to the start page (the session's tab left)`;
}

async function openInRow(s: Ctx): Promise<string> {
  const { x } = s;
  const marker = join(x.launchDir, "open-moss");
  rmSync(marker, { force: true });
  const page = await waitDoc(s, "the plugin's start page", "[data-canvas-start]", 60_000);
  // The run answers the engine's request to start MOSS: it starts its own MOSS from source when the marker appears.
  let moss: { proc: ChildProcess; log: string } | undefined;
  let mossCdp: Cdp | undefined;
  const watch = (async () => {
    while (!existsSync(marker)) await sleep(150);
    const port = x.freePort();
    moss = x.startMossApp(port);
    s.apps.push(moss);
    mossCdp = await x.until("MOSS's DevTools port", 120_000, async () => { try { return await Cdp.connect(port); } catch { return undefined; } }, 400);
    s.cdps.push(mossCdp);
    s.mossCdp = mossCdp;
  })();
  watch.catch(() => undefined);
  await page.click("[data-canvas-openin]");
  const result = await page.waitFor<string>("the page's answer to Open in MOSS", "document.querySelector('[data-canvas-opened]')?.textContent || null", 180_000);
  if (!existsSync(marker)) x.fail(`the engine never asked for MOSS to start (the page says: ${result})`);
  if (!/^opened started/.test(result)) x.fail(`Open in MOSS answered "${result}", not that it opened after starting MOSS`);
  await watch;
  const mossDoc = new Doc(x, mossCdp!, (u) => u.startsWith("moss-app://app/"), "MOSS's window");
  const shown = await mossDoc.waitFor<string>("MOSS showing the bot's conversation", "document.querySelector('[data-bot-row=alpha][aria-current=true]') ? 'alpha' : null", 60_000);
  const pictures: string[] = [];
  if (s.renders !== undefined) pictures.push(...await mossDoc.picture(s.renders, "moss-bot-face-and-conversation", ["light", "dark"]));
  return `with MOSS not running, the page's Open in MOSS made the engine ask for it (marker open-moss), the run started MOSS from source, and the engine's app.show opened the bot's conversation (${shown} selected); the page was told "${result}"${pictures.length > 0 ? `; pictures: ${pictures.length}` : ""}`;
}

export type { Status };

// -------------------------------------------------------------------------------------------------
// Lane CP's rows: the canvas plugin itself, on the real engine
// -------------------------------------------------------------------------------------------------

interface CpState { made?: string; other?: string }

const canvasDoc = (s: Ctx, what = "the canvas start page") => waitDoc(s, what, "section.cv", 60_000);
// In view: inside the viewport and below the window's bar (the canvas runs up under the bar; nothing counts as shown under it).
const inView = (id: string) => `(() => { const v = document.querySelector('.cv-viewport')?.getBoundingClientRect(); const bar = document.querySelector('.cl-window__bar')?.getBoundingClientRect(); const b = document.querySelector(${JSON.stringify(`[data-block="${id}"]`)})?.getBoundingClientRect(); const top = Math.max(v?.top ?? 0, bar?.bottom ?? 0); return !!v && !!b && b.left >= v.left && b.right <= v.right && b.top >= top && b.bottom <= v.bottom; })()`;

/** Brings a block into view the person's way: the wheel pans the canvas toward it (there is no Fit control). */
async function bringIntoView(s: Ctx, canvas: Doc, id: string): Promise<void> {
  const doc = await canvas.session();
  const vp = await s.cdp.centerOf(doc, ".cv-viewport");
  if (vp === undefined) s.x.fail("no canvas viewport");
  for (let i = 0; i < 20 && !(await canvas.eval<boolean>(inView(id))); i++) {
    const d = await canvas.eval<{ dx: number; dy: number }>(`(() => { const v = document.querySelector('.cv-viewport').getBoundingClientRect(); const bar = document.querySelector('.cl-window__bar')?.getBoundingClientRect(); const top = Math.max(v.top, bar?.bottom ?? 0); const b = document.querySelector(${JSON.stringify(`[data-block="${id}"]`)}).getBoundingClientRect(); return { dx: (b.left + b.width / 2) - (v.left + v.width / 2), dy: (b.top + b.height / 2) - (top + (v.bottom - top) / 2) }; })()`);
    await s.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: vp!.x, y: vp!.y, deltaX: Math.max(-400, Math.min(400, d.dx)), deltaY: Math.max(-400, Math.min(400, d.dy)) }, doc);
    await sleep(150);
  }
  await canvas.waitFor(`${id}'s block in view`, inView(id), 10_000);
}

async function computerOf(c: MossClient): Promise<string> {
  const computer = (await c.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
  if (computer === undefined) throw new Error("computer.list lists no computer");
  return computer;
}

/** Row 5: the canvas is the start page; + creates a session with what it preselects and opens its tab. */
async function plusRow(s: Ctx, cp: CpState): Promise<string> {
  const { x, c } = s;
  const canvas = await canvasDoc(s);
  if (await anyDoc(s, ".cl-new-session") !== undefined) x.fail("the shell's own new-session page shows beside the canvas");
  // What + preselects is the last start (agent.recent): the agent, its model and effort, the folder.
  const recent = await c.request<{ backend?: string; model?: string; effort?: string; roots: { root: string }[] }>("agent.recent", {});
  if (recent.backend === undefined || recent.roots[0] === undefined) x.fail(`agent.recent offers no last start to preselect: ${JSON.stringify(recent)}`);
  // The bar's line and + come once the canvas has loaded its sessions (the page tells its line; until then nothing to press).
  await canvas.waitFor("the canvas's line and + on the window's bar", "!!document.querySelector('.cl-window__bar .cv-plus')", 60_000);
  // One bar: the window's own, its title the canvas's count of sessions, a plain + at its right end named New session; the canvas has no
  // bar of its own, no zoom buttons and no Fit, and runs up under the window's bar (frosted).
  const bar = await canvas.eval<{ bars: number; title: boolean; plus: { name: string | null; tip: string | null; text: string; right: number; barRight: number } | null; line: string | null; zoom: number; under: number | null; frost: string }>(`(() => {
    const bar = document.querySelector('.cl-window__bar'); const plus = bar?.querySelector('.cv-plus'); const line = bar?.querySelector('.cv-barline [role=status]');
    const cv = document.querySelector('section.cv'); const main = document.querySelector('.cl-window__main');
    return { bars: document.querySelectorAll('.cl-window__bar, .cv-bar').length, title: !!bar?.querySelector('.cl-window__title'),
      plus: plus ? { name: plus.getAttribute('aria-label'), tip: plus.getAttribute('title'), text: plus.textContent.trim(), right: plus.getBoundingClientRect().right, barRight: bar.getBoundingClientRect().right } : null,
      line: line ? line.textContent : null, zoom: [...document.querySelectorAll('button')].filter((b) => /zoom|^fit/i.test(b.getAttribute('aria-label') || b.textContent.trim())).length,
      under: cv && main ? Math.round(cv.getBoundingClientRect().top - main.getBoundingClientRect().top) : null, frost: bar ? getComputedStyle(bar).backdropFilter : '' }; })()`);
  if (bar.bars !== 1) x.fail(`the start page has ${bar.bars} bars, not one`);
  if (bar.title) x.fail("the window's bar still shows the shell's own title on the canvas");
  if (bar.plus === null) x.fail("no + on the window's bar");
  if (bar.plus!.name !== "New session" || bar.plus!.tip !== "New session" || bar.plus!.text !== "") x.fail(`the bar's + isn't a plain + named New session: ${JSON.stringify(bar.plus)}`);
  if (bar.plus!.barRight - bar.plus!.right > 24) x.fail(`the bar's + isn't at its right end (${Math.round(bar.plus!.barRight - bar.plus!.right)} px from it)`);
  if (bar.line === null || !/^(No sessions|\d+ sessions?)$/.test(bar.line)) x.fail(`the bar's line isn't the canvas's count: ${JSON.stringify(bar.line)}`);
  if (bar.zoom !== 0) x.fail(`${bar.zoom} zoom or Fit buttons still show`);
  if (bar.under !== 0) x.fail(`the canvas starts ${bar.under} px below the main column's top, not under the bar`);
  if (!/blur/.test(bar.frost)) x.fail(`the window's bar isn't frosted (backdrop-filter: ${bar.frost})`);
  const before = new Set((await c.request<{ sessions: SessionView[] }>("session.list", {})).sessions.map((v) => v.id));
  await canvas.click(".cv-plus");
  // Every step preselected: Create is ready at once, with nothing picked by hand.
  await canvas.waitFor("the + panel ready to create", "(() => { const b = document.querySelector('.cv-panel .cv-create'); return !!b && !b.disabled; })()", 60_000);
  const picked = await canvas.eval<string>("document.querySelector('.cv-panel [data-agent][aria-checked=true]')?.getAttribute('data-agent') ?? ''");
  if (picked !== recent.backend) x.fail(`+ preselected ${picked || "no agent"}, not the last start's ${recent.backend}`);
  await canvas.click(".cv-panel .cv-create");
  const made = await x.until("the new session in the engine's list", 60_000, async () => (await c.request<{ sessions: SessionView[] }>("session.list", {})).sessions.find((v) => !before.has(v.id) && v.kind === "coding"), 400);
  const detail = (await c.request<{ session: SessionView }>("session.get", { id: made.id })).session;
  if (detail.backend !== recent.backend) x.fail(`the new session runs ${detail.backend}, not ${recent.backend}`);
  if (recent.model !== undefined && detail.model !== recent.model) x.fail(`the new session runs on ${detail.model}, not the preselected ${recent.model}`);
  if (recent.effort !== undefined && detail.effort !== recent.effort) x.fail(`the new session's effort is ${detail.effort}, not the preselected ${recent.effort}`);
  if (detail.root !== recent.roots[0]!.root) x.fail(`the new session's folder is ${detail.root}, not the preselected ${recent.roots[0]!.root}`);
  await waitDoc(s, "the new session's tab", ".cl-agent-tab", 60_000);
  if (await anyDoc(s, "section.cv") !== undefined) x.fail("the canvas still shows: the window didn't open the new session's tab");
  cp.made = made.id;
  return `the canvas was the start page with one bar (the window's, frosted, the canvas under it): its line "${bar.line}" and a plain + at its right end; + preselected ${picked} (the last start), and Create started ${made.id} on ${detail.backend} ${detail.model ?? "(default model)"} at ${detail.effort ?? "no effort"} in ${detail.root}; the window opened its tab`;
}

/** Row 6: the tab's corner control returns to the canvas with that session's block in view. */
async function backRow(s: Ctx, cp: CpState): Promise<string> {
  const { x } = s;
  if (cp.made === undefined) x.fail("row 5 made no session to come back from");
  const tab = await waitDoc(s, "the canvas's corner control in the session's tab", ".cv-corner", 60_000);
  await tab.click(".cv-corner");
  const canvas = await canvasDoc(s, "the canvas again");
  await canvas.waitFor("the session's block on the canvas", `!!document.querySelector('[data-block="${cp.made}"]')`, 30_000);
  await canvas.waitFor("the session's block in view", inView(cp.made!), 10_000);
  if (await anyDoc(s, ".cl-agent-tab") !== undefined) x.fail("the session's tab still shows after the corner control");
  return `the corner control of ${cp.made}'s tab returned the window to the canvas with its block in view`;
}

/** Row 7: a message between two code sessions on their line; the line survives the canvas closing. */
async function lineRow(s: Ctx, cp: CpState): Promise<string> {
  const { x, c } = s;
  if (cp.made === undefined) x.fail("row 5 made no session");
  const computer = await computerOf(c);
  mkdirSync(join(x.userHome, "canvas-line"), { recursive: true });
  const other = (await c.request<{ session: string }>("agent.start", { backend: "moss-code", computer, root: `home/${computer}/canvas-line`, model: x.keyedModel }, 60_000)).session;
  cp.other = other;
  const canvas = await canvasDoc(s);
  await canvas.waitFor("both blocks on the canvas", `!!document.querySelector('[data-block="${cp.made}"]') && !!document.querySelector('[data-block="${other}"]')`, 60_000);
  // Watch the canvas for the message as it is drawn (it lasts about a second): the light on the line, both rings reacting.
  await canvas.eval(`(() => { const seen = window.__cpSeen = { msg: false, from: false, to: false, line: false };
    const look = () => {
      if (document.querySelector('.cv-msg .cv-mlight')) seen.msg = true;
      if (document.querySelector('[data-block="${cp.made}"] .cv-react')) seen.from = true;
      if (document.querySelector('[data-block="${other}"] .cv-react[data-morph]')) seen.to = true;
      if (document.querySelector('.cv-line[data-kind="peer"]')) seen.line = true;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true }); look(); return true; })()`);
  // The first session messages the second (its model scripted to call SendMessage), as the user asks it to.
  await c.request("session.attach", { id: cp.made }).catch(() => undefined);
  await c.request("session.send", { id: cp.made, message: { text: `ACCEPTANCE-CALL SendMessage ${JSON.stringify({ to: other, message: "CANVAS-LINE: the API moved to v2." })}`, clientMessageId: randomUUID() } }, 30_000);
  const seen = await canvas.waitFor<{ msg: boolean; from: boolean; to: boolean; line: boolean }>("the message drawn on the canvas", "(() => { const s = window.__cpSeen; return s && s.msg && s.from && s.to && s.line ? s : null; })()", 150_000)
    .catch(async (err: unknown) => { x.fail(`the message wasn't drawn: ${JSON.stringify(await canvas.eval("window.__cpSeen").catch(() => null))} (${x.why(err)})`); throw err; });
  const pairs = (await c.request<{ pairs: { from: { session?: string }; to: { session: string } }[] }>("session.links", {})).pairs;
  if (!pairs.some((p) => p.from.session === cp.made && p.to.session === other)) x.fail(`session.links keeps no pair from ${cp.made} to ${other}`);
  // Closed and opened again: into a session's tab and back by its corner control. The line is drawn from the record.
  await canvas.click(`[data-block="${other}"] .cv-head`);
  await canvas.click(`[data-block="${other}"] .cv-button`, "Open tab");
  const tab = await waitDoc(s, "the other session's tab", ".cv-corner", 60_000);
  await tab.click(".cv-corner");
  const again = await canvasDoc(s, "the canvas, opened again");
  await again.waitFor("the line between them, from the engine's record", `!!document.querySelector('.cv-line[data-kind="peer"]')`, 30_000);
  return `${cp.made}'s SendMessage to ${other} was drawn: the light on their line (${seen.msg}), ${cp.made}'s ring (${seen.from}) and ${other}'s ring turning from the sender's colour (${seen.to}); session.links keeps the pair, and the line was there again after the canvas was closed and opened`;
}

/** Row 8: a block's composer sends as the user; a bot's block opens "Open in MOSS". */
async function blockRow(s: Ctx, cp: CpState): Promise<string> {
  const { x, c } = s;
  if (cp.other === undefined) x.fail("row 7 made no second session");
  const canvas = await canvasDoc(s);
  await bringIntoView(s, canvas, cp.made!);
  // Real pointer events: a drag of one block a little past the drag's threshold, then one press on another opens it.
  const doc = await canvas.session();
  const from = await s.cdp.centerOf(doc, `[data-block="${cp.made}"] .cv-head`);
  if (from === undefined) x.fail("no head to drag");
  const mouse = (type: string, px: number, py: number, buttons: number) => s.cdp.send("Input.dispatchMouseEvent", { type, x: px, y: py, button: type === "mouseMoved" ? (buttons === 1 ? "left" : "none") : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 }, doc);
  await mouse("mouseMoved", from!.x, from!.y, 0);
  await mouse("mousePressed", from!.x, from!.y, 1);
  for (const d of [3, 6, 10, 14]) await mouse("mouseMoved", from!.x + d, from!.y + d / 2, 1);
  await mouse("mouseReleased", from!.x + 14, from!.y + 7, 0);
  await sleep(300);
  // The other block brought into view by the wheel (no press in between), then one press opens it.
  await bringIntoView(s, canvas, cp.other!);
  await canvas.click(`[data-block="${cp.other}"] .cv-head`);
  await canvas.waitFor("one press after a drag opening another block", `document.querySelector('[data-block="${cp.other}"]')?.hasAttribute('data-open') || null`, 5_000);
  const closeAll = () => canvas.eval("document.querySelector('section.cv').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await closeAll();
  // Enter on a focused block opens it (the keyboard's press: real key events).
  await canvas.eval(`document.querySelector('[data-block="${cp.made}"] .cv-head').focus()`);
  for (const type of ["keyDown", "keyUp"]) await s.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, doc);
  await canvas.waitFor("Enter on a focused block opening it", `document.querySelector('[data-block="${cp.made}"]')?.hasAttribute('data-open') || null`, 5_000);
  await closeAll();
  await canvas.click(`[data-block="${cp.other}"] .cv-head`);
  await canvas.type(`[data-block="${cp.other}"] .cv-composer__field`, "CANVAS-COMPOSER: from the canvas");
  await canvas.click(`[data-block="${cp.other}"] .cv-send`);
  await c.request("session.attach", { id: cp.other }).catch(() => undefined);
  const said = await x.until("the composer's words in the session as the user's", 60_000, async () => {
    const h = await c.request<{ events: { type: string; text?: string }[] }>("session.history", { id: cp.other, limit: 200 });
    return h.events.find((e) => (e.text ?? "").includes("CANVAS-COMPOSER"));
  }, 500);
  if (said.type !== "user_message") x.fail(`the composer's words arrived as ${said.type}, not the user's`);
  // A bot's block: Open in MOSS (MOSS runs: CA's row 4 started it).
  if (s.mossCdp === undefined) x.fail("MOSS isn't running (CA's row 4 starts it)");
  const bot = await canvas.waitFor<string>("a bot's block", "document.querySelector('.cv-node[data-type=bot]')?.getAttribute('data-block') ?? null", 30_000);
  // The bot's block brought into view the person's way: the wheel pans the canvas.
  await bringIntoView(s, canvas, bot);
  await canvas.click(`[data-block="${bot}"] .cv-head`);
  await canvas.click(`[data-block="${bot}"] .cv-button`, "Open in MOSS");
  const mossDoc = new Doc(x, s.mossCdp!, (u) => u.startsWith("moss-app://app/"), "MOSS's window");
  const botId = bot.replace(/^bot:/, "");
  await mossDoc.waitFor("MOSS showing the bot's conversation", `!!document.querySelector('[data-bot-row="${botId}"][aria-current=true]')`, 60_000);
  return `after a real drag of ${cp.made}'s block one press opened ${cp.other}'s, and Enter on a focused block opened it; the composer of ${cp.other}'s block sent as the user (${said.type}); ${bot}'s block's Open in MOSS showed ${botId}'s conversation in MOSS`;
}

/** The sidebar's glass must let at least this much of a magenta ground through (the mean of R−G and B−G, 0 to 255): a 70%
 *  tint (the base theme's before the owner's try 21, which read as solid) gives about 76; the 40% and 35% tints read 113 to
 *  166 (a source run here, a headless probe), so the bar sits between. */
export const GLASS_MIN = 95;
/** And the main column none of it (it paints its own surface). */
export const MAIN_MAX = 8;
/** With nothing painted, the sidebar's alpha where the capture keeps it: at most this (a 70% tint is 179; 40% is 102, 35% 89). */
export const GLASS_ALPHA_MAX = 150;

/** The magenta in one pixel: the mean of R−G and B−G. */
export const magentaOf = (p: readonly number[]): number => ((p[0]! - p[1]!) + (p[2]! - p[1]!)) / 2;

/** Row 9: a block half under the bar passes beneath it, frosted; what is behind the window shows through the sidebar, never the main column. */
async function glassRow(s: Ctx, cp: CpState): Promise<string> {
  const { x } = s;
  if (cp.made === undefined) x.fail("row 5 made no session");
  // Back on the canvas (row 8 ended in MOSS's window; MOSS Code's still shows the canvas).
  const canvas = await canvasDoc(s);
  await bringIntoView(s, canvas, cp.made!);
  // The block panned up until it is half under the bar: the bar's own box lies over it, and the block runs on beneath.
  const doc = await canvas.session();
  const vp = await s.cdp.centerOf(doc, ".cv-viewport");
  const under = async () => canvas.eval<{ over: number; topElement: string; frost: string; tint: string } | null>(`(() => {
    const bar = document.querySelector('.cl-window__bar').getBoundingClientRect(); const b = document.querySelector('[data-block="${cp.made}"]').getBoundingClientRect();
    const over = Math.min(b.bottom, bar.bottom) - Math.max(b.top, bar.top);
    const at = document.elementsFromPoint(b.left + b.width / 2, bar.top + bar.height / 2);
    const bs = getComputedStyle(document.querySelector('.cl-window__bar'));
    return { over: Math.round(over / b.height * 100), topElement: at.map((e) => e.closest('.cl-window__bar') ? 'bar' : e.closest('[data-block="${cp.made}"]') ? 'block' : '').filter(Boolean).join(','), frost: bs.backdropFilter, tint: bs.backgroundColor }; })()`);
  for (let i = 0; i < 20; i++) {
    const u = await under();
    if (u !== null && u.over >= 30 && u.over <= 70) break;
    const dy = await canvas.eval<number>(`(() => { const bar = document.querySelector('.cl-window__bar').getBoundingClientRect(); const b = document.querySelector('[data-block="${cp.made}"]').getBoundingClientRect(); return (b.top + b.height / 2) - bar.bottom; })()`);
    await s.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: vp!.x, y: vp!.y, deltaX: 0, deltaY: Math.max(-400, Math.min(400, dy)) }, doc);
    await sleep(150);
  }
  const u = await under();
  if (u === null || u.over < 30 || u.over > 70) x.fail(`the block couldn't be panned half under the bar (${JSON.stringify(u)})`);
  if (!u!.topElement.startsWith("bar,") || !u!.topElement.includes("block")) x.fail(`the block isn't beneath the bar where they meet (what is there, top first: ${u!.topElement})`);
  if (!/blur/.test(u!.frost)) x.fail(`the bar over the block isn't frosted (backdrop-filter: ${u!.frost})`);
  if (!/rgba\(.*, 0?\.\d+\)/.test(u!.tint)) x.fail(`the bar's tint is opaque (${u!.tint}): nothing beneath could show`);
  // The window's material (the see-through sidebar over the desktop) is macOS's vibrancy; Linux has none (spec: no window material off
  // macOS), so there the row ends here, with the bar's frost and tint, which are CSS and checked above, said as what was checked.
  if (onLinux()) return notOnLinux("the window's glass (a see-through sidebar over what is behind the window, in light and dark) is macOS's window material, which Linux has no counterpart of", `${cp.made}'s block panned ${u!.over}% under the bar ran on beneath it (the bar on top, ${u!.frost}, ${u!.tint})`);
    // The sidebar: magenta painted on the window's root document (the layer right above macOS's material, in place of the
  // clear one), in light and dark; sampled in the sidebar's empty margin and in the main column.
  const root = rootDoc(s);
  const rootSession = await root.session();
  const notes: string[] = [];
  try {
    // First with nothing painted: where the capture keeps the window's clear backing (alpha), the sidebar is see-through
    // (an opaque layer anywhere under it, in either scheme, shows as alpha 255) and the main column opaque.
    for (const scheme of ["light", "dark"] as const) {
      writeFileSync(s.appearance, scheme);
      await canvas.waitFor(`the window in ${scheme}`, `matchMedia('(prefers-color-scheme: dark)').matches === ${scheme === "dark"}`, 10_000);
      await sleep(600);
      const box = await canvas.eval<{ sidebar: { x: number; y: number; w: number; h: number }; main: { x: number; y: number; w: number; h: number }; dpr: number }>(`(() => { const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }; return { sidebar: r('.cl-window__sidebar'), main: r('.cl-window__main'), dpr: devicePixelRatio }; })()`);
      const img = readPng(Buffer.from((await s.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, rootSession)).data, "base64"));
      if (img.bpp !== 4) { notes.push(`${scheme} unpainted: the capture keeps no alpha here`); continue; }
      const alpha = (px0: number, py0: number) => img.rows[Math.round(py0 * box.dpr)]![Math.round(px0 * box.dpr) * 4 + 3]!;
      const side = alpha(box.sidebar.x + 3, box.sidebar.y + box.sidebar.h * 0.6);
      const main = alpha(box.main.x + box.main.w - 6, box.main.y + box.main.h * 0.5);
      if (side > GLASS_ALPHA_MAX) x.fail(`in ${scheme}, with nothing painted, the sidebar is ${side === 255 ? "opaque" : "too nearly opaque"} (alpha ${side}, at most ${GLASS_ALPHA_MAX}): something under it hides the window's material`);
      if (main !== 255) x.fail(`in ${scheme}, the main column isn't opaque (alpha ${main})`);
      notes.push(`${scheme} unpainted: sidebar alpha ${side}, main column ${main}`);
    }
    await root.eval("(() => { document.body.style.setProperty('background', '#FF00FF', 'important'); return true; })()");
    for (const scheme of ["light", "dark"] as const) {
      writeFileSync(s.appearance, scheme);
      await canvas.waitFor(`the window in ${scheme}`, `matchMedia('(prefers-color-scheme: dark)').matches === ${scheme === "dark"}`, 10_000);
      await sleep(600);
      const box = await canvas.eval<{ sidebar: { x: number; y: number; w: number; h: number }; main: { x: number; y: number; w: number; h: number }; translucent: boolean; dpr: number }>(`(() => { const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }; return { sidebar: r('.cl-window__sidebar'), main: r('.cl-window__main'), translucent: document.querySelector('.cl-window').hasAttribute('data-translucent'), dpr: devicePixelRatio }; })()`);
      if (!box.translucent) x.fail(`the window has no material in ${scheme} (data-translucent isn't set)`);
      const shot = await s.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, rootSession);
      const png = Buffer.from(shot.data, "base64");
      writeFileSync(join(x.logs, `canvas-glass-${scheme}.png`), png);
      const img = readPng(png);
      const px = (px0: number, py0: number) => { const row = img.rows[Math.round(py0 * box.dpr)]!; const i = Math.round(px0 * box.dpr) * img.bpp; return [row[i]!, row[i + 1]!, row[i + 2]!]; };
      const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
      // The sidebar's left margin (no row is drawn there), down its lower two thirds; the main column at its right edge, mid-height.
      const side = median(Array.from({ length: 15 }, (_, i) => magentaOf(px(box.sidebar.x + 3, box.sidebar.y + box.sidebar.h * (0.33 + i * 0.04)))));
      const main = median(Array.from({ length: 9 }, (_, i) => Math.abs(magentaOf(px(box.main.x + box.main.w - 6, box.main.y + box.main.h * (0.3 + i * 0.05))))));
      if (side < GLASS_MIN) x.fail(`in ${scheme}, the sidebar lets too little of what is behind the window through (magenta ${side.toFixed(0)}, at least ${GLASS_MIN}; picture: logs/canvas-glass-${scheme}.png)`);
      if (main > MAIN_MAX) x.fail(`in ${scheme}, what is behind the window shows through the main column (magenta ${main.toFixed(0)}; picture: logs/canvas-glass-${scheme}.png)`);
      notes.push(`${scheme}: sidebar ${side.toFixed(0)}, main column ${main.toFixed(0)}`);
    }
  } finally {
    await root.eval("(() => { document.body.style.removeProperty('background'); return true; })()").catch(() => undefined);
    writeFileSync(s.appearance, "");
  }
  return `${cp.made}'s block panned ${u!.over}% under the bar ran on beneath it (the bar on top, ${u!.frost}, ${u!.tint}); a magenta ground under the window's documents showed through the sidebar and not the main column (${notes.join("; ")}; at least ${GLASS_MIN} and at most ${MAIN_MAX})`;
}
