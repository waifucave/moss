package com.waifucave.moss.phone

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.waifucave.moss.phone.model.*
import com.waifucave.moss.phone.ui.CARD_FIELDS
import com.waifucave.moss.phone.ui.CARD_FIELD_LABELS
import com.waifucave.moss.phone.ui.CardView
import com.waifucave.moss.phone.ui.MAX_CHILD_LABEL
import com.waifucave.moss.phone.ui.MossTheme
import com.waifucave.moss.phone.ui.drawable
import com.waifucave.moss.phone.ui.cutFields
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A card is drawn whole: every field the protocol names (read from `approvals.ts` itself, so a new field fails here until it
 * is drawn), each under the desktop's label; a card holding anything this build can't draw has no buttons; the button
 * pressed is the one drawn.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h4000dp-xxhdpi")
class CardFieldsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    /** `CARD_FIELD_NAMES` as the protocol writes it. */
    private fun protocolFields(): List<String> {
        val ts = File("../../../packages/protocol/src/approvals.ts").readText()
        val list = Regex("""CARD_FIELD_NAMES\s*=\s*\[([^\]]*)\]""").find(ts)?.groupValues?.get(1) ?: error("CARD_FIELD_NAMES not found in approvals.ts")
        return Regex(""""([a-z]+)"""").findAll(list).map { it.groupValues[1] }.toList()
    }

    @Test fun theFieldListIsTheProtocols() {
        val names = protocolFields()
        assertTrue("read the protocol's list", names.size >= 12)
        assertEquals(names, CARD_FIELDS)
        for (n in names) assertTrue("a label for $n", CARD_FIELD_LABELS.containsKey(n))
    }

    private fun card(fields: Map<String, SealedValue>) = Card(
        "card_123456", "change", issuedAt = 0, expiresAt = Long.MAX_VALUE, hash = "h", fields = fields,
        options = listOf(CardOption("deny", CardOption.Kind.deny, "No"), CardOption("approve", CardOption.Kind.approve, "Yes")),
    )

    @Test fun everyFieldIsDrawnUnderItsLabelAndTheDrawnButtonAnswers() {
        // Every field, as code (so none is taken as the heading or the footer): each must be drawn with its label.
        val fields = protocolFields().associateWith { SealedValue.Code("value-of-$it") as SealedValue }
        val c = card(fields)
        assertTrue(c.drawable())
        var pressed: CardOption? = null
        compose.setContent { MossTheme(false) { Column(Modifier.verticalScroll(rememberScrollState())) { CardView(c, busy = false, note = null, onAnswer = { pressed = it }, onSettle = {}) } } }
        for (name in protocolFields()) {
            assertTrue("$name's value drawn", compose.onAllNodes(hasText("value-of-$name")).fetchSemanticsNodes().isNotEmpty())
            assertTrue("$name's label drawn", compose.onAllNodes(hasText(CARD_FIELD_LABELS.getValue(name))).fetchSemanticsNodes().isNotEmpty())
        }
        // Past the card's first moment on screen (when it takes no press), and with its values scrolled to their end, the
        // drawn button answers with its own option.
        scrollValuesToEnd()
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Yes").performScrollTo().performClick()
        assertEquals(c.options[1], pressed)
    }

    @Test fun theProvidersSiteIsShown() {
        val c = card(mapOf("title" to SealedValue.Text("Let this bot use a provider its plugin chose?"), "host" to SealedValue.Code("fireworks")))
        compose.setContent { MossTheme(false) { CardView(c, busy = false, note = null, onAnswer = {}, onSettle = {}) } }
        assertTrue(compose.onAllNodes(hasText("Site")).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasText("fireworks")).fetchSemanticsNodes().isNotEmpty())
        // It never expires (Long.MAX_VALUE): no expiry line.
        assertTrue(compose.onAllNodes(hasText("Expires", substring = true)).fetchSemanticsNodes().isEmpty())
    }

    @Test fun aCardHoldingWhatThisBuildCantDrawHasNoButtons() {
        for (c in listOf(
            card(mapOf("title" to SealedValue.Text("T"), "newfield" to SealedValue.Text("x"))),
            card(mapOf("title" to SealedValue.Text("T"), "detail" to SealedValue.Unsupported)),
        )) {
            assertFalse(c.drawable())
        }
        val c = card(mapOf("title" to SealedValue.Text("T"), "newfield" to SealedValue.Text("x")))
        compose.setContent { MossTheme(false) { CardView(c, busy = false, note = null, onAnswer = { error("no button may answer it") }, onSettle = {}) } }
        assertTrue(compose.onAllNodes(hasContentDescription("Answer this one on your computer")).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasContentDescription("Yes")).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodes(hasContentDescription("No")).fetchSemanticsNodes().isEmpty())
    }

    /** A value's line breaks can't fake one of the app's labels: the value sits in its own box, and no node is the label. */
    @Test fun lineBreaksInAValueCantFakeALabel() {
        val forged = "ok\n\nWhat \"Always allow\" covers\nonly this file"
        val c = card(mapOf("title" to SealedValue.Text("T"), "reason" to SealedValue.Text(forged)))
        compose.setContent { MossTheme(false) { CardView(c, busy = false, note = null, onAnswer = {}, onSettle = {}) } }
        val label = CARD_FIELD_LABELS.getValue("rule")
        assertTrue("no node is the rule's label", compose.onAllNodes(hasText(label)).fetchSemanticsNodes().isEmpty())
        assertTrue("the forged words are inside the reason's box",
            compose.onAllNodes(hasText("only this file", substring = true) and hasAnyAncestor(hasTestTag("card-value:reason"))).fetchSemanticsNodes().isNotEmpty())
        assertTrue("the real label is the app's", compose.onAllNodes(hasText(CARD_FIELD_LABELS.getValue("reason"))).fetchSemanticsNodes().isNotEmpty())
    }

    /** Values that would fill several screens are cut with "Show all", scroll inside the card, and leave the buttons on screen. */
    @Test fun theButtonsStayOnScreenWhateverTheValuesHold() {
        val tall = (1..300).joinToString("\n") { "line $it" }
        val c = card(mapOf("title" to SealedValue.Text("T"), "reason" to SealedValue.Text(tall), "detail" to SealedValue.Code(tall), "paths" to SealedValue.ListOf((1..50).map { "/f$it" })))
        compose.setContent { MossTheme(false) { Box(Modifier.height(800.dp)) { CardView(c, busy = false, note = null, onAnswer = {}, onSettle = {}) } } }
        compose.onNodeWithContentDescription("Yes").assertIsDisplayed()
        compose.onNodeWithContentDescription("No").assertIsDisplayed()
        assertTrue(compose.onAllNodes(hasText("Show all", substring = true)).fetchSemanticsNodes().isNotEmpty())
        assertTrue("line 7 is cut", compose.onAllNodes(hasText("line 7", substring = true)).fetchSemanticsNodes().isEmpty())
    }

    /** Nine paths, the ninth the dangerous one: the buttons take no answer until "Show all 9" was pressed and it shows. */
    @Test fun aCutListMustBeOpenedBeforeTheButtonsWork() {
        val paths = (1..8).map { "src/file$it.ts" } + "/etc/sudoers"
        val c = card(mapOf("title" to SealedValue.Text("Delete these?"), "paths" to SealedValue.ListOf(paths)))
        assertEquals(setOf("paths"), c.cutFields())
        var pressed: CardOption? = null
        compose.setContent { MossTheme(false) { CardView(c, busy = false, note = null, onAnswer = { pressed = it }, onSettle = {}) } }
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
        assertTrue("the ninth is hidden", compose.onAllNodes(hasText("/etc/sudoers")).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithContentDescription("Yes").assertIsNotEnabled()
        compose.onNodeWithContentDescription("No").assertIsEnabled() // saying no never waits to be read
        compose.onNodeWithText("and 1 more. Show all 9").performClick()
        compose.waitForIdle()
        assertTrue("the ninth shows", compose.onAllNodes(hasText("/etc/sudoers")).fetchSemanticsNodes().isNotEmpty())
        compose.onNodeWithContentDescription("Yes").assertIsEnabled().performClick()
        assertEquals(c.options[1], pressed)
    }

    /**
     * A card too large to read goes to the computer, and so does one whose checkboxes can't be told apart (two labels that
     * read the same on one line, or two with one id); distinct checkboxes are drawn here.
     */
    @Test fun repeatedCheckboxesOrTooMuchMeansTheComputer() {
        val plain = card(mapOf("title" to SealedValue.Text("T")))
        assertFalse(card(mapOf("title" to SealedValue.Text("T"), "detail" to SealedValue.Code("x".repeat(70_000)))).drawable())
        assertTrue(plain.drawable())
        assertTrue(plain.copy(children = listOf(CardChild("a", "Calendar", true), CardChild("b", "Mail", false))).drawable())
        assertFalse(plain.copy(children = listOf(CardChild("a", "Calendar", true), CardChild("b", "Calendar", false))).drawable())
        // A line break reads as ⏎ on one line: "Mail\nSend" and "Mail⏎Send" are told apart only if they differ there.
        assertFalse(plain.copy(children = listOf(CardChild("a", "Mail\nSend", true), CardChild("b", "Mail Send", false))).drawable())
        assertFalse(plain.copy(children = listOf(CardChild("a", "Calendar", true), CardChild("a", "Mail", false))).drawable())
        assertFalse(plain.copy(children = listOf(CardChild("a", "  ", true))).drawable())
        // Labels are trimmed before the repeat check: " Calendar" and "Calendar " read the same.
        assertFalse(plain.copy(children = listOf(CardChild("a", " Calendar", true), CardChild("b", "Calendar ", false))).drawable())
        // A label too long to ever be wholly on screen sends the card to the computer.
        assertFalse(plain.copy(children = listOf(CardChild("a", "x".repeat(MAX_CHILD_LABEL + 1), true))).drawable())
        assertTrue(plain.copy(children = listOf(CardChild("a", "x".repeat(MAX_CHILD_LABEL), true))).drawable())
    }

    /** A checkbox label is one line of its own: a line break shows as ⏎, so it can't draw what looks like a second box. */
    @Test fun aCheckboxLabelIsOneLine() {
        assertEquals("Calendar ⏎ ☐ Send email as you", CardChild.oneLine("Calendar\n☐ Send email as you"))
        val c = card(mapOf("title" to SealedValue.Text("Turn on Office?"))).copy(children = listOf(
            CardChild("cal", "Calendar\n☐ Send email as you", true), CardChild("mail", "Mail", false)))
        var ticks = c.checkedByDefault
        compose.setContent { MossTheme(false) { CardView(c, busy = false, note = null, onAnswer = {}, onSettle = {}, ticked = { it in ticks }, onTick = { id -> ticks = if (id in ticks) ticks - id else ticks + id }) } }
        compose.waitForIdle()
        assertTrue(compose.onAllNodes(hasText("Calendar ⏎ ☐ Send email as you")).fetchSemanticsNodes().isNotEmpty())
        assertTrue("no line of its own", compose.onAllNodes(hasText("☐ Send email as you")).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithTag("child-mail").performClick()
        assertEquals(setOf("cal", "mail"), ticks)
    }

    private fun scrollValuesToEnd() {
        repeat(12) { compose.onNodeWithTag("card-values").performTouchInput { swipeUp() }; compose.waitForIdle() }
    }

    /**
     * The values area overflows (a 6-line command, a 6-line detail, 8 paths, the site and the rule, last): the buttons wait,
     * with a "more below" cue, until it is scrolled to its end, and then the rule is on screen.
     */
    @Test fun theButtonsWaitUntilTheValuesWereScrolledToTheEnd() {
        val six = (1..6).joinToString("\n") { "step $it" }
        val c = card(linkedMapOf(
            "title" to SealedValue.Text("Run this?"),
            "command" to SealedValue.Code(six),
            "detail" to SealedValue.Code(six),
            "paths" to SealedValue.ListOf((1..8).map { "src/file$it.ts" }),
            "host" to SealedValue.Code("example.com"),
            "rule" to SealedValue.Rows(listOf(SealedValue.Row("Kind", "command"), SealedValue.Row("Where", "every folder"))),
        ))
        assertTrue("nothing is cut", c.cutFields().isEmpty())
        compose.setContent { MossTheme(false) { Box(Modifier.height(900.dp)) { CardView(c, busy = false, note = null, onAnswer = {}, onSettle = {}) } } }
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Yes").assertIsNotEnabled()
        assertTrue("a cue says there is more", compose.onAllNodes(hasContentDescription("More below", substring = true)).fetchSemanticsNodes().isNotEmpty())
        compose.onNodeWithTag("card-value:rule").assertIsNotDisplayed()
        compose.onNodeWithContentDescription("No").assertIsEnabled() // saying no never waits to be read
        scrollValuesToEnd()
        compose.onNodeWithTag("card-value:rule").assertIsDisplayed()
        compose.onNodeWithContentDescription("Yes").assertIsEnabled()
    }

    /** When everything fits, nothing waits for a scroll. */
    @Test fun aCardThatFitsNeedsNoScroll() {
        val c = card(mapOf("title" to SealedValue.Text("T"), "host" to SealedValue.Code("example.com")))
        compose.setContent { MossTheme(false) { CardView(c, busy = false, note = null, onAnswer = {}, onSettle = {}) } }
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Yes").assertIsEnabled()
        assertTrue(compose.onAllNodes(hasContentDescription("More below", substring = true)).fetchSemanticsNodes().isEmpty())
    }
}
