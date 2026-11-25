package com.waifucave.moss.phone.engine

import com.waifucave.moss.phone.model.Bot
import com.waifucave.moss.phone.model.CardOption
import com.waifucave.moss.phone.model.SessionRow
import com.waifucave.moss.phone.model.StartRequest
import kotlinx.coroutines.CancellationException

/**
 * A call that changes state and then fails without saying whether the computer got it (a timeout after its frame began
 * writing, the link dropping mid-call) may have happened. Before anyone tries again, the client reads back what the
 * computer holds: a session started, a bot made, a card answered. Found: the call counts as done, and nothing is sent a
 * second time. Not found: the first failure stands, and a retry is the person's. A send needs none of this: the same
 * client message id makes a resend the same message.
 *
 * Pure (no native core), so the JVM tests cover it.
 */
internal object ReadBack {
    /** How far before the call a session's or bot's start may be stamped (the two clocks differ a little). */
    const val SKEW_MS = 60_000L

    /** Runs `call`; on an `uncertain` failure, `readBack` decides: its answer stands for the call's, or the failure does. */
    suspend fun <T : Any> afterUncertain(call: suspend () -> T, uncertain: (Throwable) -> Boolean, readBack: suspend () -> T?): T {
        try {
            return call()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            if (!uncertain(e)) throw e
            val found = try { readBack() } catch (c: CancellationException) { throw c } catch (x: Exception) { null }
            return found ?: throw e
        }
    }

    /**
     * The session a start made, read back: a coding session that wasn't there before the call, on the backend and folder
     * asked for, started no earlier than the call (less the skew). Two matching is not knowing: none is taken.
     */
    fun startedSession(before: Set<String>, now: List<SessionRow>, request: StartRequest, calledAt: Long): String? =
        now.filter {
            it.id !in before && it.kind == "coding" && it.backend == request.backend && it.root == request.root && it.startedAt >= calledAt - SKEW_MS
        }.singleOrNull()?.id

    /** The bot a create made, read back: one that wasn't there before the call, with the name asked for. */
    fun madeBot(before: Set<String>, now: List<Bot>, name: String): Bot? =
        now.filter { it.id !in before && it.name == name.trim() }.singleOrNull()

    /**
     * The message text as the engine takes it with attachments: each picture and file is named in the text by its number
     * (`[Image #n]`, `[File #n]`, numbered from 1 in the order sent), or the engine refuses the send. The screens don't write
     * them, so a token the text lacks is added at its end, before the core signs the text. The same text and id each time,
     * so a resend is still the same message.
     */
    fun withTokens(text: String, images: Int, files: Int): String {
        val missing = (1..images).map { "[Image #$it]" }.filter { it !in text } + (1..files).map { "[File #$it]" }.filter { it !in text }
        return if (missing.isEmpty()) text else text + " " + missing.joinToString(" ")
    }

    /** A pairing QR's shape (`<name>:<version>:<base64url>`): anything else is refused before the core is made. */
    fun looksLikePairingCode(code: String): Boolean = Regex("^[a-z][a-z-]{0,31}:[0-9]{1,3}:[A-Za-z0-9_-]{16,8192}={0,2}$").matches(code)

    enum class Answer { accepted, stillPending, expired, answeredElsewhere }

    /**
     * A card's state read back after an uncertain answer. Still pending: nothing was taken (the person may answer again;
     * the first answer wins). Resolved the way this option answers it: taken, ours or another device's same answer, whose
     * effect is the same. Expired, or resolved another way: as the screens say it.
     */
    fun answer(pending: Boolean, outcome: String?, option: CardOption): Answer = when {
        pending -> Answer.stillPending
        outcome == "approved" && option.kind == CardOption.Kind.approve -> Answer.accepted
        outcome == "denied" && option.kind == CardOption.Kind.deny -> Answer.accepted
        outcome == "expired" -> Answer.expired
        else -> Answer.answeredElsewhere
    }
}
