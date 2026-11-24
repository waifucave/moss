import Foundation

/// A page of one conversation's messages, oldest first (`bot.conversation`, `session.history`).
public struct MessagePage: Hashable, Sendable {
    public var session: String
    public var messages: [ChatMessage]
    public var hasMore: Bool
    public init(session: String, messages: [ChatMessage], hasMore: Bool = false) {
        self.session = session; self.messages = messages; self.hasMore = hasMore
    }
}

/// What the phone's screens need from the engine. Lane PC's shared core implements it over the paired link; the
/// screens run on `FakeEngineClient` until then. Every call maps to a call of the `remote` allowlist
/// (`packages/protocol/generated/moss/allowlists.json`), except pairing, which is the core's own ceremony.
///
/// A client never gives a screen raw JSON: it hands back the models in `Models.swift`. It signs card answers and
/// user messages with the device's own key itself (no Face ID, Touch ID or passcode is asked for).
public protocol EngineClient: AnyObject, Sendable {
    /// The computer this phone is paired with; `nil` before the first pairing.
    var pairedComputer: PairedComputer? { get async }

    /// Pairing. `code` is the text of the QR the computer shows (`device.pair.begin`'s `qr`); the proposal holds the
    /// four words both screens show. `confirmPairing` is the person's yes when the words agree.
    func beginPairing(code: String) async throws -> PairingProposal
    func confirmPairing(_ proposal: PairingProposal) async throws -> PairedComputer
    func cancelPairing(_ proposal: PairingProposal) async

    /// `bot.list` joined with `bot.summaries`.
    func bots() async throws -> [Bot]
    func botSummaries() async throws -> [BotSummary]
    /// `bot.conversation`: a page of the bot's one conversation, newest last.
    func conversation(bot: String, before: Int64?, limit: Int) async throws -> MessagePage
    /// `bot.markRead`.
    func markRead(bot: String) async throws

    /// `session.list`.
    func sessions() async throws -> [SessionRow]
    /// `session.history`.
    func history(session: String, before: Int64?, limit: Int) async throws -> MessagePage

    /// `session.send` with a `UserMessageInput` (the client id makes a resend one message). Bots' conversations and
    /// coding sessions are both sessions, so one call serves both.
    func send(session: String, text: String, clientMessageId: String, images: [String]) async throws
    /// `session.interrupt`: Stop.
    func stop(session: String) async throws

    /// `card.list`, and `card.answer` with a signed answer over the card's hash. `answer` throws `CardAnswerError` when the
    /// card expired or another device answered it first.
    func cards() async throws -> [Card]
    func answer(card: Card, option: CardOption) async throws
    /// The engine's answer to which cards this app shows (MOSS the bots' cards, MOSS Code the rest, and every pending card
    /// when the other app is not installed): a setting of the client's answer, never a split the screens hard-code.
    func shows(_ card: Card, in app: PhoneApp) async -> Bool

    /// Starting a coding session (MOSS Code): `agent.backends`, `agent.options`, `agent.recent`, `agent.start`.
    /// `startSession` returns the new session's id; `sessions()` then lists it.
    func backends() async throws -> [AgentBackend]
    func startOptions(backend: String) async throws -> BackendOptions
    func recentStart() async throws -> RecentStart
    func startSession(_ request: StartRequest) async throws -> String

    /// The composer's rows: what this conversation or session offers through the doors a phone may call. Nothing offered, no row.
    func composerOffers(session: String, kind: ConversationKind) async throws -> ComposerOffers
    /// `session.setModel` (a bot's effort too).
    func setModel(session: String, model: String?, effort: String?) async throws
    /// `session.stageImage`: the staged picture's path, for `send(images:)`.
    func stageImage(session: String, data: Data) async throws -> String
    /// `command.run`.
    func runCommand(session: String, command: String) async throws
    /// The question waiting in a conversation, if any, and `session.answer`.
    func pendingQuestion(session: String) async throws -> AskQuestion?
    func answerQuestion(session: String, question: AskQuestion, answers: [String: String]) async throws

    /// The state of the link now (`events()` tells the changes), and forgetting this computer.
    func connectionState() async -> ConnectionState
    func unpair() async

    /// `events.subscribe`: what happens next, until the stream is dropped.
    func events() async -> AsyncStream<EngineEvent>
}

public extension EngineClient {
    func send(session: String, text: String, clientMessageId: String) async throws {
        try await send(session: session, text: text, clientMessageId: clientMessageId, images: [])
    }
}
