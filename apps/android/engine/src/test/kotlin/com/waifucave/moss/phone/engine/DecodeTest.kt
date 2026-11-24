package com.waifucave.moss.phone.engine

import com.waifucave.moss.phone.model.*
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What the Android side still reads from engine JSON (a card to draw, the device list), against the protocol's fixtures. */
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
    fun everyStringOfACardGoesThroughTheCleaner() {
        val card = fixture("card_requested")["card"]!!
        val c = Decode.card(card.toString(), "h") { "[$it]" }!!
        assertEquals("[Run a command?]", c.title)
        assertEquals(SealedValue.Code("[rm -rf build/]", "[sh]"), c.fields["command"])
        assertEquals("[Allow]", c.options[0].label)
        assertEquals("card_0a1b2c3d", c.id)
    }

    @Test
    fun devicesSayWhichAppEachPhoneIs() {
        val d = Decode.devices(Decode.parse("""{"devices":[{"id":"a","name":"Studio","kind":"desktop"},{"id":"b","name":"Pixel","kind":"phone","app":"code"},{"id":"c","kind":"phone","app":"other"},{"name":"no id"}]}"""))
        assertEquals(listOf(Decode.Device("a", "Studio", false, null), Decode.Device("b", "Pixel", true, PhoneApp.code), Decode.Device("c", "c", true, null)), d)
    }

    @Test
    fun picturesAreNamedByTheirBytes() {
        assertEquals("image/png", CoreEngineClient.mediaType(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D)))
        assertEquals("image/jpeg", CoreEngineClient.mediaType(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0)))
    }
}
