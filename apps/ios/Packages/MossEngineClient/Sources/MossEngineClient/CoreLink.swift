import Foundation
import MossPhoneKit

// What `CoreEngineClient` needs from the phone core (native/phone-core), one to one with its Swift binding. The core
// decodes the engine's payloads once, in Rust, into typed records (lane PC3); `MossEngineCore` conforms the binding to
// these protocols and maps each record onto the screens' models (MossPhoneKit) and nothing else. Keeping the client on
// this mirror lets it build and test without the core's XCFramework (built only in CI).

/// Which of the two phone apps a pairing is for (`PhoneApp` in the core).
public enum LinkApp: String, Sendable, Hashable { case moss, code }

/// A computer this phone is paired with (`PairedComputer` in the core).
public struct LinkComputer: Sendable, Hashable {
    public var id: String
    public var name: String
    public var app: LinkApp
    public var pairedAt: Int64
    public init(id: String, name: String, app: LinkApp, pairedAt: Int64) { self.id = id; self.name = name; self.app = app; self.pairedAt = pairedAt }
}

/// The link's state (`LinkState`).
public enum LinkState: Sendable, Equatable { case connecting, up, down, unpaired, revoked, closed }

/// A card the core issued for display (`CardView`, an object only the core makes). `card` is what the screen draws, as
/// the core typed it (every string through its visible-text rule), or nil when the core couldn't read all of it (the
/// screen then draws "answer this one on your computer"); `handle` is the core's own object, handed back unchanged to
/// answer it: the client never builds one.
public final class ShownCard: @unchecked Sendable {
    public let id: String
    public let hash: String
    public let card: Card?
    /// Whose it is, as the core read it from the card: the bot or the session that raised it.
    public let bot: String?
    public let session: String?
    public let handle: AnyObject
    public init(id: String, hash: String, card: Card?, bot: String? = nil, session: String? = nil, handle: AnyObject) {
        self.id = id; self.hash = hash; self.card = card; self.bot = bot; self.session = session; self.handle = handle
    }
}

/// How a card was settled (`card.get`), read back after an answer timed out.
public struct LinkCardOutcome: Sendable, Equatable {
    public var outcome: String?
    public var option: String?
    public init(outcome: String?, option: String?) { self.outcome = outcome; self.option = option }
}

/// One event of a session's log as the core typed it (`SessionItem`): a message the conversation draws, a turn's start
/// or end (the one status line), a question, or something the phone doesn't draw.
public enum LinkItem: Sendable, Equatable {
    case message(ChatMessage)
    case turnStarted
    case turnEnded
    /// A question closed, and how (`question_resolved`).
    case questionResolved(callId: String, state: AskedQuestion.State)
    case other
}

/// A page of a session's log, oldest first (`MessagePage`). `seq` orders it; the oldest is where "earlier" starts.
public struct LinkPage: Sendable {
    public var session: String
    public var items: [(seq: UInt64, item: LinkItem)]
    public var hasMore: Bool
    public init(session: String, items: [(seq: UInt64, item: LinkItem)], hasMore: Bool) { self.session = session; self.items = items; self.hasMore = hasMore }
}

/// What a connection tells, in order (`ConnEvent`).
public enum LinkEvent: Sendable {
    case connecting
    case up
    case pendingCards([ShownCard])
    case cardRequested(ShownCard)
    case cardResolved(id: String, outcome: String)
    case botChanged(Bot)
    case botSummaryChanged(BotSummary)
    case botRemoved(id: String)
    case sessionChanged(SessionRow)
    case sessionRemoved(id: String)
    case sessionItem(session: String, seq: UInt64, item: LinkItem)
    /// A card whose hash didn't match: not shown, never signed.
    case tamperedCard
    /// A message larger than the phone takes was dropped.
    case messageDropped
    /// Any other notification the core passes on untyped.
    case notification(method: String, paramsJSON: String)
    case down(reason: String)
    case unpaired
    case revoked
    case lagged
    case closed
}

/// The core's errors (`CoreError`), in the client's terms. The texts are the core's own words.
public enum LinkError: Error, Sendable, Equatable {
    /// The store can't be read now (the Keychain before the first unlock): try again later. Never "not paired".
    case storageNotAvailable(String)
    case storage(String)
    case invalid(String)
    case refused(String)
    case protocolError(String)
    case offline(String)
    case timeout(String)
    /// The engine answered with a JSON-RPC error; `words` is the engine's message, cleaned by the core.
    case rpc(code: Int64, words: String, dataJSON: String?)
    case revoked(String)
    case closed(String)
    case tamperedCard(String)

    /// The engine has no such door, or doesn't open it to a phone (an older engine, or a door not merged yet).
    public var isNotOffered: Bool {
        if case .rpc(let code, let words, _) = self { return code == -32601 || (code == -32001 && words.contains("may not call")) }
        return false
    }
}

/// A pairing in progress (`Pairing`).
public protocol PairingLink: AnyObject, Sendable {
    var words: [String] { get }
    var computerName: String { get }
    func confirm() async throws -> LinkComputer
    func reject() async
}

/// One computer's link and client connection (`Connection`): the core's typed calls, already decoded.
public protocol ConnectionLink: AnyObject, Sendable {
    func nextEvent() async -> LinkEvent?
    func fetchCard(_ id: String) async throws -> ShownCard
    /// Follows a conversation live (`session.attach`): the newest place in its log.
    func attach(session: String, since: UInt64?) async throws -> UInt64
    func detach(session: String) async throws
    /// The ids of the cards pending now (`card.list`).
    func pendingCardIDs() async throws -> [String]
    /// How a card was settled (`card.get`).
    func cardOutcome(id: String) async throws -> LinkCardOutcome
    /// Signs and sends the answer to the card the core issued (`answer_card`): `card.handle` goes back as it came.
    func answer(_ card: ShownCard, option: String, children: [String]) async throws -> (accepted: Bool, reason: String?)
    func sendMessage(session: String, text: String, clientMessageId: String, images: [String], files: [String]) async throws -> UInt64
    func stageFile(session: String, name: String, data: Data) async throws -> (name: String, path: String)
    func stageImage(session: String, mediaType: String, data: Data) async throws -> String

    func bots() async throws -> [Bot]
    func botSummaries() async throws -> [BotSummary]
    func conversation(bot: String, beforeSeq: Int64?, limit: UInt32) async throws -> LinkPage
    func markRead(bot: String, at: Int64) async throws
    func createBot(name: String, model: String?) async throws -> Bot
    func sessions() async throws -> [SessionRow]
    func history(session: String, beforeSeq: Int64?, limit: UInt32) async throws -> LinkPage
    func stop(session: String) async throws
    func setModel(session: String, model: String, effort: String?) async throws
    func composerOffers(session: String) async throws -> ComposerOffers
    func pendingQuestion(session: String) async throws -> AskQuestion?
    func answerQuestion(session: String, callId: String, answers: [String: String]) async throws
    func skipQuestion(session: String, callId: String) async throws
    func backends() async throws -> [AgentBackend]
    func startOptions(backend: String, computer: String?) async throws -> BackendOptions
    func recentStart() async throws -> RecentStart
    func startSession(_ request: StartRequest) async throws -> String
    /// `models.list`: the models on offer (signed in), and the default.
    func models(session: String?) async throws -> NewBotOptions
    func runCommand(name: String) async throws

    func state() -> LinkState
    func networkChanged()
    func disconnect()
}

/// The phone core (`PhoneCore`), made over the host's store.
public protocol CoreLink: AnyObject, Sendable {
    func pairedComputers() throws -> [LinkComputer]
    var deviceName: String { get }
    func beginPairing(qr: String, app: LinkApp) async throws -> PairingLink
    func connect(computerId: String, clientName: String, areas: [String]) async throws -> ConnectionLink
    func forgetComputer(_ id: String) throws
    func shutdown() async
}

/// How the client reaches the core and its store: making a core (again, after an unpair or a locked Keychain), emptying
/// the store of every item the core kept (the unpair leaves nothing of the pairing, the identity included), and the
/// engine's one rule for drawing a computer's text outside a typed field (`visible_text`).
public struct CoreFactory: Sendable {
    public var make: @Sendable () throws -> CoreLink
    public var wipeStore: @Sendable () throws -> Void
    public var visible: @Sendable (String) -> String
    /// The same rule for a name (a computer's): `visible_text(text, name: true)`.
    public var visibleName: @Sendable (String) -> String
    public init(make: @escaping @Sendable () throws -> CoreLink, wipeStore: @escaping @Sendable () throws -> Void, visible: @escaping @Sendable (String) -> String = { $0 },
                visibleName: @escaping @Sendable (String) -> String = { $0 }) {
        self.make = make; self.wipeStore = wipeStore; self.visible = visible; self.visibleName = visibleName
    }
}
