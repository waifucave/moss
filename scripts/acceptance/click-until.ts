// A press whose result is a page opening, made again when the page did not open. The sidebar lists its sessions after it first
// draws, which moves the Apps rows down; a press aimed at a row's place from before then lands on what moved into it (archive
// row 89, run 44918645157: the press selected the code session that had taken the Archive row's place, the Archive page never
// opened, and the next wait ran its 90 s). The press is made again, the row found anew, until the page shows or the tries end.

export async function pressUntilShown(o: {
  press: () => Promise<void>;
  shown: () => Promise<boolean>;
  tries: number;
  waitMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<number> {
  for (let attempt = 1; attempt <= o.tries; attempt++) {
    await o.press();
    const until = o.now() + o.waitMs;
    for (;;) {
      if (await o.shown()) return attempt;
      if (o.now() >= until) break;
      await o.sleep(200);
    }
  }
  return 0;
}
