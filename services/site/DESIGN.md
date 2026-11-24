# moss.waifucave.com: the design

## Who it is for

1. **A person who is not a developer** and has heard that AI can do things, not just chat. They may already pay for ChatGPT or have an API key. They want to know what MOSS is, whether it is safe to let it act on their computer, and whether they can have it yet.
2. **A developer who already uses coding agents** (Claude Code, Codex, OpenCode and the rest). They want to know what MOSS Code adds to the agents they have.
3. **Someone who wants to build on it**: a plugin, a model provider, a coding agent. They read the second register, lower on the page, and the docs.

The page is written for the first reader. The second and third find their part by name (MOSS Code, Plugins, For developers) and in /docs.

## The idea

The bots are the product, so the bots are the page. Each bot is a living face made from its name; on the page they are the real faces, drawn by the same code the app draws them with (`packages/plugin-sdk/src/ui/faces/living-bots.js`), so they blink, look around and change mood. They are the only colour on the page. Everything else is the app's own plain neutral look: white and light grey surfaces, black for the person's words and the main buttons, light grey for the bot's.

Two openings are built, and `site.json`'s `hero` picks one:

* `list`: the headline at the left, and at the right a bot list like the app's own, where the bots' moods change as they work.
* `name`: one large bot and a field: type a name and its face appears. The same name always makes the same bot.

## What each section must make the reader understand

| Section | The one thing |
| :- | :- |
| Opening | MOSS is an app where you talk to AI bots that do things on your computer, and it is not out yet. |
| Bots | Each bot has its own face, one long conversation, a memory and routines. |
| What a bot can do | Files, commands, the web, a browser in the background, routines, other bots and coding agents. Screen control comes later. |
| You stay in charge | Before anything risky the bot asks on a card, and you choose how much it may do alone. A real card is shown. |
| MOSS Code | The second app runs the coding agents you already have, side by side, with the same cards. |
| Plugins | Almost everything is a plugin, and nothing new runs until you say OK. |
| Your keys | You bring your own model accounts. Nothing reports on you; the page lists what does connect, and where. |
| Devices and phones | Your computers pair with each other. Phone apps are being built. |
| Open source | Apache-2.0, on GitHub. |
| Systems and download | macOS, Windows and Linux; not released yet, or a button per system. |
| For developers | One engine, a local protocol, plugins as folders, ACP agents and MCP tools; then the docs. |

## Look

* **Type:** the system's own font (San Francisco on a Mac, Segoe UI on Windows), the font the apps use. No web font: zero bytes and zero requests. A clear scale: large tight headlines, 17 px body, 14 px notes.
* **Colour:** the MOSS window's own tokens (`apps/moss/src/window/window.css`): white, `#F7F7F7`, black `#0A0A0A` for buttons and the person's words, `#F0F0F0` for the bot's words, and the same set turned for dark mode. Links are the text colour, underlined. No blue, no beige, no gradient, no glow.
* **Faces:** the hero, the list, the moods row, the MOSS Code canvas sketch's bot block and the header's logo (MOSS, the default bot: the coral tile with round eyes, which is the app's icon) are all live. With "reduce motion" on, the kit leaves out jumps and turns, and a mood is also said in words beside every face.
* **Pictures:** real renders of the MOSS app with sample data only, in light and dark (`public/pictures/SOURCES.md`). Where no clean picture exists (MOSS Code's canvas) the page shows a sketch and says that it is one.

## Rejected

* A framework (Astro, Eleventy, VitePress, Next): every one adds dozens of packages and a lockfile tree for a site this size. Bun already has Markdown (`Bun.markdown`), a bundler and a server, so the site has no dependency at all.
* A web font: a request and 50 to 200 KB for a look that is the system font's anyway.
* Agent and provider logos: they are colour that is not a face, and the agent marks are cleared for naming an agent in the app (`docs/agent-marks.md`), not for a marketing page. Agents are named in text.
* A search service: the docs' search is an index built with the site and searched in the page, so it works offline.
* An email form, analytics, a cookie banner: the product reports nothing about its user, and neither does its site.
