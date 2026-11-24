package com.waifucave.moss.phone.engine

import android.content.Context
import android.os.Build
import android.provider.Settings
import com.waifucave.moss.phone.model.PhoneApp
import com.waifucave.moss.phonecore.RelayChoice

/**
 * One real engine client per app process: the core binds one endpoint and keeps one link, so an activity recreated (a
 * rotation, a return from the background) uses the same one. Each app has its own store (its own package, its own
 * Keystore), so MOSS and MOSS Code pair on their own.
 */
object Engines {
    @Volatile private var client: CoreEngineClient? = null

    /** The app's client, made on first use. `relay` is read only then: `Disabled` for tests that dial the engine directly. */
    fun client(context: Context, app: PhoneApp, relay: RelayChoice = RelayChoice.Default): CoreEngineClient {
        client?.let { return it }
        synchronized(this) {
            client?.let { return it }
            val name = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
                ?.takeIf { it.isNotBlank() } ?: Build.MODEL ?: "Android phone"
            val made = CoreEngineClient(
                context, app,
                CoreEngineClient.Config(
                    deviceName = name, relay = relay, storeAlias = "moss-phone-core",
                    clientName = if (app == PhoneApp.moss) "MOSS for Android" else "MOSS Code for Android",
                ),
            )
            client = made
            return made
        }
    }
}
