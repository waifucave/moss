import Foundation

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
    ]

    public static let summaries: [BotSummary] = [
        BotSummary(id: "alpha", last: .init(text: "The deploy finished. Nothing needed a retry.", from: .bot, at: ago(240)), unread: true),
        BotSummary(id: "luna", last: .init(text: "Looking through this week's receipts", from: .note, at: ago(30)), unread: false),
        BotSummary(id: "juniper", last: .init(text: "Thanks, that is the one I wanted.", from: .user, at: ago(3 * 3600)), unread: false),
        BotSummary(id: "pip", last: .init(text: "Your 3 pm is moved to Thursday.", from: .bot, at: ago(26 * 3600)), unread: true),
        BotSummary(id: "marlow", last: .init(text: "I will pick this up when Studio is on.", from: .bot, at: ago(3 * 86400)), unread: false),
        BotSummary(id: "sorrel", last: nil, unread: false),
        BotSummary(id: "tansy", last: .init(text: "Booked the table for four.", from: .bot, at: ago(5 * 86400)), unread: false),
    ]

    /// The bots the person pinned: the phone keeps this itself (the engine has no such field).
    public static let pinned: [String] = ["alpha", "luna", "pip"]

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
                ChatMessage(id: "c2-1", role: .user, text: "Move the settings page to the new form component.", at: ago(8900)),
                ChatMessage(id: "c2-2", role: .agent, text: "Done in 12 files. I want to delete the old form folder, which needs your approval.", at: ago(700)),
            ]
        default:
            return [ChatMessage(id: "\(id)-1", role: .agent, text: "Ready when you are.", at: ago(5000))]
        }
    }

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
}
