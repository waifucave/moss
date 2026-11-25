import XCTest

/// The drawn card's own buttons: a cut list or text offers the rest in place, and Allow stays disabled until every cut part
/// was opened; the provider-consent card draws its provider under "Site". On the fake, headless in a simulator.
final class CardGateUITests: XCTestCase {
    private func launch(_ scenario: String) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.waifucave.moss.ios")
        app.launchArguments = ["-screen", "cards", "-scenario", scenario]
        app.launch()
        return app
    }

    func testAllowWaitsUntilTheNinthPathIsOnScreen() throws {
        let app = launch("manyPaths")
        let allow = app.buttons["Allow"].firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["~/.ssh/authorized_keys"].exists, "the ninth path is cut at first")
        XCTAssertFalse(allow.isEnabled, "Allow is disabled while a part is cut")
        allow.tap()
        XCTAssertTrue(app.buttons["Allow"].firstMatch.exists, "a tap on a disabled Allow answers nothing")
        app.buttons["showAll-paths"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["~/.ssh/authorized_keys"].waitForExistence(timeout: 5), "Show all opens the list in place")
        XCTAssertFalse(allow.isEnabled, "the long reason is still cut")
        let more = app.buttons["showAll-reason"].firstMatch
        if !more.isHittable { app.swipeUp() }
        more.tap()
        let deadline = Date().addingTimeInterval(5)
        while !allow.isEnabled && Date() < deadline { usleep(200_000) }
        XCTAssertTrue(allow.isEnabled, "every cut part opened: Allow answers")
        app.terminate()
    }

    func testTheProviderConsentCardDrawsItsProvider() throws {
        let app = launch("providerConsent")
        XCTAssertTrue(app.staticTexts["Site"].waitForExistence(timeout: 10), "the host field is drawn with the desktop's label")
        XCTAssertTrue(app.staticTexts["fireworks"].exists, "the provider whose stored key is used is on screen")
        XCTAssertTrue(app.staticTexts["From"].exists)
        app.terminate()
    }
}
