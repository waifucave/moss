// Rows (or the part of a row) that are not run on Linux, and why: the way the acceptance run says "this is a macOS behaviour by design",
// beside measured.ts's "measured on the Mac only". A row that cannot mean the same thing on Linux does not pass there and is not
// deleted: its detail starts with the marker below and a reason, and the unit's verdict (scripts/ci/acceptance-unit.ts) lists it as "not on
// Linux", never as a pass. Only the rows named here may say it (a marker on any other row is a problem), and a marker is never a way to
// hide a fault: each reason names the macOS-only thing the row proves (a spec decision), not a thing that is broken on Linux.
export const NOT_ON_LINUX = "NOT ON LINUX";

/** The rows (by the start of their names) that may say it, with the reason the table prints. */
export const NOT_ON_LINUX_ROWS: readonly { prefix: string; reason: string }[] = [
  { prefix: "a folder-installed plugin's command hook fires on its event, fenced", reason: "its refusals are the plugin fence's, which only macOS has: plugin code on Linux and Windows runs as the user (spec §5.2, item 58)" },
  { prefix: "a folder-installed plugin's stdio MCP server lists and answers, fenced", reason: "its refusals are the plugin fence's, which only macOS has: plugin code on Linux and Windows runs as the user (spec §5.2, item 58)" },
  { prefix: "a plugin's own network: its granted host through its proxy", reason: "the per-plugin network proxy is the plugin fence's, which only macOS has: plugin code on Linux and Windows runs as the user (spec §5.2, item 58)" },
  { prefix: "manifest fields on the app:", reason: "its P5 clause (a program or folder named on the card as outside the plugin's sandbox) is the plugin sandbox's, which only macOS has: plugin code on Linux and Windows runs as the user (spec §5.2, item 58); the rest of the row runs" },
];

/** Whether this run is on Linux. */
export const onLinux = (): boolean => process.platform === "linux";

/** A row's detail on Linux for what is macOS-only: the marker, the reason, and what was still checked here. */
export const notOnLinux = (reason: string, checkedHere = ""): string => `${NOT_ON_LINUX}: ${reason}${checkedHere === "" ? "" : `; checked here: ${checkedHere}`}`;
