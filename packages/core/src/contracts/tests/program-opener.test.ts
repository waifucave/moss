// Runs the ProgramOpener conformance suite against FakeProgramOpener.
import { runProgramOpenerConformance } from "../conformance/program-opener";
import { FakeProgramOpener } from "../fakes/program-opener";

runProgramOpenerConformance((world) => new FakeProgramOpener(world));
