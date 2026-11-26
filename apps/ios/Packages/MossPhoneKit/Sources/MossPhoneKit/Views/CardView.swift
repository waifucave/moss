import SwiftUI

/// A pending card: small, never raw JSON. Its title, what it asks, the command or paths it covers, and its sealed buttons.
public struct CardView: View {
    let card: Card
    let busy: Bool
    let note: CardNote?
    let onAnswer: (CardOption) -> Void
    let onSettle: () -> Void
    /// Whether each option answers now (the model's word): an approve waits until read; a deny only the moment after a change.
    let ready: (CardOption) -> Bool
    /// The cut fields opened, and opening one (kept in the model, which refuses an answer until all are open).
    let opened: Set<String>
    let onOpen: (String) -> Void
    /// Why the buttons wait, in one line (the model's), and the report that the heading is on screen.
    let waitReason: String?
    let onSighted: (String) -> Void
    /// The report that an opened field's last line has been on screen.
    let onReadEnd: (String, String) -> Void
    /// A plugin OK's checkboxes: whether each is ticked now, and ticking one (kept in the model, sent with an approve).
    var ticked: (String) -> Bool = { _ in false }
    var onTick: (String) -> Void = { _ in }
    /// The report that one box of an opened cut list has been on screen (box id, surface).
    var onBoxSeen: (String, String) -> Void = { _, _ in }
    @Environment(\.nowMs) private var nowOverride
    @Environment(\.dynamicTypeSize) private var typeSize

    /// `note` says why the card can't be answered (expired, answered elsewhere, failed); `onSettle` then dismisses it (or, after a failure, lets the person try again).
    public init(card: Card, busy: Bool = false, note: CardNote? = nil, ready: @escaping (CardOption) -> Bool = { _ in true }, opened: Set<String> = [], onOpen: @escaping (String) -> Void = { _ in },
                waitReason: String? = nil, onSighted: @escaping (String) -> Void = { _ in }, onReadEnd: @escaping (String, String) -> Void = { _, _ in },
                onAnswer: @escaping (CardOption) -> Void, onSettle: @escaping () -> Void = {}) {
        self.card = card; self.busy = busy; self.note = note; self.ready = ready; self.opened = opened; self.onOpen = onOpen
        self.waitReason = waitReason; self.onSighted = onSighted; self.onReadEnd = onReadEnd
        self.onAnswer = onAnswer; self.onSettle = onSettle
    }
    /// A convenience for the cards a `CardsModel` holds: its gates, its opened fields, its answer.
    public init(card: Card, in model: CardsModel) {
        self.init(card: card, busy: model.answering.contains(card.id), note: model.note(for: card), ready: { model.mayAnswer(card, with: $0) },
                  opened: model.opened[card.id] ?? [], onOpen: { model.open($0, of: card) },
                  waitReason: model.waitReason(card), onSighted: { model.sighted(card, on: $0) }, onReadEnd: { model.readEnd($0, of: card, on: $1) },
                  onAnswer: { o in Task { await model.answer(card, with: o) } },
                  onSettle: { model.note(for: card) == .failed ? model.clearFailure(card) : model.dismiss(card) })
        self.ticked = { model.isTicked($0, of: card) }
        self.onTick = { model.toggle($0, of: card) }
        self.onBoxSeen = { model.boxSeen($0, of: card, on: $1) }
    }
    private var unopened: Int { card.cutFields.subtracting(opened).count }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                // The heading counts as seen by its first line, wholly inside what the bars leave visible: what follows
                // down to the buttons is passed on the way to them.
                Text(Sealed.visible(card.title)).font(.headline)
                    .overlay(alignment: .top) { Color.clear.frame(height: 12).whenSeen(onSighted).id(card.hash) }
                if let what = card.what { cutText(what, name: "what", limit: Card.Cut.text).font(.subheadline).foregroundStyle(Theme.subtle) }
            }
            ForEach(shownFields, id: \.0) { name, value in
                field(name, value)
            }
            if let kids = card.children, !kids.isEmpty { checkboxes(kids) }
            footer
            if let note {
                VStack(alignment: .leading, spacing: 8) {
                    Label(note.text, systemImage: note == .failed ? "exclamationmark.circle" : "clock.badge.xmark")
                        .font(.footnote).foregroundStyle(Theme.subtle)
                    Button { onSettle() } label: { Text(note == .failed ? "Try again" : "Dismiss").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered).tint(.primary)
                }
            } else if !card.drawnWhole {
                // A field this phone doesn't know how to draw: what the person would approve isn't all on screen.
                Label("Answer this one on your computer: it carries something this phone can't show.", systemImage: "desktopcomputer")
                    .font(.footnote).foregroundStyle(Theme.subtle).fixedSize(horizontal: false, vertical: true)
            } else {
                // Why the buttons wait, in one line, never silently: what is approved is what was on screen.
                if let why = waitReason ?? (unopened > 0 ? (unopened == 1 ? "Open the part cut short above first." : "Open the \(unopened) parts cut short above first.") : nil) {
                    Label(why, systemImage: "hand.raised").font(.footnote).foregroundStyle(Theme.subtle).fixedSize(horizontal: false, vertical: true)
                }
                (card.options.count > 2 ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))) {
                    ForEach(card.options) { option in
                        Button { onAnswer(option) } label: {
                            Text(Sealed.visible(option.label)).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(option.kind == .approve ? Theme.accent : Theme.subtle)
                        .controlSize(.regular)
                        .disabled(busy || !ready(option) || (option.kind == .approve && unopened > 0))
                        .accessibilityLabel(option.rememberAlways ? "\(option.label), and remember" : option.label)
                        .accessibilityHint(option.kind == .approve ? "Approves this request" : "Refuses this request")
                    }
                }
            }
        }
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.primary.opacity(0.14), lineWidth: 0.5))
        // A settled card keeps its full contrast: its note says it is settled (a faded card failed the contrast audit).
        .accessibilityElement(children: .contain)
    }

    /// Every field the protocol lists (`CARD_FIELD_NAMES`) after the heading's two, in the desktop's order; `computer` sits in the footer.
    private var shownFields: [(String, SealedValue)] {
        Card.bodyFields.compactMap { name in card.fields[name].map { (name, $0) } }
    }

    @ViewBuilder private func field(_ name: String, _ value: SealedValue) -> some View {
        switch value {
        case .text(let t):
            if name == "computer" { EmptyView() }   // shown in the footer
            else { labelled(name) { cutText(t, name: name, limit: Card.Cut.text).font(.callout) } }
        case .code(let c, _):
            labelled(name) {
                cutText(c, name: name, limit: Card.Cut.code)
                    .font(.system(.footnote, design: .monospaced))
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        case .list(let items):
            labelled(name) {
                VStack(alignment: .leading, spacing: 2) {
                    let open = opened.contains(name) || items.count <= Card.Cut.items
                    ForEach(Array((open ? items : Array(items.prefix(Card.Cut.items))).enumerated()), id: \.offset) { _, i in
                        Text(Sealed.visible(i)).font(.system(.footnote, design: .monospaced))
                    }
                    if !open { showAll(name, "Cut short: \(items.count - Card.Cut.items) more. Show all \(items.count)") }
                    endMarker(name)
                }
            }
        case .rows(let rows):
            labelled(name) { VStack(alignment: .leading, spacing: 4) {
                let open = opened.contains(name) || rows.count <= Card.Cut.items
                ForEach(Array((open ? rows : Array(rows.prefix(Card.Cut.items))).enumerated()), id: \.offset) { _, r in
                    (typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline))) {
                        Text(Sealed.visible(r.label)).foregroundStyle(Theme.subtle)
                        if !typeSize.isAccessibilitySize { Spacer(minLength: 12) }
                        Text(Sealed.visible(r.value)).multilineTextAlignment(typeSize.isAccessibilitySize ? .leading : .trailing)
                    }.font(.callout)
                }
                if !open { showAll(name, "Cut short: \(rows.count - Card.Cut.items) more. Show all \(rows.count)") }
                endMarker(name)
            } }
        }
    }

    /// A plugin OK's checkboxes, one per child, above the buttons (so passed on the way to them), as the desktop draws them:
    /// a ticked one is covered by Allow. More than eight are cut like a list, and opened and read to their end before Allow.
    @ViewBuilder private func checkboxes(_ kids: [Card.Child]) -> some View {
        let name = Card.childrenField
        let open = opened.contains(name) || kids.count <= Card.Cut.items
        labelled(name) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(open ? kids : Array(kids.prefix(Card.Cut.items)), id: \.id) { kid in
                    let on = ticked(kid.id)
                    Button { onTick(kid.id) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: on ? "checkmark.square.fill" : "square").font(.body)
                                .foregroundStyle(on ? Theme.accent : Theme.subtle).accessibilityHidden(true)
                            // One line of its own: its line breaks shown (⏎), so a label never starts a row that looks like another
                            // checkbox; a long label wraps under its own text, never in the boxes' column, and nothing of it is hidden.
                            Text(Card.Child.oneLine(Sealed.visible(kid.label))).font(.callout).foregroundStyle(.primary).multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: 44).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    // In an opened cut list each box reports itself seen (whole, in a settled frame): all must be, not
                    // only the list's end, before Allow (a fast scroll could pass the middle unseen).
                    .modifier(BoxSeen(active: opened.contains(name) && kids.count > Card.Cut.items, key: card.hash) { onBoxSeen(kid.id, $0) })
                    .disabled(busy || note != nil)
                    .accessibilityLabel(Card.Child.oneLine(Sealed.visible(kid.label)))
                    .accessibilityValue(on ? "ticked" : "not ticked")
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier("child-\(kid.id)")
                }
                if !open { showAll(name, "Cut short: \(kids.count - Card.Cut.items) more. Show all \(kids.count)") }
                endMarker(name)
            }
        }
    }

    /// A box's own seen report, only where its list is opened and cut (keyed on the card's content, so new content of the
    /// same height is reported again).
    private struct BoxSeen: ViewModifier {
        let active: Bool
        let key: String
        let seen: (String) -> Void
        func body(content: Content) -> some View {
            if active { content.background { Color.clear.whenSeen(seen).id(key) } } else { content }
        }
    }

    private func labelled<C: View>(_ name: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let l = Self.labels[name] { Text(l).font(.caption).foregroundStyle(Theme.subtle) }
            content()
        }
    }
    /// The desktop's words for each field (its sealed page's `FIELD_TITLES`); `rule` has none there, so it says what it is.
    static let labels = ["command": "Command", "computer": "Computer", "risk": "Risk", "reason": "Why", "source": "From", "host": "Site",
                         "paths": "Files", "detail": "Everything it sends", "expires": "Expires", "rule": "What Always would save",
                         "children": "Allow covers the ticked ones"]

    /// A long field is cut openly: it says how much is hidden and offers the rest.
    @ViewBuilder private func cutText(_ s: String, name: String, limit: Int) -> some View {
        let cut = Sealed.cut(s, limit: limit)
        VStack(alignment: .leading, spacing: 4) {
            Text(opened.contains(name) ? Sealed.visible(s) : cut.shown)
            if cut.hiddenCount > 0 && !opened.contains(name) { showAll(name, "Cut short: \(cut.hiddenCount) more characters. Show all") }
            endMarker(name)
        }
    }
    /// After an opened field: its end, reported once it has been on screen (only then does the field count as read).
    @ViewBuilder private func endMarker(_ name: String) -> some View {
        if opened.contains(name) { Color.clear.frame(height: 1).whenSeen { onReadEnd(name, $0) }.id(card.hash) }
    }
    /// Opens a cut field in place.
    private func showAll(_ name: String, _ label: String) -> some View {
        // A footnote-sized line, but a full 44-point target (the accessibility audit's hit area), the whole row's width.
        Button { onOpen(name) } label: {
            Text(label).font(.footnote).foregroundStyle(Theme.subtle).underline()
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("showAll-\(name)")
    }

    private var footer: some View {
        (typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 6))) {
            if case .text(let c)? = card.fields["computer"] { Label("on \(Sealed.visible(c))", systemImage: "desktopcomputer") }
            if !typeSize.isAccessibilitySize { Spacer() }
            if let left = secondsLeft { Text("Expires in \(left / 60) min") }
        }
        .font(.caption).foregroundStyle(Theme.subtle)
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
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if model.loadFailed { UnreachableNotice(onRetry: { Task { await model.load() } }).padding(14).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.primary.opacity(0.14), lineWidth: 0.5)) }
                // In the order they came: a new card joins at the end and never moves the list under the person's finger.
                ForEach(model.cards) { card in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(who(card)).font(.footnote).foregroundStyle(Theme.subtle).padding(.leading, 6)
                            .accessibilityAddTraits(.isHeader)
                        CardView(card: card, in: model)
                    }
                }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
            .cardContent()
        }
        .cardViewport(model)
        .background(Color(uiColor: .systemGroupedBackground))
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
