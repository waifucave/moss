# Where each picture comes from

Every picture is of the real MOSS app, rendered from source with sample data only (sample bots called Juniper, Kite,
Maple and so on; the computer "Studio"; the site example-air.test). None comes from anyone's own home. The build
leaves this file out of the site.

| File | From | Rendered |
| :- | :- | :- |
| `moss-window-{light,dark}.png` | the MOSS app's render script (`apps/moss/scripts/render.ts`), the conversation at its usual size | 2026-11-17, 1280 by 820 at 1x |
| `moss-window-narrow-{light,dark}.png` | the same, at its narrow size, shown on phone-sized screens | 2026-11-17, 760 by 820 at 1x |
| `moss-card-{light,dark}.png` | the card cut from `moss-window-*` (Juniper's booking card) | 2026-11-17, 572 by 232 at 1x |
| `moss-panel-{light,dark}.png` | the same script, the side panel open, with another bot's card in the strip | 2026-11-18, 1280 by 820 at 1x |
| `moss-plugins-{light,dark}.png` | the same script, MOSS's Plugins page cut to "Add a plugin" and the MOSS Browser's tools (the page's next plugin, computer use, is left out: it is not in the first release) | 2026-11-18, 788 by 534 at 1x |
| `moss-setup-{light,dark}.png` | the setup guide's first step, cut to its card | 2026-11-24, 2x |
| `moss-setup-model-{light,dark}.png` | the setup guide's second step, cut to its card | 2026-11-24, 2x |
| `moss-code-canvas-{light,dark}.png` | MOSS Code's live preview (`scripts/preview/run.ts --control --headless`, its throwaway home and sample sessions, nothing shown on screen), the canvas cut to the sessions on MOSS's own coding agent and the bot MOSS: the sample world's Codex, Claude Code and Gemini sessions, whose blocks carry those agents' marks, are below the cut. One block (Profile checkout page load) was dragged beside the others first, as a person can | 2026-11-24, 2x |

## To shoot again

* All of the window and the card at 2x. On 2026-11-24 the render script was run again on today's app: its pictures
  match these (the same scenes, the same words), but it draws only at 1x. Its window is an offscreen one
  (`offscreen: true` in `apps/moss/src/main/index.ts`), which draws at a scale of 1 whatever Chromium's
  `--force-device-scale-factor=2` says (tried: still 1280 by 820). A 2x render needs a scale in the render's own
  window, `offscreen: { deviceScaleFactor: 2 }` for `--moss-render`, which is the MOSS app's code, not this site's.
* MOSS Code: one session open in its tab. The preview's sample sessions can't give one: its fake model answers every
  message with test words (`ACCEPTANCE-REPLY-OK`, `scripts/acceptance/fake-anthropic.ts`), and the session's panel row
  shows an Avatar tab, which this site leaves out. Wanted: a scripted sample conversation for a session on MOSS's own
  agent, as MOSS's render has for its bots (`apps/moss/scripts/render.ts`'s long talk), and a way to leave the avatar
  plugin out of a picture run; or a preview seed with only MOSS's own agent, so the whole canvas can be shown.
