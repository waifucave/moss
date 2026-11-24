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

    func testCardsSplitByAppAndFallBackWhenTheOtherAppIsMissing() async {
        let c = fake()
        let bots = CardsModel(client: c, app: .moss, now: { SampleData.now })
        let code = CardsModel(client: c, app: .code, now: { SampleData.now })
        await bots.load(); await code.load()
        XCTAssertEqual(Set(bots.cards.map(\.id)), ["card_0a1b2c3d", "card_55aa66bb"])
        XCTAssertEqual(code.cards.map(\.id), ["card_9f8e7d6c"])
        await c.setOtherAppInstalled(false)
        await bots.load(); await code.load()
        XCTAssertEqual(bots.cards.count, 3); XCTAssertEqual(code.cards.count, 3)
        let card = bots.cards.first { $0.id == "card_0a1b2c3d" }!
        await bots.answer(card, with: card.options[0])
        XCTAssertFalse(bots.cards.contains { $0.id == card.id })
        let a = await c.answered
        XCTAssertEqual(a.first?.card, card.id); XCTAssertEqual(a.first?.option, card.options[0].id)
    }

    func testCardFailureKeepsCardAndOffersRetry() async {
        let c = fake()
        let m = CardsModel(client: c, app: .moss, now: { SampleData.now })
        await m.load()
        let card = m.cards[0]
        await c.setFail(.init("down"))
        await m.answer(card, with: card.options[0])
        XCTAssertEqual(m.cards.count, 2); XCTAssertEqual(m.note(for: card), .failed)
        m.clearFailure(card)
        XCTAssertNil(m.note(for: card))
    }

    func testExpiredAndAnsweredElsewhereCards() async {
        let c = FakeEngineClient(scenario: .cardStates)
        let m = CardsModel(client: c, app: .moss, now: { SampleData.now })
        await m.load()
        let expired = m.cards.first { $0.id == "card_0a1b2c3d" }!
        XCTAssertEqual(m.note(for: expired), .expired)
        await m.answer(expired, with: expired.options[0])          // refused here, never sent
        let sent = await c.answered
        XCTAssertTrue(sent.isEmpty)
        await m.apply(.cardResolved(id: "card_55aa66bb"))           // another device answered it
        XCTAssertEqual(m.note(for: m.cards.first { $0.id == "card_55aa66bb" }!), .answeredElsewhere)
        XCTAssertEqual(m.waitingCount, 0)
        m.dismiss(expired)
        XCTAssertEqual(m.cards.count, 1)
    }

    func testAnsweringARaceLostCardSaysAnsweredElsewhere() async {
        let c = FakeEngineClient(scenario: .cardStates)
        let m = CardsModel(client: c, app: .moss, now: { SampleData.now })
        await m.load()
        let card = m.cards.first { $0.id == "card_55aa66bb" }!
        await m.answer(card, with: card.options[0])
        XCTAssertEqual(m.note(for: card), .answeredElsewhere)
    }

    func testFailedSendKeepsTextAndRetryUsesTheSameId() async {
        let c = FakeEngineClient(scenario: .sendFails)
        var n = 0
        let m = ConversationModel(source: .bot(SampleData.bots[0]), client: c, makeID: { n += 1; return "id-\(n)" })
        await m.load()
        m.draft = "hello"
        await m.send()
        XCTAssertEqual(m.draft, "hello"); XCTAssertEqual(m.failedSend?.id, "id-1")
        await m.retry()
        XCTAssertEqual(m.failedSend?.id, "id-1")        // the same id: never two messages
        XCTAssertEqual(n, 1)
    }

    func testUnreachableComputerShowsInEveryList() async {
        let c = FakeEngineClient(scenario: .unreachable)
        let b = BotsListModel(client: c, store: MemoryPinStore())
        await b.load()
        XCTAssertTrue(b.loadFailed); XCTAssertTrue(b.loaded)
        XCTAssertEqual(b.connection, .unreachable(since: SampleData.now - 7_200_000))
        let s = SessionsListModel(client: c)
        await s.load()
        XCTAssertTrue(s.loadFailed)
    }

    func testEmptyListsAreEmptyNotFailed() async {
        let c = FakeEngineClient(scenario: .empty)
        let b = BotsListModel(client: c, store: MemoryPinStore())
        await b.load()
        XCTAssertTrue(b.loaded); XCTAssertFalse(b.loadFailed); XCTAssertTrue(b.rows.isEmpty)
        let s = SessionsListModel(client: c)
        await s.load()
        XCTAssertTrue(s.groups.isEmpty)
    }

    func testNewSessionPreselectsLastUsedAndStarts() async throws {
        let c = fake()
        let m = NewSessionModel(client: c, computer: "Studio")
        await m.load()
        XCTAssertEqual(m.backend, "claude-code")                   // the last used agent
        XCTAssertEqual(m.model, "claude-sonnet"); XCTAssertEqual(m.effort, "medium")
        XCTAssertEqual(m.folders.first, "home/Studio/moss")       // folders of existing sessions first
        XCTAssertEqual(m.folder, "home/Studio/moss")
        m.typedFolder = "  home/Studio/new-thing "
        XCTAssertEqual(m.folder, "home/Studio/new-thing")
        let id = await m.start()
        XCTAssertNotNil(id)
        let started = await c.started
        XCTAssertEqual(started.first, StartRequest(backend: "claude-code", computer: "Studio", root: "home/Studio/new-thing", model: "claude-sonnet", effort: "medium"))
        let list = try await c.sessions()
        XCTAssertTrue(list.contains { $0.id == id })
    }

    func testNewSessionDefaultsFollowTheAgentChosen() async {
        let c = fake()
        let m = NewSessionModel(client: c, computer: "Studio")
        await m.load()
        m.backend = "moss-code"
        for _ in 0..<150 where m.options?.backend != "moss-code" { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(m.model, "kimi-k3"); XCTAssertEqual(m.effort, "medium")   // no recent choice: the defaults
        m.backend = "gemini"
        for _ in 0..<150 where m.options?.backend != "gemini" { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(m.options?.known, false); XCTAssertNil(m.model)
    }

    func testNewSessionRefusesTheMossHomeAndEmptyFolders() async {
        let c = fake()
        let m = NewSessionModel(client: c, computer: "Studio")
        await m.load()
        m.typedFolder = "home/.moss"
        let id = await m.start()
        XCTAssertNil(id); XCTAssertNotNil(m.errorText)
        m.typedFolder = "../x"
        let id2 = await m.start()
        XCTAssertNil(id2)
    }

    func testSettingsLastSeenAndUnpair() async {
        let c = FakeEngineClient(scenario: .unreachable)
        let m = SettingsModel(client: c, version: "1.0 (1)")
        await m.load()
        XCTAssertEqual(m.computer?.name, "Studio")
        XCTAssertEqual(m.lastSeenText(now: SampleData.now), "Last seen 2 hours ago")
        await m.unpair()
        XCTAssertNil(m.computer)
        let p = await c.pairedComputer
        XCTAssertNil(p)
        let n = await c.unpairCount
        XCTAssertEqual(n, 1)
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
