package com.waifucave.moss.phone.engine

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import com.waifucave.moss.phone.client.EngineClient
import com.waifucave.moss.phone.client.MessagePage
import com.waifucave.moss.phone.model.*
import com.waifucave.moss.phone.ui.drawable
import com.waifucave.moss.phonecore.AnswerKeyHolder
import com.waifucave.moss.phonecore.CardView
import com.waifucave.moss.phonecore.ConnEvent
import com.waifucave.moss.phonecore.ConnectOptions
import com.waifucave.moss.phonecore.Connection
import com.waifucave.moss.phonecore.CoreConfig
import com.waifucave.moss.phonecore.CoreException
import com.waifucave.moss.phonecore.ItemKind
import com.waifucave.moss.phonecore.Pairing
import com.waifucave.moss.phonecore.PhoneCore
import com.waifucave.moss.phonecore.PhoneOs
import com.waifucave.moss.phonecore.RelayChoice
import com.waifucave.moss.phonecore.SessionItem
import com.waifucave.moss.phonecore.visibleText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
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
import java.util.TreeMap
import java.util.UUID
import com.waifucave.moss.phonecore.PhoneApp as CoreApp
import com.waifucave.moss.phonecore.StartRequest as CoreStart

/**
 * The real engine client: the screens' [EngineClient] over the shared phone core (`native/phone-core`, its Kotlin binding).
 * One per app process ([Engines]). The core holds the keys (through [KeystoreStore]), pairs, keeps the link and its client
 * connection up (re-dialling by itself), signs the person's messages and card answers, and makes the engine's calls as typed
 * calls with records; this class maps each screen call to the core's call ([Typed] maps the records) and the core's events
 * to the screens' events. The few calls the core doesn't type yet are in `EngineCalls.kt`, the one file reading engine JSON.
 *
 * Cards: the screens see a [Card] drawn from a `CardView` the core issued (from `PendingCards`, `CardRequested`). The view
 * is kept by id; [answer] takes the card the screen drew, finds the view it was drawn from, requires that view to draw to
 * exactly that card, and hands that same `CardView` back to the core, which signs only it (and only while it is pending
 * and was issued by this connection). Nothing is fetched between the tap and the signature.
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
    /** The engine's one rule for the computer's text drawn outside a typed field. */
    private val clean: (String) -> String = { visibleText(it, false) }

    private val lock = Mutex()
    private var core: PhoneCore? = null
    private var conn: Connection? = null
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

    private suspend fun c(): Connection = connection() ?: throw IllegalStateException("not paired")

    /**
     * Every call into the core runs on the IO dispatcher. The core completes an async call by calling back on a thread of its
     * own (attached through JNA); a caller whose dispatcher resumes undispatched (a test's, Compose's in tests) would run its
     * own code on that thread and call into the core again from inside the callback, which the runtime aborts on.
     */
    private suspend fun <T> io(f: suspend () -> T): T = withContext(Dispatchers.IO) { f() }

    private val calls = EngineCalls({ method, params ->
        val text = try { c().call(method, params.toString()) } catch (e: CoreException.Rpc) { throw EngineRpcError(e.code, e.computersWords) }
        Decode.parse(text)
    }, clean)

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
        // An empty store is an unpaired phone with no identity yet: asking about it makes no keys (a pairing does).
        if (core == null && withContext(Dispatchers.IO) { store.itemCount() } == 0) return null
        val core = coreLocked()
        val mine = withContext(Dispatchers.IO) { core.pairedComputers() }.filter { it.app == coreApp }.maxByOrNull { it.pairedAt } ?: return null
        val areas = listOf("approvals", "sessions", "bots", "devices", "computers")
        val c = core.connect(mine.id, ConnectOptions(config.clientName, areas, config.callTimeoutMs.toULong()))
        conn = c
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

    /** The card a view draws: its JSON as the core checked it, its owner as the core read it. */
    private fun cardOf(v: CardView): Card? = Decode.card(v.cardJson(), v.hash(), clean)?.copy(bot = v.bot(), session = v.session())

    /** What the screens are given for a card the core issued: the card, or one to answer on the computer. */
    private fun shownOf(v: CardView): Card = cardOf(v) ?: Decode.unreadable(v.id(), v.hash(), v.bot(), v.session())

    private fun handle(e: ConnEvent) {
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
                    // New, or the same id with other content (a new hash): either is shown afresh.
                    fresh = e.cards.filter { v -> issued[v.id()]?.hash() != v.hash() }
                    issued.clear(); issued.putAll(now)
                }
                for (id in gone) events.tryEmit(EngineEvent.CardResolved(id))
                for (v in fresh) events.tryEmit(EngineEvent.CardRequested(shownOf(v)))
            }
            is ConnEvent.CardRequested -> {
                synchronized(this) { issued[e.card.id()] = e.card }
                events.tryEmit(EngineEvent.CardRequested(shownOf(e.card)))
            }
            is ConnEvent.CardResolved -> {
                synchronized(this) { issued.remove(e.id) }
                events.tryEmit(EngineEvent.CardResolved(e.id))
            }
            is ConnEvent.BotChanged -> {
                val b = Typed.bot(e.bot)
                remember(b)
                events.tryEmit(EngineEvent.BotChanged(b))
                events.tryEmit(EngineEvent.StatusLine(b.mainSession, if (b.state == BotState.thinking) "${b.name} is thinking" else null))
            }
            is ConnEvent.BotSummaryChanged -> events.tryEmit(EngineEvent.BotSummaryChanged(Typed.summary(e.summary)))
            is ConnEvent.BotRemoved -> synchronized(this) { bots.remove(e.id) }
            is ConnEvent.SessionChanged -> {
                val s = Typed.session(e.session)
                remember(s)
                events.tryEmit(EngineEvent.SessionChanged(s))
                // A coding session's one status line follows its state (a bot's follows the bot's).
                if (s.bot == null) events.tryEmit(EngineEvent.StatusLine(s.id, if (s.motion == SessionMotion.running) "Working" else null))
            }
            is ConnEvent.SessionEvent -> sessionItem(e.item)
            is ConnEvent.Notification -> if (e.method == "core.event" && e.paramsJson.contains("\"device_")) synchronized(this) { devices = null }
            is ConnEvent.Lagged -> scope.launch { afterUp() }
            // A deleted session (`session_removed`): the Android lists don't drop it live yet; they do on their next read.
            is ConnEvent.SessionRemoved -> {}
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
            val conn = c()
            for (b in conn.bots()) { val m = Typed.bot(b); remember(m); events.tryEmit(EngineEvent.BotChanged(m)) }
            for (s in conn.botSummaries()) events.tryEmit(EngineEvent.BotSummaryChanged(Typed.summary(s)))
            for (r in conn.sessions()) { val s = Typed.session(r); remember(s); events.tryEmit(EngineEvent.SessionChanged(s)) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            Log.w(tag, "re-reading after a connect failed: ${e.javaClass.simpleName}")
        }
    }

    private fun remember(b: Bot) = synchronized(this) { bots[b.id] = b; sessionKinds[b.mainSession] = "bot" }
    private fun remember(s: SessionRow) = synchronized(this) { sessionKinds[s.id] = s.kind; s.model?.let { sessionModels[s.id] = it } }

    private fun isBot(session: String) = synchronized(this) { sessionKinds[session] } == "bot"

    private fun sessionItem(i: SessionItem) {
        synchronized(this) { if (i.session in followed) followed[i.session] = maxOf(followed[i.session] ?: 0, i.seq.toLong()) }
        if (i.kind is ItemKind.TurnEnded) events.tryEmit(EngineEvent.StatusLine(i.session, null))
        message(i)?.let { events.tryEmit(EngineEvent.Message(i.session, it)) }
        if (i.kind is ItemKind.QuestionAsked || i.kind is ItemKind.QuestionResolved) events.tryEmit(EngineEvent.QuestionChanged(i.session))
    }

    private fun message(i: SessionItem): ChatMessage? {
        val m = Typed.message(i, isBot(i.session), ::deviceName) ?: return null
        synchronized(this) { seqAt.getOrPut(i.session) { TreeMap() }.merge(m.at, i.seq.toLong()) { a, b -> minOf(a, b) } }
        return m
    }

    /** Another device's name, for a user message that came from it; `null` for this phone's own. */
    private fun deviceName(id: String): String? {
        val me = runCatching { core?.identity()?.deviceId }.getOrNull()
        if (id == me) return null
        return synchronized(this) { devices }?.firstOrNull { it.id == id }?.name ?: "another device"
    }

    /** Follows a session live, before its page is handed over; at most a few at once (the oldest let go). */
    private suspend fun follow(session: String, lastSeq: Long?) {
        val drop = synchronized(this) {
            val known = followed.remove(session)
            followed[session] = maxOf(known ?: 0, lastSeq ?: 0)
            if (followed.size > 8) followed.keys.first().also { followed.remove(it) } else null
        }
        try { calls.sessionAttach(session, null) } catch (e: CancellationException) { throw e } catch (e: Exception) { Log.w(tag, "following a session failed: ${e.javaClass.simpleName}") }
        if (drop != null) scope.launch { runCatching { calls.sessionDetach(drop) } }
    }

    /** A message's time back to the seq the engine pages by (`before` is a seq there, a time on the screens). */
    private fun beforeSeq(session: String?, before: Long?): Long? {
        if (before == null || session == null) return null
        return synchronized(this) { seqAt[session]?.get(before) ?: seqAt[session]?.ceilingEntry(before)?.value }
    }

    private suspend fun page(p: com.waifucave.moss.phonecore.MessagePage): MessagePage {
        val msgs = p.items.mapNotNull { message(it) }
        follow(p.session, p.items.lastOrNull()?.seq?.toLong())
        return MessagePage(p.session, msgs, p.hasMore)
    }

    // Pairing

    override suspend fun pairedComputer(): PairedComputer? = io {
        val c = connection() ?: return@io null
        val pc = c.computer()
        if (treeName == null) scope.launch { runCatching { treeName = calls.selfComputerName() } }
        PairedComputer(treeName ?: pc.name, phoneCore().identity().name, lastUp)
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

    override suspend fun beginPairing(code: String): PairingProposal = io {
        // The core reads the code and refuses anything that isn't a pairing QR (`Invalid` -> unreadable). A code that isn't
        // even shaped like one (`<name>:<version>:<base64url>`) is refused here, before the core exists, so nothing is written.
        val qr = code.trim()
        if (!ReadBack.looksLikePairingCode(qr)) throw PairingException(PairingError.unreadableCode)
        // Making the core makes this phone's keys and saves them. A first pairing that then fails leaves nothing behind:
        // the store is wiped again, as it was.
        // Whether the store was empty and the core that read it are taken under one hold of the lock.
        val (wasEmpty, made) = lock.withLock {
            val empty = core == null && withContext(Dispatchers.IO) { store.itemCount() } == 0
            empty to coreLocked()
        }
        val pairing = try { made.beginPairing(qr, coreApp) } catch (e: CancellationException) {
            if (wasEmpty) forgetIdentity(); throw e
        } catch (e: Exception) {
            if (wasEmpty) forgetIdentity(); throw pairingError(e)
        }
        val id = UUID.randomUUID().toString()
        synchronized(this) { pairings[id] = pairing }
        PairingProposal(id, visibleText(pairing.computerName(), true), pairing.words())
    }

    /** The phone's keys, made for a first pairing that didn't happen, go again: the store is as it was before. */
    private suspend fun forgetIdentity() = withContext(NonCancellable) {
        lock.withLock {
            if (conn != null) return@withLock
            core?.let { c -> runCatching { c.shutdown() }; c.destroy() }
            core = null
            store.wipe()
        }
    }

    override suspend fun confirmPairing(proposal: PairingProposal): PairedComputer = io {
        val pairing = synchronized(this) { pairings.remove(proposal.pairingId) } ?: throw PairingException(PairingError.expired)
        try { pairing.confirm() } catch (e: CancellationException) { throw e } catch (e: Exception) { throw pairingError(e) }
        // A new pairing replaces this app's connection to the one before, if any.
        lock.withLock { conn?.disconnect(); conn = null; reader?.cancel(); firstUp = CompletableDeferred() }
        pairedComputer() ?: throw PairingException(PairingError.unreachable)
    }

    override suspend fun cancelPairing(proposal: PairingProposal): Unit = io {
        synchronized(this) { pairings.remove(proposal.pairingId) }?.reject()
    }

    // Bots

    override suspend fun bots(): List<Bot> = io { c().bots().map { Typed.bot(it).also(::remember) } }
    override suspend fun botSummaries(): List<BotSummary> = io { c().botSummaries().map(Typed::summary) }

    override suspend fun conversation(bot: String, before: Long?, limit: Int): MessagePage = io {
        val main = synchronized(this) { bots[bot]?.mainSession }
        main?.let { synchronized(this) { sessionKinds[it] = "bot" } }
        val p = c().conversation(bot, beforeSeq(main, before), limit.coerceIn(1, 500).toUInt())
        synchronized(this) { sessionKinds[p.session] = "bot" }
        page(p)
    }

    override suspend fun markRead(bot: String): Unit = io { c().markRead(bot, System.currentTimeMillis()) }

    // Sessions

    override suspend fun sessions(): List<SessionRow> = io { c().sessions().map { Typed.session(it).also(::remember) } }
    override suspend fun history(session: String, before: Long?, limit: Int): MessagePage =
        io { page(c().history(session, beforeSeq(session, before), limit.coerceIn(1, 500).toUInt())) }

    override suspend fun send(session: String, text: String, clientMessageId: String, images: List<String>, files: List<String>): Unit = io {
        // Signed by the core with this phone's answer key. The same client id makes a resend the same message, so a retry
        // after a timeout (which doesn't mean the computer didn't get it) is never a second message.
        c().sendMessage(session, ReadBack.withTokens(text, images.size, files.size), clientMessageId, images, files)
    }

    override suspend fun stop(session: String): Unit = io { c().stop(session) }

    // Cards

    override suspend fun cards(): List<Card> = io {
        c()
        // The pending cards come with the connection (`PendingCards`): wait for it to be up once.
        withTimeoutOrNull(15_000) { firstUp.await() } ?: throw IllegalStateException("not connected")
        val views = synchronized(this) { issued.values.toList() }
        views.filter { it.pending() }.mapNotNull(::cardOf)
    }

    override suspend fun answer(card: Card, option: CardOption): Unit = io {
        val c = c()
        val view = synchronized(this) { issued[card.id] } ?: throw CardAnswerException(CardAnswerError.answeredElsewhere)
        // The card the screen drew must be exactly what this view draws: same hash, same content, the option one of its own.
        if (view.hash() != card.hash || cardOf(view) != card) throw IllegalStateException("the card on screen isn't the one the core issued")
        if (option.id !in view.options() || card.options.none { it == option }) throw IllegalArgumentException("not one of the card's options")
        // Drawn whole, judged here on the card this client read from the core's view (not on what the screen says): a card
        // holding a field this phone can't draw, too much to show, or children (checkboxes this phone doesn't draw) is
        // answered on the computer.
        val issuedCard = cardOf(view) ?: throw IllegalStateException("this card is answered on the computer")
        if (!issuedCard.drawable()) throw IllegalStateException("this card is answered on the computer")
        if (!view.pending()) throw CardAnswerException(if (view.outcome() == "expired") CardAnswerError.expired else CardAnswerError.answeredElsewhere)
        val outcome = try {
            c.answerCard(view, option.id, emptyList())
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            if (!uncertain(e)) throw e
            // The answer may have reached the computer: read the card back before anything is tried again.
            val back = try { c.fetchCard(card.id) } catch (x: CancellationException) { throw x } catch (x: Exception) { throw e }
            // The core checks the card it reads back; the option that won is read from the same door (`card.get`).
            val won = try { calls.cardResolvedOption(card.id) } catch (x: CancellationException) { throw x } catch (x: Exception) { null }
            when (ReadBack.answer(back.pending(), back.outcome(), option, won)) {
                ReadBack.Answer.accepted -> { resolvedHere(card.id, card.hash); return@io }
                ReadBack.Answer.stillPending -> throw e
                ReadBack.Answer.expired -> throw CardAnswerException(CardAnswerError.expired)
                ReadBack.Answer.answeredElsewhere -> throw CardAnswerException(CardAnswerError.answeredElsewhere)
            }
        }
        if (outcome.accepted) { resolvedHere(card.id, card.hash); return@io }
        val why = outcome.computersReason?.lowercase() ?: ""
        throw when {
            "time ran out" in why || "expired" in why -> CardAnswerException(CardAnswerError.expired)
            "already answered" in why || "no such card" in why -> CardAnswerException(CardAnswerError.answeredElsewhere)
            else -> IllegalStateException("the answer wasn't taken")
        }
    }

    /** Stands for "no stored record": never a model anyone asks for. */
    private val NO_RECORD = "\u0000no record"

    /** The card this phone answered goes; one re-issued under the same id meanwhile (another hash) stays, unanswered. */
    private fun resolvedHere(id: String, hash: String) {
        val gone = synchronized(this) { if (issued[id]?.hash() == hash) { issued.remove(id); true } else false }
        if (gone) events.tryEmit(EngineEvent.CardResolved(id))
    }

    /** A failure that doesn't say whether the computer got the call: a timeout, or the link dropping while it was in flight. */
    private fun uncertain(e: Throwable): Boolean = e is CoreException.Timeout || e is CoreException.Offline

    /**
     * Which cards this app shows (the engine's routing rule, `push-routing.ts`): a card belongs to MOSS when a bot's
     * conversation raised it, to MOSS Code when a coding or agent session did (the core says whose it is). Each app shows its
     * own, and the other app's too when no phone of that app is paired with the computer (so a card is never shown nowhere).
     */
    override suspend fun shows(card: Card, app: PhoneApp): Boolean = io {
        val kind = card.session?.let { synchronized(this) { sessionKinds[it] } }
        val owner = when {
            kind == "bot" || kind == "side-thread" -> PhoneApp.moss
            kind == "coding" || kind == "agent" -> PhoneApp.code
            card.bot != null -> PhoneApp.moss
            else -> null
        } ?: return@io true
        if (owner == app) return@io true
        val phones = synchronized(this) { devices } ?: runCatching { calls.devices() }.getOrNull()?.also { synchronized(this) { devices = it } } ?: return@io true
        val me = runCatching { phoneCore().identity().deviceId }.getOrNull()
        phones.none { it.phone && it.id != me && (it.app == owner || it.app == null) }
    }

    // Starting a session

    override suspend fun backends(): List<AgentBackend> = io { c().backends().mapNotNull { Typed.backend(it, treeName) } }
    override suspend fun startOptions(backend: String): BackendOptions = io { Typed.options(c().startOptions(backend, treeName)) }
    override suspend fun recentStart(): RecentStart = io { Typed.recent(c().recentStart()) }
    override suspend fun startSession(request: StartRequest): String = io { try {
        val c = c()
        val before = c.sessions().map { it.id }.toSet()
        val calledAt = System.currentTimeMillis()
        // A start may have happened though its answer never came: read the sessions back before anyone starts again.
        ReadBack.afterUncertain(
            { c.startSession(CoreStart(request.backend, request.computer, request.root, request.model, request.effort, null)) },
            ::uncertain,
        ) { ReadBack.startedSession(before, c.sessions().map(Typed::session), request, calledAt) }
            .also { synchronized(this) { sessionKinds[it] = "coding" } }
    } catch (e: CoreException.Rpc) {
        val w = e.computersWords.lowercase()
        throw when {
            "install" in w -> StartException(StartError.notInstalled)
            "folder" in w || "fence" in w || "home" in w || "root" in w -> StartException(StartError.folderRefused)
            else -> e
        }
    } }

    // The composer

    override suspend fun composerOffers(session: String, kind: ConversationKind): ComposerOffers = io { try {
        Typed.offers(c().composerOffers(session))
    } catch (e: CoreException.Rpc) {
        // -32601: not served; -32010: not on the remote role's list. An engine without the composer's door offers only the
        // plugins' commands and a coding session's models: no Photos or Files row (its picture and file doors came with it).
        if (e.code != -32601L && e.code != -32010L) throw e
        val commands = runCatching { c().commands().map { PluginCommand(it.name, it.description) } }.getOrDefault(emptyList())
        if (kind == ConversationKind.bot) ComposerOffers(commands = commands)
        else {
            val choices = runCatching { Typed.choices(c().models(session)) }.getOrDefault(emptyList())
            val current = synchronized(this) { sessionModels[session] }
            ComposerOffers(commands = commands, models = choices, model = current,
                efforts = choices.firstOrNull { it.id == current }?.efforts ?: emptyList())
        }
    } }

    override suspend fun setModel(session: String, model: String?, effort: String?): Unit = io {
        val m = model ?: synchronized(this) { sessionModels[session] } ?: throw IllegalStateException("no model to keep")
        c().setModel(session, m, effort)
        synchronized(this) { sessionModels[session] = m }
    }

    /** What this conversation offers now, as the engine says (`session.composerOffers`); nothing when it can't be read. */
    private suspend fun offersOf(session: String): ComposerOffers? =
        try { Typed.offers(c().composerOffers(session)) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }

    override suspend fun stageImage(session: String, data: ByteArray): String = io {
        if (offersOf(session)?.pictures != true) throw EngineRefusal("This conversation doesn't take pictures from the phone.")
        try { c().stageImage(session, mediaType(data), data) } catch (e: CoreException) {
            Log.w(tag, "a picture wasn't staged: ${e.javaClass.simpleName}") // never the core's words: they may name a file
            throw e
        }
    }

    override suspend fun stageFile(session: String, name: String, data: ByteArray): StagedFile = io {
        val offers = offersOf(session)
        if (offers?.files != true) throw EngineRefusal("This conversation doesn't take files from the phone.")
        val limit = offers.fileLimit ?: STAGE_FILE_MAX_BYTES
        if (data.size > limit) throw FileTooLarge(limit)
        val f = try { c().stageFile(session, name, data) } catch (e: CoreException) {
            // The core's words, cleaned (never a key or a path of the phone's): what the screens say only as "couldn't be added".
            Log.w(tag, "a file wasn't staged: ${e.javaClass.simpleName}")
            throw e
        }
        StagedFile(f.path, visibleText(f.computersName, true), data.size.toLong())
    }

    override suspend fun newBotOptions(): NewBotOptions = io { Typed.newBot(c().models(null)) }

    override suspend fun createBot(name: String, model: String?): Bot = io {
        // A refusal (the day's limit, a name or model the engine won't take) in the engine's own words, cleaned by the core.
        val c = c()
        try {
            val before = c.bots().map { it.id }.toSet()
            // A bot may have been made though the answer never came: read the bots back before anyone makes it again.
            ReadBack.afterUncertain({ Typed.bot(c.createBot(name, model)) }, ::uncertain) { run {
                val stored = calls.botStoredModels()
                ReadBack.madeBot(before, c.bots().map(Typed::bot), name, model, { visibleText(it, false) }) { b -> if (b.id in stored) stored[b.id] else NO_RECORD }
            } }
                .also(::remember)
        } catch (e: CoreException.Rpc) {
            if (e.code == -32601L || e.code == -32010L) throw EngineRefusal("Making a bot from the phone isn't available on this computer yet.")
            throw EngineRefusal(e.computersWords)
        }
    }

    override suspend fun runCommand(session: String, command: String): Unit = io { c().runCommand(command) }

    /** The newest open question (`session.openQuestions`, through the core's `open_questions`, in the order asked). */
    override suspend fun pendingQuestion(session: String): AskQuestion? = io { c().openQuestions(session).lastOrNull()?.let(Typed::question) }

    override suspend fun answerQuestion(session: String, question: AskQuestion, answers: Map<String, String>): Unit = io {
        // The engine keys an answer by the question's text (the screens key it by its header when it has one).
        c().answerQuestion(session, question.callId, mapOf(question.text to (answers.values.firstOrNull() ?: "")))
    }

    override suspend fun skipQuestion(session: String, question: AskQuestion): Unit = io { c().skipQuestion(session, question.callId) }

    // The link

    override suspend fun connectionState(): ConnectionState = io { state }

    /**
     * Forgets the computer on this phone: the link closes, and every item of the store goes, the phone's own device and
     * answer keys and the Keystore key included, so pairing again makes a new device. (The computer keeps its record of
     * this phone until the person revokes it there: a phone revoking itself would put a card on the computer.)
     */
    override suspend fun unpair(): Unit = io {
        // An open pairing first: the core won't forget the last computer while one is open.
        val open = synchronized(this) { pairings.values.toList().also { pairings.clear() } }
        for (p in open) runCatching { p.reject() }
        lock.withLock {
            conn?.disconnect(); conn = null; reader?.cancel(); reader = null
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

/** An RPC error as the engine answered it, for the calls the core doesn't type yet. */
class EngineRpcError(val code: Long, val words: String) : Exception("rpc error $code")
