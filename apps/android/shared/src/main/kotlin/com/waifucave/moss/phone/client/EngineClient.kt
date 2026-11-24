package com.waifucave.moss.phone.client

import com.waifucave.moss.phone.model.*
import kotlinx.coroutines.flow.Flow

/** A page of one conversation's messages, oldest first (`bot.conversation`, `session.history`). */
data class MessagePage(val session: String, val messages: List<ChatMessage>, val hasMore: Boolean = false)

/**
 * What the phone's screens need from the engine: the same calls, names and labels as the iPhone's `EngineClient` protocol, so
 * the shared core's binding fits both. The screens run on [FakeEngineClient] until the core exists. Every call maps to a call
 * of the `remote` allowlist (`packages/protocol/generated/moss/allowlists.json`), except pairing, which is the core's own
 * ceremony.
 *
 * Where Kotlin differs from Swift: the async property `pairedComputer` is a suspend function; a typed Swift error is thrown
 * wrapped ([PairingException], [CardAnswerException], [StartException]); `Data` is a `ByteArray`; `events()` is a `Flow`.
 *
 * A client never gives a screen raw JSON. It signs card answers and user messages with the device's own key itself (no
 * fingerprint, face or device-credential prompt is asked for).
 */
interface EngineClient {
    /** The computer this phone is paired with; `null` before the first pairing. */
    suspend fun pairedComputer(): PairedComputer?

    /** Pairing. `code` is the text of the QR the computer shows; the proposal holds the four words both screens show. */
    suspend fun beginPairing(code: String): PairingProposal
    suspend fun confirmPairing(proposal: PairingProposal): PairedComputer
    suspend fun cancelPairing(proposal: PairingProposal)

    /** `bot.list` joined with `bot.summaries`. */
    suspend fun bots(): List<Bot>
    suspend fun botSummaries(): List<BotSummary>
    /** `bot.conversation`: a page of the bot's one conversation, newest last. */
    suspend fun conversation(bot: String, before: Long?, limit: Int): MessagePage
    /** `bot.markRead`. */
    suspend fun markRead(bot: String)

    /** `session.list`. */
    suspend fun sessions(): List<SessionRow>
    /** `session.history`. */
    suspend fun history(session: String, before: Long?, limit: Int): MessagePage

    /** `session.send` with a `UserMessageInput` (the client id makes a resend one message). */
    suspend fun send(session: String, text: String, clientMessageId: String, images: List<String> = emptyList(), files: List<String> = emptyList())
    /** `session.interrupt`: Stop. */
    suspend fun stop(session: String)

    /**
     * `card.list`, and `card.answer` with a signed answer over the card's hash; throws [CardAnswerException]. `answer` takes the
     * card object the screen drew, never an id: the core signs only over the card the person saw.
     */
    suspend fun cards(): List<Card>
    suspend fun answer(card: Card, option: CardOption)
    /** The engine's answer to which cards this app shows: a setting of the client's answer, never a split the screens hard-code. */
    suspend fun shows(card: Card, app: PhoneApp): Boolean

    /** Starting a coding session (MOSS Code): `agent.backends`, `agent.options`, `agent.recent`, `agent.start`. */
    suspend fun backends(): List<AgentBackend>
    suspend fun startOptions(backend: String): BackendOptions
    suspend fun recentStart(): RecentStart
    suspend fun startSession(request: StartRequest): String

    /** The composer's rows: what this conversation or session offers through the doors a phone may call. */
    suspend fun composerOffers(session: String, kind: ConversationKind): ComposerOffers
    /** `session.setModel` (a bot's effort too). */
    suspend fun setModel(session: String, model: String?, effort: String?)
    /** `session.stageImage`: the staged picture's path, for `send(images)`. */
    suspend fun stageImage(session: String, data: ByteArray): String
    /** A file for the next message, up to the engine's limit (throws [com.waifucave.moss.phone.model.FileTooLarge] over it). */
    suspend fun stageFile(session: String, name: String, data: ByteArray): StagedFile
    /** Making a bot from the phone: the models on offer, and the new bot (its conversation opens next). */
    suspend fun newBotOptions(): NewBotOptions
    suspend fun createBot(name: String, model: String?): Bot
    /** `command.run`. */
    suspend fun runCommand(session: String, command: String)
    /** The question waiting in a conversation, if any, and `session.answer`. */
    suspend fun pendingQuestion(session: String): AskQuestion?
    suspend fun answerQuestion(session: String, question: AskQuestion, answers: Map<String, String>)

    /** The state of the link now (`events()` tells the changes), and forgetting this computer. */
    suspend fun connectionState(): ConnectionState
    suspend fun unpair()

    /** `events.subscribe`: what happens next, until the collector stops. */
    fun events(): Flow<EngineEvent>
}
