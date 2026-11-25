package com.waifucave.moss.phone

import com.waifucave.moss.phone.client.FakeEngineClient
import com.waifucave.moss.phone.client.SampleData
import com.waifucave.moss.phone.model.*
import com.waifucave.moss.phone.ui.AgentLook
import com.waifucave.moss.phone.ui.ComposerRules
import com.waifucave.moss.phone.ui.Sealed
import com.waifucave.moss.phone.ui.TimeText
import com.waifucave.moss.phone.vm.BotsListModel
import com.waifucave.moss.phone.vm.ARM_MS
import com.waifucave.moss.phone.vm.CardsModel
import com.waifucave.moss.phone.vm.MemoryPinStore
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneOffset
import java.util.Locale
import kotlin.random.Random

/** A clock a second further on at every read: a card's wait (CardsModel.ARM_MS) is always over by the next look. */
fun steppingClock(): () -> Long { var t = 0L; return { t += 1_000; t } }

class RulesTest {
    @Test fun composerPrimarySlot() {
        assertEquals(ComposerRules.Primary.stop, ComposerRules.primary(running = true, draft = "text"))
        assertEquals(ComposerRules.Primary.send, ComposerRules.primary(running = false, draft = "text"))
        assertEquals(ComposerRules.Primary.voice, ComposerRules.primary(running = false, draft = ""))
        assertTrue(ComposerRules.showsMic(false, ""))
        assertFalse(ComposerRules.showsMic(true, ""))
        assertFalse(ComposerRules.showsMic(false, "a"))
    }

    @Test fun composerRowsOnlyWhenOffered() {
        assertEquals(emptyList<String>(), ComposerRules.rows(ComposerOffers(), camera = true))
        val bot = ComposerOffers(pictures = true, commands = listOf(PluginCommand("a", "A")), efforts = listOf("low"), effort = "low")
        assertEquals(listOf("Camera", "Photos", "Plugins", "Effort"), ComposerRules.rows(bot, camera = true))
        assertEquals(listOf("Photos", "Plugins", "Effort"), ComposerRules.rows(bot, camera = false))
        val code = bot.copy(models = listOf(ModelChoice("m", "M")))
        assertEquals(listOf("Camera", "Photos", "Plugins", "Effort", "Model"), ComposerRules.rows(code, camera = true))
    }

    @Test fun bidiAndControlShowAsEscapes() {
        assertEquals("a\\u{202E}b", Sealed.visible("a‮b"))
        assertEquals("x\\u{0}y", Sealed.visible("x\u0000y"))
        assertEquals("line\nbreak", Sealed.visible("line\nbreak"))
    }

    @Test fun longFieldIsCutOpenly() {
        val c = Sealed.cut("a".repeat(1000), 600)
        assertEquals(600, c.shown.length); assertEquals(400, c.hiddenCount)
        assertEquals(0, Sealed.cut("short", 600).hiddenCount)
    }

    @Test fun listStamps() {
        val now = SampleData.now; val utc = ZoneOffset.UTC; val us = Locale.US
        assertEquals("9:56 AM", TimeText.stamp(now - 240_000, now, utc, us))
        assertEquals("Yesterday", TimeText.stamp(now - 26 * 3_600_000L, now, utc, us))
        assertEquals("Sunday", TimeText.stamp(now - 3 * 86_400_000L, now, utc, us))
        assertEquals("Nov 16", TimeText.stamp(now - 9 * 86_400_000L, now, utc, us))
        assertEquals("Yesterday 10:00 AM", TimeText.divider(now - 86_400_000L, now, utc, us))
        assertEquals("2 hours ago", TimeText.relative(now - 7_200_000L, now))
    }

    @Test fun agentLookKnownAndFallback() {
        assertEquals("Claude Code", AgentLook.of("claude-code").name)
        assertEquals("S", AgentLook.of("some-new-agent").initial)
    }

    @Test fun sessionMotionMatchesProtocolRule() {
        assertEquals(SessionMotion.running, sessionMotion(SessionStatus.prompting, SessionWaiting(2, 0)))
        assertEquals(SessionMotion.waiting, sessionMotion(SessionStatus.idle, SessionWaiting(1, 0)))
        assertEquals(SessionMotion.still, sessionMotion(SessionStatus.ready, SessionWaiting(0, 0)))
        assertEquals(SessionMotion.ended, sessionMotion(SessionStatus.failed, null))
        assertEquals(SessionMotion.ended, sessionMotion(SessionStatus.stopped, SessionWaiting(3, 3)))
    }

    /**
     * Generated sequences of engine events into the bots list: whatever the order, every bot shows once, the pinned and the
     * others never overlap and together are every bot, a status line shows exactly while its turn runs, and the unread count is
     * the rows marked unread.
     */
    @Test fun botsListHoldsItsInvariantsOverAnyEventSequence() = runTest {
        repeat(200) { seed ->
            val rnd = Random(seed)
            val m = BotsListModel(FakeEngineClient(), MemoryPinStore(SampleData.pinned))
            m.load()
            val running = mutableMapOf<String, String>()
            repeat(60) { i ->
                val bot = SampleData.bots[rnd.nextInt(SampleData.bots.size)]
                when (rnd.nextInt(5)) {
                    0 -> { val line = "${bot.name} is working"; running[bot.mainSession] = line; m.apply(EngineEvent.StatusLine(bot.mainSession, line)) }
                    1 -> { running.remove(bot.mainSession); m.apply(EngineEvent.StatusLine(bot.mainSession, null)) }
                    2 -> m.apply(EngineEvent.Message(bot.mainSession, ChatMessage("e$i", if (rnd.nextBoolean()) MessageRole.user else MessageRole.bot, "t$i", SampleData.now + i)))
                    3 -> m.togglePin(bot.id)
                    else -> m.apply(EngineEvent.BotSummaryChanged(BotSummary(bot.id, null, rnd.nextBoolean())))
                }
                val ids = m.rows.map { it.id }
                assertEquals(ids.toSet().size, ids.size)
                assertEquals(SampleData.bots.size, ids.size)
                val pinned = m.pinned.map { it.id }.toSet(); val others = m.others.map { it.id }.toSet()
                assertTrue((pinned intersect others).isEmpty())
                assertEquals(ids.toSet(), pinned + others)
                for (r in m.rows) assertEquals(running[r.bot.mainSession], r.statusLine)
                assertEquals(m.rows.count { it.unread }, m.unreadCount)
            }
        }
    }

    /** Generated card events: a card is never listed twice, and the waiting count is the cards with no note. */
    @Test fun cardsHoldTheirInvariantsOverAnyEventSequence() = runTest {
        repeat(100) { seed ->
            val rnd = Random(seed)
            val c = FakeEngineClient()
            c.setOtherAppInstalled(false)
            val m = CardsModel(c, PhoneApp.moss, { SampleData.now }, steppingClock())
            m.load()
            repeat(40) {
                val card = SampleData.cards[rnd.nextInt(SampleData.cards.size)]
                when (rnd.nextInt(4)) {
                    0 -> m.apply(EngineEvent.CardRequested(card))
                    1 -> m.apply(EngineEvent.CardResolved(card.id))
                    2 -> m.cards.firstOrNull { it.id == card.id }?.let { m.answer(it, it.options.last()) }
                    else -> m.cards.firstOrNull { it.id == card.id }?.let { m.dismiss(it) }
                }
                val ids = m.cards.map { it.id }
                assertEquals(ids.toSet().size, ids.size)
                assertEquals(m.cards.count { m.note(it) == null }, m.waitingCount)
            }
        }
    }

    /** A new card comes in at the end; the same card with new content replaces the old where it stands, marked changed. */
    @Test fun aNewCardGoesLastAndAChangedOneIsReplacedInPlace() = runTest {
        val c = FakeEngineClient()
        c.setOtherAppInstalled(false)
        val m = CardsModel(c, PhoneApp.moss, { SampleData.now }, steppingClock())
        m.load()
        val first = m.cards.map { it.id }
        val fresh = SampleData.cards[0].copy(id = "card_ffff0000", issuedAt = SampleData.now + 1, hash = "f".repeat(64))
        m.apply(EngineEvent.CardRequested(fresh))
        assertEquals(first + fresh.id, m.cards.map { it.id })
        val changed = fresh.copy(hash = "e".repeat(64), fields = fresh.fields + ("title" to SealedValue.Text("Something else")))
        m.apply(EngineEvent.CardRequested(changed))
        assertEquals(first + fresh.id, m.cards.map { it.id })
        assertEquals(changed, m.cards.last())
        assertTrue(fresh.id in m.changed)
        // The same content again changes nothing.
        m.apply(EngineEvent.CardRequested(changed))
        assertEquals(1, m.cards.count { it.id == fresh.id })
    }

    /**
     * The wait is the model's: after card A is answered and leaves, the card that moved up into its place takes no press
     * for a moment (a second, impatient tap is refused, never sent), and then does.
     */
    @Test fun aCardThatMovedUpWaitsBeforeItTakesAPress() = runTest {
        val c = FakeEngineClient()
        c.setOtherAppInstalled(false)
        var t = 0L
        val m = CardsModel(c, PhoneApp.moss, { SampleData.now }, { t })
        m.load()
        t += 10_000
        val waiting = m.cards.filter { m.note(it) == null }
        assertTrue("two cards to work with", waiting.size >= 2)
        val a = waiting[0]
        val b = m.cards[m.cards.indexOf(a) + 1]
        assertEquals(0L, m.waitLeft(a))
        m.answer(a, a.options.first())
        assertFalse(m.cards.any { it.id == a.id })
        assertTrue("b moved up and waits", m.waitLeft(b) > 0)
        m.answer(b, b.options.first())
        assertTrue("the impatient tap was refused", m.cards.any { it.id == b.id })
        assertNull(m.notes[b.id])
        t += ARM_MS
        assertEquals(0L, m.waitLeft(b))
        m.answer(b, b.options.first())
        assertFalse("now it is answered", m.cards.any { it.id == b.id })
    }

    /** A card re-issued under its id while an answer to it is in flight stays on screen, as re-issued; a cut one waits. */
    @Test fun anAnswerInFlightLeavesAReissuedCardAndACutCardWaitsUntilOpened() = runTest {
        val c = FakeEngineClient()
        c.setOtherAppInstalled(false)
        val m = CardsModel(c, PhoneApp.moss, { SampleData.now }, steppingClock())
        m.load()
        val a = m.cards.first { m.note(it) == null }
        val reissued = a.copy(hash = "9".repeat(64), fields = a.fields + ("reason" to SealedValue.Text("changed")))
        c.beforeAnswer = { m.apply(EngineEvent.CardRequested(reissued)) }
        m.answer(a, a.options.first())
        assertEquals("the re-issued card stays", reissued, m.cards.firstOrNull { it.id == a.id })
        // A card with a cut list: refused until the list was opened.
        val long = a.copy(id = "card_cut000001", hash = "8".repeat(64), fields = a.fields + ("paths" to SealedValue.ListOf((1..9).map { "f$it" })))
        c.raise(long)
        m.apply(EngineEvent.CardRequested(long))
        c.beforeAnswer = {}
        m.answer(long, long.options.first())
        assertTrue("refused while cut", m.cards.any { it.id == long.id })
        m.open(long, "paths")
        m.answer(long, long.options.first())
        assertFalse("answered once opened", m.cards.any { it.id == long.id })
    }

    /** The model refuses a card whose values overflow until they were scrolled to the end, and says why in one line. */
    @Test fun aCardNotScrolledToItsEndIsRefusedWithAReason() = runTest {
        val c = FakeEngineClient()
        c.setOtherAppInstalled(false)
        val m = CardsModel(c, PhoneApp.moss, { SampleData.now }, steppingClock())
        m.load()
        val a = m.cards.first { m.note(it) == null }
        m.scrolled(a, overflows = true, reachedEnd = false)
        m.answer(a, a.options.first())
        assertTrue(m.cards.any { it.id == a.id })
        assertEquals("Scroll to the end of the card first.", m.refusals[a.id])
        m.scrolled(a, overflows = true, reachedEnd = true)
        m.answer(a, a.options.first())
        assertFalse(m.cards.any { it.id == a.id })
    }
}
