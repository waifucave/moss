import Foundation
import Observation

/// The new-bot sheet: a name, and a model with the computer's default preselected.
@MainActor @Observable
public final class NewBotModel {
    public var name = ""
    public var model: String?
    public private(set) var options: NewBotOptions?
    public private(set) var loading = true
    public private(set) var errorText: String?
    public private(set) var creating = false
    @ObservationIgnored private let client: EngineClient

    public init(client: EngineClient) { self.client = client }

    public var canCreate: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !creating }

    public func load() async {
        loading = true
        do {
            let o = try await client.newBotOptions()
            options = o
            if model == nil { model = o.defaultModel ?? o.models.first?.id }
            errorText = nil
        } catch { errorText = "Can't reach your computer." }
        loading = false
    }

    /// Makes the bot; returns it so its conversation can open. A refusal leaves the sheet as it was.
    public func create() async -> Bot? {
        guard canCreate else { return nil }
        creating = true; defer { creating = false }
        do { let b = try await client.createBot(name: name.trimmingCharacters(in: .whitespacesAndNewlines), model: model); errorText = nil; return b }
        catch let e as BotCreateRefused { errorText = e.message; return nil }
        catch is MayHaveReached { errorText = "Your computer didn't answer, so the bot may have been made. Check your bots before trying again."; return nil }
        catch { errorText = "The bot wasn't made. Check that your computer is on and try again."; return nil }
    }
}
