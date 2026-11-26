import SwiftUI

/// A conversation: messages, the turn's one status line, the cards that wait in it, and the composer. It serves a bot's
/// conversation and a coding session alike.
public struct ConversationScreen: View {
    @Bindable var model: ConversationModel
    @Bindable var cards: CardsModel
    @FocusState private var composing: Bool
    @Environment(\.nowMs) private var nowOverride
    @Environment(\.conversationStartsAtTop) private var startsAtTop
    @Environment(\.conversationScrollTo) private var scrollTarget
    /// The composer's camera, photo or file picker is over the conversation: its cards are not being looked at.
    @State private var composerCovering = false

    public init(model: ConversationModel, cards: CardsModel) { self.model = model; self.cards = cards }

    private var waitingCards: [Card] {
        cards.cards.filter { c in
            switch model.source {
            case .bot(let b): return c.bot == b.id || c.session == b.mainSession
            case .session(let s): return c.session == s.id
            }
        }
    }

    public var body: some View {
        ScrollViewReader { proxy in
          // Drawn once the first page and the waiting cards are both in, so it opens at its real bottom: a card that
          // arrived after the scroll view took its first position would sit below the fold, heading first.
          Group {
            if !(model.loaded && cards.loaded) {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
            ScrollView {
                // Not lazy, on purpose: a lazy stack re-places itself as it measures rows, and a card's heading counted as
                // seen in a place the person never saw it (the tall-card UI test). A plain stack lays out every loaded
                // row when the conversation opens: the first page is 60 messages and each "Show earlier messages" adds 60
                // more. Its cost with several pages loaded is not measured yet; the lazy stack, with the settle rule made
                // to hold for it, is a follow-up of its own.
                VStack(alignment: .leading, spacing: 4) {
                    if model.hasEarlier {
                        Button("Show earlier messages") { Task { await model.loadEarlier() } }
                            .font(.footnote).frame(maxWidth: .infinity)
                    }
                    if model.messages.isEmpty, model.errorText == nil {
                        Text(emptyText).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    ForEach(Array(model.messages.enumerated()), id: \.element.id) { i, m in
                        let prev = i > 0 ? model.messages[i - 1] : nil
                        if prev == nil || m.at - (prev?.at ?? 0) > 30 * 60_000 {
                            Text(TimeText.divider(at: m.at, now: nowOverride ?? Int64(Date().timeIntervalSince1970 * 1000)))
                                .font(.footnote).foregroundStyle(Theme.subtle).frame(maxWidth: .infinity).padding(.vertical, 6)
                                .accessibilityAddTraits(.isHeader)
                        }
                        MessageRow(message: m, botName: speaker, answered: answeredText).id(m.id)
                            .padding(.top, prev != nil && prev?.role != m.role ? 6 : 0)
                    }
                    ForEach(waitingCards) { card in
                        CardView(card: card, in: cards)
                            .padding(.top, 6)
                            .id(card.id)
                    }
                    if let line = model.statusLine {
                        StatusLineView(line).padding(.horizontal, 4).padding(.top, 2).id("status")
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16).padding(.top, 8)
                .cardContent()
            }
            }
          }
            .scrollDismissesKeyboard(.interactively)
            // Messages pass under the bars as the system does it: the top and bottom scroll edge effects blur what is beneath the title and the composer.
            .scrollEdgeEffectStyle(.hard, for: .top)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            // Only where it opens: growth (a card's opened list) is not pinned to the bottom, so it grows downward from where it was.
            .defaultScrollAnchor(startsAtTop ? .top : .bottom, for: .initialOffset)
            .cardViewport(cards, covered: composerCovering)
            .task(id: scrollTarget) { if let t = scrollTarget { try? await Task.sleep(for: .seconds(1)); proxy.scrollTo(t, anchor: .top) } }
            // Never scrolled by itself while a card's buttons are on screen: nothing moves under the person's finger.
            .onChange(of: model.messages.count) { _, _ in if !startsAtTop, scrollTarget == nil, waitingCards.isEmpty { withAnimation { proxy.scrollTo("end") } } }
            .onChange(of: model.statusLine) { _, _ in if !startsAtTop, scrollTarget == nil, waitingCards.isEmpty { withAnimation { proxy.scrollTo("end") } } }
        }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            VStack(spacing: 6) {
                if let e = model.errorText {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.circle").accessibilityHidden(true).foregroundStyle(Theme.subtle)
                        Text(e).font(.footnote).foregroundStyle(Theme.subtle)
                        Spacer(minLength: 0)
                        if model.failedSend != nil {
                            // The button's own ink, not the line's grey: it is the thing to press.
                            Button("Retry") { Task { await model.retry() } }
                                .font(.footnote.weight(.semibold)).buttonStyle(.bordered).controlSize(.small).tint(Theme.accent).foregroundStyle(.primary)
                                .frame(minHeight: 44)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                if model.gone {
                    // Deleted on the computer: nothing to send to.
                    EmptyView()
                } else if let q = model.question {
                    // A bot's question doesn't hold the bot: it stays open until answered or skipped, so it can be skipped here.
                    QuestionComposerView(question: q, onSubmit: { drawn, answers in await model.answerQuestion(answers, to: drawn) },
                                         onSkip: model.kind == .bot ? { drawn in await model.skipQuestion(drawn) } : nil)
                        // A new question is a new view: nothing picked for one is ever shown, or sent, for another.
                        .id(q.callId)
                } else {
                    ComposerView(model: model, placeholder: model.placeholder)
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task { model.start() }
        .onPreferenceChange(ComposerCoveringKey.self) { composerCovering = $0 }
        .onDisappear { model.stopListening() }
    }

    /// Each question asked in this conversation, by call id: what an answer bubble names.
    private var answeredText: [String: String] {
        var out: [String: String] = [:]
        for m in model.messages { if let q = m.question { out[q.callId] = q.text } }
        return out
    }

    private var speaker: String {
        if case .bot(let b) = model.source { return b.name }
        if case .session(let s) = model.source { return AgentLook.of(s.backend).name }
        return ""
    }
    private var emptyText: String {
        if case .bot(let b) = model.source { return "This is the start of your conversation with \(b.name)." }
        return "Nothing has been said in this session yet."
    }
}

struct MessageRow: View {
    let message: ChatMessage
    let botName: String
    /// The question a message answers, by call id: its text, for the answer bubble's caption.
    var answered: [String: String] = [:]

    var body: some View {
        switch message.role {
        case .user:
            VStack(alignment: .trailing, spacing: 2) {
                if let id = message.answersQuestion {
                    // The person's answer to (or skip of) a question asked above: said so, never read as a plain message.
                    Label((answered[id] ?? message.answersQuestionText).map { "Answer to: \($0)" } ?? "Answer to a question", systemImage: "arrowshape.turn.up.left")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(message.text)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .foregroundStyle(Theme.userBubbleText)
                    .background(Theme.userBubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                if let d = message.device { Text("from \(d)").font(.caption2).foregroundStyle(.secondary) }
            }

            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 64)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(message.answersQuestion == nil ? "You: \(message.text)" : "Your answer: \(message.text)")
        case .bot, .agent:
            VStack(alignment: .leading, spacing: 4) {
                if !message.text.isEmpty {
                    Text(Linked.attributed(message.text))
                        .tint(Theme.link)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(Theme.botBubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .accessibilityLabel("\(botName): \(message.text)")
                }
                if let f = message.file { FileCard(file: f) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, 64)
        case .note:
            Text(message.text).font(.footnote).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 4)
        case .question:
            if let q = message.question { AskedQuestionRow(question: q, asker: botName) }
        }
    }
}

/// Links in a message are coloured, not underlined.
enum Linked {
    static func attributed(_ text: String) -> AttributedString {
        var a = AttributedString(text)
        guard let d = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return a }
        for m in d.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let url = m.url, let r = Range(m.range, in: text), let lo = AttributedString.Index(r.lowerBound, within: a), let hi = AttributedString.Index(r.upperBound, within: a) else { continue }
            a[lo..<hi].link = url
            a[lo..<hi].underlineStyle = nil
        }
        return a
    }
}

/// A file a message carries, as its own card: a tile for its kind, its name and what the engine says about it.
struct FileCard: View {
    let file: ChatFile
    private var isPDF: Bool { file.name.lowercased().hasSuffix(".pdf") }
    var body: some View {
        HStack(spacing: 12) {
            Text(isPDF ? "PDF" : String(file.name.split(separator: ".").last ?? "FILE").uppercased().prefix(4))
                .font(.caption.weight(.bold)).foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(isPDF ? Color(red: 0.86, green: 0.2, blue: 0.2) : Color.gray, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text(file.detail).font(.footnote).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Image(systemName: "arrow.down.circle").font(.title3).foregroundStyle(.secondary).accessibilityHidden(true)
        }
        .padding(12)
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.primary.opacity(0.14), lineWidth: 0.5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("File: \(file.name), \(file.detail)")
    }
}

private struct ScrollToKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
    /// For pictures: open a conversation with this message at the top edge, so later bubbles sit under the composer.
    var conversationScrollTo: String? { get { self[ScrollToKey.self] } set { self[ScrollToKey.self] = newValue } }
}

private struct StartsAtTopKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// For pictures: open a conversation at its first message rather than its last.
    var conversationStartsAtTop: Bool { get { self[StartsAtTopKey.self] } set { self[StartsAtTopKey.self] = newValue } }
}


/// A question where it was asked: the question and its options as asked, and how it ended. The person answers an open one
/// in the composer's place, below; this row never takes an answer.
struct AskedQuestionRow: View {
    let question: AskedQuestion
    let asker: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The bot's words, in their own box: nothing in them can pass for the status below.
            VStack(alignment: .leading, spacing: 10) {
                // Every question of the call, as asked.
                ForEach(question.parts.indices, id: \.self) { i in
                    let part = question.parts[i]
                    VStack(alignment: .leading, spacing: 4) {
                        if let h = part.header { Text(verbatim: h).font(.caption.weight(.semibold)).foregroundStyle(Theme.subtle) }
                        Text(verbatim: part.text).font(.subheadline).lineLimit(6)
                        if !part.options.isEmpty {
                            Text(verbatim: part.options.joined(separator: " · ")).font(.footnote).foregroundStyle(Theme.subtle).lineLimit(3)
                        }
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.botBubble.opacity(0.6))
            // The phone's own footer, apart from the bot's box: how the question ended.
            Divider()
            Group {
                if let s = question.state.status {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(s.title, systemImage: s.symbol).font(.footnote.weight(.semibold))
                        // The plugin's id, small and as plain text.
                        if let d = s.detail { Text(verbatim: d).font(.caption2).lineLimit(1).truncationMode(.middle) }
                    }
                } else { Label("Waiting for your answer below", systemImage: "questionmark.bubble").font(.footnote) }
            }
            .foregroundStyle(Theme.subtle)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .accessibilityIdentifier("questionStatus")
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.12), lineWidth: 0.5))
        .padding(.trailing, 32)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(asker) asked: \(question.parts.map(\.text).joined(separator: " ")). \(question.state.status.map { s in s.detail.map { "\(s.title): \($0)" } ?? s.title } ?? "Waiting for your answer")")
    }
}
