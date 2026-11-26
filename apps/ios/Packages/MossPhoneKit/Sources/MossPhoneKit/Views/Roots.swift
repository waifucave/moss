import SwiftUI

/// What the process was asked to show, for pictures and tests of the apps (`-screen`, `-scenario`). Real runs pass none.
/// The launch arguments are read in a Debug build only: a Release build ignores every one of them, so there is no debugging door in it.
public struct AppLaunch {
    public enum Screen: String { case home, conversation, cards, pairScan, pairWords, sessions, session, settings, newSession }
    public var screen: Screen = .home
    #if DEBUG
    public var scenario: FakeEngineClient.Scenario = .idle
    public init(screen: Screen = .home, scenario: FakeEngineClient.Scenario = .idle) { self.screen = screen; self.scenario = scenario }
    var unpaired: Bool { scenario == .unpaired }
    #else
    // A Release build has no fake and no scenario: it runs on the engine it was given.
    public init(screen: Screen = .home) { self.screen = screen }
    var unpaired: Bool { false }
    #endif

    public static func fromProcess(_ args: [String] = ProcessInfo.processInfo.arguments) -> AppLaunch {
        #if DEBUG
        var l = AppLaunch()
        if let i = args.firstIndex(of: "-screen"), i + 1 < args.count, let s = Screen(rawValue: args[i + 1]) { l.screen = s }
        if let i = args.firstIndex(of: "-scenario"), i + 1 < args.count {
            switch args[i + 1] {
            case "quiet": l.scenario = .quiet
            case "midTurn": l.scenario = .midTurn
            case "unpaired": l.scenario = .unpaired
            case "unreachable": l.scenario = .unreachable
            case "empty": l.scenario = .empty
            case "loading": l.scenario = .loading
            case "cardStates": l.scenario = .cardStates
            case "sendFails": l.scenario = .sendFails
            case "manyPaths": l.scenario = .manyPaths
            case "longCardChat": l.scenario = .longCardChat
            case "tallCardChat": l.scenario = .tallCardChat
            case "providerConsent": l.scenario = .providerConsent
            case "botLimit": l.scenario = .botLimit
            case "questionSwitch": l.scenario = .questionSwitch
            case "pluginOK": l.scenario = .pluginOK
            default: break
            }
        }
        l.startNew = args.contains("-startNew")
        l.confirmUnpair = args.contains("-confirmUnpair")
        l.scrollTop = args.contains("-scrollTop")
        if let i = args.firstIndex(of: "-open"), i + 1 < args.count { l.openID = args[i + 1] }
        if let i = args.firstIndex(of: "-draft"), i + 1 < args.count { l.composer.draft = args[i + 1] }
        l.newBot = args.contains("-newBot") || args.contains("-newBotTry")
        l.newBotTry = args.contains("-newBotTry")
        l.composer.file = args.contains("-file")
        l.composer.focus = args.contains("-focus"); l.composer.picker = args.contains("-picker")
        if let i = args.firstIndex(of: "-scrollTo"), i + 1 < args.count { l.scrollTo = args[i + 1] }
        if l.screen == .pairScan || l.screen == .pairWords { l.scenario = .unpaired }
        // Any of these asks for a picture or a test: the app then runs on the fake (and the real client never sees one).
        l.explicit = args.contains { ["-screen", "-scenario", "-newBot", "-newBotTry", "-startNew", "-confirmUnpair", "-scrollTop", "-open", "-draft", "-file", "-focus", "-picker", "-scrollTo"].contains($0) }
        return l
        #else
        return AppLaunch()
        #endif
    }
    /// Opens the new-session sheet, fills nothing, and starts with the preselected choices (for the picture of the result).
    public var startNew = false
    public var confirmUnpair = false
    /// Opens conversations at their first message (for the picture of the top).
    public var scrollTop = false
    /// A message id to show at the bottom edge, under the composer (for pictures).
    public var scrollTo: String?
    /// For pictures: which bot or session to open, and what the composer starts with.
    public var openID: String?
    /// For pictures: open the new-bot sheet with a name typed.
    public var newBot = false
    /// Types a name and presses Create, for the picture of a refusal.
    public var newBotTry = false
    public var composer = ComposerPreset()
    /// A picture or a test asked for a screen or a scenario: the app runs on the fake, whatever engine it was given.
    public var explicit = false
    #if DEBUG
    var sendsOnOpen: String? { scenario == .sendFails ? "Can you also look at the invoice?" : nil }
    #else
    var sendsOnOpen: String? { nil }
    #endif
}

/// The fake and its sample data, for pictures and UI tests: compiled into a Debug build only. A Release build has neither,
/// so it can't be switched to canned data and carries no sample conversation.
enum Fake {
    #if DEBUG
    static func client(_ l: AppLaunch) -> any EngineClient { FakeEngineClient(scenario: l.scenario) }
    static var pinned: [String] { SampleData.pinned }
    static var now: Int64 { SampleData.now }
    static var computerName: String { SampleData.computerName }
    static var phoneName: String { SampleData.phoneName }
    static var bots: [Bot] { SampleData.bots }
    static var sessions: [SessionRow] { SampleData.sessions }
    #else
    static func client(_ l: AppLaunch) -> any EngineClient { NoEngineClient() }
    static var pinned: [String] { [] }
    static var now: Int64 { 0 }
    static var computerName: String { "" }
    static var phoneName: String { "" }
    static var bots: [Bot] { [] }
    static var sessions: [SessionRow] { [] }
    #endif
}

/// The MOSS app: the bots, and what needs the person. The apps hold only this view; the rest is shared.
public struct MossRoot: View {
    @State private var client: any EngineClient
    @State private var bots: BotsListModel
    @State private var cards: CardsModel
    @State private var pairing: PairingModel
    @State private var settings: SettingsModel
    @State private var paired: PairedComputer?
    @State private var showSettings: Bool
    @State private var path: [Bot] = []
    @State private var showCards = false
    @State private var showNewBot = false
    @State private var newBot: NewBotModel
    @State private var checked: Bool
    private let launch: AppLaunch
    /// On the real engine (lane IW): what the person runs. Otherwise the fake, for pictures and UI tests.
    private let real: Bool

    /// `engine`: the real client; the fake runs when none is given, or when the launch asks for a screen or a scenario.
    public init(launch given: AppLaunch = .fromProcess(), engine: (any EngineClient)? = nil) {
        // Release: always the engine given (the real client); Debug: the fake when none is given or a picture asks.
        #if DEBUG
        let real = engine != nil && !given.explicit
        #else
        let real = true
        #endif
        self.real = real
        // Launch arguments drive the fake only: on the real client none of them applies (no bot made, no session started,
        // no file staged, no draft typed by anything but the person).
        let launch = real ? AppLaunch() : given
        self.launch = launch
        _checked = State(initialValue: !real)
        let c: any EngineClient = real ? (engine ?? NoEngineClient()) : Fake.client(launch)
        _client = State(initialValue: c)
        _bots = State(initialValue: BotsListModel(client: c, store: real ? DefaultsPinStore() : MemoryPinStore(Fake.pinned)))
        let nb = NewBotModel(client: c)
        #if DEBUG
        if launch.newBotTry { nb.name = "Hazel"; Task { await nb.load(); _ = await nb.create() } }
        #endif
        _newBot = State(initialValue: nb)
        _showNewBot = State(initialValue: launch.newBot)
        _cards = State(initialValue: real ? CardsModel(client: c, app: .moss) : CardsModel(client: c, app: .moss, now: { Fake.now }))
        _pairing = State(initialValue: PairingModel(client: c))
        let st = SettingsModel(client: c, version: SettingsModel.bundleVersion()); st.confirmingUnpair = launch.confirmUnpair
        _settings = State(initialValue: st)
        _paired = State(initialValue: real || launch.unpaired ? nil : PairedComputer(name: Fake.computerName, deviceName: Fake.phoneName))
        _showCards = State(initialValue: launch.screen == .cards)
        _showSettings = State(initialValue: launch.screen == .settings)
        if launch.screen == .conversation, let alpha = Fake.bots.first(where: { $0.id == (launch.openID ?? "alpha") }) { _path = State(initialValue: [alpha]) }
    }

    public var body: some View {
        Group {
            if let paired {
                NavigationStack(path: $path) {
                    BotsScreen(model: bots, cards: cards, computer: paired.name, onSettings: { showSettings = true }, onBell: { showCards = true },
                               onNew: { showNewBot = true }, onOpen: { path.append($0) })
                        .navigationDestination(for: Bot.self) { bot in
                            BotConversationView(bot: bot, client: client, cards: cards, autoSend: launch.sendsOnOpen)
                        }
                }
                // A sheet over the stack covers its cards (the Needs You sheet's own cards are not under it).
                .environment(\.cardsCovered, showSettings || showCards || showNewBot)
                .sheet(isPresented: $showSettings) {
                    SettingsScreen(model: settings, appName: "MOSS", onUnpaired: { showSettings = false; self.paired = nil; pairing.retry() }, onDone: { showSettings = false })
                }
                .sheet(isPresented: $showCards) {
                    NeedsYouSheet(cards: cards, who: { c in c.bot.flatMap { id in (real ? bots.rows.map(\.bot) : Fake.bots).first { $0.id == id }?.name } ?? "A bot" }, onDone: { showCards = false })
                }
                .sheet(isPresented: $showNewBot) {
                    NewBotSheet(model: newBot, computer: paired.name, onCreated: { bot in
                        showNewBot = false
                        Task { await bots.load(); path.append(bot) }
                    }, onCancel: { showNewBot = false })
                }
            } else if !checked {
                ProgressView()
            } else {
                PairingScreen(model: pairing, appName: "MOSS", simulatedCamera: !real) { paired = $0 }
            }
        }
        .tint(Theme.accent)
        .environment(\.nowMs, real ? nil : Fake.now)
        .environment(\.conversationStartsAtTop, launch.scrollTop)
        .environment(\.conversationScrollTo, launch.scrollTo)
        .environment(\.composerPreset, launch.composer)
        .task {
            if real { paired = await client.pairedComputer; checked = true }
            await cards.load(); cards.start()
        }
        .task(id: launch.screen) {
            #if DEBUG
            if launch.screen == .pairWords { await pairing.scanned("moss-pair:sample") }
            #endif
        }
    }
}

/// The MOSS Code app: the sessions with coding agents, and what needs the person.
public struct MossCodeRoot: View {
    @State private var client: any EngineClient
    @State private var sessions: SessionsListModel
    @State private var cards: CardsModel
    @State private var pairing: PairingModel
    @State private var settings: SettingsModel
    @State private var paired: PairedComputer?
    @State private var showSettings: Bool
    @State private var showNew: Bool
    @State private var newSession: NewSessionModel
    @State private var path: [SessionRow] = []
    @State private var showCards = false
    @State private var checked: Bool
    private let launch: AppLaunch
    private let real: Bool

    public init(launch given: AppLaunch = .fromProcess(), engine: (any EngineClient)? = nil) {
        // Release: always the engine given (the real client); Debug: the fake when none is given or a picture asks.
        #if DEBUG
        let real = engine != nil && !given.explicit
        #else
        let real = true
        #endif
        self.real = real
        // Launch arguments drive the fake only: on the real client none of them applies (no bot made, no session started,
        // no file staged, no draft typed by anything but the person).
        let launch = real ? AppLaunch() : given
        self.launch = launch
        _checked = State(initialValue: !real)
        let c: any EngineClient = real ? (engine ?? NoEngineClient()) : Fake.client(launch)
        _client = State(initialValue: c)
        _sessions = State(initialValue: SessionsListModel(client: c))
        _cards = State(initialValue: real ? CardsModel(client: c, app: .code) : CardsModel(client: c, app: .code, now: { Fake.now }))
        _pairing = State(initialValue: PairingModel(client: c))
        let st = SettingsModel(client: c, version: SettingsModel.bundleVersion()); st.confirmingUnpair = launch.confirmUnpair
        _settings = State(initialValue: st)
        // On the real engine the client names the computer it is linked to.
        _newSession = State(initialValue: NewSessionModel(client: c, computer: real ? "" : Fake.computerName))
        _paired = State(initialValue: real || launch.unpaired ? nil : PairedComputer(name: Fake.computerName, deviceName: Fake.phoneName))
        _showCards = State(initialValue: launch.screen == .cards)
        _showSettings = State(initialValue: launch.screen == .settings)
        _showNew = State(initialValue: launch.screen == .newSession)
        if launch.screen == .session, let s = Fake.sessions.first(where: { $0.id == (launch.openID ?? "c2") }) { _path = State(initialValue: [s]) }
    }

    public var body: some View {
        Group {
            if let paired {
                NavigationStack(path: $path) {
                    SessionsScreen(model: sessions, cards: cards, computer: paired.name, onSettings: { showSettings = true }, onBell: { showCards = true }, onNew: { showNew = true })
                        .navigationDestination(for: SessionRow.self) { s in
                            SessionConversationView(session: s, client: client, cards: cards, autoSend: launch.sendsOnOpen)
                        }
                }
                // A sheet over the stack covers its cards (the Needs You sheet's own cards are not under it).
                .environment(\.cardsCovered, showCards || showSettings || showNew)
                .sheet(isPresented: $showCards) {
                    NeedsYouSheet(cards: cards, who: { c in c.session.flatMap { id in (real ? sessions.sessions : Fake.sessions).first { $0.id == id }?.title } ?? "A session" }, onDone: { showCards = false })
                }
                .sheet(isPresented: $showSettings) {
                    SettingsScreen(model: settings, appName: "MOSS Code", onUnpaired: { showSettings = false; self.paired = nil; pairing.retry() }, onDone: { showSettings = false })
                }
                .sheet(isPresented: $showNew) {
                    NewSessionScreen(model: newSession, onStarted: { id in
                        showNew = false
                        Task {
                            await sessions.load()
                            if let row = sessions.sessions.first(where: { $0.id == id }) { path = [row] }
                        }
                    }, onCancel: { showNew = false })
                }
            } else if !checked {
                ProgressView()
            } else {
                PairingScreen(model: pairing, appName: "MOSS Code", simulatedCamera: !real) { paired = $0 }
            }
        }
        .tint(Theme.accent)
        .environment(\.nowMs, real ? nil : Fake.now)
        .environment(\.conversationStartsAtTop, launch.scrollTop)
        .environment(\.conversationScrollTo, launch.scrollTo)
        .environment(\.composerPreset, launch.composer)
        .task {
            if real { paired = await client.pairedComputer; checked = true }
            await cards.load(); cards.start()
        }
        .task(id: launch.screen) {
            #if DEBUG
            if launch.screen == .pairWords { await pairing.scanned("moss-pair:sample") }
            #endif
            #if DEBUG
            if launch.startNew {
                await newSession.load()
                if let id = await newSession.start() { await sessions.load(); if let row = sessions.sessions.first(where: { $0.id == id }) { path = [row] } }
            }
            #endif
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
            BotFaceView(name: bot.name, face: bot.face, mood: (bot.state ?? .idle).faceMood, size: 22)
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
