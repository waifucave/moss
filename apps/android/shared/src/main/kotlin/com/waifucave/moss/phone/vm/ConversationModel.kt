package com.waifucave.moss.phone.vm

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.waifucave.moss.phone.client.EngineClient
import com.waifucave.moss.phone.model.*
import kotlinx.coroutines.CancellationException
import java.util.UUID

/** One conversation: a bot's single one, or a coding session's. A turn shows as ONE plain status line, never its tool calls. */
class ConversationModel(
    val source: Source,
    private val client: EngineClient,
    private val makeID: () -> String = { UUID.randomUUID().toString() },
    private val autoSend: String? = null,
) {
    sealed class Source {
        data class OfBot(val bot: Bot) : Source()
        data class OfSession(val session: SessionRow) : Source()
    }

    var messages by mutableStateOf<List<ChatMessage>>(emptyList())
        private set
    var statusLine by mutableStateOf<String?>(null)
        private set
    var hasEarlier by mutableStateOf(false)
        private set
    var errorText by mutableStateOf<String?>(null)
        private set
    /** A message that did not go: its words stay in the composer, and Retry sends it again under the same id (never twice). */
    var failedSend by mutableStateOf<Pair<String, String>?>(null)
        private set
    var draft by mutableStateOf("")
    /** What the composer's picker may offer here; `null` until read. */
    var offers by mutableStateOf<ComposerOffers?>(null)
        private set
    /** The question waiting in this conversation: the composer's place is taken by it. */
    var question by mutableStateOf<AskQuestion?>(null)
        private set
    var staged by mutableStateOf<List<StagedImage>>(emptyList())
        private set
    var isInterrupting by mutableStateOf(false)
        private set

    private var sessionID: String = when (source) {
        is Source.OfBot -> source.bot.mainSession
        is Source.OfSession -> source.session.id
    }
    private val listener = Listener()

    val kind: ConversationKind get() = if (source is Source.OfBot) ConversationKind.bot else ConversationKind.codingSession
    val title: String get() = when (source) {
        is Source.OfBot -> source.bot.name
        is Source.OfSession -> source.session.title ?: "Session"
    }
    val isRunning: Boolean get() = statusLine != null
    val canSend: Boolean get() = draft.isNotBlank()
    val placeholder: String get() = when (source) {
        is Source.OfBot -> "Message ${source.bot.name}"
        is Source.OfSession -> "Message"
    }

    private suspend fun page(before: Long?): com.waifucave.moss.phone.client.MessagePage = when (source) {
        is Source.OfBot -> client.conversation(source.bot.id, before, 60)
        is Source.OfSession -> client.history(source.session.id, before, 60)
    }

    suspend fun load() {
        try {
            val p = page(null)
            sessionID = p.session
            messages = p.messages
            hasEarlier = p.hasMore
            errorText = null
            val s = source
            if (s is Source.OfBot) runCatching { client.markRead(s.bot.id) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            errorText = UNREACHABLE_TEXT
        }
    }

    suspend fun loadEarlier() {
        val first = messages.firstOrNull() ?: return
        if (!hasEarlier) return
        try {
            val p = page(first.at)
            messages = p.messages + messages
            hasEarlier = p.hasMore
        } catch (e: CancellationException) { throw e } catch (e: Exception) { errorText = UNREACHABLE_TEXT }
    }

    suspend fun run() = listener.run(client, {
        load()
        loadComposer()
        autoSend?.let { draft = it; send() }
    }) { apply(it) }

    fun apply(event: EngineEvent) {
        when (event) {
            is EngineEvent.Message -> if (event.subject == sessionID && messages.none { it.id == event.message.id }) messages = messages + event.message
            is EngineEvent.StatusLine -> if (event.subject == sessionID) statusLine = event.line
            else -> {}
        }
    }

    /** Sends the draft. The field clears only when the send was accepted: a refused prompt stays in it (and so does a picture). */
    suspend fun send(): Boolean {
        val text = draft.trim()
        if (text.isEmpty()) return false
        val id = failedSend?.takeIf { it.first == text }?.second ?: makeID()
        return try {
            client.send(sessionID, text, id, staged.map { it.path })
            draft = ""
            staged = emptyList()
            errorText = null
            failedSend = null
            true
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            // The words stay in the composer so nothing is lost.
            failedSend = text to id
            errorText = "Your message wasn't sent. It is still here."
            false
        }
    }

    // Composer

    suspend fun loadComposer() {
        offers = try { client.composerOffers(sessionID, kind) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
        question = try { client.pendingQuestion(sessionID) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
    }
    suspend fun setEffort(effort: String) {
        try { client.setModel(sessionID, null, effort); offers = offers?.copy(effort = effort) }
        catch (e: CancellationException) { throw e } catch (e: Exception) { errorText = "That didn't work." }
    }
    suspend fun setModel(choice: ModelChoice) {
        try {
            val current = offers?.effort
            val effort = if (current != null && current in choice.efforts) current else choice.efforts.firstOrNull()
            client.setModel(sessionID, choice.id, effort)
            offers = offers?.copy(model = choice.id, efforts = choice.efforts, effort = effort)
        } catch (e: CancellationException) { throw e } catch (e: Exception) { errorText = "That didn't work." }
    }
    suspend fun run(command: PluginCommand) {
        try { client.runCommand(sessionID, command.id) } catch (e: CancellationException) { throw e } catch (e: Exception) { errorText = "That didn't work." }
    }
    suspend fun stage(data: ByteArray, thumbnail: ByteArray) {
        try { staged = staged + StagedImage(client.stageImage(sessionID, data), thumbnail) }
        catch (e: CancellationException) { throw e } catch (e: Exception) { errorText = "That picture couldn't be added." }
    }
    fun unstage(image: StagedImage) { staged = staged.filter { it != image } }
    suspend fun answerQuestion(answers: Map<String, String>): Boolean {
        val q = question ?: return false
        return try { client.answerQuestion(sessionID, q, answers); question = null; true }
        catch (e: CancellationException) { throw e } catch (e: Exception) { errorText = "That didn't work. The question is still waiting."; false }
    }

    /** Sends the message that failed again. */
    suspend fun retry() { send() }

    suspend fun stop() {
        isInterrupting = true
        try { client.stop(sessionID) } catch (e: CancellationException) { throw e } catch (e: Exception) { errorText = "That didn't work." }
        finally { isInterrupting = false }
    }
}
