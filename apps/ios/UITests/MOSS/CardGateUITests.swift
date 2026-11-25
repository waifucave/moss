import XCTest

/// The drawn card's own buttons, on the fake, headless in a simulator. Allow answers only what was on screen: a cut part is
/// opened in place and read to its end, the heading has been in sight below the bars, and a list that grows when opened
/// grows where the person is reading, not out of sight behind the buttons.
final class CardGateUITests: XCTestCase {
    private func launch(_ args: [String]) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.waifucave.moss.ios")
        app.launchArguments = args
        app.launch()
        return app
    }
    /// Swipes a little at a time (up: towards the end) until `done`, failing if `guardrail` breaks first.
    private func scroll(_ app: XCUIApplication, up: Bool, tries: Int = 25, guardrail: () -> Void = {}, until done: () -> Bool) {
        for _ in 0..<tries {
            guardrail()
            if done() { return }
            let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.6 : 0.4))
            let end = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.4 : 0.6))
            start.press(forDuration: 0.05, thenDragTo: end)
            usleep(400_000)
        }
        guardrail()
    }

    func testAllowWaitsUntilTheNinthPathIsOnScreen() throws {
        let app = launch(["-screen", "cards", "-scenario", "manyPaths"])
        let allow = app.buttons["Allow"].firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["~/.ssh/authorized_keys"].exists, "the ninth path is cut at first")
        XCTAssertFalse(allow.isEnabled, "Allow is disabled while a part is cut")
        XCTAssertTrue(app.buttons["Deny"].firstMatch.isEnabled, "Deny never waits to be read")
        app.buttons["showAll-paths"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["~/.ssh/authorized_keys"].waitForExistence(timeout: 5), "Show all opens the list in place")
        XCTAssertFalse(allow.isEnabled, "the long reason is still cut")
        scroll(app, up: true, until: { app.buttons["showAll-reason"].firstMatch.isHittable })
        app.buttons["showAll-reason"].firstMatch.tap()
        scroll(app, up: true, until: { allow.isEnabled })
        XCTAssertTrue(allow.isEnabled, "every cut part opened and read to its end: Allow answers")
        app.terminate()
    }

    func testTheProviderConsentCardDrawsItsProvider() throws {
        let app = launch(["-screen", "cards", "-scenario", "providerConsent"])
        XCTAssertTrue(app.staticTexts["Site"].waitForExistence(timeout: 10), "the host field is drawn with the desktop's label")
        XCTAssertTrue(app.staticTexts["fireworks"].exists, "the provider whose stored key is used is on screen")
        XCTAssertTrue(app.staticTexts["From"].exists)
        app.terminate()
    }

    /// The reviewer's case: in a conversation (opened at its bottom) a card at the foot lists 8 paths and 30 more, the
    /// 15th `~/.ssh/authorized_keys`. After "Show all 38" Allow stays disabled until the 15th path has been on screen and
    /// the list's end was reached.
    func testInAConversationAnOpenedListMustBeReadBeforeAllow() throws {
        let app = launch(["-screen", "conversation", "-scenario", "longCardChat", "-open", "alpha"])
        let show = app.buttons["showAll-paths"].firstMatch
        XCTAssertTrue(show.waitForExistence(timeout: 10))
        let allow = app.buttons["Allow"].firstMatch
        XCTAssertFalse(allow.isEnabled)
        show.tap()
        sleep(1)
        XCTAssertFalse(allow.isEnabled, "opening is not reading")
        let fifteenth = app.staticTexts["~/.ssh/authorized_keys"]
        var fifteenthSeen = fifteenth.exists && fifteenth.isHittable
        scroll(app, up: true, tries: 40, guardrail: {
            if fifteenth.exists && fifteenth.isHittable { fifteenthSeen = true }
            if allow.isEnabled { XCTAssertTrue(fifteenthSeen, "Allow enabled before the 15th path was on screen") }
        }, until: { allow.isEnabled })
        XCTAssertTrue(fifteenthSeen, "the 15th path was on screen")
        XCTAssertTrue(allow.isEnabled, "read to the end: Allow answers")
        app.terminate()
    }

    /// A card taller than the screen, opened at its bottom: its heading is out of sight (above, or under the bar), so
    /// Allow waits, with its reason on the card, until the heading has come into the visible part.
    func testATallCardOpenedAtItsBottomWaitsForItsHeading() throws {
        let app = launch(["-screen", "conversation", "-scenario", "tallCardChat", "-open", "alpha"])
        let allow = app.buttons["Allow"].firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 10))
        sleep(2)
        let title = app.staticTexts["Run this command?"]
        if !(title.exists && title.isHittable) {
            XCTAssertFalse(allow.isEnabled, "the heading hasn't been on screen: Allow waits")
            XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Scroll up to the top'")).firstMatch.exists, "it says why")
        }
        scroll(app, up: false, until: { title.exists && title.isHittable })
        scroll(app, up: true, until: { allow.isEnabled })
        XCTAssertTrue(allow.isEnabled, "the heading seen, nothing cut: Allow answers")
        app.terminate()
    }
}
