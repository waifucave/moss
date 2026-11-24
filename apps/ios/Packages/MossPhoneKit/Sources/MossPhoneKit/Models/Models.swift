import Foundation

// Shapes the phone shows, as the engine's own payloads carry them (`packages/protocol/src/bots.ts`, `sessions.ts`,
// `approvals.ts`). Names and cases follow the protocol; times are epoch milliseconds, as on the wire.

/// A bot's face pins (`BotFace`): a trait left out comes from the bot's name, in the kit.
public struct BotFaceSpec: Codable, Hashable, Sendable {
    public var shape: String?
    public var color: String?
    public var eyes: String?
    public var temper: String?
    public init(shape: String? = nil, color: String? = nil, eyes: String? = nil, temper: String? = nil) {
        self.shape = shape; self.color = color; self.eyes = eyes; self.temper = temper
    }
}

public enum BotState: String, Codable, Sendable { case idle, thinking, asleep, paused }

/// A bot as `bot.list` serves it (its record, its main session and its state).
public struct Bot: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var model: String?
    public var effort: String?
    public var face: BotFaceSpec?
    public var state: BotState?
    public var computer: String?
    public var mainSession: String
    public init(id: String, name: String, model: String? = nil, effort: String? = nil, face: BotFaceSpec? = nil,
                state: BotState? = nil, computer: String? = nil, mainSession: String) {
        self.id = id; self.name = name; self.model = model; self.effort = effort; self.face = face
        self.state = state; self.computer = computer; self.mainSession = mainSession
    }
}

/// One line of the bots list (`BotSummary`): the bot's last line, its time and whether the user has read it.
public struct BotSummary: Codable, Hashable, Sendable {
    public struct Last: Codable, Hashable, Sendable {
        public enum From: String, Codable, Sendable { case user, bot, note }
        public var text: String
        public var from: From
        public var at: Int64
        public init(text: String, from: From, at: Int64) { self.text = text; self.from = from; self.at = at }
    }
    public var id: String
    public var last: Last?
    public var unread: Bool
    public init(id: String, last: Last? = nil, unread: Bool = false) { self.id = id; self.last = last; self.unread = unread }
}

public enum MessageRole: String, Codable, Sendable { case user, bot, note, agent }

/// One message of a conversation, already read out of the session's events by the client.
public struct ChatMessage: Identifiable, Hashable, Sendable {
    public var id: String
    public var role: MessageRole
    public var text: String
    /// Epoch milliseconds.
    public var at: Int64
    /// The device a user message came from (`from <device>`), when it was not this phone.
    public var device: String?
    public init(id: String, role: MessageRole, text: String, at: Int64, device: String? = nil) {
        self.id = id; self.role = role; self.text = text; self.at = at; self.device = device
    }
}

// MARK: Sessions

public enum SessionStatus: String, Codable, Sendable { case starting, ready, prompting, cancelling, idle, stopped, failed }

public struct SessionWaiting: Codable, Hashable, Sendable {
    public var tasks: Int
    public var children: Int
    public init(tasks: Int, children: Int) { self.tasks = tasks; self.children = children }
}

public struct NeedsYou: Codable, Hashable, Sendable {
    public var cards: Int
    public var questions: Int
    public init(cards: Int, questions: Int) { self.cards = cards; self.questions = questions }
    public var total: Int { cards + questions }
}

/// How a session moves (`sessionMotion` in `session-graph.ts`): running wins over waiting.
public enum SessionMotion: String, Sendable { case running, waiting, still, ended }

public func sessionMotion(status: SessionStatus, waiting: SessionWaiting?) -> SessionMotion {
    switch status {
    case .stopped, .failed: return .ended
    case .starting, .prompting, .cancelling: return .running
    case .ready, .idle:
        if let w = waiting, w.tasks + w.children > 0 { return .waiting }
        return .still
    }
}

/// A session as `session.list` serves it (`SessionView`, the fields the phone draws).
public struct SessionRow: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var kind: String
    public var bot: String?
    public var parent: String?
    public var computer: String
    public var title: String?
    public var status: SessionStatus
    public var startedAt: Int64
    public var updatedAt: Int64
    public var backend: String?
    public var model: String?
    public var root: String?
    public var branch: String?
    public var changes: Int?
    public var needsYou: NeedsYou?
    public var waiting: SessionWaiting?
    public var archived: Bool?

    public init(id: String, kind: String = "coding", bot: String? = nil, parent: String? = nil, computer: String,
                title: String? = nil, status: SessionStatus, startedAt: Int64, updatedAt: Int64, backend: String? = nil,
                model: String? = nil, root: String? = nil, branch: String? = nil, changes: Int? = nil,
                needsYou: NeedsYou? = nil, waiting: SessionWaiting? = nil, archived: Bool? = nil) {
        self.id = id; self.kind = kind; self.bot = bot; self.parent = parent; self.computer = computer; self.title = title
        self.status = status; self.startedAt = startedAt; self.updatedAt = updatedAt; self.backend = backend
        self.model = model; self.root = root; self.branch = branch; self.changes = changes; self.needsYou = needsYou
        self.waiting = waiting; self.archived = archived
    }

    public var motion: SessionMotion { sessionMotion(status: status, waiting: waiting) }
    /// The project the desktop's sidebar groups it under: its root folder's own name.
    public var project: String {
        guard let root, let last = root.split(separator: "/").last else { return "" }
        return String(last)
    }
}

// MARK: Cards

/// A sealed field's content (`SealedValue`). The phone draws what the card hash covers and cuts nothing silently.
public enum SealedValue: Codable, Hashable, Sendable {
    case text(String)
    case code(String, language: String?)
    case list([String])
    case rows([Row])
    public struct Row: Codable, Hashable, Sendable {
        public var label: String
        public var value: String
        public init(label: String, value: String) { self.label = label; self.value = value }
    }

    private enum Keys: String, CodingKey { case type, text, code, language, items, rows }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "text": self = .text(try c.decode(String.self, forKey: .text))
        case "code": self = .code(try c.decode(String.self, forKey: .code), language: try c.decodeIfPresent(String.self, forKey: .language))
        case "list": self = .list(try c.decode([String].self, forKey: .items))
        case "rows": self = .rows(try c.decode([Row].self, forKey: .rows))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown sealed field type")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .text(let t): try c.encode("text", forKey: .type); try c.encode(t, forKey: .text)
        case .code(let s, let l): try c.encode("code", forKey: .type); try c.encode(s, forKey: .code); try c.encodeIfPresent(l, forKey: .language)
        case .list(let i): try c.encode("list", forKey: .type); try c.encode(i, forKey: .items)
        case .rows(let r): try c.encode("rows", forKey: .type); try c.encode(r, forKey: .rows)
        }
    }
}

/// A sealed button. The label is a plain string or a map by language on the wire; the phone keeps the one it shows.
public struct CardOption: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable { case approve, deny }
    public var id: String
    public var kind: Kind
    public var label: String
    public var rememberAlways: Bool

    public init(id: String, kind: Kind, label: String, rememberAlways: Bool = false) {
        self.id = id; self.kind = kind; self.label = label; self.rememberAlways = rememberAlways
    }
    private enum Keys: String, CodingKey { case id, kind, label, remember }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(Kind.self, forKey: .kind)
        if let s = try? c.decode(String.self, forKey: .label) {
            label = s
        } else {
            let map = try c.decode([String: String].self, forKey: .label)
            let preferred = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "en"
            label = map[preferred] ?? map["en"] ?? map.values.sorted().first ?? id
        }
        rememberAlways = (try c.decodeIfPresent(String.self, forKey: .remember)) == "always"
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(id, forKey: .id); try c.encode(kind, forKey: .kind); try c.encode(label, forKey: .label)
        if rememberAlways { try c.encode("always", forKey: .remember) }
    }
}

/// A pending card (`Card`). `hash` is what the answer is signed over; the client keeps it with the card.
public struct Card: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var kind: String
    public var computer: String?
    public var session: String?
    public var bot: String?
    public var origin: String?
    public var issuedAt: Int64
    public var expiresAt: Int64
    public var hash: String
    public var fields: [String: SealedValue]
    public var options: [CardOption]

    public init(id: String, kind: String, computer: String? = nil, session: String? = nil, bot: String? = nil,
                origin: String? = nil, issuedAt: Int64, expiresAt: Int64, hash: String,
                fields: [String: SealedValue], options: [CardOption]) {
        self.id = id; self.kind = kind; self.computer = computer; self.session = session; self.bot = bot
        self.origin = origin; self.issuedAt = issuedAt; self.expiresAt = expiresAt; self.hash = hash
        self.fields = fields; self.options = options
    }

    public var title: String { text("title") ?? "Needs your answer" }
    public var what: String? { text("what") }
    private func text(_ name: String) -> String? {
        if case .text(let t)? = fields[name] { return t }
        return nil
    }
}

// MARK: Pairing and events

/// The computer a phone is paired with.
public struct PairedComputer: Hashable, Sendable {
    public var name: String
    public var deviceName: String
    /// When the link last carried anything (epoch ms), if it ever has.
    public var lastSeen: Int64?
    public init(name: String, deviceName: String, lastSeen: Int64? = nil) { self.name = name; self.deviceName = deviceName; self.lastSeen = lastSeen }
}

/// What a scanned code starts: the id of the pairing and the four words both screens show.
public struct PairingProposal: Hashable, Sendable {
    public var pairingId: String
    public var computer: String
    public var words: [String]
    public init(pairingId: String, computer: String, words: [String]) { self.pairingId = pairingId; self.computer = computer; self.words = words }
}

public enum PairingError: Error, Equatable, Sendable { case unreadableCode, expired, wordsDoNotMatch, unreachable }

/// What the engine tells a phone as it happens (the `receives` list of the remote allowlist, boiled down to what screens use).
public enum EngineEvent: Hashable, Sendable {
    case botChanged(Bot)
    case botSummaryChanged(BotSummary)
    /// A turn's one status line for a bot or session; `nil` when the turn ended.
    case statusLine(subject: String, line: String?)
    case message(subject: String, ChatMessage)
    case sessionChanged(SessionRow)
    case cardRequested(Card)
    case cardResolved(id: String)
    case connection(ConnectionState)
}


// MARK: Link state, apps, starting a session

/// Whether the link to the paired computer is carrying anything now.
public enum ConnectionState: Hashable, Sendable {
    case connected
    /// The computer cannot be reached; `since` is when the link was last up (epoch ms), if known.
    case unreachable(since: Int64?)
}

/// Which phone app is asking, for the client's answer to which cards to show it.
public enum PhoneApp: String, Hashable, Sendable { case moss, code }

/// Why an answer to a card did not count.
public enum CardAnswerError: Error, Equatable, Sendable {
    case expired
    case answeredElsewhere
}

/// An agent backend a person can start a session with (`agent.backends`, `userStartable` only).
public struct AgentBackend: Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

/// A model a backend offers before any session exists (`BackendModelOption`).
public struct ModelOption: Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var efforts: [String]
    public var defaultEffort: String?
    public init(id: String, name: String, efforts: [String] = [], defaultEffort: String? = nil) {
        self.id = id; self.name = name; self.efforts = efforts; self.defaultEffort = defaultEffort
    }
}

/// What a backend offers to start with (`AgentBackendOptions`). `known: false` means unknown until it starts.
public struct BackendOptions: Hashable, Sendable {
    public var backend: String
    public var known: Bool
    public var models: [ModelOption]
    public var defaultModel: String?
    public var defaultEffort: String?
    public init(backend: String, known: Bool = true, models: [ModelOption], defaultModel: String? = nil, defaultEffort: String? = nil) {
        self.backend = backend; self.known = known; self.models = models; self.defaultModel = defaultModel; self.defaultEffort = defaultEffort
    }
}

/// The person's last start (`RecentStart`): preselects the agent, its model and effort, and lists folders used before.
public struct RecentStart: Hashable, Sendable {
    public struct Choice: Hashable, Sendable {
        public var backend: String
        public var model: String?
        public var effort: String?
        public init(backend: String, model: String? = nil, effort: String? = nil) { self.backend = backend; self.model = model; self.effort = effort }
    }
    public var last: Choice?
    public var byBackend: [Choice]
    /// Folders started in last, newest first.
    public var roots: [String]
    public init(last: Choice? = nil, byBackend: [Choice] = [], roots: [String] = []) { self.last = last; self.byBackend = byBackend; self.roots = roots }
}

/// What `agent.start` takes (`backend`, `computer`, `root`, `model`, `effort`).
public struct StartRequest: Hashable, Sendable {
    public var backend: String
    public var computer: String
    public var root: String
    public var model: String?
    public var effort: String?
    public init(backend: String, computer: String, root: String, model: String? = nil, effort: String? = nil) {
        self.backend = backend; self.computer = computer; self.root = root; self.model = model; self.effort = effort
    }
}

public enum StartError: Error, Equatable, Sendable {
    /// The engine refused the folder (outside the fence, or it holds the MOSS home).
    case folderRefused
    /// The agent is not installed on that computer.
    case notInstalled
}
