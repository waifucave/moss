// The `computerProviders` conformance suite, run against each provider plugin that ships (spec §9.2).
import { runCloudProviderConformance } from "./cloud-provider-conformance";

runCloudProviderConformance("hetzner");
runCloudProviderConformance("gcp");
