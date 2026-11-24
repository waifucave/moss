package com.waifucave.moss.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.waifucave.moss.phone.ui.AppLaunch
import com.waifucave.moss.phone.ui.MossApp

/** The app holds only this: the root is shared with the other app's, in :shared. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val launch = AppLaunch.fromExtras(intent?.extras)
        val engine = engineFor(this)
        setContent { MossApp(launch, engine = engine) }
    }
}
