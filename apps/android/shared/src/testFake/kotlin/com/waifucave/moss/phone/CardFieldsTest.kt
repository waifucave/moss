package com.waifucave.moss.phone

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.waifucave.moss.phone.model.*
import com.waifucave.moss.phone.ui.CARD_FIELDS
import com.waifucave.moss.phone.ui.CARD_FIELD_LABELS
import com.waifucave.moss.phone.ui.CardView
import com.waifucave.moss.phone.ui.MossTheme
import com.waifucave.moss.phone.ui.drawable
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
        compose.onNodeWithContentDescription("Yes").performScrollTo().performClick()
        assertEquals(c.options[1], pressed)
    }

    @Test fun theProvidersSiteIsShown() {
        val c = card(mapOf("title" to SealedValue.Text("Let this bot use a provider its plugin chose?"), "host" to SealedValue.Code("fireworks")))
        compose.setContent { MossTheme(false) { CardView(c, busy = false, note = null, onAnswer = {}, onSettle = {}) } }
        assertTrue(compose.onAllNodes(hasText("Site")).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasText("fireworks")).fetchSemanticsNodes().isNotEmpty())
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
}
