import Foundation

/// The engine client the screens run on until lane PC's core exists: in memory, serving `SampleData`, and
/// deterministic. It sleeps never; a turn it starts is finished by `finishTurn` (the apps call it after a short
/// delay, tests call it directly).
public actor FakeEngineClient: EngineClient {
    public enum Scenario: Sendable {
        /// Paired, everything quiet.
        case idle
        /// Paired, and Alpha's turn is running (status line, Stop showing).
        case midTurn
        /// Not paired yet.
        case unpaired
    }

    public struct Failure: Error, Equatable, Sendable { public var message: String; public init(_ m: String) { message = m } }

    private var paired: PairedComputer?
    private var botList: [Bot]
    private var summaryList: [BotSummary]
    private var conversations: [String: [ChatMessage]] = [:]      // by session id
    private var sessionList: [SessionRow]
    private var cardList: [Card]
    private var statusLines: [String: String] = [:]               // by session id
    private var continuations: [UUID: AsyncStream<EngineEvent>.Continuation] = [:]
    private let clock: @Sendable () -> Int64
    private let acceptedCodePrefix = "moss-pair:"

    /// Everything the client was asked to do, in order: tests read it.
    public private(set) var sent: [(session: String, text: String, clientMessageId: String)] = []
    public private(set) var stopped: [String] = []
    public private(set) var answered: [(card: String, option: String)] = []
    public private(set) var markedRead: [String] = []
    /// When set, the next call that can fail throws it, once.
    public var failNext: Failure?

    public init(scenario: Scenario = .idle, clock: @escaping @Sendable () -> Int64 = { SampleData.now }) {
        self.clock = clock
        botList = SampleData.bots
        summaryList = SampleData.summaries
        sessionList = SampleData.sessions
        cardList = SampleData.cards
        for bot in SampleData.bots { conversations[bot.mainSession] = SampleData.conversation(for: bot.id) }
        conversations["s_alpha"] = SampleData.conversation(for: "alpha")
        for s in SampleData.sessions { conversations[s.id] = SampleData.sessionMessages(for: s.id) }
        switch scenario {
        case .idle: paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName)
        case .midTurn:
            paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName)
            statusLines["s_alpha"] = "Alpha is working"
            if let i = botList.firstIndex(where: { $0.id == "alpha" }) { botList[i].state = .thinking }
        case .unpaired: paired = nil
        }
    }

    public var pairedComputer: PairedComputer? { paired }

    private func maybeFail() throws {
        if let f = failNext { failNext = nil; throw f }
    }

    private func emit(_ e: EngineEvent) { for c in continuations.values { c.yield(e) } }

    // MARK: Pairing

    public func beginPairing(code: String) async throws -> PairingProposal {
        try maybeFail()
        guard code.hasPrefix(acceptedCodePrefix) else { throw PairingError.unreadableCode }
        return PairingProposal(pairingId: "pair_1", computer: SampleData.computerName, words: ["maple", "orbit", "velvet", "canyon"])
    }
    public func confirmPairing(_ proposal: PairingProposal) async throws -> PairedComputer {
        try maybeFail()
        let p = PairedComputer(name: proposal.computer, deviceName: SampleData.phoneName)
        paired = p
        return p
    }
    public func cancelPairing(_ proposal: PairingProposal) async {}

    // MARK: Bots

    public func bots() async throws -> [Bot] { try maybeFail(); return botList }
    public func botSummaries() async throws -> [BotSummary] { try maybeFail(); return summaryList }
    public func conversation(bot: String, before: Int64?, limit: Int) async throws -> MessagePage {
        try maybeFail()
        guard let b = botList.first(where: { $0.id == bot }) else { throw Failure("no such bot") }
        return page(b.mainSession, before: before, limit: limit)
    }
    public func markRead(bot: String) async throws {
        markedRead.append(bot)
        if let i = summaryList.firstIndex(where: { $0.id == bot }) {
            summaryList[i].unread = false
            emit(.botSummaryChanged(summaryList[i]))
        }
    }

    // MARK: Sessions

    public func sessions() async throws -> [SessionRow] { try maybeFail(); return sessionList }
    public func history(session: String, before: Int64?, limit: Int) async throws -> MessagePage {
        try maybeFail()
        return page(session, before: before, limit: limit)
    }

    private func page(_ session: String, before: Int64?, limit: Int) -> MessagePage {
        var all = conversations[session] ?? []
        if let before { all = all.filter { $0.at < before } }
        let hasMore = all.count > limit
        return MessagePage(session: session, messages: Array(all.suffix(limit)), hasMore: hasMore)
    }

    // MARK: Sending

    public func send(session: String, text: String, clientMessageId: String) async throws {
        try maybeFail()
        // A resend with the same client id is not a second message.
        if sent.contains(where: { $0.clientMessageId == clientMessageId }) { return }
        sent.append((session, text, clientMessageId))
        let m = ChatMessage(id: clientMessageId, role: .user, text: text, at: clock())
        conversations[session, default: []].append(m)
        emit(.message(subject: session, m))
        let isBot = botList.contains { $0.mainSession == session }
        let line = isBot ? "\(botList.first { $0.mainSession == session }?.name ?? "Bot") is thinking" : "Working"
        statusLines[session] = line
        emit(.statusLine(subject: session, line: line))
    }

    public func stop(session: String) async throws {
        try maybeFail()
        stopped.append(session)
        statusLines[session] = nil
        let m = ChatMessage(id: "stop-\(stopped.count)", role: .note, text: "Interrupted", at: clock())
        conversations[session, default: []].append(m)
        emit(.message(subject: session, m))
        emit(.statusLine(subject: session, line: nil))
    }

    /// The status line a subject shows now, as the first `events()` snapshot would tell it.
    public func statusLine(for session: String) -> String? { statusLines[session] }

    /// Ends the running turn of a session with a reply.
    public func finishTurn(session: String, reply: String = "Understood. I will take care of it.") {
        statusLines[session] = nil
        let isBot = botList.contains { $0.mainSession == session }
        let m = ChatMessage(id: "reply-\(conversations[session]?.count ?? 0)", role: isBot ? .bot : .agent, text: reply, at: clock())
        conversations[session, default: []].append(m)
        emit(.message(subject: session, m))
        emit(.statusLine(subject: session, line: nil))
    }

    // MARK: Cards

    public func cards() async throws -> [Card] { try maybeFail(); return cardList }
    public func answer(card: Card, option: CardOption) async throws {
        try maybeFail()
        guard cardList.contains(where: { $0.id == card.id }) else { throw Failure("that card is no longer waiting") }
        answered.append((card.id, option.id))
        cardList.removeAll { $0.id == card.id }
        emit(.cardResolved(id: card.id))
    }

    /// Raises a card as if the computer had just asked.
    public func raise(_ card: Card) {
        cardList.append(card)
        emit(.cardRequested(card))
    }

    // MARK: Events

    public func events() async -> AsyncStream<EngineEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<EngineEvent>.makeStream()
        continuation.onTermination = { [weak self] _ in
            Task { await self?.drop(id) }
        }
        add(id, continuation)
        return stream
    }
    private func add(_ id: UUID, _ c: AsyncStream<EngineEvent>.Continuation) {
        continuations[id] = c
        // What is true right now, so a subscriber that joins mid-turn still shows it.
        for (subject, line) in statusLines { c.yield(.statusLine(subject: subject, line: line)) }
    }
    private func drop(_ id: UUID) { continuations[id] = nil }
}
