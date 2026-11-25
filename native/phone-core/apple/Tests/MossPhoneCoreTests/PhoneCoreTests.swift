import Foundation
import XCTest
@testable import MossPhoneCore

/// The host app's storage, in memory for the pairing test.
final class MemStorage: SecretStorage, @unchecked Sendable {
    private var items: [String: Data] = [:]
    private let lock = NSLock()
    func load(name: String) throws -> Data? { lock.withLock { items[name] } }
    func save(name: String, value: Data) throws { lock.withLock { items[name] = value } }
    func delete(name: String) throws { lock.withLock { _ = items.removeValue(forKey: name) } }
}

/// Proof C, in the iPhone simulator through the Swift binding: the async calls complete, and the core pairs with an engine running on the runner (the four words compared with the
/// engine's), connects, and answers the card it displayed with a signature the engine takes.
final class PhoneCoreTests: XCTestCase {
    func testAsyncCallsComplete() async throws {
        let steps = try await loopbackSelfTest()
        XCTAssertEqual(steps, ["bind server", "bind client", "dial", "open stream", "write", "read echo", "close"])
    }

    /// The runner's engine hands its QR and then its words over loopback sockets: never on a command line or in a log.
    private func fromRunner(_ port: UInt32) throws -> String {
        var input: InputStream?
        var output: OutputStream?
        Stream.getStreamsToHost(withName: "127.0.0.1", port: Int(port), inputStream: &input, outputStream: &output)
        guard let s = input else { throw XCTSkip("no engine on this runner") }
        s.open()
        defer { s.close() }
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = s.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            data.append(buf, count: n)
        }
        return String(decoding: data, as: UTF8.self)
    }

    func testPairsWithTheEngineAndAnswersTheCardItShows() async throws {
        guard ProcessInfo.processInfo.environment["MOSS_PC_ENGINE"] == "1" else { throw XCTSkip("no engine (MOSS_PC_ENGINE=1)") }
        let qr = try fromRunner(8787)
        XCTAssertTrue(qr.hasPrefix("clover-pair:1:"))
        let core = try PhoneCore(storage: MemStorage(), config: CoreConfig(deviceName: "iPhone test", holder: .keychain, os: .ios, relay: .disabled, bindAddr: nil))
        let pairing = try await core.beginPairing(qr: qr, app: .code)
        // The person compares the four words: these are the ones the engine's person read on its add card.
        let engineWords = try fromRunner(8788).split(separator: " ").map(String.init)
        XCTAssertEqual(pairing.words(), engineWords)
        let computer = try await pairing.confirm()
        XCTAssertEqual(computer.app, .code)
        let conn = try await core.connect(computerId: computer.id, options: ConnectOptions(clientName: "iphone test", areas: ["approvals", "bots"], callTimeoutMs: 30_000))
        var answered = false
        while !answered {
            guard let e = await conn.nextEvent() else { XCTFail("the connection closed"); return }
            var shown: CardView?
            switch e {
            case let .cardRequested(card): shown = card
            case let .pendingCards(cards): shown = cards.first
            default: continue
            }
            guard let card = shown else { continue }
            // The card as displayed is what is answered: no fetch between the tap and the signature.
            let outcome = try await conn.answerCard(card: card, option: "approve", children: [])
            XCTAssertTrue(outcome.accepted)
            answered = true
        }
        conn.disconnect()
        await core.shutdown()
    }
}
