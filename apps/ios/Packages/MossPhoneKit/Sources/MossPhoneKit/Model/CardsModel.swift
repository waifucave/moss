import Foundation
import Observation

/// Why a card on the screen can no longer be answered.
public enum CardNote: Equatable, Sendable {
    case expired
    case answeredElsewhere
    case failed
    /// The computer turned the answer away, and said why (its words, cleaned).
    case refused(String)
    public var text: String {
        switch self {
        case .expired: return "This card expired before it was answered."
        case .answeredElsewhere: return "Already answered on another device."
        case .failed: return "That didn't work. The card is still waiting."
        case .refused(let why): return "Your computer didn't take that answer: \(why)"
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
    /// Cards whose buttons wait: just arrived, changed, or moved because one above them left. A press can't land on a
    /// card that slid under the finger; the model refuses an answer inside the wait, whatever the view shows.
    public private(set) var settling: Set<String> = []
    @ObservationIgnored private var settleTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private let settleWait: Duration
    /// The cut fields the person has opened, per card: a card is answered only once every cut field was on screen.
    public private(set) var opened: [String: Set<String>] = [:]

    /// Cards whose heading has been on screen. A card is one column with its buttons last, so a person who sees the buttons
    /// and has seen the heading has had every field in between on screen (a tall card, opened at its bottom, has not).
    public private(set) var sighted: Set<String> = []
    @ObservationIgnored private let requiresSighting: Bool

    /// `requiresSighting`: the app's screens report each card's heading on screen (`sighted(_:)`); a model without views
    /// (tests over the client) leaves it off.
    public init(client: EngineClient, app: PhoneApp, now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                settleWait: Duration = .milliseconds(1200), requiresSighting: Bool = false) {
        self.client = client; self.app = app; self.now = now; self.settleWait = settleWait; self.requiresSighting = requiresSighting
    }
    public func sighted(_ card: Card) { sighted.insert(card.id) }

    /// Why the buttons don't answer now, in one line for the card, or nil when they do.
    public func waitReason(_ card: Card) -> String? {
        if !card.drawnWhole || note(for: card) != nil { return nil }
        if settling.contains(card.id) { return "Wait a moment: this card just arrived or changed." }
        if requiresSighting && !sighted.contains(card.id) { return "Scroll up to the top of this card first: answer only what you have seen." }
        let n = card.cutFields.subtracting(opened[card.id] ?? []).count
        if n > 0 { return n == 1 ? "Open the part cut short above first." : "Open the \(n) parts cut short above first." }
        return nil
    }

    /// Every cut field of the card has been opened (or it has none).
    public func seenWhole(_ card: Card) -> Bool { card.cutFields.isSubset(of: opened[card.id] ?? []) }
    public func open(_ field: String, of card: Card) { opened[card.id, default: []].insert(field) }
    /// Whether its buttons answer now: drawn whole, every cut field opened, not waiting, not busy, nothing noted.
    public func mayAnswer(_ card: Card) -> Bool {
        card.drawnWhole && seenWhole(card) && !settling.contains(card.id) && !answering.contains(card.id) && note(for: card) == nil
            && (!requiresSighting || sighted.contains(card.id))
    }

    private func settle(_ ids: some Sequence<String>) {
        for id in ids {
            settleTasks[id]?.cancel()
            settling.insert(id)
            let wait = settleWait
            settleTasks[id] = Task { [weak self] in
                try? await Task.sleep(for: wait)
                guard !Task.isCancelled else { return }
                self?.settling.remove(id); self?.settleTasks[id] = nil
            }
        }
    }
    /// The list became `new`: cards that arrived, changed, or now sit somewhere else wait a moment.
    private func replace(with new: [Card]) {
        let old = cards
        var moved: [String] = []
        for (i, c) in new.enumerated() {
            if let j = old.firstIndex(where: { $0.id == c.id }) {
                if old[j] != c { moved.append(c.id); opened[c.id] = nil; sighted.remove(c.id) }
                else if j != i { moved.append(c.id) }
            } else if loaded { moved.append(c.id) }
        }
        cards = new
        for id in Set(old.map(\.id)).subtracting(new.map(\.id)) { opened[id] = nil; sighted.remove(id); settleTasks[id]?.cancel(); settleTasks[id] = nil; settling.remove(id) }
        settle(moved)
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
            replace(with: mine)
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
            var next = cards
            if let i = next.firstIndex(where: { $0.id == c.id }) { if next[i] != c { next[i] = c; notes[c.id] = nil } }
            else { next.append(c) }
            replace(with: next)
        case .cardResolved(let id):
            if answeredHere.contains(id) { replace(with: cards.filter { $0.id != id }) }
            else if cards.contains(where: { $0.id == id }) { notes[id] = .answeredElsewhere }
        default: break
        }
    }

    public func answer(_ card: Card, with option: CardOption) async {
        // Only the card as it is on screen now, whole, every cut field opened, and not inside its wait.
        guard cards.contains(card), mayAnswer(card) else { return }
        answering.insert(card.id)
        defer { answering.remove(card.id) }
        do {
            answeredHere.insert(card.id)
            try await client.answer(card: card, option: option)
            replace(with: cards.filter { $0.id != card.id })
            notes[card.id] = nil
        } catch let e as CardAnswerError {
            answeredHere.remove(card.id)
            switch e {
            case .expired: notes[card.id] = .expired
            case .answeredElsewhere: notes[card.id] = .answeredElsewhere
            case .refused(let why): notes[card.id] = .refused(why)
            // The new card is drawn in its place (its event comes with it); nothing is noted on it.
            case .changed, .notShownWhole: break
            }
        } catch {
            answeredHere.remove(card.id)
            notes[card.id] = .failed
        }
    }

    /// Takes a settled card off the screen.
    public func dismiss(_ card: Card) {
        replace(with: cards.filter { $0.id != card.id })
        notes[card.id] = nil
    }
    /// Lets a failed answer be tried again.
    public func clearFailure(_ card: Card) { if notes[card.id] == .failed { notes[card.id] = nil } }
}
