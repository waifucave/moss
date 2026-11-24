// FakeProgramOpener: the routing rule over a world the test gives.
import { OPEN_IN_PLACES, type AppOpenInResult, type AppShowWhat, type WindowProgram } from "@waifucave/moss-protocol";
import { OPEN_IN_START_MS, type ProgramOpener, type ProgramOpenerWorld } from "../program-opener";

export class FakeProgramOpener implements ProgramOpener {
  constructor(private readonly world: ProgramOpenerWorld) {}

  async openIn(caller: WindowProgram, program: WindowProgram, what: AppShowWhat): Promise<AppOpenInResult> {
    if (caller === program) return { opened: false, refused: "That place is in this program's own window: show it there." };
    if (!OPEN_IN_PLACES[program].includes(what.kind)) return { opened: false, refused: `${program === "moss" ? "MOSS" : "MOSS Code"} doesn't open a ${what.kind}.` };
    let started = false;
    if (!this.world.connected(program)) {
      if (!(await this.world.start(program, OPEN_IN_START_MS))) return { opened: false, refused: `${program === "moss" ? "MOSS" : "MOSS Code"} didn't start.` };
      started = true;
    }
    await this.world.show(program, what);
    return { opened: true, started };
  }
}
