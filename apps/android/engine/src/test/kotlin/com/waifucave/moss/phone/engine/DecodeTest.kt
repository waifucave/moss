package com.waifucave.moss.phone.engine

import com.waifucave.moss.phone.model.*
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The decoders against the protocol's own generated fixtures, and what they must never do: crash on what they don't know. */
class DecodeTest {
    private fun fixture(name: String) = Decode.parse(File("../../../packages/protocol/generated/moss/fixtures/$name.json").readText())!!

    @Test
    fun aCardFromTheFixtureDecodesWhole() {
        val card = fixture("card_requested")["card"]!!
        val c = Decode.card(card.toString(), "h")!!
        assertEquals("card_0a1b2c3d", c.id)
        assertEquals("alpha", c.bot)
        assertEquals("s_alpha", c.session)
        assertEquals("h", c.hash)
        assertEquals(listOf("allow_once", "allow_always", "deny"), c.options.map { it.id })
        assertEquals("Always allow", c.options[1].label)
        assertTrue(c.options[1].rememberAlways)
        assertEquals(SealedValue.Code("rm -rf build/", "sh"), c.fields["command"])
        assertEquals("Run a command?", c.title)
        assertEquals(1781270600000L, c.expiresAt)
    }

    @Test
    fun aCardThatNeverExpiresReadsAsNever() {
        val json = """{"id":"card_123456","kind":"change","computer":null,"origin":"user","issuedAt":1,"expiresAt":null,"hash":"x","fields":{"title":{"type":"text","text":"T"}},"options":[{"id":"approve","kind":"approve","label":"Approve"}]}"""
        assertEquals(Long.MAX_VALUE, Decode.card(json, "x")!!.expiresAt)
    }

    @Test
    fun aCardWithAFieldOrOptionThePhoneCantDrawIsRefusedWhole() {
        val field = """{"id":"card_123456","kind":"tool","issuedAt":1,"fields":{"title":{"type":"hologram"}},"options":[{"id":"a","kind":"approve","label":"A"}]}"""
        assertNull(Decode.card(field, "x"))
        val option = """{"id":"card_123456","kind":"tool","issuedAt":1,"fields":{},"options":[{"id":"a","kind":"maybe","label":"A"}]}"""
        assertNull(Decode.card(option, "x"))
        assertNull(Decode.card("not json", "x"))
    }

    @Test
    fun botsSessionsAndSummariesFromTheFixtures() {
        val b = Decode.bot(fixture("bot_changed")["bot"])!!
        assertEquals(Bot("alpha", "Alpha", "fireworks/kimi-k3", "medium", null, BotState.idle, "Studio", "s_alpha"), b)
        val s = Decode.session(fixture("session_changed")["session"])!!
        assertEquals("agent", s.kind)
        assertEquals(SessionStatus.prompting, s.status)
        assertEquals("project1", s.project)
        val sum = Decode.summary(fixture("bot_summary_changed")["summary"])!!
        assertEquals(BotSummary.From.bot, sum.last!!.from)
        assertTrue(sum.unread)
    }

    @Test
    fun unknownValuesAreReadAsTheirPlainMeaningNeverACrash() {
        val b = Decode.bot(Decode.parse("""{"id":"x","name":{"en":"X","fr":"Xe"},"state":"dreaming","mainSession":"s_x","new":[1,2]}"""))!!
        assertEquals("X", b.name)
        assertNull(b.state)
        val s = Decode.session(Decode.parse("""{"id":"s","kind":"future","computer":"C","status":"levitating","startedAt":1,"updatedAt":2}"""))!!
        assertEquals(SessionStatus.idle, s.status)
        assertNull(Decode.bot(Decode.parse("[]")))
        assertNull(Decode.session(Decode.parse("\"s\"")))
    }

    @Test
    fun aSessionsEventsAsMessages() {
        val user = Decode.parse("""{"type":"user_message","seq":3,"sessionId":"s_a","ts":10,"threadId":"main","text":"hi","clientName":"x","device":"d_other"}""")
        val m = Decode.message(user, ConversationKind.bot) { if (it == "d_other") "Laptop" else null }!!
        assertEquals(ChatMessage("s_a#3", MessageRole.user, "hi", 10, device = "Laptop"), m)
        val reply = Decode.parse("""{"type":"assistant_message","seq":4,"sessionId":"s_a","ts":11,"threadId":"main","text":"hello"}""")
        assertEquals(MessageRole.bot, Decode.message(reply, ConversationKind.bot)!!.role)
        assertEquals(MessageRole.agent, Decode.message(reply, ConversationKind.codingSession)!!.role)
        assertNull(Decode.message(Decode.parse("""{"type":"tool_call","seq":5,"sessionId":"s_a","ts":12}"""), ConversationKind.bot))
        assertNull(Decode.message(Decode.parse("""{"type":"assistant_delta","seq":4,"sessionId":"s_a","ts":12,"delta":"x"}"""), ConversationKind.bot))
        assertNotNull(Decode.message(fixture("note"), ConversationKind.bot))
    }

    @Test
    fun theOpenQuestionIsTheLastOneNotResolved() {
        val events = listOf(
            """{"type":"question_asked","callId":"c1","questions":[{"question":"One?","options":[],"multiSelect":false}]}""",
            """{"type":"question_resolved","callId":"c1","answers":{},"by":"user"}""",
            """{"type":"question_asked","callId":"c2","questions":[{"question":"Two?","header":"Pick","options":[{"label":"A"},{"label":"B","description":"b"}],"multiSelect":true}]}""",
        ).map { Decode.parse(it)!! }
        val q = Decode.openQuestion(events)!!
        assertEquals("c2", q.callId)
        assertEquals(listOf(AskQuestion.Option("A"), AskQuestion.Option("B", "b")), q.options)
        assertTrue(q.multiSelect)
        assertNull(Decode.openQuestion(events.take(2)))
    }

    @Test
    fun picturesAreNamedByTheirBytes() {
        assertEquals("image/png", CoreEngineClient.mediaType(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D)))
        assertEquals("image/jpeg", CoreEngineClient.mediaType(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0)))
    }
}
