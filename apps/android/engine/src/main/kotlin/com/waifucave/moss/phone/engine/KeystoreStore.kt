package com.waifucave.moss.phone.engine

import android.content.Context
import android.os.UserManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import com.waifucave.moss.phonecore.SecretStorage
import com.waifucave.moss.phonecore.StorageException
import java.io.File
import java.io.IOException
import java.security.KeyStore
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The phone core's `SecretStorage` on Android, as the core's own Android test keeps it: each item (the device's link key, its
 * answer key, a pairing's key and secret, the paired computers' record) sealed with AES-256-GCM under a key the Android
 * Keystore makes and holds, which never leaves it. Only the sealed bytes are on disk, one file per item in the app's
 * `noBackupFilesDir` (left out of every backup by the system, and by the app's backup and transfer rules as well).
 *
 * - No user authentication is asked for the key (no fingerprint, face or device-credential prompt can come from it): it is
 *   usable once the phone has been unlocked after boot, as the core needs to answer cards and keep its link.
 * - `load` answers `null` only when the item does not exist. A store that can't be read now (the user not unlocked yet since
 *   boot, the Keystore busy) is `StorageException.NotAvailable`; an item that is there but can't be opened (its key is gone
 *   or changed, the bytes damaged) is `StorageException.Failed`. Neither is ever "not found", so the core never makes new keys
 *   over keys it couldn't read.
 * - The key is made only by `save`; [wipe] deletes every item and the key itself.
 * - No secret is in an error's text: errors name the item's kind of failure only.
 */
class KeystoreStore(context: Context, private val alias: String) : SecretStorage {
    private val app = context.applicationContext
    private val dir = File(app.noBackupFilesDir, "moss-phone-core-$alias")
    private val lock = Any()

    private fun unavailable(why: String) = StorageException.NotAvailable(why)
    private fun failed(why: String) = StorageException.Failed(why)

    /** An item's file: its name hex-encoded, so no name is a path. */
    private fun fileOf(name: String) = File(dir, name.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) })

    private fun checkUnlocked() {
        val um = app.getSystemService(UserManager::class.java)
        if (um != null && !um.isUserUnlocked) throw unavailable("the phone hasn't been unlocked since it started")
    }

    private fun keyStore(): KeyStore = try {
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    } catch (e: Exception) {
        throw unavailable("the Keystore can't be opened now")
    }

    private fun existingKey(): SecretKey? = try {
        keyStore().getKey(alias, null) as? SecretKey
    } catch (e: StorageException) {
        throw e
    } catch (e: UnrecoverableKeyException) {
        throw failed("the store's key can't be recovered")
    } catch (e: Exception) {
        throw unavailable("the Keystore can't be read now")
    }

    private fun makeKey(): SecretKey = try {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                // Said outright: no user authentication, so no prompt of any kind can come from this key.
                .setUserAuthenticationRequired(false)
                .build(),
        )
        gen.generateKey()
    } catch (e: Exception) {
        throw unavailable("the Keystore can't make the store's key now")
    }

    override fun load(name: String): ByteArray? = synchronized(lock) {
        checkUnlocked()
        val f = fileOf(name)
        if (!f.exists()) return null
        val raw = try { f.readBytes() } catch (e: IOException) { throw unavailable("an item can't be read now") }
        if (raw.size < 12 + 16) throw failed("an item is damaged")
        val key = existingKey() ?: throw failed("an item is there but the store's key is gone")
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, raw, 0, 12))
            cipher.doFinal(raw, 12, raw.size - 12)
        } catch (e: AEADBadTagException) {
            throw failed("an item doesn't open with the store's key")
        } catch (e: KeyPermanentlyInvalidatedException) {
            throw failed("the store's key was invalidated")
        } catch (e: ProviderException) {
            throw unavailable("the Keystore is busy")
        } catch (e: Exception) {
            throw failed("an item can't be opened")
        }
    }

    override fun save(name: String, value: ByteArray): Unit = synchronized(lock) {
        checkUnlocked()
        val key = existingKey() ?: makeKey()
        val sealed = try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val iv = cipher.iv
            if (iv.size != 12) throw failed("the Keystore gave an unexpected nonce")
            iv + cipher.doFinal(value)
        } catch (e: StorageException) {
            throw e
        } catch (e: ProviderException) {
            throw unavailable("the Keystore is busy")
        } catch (e: Exception) {
            throw failed("an item can't be sealed")
        }
        try {
            if (!dir.exists() && !dir.mkdirs()) throw IOException("no folder")
            val f = fileOf(name)
            val tmp = File(dir, f.name + ".new")
            tmp.writeBytes(sealed)
            if (!tmp.renameTo(f)) { tmp.delete(); throw IOException("not moved into place") }
        } catch (e: IOException) {
            throw unavailable("an item can't be written now")
        }
    }

    override fun delete(name: String): Unit = synchronized(lock) {
        val f = fileOf(name)
        if (f.exists() && !f.delete()) throw unavailable("an item can't be deleted now")
        Unit
    }

    /** How many items the store holds (the unpair proof: none). */
    /** Every file the store holds, a half-written `.new` one too: "nothing left" means no file at all. */
    /** Locked (before the first unlock after a boot) the folder can't be read: that is `NotAvailable`, never "empty". */
    fun itemCount(): Int = synchronized(lock) { checkUnlocked(); dir.listFiles()?.size ?: 0 }

    /** Whether the Keystore still holds the store's key. */
    fun hasKey(): Boolean = try { keyStore().containsAlias(alias) } catch (e: Exception) { false }

    /** Deletes every item and the Keystore key: after it, nothing of this phone's pairing or identity is left. */
    fun wipe(): Unit = synchronized(lock) {
        dir.listFiles()?.forEach { it.delete() }
        dir.delete()
        try { keyStore().deleteEntry(alias) } catch (e: Exception) { /* none to delete */ }
        Unit
    }
}
