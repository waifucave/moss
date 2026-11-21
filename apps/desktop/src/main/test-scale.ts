// The acceptance run's time scale, for the app's own short limits (a card's fallback after 2 s). A hosted runner is several times
// slower than a Mac, and ci.yml sets MOSS_ACCEPT_TIME_SCALE (3 there) so each wait of the run takes that many times as long; an app
// limit that the run asserts is never reached (the fallback card "never drawn" while the island's buttons show) must stretch with it, or
// the row measures the runner's speed (browser-host row 120, run 44917109910: the island's buttons took 3.06 s to show at a load of
// 84, the fallback had come at 2.3 s, 60 ms before they showed). Only a build that is not a released one reads it: a packaged app
// with neither test define ignores the variable, so a person's app never changes its limits.

/** 1 on a person's app, the run's scale (1 to 10) on a test or source build. */
export function testTimeScale(env: Record<string, string | undefined>, released: boolean): number {
  if (released) return 1;
  const n = Number(env.MOSS_ACCEPT_TIME_SCALE ?? "1");
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : 1;
}
