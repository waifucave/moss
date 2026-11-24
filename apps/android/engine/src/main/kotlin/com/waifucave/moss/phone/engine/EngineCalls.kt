package com.waifucave.moss.phone.engine

import com.waifucave.moss.phone.model.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * THE ONE FILE that reads the engine's JSON. The controller's ruling (2026-11-24): the engine's payloads are to be decoded
 * once, in the Rust core, as typed calls with records, for both phones. Until the core has them, [EngineCalls] makes each
 * call raw through the core's `Connection.call` and [Decode] reads its answer; each method of [EngineCalls] is meant to be
 * replaced by the core's typed call in a few lines, and nothing outside this file reads engine JSON. Cards are never read
 * from a raw call: they come only as the core's checked `CardView`s (`Decode.card` reads the JSON of one to draw it).
 *
 * The engine's payloads read into the screens' models (shapes in `packages/protocol/src`: `bots.ts`, `sessions.ts`,
 * `approvals.ts`, `agents.ts`, `events.ts`). Defensive by rule: an unknown field is ignored, an unknown kind or enum value
 * is skipped or read as its nearest plain meaning, and a malformed item is dropped (`null`), never a crash. Nothing here
 * touches the native core, so it runs in the JVM tests.
 */
object Decode {
    val json = Json { ignoreUnknownKeys = true; isLenient = false }

    fun parse(text: String): JsonElement? = try { json.parseToJsonElement(text) } catch (e: Exception) { null }

    /** A `Text`: a plain string, or a map by language with `en` required. The phone shows English, or the first it has. */
    fun text(e: JsonElement?): String? {
        e.str()?.let { return it }
        val o = e.obj() ?: return null
        return o["en"].str() ?: o.values.firstNotNullOfOrNull { it.str() }
    }

    private inline fun <reified T : Enum<T>> enumOf(s: String?): T? = s?.let { v -> enumValues<T>().firstOrNull { it.name == v } }

    // Bots

    fun face(e: JsonElement?): BotFaceSpec? {
        val o = e.obj() ?: return null
        return BotFaceSpec(o["shape"].str(), o["color"].str(), o["eyes"].str(), o["temper"].str())
    }

    /** `BotView` (`bot.list`, `bot_changed`), with the face pins of its record when known. */
    fun bot(e: JsonElement?, faces: Map<String, BotFaceSpec> = emptyMap()): Bot? {
        val o = e.obj() ?: return null
        val id = o["id"].str() ?: return null
        val main = o["mainSession"].str() ?: return null
        return Bot(
            id = id, name = text(o["name"]) ?: id, model = o["model"].str(), effort = o["effort"].str(),
            face = face(o["face"]) ?: faces[id], state = enumOf<BotState>(o["state"].str()), computer = o["computer"].str(), mainSession = main,
        )
    }

    /** `BotRecordView` (`bot.records`, `bot.create`): a bot as engine data, idle until its state says otherwise. */
    fun botRecord(e: JsonElement?): Bot? {
        val o = e.obj() ?: return null
        val id = o["id"].str() ?: return null
        val main = o["mainSession"].str() ?: return null
        return Bot(id = id, name = text(o["name"]) ?: id, model = o["model"].str(), effort = o["effort"].str(), face = face(o["face"]), state = BotState.idle, mainSession = main)
    }

    fun summary(e: JsonElement?): BotSummary? {
        val o = e.obj() ?: return null
        val id = o["id"].str() ?: return null
        val last = o["last"].obj()?.let { l ->
            val t = l["text"].str() ?: return@let null
            val at = l["at"].long() ?: return@let null
            BotSummary.Last(t, enumOf<BotSummary.From>(l["from"].str()) ?: BotSummary.From.note, at)
        }
        return BotSummary(id, last, o["unread"].bool() ?: false)
    }

    // Sessions

    fun session(e: JsonElement?): SessionRow? {
        val o = e.obj() ?: return null
        val id = o["id"].str() ?: return null
        val status = enumOf<SessionStatus>(o["status"].str()) ?: SessionStatus.idle
        val needs = o["needsYou"].obj()?.let { NeedsYou((it["cards"].long() ?: 0).toInt(), (it["questions"].long() ?: 0).toInt()) }
        val waiting = o["waiting"].obj()?.let { SessionWaiting((it["tasks"].long() ?: 0).toInt(), (it["children"].long() ?: 0).toInt()) }
        return SessionRow(
            id = id, kind = o["kind"].str() ?: "coding", bot = o["bot"].str(), parent = o["parent"].str(), computer = o["computer"].str() ?: "",
            title = o["title"].str(), status = status, startedAt = o["startedAt"].long() ?: 0, updatedAt = o["updatedAt"].long() ?: 0,
            backend = o["backend"].str(), model = o["model"].str(), root = o["root"].str(), branch = o["branch"].str(),
            changes = o["changes"].long()?.toInt(), needsYou = needs, waiting = waiting, archived = o["archived"].bool(),
        )
    }

    /**
     * One event of a session's log as a message the conversation shows, or `null` for what a conversation doesn't show
     * (tool calls, status records, streaming deltas, anything unknown). `kind` is the session's kind: a bot's replies are the
     * bot's, a coding session's the agent's. `deviceName` names another device a user message came from (`null` for this phone).
     */
    fun message(e: JsonElement?, kind: ConversationKind, deviceName: (String) -> String? = { null }): ChatMessage? {
        val o = e.obj() ?: return null
        val type = o["type"].str() ?: return null
        val session = o["sessionId"].str() ?: return null
        val seq = o["seq"].long() ?: return null
        val at = o["ts"].long() ?: 0
        val id = messageId(session, seq)
        fun note(t: String?) = t?.takeIf { it.isNotBlank() }?.let { ChatMessage(id, MessageRole.note, it, at) }
        return when (type) {
            "user_message" -> o["text"].str()?.let { ChatMessage(id, MessageRole.user, it, at, device = o["device"].str()?.let(deviceName)) }
            "assistant_message" -> o["text"].str()?.takeIf { it.isNotEmpty() }?.let {
                ChatMessage(id, if (kind == ConversationKind.bot) MessageRole.bot else MessageRole.agent, it, at)
            }
            "bot_message", "session_message", "plugin_message" -> note(o["text"].str())
            "agent_message", "agent_finished" -> o["text"].str()?.let { ChatMessage(id, MessageRole.agent, it, at) }
            "routine_result" -> note(listOfNotNull(o["name"].str(), o["text"].str()).joinToString(": "))
            "note" -> note(listOfNotNull(o["label"].str()?.takeIf { it.isNotBlank() }, o["text"].str()).joinToString(": "))
            "agent_error" -> note(o["message"].str()?.let { "Something went wrong: $it" })
            "turn_completed" -> if (o["stopReason"].str() == "aborted") note("Interrupted") else null
            else -> null
        }
    }

    /** A message's id: its place in its session's log, the same whether it came in a page or live. */
    fun messageId(session: String, seq: Long) = "$session#$seq"

    /** The question still open in a page of events (`question_asked` with no `question_resolved` after it). */
    fun openQuestion(events: List<JsonElement>): AskQuestion? {
        val resolved = events.mapNotNull { e -> e.takeIf { it["type"].str() == "question_resolved" }?.get("callId").str() }.toSet()
        val asked = events.lastOrNull { it["type"].str() == "question_asked" && it["callId"].str() !in resolved } ?: return null
        val callId = asked["callId"].str() ?: return null
        val q = asked["questions"].arr().firstOrNull() ?: return null
        val text = q["question"].str() ?: return null
        val options = q["options"].arr().mapNotNull { o -> o["label"].str()?.let { AskQuestion.Option(it, o["description"].str()) } }
        return AskQuestion(callId, q["header"].str(), text, options, q["multiSelect"].bool() ?: false)
    }

    // Cards

    fun sealed(e: JsonElement?): SealedValue? {
        val o = e.obj() ?: return null
        return when (o["type"].str()) {
            "text" -> o["text"].str()?.let { SealedValue.Text(it) }
            "code" -> o["code"].str()?.let { SealedValue.Code(it, o["language"].str()) }
            "list" -> SealedValue.ListOf(o["items"].arr().mapNotNull { it.str() })
            "rows" -> SealedValue.Rows(o["rows"].arr().mapNotNull { r -> r["label"].str()?.let { l -> r["value"].str()?.let { SealedValue.Row(l, it) } } })
            else -> null
        }
    }

    /**
     * A `Card` as the screens draw it, read from the card's JSON exactly as the core checked it (`CardView.card_json`). A
     * card with a field or an option this phone can't draw is refused whole (`null`): a card is shown entire or not at all,
     * so the person never approves less than what they were asked. `expiresAt: null` (a card the user's own turn raised
     * never expires) reads as never.
     */
    fun card(cardJson: String, hash: String): Card? {
        val o = parse(cardJson).obj() ?: return null
        val id = o["id"].str() ?: return null
        val kind = o["kind"].str() ?: return null
        val fields = linkedMapOf<String, SealedValue>()
        for ((name, v) in o["fields"].obj() ?: JsonObject(emptyMap())) fields[name] = sealed(v) ?: return null
        val options = o["options"].arr().map { op ->
            val oid = op["id"].str() ?: return null
            val k = enumOf<CardOption.Kind>(op["kind"].str()) ?: return null
            CardOption(oid, k, text(op["label"]) ?: return null, op["remember"].str() == "always")
        }
        if (options.isEmpty()) return null
        return Card(
            id = id, kind = kind, computer = o["computer"].str(), session = o["session"].str(), bot = o["bot"].str(), origin = o["origin"].str(),
            issuedAt = o["issuedAt"].long() ?: 0, expiresAt = o["expiresAt"].long() ?: Long.MAX_VALUE, hash = hash, fields = fields, options = options,
        )
    }

    // Starting a session, the composer

    fun backend(e: JsonElement?, computer: String?): AgentBackend? {
        val o = e.obj() ?: return null
        val id = o["id"].str() ?: return null
        if (o["userStartable"].bool() == false) return null
        // Offered when it is installed on the computer this phone is linked to (or the engine names no computer).
        val on = o["computers"].arr()
        if (computer != null && on.isNotEmpty() && on.none { it["computer"].str() == computer && it["installed"].bool() == true }) return null
        return AgentBackend(id, text(o["name"]) ?: id)
    }

    fun backendOptions(e: JsonElement?, backend: String): BackendOptions {
        val o = e.obj()
        val models = o?.get("models").arr().mapNotNull { m ->
            val id = m["id"].str() ?: return@mapNotNull null
            ModelOption(id, text(m["name"]) ?: id, m["efforts"].arr().mapNotNull { it.str() }, m["defaultEffort"].str())
        }
        return BackendOptions(
            backend = o?.get("backend").str() ?: backend, known = o?.get("known").bool() ?: false, models = models,
            defaultModel = o?.get("default")?.get("model").str(), defaultEffort = o?.get("default")?.get("effort").str(),
        )
    }

    fun recent(e: JsonElement?): RecentStart {
        val o = e.obj() ?: return RecentStart()
        val last = o["backend"].str()?.let { RecentStart.Choice(it, o["model"].str(), o["effort"].str()) }
        val by = o["byBackend"].arr().mapNotNull { b -> b["backend"].str()?.let { RecentStart.Choice(it, b["model"].str(), b["effort"].str()) } }
        val roots = o["roots"].arr().mapNotNull { r -> r["root"].str()?.let { it to (r["at"].long() ?: 0) } }.sortedByDescending { it.second }.map { it.first }
        return RecentStart(last, by, roots)
    }

    fun commands(e: JsonElement?): List<PluginCommand> =
        e["commands"].arr().mapNotNull { c -> c["name"].str()?.let { PluginCommand(it, text(c["description"]) ?: it) } }

    /** `models.list` as the new-bot sheet's choices: the signed-in models, the user's default first among them. */
    fun newBotOptions(e: JsonElement?): NewBotOptions {
        val models = e["models"].arr().filter { it["signedIn"].bool() != false }.mapNotNull { m ->
            m["id"].str()?.let { ModelChoice(it, text(m["name"]) ?: it, m["efforts"].arr().mapNotNull { x -> x.str() }) }
        }
        val def = e["default"].str()?.takeIf { d -> models.any { it.id == d } }
        return NewBotOptions(models, def)
    }

    /** `session.composerOffers` (lane PH's door). */
    fun composerOffers(e: JsonElement?): ComposerOffers? {
        val o = e.obj() ?: return null
        val files = o["files"].obj()
        return ComposerOffers(
            pictures = o["pictures"].bool() ?: false,
            commands = o["commands"].arr().mapNotNull { c -> c["name"].str()?.let { PluginCommand(it, text(c["description"]) ?: it) } },
            efforts = o["efforts"].arr().mapNotNull { it.str() },
            effort = o["effort"].str(),
            models = o["models"].arr().mapNotNull { m -> m["id"].str()?.let { ModelChoice(it, text(m["name"]) ?: it, m["efforts"].arr().mapNotNull { x -> x.str() }) } },
            model = o["model"].str(),
            files = files != null,
            fileLimit = files?.get("maxBytes").long(),
        )
    }

    // Devices: their names (a message from another device says which), and which phone app each paired phone is (which
    // cards this app shows).

    data class Device(val id: String, val name: String, val phone: Boolean, val app: PhoneApp?)

    fun devices(e: JsonElement?): List<Device> = e["devices"].arr().mapNotNull { d ->
        val id = d["id"].str() ?: return@mapNotNull null
        val phone = d["kind"].str() == "phone"
        Device(id, d["name"].str() ?: id, phone, if (phone) enumOf<PhoneApp>(d["app"].str()) else null)
    }
}

// Small readers that never throw.
internal fun JsonElement?.obj(): JsonObject? = this as? JsonObject
internal fun JsonElement?.arr(): List<JsonElement> = (this as? JsonArray) ?: emptyList()
internal fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonElement?.long(): Long? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.longOrNull ?: it.contentOrNull?.toDoubleOrNull()?.toLong() }
internal fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
internal operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)?.takeIf { it !is JsonNull }


/** An RPC error as the engine answered it, from the core's `CoreException.Rpc`. */
class EngineRpcError(val code: Long, val words: String) : Exception("rpc error $code")

/**
 * Each engine call the screens need that the core does not yet make itself, raw over `call(method, paramsJson)`, with its
 * answer read by [Decode]. One method per call, so each can be swapped for the core's typed call.
 */
class EngineCalls(private val call: suspend (method: String, params: JsonObject) -> JsonElement?) {
    private fun params(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.mapNotNull { (k, v) ->
        when (v) {
            null -> null
            is String -> k to JsonPrimitive(v)
            is Number -> k to JsonPrimitive(v)
            is Boolean -> k to JsonPrimitive(v)
            is JsonElement -> k to v
            is List<*> -> k to JsonArray(v.map { JsonPrimitive(it as String) })
            else -> error("unsupported parameter")
        }
    }.toMap())

    suspend fun botList(faces: Map<String, BotFaceSpec>): List<Bot> = call("bot.list", params())["bots"].arr().mapNotNull { Decode.bot(it, faces) }
    suspend fun botFaces(): Map<String, BotFaceSpec> =
        call("bot.records", params())["bots"].arr().mapNotNull { r -> r["id"].str()?.let { id -> Decode.face(r["face"])?.let { id to it } } }.toMap()
    suspend fun botGet(id: String): Bot? = Decode.bot(call("bot.get", params("id" to id))["bot"])
    suspend fun botSummaries(): List<BotSummary> = call("bot.summaries", params())["summaries"].arr().mapNotNull { Decode.summary(it) }
    suspend fun botMarkRead(id: String, at: Long) { call("bot.markRead", params("id" to id, "at" to at)) }

    /** A page of events: the session, its events (raw, for [Decode.message] and [Decode.openQuestion]) and whether more are before it. */
    data class Page(val session: String?, val events: List<JsonElement>, val hasMore: Boolean)
    suspend fun botConversation(id: String, before: Long?, limit: Int): Page {
        val r = call("bot.conversation", params("id" to id, "before" to before, "limit" to limit.coerceIn(1, 500)))
        return Page(r["session"].str(), r["events"].arr(), r["hasMore"].bool() ?: false)
    }
    suspend fun sessionHistory(id: String, before: Long?, limit: Int): Page {
        val r = call("session.history", params("id" to id, "before" to before, "limit" to limit.coerceIn(1, 500)))
        return Page(id, r["events"].arr(), r["hasMore"].bool() ?: false)
    }
    suspend fun sessionList(): List<SessionRow> = call("session.list", params())["sessions"].arr().mapNotNull { Decode.session(it) }
    /** Follows a session live (its events come as `event` notifications); with `since`, the ones after it are replayed first. */
    suspend fun sessionAttach(id: String, since: Long?): Long? = call("session.attach", params("id" to id, "since" to since))["lastSeq"].long()
    suspend fun sessionInterrupt(id: String) { call("session.interrupt", params("id" to id)) }
    suspend fun sessionSetModel(id: String, model: String, effort: String?) { call("session.setModel", params("id" to id, "model" to model, "effort" to effort)) }
    suspend fun sessionAnswer(id: String, callId: String, answers: Map<String, String>) {
        call("session.answer", params("id" to id, "callId" to callId, "answers" to JsonObject(answers.mapValues { JsonPrimitive(it.value) })))
    }

    suspend fun agentBackends(computer: String?): List<AgentBackend> = call("agent.backends", params())["backends"].arr().mapNotNull { Decode.backend(it, computer) }
    suspend fun agentOptions(backend: String): BackendOptions = Decode.backendOptions(call("agent.options", params("backend" to backend)), backend)
    suspend fun agentRecent(): RecentStart = Decode.recent(call("agent.recent", params()))
    suspend fun agentStart(r: StartRequest): String =
        call("agent.start", params("backend" to r.backend, "computer" to r.computer, "root" to r.root, "model" to r.model, "effort" to r.effort))["session"].str()
            ?: throw EngineRpcError(-32603, "agent.start answered no session")

    suspend fun commandList(): List<PluginCommand> = Decode.commands(call("command.list", params()))
    suspend fun commandRun(name: String) { call("command.run", params("name" to name)) }
    suspend fun modelsList(session: String?): JsonElement? = call("models.list", params("session" to session))
    suspend fun newBotOptions(): NewBotOptions = Decode.newBotOptions(modelsList(null))
    /** The computers the engine knows; the one it calls `self` is the computer this phone is linked to, by its folder-tree name. */
    suspend fun selfComputerName(): String? = call("computer.list", params())["computers"].arr().firstOrNull { it["link"].str() == "self" }?.get("name").str()
    suspend fun devices(): List<Decode.Device> = Decode.devices(call("device.list", params()))

    // Lane PH's doors (`lane/ph-3-phone-doors`, not on the integration branch yet): `bot.create` for a phone and
    // `session.composerOffers`. An engine without them answers "method not found" or "not allowed", which reads as
    // [NotAvailableYet]; `session.stageFile` is the core's own `stage_file`.
    suspend fun botCreate(name: String, model: String?): Bot =
        Decode.botRecord(door { call("bot.create", params("name" to name, "model" to model)) }["bot"]) ?: throw EngineRpcError(-32603, "bot.create answered no bot")
    suspend fun composerOffers(session: String): ComposerOffers? = Decode.composerOffers(door { call("session.composerOffers", params("id" to session)) })

    private suspend fun door(f: suspend () -> JsonElement?): JsonElement? = try { f() } catch (e: EngineRpcError) {
        // -32601: not served (no such method, or not served yet); -32010: not on the remote role's list.
        if (e.code == -32601L || e.code == -32010L) throw NotAvailableYet() else throw e
    }
}

/** A call the engine this phone is linked to does not serve yet. */
class NotAvailableYet : Exception("not available yet on this computer")
