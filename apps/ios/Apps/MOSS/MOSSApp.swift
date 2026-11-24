import SwiftUI
import MossPhoneKit
#if MOSS_REAL_ENGINE
import MossEngineCore
#endif

@main
struct MOSSApp: App {
    #if MOSS_REAL_ENGINE
    // The real engine (project-real.yml): the phone core over the Keychain. Pictures and UI tests still pass a screen
    // or a scenario and run on the fake.
    private let engine: (any EngineClient)? = MossEngine.client(app: .moss)
    #else
    private let engine: (any EngineClient)? = nil
    #endif
    var body: some Scene {
        WindowGroup { MossRoot(engine: engine) }
    }
}
