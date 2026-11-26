package com.waifucave.moss.phone.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.ArrowCircleDown
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.waifucave.moss.phone.model.*
import com.waifucave.moss.phone.vm.CardNote
import com.waifucave.moss.phone.vm.CardsModel
import com.waifucave.moss.phone.vm.ConversationModel
import kotlinx.coroutines.launch

/** For pictures: what the composer starts with (real runs pass none). */
data class ComposerPreset(
    val draft: String? = null, val focus: Boolean = false, val picker: Boolean = false,
    /** A sample file staged at the start; [bigFile] one over the limit, for the refusal (the fake build's pictures). */
    val file: PresetFile? = null, val bigFile: PresetFile? = null,
)

/** A file a picture stages: a name and a size; its bytes are zeros (never read from anywhere). */
data class PresetFile(val name: String, val size: Long)

private sealed class Item {
    data class Divider(val key: String, val text: String) : Item()
    data class Msg(val m: ChatMessage, val gapAbove: Boolean) : Item()
    data class CardItem(val card: Card) : Item()
    data object Status : Item()
}

/**
 * A conversation: messages, the turn's one status line, the cards that wait in it, and the composer. It serves a bot's
 * conversation and a coding session alike; the header is the bot's face and name, or the session's title, agent and mark.
 */
@Composable
fun ConversationScreen(model: ConversationModel, cards: CardsModel, onBack: () -> Unit, preset: ComposerPreset = ComposerPreset(), startsAtTop: Boolean = false) {
    val c = MossTheme.colors
    val now = nowMs()
    val scope = rememberCoroutineScope()
    var pickerOpen by remember { mutableStateOf(preset.picker) }
    val density = LocalDensity.current
    LaunchedEffect(model) { model.run() }
    LaunchedEffect(preset.draft) { preset.draft?.let { model.draft = it } }
    LaunchedEffect(model.offers != null) {
        if (model.offers == null) return@LaunchedEffect
        preset.file?.let { f -> if (model.stagedFiles.isEmpty()) model.stageFile(f.name, f.size) { ByteArray(f.size.toInt()) } }
        preset.bigFile?.let { f -> model.stageFile(f.name, f.size) { null } }
    }

    val waitingCards = cards.cards.filter { card ->
        when (val s = model.source) {
            is ConversationModel.Source.OfBot -> card.bot == s.bot.id || card.session == s.bot.mainSession
            is ConversationModel.Source.OfSession -> card.session == s.session.id
        }
    }
    val speaker = when (val s = model.source) {
        is ConversationModel.Source.OfBot -> s.bot.name
        is ConversationModel.Source.OfSession -> AgentLook.of(s.session.backend).name
    }
    val rows = buildList<Item> {
        model.messages.forEachIndexed { i, m ->
            val prev = model.messages.getOrNull(i - 1)
            if (prev == null || m.at - prev.at > 30 * 60_000) add(Item.Divider("d-" + m.id, TimeText.divider(m.at, now)))
            add(Item.Msg(m, prev != null && prev.role != m.role))
        }
        waitingCards.forEach { add(Item.CardItem(it)) }
        if (model.statusLine != null) add(Item.Status)
    }
    val list = rememberLazyListState()
    // A card with live buttons on screen holds the list still: no scroll to the newest message moves it under the finger.
    // A card whose place in the conversation changed (a message came in above it) waits again before it takes a press.
    val cardPlaces = rows.withIndex().filter { it.value is Item.CardItem }.associate { (it.value as Item.CardItem).card.id to it.index }
    var lastPlaces by remember { mutableStateOf(cardPlaces) }
    LaunchedEffect(cardPlaces) {
        for ((id, at) in cardPlaces) if (lastPlaces[id] != null && lastPlaces[id] != at) cards.cards.firstOrNull { it.id == id }?.let(cards::rearm)
        lastPlaces = cardPlaces
    }
    LaunchedEffect(rows.size) {
        if (startsAtTop || rows.isEmpty()) return@LaunchedEffect
        val liveCardShown = list.layoutInfo.visibleItemsInfo.any { info ->
            (info.key as? String)?.removePrefix("c-")?.takeIf { (info.key as String).startsWith("c-") }
                ?.let { id -> cards.cards.firstOrNull { it.id == id }?.let { cards.note(it) == null } } == true
        }
        if (!liveCardShown) list.scrollToItem(rows.size - 1 + (if (model.hasEarlier) 1 else 0))
    }

    Column(Modifier.fillMaxSize().background(c.background).systemBarsPadding()) {
        ConversationHeader(model, onBack)
        // The composer is measured first and its height handed to the list, the fade and the picker in the same pass
        // (no size written to state during layout and read back by a sibling).
        ComposerOverlay(
            Modifier.weight(1f).fillMaxWidth(),
            body = { composerH ->
                Box(Modifier.fillMaxSize()) {
                LazyColumn(
                    state = list, modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = composerH + 8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.Bottom),
                ) {
                    if (model.hasEarlier) item("earlier") {
                        TextButton(onClick = { scope.launch { model.loadEarlier() } }, modifier = Modifier.fillMaxWidth()) {
                            Text("Show earlier messages", style = MossType.footnote, color = c.text)
                        }
                    }
                    if (model.messages.isEmpty() && model.errorText == null) item("empty") {
                        Text(
                            if (model.source is ConversationModel.Source.OfBot) "This is the start of your conversation with ${model.title}." else "Nothing has been said in this session yet.",
                            style = MossType.footnote, color = c.secondary, modifier = Modifier.fillMaxWidth().padding(top = 40.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                    }
                    items(rows, key = {
                        when (it) { is Item.Divider -> it.key; is Item.Msg -> "m-" + it.m.id; is Item.CardItem -> "c-" + it.card.id; Item.Status -> "status" }
                    }) { item ->
                        when (item) {
                            is Item.Divider -> Text(item.text, style = MossType.footnote, color = c.secondary,
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp).semantics { heading() })
                            is Item.Msg -> MessageRow(item.m, speaker, Modifier.padding(top = if (item.gapAbove) 6.dp else 0.dp))
                            is Item.CardItem -> CardView(item.card, item.card.id in cards.answering, cards.note(item.card),
                                onAnswer = { o -> scope.launch { cards.answer(item.card, o) } },
                                onSettle = { if (cards.note(item.card) == CardNote.failed) cards.clearFailure(item.card) else cards.dismiss(item.card) },
                                changed = item.card.id in cards.changed, wait = cards.waitLeft(item.card), waitKey = cards.armedAt[item.card.id], onOpen = { f -> cards.open(item.card, f) }, onScrolled = { o, e -> cards.scrolled(item.card, o, e) }, refusal = cards.refusals[item.card.id],
                                modifier = Modifier.padding(top = 6.dp))
                            Item.Status -> StatusLine(model.statusLine ?: "", Modifier.padding(start = 4.dp, top = 2.dp))
                        }
                    }
                }
                    // What sits under the composer fades into the canvas, so the floating pill reads on any message.
                    Box(
                        Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(composerH + 12.dp)
                            .background(Brush.verticalGradient(listOf(c.background.copy(alpha = 0f), c.background.copy(alpha = 0.92f), c.background)))
                    )
                    if (pickerOpen) {
                        Box(Modifier.fillMaxSize().clickable(MutableInteractionSource(), null) { pickerOpen = false }.clearAndSetSemantics {})
                    }
                }
            },
            composer = {
                Column(Modifier.fillMaxWidth().imePadding()) {
                    model.errorText?.let { e ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.ErrorOutline, null, tint = c.secondary, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(e, style = MossType.footnote, color = c.secondary, modifier = Modifier.weight(1f))
                            if (model.failedSend != null) {
                                FilledTonalButton(onClick = { scope.launch { model.retry() } }, contentPadding = PaddingValues(horizontal = 14.dp)) {
                                    Text("Retry", style = MossType.footnote, fontWeight = FontWeight.SemiBold)
                                }
                            }
                        }
                    }
                    val q = model.question
                    // A bot's question doesn't hold the bot: it stays open until answered or skipped, so it can be skipped here.
                    if (q != null) QuestionComposer(q, onSubmit = { answers -> model.answerQuestion(answers) },
                        onSkip = if (model.canSkipQuestion) ({ model.skipQuestion() }) else null)
                    else Composer(model, preset, pickerOpen, onPicker = { pickerOpen = it })
                }
            },
            overlay = { composerH ->
                if (pickerOpen && model.question == null) {
                    Box(Modifier.fillMaxSize()) {
                        ComposerPicker(model, onClose = { pickerOpen = false },
                            modifier = Modifier.align(Alignment.BottomStart).padding(start = 16.dp, end = 16.dp, bottom = composerH + 4.dp))
                    }
                }
            },
        )
    }
}

@Composable
private fun ConversationHeader(model: ConversationModel, onBack: () -> Unit) {
    val c = MossTheme.colors
    Box(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp)) {
        Box(Modifier.align(Alignment.CenterStart)) { RoundButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onClick = onBack) }
        when (val s = model.source) {
            is ConversationModel.Source.OfBot -> Row(
                Modifier.align(Alignment.Center).semantics(mergeDescendants = true) { heading(); contentDescription = s.bot.name },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BotFace(s.bot.name, s.bot.face, (s.bot.state ?: BotState.idle).faceMood, 22.dp)
                Spacer(Modifier.width(8.dp))
                Text(s.bot.name, style = MossType.title, color = c.text)
            }
            is ConversationModel.Source.OfSession -> {
                Column(
                    Modifier.align(Alignment.Center).padding(horizontal = 60.dp).semantics(mergeDescendants = true) { heading() },
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(s.session.title ?: "Session", style = MossType.name.copy(fontSize = MossType.line.fontSize), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(AgentLook.of(s.session.backend).name, s.session.model).joinToString(" · "), style = MossType.small, color = c.secondary, maxLines = 1)
                }
                Box(Modifier.align(Alignment.CenterEnd).padding(end = 4.dp).size(40.dp).background(c.softButton, RoundedCornerShape(20.dp)), contentAlignment = Alignment.Center) {
                    AgentMark(s.session.backend, 26.dp)
                }
            }
        }
    }
}

/** Links in a message are coloured, not underlined. */
private val URL = Regex("""https?://[^\s]+[^\s.,;:!?)"']""")

@Composable
private fun linked(text: String): AnnotatedString {
    val link = MossTheme.colors.link
    return buildAnnotatedString {
        var at = 0
        for (m in URL.findAll(text)) {
            append(text.substring(at, m.range.first))
            pushLink(LinkAnnotation.Url(m.value, TextLinkStyles(SpanStyle(color = link))))
            append(m.value)
            pop()
            at = m.range.last + 1
        }
        append(text.substring(at))
    }
}

@Composable
private fun MessageRow(message: ChatMessage, speaker: String, modifier: Modifier = Modifier) {
    val c = MossTheme.colors
    val shape = RoundedCornerShape(18.dp)
    when (message.role) {
        MessageRole.user -> Column(
            modifier.fillMaxWidth().padding(start = 64.dp).semantics(mergeDescendants = true) { contentDescription = "You: ${message.text}" },
            horizontalAlignment = Alignment.End,
        ) {
            Text(message.text, style = MossType.body, color = c.userBubbleText,
                modifier = Modifier.background(c.userBubble, shape).padding(horizontal = 14.dp, vertical = 9.dp))
            message.device?.let { Text("from $it", style = MossType.small, color = c.secondary, modifier = Modifier.padding(top = 2.dp)) }
        }
        MessageRole.bot, MessageRole.agent -> Column(modifier.fillMaxWidth().padding(end = 64.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (message.text.isNotEmpty()) {
                Text(linked(message.text), style = MossType.body.copy(color = c.text),
                    modifier = Modifier.background(c.botBubble, shape).padding(horizontal = 14.dp, vertical = 9.dp)
                        .semantics { contentDescription = "$speaker: ${message.text}" })
            }
            message.file?.let { FileCard(it) }
        }
        MessageRole.note -> Text(message.text, style = MossType.footnote, color = c.secondary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = modifier.fillMaxWidth().padding(vertical = 4.dp))
        MessageRole.question -> message.question?.let { AskedQuestionRow(it, speaker, modifier) }
    }
}

/**
 * A question where it was asked: the question and its options as asked, in the bot's own box, and below it, apart, the
 * phone's own line saying how it ended. An open one is answered in the composer's place; this row takes no answer.
 */
@Composable
private fun AskedQuestionRow(question: AskedQuestion, asker: String, modifier: Modifier = Modifier) {
    val c = MossTheme.colors
    val shape = RoundedCornerShape(14.dp)
    val status = question.state.status
    val said = status?.let { s -> s.detail?.let { "${s.title}: $it" } ?: s.title } ?: "Waiting for your answer"
    Column(
        modifier.fillMaxWidth().padding(end = 32.dp).clip(shape).border(0.5.dp, c.stroke, shape)
            .semantics(mergeDescendants = true) { contentDescription = "$asker asked: ${question.text}. $said" },
    ) {
        if (question.text.isNotEmpty()) {
            // The bot's words, in their own box: nothing in them can pass for the status below.
            Column(Modifier.fillMaxWidth().background(c.botBubble).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                question.header?.let { Text(it, style = MossType.caption, fontWeight = FontWeight.SemiBold, color = c.secondary) }
                Text(question.text, style = MossType.body, color = c.text, maxLines = 6, overflow = TextOverflow.Ellipsis)
                if (question.options.isNotEmpty()) {
                    Text(question.options.joinToString(" · "), style = MossType.footnote, color = c.secondary, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
            HorizontalDivider(color = c.stroke)
        }
        // The phone's own footer: how the question ended.
        Column(Modifier.fillMaxWidth().background(c.softButton).padding(horizontal = 12.dp, vertical = 8.dp).testTag("questionStatus"),
            verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(status?.title ?: "Waiting for your answer below", style = MossType.footnote, fontWeight = FontWeight.SemiBold, color = c.secondary)
            // The plugin's id, small and as plain text.
            status?.detail?.let { Text(it, style = MossType.small, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

/** A file a message carries, as its own card: a tile for its kind, its name and what the engine says about it. */
@Composable
private fun FileCard(file: ChatFile) {
    val c = MossTheme.colors
    val pdf = file.name.lowercase().endsWith(".pdf")
    Row(
        Modifier.cardSurface(c).padding(12.dp).semantics(mergeDescendants = true) { contentDescription = "File: ${file.name}, ${file.detail}" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(44.dp).background(if (pdf) Color(0xFFDB3333) else Color.Gray, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
            Text(if (pdf) "PDF" else file.name.substringAfterLast('.', "FILE").uppercase().take(4), style = MossType.caption, fontWeight = FontWeight.Bold, color = Color.White)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f, fill = false)) {
            Text(file.name, style = MossType.line, fontWeight = FontWeight.SemiBold, color = c.text, maxLines = 2)
            Text(file.detail, style = MossType.footnote, color = c.secondary)
        }
        Spacer(Modifier.width(20.dp))
        Icon(Icons.Outlined.ArrowCircleDown, null, tint = c.secondary, modifier = Modifier.size(24.dp))
    }
}

/**
 * The conversation's area: the composer measured first at the bottom, then the body under it and the overlay over it,
 * each given the composer's height in the same layout pass, as a scaffold does with its bars.
 */
@Composable
private fun ComposerOverlay(
    modifier: Modifier,
    body: @Composable (composerHeight: Dp) -> Unit,
    composer: @Composable () -> Unit,
    overlay: @Composable (composerHeight: Dp) -> Unit,
) {
    SubcomposeLayout(modifier) { constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val loose = Constraints(minWidth = width, maxWidth = width, minHeight = 0, maxHeight = height)
        val bar = subcompose("composer", composer).map { it.measure(loose) }
        val barHeight = bar.maxOfOrNull { it.height } ?: 0
        val barDp = barHeight.toDp()
        val full = Constraints(minWidth = width, maxWidth = width, minHeight = height, maxHeight = height)
        val under = subcompose("body") { body(barDp) }.map { it.measure(full) }
        val over = subcompose("overlay") { overlay(barDp) }.map { it.measure(full) }
        layout(width, height) {
            under.forEach { it.place(0, 0) }
            bar.forEach { it.place(0, height - it.height) }
            over.forEach { it.place(0, 0) }
        }
    }
}
