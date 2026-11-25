package com.waifucave.moss.phone.ui

import android.content.Context
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.waifucave.moss.phone.client.FakeEngineClient
import com.waifucave.moss.phone.client.SampleData
import com.waifucave.moss.phone.model.Bot
import com.waifucave.moss.phone.model.PhoneApp
import com.waifucave.moss.phone.model.SessionRow
import com.waifucave.moss.phone.vm.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** What the process was asked to show, for pictures and tests of the apps (intent extras). Real runs pass none. */
data class AppLaunch(
    val screen: Screen = Screen.home,
    val scenario: FakeEngineClient.Scenario = FakeEngineClient.Scenario.idle,
    /** Opens the new-session screen, starts with the preselected choices and shows the result. */
    val startNew: Boolean = false,
    val confirmUnpair: Boolean = false,
    /** Opens conversations at their first message. */
    val scrollTop: Boolean = false,
    /** Which bot or session to open. */
    val openID: String? = null,
    val composer: ComposerPreset = ComposerPreset(),
    /** Pictures: faces hold still and nothing shimmers. */
    val still: Boolean = false,
    /** Pictures: the new-bot sheet opens with this name typed. */
    val newBotName: String? = null,
) {
    enum class Screen { home, conversation, cards, pairScan, pairWords, session, settings, newSession, newBot, search }

    val effectiveScenario: FakeEngineClient.Scenario
        get() = if (screen == Screen.pairScan || screen == Screen.pairWords) FakeEngineClient.Scenario.unpaired else scenario
    /** A send that fails on open, for the picture of a failed send. */
    val sendsOnOpen: String? get() = if (scenario == FakeEngineClient.Scenario.sendFails) "Can you also look at the invoice?" else null

    companion object {
        fun fromExtras(b: Bundle?): AppLaunch {
            if (b == null) return AppLaunch()
            return AppLaunch(
                screen = b.getString("screen")?.let { s -> Screen.entries.firstOrNull { it.name == s } } ?: Screen.home,
                scenario = b.getString("scenario")?.let { s -> FakeEngineClient.Scenario.entries.firstOrNull { it.name == s } } ?: FakeEngineClient.Scenario.idle,
                startNew = b.getBoolean("startNew"), confirmUnpair = b.getBoolean("confirmUnpair"), scrollTop = b.getBoolean("scrollTop"),
                openID = b.getString("open"),
                composer = ComposerPreset(b.getString("draft"), b.getBoolean("focus"), b.getBoolean("picker"), b.getBoolean("file"), b.getBoolean("bigFile")),
                newBotName = b.getString("newBotName"),
            )
        }
    }
}

fun appVersion(context: Context): String = try {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    "${info.versionName ?: "0"} ($code)"
} catch (e: Exception) { "0.1 (1)" }

/**
 * A plain back stack with the system's predictive back: while the person drags back, the screen in front shrinks and slides
 * with the finger and the one under it shows; letting go goes back, cancelling restores it.
 */
@Composable
fun <T : Any> BackStack(stack: SnapshotStateList<T>, content: @Composable (T) -> Unit) {
    var progress by remember { mutableFloatStateOf(0f) }
    var fromLeft by remember { mutableStateOf(true) }
    PredictiveBackHandler(enabled = stack.size > 1) { events ->
        try {
            events.collect { progress = it.progress; fromLeft = it.swipeEdge == androidx.activity.BackEventCompat.EDGE_LEFT }
            if (stack.size > 1) stack.removeAt(stack.lastIndex)
        } catch (e: CancellationException) {
            throw e
        } finally {
            progress = 0f
        }
    }
    Box(Modifier.fillMaxSize()) {
        if (progress > 0f && stack.size > 1) {
            val under = stack[stack.size - 2]
            key(under) { content(under) }
        }
        val top = stack.last()
        key(top) {
            Box(Modifier.fillMaxSize().graphicsLayer {
                val p = progress
                if (p > 0f) {
                    val s = 1f - 0.1f * p
                    scaleX = s; scaleY = s
                    translationX = (if (fromLeft) 1f else -1f) * p * 0.08f * size.width
                    shape = RoundedCornerShape(32.dp)
                    clip = true
                }
            }) { content(top) }
        }
    }
}

sealed class MossDest {
    data object Home : MossDest()
    data class Conversation(val bot: Bot) : MossDest()
    data object NeedsYou : MossDest()
    data object Settings : MossDest()
}

/** The MOSS app: the bots, and what needs the person. The app module holds only this; the rest is shared. */
@Composable
fun MossApp(launch: AppLaunch = AppLaunch(), dark: Boolean = isSystemInDarkTheme()) {
    val context = LocalContext.current
    val client = remember { FakeEngineClient(launch.effectiveScenario) }
    val bots = remember { BotsListModel(client, MemoryPinStore(SampleData.pinned)) }
    val cards = remember { CardsModel(client, PhoneApp.moss) { SampleData.now } }
    val pairing = remember { PairingModel(client) }
    val settings = remember { SettingsModel(client, appVersion(context)).also { it.confirmingUnpair = launch.confirmUnpair } }
    val newBot = remember { NewBotModel(client).also { it.name = launch.newBotName ?: "" } }
    val scope = rememberCoroutineScope()
    var paired by remember { mutableStateOf(launch.effectiveScenario != FakeEngineClient.Scenario.unpaired) }
    var showNewBot by remember { mutableStateOf(launch.screen == AppLaunch.Screen.newBot) }
    val stack = remember {
        mutableStateListOf<MossDest>(MossDest.Home).also { s ->
            when (launch.screen) {
                AppLaunch.Screen.conversation -> SampleData.bots.firstOrNull { it.id == (launch.openID ?: "alpha") }?.let { s.add(MossDest.Conversation(it)) }
                AppLaunch.Screen.cards -> s.add(MossDest.NeedsYou)
                AppLaunch.Screen.settings -> s.add(MossDest.Settings)
                else -> {}
            }
        }
    }
    LaunchedEffect(cards) { cards.run() }
    LaunchedEffect(launch.screen) { if (launch.screen == AppLaunch.Screen.pairWords) pairing.scanned("moss-pair:sample") }

    MossTheme(dark) {
        CompositionLocalProvider(LocalNow provides SampleData.now, LocalStill provides launch.still) {
            if (!paired) {
                PairingScreen(pairing, "MOSS") { paired = true }
            } else {
                BackStack(stack) { dest ->
                    when (dest) {
                        MossDest.Home -> BotsScreen(bots, cards, SampleData.computerName,
                            onSettings = { stack.add(MossDest.Settings) }, onBell = { stack.add(MossDest.NeedsYou) },
                            onNew = { showNewBot = true }, onOpen = { stack.add(MossDest.Conversation(it)) },
                            startSearching = launch.screen == AppLaunch.Screen.search)
                        is MossDest.Conversation -> {
                            val model = remember(dest) { ConversationModel(ConversationModel.Source.OfBot(dest.bot), client, autoSend = launch.sendsOnOpen) }
                            ConversationScreen(model, cards, onBack = { stack.removeAt(stack.lastIndex) }, preset = launch.composer, startsAtTop = launch.scrollTop)
                        }
                        MossDest.NeedsYou -> NeedsYouScreen(cards, { c -> c.bot?.let { id -> SampleData.bots.firstOrNull { it.id == id }?.name } ?: "A bot" }) {
                            stack.removeAt(stack.lastIndex)
                        }
                        MossDest.Settings -> SettingsScreen(settings, "MOSS", onUnpaired = {
                            stack.clear(); stack.add(MossDest.Home); paired = false; pairing.retry()
                        }, onBack = { stack.removeAt(stack.lastIndex) })
                    }
                }
                if (showNewBot) NewBotSheet(newBot, SampleData.computerName, onCreated = { bot ->
                    showNewBot = false
                    newBot.name = ""
                    scope.launch { bots.load(); stack.add(MossDest.Conversation(bot)) }
                }, onCancel = { showNewBot = false })
            }
        }
    }
}

sealed class CodeDest {
    data object Home : CodeDest()
    data class Session(val session: SessionRow) : CodeDest()
    data object NeedsYou : CodeDest()
    data object Settings : CodeDest()
    data object NewSession : CodeDest()
}

/** The MOSS Code app: the sessions with coding agents, and what needs the person. */
@Composable
fun MossCodeApp(launch: AppLaunch = AppLaunch(), dark: Boolean = isSystemInDarkTheme()) {
    val context = LocalContext.current
    val client = remember { FakeEngineClient(launch.effectiveScenario) }
    val sessions = remember { SessionsListModel(client) }
    val cards = remember { CardsModel(client, PhoneApp.code) { SampleData.now } }
    val pairing = remember { PairingModel(client) }
    val settings = remember { SettingsModel(client, appVersion(context)).also { it.confirmingUnpair = launch.confirmUnpair } }
    val newSession = remember { NewSessionModel(client, SampleData.computerName) }
    val scope = rememberCoroutineScope()
    var paired by remember { mutableStateOf(launch.effectiveScenario != FakeEngineClient.Scenario.unpaired) }
    val stack = remember {
        mutableStateListOf<CodeDest>(CodeDest.Home).also { s ->
            when (launch.screen) {
                AppLaunch.Screen.session -> SampleData.sessions.firstOrNull { it.id == (launch.openID ?: "c2") }?.let { s.add(CodeDest.Session(it)) }
                AppLaunch.Screen.cards -> s.add(CodeDest.NeedsYou)
                AppLaunch.Screen.settings -> s.add(CodeDest.Settings)
                AppLaunch.Screen.newSession -> s.add(CodeDest.NewSession)
                else -> {}
            }
        }
    }
    LaunchedEffect(cards) { cards.run() }
    LaunchedEffect(launch.screen) {
        if (launch.screen == AppLaunch.Screen.pairWords) pairing.scanned("moss-pair:sample")
        if (launch.startNew) {
            newSession.load()
            newSession.start()?.let { id ->
                sessions.load()
                sessions.sessions.firstOrNull { it.id == id }?.let { stack.add(CodeDest.Session(it)) }
            }
        }
    }

    MossTheme(dark) {
        CompositionLocalProvider(LocalNow provides SampleData.now, LocalStill provides launch.still) {
            if (!paired) {
                PairingScreen(pairing, "MOSS Code") { paired = true }
            } else BackStack(stack) { dest ->
                when (dest) {
                    CodeDest.Home -> SessionsScreen(sessions, cards, SampleData.computerName,
                        onSettings = { stack.add(CodeDest.Settings) }, onBell = { stack.add(CodeDest.NeedsYou) },
                        onNew = { stack.add(CodeDest.NewSession) }, onOpen = { stack.add(CodeDest.Session(it)) })
                    is CodeDest.Session -> {
                        val model = remember(dest) { ConversationModel(ConversationModel.Source.OfSession(dest.session), client, autoSend = launch.sendsOnOpen) }
                        ConversationScreen(model, cards, onBack = { stack.removeAt(stack.lastIndex) }, preset = launch.composer, startsAtTop = launch.scrollTop)
                    }
                    CodeDest.NeedsYou -> NeedsYouScreen(cards, { c -> c.session?.let { id -> SampleData.sessions.firstOrNull { it.id == id }?.title } ?: "A session" }) {
                        stack.removeAt(stack.lastIndex)
                    }
                    CodeDest.Settings -> SettingsScreen(settings, "MOSS Code", onUnpaired = {
                        stack.clear(); stack.add(CodeDest.Home); paired = false; pairing.retry()
                    }, onBack = { stack.removeAt(stack.lastIndex) })
                    CodeDest.NewSession -> NewSessionScreen(newSession, onStarted = { id ->
                        stack.removeAt(stack.lastIndex)
                        scope.launch {
                            sessions.load()
                            sessions.sessions.firstOrNull { it.id == id }?.let { stack.add(CodeDest.Session(it)) }
                        }
                    }, onCancel = { stack.removeAt(stack.lastIndex) })
                }
            }
        }
    }
}
