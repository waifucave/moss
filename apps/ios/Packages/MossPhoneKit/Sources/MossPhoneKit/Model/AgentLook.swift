import Foundation

/// How an agent is named and drawn, as `agent.backends` serves it (`docs/agent-marks.md`). A mark ships as one imageset in
/// `Resources/AgentMarks.xcassets`, named by the agent's id; delete the folder and the agent is drawn with the fallback, its
/// name's first letter on its colour (`look.ts` does the same on the desktop).
public struct AgentLook: Hashable, Sendable {
    public var id: String
    public var name: String
    public var colorHex: String?
    /// One-colour marks are tinted; the rest draw as they are.
    public var template: Bool

    public static let mossCode = "moss-code"
    static let known: [String: AgentLook] = [
        "moss-code": .init(id: "moss-code", name: "MOSS Code", colorHex: "#E5A72E", template: false),
        "claude-code": .init(id: "claude-code", name: "Claude Code", colorHex: "#D97757", template: false),
        "codex": .init(id: "codex", name: "Codex", colorHex: "#484FF6", template: true),
        "gemini": .init(id: "gemini", name: "Gemini", colorHex: "#3488FB", template: false),
        "antigravity": .init(id: "antigravity", name: "Antigravity", colorHex: "#3186FF", template: false),
        "cursor": .init(id: "cursor", name: "Cursor", colorHex: nil, template: true),
        "opencode": .init(id: "opencode", name: "OpenCode", colorHex: nil, template: true),
        "deepseek": .init(id: "deepseek", name: "DeepSeek", colorHex: "#4D6BFE", template: false),
        "grok": .init(id: "grok", name: "Grok", colorHex: nil, template: true),
        "copilot": .init(id: "copilot", name: "Copilot", colorHex: "#218BFF", template: true),
        "kimi": .init(id: "kimi", name: "Kimi", colorHex: "#1783FF", template: false),
        "qwen": .init(id: "qwen", name: "Qwen", colorHex: "#082DFF", template: false),
        "devin": .init(id: "devin", name: "Devin", colorHex: nil, template: true),
    ]

    public static func of(_ backend: String?) -> AgentLook {
        guard let backend else { return .init(id: "", name: "Agent", colorHex: nil, template: false) }
        return known[backend] ?? .init(id: backend, name: backend.capitalized, colorHex: nil, template: false)
    }
    public var initial: String { String(name.first ?? "?").uppercased() }
}
