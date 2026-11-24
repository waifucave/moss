import Foundation
import Observation

/// Where the phone keeps which bots the person pinned (the engine has no such field, so it is the phone's own).
public protocol PinStore: AnyObject {
    var pinned: [String] { get set }
}
public final class MemoryPinStore: PinStore {
    public var pinned: [String]
    public init(_ pinned: [String] = []) { self.pinned = pinned }
}
public final class DefaultsPinStore: PinStore {
    private let key: String
    private let defaults: UserDefaults
    public init(key: String = "moss.pinnedBots", defaults: UserDefaults = .standard) { self.key = key; self.defaults = defaults }
    public var pinned: [String] {
        get { defaults.stringArray(forKey: key) ?? [] }
        set { defaults.set(newValue, forKey: key) }
    }
}

/// One line of the bots list.
public struct BotRow: Identifiable, Hashable, Sendable {
    public var bot: Bot
    public var summary: BotSummary?
    public var statusLine: String?
    public var id: String { bot.id }
    public var unread: Bool { summary?.unread ?? false }
    public var lastAt: Int64 { summary?.last?.at ?? 0 }
}

@MainActor @Observable
public final class BotsListModel {
    public private(set) var rows: [BotRow] = []
    public private(set) var loaded = false
    public private(set) var errorText: String?
    public private(set) var connection: ConnectionState = .connected
    public var loadFailed: Bool { errorText != nil }
    public private(set) var pinnedIDs: [String]

    @ObservationIgnored private let client: EngineClient
    @ObservationIgnored private let store: PinStore
    @ObservationIgnored private var bots: [Bot] = []
    @ObservationIgnored private var summaries: [String: BotSummary] = [:]
    @ObservationIgnored private var lines: [String: String] = [:]   // by main session id
    @ObservationIgnored private var listener: Task<Void, Never>?

    public init(client: EngineClient, store: PinStore) {
        self.client = client; self.store = store; self.pinnedIDs = store.pinned
    }

    /// The pinned bots, in the order the person pinned them: the large faces on top.
    public var pinned: [BotRow] { pinnedIDs.compactMap { id in rows.first { $0.id == id } } }
    /// The rest, newest conversation first.
    public var others: [BotRow] {
        rows.filter { !pinnedIDs.contains($0.id) }.sorted { ($0.lastAt, $1.bot.name) > ($1.lastAt, $0.bot.name) }
    }
    public var unreadCount: Int { rows.filter(\.unread).count }

    public func load() async {
        connection = await client.connectionState()
        do {
            bots = try await client.bots()
            summaries = Dictionary(uniqueKeysWithValues: try await client.botSummaries().map { ($0.id, $0) })
            errorText = nil
        } catch {
            errorText = "Can't reach your computer."
        }
        loaded = true
        rebuild()
    }

    public func start() {
        guard listener == nil else { return }
        listener = Task { [weak self] in
            guard let self else { return }
            let stream = await client.events()
            await self.load()
            for await event in stream {
                self.apply(event)
                // Typed events carry no ordering, so after the link comes back the lists are read again rather than patched across the gap.
                if case .connection(.connected) = event { await self.load() }
            }
        }
    }
    public func stop() { listener?.cancel(); listener = nil }

    public func togglePin(_ id: String) {
        if let i = pinnedIDs.firstIndex(of: id) { pinnedIDs.remove(at: i) } else { pinnedIDs.append(id) }
        store.pinned = pinnedIDs
    }
    public func isPinned(_ id: String) -> Bool { pinnedIDs.contains(id) }

    public func apply(_ event: EngineEvent) {
        switch event {
        case .botChanged(let b):
            if let i = bots.firstIndex(where: { $0.id == b.id }) { bots[i] = b } else { bots.append(b) }
        case .botSummaryChanged(let s): summaries[s.id] = s
        case .statusLine(let subject, let line): lines[subject] = line
        case .message(let subject, let m):
            if let b = bots.first(where: { $0.mainSession == subject }), m.role != .note {
                summaries[b.id] = BotSummary(id: b.id, last: .init(text: m.text, from: m.role == .user ? .user : .bot, at: m.at), unread: m.role != .user)
            }
        case .connection(let c): connection = c
        default: break
        }
        rebuild()
    }

    private func rebuild() {
        rows = bots.map { BotRow(bot: $0, summary: summaries[$0.id], statusLine: lines[$0.mainSession]) }
    }
}
