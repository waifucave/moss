import SwiftUI

/// A pending card: small, never raw JSON. Its title, what it asks, the command or paths it covers, and its sealed buttons.
public struct CardView: View {
    let card: Card
    let busy: Bool
    let note: CardNote?
    let onAnswer: (CardOption) -> Void
    let onSettle: () -> Void
    @State private var expanded = Set<String>()
    @Environment(\.nowMs) private var nowOverride

    /// `note` says why the card can't be answered (expired, answered elsewhere, failed); `onSettle` then dismisses it (or, after a failure, lets the person try again).
    public init(card: Card, busy: Bool = false, note: CardNote? = nil, onAnswer: @escaping (CardOption) -> Void, onSettle: @escaping () -> Void = {}) {
        self.card = card; self.busy = busy; self.note = note; self.onAnswer = onAnswer; self.onSettle = onSettle
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(Sealed.visible(card.title)).font(.headline)
                if let what = card.what { Text(Sealed.visible(what)).font(.subheadline).foregroundStyle(.secondary) }
            }
            ForEach(shownFields, id: \.0) { name, value in
                field(name, value)
            }
            footer
            if let note {
                VStack(alignment: .leading, spacing: 8) {
                    Label(note.text, systemImage: note == .failed ? "exclamationmark.circle" : "clock.badge.xmark")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button { onSettle() } label: { Text(note == .failed ? "Try again" : "Dismiss").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered).tint(.secondary)
                }
            } else {
                (card.options.count > 2 ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))) {
                    ForEach(card.options) { option in
                        Button { onAnswer(option) } label: {
                            Text(Sealed.visible(option.label)).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(option.kind == .approve ? Theme.accent : .secondary)
                        .controlSize(.regular)
                        .disabled(busy)
                        .accessibilityLabel(option.rememberAlways ? "\(option.label), and remember" : option.label)
                        .accessibilityHint(option.kind == .approve ? "Approves this request" : "Refuses this request")
                    }
                }
            }
        }
        .padding(14)
        .background(Color(uiColor: .secondarySystemFill), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .opacity(note == nil || note == .failed ? 1 : 0.75)
        .accessibilityElement(children: .contain)
    }

    private static let order = ["command", "paths", "detail", "reason", "risk", "computer"]
    private var shownFields: [(String, SealedValue)] {
        Self.order.compactMap { name in card.fields[name].map { (name, $0) } }
    }

    @ViewBuilder private func field(_ name: String, _ value: SealedValue) -> some View {
        switch value {
        case .text(let t):
            if name == "computer" { EmptyView() }   // shown in the footer
            else { labelled(name) { cutText(t, name: name, limit: 600).font(.callout) } }
        case .code(let c, _):
            cutText(c, name: name, limit: 800)
                .font(.system(.footnote, design: .monospaced))
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .list(let items):
            labelled(name) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(items.prefix(8).enumerated()), id: \.offset) { _, i in
                        Text(Sealed.visible(i)).font(.system(.footnote, design: .monospaced))
                    }
                    if items.count > 8 { Text("and \(items.count - 8) more").font(.footnote).foregroundStyle(.secondary) }
                }
            }
        case .rows(let rows):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                    HStack(alignment: .firstTextBaseline) {
                        Text(Sealed.visible(r.label)).foregroundStyle(.secondary)
                        Spacer(minLength: 12)
                        Text(Sealed.visible(r.value)).multilineTextAlignment(.trailing)
                    }.font(.callout)
                }
            }
        }
    }

    private func labelled<C: View>(_ name: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let l = Self.labels[name] { Text(l).font(.caption).foregroundStyle(.secondary) }
            content()
        }
    }
    private static let labels = ["risk": "Risk", "reason": "Why", "paths": "Files", "detail": "Details"]

    /// A long field is cut openly: it says how much is hidden and offers the rest.
    @ViewBuilder private func cutText(_ s: String, name: String, limit: Int) -> some View {
        let cut = Sealed.cut(s, limit: limit)
        VStack(alignment: .leading, spacing: 4) {
            Text(expanded.contains(name) ? Sealed.visible(s) : cut.shown)
            if cut.hiddenCount > 0 && !expanded.contains(name) {
                Button("Cut short: \(cut.hiddenCount) more characters. Show all") { expanded.insert(name) }
                    .font(.footnote).buttonStyle(.plain).foregroundStyle(.secondary).underline()
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 6) {
            if case .text(let c)? = card.fields["computer"] { Label("on \(Sealed.visible(c))", systemImage: "desktopcomputer") }
            Spacer()
            if let left = secondsLeft { Text("Expires in \(left / 60) min") }
        }
        .font(.caption).foregroundStyle(.secondary)
    }
    private var secondsLeft: Int64? {
        let now = nowOverride ?? Int64(Date().timeIntervalSince1970 * 1000)
        let s = (card.expiresAt - now) / 1000
        return s > 0 ? s : nil
    }
}

/// The cards screen both apps share: the pending cards, newest first, or a plain empty state.
public struct CardsScreen: View {
    @Bindable var model: CardsModel
    let who: (Card) -> String
    let onRetry: () -> Void
    public init(model: CardsModel, who: @escaping (Card) -> String, onRetry: @escaping () -> Void = {}) { self.model = model; self.who = who; self.onRetry = onRetry }

    public var body: some View {
        List {
            if model.loadFailed { Section { UnreachableNotice(onRetry: { Task { await model.load() } }) } }
            ForEach(model.cards.sorted { $0.issuedAt > $1.issuedAt }) { card in
                Section {
                    CardView(card: card, busy: model.answering.contains(card.id), note: model.note(for: card),
                             onAnswer: { option in Task { await model.answer(card, with: option) } },
                             onSettle: { model.note(for: card) == .failed ? model.clearFailure(card) : model.dismiss(card) })
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                        .listRowBackground(Color.clear)
                } header: { Text(who(card)) }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if !model.loaded { ProgressView("Loading").controlSize(.large) }
            else if model.cards.isEmpty && !model.loadFailed {
                ContentUnavailableView("Nothing needs you", systemImage: "checkmark.circle", description: Text("When a bot or an agent needs your answer, it shows here."))
            }
        }
        .navigationTitle("Needs you")
        .task { model.start() }
    }
}
