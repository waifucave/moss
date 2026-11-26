import Foundation

// The client reads and writes no engine JSON of its own: the phone core types every call it makes (`session.attach` and
// `session.detach`, `card.list`'s ids, `card.get`'s outcome and option, and the card itself, every string of it through
// the core's visible-text rule). What is left here is the error for a door the linked engine doesn't offer.

/// A call the engine this phone is linked to doesn't offer (an older engine, or a door not merged yet).
public struct NotAvailableYet: Error, Equatable, Sendable {
    public var method: String
    public init(_ method: String) { self.method = method }
}
