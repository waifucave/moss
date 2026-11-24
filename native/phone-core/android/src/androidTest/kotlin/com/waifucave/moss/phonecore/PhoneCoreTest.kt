package com.waifucave.moss.phonecore

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.Socket
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The host app's storage, in memory for the pairing test. */
class MemStorage : SecretStorage {
    private val items = ConcurrentHashMap<String, ByteArray>()
    override fun load(name: String): ByteArray? = items[name]
    override fun save(name: String, value: ByteArray) { items[name] = value }
    override fun delete(name: String) { items.remove(name) }
}

/**
 * A real store, as an Android app would keep the core's items: each value encrypted (AES-GCM) under a key the Android
 * Keystore holds, the ciphertext in the app's private preferences. The Keystore holds the wrapping key, never the
 * core's keys themselves (hence the holder `KEYSTORE_WRAPPED`).
 */
class KeystoreStorage(context: Context, private val alias: String) : SecretStorage {
    private val prefs = context.getSharedPreferences("moss-phone-core-test", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    override fun load(name: String): ByteArray? {
        val stored = prefs.getString(name, null) ?: return null
        val raw = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
        return cipher.doFinal(raw, 12, raw.size - 12)
    }

    override fun save(name: String, value: ByteArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(value)
        check(prefs.edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit())
    }

    override fun delete(name: String) {
        check(prefs.edit().remove(name).commit())
    }

    fun raw(name: String): String? = prefs.getString(name, null)

    fun wipe() {
        prefs.edit().clear().commit()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
    }
}

/**
 * Proof B, inside an Android emulator: (1) the core's async calls complete on Android (binding iroh endpoints, a dial
 * and a stream, each step timed so a hang fails at a named step); (2) its keys kept through the Android Keystore survive
 * a new core; (3) it pairs with a real engine running on the runner (reached at 10.0.2.2), the four words compared with
 * the engine's, connects, and answers the card it displayed with a signature the engine takes.
 */
@RunWith(AndroidJUnit4::class)
class PhoneCoreTest {
    private val tag = "MossPhoneCoreTest"
    private fun config(storageName: String) = CoreConfig(storageName, AnswerKeyHolder.KEYSTORE_WRAPPED, PhoneOs.ANDROID, RelayChoice.Disabled, null)

    @Test
    fun asyncCallsCompleteOnAndroid() = runBlocking {
        val steps = withTimeout(120_000) { loopbackSelfTest() }
        Log.i(tag, "self-test steps: $steps")
        assertEquals(listOf("bind server", "bind client", "dial", "open stream", "write", "read echo", "close"), steps)
    }

    @Test
    fun keysKeptThroughTheKeystoreSurviveANewCore() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = KeystoreStorage(context, "moss-phone-core-test")
        store.wipe()
        try {
            val first = PhoneCore(store, config("Android test phone")).identity()
            val again = PhoneCore(KeystoreStorage(context, "moss-phone-core-test"), config("Android test phone")).identity()
            assertEquals(first.deviceId, again.deviceId)
            assertEquals(first.answerKey, again.answerKey)
            // What the preferences hold is the Keystore's ciphertext, never the seed.
            assertNotEquals(32, Base64.decode(store.raw("device-key")!!, Base64.NO_WRAP).size)
            Log.i(tag, "identity kept through the Keystore: ${first.deviceId}")
        } finally {
            store.wipe()
        }
    }

    private fun fromRunner(port: Int): String = Socket("10.0.2.2", port).use { it.getInputStream().readBytes().decodeToString() }

    @Test
    fun pairsWithTheEngineAndAnswersTheCardItShows() = runBlocking {
        withTimeout(300_000) {
            // The runner's engine hands its QR over a socket on the host: never on a command line or in a log.
            val qr = fromRunner(8787)
            val core = PhoneCore(MemStorage(), config("Android test phone"))
            Log.i(tag, "bound at ${core.start()}")
            val pairing = core.beginPairing(qr, PhoneApp.MOSS)
            // The person compares the four words: these are the ones the engine's person read on its add card.
            val engineWords = fromRunner(8788).split(" ")
            assertEquals(engineWords, pairing.words())
            Log.i(tag, "the four words match; confirming")
            val computer = pairing.confirm()
            assertEquals(PhoneApp.MOSS, computer.app)
            Log.i(tag, "paired with ${computer.name}")
            val conn = core.connect(computer.id, ConnectOptions("android test", listOf("approvals", "bots"), 30_000uL))
            var answered = false
            while (!answered) {
                when (val e = conn.nextEvent()) {
                    null -> error("the connection closed")
                    is ConnEvent.CardRequested -> {
                        // The card as displayed is what is answered: no fetch between the tap and the signature.
                        val outcome = conn.answerCard(e.card, "approve", emptyList())
                        Log.i(tag, "answered ${e.card.id}: $outcome")
                        assertTrue(outcome.accepted)
                        answered = true
                    }
                    is ConnEvent.PendingCards -> e.cards.firstOrNull()?.let { card ->
                        val outcome = conn.answerCard(card, "approve", emptyList())
                        Log.i(tag, "answered pending ${card.id}: $outcome")
                        assertTrue(outcome.accepted)
                        answered = true
                    }
                    else -> Log.i(tag, "event $e")
                }
            }
            assertEquals(LinkState.UP, conn.state())
            conn.disconnect()
            core.shutdown()
        }
    }
}
