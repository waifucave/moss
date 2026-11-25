package com.waifucave.moss.phone.vm

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.waifucave.moss.phone.client.EngineClient
import com.waifucave.moss.phone.model.*
import kotlinx.coroutines.CancellationException

/** Why a card on the screen can no longer be answered. */
enum class CardNote(val text: String) {
    expired("This card expired before it was answered."),
    answeredElsewhere("Already answered on another device."),
    failed("That didn't work. The card is still waiting."),
}

/** How long a card that came, changed or moved waits before it takes a press. */
const val ARM_MS = 600L

/** The cards waiting for the person. Which of them this app shows is the client's answer (`shows(card, app)`). */
class CardsModel(
    private val client: EngineClient, private val app: PhoneApp, private val now: () -> Long = { System.currentTimeMillis() },
    /** A monotonic clock for the wait below (milliseconds); tests pass their own. */
    private val tick: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    /** The cards in arrival order. Every change goes through [show], which arms the cards that moved. */
    var cards by mutableStateOf<List<Card>>(emptyList())
        private set

    /**
     * When each card starts taking a press ([tick] time). A card that is new on the screen, whose content changed, or that
     * moved because a card above it came or went waits [ARM_MS] first: a tap meant for what was under the finger never
     * answers it. A press inside the wait is refused here ([answer]), whatever the screen drew.
     */
    var armedAt by mutableStateOf<Map<String, Long>>(emptyMap())
        private set

    /** Milliseconds until `card` takes a press (0: it does now). */
    fun waitLeft(card: Card): Long = maxOf(0L, (armedAt[card.id] ?: 0L) - tick())

    private fun show(next: List<Card>, rearm: Set<String> = emptySet()) {
        val before = cards.mapIndexed { i, c -> c.id to i }.toMap()
        val at = tick() + ARM_MS
        val moved = next.withIndex().filter { (i, c) -> before[c.id] != i || c.id in rearm }.map { it.value.id }
        armedAt = armedAt.filterKeys { id -> next.any { it.id == id } } + moved.associateWith { at }
        cards = next
    }
    var answering by mutableStateOf<Set<String>>(emptySet())
        private set
    var notes by mutableStateOf<Map<String, CardNote>>(emptyMap())
        private set
    var loadFailed by mutableStateOf(false)
        private set
    var loaded by mutableStateOf(false)
        private set
    private val answeredHere = mutableSetOf<String>()
    private val listener = Listener()

    /** Cards whose content changed while shown (the same id, a new hash): the screen says so. */
    var changed by mutableStateOf(setOf<String>())
        private set

    /** Cards still waiting for an answer (not expired, not answered elsewhere). */
    val waitingCount: Int get() = cards.count { note(it) == null }

    /** The state a card is in: a note when it can't be answered. */
    fun note(card: Card): CardNote? {
        notes[card.id]?.let { return it }
        if (card.expiresAt <= now()) return CardNote.expired
        return null
    }

    suspend fun load() {
        try {
            val all = client.cards()
            val next = all.filter { client.shows(it, app) }
            show(next, rearm = next.filter { n -> cards.any { it.id == n.id && it.hash != n.hash } }.map { it.id }.toSet())
            loadFailed = false
        } catch (e: CancellationException) { throw e } catch (e: Exception) { loadFailed = true }
        loaded = true
    }

    suspend fun run() = listener.run(client, ::load) { apply(it) }

    suspend fun apply(event: EngineEvent) {
        when (event) {
            is EngineEvent.CardRequested -> if (client.shows(event.card, app)) {
                val old = cards.firstOrNull { it.id == event.card.id }
                when {
                    // New: at the end, so nothing the person is looking at moves.
                    old == null -> show(cards + event.card)
                    // The same card with other content: replaced where it stands, said so, and its buttons wait a moment
                    // (the card's view holds them back while it is new to the screen); an answer to the old one is refused.
                    old.hash != event.card.hash -> {
                        show(cards.map { if (it.id == event.card.id) event.card else it }, rearm = setOf(event.card.id))
                        notes = notes - event.card.id
                        changed = changed + event.card.id
                    }
                }
            }
            is EngineEvent.CardResolved -> {
                if (event.id in answeredHere) show(cards.filter { it.id != event.id })
                else if (cards.any { it.id == event.id }) notes = notes + (event.id to CardNote.answeredElsewhere)
            }
            else -> {}
        }
    }

    suspend fun answer(card: Card, option: CardOption) {
        if (card.id in answering || note(card) != null) return
        // Inside the wait: refused, whatever the screen drew (a second tap after the card above it went).
        if (waitLeft(card) > 0) return
        answering = answering + card.id
        try {
            answeredHere.add(card.id)
            client.answer(card, option)
            show(cards.filter { it.id != card.id })
            notes = notes - card.id
        } catch (e: CardAnswerException) {
            answeredHere.remove(card.id)
            notes = notes + (card.id to if (e.error == CardAnswerError.expired) CardNote.expired else CardNote.answeredElsewhere)
        } catch (e: CancellationException) {
            answeredHere.remove(card.id); throw e
        } catch (e: Exception) {
            answeredHere.remove(card.id)
            notes = notes + (card.id to CardNote.failed)
        } finally {
            answering = answering - card.id
        }
    }

    /** Takes a settled card off the screen. */
    fun dismiss(card: Card) {
        show(cards.filter { it.id != card.id })
        notes = notes - card.id
    }
    /** Lets a failed answer be tried again. */
    fun clearFailure(card: Card) { if (notes[card.id] == CardNote.failed) notes = notes - card.id }
}
