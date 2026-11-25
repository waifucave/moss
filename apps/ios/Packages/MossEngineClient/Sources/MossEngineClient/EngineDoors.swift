import Foundation
import MossPhoneKit

// THE ONE SMALL FILE where the client still reads or writes the engine's JSON itself: what the phone core doesn't type
// yet (lane PC3 types every other call). Each function is one call, meant to be swapped for a typed one of the core's:
//   * `session.attach` / `session.detach` (following a conversation live; the core then types its events);
//   * `card.list`'s ids (the cards themselves only ever come from the core's issue), and `card.get`'s outcome and option
//     (read back after an answer timed out);
//   * `session.answer` with `skipped` (skipping a bot's open question: the core's `answer_question` has no skip yet);
//   * a card's JSON into the screens' `Card` (the core gives `card_json` to draw; every string in it is drawn through the
//     core's `visible_text`). A card the phone can't draw whole (an unknown sealed field or option kind) is never shown.

/// A call the engine this phone is linked to doesn't offer (an older engine, or a door not merged yet).
public struct NotAvailableYet: Error, Equatable, Sendable {
    public var method: String
    public init(_ method: String) { self.method = method }
}

enum Doors {
    static func call(_ c: ConnectionLink, _ method: String, _ params: [String: Any]) async throws -> [String: Any] {
        let body = try JSONSerialization.data(withJSONObject: params)
        do {
            let out = try await c.call(method, String(decoding: body, as: UTF8.self))
            return (try? JSONSerialization.jsonObject(with: Data(out.utf8))) as? [String: Any] ?? [:]
        } catch let e as LinkError where e.isNotOffered {
            throw NotAvailableYet(method)
        }
    }

    static func attach(_ c: ConnectionLink, session: String, since: UInt64?) async throws -> UInt64 {
        var p: [String: Any] = ["id": session]
        if let since { p["since"] = since }
        return (try await call(c, "session.attach", p)["lastSeq"] as? NSNumber)?.uint64Value ?? 0
    }
    static func detach(_ c: ConnectionLink, session: String) async { _ = try? await call(c, "session.detach", ["id": session]) }

    /// Skips a bot's open question: no answers, `skipped` (the engine tells the bot; only the person may skip).
    static func skipQuestion(_ c: ConnectionLink, session: String, callId: String) async throws {
        _ = try await call(c, "session.answer", ["id": session, "callId": callId, "answers": [String: String](), "skipped": true])
    }

    /// The ids `card.list` names now.
    static func pendingCardIDs(_ c: ConnectionLink) async throws -> [String] {
        ((try await call(c, "card.list", [:])["cards"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }
    }

    /// A card's outcome and the option that settled it (`card.get`), for reading back an answer after a timeout.
    static func cardOutcome(_ c: ConnectionLink, id: String) async throws -> (outcome: String?, option: String?) {
        let o = try await call(c, "card.get", ["id": id])
        return (o["outcome"] as? String, o["option"] as? String)
    }

    /// A card as the screens draw it, from the JSON the core issued, every string through `visible`. `nil` when the
    /// phone can't draw it whole: such a card is never shown, so never answered, here.
    static func card(_ json: String, visible: (String) -> String = { $0 }) -> Card? {
        guard var o = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { return nil }
        // No expiry (the user's own turn): it waits until answered.
        if o["expiresAt"] == nil || o["expiresAt"] is NSNull { o["expiresAt"] = Int64.max }
        if o["origin"] != nil, !(o["origin"] is String) { o["origin"] = nil }
        guard let data = try? JSONSerialization.data(withJSONObject: o), var card = try? JSONDecoder().decode(Card.self, from: data) else { return nil }
        card.fields = card.fields.mapValues { v in
            switch v {
            case .text(let t): return .text(visible(t))
            case .code(let s, let l): return .code(visible(s), language: l)
            case .list(let i): return .list(i.map(visible))
            case .rows(let r): return .rows(r.map { .init(label: visible($0.label), value: visible($0.value)) })
            }
        }
        card.options = card.options.map { var o = $0; o.label = visible(o.label); return o }
        return card
    }
}
