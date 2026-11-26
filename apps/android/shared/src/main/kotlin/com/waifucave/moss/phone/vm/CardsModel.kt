package com.waifucave.moss.phone.vm

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.waifucave.moss.phone.client.EngineClient
import com.waifucave.moss.phone.model.*
import com.waifucave.moss.phone.ui.cutFields
import com.waifucave.moss.phone.ui.drawable
import kotlinx.coroutines.CancellationException

/** Why a card on the screen can no longer be answered. */
enum class CardNote(val text: String) {
    expired("This card expired before it was answered."),
    answeredElsewhere("Already answered on another device."),
    failed("That didn't work. The card is still waiting."),
}

/** How long a card that came, changed or moved waits before it takes a press. */
const val ARM_MS = 600L

/** The opened "part" that stands for a card's values area scrolled to its end. */
const val END = "\u0000end"

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

    /** The cut fields the person opened on each card (by id and hash: a re-issued card starts again). */
    var opened by mutableStateOf<Map<String, Set<String>>>(emptyMap())
        private set
    fun open(card: Card, field: String) {
        val key = card.id + "#" + card.hash
        opened = opened + (key to ((opened[key] ?: emptySet()) + field))
    }
    private fun openedOn(card: Card): Set<String> = opened[card.id + "#" + card.hash] ?: emptySet()

    /**
     * Cards (by id and hash) the screen has shown whole: their values fit their area, or were scrolled to its end once.
     * An approval is refused until the screen said so; before any report it is refused, never taken.
     */
    private var seenWhole by mutableStateOf<Set<String>>(emptySet())
    /** The screen says whether a card's values overflow its area and whether they were scrolled to the end once. */
    fun scrolled(card: Card, overflows: Boolean, reachedEnd: Boolean) {
        val key = card.id + "#" + card.hash
        if (!overflows || reachedEnd) seenWhole = seenWhole + key
        if (reachedEnd) open(card, END)
    }

    /** Why the last press on a card was refused, in one line; cleared by the next press. */
    var refusals by mutableStateOf<Map<String, String>>(emptyMap())
        private set

    /** A card that moved on the screen (in a conversation, a message came in above it) waits again. */
    fun rearm(card: Card) { armedAt = armedAt + (card.id to tick() + ARM_MS) }

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

    /** A plugin OK's checkboxes as the person has them now, per card as it is now (id and hash): new content starts again
     *  from the engine's own ticks. */
    var ticks by mutableStateOf<Map<String, Set<String>>>(emptyMap())
        private set
    /** Whether this checkbox of the card is ticked now. */
    fun isTicked(child: String, card: Card): Boolean = (ticks[card.id + "#" + card.hash] ?: card.checkedByDefault).contains(child)
    /** Ticks or unticks one of the card's checkboxes (only one it has, on a card shown and not being answered). */
    fun toggle(child: String, card: Card) {
        if (cards.none { it.id == card.id && it.hash == card.hash } || card.children.none { it.id == child } || card.id in answering) return
        val key = card.id + "#" + card.hash
        val set = ticks[key] ?: card.checkedByDefault
        ticks = ticks + (key to if (child in set) set - child else set + child)
    }
    /** What an answer carries: with an approve, the ticked checkboxes (in the card's order); with a deny, none. */
    fun childrenFor(card: Card, option: CardOption): List<String> =
        if (option.kind != CardOption.Kind.approve) emptyList() else card.children.map { it.id }.filter { isTicked(it, card) }

    suspend fun answer(card: Card, option: CardOption) {
        if (card.id in answering || note(card) != null) return
        refusals = refusals - card.id
        fun refuse(why: String) { refusals = refusals + (card.id to why) }
        // Inside the wait: refused, whatever the screen drew (a second tap after the card above it went).
        if (waitLeft(card) > 0) return refuse("Wait a moment: this card just moved.")
        // A card this phone can't show whole (a field it can't draw, children, too much) is answered on the computer.
        if (!card.drawable()) return refuse("Answer this one on your computer.")
        // A refusal never waits to be read (only the moment above): saying no must always be possible. An approval waits
        // until every cut part was opened and the screen has shown the values whole.
        if (option.kind == CardOption.Kind.approve) {
            if ((card.cutFields() - openedOn(card)).isNotEmpty()) return refuse("Open the rest first: some of this card is cut short.")
            if (card.id + "#" + card.hash !in seenWhole) return refuse("Scroll to the end of the card first.")
        }
        // Only the card as it stands now: one re-issued meanwhile (another hash) is answered from what is shown now.
        if (cards.none { it.id == card.id && it.hash == card.hash }) return
        answering = answering + card.id
        try {
            answeredHere.add(card.id)
            client.answer(card, option, childrenFor(card, option))
            // The card answered goes; one re-issued under its id while the answer was in flight stays.
            show(cards.filter { !(it.id == card.id && it.hash == card.hash) })
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
