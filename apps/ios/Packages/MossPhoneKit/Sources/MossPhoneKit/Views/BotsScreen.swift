import SwiftUI

/// MOSS's first screen: a top row, three pinned faces, then plain rows. Nothing else.
public struct BotsScreen: View {
    @Bindable var model: BotsListModel
    let cards: CardsModel
    @Environment(\.nowMs) private var nowOverride
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var searching = false
    @State private var query = ""
    let computer: String?
    let onSettings: () -> Void
    let onBell: () -> Void
    let onNew: () -> Void
    let onOpen: (Bot) -> Void

    public init(model: BotsListModel, cards: CardsModel, computer: String?, onSettings: @escaping () -> Void = {}, onBell: @escaping () -> Void = {},
                onNew: @escaping () -> Void = {}, onOpen: @escaping (Bot) -> Void = { _ in }) {
        self.model = model; self.cards = cards; self.computer = computer; self.onSettings = onSettings; self.onBell = onBell; self.onNew = onNew; self.onOpen = onOpen
    }

    private var since: Int64? { if case .unreachable(let s) = model.connection { return s } else { return nil } }
    private var now: Int64 { nowOverride ?? Int64(Date().timeIntervalSince1970 * 1000) }

    /// The bots with a card waiting, by id.
    private var waitingBots: Set<String> {
        var ids = Set<String>()
        for c in cards.cards where cards.note(for: c) == nil {
            if let b = c.bot { ids.insert(b) } else if let r = model.rows.first(where: { $0.bot.mainSession == c.session }) { ids.insert(r.id) }
        }
        return ids
    }
    private var found: [BotRow] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return model.rows.filter { r in q.isEmpty || r.bot.name.lowercased().contains(q) || (r.summary?.last?.text.lowercased().contains(q) ?? false) }
    }
    private var searchingNow: Bool { searching }

    public var body: some View {
        let waiting = waitingBots
        List {
            TopBar(waiting: cards.waitingCount, plusLabel: "New bot", onSettings: onSettings, onBell: onBell,
                   onSearch: { searching = true }, onPlus: onNew)
                .listRow()
            if searchingNow {
                SearchField(text: $query, prompt: "Search bots and what was said", onCancel: { searching = false; query = "" })
                    .listRow(top: 8, bottom: 8)
            }
            if model.loadFailed || model.connection != .connected {
                UnreachableNotice(computer: computer, since: since, onRetry: { Task { await model.load() } }).listRow(top: 8, bottom: 8)
            }
            if !searchingNow, !model.pinned.isEmpty {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .top), count: typeSize.isAccessibilitySize ? 1 : 3), spacing: 16) {
                    ForEach(model.pinned) { row in
                        Button { onOpen(row.bot) } label: { PinnedFace(row: row, waiting: waiting.contains(row.id)) }
                            .buttonStyle(.plain)
                            .contextMenu { Button("Unpin", systemImage: "pin.slash") { model.togglePin(row.id) } }
                    }
                }
                .listRow(top: 12, bottom: 8)
            }
            ForEach(searchingNow ? found : model.others) { row in
                NavigationLink(value: row.bot) { BotListRow(row: row, now: now, waiting: waiting.contains(row.id)) }
                    .navigationLinkIndicatorVisibility(.hidden)
                    .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .swipeActions(edge: .leading) {
                        Button { model.togglePin(row.id) } label: { Label(model.pinnedIDs.contains(row.id) ? "Unpin" : "Pin", systemImage: model.pinnedIDs.contains(row.id) ? "pin.slash" : "pin") }.tint(.gray)
                    }
                    .contextMenu { Button(model.pinnedIDs.contains(row.id) ? "Unpin" : "Pin to the top", systemImage: "pin") { model.togglePin(row.id) } }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(uiColor: .systemBackground))
        .overlay {
            if !model.loaded { ProgressView("Loading").controlSize(.large) }
            else if model.rows.isEmpty, !model.loadFailed { ContentUnavailableView("No bots yet", systemImage: "face.smiling", description: Text("Make a bot on your computer and it shows here.")).padding(.top, 80) }
            else if searchingNow, found.isEmpty { ContentUnavailableView.search(text: query).padding(.top, 80) }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { model.start() }
    }
}

extension View {
    /// A list row with no background, no separator and the screen's 20 pt side margins.
    func listRow(top: CGFloat = 0, bottom: CGFloat = 0) -> some View {
        self.listRowInsets(EdgeInsets(top: top, leading: 20, bottom: bottom, trailing: 20))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

struct PinnedFace: View {
    let row: BotRow
    let waiting: Bool
    var body: some View {
        VStack(spacing: 8) {
            BotFaceView(name: row.bot.name, face: row.bot.face, mood: mood, size: 76)
                .overlay(alignment: .bottomTrailing) { if row.unread { UnreadDot(size: 14) } }
                .overlay(alignment: .topTrailing) { if waiting { Circle().fill(Theme.waiting).frame(width: 14, height: 14).overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2)).accessibilityHidden(true) } }
            Text(row.bot.name).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.bot.name)\(waiting ? ", needs you" : "")\(row.unread ? ", unread" : "")\(row.statusLine.map { ", " + $0 } ?? "")")
        .accessibilityAddTraits(.isButton)
    }
    private var mood: BotFaceView.Mood { row.statusLine != nil ? .working : (row.bot.state ?? .idle).faceMood }
}

struct BotListRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let row: BotRow
    let now: Int64
    let waiting: Bool
    var body: some View {
        HStack(spacing: 14) {
            BotFaceView(name: row.bot.name, face: row.bot.face, mood: row.statusLine != nil ? .working : (row.bot.state ?? .idle).faceMood, size: typeSize.isAccessibilitySize ? 40 : 48)
                .overlay(alignment: .bottomTrailing) { if row.unread { UnreadDot(size: 13).offset(x: 2, y: 2) } }
            VStack(alignment: .leading, spacing: 2) {
                (typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0)) : AnyLayout(HStackLayout())) {
                    Text(row.bot.name).font(.body.weight(.semibold)).lineLimit(1)
                    if !typeSize.isAccessibilitySize { Spacer(minLength: 8) }
                    if row.lastAt > 0 { Text(TimeText.stamp(at: row.lastAt, now: now)).font(.subheadline).foregroundStyle(.secondary) }
                }
                HStack(spacing: 6) {
                    if waiting { NeedsYouTag() }
                    Text(line).font(.subheadline).foregroundStyle(.secondary).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                }
            }
        }
        .padding(.vertical, 14)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.bot.name). \(waiting ? "Needs you. " : "")\(line)\(row.unread ? ". Unread" : "")")
    }
    private var line: String {
        if let s = row.statusLine { return s }
        switch row.bot.state {
        case .asleep?: return row.summary?.last?.text ?? "Asleep: no computer that can run it is on."
        case .paused?: return "Paused"
        default: return row.summary?.last?.text ?? "No messages yet"
        }
    }
}
