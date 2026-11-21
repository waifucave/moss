// The session canvas's acceptance rows of lane CA (spec revision 20, §9.5; the `canvas-app` unit, a home of its own; lane CM's row is in canvas-step.ts): MOSS Code from source over its own home,
// `main` entry keyed `start` (lane CA's rows here use a fixture plugin, `fixtures/acceptance-canvas`, until the canvas plugin of lane CP
// has its own). Lanes CG, CM and CP add their rows to this table beside CA's.
//
// CA's rows, in order on one home (each drives MOSS Code's window through its DevTools port, with trusted clicks, and reads the engine's
// answers beside what the window shows):
//   1. the start page: with no plugin's `start` entry the shell draws its own new-session page, each agent's row carrying its plugin's
//      mark (the nine agent plugins ship theirs; MOSS's own coding agent has MOSS's face on coral); the fixture plugin installed, its
//      entry is the start page;
//   2. a start through the app's door: the page's button starts a session with a model, an effort, a recent folder and a first message,
//      the window opens that session's tab, the engine says the session runs on that model and effort, the first message is the
//      user's own, and `agent.recent` then offers them;
//   3. the corner control of the session's tab returns to the start page;
//   4. "Open in MOSS": MOSS isn't running, so the engine asks for it to start (a marker the run answers by starting its own MOSS from
//      source), and MOSS opens the bot's conversation.
//
// With MOSS_ACCEPT_RENDERS set, the start pages are pictured in light and dark, and a bot's face drawn by BotFace in MOSS Code beside
// MOSS's own drawing (a render, never a check).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Cdp } from "./cdp";
import type { MossClient } from "./client";
import { Doc, type SetupUnitCtx } from "./setup-step";
import type { Status } from "./steps";

export const CANVAS_START_STEP = "the start page: with no plugin's `start` entry the shell draws its own new-session page, each agent's row carrying its plugin's mark (MOSS's own agent MOSS's face on coral, the nine agent plugins theirs, a one-colour glyph drawn in its agent's colour); with a plugin's `main` entry keyed `start` installed, that entry is the start page, drawing the same marks and, for an agent with none, the first letter on a colour";
export const CANVAS_START_SESSION_STEP = "a start through the app's door from the start page's button: a model, an effort, a recent folder (a token, never a path) and a first message; the window opens the new session's tab, the engine says it runs on that model and effort, the first message is the user's own, and agent.recent then offers that agent, model, effort and folder";
export const CANVAS_CORNER_STEP = "a session tab's top corner holds a plugin's control (the `session.corner` spot, given the session and its kind): pressing it returns the window to the start page";
export const CANVAS_OPEN_IN_STEP = "\"Open in MOSS\" from a part of MOSS Code with MOSS not running: the engine is asked to start MOSS (it starts nothing itself in the run: a marker, answered by the run starting its own MOSS from source), and MOSS opens the bot's conversation";
export const CANVAS_APP_STEPS: readonly string[] = [CANVAS_START_STEP, CANVAS_START_SESSION_STEP, CANVAS_CORNER_STEP, CANVAS_OPEN_IN_STEP];

export interface CanvasAppUnitCtx extends Pick<SetupUnitCtx, "root" | "logs" | "userHome" | "driver" | "startCodeApp" | "startMossApp" | "freePort" | "endChild" | "alive" | "readLog" | "until" | "fail" | "record" | "statusOf" | "why"> {
  /** The folder the run's engine leaves its `open-moss` marker in (MOSS_ACCEPTANCE_LAUNCH_DIR). */
  launchDir: string;
  /** Installs the fixture plugin (`fixtures/acceptance-canvas`) and answers its OK card, over the run's client. */
  installFixture(c: MossClient): Promise<void>;
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
  // No plugin's `start` entry yet: the shell's own new-session page, the window's start (no code session exists).
  const shell = await waitDoc(s, "the shell's own new-session page", ".cl-new-session__agent", 90_000);
  await shell.waitFor("the agent rows", "document.querySelectorAll('.cl-new-session__agent [data-agent-mark]').length >= 9", 60_000);
  const shellMarks = await marksIn(shell, ".cl-new-session__agent", "r.querySelector('input').value");
  const shellNote = checkMarks(s, "the shell's new-session page", shellMarks);
  const pictures = await picture(s, shell, "canvas-new-session", "moss-code-new-session");
  // The fixture plugin installed: its entry keyed `start` is the start page, and the shell's own page is gone.
  await s.x.installFixture(s.c);
  const page = await waitDoc(s, "the plugin's start page", "[data-canvas-start]", 90_000);
  if (await anyDoc(s, ".cl-new-session") !== undefined) s.x.fail("the shell's own new-session page still shows beside the plugin's start page");
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
  return `no plugin entry: the shell's own page, ${shellNote}; the fixture plugin's start entry installed: it is the start page and the shell's own is gone, ${pluginNote}; an agent with no icon is the letter mark; BotFace drew a face${pictures.length > 0 ? `; pictures: ${pictures.length}` : ""}`;
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
