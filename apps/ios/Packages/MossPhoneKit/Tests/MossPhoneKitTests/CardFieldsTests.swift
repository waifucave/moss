import Foundation
import XCTest
@testable import MossPhoneKit

/// A card is drawn whole or not answered here: the phone's field list is the protocol's own, read from its source, so a
/// field added there fails this test until the phone draws it.
final class CardFieldsTests: XCTestCase {
    private func protocolFieldNames() throws -> [String] {
        let here = URL(fileURLWithPath: #filePath)
        let repo = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
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
        let c = SampleData.providerConsentCard
        XCTAssertTrue(c.drawnWhole)
        XCTAssertNotNil(c.fields["host"], "the provider whose key is used is in host")
        XCTAssertTrue(Card.bodyFields.contains("host"))
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
