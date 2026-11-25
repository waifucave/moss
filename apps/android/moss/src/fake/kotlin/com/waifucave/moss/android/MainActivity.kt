package com.waifucave.moss.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.waifucave.moss.phone.client.FakeLaunch
import com.waifucave.moss.phone.ui.MossApp

/**
 * The fake build's activity: the in-memory sample, and the iPhone's launch arguments as extras for a picture of one state
 * on a device (`adb shell am start -n com.waifucave.moss.android/.MainActivity --es screen conversation`). Never the build a person runs.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val start = FakeLaunch.fromExtras(intent?.extras)
        val client = start.client()
        setContent { MossApp(client, start.launch) }
    }
}
