package com.waifucave.moss.phone.client

import android.os.Bundle
import com.waifucave.moss.phone.model.Bot
import com.waifucave.moss.phone.model.SessionRow
import com.waifucave.moss.phone.ui.AppLaunch
import com.waifucave.moss.phone.ui.AppLaunch.Screen
import com.waifucave.moss.phone.ui.ComposerPreset
import com.waifucave.moss.phone.ui.PresetFile
import com.waifucave.moss.phone.ui.Sample

/**
 * The fake build's start: a [FakeEngineClient] in a scenario, and the [AppLaunch] a picture or a test asks for. Only the
 * `fake` source set has this, so only the fake build reads an Intent's extras; the real build starts on `AppLaunch()` alone.
 */
data class FakeLaunch(val launch: AppLaunch, val scenario: FakeEngineClient.Scenario = FakeEngineClient.Scenario.idle) {
    /** The pairing screens start unpaired whatever the scenario. */
    val effectiveScenario: FakeEngineClient.Scenario
        get() = if (launch.screen == Screen.pairScan || launch.screen == Screen.pairWords) FakeEngineClient.Scenario.unpaired else scenario

    fun client(): FakeEngineClient = FakeEngineClient(effectiveScenario)
    fun still(): FakeLaunch = copy(launch = launch.copy(still = true))

    companion object {
        /** The sample file a picture stages, and one over the limit for the refusal. */
        val SAMPLE_FILE = PresetFile("Quarterly report.pdf", 1_240_000)
        val BIG_FILE = PresetFile("Site backup.zip", 60_000_000)

        fun of(
            screen: Screen = Screen.home,
            scenario: FakeEngineClient.Scenario = FakeEngineClient.Scenario.idle,
            startNew: Boolean = false, confirmUnpair: Boolean = false, scrollTop: Boolean = false, openID: String? = null,
            composer: FakeComposer = FakeComposer(), newBotName: String? = null,
        ): FakeLaunch {
            val sample = SampleComputer(scenario, screen)
            return FakeLaunch(
                AppLaunch(screen, startNew, confirmUnpair, scrollTop, openID, composer.preset(), newBotName = newBotName, sample = sample),
                scenario,
            )
        }

        /** A picture of one state on a device: the iPhone's launch arguments as extras (`--es screen conversation`). */
        fun fromExtras(b: Bundle?): FakeLaunch {
            if (b == null) return of()
            return of(
                screen = b.getString("screen")?.let { s -> Screen.entries.firstOrNull { it.name == s } } ?: Screen.home,
                scenario = b.getString("scenario")?.let { s -> FakeEngineClient.Scenario.entries.firstOrNull { it.name == s } } ?: FakeEngineClient.Scenario.idle,
                startNew = b.getBoolean("startNew"), confirmUnpair = b.getBoolean("confirmUnpair"), scrollTop = b.getBoolean("scrollTop"),
                openID = b.getString("open"),
                composer = FakeComposer(b.getString("draft"), b.getBoolean("focus"), b.getBoolean("picker"), b.getBoolean("file"), b.getBoolean("bigFile")),
                newBotName = b.getString("newBotName"),
            )
        }
    }
}

/** What a picture's composer starts with: a draft, the picker open, the sample file staged, or the big one refused. */
data class FakeComposer(val draft: String? = null, val focus: Boolean = false, val picker: Boolean = false, val file: Boolean = false, val bigFile: Boolean = false) {
    fun preset() = ComposerPreset(draft, focus, picker, if (file) FakeLaunch.SAMPLE_FILE else null, if (bigFile) FakeLaunch.BIG_FILE else null)
}

/** The sample computer the fake client serves ([SampleData]). */
private class SampleComputer(private val scenario: FakeEngineClient.Scenario, private val screen: Screen) : Sample {
    override val now: Long = SampleData.now
    override val computerName: String = SampleData.computerName
    override val pinned: List<String> = SampleData.pinned
    override val bots: List<Bot> = SampleData.bots
    override val sessions: List<SessionRow> = SampleData.sessions
    override val pairCode: String = "moss-pair:sample"
    override val unpaired: Boolean = screen == Screen.pairScan || screen == Screen.pairWords || scenario == FakeEngineClient.Scenario.unpaired
    override val sendsOnOpen: String? = if (scenario == FakeEngineClient.Scenario.sendFails) "Can you also look at the invoice?" else null
}
