import Foundation
import XCTest
@testable import MossPhoneKit

/// A card is drawn whole or not answered here: the phone's field list is the protocol's own, read from its source, so a
/// field added there fails this test until the phone draws it.
final class CardFieldsTests: XCTestCase {
    private func protocolFieldNames() throws -> [String] {
        // This file is <repo>/apps/ios/Packages/MossPhoneKit/Tests/MossPhoneKitTests/CardFieldsTests.swift: seven folders up.
        var repo = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { repo = repo.deletingLastPathComponent() }
        let src = try String(contentsOf: repo.appendingPathComponent("packages/protocol/src/approvals.ts"), encoding: .utf8)
        let start = try XCTUnwrap(src.range(of: "export const CARD_FIELD_NAMES = ["))
        let end = try XCTUnwrap(src.range(of: "] as const", range: start.upperBound..<src.endIndex))
        return src[start.upperBound..<end.lowerBound].split(separator: ",").map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \n\"")) }.filter { !$0.isEmpty }
    }

    func testThePhonesFieldListIsTheProtocols() throws {
        XCTAssertEqual(Card.fieldNames, try protocolFieldNames())
        // Every field under the heading has the desktop's label.
        for name in Card.bodyFields { XCTAssertNotNil(CardView.labels[name], "no label for \(name)") }
    }

    func testACardWithAFieldThePhoneDoesntKnowIsAnsweredOnTheComputer() {
        var c = SampleData.cards[0]
        XCTAssertTrue(c.drawnWhole)
        c.fields["somethingNew"] = .text("x")
        XCTAssertFalse(c.drawnWhole)
    }

    func testTheProviderConsentCardShowsItsProvider() throws {
        // That the provider is DRAWN is the UI test's (CardGateUITests, the drawn "Site" label and its value).
        let c = SampleData.providerConsentCard
        XCTAssertTrue(c.drawnWhole)
        XCTAssertNotNil(c.fields["host"], "the provider whose key is used is in host")
        XCTAssertTrue(Card.bodyFields.contains("host"))
        XCTAssertEqual(CardView.labels["host"], "Site")
    }

    @MainActor
    func testACutCardIsAnsweredOnlyOnceEveryCutPartWasOpened() async {
        let fake = FakeEngineClient(scenario: .manyPaths)
        let model = CardsModel(client: fake, app: .moss, now: { SampleData.now })
        await model.load()
        let card = SampleData.manyPathsCard
        XCTAssertEqual(card.cutFields, ["paths", "reason"], "nine paths and a long reason are both cut")
        XCTAssertFalse(model.mayAnswer(card), "refused by default: the view hasn't reported the card on screen")
        model.seenOnScreen(card)
        XCTAssertFalse(model.mayAnswer(card))
        XCTAssertTrue(model.mayAnswer(card, with: card.options[1]), "Deny never waits to be read")
        await model.answer(card, with: card.options[0])
        let none = await fake.answered
        XCTAssertTrue(none.isEmpty, "Allow does nothing while the ninth path is hidden")
        model.open("paths", of: card)
        XCTAssertFalse(model.mayAnswer(card), "opened is not read: its end hasn't been on screen")
        model.readOnScreen("paths", of: card)
        XCTAssertFalse(model.mayAnswer(card), "the long reason is still cut")
        model.open("reason", of: card)
        model.readOnScreen("reason", of: card)
        XCTAssertTrue(model.mayAnswer(card))
        // Opening again (or a field's end reported before it was opened) never counts as read.
        model.open("paths", of: card)
        XCTAssertFalse(model.mayAnswer(card), "opening a part makes Allow wait again")
        model.readOnScreen("paths", of: card)
        await model.answer(card, with: card.options[0])
        let sent = await fake.answered
        XCTAssertEqual(sent.map(\.card), [card.id])
    }

    @MainActor
    func testANewOrChangedOrMovedCardWaitsBeforeItAnswers() async throws {
        let fake = FakeEngineClient(scenario: .idle)
        let model = CardsModel(client: fake, app: .moss, now: { SampleData.now }, settleWait: .milliseconds(400))
        await model.load()
        let first = try XCTUnwrap(model.cards.first)
        model.seenOnScreen(first)
        XCTAssertTrue(model.mayAnswer(first), "the list as opened answers once seen")
        // A card that arrives now waits; the model refuses an answer inside the wait whatever the view shows.
        var arriving = SampleData.providerConsentCard; arriving.id = "card_arrive01"
        await model.apply(.cardRequested(arriving))
        model.seenOnScreen(arriving)
        XCTAssertFalse(model.mayAnswer(arriving))
        XCTAssertFalse(model.mayAnswer(arriving, with: arriving.options[1]), "Deny waits out the moment after a card shows too")
        await model.answer(arriving, with: arriving.options[0])
        let early = await fake.answered
        XCTAssertTrue(early.isEmpty)
        // Changed again at once: the wait starts over (it is never cut short by the first one's end).
        try await Task.sleep(for: .milliseconds(250))
        arriving.fields["what"] = .text("Changed words")
        arriving.hash = String(repeating: "f", count: 64)
        await model.apply(.cardRequested(arriving))
        model.seenOnScreen(arriving)
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertFalse(model.mayAnswer(arriving), "a second change restarts the wait")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(model.mayAnswer(arriving))
        // A card that moves because one above it left waits too.
        let second = model.cards[1]
        model.seenOnScreen(second)
        model.dismiss(first)
        XCTAssertFalse(model.mayAnswer(second))
    }

    /// A plugin OK's checkboxes: drawn and answered on the phone under the same gate. The ticked ones (the engine's defaults,
    /// then the person's own ticks) go with Allow; Deny sends none; more than eight are cut and must be read to their end.
    @MainActor
    func testAPluginOKIsAnsweredWithItsTickedCheckboxes() async {
        let fake = FakeEngineClient(scenario: .pluginOK)
        let model = CardsModel(client: fake, app: .moss, now: { SampleData.now }, settleWait: .zero)
        await model.load()
        let ok = SampleData.pluginOKCard, many = SampleData.manyChildrenCard
        XCTAssertTrue(ok.drawnWhole); XCTAssertTrue(many.drawnWhole)
        XCTAssertTrue(ok.cutFields.isEmpty, "three checkboxes are drawn whole")
        XCTAssertFalse(model.mayAnswer(ok), "refused by default: not seen yet")
        XCTAssertTrue(model.isTicked("office", of: ok)); XCTAssertFalse(model.isTicked("office-mail", of: ok))
        model.toggle("office-mail", of: ok); model.toggle("office-sheets", of: ok)
        model.toggle("not-a-child", of: ok)
        XCTAssertTrue(model.isTicked("office-mail", of: ok)); XCTAssertFalse(model.isTicked("office-sheets", of: ok))
        model.seenOnScreen(ok)
        XCTAssertTrue(model.mayAnswer(ok))
        await model.answer(ok, with: ok.options[0])
        let sent = await fake.answeredChildren[ok.id]
        XCTAssertEqual(sent, ["office", "office-mail"], "Allow carries exactly the ticked ones, in the card's order")

        // Twelve: cut at eight, like a list. Allow waits until they are opened and read to their end; Deny sends none.
        XCTAssertEqual(many.cutFields, [Card.childrenField])
        model.seenOnScreen(many)
        XCTAssertFalse(model.mayAnswer(many), "the checkboxes past the eighth haven't been on screen")
        model.open(Card.childrenField, of: many)
        XCTAssertFalse(model.mayAnswer(many), "opened is not read")
        model.readOnScreen(Card.childrenField, of: many)
        XCTAssertTrue(model.mayAnswer(many))
        await model.answer(many, with: many.options[1])
        let denied = await fake.answeredChildren[many.id]
        XCTAssertEqual(denied, [], "Deny carries no checkbox")

        // A card whose content changed starts again from the engine's defaults.
        var changed = ok; changed.id = "card_plug0003"; changed.hash = String(repeating: "f", count: 64)
        await model.apply(.cardRequested(changed))
        XCTAssertFalse(model.isTicked("office-mail", of: changed), "a new card's ticks are the engine's, not the last card's")
    }

    /// The Android review's card: a 6-line command, a 6-line detail and 8 paths push `host` and `rule` (what "Always" would
    /// save, the last field) far down. On the phone the card is one column with its buttons last; the buttons answer only
    /// once its heading has been on screen, so a person who reaches them has scrolled through every field, `rule` included.
    @MainActor
    func testATallCardAnswersOnlyOnceItsHeadingWasOnScreen() async {
        let six = (1...6).map { "line \($0)" }.joined(separator: "\n")
        let tall = Card(id: "card_tall0001", kind: "tool", bot: "alpha", origin: "bot", issuedAt: SampleData.now, expiresAt: Int64.max,
                        hash: String(repeating: "e", count: 64),
                        fields: ["title": .text("Run this?"), "command": .code(six, language: "sh"),
                                 "detail": .rows((1...6).map { .init(label: "Row \($0)", value: "value \($0)") }),
                                 "paths": .list((1...8).map { "notes/\($0).md" }), "host": .code("example.org", language: nil),
                                 "rule": .rows([.init(label: "kind", value: "command"), .init(label: "target", value: "anything in notes/")])],
                        options: [CardOption(id: "always", kind: .approve, label: "Always allow", rememberAlways: true), CardOption(id: "deny", kind: .deny, label: "Deny")])
        XCTAssertTrue(tall.drawnWhole)
        XCTAssertTrue(tall.cutFields.isEmpty, "nothing in it is cut: it is the scrolling that hides host and rule")
        let fake = FakeEngineClient(scenario: .quiet)
        let model = CardsModel(client: fake, app: .moss, now: { SampleData.now }, settleWait: .zero)
        await model.load()
        await model.apply(.cardRequested(tall))
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(model.mayAnswer(tall))
        XCTAssertNotNil(model.waitReason(tall), "a refused press says why in one line")
        XCTAssertTrue(model.mayAnswer(tall, with: tall.options[1]), "Deny is never held back by reading")
        model.seenOnScreen(tall)
        XCTAssertTrue(model.mayAnswer(tall))
        XCTAssertNil(model.waitReason(tall))
        // The same card with new content must be seen again from its top.
        var changed = tall; changed.fields["host"] = .code("other.example", language: nil); changed.hash = String(repeating: "9", count: 64)
        await model.apply(.cardRequested(changed))
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(model.mayAnswer(changed))
    }

    @MainActor
    func testTheSameCardWithNewContentReplacesTheOneOnScreen() async {
        let fake = FakeEngineClient(scenario: .idle)
        let model = CardsModel(client: fake, app: .code, now: { SampleData.now })
        await model.load()
        guard var c = model.cards.first else { return XCTFail("no card") }
        c.fields["what"] = .text("New words")
        await model.apply(.cardRequested(c))
        XCTAssertEqual(model.cards.first { $0.id == c.id }?.what, "New words")
        XCTAssertEqual(model.cards.filter { $0.id == c.id }.count, 1)
    }

    /// What counts as on screen. (a) nothing before the surface has settled (its size and visible rect held through a
    /// presented frame), and a report counts only at a frame after it.
    @MainActor
    func testAReportCountsOnlyOnASettledSurfaceAtTheNextFrame() async {
        let (model, card) = await tallModel()
        let atTop = CardsModel.SurfaceLayout(contentSize: CGSize(width: 400, height: 600), visible: CGRect(x: 0, y: 0, width: 400, height: 670))
        model.surface("s", inFront: true)
        model.layout("s", atTop, userScrolling: false)
        model.sighted(card, on: "s")
        XCTAssertFalse(model.isPresented("s"), "laid out, not yet through a presented frame")
        frame(model, "s")
        XCTAssertFalse(model.mayAnswer(card), "a report before the surface settled never counts")
        XCTAssertTrue(model.isPresented("s"))
        model.sighted(card, on: "s")
        XCTAssertFalse(model.mayAnswer(card), "not before a frame is presented after it")
        frame(model, "s")
        XCTAssertTrue(model.mayAnswer(card))
    }

    /// (c) The offset moved without a size change, by no hand of the person's (the anchor placing it at its bottom): the
    /// report made in that pass is dropped, and the wait starts over.
    @MainActor
    func testTheOffsetMovedWithoutASizeChangeTheReportIsDropped() async {
        let (model, card) = await tallModel()
        let size = CGSize(width: 400, height: 2400)
        let top = CardsModel.SurfaceLayout(contentSize: size, visible: CGRect(x: 0, y: 0, width: 400, height: 670))
        let bottom = CardsModel.SurfaceLayout(contentSize: size, visible: CGRect(x: 0, y: 1730, width: 400, height: 670))
        model.surface("s", inFront: true)
        model.layout("s", top, userScrolling: false); frame(model, "s")
        XCTAssertTrue(model.isPresented("s"))
        model.sighted(card, on: "s")
        let ticket = model.frameRequest["s"]
        model.layout("s", bottom, userScrolling: false)          // moved, same size
        XCTAssertFalse(model.isPresented("s"), "a move the person didn't make unsettles it")
        if let ticket { model.framePresented("s", ticket: ticket) }
        frame(model, "s")
        XCTAssertFalse(model.mayAnswer(card), "the report from before the move is dropped, the stale frame ignored")
        XCTAssertTrue(model.isPresented("s"), "settled again at its new place")
        // The person's own scroll moves it too, and they are looking: a report then counts.
        model.layout("s", top, userScrolling: true)
        XCTAssertTrue(model.isPresented("s"), "the person's drag does not unsettle it")
        model.sighted(card, on: "s"); frame(model, "s")
        XCTAssertTrue(model.mayAnswer(card))
    }

    /// (c) A change of the content's size drops what was reported in that pass, for a cut part's last line too.
    @MainActor
    func testAReportInThePassThatChangedTheContentSizeIsDropped() async {
        let fake = FakeEngineClient(scenario: .manyPaths)
        let model = CardsModel(client: fake, app: .moss, now: { SampleData.now }, settleWait: .zero)
        await model.load()
        let card = SampleData.manyPathsCard
        let small = CardsModel.SurfaceLayout(contentSize: CGSize(width: 400, height: 900), visible: CGRect(x: 0, y: 0, width: 400, height: 670))
        var grown = small; grown.contentSize.height = 1300
        model.surface("s", inFront: true)
        model.layout("s", small, userScrolling: false); frame(model, "s")
        model.sighted(card, on: "s")
        model.layout("s", grown, userScrolling: true)            // rows measured: even mid-drag a size change unsettles
        frame(model, "s"); frame(model, "s")
        XCTAssertFalse(model.sighted.contains(card.id + "#" + card.hash), "the report from the pass that changed the size is dropped")
        model.sighted(card, on: "s"); frame(model, "s")
        XCTAssertTrue(model.sighted.contains(card.id + "#" + card.hash), "reported again in the settled place, it counts")
        model.open("paths", of: card)
        model.readEnd("paths", of: card, on: "s")
        model.layout("s", small, userScrolling: false)
        frame(model, "s"); frame(model, "s")
        XCTAssertFalse(model.readToEnd.contains(card.id + "#" + card.hash + "#paths"))
        model.readEnd("paths", of: card, on: "s"); frame(model, "s")
        XCTAssertTrue(model.readToEnd.contains(card.id + "#" + card.hash + "#paths"))
    }

    /// (b) Nothing counts while the app is not active, the surface is covered, or it has left the screen.
    @MainActor
    func testNothingCountsWhileTheAppIsNotActiveOrTheSurfaceIsCovered() async {
        let (model, card) = await tallModel()
        let l = CardsModel.SurfaceLayout(contentSize: CGSize(width: 400, height: 900), visible: CGRect(x: 0, y: 0, width: 400, height: 670))
        model.surface("s", inFront: true)
        model.layout("s", l, userScrolling: false); frame(model, "s")
        model.sighted(card, on: "s")
        model.setAppActive(false)
        frame(model, "s")
        XCTAssertFalse(model.mayAnswer(card), "going inactive drops the report")
        model.sighted(card, on: "s"); frame(model, "s")
        XCTAssertFalse(model.mayAnswer(card), "an app not active counts nothing")
        model.setAppActive(true)
        frame(model, "s")                                      // settles again
        model.surface("s", inFront: false)                     // a sheet over it
        model.sighted(card, on: "s"); frame(model, "s")
        XCTAssertFalse(model.mayAnswer(card), "a covered surface counts nothing")
        model.surface("s", inFront: true); model.layout("s", l, userScrolling: false); frame(model, "s")
        model.sighted(card, on: "s")
        model.surfaceGone("s")
        frame(model, "s")
        XCTAssertFalse(model.mayAnswer(card), "a surface that left counts nothing it reported")
    }

    @MainActor private func tallModel() async -> (CardsModel, Card) {
        let fake = FakeEngineClient(scenario: .quiet)
        let model = CardsModel(client: fake, app: .moss, now: { SampleData.now }, settleWait: .zero)
        await model.load()
        await model.apply(.cardRequested(SampleData.tallCard))
        try? await Task.sleep(for: .milliseconds(50))
        return (model, SampleData.tallCard)
    }
    /// A frame presented for whatever the surface waits for now.
    @MainActor private func frame(_ model: CardsModel, _ id: String) {
        if let t = model.frameRequest[id] { model.framePresented(id, ticket: t) }
    }
}

/// The view's steps in one, for tests that are about something else: a settled surface, the report, a frame after it.
@MainActor extension CardsModel {
    func seenOnScreen(_ card: Card) { report { sighted(card, on: "test") } }
    func readOnScreen(_ field: String, of card: Card) { report { readEnd(field, of: card, on: "test") } }
    private func report(_ make: () -> Void) {
        if !isPresented("test") {
            surface("test", inFront: true)
            layout("test", SurfaceLayout(contentSize: CGSize(width: 1, height: 1), visible: .init(x: 0, y: 0, width: 1, height: 1)), userScrolling: false)
            if let t = frameRequest["test"] { framePresented("test", ticket: t) }
        }
        make()
        if let t = frameRequest["test"] { framePresented("test", ticket: t) }
    }
}
