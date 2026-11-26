import XCTest

/// Runs Apple's accessibility audit on every screen of an app, at the default text size and at the largest accessibility
/// size, and prints each element's spoken label (what VoiceOver reads). Headless on a simulator.
@MainActor
enum AuditRunner {
    static let screensByApp: [String: [(String, [String])]] = [
        "com.waifucave.moss.ios": [
            ("home", ["-screen", "home"]), ("conversation", ["-screen", "conversation", "-scenario", "midTurn"]),
            ("cards", ["-screen", "cards"]), ("pairScan", ["-screen", "pairScan"]), ("pairWords", ["-screen", "pairWords"]),
            ("settings", ["-screen", "settings"]), ("unreachable", ["-screen", "home", "-scenario", "unreachable"]),
            ("empty", ["-screen", "home", "-scenario", "empty"]), ("cardStates", ["-screen", "cards", "-scenario", "cardStates"]), ("providerConsent", ["-screen", "cards", "-scenario", "providerConsent"]), ("manyPaths", ["-screen", "cards", "-scenario", "manyPaths"]),
            ("sendFails", ["-screen", "conversation", "-scenario", "sendFails"]),
        ],
        "com.waifucave.moss.code.ios": [
            ("sessions", ["-screen", "sessions"]), ("session", ["-screen", "session"]), ("cards", ["-screen", "cards"]),
            ("pairScan", ["-screen", "pairScan"]), ("pairWords", ["-screen", "pairWords"]), ("settings", ["-screen", "settings"]),
            ("newSession", ["-screen", "newSession"]), ("longQuestion", ["-screen", "session", "-open", "c5"]), ("unreachable", ["-screen", "sessions", "-scenario", "unreachable"]),
            ("empty", ["-screen", "sessions", "-scenario", "empty"]),
        ],
    ]

    /// A failed contrast that is known and owed: exactly these let through (on this app's screen, this element's label, at
    /// either size); any other failed contrast fails the audit. The list is to be emptied, never grown without an owner.
    struct KnownContrast { let app: String; let screen: String; let element: String; let reason: String; let owed: String }
    static let knownContrast: [KnownContrast] = [
        .init(app: "com.waifucave.moss.ios", screen: "home", element: "2",
              reason: "the bell's count: its text frame took in the white corners round the orange circle (the pictures show it); now a numbered circle symbol, to be removed when a run shows it stale",
              owed: "lane/iw-4"),
        .init(app: "com.waifucave.moss.ios", screen: "settings", element: "Paired computer",
              reason: "the first form header: its row-wide frame took in the soft shadow of the Done glass button (the pictures show it); now the text keeps its own width, to be removed when a run shows it stale",
              owed: "lane/iw-4"),
        .init(app: "com.waifucave.moss.code.ios", screen: "sessions", element: "1",
              reason: "the bell's count, as on MOSS's home (same cause, same fix)",
              owed: "lane/iw-4"),
        .init(app: "com.waifucave.moss.code.ios", screen: "sessions", element: "moss",
              reason: "the first project header: its row-wide frame took in the top bar's glass-button shadow (the pictures show it); now the text keeps its own width, to be removed when a run shows it stale",
              owed: "lane/iw-4"),
        .init(app: "com.waifucave.moss.code.ios", screen: "newSession", element: "-",
              reason: "the audit gives it no element; the screen's only light-grey text is the folder field's placeholder, now in the readable grey, to be removed when a run shows it stale",
              owed: "lane/iw-4"),
        .init(app: "com.waifucave.moss.code.ios", screen: "settings", element: "Paired computer",
              reason: "as on MOSS's settings (same cause, same fix)",
              owed: "lane/iw-4"),
    ]

    /// A known entry names an element by its label's first line (a question's label goes on over several lines), its
    /// no-break spaces read as plain ones (a clock's "4:26 AM" carries U+202F before "AM"); "-" is an element the audit
    /// gives no label.
    static func firstLine(_ label: String?) -> String {
        guard let label else { return "-" }
        let line = String(label.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        return line.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    /// Waits until the screen has stopped moving: every element's frame (so a scroll view's content and visible rect too)
    /// the same in consecutive snapshots across half a second, as the cards' settled rule asks, within a 15 s deadline.
    /// Past the deadline it says so and the audit goes ahead.
    static func settle(_ app: XCUIApplication, name: String, size: String?) {
        func frames() -> [CGRect] {
            guard let root = try? app.snapshot() else { return [] }
            var out: [CGRect] = []
            var stack: [XCUIElementSnapshot] = [root]
            while let s = stack.popLast() { out.append(s.frame); stack.append(contentsOf: s.children) }
            return out
        }
        let deadline = Date().addingTimeInterval(15)
        var last = frames()
        var steady = 0
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            let now = frames()
            steady = (!now.isEmpty && now == last) ? steady + 1 : 0
            last = now
            if steady >= 2 { return }
        }
        print("AUDIT UNSETTLED \(name) \(size ?? "default"): still moving after 15 s, audited as it is")
    }

    /// A failed contrast's evidence, kept in the result bundle: the whole screen (the bars and whatever is behind the
    /// element) and the element's own crop, with what the audit says it is, so the cause can be read, not guessed.
    static func keepPicture(of issue: XCUIAccessibilityAuditIssue, app: XCUIApplication, screen: String, size: String?, in test: XCTestCase) {
        let tag = "\(screen) \(size ?? "default") \(firstLine(issue.element?.label))"
        if let e = issue.element {
            print("AUDIT ELEMENT \(tag): type \(e.elementType.rawValue) id '\(e.identifier)' frame \(e.frame) :: \(issue.detailedDescription)")
        } else {
            print("AUDIT ELEMENT \(tag): no element :: \(issue.detailedDescription)")
        }
        let whole = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        whole.name = "contrast \(tag) (screen)"; whole.lifetime = .keepAlways
        test.add(whole)
        if let e = issue.element, e.exists, !e.frame.isEmpty {
            let crop = XCTAttachment(screenshot: e.screenshot())
            crop.name = "contrast \(tag) (element)"; crop.lifetime = .keepAlways
            test.add(crop)
        }
    }

    /// Conversation text scrolled under a bar is half-covered by design. On a conversation screen (it has the composer's
    /// bar, `chrome-composer`), a failed contrast is report-only when the element is the conversation's CONTENT and its
    /// frame overlaps the header's (the system navigation bar, which SwiftUI can't name) or the composer bar's frame by a
    /// non-zero area. A bar's own elements are never exempt, nor is an element that only touches a bar's edge. Returns
    /// the bar it is under, or nil.
    static func underChrome(_ element: XCUIElement?, in app: XCUIApplication) -> String? {
        guard let e = element, e.exists else { return nil }
        let composer = app.descendants(matching: .any).matching(identifier: "chrome-composer").firstMatch
        guard composer.exists else { return nil }
        let header = app.navigationBars.firstMatch
        let frame = e.frame
        func isOwn(_ bar: XCUIElement) -> Bool {
            bar.descendants(matching: e.elementType).allElementsBoundByIndex.contains { $0.frame == frame && $0.label == e.label }
        }
        for (name, bar) in [("header", header), ("composer", composer)] where bar.exists {
            let overlap = frame.intersection(bar.frame)
            guard !overlap.isNull, overlap.width > 0, overlap.height > 0 else { continue }
            if isOwn(bar) { return nil }
            return name
        }
        return nil
    }

    static func run(bundleID: String, size: String?, in test: XCTestCase) throws {
        test.continueAfterFailure = true
        // Known entries this run matched; one that matched nothing is printed as AUDIT STALE (its fix may have worked:
        // the entry is to be removed once a run shows it quiet), so the list can't keep an entry nobody needs.
        var matchedKnown: Set<String> = []
        defer {
            for k in knownContrast where k.app == bundleID && !matchedKnown.contains("\(k.screen)\t\(k.element)") {
                print("AUDIT STALE \(size ?? "default"): \(k.screen) :: \(k.element) matched nothing in this run")
            }
        }
        for (name, args) in screensByApp[bundleID] ?? [] {
            let app = XCUIApplication(bundleIdentifier: bundleID)
            // Still motion (as Reduce Motion asks, Debug builds only): the shimmering status line and a bot's face hold
            // still, so the screen settles and the audit reads one picture of it.
            app.launchArguments = args + ["-stillMotion"] + (size.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? [])
            app.launch()
            _ = app.wait(for: .runningForeground, timeout: 10)
            settle(app, name: name, size: size)
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
            // A failed contrast that isn't known: nil when it isn't one, else the element's first label line.
            func unknownFailedContrast(_ issue: XCUIAccessibilityAuditIssue) -> String? {
                guard issue.auditType == .contrast, !issue.compactDescription.localizedCaseInsensitiveContains("nearly") else { return nil }
                let element = firstLine(issue.element?.label)
                if let bar = underChrome(issue.element, in: app) {
                    print("AUDIT UNDER CHROME \(bar) \(name) \(size ?? "default"): \(element) (frame \(issue.element?.frame ?? .zero))")
                    return nil
                }
                if let known = knownContrast.first(where: { $0.app == bundleID && $0.screen == name && $0.element == element }) {
                    matchedKnown.insert("\(known.screen)\t\(known.element)")
                    print("AUDIT KNOWN \(name) \(size ?? "default"): \(known.element) (owed: \(known.owed))")
                    return nil
                }
                return element
            }
            // First pass: every type. A failed contrast is only noted here; it fails in the second pass when the SAME
            // element fails again on the settled screen.
            var failedOnce: Set<String> = []
            try app.performAccessibilityAudit(for: types) { issue in
                print("AUDIT ISSUE \(name) \(size ?? "default"): \(issue.compactDescription) :: \(issue.element?.label ?? "-")")
                // Missing descriptions, wrong traits, small hit regions and FAILED contrast (twice) fail the test. A contrast
                // that nearly passed, clipped text and Dynamic Type are reported only (the audit flags the system's own bars
                // and scrolled-away labels with those as well).
                // A file path is read out letter by letter on purpose: what a card shows is what it covers.
                if issue.auditType == .sufficientElementDescription, issue.element?.label.contains("/") == true { return true }
                if issue.auditType == .contrast {
                    if !issue.compactDescription.localizedCaseInsensitiveContains("nearly") { keepPicture(of: issue, app: app, screen: name, size: size, in: test) }
                    if let element = unknownFailedContrast(issue) { failedOnce.insert(element) }
                    return true
                }
                return [XCUIAccessibilityAuditType.dynamicType, .textClipped].contains(issue.auditType)
            }
            // Second pass: contrast only, after the screen settles again.
            var failedTwice: Set<String> = []
            if !failedOnce.isEmpty {
                settle(app, name: name, size: size)
                try app.performAccessibilityAudit(for: .contrast) { issue in
                    guard let element = unknownFailedContrast(issue) else { return true }
                    print("AUDIT ISSUE (second pass) \(name) \(size ?? "default"): \(issue.compactDescription) :: \(issue.element?.label ?? "-")")
                    guard failedOnce.contains(element) else {
                        print("AUDIT FLAKY \(name) \(size ?? "default"): \(element) (failed the second pass only)")
                        return true
                    }
                    failedTwice.insert(element)
                    return false
                }
                for element in failedOnce.subtracting(failedTwice).sorted() {
                    print("AUDIT FLAKY \(name) \(size ?? "default"): \(element) (failed the first pass only)")
                }
            }
            app.terminate()
        }
    }
}
