import Foundation
import MossEngineClient
import MossPhoneCore
import MossPhoneKit

// The core's Swift binding behind `CoreLink`: one to one, no logic of its own. Names both modules define
// (`PairedComputer`, `PhoneApp`, `CardView`, `StagedFile`, `LinkState`) are written with their module.

/// The core's items in the Keychain, as the core's `SecretStorage`.
final class KeychainSecretStorage: SecretStorage, @unchecked Sendable {
    let items: KeychainItems
    init(_ items: KeychainItems) { self.items = items }
    private func mapped<T>(_ f: () throws -> T) throws -> T {
        do { return try f() } catch KeychainItems.Failure.notAvailable(let r) {
            throw StorageError.NotAvailable(reason: r)
        } catch KeychainItems.Failure.failed(let r) {
            throw StorageError.Failed(reason: r)
        }
    }
    func load(name: String) throws -> Data? { try mapped { try items.load(name) } }
    func save(name: String, value: Data) throws { try mapped { try items.save(name, value) } }
    func delete(name: String) throws { try mapped { try items.delete(name) } }
}

func linkError(_ e: Error) -> Error {
    guard let c = e as? CoreError else { return e }
    switch c {
    case .Storage(let r): return r.contains("not available now") ? LinkError.storageNotAvailable(r) : LinkError.storage(r)
    case .Invalid(let r): return LinkError.invalid(r)
    case .Refused(let r): return LinkError.refused(r)
    case .Offline(let r): return LinkError.offline(r)
    case .Timeout(let r): return LinkError.timeout(r)
    case .Rpc(let code, let words, let data): return LinkError.rpc(code: code, words: words, dataJSON: data)
    case .Revoked(let r): return LinkError.revoked(r)
    case .Closed(let r): return LinkError.closed(r)
    case .TamperedCard(let r): return LinkError.tamperedCard(r)
    default: return LinkError.protocolError(String(describing: c))
    }
}
func mapped<T>(_ f: () async throws -> T) async throws -> T {
    do { return try await f() } catch { throw linkError(error) }
}

extension MossPhoneCore.PairedComputer {
    var link: LinkComputer { LinkComputer(id: id, name: name, app: app == .moss ? .moss : .code, pairedAt: pairedAt) }
}

final class CoreLinkImpl: CoreLink, @unchecked Sendable {
    let core: PhoneCore
    init(_ core: PhoneCore) { self.core = core }
    var deviceName: String { core.identity().name }
    func pairedComputers() throws -> [LinkComputer] {
        do { return try core.pairedComputers().map(\.link) } catch { throw linkError(error) }
    }
    func beginPairing(qr: String, app: LinkApp) async throws -> PairingLink {
        try await mapped { PairingImpl(try await core.beginPairing(qr: qr, app: app == .moss ? .moss : .code)) }
    }
    func connect(computerId: String, clientName: String, areas: [String]) async throws -> ConnectionLink {
        try await mapped { ConnectionImpl(try await core.connect(computerId: computerId, options: ConnectOptions(clientName: clientName, areas: areas, callTimeoutMs: 30_000))) }
    }
    func forgetComputer(_ id: String) throws {
        do { try core.forgetComputer(id: id) } catch { throw linkError(error) }
    }
    func shutdown() async { await core.shutdown() }
}

final class PairingImpl: PairingLink, @unchecked Sendable {
    let p: Pairing
    init(_ p: Pairing) { self.p = p }
    var words: [String] { p.words() }
    var computerName: String { p.computerName() }
    func confirm() async throws -> LinkComputer { try await mapped { try await p.confirm().link } }
    func reject() async { await p.reject() }
}

// MARK: The core's records onto the screens' models (field for field; an unknown kind keeps its own word or a neutral one)

enum Records {
    static func bot(_ b: MossPhoneCore.Bot) -> MossPhoneKit.Bot {
        let state: MossPhoneKit.BotState? = b.state.map {
            switch $0 {
            case .idle: return .idle
            case .thinking: return .thinking
            case .asleep: return .asleep
            case .paused: return .paused
            case .other: return .idle
            }
        }
        let face = b.face.map { BotFaceSpec(shape: $0.shape, color: $0.color, eyes: $0.eyes, temper: $0.temper) }
        return MossPhoneKit.Bot(id: b.id, name: b.name, model: b.model, effort: b.effort, face: face, state: state, computer: b.computer, mainSession: b.mainSession)
    }
    static func summary(_ s: MossPhoneCore.BotSummary) -> MossPhoneKit.BotSummary {
        let last = s.last.map { l -> MossPhoneKit.BotSummary.Last in
            let from: MossPhoneKit.BotSummary.Last.From
            switch l.from { case .user: from = .user; case .bot: from = .bot; case .note, .other: from = .note }
            return .init(text: l.text, from: from, at: l.at)
        }
        return MossPhoneKit.BotSummary(id: s.id, last: last, unread: s.unread)
    }
    static func session(_ r: MossPhoneCore.SessionRow) -> MossPhoneKit.SessionRow {
        let kind: String
        switch r.kind { case .bot: kind = "bot"; case .sideThread: kind = "side-thread"; case .agent: kind = "agent"; case .coding: kind = "coding"; case .other(let v): kind = v }
        let status: MossPhoneKit.SessionStatus
        switch r.status {
        case .starting: status = .starting
        case .ready: status = .ready
        case .prompting: status = .prompting
        case .cancelling: status = .cancelling
        case .idle, .other: status = .idle
        case .stopped: status = .stopped
        case .failed: status = .failed
        }
        return MossPhoneKit.SessionRow(id: r.id, kind: kind, bot: r.bot, parent: r.parent, computer: r.computer, title: r.title, status: status,
                                       startedAt: r.startedAt, updatedAt: r.updatedAt, backend: r.backend, model: r.model, root: r.root, branch: r.branch,
                                       changes: r.changes.map { Int($0) }, needsYou: r.needsYou.map { MossPhoneKit.NeedsYou(cards: Int($0.cards), questions: Int($0.questions)) },
                                       waiting: r.waiting.map { SessionWaiting(tasks: Int($0.tasks), children: Int($0.children)) }, archived: r.archived)
    }
    /// A log item as the conversation draws it: its id is the session and its place (the same in a page and live).
    static func item(_ i: MossPhoneCore.SessionItem) -> LinkItem {
        func m(_ role: MessageRole, _ text: String) -> LinkItem {
            text.isEmpty ? .other : .message(ChatMessage(id: i.id, role: role, text: text, at: i.at))
        }
        switch i.kind {
        case .user(let text, _, let answers):
            guard !text.isEmpty else { return .other }
            return .message(ChatMessage(id: i.id, role: .user, text: text, at: i.at, answersQuestion: answers))
        case .assistant(let text): return m(.agent, text)
        case .fromBot(_, let text), .fromSession(let text), .fromPlugin(let text), .agent(let text), .routine(_, let text), .note(_, let text), .turnError(let text): return m(.note, text)
        case .turnEnded: return .turnEnded
        case .questionAsked(let q):
            // Where it was asked, as asked: every question of the call.
            guard let first = q.questions.first else { return .other }
            return .message(ChatMessage(id: i.id, role: .question, text: first.question, at: i.at,
                                        question: AskedQuestion(callId: q.callId, parts: q.questions.map {
                                            AskedQuestion.Part(header: $0.header, text: $0.question, options: $0.options.map(\.label))
                                        })))
        case .questionResolved(let callId, _, _, _, _, let end):
            // How it closed is the core's decision (`QuestionEnd`), the same for every app.
            let state: AskedQuestion.State
            switch end {
            case .answered: state = .answered
            case .answeredByPlugin(let plugin): state = .answeredByPlugin(plugin)
            case .skipped: state = .skipped
            case .ended: state = .withdrawn
            case .engineStopped: state = .engineStopped
            case .closed: state = .closed
            }
            return .questionResolved(callId: callId, state: state)
        case .other(let kind): return kind == "turn_started" ? .turnStarted : .other
        }
    }
    static func page(_ p: MossPhoneCore.MessagePage) -> LinkPage { LinkPage(session: p.session, items: p.items.map { ($0.seq, item($0)) }, hasMore: p.hasMore) }
    static func choice(_ m: MossPhoneCore.ModelOption) -> ModelChoice { ModelChoice(id: m.id, name: m.name, efforts: m.efforts) }
    static func offers(_ o: MossPhoneCore.ComposerOffers) -> MossPhoneKit.ComposerOffers {
        MossPhoneKit.ComposerOffers(pictures: o.pictures, commands: o.commands.map { MossPhoneKit.PluginCommand(id: $0.name, title: $0.description) },
                                    efforts: o.efforts, effort: o.effort, models: o.models.map(choice), model: o.model,
                                    files: o.files != nil, fileLimit: o.files?.maxBytes, maxFiles: o.files.map { Int($0.perMessage) })
    }
    /// A card as the screens draw it, typed by the core (every string already through its visible-text rule), or nil
    /// when the core couldn't read all of it: the screen then draws "answer this one on your computer".
    static func card(_ v: MossPhoneCore.CardView) -> MossPhoneKit.Card? {
        let c = v.content()
        guard c.unreadable.isEmpty else { return nil }
        var fields: [String: MossPhoneKit.SealedValue] = [:]
        for f in c.fields {
            switch f.value {
            case .text(let t): fields[f.name] = .text(t)
            case .code(let s, let l): fields[f.name] = .code(s, language: l)
            case .items(let items): fields[f.name] = .list(items)
            case .rows(let rows): fields[f.name] = .rows(rows.map { .init(label: $0.label, value: $0.value) })
            }
        }
        let options = c.options.compactMap { o in
            MossPhoneKit.CardOption.Kind(rawValue: o.kind).map { MossPhoneKit.CardOption(id: o.id, kind: $0, label: o.label, rememberAlways: o.rememberAlways) }
        }
        guard options.count == c.options.count else { return nil }
        return MossPhoneKit.Card(id: v.id(), kind: c.kind, computer: c.computer, session: v.session(), bot: v.bot(), origin: c.origin,
                                 issuedAt: c.issuedAt, expiresAt: c.expiresAt ?? Int64.max, hash: v.hash(), fields: fields, options: options,
                                 children: c.children.isEmpty ? nil : c.children.map { .init(id: $0.id, label: $0.label, checked: $0.checked) })
    }
    static func question(_ q: MossPhoneCore.AskQuestion) -> MossPhoneKit.AskQuestion? {
        // Every question of the call, as the desktop's card draws them: they are answered together.
        guard !q.questions.isEmpty else { return nil }
        return MossPhoneKit.AskQuestion(callId: q.callId, questions: q.questions.map { part in
            .init(header: part.header, text: part.question,
                  options: part.options.map { .init(label: $0.label, detail: $0.description, preview: $0.preview) }, multiSelect: part.multiSelect)
        })
    }
}

final class ConnectionImpl: ConnectionLink, @unchecked Sendable {
    let c: Connection
    init(_ c: Connection) { self.c = c }

    static func shown(_ v: MossPhoneCore.CardView) -> ShownCard {
        ShownCard(id: v.id(), hash: v.hash(), card: Records.card(v), bot: v.bot(), session: v.session(), handle: v)
    }

    func attach(session: String, since: UInt64?) async throws -> UInt64 { try await mapped { try await c.attach(session: session, since: since) } }
    func detach(session: String) async throws { try await mapped { try await c.detach(session: session) } }
    func pendingCardIDs() async throws -> [String] { try await mapped { try await c.pendingCardIds() } }
    func cardOutcome(id: String) async throws -> LinkCardOutcome {
        try await mapped { let o = try await c.cardOutcome(id: id); return LinkCardOutcome(outcome: o.outcome, option: o.option) }
    }

    func nextEvent() async -> LinkEvent? {
        guard let e = await c.nextEvent() else { return nil }
        switch e {
        case .connecting: return .connecting
        case .up: return .up
        case .pendingCards(let cards): return .pendingCards(cards.map(Self.shown))
        case .cardRequested(let card): return .cardRequested(Self.shown(card))
        case .cardResolved(let id, let outcome): return .cardResolved(id: id, outcome: outcome)
        case .botChanged(let bot): return .botChanged(Records.bot(bot))
        case .botSummaryChanged(let summary): return .botSummaryChanged(Records.summary(summary))
        case .botRemoved(let id): return .botRemoved(id: id)
        case .sessionChanged(let session): return .sessionChanged(Records.session(session))
        case .sessionRemoved(let id): return .sessionRemoved(id: id)
        case .sessionEvent(let item): return .sessionItem(session: item.session, seq: item.seq, item: Records.item(item))
        case .tamperedCard: return .tamperedCard
        case .messageDropped: return .messageDropped
        case .notification(let method, let json): return .notification(method: method, paramsJSON: json)
        case .down(let reason): return .down(reason: reason)
        case .unpaired: return .unpaired
        case .revoked: return .revoked
        case .lagged: return .lagged
        case .closed: return .closed
        }
    }

    func fetchCard(_ id: String) async throws -> ShownCard { try await mapped { Self.shown(try await c.fetchCard(id: id)) } }

    func answer(_ card: ShownCard, option: String, children: [String]) async throws -> (accepted: Bool, reason: String?) {
        // The core's own object, exactly as it issued it: the client never makes one.
        guard let view = card.handle as? MossPhoneCore.CardView else { throw LinkError.tamperedCard("not a card the core issued") }
        return try await mapped {
            let r = try await c.answerCard(card: view, option: option, children: children)
            return (r.accepted, r.computersReason)
        }
    }

    func sendMessage(session: String, text: String, clientMessageId: String, images: [String], files: [String]) async throws -> UInt64 {
        try await mapped { try await c.sendMessage(session: session, text: text, clientMessageId: clientMessageId, images: images, files: files) }
    }
    func stageFile(session: String, name: String, data: Data) async throws -> (name: String, path: String) {
        try await mapped { let f = try await c.stageFile(session: session, name: name, data: data); return (f.computersName, f.path) }
    }
    func stageImage(session: String, mediaType: String, data: Data) async throws -> String {
        try await mapped { try await c.stageImage(session: session, mediaType: mediaType, data: data) }
    }

    func bots() async throws -> [MossPhoneKit.Bot] { try await mapped { try await c.bots().map(Records.bot) } }
    func botSummaries() async throws -> [MossPhoneKit.BotSummary] { try await mapped { try await c.botSummaries().map(Records.summary) } }
    func conversation(bot: String, beforeSeq: Int64?, limit: UInt32) async throws -> LinkPage {
        try await mapped { Records.page(try await c.conversation(bot: bot, before: beforeSeq, limit: limit)) }
    }
    func markRead(bot: String, at: Int64) async throws { try await mapped { try await c.markRead(bot: bot, at: at) } }
    func createBot(name: String, model: String?) async throws -> MossPhoneKit.Bot { try await mapped { Records.bot(try await c.createBot(name: name, model: model)) } }
    func sessions() async throws -> [MossPhoneKit.SessionRow] { try await mapped { try await c.sessions().map(Records.session) } }
    func history(session: String, beforeSeq: Int64?, limit: UInt32) async throws -> LinkPage {
        try await mapped { Records.page(try await c.history(session: session, before: beforeSeq, limit: limit)) }
    }
    func stop(session: String) async throws { try await mapped { try await c.stop(session: session) } }
    func setModel(session: String, model: String, effort: String?) async throws { try await mapped { try await c.setModel(session: session, model: model, effort: effort) } }
    func composerOffers(session: String) async throws -> MossPhoneKit.ComposerOffers { try await mapped { Records.offers(try await c.composerOffers(session: session)) } }
    func pendingQuestion(session: String) async throws -> MossPhoneKit.AskQuestion? {
        // The questions open in the session, in the order asked (`session.openQuestions`): the newest waits on the composer.
        try await mapped { try await c.openQuestions(session: session).sorted { $0.seq < $1.seq }.last.flatMap(Records.question) }
    }
    func answerQuestion(session: String, callId: String, answers: [String: String]) async throws {
        try await mapped { try await c.answerQuestion(session: session, callId: callId, answers: answers) }
    }
    func skipQuestion(session: String, callId: String) async throws {
        try await mapped { try await c.skipQuestion(session: session, callId: callId) }
    }
    func backends() async throws -> [MossPhoneKit.AgentBackend] {
        try await mapped { try await c.backends().filter(\.userStartable).map { MossPhoneKit.AgentBackend(id: $0.id, name: $0.name) } }
    }
    func startOptions(backend: String, computer: String?) async throws -> MossPhoneKit.BackendOptions {
        try await mapped {
            let o = try await c.startOptions(backend: backend, computer: computer)
            return MossPhoneKit.BackendOptions(backend: o.backend, known: o.known,
                                               models: o.models.map { MossPhoneKit.ModelOption(id: $0.id, name: $0.name, efforts: $0.efforts, defaultEffort: $0.defaultEffort) },
                                               defaultModel: o.defaultModel, defaultEffort: o.defaultEffort)
        }
    }
    func recentStart() async throws -> MossPhoneKit.RecentStart {
        try await mapped {
            let r = try await c.recentStart()
            let choice = { (x: StartChoice) in MossPhoneKit.RecentStart.Choice(backend: x.backend, model: x.model, effort: x.effort) }
            return MossPhoneKit.RecentStart(last: r.last.map(choice), byBackend: r.byBackend.map(choice), roots: r.roots.map(\.root))
        }
    }
    func startSession(_ r: MossPhoneKit.StartRequest) async throws -> String {
        try await mapped { try await c.startSession(request: MossPhoneCore.StartRequest(backend: r.backend, computer: r.computer, root: r.root, model: r.model, effort: r.effort, prompt: nil)) }
    }
    func models(session: String?) async throws -> NewBotOptions {
        try await mapped {
            let l = try await c.models(session: session)
            return NewBotOptions(models: l.models.filter(\.signedIn).map { ModelChoice(id: $0.id, name: $0.name, efforts: $0.efforts) }, defaultModel: l.defaultModel)
        }
    }
    func runCommand(name: String) async throws { try await mapped { try await c.runCommand(name: name) } }

    func state() -> MossEngineClient.LinkState {
        switch c.state() {
        case .connecting: return .connecting
        case .up: return .up
        case .down: return .down
        case .unpaired: return .unpaired
        case .revoked: return .revoked
        case .closed: return .closed
        }
    }
    func networkChanged() { c.networkChanged() }
    func disconnect() { c.disconnect() }
}

/// The real client of one phone app, over the core and the Keychain.
public enum MossEngine {
    /// The Keychain service the apps keep the core's items under (each app in its own access group).
    public static let service = "com.waifucave.moss.phone"

    /// `relays: false` dials only the addresses the pairing gave (tests on one machine).
    public static func client(app: MossPhoneKit.PhoneApp, service: String = MossEngine.service, deviceName: String? = nil, relays: Bool = true) -> CoreEngineClient {
        let items = KeychainItems(service: service)
        let name = deviceName ?? "iPhone"
        let factory = CoreFactory(
            make: {
                do {
                    return CoreLinkImpl(try PhoneCore(storage: KeychainSecretStorage(items), config: CoreConfig(deviceName: name, holder: .keychain, os: .ios, relay: relays ? .default : .disabled, bindAddr: nil)))
                } catch { throw linkError(error) }
            },
            wipeStore: { try items.deleteAll() },
            // The engine's one rule for a computer's text drawn outside a typed field (a card's sealed text).
            visible: { visibleText(text: $0, name: false) },
            visibleName: { visibleText(text: $0, name: true) }
        )
        return CoreEngineClient(factory: factory, app: app)
    }
}
