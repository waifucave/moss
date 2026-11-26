package com.waifucave.moss.phone.vm

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.waifucave.moss.phone.client.EngineClient
import com.waifucave.moss.phone.model.*
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.produceIn

/** Where the phone keeps which bots the person pinned (the engine has no such field, so it is the phone's own). */
interface PinStore {
    var pinned: List<String>
}

class MemoryPinStore(override var pinned: List<String> = emptyList()) : PinStore

/** One line of the bots list. */
data class BotRow(val bot: Bot, val summary: BotSummary?, val statusLine: String?) {
    val id: String get() = bot.id
    val unread: Boolean get() = summary?.unread ?: false
    val lastAt: Long get() = summary?.last?.at ?: 0
}

/**
 * Runs a model's listener once: subscribes, loads, then applies events until the caller's coroutine ends. A second call while
 * one runs returns at once (the iPhone's `listener == nil` guard).
 */
internal class Listener {
    private var running = false
    suspend fun run(client: EngineClient, load: suspend () -> Unit, apply: suspend (EngineEvent) -> Unit) {
        if (running) return
        running = true
        try {
            coroutineScope {
                val events = client.events().produceIn(this)
                load()
                for (e in events) apply(e)
            }
        } finally { running = false }
    }
}

const val UNREACHABLE_TEXT = "Can't reach your computer."
/** A question call two of whose questions read the same: one answer would stand for both, so it is answered on the computer. */
const val SAME_TEXT = "Answer this one on your computer: two of its questions read the same."

class BotsListModel(private val client: EngineClient, private val store: PinStore) {
    var rows by mutableStateOf<List<BotRow>>(emptyList())
        private set
    var loaded by mutableStateOf(false)
        private set
    var errorText by mutableStateOf<String?>(null)
        private set
    var connection by mutableStateOf<ConnectionState>(ConnectionState.Connected)
        private set
    val loadFailed: Boolean get() = errorText != null
    var pinnedIDs by mutableStateOf(store.pinned)
        private set

    private var bots: List<Bot> = emptyList()
    private val summaries = mutableMapOf<String, BotSummary>()
    private val lines = mutableMapOf<String, String>()   // by main session id
    private val listener = Listener()

    /** The pinned bots, in the order the person pinned them: the large faces on top. */
    val pinned: List<BotRow> get() = pinnedIDs.mapNotNull { id -> rows.firstOrNull { it.id == id } }
    /** The rest, newest conversation first. */
    val others: List<BotRow>
        get() = rows.filter { it.id !in pinnedIDs }.sortedWith(compareByDescending<BotRow> { it.lastAt }.thenBy { it.bot.name })
    val unreadCount: Int get() = rows.count { it.unread }

    suspend fun load() {
        connection = client.connectionState()
        try {
            bots = client.bots()
            summaries.clear(); client.botSummaries().forEach { summaries[it.id] = it }
            errorText = null
        } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) {
            errorText = UNREACHABLE_TEXT
        }
        loaded = true
        rebuild()
    }

    suspend fun run() = listener.run(client, ::load) { apply(it) }

    fun togglePin(id: String) {
        pinnedIDs = if (id in pinnedIDs) pinnedIDs - id else pinnedIDs + id
        store.pinned = pinnedIDs
    }
    fun isPinned(id: String) = id in pinnedIDs

    fun apply(event: EngineEvent) {
        when (event) {
            is EngineEvent.BotChanged -> bots = if (bots.any { it.id == event.bot.id }) bots.map { if (it.id == event.bot.id) event.bot else it } else bots + event.bot
            is EngineEvent.BotSummaryChanged -> summaries[event.summary.id] = event.summary
            is EngineEvent.StatusLine -> if (event.line == null) lines.remove(event.subject) else lines[event.subject] = event.line
            is EngineEvent.Message -> {
                val b = bots.firstOrNull { it.mainSession == event.subject }
                val m = event.message
                // A note, or a record that only closes a question, is not the conversation's last word.
                if (b != null && m.role != MessageRole.note && m.question?.closing != true) {
                    summaries[b.id] = BotSummary(b.id, BotSummary.Last(m.text, if (m.role == MessageRole.user) BotSummary.From.user else BotSummary.From.bot, m.at), unread = m.role != MessageRole.user)
                }
            }
            is EngineEvent.Connection -> connection = event.state
            else -> {}
        }
        rebuild()
    }

    private fun rebuild() {
        rows = bots.map { BotRow(it, summaries[it.id], lines[it.mainSession]) }
    }
}

/** How a session row says what it is doing, in one word. */
enum class SessionBadge(val text: String) {
    needsYou("Needs you"), running("Running"), waiting("Waiting"), stopped("Stopped"), failed("Failed"), none("")
}

data class SessionGroup(val project: String, val sessions: List<SessionRow>) {
    val id: String get() = project
}

/** Needs you wins, then what the session is doing (`sessionMotion`). */
val SessionRow.badge: SessionBadge
    get() {
        if ((needsYou?.total ?: 0) > 0) return SessionBadge.needsYou
        return when (motion) {
            SessionMotion.running -> SessionBadge.running
            SessionMotion.waiting -> SessionBadge.waiting
            SessionMotion.ended -> if (status == SessionStatus.failed) SessionBadge.failed else SessionBadge.stopped
            SessionMotion.still -> SessionBadge.none
        }
    }

/** The sessions list, grouped as the desktop's sidebar groups it: by project folder, a session's own title and mark on each row. */
class SessionsListModel(private val client: EngineClient) {
    var sessions by mutableStateOf<List<SessionRow>>(emptyList())
        private set
    var loaded by mutableStateOf(false)
        private set
    var errorText by mutableStateOf<String?>(null)
        private set
    var connection by mutableStateOf<ConnectionState>(ConnectionState.Connected)
        private set
    val loadFailed: Boolean get() = errorText != null
    private val listener = Listener()

    /** Groups ordered by their newest session; sessions inside newest first. Archived sessions and bots' own threads stay out. */
    val groups: List<SessionGroup>
        get() {
            val visible = sessions.filter { it.archived != true && it.bot == null && it.parent == null }
            return visible.groupBy { it.project }
                .map { (k, v) -> SessionGroup(k.ifEmpty { "No project" }, v.sortedByDescending { it.updatedAt }) }
                .sortedWith(compareByDescending<SessionGroup> { it.sessions.firstOrNull()?.updatedAt ?: 0 }.thenBy { it.project })
        }
    val needsYouCount: Int get() = sessions.sumOf { it.needsYou?.total ?: 0 }

    suspend fun load() {
        connection = client.connectionState()
        try { sessions = client.sessions(); errorText = null }
        catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) { errorText = UNREACHABLE_TEXT }
        loaded = true
    }
    suspend fun run() = listener.run(client, ::load) { apply(it) }

    fun apply(event: EngineEvent) {
        when (event) {
            is EngineEvent.SessionChanged -> sessions =
                if (sessions.any { it.id == event.session.id }) sessions.map { if (it.id == event.session.id) event.session else it } else sessions + event.session
            is EngineEvent.Connection -> connection = event.state
            else -> {}
        }
    }
}
