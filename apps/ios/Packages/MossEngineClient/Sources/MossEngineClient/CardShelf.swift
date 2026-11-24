import Foundation
import MossPhoneKit

/// The cards the core issued on the current connection and the screens were given, by id. A card is answered ONLY
/// through the `ShownCard` the core issued for exactly the `Card` the screen drew: `shown(for:)` gives it back only when
/// the screen's card equals what was decoded from that issue, and never for a card resolved since. Nothing is fetched
/// between the tap and the signature.
struct CardShelf {
    private(set) var held: [String: (card: Card, shown: ShownCard)] = [:]
    private(set) var order: [String] = []
    let decode: (String) -> Card?

    init(decode: @escaping (String) -> Card?) { self.decode = decode }

    /// The cards held, in the order they were issued.
    var cards: [Card] { order.compactMap { held[$0]?.card } }

    /// A card the core issued now: held (replacing an earlier issue of the same id) and returned when the phone can draw
    /// it. A card it can't draw whole (an unknown field or option kind) is not held: the person answers it elsewhere.
    mutating func issue(_ s: ShownCard) -> Card? {
        guard let card = decode(s.cardJSON), card.id == s.id, card.hash == s.hash else {
            drop(s.id)
            return nil
        }
        if held[s.id] == nil { order.append(s.id) }
        held[s.id] = (card, s)
        return card
    }

    /// The cards pending as a connection came up: what is held becomes exactly this list. Returns the cards drawn
    /// now and the ids no longer pending (settled while the link was away).
    mutating func replacePending(_ list: [ShownCard]) -> (cards: [Card], gone: [String]) {
        let before = Set(order)
        held = [:]; order = []
        var cards: [Card] = []
        for s in list { if let c = issue(s) { cards.append(c) } }
        let gone = before.subtracting(order).sorted()
        return (cards, gone)
    }

    /// A card was resolved: it leaves the shelf and can't be answered from here any more.
    @discardableResult
    mutating func resolve(_ id: String) -> Bool { drop(id) }

    /// The core's issue for the card the screen drew, only when the screen's card is the one decoded from it.
    func shown(for card: Card) -> ShownCard? {
        guard let h = held[card.id], h.card == card else { return nil }
        return h.shown
    }

    mutating func clear() { held = [:]; order = [] }

    @discardableResult
    private mutating func drop(_ id: String) -> Bool {
        guard held.removeValue(forKey: id) != nil else { return false }
        order.removeAll { $0 == id }
        return true
    }
}
