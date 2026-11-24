// Pictures of every page, for the owner to judge the site by: each page and state at 390, 820 and 1440 pixels wide,
// light and dark, plus one contact sheet per theme for the landing page and one for the docs. It also writes
// requests.json: every address each page asked the browser for, which is the proof that the site loads nothing from
// another host.
//
//   bun scripts/render.ts --out <folder> [--browser <chrome-headless-shell>]
//
// It runs a headless browser, never one with a window: Chromium's headless shell (a plain program, no app bundle,
// so nothing shows in the Dock), with a throwaway profile folder it deletes afterwards. It drives the browser over the
// DevTools protocol on a pipe-free local port, and it stops only the browser it started. It never runs in CI: the
// browser is found on this computer (Playwright's cache, where a lane's gallery put one) or named with --browser.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSite } from "../src/build";
import { readConfig, withSwitches } from "../src/config";
import { serveSite } from "../src/serve";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
if (process.env.CI !== undefined) throw new Error("render: not in CI (it runs a browser)");
const OUT = resolve(arg("--out") ?? "");
if (arg("--out") === undefined) throw new Error("usage: bun scripts/render.ts --out <folder> [--browser <path>]");

function findBrowser(): string {
  const named = arg("--browser") ?? process.env.MOSS_SITE_BROWSER;
  if (named !== undefined) return named;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  const shells = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse() : [];
  for (const d of shells) {
    for (const sub of readdirSync(join(cache, d))) {
      const p = join(cache, d, sub, "chrome-headless-shell");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("render: no chrome-headless-shell found; name one with --browser");
}

// ---------------------------------------------------------------- a small DevTools protocol client

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  #listeners: ((m: { method: string; params: Record<string, unknown>; sessionId?: string }) => void)[] = [];
  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (m.id !== undefined) {
        const p = this.#pending.get(m.id);
        this.#pending.delete(m.id);
        if (m.error !== undefined) p?.fail(new Error(m.error.message));
        else p?.ok(m.result);
      } else if (m.method !== undefined) for (const l of this.#listeners) l({ method: m.method, params: m.params ?? {}, ...(m.sessionId !== undefined ? { sessionId: m.sessionId } : {}) });
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => ok(new Cdp(ws)));
      ws.addEventListener("error", () => fail(new Error(`render: couldn't reach the browser at ${url}`)));
    });
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.#id;
    return new Promise<T>((ok, fail) => {
      this.#pending.set(id, { ok: ok as (v: unknown) => void, fail });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId !== undefined ? { sessionId } : {}) }));
    });
  }
  on(fn: (m: { method: string; params: Record<string, unknown>; sessionId?: string }) => void): () => void {
    this.#listeners.push(fn);
    return () => { this.#listeners = this.#listeners.filter((l) => l !== fn); };
  }
  close(): void { this.#ws.close(); }
}

async function startBrowser(profile: string): Promise<{ cdp: Cdp; proc: ReturnType<typeof Bun.spawn> }> {
  const proc = Bun.spawn([findBrowser(),
    "--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    "--disable-extensions", "--no-pings", "--metrics-recording-only", "--force-color-profile=srgb", "--font-render-hinting=none",
    "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await Bun.sleep(50);
  if (!existsSync(portFile)) { proc.kill(); throw new Error("render: the browser didn't start"); }
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  return { cdp: await Cdp.open(`ws://127.0.0.1:${port}${path}`), proc };
}

// ---------------------------------------------------------------- one picture

interface Shot {
  file: string;
  url: string;
  width: number;
  theme: "light" | "dark";
  /** Only the top of the page, this tall (the opening), instead of the whole page. */
  height?: number;
  /** Only this element (a CSS selector). */
  element?: string;
}

const requests: Record<string, string[]> = {};
const overflow: string[] = [];

async function shoot(cdp: Cdp, s: Shot): Promise<void> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const seen: string[] = [];
  const off = cdp.on((m) => { if (m.sessionId === sessionId && m.method === "Network.requestWillBeSent") seen.push(String((m.params.request as { url: string }).url)); });
  const send = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => cdp.send<T>(method, params, sessionId);
  await send("Network.enable");
  await send("Page.enable");
  const scale = s.width <= 820 ? 2 : 1;
  const viewH = s.width <= 390 ? 844 : s.width <= 820 ? 1180 : 900;
  await send("Emulation.setDeviceMetricsOverride", { width: s.width, height: viewH, deviceScaleFactor: scale, mobile: s.width <= 820 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: s.theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
  const loaded = new Promise<void>((ok) => { const o = cdp.on((m) => { if (m.sessionId === sessionId && m.method === "Page.loadEventFired") { o(); ok(); } }); });
  await send("Page.navigate", { url: s.url });
  await loaded;
  // A page wider than the screen is a fault: say so.
  const over = await send<{ result: { value: number } }>("Runtime.evaluate", { returnByValue: true, expression: "document.documentElement.scrollWidth - innerWidth" });
  if (over.result.value > 0) overflow.push(`${s.file}: ${over.result.value}px wider than the screen`);
  // The whole page in the viewport at once, so every face is on screen and alive (the kit rests faces it can't see),
  // and every lazy picture loads; then wait for the pictures and for the faces to settle into their moods.
  if (s.height === undefined) {
    const full = await send<{ result: { value: number } }>("Runtime.evaluate", { returnByValue: true, expression: "document.documentElement.scrollHeight" });
    await send("Emulation.setDeviceMetricsOverride", { width: s.width, height: Math.min(full.result.value, 16000), deviceScaleFactor: scale, mobile: s.width <= 820 });
  }
  await send("Runtime.evaluate", { awaitPromise: true, expression: `(async () => { for (const i of document.images) i.loading = "eager"; await Promise.all([...document.images].map((i) => i.decode().catch(() => {}))); await new Promise((r) => setTimeout(r, 1600)); })()` });
  let clip: { x: number; y: number; width: number; height: number; scale: number };
  if (s.element !== undefined) {
    const r = await send<{ result: { value: { x: number; y: number; width: number; height: number } } }>("Runtime.evaluate", { returnByValue: true, expression: `(() => { const e = document.querySelector(${JSON.stringify(s.element)}); e.scrollIntoView(); const b = e.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height }; })()` });
    const b = r.result.value;
    clip = { x: 0, y: Math.max(0, b.y - 24), width: s.width, height: b.height + 48, scale: 1 };
  } else {
    const r = await send<{ result: { value: number } }>("Runtime.evaluate", { returnByValue: true, expression: "document.documentElement.scrollHeight" });
    clip = { x: 0, y: 0, width: s.width, height: s.height ?? r.result.value, scale: 1 };
  }
  await send("Runtime.evaluate", { expression: "scrollTo(0, 0)" });
  await Bun.sleep(120);
  const shot = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: s.height === undefined || s.element !== undefined, clip });
  writeFileSync(join(OUT, s.file), Buffer.from(shot.data, "base64"));
  off();
  requests[s.file] = seen;
  await cdp.send("Target.closeTarget", { targetId });
}

// ---------------------------------------------------------------- the run

const scratch = mkdtempSync(join(process.env.MOSS_SITE_SCRATCH ?? tmpdir(), "moss-site-render-"));
mkdirSync(OUT, { recursive: true });
const base = readConfig();
const builds = {
  unreleased: await buildSite({ out: join(scratch, "unreleased"), config: withSwitches(base, { state: "unreleased" }) }),
  released: await buildSite({ out: join(scratch, "released"), config: withSwitches(base, { state: "released" }) }),
};
const servers = Object.fromEntries(Object.entries(builds).map(([k, b]) => [k, serveSite(b.out)])) as Record<keyof typeof builds, { url: string; stop: () => void }>;
const profile = join(scratch, "profile");
mkdirSync(profile);
const { cdp, proc } = await startBrowser(profile);

const WIDTHS = [1440, 820, 390] as const;
const THEMES = ["light", "dark"] as const;
const shots: Shot[] = [];
const name = (path: string) => (path === "/" ? "landing" : path === "/404.html" ? "404" : path.replace(/^\/|\/$/g, "").replace(/\//g, "-"));
for (const theme of THEMES) for (const width of WIDTHS) {
  shots.push({ file: `landing-unreleased-${width}-${theme}.png`, url: `${servers.unreleased.url}/`, width, theme });
  shots.push({ file: `landing-released-${width}-${theme}.png`, url: `${servers.released.url}/`, width, theme });
  shots.push({ file: `landing-top-${width}-${theme}.png`, url: `${servers.unreleased.url}/`, width, theme, height: width === 390 ? 844 : width === 820 ? 1180 : 900 });
  shots.push({ file: `landing-bots-${width}-${theme}.png`, url: `${servers.unreleased.url}/`, width, theme, element: "#bots" });
  shots.push({ file: `landing-privacy-${width}-${theme}.png`, url: `${servers.unreleased.url}/`, width, theme, element: "#privacy" });
  shots.push({ file: `landing-download-unreleased-${width}-${theme}.png`, url: `${servers.unreleased.url}/`, width, theme, element: "#download" });
  shots.push({ file: `landing-download-released-${width}-${theme}.png`, url: `${servers.released.url}/`, width, theme, element: "#download" });
  for (const p of builds.unreleased.pages.filter((p) => p !== "/")) shots.push({ file: `${name(p)}-${width}-${theme}.png`, url: `${servers.unreleased.url}${p}`, width, theme });
}
console.log(`render: ${shots.length} pictures into ${OUT}`);
try {
  for (const s of shots) await shoot(cdp, s);

  // Contact sheets: one page of pictures per theme, screenshotted in the same browser.
  const sheet = (title: string, rows: { label: string; files: string[]; widths: number[] }[], theme: "light" | "dark") => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;padding:32px;font:14px -apple-system,system-ui,sans-serif;background:${theme === "dark" ? "#0c0c0c" : "#e9e9e9"};color:${theme === "dark" ? "#ddd" : "#222"}}
h1{font-size:20px;margin:0 0 20px}h2{font-size:14px;font-weight:600;margin:28px 0 10px}.row{display:flex;gap:24px;align-items:flex-start}
figure{margin:0}figcaption{margin-top:6px;opacity:.7}img{display:block;border:1px solid ${theme === "dark" ? "#333" : "#ccc"}}</style>
<h1>${title}</h1>${rows.map((r) => `<h2>${r.label}</h2><div class="row">${r.files.map((f, i) => `<figure><img src="/${f}" width="${r.widths[i]}"><figcaption>${f}</figcaption></figure>`).join("")}</div>`).join("")}`;
  for (const theme of THEMES) {
    writeFileSync(join(OUT, `_sheet-landing-${theme}.html`), sheet(`moss.waifucave.com, the landing page, ${theme}`, [
      { label: "The opening, the bot list, at 1440, 820 and 390", files: [`landing-top-1440-${theme}.png`, `landing-top-820-${theme}.png`, `landing-top-390-${theme}.png`], widths: [720, 410, 222] },
      { label: "The bots band, with Try a name at its end; and What leaves your computer", files: [`landing-bots-1440-${theme}.png`, `landing-privacy-1440-${theme}.png`], widths: [720, 720] },
      { label: "The download area: not released, and released", files: [`landing-download-unreleased-1440-${theme}.png`, `landing-download-released-1440-${theme}.png`], widths: [720, 720] },
      { label: "The whole page, not released yet, at 1440, 820 and 390", files: [`landing-unreleased-1440-${theme}.png`, `landing-unreleased-820-${theme}.png`, `landing-unreleased-390-${theme}.png`], widths: [720, 410, 195] },
      { label: "Privacy and Terms, placeholders until the first release (the foot links to them)", files: [`privacy-1440-${theme}.png`, `terms-1440-${theme}.png`, `privacy-390-${theme}.png`], widths: [560, 560, 195] },
    ], theme));
    const docPages = builds.unreleased.pages.filter((p) => p.startsWith("/docs/"));
    writeFileSync(join(OUT, `_sheet-docs-${theme}.html`), sheet(`moss.waifucave.com/docs, ${theme}`, docPages.map((p) => ({
      label: p, files: [`${name(p)}-1440-${theme}.png`, `${name(p)}-820-${theme}.png`, `${name(p)}-390-${theme}.png`], widths: [560, 320, 152],
    })), theme));
  }
  const sheets = serveSite(OUT);
  for (const theme of THEMES) for (const kind of ["landing", "docs"]) {
    await shoot(cdp, { file: `contact-sheet-${kind}-${theme}.png`, url: `${sheets.url}/_sheet-${kind}-${theme}.html`, width: kind === "landing" ? 1560 : 1200, theme });
    rmSync(join(OUT, `_sheet-${kind}-${theme}.html`));
  }
  sheets.stop();

  // The proof: every address each picture's page asked for, and every host among them.
  const hosts = new Set<string>();
  for (const f of Object.keys(requests)) if (f.startsWith("contact-sheet-")) delete requests[f];
  for (const list of Object.values(requests)) for (const u of list) hosts.add(new URL(u).host);
  writeFileSync(join(OUT, "requests.json"), JSON.stringify({ hosts: [...hosts].sort(), byPicture: requests }, null, 2));
  if (overflow.length > 0) console.log(`render: pages wider than the screen:\n  ${overflow.join("\n  ")}`);
  else console.log("render: no page is wider than its screen");
  console.log(`render: hosts any page asked for: ${[...hosts].sort().join(", ")}`);
} finally {
  cdp.close();
  proc.kill();
  await proc.exited;
  for (const s of Object.values(servers)) s.stop();
  rmSync(scratch, { recursive: true, force: true });
}
