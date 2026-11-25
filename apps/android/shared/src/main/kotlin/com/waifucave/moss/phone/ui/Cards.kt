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
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
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
import com.waifucave.moss.phone.vm.ARM_MS
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

    data class LineCut(val shown: String, val hiddenLines: Int, val hiddenChars: Int)
    /** At most `lines` lines and `limit` characters (escaped), and how much was left out of each. */
    fun cutLines(s: String, limit: Int, lines: Int): LineCut {
        val v = visible(s)
        val all = v.split('\n')
        val byLines = if (all.size > lines) all.take(lines).joinToString("\n") else v
        val shown = byLines.take(limit)
        return LineCut(shown, maxOf(0, all.size - lines), maxOf(0, v.length - shown.length))
    }
}

/**
 * Every sealed field the protocol names (`CARD_FIELD_NAMES`, `packages/protocol/src/approvals.ts`), in its order; a test
 * reads that list from the protocol, so a new field fails it until it is drawn here. A card is drawn with every field it
 * carries: the title and what it asks at the top, the rest each under the label the desktop's card gives it
 * (`FIELD_TITLES` in apps/desktop/src/main/sealed-pages.ts). `rule` has no title there: it is what an "always" answer
 * would store, how far it reaches (approvals.ts), which the desktop says as an "Always allow: …" sentence (card-summary.ts
 * `ruleSentence`); here it heads the rows as "What "Always allow" covers".
 */
val CARD_FIELDS = listOf("title", "what", "command", "computer", "risk", "reason", "source", "host", "paths", "detail", "expires", "rule")
val CARD_FIELD_LABELS = mapOf(
    "title" to "What", "what" to "Tool", "command" to "Command", "computer" to "Computer", "risk" to "Risk", "reason" to "Why",
    "source" to "From", "host" to "Site", "paths" to "Files", "detail" to "Everything it sends", "expires" to "Expires", "rule" to "What \"Always allow\" covers",
)

/** How many lines of a value show before "Show all", and the most the values take before they scroll inside the card. */
const val VALUE_LINES = 6
val FIELDS_MAX = 360.dp

/** Whether this build can draw all of a card: every field one it knows, every value of a kind it draws. */
fun Card.drawable(): Boolean =
    !hasChildren && options.isNotEmpty() && fields.all { (name, v) -> name in CARD_FIELDS && v !is SealedValue.Unsupported } && size() <= MAX_DRAWN_CHARS

/** A card larger than this, in characters over all its values, is answered on the computer: too much to read on a phone. */
const val MAX_DRAWN_CHARS = 60_000
private const val LIST_SHOWN = 8
private const val ITEM_LINES = 2
private const val ITEM_CHARS = 300
private const val ROW_LINES = 3
private const val ROW_CHARS = 300

private fun Card.size(): Int = fields.values.sumOf { v ->
    when (v) {
        is SealedValue.Text -> v.text.length
        is SealedValue.Code -> v.code.length
        is SealedValue.ListOf -> v.items.sumOf { it.length }
        is SealedValue.Rows -> v.rows.sumOf { it.label.length + it.value.length }
        SealedValue.Unsupported -> 0
    }
}

/**
 * The fields a card shows cut (some lines, characters or items left out until "Show all" is pressed). Its buttons take no
 * answer until each of them has been opened once (`CardsModel.answer` refuses until then): what the person approves is
 * what they could read.
 */
fun Card.cutFields(): Set<String> = fields.filter { (name, v) ->
    if (headedBy(name) || (name == "computer" && footerComputer() != null)) return@filter false
    when (v) {
        is SealedValue.Text -> Sealed.cutLines(v.text, TEXT_CHARS, VALUE_LINES).let { it.hiddenLines > 0 || it.hiddenChars > 0 }
        is SealedValue.Code -> Sealed.cutLines(v.code, CODE_CHARS, VALUE_LINES).let { it.hiddenLines > 0 || it.hiddenChars > 0 }
        is SealedValue.ListOf -> v.items.size > LIST_SHOWN || v.items.any { i -> Sealed.cutLines(i, ITEM_CHARS, ITEM_LINES).let { it.hiddenLines > 0 || it.hiddenChars > 0 } }
        is SealedValue.Rows -> v.rows.any { r -> Sealed.cutLines(r.value, ROW_CHARS, ROW_LINES).let { it.hiddenLines > 0 || it.hiddenChars > 0 } || Sealed.cutLines(r.label, 120, 1).let { it.hiddenLines > 0 || it.hiddenChars > 0 } }
        SealedValue.Unsupported -> false
    }
}.keys
private const val TEXT_CHARS = 600
private const val CODE_CHARS = 800

/** What heads the card: its title and what it asks, when they are plain text (anything else is drawn as a labelled field). */
internal fun Card.headedBy(name: String): Boolean = (name == "title" || name == "what") && fields[name] is SealedValue.Text

/** The computer goes in the footer when it is plain text. */
internal fun Card.footerComputer(): SealedValue.Text? = fields["computer"] as? SealedValue.Text

/** A pending card: small, never raw JSON. Its title, what it asks, the command or paths it covers, and its sealed buttons. */
@Composable
fun CardView(
    card: Card, busy: Boolean, note: CardNote?, onAnswer: (CardOption) -> Unit, onSettle: () -> Unit, modifier: Modifier = Modifier,
    changed: Boolean = false,
    /** The model's wait for this card (`CardsModel.waitLeft`) and what keys it (`CardsModel.armedAt`): the model refuses a
     *  press inside it; the buttons show it. */
    wait: Long = 0L, waitKey: Any? = null,
    /** Told each field the person opens (`CardsModel.opened`), so the model knows too. */
    onOpen: (String) -> Unit = {},
) {
    val c = MossTheme.colors
    val now = nowMs()
    val large = largeText()
    var expanded by remember(card.id, card.hash) { mutableStateOf(setOf<String>()) }
    val openField: (String) -> Unit = { name -> if (name !in expanded) { expanded = expanded + name; onOpen(name) } }
    val cut = remember(card) { card.cutFields() }
    val unopened = cut - expanded
    // A card new to the screen, or whose content just changed, takes no press for a moment: a tap meant for what was
    // there before never answers it.
    var armed by remember(card.id, card.hash) { mutableStateOf(false) }
    var drawnBefore by remember(card.id, card.hash) { mutableStateOf(false) }
    LaunchedEffect(card.id, card.hash, waitKey) {
        armed = false
        delay(maxOf(wait, if (drawnBefore) 0L else ARM_MS))
        drawnBefore = true
        armed = true
    }
    Column(
        modifier.fillMaxWidth().cardSurface(c).padding(14.dp).alpha(if (note == null || note == CardNote.failed) 1f else 0.75f),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(Sealed.visible(if (card.headedBy("title")) card.title else "Needs your answer"), style = MossType.title, color = c.text, modifier = Modifier.semantics { heading() })
            if (card.headedBy("what")) card.what?.let { Text(Sealed.visible(it), style = MossType.line, color = c.secondary) }
        }
        // The values in a bounded area of their own: however much they hold, the footer and the buttons stay on screen.
        Column(
            Modifier.fillMaxWidth().heightIn(max = FIELDS_MAX).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
        for (name in CARD_FIELDS) {
            val value = card.fields[name] ?: continue
            if (card.headedBy(name) || (name == "computer" && card.footerComputer() != null)) continue
            Labelled(name) {
                // Each value in a visible box of its own: a line in a value can never read as one of the app's labels.
                Box(Modifier.fillMaxWidth().background(c.code, RoundedCornerShape(10.dp)).padding(10.dp).testTag("card-value:$name")) {
                when (value) {
                    is SealedValue.Text -> CutText(value.text, TEXT_CHARS, expanded.contains(name), { openField(name) }, MossType.body)
                    is SealedValue.Code -> CutText(value.code, CODE_CHARS, expanded.contains(name), { openField(name) }, MossType.footnote.copy(fontFamily = FontFamily.Monospace))
                    is SealedValue.ListOf -> Column {
                        val open = expanded.contains(name)
                        val shown = if (open) value.items else value.items.take(LIST_SHOWN)
                        shown.forEach { Text(if (open) Sealed.visible(it) else Sealed.cutLines(it, ITEM_CHARS, ITEM_LINES).shown, style = MossType.footnote.copy(fontFamily = FontFamily.Monospace), color = c.text) }
                        if (!open && name in cut) TextButton(onClick = { openField(name) }, contentPadding = PaddingValues(0.dp)) {
                            val more = value.items.size - shown.size
                            Text(if (more > 0) "and $more more. Show all ${value.items.size}" else "Cut short. Show all", style = MossType.footnote.copy(textDecoration = TextDecoration.Underline), color = c.secondary)
                        }
                    }
                    is SealedValue.Rows -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        val open = expanded.contains(name)
                        value.rows.forEach { r ->
                            val label = if (open) Sealed.visible(r.label) else Sealed.cutLines(r.label, 120, 1).shown
                            val v = if (open) Sealed.visible(r.value) else Sealed.cutLines(r.value, ROW_CHARS, ROW_LINES).shown
                            if (large) Column {
                                Text(label, style = MossType.body, color = c.secondary)
                                Text(v, style = MossType.body, color = c.text)
                            } else Row {
                                Text(label, style = MossType.body, color = c.secondary)
                                Spacer(Modifier.width(12.dp).weight(1f))
                                Text(v, style = MossType.body, color = c.text)
                            }
                        }
                        if (!open && name in cut) TextButton(onClick = { openField(name) }, contentPadding = PaddingValues(0.dp)) {
                            Text("Cut short. Show all", style = MossType.footnote.copy(textDecoration = TextDecoration.Underline), color = c.secondary)
                        }
                    }
                    SealedValue.Unsupported -> Text("Can't be shown on the phone", style = MossType.footnote, color = c.secondary)
                }
                }
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
            // A card the person's own turn raised never expires (`expiresAt` reads as never): it says nothing.
            if (card.expiresAt != Long.MAX_VALUE) {
                val left = (card.expiresAt - now) / 1000
                if (left > 0) Text("Expires in ${maxOf(1, left / 60)} min", style = MossType.caption, color = c.secondary)
            }
        }
        if (changed) Text("This card changed while it was shown. Read it again before you answer.", style = MossType.footnote, color = c.secondary)
        if (!card.drawable()) {
            // A field this build can't draw: the person would approve less than what they were asked. No buttons.
            Text("Answer this one on your computer: it holds something this phone can't show.", style = MossType.footnote, color = c.secondary,
                modifier = Modifier.semantics { contentDescription = "Answer this one on your computer" })
        } else if (note == null && unopened.isNotEmpty()) {
            Text("Some of this card is cut short. Open each \"Show all\" above to answer.", style = MossType.footnote, color = c.secondary,
                modifier = Modifier.semantics { contentDescription = "Open each cut part to answer" })
        }
        if (!card.drawable()) Unit
        else if (note != null) {
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
                    onClick = { if (armed && unopened.isEmpty()) onAnswer(option) }, enabled = !busy && armed && unopened.isEmpty(), modifier = m.semantics {
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
    val cut = Sealed.cutLines(s, limit, VALUE_LINES)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(if (open) Sealed.visible(s) else cut.shown, style = style, color = c.text)
        if ((cut.hiddenLines > 0 || cut.hiddenChars > 0) && !open) {
            val what = if (cut.hiddenLines > 0) "${cut.hiddenLines} more lines" else "${cut.hiddenChars} more characters"
            TextButton(onClick = onOpen, contentPadding = PaddingValues(0.dp)) {
                Text("Cut short: $what. Show all", style = MossType.footnote.copy(textDecoration = TextDecoration.Underline), color = c.secondary)
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
                                changed = card.id in model.changed, wait = model.waitLeft(card), waitKey = model.armedAt[card.id], onOpen = { f -> model.open(card, f) })
                        }
                    }
                }
            }
        }
    }
}
