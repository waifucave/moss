// `app.openIn`'s rule (spec revision 20, §9.5 "Bots and the other program"; the contract is `contracts/program-opener.ts`,
// whose conformance suite `ipc/tests/program-opener.test.ts` runs against this). A window's main process asks, on the
// person's own press in a part, for a place in the OTHER program of the pair; the engine routes it to that program's window
// connection as `app.show`, starting the program first when it isn't running, and answers once the window took it.
//   * Only a place that program opens (`OPEN_IN_PLACES`), never the caller's own program (that is `shell.go`'s), never the host.
//   * Starts are single-flight per program: two presses while MOSS starts wait for the one start, then each is shown once.
//   * A start that never connects within `OPEN_IN_START_MS` answers refused; so does a window that refuses the place.
import { OPEN_IN_PLACES, type AppOpenInResult, type AppShowWhat, type WindowProgram } from "@waifucave/moss-protocol";
import { OPEN_IN_START_MS, type ProgramOpener, type ProgramOpenerWorld } from "../contracts/program-opener";

const NAME: Readonly<Record<WindowProgram, string>> = { moss: "MOSS", code: "MOSS Code" };

export class EngineProgramOpener implements ProgramOpener {
  readonly #starting = new Map<WindowProgram, Promise<boolean>>();

  constructor(private readonly world: ProgramOpenerWorld, private readonly startMs: number = OPEN_IN_START_MS) {}

  async openIn(caller: WindowProgram, program: WindowProgram, what: AppShowWhat): Promise<AppOpenInResult> {
    if (caller === program) return { opened: false, refused: "That place is in this program's own window: show it there." };
    if (!(program in OPEN_IN_PLACES)) return { opened: false, refused: "That isn't a program with a window." };
    if (!OPEN_IN_PLACES[program].includes(what.kind)) return { opened: false, refused: `${NAME[program]} doesn't open a ${what.kind}.` };
    let started = false;
    if (!this.world.connected(program)) {
      let start = this.#starting.get(program);
      if (start === undefined) {
        start = this.world.start(program, this.startMs).catch(() => false).finally(() => this.#starting.delete(program));
        this.#starting.set(program, start);
      }
      if (!(await start)) return { opened: false, refused: `${NAME[program]} didn't start.` };
      started = true;
    }
    try {
      await this.world.show(program, what);
    } catch (err) {
      // The window said no (a bot it doesn't have), or went away between: refused with its own words, capped.
      return { opened: false, refused: (err instanceof Error ? err.message : `${NAME[program]} didn't take it.`).slice(0, 300) };
    }
    return { opened: true, started };
  }
}
