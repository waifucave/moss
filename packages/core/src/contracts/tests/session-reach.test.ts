// Runs the SessionMessenger conformance suite against FakeSessionMessenger.
import { runSessionMessengerConformance } from "../conformance/session-reach";
import { FakeSessionMessenger } from "../fakes/session-reach";

runSessionMessengerConformance((world) => new FakeSessionMessenger(world));
