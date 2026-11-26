// The lines of the app's log (`<home>/logs/app.log`) the acceptance run reads as EVIDENCE, and the check that every one of them is still
// one the real build writes to its file.
//
// A test-marked or acceptance build writes the raw line to the file (its steps read card ids and timings there); a real build writes only
// what `fileLine` (apps/desktop/src/main/file-log.ts) lets through, and a line it has no rule for becomes "<source>: (text not kept in the
// file)". A step could therefore keep passing on a line that a real build never writes, and a reworded line would vanish from real logs
// without a test failing. So the run puts its raw log through `fileLine` and FAILS when a line a step relies on falls to "text not kept":
// the evidence is classed (kept, or reduced to its fixed part) or the step does not rely on it.
//
// Each entry names the lines one kind of step reads: `re` matches the raw line (without its time), `example` is a line of the exact shape
// the app writes. apps/desktop/test/file-log.test.ts holds every example against `fileLine`, and holds this list against the
// literal needles the steps read (so a step that starts relying on a new line has to add it here, and class it).

import { APP_LOG_LINE_MAX, cleanLogLine } from "../../packages/app-release/src/app-log";

export interface EvidenceLine {
  /** What the steps read it for. */
  readonly for: string;
  readonly re: RegExp;
  readonly example: string;
}

export const EVIDENCE_LINES: readonly EvidenceLine[] = [
  { for: "a layer's connection to the core, and its closing", re: /^layers: \S+'s layer (?:connected to the core|connection closed)/, example: "layers: moss/island's layer connected to the core" },
  { for: "a layer's connection closing when it no longer shows UI", re: /^layers: \S+'s layer connection closed/, example: "layers: acc-extra's layer connection closed (it no longer shows UI)" },
  { for: "a document loading again for a layer", re: /^layers: \S+(?: \(\S+\))? loads again/, example: "layers: doc_1 loads again to frame a layer installed after it was served" },
  { for: "a document load refused", re: /^layers: .*refused (?:a document load|a load of an address it replaced)/, example: "layers: m1 (acc-office): refused a document load (an address no mount holds; a fresh address went less than a second ago)" },
  { for: "a plugin's view the app refused to place", re: /^layers: \S+ may not place /, example: "layers: acc-window may not place the acceptance-window view (it needs the browser capability)" },
  { for: "the window moved by its title area", re: /^window: moved by its title area/, example: "window: moved by its title area, from (10, 20) to (130, 80)" },
  { for: "a window shown during a headless run (must not happen)", re: /^window: shown while headless/, example: "window: shown while headless (main: MOSS Code)" },
  { for: "the test seam's own window lines", re: /^window: the test seam /, example: "window: the test seam closes the main window" },
  { for: "a surface asking to be placed", re: /^surface: a request/, example: "surface: a request visible=true (headless)" },
  { for: "a surface put away, summoned or shown again", re: /^surface: \S+ /, example: "surface: moss/pill put away from the tray" },
  { for: "an answer to a sealed card, accepted or refused", re: /^sealed: answer (?:accepted|refused)/, example: "sealed: answer accepted for card_abc123" },
  { for: "a part's approve on a card with boxes opening MOSS Code's own card", re: /^sealed: review opened for \S+/, example: "sealed: review opened for card_abc123" },
  { for: "a sealed press's fresh visibility report", re: /^sealed: press on \S+ .*: fresh report /, example: "sealed: press on card_abc123 approve in window 1: fresh report uncovered after 120 ms" },
  { for: "a plugin's command key ran, held, repeated, or the commands' keys bound", re: /^keys: /, example: "keys: acc.ping ran from its key" },
  { for: "a command key's held down and up", re: /^keys: \S+ (?:down|up) from its key/, example: "keys: acc.held down from its key" },
  { for: "the commands' keys bound", re: /^keys: \d+ command key\(s\) bound/, example: "keys: 3 command key(s) bound" },
  { for: "the ipc counters (the idle-cost row parses them)", re: /^ipc: /, example: "ipc: 5 s in 12/s (props 40, size 20) out 3/s (props 15) cpu Browser 4.1% Tab 2.0%" },
  { for: "a fallback card the app did not draw", re: /^card: the fallback card for /, example: "card: the fallback card for card_abc123 was not drawn (its answer is on its way to the core)" },
  { for: "a plugin's background part started or stopped", re: /^background: \S+#\S+ (?:started|stopped)/, example: "background: acc-sound#ticker started" },
  { for: "sound muted, or not", re: /^audio: /, example: "audio: muted (a headless run or a test build)" },
  { for: "a notification the headless app did not show, and its closing", re: /^notify: /, example: "notify: a headless run shows no notification (acc-1)" },
  { for: "a card's placement by the router", re: /^router: \S+ placed /, example: "router: card_abc123 placed island" },
  { for: "the browser panel's frame and the host's tab shown", re: /^browser: (?:view \S+ (?:has a place in the window|shows the host's tab \S+)|the panel drew the host's tab \()/, example: "browser: view browser shows the host's tab tab_1" },
  { for: "the browser panel's viewport drawing", re: /^browser: the panel drew the host's tab \(/, example: "browser: the panel drew the host's tab (800x600)" },
  { for: "the answer key's registering", re: /^answer key: (?:registered|waiting|trying again|not registered)/, example: "answer key: registered (staged)" },
  { for: "a page tree call refused or run", re: /^tree: \S+: /, example: "tree: acc-copy: session.resend refused (the session isn't this page's)" },
  { for: "a press a frame made on its own", re: /^press: a call from frame /, example: "press: a call from frame 3 found no press of its own (x; the latest press: null)" },
  { for: "the OS window list read for a press", re: /^overlap: the OS window list /, example: "overlap: the OS window list read for a press (2 above, 0 of this program's own)" },
  { for: "a plugin's file grants", re: /^files: \S+: /, example: "files: acc-files: the core keeps no grants yet; the page's token works for the media URL only" },
  { for: "a drop's grants", re: /^files: \S+: a drop gave /, example: "files: acceptance-media: a drop gave 1 grant(s)" },
  { for: "the release notice of an update switching (the upgrade unit)", re: /^release: notice /, example: "release: notice switching" },
  { for: "the app waiting for a daemon", re: /^pair: (?:unavailable|starting-daemon|reconnecting)/, example: "pair: unavailable (the engine isn't running)" },
];

/** What `fileLine` writes for a line it has no rule for. */
const UNKEPT = /\(text not kept in the file\)$/;

/** The log's lines without the time the file puts before each (a raw line from a test build is `<ISO time> <line>`). */
export const lineOf = (fileText: string): string => fileText.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, "");

/** What the check counted besides its findings. */
export interface EvidenceStats {
  /** Evidence lines the file had cut at its length limit, judged by the whole line the process printed. */
  cut: number;
}

/** The lines of `text` (the raw app log) that an evidence entry reads and that `fileLine` would write as "text not kept".
 *
 *  The file cuts a line at APP_LOG_LINE_MAX, after a real build's `fileLine` has judged the whole one. A cut line ends mid-pair, so it is
 *  judged by the WHOLE line it was cut from: `whole` holds the lines the app printed to its process output (which is never cut), and a cut
 *  line is looked up there by its cut form (`cleanLogLine`, which is what the file wrote). A cut line of an evidence kind with no whole line
 *  to match is a finding too, so a long line is never skipped unseen, and a long line of free text is judged like any other. */
export function unkeptEvidence(text: string, fileLine: (line: string) => string, whole: readonly string[] = [], stats?: EvidenceStats): { line: string; for: string }[] {
  const out: { line: string; for: string }[] = [];
  let byCut: Map<string, string> | undefined;
  for (const raw of text.split("\n")) {
    const line = lineOf(raw);
    if (line === "") continue;
    const hit = EVIDENCE_LINES.find((e) => e.re.test(line));
    if (hit === undefined) continue;
    if (line.length < APP_LOG_LINE_MAX) {
      if (UNKEPT.test(fileLine(line))) out.push({ line: line.slice(0, 200), for: hit.for });
      continue;
    }
    byCut ??= new Map(whole.map((w) => [cleanLogLine(w), w]));
    const full = byCut.get(line);
    if (full === undefined) { out.push({ line: `${line.slice(0, 160)} (cut at the file's limit; no whole line of it in the process output)`, for: hit.for }); continue; }
    if (stats !== undefined) stats.cut++;
    if (UNKEPT.test(fileLine(full))) out.push({ line: full.slice(0, 200), for: hit.for });
  }
  return out;
}
