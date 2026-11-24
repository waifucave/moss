// The landing page, moss.waifucave.com/. What each section is for is in DESIGN.md. Every statement here is checked
// against the spec (docs/moss-spec.md) or the code; the facts and where they come from are listed in DESIGN.md's
// companion, content/outline.json, for the docs pages that say the same at length.
import type { Mood, BotOptions } from "../../../packages/plugin-sdk/src/ui/faces/living-bots.js";
import type { SiteConfig } from "./config";
import { downloads, type DownloadApp } from "./downloads";
import { face, MOSS_PINS } from "./faces";
import { html, raw, type Html } from "./html";
import { picture } from "./pictures";

/** The sample bots, named as the app's own renders name them (apps/moss/scripts/render.ts's sample data). */
interface Row {
  name: string;
  pins?: BotOptions;
  mood: Mood;
  /** The status the list shows: the mood or tool in the app's words, then the last line. */
  status: string;
  line: string;
  time: string;
  unread?: boolean;
  /** What the row turns to while the page is open: [mood, status, line] steps. */
  steps?: readonly (readonly [Mood, string, string])[];
}

const ROWS: readonly Row[] = [
  {
    name: "Juniper", mood: "working", status: "Using the browser", line: "Comparing three airlines", time: "1m",
    steps: [["working", "Using the browser", "Comparing three airlines"], ["asking", "Needs you", "The 8:05 nonstop is $312.40. Book it?"], ["done", "Done", "Booked: seat 14A, one bag"]],
  },
  { name: "Kite", mood: "asking", status: "Needs you", line: "Two folders are ready to delete", time: "3m", unread: true },
  {
    name: "Maple", mood: "thinking", status: "Thinking", line: "Planning the trip budget", time: "9m",
    steps: [["thinking", "Thinking", "Planning the trip budget"], ["working", "Writing budget.md", "Hotels, trains, food"], ["done", "Done", "The budget is in your Documents"]],
  },
  { name: "Cobalt", mood: "stuck", status: "Stuck", line: "The backup drive isn't connected", time: "22m" },
  {
    name: "Fern", mood: "done", status: "Done", line: "The summary is in your notes", time: "41m", unread: true,
  },
  {
    name: "Brook", mood: "working", status: "Reading a file", line: "Going through the lease", time: "12:23",
    steps: [["working", "Reading a file", "Going through the lease"], ["working", "Searching the web", "Notice periods in Lisbon"], ["done", "Done", "Three things to ask the landlord"]],
  },
  { name: "Onyx", mood: "asleep", status: "Asleep", line: "Paused until Monday", time: "Mon" },
];

/** The eight moods (spec §6.9), in the app's words (apps/moss/src/shared/view.ts MOOD_WORDS). */
const MOODS: readonly (readonly [Mood, string, string])[] = [
  ["idle", "Idle", "Iris"], ["listening", "Listening", "Basil"], ["thinking", "Thinking", "Maple"], ["working", "Working", "Vale"],
  ["asking", "Needs you", "Kite"], ["stuck", "Stuck", "Cobalt"], ["done", "Done", "Fern"], ["asleep", "Asleep", "Onyx"],
];

/** The agents MOSS Code ships a plugin for (plugins/moss/plugins/agent-*, each manifest's name), and its own. */
const AGENTS = ["Claude Code", "Codex", "Gemini CLI", "Antigravity CLI", "Cursor", "Copilot", "Devin", "Grok", "DeepSeek Harness", "OpenCode", "Qwen", "Kimi"];

function botList(rows: readonly Row[], lively: boolean): Html {
  return html`<ul class="botlist" aria-label="A list of bots, as MOSS shows it"${lively ? raw(" data-botlist") : ""}>
${rows.map((r, i) => html`<li class="botrow${i === 0 ? " is-on" : ""}"${r.steps !== undefined ? raw(` data-steps='${JSON.stringify(r.steps).replace(/'/g, "&#39;")}'`) : ""}>
${face({ name: r.name, pins: r.pins, mood: r.mood, size: "row", surface: "list" })}
<span class="botrow__text">
<span class="botrow__top"><span class="botrow__name">${r.name}</span><span class="botrow__time">${r.time}</span></span>
<span class="botrow__line"><span class="botrow__status mood-${r.mood}" data-status>${r.status}</span><span class="botrow__last" data-line>${r.line}</span></span>
</span>
${r.unread === true ? html`<span class="botrow__unread"><span class="visually-hidden">Unread</span></span>` : ""}
</li>`)}
</ul>`;
}

const SENTENCE = "MOSS is an app for your computer where you talk to AI bots. Each one has a face, a memory and a job, and gets things done with your files, your commands and the web, asking you first before anything risky.";

function actions(config: SiteConfig): Html {
  if (config.release.state === "released") {
    return html`<div class="actions" data-get>
<a class="button" href="#download" data-get-main>Download MOSS</a>
<a class="button button--quiet" href="/docs/">Read the docs</a>
</div>
<p class="status">Version ${config.release.version}, for macOS, Windows and Linux.</p>`;
  }
  return html`<div class="actions">
<a class="button" href="${config.repository}">See it on GitHub</a>
<a class="button button--quiet" href="/docs/">Read the docs</a>
</div>
<p class="status"><span class="status__dot" aria-hidden="true"></span>Not released yet. The first release brings MOSS and MOSS Code to macOS, Windows and Linux together.</p>`;
}

function hero(config: SiteConfig): Html {
  return html`<section class="hero" aria-labelledby="hero-title">
<div class="hero__text">
<h1 id="hero-title">Bots that do the work on your computer.</h1>
<p class="lead">${SENTENCE}</p>
${actions(config)}
</div>
<div class="hero__show">
<div class="window" role="img" aria-label="MOSS's list of bots: Juniper using the browser, Kite needing you, Maple thinking, Cobalt stuck, Fern done, Brook reading a file, Onyx asleep.">
${botList(ROWS, true)}
</div>
</div>
</section>`;
}

/** "Try a name": the bots band's own proof that a name makes a face, and always the same one. */
function nameTry(): Html {
  return html`<div class="tryname" data-tryname>
${face({ name: "Juniper", size: "block", lively: true, data: { "data-tryname-face": "" } })}
<div class="tryname__field">
<label for="tryname">Try a name</label>
<input id="tryname" type="text" value="Juniper" maxlength="40" autocomplete="off" spellcheck="false" data-tryname-input>
<p class="tryname__note" aria-live="polite" data-tryname-note>Juniper is a sky-blue dome. Every bot called Juniper looks like this.</p>
</div>
</div>`;
}

function bots(): Html {
  return html`<section class="band" id="bots" aria-labelledby="bots-title">
<div class="band__head">
<h2 id="bots-title">Each bot is someone you can talk to</h2>
<p class="lead">You make a bot by giving it a name. The name makes its face, and the same name always makes the same one. MOSS, the bot you meet first, is the coral one.</p>
</div>
<div class="facts">
<div class="fact"><h3>One conversation</h3><p>Like texting a person: one long conversation with each bot. A message from you interrupts whatever it is doing.</p></div>
<div class="fact"><h3>Its own memory</h3><p>Each bot keeps notes in a memory folder of its own, and you can read everything it keeps.</p></div>
<div class="fact"><h3>Routines</h3><p>Ask for something every morning or every Friday and the bot writes itself a routine. Pause one or run it now whenever you like.</p></div>
</div>
${picture({ name: "moss-window", alt: "The MOSS window with sample bots. On the left, the list of bots with their faces and what each is doing. In the middle, a conversation with Juniper about a flight to Lisbon, ending with a card: Juniper wants to click Book on the airline's page, and asks Not now or Book it.", caption: "MOSS with sample bots. The card at the end of the conversation is a real one: Juniper asks before it books." })}
<div class="moods" aria-labelledby="moods-title">
<h3 id="moods-title">A face shows what its bot is doing</h3>
<ul class="moods__row">
${MOODS.map(([mood, word, name]) => html`<li class="mood">${face({ name, mood, size: "mood" })}<span class="mood__word">${word}</span></li>`)}
</ul>
<p class="note">The words are always there too, beside every face, and with reduced motion turned on the faces keep still.</p>
</div>
${nameTry()}
</section>`;
}

function canDo(): Html {
  return html`<section class="band" id="can-do" aria-labelledby="can-do-title">
<div class="band__head">
<h2 id="can-do-title">What a bot can do</h2>
<p class="lead">Ask it in your own words. It picks the tools.</p>
</div>
<ul class="rows">
<li><strong>Your files</strong><span>Read them, sort them, write new ones, in the folders you use.</span></li>
<li><strong>Commands</strong><span>Run them on your computer, inside a sandbox.</span></li>
<li><strong>The web</strong><span>Search it and read pages.</span></li>
<li><strong>A browser of its own</strong><span>It works in the background, and you can watch it in the bot's side panel.</span></li>
<li><strong>Routines</strong><span>Jobs on a schedule, or when a webhook arrives.</span></li>
<li><strong>Other bots, coding agents</strong><span>It can message your other bots, and hand a coding job to an agent.</span></li>
<li><strong>Talking</strong><span>With a voice plugin and your own key for it, it speaks its replies and listens while you hold the talk button.</span></li>
</ul>
<p class="note">Not in the first release: controlling your screen. It will come later, as a plugin.</p>
</section>`;
}

const LEVELS: readonly (readonly [string, string])[] = [
  ["Read only", "It can look at things. It changes nothing and runs nothing."],
  ["Ask before every action", "Every change, command or page it opens waits for your OK."],
  ["Ask before risky actions", "It works on its own inside its sandbox and your ordinary folders. Deleting, buying, and anything MOSS's safety check isn't sure of, ask you first."],
  ["Ask before risky actions, edits allowed", "The same, and it may also change and move files in sensitive places, like the settings files in your home folder, without asking."],
  ["Fully automatic", "It never asks. Changes to MOSS's own settings, levels and plugins still do."],
];

function approvals(): Html {
  return html`<section class="band" id="approvals" aria-labelledby="approvals-title">
<div class="band__head">
<h2 id="approvals-title">It asks before anything risky</h2>
<p class="lead">When a bot wants to do something its level doesn't let it do alone, it stops and asks you on a card. The card says who wants to do what, and where. Only a real press on its button answers it: a bot can't answer its own card.</p>
</div>
<div class="split">
<div class="split__side">
${picture({ name: "moss-card", alt: "A card in MOSS: Juniper wants to click Book on example-air.test. Submit the booking form? On the computer called Studio. Press Book: 8:05 nonstop to Lisbon, seat 14A, $312.40. A link: Show everything this approves. Buttons: Not now, Book it.", caption: "A card, as MOSS draws it." })}
<div class="fact"><h3>Commands run in a sandbox</h3><p>At the default level a command can write only to the bot's own folders and the temporary folder, and can't reach the network. When it needs more, it asks for that folder on a card.</p></div>
<div class="fact"><h3>The card finds you</h3><p>It shows in the MOSS window when you're there, and on a small island at the top of your screen when you're in another app. When the phone apps are out, it reaches your phone too.</p></div>
</div>
<div class="levels">
<h3>You choose how much it does alone</h3>
<dl class="levels__list">
${LEVELS.map(([name, what], i) => html`<div class="level${i === 2 ? " level--default" : ""}"><dt>${name}${i === 2 ? html`<span class="level__tag">Default</span>` : ""}</dt><dd>${what}</dd></div>`)}
</dl>
<p class="note">You set the level for each of your computers, in Settings. Changing it asks you on a card first. <a href="/docs/approvals/">What each level allows</a>.</p>
</div>
</div>
</section>`;
}

/** The canvas sketch: blocks and lines in the page's own style. It is a drawing of what MOSS Code's start page shows,
 *  not a picture of the app, and its caption says so. */
function canvasSketch(): Html {
  const block = (id: string, title: string, agent: string, state: string, motion: "running" | "waiting" | "still") =>
    html`<div class="cblock c-${id} cblock--${motion}" data-block="${id}"><span class="cblock__mark" aria-hidden="true">${agent.slice(0, 1)}</span><span class="cblock__text"><span class="cblock__title">${title}</span><span class="cblock__agent">${agent}</span><span class="cblock__state"><span class="cblock__dot" aria-hidden="true"></span>${state}</span></span></div>`;
  // The lines join a session to the one that started it; the page's script draws them between the blocks as laid out.
  return html`<figure class="sketch">
<div class="canvas" role="img" aria-label="A sketch of MOSS Code's canvas. Fix the flaky upgrade test, on Claude Code, is running, and a line joins it to the helper it started, Read the logs, which is done. API refactor, on Codex, is waiting on two background jobs. MOSS, a bot, has started two sessions, joined to it by lines: Weekly usage report on MOSS's own coding agent, and Port the parser to Rust on OpenCode, both running." data-canvas>
<svg class="canvas__lines" aria-hidden="true"><path data-link="fix>logs"/><path data-link="moss>report"/><path data-link="moss>port"/></svg>
${block("fix", "Fix the flaky upgrade test", "Claude Code", "Running, editing run.ts", "running")}
${block("logs", "Read the logs", "Claude Code, a helper", "Done, report sent", "still")}
${block("api", "API refactor", "Codex", "Waiting on 2 background jobs", "waiting")}
<div class="cblock cblock--bot c-moss" data-block="moss">${face({ name: "MOSS", pins: MOSS_PINS, mood: "working", size: "block" })}<span class="cblock__text"><span class="cblock__title">MOSS</span><span class="cblock__agent">a bot</span></span></div>
${block("report", "Weekly usage report", "MOSS's coding agent", "Running, writing report.md", "running")}
${block("port", "Port the parser to Rust", "OpenCode", "Running, cargo check", "running")}
</div>
<figcaption>A sketch of MOSS Code's canvas, drawn for this page. A picture of the app will take its place.</figcaption>
</figure>`;
}

function code(): Html {
  return html`<section class="band" id="code" aria-labelledby="code-title">
<div class="band__head">
<h2 id="code-title">MOSS Code: your coding agents, side by side</h2>
<p class="lead">MOSS Code is the second app. It runs the coding agents you already use, each in a session of its own, and lays them out on one canvas, so you can see what every one of them is doing and open any of them.</p>
</div>
${canvasSketch()}
<div class="facts">
<div class="fact"><h3>The agents you have</h3><p>${AGENTS.join(", ")}, and MOSS's own coding agent. You install an agent the usual way, and MOSS Code finds it on your computer.</p></div>
<div class="fact"><h3>The same cards</h3><p>Each agent keeps its own sign-in and its own sandbox. When it asks to do something, the request goes through your level and comes to you on the same cards as a bot's.</p></div>
<div class="fact"><h3>Bots hand over</h3><p>A bot in MOSS can give a coding job to an agent. With both apps installed, that job opens in MOSS Code as a session you can watch and steer.</p></div>
</div>
</section>`;
}

function plugins(): Html {
  return html`<section class="band" id="plugins" aria-labelledby="plugins-title">
<div class="band__head">
<h2 id="plugins-title">Almost everything is a plugin</h2>
<p class="lead">Models, tools, voices and coding agents all come as plugins, and so does most of MOSS Code's window. A plugin is just a folder of files.</p>
</div>
<div class="split split--pic">
${picture({ name: "moss-plugins", alt: "MOSS's Plugins page: a field to add a plugin from a link or a file, which runs only after you OK its card; then the MOSS Browser plugin's tools, Click, Fill, Open and Read, each with two settings: whether bots get it (Off, On demand, Always on) and what happens when a bot uses it (Always allow, Ask, Always block).", caption: "MOSS's Plugins page, with the browser's tools." })}
<ul class="rows rows--narrow">
<li><strong>Nothing new runs without your OK</strong><span>When a plugin arrives, a card says what it is and what it may do, and it waits for you.</span></li>
<li><strong>Each tool, your way</strong><span>Off, on demand, or always on; and when a bot uses it, always allow, ask, or always block.</span></li>
<li><strong>Bring what you have</strong><span>Add an MCP server, a skill folder or a Claude Code plugin, and MOSS wraps it as a plugin for you.</span></li>
<li><strong>Change the window</strong><span>In MOSS Code, plugins can restyle and rearrange the window itself. MOSS keeps its own plain window.</span></li>
</ul>
</div>
</section>`;
}

function privacy(): Html {
  return html`<section class="band" id="privacy" aria-labelledby="privacy-title">
<div class="band__head">
<h2 id="privacy-title">Your own model, and what leaves your computer</h2>
<p class="lead">MOSS doesn't come with a model: you bring one. Sign in to a subscription you already have or paste an API key, from OpenAI, Anthropic, Google, OpenRouter, xAI and many more, or run a model on your own computer with Ollama or LM Studio.</p>
</div>
<div class="split split--wide">
${picture({ name: "moss-setup", alt: "MOSS's setup guide, step 1 of 3: Welcome to MOSS. MOSS needs a model to talk to. Add a provider: sign in to a subscription you have, or paste an API key. A list of providers: Codex, Grok, OpenAI, Anthropic, Google Gemini API, OpenRouter, xAI.", caption: "The setup guide that greets you on first open." })}
<div class="connects">
<h3>What leaves your computer</h3>
<ul class="connects__list">
<li><strong>Your model provider</strong> gets what you write and what the bot reads to answer you: files, pages, command output, pictures you attach. A few background jobs use it too: titles, a safety check before commands, and, in MOSS Code, passes that read idle sessions to keep its memory and to clear away ones with nothing worth keeping. With a voice set up, what it speaks and what you say to it go to your voice provider.</li>
<li><strong>Web searches go to Exa</strong>, a search company, from the start, with no account or key. Exa gets the words searched for and your IP address. To stop it, switch off the Web search and fetch plugin in MOSS Code, or with <code>moss plugin disable</code>. Pages a bot reads are fetched straight from your computer.</li>
<li><strong>Updates</strong> come from this project's releases on GitHub. Both apps check when they start and every 4 hours, download a new version on their own and install it when MOSS has nothing running. There is no switch to turn this off. GitHub sees your IP address and which version you have.</li>
<li><strong>Paired devices</strong> find each other through a small WaifuCave service, and learn their own network address from Cloudflare's and Google's public STUN servers. When two can't connect directly, a relay carries their traffic: n0's public relays unless you pick your own. What passes between your devices is encrypted end to end, but a relay sees their IP addresses, which are online and how much they send.</li>
<li><strong>The time</strong>: while your devices are linked, they ask Cloudflare's and Google's public time servers, so they agree on it.</li>
<li><strong>Downloads you OK</strong> come from where the card says: Claude Code's and Codex's adapters from npm, a plugin from the address you gave. A plugin can then reach what its card said it may.</li>
<li><strong>Your keys</strong> stay on your computer: in the Keychain on macOS, and on Windows and Linux in an encrypted file whose key your system's secret store keeps (or, with no secret store, a key file only you can read).</li>
</ul>
<p class="note">MOSS has no analytics, no telemetry and no crash reports. You don't need an account: devices pair with a code. Claude subscriptions can't be used in MOSS; an Anthropic Console sign-in, billed to your API account, can.</p>
</div>
</div>
</section>`;
}

function devices(): Html {
  return html`<section class="band" id="devices" aria-labelledby="devices-title">
<div class="band__head">
<h2 id="devices-title">On all your computers, and soon your phone</h2>
</div>
<div class="facts">
<div class="fact"><h3>Pair them once</h3><p>Connect your computers with a code or a QR code, then check that the same four words show on both screens. The link between them is encrypted end to end.</p></div>
<div class="fact"><h3>One bot, every computer</h3><p>A bot can then work on any of them. Its files and commands run on the computer that holds them, under that computer's own level.</p></div>
<div class="fact"><h3>Phone apps, being built</h3><p>MOSS and MOSS Code for iPhone and Android are being built now: your bots, your sessions and your cards in your pocket. They are not out yet.</p></div>
</div>
</section>`;
}

function open(): Html {
  return html`<section class="band" id="open" aria-labelledby="open-title">
<div class="band__head">
<h2 id="open-title">Open source, on three systems</h2>
<p class="lead">MOSS's code is open source under the Apache 2.0 license: both apps, the engine and the command line. Read the code, build it yourself, or tell us what's wrong.</p>
</div>
<table class="systems">
<caption class="visually-hidden">The systems MOSS runs on</caption>
<thead><tr><th scope="col">System</th><th scope="col">Version</th><th scope="col">Chips</th></tr></thead>
<tbody>
<tr><th scope="row">macOS</th><td>27 or later</td><td>Apple silicon</td></tr>
<tr><th scope="row">Windows</th><td>11</td><td>x64</td></tr>
<tr><th scope="row">Linux</th><td>Ubuntu 26.04 LTS, current Fedora</td><td>x64 and arm64</td></tr>
</tbody>
</table>
</section>`;
}

/** MOSS Code's mark, the Shards mark's single-colour cut (assets/brand/moss-code/mark/shards-mark-white.svg), drawn in
 *  the text's colour: on this page only the bots' faces have colour. */
const SHARDS_PATH = "M674.7 145.6 L645.8 131.9 L603.5 119.2 L574.1 112.4 L542.8 107.8 L508.5 106.8 L481 108.3 L441 112.9 L406.2 120.5 L361.7 135.1 L324.2 153.4 L289.4 172.8 L265 191 L229.9 222.6 L200.3 254.4 L170.8 293.9 L150.8 329.2 L131.1 371.9 L129.6 376.8 L400.4 478.2 Z M863.3 365.3 L842.6 319 L827.8 292.2 L803.6 256.6 L776.5 225.2 L749 198.3 L717.6 175.1 L698.5 163.9 L424.9 491.1 L447.6 499.7 L830 702.2 L841.4 682.1 L859.3 643 L874 598.2 L880.5 572.7 L885.3 525.4 L887 491.1 L884.7 458.4 L877.8 412.9 Z M396.4 875.9 L419.4 881.5 L451.4 886.7 L485.5 888.8 L537.2 887.4 L579.8 881.4 L622.6 869.1 L669.7 850.7 L704.5 832.7 L735.6 811.6 L762.6 789.5 L786.1 766 L807.4 741.7 L818.7 726.7 L605.8 614.7 Z M125.1 402.1 L124.7 403.3 L117.3 433 L111.2 476.4 L109.5 502.5 L111 536.3 L114.1 565.2 L121.6 605.3 L131.1 633.7 L139.5 657.4 L153 685.3 L172.4 716 L195.1 746.7 L220.7 775.9 L257.4 807.5 L288.9 827.8 L322 847.6 L348.6 859.6 L364.8 865.3 L581.3 601.6 L441.2 525.9 Z";

function appMark(app: "moss" | "code"): Html {
  return app === "moss"
    ? face({ name: "MOSS", pins: MOSS_PINS, size: "app" })
    : html`<svg class="appmark" viewBox="86 86 828 828" aria-hidden="true"><path fill="currentColor" d="${SHARDS_PATH}"/></svg>`;
}

function appHead(a: { app: "moss" | "code"; name: string; what: string }): Html {
  return html`<div class="app__head">${appMark(a.app)}<div><h3>${a.name}</h3><p class="app__what">${a.what}</p></div></div>`;
}

function downloadReleased(config: SiteConfig, apps: DownloadApp[]): Html {
  return html`<div class="dl" data-downloads>
${apps.map((a) => html`<div class="app">
${appHead(a)}
<ul class="dl__systems">
${a.systems.map((s) => html`<li class="dl__system" data-system="${s.key}">
<span class="dl__sys"><span class="dl__name">${s.name}</span><span class="dl__detail">${s.detail}</span></span>
<span class="dl__files">${s.files.map((f, i) => html`<a class="button button--small${i === 0 ? "" : " button--quiet"}" href="${f.url}" download data-file="${f.name}">${f.label}</a>`)}</span>
</li>`)}
</ul>
${config.release.homebrew ? html`<p class="dl__pm">With Homebrew: <code>${a.homebrew}</code></p>` : ""}
${config.release.winget ? html`<p class="dl__pm">With winget: <code>${a.winget}</code></p>` : ""}
</div>`)}
</div>
<p class="note">Each app carries the engine and runs on its own; with both installed they share it. Every file is also on the <a href="${config.repository}/releases/tag/v${config.release.version}">release page</a>.</p>`;
}

function download(config: SiteConfig): Html {
  const released = config.release.state === "released";
  const apps = [
    { app: "moss" as const, name: "MOSS", what: "The app for your bots." },
    { app: "code" as const, name: "MOSS Code", what: "The app for your coding agents." },
  ];
  return html`<section class="band band--download" id="download" aria-labelledby="download-title">
<div class="band__head">
<h2 id="download-title">${released ? `Download MOSS ${config.release.version}` : "Download"}</h2>
${released
    ? html`<p class="lead">Pick the app and your system. The system you're on comes first.</p>`
    : html`<p class="lead">MOSS isn't released yet. The first release brings both apps to macOS, Windows and Linux at the same time. Until then, the code is on GitHub, and the docs say what to expect.</p>`}
<p class="note">MOSS is for people 13 and older. You need an account or key with a model provider, or a model running on your own computer.</p>
</div>
${released
    ? downloadReleased(config, downloads(config.release.version, config.repository))
    : html`<div class="dl dl--soon">${apps.map((a) => html`<div class="app">${appHead(a)}<p class="app__soon">Not released yet</p></div>`)}</div>
<div class="actions"><a class="button" href="${config.repository}">See it on GitHub</a><a class="button button--quiet" href="/docs/install/">How installing will work</a></div>`}
</section>`;
}

function developers(config: SiteConfig): Html {
  return html`<section class="band band--dev" id="developers" aria-labelledby="dev-title">
<div class="band__head">
<h2 id="dev-title">For developers</h2>
</div>
<div class="dev">
<div class="dev__text">
<p>Both apps are clients of one engine, <code>moss-core</code>: a Bun process that starts at login and holds everything, the bots, the sessions, the plugins, the keys and the settings. The apps, the <code>moss</code> command and the phones talk to it over JSON-RPC on a local socket (a named pipe on Windows), and every client is a view of its event log.</p>
<p>A plugin is a folder with a <code>moss.json</code>. It can bring MCP servers, skills, model providers, coding agents that speak ACP, routine triggers, and in MOSS Code, themes and parts of the window. Plugin code runs in its own worker in a plugin host, apart from the engine, so a broken plugin can't take the engine down.</p>
<p><a href="/docs/first-plugin/">Write your first plugin</a>, read <a href="/docs/">the docs</a>, or start from <a href="${config.repository}">the source</a>.</p>
</div>
<pre class="dev__code"><code>moss plugin new tool hello-tool
moss plugin validate hello-tool
moss plugin dev hello-tool</code></pre>
</div>
</section>`;
}

export function landingBody(config: SiteConfig): Html {
  return html`${hero(config)}
${bots()}
${canDo()}
${approvals()}
${code()}
${plugins()}
${privacy()}
${devices()}
${open()}
${download(config)}
${developers(config)}`;
}

export const LANDING_TITLE = "MOSS: bots that do the work on your computer";
export const LANDING_DESCRIPTION = SENTENCE;
