// What MOSS Code's log FILE may hold (`<home>/logs/app.log`). Bots can read the home's logs, so the file is for explaining what the app
// did (a refused press, a plugin's part that would not load, a connection that dropped) and nothing a message, a card, a page or an
// error could carry: it holds the check that refused, the numbers, the app's lifecycle lines and error KINDS (a code, a class, an
// outcome), never an error's message text or stack, a card's id or text, a page's address, a key that was pressed, or a word of a
// plugin's own besides its id.
//
// `log()` in index.ts still prints every line to the process's output as it always did (the acceptance run reads its card ids and
// timings there); only what is written to the file goes through `fileLine`. It is DEFAULT-DENY, as MOSS's own file is
// (`apps/moss/src/main/file-log.ts`): a line is written as it is when it matches a pattern in KEEP, whose variable parts are only
// numbers, versions, one word from a closed set, or ONE token of a plugin's, mount's or surface's id (no spaces, at most 100
// characters: the plugin list in the home's files names them anyway); a line that carries text of someone else's (an error's message, a
// card's id, a page's address, a plugin's words) is rewritten to its fixed part by a rule in REDUCE; any other line is reduced to its
// source word and "text not kept". A new log line is therefore never in the file until it is added here: the test in
// test/file-log.test.ts counts the literal logging call sites in every file of the app and fails on a new one.

import { isKnownTreeMethod } from "./ui/tree-calls";

const V = "[\\w.+-]{1,40}";
/** An Electron process type as the metrics name it ("Browser", "Tab", "GPU", "Sandbox helper", "Pepper Plugin Broker"): one to three words. */
const PROC = "[A-Za-z.-]{1,24}(?: [A-Za-z]{1,12}){0,2}";
const N = "\\d{1,9}";
const SN = "-?\\d{1,6}";
const DEC = "[\\d.]{1,10}";
/** One plugin's, mount's or surface's id (or ref) as one token: letters, digits and the id grammar's punctuation, no spaces. */
const REF = "[\\w.:/#@+-]{1,100}";
/** A word from a closed set the app's own code spells out (a kind, an outcome, a phase). */
const W = "[a-z-]{1,24}";
/** What the app calls a window or a surface (`surfaceName` in index.ts): its fixed phrases, a window number, or a surface's ref. */
const SURF = `(?:a frame with no window|the main window|the window's strip \\(window \\d{1,6}\\)|the fallback card \\(window \\d{1,6}\\)|window \\d{1,6}|${REF})`;
/** A card's id, which the file never keeps. */
const CARD = "\\S{1,100}";
const OKFAIL = "(?:ok|failed, \\S{1,8})";

const kp = (source: string): RegExp => new RegExp(`^(?:${source})$`);

/** Lines written as they are: fixed words, numbers, versions, kinds, one id token. */
export const KEEP: RegExp[] = [
  // answer-key.ts
  kp(String.raw`answer key: (?:the kept key couldn't be read; a new one is made|the core didn't say which card; the new key stays staged|replacing it waits on its card|kept \(the replacement's card is over\)|the core doesn't hold the new key yet; it stays staged|replaced|the new key stays staged in this computer's store until the next start|this computer's secret store is plain text \(no Secret Service\); the key stays in memory)`),
  kp(String.raw`answer key: (?:kept \(the replacement was ${W}\)|registered \(${W}\)|registered after ${N} tries|trying again \(in ${DEC} s, and on a growing wait while the core can't take it\))`),
  // host-runtime.ts and the host's lines in index.ts
  kp(String.raw`host: (?:safe mode ends at its next start|stop everything: kept working|stop everything: (?:stopped|kept|no-engine)|ready(?: \(safe mode\))?|a window (?:is|is no longer) in front|the engine gave up starting the host \(the notice (?:not shown: (?:headless|no notifications)|shown)\))`),
  // pair: the app's connection to the engine
  kp(String.raw`pair: (?:main\.handOver at suspend: (?:ok|no)|ignored a (?:ui_settings_changed|card_requested|card_placed) event that isn't one|the daemon's UI settings aren't valid; the defaults apply|an empty UI list while a shell is showing; keeping it until it lasts|no plugin has UI yet; asking again in ${N} ms|connected after the window said MOSS can't start|the daemon went away without saying so|no daemon for ${N} s: the window says MOSS can't start; still trying|registered the daemon's login item: ${OKFAIL}|this app \(release ${V}\) is behind the engine \(${V}\); it updates to ${V} before it connects|this app is ahead of the engine \(${V}\); only the release door is open|the daemon doesn't serve [\w.]{1,60} yet; the app runs without it and asks again)`),
  kp(String.raw`updater: the daemon was still answering after ${N} ms; installing anyway`),
  // The shared release code (packages/app-release: release.ts, updater.ts, engine-launch.ts) logs through the same `log`.
  kp(String.raw`updater: (?:installing ${V}(?: now the daemon is idle| at the user's Quit)?|the daemon can't be asked whether it is idle; the update waits|the daemon refused the update's exit; ${V} waits for the next idle moment|no GitHub publish settings in app-update\.yml; this build doesn't update itself)`),
  kp(String.raw`release: (?:the engine wasn't put under the home; this app starts its own copy|the engine starts from the home's copy \(release ${V}(?:, the login item re-registered from it)?\)|the update downloaded but did not start installing; checking again later|no engine answers after the switch; starting it through the OS|no notice|notice [a-z-]{1,30}(?: \([a-z-]{1,30}\))?|a test build's stand-in update installs here \(nothing is installed\)|the login item was not re-registered from the home's engine \(exit \S{1,8}\)|asked the OS to start the new engine \(${OKFAIL}\)|the engine has no login item; registered it so the new engine starts under supervise \(${OKFAIL}\))`),
  // windows, audio, the test seams
  kp(String.raw`window: (?:the test's size ${N}x${N}|the test's size let go|the test seam (?:says the main window is (?:in front|not in front)|closes the main window|opens the main window)|a drag began \(window at ${SN}, ${SN}; cursor at (?:${SN}|\?), (?:${SN}|\?)\)|a drag ended with the window where it began \(${SN}, ${SN}\)|the test seam moves the main window to \(${SN}, ${SN}\)|moved by its title area, from \(${SN}, ${SN}\) to \(${SN}, ${SN}\)|shown invisible while headless \(the sealed smoke's input routing: opacity 0, ignores the mouse\))`),
  kp(String.raw`window ${N} (?:stayed unresponsive: restarting in safe mode|went unresponsive; not answering: (?:none|${REF}(?:, ${REF})*))`),
  kp(String.raw`window ${N}: every document answers; it has ${N} s to come back`),
  kp(String.raw`audio: (?:muted \(a headless run or a test build\)|NOT muted in a headless run or a test build|all plugin sound (?:muted|unmuted) from the tray)`),
  kp(String.raw`smoke: the restart is left out`),
  kp(String.raw`smoke click: sent to a surface window \(visible=(?:true|false)\)`),
  kp(String.raw`smoke drop: sent to a surface window`),
  kp(String.raw`render: a render window ${N}x${N} opened \(hidden, offscreen\) as window ${N}`),
  kp(String.raw`terminal: a paste of several lines was turned down`),
  kp(String.raw`welcome: this home isn't set up for a first reply; the setup guide opens`),
  kp(String.raw`ipc: counters on \(every 5 s: messages by channel, CPU by process; no payloads\)`),
  kp(String.raw`ipc: ${DEC} s in ${DEC}/s \([\w:., -]{0,160}\) out ${DEC}/s \([\w:., -]{0,160}\) cpu(?: ${PROC} ${DEC}%){0,16}`),
  kp(String.raw`diag: cpu over ${DEC} s(?: ${PROC}:\d{1,9} -?${DEC}%){1,40}`),
  // the press check and the refusals
  kp(String.raw`send: refused \((?:not a place the user's words go|MOSS Code isn't running|the frame reported no user activation)\)(?: \(\d{1,6} like it left out\))?`),
  kp(String.raw`overlap: (?:the OS window list wasn't read for a press \((?:no window list here|no window id)\); the in-page check stands alone|the OS window list read for a press \(${N} above, ${N} of this program's own(?:; headless: its own only)?(?:; no point: a keyboard press)?\))`),
  // sealed pages and cards
  kp(String.raw`sealed: answer refused \((?:the button was covered or not shown at the press|the page's visibility report didn't come in time|no visibility report came with the press|a press (?:on the island|in the window) for a card the router placed (?:on the island|in the window)|no answer key|no client|no option|computer use acting)\)`),
  kp(String.raw`sealed: refusing a sealed load \((?:bad host|bad token|no channel)\)`),
  kp(String.raw`card: ${N} card\(s\) resolved while the connection was down, dropped`),
  // layers and plugins' parts (a plugin or mount is named by its id, one token)
  kp(String.raw`layers: (?:${N} plugin\(s\) with UI|stopping a hung layer's process \(${N}\)|${N} frame\(s\) lost their process: (?:${REF}(?:, ${REF})*)?|command ${REF} to window ${N}: ${N} document\(s\) told, ${N} not bound yet|refused a document load \(an address no mount holds\))`),
  kp(String.raw`layers: cancelled (?:a request for another layer's own data from|${REF}'s icon for) (?:a frame main doesn't know|the ${REF} layer's frame)`),
  kp(String.raw`layers: props for ${REF} were too large and were dropped`),
  // A layer's own connection to the core (the acceptance run reads these two as evidence: scripts/acceptance/evidence-lines.ts).
  kp(String.raw`layers: ${REF}'s layer (?:connected to the core|connection closed \(it no longer shows UI\))`),
  kp(String.raw`files: ${REF}: the core keeps no grants yet; the page's token works for the media URL only`),
  kp(String.raw`layers: ${REF} \(${REF}\): refused a load of an address it replaced \(its frame has the newer one\)`),
  kp(String.raw`layers: ${REF} \(${REF}\) reported a height of -?${N}`),
  kp(String.raw`layers: ${REF} \(${REF}\) already holds ${N} parts, the most it may: a [a-z-]{1,24} instance of it gets no part placed and shows its fallback`),
  kp(String.raw`layers: refused ${REF}: its layer is ${REF}, not ${REF}`),
  kp(String.raw`layers: ${REF} may not place (?:the [a-z-]{1,24} view \(it needs the browser capability\)|an app view \(it needs a conversation or session read capability\))`),
  kp(String.raw`session: the spellchecker began a dictionary download \([A-Za-z-]{1,12}\); it should be off`),
  kp(String.raw`strings: ${REF}/[\w.-]{1,60} is not a valid locale`),
  kp(String.raw`theme: ${REF}/[\w.-]{1,60} is not a valid theme`),
  // surfaces, background parts, keys, tray
  kp(String.raw`surface: ${REF} (?:closed|opened|bounds ${N}x${N}|sized to ${N}x${N}|(?:put away|summoned(?: over the main window)?|back to its usual place \(not shown: the main window is in front\)|shown) [a-z' -]{1,40}|hidden while a card is pending \(a plugin's on-screen part\)|back \((?:it draws the pending card|no card pending here)\))`),
  kp(String.raw`background: ${REF} (?:stopped|started(?: \(may play sound\))?)`),
  kp(String.raw`focus: ${REF} folded while key: key back to the window it took it from`),
  kp(String.raw`tray: ${REF} names a command ${REF} doesn't have`),
  kp(String.raw`keys: (?:${N} command key\(s\) bound|${REF} (?:down|up|repeat) from its key|${REF} ran from its key)`),
  kp(String.raw`touches: four-finger tap (?:turned (?:on|off)|listening|found no trackpad)`),
  kp(String.raw`menu: ${N} item\(s\) at ${SN},${SN} \(not shown: headless\)`),
  kp(String.raw`open: [a-z-]{1,24}(?: [\w-]{1,40})? for ${REF}`),
  kp(String.raw`quit \(${W}\): (?:MOSS Code only \(the engine and the host keep working\)|[a-z-]{1,24})`),
  kp(String.raw`browser: (?:the engine (?:starts|stops) a tab's stream [\w-]{1,40} \([\w.,-]{1,60}\)|the test seam pressed the panel at ${SN},${SN} \(${N} view\(s\)\)|a tab's stream [\w-]{1,40} started \([\w.-]{1,40}\))`),
  kp(String.raw`browser: (?:view [\w-]{1,40} has (?:a|no) place in the window(?: now)?|the panel drew the host's tab \(${N}x${N}\))`),
  kp(String.raw`web: ${REF}'s page(?: isn't one the app shows \(a URL or a page in its folder, and a partition\)| failed to load \([A-Z_0-9]{1,50}, -?\d{1,6}\)(?:; asking once more)?|'s process went \([a-z-]{1,30}\))`),
  kp(String.raw`mcp-apps: (?:a page asked to open a link with no press just before; it didn't|a page tried to navigate away; it stays|a page's process went \([a-z-]{1,30}\))`),
  // the sealed-click smoke (a test-marked build only)
  kp(String.raw`sealed-click: (?:main window shown invisible for input routing|classic scroll bars on the sealed page \(client ${N}\)|cover put over the button: (?:true|false)|dimmed the button to opacity ${DEC} \(read back; try ${N}\)|dim verdict (?:never flipped|not visible) after -?${N} ms \(was visible before the dim\)|cover verdict (?:never flipped|not visible) after -?${N} ms \(was visible before the cover\)|cover verdict never visible \(not reported visible before the cover\)|button visibility seen=\w{1,10}|button has no size yet, retrying|button rect=${SN},${SN} ${SN}x${SN} offset=${SN},${SN}|press sent at ${SN},${SN}|the button's opacity at the press: [\w.]{1,10}(?: \(another frame than the one dimmed\))?|moss iframe pointer-events: [\w-]{1,20}|input via (?:refused|cdp|sendInputEvent)|missed press set up [\w-]{1,20}|after the missed press state=[\w-]{0,24}|press -?${N} ms into the pulse|press -?${N} ms after the (?:parent )?cover|no button rect \(button=(?:null|ok) chain=(?:ok|null)\)|no sealed frame|fallback input via (?:refused|cdp|sendInputEvent)|fallback press sent at ${SN},${SN})`),
  // pair.ts's remaining fixed lines, and the retry's numbers
  kp(String.raw`pair: setting up the connection failed; (?:given up after ${N} tries|asking again in ${N} ms)`),
];

/** Lines that carry someone else's text, rewritten to their fixed part (and the id, number or kind the pattern names). */
export const REDUCE: [RegExp, string | ((m: RegExpExecArray) => string)][] = [
  [/^main: (uncaught exception|unhandled rejection):[\s\S]*/, "main: $1 (text not kept in the file)"],
  [/^updater: .*; (starting again|quitting)$/, "updater: recovering (reason not kept); $1"],
  [/^window: shown while headless \(.*/, "window: shown while headless"],
  [/^window: shown invisible while headless \(the sealed smoke's fallback card .*/, "window: shown invisible while headless (the sealed smoke's fallback card)"],
  [/^window: a drag was refused\b.*/, "window: a drag was refused"],
  [/^audio: played unmuted in a headless run or a test build\b.*/, "audio: played unmuted in a headless run or a test build"],
  [/^pair: ([a-z-]{1,24})(?: \(.*\))?$/, "pair: $1"],
  [/^pair: setting up the connection failed: .*; (given up after \d{1,9} tries|asking again in \d{1,9} ms)$/, "pair: setting up the connection failed; $1"],
  [/^pair: (?:a dial failed|a listener for .* failed|the release door's setup failed|setting up the connection failed): .*/, "pair: a connection step failed (text not kept)"],
  [/^pair: the daemon refused the hello \(behind, needs ([\w.+-]{1,40})\)$/, "pair: the daemon refused the hello (behind, needs $1)"],
  [/^pair: the daemon refused the hello\b.*/, "pair: the daemon refused the hello"],
  [/^pair: not starting the daemon \(.*\): the app is quitting$/, "pair: not starting the daemon: the app is quitting"],
  [/^pair: started the daemon through the OS \(.*\): (ok|failed, \S{1,8})$/, "pair: started the daemon through the OS: $1"],
  [/^pair: (main\.handOver failed|pair\.exiting\{update\} refused or not answered|pair\.exiting was not answered|pair\.quit failed|reloading the registry failed|the window's mount failed|[\w. -]{1,40} failed): .*/, "pair: $1"],
  [/^updater: the daemon was still answering after \d{1,9} ms\b.*/, "updater: the daemon was still answering; installing anyway"],
  [/^release: (?:this app's record|this copy of MOSS Code) was not (?:recorded|written)\b.*/, "release: this copy of MOSS Code was not recorded"],
  [new RegExp(`^release: looking for release (${V}): (\\w{1,16})\\b.*`), "release: looking for release $1: $2"],
  [/^release: the engine did not take release\.bring\b.*/, "release: the engine did not take release.bring"],
  [/^release: starting the (?:new )?engine failed\b.*/, "release: starting the engine failed"],
  [/^release: the login item was not re-registered from the home's engine: .*/, "release: the login item was not re-registered from the home's engine"],
  [/^updater: pair\.exiting\{update\} refused or not answered\b.*/, "updater: pair.exiting{update} refused or not answered"],
  [/^updater: the install threw\b.*/, "updater: the install threw"],
  [/^updater: install\.json not written\b.*/, "updater: install.json not written"],
  [/^the daemon asked the app to quit\b.*/, "the daemon asked the app to quit"],
  [/^host: (the engine stops it|host\.ready was refused|leaving) \(.*/, "host: $1"],
  [/^host: ([\w. -]{1,40}) failed: .*/, "host: $1 failed"],
  [/^screen: no add-on\b.*/, "screen: no add-on; no housing is known"],
  [/^layers: no icon for .*/, "layers: no icon for a plugin"],
  [/^layer: .*/, "layer: an error in a plugin's layer (text not kept)"],
  [/^press: a call from frame \S+ found no press of its own\b.*/, "press: a call from a frame found no press of its own"],
  [/^send: refused \(.*/, "send: refused (the reason isn't kept in the file)"],
  [/^send: the core refused user\.send\b.*/, "send: the core refused user.send"],
  [/^sealed: answer refused \(a window lies over the button\b.*/, "sealed: answer refused (a window lies over the button)"],
  [/^sealed: answer held back \(this desktop's answer key isn't registered\b.*/, "sealed: answer held back (this desktop's answer key isn't registered)"],
  [/^sealed: answer refused at handler\b.*/, "sealed: answer refused at handler"],
  [/^sealed: answer refused \(.*/, "sealed: answer refused (reason not kept)"],
  [/^sealed: core refused answer\b.*/, "sealed: the core refused an answer"],
  [/^sealed: answer accepted for \S+$/, "sealed: an answer was accepted"],
  [new RegExp(`^sealed: ${CARD} (?:\\S{1,40}) (visible|not visible) in (${SURF})$`), "sealed: a card's button is $1 in $2"],
  [new RegExp(`^sealed: press on ${CARD} \\S{1,40} in (?:${SURF}): fresh report (uncovered|none in time|covered) after (\\d{1,9}) ms$`), "sealed: a press: fresh report $1 after $2 ms"],
  [/^sealed: press on \S+ \S+ in .*/, "sealed: a press: (the page's word not kept)"],
  [/^sealed: a press over .* reached no sealed page; it says press again$/, "sealed: a press reached no sealed page; it says press again"],
  [/^sealed: \S+ \S+ in .* said nothing visible (\d{1,9}) ms after it loaded: its frame (was hidden and shown again so its page reads itself again|wasn't found in its embedder)$/, "sealed: a card said nothing visible $1 ms after it loaded: its frame $2"],
  [new RegExp(`^card: ${CARD} (frames asked|a button visible) in (${SURF}) (\\d{1,9}) ms after it arrived$`), "card: $1 in $2 $3 ms after it arrived"],
  [new RegExp(`^card: ${CARD} first ask in (${SURF}) (before it arrived|\\d{1,9} ms after it arrived) \\(([a-z ]{1,16})\\)$`), "card: first ask in $1 $2 ($3)"],
  [new RegExp(`^card: ${CARD} asks in (${SURF}) before the first made: (\\d{1,9}) not yet, (\\d{1,9}) refused$`), "card: asks in $1 before the first made: $2 not yet, $3 refused"],
  [new RegExp(`^card: ${CARD} pending told to (${REF})'s layer (before it arrived|\\d{1,9} ms after it arrived)$`), "card: pending told to $1's layer $2"],
  [new RegExp(`^card: ${CARD} both buttons visible in (${SURF}) (\\d{1,9}) ms after it arrived$`), "card: both buttons visible in $1 $2 ms after it arrived"],
  [new RegExp(`^card: ${CARD} fallback timer armed \\(a button stopped showing in (${SURF})\\)$`), "card: fallback timer armed (a button stopped showing in $1)"],
  [/^card: a ([a-z-]{1,24}) card \S+ arrived( \(waiting when the app connected\))?$/, "card: a $1 card arrived$2"],
  [/^card: the fallback card for \S+ was not drawn \(its answer is on its way to the core\)$/, "card: the fallback card was not drawn (its answer is on its way to the core)"],
  [/^card: the (window's strip|fallback card) for \S+ is another program's to draw \(([a-z-]{1,16}|no place)\)$/, "card: the $1 is another program's to draw ($2)"],
  [/^card: the (window's strip|fallback card) for \S+ was not shown \(headless\)$/, "card: the $1 was not shown (headless)"],
  [/^card: the (window's strip|fallback card) for \S+ \(([a-z-]{1,24})\) is (drawn offscreen for the test's press \(not shown\)|shown)$/, "card: the $1 ($2) is $3"],
  [/^card: \S+ (shown (?:in|on) the [a-z' ]{1,40} \([a-z ,]{1,60}\)|moved to the [a-z' ]{1,40}(?: \([a-z ]{1,30}\))? from the [a-z' ]{1,40}(?: \([a-z ]{1,30}\))?)$/, "card: a card $1"],
  [/^card: \S+ .*/, "card: a card (text not kept)"],
  [/^router: \S+ placed ([a-z-]{1,16})\b.*/, "router: a card was placed ($1)"],
  [/^notify: closed\b.*/, "notify: closed"],
  [/^notify: (a headless run shows no notification|this desktop has no notifications) \(.*\)$/, "notify: $1"],
  [/^browser: the tab events refused \(.*\); the host's state only$/, "browser: the tab events refused; the host's state only"],
  [/^browser: (shutdown|start|[\w.-]{1,40}) failed: .*/, "browser: $1 failed"],
  [/^browser: the engine refused a tab's picture\b.*/, "browser: the engine refused a tab's picture"],
  [/^mcp-apps: (a link didn't open|a page wasn't shown|a page's message was refused|a page didn't load)\b.*/, "mcp-apps: $1"],
  [/^open: would open a page in the browser\b.*/, "open: would open a page in the browser"],
  [/^surface: .*'s settings couldn't be read\b.*/, "surface: a plugin's settings couldn't be read; its surfaces that need one stay closed"],
  [/^surface: a request .*/, "surface: a request"],
  [/^tray: \S+'s command didn't run\b.*/, "tray: a command didn't run"],
  [/^tray: none here\b.*/, "tray: none here"],
  [/^touches: four-finger tap off\b.*/, "touches: four-finger tap off"],
  [/^touches: no add-on\b.*/, "touches: no add-on; no four-finger tap"],
  [/^touches: (a frame failed|reattach failed)\b.*/, "touches: $1"],
  [/^keys: (?:pressed|put down|repeated|let go of) .* in the window$/, "keys: a key in the window"],
  [/^keys: an up of .*/, "keys: an up of a key that isn't a plugin's"],
  [/^keys: an unbound .*/, "keys: an unbound key event"],
  [/^keys: \S+ (down|up|repeat) failed\b.*/, "keys: a command's key ($1) failed"],
  [/^keys: reading the commands' keys failed\b.*/, "keys: reading the commands' keys failed"],
  [/^keys: \S+ failed\b.*/, "keys: a command failed"],
  [/^overlap: no window list\b.*/, "overlap: no window list; the in-page check stands alone"],
  [/^overlap: the OS window list couldn't be read for a press\b.*/, "overlap: the OS window list couldn't be read for a press; the in-page check stands alone"],
  [/^prefs: not saved\b.*/, "prefs: not saved"],
  [/^answer key: (not replaced|not registered)\b.*/, "answer key: $1"],
  [/^answer key: the replacement's answer was lost\b.*/, "answer key: the replacement's answer was lost; its key stays staged"],
  [/^answer key: waiting\b.*/, "answer key: waiting"],
  [/^layers: a (?:window|frame) tried to leave for .*/, "layers: a window tried to leave (the address isn't kept)"],
  [/^layers: refused a request to the network from .*/, "layers: refused a request to the network (no layer declares a host yet)"],
  [/^layers: ([\w:.-]{1,60}) failed: .*/, "layers: $1 failed"],
  [/^layers: a call from frame .*/, "layers: a call from a frame bound to no mount"],
  // A page's call through the tree: the part (one id token), the method and the outcome; a reason or a result is the page's or the plugin's.
  // The method is a page's own text unless main knows it: a made-up one is written as "an unknown method" (the source says it so too).
  [/^tree: ([\w.:/#@+-]{1,100}): ([\w.]{1,60}) (refused|went through|ran)\b.*/, (m) => `tree: ${m[1]}: ${isKnownTreeMethod(m[2]!) ? m[2] : "an unknown method"} ${m[3]}`],
  [/^tree: ([\w.:/#@+-]{1,100}): an unknown method (refused|went through|ran)\b.*/, "tree: $1: an unknown method $2"],
  [/^browser: view ([\w-]{1,40}) shows the host's tab .*/, "browser: view $1 shows the host's tab"],
  [/^layers: a message to \S+ was lost\b.*/, "layers: a message to a mount was lost"],
  [/^layers: \S+ \(\S+\): refused a document load \(.*; a fresh address went less than a second ago\)$/, "layers: a document load was refused (a fresh address went less than a second ago)"],
  [/^layers: \S+(?: \(\S+\))? loads again\b.*/, "layers: a mount loads again"],
  [/^layers: .* refused \(.*\); frame \d+:\d+, active (true|false)$/, "layers: a plugin's call was refused (reason not kept)"],
  [/^layers: could not stop process \d+\b.*/, "layers: could not stop a process"],
  [/^strings: \S+ could not be read\b.*/, "strings: a plugin's strings could not be read"],
  [/^theme: \S+ could not be read\b.*/, "theme: a plugin's theme could not be read"],
  [/^theme: \S+: dropped .*/, "theme: a plugin's theme had declarations dropped"],
  [/^theme: \S+: the shell's \S+ group is not used\b.*/, "theme: a group of a plugin's theme is not used"],
  [/^web: a page tried to leave .* for another site; it stays$/, "web: a page tried to leave its site for another; it stays"],
  [/^web: \S+'s page didn't load\b.*/, "web: a plugin's page didn't load"],
  [/^sealed-click: (?:frame found|no offset chain for|fallback frame found) .*/, "sealed-click: a sealed frame"],
  [/^sealed-click: .*(?:couldn't be set|couldn't be dimmed|not on the frame that would take the press).*/, "sealed-click: a step failed (reason not kept)"],
];

/** The line as the file may hold it. */
export function fileLine(line: string): string {
  const one = line.replace(/[\r\n]+/g, " ");
  if (KEEP.some((r) => r.test(one))) return one;
  for (const [r, to] of REDUCE) {
    const m = r.exec(one);
    // Only the fixed text and the pieces the pattern names: nothing of the line outside them is carried over.
    if (m !== null) return typeof to === "function" ? to(m) : to.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? "");
  }
  const source = /^([A-Za-z][A-Za-z -]{0,24}):/.exec(one)?.[1];
  return `${source ?? "log"}: (text not kept in the file)`;
}
