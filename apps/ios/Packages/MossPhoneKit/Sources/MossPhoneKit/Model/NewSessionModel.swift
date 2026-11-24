import Foundation
import Observation

/// Starting a coding session from the phone: the agent (the last used preselected), its model and effort (defaults
/// preselected) and the folder (folders of existing sessions first, or any path typed or pasted).
@MainActor @Observable
public final class NewSessionModel {
    public private(set) var backends: [AgentBackend] = []
    public private(set) var options: BackendOptions?
    public private(set) var folders: [String] = []
    public private(set) var loading = true
    public private(set) var loadFailed = false
    public private(set) var errorText: String?
    public private(set) var starting = false

    public var backend: String = "" { didSet { if !internalChange, oldValue != backend, !backend.isEmpty { Task { await loadOptions() } } } }
    public var model: String? { didSet { applyEffortDefault() } }
    public var effort: String?
    /// The folder the person typed or pasted; when empty, `pickedFolder` is used.
    public var typedFolder = ""
    public var pickedFolder: String?

    @ObservationIgnored private let client: EngineClient
    @ObservationIgnored private let computer: String
    @ObservationIgnored private var recent = RecentStart()
    @ObservationIgnored private var internalChange = false

    public init(client: EngineClient, computer: String) { self.client = client; self.computer = computer }

    public var folder: String { let t = typedFolder.trimmingCharacters(in: .whitespacesAndNewlines); return t.isEmpty ? (pickedFolder ?? "") : t }
    public var canStart: Bool { !backend.isEmpty && !folder.isEmpty && !starting && !loading }
    public var efforts: [String] { options?.models.first { $0.id == model }?.efforts ?? [] }
    public var modelChoices: [ModelOption] { options?.models ?? [] }

    public func load() async {
        loading = true
        do {
            let all = try await client.backends()
            recent = try await client.recentStart()
            backends = all
            folders = recent.roots
            pickedFolder = recent.roots.first
            // The last used agent, else the first one.
            let start = recent.last?.backend.nilIfMissing(in: all.map(\.id)) ?? all.first?.id ?? ""
            loadFailed = false
            internalChange = true; backend = start; internalChange = false
            if !start.isEmpty { await loadOptions() }
        } catch { loadFailed = true }
        loading = false
    }

    private func loadOptions() async {
        do {
            let o = try await client.startOptions(backend: backend)
            options = o
            let mine = recent.byBackend.first { $0.backend == backend }
            model = mine?.model.flatMap { m in o.models.contains { $0.id == m } ? m : nil } ?? o.defaultModel ?? o.models.first?.id
            let candidate = mine?.effort ?? o.defaultEffort
            effort = candidate.flatMap { e in efforts.contains(e) ? e : nil } ?? options?.models.first { $0.id == model }?.defaultEffort
        } catch { options = nil; model = nil; effort = nil }
    }

    private func applyEffortDefault() {
        guard let m = options?.models.first(where: { $0.id == model }) else { return }
        if let e = effort, m.efforts.contains(e) { return }
        effort = m.defaultEffort ?? m.efforts.first
    }

    /// Starts it; returns the new session's id, or nil with `errorText` set.
    public func start() async -> String? {
        guard canStart else { return nil }
        starting = true; defer { starting = false }
        do {
            let id = try await client.startSession(StartRequest(backend: backend, computer: computer, root: folder, model: model, effort: effort))
            errorText = nil
            return id
        } catch StartError.folderRefused {
            errorText = "That folder can't be used. Pick a folder of your computer's, not MOSS's own."
        } catch StartError.notInstalled {
            errorText = "That agent isn't installed on \(computer)."
        } catch {
            errorText = "Can't reach your computer. Nothing was started."
        }
        return nil
    }
}

private extension String {
    func nilIfMissing(in list: [String]) -> String? { list.contains(self) ? self : nil }
}
