package com.waifucave.moss.phone.ui

import android.content.Context
import android.os.Build
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.foundation.background
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
import com.waifucave.moss.phone.client.EngineClient
import com.waifucave.moss.phone.model.Bot
import com.waifucave.moss.phone.model.Card
import com.waifucave.moss.phone.model.PhoneApp
import com.waifucave.moss.phone.model.SessionRow
import com.waifucave.moss.phone.vm.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * What a picture or a test of the apps starts on. The real build makes only `AppLaunch()`: no screen opened, nothing typed,
 * sent, staged or started, and no [Sample]. The fake build's `FakeLaunch` (the `fake` source set) fills it from a picture's
 * list or an Intent's extras; nothing in this source set reads an Intent.
 */
data class AppLaunch(
    val screen: Screen = Screen.home,
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
    /** The fake build's sample computer; `null` on the real build. */
    val sample: Sample? = null,
) {
    enum class Screen { home, conversation, cards, pairScan, pairWords, session, settings, newSession, newBot, search }
}

/** The fake build's sample computer, as the screens' pictures show it. The real build has none. */
interface Sample {
    val now: Long
    val computerName: String
    val pinned: List<String>
    val bots: List<Bot>
    val sessions: List<SessionRow>
    /** The code the pairing screen's sample button scans. */
    val pairCode: String
    /** The app starts unpaired. */
    val unpaired: Boolean
    /** A message sent as a conversation opens (the picture of a failed send). */
    val sendsOnOpen: String?
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

/**
 * The MOSS app: the bots, and what needs the person. The app module holds only this; the rest is shared. `engine` is the
 * app's engine client: the real one on the real build, the fake with its [Sample] in pictures and the fake build.
 */
@Composable
fun MossApp(engine: EngineClient, launch: AppLaunch = AppLaunch(), dark: Boolean = isSystemInDarkTheme()) {
    val context = LocalContext.current
    val sample = launch.sample
    val client = engine
    val bots = remember { BotsListModel(client, MemoryPinStore(sample?.pinned ?: emptyList())) }
    val cards = remember { CardsModel(client, PhoneApp.moss) { sample?.now ?: System.currentTimeMillis() } }
    val pairing = remember { PairingModel(client) }
    val settings = remember { SettingsModel(client, appVersion(context)).also { it.confirmingUnpair = launch.confirmUnpair } }
    val newBot = remember { NewBotModel(client).also { it.name = launch.newBotName ?: "" } }
    val scope = rememberCoroutineScope()
    // Paired or not is the client's answer (nothing is drawn until it says); a sample says it at once.
    var paired by remember { mutableStateOf(sample?.let { !it.unpaired }) }
    LaunchedEffect(client) { if (sample == null) paired = runCatching { client.pairedComputer() != null }.getOrDefault(false) }
    val computerName = rememberComputerName(client, sample, paired == true)
    val owners = rememberOwners(client, paired == true)
    var showNewBot by remember { mutableStateOf(launch.screen == AppLaunch.Screen.newBot) }
    val stack = remember {
        mutableStateListOf<MossDest>(MossDest.Home).also { s ->
            when (launch.screen) {
                AppLaunch.Screen.conversation -> sample?.bots?.firstOrNull { it.id == (launch.openID ?: "alpha") }?.let { s.add(MossDest.Conversation(it)) }
                AppLaunch.Screen.cards -> s.add(MossDest.NeedsYou)
                AppLaunch.Screen.settings -> s.add(MossDest.Settings)
                else -> {}
            }
        }
    }
    LaunchedEffect(cards, paired) { if (paired == true) cards.run() }
    LaunchedEffect(launch.screen) { if (launch.screen == AppLaunch.Screen.pairWords) sample?.pairCode?.let { pairing.scanned(it) } }

    MossTheme(dark) {
        CompositionLocalProvider(LocalNow provides sample?.now, LocalStill provides launch.still) {
            if (paired == null) {
                Box(Modifier.fillMaxSize().background(MossTheme.colors.background))
            } else if (paired == false) {
                PairingScreen(pairing, "MOSS", sampleCode = sample?.pairCode) { paired = true }
            } else {
                BackStack(stack) { dest ->
                    when (dest) {
                        MossDest.Home -> BotsScreen(bots, cards, computerName,
                            onSettings = { stack.add(MossDest.Settings) }, onBell = { stack.add(MossDest.NeedsYou) },
                            onNew = { showNewBot = true }, onOpen = { stack.add(MossDest.Conversation(it)) },
                            startSearching = launch.screen == AppLaunch.Screen.search)
                        is MossDest.Conversation -> {
                            val model = remember(dest) { ConversationModel(ConversationModel.Source.OfBot(dest.bot), client, autoSend = sample?.sendsOnOpen) }
                            ConversationScreen(model, cards, onBack = { stack.removeAt(stack.lastIndex) }, preset = launch.composer, startsAtTop = launch.scrollTop)
                        }
                        MossDest.NeedsYou -> NeedsYouScreen(cards, owners::of) {
                            stack.removeAt(stack.lastIndex)
                        }
                        MossDest.Settings -> SettingsScreen(settings, "MOSS", onUnpaired = {
                            stack.clear(); stack.add(MossDest.Home); paired = false; pairing.retry()
                        }, onBack = { stack.removeAt(stack.lastIndex) })
                    }
                }
                if (showNewBot) NewBotSheet(newBot, computerName, onCreated = { bot ->
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

/** The MOSS Code app: the sessions with coding agents, and what needs the person. `engine` as for [MossApp]. */
@Composable
fun MossCodeApp(engine: EngineClient, launch: AppLaunch = AppLaunch(), dark: Boolean = isSystemInDarkTheme()) {
    val context = LocalContext.current
    val sample = launch.sample
    val client = engine
    val sessions = remember { SessionsListModel(client) }
    val cards = remember { CardsModel(client, PhoneApp.code) { sample?.now ?: System.currentTimeMillis() } }
    val pairing = remember { PairingModel(client) }
    val settings = remember { SettingsModel(client, appVersion(context)).also { it.confirmingUnpair = launch.confirmUnpair } }
    val scope = rememberCoroutineScope()
    var paired by remember { mutableStateOf(sample?.let { !it.unpaired }) }
    LaunchedEffect(client) { if (sample == null) paired = runCatching { client.pairedComputer() != null }.getOrDefault(false) }
    val computerName = rememberComputerName(client, sample, paired == true)
    val owners = rememberOwners(client, paired == true)
    val newSession = remember(computerName) { NewSessionModel(client, computerName) }
    val stack = remember {
        mutableStateListOf<CodeDest>(CodeDest.Home).also { s ->
            when (launch.screen) {
                AppLaunch.Screen.session -> sample?.sessions?.firstOrNull { it.id == (launch.openID ?: "c2") }?.let { s.add(CodeDest.Session(it)) }
                AppLaunch.Screen.cards -> s.add(CodeDest.NeedsYou)
                AppLaunch.Screen.settings -> s.add(CodeDest.Settings)
                AppLaunch.Screen.newSession -> s.add(CodeDest.NewSession)
                else -> {}
            }
        }
    }
    LaunchedEffect(cards, paired) { if (paired == true) cards.run() }
    LaunchedEffect(launch.screen) {
        if (launch.screen == AppLaunch.Screen.pairWords) sample?.pairCode?.let { pairing.scanned(it) }
        if (launch.startNew) {
            newSession.load()
            newSession.start()?.let { id ->
                sessions.load()
                sessions.sessions.firstOrNull { it.id == id }?.let { stack.add(CodeDest.Session(it)) }
            }
        }
    }

    MossTheme(dark) {
        CompositionLocalProvider(LocalNow provides sample?.now, LocalStill provides launch.still) {
            if (paired == null) {
                Box(Modifier.fillMaxSize().background(MossTheme.colors.background))
            } else if (paired == false) {
                PairingScreen(pairing, "MOSS Code", sampleCode = sample?.pairCode) { paired = true }
            } else BackStack(stack) { dest ->
                when (dest) {
                    CodeDest.Home -> SessionsScreen(sessions, cards, computerName,
                        onSettings = { stack.add(CodeDest.Settings) }, onBell = { stack.add(CodeDest.NeedsYou) },
                        onNew = { stack.add(CodeDest.NewSession) }, onOpen = { stack.add(CodeDest.Session(it)) })
                    is CodeDest.Session -> {
                        val model = remember(dest) { ConversationModel(ConversationModel.Source.OfSession(dest.session), client, autoSend = sample?.sendsOnOpen) }
                        ConversationScreen(model, cards, onBack = { stack.removeAt(stack.lastIndex) }, preset = launch.composer, startsAtTop = launch.scrollTop)
                    }
                    CodeDest.NeedsYou -> NeedsYouScreen(cards, owners::of) {
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

/** The paired computer's name: the sample's in pictures; the engine's own once paired on the real client. */
@Composable
private fun rememberComputerName(client: EngineClient, sample: Sample?, paired: Boolean): String {
    var name by remember { mutableStateOf(sample?.computerName ?: "") }
    if (sample == null) LaunchedEffect(client, paired) {
        if (paired) name = try { client.pairedComputer()?.name ?: "" } catch (e: CancellationException) { throw e } catch (e: Exception) { "" }
    }
    return name
}

/**
 * Whose a card is, for the heading of its group in Needs You: the bot's name or the session's title, looked up on the
 * engine (each app shows the other app's cards too when that app isn't paired). A card neither raised is the computer's.
 */
class CardOwners(private val bots: Map<String, String>, private val sessions: Map<String, String?>) {
    fun of(card: Card): String {
        card.bot?.let { id -> return bots[id] ?: "A bot" }
        card.session?.let { id -> return sessions[id]?.takeIf { it.isNotBlank() } ?: if (id in sessions) "A coding session" else "A session" }
        return "Your computer"
    }
}

@Composable
private fun rememberOwners(client: EngineClient, paired: Boolean): CardOwners {
    var owners by remember { mutableStateOf(CardOwners(emptyMap(), emptyMap())) }
    LaunchedEffect(client, paired) {
        if (!paired) return@LaunchedEffect
        val bots = try { client.bots().associate { it.id to it.name } } catch (e: CancellationException) { throw e } catch (e: Exception) { emptyMap() }
        val sessions = try { client.sessions().associate { it.id to it.title } } catch (e: CancellationException) { throw e } catch (e: Exception) { emptyMap() }
        owners = CardOwners(bots, sessions)
    }
    return owners
}
