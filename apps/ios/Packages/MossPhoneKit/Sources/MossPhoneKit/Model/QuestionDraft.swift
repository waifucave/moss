import Foundation

/// What the person has chosen so far for one question call: per question, the options picked and the words typed in its
/// "Something else" box. The call is answered together, as the desktop's card does: `answers` is there only once every
/// question has an answer.
public struct QuestionDraft: Equatable, Sendable {
    public let question: AskQuestion
    /// Per question (its index in the call): the options picked, by index.
    public private(set) var picked: [Int: Set<Int>] = [:]
    /// Per question: the words typed instead of (or as well as) an option.
    public var other: [Int: String] = [:]

    public init(_ question: AskQuestion) { self.question = question }

    public func isPicked(_ option: Int, in part: Int) -> Bool { picked[part]?.contains(option) == true }

    /// Picks or unpicks an option: one question's pick never touches another's. A single-choice question keeps one.
    public mutating func toggle(_ option: Int, in part: Int) {
        guard question.questions.indices.contains(part), question.questions[part].options.indices.contains(option) else { return }
        var set = picked[part] ?? []
        if question.questions[part].multiSelect {
            if set.contains(option) { set.remove(option) } else { set.insert(option) }
        } else {
            set = set.contains(option) ? [] : [option]
        }
        picked[part] = set
    }

    /// One question's answer as the engine takes it: the picked labels in their order, then the typed words.
    public func answer(for part: Int) -> String {
        guard question.questions.indices.contains(part) else { return "" }
        let options = question.questions[part].options
        var parts = (picked[part] ?? []).sorted().filter { options.indices.contains($0) }.map { options[$0].label }
        let typed = (other[part] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { parts.append(typed) }
        return parts.joined(separator: ", ")
    }

    /// How many of the call's questions still have no answer.
    public var unanswered: Int { question.questions.indices.filter { answer(for: $0).isEmpty }.count }

    /// Every question's answer, keyed by its own text (exactly as the engine sent it), or nil while one has none.
    public var answers: [String: String]? {
        guard unanswered == 0, question.answerableHere else { return nil }
        var out: [String: String] = [:]
        for (i, part) in question.questions.enumerated() { out[part.text] = answer(for: i) }
        return out
    }
}
