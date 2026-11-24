package com.waifucave.moss.phone.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The desktop's plain theme on Material 3: neutral greys, no blue accent and no wallpaper colours (dynamic colour is off, as
 * the owner wants no blue). The only blues are the unread dot and a link. The values follow the iPhone's `Theme`.
 */
@Immutable
data class MossColors(
    val dark: Boolean,
    val background: Color,
    val text: Color,
    val secondary: Color,
    val tertiary: Color,
    /** The person's bubble: black with white text (white with black text in dark), as the desktop draws it. */
    val userBubble: Color,
    val userBubbleText: Color,
    val botBubble: Color,
    /** The inverse of the canvas: Send, Stop and the voice orb. */
    val inverse: Color,
    val onInverse: Color,
    /** A soft round button's fill, and the composer's. */
    val softButton: Color,
    val unreadDot: Color,
    val link: Color,
    /** "Needs you". */
    val waiting: Color,
    val card: Color,
    val stroke: Color,
    val code: Color,
    val grouped: Color,
    val destructive: Color,
)

val Ink = Color(0xFF1B1D2B)

private val Light = MossColors(
    dark = false, background = Color.White, text = Color(0xFF111111), secondary = Color(0xFF8A8A8E), tertiary = Color(0xFFC4C4C7),
    userBubble = Color(0xFF121212), userBubbleText = Color.White, botBubble = Color(0xFFF0F0F0),
    inverse = Color(0xFF121212), onInverse = Color.White, softButton = Color(0xFFF3F3F3),
    unreadDot = Color(0xFF007AFF), link = Color(0xFF0D85A3), waiting = Color(0xFFFF9500),
    card = Color.White, stroke = Color(0x24000000), code = Color(0xFFF2F2F4), grouped = Color(0xFFF2F2F7), destructive = Color(0xFFE5372B),
)
private val Dark = MossColors(
    dark = true, background = Color.Black, text = Color(0xFFF2F2F2), secondary = Color(0xFF8D8D93), tertiary = Color(0xFF48484A),
    userBubble = Color(0xFFEDEDED), userBubbleText = Color(0xFF121212), botBubble = Color(0xFF2B2B2B),
    inverse = Color(0xFFEDEDED), onInverse = Color(0xFF121212), softButton = Color(0xFF2B2B2B),
    unreadDot = Color(0xFF0A84FF), link = Color(0xFF4DBFD9), waiting = Color(0xFFFF9F0A),
    card = Color(0xFF1C1C1E), stroke = Color(0x24FFFFFF), code = Color(0xFF2C2C2E), grouped = Color(0xFF000000), destructive = Color(0xFFFF453A),
)

val LocalMossColors = staticCompositionLocalOf { Light }
/** Epoch milliseconds to count times from; `null` means the real clock. The fake sets it so pictures stay still. */
val LocalNow = compositionLocalOf<Long?> { null }
/** True in pictures: faces hold their first pose and nothing shimmers. */
val LocalStill = staticCompositionLocalOf { false }

object MossTheme {
    val colors: MossColors @Composable get() = LocalMossColors.current
}

@Composable
fun nowMs(): Long = LocalNow.current ?: System.currentTimeMillis()

@Composable
fun MossTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val c = if (dark) Dark else Light
    val scheme = if (dark) darkColorScheme(
        primary = c.text, onPrimary = c.background, primaryContainer = c.softButton, onPrimaryContainer = c.text,
        secondary = c.secondary, onSecondary = c.background, secondaryContainer = Color(0xFF3A3A3C), onSecondaryContainer = c.text,
        tertiary = c.secondary, onTertiary = c.background, tertiaryContainer = c.softButton, onTertiaryContainer = c.text,
        background = c.background, onBackground = c.text, surface = c.background, onSurface = c.text,
        surfaceVariant = c.softButton, onSurfaceVariant = c.secondary, surfaceTint = Color.Transparent,
        inverseSurface = c.inverse, inverseOnSurface = c.onInverse, inversePrimary = c.background,
        error = c.destructive, onError = Color.White, outline = Color(0xFF545458), outlineVariant = Color(0xFF38383A), scrim = Color.Black,
        surfaceBright = Color(0xFF2C2C2E), surfaceDim = Color.Black, surfaceContainerLowest = Color.Black, surfaceContainerLow = Color(0xFF141414),
        surfaceContainer = Color(0xFF1C1C1E), surfaceContainerHigh = Color(0xFF242426), surfaceContainerHighest = Color(0xFF2C2C2E),
    ) else lightColorScheme(
        primary = c.text, onPrimary = c.background, primaryContainer = c.softButton, onPrimaryContainer = c.text,
        secondary = c.secondary, onSecondary = c.background, secondaryContainer = Color(0xFFE5E5EA), onSecondaryContainer = c.text,
        tertiary = c.secondary, onTertiary = c.background, tertiaryContainer = c.softButton, onTertiaryContainer = c.text,
        background = c.background, onBackground = c.text, surface = c.background, onSurface = c.text,
        surfaceVariant = c.softButton, onSurfaceVariant = c.secondary, surfaceTint = Color.Transparent,
        inverseSurface = c.inverse, inverseOnSurface = c.onInverse, inversePrimary = c.background,
        error = c.destructive, onError = Color.White, outline = Color(0xFFC6C6C8), outlineVariant = Color(0xFFE5E5EA), scrim = Color.Black,
        surfaceBright = Color.White, surfaceDim = Color(0xFFEDEDED), surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF7F7F7),
        surfaceContainer = Color(0xFFF2F2F2), surfaceContainerHigh = Color(0xFFEDEDED), surfaceContainerHighest = Color(0xFFE6E6E6),
    )
    CompositionLocalProvider(LocalMossColors provides c) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

/** Text sizes in sp, so the system's font size scales them. */
object MossType {
    val title = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp)
    val name = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, lineHeight = 21.sp)
    val body = TextStyle(fontSize = 16.sp, lineHeight = 21.sp)
    val line = TextStyle(fontSize = 14.sp, lineHeight = 19.sp)
    val footnote = TextStyle(fontSize = 13.sp, lineHeight = 17.sp)
    val caption = TextStyle(fontSize = 12.sp, lineHeight = 15.sp)
    val small = TextStyle(fontSize = 11.sp, lineHeight = 14.sp)
}

fun hex(s: String): Color {
    val v = s.removePrefix("#").toLongOrNull(16) ?: return Color.Gray
    return Color(0xFF000000 or v)
}

/** The times the screens write, as the iPhone's `TimeText`. The zone and locale are the phone's own unless given. */
object TimeText {
    private fun zoned(at: Long, zone: ZoneId) = Instant.ofEpochMilli(at).atZone(zone)
    private fun clock(locale: Locale) = DateTimeFormatter.ofPattern("h:mm a", locale)

    /** The list's stamp: the time today ("8:41 AM"), "Yesterday", the weekday, then the date. */
    fun stamp(at: Long, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val d = zoned(at, zone); val today = zoned(now, zone).toLocalDate()
        if (d.toLocalDate() == today) return d.format(clock(locale))
        if (d.toLocalDate() == today.minusDays(1)) return "Yesterday"
        if (now - at < 6 * 86_400_000L) return d.format(DateTimeFormatter.ofPattern("EEEE", locale))
        return d.format(DateTimeFormatter.ofPattern("MMM d", locale))
    }
    /** The centred time above a run of messages: the time, with "Yesterday" or the date before it when not today. */
    fun divider(at: Long, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val d = zoned(at, zone); val t = d.format(clock(locale))
        if (d.toLocalDate() == zoned(now, zone).toLocalDate()) return t
        return stamp(at, now, zone, locale) + " " + t
    }
    /** "2 hours ago", "in 5 minutes". */
    fun relative(at: Long, now: Long): String {
        val s = (now - at) / 1000
        val past = s >= 0
        val a = kotlin.math.abs(s)
        val (n, unit) = when {
            a < 60 -> return if (past) "just now" else "in a moment"
            a < 3600 -> a / 60 to "minute"
            a < 86400 -> a / 3600 to "hour"
            else -> a / 86400 to "day"
        }
        val words = "$n $unit" + if (n == 1L) "" else "s"
        return if (past) "$words ago" else "in $words"
    }
}
