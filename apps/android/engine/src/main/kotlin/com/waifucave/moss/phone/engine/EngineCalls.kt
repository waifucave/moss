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
 * THE ONE FILE that reads engine JSON on Android. The engine's payloads are decoded once, in the Rust core, as typed calls
 * (the controller's ruling of 2026-11-24; `Typed` maps those records). What is left here is what the core doesn't type yet,
 * each a small function to swap for the core's typed call:
 *   - [Decode.card]: a card's JSON as the screens draw it (the core hands `CardView.card_json`, checked, and says to draw it);
 *   - [EngineCalls.sessionAttach] / [EngineCalls.sessionDetach]: following a session live (`session.attach`, `session.detach`);
 *   - [EngineCalls.devices]: `device.list`, for other devices' names and which phone app each paired phone is;
 *   - [EngineCalls.selfComputerName]: `computer.list`'s `self` entry, the linked computer's folder-tree name.
 * Every string from the computer that is drawn goes through `clean` (the core's `visible_text`).
 */
object Decode {
    val json = Json { ignoreUnknownKeys = true }

    fun parse(text: String): JsonElement? = try { json.parseToJsonElement(text) } catch (e: Exception) { null }

    /** A `Text`: a plain string, or a map by language with `en` required. The phone shows English, or the first it has. */
    fun text(e: JsonElement?): String? {
        e.str()?.let { return it }
        val o = e.obj() ?: return null
        return o["en"].str() ?: o.values.firstNotNullOfOrNull { it.str() }
    }

    private fun sealed(e: JsonElement?, clean: (String) -> String): SealedValue? {
        val o = e.obj() ?: return null
        return when (o["type"].str()) {
            "text" -> o["text"].str()?.let { SealedValue.Text(clean(it)) }
            "code" -> o["code"].str()?.let { SealedValue.Code(clean(it), o["language"].str()?.let(clean)) }
            "list" -> SealedValue.ListOf(o["items"].arr().mapNotNull { it.str()?.let(clean) })
            "rows" -> SealedValue.Rows(o["rows"].arr().mapNotNull { r -> r["label"].str()?.let { l -> r["value"].str()?.let { SealedValue.Row(clean(l), clean(it)) } } })
            else -> SealedValue.Unsupported
        }
    }

    /**
     * A `Card` as the screens draw it, read from a card's JSON exactly as the core checked it (`CardView.card_json`), every
     * string through `clean`. A field of a kind this phone can't draw is kept as `Unsupported`, and a field the protocol
     * doesn't name is kept as it is: the screen then shows the card with no buttons ("answer this one on your computer",
     * `Card.drawable`), and the client refuses to answer it. An option this phone can't read drops the card (`null`).
     * `expiresAt: null` (a card the user's own turn raised never expires) reads as never.
     */
    fun card(cardJson: String, hash: String, clean: (String) -> String = { it }): Card? {
        val o = parse(cardJson).obj() ?: return null
        val id = o["id"].str() ?: return null
        val kind = o["kind"].str() ?: return null
        val fields = linkedMapOf<String, SealedValue>()
        for ((name, v) in o["fields"].obj() ?: JsonObject(emptyMap())) fields[name] = sealed(v, clean) ?: SealedValue.Unsupported
        val options = o["options"].arr().map { op ->
            val oid = op["id"].str() ?: return null
            val k = when (op["kind"].str()) { "approve" -> CardOption.Kind.approve; "deny" -> CardOption.Kind.deny; else -> return null }
            CardOption(oid, k, clean(text(op["label"]) ?: return null), op["remember"].str() == "always")
        }
        if (options.isEmpty()) return null
        // A plugin OK's checkboxes: each with its id, its label (a string, or one per language) and the engine's tick. One
        // that can't be read drops the card (an unreadable card, answered on the computer): never fewer boxes than it has.
        val children = o["children"].arr().map { ch ->
            val cid = ch["id"].str() ?: return null
            val label = text(ch["label"]) ?: return null
            val checked = (ch["checked"] as? JsonPrimitive)?.booleanOrNull ?: return null
            CardChild(cid, clean(label), checked)
        }
        return Card(
            id = id, kind = kind, computer = o["computer"].str()?.let(clean), session = o["session"].str(), bot = o["bot"].str(), origin = o["origin"].str(),
            issuedAt = o["issuedAt"].long() ?: 0, expiresAt = o["expiresAt"].long() ?: Long.MAX_VALUE, hash = hash, fields = fields, options = options,
            children = children,
        )
    }

    /**
     * A card the core issued that this phone can't read at all (`card` gave null): shown, never hidden, as one to answer on
     * the computer: no option, one field of a kind this build can't draw, so it has no buttons and the client refuses it.
     * It replaces an earlier card of the same id, so stale text never keeps live buttons.
     */
    fun unreadable(id: String, hash: String, bot: String?, session: String?): Card = Card(
        id = id, kind = "unreadable", session = session, bot = bot, issuedAt = 0, expiresAt = Long.MAX_VALUE, hash = hash,
        fields = mapOf("title" to SealedValue.Text("A request this phone can't show"), "detail" to SealedValue.Unsupported), options = emptyList(),
    )

    data class Device(val id: String, val name: String, val phone: Boolean, val app: PhoneApp?)

    fun devices(e: JsonElement?, clean: (String) -> String = { it }): List<Device> = e["devices"].arr().mapNotNull { d ->
        val id = d["id"].str() ?: return@mapNotNull null
        val phone = d["kind"].str() == "phone"
        val app = if (!phone) null else when (d["app"].str()) { "moss" -> PhoneApp.moss; "code" -> PhoneApp.code; else -> null }
        Device(id, clean(d["name"].str() ?: id), phone, app)
    }
}

// Small readers that never throw.
internal fun JsonElement?.obj(): JsonObject? = this as? JsonObject
internal fun JsonElement?.arr(): List<JsonElement> = (this as? JsonArray) ?: emptyList()
internal fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonElement?.long(): Long? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.longOrNull ?: it.contentOrNull?.toDoubleOrNull()?.toLong() }
internal fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
internal operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)?.takeIf { it !is JsonNull }

/** The calls the core doesn't type yet, raw over `call(method, paramsJson)`. */
class EngineCalls(private val call: suspend (method: String, params: JsonObject) -> JsonElement?, private val clean: (String) -> String) {
    private fun p(vararg pairs: Pair<String, Any?>) = JsonObject(pairs.mapNotNull { (k, v) ->
        when (v) { null -> null; is String -> k to JsonPrimitive(v); is Number -> k to JsonPrimitive(v); else -> error("unsupported parameter") }
    }.toMap())

    /** Follows a session live (its events come as the core's `SessionEvent`s); with `since`, the ones after it come first. */
    suspend fun sessionAttach(id: String, since: Long?) { call("session.attach", p("id" to id, "since" to since)) }
    suspend fun sessionDetach(id: String) { call("session.detach", p("id" to id)) }
    suspend fun devices(): List<Decode.Device> = Decode.devices(call("device.list", p()), clean)
    /** Each bot's stored model (`bot.records`: as it was asked for; absent when none was), by id. */
    suspend fun botStoredModels(): Map<String, String?> =
        call("bot.records", p())["bots"].arr().mapNotNull { b -> b["id"].str()?.let { id -> id to b["model"].str() } }.toMap()

    /** The option that resolved a card (`card.get`'s `option`), when the engine names one: an id, never drawn. */
    suspend fun cardResolvedOption(id: String): String? =
        call("card.get", p("id" to id))["option"].str()?.takeIf { it.length <= 64 && it.all { c -> c.isLetterOrDigit() || c == '_' || c == '-' || c == '.' } }

    suspend fun selfComputerName(): String? =
        call("computer.list", p())["computers"].arr().firstOrNull { it["link"].str() == "self" }?.get("name").str()?.let(clean)
}
