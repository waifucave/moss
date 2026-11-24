package com.waifucave.moss.code.android

import android.util.Log
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.hasContentDescription
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
 * MOSS Code on the real engine client, in an emulator, against the runner's engine: pairs, lists the sessions, opens one
 * and sends, sees the reply, answers a card the session raised, shows the session in the app's own screen, survives the
 * engine restarting, and unpairs.
 */
@RunWith(AndroidJUnit4::class)
class CodeEndToEndTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val TAG = "CodeE2E"

    @Test
    fun pairsListsSessionsTalksAnswersSurvivesARestartAndUnpairs(): Unit = runBlocking {
        withTimeout(900_000) {
            val ctx = InstrumentationRegistry.getInstrumentation().targetContext
            val client = Engines.client(ctx, PhoneApp.code, RelayChoice.Disabled)
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
            eventually("the engine lists this phone as code") { Runner.text("/phones").contains("\"app\":\"code\"") }
            eventually("connected") { client.connectionState() == ConnectionState.Connected && runCatching { client.sessions() }.isSuccess }

            // The sessions.
            val sessionId = Runner.json("/coding").getString("id")
            val list = SessionsListModel(client)
            eventually("the coding session in the list") { list.load(); list.groups.any { g -> g.sessions.any { it.id == sessionId } } }
            val row = list.sessions.first { it.id == sessionId }
            Log.i(TAG, "listed ${row.title}")

            val conv = ConversationModel(ConversationModel.Source.OfSession(row), client)
            val listening = launch(Dispatchers.Default) { conv.run() }
            eventually("the session loaded") { conv.errorText == null && conv.offers != null }
            conv.draft = "hello from Android"
            assertTrue("sent", conv.send())
            eventually("the reply") { conv.messages.any { it.role == MessageRole.agent && it.text == "Echo: hello from Android" } }
            Log.i(TAG, "the session answered")

            val cards = CardsModel(client, PhoneApp.code)
            val cardsListening = launch(Dispatchers.Default) { cards.run() }
            val cardId = Runner.json("/card?session=$sessionId").getString("cardId")
            eventually("the card shown") { cards.cards.any { it.id == cardId } }
            val card = cards.cards.first { it.id == cardId }
            cards.answer(card, card.options.first { it.kind == CardOption.Kind.approve })
            assertNull("no note: ${cards.notes[cardId]}", cards.notes[cardId])
            val decision = Runner.json("/decision?card=$cardId").getJSONObject("decision")
            assertTrue("approved: $decision", decision.getBoolean("allowed"))
            Log.i(TAG, "the card was answered")

            val scenario = ActivityScenario.launch(MainActivity::class.java)
            compose.waitUntil(60_000) { compose.onAllNodes(hasContentDescription("Phone test session.", substring = true)).fetchSemanticsNodes().isNotEmpty() }
            scenario.close()
            Log.i(TAG, "the app's screen shows the session")

            Runner.text("/restart")
            eventually("the sessions again after the restart", 180_000) {
                runCatching { client.sessions().any { it.id == sessionId } }.getOrDefault(false) && client.connectionState() == ConnectionState.Connected
            }
            eventually("a message after the restart", 120_000) { conv.draft = "again after a restart"; conv.send() }
            eventually("the reply after the restart", 120_000) { conv.messages.any { it.text == "Echo: again after a restart" } }
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
