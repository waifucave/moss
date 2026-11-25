import Foundation
import MossEngineClient
import MossEngineCore
import MossPhoneKit
import Security
import XCTest

/// Lane IW's proof, hosted in the app (so the Keychain entitlement is the app's own and the Keychain is real): the app's
/// real client pairs with an engine started on the runner (EngineTests/harness/engine.ts), comparing the four words with
/// the engine's own; lists the bots; sends in a conversation and sees the reply; sees a card waiting at connect and one
/// raised after it, and answers each from the card on screen (the engine takes both); survives the engine restarting;
/// and unpairs, leaving no Keychain item. Each app's test bundle subclasses this with its own app.
class EngineFlowTests: XCTestCase {
    /// The app under test; each bundle's subclass sets it.
    class var app: MossPhoneKit.PhoneApp { .moss }
    /// The base class runs nothing itself: only each app's subclass does.
    override class var defaultTestSuite: XCTestSuite {
        self == EngineFlowTests.self ? XCTestSuite(name: "EngineFlowTests") : super.defaultTestSuite
    }
    /// Not the app's own service: the host app's real client keeps its items apart from the test's.
    let service = "com.waifucave.moss.phone.iwtest"

    /// The real store is reachable and keeps items as the core needs them: this device only, after the first unlock,
    /// never synchronised, and "no such item" is nil. It never skips: a Keychain this app can't reach fails it.
    func testKeychainStoreIsReal() throws {
        let items = KeychainItems(service: service + ".store")
        try items.deleteAll()
        defer { try? items.deleteAll() }
        XCTAssertNil(try items.load("absent"))
        try items.save("k", Data([1, 2, 3]))
        try items.save("k", Data([4, 5]))   // an update in place, never a delete first
        XCTAssertEqual(try items.load("k"), Data([4, 5]))
        var out: CFTypeRef?
        let status = SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: items.service,
                                          kSecAttrAccount as String: "k", kSecReturnAttributes as String: true] as CFDictionary, &out)
        XCTAssertEqual(status, errSecSuccess, "the Keychain isn't reachable from this app (\(status))")
        let attrs = out as? [String: Any] ?? [:]
        XCTAssertEqual(attrs[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertNotEqual(attrs[kSecAttrSynchronizable as String] as? Bool, true)
        // The Keychain reports the protection class alone as an access control (`cku`); the store never adds one, so no
        // item asks for Face ID, Touch ID or a passcode (a user-presence constraint would show as `od(...)` here).
        if let ac = attrs[kSecAttrAccessControl as String] { XCTAssertFalse(String(describing: ac).contains("od("), "no user-presence constraint: \(ac)") }
        try items.delete("k")
        XCTAssertNil(try items.load("k"))
        XCTAssertEqual(try items.count(), 0)
    }

    private func eventually(_ what: String, seconds: Double = 30, _ f: @MainActor () async -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if await f() { return }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTFail("timed out: \(what)")
        throw Harness.Failure(description: "timed out: \(what)")
    }

    @MainActor
    func testEndToEndOnTheRunnersEngine() async throws {
        guard ProcessInfo.processInfo.environment["MOSS_IW_ENGINE"] == "1" else { throw XCTSkip("no engine on this machine (MOSS_IW_ENGINE=1)") }
        let app = Self.app
        let harness = Harness()
        try await harness.open()
        defer { harness.close() }
        let items = KeychainItems(service: service)
        try items.deleteAll()

        // What each app shows: MOSS a bot and its conversation; MOSS Code a coding session.
        let bot = try await harness.run("makeBot", ["name": app == .moss ? "Alpha" : "Beta"]) as? [String: Any]
        var codingSession: String?
        if app == .code { codingSession = (try await harness.run("startCoding") as? [String: Any])?["session"] as? String }

        // A card already waiting when the phone connects (it is neither a bot's nor a session's: both apps show it).
        let begun = try await harness.run("begin") as! [String: Any]
        let pairingId = begun["pairingId"] as! String
        let qr = begun["qr"] as! String
        let atConnect = (try await harness.run("raiseCard", ["title": "Waiting at connect \(app.rawValue)"]) as! [String: Any])["cardId"] as! String

        // Pairing: the four words the phone shows are the engine's own, then both sides confirm.
        let client = MossEngine.client(app: app, service: service, deviceName: "iPhone test", relays: false)
        let proposal = try await client.beginPairing(code: qr)
        let engineWords = try await harness.run("words", ["pairingId": pairingId]) as? [String]
        XCTAssertEqual(proposal.words, engineWords)
        async let confirmed = client.confirmPairing(proposal)
        _ = try await harness.run("confirm", ["pairingId": pairingId, "words": engineWords ?? []])
        let computer = try await confirmed
        XCTAssertEqual(computer.name, "Studio")
        XCTAssertGreaterThan(try items.count(), 0, "the core's keys are in the Keychain")
        try await eventually("the link up") { await client.connectionState() == .connected }

        // The screens' models, on the real client.
        let cards = CardsModel(client: client, app: app)
        cards.start()
        try await eventually("the card waiting at connect on screen") { cards.cards.contains { $0.id == atConnect } }
        let raised = try await harness.run("raiseCard", app == .moss
            ? ["title": "Raised after connect", "rich": true, "bot": bot?["id"] as? String ?? ""]
            : ["title": "Raised after connect", "rich": true, "session": codingSession ?? ""]) as! [String: Any]
        let afterConnect = raised["cardId"] as! String
        try await eventually("the card raised after connect on screen") { cards.cards.contains { $0.id == afterConnect } }
        // The rich card: every field drawn, the nine-item list and the long reason cut; nothing answers until both are open.
        let rich = try XCTUnwrap(cards.cards.first { $0.id == afterConnect })
        XCTAssertTrue(rich.drawnWhole)
        XCTAssertEqual(rich.cutFields, ["paths", "reason"])
        for f in ["what", "command", "reason", "source", "host", "paths", "detail"] { XCTAssertNotNil(rich.fields[f], "the engine's card carries \(f)") }
        try await eventually("the new card's wait over") { !cards.settling.contains(afterConnect) }
        XCTAssertFalse(cards.mayAnswer(rich))
        await cards.answer(rich, with: rich.options.first { $0.kind == .approve }!)
        XCTAssertTrue(cards.cards.contains { $0.id == afterConnect }, "nothing was answered while a part was cut")
        cards.open("paths", of: rich); cards.open("reason", of: rich)
        for id in [atConnect, afterConnect] {
            let shown = cards.cards.first { $0.id == id }!
            let approve = shown.options.first { $0.kind == .approve }!
            try await eventually("\(id) answerable") { cards.mayAnswer(shown) }
            await cards.answer(shown, with: approve)
            XCTAssertNil(cards.notes[id], "the answer to \(id) was taken")
            let decision = try await harness.run("decision", ["cardId": id]) as? [String: Any]
            XCTAssertEqual(decision?["allowed"] as? Bool, true, "the engine took the phone's signed answer to \(id)")
        }

        // The conversation: a message out, the reply back, both through the link.
        let conversation: ConversationModel
        if app == .moss {
            let bots = try await client.bots()
            let alpha = try XCTUnwrap(bots.first { $0.name == "Alpha" })
            conversation = ConversationModel(source: .bot(alpha), client: client)
        } else {
            let rows = try await client.sessions()
            let row = try XCTUnwrap(rows.first { $0.id == codingSession })
            conversation = ConversationModel(source: .session(row), client: client)
        }
        conversation.start()
        try await eventually("the conversation loaded") { conversation.errorText == nil && conversation.offers != nil }
        let expected = app == .moss ? "Reply: Hello from the phone" : "Coding reply"
        conversation.draft = "Hello from the phone"
        let sent = await conversation.send()
        XCTAssertTrue(sent, conversation.errorText ?? "")
        try await eventually("the reply") { conversation.messages.contains { $0.text == expected } }
        XCTAssertTrue(conversation.messages.contains { $0.role == .user && $0.text == "Hello from the phone" })

        // A file goes only where the composer offers one, and then rides the next message.
        let offers = try XCTUnwrap(conversation.offers)
        print("IW offers: pictures \(offers.pictures) files \(offers.files) limit \(offers.fileLimit ?? -1)")
        // The runner's engine offers files to a paired phone (a phone with an answer key, a session this computer runs).
        XCTAssertTrue(offers.files, "the engine's composer offers files here")
        // The session the composer is for (a bot's is its main session).
        let sid = app == .moss ? (try await client.bots().first { $0.name == "Alpha" }?.mainSession ?? "") : (codingSession ?? "")
        if offers.files {
            // The client's own call first, so a refusal says why (the model's line is the person's plain one).
            do { let f = try await client.stageFile(session: sid, name: "probe.txt", data: Data("probe\n".utf8)); print("IW staged \(f.path)") }
            catch { print("IW stageFile refused: \(error)"); XCTFail("stageFile: \(error)") }
            await conversation.stageFile(name: "notes.txt", size: 12, data: Data("hello, file\n".utf8))
            XCTAssertEqual(conversation.stagedFiles.count, 1, conversation.errorText ?? "")
            conversation.draft = "With a file"
            let withFile = await conversation.send()
            XCTAssertTrue(withFile, conversation.errorText ?? "")
            try await eventually("the message with its file") { conversation.messages.contains { $0.role == .user && $0.text.hasPrefix("With a file") } }
        } else {
            do { _ = try await client.stageFile(session: "none", name: "x", data: Data([1])); XCTFail("a file where none is offered") } catch is NotAvailableYet {}
        }
        if offers.pictures {
            // The smallest PNG there is: one pixel.
            let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")!
            do { _ = try await client.stageImage(session: sid, data: png); print("IW picture staged") } catch { print("IW stageImage refused: \(error)") }
            await conversation.stage(png, thumbnail: png)
            XCTAssertEqual(conversation.staged.count, 1, conversation.errorText ?? "")
            conversation.draft = "With a picture"
            let withPicture = await conversation.send()
            XCTAssertTrue(withPicture, conversation.errorText ?? "")
        }
        if app == .moss {
            // A bot made from the phone (the engine's `bot.create` door): it is listed next.
            let made = try await client.createBot(name: "Gamma", model: nil)
            let listed = try await client.bots()
            XCTAssertTrue(listed.contains { $0.id == made.id })
        }

        // The engine restarts on the same home: the phone dials back, and the conversation keeps working.
        let before = conversation.messages.count
        _ = try await harness.run("restart")
        try await eventually("the link up again", seconds: 90) { await client.connectionState() == .connected }
        conversation.draft = "After the restart"
        var again = false
        try await eventually("a send after the restart", seconds: 60) {
            if !again { again = await conversation.send() }
            return again
        }
        try await eventually("the reply after the restart", seconds: 60) { conversation.messages.count >= before + 2 && conversation.messages.last?.role != .user }

        // Unpairing leaves nothing of the pairing in the Keychain, the device's own keys included.
        cards.stopListening(); conversation.stopListening()
        DefaultsPinStore(defaults: .standard).pinned = ["alpha"]
        await client.unpair()
        XCTAssertEqual(try items.count(), 0, "every Keychain item is gone")
        XCTAssertNil(UserDefaults.standard.object(forKey: DefaultsPinStore.defaultKey), "nothing of the computer stays in the app's settings")

        // Pairing again makes a new device; the computer revoking it leaves the phone with nothing of the pairing.
        let phonesBefore = Set(try await harness.run("phones") as? [String] ?? [])
        let again2 = try await harness.run("begin") as! [String: Any]
        let p2 = try await client.beginPairing(code: again2["qr"] as! String)
        let w2 = try await harness.run("words", ["pairingId": again2["pairingId"] as! String]) as? [String]
        XCTAssertEqual(p2.words, w2)
        async let c2 = client.confirmPairing(p2)
        _ = try await harness.run("confirm", ["pairingId": again2["pairingId"] as! String, "words": w2 ?? []])
        _ = try await c2
        try await eventually("the link up for the new device") { await client.connectionState() == .connected }
        let newPhones = Set(try await harness.run("phones") as? [String] ?? []).subtracting(phonesBefore)
        XCTAssertEqual(newPhones.count, 1, "the second pairing is a new device")
        _ = try await harness.run("revoke", ["device": newPhones.first ?? ""])
        try await eventually("the revoked phone keeps nothing", seconds: 60) { (try? items.count()) == 0 }
        let afterRevoke = await client.connectionState()
        XCTAssertNotEqual(afterRevoke, .connected)
    }
}
