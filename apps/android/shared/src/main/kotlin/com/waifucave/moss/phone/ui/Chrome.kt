package com.waifucave.moss.phone.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** The system's font size is one of the accessibility sizes: layouts stack what sat side by side. */
@Composable
fun largeText(): Boolean = LocalDensity.current.fontScale >= 1.6f

/** A light round button, as in the owner's reference: 40 dp in a 48 dp touch area, the soft fill of the canvas. */
@Composable
fun RoundButton(icon: ImageVector, label: String, badge: Int = 0, onClick: () -> Unit) {
    val c = MossTheme.colors
    Box(
        Modifier.size(48.dp).clickable(onClickLabel = null, role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(40.dp).background(c.softButton, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = c.text, modifier = Modifier.size(22.dp))
        }
        if (badge > 0) {
            Box(
                Modifier.align(Alignment.TopEnd).padding(top = 2.dp, end = 2.dp).defaultMinSize(18.dp, 18.dp)
                    .background(c.waiting, CircleShape).padding(horizontal = 5.dp),
                contentAlignment = Alignment.Center,
            ) { Text("$badge", style = MossType.small, fontWeight = FontWeight.Bold, color = Color.White) }
        }
    }
}

/** The top row of both apps: the person's initial (Settings) at the left; the bell (only while something waits), search and plus at the right. */
@Composable
fun TopBar(waiting: Int, plusLabel: String, onSettings: () -> Unit, onBell: () -> Unit, onSearch: () -> Unit, onPlus: () -> Unit) {
    val c = MossTheme.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(48.dp).clickable(role = Role.Button, onClick = onSettings).semantics { contentDescription = "Settings" },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(40.dp).background(c.text, CircleShape), contentAlignment = Alignment.Center) {
                Text("Y", color = c.background, style = MossType.title)
            }
        }
        Spacer(Modifier.weight(1f))
        if (waiting > 0) RoundButton(Icons.Outlined.Notifications, if (waiting == 1) "1 thing needs you" else "$waiting things need you", waiting, onBell)
        RoundButton(Icons.Filled.Search, "Search", onClick = onSearch)
        RoundButton(Icons.Filled.Add, plusLabel, onClick = onPlus)
    }
}

@Composable
fun SearchField(text: String, onText: (String) -> Unit, prompt: String, onCancel: () -> Unit) {
    val c = MossTheme.colors
    val focus = remember { FocusRequester() }
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).background(c.softButton, CircleShape).padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Search, null, tint = c.secondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Box(Modifier.weight(1f)) {
                if (text.isEmpty()) Text(prompt, style = MossType.body, color = c.secondary, maxLines = 1)
                BasicTextField(
                    text, onText, singleLine = true, textStyle = MossType.body.copy(color = c.text), cursorBrush = SolidColor(c.text),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = prompt },
                )
            }
        }
        TextButton(onClick = onCancel) { Text("Cancel", color = c.text) }
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

/** The dot at a face's lower right: blue for unread. */
@Composable
fun UnreadDot(size: Dp, modifier: Modifier = Modifier) {
    val c = MossTheme.colors
    Box(modifier.size(size + 4.dp).background(c.background, CircleShape).padding(2.dp).background(c.unreadDot, CircleShape))
}

@Composable
fun WaitingDot(size: Dp, modifier: Modifier = Modifier) {
    val c = MossTheme.colors
    Box(modifier.size(size + 4.dp).background(c.background, CircleShape).padding(2.dp).background(c.waiting, CircleShape))
}

/** "Needs you", before a row's last line. */
@Composable
fun NeedsYouTag() {
    val c = MossTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).background(c.waiting, CircleShape))
        Spacer(Modifier.width(4.dp))
        Text("Needs you", style = MossType.line, fontWeight = FontWeight.Medium, color = c.waiting, maxLines = 1)
    }
}

/** The turn's one plain status line ("Alpha is working"): a line of text with a shimmer, still when animations are off. */
@Composable
fun StatusLine(text: String, modifier: Modifier = Modifier) {
    val c = MossTheme.colors
    val still = LocalStill.current
    val style = MossType.line
    val mod = modifier.semantics { liveRegion = LiveRegionMode.Polite }
    if (still) {
        Text(text, style = style, color = c.secondary, modifier = mod)
    } else {
        val phase by rememberInfiniteTransition(label = "shimmer").animateFloat(
            -0.5f, 1.5f, infiniteRepeatable(tween(1600, easing = LinearEasing), RepeatMode.Restart), label = "phase",
        )
        val brush = Brush.horizontalGradient(
            0f to c.secondary, (phase - 0.25f).coerceIn(0f, 1f) to c.secondary, phase.coerceIn(0f, 1f) to c.text,
            (phase + 0.25f).coerceIn(0f, 1f) to c.secondary, 1f to c.secondary,
        )
        Text(text, style = style.copy(brush = brush), modifier = mod)
    }
}

/** What a real link needs to say: the computer can't be reached, and what the person can do about it. */
@Composable
fun UnreachableNotice(computer: String?, since: Long?, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val c = MossTheme.colors
    val now = nowMs()
    Column(modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.WifiOff, null, tint = c.text, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Text("Can't reach ${computer ?: "your computer"}", style = MossType.title, color = c.text, modifier = Modifier.semantics { heading() })
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "Check that it is on and awake, and that it has a network connection. This phone and your computer don't need to be on the same network.",
            style = MossType.line, color = c.secondary,
        )
        if (since != null) {
            Spacer(Modifier.height(6.dp))
            Text("Last connected ${TimeText.relative(since, now)}.", style = MossType.footnote, color = c.secondary)
        }
        Spacer(Modifier.height(10.dp))
        FilledTonalButton(onClick = onRetry, modifier = Modifier.fillMaxWidth()) { Text("Try again") }
    }
}

/** A plain empty or loading state in the middle of a screen. */
@Composable
fun EmptyState(icon: ImageVector?, title: String, text: String? = null, action: Pair<String, () -> Unit>? = null, modifier: Modifier = Modifier) {
    val c = MossTheme.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (icon != null) Icon(icon, null, tint = c.secondary, modifier = Modifier.size(48.dp))
        Spacer(Modifier.height(12.dp))
        Text(title, style = MossType.title.copy(fontSize = MossType.title.fontSize * 1.15f), color = c.text, textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() })
        if (text != null) {
            Spacer(Modifier.height(4.dp))
            Text(text, style = MossType.line, color = c.secondary, textAlign = TextAlign.Center)
        }
        if (action != null) {
            Spacer(Modifier.height(14.dp))
            FilledTonalButton(onClick = action.second) { Text(action.first) }
        }
    }
}

@Composable
fun Loading(modifier: Modifier = Modifier) {
    val c = MossTheme.colors
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (LocalStill.current) CircularProgressIndicator(progress = { 0.3f }, color = c.secondary, trackColor = c.softButton)
        else CircularProgressIndicator(color = c.secondary)
        Spacer(Modifier.height(10.dp))
        Text("Loading", style = MossType.line, color = c.secondary)
    }
}

/** A small grey heading over a group of rows. */
@Composable
fun GroupHeading(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MossType.footnote, color = MossTheme.colors.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = modifier.semantics { heading() })
}

/** The rounded, outlined surface cards and file tiles sit on. */
fun Modifier.cardSurface(c: MossColors, radius: Dp = 18.dp): Modifier =
    this.background(c.card, RoundedCornerShape(radius)).border(0.5.dp, c.stroke, RoundedCornerShape(radius))
