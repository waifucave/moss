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

    /// A card the core issued now: held (replacing an earlier issue of the same id) and returned to draw. One the phone
    /// can't read at all (an unknown sealed field or option kind) is held as a stand-in that says "answer this one on
    /// your computer": it replaces any earlier text of that id on screen, and it has no answer.
    mutating func issue(_ s: ShownCard) -> Card {
        let card: Card
        if let c = decode(s.cardJSON), c.id == s.id, c.hash == s.hash { card = c } else { card = Self.standIn(s) }
        if held[s.id] == nil { order.append(s.id) }
        held[s.id] = (card, s)
        return card
    }

    /// The card drawn for an issue the phone can't read: its owner (which app shows it), no options, and a field the
    /// phone doesn't draw, so `drawnWhole` is false and no button is offered.
    static func standIn(_ s: ShownCard) -> Card {
        Card(id: s.id, kind: "unreadable", session: s.session, bot: s.bot, issuedAt: 0, expiresAt: Int64.max, hash: s.hash,
             fields: ["title": .text("A card this phone can't show"), "unreadable": .text("")], options: [])
    }

    /// The cards pending as a connection came up: what is held becomes exactly this list. Returns the cards drawn
    /// now and the ids no longer pending (settled while the link was away).
    mutating func replacePending(_ list: [ShownCard]) -> (cards: [Card], gone: [String]) {
        let before = Set(order)
        held = [:]; order = []
        var cards: [Card] = []
        for s in list { cards.append(issue(s)) }
        let gone = before.subtracting(order).sorted()
        return (cards, gone)
    }

    /// A card was resolved: it leaves the shelf and can't be answered from here any more.
    @discardableResult
    mutating func resolve(_ id: String) -> Bool { drop(id) }
    /// Resolves the card only while the issue held is still `shown`: a newer issue of the same id that landed meanwhile stays.
    @discardableResult
    mutating func resolve(_ id: String, ifStill shown: ShownCard) -> Bool {
        guard held[id]?.shown === shown else { return false }
        return drop(id)
    }

    /// The core's issue for the card the screen drew, only when the screen's card is the one decoded from it and the
    /// phone draws it whole.
    func shown(for card: Card) -> ShownCard? {
        guard let h = held[card.id], h.card == card, card.drawnWhole else { return nil }
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
