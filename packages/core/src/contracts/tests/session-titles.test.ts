// Runs the SessionTitles conformance suite against FakeSessionTitles.
import { runSessionTitlesConformance } from "../conformance/session-titles";
import { FakeSessionTitles } from "../fakes/session-titles";

runSessionTitlesConformance((titler, light) => new FakeSessionTitles(titler, light));
