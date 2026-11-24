import Foundation
import MossPhoneCore
import Security
import XCTest

/// A real store, as an iPhone app keeps the core's items: device-only generic passwords in the Keychain, readable after
/// the first unlock. "Not found" is `nil`; anything else that keeps an item from being read (the Keychain locked before
/// the first unlock) is an error, so the core never takes "can't read" for "isn't there".
final class KeychainStorage: SecretStorage, @unchecked Sendable {
    let service: String
    init(service: String) { self.service = service }

    private func query(_ name: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
    }

    func load(name: String) throws -> Data? {
        var q = query(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        switch status {
        case errSecSuccess: return out as? Data
        case errSecItemNotFound: return nil
        case errSecInteractionNotAllowed: throw StorageError.NotAvailable(reason: "the Keychain is locked")
        default: throw StorageError.Failed(reason: "Keychain read failed (\(status))")
        }
    }

    func save(name: String, value: Data) throws {
        SecItemDelete(query(name) as CFDictionary)
        var q = query(name)
        q[kSecValueData as String] = value
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw StorageError.Failed(reason: "Keychain write failed (\(status))") }
    }

    func delete(name: String) throws {
        let status = SecItemDelete(query(name) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StorageError.Failed(reason: "Keychain delete failed (\(status))") }
    }

    func wipe() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
    }
}

/// The iPhone real-store proof, run inside a host app that has a Keychain entitlement: the core's keys kept in the
/// Keychain survive a new core, and are what the Keychain holds. It never skips: a Keychain it can't reach fails it.
final class KeychainHostTests: XCTestCase {
    func testKeysKeptInTheKeychainSurviveANewCore() throws {
        let store = KeychainStorage(service: "com.waifucave.moss.phonecore.test")
        store.wipe()
        defer { store.wipe() }
        let config = CoreConfig(deviceName: "iPhone test", holder: .keychain, os: .ios, relay: .disabled, bindAddr: nil)
        let first = try PhoneCore(storage: store, config: config).identity()
        // Read back from the Keychain itself, not from the core: the device key is there, 32 bytes.
        XCTAssertEqual(try store.load(name: "device-key")?.count, 32)
        let again = try PhoneCore(storage: KeychainStorage(service: store.service), config: config).identity()
        XCTAssertEqual(first.deviceId, again.deviceId)
        XCTAssertEqual(first.answerKey, again.answerKey)
    }
}
