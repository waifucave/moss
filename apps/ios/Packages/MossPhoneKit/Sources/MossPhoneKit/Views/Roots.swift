import SwiftUI

/// What the process was asked to show, for pictures and tests of the apps (`-screen`, `-scenario`). Real runs pass none.
public struct AppLaunch {
    public enum Screen: String { case home, conversation, cards, pairScan, pairWords, sessions, session, settings, newSession }
    public var screen: Screen = .home
    public var scenario: FakeEngineClient.Scenario = .idle
    public init(screen: Screen = .home, scenario: FakeEngineClient.Scenario = .idle) { self.screen = screen; self.scenario = scenario }

    public static func fromProcess(_ args: [String] = ProcessInfo.processInfo.arguments) -> AppLaunch {
        var l = AppLaunch()
        if let i = args.firstIndex(of: "-screen"), i + 1 < args.count, let s = Screen(rawValue: args[i + 1]) { l.screen = s }
        if let i = args.firstIndex(of: "-scenario"), i + 1 < args.count {
            switch args[i + 1] {
            case "midTurn": l.scenario = .midTurn
            case "unpaired": l.scenario = .unpaired
            case "unreachable": l.scenario = .unreachable
            case "empty": l.scenario = .empty
            case "loading": l.scenario = .loading
            case "cardStates": l.scenario = .cardStates
            case "sendFails": l.scenario = .sendFails
            default: break
            }
        }
        l.startNew = args.contains("-startNew")
        l.confirmUnpair = args.contains("-confirmUnpair")
        if l.screen == .pairScan || l.screen == .pairWords { l.scenario = .unpaired }
        return l
    }
    /// Opens the new-session sheet, fills nothing, and starts with the preselected choices (for the picture of the result).
    public var startNew = false
    public var confirmUnpair = false
    var sendsOnOpen: String? { scenario == .sendFails ? "Can you also look at the invoice?" : nil }
}

/// The MOSS app: the bots, and what needs the person. The apps hold only this view; the rest is shared.
public struct MossRoot: View {
    @State private var client: FakeEngineClient
    @State private var bots: BotsListModel
    @State private var cards: CardsModel
    @State private var pairing: PairingModel
    @State private var settings: SettingsModel
    @State private var paired: PairedComputer?
    @State private var showSettings: Bool
    @State private var path: [Bot] = []
    @State private var tab = 0
    private let launch: AppLaunch

    public init(launch: AppLaunch = .fromProcess()) {
        self.launch = launch
        let c = FakeEngineClient(scenario: launch.scenario)
        _client = State(initialValue: c)
        _bots = State(initialValue: BotsListModel(client: c, store: MemoryPinStore(SampleData.pinned)))
        _cards = State(initialValue: CardsModel(client: c, app: .moss, now: { SampleData.now }))
        _pairing = State(initialValue: PairingModel(client: c))
        let st = SettingsModel(client: c, version: SettingsModel.bundleVersion()); st.confirmingUnpair = launch.confirmUnpair
        _settings = State(initialValue: st)
        _paired = State(initialValue: launch.scenario == .unpaired ? nil : PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName))
        _tab = State(initialValue: launch.screen == .cards ? 1 : 0)
        _showSettings = State(initialValue: launch.screen == .settings)
        if launch.screen == .conversation, let alpha = SampleData.bots.first(where: { $0.id == "alpha" }) { _path = State(initialValue: [alpha]) }
    }

    public var body: some View {
        Group {
            if let paired {
                TabView(selection: $tab) {
                    Tab("Bots", systemImage: "face.smiling", value: 0) {
                        NavigationStack(path: $path) {
                            BotsScreen(model: bots, computer: paired.name, onSettings: { showSettings = true })
                                .navigationDestination(for: Bot.self) { bot in
                                    BotConversationView(bot: bot, client: client, cards: cards, autoSend: launch.sendsOnOpen)
                                }
                        }
                    }
                    Tab("Needs you", systemImage: "bell", value: 1) {
                        NavigationStack { CardsScreen(model: cards, who: { c in c.bot.flatMap { id in SampleData.bots.first { $0.id == id }?.name } ?? "A bot" }) }
                    }
                    .badge(cards.waitingCount)
                }
                .sheet(isPresented: $showSettings) {
                    SettingsScreen(model: settings, appName: "MOSS", onUnpaired: { showSettings = false; self.paired = nil; pairing.retry() }, onDone: { showSettings = false })
                }
            } else {
                PairingScreen(model: pairing, appName: "MOSS", simulatedCamera: true) { paired = $0 }
            }
        }
        .tint(Theme.accent)
        .environment(\.nowMs, SampleData.now)
        .task { await cards.load(); cards.start() }
        .task(id: launch.screen) {
            if launch.screen == .pairWords { await pairing.scanned("moss-pair:sample") }
        }
    }
}

/// The MOSS Code app: the sessions with coding agents, and what needs the person.
public struct MossCodeRoot: View {
    @State private var client: FakeEngineClient
    @State private var sessions: SessionsListModel
    @State private var cards: CardsModel
    @State private var pairing: PairingModel
    @State private var settings: SettingsModel
    @State private var paired: PairedComputer?
    @State private var showSettings: Bool
    @State private var showNew: Bool
    @State private var newSession: NewSessionModel
    @State private var path: [SessionRow] = []
    @State private var tab = 0
    private let launch: AppLaunch

    public init(launch: AppLaunch = .fromProcess()) {
        self.launch = launch
        let c = FakeEngineClient(scenario: launch.scenario)
        _client = State(initialValue: c)
        _sessions = State(initialValue: SessionsListModel(client: c))
        _cards = State(initialValue: CardsModel(client: c, app: .code, now: { SampleData.now }))
        _pairing = State(initialValue: PairingModel(client: c))
        let st = SettingsModel(client: c, version: SettingsModel.bundleVersion()); st.confirmingUnpair = launch.confirmUnpair
        _settings = State(initialValue: st)
        _newSession = State(initialValue: NewSessionModel(client: c, computer: SampleData.computerName))
        _paired = State(initialValue: launch.scenario == .unpaired ? nil : PairedComputer(name: SampleData.computerName, deviceName: SampleData.phoneName))
        _tab = State(initialValue: launch.screen == .cards ? 1 : 0)
        _showSettings = State(initialValue: launch.screen == .settings)
        _showNew = State(initialValue: launch.screen == .newSession)
        if launch.screen == .session, let s = SampleData.sessions.first(where: { $0.id == "c2" }) { _path = State(initialValue: [s]) }
    }

    public var body: some View {
        Group {
            if let paired {
                TabView(selection: $tab) {
                    Tab("Sessions", systemImage: "terminal", value: 0) {
                        NavigationStack(path: $path) {
                            SessionsScreen(model: sessions, computer: paired.name, onSettings: { showSettings = true }, onNew: { showNew = true })
                                .navigationDestination(for: SessionRow.self) { s in
                                    SessionConversationView(session: s, client: client, cards: cards, autoSend: launch.sendsOnOpen)
                                }
                        }
                    }
                    Tab("Needs you", systemImage: "bell", value: 1) {
                        NavigationStack { CardsScreen(model: cards, who: { c in c.session.flatMap { id in SampleData.sessions.first { $0.id == id }?.title } ?? "A session" }) }
                    }
                    .badge(cards.waitingCount)
                }
                .sheet(isPresented: $showSettings) {
                    SettingsScreen(model: settings, appName: "MOSS Code", onUnpaired: { showSettings = false; self.paired = nil; pairing.retry() }, onDone: { showSettings = false })
                }
                .sheet(isPresented: $showNew) {
                    NewSessionScreen(model: newSession, onStarted: { id in
                        showNew = false
                        Task {
                            await sessions.load()
                            if let row = sessions.sessions.first(where: { $0.id == id }) { tab = 0; path = [row] }
                        }
                    }, onCancel: { showNew = false })
                }
            } else {
                PairingScreen(model: pairing, appName: "MOSS Code", simulatedCamera: true) { paired = $0 }
            }
        }
        .tint(Theme.accent)
        .environment(\.nowMs, SampleData.now)
        .task { await cards.load(); cards.start() }
        .task(id: launch.screen) {
            if launch.screen == .pairWords { await pairing.scanned("moss-pair:sample") }
            if launch.startNew {
                await newSession.load()
                if let id = await newSession.start() { await sessions.load(); if let row = sessions.sessions.first(where: { $0.id == id }) { path = [row] } }
            }
        }
    }
}

struct BotConversationView: View {
    @State private var model: ConversationModel
    let cards: CardsModel
    let bot: Bot
    init(bot: Bot, client: EngineClient, cards: CardsModel, autoSend: String? = nil) {
        self.bot = bot; self.cards = cards
        _model = State(initialValue: ConversationModel(source: .bot(bot), client: client, autoSend: autoSend))
    }
    var body: some View {
        ConversationScreen(model: model, cards: cards)
            .navigationTitle(bot.name)
            .toolbar { ToolbarItem(placement: .principal) { BotTitle(bot: bot) } }
    }
}

struct BotTitle: View {
    let bot: Bot
    var body: some View {
        HStack(spacing: 8) {
            BotFaceView(name: bot.name, face: bot.face, mood: (bot.state ?? .idle).faceMood, size: 30)
            Text(bot.name).font(.headline)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bot.name)
        .accessibilityAddTraits(.isHeader)
    }
}

struct SessionConversationView: View {
    @State private var model: ConversationModel
    let cards: CardsModel
    let session: SessionRow
    init(session: SessionRow, client: EngineClient, cards: CardsModel, autoSend: String? = nil) {
        self.session = session; self.cards = cards
        _model = State(initialValue: ConversationModel(source: .session(session), client: client, autoSend: autoSend))
    }
    var body: some View {
        ConversationScreen(model: model, cards: cards)
            .navigationTitle(session.title ?? "Session")
            .navigationSubtitle([AgentLook.of(session.backend).name, session.model].compactMap { $0 }.joined(separator: " · "))
            .toolbar { ToolbarItem(placement: .topBarTrailing) { AgentMarkView(backend: session.backend, size: 28) } }
    }
}
