package com.waifucave.moss.phonecore

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The host app's storage, in memory for the test (a real app keeps these in the Keystore). */
class MemStorage : SecretStorage {
    private val items = ConcurrentHashMap<String, ByteArray>()
    override fun load(name: String): ByteArray? = items[name]
    override fun save(name: String, value: ByteArray) { items[name] = value }
    override fun delete(name: String) { items.remove(name) }
}

/**
 * Proof B, inside an Android emulator: (1) the core's async calls complete on Android (binding iroh endpoints, a dial
 * and a stream, each step timed so a hang fails at a named step), and (2) the core pairs with a real engine running on
 * the runner (reached at 10.0.2.2), connects, hears a card and answers it with a signature the engine takes.
 */
@RunWith(AndroidJUnit4::class)
class PhoneCoreTest {
    private val tag = "MossPhoneCoreTest"

    @Test
    fun asyncCallsCompleteOnAndroid() = runBlocking {
        val steps = withTimeout(120_000) { loopbackSelfTest() }
        Log.i(tag, "self-test steps: $steps")
        assertEquals(listOf("bind server", "bind client", "dial", "open stream", "write", "read echo", "close"), steps)
    }

    @Test
    fun pairsWithTheEngineAndAnswersACard() = runBlocking {
        withTimeout(300_000) {
            // The runner's engine hands its QR over a socket on the host: never on a command line or in a log.
            val qr = Socket("10.0.2.2", 8787).use { it.getInputStream().readBytes().decodeToString() }
            val core = PhoneCore(MemStorage(), CoreConfig("Android test phone", AnswerKeyHolder.KEYSTORE, PhoneOs.ANDROID, RelayChoice.Disabled, null))
            Log.i(tag, "bound at ${core.start()}")
            val pairing = core.beginPairing(qr, PhoneApp.MOSS)
            Log.i(tag, "words shown (${pairing.words().size}); confirming")
            val computer = pairing.confirm()
            Log.i(tag, "paired with ${computer.name}")
            val conn = core.connect(computer.id, ConnectOptions("android test", listOf("approvals", "bots"), 30_000uL))
            var answered = false
            while (!answered) {
                when (val e = conn.nextEvent()) {
                    null -> error("the connection closed")
                    is ConnEvent.Up -> {
                        val bots = conn.call("bot.list", "{}")
                        Log.i(tag, "up; bot.list answered ${bots.length} bytes")
                    }
                    is ConnEvent.PendingCards -> Log.i(tag, "pending cards: ${e.cardsJson.length} bytes")
                    is ConnEvent.Notification -> {
                        val m = Regex("\"type\":\"card_requested\".*?\"id\":\"(card_[^\"]+)\"").find(e.paramsJson)
                            ?: Regex("\"id\":\"(card_[^\"]+)\"").find(e.paramsJson).takeIf { e.paramsJson.contains("card_requested") }
                        if (m != null) {
                            val card = m.groupValues[1]
                            val outcome = conn.answerCard(card, "approve", emptyList())
                            Log.i(tag, "answered $card: $outcome")
                            assertTrue(outcome.accepted)
                            answered = true
                        }
                    }
                    else -> Log.i(tag, "event $e")
                }
            }
            conn.close()
            core.shutdown()
        }
    }
}
