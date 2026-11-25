import Foundation
import Observation

/// Why a card on the screen can no longer be answered.
public enum CardNote: Equatable, Sendable {
    case expired
    case answeredElsewhere
    case failed
    public var text: String {
        switch self {
        case .expired: return "This card expired before it was answered."
        case .answeredElsewhere: return "Already answered on another device."
        case .failed: return "That didn't work. The card is still waiting."
        }
    }
}

/// The cards waiting for the person. Which of them this app shows is the client's answer (`shows(_:in:)`).
@MainActor @Observable
public final class CardsModel {
    public private(set) var cards: [Card] = []
    public private(set) var answering: Set<String> = []
    public private(set) var notes: [String: CardNote] = [:]
    public private(set) var loadFailed = false
    public private(set) var loaded = false
    @ObservationIgnored private let client: EngineClient
    @ObservationIgnored private let app: PhoneApp
    @ObservationIgnored private let now: @Sendable () -> Int64
    @ObservationIgnored private var listener: Task<Void, Never>?
    @ObservationIgnored private var answeredHere: Set<String> = []

    public init(client: EngineClient, app: PhoneApp, now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.client = client; self.app = app; self.now = now
    }

    /// Cards still waiting for an answer (not expired, not answered elsewhere).
    public var waitingCount: Int { cards.filter { note(for: $0) == nil }.count }

    /// The state a card is in: a note when it can't be answered.
    public func note(for card: Card) -> CardNote? {
        if let n = notes[card.id] { return n }
        if card.expiresAt <= now() { return .expired }
        return nil
    }

    public func load() async {
        do {
            let all = try await client.cards()
            var mine: [Card] = []
            for c in all where await client.shows(c, in: app) { mine.append(c) }
            cards = mine
            // A card we hold but the engine no longer lists was settled elsewhere.
            loadFailed = false
        } catch { loadFailed = true }
        loaded = true
    }

    public func start() {
        guard listener == nil else { return }
        listener = Task { [weak self] in
            guard let self else { return }
            let stream = await client.events()
            await self.load()
            for await event in stream {
                await self.apply(event)
                if case .connection(.connected) = event { await self.load() }
            }
        }
    }
    public func stopListening() { listener?.cancel(); listener = nil }

    public func apply(_ event: EngineEvent) async {
        switch event {
        case .cardRequested(let c):
            guard await client.shows(c, in: app) else { break }
            // The same card again with new content replaces the one on screen, in its place (never stale text whose press fails).
            if let i = cards.firstIndex(where: { $0.id == c.id }) { if cards[i] != c { cards[i] = c; notes[c.id] = nil } }
            else { cards.append(c) }
        case .cardResolved(let id):
            if answeredHere.contains(id) { cards.removeAll { $0.id == id } }
            else if cards.contains(where: { $0.id == id }) { notes[id] = .answeredElsewhere }
        default: break
        }
    }

    public func answer(_ card: Card, with option: CardOption) async {
        guard !answering.contains(card.id), note(for: card) == nil else { return }
        answering.insert(card.id)
        defer { answering.remove(card.id) }
        do {
            answeredHere.insert(card.id)
            try await client.answer(card: card, option: option)
            cards.removeAll { $0.id == card.id }
            notes[card.id] = nil
        } catch let e as CardAnswerError {
            answeredHere.remove(card.id)
            notes[card.id] = e == .expired ? .expired : .answeredElsewhere
        } catch {
            answeredHere.remove(card.id)
            notes[card.id] = .failed
        }
    }

    /// Takes a settled card off the screen.
    public func dismiss(_ card: Card) {
        cards.removeAll { $0.id == card.id }
        notes[card.id] = nil
    }
    /// Lets a failed answer be tried again.
    public func clearFailure(_ card: Card) { if notes[card.id] == .failed { notes[card.id] = nil } }
}
