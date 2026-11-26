import Foundation
import MossPhoneKit
import Security
import XCTest
@testable import MossEngineClient

// The client over a fake link (no core): the card shelf's rule, the Keychain's status mapping, the decoding of the
// engine's payloads and events, and the unpair's wipe.

private func cardJSON(_ id: String, hash: String = "h", fields: String = #"{"title":{"type":"text","text":"T"}}"#,
                      options: String = #"[{"id":"approve","kind":"approve","label":"Allow"},{"id":"deny","kind":"deny","label":"Deny"}]"#,
                      bot: String? = nil, expires: String = "null") -> String {
    #"{"id":"\#(id)","kind":"change","computer":null,"origin":"user","issuedAt":1,"expiresAt":\#(expires),"hash":"\#(hash)","fields":\#(fields),"options":\#(options)\#(bot.map { #","bot":"\#($0)""# } ?? "")}"#
}
/// The test's stand-in for the core's typing of a card: its JSON decoded (no expiry: it waits), nil when unreadable.
func testCard(_ json: String) -> Card? {
    guard var o = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { return nil }
    if o["expiresAt"] == nil || o["expiresAt"] is NSNull { o["expiresAt"] = Int64.max }
    guard let data = try? JSONSerialization.data(withJSONObject: o) else { return nil }
    return try? JSONDecoder().decode(Card.self, from: data)
}
private func shown(_ id: String, hash: String = "h", json: String? = nil) -> ShownCard {
    ShownCard(id: id, hash: hash, card: testCard(json ?? cardJSON(id, hash: hash)), handle: NSObject())
}

final class CardShelfTests: XCTestCase {
    func testOnlyTheIssuedCardAsDrawnIsAnswerable() throws {
        var shelf = CardShelf()
        let s = shown("card_aaaaaa")
        let card = shelf.issue(s)
        XCTAssertEqual(card.expiresAt, Int64.max, "no expiry: it waits")
        XCTAssertTrue(shelf.shown(for: card) === s)
        var altered = card
        altered.fields["title"] = .text("Something else")
        XCTAssertNil(shelf.shown(for: altered), "a card that isn't the one drawn is never signed")
        shelf.resolve(card.id)
        XCTAssertNil(shelf.shown(for: card), "a resolved card isn't answered from here")
    }

    func testACardThePhoneCantDrawWholeIsShownAsAnswerOnTheComputer() {
        var shelf = CardShelf()
        // A card first drawn whole, then re-issued with content the phone can't read: the stand-in replaces it on screen.
        let first = shelf.issue(shown("card_bbbbbb"))
        XCTAssertTrue(first.drawnWhole)
        let reissued = shelf.issue(shown("card_bbbbbb", json: cardJSON("card_bbbbbb", fields: #"{"title":{"type":"chart","x":1}}"#)))
        XCTAssertFalse(reissued.drawnWhole)
        XCTAssertTrue(reissued.options.isEmpty)
        XCTAssertEqual(shelf.cards.map(\.id), ["card_bbbbbb"])
        XCTAssertNil(shelf.shown(for: reissued)); XCTAssertNil(shelf.shown(for: first), "the old text is answered nowhere")
        let c = shelf.issue(shown("card_cccccc", json: cardJSON("card_cccccc", options: #"[{"id":"x","kind":"maybe","label":"?"}]"#)))
        XCTAssertFalse(c.drawnWhole)
        let d = shelf.issue(shown("card_dddddd", hash: "other", json: cardJSON("card_dddddd", hash: "h")))
        XCTAssertFalse(d.drawnWhole, "the issue's hash and the drawn one agree, or nothing is answerable")
        // A plugin OK's checkboxes are drawn on the phone and answered there; a label may come by language.
        let ok = shelf.issue(shown("card_eeeee1", json: cardJSON("card_eeeee1").replacingOccurrences(of: #""kind":"change""#, with: #""kind":"change","children":[{"id":"pack-a","label":"A","checked":true},{"id":"pack-b","label":{"fr":"B fr","en":"B"},"checked":false}]"#)))
        XCTAssertTrue(ok.drawnWhole)
        XCTAssertEqual(ok.children?.map(\.label), ["A", "B"])
        XCTAssertEqual(ok.checkedByDefault, ["pack-a"])
        XCTAssertNotNil(shelf.shown(for: ok))
        // A checkbox with no label, or two with one id, can't be drawn whole: answered on the computer.
        let blank = shelf.issue(shown("card_eeeee2", json: cardJSON("card_eeeee2").replacingOccurrences(of: #""kind":"change""#, with: #""kind":"change","children":[{"id":"pack-a","label":" ","checked":true}]"#)))
        XCTAssertFalse(blank.drawnWhole)
        let twice = shelf.issue(shown("card_eeeee3", json: cardJSON("card_eeeee3").replacingOccurrences(of: #""kind":"change""#, with: #""kind":"change","children":[{"id":"pack-a","label":"A","checked":true},{"id":"pack-a","label":"A2","checked":false}]"#)))
        XCTAssertFalse(twice.drawnWhole)
    }

    func testAResolveKeepsANewerIssueOfTheSameCard() {
        var shelf = CardShelf()
        let old = shown("card_ffff01")
        _ = shelf.issue(old)
        let new = shown("card_ffff01", hash: "h2")
        let card = shelf.issue(new)
        XCTAssertFalse(shelf.resolve("card_ffff01", ifStill: old), "the answer to the old issue leaves the new one")
        XCTAssertTrue(shelf.shown(for: card) === new)
    }

    func testAnUnknownFieldOfTheCardIsIgnored() throws {
        // (The core types the card for the client; this checks the screens' `Card` keeps decoding a card that carries
        // more than it knows, as the tests' stand-in for the core does.)
        let json = cardJSON("card_eeeeee").replacingOccurrences(of: #""kind":"change""#, with: #""kind":"change","newThing":{"a":[1,2]},"children":[]"#)
        XCTAssertNotNil(testCard(json))
    }

    /// Generated sequences of issues, re-lists and resolutions: the shelf answers for a card exactly when the last thing
    /// it heard of that id was an issue (on its own, or in the latest pending list) of that same content.
    func testGeneratedSequencesKeepTheRule() {
        var rng = SystemRandomNumberGenerator()
        let ids = (0..<5).map { "card_seq00\($0)" }
        for _ in 0..<300 {
            var shelf = CardShelf()
            var model: [String: ShownCard] = [:]
            for _ in 0..<40 {
                let id = ids.randomElement(using: &rng)!
                switch Int.random(in: 0..<4, using: &rng) {
                case 0, 1:
                    let s = shown(id, hash: "h\(Int.random(in: 0..<3, using: &rng))")
                    _ = shelf.issue(s); model[id] = s
                case 2:
                    shelf.resolve(id); model[id] = nil
                default:
                    let list = ids.filter { _ in Bool.random(using: &rng) }.map { shown($0, hash: "h\(Int.random(in: 0..<3, using: &rng))") }
                    _ = shelf.replacePending(list)
                    model = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
                }
                for id in ids {
                    let expect = model[id]
                    let card = expect.flatMap { $0.card }
                    if let card { XCTAssertTrue(shelf.shown(for: card) === expect) }
                    XCTAssertEqual(shelf.cards.contains { $0.id == id }, expect != nil)
                    XCTAssertEqual(Set(shelf.cards.map(\.id)).count, shelf.cards.count, "one card per id")
                }
            }
        }
    }
}

final class KeychainMappingTests: XCTestCase {
    private func items(read: OSStatus = errSecSuccess, update: OSStatus = errSecSuccess, add: OSStatus = errSecSuccess, log: Log = Log()) -> KeychainItems {
        KeychainItems(service: "t", api: .init(
            copyMatching: { _, out in if read == errSecSuccess { out?.pointee = Data([7]) as CFData }; return read },
            add: { _ in log.calls.append("add"); return add },
            update: { _, _ in log.calls.append("update"); return update },
            delete: { _ in log.calls.append("delete"); return errSecSuccess }))
    }
    final class Log: @unchecked Sendable { var calls: [String] = [] }

    func testNotFoundIsNilAndALockedKeychainIsNotAvailable() {
        XCTAssertNil(try items(read: errSecItemNotFound).load("x"))
        XCTAssertEqual(try items().load("x"), Data([7]))
        XCTAssertThrowsError(try items(read: errSecInteractionNotAllowed).load("x")) { XCTAssertEqual($0 as? KeychainItems.Failure, .notAvailable("the Keychain is locked")) }
        XCTAssertThrowsError(try items(read: errSecMissingEntitlement).load("x")) {
            guard case .failed = $0 as? KeychainItems.Failure else { return XCTFail("a missing entitlement isn't 'not found'") }
        }
    }

    func testASaveUpdatesInPlaceAndNeverDeletesFirst() throws {
        let log = Log()
        try items(log: log).save("x", Data([1]))
        XCTAssertEqual(log.calls, ["update"])
        let log2 = Log()
        try items(update: errSecItemNotFound, log: log2).save("x", Data([1]))
        XCTAssertEqual(log2.calls, ["update", "add"])
        XCTAssertThrowsError(try items(update: errSecInteractionNotAllowed).save("x", Data([1]))) { XCTAssertEqual($0 as? KeychainItems.Failure, .notAvailable("the Keychain is locked")) }
    }
}

// MARK: The client over a fake link

final class FakeConnection: ConnectionLink, @unchecked Sendable {
    var answers: [String: String] = [:]
    var calls: [(String, String)] = []
    var answered: [(ShownCard, String)] = []
    var accept = true
    var botList: [Bot] = []
    var offersOffered = false
    private var queue: [LinkEvent] = []
    private var waiter: CheckedContinuation<LinkEvent?, Never>?
    private let lock = NSLock()
    func push(_ e: LinkEvent) {
        lock.lock()
        if let w = waiter { waiter = nil; lock.unlock(); w.resume(returning: e); return }
        queue.append(e); lock.unlock()
    }
    private func notOffered() -> LinkError { .rpc(code: -32001, words: "remote role may not call it", dataJSON: nil) }
    /// A canned answer for a method (JSON), as the engine would give it.
    private func call(_ method: String, _ paramsJSON: String) async throws -> [String: Any] {
        lock.withLock { calls.append((method, paramsJSON)) }
        guard let a = answers[method] else { throw LinkError.rpc(code: -32601, words: "no such method", dataJSON: nil) }
        return (try? JSONSerialization.jsonObject(with: Data(a.utf8))) as? [String: Any] ?? [:]
    }
    func attach(session: String, since: UInt64?) async throws -> UInt64 {
        (try await call("session.attach", #"{"id":"\#(session)"}"#)["lastSeq"] as? NSNumber)?.uint64Value ?? 0
    }
    func detach(session: String) async throws { _ = try await call("session.detach", #"{"id":"\#(session)"}"#) }
    func pendingCardIDs() async throws -> [String] {
        ((try await call("card.list", "{}")["cards"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }
    }
    func cardOutcome(id: String) async throws -> LinkCardOutcome {
        let o = try await call("card.get", #"{"id":"\#(id)"}"#)
        return LinkCardOutcome(outcome: o["outcome"] as? String, option: o["option"] as? String)
    }
    func nextEvent() async -> LinkEvent? {
        await withCheckedContinuation { k in
            lock.lock()
            if !queue.isEmpty { let e = queue.removeFirst(); lock.unlock(); k.resume(returning: e) } else { waiter = k; lock.unlock() }
        }
    }
    func fetchCard(_ id: String) async throws -> ShownCard { shown(id) }
    var answerTimesOut = false
    var createTimesOut = false
    var creates = 0
    func answer(_ card: ShownCard, option: String, children: [String]) async throws -> (accepted: Bool, reason: String?) {
        answered.append((card, option))
        if answerTimesOut { throw LinkError.timeout("no answer") }
        return (accept, accept ? nil : "the card was already answered, or its time ran out")
    }
    var sent: [(String, String, [String])] = []
    func sendMessage(session: String, text: String, clientMessageId: String, images: [String], files: [String]) async throws -> UInt64 { sent.append((session, text, images)); return 1 }
    func stageFile(session: String, name: String, data: Data) async throws -> (name: String, path: String) { (name, "bots/a/\(name)") }
    func stageImage(session: String, mediaType: String, data: Data) async throws -> String { "staged/1.png" }
    func bots() async throws -> [Bot] { botList }
    func botSummaries() async throws -> [BotSummary] { [] }
    /// When set, the conversation's pages by where they start (nil: the newest): an answer in the newest, its question
    /// in an older one.
    var pages: [Int64?: LinkPage]?
    var pagesRead: [Int64?] = []
    func conversation(bot: String, beforeSeq: Int64?, limit: UInt32) async throws -> LinkPage {
        if let pages { pagesRead.append(beforeSeq); return pages[beforeSeq] ?? LinkPage(session: "s1", items: [], hasMore: false) }
        return LinkPage(session: "s1", items: [(3, .message(ChatMessage(id: "s1#3", role: .agent, text: "Hi", at: 1))), (4, .turnEnded)], hasMore: true)
    }
    func markRead(bot: String, at: Int64) async throws {}
    func createBot(name: String, model: String?) async throws -> Bot {
        creates += 1
        if createTimesOut { throw LinkError.timeout("no answer") }
        throw notOffered()
    }
    func sessions() async throws -> [SessionRow] { [] }
    func history(session: String, beforeSeq: Int64?, limit: UInt32) async throws -> LinkPage { LinkPage(session: session, items: [], hasMore: false) }
    func stop(session: String) async throws {}
    func setModel(session: String, model: String, effort: String?) async throws {}
    func composerOffers(session: String) async throws -> ComposerOffers {
        if offersOffered { return ComposerOffers(pictures: true) }
        throw notOffered()
    }
    func pendingQuestion(session: String) async throws -> AskQuestion? { nil }
    func answerQuestion(session: String, callId: String, answers: [String: String]) async throws {}
    func skipQuestion(session: String, callId: String) async throws {}
    func backends() async throws -> [AgentBackend] { [] }
    func startOptions(backend: String, computer: String?) async throws -> BackendOptions { BackendOptions(backend: backend, models: []) }
    func recentStart() async throws -> RecentStart { RecentStart() }
    func startSession(_ request: StartRequest) async throws -> String { "c1" }
    func models(session: String?) async throws -> NewBotOptions { NewBotOptions(models: []) }
    func runCommand(name: String) async throws {}
    func state() -> LinkState { .up }
    func networkChanged() {}
    func disconnect() {}
}

final class FakeCore: CoreLink, @unchecked Sendable {
    let conn: FakeConnection
    var computers: [LinkComputer]
    init(_ conn: FakeConnection, computers: [LinkComputer]) { self.conn = conn; self.computers = computers }
    var deviceName: String { "iPhone" }
    func pairedComputers() throws -> [LinkComputer] { computers }
    func beginPairing(qr: String, app: LinkApp) async throws -> PairingLink { throw LinkError.invalid("not a code") }
    func connect(computerId: String, clientName: String, areas: [String]) async throws -> ConnectionLink { conn }
    func forgetComputer(_ id: String) throws { computers.removeAll { $0.id == id } }
    func shutdown() async {}
}

final class ClientTests: XCTestCase {
    private func client(_ conn: FakeConnection, wiped: @escaping @Sendable () -> Void = {}) -> (CoreEngineClient, FakeCore) {
        let core = FakeCore(conn, computers: [LinkComputer(id: "c1", name: "Studio", app: .moss, pairedAt: 1)])
        return (CoreEngineClient(factory: CoreFactory(make: { core }, wipeStore: wiped, visible: { $0.replacingOccurrences(of: "\u{202E}", with: "\\u202E") }), app: .moss), core)
    }

    func testCardsComeFromTheCoresIssueAndAreAnsweredWithIt() async throws {
        let conn = FakeConnection()
        let (c, _) = client(conn)
        let stream = await c.events()
        _ = await c.pairedComputer
        let s = shown("card_ffffff", json: cardJSON("card_ffffff", fields: #"{"title":{"type":"text","text":"a\u202Eb"}}"#))
        conn.push(.up)
        conn.push(.pendingCards([s]))
        var it = stream.makeAsyncIterator()
        var got: Card?
        while got == nil, let e = await it.next() { if case .cardRequested(let card) = e { got = card } }
        let card = try XCTUnwrap(got)
        // The core types the card, every string already through its visible-text rule (`typed.rs`); the client draws
        // exactly the card the core gave, changing nothing.
        XCTAssertEqual(card, s.card, "the card drawn is the core's own")
        try await c.answer(card: card, option: card.options[0])
        XCTAssertTrue(conn.answered.first?.0 === s, "the very object the core issued goes back")
        do { try await c.answer(card: card, option: card.options[0]); XCTFail("answered twice") } catch is CardNotShown {}
    }

    func testTypedEventsBecomeMessagesAndTheStatusLine() async throws {
        let conn = FakeConnection()
        conn.botList = [Bot(id: "alpha", name: "Alpha", mainSession: "s1")]
        let (c, _) = client(conn)
        let stream = await c.events()
        _ = try await c.bots()
        conn.push(.up)
        conn.push(.sessionItem(session: "s1", seq: 4, item: .turnStarted))
        conn.push(.sessionItem(session: "s1", seq: 5, item: .message(ChatMessage(id: "s1#5", role: .agent, text: "Hi", at: 11))))
        conn.push(.sessionItem(session: "s1", seq: 6, item: .other))
        conn.push(.sessionItem(session: "s1", seq: 7, item: .turnEnded))
        var seen: [EngineEvent] = []
        var it = stream.makeAsyncIterator()
        while seen.filter({ if case .statusLine = $0 { return true }; return false }).count < 2, let e = await it.next() { seen.append(e) }
        XCTAssertTrue(seen.contains(.statusLine(subject: "s1", line: "Alpha is thinking")))
        XCTAssertTrue(seen.contains(.message(subject: "s1", ChatMessage(id: "s1#5", role: .bot, text: "Hi", at: 11))), "a bot's words are the bot's")
        XCTAssertTrue(seen.contains(.statusLine(subject: "s1", line: nil)))
    }

    /// An answer whose question is in a page not loaded: the client reads back for the question's words (once), so the
    /// answer's caption names it.
    func testAnAnswerNamesItsQuestionFromAnOlderPage() async throws {
        let conn = FakeConnection()
        conn.botList = [Bot(id: "alpha", name: "Alpha", mainSession: "s1")]
        let asked = ChatMessage(id: "s1#2", role: .question, text: "Which colour?", at: 1,
                                question: AskedQuestion(callId: "ask_7", text: "Which colour?", options: ["Green"]))
        let answer = ChatMessage(id: "s1#9", role: .user, text: "Green", at: 5, answersQuestion: "ask_7")
        conn.pages = [nil: LinkPage(session: "s1", items: [(9, .message(answer))], hasMore: true),
                      9: LinkPage(session: "s1", items: [(2, .message(asked))], hasMore: false)]
        let (c, _) = client(conn)
        let page = try await c.conversation(bot: "alpha", before: nil, limit: 60)
        XCTAssertEqual(page.messages.first?.answersQuestionText, "Which colour?", "named from the older page")
        XCTAssertEqual(conn.pagesRead, [nil, 9], "one page read back")
        _ = try await c.conversation(bot: "alpha", before: nil, limit: 60)
        XCTAssertEqual(conn.pagesRead, [nil, 9, nil], "known now: nothing read back again")
    }

    func testPagesByPlaceForTheScreensTime() async throws {
        let conn = FakeConnection()
        conn.botList = [Bot(id: "alpha", name: "Alpha", mainSession: "s1")]
        let (c, _) = client(conn)
        let page = try await c.conversation(bot: "alpha", before: nil, limit: 60)
        XCTAssertEqual(page.messages.map(\.role), [.bot])
        XCTAssertTrue(page.hasMore)
        XCTAssertTrue(conn.calls.contains { $0.0 == "session.attach" }, "the conversation is followed live")
    }

    func testTheEnginesReasonsAreToldApart() {
        XCTAssertEqual(CoreEngineClient.answerError("the card was already answered, or its time ran out", expired: false), .answeredElsewhere)
        XCTAssertEqual(CoreEngineClient.answerError("the card was already answered, or its time ran out", expired: true), .expired)
        XCTAssertEqual(CoreEngineClient.answerError("the card changed since it was shown", expired: false), .changed)
        XCTAssertEqual(CoreEngineClient.answerError("the answer's time is too far from this computer's", expired: false), .refused("the answer's time is too far from this computer's"))
    }

    func testATimedOutAnswerCountsOnlyWithTheOptionSent() async throws {
        let conn = FakeConnection()
        let (c, _) = client(conn)
        let stream = await c.events()
        _ = await c.pairedComputer
        conn.push(.up)
        conn.push(.pendingCards([shown("card_t00001")]))
        var it = stream.makeAsyncIterator()
        var got: Card?
        while got == nil, let e = await it.next() { if case .cardRequested(let card) = e { got = card } }
        let card = try XCTUnwrap(got)
        conn.answerTimesOut = true
        conn.answers["card.get"] = #"{"card":{},"outcome":"denied","option":"deny"}"#
        do { try await c.answer(card: card, option: card.options[0]); XCTFail("another option settled it") } catch let e as CardAnswerError { XCTAssertEqual(e, .answeredElsewhere) }
    }

    func testATimedOutMakeIsLookedForBeforeAnother() async throws {
        let conn = FakeConnection()
        conn.createTimesOut = true
        let (c, _) = client(conn)
        do { _ = try await c.createBot(name: "Gamma", model: nil); XCTFail("no answer, nothing listed") } catch is MayHaveReached {}
        // It turns out it was made: the second tap finds it and makes none.
        conn.botList = [Bot(id: "gamma", name: "Gamma", mainSession: "b_gamma")]
        conn.createTimesOut = false
        let b = try await c.createBot(name: "Gamma", model: nil)
        XCTAssertEqual(b.id, "gamma")
        XCTAssertEqual(conn.creates, 1, "one make only")
    }

    func testASendNamesItsAttachmentsInTheText() async throws {
        let conn = FakeConnection()
        let (c, _) = client(conn)
        try await c.send(session: "s1", text: "Look", clientMessageId: "m1", images: ["staged/1.png"], files: ["bots/a/f.pdf"])
        XCTAssertEqual(conn.sent.first?.1, "Look [Image #1] [File #1]")
    }

    func testUnpairForgetsEveryComputerAndWipesTheStore() async throws {
        let conn = FakeConnection()
        final class Flag: @unchecked Sendable { var wiped = false }
        let flag = Flag()
        let (c, core) = client(conn, wiped: { flag.wiped = true })
        _ = await c.pairedComputer
        await c.unpair()
        XCTAssertTrue(core.computers.isEmpty)
        XCTAssertTrue(flag.wiped, "the device's own keys go too")
    }

    func testAnEngineWithoutThePhoneDoorsSaysSo() async throws {
        let conn = FakeConnection()
        let (c, _) = client(conn)
        let offers = try await c.composerOffers(session: "s1", kind: .bot)
        XCTAssertTrue(offers.isEmpty, "no rows where the engine offers nothing")
        do { _ = try await c.createBot(name: "N", model: nil); XCTFail("no such door here") } catch let e as NotAvailableYet { XCTAssertEqual(e.method, "bot.create") }
        do { _ = try await c.stageImage(session: "s1", data: Data([0x89, 0x50, 0x4E, 0x47])); XCTFail("a picture where none is offered") } catch is NotAvailableYet {}
        conn.offersOffered = true
        let offered = try await c.composerOffers(session: "s1", kind: .bot)
        XCTAssertTrue(offered.pictures)
        let path = try await c.stageImage(session: "s1", data: Data([0x89, 0x50, 0x4E, 0x47]))
        XCTAssertEqual(path, "staged/1.png")
        do { _ = try await c.stageFile(session: "s1", name: "f", data: Data([1])); XCTFail("a file where only pictures are offered") } catch is NotAvailableYet {}
    }
}
