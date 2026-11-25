package com.waifucave.moss.phone.engine

import com.waifucave.moss.phone.model.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.fail
import org.junit.Test

/** After a call that changes state fails without saying whether it happened, the client reads back before anyone retries. */
class ReadBackTest {
    private class Timeout : Exception("timeout")
    private class Refused : Exception("refused")
    private val uncertain: (Throwable) -> Boolean = { it is Timeout }

    private val request = StartRequest("moss-code", "Studio", "home/Studio/project1")
    private fun row(id: String, root: String = request.root, backend: String? = request.backend, startedAt: Long = 1_000_000, kind: String = "coding") =
        SessionRow(id, kind = kind, computer = "Studio", status = SessionStatus.starting, startedAt = startedAt, updatedAt = startedAt, backend = backend, root = root)
    private fun bot(id: String, name: String) = Bot(id, name, mainSession = "s_$id")

    @Test
    fun aStartThatTimedOutButHappenedIsReadBackNotStartedAgain() = runTest {
        var calls = 0
        val id = ReadBack.afterUncertain({ calls++; throw Timeout() }, uncertain) {
            ReadBack.startedSession(setOf("old"), listOf(row("old"), row("new")), request, calledAt = 1_000_000)
        }
        assertEquals("new", id)
        assertEquals(1, calls)
    }

    @Test
    fun aStartThatTimedOutAndDidNotHappenKeepsItsFailure() = runTest {
        val t = Timeout()
        try {
            ReadBack.afterUncertain({ throw t }, uncertain) { ReadBack.startedSession(setOf("old"), listOf(row("old")), request, 1_000_000) }
            fail("no session was found, so the failure stands")
        } catch (e: Timeout) { assertSame(t, e) }
    }

    @Test
    fun aRefusalIsNeverReadBack() = runTest {
        var readBack = false
        try {
            ReadBack.afterUncertain<String>({ throw Refused() }, uncertain) { readBack = true; "x" }
            fail("a refusal is the engine's answer")
        } catch (e: Refused) { assertEquals(false, readBack) }
    }

    @Test
    fun aStartIsOnlyFoundWhenExactlyOneNewSessionMatches() {
        val before = setOf("old")
        // Another folder, another backend, a bot's session, one from before the call: none is this start.
        val others = listOf(row("a", root = "home/Studio/other"), row("b", backend = "codex"), row("c", kind = "agent"), row("d", startedAt = 1))
        assertNull(ReadBack.startedSession(before, others, request, 1_000_000))
        // Two that match is not knowing which: none is taken.
        assertNull(ReadBack.startedSession(before, listOf(row("x"), row("y")), request, 1_000_000))
        assertEquals("x", ReadBack.startedSession(before, others + row("x"), request, 1_000_000))
    }

    @Test
    fun aBotThatWasMadeIsReadBackByItsNewIdAndName() = runTest {
        val made = ReadBack.afterUncertain({ throw Timeout() }, uncertain) {
            ReadBack.madeBot(setOf("alpha"), listOf(bot("alpha", "Alpha"), bot("hazel", "Hazel")), " Hazel ")
        }
        assertEquals("hazel", made.id)
        assertNull(ReadBack.madeBot(setOf("alpha", "hazel"), listOf(bot("alpha", "Alpha"), bot("hazel", "Hazel")), "Hazel"))
        assertNull(ReadBack.madeBot(emptySet(), listOf(bot("a", "Hazel"), bot("b", "Hazel")), "Hazel"))
    }

    @Test
    fun aCardReadBackSaysWhetherTheAnswerWasTaken() {
        val approve = CardOption("approve", CardOption.Kind.approve, "Approve")
        val deny = CardOption("deny", CardOption.Kind.deny, "Deny")
        assertEquals(ReadBack.Answer.stillPending, ReadBack.answer(pending = true, outcome = null, option = approve))
        assertEquals(ReadBack.Answer.accepted, ReadBack.answer(false, "approved", approve))
        assertEquals(ReadBack.Answer.accepted, ReadBack.answer(false, "denied", deny))
        assertEquals(ReadBack.Answer.answeredElsewhere, ReadBack.answer(false, "denied", approve))
        assertEquals(ReadBack.Answer.answeredElsewhere, ReadBack.answer(false, "withdrawn", approve))
        assertEquals(ReadBack.Answer.expired, ReadBack.answer(false, "expired", approve))
    }

    @Test
    fun attachmentsAreNamedInTheTextOnceEach() {
        assertEquals("look", ReadBack.withTokens("look", 0, 0))
        assertEquals("look [Image #1] [File #1] [File #2]", ReadBack.withTokens("look", 1, 2))
        assertEquals("see [File #1] and this [Image #1]", ReadBack.withTokens("see [File #1] and this", 1, 1))
    }

    @Test fun onlyACodeShapedLikeAPairingQrMakesTheCore() {
        assertTrue(ReadBack.looksLikePairingCode("moss-pair:1:" + "A".repeat(40)))
        assertFalse(ReadBack.looksLikePairingCode(""))
        assertFalse(ReadBack.looksLikePairingCode("hello"))
        assertFalse(ReadBack.looksLikePairingCode("moss-pair:sample"))
        assertFalse(ReadBack.looksLikePairingCode("moss-pair:1:short"))
        assertFalse(ReadBack.looksLikePairingCode("https://example.com/x:1:" + "A".repeat(40)))
    }
}
