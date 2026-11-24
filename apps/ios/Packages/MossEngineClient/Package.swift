// swift-tools-version: 6.0
import PackageDescription

// The real engine client of the iPhone apps (lane IW), in pure Swift: `CoreEngineClient` implements MossPhoneKit's
// `EngineClient` over `CoreLink`, a small mirror of the phone core's binding. It builds and tests without the core (the
// core's XCFramework is built only in CI); `MossEngineCore` (its own package) conforms the core's binding to `CoreLink`
// and holds the Keychain store the core keeps its keys in.
let package = Package(
    name: "MossEngineClient",
    platforms: [.iOS("26.0")],
    products: [.library(name: "MossEngineClient", targets: ["MossEngineClient"])],
    dependencies: [.package(path: "../MossPhoneKit")],
    targets: [
        .target(
            name: "MossEngineClient",
            dependencies: [.product(name: "MossPhoneKit", package: "MossPhoneKit")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "MossEngineClientTests",
            dependencies: ["MossEngineClient", .product(name: "MossPhoneKit", package: "MossPhoneKit")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
