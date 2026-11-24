import Foundation
import Network

/// The runner's engine (EngineTests/harness/engine.ts), driven over its loopback control port: one JSON line per
/// command, one line back. The QR and the words travel only on this socket.
final class Harness: @unchecked Sendable {
    struct Failure: Error, CustomStringConvertible { var description: String }

    private let connection: NWConnection
    private let queue = DispatchQueue(label: "iw.harness")
    private var buffer = Data()
    private var waiting: [Int: CheckedContinuation<Any, Error>] = [:]
    private var next = 1
    private let lock = NSLock()

    init(port: UInt16 = 8790) {
        connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    }

    func open() async throws {
        final class Once: @unchecked Sendable { var done = false }
        let once = Once()
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
            // The state handler runs on the connection's own serial queue: one resume only.
            connection.stateUpdateHandler = { s in
                guard !once.done else { return }
                switch s {
                case .ready: once.done = true; k.resume()
                case .failed(let e), .waiting(let e): once.done = true; k.resume(throwing: e)
                default: break
                }
            }
            connection.start(queue: queue)
        }
        receive()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            guard let self else { return }
            if let data { self.take(data) }
            if done || error != nil {
                self.lock.lock(); let all = self.waiting; self.waiting = [:]; self.lock.unlock()
                for k in all.values { k.resume(throwing: Failure(description: "the harness closed the control connection")) }
                return
            }
            self.receive()
        }
    }

    private func take(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            buffer = Data(buffer[(nl + 1)...])
            guard let o = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], let id = (o["id"] as? NSNumber)?.intValue else { continue }
            lock.lock(); let k = waiting.removeValue(forKey: id); lock.unlock()
            if (o["ok"] as? Bool) == true { k?.resume(returning: o["result"] ?? NSNull()) }
            else { k?.resume(throwing: Failure(description: "harness: \(o["error"] as? String ?? "failed")")) }
        }
    }

    @discardableResult
    func run(_ cmd: String, _ params: [String: Any] = [:]) async throws -> Any {
        let id = lock.withLock { () -> Int in let i = next; next += 1; return i }
        var body = params
        body["id"] = id; body["cmd"] = cmd
        let line = try JSONSerialization.data(withJSONObject: body) + Data([0x0A])
        return try await withCheckedThrowingContinuation { k in
            lock.lock(); waiting[id] = k; lock.unlock()
            connection.send(content: line, completion: .contentProcessed { e in
                if let e {
                    self.lock.lock(); let w = self.waiting.removeValue(forKey: id); self.lock.unlock()
                    w?.resume(throwing: e)
                }
            })
        }
    }

    func close() { connection.cancel() }
}
