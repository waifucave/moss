import SwiftUI

/// A conversation: messages, the turn's one status line, the cards that wait in it, and the composer. It serves a bot's
/// conversation and a coding session alike.
public struct ConversationScreen: View {
    @Bindable var model: ConversationModel
    @Bindable var cards: CardsModel
    @FocusState private var composing: Bool
    @Environment(\.nowMs) private var nowOverride

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
                LazyVStack(alignment: .leading, spacing: 10) {
                    if model.hasEarlier {
                        Button("Show earlier messages") { Task { await model.loadEarlier() } }
                            .font(.footnote).frame(maxWidth: .infinity)
                    }
                    if model.messages.isEmpty, model.errorText == nil {
                        Text(emptyText).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    ForEach(model.messages) { m in MessageRow(message: m, botName: speaker).id(m.id) }
                    ForEach(waitingCards) { card in
                        CardView(card: card, busy: cards.answering.contains(card.id)) { o in Task { await cards.answer(card, with: o) } }
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
            .defaultScrollAnchor(.bottom)
            .onChange(of: model.messages.count) { _, _ in withAnimation { proxy.scrollTo("end") } }
            .onChange(of: model.statusLine) { _, _ in withAnimation { proxy.scrollTo("end") } }
            .onChange(of: waitingCards.count) { _, _ in withAnimation { proxy.scrollTo("end") } }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 6) {
                if let e = model.errorText { Text(e).font(.footnote).foregroundStyle(.secondary) }
                ComposerBar(draft: $model.draft, placeholder: model.placeholder, running: model.isRunning,
                            onSend: { Task { await model.send() } }, onStop: { Task { await model.stop() } })
                    .focused($composing)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
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
                    .background(Theme.userBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                if let d = message.device { Text("from \(d)").font(.caption2).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 48)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("You: \(message.text)")
        case .bot, .agent:
            Text(message.text)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Theme.botBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 48)
                .accessibilityLabel("\(botName): \(message.text)")
        case .note:
            Text(message.text).font(.footnote).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

/// The composer: a field, and Send, which becomes Stop while a turn runs and nothing is typed.
public struct ComposerBar: View {
    @Binding var draft: String
    let placeholder: String
    let running: Bool
    let onSend: () -> Void
    let onStop: () -> Void

    public init(draft: Binding<String>, placeholder: String, running: Bool, onSend: @escaping () -> Void, onStop: @escaping () -> Void) {
        _draft = draft; self.placeholder = placeholder; self.running = running; self.onSend = onSend; self.onStop = onStop
    }
    private var hasText: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    public var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .glassEffect(.regular, in: .rect(cornerRadius: 22))
                .accessibilityLabel(placeholder)
            if running && !hasText {
                Button(action: onStop) { Image(systemName: "stop.fill").foregroundStyle(Color(uiColor: .systemBackground)).frame(width: 24, height: 24) }
                    .buttonStyle(.borderedProminent).buttonBorderShape(.circle).tint(Theme.accent).controlSize(.large)
                    .accessibilityLabel("Stop")
            } else {
                Button(action: onSend) { Image(systemName: "arrow.up").fontWeight(.semibold).foregroundStyle(Color(uiColor: .systemBackground)).frame(width: 24, height: 24) }
                    .buttonStyle(.borderedProminent).buttonBorderShape(.circle).tint(Theme.accent).controlSize(.large)
                    .disabled(!hasText)
                    .accessibilityLabel("Send")
            }
        }
    }
}
