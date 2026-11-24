package com.waifucave.moss.phone.engine

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import com.waifucave.moss.phone.client.EngineClient
import com.waifucave.moss.phone.client.MessagePage
import com.waifucave.moss.phone.model.*
import com.waifucave.moss.phonecore.AnswerKeyHolder
import com.waifucave.moss.phonecore.CardView
import com.waifucave.moss.phonecore.ConnEvent
import com.waifucave.moss.phonecore.ConnectOptions
import com.waifucave.moss.phonecore.Connection
import com.waifucave.moss.phonecore.CoreConfig
import com.waifucave.moss.phonecore.CoreException
import com.waifucave.moss.phonecore.Pairing
import com.waifucave.moss.phonecore.PhoneCore
import com.waifucave.moss.phonecore.PhoneOs
import com.waifucave.moss.phonecore.RelayChoice
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.util.TreeMap
import java.util.UUID
import com.waifucave.moss.phonecore.PairedComputer as CoreComputer
import com.waifucave.moss.phonecore.PhoneApp as CoreApp

/**
 * The real engine client: the screens' [EngineClient] over the shared phone core (`native/phone-core`, its Kotlin binding).
 * One per app process ([Engines]). The core holds the keys (through [KeystoreStore]), pairs, keeps the link and its client
 * connection up (re-dialling by itself), signs the person's messages and card answers; this class maps each screen call to
 * the engine's call (`EngineCalls`, the one file that reads engine JSON) and the core's events to the screens' events.
 *
 * Cards: the screens see a [Card] decoded from a `CardView` the core issued (from `PendingCards`, `CardRequested`). The
 * view is kept by id; [answer] takes the card the screen drew, finds the view it was decoded from, requires that view to
 * decode to exactly that card, and hands that same `CardView` object back to the core, which signs only it. A card the core
 * did not issue, or one that changed, is never answered, and nothing is fetched between the tap and the signature.
 */
class CoreEngineClient(
    context: Context,
    private val app: PhoneApp,
    private val config: Config,
) : EngineClient {
    data class Config(
        /** The phone's name as computers list it. */
        val deviceName: String,
        /** `Default` for a person's phone; `Disabled` in tests that dial the engine directly. */
        val relay: RelayChoice = RelayChoice.Default,
        /** The Keystore alias and folder of this app's store. */
        val storeAlias: String,
        val clientName: String,
        val callTimeoutMs: Long = 30_000,
    )

    private val ctx = context.applicationContext
    val store = KeystoreStore(ctx, config.storeAlias)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val coreApp = if (app == PhoneApp.moss) CoreApp.MOSS else CoreApp.CODE
    private val tag = "MossEngine"

    private val lock = Mutex()
    private var core: PhoneCore? = null
    private var conn: Connection? = null
    private var computer: CoreComputer? = null
    private var reader: Job? = null
    private var firstUp = CompletableDeferred<Unit>()

    private val events = MutableSharedFlow<EngineEvent>(extraBufferCapacity = 512, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    @Volatile private var state: ConnectionState = ConnectionState.Connected
    @Volatile private var lastUp: Long? = null
    @Volatile private var treeName: String? = null

    // What the client keeps, guarded by `this`.
    private val pairings = HashMap<String, Pairing>()
    /** The cards the core issued and that are still pending, by id, in arrival order. */
    private val issued = LinkedHashMap<String, CardView>()
    private val bots = HashMap<String, Bot>()                // by id
    private val sessionKinds = HashMap<String, String>()     // session id -> kind
    private val sessionModels = HashMap<String, String>()    // session id -> model
    private var devices: List<Decode.Device>? = null
    /** The sessions followed live (`session.attach`), most recent last, with the last seq heard of each. */
    private val followed = LinkedHashMap<String, Long>()
    /** Per session: a message's time -> the smallest seq at that time (the screens page back by a message's time). */
    private val seqAt = HashMap<String, TreeMap<Long, Long>>()

    private val calls = EngineCalls { method, params ->
        val c = connection() ?: throw IllegalStateException("not paired")
        val text = try { c.call(method, params.toString()) } catch (e: CoreException.Rpc) { throw EngineRpcError(e.code, e.computersWords) }
        Decode.parse(text)
    }

    init {
        // A network change or a wake: the core re-dials at once instead of waiting out its backoff.
        runCatching {
            ctx.getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { conn?.networkChanged() }
                override fun onLost(network: Network) { conn?.networkChanged() }
            })
        }
    }

    // The core and the connection

    private suspend fun phoneCore(): PhoneCore = lock.withLock { coreLocked() }

    private suspend fun coreLocked(): PhoneCore {
        core?.let { return it }
        // The constructor reads (or makes and saves) the keys through the store: off the main thread.
        val made = withContext(Dispatchers.IO) {
            PhoneCore(store, CoreConfig(config.deviceName, AnswerKeyHolder.KEYSTORE_WRAPPED, PhoneOs.ANDROID, config.relay, null))
        }
        core = made
        return made
    }

    /** The connection to this app's paired computer, started on first use; `null` when this app isn't paired. */
    private suspend fun connection(): Connection? = lock.withLock {
        conn?.let { return it }
        val core = coreLocked()
        val mine = withContext(Dispatchers.IO) { core.pairedComputers() }.filter { it.app == coreApp }.maxByOrNull { it.pairedAt } ?: return null
        val areas = listOf("approvals", "sessions", "bots", "devices", "computers")
        val c = core.connect(mine.id, ConnectOptions(config.clientName, areas, config.callTimeoutMs.toULong()))
        conn = c
        computer = mine
        reader = scope.launch { read(c) }
        c
    }

    private suspend fun read(c: Connection) {
        while (true) {
            val e = try { c.nextEvent() } catch (e: CancellationException) { throw e } catch (e: Exception) { null } ?: break
            try { handle(e) } catch (x: CancellationException) { throw x } catch (x: Exception) { Log.w(tag, "an event couldn't be handled: ${x.javaClass.simpleName}") }
        }
    }

    private fun setState(s: ConnectionState) {
        if (s == state) return
        state = s
        events.tryEmit(EngineEvent.Connection(s))
    }

    private suspend fun handle(e: ConnEvent) {
        when (e) {
            is ConnEvent.Up -> {
                lastUp = System.currentTimeMillis()
                setState(ConnectionState.Connected)
                firstUp.complete(Unit)
                scope.launch { afterUp() }
            }
            is ConnEvent.Connecting -> if (e.attempt > 0u) setState(ConnectionState.Unreachable(lastUp))
            is ConnEvent.Down, is ConnEvent.Unpaired, is ConnEvent.Revoked -> setState(ConnectionState.Unreachable(lastUp))
            is ConnEvent.PendingCards -> {
                val now = e.cards.associateBy { it.id() }
                val gone: List<String>
                val fresh: List<CardView>
                synchronized(this) {
                    gone = issued.keys.filter { it !in now }
                    fresh = e.cards.filter { it.id() !in issued }
                    issued.clear(); issued.putAll(now)
                }
                for (id in gone) events.tryEmit(EngineEvent.CardResolved(id))
                for (v in fresh) Decode.card(v.cardJson(), v.hash())?.let { events.tryEmit(EngineEvent.CardRequested(it)) }
            }
            is ConnEvent.CardRequested -> {
                synchronized(this) { issued[e.card.id()] = e.card }
                Decode.card(e.card.cardJson(), e.card.hash())?.let { events.tryEmit(EngineEvent.CardRequested(it)) }
            }
            is ConnEvent.CardResolved -> {
                synchronized(this) { issued.remove(e.id) }
                events.tryEmit(EngineEvent.CardResolved(e.id))
            }
            is ConnEvent.Notification -> notification(e.method, e.paramsJson)
            is ConnEvent.Lagged -> scope.launch { afterUp() }
            is ConnEvent.TamperedCard, is ConnEvent.MessageDropped, is ConnEvent.Closed -> {}
        }
    }

    /** After every connect: follow the open conversations again (replaying what was missed) and re-read the lists. */
    private suspend fun afterUp() {
        try {
            treeName = calls.selfComputerName() ?: treeName
            synchronized(this) { devices = null }
            val follow = synchronized(this) { followed.toMap() }
            for ((id, last) in follow) runCatching { calls.sessionAttach(id, last) }
            val faces = runCatching { calls.botFaces() }.getOrDefault(emptyMap())
            for (b in calls.botList(faces)) { remember(b); events.tryEmit(EngineEvent.BotChanged(b)) }
            for (s in calls.botSummaries()) events.tryEmit(EngineEvent.BotSummaryChanged(s))
            for (s in calls.sessionList()) { remember(s); events.tryEmit(EngineEvent.SessionChanged(s)) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            Log.w(tag, "re-reading after a connect failed: ${e.javaClass.simpleName}")
        }
    }

    private fun remember(b: Bot) = synchronized(this) { bots[b.id] = b; sessionKinds[b.mainSession] = "bot" }
    private fun remember(s: SessionRow) = synchronized(this) { sessionKinds[s.id] = s.kind; s.model?.let { sessionModels[s.id] = it } }

    private fun notification(method: String, paramsJson: String) {
        val p = Decode.parse(paramsJson) ?: return
        when (method) {
            "core.event" -> coreEvent(p)
            "event" -> sessionEvent(p)
        }
    }

    private fun coreEvent(p: JsonElement) {
        when (p["type"].str()) {
            "bot_changed" -> Decode.bot(p["bot"], synchronized(this) { bots.mapNotNull { (k, v) -> v.face?.let { k to it } }.toMap() })?.let { b ->
                remember(b)
                events.tryEmit(EngineEvent.BotChanged(b))
                events.tryEmit(EngineEvent.StatusLine(b.mainSession, if (b.state == BotState.thinking) "${b.name} is thinking" else null))
            }
            "bot_record_changed" -> Decode.botRecord(p["bot"])?.let { b ->
                // A new bot (its state comes with its `bot_changed`): only one this client doesn't know yet.
                if (synchronized(this) { b.id !in bots }) { remember(b); events.tryEmit(EngineEvent.BotChanged(b)) }
            }
            "bot_summary_changed" -> Decode.summary(p["summary"])?.let { events.tryEmit(EngineEvent.BotSummaryChanged(it)) }
            "session_changed" -> Decode.session(p["session"])?.let { s ->
                remember(s)
                events.tryEmit(EngineEvent.SessionChanged(s))
            }
            "device_changed", "device_removed" -> synchronized(this) { devices = null }
        }
    }

    private fun kindOf(session: String): ConversationKind =
        if (synchronized(this) { sessionKinds[session] } == "bot") ConversationKind.bot else ConversationKind.codingSession

    private fun sessionEvent(p: JsonElement) {
        val session = p["sessionId"].str() ?: return
        val type = p["type"].str() ?: return
        val seq = p["seq"].long()
        // A streaming delta carries the log's last seq, not its own: never counted as heard.
        if (seq != null && type != "assistant_delta") synchronized(this) { if (session in followed) followed[session] = maxOf(followed[session] ?: 0, seq) }
        when (type) {
            "turn_started" -> {
                val bot = synchronized(this) { bots.values.firstOrNull { it.mainSession == session } }
                events.tryEmit(EngineEvent.StatusLine(session, if (bot != null) "${bot.name} is thinking" else "Working"))
            }
            "turn_completed" -> events.tryEmit(EngineEvent.StatusLine(session, null))
        }
        message(p, session)?.let { events.tryEmit(EngineEvent.Message(session, it)) }
    }

    private fun message(e: JsonElement, session: String): ChatMessage? {
        val m = Decode.message(e, kindOf(session), ::deviceName) ?: return null
        val seq = e["seq"].long() ?: return m
        synchronized(this) { seqAt.getOrPut(session) { TreeMap() }.merge(m.at, seq) { a, b -> minOf(a, b) } }
        return m
    }

    /** Another device's name, for a user message that came from it; `null` for this phone's own. */
    private fun deviceName(id: String): String? {
        val me = runCatching { core?.identity()?.deviceId }.getOrNull()
        if (id == me) return null
        return synchronized(this) { devices }?.firstOrNull { it.id == id }?.name ?: "another device"
    }

    /** Follows a session live from now, before its page is handed over; at most a few at once (the oldest let go). */
    private suspend fun follow(session: String, lastSeq: Long?) {
        val drop = synchronized(this) {
            val known = followed.remove(session)
            followed[session] = maxOf(known ?: 0, lastSeq ?: 0)
            if (followed.size > 8) followed.keys.first().also { followed.remove(it) } else null
        }
        try { calls.sessionAttach(session, null) } catch (e: CancellationException) { throw e } catch (e: Exception) { Log.w(tag, "following a session failed: ${e.javaClass.simpleName}") }
        if (drop != null) scope.launch { runCatching { connection()?.call("session.detach", JsonObject(mapOf("id" to kotlinx.serialization.json.JsonPrimitive(drop))).toString()) } }
    }

    /** A message's time back to the seq the engine pages by (`before` is a seq there, a time on the screens). */
    private fun beforeSeq(session: String?, before: Long?): Long? {
        if (before == null || session == null) return null
        return synchronized(this) { seqAt[session]?.get(before) ?: seqAt[session]?.ceilingEntry(before)?.value }
    }

    private suspend fun page(session: String?, p: EngineCalls.Page): MessagePage {
        val s = p.session ?: session ?: ""
        val msgs = p.events.mapNotNull { message(it, s) }
        val last = p.events.lastOrNull()?.get("seq").long()
        if (s.isNotEmpty()) follow(s, last)
        return MessagePage(s, msgs, p.hasMore)
    }

    // Pairing

    override suspend fun pairedComputer(): PairedComputer? {
        val c = connection() ?: return null
        val pc = c.computer()
        if (treeName == null) scope.launch { runCatching { treeName = calls.selfComputerName() } }
        return PairedComputer(treeName ?: pc.name, phoneCore().identity().name, lastUp)
    }

    private fun pairingError(e: Exception): PairingException = PairingException(
        when (e) {
            is CoreException.Invalid -> PairingError.unreadableCode
            is CoreException.Refused -> {
                val r = e.reason.lowercase()
                when {
                    "words" in r || "cancel" in r || "said no" in r -> PairingError.wordsDoNotMatch
                    "expired" in r || "isn't showing" in r -> PairingError.expired
                    else -> PairingError.unreachable
                }
            }
            else -> PairingError.unreachable
        },
    )

    override suspend fun beginPairing(code: String): PairingProposal {
        val qr = code.trim()
        if (!qr.startsWith("clover-pair:")) throw PairingException(PairingError.unreadableCode)
        val pairing = try { phoneCore().beginPairing(qr, coreApp) } catch (e: CancellationException) { throw e } catch (e: Exception) { throw pairingError(e) }
        val id = UUID.randomUUID().toString()
        synchronized(this) { pairings[id] = pairing }
        return PairingProposal(id, pairing.computerName(), pairing.words())
    }

    override suspend fun confirmPairing(proposal: PairingProposal): PairedComputer {
        val pairing = synchronized(this) { pairings.remove(proposal.pairingId) } ?: throw PairingException(PairingError.expired)
        try { pairing.confirm() } catch (e: CancellationException) { throw e } catch (e: Exception) { throw pairingError(e) }
        // A new pairing replaces this app's connection to the one before, if any.
        lock.withLock { conn?.disconnect(); conn = null; reader?.cancel(); firstUp = CompletableDeferred() }
        return pairedComputer() ?: throw PairingException(PairingError.unreachable)
    }

    override suspend fun cancelPairing(proposal: PairingProposal) {
        synchronized(this) { pairings.remove(proposal.pairingId) }?.reject()
    }

    // Bots

    override suspend fun bots(): List<Bot> {
        val faces = runCatching { calls.botFaces() }.getOrDefault(emptyMap())
        return calls.botList(faces).onEach { remember(it) }
    }
    override suspend fun botSummaries(): List<BotSummary> = calls.botSummaries()

    override suspend fun conversation(bot: String, before: Long?, limit: Int): MessagePage {
        val main = synchronized(this) { bots[bot]?.mainSession } ?: calls.botGet(bot)?.also { remember(it) }?.mainSession
        main?.let { synchronized(this) { sessionKinds[it] = "bot" } }
        return page(main, calls.botConversation(bot, beforeSeq(main, before), limit))
    }

    override suspend fun markRead(bot: String) = calls.botMarkRead(bot, System.currentTimeMillis())

    // Sessions

    override suspend fun sessions(): List<SessionRow> = calls.sessionList().onEach { remember(it) }
    override suspend fun history(session: String, before: Long?, limit: Int): MessagePage =
        page(session, calls.sessionHistory(session, beforeSeq(session, before), limit))

    override suspend fun send(session: String, text: String, clientMessageId: String, images: List<String>, files: List<String>) {
        val c = connection() ?: throw IllegalStateException("not paired")
        // Signed by the core with this phone's answer key; the same client id makes a resend the same message.
        c.sendMessage(session, text, clientMessageId, images, files)
    }

    override suspend fun stop(session: String) = calls.sessionInterrupt(session)

    // Cards

    override suspend fun cards(): List<Card> {
        if (connection() == null) throw IllegalStateException("not paired")
        // The pending cards come with the connection (`PendingCards`): wait for it to be up once.
        withTimeoutOrNull(15_000) { firstUp.await() } ?: throw IllegalStateException("not connected")
        val views = synchronized(this) { issued.values.toList() }
        return views.filter { it.pending() }.mapNotNull { Decode.card(it.cardJson(), it.hash()) }
    }

    override suspend fun answer(card: Card, option: CardOption) {
        val c = connection() ?: throw IllegalStateException("not paired")
        val view = synchronized(this) { issued[card.id] } ?: throw CardAnswerException(CardAnswerError.answeredElsewhere)
        // The card the screen drew must be exactly what this view says: same hash, same content, the option one of its own.
        if (view.hash() != card.hash || Decode.card(view.cardJson(), view.hash()) != card) throw IllegalStateException("the card on screen isn't the one the core issued")
        if (option.id !in view.options() || card.options.none { it == option }) throw IllegalArgumentException("not one of the card's options")
        if (!view.pending()) throw CardAnswerException(if (view.outcome() == "expired") CardAnswerError.expired else CardAnswerError.answeredElsewhere)
        val outcome = c.answerCard(view, option.id, emptyList())
        if (outcome.accepted) {
            synchronized(this) { issued.remove(card.id) }
            events.tryEmit(EngineEvent.CardResolved(card.id))
            return
        }
        val why = outcome.computersReason?.lowercase() ?: ""
        throw when {
            "time ran out" in why || "expired" in why -> CardAnswerException(CardAnswerError.expired)
            "already answered" in why || "no such card" in why -> CardAnswerException(CardAnswerError.answeredElsewhere)
            else -> IllegalStateException("the answer wasn't taken")
        }
    }

    /**
     * Which cards this app shows (the engine's routing rule, `push-routing.ts`): a card belongs to MOSS when a bot's
     * conversation raised it, to MOSS Code when a coding or agent session did. Each app shows its own, and the other app's
     * too when no phone of that app is paired with the computer (so a card is never shown nowhere).
     */
    override suspend fun shows(card: Card, app: PhoneApp): Boolean {
        val kind = card.session?.let { synchronized(this) { sessionKinds[it] } }
        val owner = when {
            kind == "bot" || kind == "side-thread" -> PhoneApp.moss
            kind == "coding" || kind == "agent" -> PhoneApp.code
            card.bot != null -> PhoneApp.moss
            else -> null
        } ?: return true
        if (owner == app) return true
        val phones = synchronized(this) { devices } ?: runCatching { calls.devices() }.getOrNull()?.also { synchronized(this) { devices = it } } ?: return true
        val me = runCatching { phoneCore().identity().deviceId }.getOrNull()
        return phones.none { it.phone && it.id != me && (it.app == owner || it.app == null) }
    }

    // Starting a session

    override suspend fun backends(): List<AgentBackend> = calls.agentBackends(treeName)
    override suspend fun startOptions(backend: String): BackendOptions = calls.agentOptions(backend)
    override suspend fun recentStart(): RecentStart = calls.agentRecent()
    override suspend fun startSession(request: StartRequest): String = try {
        calls.agentStart(request).also { synchronized(this) { sessionKinds[it] = "coding" } }
    } catch (e: EngineRpcError) {
        val w = e.words.lowercase()
        throw when {
            "install" in w -> StartException(StartError.notInstalled)
            "folder" in w || "fence" in w || "home" in w || "root" in w -> StartException(StartError.folderRefused)
            else -> e
        }
    }

    // The composer

    override suspend fun composerOffers(session: String, kind: ConversationKind): ComposerOffers = try {
        calls.composerOffers(session) ?: ComposerOffers()
    } catch (e: NotAvailableYet) {
        // An engine without lane PH's door: what the doors on today's remote list offer. Pictures (`session.stageImage`),
        // the plugins' commands, and a coding session's models; no Files row.
        val commands = runCatching { calls.commandList() }.getOrDefault(emptyList())
        if (kind == ConversationKind.bot) ComposerOffers(pictures = true, commands = commands)
        else {
            val models = runCatching { calls.modelsList(session) }.getOrNull()
            val choices = models["models"].arr().filter { it["signedIn"].bool() != false }.mapNotNull { m ->
                m["id"].str()?.let { ModelChoice(it, Decode.text(m["name"]) ?: it, m["efforts"].arr().mapNotNull { x -> x.str() }) }
            }
            val current = synchronized(this) { sessionModels[session] }
            ComposerOffers(pictures = true, commands = commands, models = choices, model = current,
                efforts = choices.firstOrNull { it.id == current }?.efforts ?: emptyList())
        }
    }

    override suspend fun setModel(session: String, model: String?, effort: String?) {
        val m = model ?: synchronized(this) { sessionModels[session] } ?: throw IllegalStateException("no model to keep")
        calls.sessionSetModel(session, m, effort)
        synchronized(this) { sessionModels[session] = m }
    }

    override suspend fun stageImage(session: String, data: ByteArray): String {
        val c = connection() ?: throw IllegalStateException("not paired")
        return c.stageImage(session, mediaType(data), data)
    }

    override suspend fun stageFile(session: String, name: String, data: ByteArray): StagedFile {
        val c = connection() ?: throw IllegalStateException("not paired")
        if (data.size > STAGE_FILE_MAX_BYTES) throw FileTooLarge(STAGE_FILE_MAX_BYTES)
        val f = c.stageFile(session, name, data)
        return StagedFile(f.path, f.computersName, data.size.toLong())
    }

    override suspend fun newBotOptions(): NewBotOptions = calls.newBotOptions()

    override suspend fun createBot(name: String, model: String?): Bot {
        val made = calls.botCreate(name, model)
        val full = runCatching { calls.botGet(made.id) }.getOrNull() ?: made
        remember(full)
        return full
    }

    override suspend fun runCommand(session: String, command: String) = calls.commandRun(command)

    override suspend fun pendingQuestion(session: String): AskQuestion? = Decode.openQuestion(calls.sessionHistory(session, null, 200).events)

    override suspend fun answerQuestion(session: String, question: AskQuestion, answers: Map<String, String>) {
        // The engine keys an answer by the question's text (the screens key it by its header when it has one).
        val value = answers.values.firstOrNull() ?: ""
        calls.sessionAnswer(session, question.callId, mapOf(question.text to value))
    }

    // The link

    override suspend fun connectionState(): ConnectionState = state

    /**
     * Forgets the computer on this phone: the link closes, and every item of the store goes, the phone's own device and
     * answer keys and the Keystore key included, so pairing again makes a new device. (The computer keeps its record of
     * this phone until the person revokes it there: a phone revoking itself would put a card on the computer.)
     */
    override suspend fun unpair() {
        lock.withLock {
            conn?.disconnect(); conn = null; reader?.cancel(); reader = null; computer = null
            core?.let { c ->
                withContext(Dispatchers.IO) { runCatching { c.pairedComputers().forEach { pc -> c.forgetComputer(pc.id) } } }
                runCatching { c.shutdown() }
                c.destroy()
            }
            core = null
            firstUp = CompletableDeferred()
            withContext(Dispatchers.IO) { store.wipe() }
        }
        synchronized(this) {
            pairings.clear(); issued.clear(); bots.clear(); sessionKinds.clear(); sessionModels.clear(); devices = null; followed.clear(); seqAt.clear()
        }
        treeName = null; lastUp = null
        state = ConnectionState.Connected
    }

    override fun events(): Flow<EngineEvent> = flow {
        val s = state
        if (s is ConnectionState.Unreachable) emit(EngineEvent.Connection(s))
        emitAll(events)
    }

    companion object {
        const val STAGE_FILE_MAX_BYTES: Long = 50L * 1024 * 1024

        /** What a picture's bytes are, as the engine sniffs them (`STAGE_IMAGE_MEDIA_TYPES`). */
        fun mediaType(d: ByteArray): String {
            fun at(i: Int, vararg b: Int) = d.size >= i + b.size && b.indices.all { d[i + it] == b[it].toByte() }
            return when {
                at(0, 0x89, 0x50, 0x4E, 0x47) -> "image/png"
                at(0, 0xFF, 0xD8, 0xFF) -> "image/jpeg"
                at(0, 0x47, 0x49, 0x46, 0x38) -> "image/gif"
                at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50) -> "image/webp"
                at(4, 0x66, 0x74, 0x79, 0x70) -> "image/heic"
                at(0, 0x42, 0x4D) -> "image/bmp"
                else -> "image/jpeg"
            }
        }
    }
}
