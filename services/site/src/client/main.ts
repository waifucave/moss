// The page's one script. It makes the faces live (the bots' own kit, the file MOSS's window draws with), lets the
// bot list change as the bots work, makes a bot from a typed name, puts the visitor's system first in the download
// area, and runs the docs' search over an index the site was built with. Nothing here talks to another host; the only
// request it makes is the docs' own search index, from this site.
import { makeBot, mount, type BotOptions, type Handle, type Mood } from "../../../../packages/plugin-sdk/src/ui/faces/living-bots.js";

const quiet = matchMedia("(prefers-reduced-motion: reduce)");
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

/** The colour a face stands on, read from the page's own tokens, so a sleeping bot fades into the right grey. */
function surfaceOf(el: Element): string {
  const css = getComputedStyle(document.documentElement);
  const v = css.getPropertyValue(el.getAttribute("data-surface") === "list" ? "--list-bg" : "--bg").trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : darkQuery.matches ? "#121212" : "#FFFFFF";
}

const handles = new Map<Element, Handle>();

function pinsOf(el: Element): BotOptions {
  const pins: BotOptions = {};
  const shape = el.getAttribute("data-shape"), color = el.getAttribute("data-color"), eyes = el.getAttribute("data-eyes");
  if (shape !== null) pins.shape = shape as BotOptions["shape"];
  if (color !== null) pins.color = color;
  if (eyes !== null) pins.eyes = eyes as BotOptions["eyes"];
  return pins;
}

function wakeFaces(): void {
  for (const el of document.querySelectorAll(".face[data-face]")) {
    const name = el.getAttribute("data-face") ?? "";
    const lively = el.hasAttribute("data-lively");
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const h = mount(canvas, name, {
      ...pinsOf(el),
      mood: (el.getAttribute("data-mood") ?? "idle") as Mood,
      scale: 1.2,
      dark: darkQuery.matches,
      surface: surfaceOf(el),
      follow: lively,
      tap: lively,
    });
    el.replaceChildren(canvas);
    handles.set(el, h);
  }
  darkQuery.addEventListener("change", () => {
    for (const [el, h] of handles) h.set({ dark: darkQuery.matches, surface: surfaceOf(el) });
  });
}

/** The opening's list: every few seconds one bot moves on a step, its face, its status and its last line together. */
function liveList(): void {
  const list = document.querySelector("[data-botlist]");
  if (list === null) return;
  const rows = [...list.querySelectorAll<HTMLElement>("li[data-steps]")].map((li) => ({
    li, at: 0, steps: JSON.parse(li.getAttribute("data-steps") ?? "[]") as [Mood, string, string][],
  }));
  if (rows.length === 0) return;
  let turn = 0;
  let seen = true;
  new IntersectionObserver((e) => { seen = e.some((x) => x.isIntersecting); }).observe(list);
  setInterval(() => {
    if (!seen || document.hidden || quiet.matches) return;
    const row = rows[turn % rows.length]!;
    turn++;
    row.at = (row.at + 1) % row.steps.length;
    const [mood, status, line] = row.steps[row.at]!;
    const faceEl = row.li.querySelector(".face");
    if (faceEl !== null) handles.get(faceEl)?.setMood(mood);
    const s = row.li.querySelector<HTMLElement>("[data-status]"), l = row.li.querySelector<HTMLElement>("[data-line]");
    if (s !== null) { s.textContent = status; s.className = `botrow__status mood-${mood}`; }
    if (l !== null) l.textContent = line;
  }, 2600);
}

const COLOR_WORDS: Record<string, string> = {
  gold: "gold", coral: "coral", sky: "sky-blue", mint: "mint-green", violet: "violet", lagoon: "lagoon-blue", lime: "lime-green", orchid: "orchid-pink", ember: "orange", iris: "iris-blue",
};

/** "Try a name": the kit makes the bot for whatever is typed; the same name always makes the same bot. */
function tryName(): void {
  for (const box of document.querySelectorAll("[data-tryname]")) {
    const input = box.querySelector<HTMLInputElement>("[data-tryname-input]");
    const note = box.querySelector<HTMLElement>("[data-tryname-note]");
    const faceEl = box.querySelector(".face");
    if (input === null || note === null || faceEl === null) continue;
    let last = "";
    const show = () => {
      const name = input.value.trim().slice(0, 40);
      if (name === last) return;
      last = name;
      const h = handles.get(faceEl);
      if (name === "") { note.textContent = "Type a name to see its bot."; return; }
      const bot = makeBot(name);
      h?.setBot(bot);
      h?.poke();
      const shown = name.length > 24 ? `${name.slice(0, 24)}…` : name;
      note.textContent = `${shown} is ${/^[aeiou]/.test(COLOR_WORDS[bot.colorName] ?? "") ? "an" : "a"} ${COLOR_WORDS[bot.colorName] ?? "coloured"} ${bot.shape}. Every bot called ${shown} looks like this.`;
    };
    input.addEventListener("input", show);
    last = input.value.trim();
  }
}

/** The download area: the visitor's system first, and the opening's button says which. */
function yourSystem(): void {
  const area = document.querySelector("[data-downloads]");
  if (area === null) return;
  const ua = navigator.userAgent;
  const platform = ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "").toLowerCase();
  const key = /mac/.test(platform) || /Macintosh/.test(ua) ? "mac"
    : /win/.test(platform) || /Windows/.test(ua) ? "win"
    : /linux/.test(platform) || /Linux/.test(ua) ? (/aarch64|arm64/i.test(ua + platform) ? "linux-arm64" : /x86_64|amd64/i.test(ua + platform) ? "linux-x64" : undefined)
    : undefined;
  if (key === undefined) return;
  for (const row of area.querySelectorAll<HTMLElement>(`.dl__system[data-system="${key}"]`)) {
    row.classList.add("is-yours");
    row.parentElement?.prepend(row);
  }
  const main = document.querySelector<HTMLAnchorElement>("[data-get-main]");
  const names: Record<string, string> = { mac: "macOS", win: "Windows", "linux-x64": "Linux", "linux-arm64": "Linux" };
  if (main !== null) main.textContent = `Download for ${names[key]}`;
}

/** Copy buttons on the docs' code blocks. */
function copyButtons(): void {
  if (navigator.clipboard === undefined) return;
  for (const block of document.querySelectorAll(".codeblock")) {
    const code = block.querySelector("pre");
    if (code === null) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "copy";
    b.textContent = "Copy";
    b.addEventListener("click", () => {
      void navigator.clipboard.writeText(code.innerText.replace(/\n$/, "")).then(() => {
        b.textContent = "Copied";
        setTimeout(() => { b.textContent = "Copy"; }, 1600);
      });
    });
    block.append(b);
  }
}

/** On a narrow screen the docs' page list starts closed, under its own button. */
function docNav(): void {
  const d = document.querySelector<HTMLDetailsElement>("[data-docnav]");
  if (d !== null && matchMedia("(max-width: 899px)").matches) d.open = false;
}

interface Entry { u: string; t: string; d: string; g: string; h: [string, string][]; x: string }

/** The docs' search: the index is built with the site (docs/search.json), so it works with no service and offline. */
function search(): void {
  const box = document.querySelector("[data-search]");
  const input = box?.querySelector<HTMLInputElement>("[data-search-input]");
  const out = box?.querySelector<HTMLElement>("[data-search-results]");
  if (!box || !input || !out) return;
  let index: Entry[] | undefined;
  let loading: Promise<void> | undefined;
  let hits: HTMLAnchorElement[] = [];
  let sel = -1;
  const load = () => (loading ??= fetch("/docs/search.json").then((r) => r.json()).then((j: Entry[]) => { index = j; }).catch(() => { index = []; }));
  const count = (hay: string, w: string) => { let n = 0, i = hay.indexOf(w); while (i !== -1 && n < 5) { n++; i = hay.indexOf(w, i + w.length); } return n; };
  const close = () => { out.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); sel = -1; };
  const select = (i: number) => {
    sel = i;
    hits.forEach((a, j) => a.setAttribute("aria-selected", String(j === i)));
    if (hits[i] !== undefined) { input.setAttribute("aria-activedescendant", hits[i]!.id); hits[i]!.scrollIntoView({ block: "nearest" }); }
  };
  const run = () => {
    const q = input.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter((w) => w.length > 1);
    if (words.length === 0 || index === undefined) { close(); return; }
    const scored = index.map((e) => {
      const t = e.t.toLowerCase(), d = e.d.toLowerCase(), x = e.x.toLowerCase();
      let score = 0;
      let best: [string, string] | undefined;
      let bestScore = 0;
      for (const w of words) {
        const inAny = t.includes(w) || d.includes(w) || x.includes(w) || e.h.some(([, h]) => h.toLowerCase().includes(w));
        if (!inAny) return { e, score: 0, best };
        score += (t.includes(w) ? 12 : 0) + (d.includes(w) ? 4 : 0) + count(x, w);
      }
      for (const h of e.h) {
        const s = words.filter((w) => h[1].toLowerCase().includes(w)).length;
        if (s > bestScore) { bestScore = s; best = h; }
      }
      return { e, score: score + bestScore * 6, best };
    }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
    out.replaceChildren();
    hits = [];
    if (scored.length === 0) {
      const p = document.createElement("p");
      p.className = "search__none";
      p.textContent = "No page matches. Try fewer words.";
      out.append(p);
    }
    scored.forEach((r, i) => {
      const a = document.createElement("a");
      a.className = "search__hit";
      a.id = `hit-${i}`;
      a.setAttribute("role", "option");
      a.href = r.best !== undefined ? `${r.e.u}#${r.best[0]}` : r.e.u;
      const title = document.createElement("span");
      title.className = "search__hit-title";
      title.textContent = r.e.t;
      const where = document.createElement("span");
      where.className = "search__hit-where";
      where.textContent = r.best !== undefined ? `${r.e.g}, ${r.best[1]}` : r.e.g;
      a.append(title, where);
      out.append(a);
      hits.push(a);
    });
    out.hidden = false;
    input.setAttribute("aria-expanded", "true");
    select(-1);
  };
  input.addEventListener("focus", () => { void load(); });
  input.addEventListener("input", () => { void load().then(run); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" && hits.length > 0) { ev.preventDefault(); select(Math.min(sel + 1, hits.length - 1)); }
    else if (ev.key === "ArrowUp" && hits.length > 0) { ev.preventDefault(); select(Math.max(sel - 1, 0)); }
    else if (ev.key === "Enter" && hits.length > 0) { ev.preventDefault(); location.href = hits[Math.max(sel, 0)]!.href; }
    else if (ev.key === "Escape") { if (!out.hidden) { ev.preventDefault(); close(); } }
  });
  document.addEventListener("click", (ev) => { if (!box.contains(ev.target as Node)) close(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== input && !(document.activeElement instanceof HTMLInputElement)) { ev.preventDefault(); input.focus(); }
  });
}

wakeFaces();
liveList();
tryName();
yourSystem();
copyButtons();
docNav();
search();
