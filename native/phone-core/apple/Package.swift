// swift-tools-version:5.10
// The iPhone apps' package for the phone core (lane PC, proof C): the core built as an XCFramework (the iPhone, its
// simulator and macOS), and the Swift that UniFFI generates over it. Both are built in CI
// (.github/workflows/phone-core.yml), never committed.
import PackageDescription

let package = Package(
    name: "MossPhoneCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "MossPhoneCore", targets: ["MossPhoneCore"])],
    targets: [
        .binaryTarget(name: "MossPhoneCoreFFI", path: "MossPhoneCoreFFI.xcframework"),
        .target(
            name: "MossPhoneCore",
            dependencies: ["MossPhoneCoreFFI"],
            linkerSettings: [
                .linkedFramework("Network"),
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("Security"),
                .linkedFramework("CoreFoundation"),
                .linkedLibrary("resolv"),
            ]
        ),
        .testTarget(name: "MossPhoneCoreTests", dependencies: ["MossPhoneCore"]),
    ]
)
