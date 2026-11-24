// swift-tools-version: 6.0
import PackageDescription

// The phone core under the real engine client (lane IW): conforms the core's Swift binding (native/phone-core/apple,
// whose XCFramework CI builds) to MossEngineClient's `CoreLink`, and keeps the core's items in the Keychain. Only the
// real flavour of the apps (project-real.yml) depends on it.
let package = Package(
    name: "MossEngineCore",
    platforms: [.iOS("26.0")],
    products: [.library(name: "MossEngineCore", targets: ["MossEngineCore"])],
    dependencies: [
        .package(path: "../MossEngineClient"),
        .package(path: "../MossPhoneKit"),
        .package(path: "../../../../native/phone-core/apple"),
    ],
    targets: [
        .target(
            name: "MossEngineCore",
            dependencies: [
                .product(name: "MossEngineClient", package: "MossEngineClient"),
                .product(name: "MossPhoneKit", package: "MossPhoneKit"),
                .product(name: "MossPhoneCore", package: "apple"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
