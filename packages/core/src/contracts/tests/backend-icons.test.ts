// Runs the BackendIcons conformance suite against FakeBackendIcons.
import { runBackendIconsConformance } from "../conformance/backend-icons";
import { FakeBackendIcons } from "../fakes/backend-icons";

runBackendIconsConformance((files) => new FakeBackendIcons(files));
