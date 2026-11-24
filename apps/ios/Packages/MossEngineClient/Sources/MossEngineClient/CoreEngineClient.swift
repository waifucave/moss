import Foundation
import MossPhoneKit

/// A card answer the client refused before signing anything: the card isn't one the core issued on this connection
/// for exactly what the screen drew, or it was resolved since.
public struct CardNotShown: Error, Equatable, Sendable { public init() {} }

/// The real `EngineClient`: the screens' calls over the phone core's link to the paired computer. One instance per app;
/// each app pairs on its own (MOSS and MOSS Code on one phone are two paired devices). It keeps no key and no secret: the
/// core keeps them in the host's store, and signs card answers and the person's messages itself.
public actor CoreEngineClient: EngineClient {
    private let factory: CoreFactory
    private let app: MossPhoneKit.PhoneApp
    private let clientName: String
    private let now: @Sendable () -> Int64

    private var core: CoreLink?
    private var conn: ConnectionLink?
    private var generation = 0
    private var computer: LinkComputer?
    /// The store couldn't be read (the Keychain before the first unlock): not "unpaired", only "not now".
    private var storeLocked = false
    private var shelf: CardShelf
    private var subscribers: [UUID: AsyncStream<EngineEvent>.Continuation] = [:]
    private var up = false
    private var lastUp: Int64?
    private var pairings: [String: PairingLink] = [:]
    /// Sessions followed live (`session.attach`) and the last event seen in each, re-attached after a reconnect.
    private var attached: [String: UInt64] = [:]
    private var attachOrder: [String] = []
    private static let attachMax = 16
    /// The oldest event of each session's pages read so far: where "earlier" starts (the screens page by time).
    private var oldestSeq: [String: Int64] = [:]
    /// What the status line and the message roles need: which sessions are bots' and their bots' names.
    private var botOfSession: [String: Bot] = [:]
    private var stagedFiles: [String: Int] = [:]

    public init(factory: CoreFactory, app: MossPhoneKit.PhoneApp, clientName: String? = nil,
                now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.factory = factory
        self.app = app
        self.clientName = clientName ?? (app == .moss ? "MOSS on iPhone" : "MOSS Code on iPhone")
        self.now = now
        let visible = factory.visible
        self.shelf = CardShelf(decode: { Doors.card($0, visible: visible) })
    }

    private var linkApp: LinkApp { app == .moss ? .moss : .code }

    // MARK: Core and connection

    private func ensureCore() throws -> CoreLink {
        if let core { return core }
        do {
            let c = try factory.make()
            core = c
            storeLocked = false
            return c
        } catch LinkError.storageNotAvailable(let r) {
            storeLocked = true
            throw LinkError.storageNotAvailable(r)
        }
    }

    /// Connects to this app's paired computer, if there is one and no link is kept yet. Safe to call often.
    public func start() async {
        guard conn == nil else { return }
        guard let core = try? ensureCore(), let c = try? core.pairedComputers().last(where: { $0.app == linkApp }) else { return }
        computer = c
        await connect(core, c)
    }

    private func connect(_ core: CoreLink, _ c: LinkComputer) async {
        guard conn == nil else { return }
        do {
            let link = try await core.connect(computerId: c.id, clientName: clientName, areas: ["approvals", "bots", "sessions", "agents"])
            generation += 1
            conn = link
            let gen = generation
            Task { [weak self] in
                while let e = await link.nextEvent() {
                    guard let self else { return }
                    await self.handle(e, gen: gen)
                }
            }
        } catch {}
    }

    private func link() async throws -> ConnectionLink {
        if conn == nil { await start() }
        guard let conn else { throw LinkError.offline("not paired with a computer") }
        return conn
    }

    /// The OS reported a network change or a wake: dial again now.
    public func networkChanged() { conn?.networkChanged() }

    // MARK: Events

    private func emit(_ e: EngineEvent) { for c in subscribers.values { c.yield(e) } }

    private func handle(_ e: LinkEvent, gen: Int) async {
        guard gen == generation else { return }
        switch e {
        case .up:
            up = true
            lastUp = now()
            emit(.connection(.connected))
            await afterReconnect()
        case .connecting, .down, .unpaired:
            if up { up = false; emit(.connection(.unreachable(since: lastUp))) }
        case .revoked:
            // The computer revoked this phone: nothing is dialled again. What the pairing kept goes; pair again.
            up = false
            emit(.connection(.unreachable(since: lastUp)))
            await forgetEverything()
        case .pendingCards(let list):
            let (cards, gone) = shelf.replacePending(list)
            for id in gone { emit(.cardResolved(id: id)) }
            for c in cards { emit(.cardRequested(c)) }
        case .cardRequested(let s):
            if let c = shelf.issue(s) { emit(.cardRequested(c)) }
        case .cardResolved(let id, _):
            shelf.resolve(id)
            emit(.cardResolved(id: id))
        case .botChanged(let b):
            botOfSession[b.mainSession] = b
            emit(.botChanged(b))
        case .botSummaryChanged(let s):
            emit(.botSummaryChanged(s))
        case .sessionChanged(let r):
            emit(.sessionChanged(r))
        case .sessionItem(let session, let seq, let item):
            sessionItem(item, seq: seq, session: session)
        case .botRemoved, .notification, .tamperedCard, .messageDropped, .lagged, .closed:
            break
        }
    }

    private func sessionItem(_ item: LinkItem, seq: UInt64, session: String) {
        if attached[session] != nil { attached[session] = max(attached[session] ?? 0, seq) }
        let bot = botOfSession[session]
        switch item {
        case .message(let m): emit(.message(subject: session, role(m, botSession: bot != nil)))
        case .turnStarted: emit(.statusLine(subject: session, line: bot.map { "\($0.name) is thinking" } ?? "Working"))
        case .turnEnded: emit(.statusLine(subject: session, line: nil))
        case .question, .other: break
        }
    }

    /// The core types an assistant's words as the agent's: in a bot's conversation they are the bot's.
    private func role(_ m: ChatMessage, botSession: Bool) -> ChatMessage {
        guard botSession, m.role == .agent else { return m }
        var b = m; b.role = .bot; return b
    }

    /// After every connect nothing is carried across the gap (some events may have been missed, and the typed bot and
    /// session events carry no order): the bots, their summaries and the sessions are listed again, and each followed
    /// conversation is followed again from now and its newest page read again (a message already shown has the same id).
    /// The core lists the cards again itself (`PendingCards`).
    private func afterReconnect() async {
        guard let c = conn else { return }
        if let bots = try? await c.bots() { for b in bots { botOfSession[b.mainSession] = b; emit(.botChanged(b)) } }
        if let sums = try? await c.botSummaries() { for s in sums { emit(.botSummaryChanged(s)) } }
        let rows = (try? await c.sessions()) ?? []
        for r in rows { emit(.sessionChanged(r)) }
        for s in attachOrder {
            guard let last = try? await Doors.attach(c, session: s, since: nil) else { continue }
            attached[s] = last
            let bot = botOfSession[s]
            guard let p = try? await (bot != nil ? c.conversation(bot: bot!.id, beforeSeq: nil, limit: 60) : c.history(session: s, beforeSeq: nil, limit: 60)) else { continue }
            for i in p.items { if case .message(let m) = i.item { emit(.message(subject: s, role(m, botSession: bot != nil))) } }
            let running = rows.first { $0.id == s }.map { $0.motion == .running } ?? false
            emit(.statusLine(subject: s, line: running ? (bot.map { "\($0.name) is thinking" } ?? "Working") : nil))
        }
    }

    private func follow(_ c: ConnectionLink, _ session: String) async {
        guard attached[session] == nil else { return }
        guard let last = try? await Doors.attach(c, session: session, since: nil) else { return }
        attached[session] = last
        attachOrder.append(session)
        if attachOrder.count > Self.attachMax {
            let old = attachOrder.removeFirst()
            attached[old] = nil
            await Doors.detach(c, session: old)
        }
    }

    public func events() async -> AsyncStream<EngineEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<EngineEvent>.makeStream()
        continuation.onTermination = { [weak self] _ in Task { await self?.drop(id) } }
        subscribers[id] = continuation
        if conn != nil, !up { continuation.yield(.connection(.unreachable(since: lastUp))) }
        if storeLocked { continuation.yield(.connection(.unreachable(since: nil))) }
        return stream
    }
    private func drop(_ id: UUID) { subscribers[id] = nil }

    // MARK: Pairing

    public var pairedComputer: PairedComputer? {
        get async {
            do {
                let core = try ensureCore()
                guard let c = try core.pairedComputers().last(where: { $0.app == linkApp }) else { return nil }
                computer = c
                if conn == nil { await connect(core, c) }
                return PairedComputer(name: c.name, deviceName: core.deviceName, lastSeen: lastUp)
            } catch LinkError.storageNotAvailable {
                // The store can't be read yet: still paired as far as anyone knows; the screens show "can't reach".
                return PairedComputer(name: computer?.name ?? "your computer", deviceName: "", lastSeen: lastUp)
            } catch {
                return nil
            }
        }
    }

    public func beginPairing(code: String) async throws -> PairingProposal {
        let qr = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard qr.hasPrefix("clover-pair:") else { throw PairingError.unreadableCode }
        do {
            let p = try await ensureCore().beginPairing(qr: qr, app: linkApp)
            let id = UUID().uuidString
            pairings[id] = p
            return PairingProposal(pairingId: id, computer: p.computerName, words: p.words)
        } catch let e as LinkError {
            switch e {
            case .invalid(let r): throw r.localizedCaseInsensitiveContains("expire") ? PairingError.expired : PairingError.unreadableCode
            default: throw PairingError.unreachable
            }
        }
    }

    public func confirmPairing(_ proposal: PairingProposal) async throws -> PairedComputer {
        guard let p = pairings.removeValue(forKey: proposal.pairingId) else { throw PairingError.expired }
        let c: LinkComputer
        do { c = try await p.confirm() } catch let e as LinkError {
            if case .refused = e { throw PairingError.wordsDoNotMatch }
            throw PairingError.unreachable
        }
        let core = try ensureCore()
        // One computer per app: an earlier pairing of this app goes with everything it kept.
        if let old = conn { old.disconnect(); conn = nil; generation += 1; shelf.clear(); attached = [:]; attachOrder = [] }
        for other in (try? core.pairedComputers()) ?? [] where other.app == linkApp && other.id != c.id { try? core.forgetComputer(other.id) }
        computer = c
        await connect(core, c)
        return PairedComputer(name: c.name, deviceName: core.deviceName)
    }

    public func cancelPairing(_ proposal: PairingProposal) async {
        await pairings.removeValue(forKey: proposal.pairingId)?.reject()
    }

    public func unpair() async { await forgetEverything() }

    /// Unpairing leaves nothing of the pairing in the store, the device's own keys included: pairing again makes a new
    /// device. (The computer keeps its record of this phone until it revokes it there.)
    private func forgetEverything() async {
        conn?.disconnect()
        conn = nil
        generation += 1
        up = false
        if let core {
            for c in (try? core.pairedComputers()) ?? [] { try? core.forgetComputer(c.id) }
            await core.shutdown()
        }
        core = nil
        computer = nil
        try? factory.wipeStore()
        shelf.clear()
        attached = [:]; attachOrder = []; oldestSeq = [:]; pairings = [:]
    }

    public func connectionState() async -> ConnectionState {
        if let conn, conn.state() == .up { return .connected }
        return .unreachable(since: lastUp)
    }

    // MARK: Bots and sessions

    public func bots() async throws -> [Bot] {
        let bots = try await link().bots()
        for b in bots { botOfSession[b.mainSession] = b }
        return bots
    }
    public func botSummaries() async throws -> [BotSummary] { try await link().botSummaries() }

    public func conversation(bot: String, before: Int64?, limit: Int) async throws -> MessagePage {
        let c = try await link()
        if botOfSession.values.first(where: { $0.id == bot }) == nil { _ = try? await bots() }
        let main = botOfSession.values.first { $0.id == bot }?.mainSession
        return try await page(c, bot: bot, session: main ?? bot, before: before, limit: limit, botSession: true)
    }

    public func history(session: String, before: Int64?, limit: Int) async throws -> MessagePage {
        try await page(try await link(), bot: nil, session: session, before: before, limit: limit, botSession: botOfSession[session] != nil)
    }

    /// The screens page by time (`before` is the oldest message's time); the engine pages by place, so "earlier" starts at
    /// the oldest event read so far in that session.
    private func page(_ c: ConnectionLink, bot: String?, session: String, before: Int64?, limit: Int, botSession: Bool) async throws -> MessagePage {
        // Followed first, then read: nothing falls between the page and the live events (a repeat has the same id).
        if before == nil { await follow(c, session) }
        let beforeSeq = before == nil ? nil : oldestSeq[session]
        if before != nil, beforeSeq == nil { return MessagePage(session: session, messages: [], hasMore: false) }
        let n = UInt32(max(1, min(limit, 500)))
        let p: LinkPage
        if let bot { p = try await c.conversation(bot: bot, beforeSeq: beforeSeq, limit: n) } else { p = try await c.history(session: session, beforeSeq: beforeSeq, limit: n) }
        let sid = p.session
        if bot != nil, sid != session { await follow(c, sid) }
        if let low = p.items.map(\.seq).min() { oldestSeq[sid] = min(oldestSeq[sid] ?? Int64(low), Int64(low)) }
        let messages: [ChatMessage] = p.items.compactMap { if case .message(let m) = $0.item { return role(m, botSession: botSession) } else { return nil } }
        return MessagePage(session: sid, messages: messages, hasMore: p.hasMore)
    }

    public func markRead(bot: String) async throws { try await link().markRead(bot: bot, at: now()) }

    public func sessions() async throws -> [SessionRow] { try await link().sessions() }

    // MARK: Sending

    public func send(session: String, text: String, clientMessageId: String, images: [String], files: [String]) async throws {
        let c = try await link()
        // The engine takes an attachment only where its token is in the text (`[Image #n]`, `[File #n]`); the core signs
        // the text as sent, tokens included.
        var body = text
        for n in images.indices where !body.contains("[Image #\(n + 1)]") { body += " [Image #\(n + 1)]" }
        for n in files.indices where !body.contains("[File #\(n + 1)]") { body += " [File #\(n + 1)]" }
        // Never retried here: a timeout may have reached the computer. The person's Retry sends it again under the same
        // client id, which the engine takes as the same message.
        _ = try await c.sendMessage(session: session, text: body, clientMessageId: clientMessageId, images: images, files: files)
        stagedFiles[session] = nil
    }

    public func stop(session: String) async throws { try await link().stop(session: session) }

    // MARK: Cards

    /// The pending cards, each as the core issued it on this connection: a card `card.list` names that the shelf
    /// doesn't hold is fetched through the core (which checks it), and one no longer listed leaves the shelf.
    public func cards() async throws -> [Card] {
        let c = try await link()
        let ids = try await Doors.pendingCardIDs(c)
        let listed = Set(ids)
        for held in shelf.order where !listed.contains(held) { shelf.resolve(held) }
        for id in ids where shelf.held[id] == nil {
            if let s = try? await c.fetchCard(id) { _ = shelf.issue(s) }
        }
        return shelf.cards
    }

    public func answer(card: Card, option: CardOption) async throws {
        // Only the core's own issue of exactly the card on screen is signed; nothing is fetched in between.
        guard let shown = shelf.shown(for: card), card.options.contains(option) else { throw CardNotShown() }
        let c = try await link()
        let r: (accepted: Bool, reason: String?)
        do {
            // A plugin OK's checkboxes aren't drawn on the phone yet: none is left checked.
            r = try await c.answer(shown, option: option.id, children: [])
        } catch LinkError.timeout(let r) {
            // A timeout after the answer began going out may have reached the computer: the card stays as it is (its
            // `card_resolved` settles it), and nothing is sent again by itself.
            throw LinkError.timeout(r)
        } catch LinkError.refused {
            shelf.resolve(card.id)
            throw card.expiresAt <= now() ? CardAnswerError.expired : CardAnswerError.answeredElsewhere
        }
        if r.accepted { shelf.resolve(card.id); return }
        shelf.resolve(card.id)
        throw card.expiresAt <= now() ? CardAnswerError.expired : CardAnswerError.answeredElsewhere
    }

    /// A card belongs to the bot or session that raised it: MOSS shows bots' cards, MOSS Code the others', and both show
    /// a card that is neither's (a device or a computer change), the first answer winning (item 91).
    public func shows(_ card: Card, in app: MossPhoneKit.PhoneApp) async -> Bool {
        // Whose it is, as the core read it from the card it issued.
        let issued = shelf.held[card.id]?.shown
        if (issued?.bot ?? card.bot) != nil { return app == .moss }
        if let s = issued?.session ?? card.session { return (botOfSession[s] != nil) == (app == .moss) }
        return true
    }

    // MARK: Starting a session

    public func backends() async throws -> [AgentBackend] { try await link().backends() }
    public func startOptions(backend: String) async throws -> BackendOptions { try await link().startOptions(backend: backend, computer: computer?.name) }
    public func recentStart() async throws -> RecentStart { try await link().recentStart() }
    public func startSession(_ request: StartRequest) async throws -> String {
        var r = request
        // The screens may leave the computer to the client: the one this phone is linked to.
        if r.computer.isEmpty { r.computer = computer?.name ?? "" }
        do { return try await link().startSession(r) } catch LinkError.rpc(let code, let words, let data) {
            if words.localizedCaseInsensitiveContains("not installed") { throw StartError.notInstalled }
            if code == -32602 { throw StartError.folderRefused }
            throw LinkError.rpc(code: code, words: words, dataJSON: data)
        }
    }

    // MARK: Composer

    /// `session.composerOffers`. An engine that doesn't offer it to a phone yet gets what its other doors give: for a
    /// coding session the models it may switch to; no pictures or files (their doors came with it).
    public func composerOffers(session: String, kind: ConversationKind) async throws -> ComposerOffers {
        let c = try await link()
        do { return try await c.composerOffers(session: session) } catch let e as LinkError where e.isNotOffered {
            guard kind == .codingSession else { return ComposerOffers() }
            let models = try await c.models(session: session).models
            let row = try? await c.sessions().first { $0.id == session }
            return ComposerOffers(efforts: models.first { $0.id == row?.model }?.efforts ?? [], models: models, model: row?.model)
        }
    }
    public func setModel(session: String, model: String?, effort: String?) async throws {
        let c = try await link()
        // `session.setModel` always names the model: an effort alone keeps the session's model now.
        var m = model
        if m == nil { m = try await c.sessions().first { $0.id == session }?.model }
        guard let m else { throw NotAvailableYet("session.setModel") }
        try await c.setModel(session: session, model: m, effort: effort)
    }

    /// A picture for the next message (`session.stagePicture`, in chunks, through the core).
    public func stageImage(session: String, data: Data) async throws -> String {
        try await link().stageImage(session: session, mediaType: Self.mediaType(data), data: data)
    }
    static func mediaType(_ d: Data) -> String {
        if d.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if d.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if d.starts(with: [0x47, 0x49, 0x46]) { return "image/gif" }
        if d.count > 12, d[d.startIndex + 8..<d.startIndex + 12] == Data("WEBP".utf8) { return "image/webp" }
        if d.count > 12, d[d.startIndex + 4..<d.startIndex + 8] == Data("ftyp".utf8) { return "image/heic" }
        return "image/jpeg"
    }

    public func stageFile(session: String, name: String, data: Data) async throws -> StagedFile {
        if Int64(data.count) > StagingLimits.maxFileBytes { throw FileTooLarge(limit: StagingLimits.maxFileBytes) }
        if stagedFiles[session, default: 0] >= StagingLimits.maxFilesPerMessage { throw TooManyFiles(limit: StagingLimits.maxFilesPerMessage) }
        let r = try await link().stageFile(session: session, name: name, data: data)
        stagedFiles[session, default: 0] += 1
        return StagedFile(path: r.path, name: r.name, size: Int64(data.count))
    }

    public func newBotOptions() async throws -> NewBotOptions { try await link().models(session: nil) }
    public func createBot(name: String, model: String?) async throws -> Bot {
        do {
            let b = try await link().createBot(name: name, model: model)
            botOfSession[b.mainSession] = b
            return b
        } catch let e as LinkError where e.isNotOffered {
            throw NotAvailableYet("bot.create")
        } catch LinkError.rpc(_, let words, _) {
            // The engine refused (its daily limit for a phone, a name it won't take): shown in its own words, cleaned by the core.
            throw BotCreateRefused(message: words)
        }
    }
    public func runCommand(session: String, command: String) async throws { try await link().runCommand(name: command) }

    public func pendingQuestion(session: String) async throws -> AskQuestion? { try await link().pendingQuestion(session: session) }
    public func answerQuestion(session: String, question: AskQuestion, answers: [String: String]) async throws {
        try await link().answerQuestion(session: session, callId: question.callId, answers: answers)
    }
}
