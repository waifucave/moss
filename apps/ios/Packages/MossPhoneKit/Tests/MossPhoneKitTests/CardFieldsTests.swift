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
        XCTAssertFalse(model.mayAnswer(card))
        await model.answer(card, with: card.options[0])
        let none = await fake.answered
        XCTAssertTrue(none.isEmpty, "Allow does nothing while the ninth path is hidden")
        model.open("paths", of: card)
        XCTAssertFalse(model.mayAnswer(card), "the long reason is still cut")
        model.open("reason", of: card)
        XCTAssertTrue(model.mayAnswer(card))
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
        XCTAssertTrue(model.mayAnswer(first), "the list as opened answers at once")
        // A card that arrives now waits; the model refuses an answer inside the wait whatever the view shows.
        var arriving = SampleData.providerConsentCard; arriving.id = "card_arrive01"
        await model.apply(.cardRequested(arriving))
        XCTAssertFalse(model.mayAnswer(arriving))
        await model.answer(arriving, with: arriving.options[0])
        let early = await fake.answered
        XCTAssertTrue(early.isEmpty)
        // Changed again at once: the wait starts over (it is never cut short by the first one's end).
        try await Task.sleep(for: .milliseconds(250))
        arriving.fields["what"] = .text("Changed words")
        await model.apply(.cardRequested(arriving))
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertFalse(model.mayAnswer(arriving), "a second change restarts the wait")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(model.mayAnswer(arriving))
        // A card that moves because one above it left waits too.
        let second = model.cards[1]
        model.dismiss(first)
        XCTAssertFalse(model.mayAnswer(second))
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
}
