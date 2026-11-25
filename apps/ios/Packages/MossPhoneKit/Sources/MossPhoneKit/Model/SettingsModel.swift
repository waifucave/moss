import Foundation
import Observation

/// The Settings screen: the paired computer, Unpair behind a confirmation, and the app's version.
@MainActor @Observable
public final class SettingsModel {
    public private(set) var computer: PairedComputer?
    public private(set) var connection: ConnectionState = .connected
    public var confirmingUnpair = false
    public let version: String
    @ObservationIgnored private let client: EngineClient

    public init(client: EngineClient, version: String = SettingsModel.bundleVersion()) { self.client = client; self.version = version }

    nonisolated public static func bundleVersion(_ bundle: Bundle = .main) -> String {
        let v = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let b = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return "\(v) (\(b))"
    }

    public func load() async {
        computer = await client.pairedComputer
        connection = await client.connectionState()
    }

    /// "Seen now", "Seen 2 h ago": when the link last carried anything.
    public func lastSeenText(now: Int64) -> String {
        if case .connected = connection { return "Connected now" }
        let at: Int64? = { if case .unreachable(let s) = connection { return s ?? computer?.lastSeen } else { return nil } }()
        guard let at else { return "Not reachable now" }
        let f = RelativeDateTimeFormatter(); f.unitsStyle = .full
        let s = f.localizedString(for: Date(timeIntervalSince1970: Double(at) / 1000), relativeTo: Date(timeIntervalSince1970: Double(now) / 1000))
        return "Last seen \(s)"
    }

    /// The person confirmed. Forgets this computer; the app goes back to the pairing screen.
    public func unpair() async {
        await client.unpair()
        computer = nil
        confirmingUnpair = false
    }
}
