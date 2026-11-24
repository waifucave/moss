// What MOSS Code's log FILE may hold (src/main/file-log.ts): every kind of line the app's main process logs is listed here with what the
// file gets. Bots can read the home's logs, so the file never holds an error's message text or stack, a card's id or text, a page's
// address, a key that was pressed, or a plugin's words besides its id; the process's output keeps every line as before.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { placeLine } from "../src/main/card-place";
import { KEEP, REDUCE, fileLine } from "../src/main/file-log";
import { isKnownTreeMethod, loggedMethod } from "../src/main/ui/tree-calls";
import { ipcLine } from "../src/main/ui/ipc-stats";
import { EVIDENCE_LINES, unkeptEvidence } from "../../../scripts/acceptance/evidence-lines";

const SECRET = "SECRETWORDS";
const CARD = "card_juniper_book";
const BOT = "Juniper";
const URL_ = "https://private.example/inbox?token=SECRETWORDS";

/** Lines as the app logs them that the file keeps as they are (variable parts: numbers, versions, one word of a closed set, one id token). */
const KEPT: string[] = [
  "answer key: the kept key couldn't be read; a new one is made",
  "answer key: the core didn't say which card; the new key stays staged",
  "answer key: replacing it waits on its card",
  "answer key: kept (the replacement's card is over)",
  "answer key: the core doesn't hold the new key yet; it stays staged",
  "answer key: replaced",
  "answer key: the new key stays staged in this computer's store until the next start",
  "answer key: this computer's secret store is plain text (no Secret Service); the key stays in memory",
  "answer key: kept (the replacement was declined)",
  "answer key: registered (secure-enclave)",
  "answer key: registered after 3 tries",
  "answer key: trying again (in 2.5 s, and on a growing wait while the core can't take it)",
  "host: safe mode ends at its next start",
  "host: stop everything: kept working",
  "host: stop everything: no-engine",
  "host: ready",
  "host: ready (safe mode)",
  "host: a window is in front",
  "host: a window is no longer in front",
  "host: the engine gave up starting the host (the notice not shown: headless)",
  "host: the engine gave up starting the host (the notice shown)",
  "pair: main.handOver at suspend: ok",
  "pair: ignored a card_placed event that isn't one",
  "pair: the daemon's UI settings aren't valid; the defaults apply",
  "pair: an empty UI list while a shell is showing; keeping it until it lasts",
  "pair: no plugin has UI yet; asking again in 500 ms",
  "pair: connected after the window said MOSS can't start",
  "pair: the daemon went away without saying so",
  "pair: no daemon for 12 s: the window says MOSS can't start; still trying",
  "pair: registered the daemon's login item: failed, 3",
  "pair: this app (release 0.125.0) is behind the engine (0.126.0); it updates to 0.126.0 before it connects",
  "pair: this app is ahead of the engine (0.126.0); only the release door is open",
  "pair: the daemon doesn't serve usage.list yet; the app runs without it and asks again",
  "pair: setting up the connection failed; given up after 4 tries",
  "updater: the daemon was still answering after 15000 ms; installing anyway",
  "release: the engine wasn't put under the home; this app starts its own copy",
  "release: the engine starts from the home's copy (release 0.125.0, the login item re-registered from it)",
  "release: the update downloaded but did not start installing; checking again later",
  "release: no engine answers after the switch; starting it through the OS",
  "release: no notice",
  "ipc: 5 s in 12.5/s (ui.open 40, size 20) out 3.0/s (props 15) cpu Browser 4.1% Sandbox helper 2.0% Pepper Plugin Broker 0.1% GPU 0.3%",
  "diag: cpu over 5 s Browser:123 4.1% Sandbox helper:77 2.0%",
  "release: notice switching",
  "release: notice behind (installing)",
  "release: a test build's stand-in update installs here (nothing is installed)",
  "release: the login item was not re-registered from the home's engine (exit 3)",
  "release: asked the OS to start the new engine (failed, 3)",
  "release: the engine has no login item; registered it so the new engine starts under supervise (ok)",
  "updater: installing 0.125.0 now the daemon is idle",
  "updater: installing 0.125.0 at the user's Quit",
  "updater: the daemon can't be asked whether it is idle; the update waits",
  "updater: the daemon refused the update's exit; 0.125.0 waits for the next idle moment",
  "updater: no GitHub publish settings in app-update.yml; this build doesn't update itself",
  "window: the test's size 800x600",
  "window: the test's size let go",
  "window: the test seam says the main window is in front",
  "window: the test seam closes the main window",
  "window: moved by its title area, from (10, 20) to (-4, 8)",
  "window: shown invisible while headless (the sealed smoke's input routing: opacity 0, ignores the mouse)",
  "window 4 stayed unresponsive: restarting in safe mode",
  "window 4 went unresponsive; not answering: none",
  "window 4 went unresponsive; not answering: moss/shell, moss/sidebar",
  "window 4: every document answers; it has 20 s to come back",
  "audio: muted (a headless run or a test build)",
  "layers: moss/island's layer connected to the core",
  "layers: acc-extra's layer connection closed (it no longer shows UI)",
  "files: acc-files: the core keeps no grants yet; the page's token works for the media URL only",
  "browser: view browser has a place in the window",
  "browser: view browser has no place in the window now",
  "browser: the panel drew the host's tab (800x600)",
  "audio: all plugin sound muted from the tray",
  "smoke: the restart is left out",
  "smoke click: sent to a surface window (visible=true)",
  "smoke drop: sent to a surface window",
  "render: a render window 1280x800 opened (hidden, offscreen) as window 7",
  "terminal: a paste of several lines was turned down",
  "welcome: this home isn't set up for a first reply; the setup guide opens",
  "ipc: counters on (every 5 s: messages by channel, CPU by process; no payloads)",
  "ipc: 5 s in 12.0/s (props 40, size 20) out 3.0/s (props 15) cpu Browser 4.1% Tab 2.0% GPU 0.3%",
  "diag: cpu over 5.0 s Browser:101 4.1% Tab:204 2.0%",
  "send: refused (not a place the user's words go)",
  "send: refused (MOSS Code isn't running) (3 like it left out)",
  "send: refused (the frame reported no user activation)",
  "overlap: the OS window list wasn't read for a press (no window id); the in-page check stands alone",
  "overlap: the OS window list read for a press (2 above, 1 of this program's own; headless: its own only; no point: a keyboard press)",
  "sealed: answer refused (the button was covered or not shown at the press)",
  "sealed: answer refused (a press on the island for a card the router placed in the window)",
  "sealed: answer refused (computer use acting)",
  "sealed: refusing a sealed load (no channel)",
  "card: 2 card(s) resolved while the connection was down, dropped",
  "layers: 7 plugin(s) with UI",
  "layers: stopping a hung layer's process (4242)",
  "layers: 2 frame(s) lost their process: moss/shell, m3",
  "layers: command moss/shell:open to window 1: 2 document(s) told, 0 not bound yet",
  "layers: refused a document load (an address no mount holds)",
  "layers: cancelled a request for another layer's own data from the shell layer's frame",
  "layers: cancelled moss/sidebar's icon for a frame main doesn't know",
  "layers: props for m4 were too large and were dropped",
  "layers: m3 (moss/shell): refused a load of an address it replaced (its frame has the newer one)",
  "layers: m3 (core) reported a height of 480",
  "layers: m3 (moss/shell) already holds 8 parts, the most it may: a sidebar instance of it gets no part placed and shows its fallback",
  "layers: refused moss/shell: its layer is shell, not sidebar",
  "layers: moss/pill may not place the browser view (it needs the browser capability)",
  "session: the spellchecker began a dictionary download (en-US); it should be off",
  "strings: moss/shell/en.json is not a valid locale",
  "theme: moss/shell/dark.css is not a valid theme",
  "surface: moss/pill#main closed",
  "surface: moss/pill#main bounds 300x80",
  "surface: moss/pill#main summoned over the main window from the tray",
  "surface: moss/pill#main hidden while a card is pending (a plugin's on-screen part)",
  "background: moss/voice#player started (may play sound)",
  "focus: moss/pill folded while key: key back to the window it took it from",
  "tray: moss/pill names a command moss/pill doesn't have",
  "keys: 3 command key(s) bound",
  "keys: moss/shell:new down from its key",
  "keys: moss/shell:new ran from its key",
  "touches: four-finger tap turned on",
  "menu: 3 item(s) at 10,20 (not shown: headless)",
  "open: settings network for moss/shell",
  "quit (tray): MOSS Code only (the engine and the host keep working)",
  "quit (menu): handover",
  "browser: the engine starts a tab's stream s1 (video,h264)",
  "browser: a tab's stream s1 started (h264)",
  "web: moss/web's page isn't one the app shows (a URL or a page in its folder, and a partition)",
  "web: moss/web's page failed to load (ERR_NAME_NOT_RESOLVED, -105); asking once more",
  "web: moss/web's page's process went (crashed)",
  "mcp-apps: a page tried to navigate away; it stays",
  "sealed-click: cover put over the button: true",
  "sealed-click: button rect=10,20 80x30 offset=0,0",
  "sealed-click: input via cdp",
  "sealed-click: no sealed frame",
];

/** Lines that carry someone else's text, as logged with the planted words, and what the file gets instead. */
const REDUCED: [string, string][] = [
  [`main: uncaught exception: Error: ${SECRET} for ${BOT}\nat run (/Users/someone/${SECRET}.ts:1:1)`, "main: uncaught exception (text not kept in the file)"],
  [`main: unhandled rejection: ${SECRET}`, "main: unhandled rejection (text not kept in the file)"],
  [`updater: ${SECRET}; quitting`, "updater: recovering (reason not kept); quitting"],
  [`window: shown while headless (code: ${BOT}'s inbox)`, "window: shown while headless"],
  [`window: shown invisible while headless (the sealed smoke's fallback card ${CARD}: opacity 0, ignores the mouse)`, "window: shown invisible while headless (the sealed smoke's fallback card)"],
  [`window: a drag was refused (${SECRET})`, "window: a drag was refused"],
  [`audio: played unmuted in a headless run or a test build (${URL_})`, "audio: played unmuted in a headless run or a test build"],
  [`pair: ready (${SECRET})`, "pair: ready"],
  [`pair: a dial failed: ${SECRET}`, "pair: a connection step failed (text not kept)"],
  [`pair: a listener for ${CARD} failed: ${SECRET}`, "pair: a connection step failed (text not kept)"],
  [`pair: the release door's setup failed: ${SECRET}`, "pair: a connection step failed (text not kept)"],
  ["pair: the daemon refused the hello (behind, needs 0.126.0)", "pair: the daemon refused the hello (behind, needs 0.126.0)"],
  [`pair: the daemon refused the hello (${SECRET})`, "pair: the daemon refused the hello"],
  [`pair: not starting the daemon (${SECRET}): the app is quitting`, "pair: not starting the daemon: the app is quitting"],
  [`pair: started the daemon through the OS (${SECRET}): failed, 3`, "pair: started the daemon through the OS: failed, 3"],
  [`pair: setting up the connection failed: ${SECRET}; asking again in 500 ms`, "pair: setting up the connection failed; asking again in 500 ms"],
  [`pair: pair.quit failed: ${SECRET}`, "pair: pair.quit failed"],
  [`pair: reloading the registry failed: ${SECRET}`, "pair: reloading the registry failed"],
  [`pair: usage.list failed: ${SECRET}`, "pair: usage.list failed"],
  [`updater: the daemon was still answering after 15000 ms; ${SECRET}`, "updater: the daemon was still answering; installing anyway"],
  [`release: this app's record was not written: ${SECRET}`, "release: this copy of MOSS Code was not recorded"],
  [`release: looking for release 0.125.0: failed (${SECRET})`, "release: looking for release 0.125.0: failed"],
  [`release: the engine did not take release.bring: ${SECRET}`, "release: the engine did not take release.bring"],
  [`release: starting the new engine failed: ${SECRET}`, "release: starting the engine failed"],
  [`release: the login item was not re-registered from the home's engine: ${SECRET}`, "release: the login item was not re-registered from the home's engine"],
  [`updater: pair.exiting{update} refused or not answered: ${SECRET}`, "updater: pair.exiting{update} refused or not answered"],
  [`updater: the install threw: ${SECRET}`, "updater: the install threw"],
  [`updater: install.json not written: ${SECRET}`, "updater: install.json not written"],
  [`updater: 0.125.0 waits for an idle moment (${SECRET}, ${BOT})`, "updater: (text not kept in the file)"],
  [`updater: ${SECRET}`, "updater: (text not kept in the file)"],
  [`the daemon asked the app to quit (${SECRET})`, "the daemon asked the app to quit"],
  [`host: the engine stops it (${SECRET})`, "host: the engine stops it"],
  [`host: leaving (${SECRET})`, "host: leaving"],
  [`host: host.ready was refused (${SECRET})`, "host: host.ready was refused"],
  [`host: stop everything failed: ${SECRET}`, "host: stop everything failed"],
  [`screen: no add-on (${SECRET}); no housing is known`, "screen: no add-on; no housing is known"],
  [`layers: no icon for ${BOT}-plugin: ${SECRET}`, "layers: no icon for a plugin"],
  [`layer: ${BOT}-plugin: ${SECRET}`, "layer: an error in a plugin's layer (text not kept)"],
  [`press: a call from frame 4:2 found no press of its own (${SECRET}; the latest press: {"x":1})`, "press: a call from a frame found no press of its own"],
  [`send: refused (images: ${SECRET})`, "send: refused (the reason isn't kept in the file)"],
  [`send: refused (the main process saw no key press or click land in this frame just before (${SECRET}))`, "send: refused (the reason isn't kept in the file)"],
  [`send: the core refused user.send (${SECRET} for ${BOT})`, "send: the core refused user.send"],
  [`sealed: answer refused (a window lies over the button: ${BOT}'s window)`, "sealed: answer refused (a window lies over the button)"],
  [`sealed: answer held back (this desktop's answer key isn't registered: ${SECRET})`, "sealed: answer held back (this desktop's answer key isn't registered)"],
  [`sealed: answer refused at handler (${SECRET})`, "sealed: answer refused at handler"],
  [`sealed: answer refused (${SECRET})`, "sealed: answer refused (reason not kept)"],
  [`sealed: core refused answer (${SECRET})`, "sealed: the core refused an answer"],
  [`sealed: answer accepted for ${CARD}`, "sealed: an answer was accepted"],
  [`sealed: ${CARD} own visible in the main window`, "sealed: a card's button is visible in the main window"],
  [`sealed: press on ${CARD} own in the main window: fresh report uncovered after 120 ms`, "sealed: a press: fresh report uncovered after 120 ms"],
  [`sealed: press on ${CARD} own in the main window: ${SECRET}`, "sealed: a press: (the page's word not kept)"],
  [`sealed: a press over ${CARD} own in the main window reached no sealed page; it says press again`, "sealed: a press reached no sealed page; it says press again"],
  [`sealed: ${CARD} own in window 3 said nothing visible 900 ms after it loaded: its frame wasn't found in its embedder`, "sealed: a card said nothing visible 900 ms after it loaded: its frame wasn't found in its embedder"],
  [`card: ${CARD} frames asked in the main window 120 ms after it arrived`, "card: frames asked in the main window 120 ms after it arrived"],
  [`card: ${CARD} first ask in moss/pill#main before it arrived (made)`, "card: first ask in moss/pill#main before it arrived (made)"],
  [`card: ${CARD} asks in window 3 before the first made: 2 not yet, 1 refused`, "card: asks in window 3 before the first made: 2 not yet, 1 refused"],
  [`card: ${CARD} pending told to moss/shell's layer 40 ms after it arrived`, "card: pending told to moss/shell's layer 40 ms after it arrived"],
  [`card: ${CARD} both buttons visible in the main window 250 ms after it arrived`, "card: both buttons visible in the main window 250 ms after it arrived"],
  [`card: ${CARD} fallback timer armed (a button stopped showing in the main window)`, "card: fallback timer armed (a button stopped showing in the main window)"],
  [`card: a change card ${CARD} arrived (waiting when the app connected)`, "card: a change card arrived (waiting when the app connected)"],
  [`card: the fallback card for ${CARD} was not drawn (its answer is on its way to the core)`, "card: the fallback card was not drawn (its answer is on its way to the core)"],
  [`card: the window's strip for ${CARD} is another program's to draw (island)`, "card: the window's strip is another program's to draw (island)"],
  [`card: the fallback card for ${CARD} was not shown (headless)`, "card: the fallback card was not shown (headless)"],
  [`card: the fallback card for ${CARD} (tool) is shown`, "card: the fallback card (tool) is shown"],
  [`card: ${CARD} shown on the island (window not foreground)`, "card: a card shown on the island (window not foreground)"],
  [`card: ${CARD} moved to the island (window not foreground) from the conversation (window foreground)`, "card: a card moved to the island (window not foreground) from the conversation (window foreground)"],
  [`card: ${CARD} ${BOT} wants ${SECRET}`, "card: a card (text not kept)"],
  [`router: ${CARD} placed window (moss ${SECRET}) from island`, "router: a card was placed (window)"],
  [`notify: closed (${CARD})`, "notify: closed"],
  [`notify: a headless run shows no notification (${CARD})`, "notify: a headless run shows no notification"],
  [`browser: the tab events refused (${SECRET}); the host's state only`, "browser: the tab events refused; the host's state only"],
  [`browser: shutdown failed: ${SECRET}`, "browser: shutdown failed"],
  [`browser: tab.open failed: ${SECRET}`, "browser: tab.open failed"],
  [`browser: the engine refused a tab's picture (640x480): ${SECRET}`, "browser: the engine refused a tab's picture"],
  [`mcp-apps: a link didn't open (${URL_})`, "mcp-apps: a link didn't open"],
  [`mcp-apps: a page didn't load: ${SECRET}`, "mcp-apps: a page didn't load"],
  [`open: would open a page in the browser (${URL_})`, "open: would open a page in the browser"],
  [`surface: ${BOT}-plugin's settings couldn't be read (${SECRET}); its surfaces that need one stay closed`, "surface: a plugin's settings couldn't be read; its surfaces that need one stay closed"],
  [`surface: a request visible=true,${SECRET} visible=true`, "surface: a request"],
  [`tray: moss/pill#main's command didn't run (${SECRET})`, "tray: a command didn't run"],
  [`tray: none here (${SECRET})`, "tray: none here"],
  [`touches: four-finger tap off (${SECRET})`, "touches: four-finger tap off"],
  [`touches: no add-on (${SECRET}); no four-finger tap`, "touches: no add-on; no four-finger tap"],
  [`touches: a frame failed (${SECRET})`, "touches: a frame failed"],
  ["keys: pressed Control+s in the window", "keys: a key in the window"],
  [`keys: an up of "${SECRET}" (KeyS; ctrl) is not moss/shell's`, "keys: an up of a key that isn't a plugin's"],
  [`keys: an unbound keyDown made Control+${SECRET}`, "keys: an unbound key event"],
  [`keys: moss/shell:new down failed: ${SECRET}`, "keys: a command's key (down) failed"],
  [`keys: reading the commands' keys failed: ${SECRET}`, "keys: reading the commands' keys failed"],
  [`keys: moss/shell:new failed: ${SECRET}`, "keys: a command failed"],
  [`overlap: no window list (${SECRET}); the in-page check stands alone`, "overlap: no window list; the in-page check stands alone"],
  [`overlap: the OS window list couldn't be read for a press (${SECRET}); the in-page check stands alone`, "overlap: the OS window list couldn't be read for a press; the in-page check stands alone"],
  [`prefs: not saved (${SECRET})`, "prefs: not saved"],
  [`tree: acc-copy: session.resend refused (${SECRET})`, "tree: acc-copy: session.resend refused"],
  [`tree: acc-copy: session.resend went through`, "tree: acc-copy: session.resend went through"],
  [`tree: acc-copy: an unknown method refused (${SECRET})`, "tree: acc-copy: an unknown method refused"],
  [`tree: acc-copy: conversation.messageAction ran acc-copy's ${SECRET}`, "tree: acc-copy: conversation.messageAction ran"],
  [`browser: view browser shows the host's tab ${SECRET}`, "browser: view browser shows the host's tab"],
  [`answer key: not replaced: ${SECRET}`, "answer key: not replaced"],
  [`answer key: not registered (${SECRET})`, "answer key: not registered"],
  [`answer key: the replacement's answer was lost (${SECRET}); its key stays staged`, "answer key: the replacement's answer was lost; its key stays staged"],
  [`answer key: waiting: the core's ${SECRET}`, "answer key: waiting"],
  [`layers: a window tried to leave for ${URL_}`, "layers: a window tried to leave (the address isn't kept)"],
  [`layers: refused a request to the network from ${URL_} (no layer declares a host yet)`, "layers: refused a request to the network (no layer declares a host yet)"],
  [`layers: moss:ui.open failed: ${SECRET}`, "layers: moss:ui.open failed"],
  [`layers: moss:ui.open failed: token abc failed: ${SECRET}`, "layers: moss:ui.open failed"],
  [`layers: token abc failed: ${SECRET}`, "layers: (text not kept in the file)"],
  [`layers: a call from frame 3:4 (${BOT}) that is bound to no mount`, "layers: a call from a frame bound to no mount"],
  [`layers: a message to m3 was lost: ${SECRET}`, "layers: a message to a mount was lost"],
  [`layers: m3 (moss/shell): refused a document load (${SECRET}; a fresh address went less than a second ago)`, "layers: a document load was refused (a fresh address went less than a second ago)"],
  [`layers: m3 loads again (${SECRET})`, "layers: a mount loads again"],
  [`layers: moss/shell: ${SECRET} refused (${SECRET}); frame 3:4, active true`, "layers: a plugin's call was refused (reason not kept)"],
  [`layers: could not stop process 4242: ${SECRET}`, "layers: could not stop a process"],
  [`strings: moss/shell/en.json could not be read: ${SECRET}`, "strings: a plugin's strings could not be read"],
  [`theme: moss/shell/dark.css could not be read: ${SECRET}`, "theme: a plugin's theme could not be read"],
  [`theme: moss/shell/dark.css: dropped ${SECRET}; url(${URL_})`, "theme: a plugin's theme had declarations dropped"],
  [`theme: moss/shell: the shell's chrome group is not used (${SECRET})`, "theme: a group of a plugin's theme is not used"],
  [`web: a page tried to leave ${URL_} for another site; it stays`, "web: a page tried to leave its site for another; it stays"],
  [`web: moss/web's page didn't load: ${SECRET}`, "web: a plugin's page didn't load"],
  [`sealed-click: frame found moss-sealed://${CARD}/own`, "sealed-click: a sealed frame"],
  [`sealed-click: classic scroll bars couldn't be set (try 2: ${SECRET}; the same frame)`, "sealed-click: a step failed (reason not kept)"],
  // Anything not classed: reduced to its source word.
  [`something new: ${SECRET} ${CARD}`, "something new: (text not kept in the file)"],
  [`sealed-click: label html=${SECRET} hasBold=true sealed=true`, "sealed-click: (text not kept in the file)"],
  [`start failed: ${SECRET}`, "start failed: (text not kept in the file)"],
  [`${SECRET} without a source word`, "log: (text not kept in the file)"],
];

describe("what MOSS Code writes to its log file", () => {
  test("lines of fixed words, numbers, versions, kinds and one id token are kept as they are", () => {
    for (const l of KEPT) expect([l, fileLine(l)]).toEqual([l, l]);
  });

  test("a line that carries an error's text, a card's id, a page's address, a key or a plugin's words is reduced to its fixed part", () => {
    for (const [from, to] of REDUCED) {
      const got = fileLine(from);
      expect([from, got]).toEqual([from, to]);
      for (const word of [SECRET, CARD, BOT, "private.example"]) expect([from, got.includes(word)]).toEqual([from, false]);
    }
  });

  test("a kept pattern is never the one that lets an error's words through: the planted text in a closed-set slot is not kept", () => {
    for (const l of [
      `send: refused (${SECRET})`,
      `answer key: kept (the replacement was ${SECRET} words)`,
      `quit (tray): ${SECRET} and more words`,
      `layers: m3 (moss/shell) reported a height of ${SECRET}`,
      `pair: no daemon for ${SECRET} s: the window says MOSS can't start; still trying`,
      `surface: moss/pill#main summoned ${SECRET} and then some other words of a plugin's own, which are not a how`,
      `window 4 went unresponsive; not answering: ${SECRET} words with spaces`,
    ]) expect([l, fileLine(l).includes(SECRET)]).toEqual([l, false]);
  });

  test("every pattern in the lists is used by a line above (a rule nothing reaches is dead text)", () => {
    const keptHit = new Set<number>();
    for (const l of KEPT) keptHit.add(KEEP.findIndex((r) => r.test(l)));
    expect(KEEP.map((_, i) => i).filter((i) => !keptHit.has(i))).toEqual([]);
    const reducedHit = new Set<number>();
    for (const [from] of REDUCED) {
      const one = from.replace(/[\r\n]+/g, " ");
      reducedHit.add(REDUCE.findIndex(([r]) => r.test(one)));
    }
    expect(REDUCE.map((_, i) => i).filter((i) => !reducedHit.has(i)).map((i) => REDUCE[i]![0].source)).toEqual([]);
  });

  test("the lines other code builds are classed too: a card's place (card-place.ts) never carries its id, the ipc counter's line is kept", () => {
    const places = ["conversation", "window", "island"] as const;
    for (const now of places) {
      const first = fileLine(placeLine(CARD, now));
      expect([first.startsWith("card: a card shown "), first.includes(CARD)]).toEqual([true, false]);
      for (const before of places.filter((p) => p !== now)) {
        const moved = fileLine(placeLine(CARD, now, before));
        expect([moved.startsWith("card: a card moved to the "), moved.includes(CARD)]).toEqual([true, false]);
      }
    }
    const counter = ipcLine({ seconds: 5, in: new Map([["props", 40], ["size", 20]]), out: new Map([["props", 15]]) } as never, [{ type: "Browser", percent: 4.1 }, { type: "Tab", percent: 2 }]);
    expect(fileLine(counter)).toBe(counter);
  });

  test("a line break never splits a line, and a new kind of line is not in the file until it is added", () => {
    expect(fileLine("host: ready\nsecond: line")).toBe("host: (text not kept in the file)");
    expect(fileLine("brand new: " + SECRET)).not.toContain(SECRET);
  });

  // The tripwire: a log line added to MOSS Code's main process is not in the file (it is reduced to "text not kept") until someone has
  // classed it here and in file-log.ts, so the count of literal call sites per file is pinned, and the call sites whose line is built
  // elsewhere are named.
  test("MOSS Code's literal log call sites are the ones classed above (a new one fails here: class it in file-log.ts and the lists, then change the count)", () => {
    const root = join(import.meta.dir, "..", "src", "main");
    const counts: Record<string, number> = {};
    const dynamic: Record<string, number> = {};
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
    for (const f of walk(root).sort()) {
      const text = readFileSync(f, "utf8");
      const rel = f.slice(root.length + 1).replaceAll("\\", "/");
      const n = [...text.matchAll(/(^|[^A-Za-z0-9_.])(?:this\.|d\.|o\.|deps\.)?log\(\s*[`"]/gm)].length;
      if (n > 0) counts[rel] = n;
      // A call whose line is a variable, a ternary or a function's result (`log(placeLine(...))`), not a declaration of a `log(line: string)` method.
      const m = [...text.matchAll(/(^|[^A-Za-z0-9_.])(?:this\.|d\.|o\.|deps\.)?log\(\s*(?![`"])(?!line: string)(?!\) )[^)\s]/gm)].length;
      if (m > 0) dynamic[rel] = m;
    }
    expect(counts).toEqual({
      "answer-key.ts": 16, "browser/frame-sender.ts": 2, "host-runtime.ts": 6, "housing.ts": 1, "index.ts": 181, "overlap.ts": 1, "pair/optional-calls.ts": 1,
      "pair/pair.ts": 19, "pair/setup-retry.ts": 2, "prefs.ts": 1, "preview-control.ts": 4, "touch-tap.ts": 5, "tray.ts": 1, "ui/electron.ts": 17, "ui/model.ts": 2,
      "ui/runtime.ts": 12, "ui/strings.ts": 2, "ui/theme.ts": 5, "ui/web-views.ts": 10,
    });
    // Built elsewhere, each shaped by code that is in the lists above or reduced to its source word: the ternaries of answer-key.ts and the
    // audio line, `placeLine` (card-place.ts), the ipc counter's `ipcLine`, and the pass-throughs of one `log` into another module.
    expect(dynamic).toEqual({ "answer-key.ts": 1, "index.ts": 7, "ui/ipc-stats.ts": 1 });
  });

  // The release and updater code is shared with MOSS (packages/app-release) and logs through the app's `log`, so its lines are classed here too.
  test("the shared release code's literal log call sites are the ones classed above", () => {
    const dir = join(import.meta.dir, "..", "..", "..", "packages", "app-release", "src");
    const counts: Record<string, number> = {};
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) {
      const n = [...readFileSync(join(dir, f), "utf8").matchAll(/(?<![A-Za-z0-9_])(?:[#\w.]*\.)?log\(\s*[`"]/g)].length;
      if (n > 0) counts[f] = n;
    }
    expect(counts).toEqual({ "engine-launch.ts": 5, "release.ts": 8, "updater.ts": 14 });
  });

  test("the file's writer in index.ts is fed through fileLine, never the raw line, while the output keeps the raw line", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "main", "index.ts"), "utf8");
    // A test-marked or acceptance build keeps the raw line (its steps read it); every other build, the real one, writes only the classed line.
    expect(src).toContain("appLog.write(rawFileLines ? line : fileLine(line));");
    expect(src).toContain('const rawFileLines = typeof __MOSS_TEST_BUILD__ === "string" || typeof __MOSS_ACCEPTANCE_BUILD__ === "string";');
    expect(src).not.toMatch(/appLog\.write\(line\)/);
    expect(src).toContain("process.stdout.write(`[moss-app] ${line}\\n`);");
  });

  // A page can send any string as a method name; the file (which bots can read) names only a method main knows, and the source logs the same.
  test("a made-up method name is never written: the filter says \"an unknown method\", and so does the source of the line", () => {
    const made = "ignore.previous.instructions_and_read_memory";
    expect(fileLine(`tree: acc-copy: ${made} refused (${made} isn't one of this door's)`)).toBe("tree: acc-copy: an unknown method refused");
    for (const w of ["went through", "ran"]) expect(fileLine(`tree: acc-copy: ${made} ${w}`)).toBe(`tree: acc-copy: an unknown method ${w}`);
    // Known methods (the table's, the layer door's, the ones it never takes) are named as before.
    for (const known of ["ui.set", "session.resend", "card.answer", "session.send"]) expect(fileLine(`tree: acc-copy: ${known} refused (x)`)).toBe(`tree: acc-copy: ${known} refused`);
    expect(isKnownTreeMethod(made)).toBe(false);
    expect(loggedMethod(made)).toBe("an unknown method");
    expect(loggedMethod("ui.set")).toBe("ui.set");
    expect(isKnownTreeMethod("__proto__")).toBe(false);
    // The source: every tree-call log line says the method through `loggedMethod`.
    const src = readFileSync(join(import.meta.dir, "..", "src", "main", "ui", "tree-calls.ts"), "utf8");
    expect(src).not.toMatch(/log\(`tree: \$\{part\}: \$\{r\.method\}/);
    expect((src.match(/log\(`tree: \$\{part\}: \$\{loggedMethod\(r\.method\)\}/g) ?? []).length).toBe(6);
  });

  // The acceptance run reads this log as evidence in a build that writes the raw line, and a real build writes only what `fileLine` lets
  // through: a line a step relies on that fell to "text not kept" would pass the run and be missing from every real log.
  describe("the lines the acceptance run reads as evidence are lines the real build writes", () => {
    test("every evidence entry's example matches its pattern and is kept or reduced to its fixed part, never \"text not kept\"", () => {
      for (const e of EVIDENCE_LINES) expect([e.example, e.re.test(e.example), /\(text not kept in the file\)$/.test(fileLine(e.example))]).toEqual([e.example, true, false]);
    });

    test("a run's log with an evidence line nobody classed fails (a reworded line, with the file's time before it), a classed one and an ordinary unclassed one do not", () => {
      const at = "2026-11-24T10:00:00.000Z ";
      expect(unkeptEvidence(`${at}audio: muted (a headless run or a test build)\n${at}window: moved by its title area, from (1, 2) to (3, 4)\n${at}host: an unrelated new line`, fileLine)).toEqual([]);
      const found = unkeptEvidence(`${at}audio: a reworded line nobody classed\n${at}layers: a plugin's new sentence`, fileLine);
      expect(found.map((f) => f.line)).toEqual(["audio: a reworded line nobody classed"]);
      expect(found[0]!.for).toBe("sound muted, or not");
    });

    // The literal strings the steps look for in the app's log (`includes("layers: ...")`): each is a line of the list. A step that starts
    // relying on a line adds it to scripts/acceptance/evidence-lines.ts and classes it in file-log.ts. What is not a line of its own (an id, a
    // fragment, a line of the MOSS app, which has its own file filter) is not here; the one line no code writes any more is named.
    test("every log line a step looks for by its literal text is in the evidence list", () => {
      const dir = join(import.meta.dir, "..", "..", "..", "scripts", "acceptance");
      const NOT_A_LINE_OF_THIS_APP = new Set(["the window's strip for x"]);
      const uncovered: string[] = [];
      let needles = 0;
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "evidence-lines.ts" && !n.endsWith(".test.ts"))) {
        for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
          if (!/appLog|app\.log/.test(l)) continue;
          for (const m of l.matchAll(/\.includes\((["`])((?:(?!\1).)*)\1\)/g)) {
            const needle = m[2]!.replace(/\$\{[^}]*\}/g, "x");
            if (!/^[a-z][a-z -]{0,24}: /.test(needle) || needle.includes("MOSS's")) continue;
            needles++;
            const covered = EVIDENCE_LINES.some((e) => [needle, `${needle}x`, `${needle} x`].some((n) => e.re.test(n)) || e.example.includes(needle));
            if (!covered && !NOT_A_LINE_OF_THIS_APP.has(needle)) uncovered.push(`${f}: ${needle}`);
          }
        }
      }
      expect(uncovered).toEqual([]);
      expect(needles).toBeGreaterThan(8);
    });
  });
});
