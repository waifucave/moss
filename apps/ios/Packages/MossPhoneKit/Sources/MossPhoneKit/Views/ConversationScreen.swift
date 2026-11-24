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
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
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
                                .font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 6)
                                .accessibilityAddTraits(.isHeader)
                        }
                        MessageRow(message: m, botName: speaker).id(m.id)
                            .padding(.top, prev != nil && prev?.role != m.role ? 6 : 0)
                    }
                    ForEach(waitingCards) { card in
                        CardView(card: card, busy: cards.answering.contains(card.id), note: cards.note(for: card),
                                 onAnswer: { o in Task { await cards.answer(card, with: o) } },
                                 onSettle: { cards.note(for: card) == .failed ? cards.clearFailure(card) : cards.dismiss(card) })
                            .padding(.top, 6)
                            .id(card.id)
                    }
                    if let line = model.statusLine {
                        StatusLineView(line).padding(.horizontal, 4).padding(.top, 2).id("status")
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16).padding(.top, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            // Messages pass under the bars as the system does it: the top and bottom scroll edge effects blur what is beneath the title and the composer.
            .scrollEdgeEffectStyle(.hard, for: .top)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .defaultScrollAnchor(startsAtTop ? .top : .bottom)
            .task(id: scrollTarget) { if let t = scrollTarget { try? await Task.sleep(for: .seconds(1)); proxy.scrollTo(t, anchor: .top) } }
            .onChange(of: model.messages.count) { _, _ in if !startsAtTop, scrollTarget == nil { withAnimation { proxy.scrollTo("end") } } }
            .onChange(of: model.statusLine) { _, _ in if !startsAtTop, scrollTarget == nil { withAnimation { proxy.scrollTo("end") } } }
            .onChange(of: waitingCards.count) { _, _ in if !startsAtTop, scrollTarget == nil { withAnimation { proxy.scrollTo("end") } } }
        }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            VStack(spacing: 6) {
                if let e = model.errorText {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.circle").accessibilityHidden(true)
                        Text(e).font(.footnote)
                        Spacer(minLength: 0)
                        if model.failedSend != nil {
                            Button("Retry") { Task { await model.retry() } }
                                .font(.footnote.weight(.semibold)).buttonStyle(.bordered).controlSize(.small).tint(Theme.accent)
                        }
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)
                }
                if let q = model.question {
                    QuestionComposerView(question: q) { answers in await model.answerQuestion(answers) }
                } else {
                    ComposerView(model: model, placeholder: model.placeholder)
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task { model.start() }
        .onDisappear { model.stopListening() }
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

    var body: some View {
        switch message.role {
        case .user:
            VStack(alignment: .trailing, spacing: 2) {
                Text(message.text)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .foregroundStyle(Theme.userBubbleText)
                    .background(Theme.userBubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                if let d = message.device { Text("from \(d)").font(.caption2).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 64)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("You: \(message.text)")
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

