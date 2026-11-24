// What MOSS's log FILE may hold (src/main/file-log.ts): every log line MOSS's main process writes, and the ones its release code
// writes through `log`, is listed here with what the file gets. Bots can read the home's logs, so the file never holds an error's
// message text, a card's id or text, a bot's name or a page's word; the process's output keeps its lines as before.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileLine } from "../src/main/file-log";

const SECRET = "SECRETWORDS";
const CARD = "card_juniper_book";
const BOT = "Juniper";

/** [the line as MOSS logs it, what the file gets]; the same text means it is kept as it is. */
const KEPT: string[] = [
  "answer key: the kept key couldn't be read; a new one is made",
  "answer key: MOSS's key is registered for this device",
  "answer key: the engine holds another key for MOSS on this device",
  "connection: connecting",
  "connection: connected as surface moss (mount: 7 points)",
  "connection: MOSS is ahead of the engine (0.125.0); only the release door is open",
  "connection: the engine went away without saying so",
  "host: the engine gave up starting the host (MOSS says so in its window)",
  "host: the host is back",
  "send: refused by the press check (the write came too late, 151 ms past its bound; the process itself was not running for 3000 ms)",
  "send: the engine took nothing (no answer in time, 30001 ms after the call)",
  "send: refused by the engine connection (MOSS isn't connected to its engine)",
  "press: send taken; the process itself was not running for 4200 ms of the press's age",
  "a write: refused by the press check (no press seen)",
  "voice: refused by the press check (the press landed in another frame) (3 like it left out)",
  "voice: talk held (button)",
  "voice: the talk command didn't run (no voice plugin's talk command, or the engine didn't take it)",
  "updater: the engine was still answering after 15 s; installing anyway",
  "window: shown while headless",
  "window: the test seam says MOSS's window is in front",
  "window: refused a request off MOSS's own schemes (https)",
  "sealed: refusing a sealed load (no channel)",
  "picture: input refused (watch only): a click on the bot's screen reaches nothing",
  "overlap: the OS window list wasn't read for a press (no window id); the in-page check stands alone",
  "overlap: the OS window list read for a press (2 above, 1 of MOSS's own; headless: its own only; no point: a keyboard press)",
  "audio: muted (headless: every page muted)",
  "quit: not connected; nothing to tell",
  "quit: told the engine (pair.quit, no hand-over)",
  "release: this copy of MOSS is recorded",
  "release: the engine starts from the home's copy (release 0.125.0, the login item re-registered from it)",
  "release: no notice",
  "release: notice behind (installing)",
  "release: asked the OS to start the new engine (failed, 3)",
  "updater: installing 0.125.0 now the daemon is idle",
  "updater: the daemon can't be asked whether it is idle; the update waits",
  "sealed: answer refused (no such sealed button)",
  "sealed: answer refused (the card is placed on the island)",
  "sealed: answer refused (MOSS saw no press of its own land in this button (the answer came 200 ms past the bound of 1500))",
  "sealed: answer refused (MOSS's answer key isn't registered (waiting))",
];

/** Lines that carry someone else's text: [as logged (with the planted words), what the file gets]. */
const REDUCED: [string, string][] = [
  [`connection: a listener for ${CARD} failed: ${SECRET}`, "connection: a listener failed"],
  [`connection: the engine refused the hello (${SECRET})`, "connection: the engine refused the hello"],
  ["connection: the engine refused the hello (behind, needs 0.125.0)", "connection: the engine refused the hello (behind, needs 0.125.0)"],
  [`connection: the release door failed: ${SECRET}`, "connection: the release door failed"],
  [`connection: setting up failed: ${SECRET}`, "connection: setting up failed"],
  [`connection: started the engine through the OS (${SECRET}): failed, 3`, "connection: started the engine through the OS: failed, 3"],
  [`connection: the endpoint isn't this user's engine (${SECRET}); MOSS sent it nothing`, "connection: the endpoint isn't this user's engine; MOSS sent it nothing"],
  [`engine: user.send failed (${SECRET} for ${BOT})`, "engine: user.send failed (error)"],
  [`engine: events.subscribe failed (${SECRET})`, "engine: events.subscribe failed (error)"],
  [`voice: the talk command is ${SECRET} (${BOT})`, "voice: a talk command is set"],
  [`voice: no talk command (${SECRET})`, "voice: no talk command"],
  [`updater: ${SECRET}; quitting`, "updater: recovering (reason not kept); quitting"],
  [`the engine asked MOSS to leave (${SECRET})`, "the engine asked MOSS to leave"],
  [`release: not recorded (${SECRET})`, "release: not recorded"],
  [`release: this app's record was not written: ${SECRET}`, "release: this copy of MOSS was not recorded"],
  [`release: looking for release 0.125.0: failed (${SECRET})`, "release: looking for release 0.125.0: failed"],
  [`release: the engine did not take release.bring: ${SECRET}`, "release: the engine did not take release.bring"],
  [`release: starting the new engine failed: ${SECRET}`, "release: starting the engine failed"],
  [`quit: the engine didn't take pair.quit (${SECRET})`, "quit: the engine didn't take pair.quit"],
  [`presence: not taken (${SECRET})`, "presence: not taken"],
  [`overlap: no window list (${SECRET}); the in-page check stands alone`, "overlap: no window list; the in-page check stands alone"],
  [`overlap: the OS window list couldn't be read for a press (${SECRET}); the in-page check stands alone`, "overlap: the OS window list couldn't be read for a press; the in-page check stands alone"],
  [`updater: pair.exiting{update} refused or not answered: ${SECRET}`, "updater: pair.exiting{update} refused or not answered"],
  [`updater: the install threw: ${SECRET}`, "updater: the install threw"],
  [`updater: ${SECRET}`, "updater: (text not kept in the file)"],
  [`card: ${CARD} is drawn nowhere now; the notification "${BOT} needs you" shown`, "card: a card is drawn nowhere now; the notification shown"],
  [`card: ${CARD} is drawn nowhere now; the notification "${BOT} needs you" (not shown: headless)`, "card: a card is drawn nowhere now; the notification (not shown: headless)"],
  [`sealed: a press over ${CARD} button:allow_once reached no sealed page; it says press again`, "sealed: a press reached no sealed page; it says press again"],
  [`sealed: press on ${CARD}: fresh report uncovered after 120 ms`, "sealed: a press: fresh report uncovered after 120 ms"],
  [`sealed: press on ${CARD}: ${SECRET}`, "sealed: a press: (the page's word not kept)"],
  [`sealed: ${CARD} button:allow_once in MOSS's window said nothing visible 900 ms after it loaded: its frame wasn't found in its embedder`, "sealed: a card in MOSS's window said nothing visible 900 ms after it loaded: its frame wasn't found in its embedder"],
  [`sealed: answer accepted for ${CARD} (click)`, "sealed: an answer was accepted (click)"],
  [`sealed: answer refused (the engine refused the answer (${SECRET}))`, "sealed: answer refused (the engine refused the answer)"],
  [`sealed: answer refused (a window lies over the button: ${BOT}'s window)`, "sealed: answer refused (a window lies over the button)"],
  [`sealed: answer refused (${SECRET})`, "sealed: (text not kept in the file)"],
  [`something new: ${SECRET} ${CARD}`, "something new: (text not kept in the file)"],
  [`${SECRET} without a source word`, "log: (text not kept in the file)"],
];

describe("what MOSS writes to its log file", () => {
  test("lines of fixed words, numbers, versions and kinds are kept as they are", () => {
    for (const l of KEPT) expect([l, fileLine(l)]).toEqual([l, l]);
  });

  test("a line that carries an error's text, a card's id, a bot's name or a page's word is reduced to its fixed part", () => {
    for (const [from, to] of REDUCED) {
      const got = fileLine(from);
      expect([from, got]).toEqual([from, to]);
      for (const word of [SECRET, CARD, BOT]) expect([from, got.includes(word)]).toEqual([from, false]);
    }
  });

  test("a line break never splits a line, and a new kind of line is not in the file until it is added", () => {
    expect(fileLine("voice: talk held (button)\nsecond: line")).toBe("voice: (text not kept in the file)");
    expect(fileLine("brand new: " + SECRET)).not.toContain(SECRET);
  });

  // The tripwire: a log line added to MOSS's main process is not in the file (it is reduced to "text not kept") until someone has
  // classed it here and in file-log.ts, so the count of literal call sites per file is pinned.
  test("MOSS's literal log call sites are the ones classed above (a new one fails here: class it in file-log.ts and the lists, then change the count)", () => {
    const dir = join(import.meta.dir, "..", "src", "main");
    const counts: Record<string, number> = {};
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) {
      const n = [...readFileSync(join(dir, f), "utf8").matchAll(/(^|[^A-Za-z0-9_.])(?:this\.|d\.|o\.|deps\.)?log\(\s*[`"]/gm)].length;
      if (n > 0) counts[f] = n;
    }
    expect(counts).toEqual({ "answer-key.ts": 5, "connection.ts": 9, "engine.ts": 5, "index.ts": 23, "overlap.ts": 3, "presence.ts": 1, "press.ts": 2, "quit.ts": 4, "release.ts": 1, "sealed-redraw.ts": 1, "test-runs.ts": 2, "voice.ts": 2 });
  });

  test("the file's writer in index.ts is fed through fileLine, never the raw line", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "main", "index.ts"), "utf8");
    expect(src).toContain("appLog.write(fileLine(line));");
    expect(src).not.toMatch(/appLog\.write\(line\)/);
  });
});
