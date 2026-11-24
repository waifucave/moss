package com.waifucave.moss.android

import android.util.Log
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
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
            val client = Engines.client(ctx, PhoneApp.moss, RelayChoice.Disabled)
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

            // The app's own screen on the same client shows the bot.
            val scenario = ActivityScenario.launch(MainActivity::class.java)
            compose.waitUntil(60_000) { compose.onAllNodesWithText("Echo").fetchSemanticsNodes().isNotEmpty() }
            scenario.close()
            Log.i(TAG, "the app's screen shows the bot")

            // The engine restarts: the link comes back by itself, and the conversation goes on.
            Runner.text("/restart")
            eventually("a message after the restart", 180_000) {
                conv.draft = "again after a restart"
                conv.send()
            }
            eventually("the reply after the restart", 120_000) { conv.messages.any { it.text == "Echo: again after a restart" } }
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
