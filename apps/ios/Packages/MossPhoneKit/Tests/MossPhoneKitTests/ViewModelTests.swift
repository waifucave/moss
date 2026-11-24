import XCTest
@testable import MossPhoneKit

@MainActor
final class ViewModelTests: XCTestCase {
    func fake(_ s: FakeEngineClient.Scenario = .idle) -> FakeEngineClient { FakeEngineClient(scenario: s) }

    func testBotsListPinsAndOrders() async {
        let m = BotsListModel(client: fake(), store: MemoryPinStore(["pip", "alpha"]))
        await m.load()
        XCTAssertEqual(m.pinned.map(\.id), ["pip", "alpha"])        // in the order pinned
        XCTAssertFalse(m.others.contains { $0.id == "alpha" })
        XCTAssertEqual(m.others.first?.id, "luna")                   // newest conversation first
        m.togglePin("juniper")
        XCTAssertEqual(m.pinned.map(\.id), ["pip", "alpha", "juniper"])
        XCTAssertEqual(m.unreadCount, 2)
    }

    func testSessionsGroupedByProject() async {
        let m = SessionsListModel(client: fake())
        await m.load()
        XCTAssertEqual(m.groups.map(\.project), ["moss", "website", "tools"])
        let moss = m.groups[0].sessions
        XCTAssertEqual(moss.map(\.id), ["c1", "c2", "c3"])   // newest first
        XCTAssertEqual(moss.first { $0.id == "c1" }?.badge, .running)
        XCTAssertEqual(moss.first { $0.id == "c2" }?.badge, .needsYou)
        XCTAssertEqual(moss.first { $0.id == "c3" }?.badge, .waiting)
        XCTAssertEqual(m.needsYouCount, 2)
    }

    func testSendClearsDraftAndShowsStatusLineThenReply() async {
        let c = fake()
        let bot = SampleData.bots[0]
        let m = ConversationModel(source: .bot(bot), client: c, makeID: { "id-1" })
        await m.load()
        let events = await c.events()
        m.draft = "  Hello  "
        await m.send()
        XCTAssertEqual(m.draft, "")
        let sent = await c.sent
        XCTAssertEqual(sent.first?.text, "Hello"); XCTAssertEqual(sent.first?.clientMessageId, "id-1")
        var it = events.makeAsyncIterator()
        while let e = await it.next() { m.apply(e); if m.statusLine != nil { break } }
        XCTAssertEqual(m.statusLine, "Alpha is thinking"); XCTAssertTrue(m.isRunning)
        await c.finishTurn(session: bot.mainSession)
        while let e = await it.next() { m.apply(e); if m.statusLine == nil { break } }
        XCTAssertFalse(m.isRunning)
        XCTAssertEqual(m.messages.last?.role, .bot)
    }

    func testSendFailureKeepsTheWords() async {
        let c = fake()
        let m = ConversationModel(source: .bot(SampleData.bots[0]), client: c)
        await m.load()
        m.draft = "keep me"
        await c.setFail(.init("down"))
        await m.send()
        XCTAssertEqual(m.draft, "keep me"); XCTAssertNotNil(m.errorText)
    }

    func testResendIsNotASecondMessage() async throws {
        let c = fake()
        try await c.send(session: "s_alpha", text: "a", clientMessageId: "x")
        try await c.send(session: "s_alpha", text: "a", clientMessageId: "x")
        let n = await c.sent.count
        XCTAssertEqual(n, 1)
    }

    func testStopCallsClient() async {
        let c = fake(.midTurn)
        let m = ConversationModel(source: .bot(SampleData.bots[0]), client: c)
        await m.stop()
        let s = await c.stopped
        XCTAssertEqual(s, ["s_alpha"])
    }

    func testCardsFilterAndAnswer() async {
        let c = fake()
        let bots = CardsModel(client: c, filter: CardsModel.forBots)
        let code = CardsModel(client: c, filter: CardsModel.forSessions)
        await bots.load(); await code.load()
        XCTAssertEqual(Set(bots.cards.map(\.id)), ["card_0a1b2c3d", "card_55aa66bb"])
        XCTAssertEqual(code.cards.map(\.id), ["card_9f8e7d6c"])
        let card = bots.cards[0]
        await bots.answer(card, with: card.options[0])
        XCTAssertFalse(bots.cards.contains { $0.id == card.id })
        let a = await c.answered
        XCTAssertEqual(a.first?.card, card.id); XCTAssertEqual(a.first?.option, card.options[0].id)
    }

    func testCardAnswerFailureLeavesCardWaiting() async {
        let c = fake()
        let m = CardsModel(client: c, filter: CardsModel.forBots)
        await m.load()
        await c.setFail(.init("down"))
        await m.answer(m.cards[0], with: m.cards[0].options[0])
        XCTAssertEqual(m.cards.count, 2); XCTAssertNotNil(m.errorText)
    }

    func testPairingHappyPath() async {
        let c = fake(.unpaired)
        let p = PairingModel(client: c)
        await p.scanned("moss-pair:abc")
        guard case .confirming(let prop) = p.step else { return XCTFail("\(p.step)") }
        XCTAssertEqual(prop.words.count, 4)
        await p.confirm()
        XCTAssertEqual(p.step, .paired(PairedComputer(name: "Studio", deviceName: "Phone")))
        let paired = await c.pairedComputer
        XCTAssertNotNil(paired)
    }

    func testPairingRejectsForeignCodeAndCanCancel() async {
        let c = fake(.unpaired)
        let p = PairingModel(client: c)
        await p.scanned("https://example.com")
        XCTAssertEqual(p.step, .failed(.unreadableCode))
        p.retry()
        await p.scanned("moss-pair:abc")
        await p.cancel()
        XCTAssertEqual(p.step, .scanning)
        let paired = await c.pairedComputer
        XCTAssertNil(paired)
    }
}
