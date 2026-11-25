package com.waifucave.moss.phone.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.TimerOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.waifucave.moss.phone.model.Card
import com.waifucave.moss.phone.model.CardOption
import com.waifucave.moss.phone.model.SealedValue
import com.waifucave.moss.phone.vm.CardNote
import com.waifucave.moss.phone.vm.CardsModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * What a card draws: the sealed text with control characters and bidirectional marks made visible as escapes (`\u{202E}`), so
 * what the person approves is what runs; and a field too long for its space is cut openly, never silently.
 */
object Sealed {
    fun visible(s: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < s.length) {
            val v = s.codePointAt(i)
            val bidi = v in 0x202A..0x202E || v in 0x2066..0x2069 || v == 0x200E || v == 0x200F || v == 0x061C
            val control = (v < 0x20 && v != 0x0A && v != 0x09) || v in 0x7F..0x9F || v == 0x200B || v == 0xFEFF
            if (bidi || control) out.append("\\u{").append(Integer.toHexString(v).uppercase()).append("}") else out.appendCodePoint(v)
            i += Character.charCount(v)
        }
        return out.toString()
    }

    data class Cut(val shown: String, val hiddenCount: Int)
    /** The first `limit` characters (escaped), and how many were left out. */
    fun cut(s: String, limit: Int): Cut {
        val v = visible(s)
        return if (v.length <= limit) Cut(v, 0) else Cut(v.take(limit), v.length - limit)
    }
}

/**
 * Every sealed field the protocol names (`CARD_FIELD_NAMES`, `packages/protocol/src/approvals.ts`), in its order; a test
 * reads that list from the protocol, so a new field fails it until it is drawn here. A card is drawn with every field it
 * carries: the title and what it asks at the top, the rest each under the label the desktop's card gives it
 * (`FIELD_TITLES` in apps/desktop/src/main/sealed-pages.ts; `rule` has none there and reads "Rule").
 */
val CARD_FIELDS = listOf("title", "what", "command", "computer", "risk", "reason", "source", "host", "paths", "detail", "expires", "rule")
val CARD_FIELD_LABELS = mapOf(
    "title" to "What", "what" to "Tool", "command" to "Command", "computer" to "Computer", "risk" to "Risk", "reason" to "Why",
    "source" to "From", "host" to "Site", "paths" to "Files", "detail" to "Everything it sends", "expires" to "Expires", "rule" to "Rule",
)

/** How long a card new to the screen holds its buttons back. */
const val ARM_MS = 600L

/** Whether this build can draw all of a card: every field one it knows, every value of a kind it draws. */
fun Card.drawable(): Boolean = fields.all { (name, v) -> name in CARD_FIELDS && v !is SealedValue.Unsupported }

/** What heads the card: its title and what it asks, when they are plain text (anything else is drawn as a labelled field). */
private fun Card.headedBy(name: String): Boolean = (name == "title" || name == "what") && fields[name] is SealedValue.Text

/** The computer goes in the footer when it is plain text. */
private fun Card.footerComputer(): SealedValue.Text? = fields["computer"] as? SealedValue.Text

/** A pending card: small, never raw JSON. Its title, what it asks, the command or paths it covers, and its sealed buttons. */
@Composable
fun CardView(card: Card, busy: Boolean, note: CardNote?, onAnswer: (CardOption) -> Unit, onSettle: () -> Unit, modifier: Modifier = Modifier, changed: Boolean = false) {
    val c = MossTheme.colors
    val now = nowMs()
    val large = largeText()
    var expanded by remember(card.id) { mutableStateOf(setOf<String>()) }
    // A card new to the screen, or whose content just changed, takes no press for a moment: a tap meant for what was
    // there before never answers it.
    var armed by remember(card.id, card.hash) { mutableStateOf(false) }
    LaunchedEffect(card.id, card.hash) { delay(ARM_MS); armed = true }
    Column(
        modifier.fillMaxWidth().cardSurface(c).padding(14.dp).alpha(if (note == null || note == CardNote.failed) 1f else 0.75f),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(Sealed.visible(if (card.headedBy("title")) card.title else "Needs your answer"), style = MossType.title, color = c.text, modifier = Modifier.semantics { heading() })
            if (card.headedBy("what")) card.what?.let { Text(Sealed.visible(it), style = MossType.line, color = c.secondary) }
        }
        for (name in CARD_FIELDS) {
            val value = card.fields[name] ?: continue
            if (card.headedBy(name) || (name == "computer" && card.footerComputer() != null)) continue
            Labelled(name) {
                when (value) {
                    is SealedValue.Text -> CutText(value.text, 600, expanded.contains(name), { expanded = expanded + name }, MossType.body)
                    is SealedValue.Code -> Box(Modifier.fillMaxWidth().background(c.code, RoundedCornerShape(10.dp)).padding(10.dp)) {
                        CutText(value.code, 800, expanded.contains(name), { expanded = expanded + name }, MossType.footnote.copy(fontFamily = FontFamily.Monospace))
                    }
                    is SealedValue.ListOf -> Column {
                        val shown = if (expanded.contains(name)) value.items else value.items.take(8)
                        shown.forEach { Text(Sealed.visible(it), style = MossType.footnote.copy(fontFamily = FontFamily.Monospace), color = c.text) }
                        if (shown.size < value.items.size) TextButton(onClick = { expanded = expanded + name }, contentPadding = PaddingValues(0.dp)) {
                            Text("and ${value.items.size - shown.size} more. Show all", style = MossType.footnote.copy(textDecoration = TextDecoration.Underline), color = c.secondary)
                        }
                    }
                    is SealedValue.Rows -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        value.rows.forEach { r ->
                            if (large) Column {
                                Text(Sealed.visible(r.label), style = MossType.body, color = c.secondary)
                                Text(Sealed.visible(r.value), style = MossType.body, color = c.text)
                            } else Row {
                                Text(Sealed.visible(r.label), style = MossType.body, color = c.secondary)
                                Spacer(Modifier.width(12.dp).weight(1f))
                                Text(Sealed.visible(r.value), style = MossType.body, color = c.text)
                            }
                        }
                    }
                    SealedValue.Unsupported -> Text("Can't be shown on the phone", style = MossType.footnote, color = c.secondary)
                }
            }
        }
        // The footer: which computer, and how long the card has left.
        Row(verticalAlignment = Alignment.CenterVertically) {
            card.footerComputer()?.let {
                Icon(Icons.Outlined.DesktopWindows, null, tint = c.secondary, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text("on ${Sealed.visible(it.text)}", style = MossType.caption, color = c.secondary)
            }
            Spacer(Modifier.weight(1f))
            val left = (card.expiresAt - now) / 1000
            if (left > 0) Text("Expires in ${left / 60} min", style = MossType.caption, color = c.secondary)
        }
        if (changed) Text("This card changed while it was shown. Read it again before you answer.", style = MossType.footnote, color = c.secondary)
        if (!card.drawable()) {
            // A field this build can't draw: the person would approve less than what they were asked. No buttons.
            Text("Answer this one on your computer: it holds something this phone can't show.", style = MossType.footnote, color = c.secondary,
                modifier = Modifier.semantics { contentDescription = "Answer this one on your computer" })
        } else if (note != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(if (note == CardNote.failed) Icons.Outlined.ErrorOutline else Icons.Outlined.TimerOff, null, tint = c.secondary, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(note.text, style = MossType.footnote, color = c.secondary)
            }
            OutlinedButton(onClick = onSettle, modifier = Modifier.fillMaxWidth()) { Text(if (note == CardNote.failed) "Try again" else "Dismiss", color = c.secondary) }
        } else {
            val buttons: @Composable (CardOption, Modifier) -> Unit = { option, m ->
                val approve = option.kind == CardOption.Kind.approve
                FilledTonalButton(
                    onClick = { if (armed) onAnswer(option) }, enabled = !busy && armed, modifier = m.semantics {
                        contentDescription = if (option.rememberAlways) "${option.label}, and remember" else option.label
                        stateDescription = if (approve) "Approves this request" else "Refuses this request"
                    },
                    colors = ButtonDefaults.filledTonalButtonColors(
                        containerColor = if (approve) c.text.copy(alpha = if (c.dark) 0.22f else 0.12f) else c.text.copy(alpha = 0.05f),
                        contentColor = if (approve) c.text else c.secondary,
                    ),
                ) { Text(Sealed.visible(option.label), maxLines = 2) }
            }
            if (card.options.size > 2 || large) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                card.options.forEach { buttons(it, Modifier.fillMaxWidth()) }
            } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                card.options.forEach { buttons(it, Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun Labelled(name: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(CARD_FIELD_LABELS[name] ?: name, style = MossType.caption, color = MossTheme.colors.secondary)
        content()
    }
}

/** A long field is cut openly: it says how much is hidden and offers the rest. */
@Composable
private fun CutText(s: String, limit: Int, open: Boolean, onOpen: () -> Unit, style: androidx.compose.ui.text.TextStyle) {
    val c = MossTheme.colors
    val cut = Sealed.cut(s, limit)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(if (open) Sealed.visible(s) else cut.shown, style = style, color = c.text)
        if (cut.hiddenCount > 0 && !open) {
            TextButton(onClick = onOpen, contentPadding = PaddingValues(0.dp)) {
                Text("Cut short: ${cut.hiddenCount} more characters. Show all", style = MossType.footnote.copy(textDecoration = TextDecoration.Underline), color = c.secondary)
            }
        }
    }
}

/** The gathered list of cards, behind the bell: both apps share it. */
@Composable
fun NeedsYouScreen(model: CardsModel, who: (Card) -> String, onBack: () -> Unit) {
    val c = MossTheme.colors
    val scope = rememberCoroutineScope()
    LaunchedEffect(model) { model.run() }
    Scaffold(
        containerColor = c.grouped,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Needs you", style = MossType.title) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.grouped),
            )
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when {
                !model.loaded -> Loading(Modifier.align(Alignment.Center))
                model.cards.isEmpty() && !model.loadFailed -> EmptyState(Icons.Outlined.CheckCircle, "Nothing needs you",
                    "When a bot or an agent needs your answer, it shows here.", modifier = Modifier.align(Alignment.Center))
                else -> LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    if (model.loadFailed) item {
                        UnreachableNotice(null, null, { scope.launch { model.load() } }, Modifier.cardSurface(c).padding(14.dp))
                    }
                    items(model.cards, key = { it.id }) { card -> // in arrival order: a new card comes in at the end
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            GroupHeading(who(card), Modifier.padding(start = 6.dp))
                            CardView(card, card.id in model.answering, model.note(card),
                                onAnswer = { o -> scope.launch { model.answer(card, o) } },
                                onSettle = { if (model.note(card) == CardNote.failed) model.clearFailure(card) else model.dismiss(card) },
                                changed = card.id in model.changed)
                        }
                    }
                }
            }
        }
    }
}
