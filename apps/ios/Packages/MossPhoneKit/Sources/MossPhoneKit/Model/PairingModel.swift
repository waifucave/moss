import Foundation
import Observation

/// The first-run pairing: scan the code on the computer, show the four words, confirm.
@MainActor @Observable
public final class PairingModel {
    public enum Step: Equatable, Sendable {
        case scanning
        case checking
        case confirming(PairingProposal)
        case paired(PairedComputer)
        case failed(PairingError)
    }
    public private(set) var step: Step = .scanning
    @ObservationIgnored private let client: EngineClient

    public init(client: EngineClient, step: Step = .scanning) { self.client = client; self.step = step }

    public func scanned(_ code: String) async {
        guard step == .scanning else { return }
        step = .checking
        do { step = .confirming(try await client.beginPairing(code: code)) }
        catch let e as PairingError { step = .failed(e) }
        catch { step = .failed(.unreachable) }
    }

    /// The person says the four words match what the computer shows.
    public func confirm() async {
        guard case .confirming(let p) = step else { return }
        do { step = .paired(try await client.confirmPairing(p)) }
        catch let e as PairingError { step = .failed(e) }
        catch { step = .failed(.unreachable) }
    }

    /// The words do not match, or the person backs out.
    public func cancel() async {
        if case .confirming(let p) = step { await client.cancelPairing(p) }
        step = .scanning
    }
    public func retry() { step = .scanning }
}

public extension PairingError {
    var message: String {
        switch self {
        case .unreadableCode: return "That isn't a MOSS pairing code. Scan the code your computer shows."
        case .expired: return "That code has expired. Show a new one on your computer."
        case .wordsDoNotMatch: return "The words didn't match, so nothing was paired."
        case .unreachable: return "Can't reach your computer. Is it on and nearby?"
        }
    }
}
