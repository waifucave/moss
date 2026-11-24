import Foundation

/// The client of a Release build made without the phone core (the fake-only project, `project.yml`): it has no engine,
/// refuses every call and is never paired. The real apps are built from `project-real.yml`, where the engine client is
/// the phone core's; a Release build never runs on the fake or its sample data.
public final class NoEngineClient: EngineClient, @unchecked Sendable {
    public struct NoEngine: Error, Equatable, Sendable { public init() {} }
    public init() {}
    public var pairedComputer: PairedComputer? { get async { nil } }
    public func beginPairing(code: String) async throws -> PairingProposal { throw PairingError.unreachable }
    public func confirmPairing(_ proposal: PairingProposal) async throws -> PairedComputer { throw PairingError.unreachable }
    public func cancelPairing(_ proposal: PairingProposal) async {}
    public func bots() async throws -> [Bot] { throw NoEngine() }
    public func botSummaries() async throws -> [BotSummary] { throw NoEngine() }
    public func conversation(bot: String, before: Int64?, limit: Int) async throws -> MessagePage { throw NoEngine() }
    public func markRead(bot: String) async throws { throw NoEngine() }
    public func sessions() async throws -> [SessionRow] { throw NoEngine() }
    public func history(session: String, before: Int64?, limit: Int) async throws -> MessagePage { throw NoEngine() }
    public func send(session: String, text: String, clientMessageId: String, images: [String], files: [String]) async throws { throw NoEngine() }
    public func stop(session: String) async throws { throw NoEngine() }
    public func cards() async throws -> [Card] { throw NoEngine() }
    public func answer(card: Card, option: CardOption) async throws { throw NoEngine() }
    public func shows(_ card: Card, in app: PhoneApp) async -> Bool { false }
    public func backends() async throws -> [AgentBackend] { throw NoEngine() }
    public func startOptions(backend: String) async throws -> BackendOptions { throw NoEngine() }
    public func recentStart() async throws -> RecentStart { throw NoEngine() }
    public func startSession(_ request: StartRequest) async throws -> String { throw NoEngine() }
    public func composerOffers(session: String, kind: ConversationKind) async throws -> ComposerOffers { throw NoEngine() }
    public func setModel(session: String, model: String?, effort: String?) async throws { throw NoEngine() }
    public func stageImage(session: String, data: Data) async throws -> String { throw NoEngine() }
    public func stageFile(session: String, name: String, data: Data) async throws -> StagedFile { throw NoEngine() }
    public func newBotOptions() async throws -> NewBotOptions { throw NoEngine() }
    public func createBot(name: String, model: String?) async throws -> Bot { throw NoEngine() }
    public func runCommand(session: String, command: String) async throws { throw NoEngine() }
    public func pendingQuestion(session: String) async throws -> AskQuestion? { nil }
    public func answerQuestion(session: String, question: AskQuestion, answers: [String: String]) async throws { throw NoEngine() }
    public func connectionState() async -> ConnectionState { .unreachable(since: nil) }
    public func unpair() async {}
    public func events() async -> AsyncStream<EngineEvent> { AsyncStream { _ in } }
}
