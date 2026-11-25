package com.waifucave.moss.phone.ui

import android.annotation.SuppressLint
import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.runtime.withFrameNanos
import com.waifucave.moss.phone.face.LivingBots
import com.waifucave.moss.phone.model.BotFaceSpec
import com.waifucave.moss.phone.model.BotState
import kotlinx.coroutines.isActive
import kotlin.coroutines.coroutineContext
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

enum class FaceMood { idle, thinking, working, asking, asleep }

val BotState.faceMood: FaceMood
    get() = when (this) { BotState.idle -> FaceMood.idle; BotState.thinking -> FaceMood.thinking; BotState.asleep, BotState.paused -> FaceMood.asleep }

/** The system's "remove animations" setting (Settings > Accessibility): the faces then hold still, as Reduce Motion on iPhone. */
@Composable
private fun animationsOff(): Boolean {
    val context = LocalContext.current
    return remember { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
}

private class FaceFit(var made: Boolean = false, var fit: Double = 1.0, var ax: Double = 500.0, var ay: Double = 500.0)

/** The canvas is a little larger than the face's box, so a squash or a bounce is not cut off (the iPhone's `canvasScale`). */
private const val CANVAS_SCALE = 1.12f

/**
 * A bot's own living face, drawn by the kit ([LivingBots]) as the desktop draws it. Still when animations are off, and in
 * pictures. Decorative to TalkBack: the row or button it sits in names the bot.
 */
@Composable
fun BotFace(name: String, face: BotFaceSpec?, mood: FaceMood = FaceMood.idle, size: Dp, modifier: Modifier = Modifier) {
    val bot = remember(name, face) { LivingBots.makeBot(name, face?.shape, face?.color, face?.eyes, face?.temper) }
    val life = remember(bot) { LivingBots.wake(bot, mood.name) }
    val fit = remember(bot) { FaceFit() }
    var frame by remember { mutableLongStateOf(0L) }
    val still = LocalStill.current || LocalInspectionMode.current || animationsOff()
    val dark = MossTheme.colors.dark
    val px = size.value.toDouble()

    LaunchedEffect(life, mood) { LivingBots.setMood(life, mood.name) }
    if (!still) {
        LaunchedEffect(life) {
            var last = 0L
            // 15 frames a second for list faces, 30 for the large ones, as on the iPhone.
            val interval = if (px > 80) 33_000_000L else 66_000_000L
            while (coroutineContext.isActive) {
                withFrameNanos { now ->
                    if (last == 0L) last = now
                    if (now - last >= interval) {
                        LivingBots.step(bot, life, min((now - last) / 1e9, 0.1))
                        last = now
                        frame = now
                    }
                }
            }
        }
    }

    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.requiredSize(size * CANVAS_SCALE).clearAndSetSemantics {}) {
            if (frame < 0L) return@Canvas
            val pose = LivingBots.poseOf(bot, life, px, dark)
            if (!fit.made) {
                fit.made = true
                val xs = pose.outline.map { it[0] }; val ys = pose.outline.map { it[1] }
                val ext = max((xs.max() - xs.min()) * pose.sx, (ys.max() - ys.min()) * pose.sy)
                fit.fit = if (ext > 1) (1000 / CANVAS_SCALE) / ext else 1.0
                fit.ax = pose.x + ((xs.min() + xs.max()) / 2 - 500) * pose.sx
                fit.ay = pose.y + ((ys.min() + ys.max()) / 2 - pose.foot) * pose.sy
            }
            val side = min(this.size.width, this.size.height)
            val s = side / 1000.0
            val ox = (this.size.width - side) / 2.0; val oy = (this.size.height - side) / 2.0
            val cr = cos(pose.roll); val sr = sin(pose.roll)
            fun map(x: Double, y: Double): Pair<Float, Float> {
                // translate(-500, -foot), scale(sx, sy), rotate(roll), translate(x, y), then fit the shape into the box.
                val qx = (x - 500) * pose.sx; val qy = (y - pose.foot) * pose.sy
                val rx = qx * cr - qy * sr + pose.x; val ry = qx * sr + qy * cr + pose.y
                val fx = (rx - fit.ax) * fit.fit + 500; val fy = (ry - fit.ay) * fit.fit + 500
                return (ox + fx * s).toFloat() to (oy + fy * s).toFloat()
            }
            val body = Path()
            pose.outline.forEachIndexed { i, p -> val (x, y) = map(p[0], p[1]); if (i == 0) body.moveTo(x, y) else body.lineTo(x, y) }
            body.close()
            drawPath(body, fillColor(pose.fill))
            for (eye in pose.eyes) {
                val path = Path()
                var i = 0
                while (i + 1 < eye.size) { val (x, y) = map(eye[i], eye[i + 1]); if (i == 0) path.moveTo(x, y) else path.lineTo(x, y); i += 2 }
                path.close()
                drawPath(path, Ink)
            }
        }
    }
}

/** The kit gives a `#rrggbb` or an `rgb(r,g,b)` fill. */
private fun fillColor(s: String): Color {
    if (s.startsWith("#")) return hex(s)
    val n = s.filter { it.isDigit() || it == ',' || it == '.' }.split(',').mapNotNull { it.toFloatOrNull() }
    return if (n.size >= 3) Color(n[0] / 255f, n[1] / 255f, n[2] / 255f) else Color.Gray
}

/** How an agent is named and drawn, as `agent.backends` serves it (`docs/agent-marks.md`). */
data class AgentLook(val id: String, val name: String, val colorHex: String?, /** One-colour marks are tinted. */ val template: Boolean) {
    val initial: String get() = name.firstOrNull()?.uppercase() ?: "?"

    companion object {
        const val mossCode = "moss-code"
        private val known = listOf(
            AgentLook("moss-code", "MOSS Code", "#E5A72E", false), AgentLook("claude-code", "Claude Code", "#D97757", false),
            AgentLook("codex", "Codex", "#484FF6", true), AgentLook("gemini", "Gemini", "#3488FB", false),
            AgentLook("antigravity", "Antigravity", "#3186FF", false), AgentLook("cursor", "Cursor", null, true),
            AgentLook("opencode", "OpenCode", null, true), AgentLook("deepseek", "DeepSeek", "#4D6BFE", false),
            AgentLook("grok", "Grok", null, true), AgentLook("copilot", "Copilot", "#218BFF", true),
            AgentLook("kimi", "Kimi", "#1783FF", false), AgentLook("qwen", "Qwen", "#082DFF", false), AgentLook("devin", "Devin", null, true),
        ).associateBy { it.id }

        fun of(backend: String?): AgentLook {
            if (backend == null) return AgentLook("", "Agent", null, false)
            return known[backend] ?: AgentLook(backend, backend.replaceFirstChar { it.uppercase() }, null, false)
        }
    }
}

/**
 * An agent's mark: the shipped file `res/drawable-nodpi/agent_<id>.png` (and its `drawable-night-nodpi` twin where the mark
 * has a dark one), looked up by name so deleting a mark's file needs no code change; without one, the first letter of the
 * agent's name on its colour, as the desktop's `look.ts` does.
 */
@SuppressLint("DiscouragedApi")
@Composable
fun AgentMark(backend: String?, size: Dp, modifier: Modifier = Modifier) {
    val look = AgentLook.of(backend)
    val context = LocalContext.current
    val res = remember(look.id) {
        if (look.id.isEmpty()) 0 else context.resources.getIdentifier("agent_" + look.id.replace('-', '_'), "drawable", context.packageName)
    }
    val desc = Modifier.semantics { contentDescription = look.name }
    if (res != 0) {
        Image(
            painterResource(res), contentDescription = null,
            colorFilter = if (look.template) ColorFilter.tint(look.colorHex?.let(::hex) ?: MossTheme.colors.text) else null,
            modifier = modifier.then(desc).size(size).padding(size * 0.03f),
        )
    } else {
        Box(
            modifier.then(desc).size(size).background(look.colorHex?.let(::hex) ?: Color(0xFF8E8E93), RoundedCornerShape(size * 0.28f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(look.initial, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = (size.value * 0.5f).sp)
        }
    }
}
