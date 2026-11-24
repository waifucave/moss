package com.waifucave.moss.code.android

import android.content.Context
import com.waifucave.moss.phone.client.EngineClient

/** The fake build: no engine client, so the screens run on the in-memory sample. */
@Suppress("UNUSED_PARAMETER")
fun engineFor(context: Context): EngineClient? = null
