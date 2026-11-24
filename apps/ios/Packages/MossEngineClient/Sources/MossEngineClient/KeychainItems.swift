import Foundation
import Security

/// The phone core's store on the iPhone: generic-password items of one service, in the app's own default access group
/// (one per app: MOSS and MOSS Code are two paired devices), kept on this device only (`…ThisDeviceOnly`: never synced,
/// never restored to another device from a backup) and readable after the first unlock (so the app reconnects in the
/// background). No item carries access control, so nothing here can raise a Face ID, Touch ID or passcode prompt.
///
/// "No such item" is `nil`. Anything else that keeps an item from being read is an error: the Keychain locked before the
/// first unlock is `notAvailable` (try later), never "not found", so the core never makes new keys over keys it
/// couldn't read. A save updates the item in place (or adds it), so a failed write never loses the key that was there.
public final class KeychainItems: @unchecked Sendable {
    public enum Failure: Error, Equatable {
        /// The Keychain can't be read now (before the first unlock): try again later.
        case notAvailable(String)
        case failed(String)
    }

    /// The four Security calls, replaceable in tests (a simulator can't lock its Keychain).
    public struct API: Sendable {
        public var copyMatching: @Sendable (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
        public var add: @Sendable (CFDictionary) -> OSStatus
        public var update: @Sendable (CFDictionary, CFDictionary) -> OSStatus
        public var delete: @Sendable (CFDictionary) -> OSStatus
        public static let system = API(copyMatching: { SecItemCopyMatching($0, $1) }, add: { SecItemAdd($0, nil) },
                                       update: { SecItemUpdate($0, $1) }, delete: { SecItemDelete($0) })
        public init(copyMatching: @escaping @Sendable (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus, add: @escaping @Sendable (CFDictionary) -> OSStatus,
                    update: @escaping @Sendable (CFDictionary, CFDictionary) -> OSStatus, delete: @escaping @Sendable (CFDictionary) -> OSStatus) {
            self.copyMatching = copyMatching; self.add = add; self.update = update; self.delete = delete
        }
    }

    public let service: String
    private let api: API
    private let lock = NSLock()

    public init(service: String, api: API = .system) { self.service = service; self.api = api }

    private func base(_ name: String? = nil) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
        if let name { q[kSecAttrAccount as String] = name }
        return q
    }

    static func failure(_ status: OSStatus, _ what: String) -> Failure {
        switch status {
        case errSecInteractionNotAllowed, errSecNotAvailable: return .notAvailable("the Keychain is locked")
        default: return .failed("Keychain \(what) failed (\(status))")
        }
    }

    public func load(_ name: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        var q = base(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = api.copyMatching(q as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let d = out as? Data else { throw Failure.failed("the Keychain item isn't data") }
            return d
        case errSecItemNotFound: return nil
        default: throw Self.failure(status, "read")
        }
    }

    public func save(_ name: String, _ value: Data) throws {
        lock.lock(); defer { lock.unlock() }
        let attrs: [String: Any] = [kSecValueData as String: value, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = api.update(base(name) as CFDictionary, attrs as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw Self.failure(status, "write") }
        let added = api.add(base(name).merging(attrs) { $1 } as CFDictionary)
        guard added == errSecSuccess else { throw Self.failure(added, "write") }
    }

    public func delete(_ name: String) throws {
        lock.lock(); defer { lock.unlock() }
        let status = api.delete(base(name) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.failure(status, "delete") }
    }

    /// Every item of this service: what an unpair removes (the pairing's items and the device's own keys).
    public func deleteAll() throws {
        lock.lock(); defer { lock.unlock() }
        let status = api.delete(base() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.failure(status, "delete") }
    }

    /// How many items this service holds now (for the unpair's proof).
    public func count() throws -> Int {
        lock.lock(); defer { lock.unlock() }
        var q = base()
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let status = api.copyMatching(q as CFDictionary, &out)
        switch status {
        case errSecSuccess: return (out as? [[String: Any]])?.count ?? 0
        case errSecItemNotFound: return 0
        default: throw Self.failure(status, "read")
        }
    }
}
