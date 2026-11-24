import SwiftUI

/// MOSS Code's sessions, grouped by project folder as the desktop's sidebar groups them.
public struct SessionsScreen: View {
    @Bindable var model: SessionsListModel
    let computer: String?
    let onSettings: () -> Void
    let onNew: () -> Void
    @Environment(\.nowMs) private var nowOverride

    public init(model: SessionsListModel, computer: String?, onSettings: @escaping () -> Void = {}, onNew: @escaping () -> Void = {}) {
        self.model = model; self.computer = computer; self.onSettings = onSettings; self.onNew = onNew
    }
    private var since: Int64? { if case .unreachable(let s) = model.connection { return s } else { return nil } }

    public var body: some View {
        List {
            if model.loadFailed || model.connection != .connected {
                Section { UnreachableNotice(computer: computer, since: since, onRetry: { Task { await model.load() } }) }
            }
            ForEach(model.groups) { group in
                Section(group.project) {
                    ForEach(group.sessions) { s in
                        NavigationLink(value: s) { SessionListRow(session: s, now: nowOverride ?? Int64(Date().timeIntervalSince1970 * 1000)) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if !model.loaded { ProgressView("Loading").controlSize(.large) }
            else if model.groups.isEmpty, !model.loadFailed {
                ContentUnavailableView {
                    Label("No sessions", systemImage: "terminal")
                } description: { Text("Start one here, or on your computer.") } actions: {
                    Button("New session", action: onNew).buttonStyle(.bordered).tint(Theme.accent)
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button(action: onSettings) { Image(systemName: "gearshape") }.accessibilityLabel("Settings") }
            ToolbarItem(placement: .topBarTrailing) { Button(action: onNew) { Image(systemName: "plus") }.accessibilityLabel("New session") }
        }
        .navigationTitle("Sessions")
        .navigationSubtitle(computer ?? "")
        .task { model.start() }
    }
}

struct SessionListRow: View {
    let session: SessionRow
    let now: Int64
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentMarkView(backend: session.backend, size: 32)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(session.title ?? "Untitled").font(.headline).lineLimit(2)
                    Spacer(minLength: 8)
                    Text(TimeText.short(at: session.updatedAt, now: now)).font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    if session.badge != .none { Badge(session.badge) }
                    Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(session.title ?? "Untitled"). \(AgentLook.of(session.backend).name)\(session.model.map { ", " + $0 } ?? ""). \(session.badge == .none ? "" : session.badge.rawValue)")
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
