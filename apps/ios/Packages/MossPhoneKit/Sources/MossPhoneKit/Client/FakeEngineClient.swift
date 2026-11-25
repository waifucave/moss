import Foundation

/// The engine client the screens run on until lane PC's core exists: in memory, serving `SampleData`, and
/// deterministic. It sleeps never; a turn it starts is finished by `finishTurn` (the apps call it after a short
/// delay, tests call it directly).
public actor FakeEngineClient: EngineClient {
    public enum Scenario: Sendable {
        /// Paired, everything quiet.
        case idle
        /// Paired, and nothing waits for the person (no cards): the plain list.
        case quiet
        /// Paired, and Alpha's turn is running (status line, Stop showing).
        case midTurn
        /// Not paired yet.
        case unpaired
        /// Paired, but the computer cannot be reached: every call fails.
        case unreachable
        /// Paired, and nothing exists yet: no bots, sessions or cards.
        case empty
        /// Paired, and every call waits (the loading state).
        case loading
        /// Paired; one card has expired and another was answered on another device.
        case cardStates
        /// Paired; sending a message fails.
        case sendFails
        /// This phone has already made the day's 5 bots: the next `createBot` is refused.
        case botLimit
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
    private var scenario: Scenario
    private var connection: ConnectionState = .connected
    private var otherAppInstalled = true
    private var answeredElsewhereIDs: Set<String> = []
    private let acceptedCodePrefix = "moss-pair:"

    /// Everything the client was asked to do, in order: tests read it.
    public private(set) var sent: [(session: String, text: String, clientMessageId: String)] = []
    public private(set) var stopped: [String] = []
    public private(set) var answered: [(card: String, option: String)] = []
    public private(set) var markedRead: [String] = []
    /// When set, the next call that can fail throws it, once.
    public private(set) var failNext: Failure?
    public func setFail(_ f: Failure?) { failNext = f }

    public init(scenario: Scenario = .idle, clock: @escaping @Sendable () -> Int64 = { SampleData.now }) {
        self.clock = clock
        self.scenario = scenario
        botList = SampleData.bots
        summaryList = SampleData.summaries
        sessionList = SampleData.sessions
        cardList = SampleData.cards
        for bot in SampleData.bots { conversations[bot.mainSession] = SampleData.conversation(for: bot.id) }
        conversations["s_alpha"] = SampleData.conversation(for: "alpha")
        for s in SampleData.sessions { conversations[s.id] = SampleData.sessionMessages(for: s.id) }
        switch scenario {
        case .quiet:
            paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName)
            cardList = []
        case .idle: paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName)
        case .midTurn:
            paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName)
            statusLines["s_alpha"] = "Alpha is working"
            statusLines["c1"] = "Working"
            if let i = botList.firstIndex(where: { $0.id == "alpha" }) { botList[i].state = .thinking }
        case .unpaired: paired = nil
        case .unreachable:
            paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName, lastSeen: SampleData.now - 2 * 3600 * 1000)
            connection = .unreachable(since: SampleData.now - 2 * 3600 * 1000)
        case .empty:
            paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName, lastSeen: SampleData.now - 30_000)
            botList = []; summaryList = []; sessionList = []; cardList = []
        case .loading: paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName)
        case .cardStates:
            paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName)
            // The first card ran out of time; the third one is answered on another device.
            if let i = cardList.firstIndex(where: { $0.id == "card_0a1b2c3d" }) { cardList[i].expiresAt = SampleData.now - 60_000 }
            answeredElsewhereIDs = ["card_55aa66bb"]
        case .botLimit:
            paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName)
            botsMadeToday = Self.botsPerDay
        case .sendFails: paired = PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName)
        }
        if paired != nil, scenario != .unreachable, scenario != .empty { paired?.lastSeen = SampleData.now - 20_000 }
    }

    public var pairedComputer: PairedComputer? { paired }

    private func maybeFail() async throws {
        if scenario == .loading { try await Task.sleep(for: .seconds(3600)) }
        if case .unreachable = connection { throw Failure("unreachable") }
        if let f = failNext { failNext = nil; throw f }
    }

    private var muted = false
    /// While muted the fake changes its data without telling the stream: the gap a reconnect has to close by listing again.
    public func setMuted(_ m: Bool) { muted = m }
    private func emit(_ e: EngineEvent) { if muted, case .connection = e {} else if muted { return }; for c in continuations.values { c.yield(e) } }

    // MARK: Pairing

    public func beginPairing(code: String) async throws -> PairingProposal {
        try await maybeFail()
        guard code.hasPrefix(acceptedCodePrefix) else { throw PairingError.unreadableCode }
        return PairingProposal(pairingId: "pair_1", computer: SampleData.computerName, words: ["maple", "orbit", "velvet", "canyon"])
    }
    public func confirmPairing(_ proposal: PairingProposal) async throws -> PairedComputer {
        try await maybeFail()
        let p = PairedComputer(name: proposal.computer, deviceName: SampleData.phoneName)
        paired = p
        return p
    }
    public func cancelPairing(_ proposal: PairingProposal) async {}

    // MARK: Bots

    public func bots() async throws -> [Bot] { try await maybeFail(); return botList }
    public func botSummaries() async throws -> [BotSummary] { try await maybeFail(); return summaryList }
    public func conversation(bot: String, before: Int64?, limit: Int) async throws -> MessagePage {
        try await maybeFail()
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

    public func sessions() async throws -> [SessionRow] { try await maybeFail(); return sessionList }
    public func history(session: String, before: Int64?, limit: Int) async throws -> MessagePage {
        try await maybeFail()
        return page(session, before: before, limit: limit)
    }

    private func page(_ session: String, before: Int64?, limit: Int) -> MessagePage {
        var all = conversations[session] ?? []
        if let before { all = all.filter { $0.at < before } }
        let hasMore = all.count > limit
        return MessagePage(session: session, messages: Array(all.suffix(limit)), hasMore: hasMore)
    }

    // MARK: Sending

    public func send(session: String, text: String, clientMessageId: String, images: [String], files: [String]) async throws {
        try await maybeFail()
        if scenario == .sendFails { throw Failure("send failed") }
        // A resend with the same client id is not a second message.
        if sent.contains(where: { $0.clientMessageId == clientMessageId }) { return }
        sent.append((session, text, clientMessageId))
        filesThisMessage[session] = nil
        let m = ChatMessage(id: clientMessageId, role: .user, text: text, at: clock())
        conversations[session, default: []].append(m)
        emit(.message(subject: session, m))
        let isBot = botList.contains { $0.mainSession == session }
        let line = isBot ? "\(botList.first { $0.mainSession == session }?.name ?? "Bot") is thinking" : "Working"
        statusLines[session] = line
        emit(.statusLine(subject: session, line: line))
    }

    // MARK: Composer

    public private(set) var efforts: [String: String] = [:]
    public private(set) var models: [String: String] = [:]
    public private(set) var staged: [String] = []
    public private(set) var commandsRun: [String] = []
    public private(set) var questionsAnswered: [(session: String, answers: [String: String])] = []
    private var answeredQuestions: Set<String> = []

    public func composerOffers(session: String, kind: ConversationKind) async throws -> ComposerOffers {
        try await maybeFail()
        switch kind {
        case .bot:
            // A bot gets no model or effort row: the engine's offers for a bot carry neither.
            return ComposerOffers(pictures: true, commands: [PluginCommand(id: "summary.daily", title: "Daily summary")],
                                  files: true, fileLimit: Self.fileLimit, maxFiles: StagingLimits.maxFilesPerMessage)
        case .codingSession:
            let row = sessionList.first { $0.id == session }
            let backend = row?.backend ?? "claude-code"
            let options = SampleData.options(for: backend)
            let choices = options.models.map { ModelChoice(id: $0.id, name: $0.name, efforts: $0.efforts) }
            let current = models[session] ?? row?.model ?? choices.first?.id
            let levels = choices.first { $0.id == current }?.efforts ?? choices.first?.efforts ?? []
            return ComposerOffers(pictures: true, commands: [PluginCommand(id: "tests.run", title: "Run the tests"), PluginCommand(id: "review.diff", title: "Review the diff")],
                                  efforts: levels, effort: efforts[session] ?? levels.first, models: choices, model: current, files: true, fileLimit: Self.fileLimit, maxFiles: StagingLimits.maxFilesPerMessage, fileKeptDays: 14)
        }
    }
    public func setModel(session: String, model: String?, effort: String?) async throws {
        try await maybeFail()
        if let model { models[session] = model }
        if let effort { efforts[session] = effort }
    }
    /// The size of every chunk this fake received, in order: a picture or a file crosses the link in `StagingLimits.chunkSize` pieces.
    public private(set) var chunksReceived: [Int] = []
    private var filesThisMessage: [String: Int] = [:]
    public func stageImage(session: String, data: Data) async throws -> String {
        try await maybeFail()
        chunksReceived += StagingLimits.chunks(of: data).map(\.count)
        let path = "staged/\(session)/image-\(staged.count + 1).png"
        staged.append(path); return path
    }
    public static let fileLimit = StagingLimits.maxFileBytes
    public private(set) var stagedFiles: [String] = []
    public func stageFile(session: String, name: String, data: Data) async throws -> StagedFile {
        try await maybeFail()
        if Int64(data.count) > Self.fileLimit { throw FileTooLarge(limit: Self.fileLimit) }
        if filesThisMessage[session, default: 0] >= StagingLimits.maxFilesPerMessage { throw TooManyFiles(limit: StagingLimits.maxFilesPerMessage) }
        filesThisMessage[session, default: 0] += 1
        chunksReceived += StagingLimits.chunks(of: data).map(\.count)
        let path = "staged/\(session)/\(name)"
        stagedFiles.append(path)
        return StagedFile(path: path, name: name, size: Int64(data.count))
    }
    public private(set) var botsCreated: [(name: String, model: String?)] = []
    public func newBotOptions() async throws -> NewBotOptions {
        try await maybeFail()
        let models = SampleData.options(for: "moss-code").models.map { ModelChoice(id: $0.id, name: $0.name, efforts: $0.efforts) }
        return NewBotOptions(models: models, defaultModel: models.first?.id)
    }
    /// How many bots this phone has made today; the engine allows 5 a day per device and says so in its own words.
    public private(set) var botsMadeToday = 0
    public static let botsPerDay = 5
    public func createBot(name: String, model: String?) async throws -> Bot {
        try await maybeFail()
        if botsMadeToday >= Self.botsPerDay {
            throw BotCreateRefused(message: "This phone has made \(Self.botsPerDay) bots today, the most a phone may make in a day. Try again tomorrow, or make it on \(SampleData.computerName).")
        }
        botsMadeToday += 1
        let id = "bot_" + String(name.lowercased().filter { $0.isLetter || $0.isNumber }.prefix(12)) + "\(botsCreated.count)"
        let bot = Bot(id: id, name: name, model: model, state: .idle, computer: SampleData.computerName, mainSession: "s_" + id)
        botsCreated.append((name, model))
        botList.append(bot)
        let hello = ChatMessage(id: "\(id)-1", role: .bot, text: "Hello, I am \(name). What would you like to do?", at: clock())
        conversations[bot.mainSession] = [hello]
        let summary = BotSummary(id: id, last: .init(text: hello.text, from: .bot, at: hello.at), unread: false)
        summaryList.append(summary)
        emit(.botChanged(bot)); emit(.botSummaryChanged(summary))
        return bot
    }
    public func runCommand(session: String, command: String) async throws { try await maybeFail(); commandsRun.append(command) }
    public func pendingQuestion(session: String) async throws -> AskQuestion? {
        try await maybeFail()
        guard let q = SampleData.questions[session], !answeredQuestions.contains(q.callId) else { return nil }
        return q
    }
    public func answerQuestion(session: String, question: AskQuestion, answers: [String: String]) async throws {
        try await maybeFail()
        answeredQuestions.insert(question.callId)
        questionsAnswered.append((session, answers))
    }

    public func stop(session: String) async throws {
        try await maybeFail()
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

    /// The cards this client handed out, by id: the engine answers only from the card the app drew, never from an id alone.
    private var delivered: [String: Card] = [:]
    public func cards() async throws -> [Card] {
        try await maybeFail()
        for c in cardList { delivered[c.id] = c }
        return cardList
    }
    public func answer(card: Card, option: CardOption) async throws {
        try await maybeFail()
        guard delivered[card.id] == card, card.options.contains(option) else { throw Failure("that is not a card this client delivered") }
        if answeredElsewhereIDs.contains(card.id) { cardList.removeAll { $0.id == card.id }; throw CardAnswerError.answeredElsewhere }
        if card.expiresAt <= clock() { throw CardAnswerError.expired }
        guard cardList.contains(where: { $0.id == card.id }) else { throw CardAnswerError.answeredElsewhere }
        answered.append((card.id, option.id))
        cardList.removeAll { $0.id == card.id }
        emit(.cardResolved(id: card.id))
    }

    /// Raises a card as if the computer had just asked.
    public func raise(_ card: Card) {
        cardList.append(card)
        delivered[card.id] = card
        emit(.cardRequested(card))
    }

    public func shows(_ card: Card, in app: PhoneApp) async -> Bool {
        guard otherAppInstalled else { return true }
        return (card.bot != nil) == (app == .moss)
    }
    /// Whether the other phone app is on this phone; when it is not, each app shows every pending card.
    public func setOtherAppInstalled(_ installed: Bool) { otherAppInstalled = installed }

    // MARK: Starting a session

    public func backends() async throws -> [AgentBackend] {
        try await maybeFail()
        return SampleData.backends
    }
    public func startOptions(backend: String) async throws -> BackendOptions {
        try await maybeFail()
        return SampleData.options(for: backend)
    }
    public func recentStart() async throws -> RecentStart { try await maybeFail(); return recent }
    private var recent = SampleData.recentStart
    public private(set) var started: [StartRequest] = []
    public func startSession(_ request: StartRequest) async throws -> String {
        try await maybeFail()
        let root = request.root.trimmingCharacters(in: .whitespaces)
        if root.isEmpty || root.contains("..") || root.hasPrefix("home/.moss") || root == ".moss" { throw StartError.folderRefused }
        started.append(request)
        let id = "c\(100 + started.count)"
        let row = SessionRow(id: id, computer: request.computer, title: "New session", status: .starting, startedAt: clock(), updatedAt: clock(),
                             backend: request.backend, model: request.model, root: root)
        sessionList.append(row)
        conversations[id] = []
        recent.last = .init(backend: request.backend, model: request.model, effort: request.effort)
        recent.byBackend.removeAll { $0.backend == request.backend }
        recent.byBackend.insert(recent.last!, at: 0)
        recent.roots.removeAll { $0 == root }
        recent.roots.insert(root, at: 0)
        emit(.sessionChanged(row))
        return id
    }

    // MARK: Link

    public func connectionState() async -> ConnectionState { connection }
    public func setBotsMadeToday(_ n: Int) { botsMadeToday = n }
    public func setConnection(_ c: ConnectionState) { connection = c; emit(.connection(c)) }
    public private(set) var unpairCount = 0
    public func unpair() async { unpairCount += 1; paired = nil }

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
        if case .unreachable = connection { c.yield(.connection(connection)) }
        for id in answeredElsewhereIDs { c.yield(.cardResolved(id: id)) }
    }
    private func drop(_ id: UUID) { continuations[id] = nil }
}
