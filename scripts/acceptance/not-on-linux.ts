// Rows (or the part of a row) that are not run on Linux, and why: the way the acceptance run says "this is a macOS behaviour by design",
// beside measured.ts's "measured on the Mac only". A row that cannot mean the same thing on Linux does not pass there and is not
// deleted: its detail starts with the marker below and a reason, and the unit's verdict (scripts/ci/acceptance-unit.ts) lists it as "not on
// Linux", never as a pass. Only the rows named here may say it (a marker on any other row is a problem), and a marker is never a way to
// hide a fault: each reason names the macOS-only thing the row proves (a spec decision), not a thing that is broken on Linux.
export const NOT_ON_LINUX = "NOT ON LINUX";
/** The same for Windows (no plugin fence or window glass there either): the judge lists such a row as "not on Windows". */
export const NOT_ON_WINDOWS_MARK = "NOT ON WINDOWS";

/** The rows (by the start of their names) that may say it, with the reason the table prints. */
export const NOT_ON_LINUX_ROWS: readonly { prefix: string; reason: string }[] = [
  { prefix: "a folder-installed plugin's command hook fires on its event, fenced", reason: "its refusals are the plugin fence's, which only macOS has: plugin code on Linux and Windows runs as the user (spec §5.2, item 58)" },
  { prefix: "a folder-installed plugin's stdio MCP server lists and answers, fenced", reason: "its refusals are the plugin fence's, which only macOS has: plugin code on Linux and Windows runs as the user (spec §5.2, item 58)" },
  { prefix: "a plugin's own network: its granted host through its proxy", reason: "the per-plugin network proxy is the plugin fence's, which only macOS has: plugin code on Linux and Windows runs as the user (spec §5.2, item 58)" },
  { prefix: "manifest fields on the app:", reason: "its P5 clause (a program or folder named on the card as outside the plugin's sandbox) is the plugin sandbox's, which only macOS has: plugin code on Linux and Windows runs as the user (spec §5.2, item 58); the rest of the row runs" },
  { prefix: "the window's glass:", reason: "the see-through sidebar over what is behind the window is macOS's window material, which Linux has no counterpart of; the bar's frost and tint over a panned block (CSS) are still checked" },
  { prefix: "the background host (lane HS)", reason: "a restarted engine adopts a running host by the host's OS lock, which only macOS has (Linux's host holds none; its service manager's start of a running unit does nothing); the rest of the row ran, with the host's pid taken from the harness's own record of the process it started" },
];

/** Whether this run is on Linux. */
export const onLinux = (): boolean => process.platform === "linux";
/** Whether this run is on an OS with no plugin fence or window glass: Linux, and Windows (plugin code runs as the user there too, spec §5.2 item 58). Its rows say "NOT ON WINDOWS" there
 *  (`notOnLinux` picks the marker by platform); each reason names the macOS-only thing the row proves. */
export const onUnfencedOs = (): boolean => process.platform === "linux" || process.platform === "win32";

/** A row's detail on Linux for what is macOS-only: the marker, the reason, and what was still checked here. */
export const notOnLinux = (reason: string, checkedHere = ""): string => `${process.platform === "win32" ? NOT_ON_WINDOWS_MARK : NOT_ON_LINUX}: ${reason}${checkedHere === "" ? "" : `; checked here: ${checkedHere}`}`;
