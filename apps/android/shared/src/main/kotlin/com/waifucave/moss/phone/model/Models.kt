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

enum class MessageRole { user, bot, note, agent }

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
)

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
) {
    val isEmpty: Boolean get() = !pictures && commands.isEmpty() && efforts.isEmpty() && models.isEmpty()
}

enum class ConversationKind { bot, codingSession }

/** A picture staged for the next message (`session.stageImage` wrote it; `path` is what `session.send` takes). */
class StagedImage(val path: String, val thumbnail: ByteArray) {
    val id: String get() = path
    override fun equals(other: Any?) = other is StagedImage && other.path == path
    override fun hashCode() = path.hashCode()
}

/** An `AskUserQuestion` waiting in a conversation (`session.answer` answers it). */
data class AskQuestion(
    val callId: String,
    val header: String? = null,
    val text: String,
    val options: List<Option>,
    val multiSelect: Boolean = false,
) {
    data class Option(val label: String, val detail: String? = null)
    val id: String get() = callId
}
