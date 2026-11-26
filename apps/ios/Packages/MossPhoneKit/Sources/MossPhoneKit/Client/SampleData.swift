import Foundation

// Debug only: a Release build carries no fake and no sample data (see Roots.swift `Fake`).
#if DEBUG
/// Sample data shaped like the engine's payloads (`packages/protocol/generated/moss/fixtures`). Not real people, bots or paths.
public enum SampleData {
    /// A fixed "now" (2026-11-24 10:00 UTC) so pictures and tests never depend on the clock.
    public static let now: Int64 = 1_795_600_800_000
    static func ago(_ seconds: Int64) -> Int64 { now - seconds * 1000 }

    public static let computerName = "Studio"
    public static let phoneName = "Phone"

    public static let bots: [Bot] = [
        Bot(id: "alpha", name: "Alpha", model: "fireworks/kimi-k3", effort: "medium", face: BotFaceSpec(color: "coral"), state: .idle, computer: computerName, mainSession: "s_alpha"),
        Bot(id: "luna", name: "Luna", model: "anthropic/claude-sonnet", face: nil, state: .thinking, computer: computerName, mainSession: "s_luna"),
        Bot(id: "juniper", name: "Juniper", model: "openai/gpt-5", face: nil, state: .idle, computer: computerName, mainSession: "s_juniper"),
        Bot(id: "pip", name: "Pip", face: BotFaceSpec(shape: "drop", color: "sky"), state: .idle, computer: computerName, mainSession: "s_pip"),
        Bot(id: "marlow", name: "Marlow", face: nil, state: .asleep, mainSession: "s_marlow"),
        Bot(id: "sorrel", name: "Sorrel", face: nil, state: .paused, computer: computerName, mainSession: "s_sorrel"),
        Bot(id: "tansy", name: "Tansy", face: nil, state: .idle, computer: computerName, mainSession: "s_tansy"),
        Bot(id: "ember", name: "Ember", face: nil, state: .idle, computer: computerName, mainSession: "s_ember"),
        Bot(id: "wren", name: "Wren", face: nil, state: .idle, computer: computerName, mainSession: "s_wren"),
        Bot(id: "fig", name: "Fig", face: nil, state: .idle, computer: computerName, mainSession: "s_fig"),
        Bot(id: "briar", name: "Briar", face: nil, state: .idle, computer: computerName, mainSession: "s_briar"),
    ]

    public static let summaries: [BotSummary] = [
        BotSummary(id: "alpha", last: .init(text: "The deploy finished. Nothing needed a retry.", from: .bot, at: ago(240)), unread: true),
        BotSummary(id: "luna", last: .init(text: "Looking through this week's receipts", from: .note, at: ago(30)), unread: false),
        BotSummary(id: "juniper", last: .init(text: "Thanks, that is the one I wanted.", from: .user, at: ago(3 * 3600)), unread: false),
        BotSummary(id: "pip", last: .init(text: "Your 3 pm is moved to Thursday.", from: .bot, at: ago(26 * 3600)), unread: true),
        BotSummary(id: "marlow", last: .init(text: "I will pick this up when Studio is on.", from: .bot, at: ago(3 * 86400)), unread: false),
        BotSummary(id: "sorrel", last: nil, unread: false),
        BotSummary(id: "tansy", last: .init(text: "Booked the table for four.", from: .bot, at: ago(5 * 86400)), unread: false),
        BotSummary(id: "ember", last: .init(text: "Outreach drafts queued for approval.", from: .bot, at: ago(2 * 3600)), unread: true),
        BotSummary(id: "wren", last: .init(text: "The weekly numbers are in the sheet.", from: .bot, at: ago(4 * 86400)), unread: false),
        BotSummary(id: "fig", last: .init(text: "I moved the invoices to the shared folder.", from: .bot, at: ago(6 * 86400)), unread: false),
        BotSummary(id: "briar", last: .init(text: "Nothing new in the inbox since Friday.", from: .bot, at: ago(9 * 86400)), unread: false),
    ]

    /// The bots the person pinned: the phone keeps this itself (the engine has no such field).
    public static let pinned: [String] = ["luna", "juniper", "tansy"]

    public static func conversation(for bot: String) -> [ChatMessage] {
        switch bot {
        case "alpha":
            return [
                ChatMessage(id: "m1", role: .user, text: "Can you ship the docs fix tonight?", at: ago(3900), device: nil),
                ChatMessage(id: "m2", role: .bot, text: "Yes. I will run the checks first and tell you when it is out.", at: ago(3880)),
                ChatMessage(id: "m3", role: .note, text: "Ran the checks on Studio", at: ago(3000)),
                ChatMessage(id: "m4", role: .bot, text: "The deploy finished. Nothing needed a retry.", at: ago(240)),
                ChatMessage(id: "m5", role: .user, text: "Great. Anything waiting on me?", at: ago(200), device: "Laptop"),
                ChatMessage(id: "m6", role: .bot, text: "One approval is waiting: I would like to clear the old build folder.", at: ago(150)),
                ChatMessage(id: "m7", role: .bot, text: "The release notes are written up at https://example.com/notes", at: ago(140)),
                ChatMessage(id: "m8", role: .bot, text: "", at: ago(130), file: ChatFile(name: "Release notes.pdf", detail: "12 pages · 1.2 MB")),
            ]
        default:
            let name = bots.first { $0.id == bot }?.name ?? "Bot"
            return [
                ChatMessage(id: "\(bot)-1", role: .bot, text: "Hello, I am \(name). What would you like to do?", at: ago(86400)),
            ]
        }
    }

    // Sessions, shaped as `session.list` serves them; root is `home/<Computer>/<project>`.
    public static let sessions: [SessionRow] = [
        SessionRow(id: "c1", computer: computerName, title: "Fix the flaky pairing test", status: .prompting, startedAt: ago(1800), updatedAt: ago(20),
                   backend: "claude-code", model: "claude-opus", root: "home/Studio/moss", branch: "lane/pairing", changes: 4),
        SessionRow(id: "c2", computer: computerName, title: "Move the settings page to the new form", status: .idle, startedAt: ago(9000), updatedAt: ago(600),
                   backend: "moss-code", model: "kimi-k3", root: "home/Studio/moss", branch: "settings-form", changes: 12, needsYou: NeedsYou(cards: 1, questions: 0)),
        SessionRow(id: "c3", computer: computerName, title: "Read the failing CI log", status: .idle, startedAt: ago(20000), updatedAt: ago(4000),
                   backend: "codex", model: "gpt-5-codex", root: "home/Studio/moss", waiting: SessionWaiting(tasks: 1, children: 0)),
        SessionRow(id: "c4", computer: computerName, title: "Which colour for the new tag?", status: .idle, startedAt: ago(30000), updatedAt: ago(7200),
                   backend: "claude-code", model: "claude-sonnet", root: "home/Studio/website", needsYou: NeedsYou(cards: 0, questions: 1)),
        SessionRow(id: "c5", computer: computerName, title: "Rebuild the landing page header", status: .idle, startedAt: ago(90000), updatedAt: ago(30000),
                   backend: "gemini", model: "gemini-pro", root: "home/Studio/website", branch: "header", changes: 0),
        SessionRow(id: "c6", computer: computerName, title: "Trim the install script", status: .stopped, startedAt: ago(200000), updatedAt: ago(100000),
                   backend: "opencode", model: "kimi-k3", root: "home/Studio/tools"),
        SessionRow(id: "c7", computer: computerName, title: "Notes from the review", status: .failed, startedAt: ago(300000), updatedAt: ago(250000),
                   backend: "cursor", model: "auto", root: "home/Studio/tools"),
    ]

    /// Questions waiting in a conversation, by session id.
    /// The switch scenario's two questions: four options, then two (a choice of the 4th must never survive the switch).
    public static let fourOptionQuestion = AskQuestion(callId: "ask_four", header: "Release", text: "Which day should the release go out?",
                                                       options: [.init(label: "Monday"), .init(label: "Tuesday"), .init(label: "Wednesday"), .init(label: "Thursday")])
    public static let switchedQuestion = AskQuestion(callId: "ask_two", header: "Notes", text: "Should the notes be public?",
                                                     options: [.init(label: "Yes"), .init(label: "No")])
    public static let questions: [String: AskQuestion] = [
        // A tall question with a long preview: the options and Submit stay on screen (the reviewer's rule for computer text).
        "c5": AskQuestion(callId: "ask_3", header: "Header", text: (1...10).map { "Line \($0) of a question that runs on and on, as a computer may send it." }.joined(separator: "\n"),
                          options: [.init(label: "Keep the old header", detail: "Nothing changes", preview: (1...40).map { "- old line \($0)\n+ new line \($0)" }.joined(separator: "\n")),
                                    .init(label: "Use the new header")]),
        "c4": AskQuestion(callId: "ask_1", header: "Tag colour", text: "Which colour should the new tag have?",
                          options: [.init(label: "Green", detail: "Matches the success states"), .init(label: "Amber", detail: "Stands out on the white page"), .init(label: "Grey", detail: "Quiet, like the other tags")]),
        "s_luna": AskQuestion(callId: "ask_2", header: "Receipts", text: "Which folder should I keep this week's receipts in?",
                              options: [.init(label: "Receipts 2026"), .init(label: "Taxes"), .init(label: "A new folder")]),
        // A call of two questions, answered together: Submit waits until both have an answer.
        "s_juniper": SampleData.twoQuestions,
    ]
    public static let twoQuestions = AskQuestion(callId: "ask_pair", questions: [
        .init(header: "Trip", text: "Which day should I book the train for?", options: [.init(label: "Friday"), .init(label: "Saturday")]),
        .init(header: "Seat", text: "Which seats do you want?", options: [.init(label: "Window"), .init(label: "Aisle"), .init(label: "Table")], multiSelect: true),
    ])

    public static func sessionMessages(for id: String) -> [ChatMessage] {
        switch id {
        case "c1":
            return [
                ChatMessage(id: "c1-1", role: .user, text: "The pairing test fails about one run in five. Find out why.", at: ago(1790)),
                ChatMessage(id: "c1-2", role: .agent, text: "The test waits a fixed 200 ms for the words to arrive. On a busy runner they come later. I will wait for the event instead.", at: ago(1500)),
                ChatMessage(id: "c1-3", role: .note, text: "Edited pairing.test.ts", at: ago(900)),
                ChatMessage(id: "c1-4", role: .agent, text: "Fixed in the test; running it fifty times now.", at: ago(120)),
            ]
        case "c2":
            return [
                ChatMessage(id: "c2-a", role: .user, text: "Which settings pages still use the old form?", at: ago(20000)),
                ChatMessage(id: "c2-b", role: .agent, text: "Four of them: profile, billing, notifications and the API keys page.", at: ago(19500)),
                ChatMessage(id: "c2-c", role: .user, text: "Move them one by one and run the tests after each.", at: ago(19000)),
                ChatMessage(id: "c2-d", role: .agent, text: "Starting with profile. I will keep the old component until all four are done.", at: ago(18500)),
                ChatMessage(id: "c2-1", role: .user, text: "Move the settings page to the new form component.", at: ago(8900)),
                ChatMessage(id: "c2-2", role: .agent, text: "Done in 12 files. I want to delete the old form folder, which needs your approval.", at: ago(700)),
            ]
        default:
            return [ChatMessage(id: "\(id)-1", role: .agent, text: "Ready when you are.", at: ago(5000))]
        }
    }

    /// The provider-consent card (core/src/bots/provider-consent.ts): the provider whose stored key is used is in `host` only.
    public static let providerConsentCard = Card(id: "card_prov0001", kind: "change", computer: computerName, bot: "alpha", origin: "bot",
             issuedAt: ago(60), expiresAt: now + 540_000, hash: String(repeating: "c", count: 64),
             fields: [
                "title": .text("Use your stored key for Alpha?"),
                "what": .text("This bot's plugin, not you, chose a model whose provider uses your stored key. A yes lets this bot use that provider with your key, and no other bot or provider."),
                "reason": .text("You can choose the model yourself in the bot's settings instead: then nothing asks."),
                "source": .code("alpha", language: nil),
                "host": .code("fireworks", language: nil),
                "command": .code("fireworks/kimi-k3", language: nil),
             ],
             options: [CardOption(id: "approve", kind: .approve, label: "Allow"), CardOption(id: "deny", kind: .deny, label: "Deny")])

    /// A card that lists nine files, the ninth one that matters: the list is cut at eight and its buttons wait until it is opened.
    public static let manyPathsCard = Card(id: "card_paths0009", kind: "tool", computer: computerName, bot: "alpha", origin: "bot",
             issuedAt: ago(30), expiresAt: now + 570_000, hash: String(repeating: "d", count: 64),
             fields: [
                "title": .text("Change nine files?"),
                "what": .text("Alpha wants to write to these files."),
                "paths": .list(["notes/a.md", "notes/b.md", "notes/c.md", "notes/d.md", "notes/e.md", "notes/f.md", "notes/g.md", "notes/h.md", "~/.ssh/authorized_keys"]),
                "reason": .text(String(repeating: "Tidying the notes folder so every file has a heading. ", count: 14)),
                "source": .code("alpha", language: nil),
                "computer": .text(computerName),
             ],
             options: [CardOption(id: "approve", kind: .approve, label: "Allow"), CardOption(id: "deny", kind: .deny, label: "Deny")])

    /// At the foot of Alpha's conversation: eight paths shown, thirty more cut, `~/.ssh/authorized_keys` the fifteenth.
    public static let longListCard = Card(id: "card_long0038", kind: "tool", computer: computerName, bot: "alpha", origin: "bot",
             issuedAt: ago(20), expiresAt: now + 580_000, hash: String(repeating: "7", count: 64),
             fields: ["title": .text("Change these files?"), "what": .text("Alpha wants to write to them."),
                      "paths": .list((1...38).map { $0 == 15 ? "~/.ssh/authorized_keys" : "notes/file-\($0).md" })],
             options: [CardOption(id: "approve", kind: .approve, label: "Allow"), CardOption(id: "deny", kind: .deny, label: "Deny")])
    /// At the foot of Alpha's conversation, taller than the screen: it opens at its bottom, its heading out of sight.
    public static let tallCard = Card(id: "card_tall0002", kind: "tool", computer: computerName, bot: "alpha", origin: "bot",
             issuedAt: ago(20), expiresAt: now + 580_000, hash: String(repeating: "8", count: 64),
             fields: ["title": .text("Run this command?"), "what": .text("Alpha wants to tidy the notes."),
                      "command": .code((1...6).map { "step \($0) --all notes/" }.joined(separator: "\n"), language: "sh"),
                      "detail": .rows((1...8).map { .init(label: "Step \($0)", value: "notes/part-\($0)") }),
                      "paths": .list((1...8).map { "notes/part-\($0).md" }),
                      "reason": .text(String(repeating: "Every part gets a heading and a date. ", count: 14)),
                      "host": .code("example.org", language: nil)],
             options: [CardOption(id: "approve", kind: .approve, label: "Allow"), CardOption(id: "deny", kind: .deny, label: "Deny")])

    public static let cards: [Card] = [
        Card(id: "card_0a1b2c3d", kind: "tool", computer: computerName, session: "s_alpha", bot: "alpha", origin: "routine",
             issuedAt: ago(150), expiresAt: now + 450_000, hash: String(repeating: "a", count: 64),
             fields: [
                "title": .text("Run a command?"),
                "what": .text("Alpha wants to clear the old build folder."),
                "command": .code("rm -rf build/", language: "sh"),
                "computer": .text(computerName),
                "risk": .text("Deletes a folder"),
             ],
             options: [
                CardOption(id: "allow_once", kind: .approve, label: "Allow"),
                CardOption(id: "allow_always", kind: .approve, label: "Always allow", rememberAlways: true),
                CardOption(id: "deny", kind: .deny, label: "Deny"),
             ]),
        Card(id: "card_9f8e7d6c", kind: "tool", computer: computerName, session: "c2", origin: "agent",
             issuedAt: ago(600), expiresAt: now + 900_000, hash: String(repeating: "b", count: 64),
             fields: [
                "title": .text("Delete a folder?"),
                "what": .text("MOSS Code wants to remove the old form folder from the project."),
                "paths": .list(["src/settings/old-form/", "src/settings/old-form.test.ts"]),
                "computer": .text(computerName),
                "reason": .text("The settings page no longer uses it."),
             ],
             options: [
                CardOption(id: "allow_once", kind: .approve, label: "Allow"),
                CardOption(id: "deny", kind: .deny, label: "Deny"),
             ]),
        Card(id: "card_55aa66bb", kind: "tool", computer: computerName, session: "s_pip", bot: "pip", origin: "bot",
             issuedAt: ago(90), expiresAt: now + 800_000, hash: String(repeating: "c", count: 64),
             fields: [
                "title": .text("Send an email?"),
                "what": .text("Pip wants to send the moved invitation."),
                "detail": .rows([.init(label: "To", value: "the book club"), .init(label: "Subject", value: "Thursday instead")]),
                "computer": .text(computerName),
             ],
             options: [
                CardOption(id: "allow_once", kind: .approve, label: "Send"),
                CardOption(id: "deny", kind: .deny, label: "Don't send"),
             ]),
    ]

    public static let backends: [AgentBackend] = [
        AgentBackend(id: "moss-code", name: "MOSS Code"), AgentBackend(id: "claude-code", name: "Claude Code"),
        AgentBackend(id: "codex", name: "Codex"), AgentBackend(id: "gemini", name: "Gemini"), AgentBackend(id: "opencode", name: "OpenCode"),
    ]
    public static func options(for backend: String) -> BackendOptions {
        switch backend {
        case "claude-code":
            return BackendOptions(backend: backend, models: [
                ModelOption(id: "claude-opus", name: "Opus", efforts: ["low", "medium", "high"], defaultEffort: "high"),
                ModelOption(id: "claude-sonnet", name: "Sonnet", efforts: ["low", "medium", "high"], defaultEffort: "medium"),
            ], defaultModel: "claude-opus", defaultEffort: "high")
        case "codex":
            return BackendOptions(backend: backend, models: [ModelOption(id: "gpt-5-codex", name: "GPT-5 Codex", efforts: ["low", "medium", "high"], defaultEffort: "medium")],
                                  defaultModel: "gpt-5-codex", defaultEffort: "medium")
        case "moss-code":
            return BackendOptions(backend: backend, models: [ModelOption(id: "kimi-k3", name: "Kimi K3", efforts: ["medium", "high"], defaultEffort: "medium"),
                                                             ModelOption(id: "gpt-5", name: "GPT-5", efforts: ["low", "medium", "high"], defaultEffort: "medium")],
                                  defaultModel: "kimi-k3", defaultEffort: "medium")
        default:
            // An agent whose models are unknown until it starts.
            return BackendOptions(backend: backend, known: false, models: [])
        }
    }
    public static let recentStart = RecentStart(
        last: .init(backend: "claude-code", model: "claude-sonnet", effort: "medium"),
        byBackend: [.init(backend: "claude-code", model: "claude-sonnet", effort: "medium"), .init(backend: "codex", model: "gpt-5-codex", effort: "high")],
        roots: ["home/Studio/moss", "home/Studio/website", "home/Studio/tools"])
}
#endif
