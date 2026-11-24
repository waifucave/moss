package com.waifucave.moss.phone.client

import com.waifucave.moss.phone.model.*
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow

/**
 * The engine client the screens run on until the shared core exists: in memory, serving [SampleData], and deterministic, the
 * iPhone's `FakeEngineClient` call for call. It never sleeps; a turn it starts is finished by [finishTurn]. It is meant to be
 * called from one thread (the main thread in the apps, the test's thread in tests).
 */
class FakeEngineClient(
    private val scenario: Scenario = Scenario.idle,
    private val clock: () -> Long = { SampleData.now },
) : EngineClient {
    enum class Scenario {
        /** Paired, everything quiet. */
        idle,
        /** Paired, and nothing waits for the person (no cards): the plain list. */
        quiet,
        /** Paired, and Alpha's turn is running (status line, Stop showing). */
        midTurn,
        /** Not paired yet. */
        unpaired,
        /** Paired, but the computer cannot be reached: every call fails. */
        unreachable,
        /** Paired, and nothing exists yet: no bots, sessions or cards. */
        empty,
        /** Paired, and every call waits (the loading state). */
        loading,
        /** Paired; one card has expired and another was answered on another device. */
        cardStates,
        /** Paired; sending a message fails. */
        sendFails,
    }

    class Failure(message: String) : Exception(message)

    private var paired: PairedComputer?
    private var botList = SampleData.bots.toMutableList()
    private var summaryList = SampleData.summaries.toMutableList()
    private val conversations = mutableMapOf<String, MutableList<ChatMessage>>()
    private val sessionList = SampleData.sessions.toMutableList()
    private var cardList = SampleData.cards.toMutableList()
    private val statusLines = linkedMapOf<String, String>()
    private val subscribers = mutableListOf<SendChannel<EngineEvent>>()
    private var connection: ConnectionState = ConnectionState.Connected
    private var otherAppInstalled = true
    private var answeredElsewhereIDs = setOf<String>()
    private val acceptedCodePrefix = "moss-pair:"

    /** Everything the client was asked to do, in order: tests read it. */
    val sent = mutableListOf<Triple<String, String, String>>()
    val stopped = mutableListOf<String>()
    val answered = mutableListOf<Pair<String, String>>()
    val markedRead = mutableListOf<String>()
    /** When set, the next call that can fail throws it, once. */
    var failNext: Exception? = null

    init {
        for (bot in SampleData.bots) conversations[bot.mainSession] = SampleData.conversation(bot.id).toMutableList()
        conversations["s_alpha"] = SampleData.conversation("alpha").toMutableList()
        for (s in SampleData.sessions) conversations[s.id] = SampleData.sessionMessages(s.id).toMutableList()
        val here = PairedComputer(SampleData.computerName, SampleData.phoneName)
        paired = here
        when (scenario) {
            Scenario.quiet -> cardList = mutableListOf()
            Scenario.idle, Scenario.loading, Scenario.sendFails -> {}
            Scenario.midTurn -> {
                statusLines["s_alpha"] = "Alpha is working"
                statusLines["c1"] = "Working"
                val i = botList.indexOfFirst { it.id == "alpha" }
                if (i >= 0) botList[i] = botList[i].copy(state = BotState.thinking)
            }
            Scenario.unpaired -> paired = null
            Scenario.unreachable -> {
                paired = here.copy(lastSeen = SampleData.now - 2 * 3600 * 1000)
                connection = ConnectionState.Unreachable(SampleData.now - 2 * 3600 * 1000)
            }
            Scenario.empty -> {
                paired = here.copy(lastSeen = SampleData.now - 30_000)
                botList = mutableListOf(); summaryList = mutableListOf(); sessionList.clear(); cardList = mutableListOf()
            }
            Scenario.cardStates -> {
                // The first card ran out of time; the third one is answered on another device.
                val i = cardList.indexOfFirst { it.id == "card_0a1b2c3d" }
                if (i >= 0) cardList[i] = cardList[i].copy(expiresAt = SampleData.now - 60_000)
                answeredElsewhereIDs = setOf("card_55aa66bb")
            }
        }
        if (paired != null && scenario != Scenario.unreachable && scenario != Scenario.empty) paired = paired?.copy(lastSeen = SampleData.now - 20_000)
    }

    override suspend fun pairedComputer(): PairedComputer? = paired

    private suspend fun maybeFail() {
        if (scenario == Scenario.loading) awaitCancellation()
        if (connection is ConnectionState.Unreachable) throw Failure("unreachable")
        failNext?.let { failNext = null; throw it }
    }

    private fun emit(e: EngineEvent) { for (c in subscribers.toList()) c.trySend(e) }

    // Pairing

    override suspend fun beginPairing(code: String): PairingProposal {
        maybeFail()
        if (!code.startsWith(acceptedCodePrefix)) throw PairingException(PairingError.unreadableCode)
        return PairingProposal("pair_1", SampleData.computerName, listOf("maple", "orbit", "velvet", "canyon"))
    }
    override suspend fun confirmPairing(proposal: PairingProposal): PairedComputer {
        maybeFail()
        val p = PairedComputer(proposal.computer, SampleData.phoneName)
        paired = p
        return p
    }
    override suspend fun cancelPairing(proposal: PairingProposal) {}

    // Bots

    override suspend fun bots(): List<Bot> { maybeFail(); return botList.toList() }
    override suspend fun botSummaries(): List<BotSummary> { maybeFail(); return summaryList.toList() }
    override suspend fun conversation(bot: String, before: Long?, limit: Int): MessagePage {
        maybeFail()
        val b = botList.firstOrNull { it.id == bot } ?: throw Failure("no such bot")
        return page(b.mainSession, before, limit)
    }
    override suspend fun markRead(bot: String) {
        markedRead.add(bot)
        val i = summaryList.indexOfFirst { it.id == bot }
        if (i >= 0) {
            summaryList[i] = summaryList[i].copy(unread = false)
            emit(EngineEvent.BotSummaryChanged(summaryList[i]))
        }
    }

    // Sessions

    override suspend fun sessions(): List<SessionRow> { maybeFail(); return sessionList.toList() }
    override suspend fun history(session: String, before: Long?, limit: Int): MessagePage { maybeFail(); return page(session, before, limit) }

    private fun page(session: String, before: Long?, limit: Int): MessagePage {
        var all: List<ChatMessage> = conversations[session] ?: emptyList()
        if (before != null) all = all.filter { it.at < before }
        return MessagePage(session, all.takeLast(limit), hasMore = all.size > limit)
    }

    // Sending

    override suspend fun send(session: String, text: String, clientMessageId: String, images: List<String>) {
        maybeFail()
        if (scenario == Scenario.sendFails) throw Failure("send failed")
        // A resend with the same client id is not a second message.
        if (sent.any { it.third == clientMessageId }) return
        sent.add(Triple(session, text, clientMessageId))
        val m = ChatMessage(clientMessageId, MessageRole.user, text, clock())
        conversations.getOrPut(session) { mutableListOf() }.add(m)
        emit(EngineEvent.Message(session, m))
        val bot = botList.firstOrNull { it.mainSession == session }
        val line = if (bot != null) "${bot.name} is thinking" else "Working"
        statusLines[session] = line
        emit(EngineEvent.StatusLine(session, line))
    }

    // Composer

    val efforts = mutableMapOf<String, String>()
    val models = mutableMapOf<String, String>()
    val staged = mutableListOf<String>()
    val commandsRun = mutableListOf<String>()
    val questionsAnswered = mutableListOf<Pair<String, Map<String, String>>>()
    private val answeredQuestions = mutableSetOf<String>()

    override suspend fun composerOffers(session: String, kind: ConversationKind): ComposerOffers {
        maybeFail()
        return when (kind) {
            ConversationKind.bot -> ComposerOffers(pictures = true, commands = listOf(PluginCommand("summary.daily", "Daily summary")),
                efforts = listOf("low", "medium", "high"), effort = efforts[session] ?: "medium")
            ConversationKind.codingSession -> {
                val row = sessionList.firstOrNull { it.id == session }
                val options = SampleData.options(row?.backend ?: "claude-code")
                val choices = options.models.map { ModelChoice(it.id, it.name, it.efforts) }
                val current = models[session] ?: row?.model ?: choices.firstOrNull()?.id
                val levels = choices.firstOrNull { it.id == current }?.efforts ?: choices.firstOrNull()?.efforts ?: emptyList()
                ComposerOffers(pictures = true, commands = listOf(PluginCommand("tests.run", "Run the tests"), PluginCommand("review.diff", "Review the diff")),
                    efforts = levels, effort = efforts[session] ?: levels.firstOrNull(), models = choices, model = current)
            }
        }
    }
    override suspend fun setModel(session: String, model: String?, effort: String?) {
        maybeFail()
        if (model != null) models[session] = model
        if (effort != null) efforts[session] = effort
    }
    override suspend fun stageImage(session: String, data: ByteArray): String {
        maybeFail()
        val path = "staged/$session/image-${staged.size + 1}.png"
        staged.add(path); return path
    }
    override suspend fun runCommand(session: String, command: String) { maybeFail(); commandsRun.add(command) }
    override suspend fun pendingQuestion(session: String): AskQuestion? {
        maybeFail()
        val q = SampleData.questions[session] ?: return null
        return if (q.callId in answeredQuestions) null else q
    }
    override suspend fun answerQuestion(session: String, question: AskQuestion, answers: Map<String, String>) {
        maybeFail()
        answeredQuestions.add(question.callId)
        questionsAnswered.add(session to answers)
    }

    override suspend fun stop(session: String) {
        maybeFail()
        stopped.add(session)
        statusLines.remove(session)
        val m = ChatMessage("stop-${stopped.size}", MessageRole.note, "Interrupted", clock())
        conversations.getOrPut(session) { mutableListOf() }.add(m)
        emit(EngineEvent.Message(session, m))
        emit(EngineEvent.StatusLine(session, null))
    }

    /** The status line a subject shows now, as the first `events()` snapshot would tell it. */
    fun statusLine(session: String): String? = statusLines[session]

    /** Ends the running turn of a session with a reply. */
    fun finishTurn(session: String, reply: String = "Understood. I will take care of it.") {
        statusLines.remove(session)
        val isBot = botList.any { it.mainSession == session }
        val m = ChatMessage("reply-${conversations[session]?.size ?: 0}", if (isBot) MessageRole.bot else MessageRole.agent, reply, clock())
        conversations.getOrPut(session) { mutableListOf() }.add(m)
        emit(EngineEvent.Message(session, m))
        emit(EngineEvent.StatusLine(session, null))
    }

    // Cards

    override suspend fun cards(): List<Card> { maybeFail(); return cardList.toList() }
    override suspend fun answer(card: Card, option: CardOption) {
        maybeFail()
        if (card.id in answeredElsewhereIDs) { cardList.removeAll { it.id == card.id }; throw CardAnswerException(CardAnswerError.answeredElsewhere) }
        if (card.expiresAt <= clock()) throw CardAnswerException(CardAnswerError.expired)
        if (cardList.none { it.id == card.id }) throw CardAnswerException(CardAnswerError.answeredElsewhere)
        answered.add(card.id to option.id)
        cardList.removeAll { it.id == card.id }
        emit(EngineEvent.CardResolved(card.id))
    }

    /** Raises a card as if the computer had just asked. */
    fun raise(card: Card) {
        cardList.add(card)
        emit(EngineEvent.CardRequested(card))
    }

    override suspend fun shows(card: Card, app: PhoneApp): Boolean {
        if (!otherAppInstalled) return true
        return (card.bot != null) == (app == PhoneApp.moss)
    }
    /** Whether the other phone app is on this phone; when it is not, each app shows every pending card. */
    fun setOtherAppInstalled(installed: Boolean) { otherAppInstalled = installed }

    // Starting a session

    override suspend fun backends(): List<AgentBackend> { maybeFail(); return SampleData.backends }
    override suspend fun startOptions(backend: String): BackendOptions { maybeFail(); return SampleData.options(backend) }
    private var recent = SampleData.recentStart
    override suspend fun recentStart(): RecentStart { maybeFail(); return recent }
    val started = mutableListOf<StartRequest>()
    override suspend fun startSession(request: StartRequest): String {
        maybeFail()
        val root = request.root.trim()
        if (root.isEmpty() || root.contains("..") || root.startsWith("home/.moss") || root == ".moss") throw StartException(StartError.folderRefused)
        started.add(request)
        val id = "c${100 + started.size}"
        val row = SessionRow(id, computer = request.computer, title = "New session", status = SessionStatus.starting, startedAt = clock(), updatedAt = clock(),
            backend = request.backend, model = request.model, root = root)
        sessionList.add(row)
        conversations[id] = mutableListOf()
        val last = RecentStart.Choice(request.backend, request.model, request.effort)
        recent = RecentStart(last = last, byBackend = listOf(last) + recent.byBackend.filter { it.backend != request.backend },
            roots = listOf(root) + recent.roots.filter { it != root })
        emit(EngineEvent.SessionChanged(row))
        return id
    }

    // Link

    override suspend fun connectionState(): ConnectionState = connection
    fun setConnection(c: ConnectionState) { connection = c; emit(EngineEvent.Connection(c)) }
    var unpairCount = 0
        private set
    override suspend fun unpair() { unpairCount += 1; paired = null }

    // Events

    override fun events(): Flow<EngineEvent> = callbackFlow {
        subscribers.add(channel)
        // What is true right now, so a subscriber that joins mid-turn still shows it.
        for ((subject, line) in statusLines) trySend(EngineEvent.StatusLine(subject, line))
        if (connection is ConnectionState.Unreachable) trySend(EngineEvent.Connection(connection))
        for (id in answeredElsewhereIDs) trySend(EngineEvent.CardResolved(id))
        awaitClose { subscribers.remove(channel) }
    }.buffer(Channel.UNLIMITED)
}
