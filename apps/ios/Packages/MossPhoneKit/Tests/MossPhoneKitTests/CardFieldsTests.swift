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

    /// What counts as on screen: (a) nothing before the surface is presented in its settled place, and a report counts
    /// only at the next presented frame; (b) nothing while the app is not active or the surface is covered; (c) a change
    /// of the content's size drops what was reported in the same pass.
    @MainActor
    func testAReportCountsOnlyOnAPresentedSurfaceAtTheNextFrame() async {
        let fake = FakeEngineClient(scenario: .quiet)
        let model = CardsModel(client: fake, app: .moss, now: { SampleData.now }, settleWait: .zero)
        await model.load()
        let card = SampleData.tallCard
        await model.apply(.cardRequested(card))
        try? await Task.sleep(for: .milliseconds(50))

        // (a) The conversation laid out at its top, not yet placed at its bottom: the heading is "inside" then, unseen.
        model.sighted(card, on: "s")
        model.framePresented("s")
        XCTAssertFalse(model.mayAnswer(card), "a report before the surface is presented never counts")
        model.surface("s", presented: true)
        model.sighted(card, on: "s")
        XCTAssertFalse(model.mayAnswer(card), "not before a frame is presented after it")
        XCTAssertTrue(model.awaitingFrame.contains("s"), "the view is asked for the next frame")
        model.framePresented("s")
        XCTAssertTrue(model.mayAnswer(card), "presented, then a frame presented: it counts")
    }

    @MainActor
    func testNothingCountsWhileTheAppIsNotActiveOrTheSurfaceIsCovered() async {
        let fake = FakeEngineClient(scenario: .quiet)
        let model = CardsModel(client: fake, app: .moss, now: { SampleData.now }, settleWait: .zero)
        await model.load()
        let card = SampleData.tallCard
        await model.apply(.cardRequested(card))
        try? await Task.sleep(for: .milliseconds(50))
        model.surface("s", presented: true)
        // (b) In the app switcher or the background.
        model.setAppActive(false)
        model.sighted(card, on: "s"); model.framePresented("s")
        XCTAssertFalse(model.mayAnswer(card), "an app not active counts nothing")
        model.setAppActive(true)
        model.sighted(card, on: "s"); model.framePresented("s")
        XCTAssertFalse(model.mayAnswer(card), "going inactive unpresented the surface: it must be presented again")
        // Going inactive between the report and the frame drops the report.
        model.surface("s", presented: true)
        model.sighted(card, on: "s")
        model.setAppActive(false); model.setAppActive(true); model.surface("s", presented: true)
        model.framePresented("s")
        XCTAssertFalse(model.mayAnswer(card), "a report from before the app left does not count after it is back")
        // A sheet over it (the view says covered: not presented).
        model.surface("s", presented: false)
        model.sighted(card, on: "s"); model.framePresented("s")
        XCTAssertFalse(model.mayAnswer(card), "a covered surface counts nothing")
        // Gone from the screen.
        model.surface("s", presented: true)
        model.sighted(card, on: "s")
        model.surfaceGone("s")
        model.framePresented("s")
        XCTAssertFalse(model.mayAnswer(card), "a surface that left counts nothing it reported")
    }

    @MainActor
    func testAReportInThePassThatChangedTheContentSizeIsDropped() async {
        let fake = FakeEngineClient(scenario: .manyPaths)
        let model = CardsModel(client: fake, app: .moss, now: { SampleData.now }, settleWait: .zero)
        await model.load()
        let card = SampleData.manyPathsCard
        model.surface("s", presented: true)
        // (c) Rows measured, the content grew: the heading reported in that pass sat where it no longer is.
        model.sighted(card, on: "s")
        model.surface("s", presented: false)   // the content's size changed
        model.surface("s", presented: true)    // settled again through a presented frame
        model.framePresented("s")
        XCTAssertFalse(model.sighted.contains(card.id + "#" + card.hash), "the report from the pass that changed the size is dropped")
        model.sighted(card, on: "s"); model.framePresented("s")
        XCTAssertTrue(model.sighted.contains(card.id + "#" + card.hash), "reported again in the settled place, it counts")
        // The same for an opened part's last line.
        model.open("paths", of: card)
        model.readEnd("paths", of: card, on: "s")
        model.surface("s", presented: false); model.surface("s", presented: true)
        model.framePresented("s")
        XCTAssertFalse(model.readToEnd.contains(card.id + "#" + card.hash + "#paths"))
        model.readEnd("paths", of: card, on: "s"); model.framePresented("s")
        XCTAssertTrue(model.readToEnd.contains(card.id + "#" + card.hash + "#paths"))
    }
}

/// The view's two steps in one, for tests that are about something else: the surface is presented, the report made, and a
/// frame presented after it.
@MainActor extension CardsModel {
    func seenOnScreen(_ card: Card) { surface("test", presented: true); sighted(card, on: "test"); framePresented("test") }
    func readOnScreen(_ field: String, of card: Card) { surface("test", presented: true); readEnd(field, of: card, on: "test"); framePresented("test") }
}
