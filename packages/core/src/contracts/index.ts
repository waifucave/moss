// The spine's core interfaces (plan §3), one file each, with their owners:
//
// | Contract          | Owner      | File                  |
// | :---------------- | :--------- | :-------------------- |
// | SecretStore       | C          | secret-store.ts       |
// | Fence             | C          | fence.ts              |
// | ApprovalBroker    | C (K signs off for agents) | approval-broker.ts |
// | PluginRegistry    | B          | plugin-registry.ts    |
// | PluginHost        | B          | plugin-host.ts        |
// | SessionHost       | D and A (K signs off for agents) | session-host.ts |
// | LinkTransport     | H          | link-transport.ts     |
// | DeviceRegistry    | H          | device-registry.ts    |
// | Lease             | H          | lease.ts              |
// | Clock             | H          | clock.ts              |
// | ComputerRegistry  | J          | computer-registry.ts  |
// | Tree              | J          | tree.ts               |
// | AgentBackend      | K          | agent-backend.ts      |
// | BrowserApi        | L          | browser-api.ts        |
// | SurfaceDoor       | RT         | surface-door.ts       |
// | CardRouter        | RT         | card-router.ts        |
// | ProgramAnswerKeys | RT (over H's registry) | program-keys.ts |
// | ReleaseHome       | RL         | release-home.ts       |
// | HostSupervisor    | HS         | host-supervisor.ts    |
// | ActivityFeed      | AF         | activity-feed.ts      |
// | LivePictures      | AF (HS for tabs, MA shows them) | live-pictures.ts |
// | BotRecords        | BT         | bot-records.ts        |
// | ToolSettings      | TS (beside A's permission) | tool-settings.ts |
// | SessionGraph      | CG         | session-graph.ts      |
// | SessionTitles     | CG         | session-titles.ts     |
// | SessionMessenger  | CM         | session-reach.ts      |
// | AgentStartOptions | CA         | agent-start.ts        |
// | BackendIcons      | CA         | backend-icons.ts      |
// | ProgramOpener     | CA         | program-opener.ts     |
//
// The session canvas's contracts (spec revision 20, §9.5) were pinned by lane CS; their owners are the canvas's lanes.
//
// The split's contracts (spec revision 19, §13 Split 1) were pinned by lane SP; their owners are the split's lanes.
//
// The UI API (lane E) is in the plugin SDK (`packages/plugin-sdk/src/api/ui-api.ts`). The fakes are in `./fakes`.
export * from "./common";
export * from "./clock";
export * from "./secret-store";
export * from "./fence";
export * from "./approval-broker";
export * from "./plugin-registry";
export * from "./plugin-registry-rules";
export * from "./plugin-host";
export * from "./session-host";
export * from "./link-transport";
export * from "./device-registry";
export * from "./lease";
export * from "./computer-registry";
export * from "./tree";
export * from "./agent-backend";
export * from "./browser-api";
export * from "./surface-door";
export * from "./card-router";
export * from "./program-keys";
export * from "./release-home";
export * from "./host-supervisor";
export * from "./activity-feed";
export * from "./live-pictures";
export * from "./bot-records";
export * from "./tool-settings";
export * from "./session-graph"; export * from "./session-titles"; export * from "./session-reach"; export * from "./agent-start"; export * from "./backend-icons"; export * from "./program-opener";
