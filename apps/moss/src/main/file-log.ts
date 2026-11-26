// What MOSS's log FILE may hold (`<home>/logs/moss-app.log`). Bots can read the home's logs, so the file is for explaining a dead
// button and nothing a message, a card or an error could carry: the check that refused and the milliseconds, the app's lifecycle
// lines (connect, disconnect, versions) and error KINDS (a code, a class, an outcome), never an error's message text, a card's id
// or text, or a bot's name.
//
// `log()` in index.ts still prints every line to the process's output and keeps it in memory as it always did (the acceptance
// reads card ids there); only what is written to the file goes through `fileLine`. It is DEFAULT-DENY: a line is written as it is
// when it matches a pattern below whose variable parts are only numbers, versions and fixed words; a line that carries text of
// someone else's (an error's message, a card id, a name, a page's word) is rewritten to its fixed part; any other line is reduced
// to its source word and "text not kept". A new log line is therefore never in the file until it is added here (the test in
// test/moss-app-log.test.ts counts MOSS's log call sites and fails on a new one).

const V = "[\\w.+-]{1,40}";

/** Lines written as they are: fixed words, numbers, versions, kinds. */
const KEEP: RegExp[] = [
  /^answer key: (?:the kept key couldn't be read(?: this start; it is kept as it is, and this start's key is in memory only|; a new one is made)|MOSS's key is registered for this device|the engine holds another key for MOSS on this device(?:, and this one can't replace it)?|MOSS's new key waits on the engine's card \(its earlier key was lost\))$/,
  new RegExp(`^connection: (?:connected as surface [\\w.-]{1,40} \\(mount: [\\d?]+ points\\)|the engine went away without saying so|MOSS is ahead of the engine \\(${V}\\); only the release door is open|[a-z-]{1,24})$`),
  /^host: (?:the engine gave up starting the host \(MOSS says so in its window\)|the host is back)$/,
  /^send: (?:refused by the engine connection \(MOSS isn't connected to its engine\)|the engine took nothing \((?:no answer in time|the connection closed|the engine refused \(code -?\d{1,6}\)|failed), \d{1,9} ms after the call\))$/,
  /^press: [a-z ]{1,20} taken; the process itself was not running for \d+ ms of the press's age$/,
  /^[a-z ]{1,20}: refused by the press check \([a-z' ]{1,80}(?:, \d+ ms past its bound)?(?:; the process itself was not running for \d+ ms)?\)(?: \(\d+ like it left out\))?$/,
  /^voice: (?:talk held \(\w{1,12}\)|the talk command didn't run \(no voice plugin's talk command, or the engine didn't take it\))$/,
  /^updater: the engine was still answering after 15 s; installing anyway$/,
  /^window: (?:shown while headless|the test seam says MOSS's window is (?:in front|not in front))$/,
  /^window: refused a request off MOSS's own schemes \([a-z][a-z0-9+.-]{0,20}\)$/,
  /^sealed: refusing a sealed load \(no channel\)$/,
  /^picture: input refused \(watch only\): a [a-z]{1,12} on the bot's screen reaches nothing$/,
  /^overlap: (?:the OS window list wasn't read for a press \((?:no window list here|no window id)\); the in-page check stands alone|the OS window list read for a press \(\d+ above, \d+ of MOSS's own(?:; headless: its own only)?(?:; no point: a keyboard press)?\))$/,
  /^audio: muted \(headless: every page muted\)$/,
  /^quit: (?:the engine asked for it; nothing to tell|not connected; nothing to tell|told the engine \(pair\.quit, no hand-over\))$/,
  new RegExp(`^release: (?:this copy of MOSS is recorded|the engine wasn't put under the home; MOSS starts its own copy|the engine starts from the home's copy \\(release ${V}(?:, the login item re-registered from it)?\\)|the update downloaded but did not start installing; checking again later|no engine answers after the switch; starting it through the OS|no notice|notice [a-z-]{1,30}(?: \\([a-z-]{1,30}\\))?|a test build's stand-in update installs here \\(nothing is installed\\)|the login item was not re-registered from the home's engine \\(exit \\S{1,8}\\)|asked the OS to start the new engine \\((?:ok|failed, \\S{1,8})\\)|the engine has no login item; registered it so the new engine starts under supervise \\((?:ok|failed, \\S{1,8})\\))$`),
  new RegExp(`^updater: (?:installing ${V}(?: now the daemon is idle| at the user's Quit)?|the daemon can't be asked whether it is idle; the update waits|the daemon refused the update's exit; ${V} waits for the next idle moment|no GitHub publish settings in app-update\\.yml; this build doesn't update itself)$`),
  /^sealed: answer refused \((?:no such sealed button|the button was covered or not shown at the press|no visibility reading came with the press|the router hasn't placed this card|the card is placed (?:on the island|elsewhere|in another window)|MOSS's window isn't showing|MOSS's window isn't in front|not MOSS's window|no device|no option named|MOSS saw no press of its own land in this button \([^()]{1,200}\))\)$/,
  /^sealed: answer refused \(MOSS's answer key isn't registered \((?:refused|waiting|[a-z-]{1,24})\)\)$/,
];

/** Lines that carry someone else's text, rewritten to their fixed part. */
const REDUCE: [RegExp, string][] = [
  [/^connection: the endpoint isn't this user's engine\b.*/, "connection: the endpoint isn't this user's engine; MOSS sent it nothing"],
  [/^connection: a listener for .*/, "connection: a listener failed"],
  [new RegExp(`^connection: the engine refused the hello \\(behind, needs (${V})\\)$`), "connection: the engine refused the hello (behind, needs $1)"],
  [/^connection: the engine refused the hello\b.*/, "connection: the engine refused the hello"],
  [/^connection: the release door failed\b.*/, "connection: the release door failed"],
  [/^connection: setting up failed\b.*/, "connection: setting up failed"],
  [/^connection: started the engine through the OS \(.*\): (ok|failed, \S{1,8})$/, "connection: started the engine through the OS: $1"],
  [/^engine: ([\w.]{1,60}) failed\b.*/, "engine: $1 failed (error)"],
  [/^voice: the talk command is .*/, "voice: a talk command is set"],
  [/^voice: no talk command\b.*/, "voice: no talk command"],
  [/^updater: .*; (starting again|quitting)$/, "updater: recovering (reason not kept); $1"],
  [/^the engine asked MOSS to leave\b.*/, "the engine asked MOSS to leave"],
  [/^release: (?:this copy of MOSS|this app's record) was not (?:recorded|written)\b.*/, "release: this copy of MOSS was not recorded"],
  [/^release: not recorded\b.*/, "release: not recorded"],
  [new RegExp(`^release: looking for release (${V}): (\\w{1,16})\\b.*`), "release: looking for release $1: $2"],
  [/^release: the engine did not take release\.bring\b.*/, "release: the engine did not take release.bring"],
  [/^release: starting the (?:new )?engine failed\b.*/, "release: starting the engine failed"],
  [/^release: the login item was not re-registered from the home's engine: .*/, "release: the login item was not re-registered from the home's engine"],
  [/^quit: the engine didn't take pair\.quit\b.*/, "quit: the engine didn't take pair.quit"],
  [/^presence: not taken\b.*/, "presence: not taken"],
  [/^overlap: no window list\b.*/, "overlap: no window list; the in-page check stands alone"],
  [/^overlap: the OS window list couldn't be read for a press\b.*/, "overlap: the OS window list couldn't be read for a press; the in-page check stands alone"],
  [/^updater: pair\.exiting\{update\} refused or not answered\b.*/, "updater: pair.exiting{update} refused or not answered"],
  [/^updater: the install threw\b.*/, "updater: the install threw"],
  [/^updater: install\.json not written\b.*/, "updater: install.json not written"],
  [/^card: \S+ is drawn nowhere now; the notification ".*" (shown|\(not shown: (?:headless|no notifications)\))$/, "card: a card is drawn nowhere now; the notification $1"],
  [/^sealed: a press over .* reached no sealed page; it says press again$/, "sealed: a press reached no sealed page; it says press again"],
  [/^sealed: press on \S+: fresh report (uncovered|none in time|covered) after (\d+) ms$/, "sealed: a press: fresh report $1 after $2 ms"],
  [/^sealed: press on \S+: .*/, "sealed: a press: (the page's word not kept)"],
  [/^sealed: \S+ \S+ in MOSS's window said nothing visible (\d+) ms after it loaded: its frame (was hidden and shown again so its page reads itself again|wasn't found in its embedder)$/, "sealed: a card in MOSS's window said nothing visible $1 ms after it loaded: its frame $2"],
  [/^sealed: answer accepted for \S+ \((click|key)\)$/, "sealed: an answer was accepted ($1)"],
  [/^sealed: answer refused \(the engine refused the answer\b.*/, "sealed: answer refused (the engine refused the answer)"],
  [/^sealed: answer refused \(a window lies over the button\b.*/, "sealed: answer refused (a window lies over the button)"],
  [/^sealed: answer refused \(MOSS's answer key isn't registered\b.*/, "sealed: answer refused (MOSS's answer key isn't registered)"],
];

/** The line as the file may hold it. */
export function fileLine(line: string): string {
  const one = line.replace(/[\r\n]+/g, " ");
  if (KEEP.some((r) => r.test(one))) return one;
  for (const [r, to] of REDUCE) {
    const m = r.exec(one);
    // Only the fixed text and the pieces the pattern names: nothing of the line outside them is carried over.
    if (m !== null) return to.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? "");
  }
  const source = /^([A-Za-z][A-Za-z ]{0,24}):/.exec(one)?.[1];
  return `${source ?? "log"}: (text not kept in the file)`;
}
