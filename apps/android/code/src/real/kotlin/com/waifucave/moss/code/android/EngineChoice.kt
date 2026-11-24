package com.waifucave.moss.code.android

import android.content.Context
import com.waifucave.moss.phone.client.EngineClient
import com.waifucave.moss.phone.engine.Engines
import com.waifucave.moss.phone.model.PhoneApp

/** The real build: the shared core's client, one per process. */
fun engineFor(context: Context): EngineClient? = Engines.client(context, PhoneApp.code)
