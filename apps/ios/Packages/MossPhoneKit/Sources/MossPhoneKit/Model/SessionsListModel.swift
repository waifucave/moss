import Foundation
import Observation

/// How a session row says what it is doing, in one word.
public enum SessionBadge: String, Sendable {
    case needsYou = "Needs you", running = "Running", waiting = "Waiting", stopped = "Stopped", failed = "Failed", none = ""
}

public struct SessionGroup: Identifiable, Hashable, Sendable {
    public var project: String
    public var sessions: [SessionRow]
    public var id: String { project }
}

public extension SessionRow {
    /// Needs you wins, then what the session is doing (`sessionMotion`).
    var badge: SessionBadge {
        if let n = needsYou, n.total > 0 { return .needsYou }
        switch motion {
        case .running: return .running
        case .waiting: return .waiting
        case .ended: return status == .failed ? .failed : .stopped
        case .still: return .none
        }
    }
}

/// The sessions list, grouped as the desktop's sidebar groups it: by project folder, a session's own title and mark on each row.
@MainActor @Observable
public final class SessionsListModel {
    public private(set) var sessions: [SessionRow] = []
    public private(set) var loaded = false
    public private(set) var errorText: String?
    @ObservationIgnored private let client: EngineClient
    @ObservationIgnored private var listener: Task<Void, Never>?

    public init(client: EngineClient) { self.client = client }

    /// Groups ordered by their newest session; sessions inside newest first. Archived sessions and bots' own threads stay out.
    public var groups: [SessionGroup] {
        let visible = sessions.filter { $0.archived != true && $0.bot == nil && $0.parent == nil }
        let grouped = Dictionary(grouping: visible, by: \.project)
        return grouped.map { SessionGroup(project: $0.key.isEmpty ? "No project" : $0.key, sessions: $0.value.sorted { $0.updatedAt > $1.updatedAt }) }
            .sorted { ($0.sessions.first?.updatedAt ?? 0, $1.project) > ($1.sessions.first?.updatedAt ?? 0, $0.project) }
    }
    public var needsYouCount: Int { sessions.reduce(0) { $0 + ($1.needsYou?.total ?? 0) } }

    public func load() async {
        do { sessions = try await client.sessions(); errorText = nil }
        catch { errorText = "Can't reach your computer." }
        loaded = true
    }
    public func start() {
        guard listener == nil else { return }
        listener = Task { [weak self] in
            guard let self else { return }
            let stream = await client.events()
            await self.load()
            for await event in stream { self.apply(event) }
        }
    }
    public func stopListening() { listener?.cancel(); listener = nil }

    public func apply(_ event: EngineEvent) {
        if case .sessionChanged(let s) = event {
            if let i = sessions.firstIndex(where: { $0.id == s.id }) { sessions[i] = s } else { sessions.append(s) }
        }
    }
}
