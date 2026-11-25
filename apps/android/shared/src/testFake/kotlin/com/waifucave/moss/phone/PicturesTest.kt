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
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.captureScreenRoboImage
import com.waifucave.moss.phone.client.FakeComposer
import com.waifucave.moss.phone.client.FakeEngineClient.Scenario
import com.waifucave.moss.phone.client.FakeLaunch
import com.waifucave.moss.phone.ui.AppLaunch.Screen
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
data class Picture(val name: String, val code: Boolean, val launch: FakeLaunch, val fontScale: Float = 1f, val press: String? = null)

private fun moss(name: String, launch: FakeLaunch, fontScale: Float = 1f, press: String? = null) = Picture("moss-$name", false, launch.still(), fontScale, press)
private fun code(name: String, launch: FakeLaunch, fontScale: Float = 1f) = Picture("code-$name", true, launch.still(), fontScale)

/** Every screen and state of both apps, as the iPhone's rounds pictured them. */
val PICTURES = listOf(
    moss("01-list", FakeLaunch.of(scenario = Scenario.quiet)),
    moss("02-list-waiting", FakeLaunch.of()),
    moss("03-search", FakeLaunch.of(Screen.search)),
    moss("04-conversation", FakeLaunch.of(Screen.conversation)),
    moss("05-conversation-top", FakeLaunch.of(Screen.conversation, scrollTop = true)),
    moss("06-composer-expanded", FakeLaunch.of(Screen.conversation, scenario = Scenario.quiet,
        composer = FakeComposer("Can you also check the other docs pages for the same typo, and send me a short list when you are done?", focus = true))),
    moss("07-picker", FakeLaunch.of(Screen.conversation, scenario = Scenario.quiet, composer = FakeComposer(picker = true))),
    moss("08-stop", FakeLaunch.of(Screen.conversation, scenario = Scenario.midTurn)),
    moss("09-question", FakeLaunch.of(Screen.conversation, openID = "luna")),
    moss("10-needs-you", FakeLaunch.of(Screen.cards)),
    moss("11-card-states", FakeLaunch.of(Screen.cards, scenario = Scenario.cardStates)),
    moss("12-send-failed", FakeLaunch.of(Screen.conversation, scenario = Scenario.sendFails)),
    moss("13-settings", FakeLaunch.of(Screen.settings)),
    moss("14-unpair-confirm", FakeLaunch.of(Screen.settings, confirmUnpair = true)),
    moss("15-new-bot", FakeLaunch.of(Screen.newBot, scenario = Scenario.quiet, newBotName = "Hazel")),
    moss("16-pair-scan", FakeLaunch.of(Screen.pairScan)),
    moss("17-pair-words", FakeLaunch.of(Screen.pairWords)),
    moss("18-unreachable", FakeLaunch.of(scenario = Scenario.unreachable)),
    moss("19-loading", FakeLaunch.of(scenario = Scenario.loading)),
    moss("20-empty", FakeLaunch.of(scenario = Scenario.empty)),
    moss("21-largest-text", FakeLaunch.of(), fontScale = 2f),
    moss("22-new-bot-empty", FakeLaunch.of(Screen.newBot, scenario = Scenario.quiet)),
    moss("23-file-chip", FakeLaunch.of(Screen.conversation, scenario = Scenario.quiet, composer = FakeComposer(file = true))),
    moss("24-files-row", FakeLaunch.of(Screen.conversation, scenario = Scenario.quiet, composer = FakeComposer(picker = true))),
    moss("26-new-bot-refused", FakeLaunch.of(Screen.newBot, scenario = Scenario.botLimit, newBotName = "Hazel"), press = "Create"),
    moss("28-provider-consent", FakeLaunch.of(Screen.cards, scenario = Scenario.providerConsent)),
    moss("29-card-scroll", FakeLaunch.of(Screen.cards, scenario = Scenario.tallCard)),
    moss("27-question-tall", FakeLaunch.of(Screen.conversation, scenario = Scenario.tallQuestion, openID = "luna")),
    moss("25-file-too-big", FakeLaunch.of(Screen.conversation, scenario = Scenario.quiet, composer = FakeComposer(bigFile = true))),
    code("01-sessions", FakeLaunch.of(scenario = Scenario.quiet)),
    code("02-sessions-waiting", FakeLaunch.of()),
    code("03-session", FakeLaunch.of(Screen.session)),
    code("04-composer-expanded", FakeLaunch.of(Screen.session, scenario = Scenario.quiet,
        composer = FakeComposer("Also run the settings tests after each page and tell me which ones fail before you go on.", focus = true))),
    code("05-picker", FakeLaunch.of(Screen.session, scenario = Scenario.quiet, composer = FakeComposer(picker = true))),
    code("06-stop", FakeLaunch.of(Screen.session, scenario = Scenario.midTurn, openID = "c1")),
    code("07-question", FakeLaunch.of(Screen.session, openID = "c4")),
    code("08-new-session", FakeLaunch.of(Screen.newSession)),
    code("09-session-started", FakeLaunch.of(startNew = true)),
    code("10-needs-you", FakeLaunch.of(Screen.cards)),
    code("11-settings", FakeLaunch.of(Screen.settings)),
    code("12-unpair-confirm", FakeLaunch.of(Screen.settings, confirmUnpair = true)),
    code("13-pair-words", FakeLaunch.of(Screen.pairWords)),
    code("14-unreachable", FakeLaunch.of(scenario = Scenario.unreachable)),
    code("15-loading", FakeLaunch.of(scenario = Scenario.loading)),
    code("16-empty", FakeLaunch.of(scenario = Scenario.empty)),
    code("17-largest-text", FakeLaunch.of(), fontScale = 2f),
    code("18-file-chip", FakeLaunch.of(Screen.session, scenario = Scenario.quiet, composer = FakeComposer(file = true))),
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
                Themed(dark, picture.fontScale) {
                    val client = remember { picture.launch.client() }
                    if (picture.code) MossCodeApp(client, picture.launch.launch, dark) else MossApp(client, picture.launch.launch, dark)
                }
            }
        }
        compose.waitForIdle()
        picture.press?.let { compose.onNodeWithText(it).performClick(); compose.waitForIdle() }
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
