package com.waifucave.moss.phone.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material.icons.outlined.SentimentSatisfied
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.waifucave.moss.phone.model.Bot
import com.waifucave.moss.phone.model.BotState
import com.waifucave.moss.phone.model.ConnectionState
import com.waifucave.moss.phone.model.SessionRow
import com.waifucave.moss.phone.vm.*
import kotlinx.coroutines.launch

private val SIDE = 20.dp

/** MOSS's first screen: a top row, three pinned faces, then plain rows. Nothing else. */
@Composable
fun BotsScreen(
    model: BotsListModel, cards: CardsModel, computer: String?,
    onSettings: () -> Unit, onBell: () -> Unit, onNew: () -> Unit, onOpen: (Bot) -> Unit,
    startSearching: Boolean = false,
) {
    val c = MossTheme.colors
    val now = nowMs()
    val scope = rememberCoroutineScope()
    val large = largeText()
    var searching by remember { mutableStateOf(startSearching) }
    var query by remember { mutableStateOf("") }
    LaunchedEffect(model) { model.run() }

    val waiting = buildSet {
        for (card in cards.cards) if (cards.note(card) == null) {
            val b = card.bot
            if (b != null) add(b) else model.rows.firstOrNull { it.bot.mainSession == card.session }?.let { add(it.id) }
        }
    }
    val q = query.trim().lowercase()
    val found = model.rows.filter { q.isEmpty() || it.bot.name.lowercase().contains(q) || (it.summary?.last?.text?.lowercase()?.contains(q) ?: false) }
    val since = (model.connection as? ConnectionState.Unreachable)?.since

    Box(Modifier.fillMaxSize().background(c.background).systemBarsPadding()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item("top") { TopBar(cards.waitingCount, "New bot", onSettings, onBell, { searching = true }, onNew) }
            if (searching) item("search") { SearchField(query, { query = it }, "Search bots and what was said") { searching = false; query = "" } }
            if (model.loadFailed || model.connection != ConnectionState.Connected) item("unreachable") {
                UnreachableNotice(computer, since, { scope.launch { model.load() } }, Modifier.padding(horizontal = SIDE, vertical = 8.dp))
            }
            if (!searching && model.pinned.isNotEmpty()) item("pinned") {
                val perRow = if (large) 1 else 3
                Column(Modifier.padding(start = SIDE, end = SIDE, top = 18.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    model.pinned.chunked(perRow).forEach { line ->
                        Row(Modifier.fillMaxWidth()) {
                            line.forEach { row -> PinnedFace(row, row.id in waiting, { onOpen(row.bot) }, { model.togglePin(row.id) }, Modifier.weight(1f)) }
                            repeat(perRow - line.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
            }
            items(if (searching) found else model.others, key = { it.id }) { row ->
                BotListRow(row, now, row.id in waiting, model.isPinned(row.id), { onOpen(row.bot) }, { model.togglePin(row.id) })
            }
        }
        when {
            !model.loaded -> Loading(Modifier.align(Alignment.Center))
            model.rows.isEmpty() && !model.loadFailed -> EmptyState(Icons.Outlined.SentimentSatisfied, "No bots yet", "Make a bot on your computer and it shows here.",
                modifier = Modifier.align(Alignment.Center))
            searching && q.isNotEmpty() && found.isEmpty() -> EmptyState(Icons.Outlined.SearchOff, "No results for “$query”", "Check the spelling or try a new search.",
                modifier = Modifier.align(Alignment.Center))
        }
    }
}

private fun moodOf(row: BotRow): FaceMood = if (row.statusLine != null) FaceMood.working else (row.bot.state ?: BotState.idle).faceMood

@Composable
private fun PinnedFace(row: BotRow, waiting: Boolean, onOpen: () -> Unit, onUnpin: () -> Unit, modifier: Modifier) {
    val c = MossTheme.colors
    var menu by remember { mutableStateOf(false) }
    val label = row.bot.name + (if (waiting) ", needs you" else "") + (if (row.unread) ", unread" else "") + (row.statusLine?.let { ", $it" } ?: "")
    Box(modifier) {
        Column(
            Modifier.fillMaxWidth().combinedClickable(onClick = onOpen, onLongClick = { menu = true })
                .clearAndSetSemantics {
                    contentDescription = label; role = Role.Button
                    customActions = listOf(CustomAccessibilityAction("Unpin") { onUnpin(); true })
                },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box {
                BotFace(row.bot.name, row.bot.face, moodOf(row), 76.dp)
                if (row.unread) UnreadDot(12.dp, Modifier.align(Alignment.BottomEnd))
                if (waiting) WaitingDot(12.dp, Modifier.align(Alignment.TopEnd))
            }
            Spacer(Modifier.height(8.dp))
            Text(row.bot.name, style = MossType.footnote, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        DropdownMenu(menu, { menu = false }) { DropdownMenuItem({ Text("Unpin") }, onClick = { menu = false; onUnpin() }) }
    }
}

@Composable
private fun BotListRow(row: BotRow, now: Long, waiting: Boolean, pinned: Boolean, onOpen: () -> Unit, onPin: () -> Unit) {
    val c = MossTheme.colors
    val large = largeText()
    var menu by remember { mutableStateOf(false) }
    val line = row.statusLine ?: when (row.bot.state) {
        BotState.asleep -> row.summary?.last?.text ?: "Asleep: no computer that can run it is on."
        BotState.paused -> "Paused"
        else -> row.summary?.last?.text ?: "No messages yet"
    }
    val pinLabel = if (pinned) "Unpin" else "Pin to the top"
    Box {
        Row(
            Modifier.fillMaxWidth().combinedClickable(onClick = onOpen, onLongClick = { menu = true })
                .clearAndSetSemantics {
                    contentDescription = "${row.bot.name}. ${if (waiting) "Needs you. " else ""}$line${if (row.unread) ". Unread" else ""}"
                    role = Role.Button
                    customActions = listOf(CustomAccessibilityAction(pinLabel) { onPin(); true })
                }
                .padding(horizontal = SIDE, vertical = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box {
                BotFace(row.bot.name, row.bot.face, moodOf(row), if (large) 40.dp else 48.dp)
                if (row.unread) UnreadDot(11.dp, Modifier.align(Alignment.BottomEnd))
            }
            Spacer(Modifier.width(13.dp))
            Column(Modifier.weight(1f)) {
                if (large) {
                    Text(row.bot.name, style = MossType.name, color = c.text)
                    if (row.lastAt > 0) Text(TimeText.stamp(row.lastAt, now), style = MossType.line, color = c.secondary)
                } else Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(row.bot.name, style = MossType.name, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (row.lastAt > 0) Text(TimeText.stamp(row.lastAt, now), style = MossType.line, color = c.secondary)
                }
                Spacer(Modifier.height(2.dp))
                if (large) {
                    if (waiting) NeedsYouTag()
                    Text(line, style = MossType.line, color = c.secondary, maxLines = 3, overflow = TextOverflow.Ellipsis)
                } else Row(verticalAlignment = Alignment.CenterVertically) {
                    if (waiting) { NeedsYouTag(); Spacer(Modifier.width(6.dp)) }
                    Text(line, style = MossType.line, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        DropdownMenu(menu, { menu = false }) { DropdownMenuItem({ Text(pinLabel) }, onClick = { menu = false; onPin() }) }
    }
}

/**
 * MOSS Code's first screen: the same top row and plain rows as MOSS, with a session's mark where a bot's face is, grouped by
 * project folder under small grey headings.
 */
@Composable
fun SessionsScreen(
    model: SessionsListModel, cards: CardsModel, computer: String?,
    onSettings: () -> Unit, onBell: () -> Unit, onNew: () -> Unit, onOpen: (SessionRow) -> Unit,
) {
    val c = MossTheme.colors
    val now = nowMs()
    val scope = rememberCoroutineScope()
    var searching by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    LaunchedEffect(model) { model.run() }
    val waiting = cards.cards.filter { cards.note(it) == null }.mapNotNull { it.session }.toSet()
    val q = query.trim().lowercase()
    val groups = if (q.isEmpty()) model.groups else model.groups.mapNotNull { g ->
        val hit = g.sessions.filter { (it.title ?: "").lowercase().contains(q) || g.project.lowercase().contains(q) || (it.branch ?: "").lowercase().contains(q) }
        if (hit.isEmpty()) null else SessionGroup(g.project, hit)
    }
    val since = (model.connection as? ConnectionState.Unreachable)?.since

    Box(Modifier.fillMaxSize().background(c.background).systemBarsPadding()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item("top") { TopBar(cards.waitingCount, "New session", onSettings, onBell, { searching = true }, onNew) }
            if (searching) item("search") { SearchField(query, { query = it }, "Search sessions") { searching = false; query = "" } }
            if (model.loadFailed || model.connection != ConnectionState.Connected) item("unreachable") {
                UnreachableNotice(computer, since, { scope.launch { model.load() } }, Modifier.padding(horizontal = SIDE, vertical = 8.dp))
            }
            for (g in groups) {
                item("h-" + g.project) { GroupHeading(g.project, Modifier.padding(start = SIDE + 4.dp, end = SIDE, top = 18.dp, bottom = 2.dp)) }
                items(g.sessions, key = { it.id }) { s -> SessionListRow(s, now, s.id in waiting) { onOpen(s) } }
            }
        }
        when {
            !model.loaded -> Loading(Modifier.align(Alignment.Center))
            model.groups.isEmpty() && !model.loadFailed -> EmptyState(Icons.Outlined.Terminal, "No sessions", "Start one here, or on your computer.",
                "New session" to onNew, Modifier.align(Alignment.Center))
            searching && q.isNotEmpty() && groups.isEmpty() -> EmptyState(Icons.Outlined.SearchOff, "No results for “$query”", "Check the spelling or try a new search.",
                modifier = Modifier.align(Alignment.Center))
        }
    }
}

@Composable
private fun SessionListRow(s: SessionRow, now: Long, waiting: Boolean, onOpen: () -> Unit) {
    val c = MossTheme.colors
    val large = largeText()
    val needs = waiting || s.badge == SessionBadge.needsYou
    val detail = listOfNotNull(s.model, s.branch).joinToString(" · ")
    val look = AgentLook.of(s.backend)
    Row(
        Modifier.fillMaxWidth().combinedClickable(onClick = onOpen)
            .clearAndSetSemantics {
                contentDescription = "${s.title ?: "Untitled"}. ${look.name}${s.model?.let { ", $it" } ?: ""}. ${if (needs) "Needs you" else s.badge.text}"
                role = Role.Button
            }
            .padding(horizontal = SIDE, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AgentMark(s.backend, 48.dp)
        Spacer(Modifier.width(13.dp))
        Column(Modifier.weight(1f)) {
            if (large) {
                Text(s.title ?: "Untitled", style = MossType.name, color = c.text, maxLines = 3)
                Text(TimeText.stamp(s.updatedAt, now), style = MossType.line, color = c.secondary)
            } else Row(verticalAlignment = Alignment.CenterVertically) {
                Text(s.title ?: "Untitled", style = MossType.name, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Text(TimeText.stamp(s.updatedAt, now), style = MossType.line, color = c.secondary)
            }
            Spacer(Modifier.height(2.dp))
            if (large) {
                if (needs) NeedsYouTag()
                else if (s.badge != SessionBadge.none) Text(s.badge.text, style = MossType.line, fontWeight = FontWeight.Medium, color = c.text)
                Text(detail, style = MossType.line, color = c.secondary, maxLines = 3, overflow = TextOverflow.Ellipsis)
            } else Row(verticalAlignment = Alignment.CenterVertically) {
                if (needs) { NeedsYouTag(); Spacer(Modifier.width(6.dp)) }
                else if (s.badge != SessionBadge.none) { Text(s.badge.text, style = MossType.line, fontWeight = FontWeight.Medium, color = c.text); Spacer(Modifier.width(6.dp)) }
                Text(detail, style = MossType.line, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

