// Runs the SessionGraph conformance suite against FakeSessionGraph.
import { runSessionGraphConformance } from "../conformance/session-graph";
import { FakeSessionGraph } from "../fakes/session-graph";

runSessionGraphConformance((now) => new FakeSessionGraph(now));
