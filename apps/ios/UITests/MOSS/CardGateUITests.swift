import XCTest

/// The drawn card's own buttons, on the fake, headless in a simulator. Allow answers only what was on screen: a cut part is
/// opened in place and read to its end, the heading has been in sight below the bars, and a list that grows when opened
/// grows where the person is reading, not out of sight behind the buttons.
final class CardGateUITests: XCTestCase {
    private var running: XCUIApplication?
    private func launch(_ args: [String]) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.waifucave.moss.ios")
        app.launchArguments = args
        app.launch()
        running = app
        return app
    }
    /// On a failure the run keeps what was on screen: a screenshot and the view hierarchy, in the result bundle the
    /// workflow uploads.
    override func record(_ issue: XCTIssue) {
        var issue = issue
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "screen at failure"; shot.lifetime = .keepAlways
        issue.add(shot)
        if let app = running, app.state == .runningForeground {
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "view hierarchy at failure"; tree.lifetime = .keepAlways
            issue.add(tree)
        }
        super.record(issue)
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

    /// One short drag that lands where it stops (no coasting): towards the top of the content when `towardsTop`.
    private func nudge(_ app: XCUIApplication, towardsTop: Bool) {
        let w = app.windows.firstMatch
        let start = w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: towardsTop ? 0.45 : 0.5))
        let end = w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: towardsTop ? 0.5 : 0.45))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
        usleep(400_000)
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
        if !allow.isEnabled {
            // Why it waits, as the card says it (for the log).
            for t in app.staticTexts.allElementsBoundByIndex where t.label.contains("first") { print("IW card says: \(t.label)") }
            print("IW title hittable: \(app.staticTexts["Change nine files?"].isHittable)")
        }
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
        let last = app.staticTexts["notes/file-38.md"]
        var fifteenthSeen = fifteenth.exists && fifteenth.isHittable
        var lastSeen = last.exists && last.isHittable
        scroll(app, up: true, tries: 40, guardrail: {
            if fifteenth.exists && fifteenth.isHittable { fifteenthSeen = true }
            if last.exists && last.isHittable { lastSeen = true }
            if allow.isEnabled {
                XCTAssertTrue(fifteenthSeen, "Allow enabled before the 15th path was on screen")
                XCTAssertTrue(lastSeen, "Allow enabled before the list's last line was above the composer")
            }
        }, until: { allow.isEnabled })
        XCTAssertTrue(fifteenthSeen, "the 15th path was on screen")
        XCTAssertTrue(lastSeen, "the 38th path was on screen")
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
        let bar = app.navigationBars.firstMatch
        print("IW tall at start: title \(title.exists ? "\(title.frame)" : "absent") bar \(bar.frame) allow \(allow.isEnabled)")
        XCTAssertFalse(allow.isEnabled, "opened at its bottom, the heading out of sight: Allow waits")
        if !(title.exists && title.isHittable) {
            XCTAssertFalse(allow.isEnabled, "the heading hasn't been on screen: Allow waits")
            XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Scroll up to the top'")).firstMatch.exists, "it says why")
        }
        // Down towards the heading in short steps that don't coast, so it passes through the bar: while any of it is
        // under the bar Allow still waits, and it answers only once the heading is wholly below the bar.
        var underBarSeen = false
        for _ in 0..<80 {
            if title.exists {
                let t = title.frame, b = bar.frame
                if t.maxY > b.minY && t.minY < b.maxY - 1 {
                    XCTAssertFalse(allow.isEnabled, "the heading is under the bar: Allow waits")
                    underBarSeen = true
                }
                if t.minY >= b.maxY + 4 { break }
            }
            nudge(app, towardsTop: true)
        }
        XCTAssertTrue(underBarSeen, "the heading passed under the bar on its way into sight")
        sleep(1)
        scroll(app, up: true, until: { allow.isEnabled })
        XCTAssertTrue(allow.isEnabled, "the heading seen, nothing cut: Allow answers")
        app.terminate()
    }

    /// One question replaced by another while an option is picked: the new one shows nothing ticked, the app doesn't
    /// crash (the first had four options, the second two), and Submit has nothing to send until the person chooses again.
    func testAQuestionReplacedWhileAnOptionIsPickedStartsClean() throws {
        let app = launch(["-screen", "conversation", "-scenario", "questionSwitch", "-open", "alpha"])
        let fourth = app.buttons["Thursday"].firstMatch
        XCTAssertTrue(fourth.waitForExistence(timeout: 10), "the first question, with four options")
        fourth.tap()
        XCTAssertTrue(fourth.isSelected, "the fourth option is picked")
        XCTAssertTrue(app.staticTexts["Should the notes be public?"].waitForExistence(timeout: 40), "the second question took its place")
        XCTAssertEqual(app.state, .runningForeground, "no crash")
        XCTAssertFalse(app.buttons["Thursday"].exists, "the first question's options are gone")
        for label in ["Yes", "No"] { XCTAssertFalse(app.buttons[label].firstMatch.isSelected, "\(label) is not ticked: the person never chose it") }
        XCTAssertFalse(app.buttons["Submit"].firstMatch.isEnabled, "nothing chosen: nothing to submit")
        app.terminate()
    }

    /// A plugin OK on the phone: its checkboxes are drawn with the engine's ticks, the person's tick shows, Allow answers
    /// it; a card of twelve is cut at eight and Allow waits until the rest is opened and read.
    func testAPluginOKIsAnsweredWithItsCheckboxes() throws {
        let app = launch(["-screen", "cards", "-scenario", "pluginOK"])
        let mail = app.buttons["child-office-mail"].firstMatch
        XCTAssertTrue(mail.waitForExistence(timeout: 10), "the checkboxes are drawn")
        XCTAssertTrue(app.buttons["child-office"].firstMatch.isSelected, "ticked by the engine")
        XCTAssertFalse(mail.isSelected, "unticked by the engine")
        mail.tap()
        XCTAssertTrue(mail.isSelected, "the person's tick shows")
        let allow = app.buttons["Allow"].firstMatch
        scroll(app, up: true, until: { allow.isHittable && allow.isEnabled })
        XCTAssertTrue(allow.isEnabled, "seen whole, nothing cut: Allow answers")
        allow.tap()
        XCTAssertTrue(app.staticTexts["Turn on the Office plugin?"].waitForNonExistence(timeout: 10), "answered: the card goes")
        // Twelve checkboxes: cut at eight, and the last one is not on screen until opened.
        XCTAssertFalse(app.buttons["child-studio-12"].exists, "cut at eight")
        let show = app.buttons["showAll-children"].firstMatch
        scroll(app, up: true, until: { show.isHittable })
        show.tap()
        XCTAssertTrue(app.buttons["child-studio-12"].waitForExistence(timeout: 5), "opened in place")
        app.terminate()
    }

    /// A call of two questions: both are drawn, Submit waits until each has an answer, and then answers both together.
    func testACallOfTwoQuestionsIsAnsweredTogether() throws {
        let app = launch(["-screen", "conversation", "-open", "juniper"])
        XCTAssertTrue(app.staticTexts["Which day should I book the train for?"].waitForExistence(timeout: 10), "the first question")
        XCTAssertTrue(app.staticTexts["Which seats do you want?"].exists, "and the second, in the same box")
        let submit = app.buttons["Submit"].firstMatch
        XCTAssertFalse(submit.isEnabled, "nothing chosen")
        app.buttons["Saturday"].firstMatch.tap()
        XCTAssertFalse(submit.isEnabled, "the second question still has no answer")
        XCTAssertTrue(app.staticTexts["1 question still needs an answer."].exists, "it says why")
        let window = app.buttons["Window"].firstMatch
        scroll(app, up: true, until: { window.isHittable })
        window.tap()
        XCTAssertTrue(app.buttons["Saturday"].firstMatch.isSelected, "the first question's pick stays")
        XCTAssertTrue(submit.isEnabled, "each question has an answer")
        submit.tap()
        XCTAssertTrue(app.staticTexts["Which day should I book the train for?"].waitForNonExistence(timeout: 10), "answered: the box goes")
        app.terminate()
    }
}
