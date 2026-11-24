// Runs the AgentStartOptions conformance suite against FakeAgentStartOptions.
import { runAgentStartOptionsConformance } from "../conformance/agent-start";
import { FakeAgentStartOptions } from "../fakes/agent-start";

runAgentStartOptionsConformance((backends, catalog) => new FakeAgentStartOptions(backends, catalog));
