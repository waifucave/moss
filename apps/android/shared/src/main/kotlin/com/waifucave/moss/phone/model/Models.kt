package com.waifucave.moss.phone.model

// Shapes the phone shows, as the engine's own payloads carry them (`packages/protocol/src/bots.ts`, `sessions.ts`,
// `approvals.ts`). Names and cases follow the protocol and the iPhone's `Models.swift`; times are epoch milliseconds, as on
// the wire.

/** A bot's face pins (`BotFace`): a trait left out comes from the bot's name, in the kit. */
data class BotFaceSpec(val shape: String? = null, val color: String? = null, val eyes: String? = null, val temper: String? = null)

enum class BotState { idle, thinking, asleep, paused }

/** A bot as `bot.list` serves it (its record, its main session and its state). */
data class Bot(
    val id: String,
    val name: String,
    val model: String? = null,
    val effort: String? = null,
    val face: BotFaceSpec? = null,
    val state: BotState? = null,
    val computer: String? = null,
    val mainSession: String,
)

/** One line of the bots list (`BotSummary`): the bot's last line, its time and whether the user has read it. */
data class BotSummary(val id: String, val last: Last? = null, val unread: Boolean = false) {
    data class Last(val text: String, val from: From, val at: Long)
    enum class From { user, bot, note }
}

enum class MessageRole { user, bot, note, agent, question }

/**
 * A question asked in the conversation, drawn where it was asked with how it ended. Its state comes from the core's
 * `QuestionEnd`, decided once there so every phone draws it the same.
 */
data class AskedQuestion(
    val callId: String,
    val header: String? = null,
    val text: String,
    val options: List<String> = emptyList(),
    val state: QuestionState = QuestionState.Open,
    /** This record only closes a question asked earlier (a `question_resolved`): its state goes onto that question's row. */
    val closing: Boolean = false,
)

/** How an asked question stands. */
sealed class QuestionState {
    data object Open : QuestionState()
    /** Answered by the person (here or on another device). */
    data object Answered : QuestionState()
    /** Answered by a plugin: a real answer, not the person's. `plugin` is its id, cleaned by the core. */
    data class AnsweredByPlugin(val plugin: String) : QuestionState()
    /** The person skipped a bot's open question: nothing was chosen. */
    data object Skipped : QuestionState()
    /** It ended with no answer, by one of the engine's endings: the turn ended or was stopped. */
    data object Withdrawn : QuestionState()
    /** The engine went away while it waited (a stop, an update's restart, a crash), not the person. */
    data object EngineStopped : QuestionState()
    /** Closed by something this phone doesn't know (a newer engine): neither answered nor withdrawn. */
    data object Closed : QuestionState()

    /** The row's status line, the phone's own words: a title, and the plugin's id (small, plain) when a plugin answered. */
    data class Status(val title: String, val detail: String? = null)
    val status: Status?
        get() = when (this) {
            Open -> null
            Answered -> Status("Answered")
            is AnsweredByPlugin -> Status("Answered by a plugin", plugin)
            Skipped -> Status("Skipped")
            Withdrawn -> Status("Withdrawn")
            EngineStopped -> Status("Ended: your computer stopped")
            Closed -> Status("Closed")
        }
}

data class ChatFile(val name: String, /** "12 pages · 1.2 MB": what the engine says about the file. */ val detail: String)

/** One message of a conversation, already read out of the session's events by the client. */
data class ChatMessage(
    val id: String,
    val role: MessageRole,
    val text: String,
    /** Epoch milliseconds. */
    val at: Long,
    /** The device a user message came from (`from <device>`), when it was not this phone. */
    val device: String? = null,
    /** A file the message carries, drawn as its own card. */
    val file: ChatFile? = null,
    /** For a `question` row: the question and how it ended. */
    val question: AskedQuestion? = null,
)

/**
 * Messages as a conversation shows them: a record that closes a question (a `question_resolved`) sets the state of the row
 * where that question was asked, and is not a row of its own; one whose question isn't in these messages (asked before
 * the page) stays as a row with its state only.
 */
fun foldQuestions(messages: List<ChatMessage>): List<ChatMessage> {
    val out = ArrayList<ChatMessage>(messages.size)
    for (m in messages) {
        val q = m.question
        if (q != null && q.closing) {
            val i = out.indexOfLast { o -> o.question?.let { it.callId == q.callId && !it.closing } == true }
            if (i >= 0) { out[i] = out[i].copy(question = out[i].question!!.copy(state = q.state)); continue }
        }
        out.add(m)
    }
    return out
}

// Sessions

enum class SessionStatus { starting, ready, prompting, cancelling, idle, stopped, failed }

data class SessionWaiting(val tasks: Int, val children: Int)

data class NeedsYou(val cards: Int, val questions: Int) {
    val total: Int get() = cards + questions
}

/** How a session moves (`sessionMotion` in `session-graph.ts`): running wins over waiting. */
enum class SessionMotion { running, waiting, still, ended }

fun sessionMotion(status: SessionStatus, waiting: SessionWaiting?): SessionMotion = when (status) {
    SessionStatus.stopped, SessionStatus.failed -> SessionMotion.ended
    SessionStatus.starting, SessionStatus.prompting, SessionStatus.cancelling -> SessionMotion.running
    SessionStatus.ready, SessionStatus.idle ->
        if (waiting != null && waiting.tasks + waiting.children > 0) SessionMotion.waiting else SessionMotion.still
}

/** A session as `session.list` serves it (`SessionView`, the fields the phone draws). */
data class SessionRow(
    val id: String,
    val kind: String = "coding",
    val bot: String? = null,
    val parent: String? = null,
    val computer: String,
    val title: String? = null,
    val status: SessionStatus,
    val startedAt: Long,
    val updatedAt: Long,
    val backend: String? = null,
    val model: String? = null,
    val root: String? = null,
    val branch: String? = null,
    val changes: Int? = null,
    val needsYou: NeedsYou? = null,
    val waiting: SessionWaiting? = null,
    val archived: Boolean? = null,
) {
    val motion: SessionMotion get() = sessionMotion(status, waiting)
    /** The project the desktop's sidebar groups it under: its root folder's own name. */
    val project: String get() = root?.split("/")?.lastOrNull { it.isNotEmpty() } ?: ""
}

// Cards

/** A sealed field's content (`SealedValue`). The phone draws what the card hash covers and cuts nothing silently. */
sealed class SealedValue {
    data class Text(val text: String) : SealedValue()
    data class Code(val code: String, val language: String? = null) : SealedValue()
    data class ListOf(val items: List<String>) : SealedValue()
    data class Rows(val rows: List<Row>) : SealedValue()
    data class Row(val label: String, val value: String)
    /** A value of a kind this build can't draw: the card is answered on the computer, never here. */
    data object Unsupported : SealedValue()
}

/** A sealed button. The label is a plain string or a map by language on the wire; the phone keeps the one it shows. */
data class CardOption(val id: String, val kind: Kind, val label: String, val rememberAlways: Boolean = false) {
    enum class Kind { approve, deny }
}

/** A pending card (`Card`). `hash` is what the answer is signed over; the client keeps it with the card. */
data class Card(
    val id: String,
    val kind: String,
    val computer: String? = null,
    val session: String? = null,
    val bot: String? = null,
    val origin: String? = null,
    val issuedAt: Long,
    val expiresAt: Long,
    val hash: String,
    val fields: Map<String, SealedValue>,
    val options: List<CardOption>,
    /** The card carries `children` (a plugin's OK card with a checkbox per child): this phone draws no checkboxes yet. */
    val hasChildren: Boolean = false,
) {
    val title: String get() = text("title") ?: "Needs your answer"
    val what: String? get() = text("what")
    private fun text(name: String): String? = (fields[name] as? SealedValue.Text)?.text
}

// Pairing and events

/** The computer a phone is paired with. */
data class PairedComputer(val name: String, val deviceName: String, /** When the link last carried anything (epoch ms). */ val lastSeen: Long? = null)

/** What a scanned code starts: the id of the pairing and the four words both screens show. */
data class PairingProposal(val pairingId: String, val computer: String, val words: List<String>)

enum class PairingError { unreadableCode, expired, wordsDoNotMatch, unreachable }

/** Swift throws the error enums themselves; Kotlin throws them wrapped. */
class PairingException(val error: PairingError) : Exception(error.name)

/** What the engine tells a phone as it happens (the `receives` list of the remote allowlist, boiled down to what screens use). */
sealed class EngineEvent {
    data class BotChanged(val bot: Bot) : EngineEvent()
    data class BotSummaryChanged(val summary: BotSummary) : EngineEvent()
    /** A turn's one status line for a bot or session; `null` when the turn ended. */
    data class StatusLine(val subject: String, val line: String?) : EngineEvent()
    data class Message(val subject: String, val message: ChatMessage) : EngineEvent()
    /** A question was asked or closed in this session: an open conversation reads its open question again. */
    data class QuestionChanged(val subject: String) : EngineEvent()
    data class SessionChanged(val session: SessionRow) : EngineEvent()
    data class CardRequested(val card: Card) : EngineEvent()
    data class CardResolved(val id: String) : EngineEvent()
    data class Connection(val state: ConnectionState) : EngineEvent()
}

// Link state, apps, starting a session

/** Whether the link to the paired computer is carrying anything now. */
sealed class ConnectionState {
    data object Connected : ConnectionState()
    /** The computer cannot be reached; `since` is when the link was last up (epoch ms), if known. */
    data class Unreachable(val since: Long?) : ConnectionState()
}

/** Which phone app is asking, for the client's answer to which cards to show it. */
enum class PhoneApp { moss, code }

/** Why an answer to a card did not count. */
enum class CardAnswerError { expired, answeredElsewhere }
class CardAnswerException(val error: CardAnswerError) : Exception(error.name)

/** An agent backend a person can start a session with (`agent.backends`, `userStartable` only). */
data class AgentBackend(val id: String, val name: String)

/** A model a backend offers before any session exists (`BackendModelOption`). */
data class ModelOption(val id: String, val name: String, val efforts: List<String> = emptyList(), val defaultEffort: String? = null)

/** What a backend offers to start with (`AgentBackendOptions`). `known: false` means unknown until it starts. */
data class BackendOptions(
    val backend: String,
    val known: Boolean = true,
    val models: List<ModelOption>,
    val defaultModel: String? = null,
    val defaultEffort: String? = null,
)

/** The person's last start (`RecentStart`): preselects the agent, its model and effort, and lists folders used before. */
data class RecentStart(val last: Choice? = null, val byBackend: List<Choice> = emptyList(), /** Newest first. */ val roots: List<String> = emptyList()) {
    data class Choice(val backend: String, val model: String? = null, val effort: String? = null)
}

/** What `agent.start` takes (`backend`, `computer`, `root`, `model`, `effort`). */
data class StartRequest(val backend: String, val computer: String, val root: String, val model: String? = null, val effort: String? = null)

enum class StartError {
    /** The engine refused the folder (outside the fence, or it holds the MOSS home). */
    folderRefused,
    /** The agent is not installed on that computer. */
    notInstalled,
}
class StartException(val error: StartError) : Exception(error.name)

// Composer

/** A plugin's command the person may run from a conversation (`command.list`, `command.run`). */
data class PluginCommand(val id: String, val title: String)

/** A model a session lets the person switch to (`models.list {session}`, `session.setModel`). */
data class ModelChoice(val id: String, val name: String, val efforts: List<String> = emptyList())

/**
 * What the composer of one conversation or session may offer, read from the doors a phone may call today. A kind with nothing
 * behind it is empty or `null`, and its row is left out of the picker: there are no placeholder rows.
 */
data class ComposerOffers(
    /** `session.stageImage`: Photos, and Camera where the phone has one. Files have no door on the `remote` list. */
    val pictures: Boolean = false,
    /** `command.list` and `command.run`: the Plugins row, when any command is listed. */
    val commands: List<PluginCommand> = emptyList(),
    /** `session.setModel`'s effort: the session's own levels and the one set now. Empty: no Effort row. */
    val efforts: List<String> = emptyList(),
    val effort: String? = null,
    /** `session.setModel`'s model, for a coding session that lets it be changed. Empty: no Model row. */
    val models: List<ModelChoice> = emptyList(),
    val model: String? = null,
    /** A file the person may send (`stageFile`), up to `fileLimit` bytes: the Files row. Nothing offered, no row. */
    val files: Boolean = false,
    val fileLimit: Long? = null,
    /** How many files one message may carry. */
    val fileCount: Int? = null,
) {
    val isEmpty: Boolean get() = !pictures && !files && commands.isEmpty() && efforts.isEmpty() && models.isEmpty()
}

enum class ConversationKind { bot, codingSession }

/** A picture staged for the next message (`session.stageImage` wrote it; `path` is what `session.send` takes). */
class StagedImage(val path: String, val thumbnail: ByteArray) {
    val id: String get() = path
    override fun equals(other: Any?) = other is StagedImage && other.path == path
    override fun hashCode() = path.hashCode()
}

/**
 * An `AskUserQuestion` call waiting in a conversation (`session.answer` answers it): one to four questions, drawn whole and
 * answered together, as the desktop's card does. Each answer is keyed by its question's text.
 */
data class AskQuestion(val callId: String, val questions: List<Part>) {
    /** A call of one question. */
    constructor(callId: String, header: String? = null, text: String, options: List<Option>, multiSelect: Boolean = false) :
        this(callId, listOf(Part(header, text, options, multiSelect)))

    /** One question of the call: its header, its text, its options. */
    data class Part(val header: String? = null, val text: String, val options: List<Option>, val multiSelect: Boolean = false)

    /** `detail` is the option's description and `preview` its preview (a snippet drawn beside it): the computer's text, plain. */
    data class Option(val label: String, val detail: String? = null, val preview: String? = null)
    val id: String get() = callId

    /**
     * Each answer is keyed by its question's text, so two questions with one text would share one answer: such a call (an
     * older engine may still send one; a new one refuses it when asked) is answered on the computer, never here.
     */
    val answerableHere: Boolean get() = questions.isNotEmpty() && questions.map { it.text }.toSet().size == questions.size
}

/**
 * What the person has chosen so far for one question call: per question, the options picked and the words typed in its
 * "Something else" box. [answers] is there only once every question has one.
 */
data class QuestionDraft(
    val question: AskQuestion,
    /** Per question (its index in the call): the options picked, by index. */
    val picked: Map<Int, Set<Int>> = emptyMap(),
    /** Per question: the words typed instead of (or as well as) an option. */
    val other: Map<Int, String> = emptyMap(),
) {
    fun isPicked(option: Int, part: Int): Boolean = picked[part]?.contains(option) == true

    /** Picks or unpicks an option: one question's pick never touches another's. A single-choice question keeps one. */
    fun toggle(option: Int, part: Int): QuestionDraft {
        val p = question.questions.getOrNull(part) ?: return this
        if (option !in p.options.indices) return this
        val set = picked[part] ?: emptySet()
        val next = if (p.multiSelect) (if (option in set) set - option else set + option) else (if (option in set) emptySet() else setOf(option))
        return copy(picked = picked + (part to next))
    }

    fun typed(part: Int, words: String): QuestionDraft = if (part in question.questions.indices) copy(other = other + (part to words)) else this

    /** One question's answer as the engine takes it: the picked labels in their order, then the typed words. */
    fun answer(part: Int): String {
        val p = question.questions.getOrNull(part) ?: return ""
        val labels = (picked[part] ?: emptySet()).sorted().filter { it in p.options.indices }.map { p.options[it].label }
        return (labels + listOfNotNull(other[part]?.trim()?.ifEmpty { null })).joinToString(", ")
    }

    /** How many of the call's questions still have no answer. */
    val unanswered: Int get() = question.questions.indices.count { answer(it).isEmpty() }

    /** Every question's answer, keyed by its own text exactly as the engine sent it; `null` while one has none. */
    val answers: Map<String, String>?
        get() = if (unanswered == 0 && question.answerableHere) question.questions.withIndex().associate { (i, p) -> p.text to answer(i) } else null
}

/** A file staged for the next message: what the engine wrote, and how it reads in the chip. */
data class StagedFile(val path: String, val name: String, val size: Long) {
    val id: String get() = path
}

/** The engine refused a file over its limit (bytes). */
class FileTooLarge(val limit: Long) : Exception("file over $limit bytes")

/** What a new bot is made from: the models the computer offers, and its default. */
data class NewBotOptions(val models: List<ModelChoice>, val defaultModel: String? = null)

/** The engine refused something and said why in words meant for the person (a bot over the day's limit, for one). */
class EngineRefusal(message: String) : Exception(message)

/** "1.2 MB", "50 MB", "840 KB": a size as the chip and the refusal say it (the engine's limits are in binary units). */
fun byteCount(bytes: Long): String {
    if (bytes < 1024) return "$bytes bytes"
    val units = listOf("KB", "MB", "GB")
    var v = bytes / 1024.0; var u = 0
    while (v >= 1024 && u < units.size - 1) { v /= 1024; u++ }
    val n = if (v < 10) String.format(java.util.Locale.US, "%.1f", v).removeSuffix(".0") else Math.round(v).toString()
    return "$n ${units[u]}"
}
