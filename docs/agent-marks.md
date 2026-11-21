# Agent marks

Each agent plugin under `plugins/moss/plugins/agent-*` ships its agent's mark as an icon file in its own folder, named by the `icon` line of its `agentBackends` entry (with `color` and `color2` where it has them). The engine serves them in `agent.backends`; the window draws them to name each agent on the start page and in the canvas.

Every mark below is the trademark of its owner. It is shown only to name that agent, and does not mean the owner endorses or is part of this product.

**To remove a mark:** delete its file and its `icon` line (and `color` lines, if wanted) from the plugin's `moss.json`. The plugin keeps working; the agent is drawn with the fallback mark (its name's first letter on its colour). Nothing else names the file.

| Agent plugin | File | Owner of the mark | Source |
|---|---|---|---|
| `agent-claude-code` | `claude-code.svg` | Anthropic | The Claude Code extension's own mascot file (`resources/clawd.svg`) |
| `agent-codex` | `codex.svg` | OpenAI | A single-colour Codex glyph supplied by the project owner; colours `#484FF6` and `#7893F9` sampled from the Codex app's icon |
| `agent-gemini` | `gemini.png` | Google | https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png (colours `#3488FB`, `#F24D50` read from it) |
| `agent-antigravity` | `antigravity.svg` | Google | https://antigravity.google/favicon.svg (colours `#3186FF`, `#FBBC04` from its palette) |
| `agent-cursor` | `cursor.svg` | Anysphere (Cursor) | https://www.cursor.com/brand (`brand-logo-8.svg`) |
| `agent-devin` and `agent-devin-cloud` (same file in each folder) | `devin.svg` | Cognition | https://devin.ai/assets/brand/logos/devin/Devin_Symbol.svg |
| `agent-grok` | `grok.svg` | xAI | https://grok.com/images/favicon.svg (the mark only) |
| `agent-deepseek` | `deepseek.svg` | DeepSeek | https://raw.githubusercontent.com/deepseek-ai/DeepSeek-LLM/HEAD/images/logo.svg (the whale only; colour `#4D6BFE`) |
| `agent-opencode` | `opencode.svg` | Anomaly (OpenCode) | https://opencode.ai/brand (no `color`: its brand is black and silver, so the text's colour) |
| `agent-copilot` | `copilot.svg` | GitHub (Microsoft) | https://github.com/primer/octicons (`copilot-24.svg`; colour `#218BFF`, a value from GitHub Primer's blue scale) |
| `agent-qwen` | `qwen.svg` | Alibaba (Qwen) | the qwen-code repository's `qwen-code-logo.svg` (colour `#082DFF`, its own) |
| `agent-kimi` | `kimi.svg` | Moonshot AI (Kimi) | https://www.kimi.com/en/resources/kimi-brand (the logomark; its black tile dropped, the K drawn in the text's colour, the dot `#1783FF` its own) |

MOSS's own coding agent has no plugin: its mark is our own, MOSS Code's Shards mark (`assets/brand/moss-code/mark/shards-mark-on-light.svg` and `shards-mark-on-dark.svg`, served as `icon` and `iconDark`, the one that fits the theme drawn), bare, with the mark's gold `#E5A72E` as its colour. MOSS's face is for bots only (`BotFace`).

Files were put on a square canvas and made plain (no script, style, external reference); no path data of a mark was changed, and no colour either, except Kimi's: the vendor's black tile was dropped (marks are drawn bare, as Grok's and Cursor's were) and its white K is `currentColor`, so it takes the theme's text colour. A one-colour (`currentColor`) icon is drawn in the agent's colour when it has one with a hue, else in the theme's text colour. The engine accepts an icon only as a PNG or inert SVG of at most 64 KiB, inside the plugin's own folder.
