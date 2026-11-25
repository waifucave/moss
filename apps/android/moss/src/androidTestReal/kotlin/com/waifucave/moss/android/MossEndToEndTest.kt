package com.waifucave.moss.android

import android.util.Log
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.waifucave.moss.phone.engine.Engines
import com.waifucave.moss.phone.model.*
import com.waifucave.moss.phone.vm.*
import com.waifucave.moss.phonecore.RelayChoice
import java.net.Socket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith


/**
 * The runner's engine, reached from the emulator at 10.0.2.2 (`apps/android/engine/e2e/engine.ts`'s control port), over a
 * plain socket: the app's network rules refuse cleartext HTTP, and the control port is loopback on the runner only.
 */
object Runner {
    fun text(path: String): String = Socket("10.0.2.2", 8790).use { s ->
        s.soTimeout = 180_000
        s.getOutputStream().write("GET $path HTTP/1.1\r\nHost: 10.0.2.2\r\nConnection: close\r\n\r\n".toByteArray())
        val raw = s.getInputStream().readBytes().decodeToString()
        val status = raw.substringBefore("\r\n").split(" ").getOrNull(1)?.toIntOrNull() ?: 0
        val body = raw.substringAfter("\r\n\r\n", "")
        check(status in 200..299) { "$path answered $status: $body" }
        body
    }
    fun json(path: String): JSONObject = JSONObject(text(path))
}

/** A 1x1 PNG, for the picture a message carries. */
const val PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

/** What another app puts in the extras: never on the real build's screen. */
const val INJECTED = "INJECTED BY ANOTHER APP"

/** The call timeout this test's client uses, and how late the runner's engine answers a call it has already done. */
const val CALL_TIMEOUT_MS = 8_000L
const val LATE_MS = 14_000L

/** Polls until `cond` holds, or fails naming what it waited for. */
suspend fun eventually(what: String, ms: Long = 60_000, cond: suspend () -> Boolean) {
    val end = System.currentTimeMillis() + ms
    while (!cond()) {
        if (System.currentTimeMillis() > end) throw AssertionError("timed out: $what")
        delay(500)
    }
}

/**
 * MOSS on the real engine client, in an emulator, against a real engine on the runner (temp home, scripted "provider"):
 * pairs, lists the bots, opens a conversation and sends, sees the reply, sees a card the engine raises and answers it from
 * the card the screen's model holds, shows it all in the app's own screen, survives the engine restarting, and unpairs.
 */
@RunWith(AndroidJUnit4::class)
class MossEndToEndTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val TAG = "MossE2E"

    @Test
    fun pairsTalksAnswersSurvivesARestartAndUnpairs(): Unit = runBlocking {
        withTimeout(900_000) {
            val ctx = InstrumentationRegistry.getInstrumentation().targetContext
            val client = Engines.client(ctx, PhoneApp.moss, RelayChoice.Disabled, callTimeoutMs = CALL_TIMEOUT_MS)
            client.unpair()
            // Pairing, as the pairing screen drives it: the code the computer shows, the four words compared with the ones the
            // engine's person read on its add card, then confirmed.
            val offer = Runner.json("/pair")
            val pairing = PairingModel(client)
            pairing.scanned(offer.getString("qr"))
            val proposal = (pairing.step as? PairingModel.Step.Confirming)?.proposal ?: throw AssertionError("no words: ${pairing.step}")
            val engineWords = Runner.text("/words?pairing=${offer.getString("pairingId")}").split(" ")
            assertEquals(engineWords, proposal.words)
            Log.i(TAG, "the four words match")
            pairing.confirm()
            assertTrue("paired: ${pairing.step}", pairing.step is PairingModel.Step.Paired)
            eventually("the engine lists this phone as moss") { Runner.text("/phones").contains("\"app\":\"moss\"") }
            eventually("connected") { client.connectionState() == ConnectionState.Connected && runCatching { client.sessions() }.isSuccess }

            // The bots.
            val botId = Runner.json("/bot").getString("id")
            val list = BotsListModel(client, MemoryPinStore())
            eventually("the bot in the list") { list.load(); list.rows.any { it.id == botId } }
            val bot = list.rows.first { it.id == botId }.bot
            Log.i(TAG, "listed ${bot.name}")

            // Its conversation: a message sent, the reply heard live.
            val conv = ConversationModel(ConversationModel.Source.OfBot(bot), client)
            val listening = launch(Dispatchers.Default) { conv.run() }
            eventually("the conversation loaded") { conv.errorText == null && conv.offers != null }
            conv.draft = "hello from Android"
            assertTrue("sent", conv.send())
            eventually("the reply") { conv.messages.any { it.role == MessageRole.bot && it.text == "Echo: hello from Android" } }
            assertTrue(conv.messages.any { it.role == MessageRole.user && it.text == "hello from Android" })
            Log.i(TAG, "the bot answered")

            // A picture and a file, as the composer offers them (`session.composerOffers` on the engine's phone doors).
            val offers = conv.offers!!
            assertTrue("pictures offered: $offers", offers.pictures)
            assertTrue("files offered: $offers", offers.files)
            val png = android.util.Base64.decode(PNG_1PX, android.util.Base64.DEFAULT)
            conv.stage(png, png)
            assertEquals("a picture staged: ${conv.errorText}", 1, conv.staged.size)
            val file = "hello from the phone\n".toByteArray()
            conv.stageFile("note.txt", file.size.toLong()) { file }
            assertEquals("a file staged: ${conv.errorText}", 1, conv.stagedFiles.size)
            conv.draft = "with a picture and a file"
            assertTrue("sent with attachments: ${conv.errorText}", conv.send())
            eventually("the reply to the attachments") { conv.messages.any { it.role == MessageRole.bot && it.text.startsWith("Echo: with a picture and a file") } }
            Log.i(TAG, "a picture and a file went with a message")

            // A new bot from the phone (`bot.create`), then in the list.
            val newBot = NewBotModel(client)
            newBot.load()
            newBot.name = "Hazel"
            val hazel = newBot.create() ?: throw AssertionError("no bot made: ${newBot.errorText}")
            eventually("the new bot in the list") { list.load(); list.rows.any { it.id == hazel.id } }
            Log.i(TAG, "made a bot")

            // A bot made while the computer answers only after the call's timeout: the phone reads the bots back, finds
            // the one it asked for (in the core's form of its name), and counts it as made. The computer holds it once.
            val botsBefore = Runner.json("/counts").getInt("bots")
            Runner.text("/late?what=bot&ms=$LATE_MS")
            val t1 = System.currentTimeMillis()
            val heldBot = client.createBot("Juniper", null)
            assertTrue("the call timed out first", System.currentTimeMillis() - t1 >= CALL_TIMEOUT_MS)
            assertEquals("Juniper", heldBot.name)
            delay(LATE_MS)
            assertEquals("one bot made", botsBefore + 1, Runner.json("/counts").getInt("bots"))
            Log.i(TAG, "a bot the computer answered late was read back as made")

            // A card the engine raises, answered from the card the model holds (the one the screen draws).
            val cards = CardsModel(client, PhoneApp.moss)
            val cardsListening = launch(Dispatchers.Default) { cards.run() }
            val cardId = Runner.json("/card?bot=$botId").getString("cardId")
            eventually("the card shown") { cards.cards.any { it.id == cardId } }
            val card = cards.cards.first { it.id == cardId }
            cards.answer(card, card.options.first { it.kind == CardOption.Kind.approve })
            assertNull("no note: ${cards.notes[cardId]}", cards.notes[cardId])
            assertFalse(cards.cards.any { it.id == cardId })
            val decision = Runner.json("/decision?card=$cardId").getJSONObject("decision")
            assertTrue("approved: $decision", decision.getBoolean("allowed"))
            Log.i(TAG, "the card was answered: $decision")

            // A card changed on the phone (other content than the core issued) is refused, and nothing reaches the computer.
            val heldId = Runner.json("/card?bot=$botId").getString("cardId")
            eventually("the second card shown") { cards.cards.any { it.id == heldId } }
            val heldCard = cards.cards.first { it.id == heldId }
            val once = heldCard.options.first { it.kind == CardOption.Kind.approve && !it.rememberAlways }
            val forged = heldCard.copy(fields = heldCard.fields + ("title" to SealedValue.Text("Something else")))
            assertTrue("a changed card is refused", runCatching { client.answer(forged, once) }.isFailure)
            assertTrue("still waiting on the computer", client.cards().any { it.id == heldId })
            // The computer takes the answer but answers only after the call's timeout: the phone reads the card back
            // (card.get), finds it answered with this very option, and counts the answer as given. Nothing is sent twice.
            Runner.text("/late?what=card&ms=$LATE_MS")
            val t0 = System.currentTimeMillis()
            client.answer(heldCard, once)
            assertTrue("the call timed out first", System.currentTimeMillis() - t0 >= CALL_TIMEOUT_MS)
            val heldDecision = Runner.json("/decision?card=$heldId").getJSONObject("decision")
            assertTrue("approved after the read-back: $heldDecision", heldDecision.getBoolean("allowed"))
            Log.i(TAG, "an answer the computer answered late was read back as given")

            // Another app starts the real build's activity with every extra the fake build reads (a scenario that sends on
            // open, a draft, a file to stage, a session to start, a screen, a pairing code): the real build reads none of them.
            val before = Runner.text("/counts")
            val hostile = android.content.Intent(ctx, MainActivity::class.java).apply {
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra("scenario", "sendFails"); putExtra("draft", INJECTED); putExtra("file", true); putExtra("bigFile", true)
                putExtra("startNew", true); putExtra("screen", "conversation"); putExtra("open", "$botId"); putExtra("newBotName", INJECTED)
            }
            val scenario = ActivityScenario.launch<MainActivity>(hostile)
            compose.waitUntil(60_000) { compose.onAllNodes(hasContentDescription("Echo.", substring = true)).fetchSemanticsNodes().isNotEmpty() }
            // The person opens the conversation, as the hostile scenario wanted: nothing is sent, typed or staged.
            compose.onAllNodes(hasContentDescription("Echo.", substring = true))[0].performClick()
            delay(4_000)
            compose.waitForIdle()
            assertTrue("no injected draft", compose.onAllNodes(hasText(INJECTED, substring = true)).fetchSemanticsNodes().isEmpty())
            assertTrue("no sample file", compose.onAllNodes(hasText("Quarterly", substring = true)).fetchSemanticsNodes().isEmpty())
            assertEquals("nothing reached the engine", before, Runner.text("/counts"))

            // A card the bot raises now shows in the open conversation; the person presses its drawn button.
            val drawnId = Runner.json("/card?bot=$botId").getString("cardId")
            eventually("the drawn card known") { client.cards().any { it.id == drawnId } }
            val drawn = client.cards().first { it.id == drawnId }
            val allow = drawn.options.first { it.kind == CardOption.Kind.approve && !it.rememberAlways }
            compose.waitUntil(60_000) { compose.onAllNodes(hasContentDescription(allow.label)).fetchSemanticsNodes().isNotEmpty() }
            delay(1_500) // past the moment a card new to the screen takes no press
            // The button's own click (its semantics action): the card can sit under the floating composer, where a tap at
            // the button's centre would land on the composer instead.
            val button = compose.onAllNodes(hasContentDescription(allow.label) and hasClickAction())[0]
            button.assertIsEnabled()
            button.performSemanticsAction(SemanticsActions.OnClick)
            val drawnDecision = Runner.json("/decision?card=$drawnId").getJSONObject("decision")
            assertTrue("the drawn button approved: $drawnDecision", drawnDecision.getBoolean("allowed"))
            Log.i(TAG, "the drawn button answered the card")
            scenario.close()
            Log.i(TAG, "the app's screen shows the bot, and no extra reached the engine")

            // The engine restarts: the link comes back by itself, and the conversation goes on.
            val sentBefore = Runner.json("/counts").getInt("botMessages")
            Runner.text("/restart")
            eventually("the link back after the restart", 180_000) { client.connectionState() == ConnectionState.Connected }
            // A send that fails is tried again only after the engine is read: a retry keeps the message's id, and the
            // engine must hold the message once, however many tries it took.
            conv.draft = "again after a restart"
            eventually("a message after the restart", 180_000) {
                Runner.json("/counts").getInt("botMessages") > sentBefore || conv.send()
            }
            eventually("the reply after the restart", 120_000) { conv.messages.any { it.text == "Echo: again after a restart" } }
            delay(3_000)
            assertEquals("exactly one message arrived", sentBefore + 1, Runner.json("/counts").getInt("botMessages"))
            assertEquals("one reply shown", 1, conv.messages.count { it.text == "Echo: again after a restart" })
            assertEquals(ConnectionState.Connected, client.connectionState())
            Log.i(TAG, "survived the restart")
            listening.cancel(); cardsListening.cancel()

            // Unpairing leaves nothing of the pairing or of this phone's identity in the store.
            val settings = SettingsModel(client, "test")
            settings.unpair()
            assertNull(client.pairedComputer())
            assertEquals(0, client.store.itemCount())
            assertFalse(client.store.hasKey())
            Log.i(TAG, "unpaired: the store is empty")

        }
    }
}
