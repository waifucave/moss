package com.waifucave.moss.phone

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.captureScreenRoboImage
import com.waifucave.moss.phone.client.FakeEngineClient.Scenario
import com.waifucave.moss.phone.ui.AppLaunch
import com.waifucave.moss.phone.ui.AppLaunch.Screen
import com.waifucave.moss.phone.ui.ComposerPreset
import com.waifucave.moss.phone.ui.MossApp
import com.waifucave.moss.phone.ui.MossCodeApp
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.Locale
import java.util.TimeZone

/** One picture: which app, what it was launched to show, and the text scale. */
data class Picture(val name: String, val code: Boolean, val launch: AppLaunch, val fontScale: Float = 1f)

private fun moss(name: String, launch: AppLaunch, fontScale: Float = 1f) = Picture("moss-$name", false, launch.copy(still = true), fontScale)
private fun code(name: String, launch: AppLaunch, fontScale: Float = 1f) = Picture("code-$name", true, launch.copy(still = true), fontScale)

/** Every screen and state of both apps, as the iPhone's rounds pictured them. */
val PICTURES = listOf(
    moss("01-list", AppLaunch(scenario = Scenario.quiet)),
    moss("02-list-waiting", AppLaunch()),
    moss("03-search", AppLaunch(Screen.search)),
    moss("04-conversation", AppLaunch(Screen.conversation)),
    moss("05-conversation-top", AppLaunch(Screen.conversation, scrollTop = true)),
    moss("06-composer-expanded", AppLaunch(Screen.conversation, scenario = Scenario.quiet,
        composer = ComposerPreset("Can you also check the other docs pages for the same typo, and send me a short list when you are done?", focus = true))),
    moss("07-picker", AppLaunch(Screen.conversation, scenario = Scenario.quiet, composer = ComposerPreset(picker = true))),
    moss("08-stop", AppLaunch(Screen.conversation, scenario = Scenario.midTurn)),
    moss("09-question", AppLaunch(Screen.conversation, openID = "luna")),
    moss("10-needs-you", AppLaunch(Screen.cards)),
    moss("11-card-states", AppLaunch(Screen.cards, scenario = Scenario.cardStates)),
    moss("12-send-failed", AppLaunch(Screen.conversation, scenario = Scenario.sendFails)),
    moss("13-settings", AppLaunch(Screen.settings)),
    moss("14-unpair-confirm", AppLaunch(Screen.settings, confirmUnpair = true)),
    moss("15-new-bot", AppLaunch(Screen.newBot)),
    moss("16-pair-scan", AppLaunch(Screen.pairScan)),
    moss("17-pair-words", AppLaunch(Screen.pairWords)),
    moss("18-unreachable", AppLaunch(scenario = Scenario.unreachable)),
    moss("19-loading", AppLaunch(scenario = Scenario.loading)),
    moss("20-empty", AppLaunch(scenario = Scenario.empty)),
    moss("21-largest-text", AppLaunch(), fontScale = 2f),
    code("01-sessions", AppLaunch(scenario = Scenario.quiet)),
    code("02-sessions-waiting", AppLaunch()),
    code("03-session", AppLaunch(Screen.session)),
    code("04-composer-expanded", AppLaunch(Screen.session, scenario = Scenario.quiet,
        composer = ComposerPreset("Also run the settings tests after each page and tell me which ones fail before you go on.", focus = true))),
    code("05-picker", AppLaunch(Screen.session, scenario = Scenario.quiet, composer = ComposerPreset(picker = true))),
    code("06-stop", AppLaunch(Screen.session, scenario = Scenario.midTurn, openID = "c1")),
    code("07-question", AppLaunch(Screen.session, openID = "c4")),
    code("08-new-session", AppLaunch(Screen.newSession)),
    code("09-session-started", AppLaunch(startNew = true)),
    code("10-needs-you", AppLaunch(Screen.cards)),
    code("11-settings", AppLaunch(Screen.settings)),
    code("12-unpair-confirm", AppLaunch(Screen.settings, confirmUnpair = true)),
    code("13-pair-words", AppLaunch(Screen.pairWords)),
    code("14-unreachable", AppLaunch(scenario = Scenario.unreachable)),
    code("15-loading", AppLaunch(scenario = Scenario.loading)),
    code("16-empty", AppLaunch(scenario = Scenario.empty)),
    code("17-largest-text", AppLaunch(), fontScale = 2f),
)

/**
 * A PNG per screen in light and dark, drawn on the JVM (Robolectric's native graphics, no emulator), written to
 * `build/outputs/roborazzi/` by `gradle :shared:recordRoborazziDebug`. A phone of 412 by 915 dp at 480 dpi.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xxhdpi")
class PicturesTest(private val picture: Picture, private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{index}")
        fun pictures(): List<Array<Any>> = PICTURES.flatMap { listOf(arrayOf<Any>(it, false), arrayOf<Any>(it, true)) }
    }

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Before fun fixedClockFace() {
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        Locale.setDefault(Locale.US)
    }

    @OptIn(ExperimentalRoborazziApi::class)
    @Test fun picture() {
        // The test activity has a title bar; a phone app has none.
        compose.runOnUiThread { compose.activity.actionBar?.hide() }
        compose.setContent {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides compose.activity) {
                Themed(dark, picture.fontScale) { if (picture.code) MossCodeApp(picture.launch, dark) else MossApp(picture.launch, dark) }
            }
        }
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
        captureScreenRoboImage("build/outputs/roborazzi/${picture.name}-${if (dark) "dark" else "light"}.png")
    }
}

/** The phone in light or dark (so resources such as a mark's dark file follow), at a text scale. */
@Composable
private fun Themed(dark: Boolean, fontScale: Float, content: @Composable () -> Unit) {
    val base = LocalContext.current
    val context = remember(dark) {
        val config = Configuration(base.resources.configuration)
        config.uiMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
            (if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
        config.fontScale = fontScale
        base.createConfigurationContext(config)
    }
    val density = LocalDensity.current
    CompositionLocalProvider(
        LocalContext provides context,
        LocalConfiguration provides context.resources.configuration,
        LocalDensity provides Density(density.density, fontScale),
    ) { content() }
}
