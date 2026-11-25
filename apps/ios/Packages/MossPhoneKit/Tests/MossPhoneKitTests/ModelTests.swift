import XCTest
@testable import MossPhoneKit

/// The engine's own generated fixtures, read from the repo by path (never copies).
func repoRoot(_ file: String = #filePath) -> URL {
    var u = URL(fileURLWithPath: file)
    for _ in 0..<7 { u.deleteLastPathComponent() }
    return u
}
func fixture(_ name: String) throws -> [String: Any] {
    let url = repoRoot().appendingPathComponent("packages/protocol/generated/moss/fixtures/\(name).json")
    return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
}
func decode<T: Decodable>(_ type: T.Type, from obj: Any) throws -> T {
    try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: obj))
}

final class FixtureTests: XCTestCase {
    func testBotChanged() throws {
        let bot = try decode(Bot.self, from: fixture("bot_changed")["bot"]!)
        XCTAssertEqual(bot.id, "alpha"); XCTAssertEqual(bot.state, .idle); XCTAssertEqual(bot.mainSession, "s_alpha")
    }
    func testSessionChanged() throws {
        let s = try decode(SessionRow.self, from: fixture("session_changed")["session"]!)
        XCTAssertEqual(s.status, .prompting); XCTAssertEqual(s.motion, .running); XCTAssertEqual(s.project, "project1")
    }
    func testCardRequestedDecodesBothLabelShapes() throws {
        let c = try decode(Card.self, from: fixture("card_requested")["card"]!)
        XCTAssertEqual(c.title, "Run a command?")
        XCTAssertEqual(c.options.map(\.label).first, "Allow")
        let always = c.options[1]
        XCTAssertTrue(always.rememberAlways)
        XCTAssertFalse(always.label.isEmpty)   // a map by language: one is chosen
        XCTAssertEqual(c.options[2].kind, .deny)
        if case .code(let code, _)? = c.fields["command"] { XCTAssertEqual(code, "rm -rf build/") } else { XCTFail("command") }
    }
    func testSessionMotionMatchesProtocolRule() {
        XCTAssertEqual(sessionMotion(status: .prompting, waiting: SessionWaiting(tasks: 2, children: 0)), .running)
        XCTAssertEqual(sessionMotion(status: .idle, waiting: SessionWaiting(tasks: 1, children: 0)), .waiting)
        XCTAssertEqual(sessionMotion(status: .ready, waiting: SessionWaiting(tasks: 0, children: 0)), .still)
        XCTAssertEqual(sessionMotion(status: .failed, waiting: nil), .ended)
        XCTAssertEqual(sessionMotion(status: .stopped, waiting: SessionWaiting(tasks: 3, children: 3)), .ended)
    }
    func testKitFileIsTheDesktopsFile() throws {
        let repo = try Data(contentsOf: repoRoot().appendingPathComponent("packages/plugin-sdk/src/ui/faces/living-bots.js"))
        let url = try XCTUnwrap(Bundle.module.url(forResource: "living-bots", withExtension: "js"))
        XCTAssertEqual(try Data(contentsOf: url), repo)
    }
}

final class SealedTests: XCTestCase {
    func testBidiAndControlShowAsEscapes() {
        XCTAssertEqual(Sealed.visible("a\u{202E}b"), "a\\u{202E}b")
        XCTAssertEqual(Sealed.visible("x\u{0}y"), "x\\u{0}y")
        XCTAssertEqual(Sealed.visible("line\nbreak"), "line\nbreak")
    }
    func testLongFieldIsCutOpenly() {
        let c = Sealed.cut(String(repeating: "a", count: 1000), limit: 600)
        XCTAssertEqual(c.shown.count, 600); XCTAssertEqual(c.hiddenCount, 400)
        XCTAssertEqual(Sealed.cut("short", limit: 600).hiddenCount, 0)
    }
}

final class TimeTests: XCTestCase {
    func testShort() {
        let now = SampleData.now
        XCTAssertEqual(TimeText.short(at: now - 20_000, now: now), "Now")
        XCTAssertEqual(TimeText.short(at: now - 4 * 60_000, now: now), "4 min")
        XCTAssertEqual(TimeText.short(at: now - 26 * 3_600_000, now: now), "Yesterday")
    }
}

final class AgentLookTests: XCTestCase {
    func testKnownAndFallback() {
        XCTAssertEqual(AgentLook.of("claude-code").name, "Claude Code")
        XCTAssertEqual(AgentLook.of("some-new-agent").initial, "S")
    }
}
