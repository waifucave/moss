// The acceptance units GitHub runs (`ON_GITHUB`) and the ones it does not, and why (`NOT_ON_GITHUB`). `ON_GITHUB` is the only
// place to add a unit to the lane gate: ci.yml's `acceptance` and `acceptance-linux` jobs take their matrix from the `changes`
// job (scripts/ci-changes.ts prints `acceptance_units`, the units a run needs, of this list), so a run that touched only
// part of the acceptance starts only those units. Every unit of scripts/acceptance/shards.ts is in the list or in
// `NOT_ON_GITHUB`, never neither (scripts/ci-changes.test.ts), so a lane that adds a unit meets the question when its tests
// run, not after a row that never ran on a runner has been merged.
//
// An entry may name a unit before its lane has merged (`release`): the test checks only that no unit is in both places and
// that every unit that exists is in one.
export const ON_GITHUB: readonly string[] = [
  "chain", "window-1", "window-2", "window-3", "workshop", "plugin-app", "browser", "bundled-tools", "examples", "reopen", "host", "cards", "moss", "setup",
  "arrivals", "addons", "archive", "acp", "workshop-points", "models", "builder-examples", "browser-host", "surface-copy-host", "canvas", "canvas-app",
  // Lane XC: two engines over the real link sidecar (macOS and Linux; ci.yml keeps it out of the Windows set for now).
  "computers",
];

export const NOT_ON_GITHUB: Readonly<Record<string, string>> = {
  cold: "measures the cold start's deadline, alone on the machine: the Mac's merge check runs it",
  idle: "measures idle CPU, alone on the machine: the Mac's merge check runs it",
  release: "needs a packaged test build signed with the Developer ID, which a GitHub runner does not have: the Mac's merge check runs it on the try build",
};
