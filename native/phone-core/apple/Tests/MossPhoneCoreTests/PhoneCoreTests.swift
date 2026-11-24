import Foundation
import XCTest
@testable import MossPhoneCore

/// The host app's storage, in memory for the test (a real app keeps these in the Keychain, device-only).
final class MemStorage: SecretStorage, @unchecked Sendable {
    private var items: [String: Data] = [:]
    private let lock = NSLock()
    func load(name: String) throws -> Data? { lock.withLock { items[name] } }
    func save(name: String, value: Data) throws { lock.withLock { items[name] = value } }
    func delete(name: String) throws { lock.withLock { _ = items.removeValue(forKey: name) } }
}

/// Proof C, in the iPhone simulator through the Swift binding: the async calls complete, and the core pairs with an
/// engine running on the runner, connects, hears a card and answers it with a signature the engine takes.
final class PhoneCoreTests: XCTestCase {
    func testAsyncCallsComplete() async throws {
        let steps = try await loopbackSelfTest()
        XCTAssertEqual(steps, ["bind server", "bind client", "dial", "open stream", "write", "read echo", "close"])
    }

    /// The runner's engine hands its QR over a loopback socket: never on a command line or in a log.
    private func readQR() throws -> String {
        var input: InputStream?
        var output: OutputStream?
        Stream.getStreamsToHost(withName: "127.0.0.1", port: 8787, inputStream: &input, outputStream: &output)
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

    func testPairsWithTheEngineAndAnswersACard() async throws {
        guard ProcessInfo.processInfo.environment["MOSS_PC_ENGINE"] == "1" else { throw XCTSkip("no engine (MOSS_PC_ENGINE=1)") }
        let qr = try readQR()
        XCTAssertTrue(qr.hasPrefix("clover-pair:1:"))
        let core = try PhoneCore(storage: MemStorage(), config: CoreConfig(deviceName: "iPhone test", holder: .keychain, os: .ios, relay: .disabled, bindAddr: nil))
        let pairing = try await core.beginPairing(qr: qr, app: .code)
        XCTAssertEqual(pairing.words().count, 4)
        let computer = try await pairing.confirm()
        XCTAssertEqual(computer.app, .code)
        let conn = try await core.connect(computerId: computer.id, options: ConnectOptions(clientName: "iphone test", areas: ["approvals", "bots"], callTimeoutMs: 30_000))
        var answered = false
        while !answered {
            guard let e = await conn.nextEvent() else { XCTFail("the connection closed"); return }
            switch e {
            case .up:
                _ = try await conn.call(method: "bot.list", paramsJson: "{}")
            case let .notification(method, paramsJson):
                guard method == "core.event",
                      let p = try JSONSerialization.jsonObject(with: Data(paramsJson.utf8)) as? [String: Any],
                      p["type"] as? String == "card_requested",
                      let card = p["card"] as? [String: Any], let id = card["id"] as? String else { continue }
                let outcome = try await conn.answerCard(id: id, option: "approve", children: [])
                XCTAssertTrue(outcome.accepted)
                answered = true
            default:
                continue
            }
        }
        conn.close()
        await core.shutdown()
    }
}
