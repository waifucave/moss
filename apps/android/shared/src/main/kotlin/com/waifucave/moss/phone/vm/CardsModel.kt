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

/** The cards waiting for the person. Which of them this app shows is the client's answer (`shows(card, app)`). */
class CardsModel(private val client: EngineClient, private val app: PhoneApp, private val now: () -> Long = { System.currentTimeMillis() }) {
    var cards by mutableStateOf<List<Card>>(emptyList())
        private set
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
            cards = all.filter { client.shows(it, app) }
            loadFailed = false
        } catch (e: CancellationException) { throw e } catch (e: Exception) { loadFailed = true }
        loaded = true
    }

    suspend fun run() = listener.run(client, ::load) { apply(it) }

    suspend fun apply(event: EngineEvent) {
        when (event) {
            is EngineEvent.CardRequested -> if (client.shows(event.card, app) && cards.none { it.id == event.card.id }) cards = cards + event.card
            is EngineEvent.CardResolved -> {
                if (event.id in answeredHere) cards = cards.filter { it.id != event.id }
                else if (cards.any { it.id == event.id }) notes = notes + (event.id to CardNote.answeredElsewhere)
            }
            else -> {}
        }
    }

    suspend fun answer(card: Card, option: CardOption) {
        if (card.id in answering || note(card) != null) return
        answering = answering + card.id
        try {
            answeredHere.add(card.id)
            client.answer(card, option)
            cards = cards.filter { it.id != card.id }
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
        cards = cards.filter { it.id != card.id }
        notes = notes - card.id
    }
    /** Lets a failed answer be tried again. */
    fun clearFailure(card: Card) { if (notes[card.id] == CardNote.failed) notes = notes - card.id }
}
