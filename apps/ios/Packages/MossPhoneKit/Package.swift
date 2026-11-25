// swift-tools-version: 6.0
import PackageDescription

// The code both iPhone apps share: the models, the engine-client protocol and its in-memory fake, the pairing
// flow, the card views and the theme. No networking: lane PC's shared core will implement `EngineClient`.
let package = Package(
    name: "MossPhoneKit",
    platforms: [.iOS("26.0")],
    products: [.library(name: "MossPhoneKit", targets: ["MossPhoneKit"])],
    targets: [
        .target(
            name: "MossPhoneKit",
            resources: [.process("Resources/AgentMarks.xcassets"), .copy("Resources/living-bots.js")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "MossPhoneKitTests",
            dependencies: ["MossPhoneKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
