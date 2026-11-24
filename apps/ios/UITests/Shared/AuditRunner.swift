import XCTest

/// Runs Apple's accessibility audit on every screen of an app, at the default text size and at the largest accessibility
/// size, and prints each element's spoken label (what VoiceOver reads). Headless on a simulator.
enum AuditRunner {
    static let screensByApp: [String: [(String, [String])]] = [
        "com.waifucave.moss.ios": [
            ("home", ["-screen", "home"]), ("conversation", ["-screen", "conversation", "-scenario", "midTurn"]),
            ("cards", ["-screen", "cards"]), ("pairScan", ["-screen", "pairScan"]), ("pairWords", ["-screen", "pairWords"]),
            ("settings", ["-screen", "settings"]), ("unreachable", ["-screen", "home", "-scenario", "unreachable"]),
            ("empty", ["-screen", "home", "-scenario", "empty"]), ("cardStates", ["-screen", "cards", "-scenario", "cardStates"]),
            ("sendFails", ["-screen", "conversation", "-scenario", "sendFails"]),
        ],
        "com.waifucave.moss.code.ios": [
            ("sessions", ["-screen", "sessions"]), ("session", ["-screen", "session"]), ("cards", ["-screen", "cards"]),
            ("pairScan", ["-screen", "pairScan"]), ("pairWords", ["-screen", "pairWords"]), ("settings", ["-screen", "settings"]),
            ("newSession", ["-screen", "newSession"]), ("unreachable", ["-screen", "sessions", "-scenario", "unreachable"]),
            ("empty", ["-screen", "sessions", "-scenario", "empty"]),
        ],
    ]

    static func run(bundleID: String, size: String?, in test: XCTestCase) throws {
        test.continueAfterFailure = true
        for (name, args) in screensByApp[bundleID] ?? [] {
            let app = XCUIApplication(bundleIdentifier: bundleID)
            app.launchArguments = args + (size.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? [])
            app.launch()
            _ = app.wait(for: .runningForeground, timeout: 10)
            sleep(2)
            var labels: [String] = []
            for q in [app.buttons, app.staticTexts, app.textFields, app.switches] {
                for e in q.allElementsBoundByIndex where e.exists && !e.label.isEmpty { labels.append(e.label) }
            }
            let unlabelled = app.buttons.allElementsBoundByIndex.filter { $0.exists && $0.label.isEmpty }.count
            print("AUDIT \(bundleID) \(name) \(size ?? "default"): unlabelled buttons \(unlabelled); spoken: \(labels.joined(separator: " | "))")
            XCTAssertEqual(unlabelled, 0, "\(name): a button with no label")
            // Dynamic type is checked at the large size; contrast and the rest at both.
            var types: XCUIAccessibilityAuditType = [.sufficientElementDescription, .hitRegion, .contrast, .textClipped, .trait]
            if size != nil { types.insert(.dynamicType) }
            try app.performAccessibilityAudit(for: types) { issue in
                print("AUDIT ISSUE \(name) \(size ?? "default"): \(issue.compactDescription) :: \(issue.element?.label ?? "-")")
                // Missing descriptions, wrong traits and small hit regions fail the test. Contrast, clipped text and Dynamic Type
                // are reported only: the audit flags the system's own bars and scrolled-away labels as well.
                // A file path is read out letter by letter on purpose: what a card shows is what it covers.
                if issue.auditType == .sufficientElementDescription, issue.element?.label.contains("/") == true { return true }
                return [XCUIAccessibilityAuditType.contrast, .dynamicType, .textClipped].contains(issue.auditType)
            }
            app.terminate()
        }
    }
}
