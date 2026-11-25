package com.waifucave.moss.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.waifucave.moss.phone.engine.Engines
import com.waifucave.moss.phone.model.PhoneApp
import com.waifucave.moss.phone.ui.MossApp

/**
 * The real build's activity: the shared core's client, one per process, and the app's root. It reads nothing from the
 * Intent that started it (the launcher's, or any other app's): no screen, scenario, draft, file or code comes in that way.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val engine = Engines.client(this, PhoneApp.moss)
        setContent { MossApp(engine) }
    }
}
