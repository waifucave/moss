import SwiftUI

/// The host the Keychain test runs in (it only lends its Keychain entitlement).
@main
struct KeychainHostApp: App {
    var body: some Scene {
        WindowGroup { Text("MOSS phone core test host") }
    }
}
