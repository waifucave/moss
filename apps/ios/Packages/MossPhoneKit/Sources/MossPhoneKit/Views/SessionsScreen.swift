import SwiftUI

/// MOSS Code's first screen: the same top row and plain rows as MOSS, with a session's mark where a bot's face is,
/// grouped by project folder under small grey headings.
public struct SessionsScreen: View {
    @Bindable var model: SessionsListModel
    let cards: CardsModel
    let computer: String?
    let onSettings: () -> Void
    let onBell: () -> Void
    let onNew: () -> Void
    @Environment(\.nowMs) private var nowOverride
    @State private var searching = false
    @State private var query = ""

    public init(model: SessionsListModel, cards: CardsModel, computer: String?, onSettings: @escaping () -> Void = {}, onBell: @escaping () -> Void = {}, onNew: @escaping () -> Void = {}) {
        self.model = model; self.cards = cards; self.computer = computer; self.onSettings = onSettings; self.onBell = onBell; self.onNew = onNew
    }
    private var since: Int64? { if case .unreachable(let s) = model.connection { return s } else { return nil } }
    private var now: Int64 { nowOverride ?? Int64(Date().timeIntervalSince1970 * 1000) }
    private var waiting: Set<String> { Set(cards.cards.filter { cards.note(for: $0) == nil }.compactMap(\.session)) }
    private var groups: [SessionGroup] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return model.groups }
        return model.groups.compactMap { g in
            let hit = g.sessions.filter { ($0.title ?? "").lowercased().contains(q) || g.project.lowercased().contains(q) || ($0.branch ?? "").lowercased().contains(q) }
            return hit.isEmpty ? nil : SessionGroup(project: g.project, sessions: hit)
        }
    }

    public var body: some View {
        let waiting = waiting
        List {
            TopBar(waiting: cards.waitingCount, plusLabel: "New session", onSettings: onSettings, onBell: onBell, onSearch: { searching = true }, onPlus: onNew)
                .listRow()
            if searching {
                SearchField(text: $query, prompt: "Search sessions", onCancel: { searching = false; query = "" }).listRow(top: 8, bottom: 8)
            }
            if model.loadFailed || model.connection != .connected {
                UnreachableNotice(computer: computer, since: since, onRetry: { Task { await model.load() } }).listRow(top: 8, bottom: 8)
            }
            ForEach(groups) { group in
                Section {
                    ForEach(group.sessions) { s in
                        NavigationLink(value: s) { SessionListRow(session: s, now: now, waiting: waiting.contains(s.id)) }
                            .navigationLinkIndicatorVisibility(.hidden)
                            .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                } header: {
                    Text(group.project).font(.footnote).foregroundStyle(.secondary).textCase(nil)
                        .padding(.leading, 4).accessibilityAddTraits(.isHeader)
                }
                .listSectionSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(uiColor: .systemBackground))
        .overlay {
            if !model.loaded { ProgressView("Loading").controlSize(.large) }
            else if model.groups.isEmpty, !model.loadFailed {
                ContentUnavailableView {
                    Label("No sessions", systemImage: "terminal")
                } description: { Text("Start one here, or on your computer.") } actions: {
                    Button("New session", action: onNew).buttonStyle(.bordered).tint(Theme.accent)
                }.padding(.top, 80)
            } else if searching, groups.isEmpty { ContentUnavailableView.search(text: query).padding(.top, 80) }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { model.start() }
    }
}

struct SessionListRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let session: SessionRow
    let now: Int64
    let waiting: Bool
    var body: some View {
        HStack(spacing: 14) {
            AgentMarkView(backend: session.backend, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                (typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline))) {
                    Text(session.title ?? "Untitled").font(.body.weight(.semibold)).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                    if !typeSize.isAccessibilitySize { Spacer(minLength: 8) }
                    Text(TimeText.stamp(at: session.updatedAt, now: now)).font(.subheadline).foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    if waiting || session.badge == .needsYou { NeedsYouTag() }
                    else if session.badge != .none { Text(session.badge.rawValue).font(.subheadline.weight(.medium)).foregroundStyle(.primary) }
                    Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                }
            }
        }
        .padding(.vertical, 14)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(session.title ?? "Untitled"). \(AgentLook.of(session.backend).name)\(session.model.map { ", " + $0 } ?? ""). \(waiting || session.badge == .needsYou ? "Needs you" : (session.badge == .none ? "" : session.badge.rawValue))")
    }
    private var detail: String {
        [session.model, session.branch].compactMap { $0 }.joined(separator: " · ")
    }
}

struct Badge: View {
    let kind: SessionBadge
    init(_ kind: SessionBadge) { self.kind = kind }
    var body: some View {
        Text(kind.rawValue)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 7).padding(.vertical, 2)
            .foregroundStyle(kind == .needsYou ? Color(uiColor: .systemBackground) : Color.primary)
            .background(kind == .needsYou ? Color.primary : Color.primary.opacity(0.12), in: Capsule())
    }
}
