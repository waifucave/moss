import Foundation
import Observation

/// The cards waiting for the person. Which of them a screen shows is its `filter`: MOSS the bots' cards, MOSS Code the sessions'.
@MainActor @Observable
public final class CardsModel {
    public private(set) var cards: [Card] = []
    public private(set) var answering: Set<String> = []
    public private(set) var errorText: String?
    @ObservationIgnored private let client: EngineClient
    @ObservationIgnored private let filter: @Sendable (Card) -> Bool
    @ObservationIgnored private var listener: Task<Void, Never>?

    public init(client: EngineClient, filter: @escaping @Sendable (Card) -> Bool) {
        self.client = client; self.filter = filter
    }

    /// Cards that belong to a bot (MOSS) or to a session with no bot (MOSS Code).
    public static let forBots: @Sendable (Card) -> Bool = { $0.bot != nil }
    public static let forSessions: @Sendable (Card) -> Bool = { $0.bot == nil }

    public func load() async {
        do { cards = try await client.cards().filter(filter); errorText = nil }
        catch { errorText = "Can't reach your computer." }
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
        switch event {
        case .cardRequested(let c) where filter(c):
            if !cards.contains(where: { $0.id == c.id }) { cards.append(c) }
        case .cardResolved(let id): cards.removeAll { $0.id == id }
        default: break
        }
    }

    public func answer(_ card: Card, with option: CardOption) async {
        guard !answering.contains(card.id) else { return }
        answering.insert(card.id)
        defer { answering.remove(card.id) }
        do {
            try await client.answer(card: card, option: option)
            cards.removeAll { $0.id == card.id }
            errorText = nil
        } catch {
            errorText = "That didn't work. The card is still waiting."
        }
    }
}
