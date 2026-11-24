package com.waifucave.moss.phone.face

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sign
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The living-bots kit (`packages/plugin-sdk/src/ui/faces/living-bots.js`), ported line for line so a bot's face on Android is
 * the desktop's own: the same name gives the same shape, colour, eyes and temper, and the same life moves the same way. The
 * iPhone runs the JavaScript file itself; Android has no JavaScript engine that also runs in the JVM tests, so this is a port,
 * and `LivingBotsTest` holds it to numbers the JavaScript gave (`living-bots-golden.json`). Only the drawing-free parts are
 * here (`makeBot`, `wake`, `setMood`, `lookAt`, `poke`, `step`, `poseOf`); the canvas helpers stay on the desktop.
 */
object LivingBots {
    val PALETTE = listOf(
        "gold" to "#E5A72E", "coral" to "#F0694C", "sky" to "#4A9CEC", "mint" to "#3DBE8B", "violet" to "#9A7BF0",
        "lagoon" to "#1FB2BE", "lime" to "#A2C73B", "orchid" to "#C86FD6", "ember" to "#F4893A", "iris" to "#5F70E2",
    )
    val SHAPES = listOf("ball", "drop", "dome", "bowl", "pill", "loaf", "tile", "peak", "gem", "cup")
    val MOODS = listOf("idle", "listening", "thinking", "working", "asking", "stuck", "done", "asleep")
    val EYES = listOf("round", "tall", "dot", "calm")
    val TEMPERS = listOf("steady", "restless", "slow", "bright")
    const val INK = "#1B1D2B"

    private const val TAU = PI * 2
    private const val YAW = 1.06
    private const val PITCH = 0.6
    private const val TILT = 0.15
    private const val HOP = 235.0
    private const val EDGE = 12.0
    const val FRAME = 0.9
    private const val EYE_POINTS = 48

    // The JavaScript's clamp: no check that lo <= hi, as there.
    private fun clamp(v: Double, lo: Double, hi: Double) = if (v < lo) lo else if (v > hi) hi else v
    private fun mix(a: Double, b: Double, t: Double) = a + (b - a) * t
    private fun ease(t: Double) = t * t * (3 - 2 * t)

    /** FNV-1a over UTF-16 code units, as `hashText`. */
    fun hashText(text: String): Long {
        var h = 2166136261L.toInt()
        for (c in text) { h = h xor c.code; h *= 16777619 }
        return h.toLong() and 0xFFFFFFFFL
    }

    /** The kit's `seeded`: the same 32-bit generator. */
    class Rng(key: String) {
        private var s: Int = run { val h = hashText(key); (if (h == 0L) 1L else h).toInt() }
        operator fun invoke(): Double {
            s += 0x6d2b79f5
            var t = (s xor (s ushr 15)) * (1 or s)
            t = (t + (t xor (t ushr 7)) * (61 or t)) xor t
            return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
        }
        fun range(a: Double, b: Double) = a + (b - a) * this()
        fun <T> pick(list: List<T>): T = list[floor(this() * list.size).toInt() % list.size]
    }

    /** The outline round a set of circles: arcs where it touches them, straight runs between. */
    private fun wrap(circles: List<DoubleArray>): List<DoubleArray> {
        val pts = ArrayList<DoubleArray>()
        for (c in circles) for (i in 0 until 120) {
            pts.add(doubleArrayOf(c[0] + c[2] * cos((i / 120.0) * TAU), c[1] + c[2] * sin((i / 120.0) * TAU)))
        }
        val sorted = pts.sortedWith(Comparator { a, b ->
            val d = a[0] - b[0]
            if (d != 0.0) d.sign.toInt() else (a[1] - b[1]).sign.toInt()
        })
        fun cross(o: DoubleArray, a: DoubleArray, b: DoubleArray) = (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
        fun half(list: List<DoubleArray>): List<DoubleArray> {
            val out = ArrayList<DoubleArray>()
            for (p in list) {
                while (out.size >= 2 && cross(out[out.size - 2], out[out.size - 1], p) <= 1e-12) out.removeAt(out.size - 1)
                out.add(p)
            }
            out.removeAt(out.size - 1)
            return out
        }
        return half(sorted) + half(sorted.reversed())
    }

    private class Spec(val circles: List<DoubleArray>, val face: Double, val reach: Double)
    private fun c(x: Double, y: Double, r: Double) = doubleArrayOf(x, y, r)

    private val BODIES: Map<String, (Rng) -> Spec> = mapOf(
        "ball" to { _ -> Spec(listOf(c(0.0, 0.0, 1.0)), -0.08, 0.8) },
        "drop" to { r -> Spec(listOf(c(0.0, 0.3, 0.8), c(0.0, r.range(-0.92, -0.82), r.range(0.14, 0.17))), 0.2, 0.56) },
        "dome" to { r ->
            val cc = r.range(0.22, 0.3); val w = r.range(0.96, 1.04)
            Spec(listOf(c(0.0, -0.14, 0.74), c(-(w - cc), 0.8 - cc, cc), c(w - cc, 0.8 - cc, cc)), 0.02, 0.56)
        },
        "pill" to { r -> val h = r.range(0.4, 0.54); Spec(listOf(c(0.0, -h, 0.62), c(0.0, h, 0.62)), -h + 0.16, 0.5) },
        "loaf" to { r -> val h = r.range(0.4, 0.52); Spec(listOf(c(-h, 0.0, 0.6), c(h, 0.0, 0.6)), -0.04, 0.44) },
        "tile" to { r ->
            val cc = r.range(0.3, 0.42); val w = 0.92 - cc
            Spec(listOf(c(-w, -w, cc), c(w, -w, cc), c(-w, w, cc), c(w, w, cc)), -0.08, 0.66)
        },
        "bowl" to { r ->
            val cc = r.range(0.2, 0.3); val w = 0.9
            Spec(listOf(c(0.0, 0.1, w), c(-(w - cc), -0.84 + cc, cc), c(w - cc, -0.84 + cc, cc)), -0.12, 0.6)
        },
        "peak" to { r -> Spec(listOf(c(0.0, r.range(-0.7, -0.6), 0.28), c(-0.6, 0.6, 0.34), c(0.6, 0.6, 0.34)), 0.3, 0.44) },
        "gem" to { _ -> Spec(listOf(c(0.0, -0.74, 0.22), c(0.0, 0.74, 0.22), c(-0.7, 0.0, 0.24), c(0.7, 0.0, 0.24)), -0.04, 0.4) },
        "cup" to { r ->
            val top = r.range(0.62, 0.7); val foot = r.range(0.42, 0.5)
            Spec(listOf(c(-top, -0.6, 0.28), c(top, -0.6, 0.28), c(-foot, 0.64, 0.3), c(foot, 0.64, 0.3)), -0.1, 0.56)
        },
    )

    // What a name draws from. Order and repeats are part of the format: change them and every existing bot changes.
    private val EYE_ODDS = listOf("round", "round", "round", "round", "tall", "tall", "tall", "tall", "dot", "calm")
    private val AVOID = mapOf("ball" to listOf("gold", "orchid"), "drop" to listOf("coral"), "dome" to listOf("coral"), "pill" to listOf("gold"))
    private val TEMPER_ODDS = listOf("steady", "steady", "restless", "slow", "bright")
    private val HEX = Regex("^#[0-9a-fA-F]{6}$")

    class Eye(val kind: String, val r: Double, val tall: Double, val apart: Double, val rest: Double, val g: Double)
    class Face(val y: Double, val reach: Double, val lo: Double, val hi: Double)

    class Bot internal constructor(
        val seed: String, val shape: String, val colorName: String, val color: String,
        val outline: List<DoubleArray>, val top: Double, val foot: Double, val ax: Double, val ay: Double,
        private val rows: DoubleArray, val face: Face, val eye: Eye, val yawMax: Double, val temper: String,
        val breathSeconds: Double, val blink: DoubleArray, val glance: DoubleArray, val home: DoubleArray,
        val tilt: Double, val spring: Double, val play: DoubleArray,
    ) {
        fun widthAt(y: Double): Double {
            val f = clamp((y - top) / (foot - top), 0.0, 1.0) * ROWS
            val i = min(ROWS - 1, floor(f).toInt())
            return mix(rows[i], rows[i + 1], f - i)
        }
        fun fitAt(y: Double, h: Double): Double =
            minOf(widthAt(y - h), widthAt(y - h / 2), widthAt(y), widthAt(y + h / 2), widthAt(y + h)) - EDGE
    }
    private const val ROWS = 120

    /**
     * Make the bot for a name. The same name always gives the same bot; capitals and outer spaces do not count. Each of
     * shape, color (a PALETTE name or '#RRGGBB'), eyes and temper is drawn from the name unless set.
     */
    fun makeBot(name: String?, shape: String? = null, color: String? = null, eyes: String? = null, temper: String? = null): Bot {
        val key = (name ?: "").trim().lowercase().ifEmpty { "bot" }
        val picked = Rng("flat/$key/body").pick(SHAPES)
        val shapeName = if (shape != null && BODIES.containsKey(shape)) shape else picked
        var tone = Rng("flat/$key/colour").pick(PALETTE)
        if ((AVOID[shapeName] ?: emptyList()).contains(tone.first)) tone = PALETTE[(PALETTE.indexOf(tone) + 1) % PALETTE.size]
        val asked = color?.trim() ?: ""
        val named = PALETTE.firstOrNull { it.first == asked.lowercase() }
        if (named != null) tone = named
        else if (HEX.matches(asked)) tone = "custom" to asked.uppercase()
        val spec = BODIES.getValue(shapeName)(Rng("flat/$key/$shapeName"))

        // fit: every body gets about the same area, and none grows past the frame
        val unit = wrap(spec.circles)
        var area = 0.0
        var x0 = Double.POSITIVE_INFINITY; var x1 = Double.NEGATIVE_INFINITY; var y0 = Double.POSITIVE_INFINITY; var y1 = Double.NEGATIVE_INFINITY
        run { var j = unit.size - 1; for (i in unit.indices) { area += (unit[j][0] + unit[i][0]) * (unit[j][1] - unit[i][1]) / 2; j = i } }
        for (p in unit) { x0 = min(x0, p[0]); x1 = max(x1, p[0]); y0 = min(y0, p[1]); y1 = max(y1, p[1]) }
        val s = min(318 * sqrt(PI / abs(area)), 780 / max(x1 - x0, y1 - y0))
        val my = (y0 + y1) / 2
        val outline = unit.map { doubleArrayOf(500 + it[0] * s, 500 + (it[1] - my) * s) }
        val top = 500 + (y0 - my) * s; val foot = 500 + (y1 - my) * s; val ax = ((x1 - x0) / 2) * s; val ay = ((y1 - y0) / 2) * s

        // how wide the body is at every height, so the eyes can run to its real edge
        val rows = DoubleArray(ROWS + 1)
        for (i in 0..ROWS) {
            val y = mix(top + 0.5, foot - 0.5, i.toDouble() / ROWS)
            var lo = Double.POSITIVE_INFINITY; var hi = Double.NEGATIVE_INFINITY
            var j = outline.size - 1
            for (k in outline.indices) {
                val a = outline[k]; val b = outline[j]
                if ((a[1] > y) != (b[1] > y)) {
                    val x = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]); lo = min(lo, x); hi = max(hi, x)
                }
                j = k
            }
            rows[i] = if (lo <= hi) (hi - lo) / 2 else 0.0
        }
        // A provisional bot to measure with; the real one is made below with the same rows.
        val probe = Bot(key, shapeName, tone.first, tone.second, outline, top, foot, ax, ay, rows, Face(0.0, 0.0, 0.0, 0.0),
            Eye("", 0.0, 0.0, 0.0, 0.0, 0.0), 0.0, "", 0.0, DoubleArray(2), DoubleArray(2), DoubleArray(2), 0.0, 0.0, DoubleArray(2))

        val e = Rng("flat/$key/eyes"); val drawnEyes = e.pick(EYE_ODDS); val faceY = 500 + (spec.face - my) * s
        val kind = if (eyes != null && eyes in EYES) eyes else drawnEyes
        val want = e.range(0.255, 0.3) * (if (kind == "dot") 0.78 else 1.0)
        val tall = if (kind == "tall") e.range(1.22, 1.34) else if (kind == "dot") 1.0 else e.range(1.0, 1.1)
        val apart = if (kind == "dot") e.range(0.44, 0.54) else e.range(0.38, 0.47)
        val rest = if (kind == "calm") 1 - e.range(0.2, 0.28) else 1.0
        // eye size goes by the width of the body over the whole height of the eye, so a pointed body gets eyes that suit it
        var size = probe.widthAt(faceY) * want
        for (i in 0 until 3) size = (want * (probe.widthAt(faceY - size * tall) + 2 * probe.widthAt(faceY) + probe.widthAt(faceY + size * tall))) / 4
        size = clamp(size, 318 * 0.17, min(318 * 0.3, ay * 0.46))
        // two eyes of radius r need a clear half-width of g * r to sit side by side without touching
        val g = sqrt(1 + (1.06 / sin(apart)).pow(2))
        // how far up and down the eyes may go before the body gets too narrow for them
        var lo = faceY; var hi = faceY
        fun roomy(y: Double) = probe.fitAt(y, size * tall * 0.64) >= 0.64 * g * size
        while (lo - 6 > top && roomy(lo - 6)) lo -= 6
        while (hi + 6 < foot && roomy(hi + 6)) hi += 6
        val t = Rng("flat/$key/temper"); val drawnTemper = t.pick(TEMPER_ODDS)
        val temperName = if (temper != null && temper in TEMPERS) temper else drawnTemper
        val breath = if (temperName == "slow") t.range(5.5, 6.5) else if (temperName == "restless") t.range(2.4, 3.0) else t.range(3.6, 4.6)
        val blink = if (temperName == "restless") doubleArrayOf(1.5, 3.2) else if (temperName == "slow") doubleArrayOf(3.2, 6.4) else doubleArrayOf(2.2, 5.0)
        val glance = if (temperName == "restless") doubleArrayOf(0.5, 1.3) else if (temperName == "slow") doubleArrayOf(2.4, 4.6) else doubleArrayOf(1.1, 2.8)
        // where it looks when nothing is going on: a little to one side and a little up, never square on
        val side = if (t() < 0.5) -1.0 else 1.0
        val hx = side * t.range(0.2, 0.36)
        val hy = t.range(-0.34, -0.08)
        val tilt = t.range(0.035, 0.07)
        val spring = if (temperName == "bright") 1.25 else if (temperName == "slow") 0.8 else 1.0
        val play = when (temperName) {
            "bright" -> doubleArrayOf(5.0, 9.0); "restless" -> doubleArrayOf(6.0, 11.0); "slow" -> doubleArrayOf(13.0, 22.0); else -> doubleArrayOf(8.0, 15.0)
        }
        return Bot(key, shapeName, tone.first, tone.second, outline, top, foot, ax, ay, rows, Face(faceY, spec.reach * s, lo, hi),
            Eye(kind, size, tall, apart, rest, g), 1.2 - apart, temperName, breath, blink, glance, doubleArrayOf(hx, hy), tilt, spring, play)
    }

    // ---------------------------------------------------------------- life

    /** Everything that moves. Keep one for each place the bot is shown. */
    class Life internal constructor(var mood: String, val r: Rng, t0: Double, B: Bot) {
        var moodTime = 0.0; var t = t0
        var tx = B.home[0]; var ty = B.home[1]; var jx = 0.0; var jy = 0.0; var nextDrift = t0
        var yaw = B.home[0] * YAW; var vYaw = 0.0; var pitch = B.home[1] * PITCH; var vPitch = 0.0; var roll = B.home[0] * B.tilt; var vRoll = 0.0
        var spin = 0.0; var spinT = 1.0; var spinDir = 1.0; var spinDur = 0.8; var look: DoubleArray? = null; var lookUntil = 0.0
        var lid = 1 - B.eye.rest; var smile = 0.0; var wide = 1.0; var skew = 0.0; var perk = 0.0; var slump = 0.0; var dim = 0.0; var nod = 9.0; var nextNod = 0.0
        var close = 0.0; var peek = 0.0; var peekAmt = 0.0; var blink = -1.0; var blinksLeft = 0
        var nextBlink = t0 + r.range(0.8, 3.0); var nextGlance = t0 + r.range(0.3, 1.4); var nextPlay = t0 + r.range(5.0, 11.0)
        var hop = 0.0; var vHop = 0.0; var squash = 0.0; var vSquash = 0.0; var crouch = 0.0; var power = 0.0; var turnOnJump = 0.0; var joy = 0.0
    }

    fun wake(B: Bot, mood: String = "idle"): Life {
        val r = Rng("flat/${B.seed}/life"); val t0 = r.range(0.0, 20.0)
        return Life(if (mood in MOODS) mood else "idle", r, t0, B)
    }

    /** Change what the bot is doing: one of MOODS. */
    fun setMood(S: Life, mood: String) {
        if (mood !in MOODS || S.mood == mood) return
        S.mood = mood
        S.moodTime = 0.0
        S.peek = 0.0
        if (mood != "done") S.joy = min(S.joy, 0.2)
        if (mood == "listening") { S.blink = 0.0; S.blinksLeft = 1; S.nod = 0.0 }
    }

    /** Look at a point for a while: x from -1 (far left) to 1, y from -1 (up) to 1 (down). */
    fun lookAt(S: Life, x: Double, y: Double, seconds: Double = 2.2) {
        S.look = doubleArrayOf(clamp(x, -1.15, 1.15), clamp(y, -1.0, 1.0))
        S.lookUntil = S.t + seconds
    }

    private fun turnRound(S: Life, dir: Double, seconds: Double) {
        if (S.spinT < 1) return
        S.spinDir = dir; S.spinT = 0.0; S.spinDur = seconds
    }

    private fun jump(S: Life, power: Double, turn: Double) {
        if (S.crouch > 0 || S.hop > 0) return
        S.crouch = 0.09; S.power = power; S.turnOnJump = turn; S.vSquash -= 2.2
    }

    /** A tap. Awake, it jumps, turns right round and smiles. Asleep, it opens one eye. */
    fun poke(S: Life, calm: Boolean = false) {
        if (S.mood == "asleep") { S.peek = 1.3; S.vSquash -= 1.2; return }
        S.joy = 1.35
        if (!(S.look != null && S.t < S.lookUntil)) lookAt(S, 0.0, -0.04, 1.7)
        if (calm) return
        jump(S, 3.4, if (S.r() < 0.5) 1.0 else -1.0)
    }

    private fun spring(x: Double, v0: Double, target: Double, k: Double, c: Double, dt: Double): Pair<Double, Double> {
        val v = v0 + (k * (target - x) - c * v0) * dt
        return (x + v * dt) to v
    }

    /** Move a life on by dt seconds. calm = true leaves out jumps and turns, for people who ask for less motion. */
    fun step(B: Bot, S: Life, dt0: Double, calm: Boolean = false) {
        val dt = min(dt0, 0.05)
        S.t += dt
        S.moodTime += dt
        val m = S.mood; val E = B.eye
        var wide = 1.0; var lid = 1 - E.rest; var smile = 0.0; var rollT = 0.0; var perk = 0.0; var skew = 0.0; var slump = 0.0; var stiff = 1.0; var extraPitch = 0.0
        val watching = S.look != null && S.t < S.lookUntil && m != "asleep"

        when (m) {
            "idle" -> {
                if (!watching && S.t > S.nextGlance) {
                    val roll = S.r(); val far = abs(S.tx) > 0.9
                    val nx: Double; val ny: Double
                    if (far || roll < 0.3) { nx = B.home[0] + S.r.range(-0.08, 0.08); ny = B.home[1] + S.r.range(-0.08, 0.08) }
                    else if (roll < 0.44) { nx = S.r.range(-0.08, 0.08); ny = S.r.range(-0.05, 0.1) }
                    else if (roll < 0.86) { val a = S.r.range(0.3, 0.8); nx = a * (if (S.r() < 0.5) -1 else 1); ny = S.r.range(-0.55, 0.36) }
                    else { val a = S.r.range(0.96, 1.12); nx = a * (if (S.r() < 0.5) -1 else 1); ny = S.r.range(-0.2, 0.15) }
                    if (abs(nx - S.tx) > 0.7 && S.r() < 0.55 && S.blink < 0) S.blink = 0.0
                    S.tx = nx
                    S.ty = ny
                    S.nextGlance = S.t + S.r.range(B.glance[0], B.glance[1]) * (if (abs(nx) > 0.9) 0.6 else 1.0)
                }
                if (!calm && !watching && S.t > S.nextPlay) {
                    if (S.r() < (if (B.temper == "bright") 0.35 else 0.6)) turnRound(S, if (S.tx < 0) -1.0 else 1.0, 0.85) else jump(S, 2.3, 0.0)
                    S.nextPlay = S.t + S.r.range(B.play[0], B.play[1])
                }
                if (S.t > S.nextDrift) { S.jx = S.r.range(-0.035, 0.035); S.jy = S.r.range(-0.035, 0.035); S.nextDrift = S.t + S.r.range(0.3, 0.9) }
                rollT = S.tx * B.tilt
            }
            "listening" -> {
                S.tx = 0.0; S.ty = -0.1; wide = 1.14; perk = 1.0; lid = 0.0
                if (S.t > S.nextNod) { S.nod = 0.0; S.nextNod = S.t + S.r.range(1.9, 3.2) }
                S.nod += dt
                if (!calm) extraPitch = 0.24 * sin(S.nod * TAU * 2.2) * exp(-S.nod * 2.4)
            }
            "thinking" -> {
                val side = if (floor(S.moodTime / 3.4).toLong() % 2 != 0L) 1.0 else -1.0
                S.tx = side * 0.52 + 0.1 * cos(S.t * 1.1)
                S.ty = -0.78 + 0.1 * sin(S.t * 1.1)
                rollT = side * 0.1; lid = max(lid, 0.06); skew = side; stiff = 0.3
            }
            "working" -> {
                // reads a line from left to right, then snaps back to the start of the next one
                val line = (S.moodTime % 1.15) / 1.15
                S.tx = if (line < 0.86) mix(-0.62, 0.62, line / 0.86) else mix(0.62, -0.62, ease((line - 0.86) / 0.14))
                S.ty = 0.3; lid = max(lid, 0.14)
                stiff = 1.6
                if (!calm && S.moodTime % 1.15 < dt && S.moodTime > 0.5) S.vSquash -= 0.5
            }
            "asking" -> {
                // wants you: faces you, bounces on the spot, tips its head one way then the other
                S.tx = 0.0; S.ty = -0.14; wide = 1.1; perk = 1.0; lid = 0.0
                rollT = 0.085 * (if (floor(S.moodTime / 1.5).toLong() % 2 != 0L) 1 else -1)
                if (!calm && S.moodTime % 1.5 < dt * 1.5) jump(S, 1.9, 0.0)
            }
            "stuck" -> {
                // shakes its head, then looks at you with heavy eyes
                val beat = S.moodTime % 3.1
                S.tx = if (beat < 1.25) 0.74 * sin(beat * TAU * 1.9) * (1 - beat / 1.25) else 0.0
                S.ty = 0.14; lid = max(lid, 0.3); slump = 0.5; stiff = 1.7
            }
            "done" -> {
                S.tx = 0.0; S.ty = -0.08
                if (S.moodTime % 3.4 < dt * 1.5) { S.joy = 1.6; if (!calm) jump(S, 3.5, if (S.r() < 0.5) 1.0 else -1.0) }
            }
            else -> { S.tx = 0.16; S.ty = 0.5; rollT = -0.1; slump = 1.0; stiff = 0.15 }
        }
        if (watching) { val l = S.look!!; S.tx = l[0]; S.ty = l[1]; stiff = max(stiff, 1.0); if (m == "idle") rollT = S.tx * B.tilt }

        val reach = if (calm) 0.65 else 1.0; val k = 150 * B.spring * stiff; val c = 2 * 0.66 * sqrt(k)
        spring(S.yaw, S.vYaw, clamp((S.tx + (if (m == "idle") S.jx else 0.0)) * YAW * reach, -B.yawMax, B.yawMax), k, c, dt).let { S.yaw = it.first; S.vYaw = it.second }
        spring(S.pitch, S.vPitch, (S.ty + (if (m == "idle") S.jy else 0.0)) * PITCH * reach + extraPitch, k, c * 1.04, dt).let { S.pitch = it.first; S.vPitch = it.second }
        spring(S.roll, S.vRoll, if (calm) rollT * 0.4 else rollT, 40.0, 8.5, dt).let { S.roll = it.first; S.vRoll = it.second }
        if (S.spinT < 1) {
            S.spinT = min(1.0, S.spinT + dt / S.spinDur)
            S.spin = if (S.spinT >= 1) 0.0 else S.spinDir * TAU * ease(S.spinT)
        }

        S.joy = max(0.0, S.joy - dt)
        if (S.crouch > 0) {
            S.crouch -= dt
            if (S.crouch <= 0) { S.vHop = S.power; S.vSquash += 3.4; if (S.turnOnJump != 0.0) turnRound(S, S.turnOnJump, 0.62) }
        }
        if (S.hop > 0 || S.vHop > 0) {
            S.vHop -= 14 * dt
            S.hop += S.vHop * dt
            if (S.hop <= 0) { S.hop = 0.0; S.vSquash -= min(3.2, abs(S.vHop)) * 0.95; S.vHop = 0.0 }
        }
        spring(S.squash, S.vSquash, 0.0, 230.0, 13.0, dt).let { S.squash = it.first; S.vSquash = it.second }

        if (S.joy > 0.14) { smile = 1.0; lid = 0.0; wide = 1.06; skew = 0.0 }
        val rate = 1 - exp(-dt * 13)
        S.lid += (lid - S.lid) * rate
        S.smile += (smile - S.smile) * (1 - exp(-dt * (if (smile > S.smile) 12 else 9)))
        S.wide += (wide - S.wide) * rate
        S.skew += (skew - S.skew) * rate * 0.4
        S.perk += (perk - S.perk) * (1 - exp(-dt * 8))
        S.slump += (slump - S.slump) * (1 - exp(-dt * 2.5))
        S.dim += ((if (m == "asleep") 1.0 else 0.0) - S.dim) * (1 - exp(-dt * 3))

        if (m == "asleep") {
            S.close += (1 - S.close) * (1 - exp(-dt * 3.2))
            S.blink = -1.0
            S.peek = max(0.0, S.peek - dt)
            S.peekAmt += ((if (S.peek > 0.25) 0.62 else 0.0) - S.peekAmt) * (1 - exp(-dt * 9))
        } else {
            S.peekAmt = 0.0
            if (S.blink < 0 && S.t > S.nextBlink) { S.blink = 0.0; S.blinksLeft = if (S.r() < 0.16) 1 else 0 }
            var shut = 0.0
            if (S.blink >= 0) {
                S.blink += dt / 0.19
                if (S.blink >= 1) {
                    if (S.blinksLeft > 0) { S.blinksLeft--; S.blink = 0.0 }
                    else { S.blink = -1.0; S.nextBlink = S.t + S.r.range(B.blink[0], B.blink[1]) * (if (m == "listening") 1.5 else 1.0) }
                } else shut = if (S.blink < 0.36) ease(S.blink / 0.36) else if (S.blink < 0.5) 1.0 else 1 - ease((S.blink - 0.5) / 0.5)
            }
            S.close = if (S.close > 0.5 && S.blink < 0) max(0.0, S.close - dt * 5) else shut
        }
    }

    // ---------------------------------------------------------------- drawing as numbers

    private class EyeNow(val x: Double, val y: Double, val hx: Double, val hy: Double, val r: Double) {
        var h = 0.0; var bar = 0.0; var bend = 0.0
    }

    private fun eyeOf(B: Bot, S: Life, side: Int, boost: Double): EyeNow? {
        val E = B.eye; val P = S.pitch + TILT; val lon = S.yaw + S.spin + side * E.apart
        val x1 = sin(lon); val z1 = cos(lon); val y2 = z1 * sin(P); val z2 = z1 * cos(P)
        if (z2 <= 0.015) return null
        val fx = (z2 / hypot(x1, z2)).pow(0.86); val fy = sqrt(1 - y2 * y2 * 0.8)
        val full = E.r * boost * S.wide * (0.87 + 0.13 * z2)
        val y = clamp(B.face.y + y2 * B.face.reach, B.face.lo, B.face.hi)
        val tall = full * E.tall * fy * (0.62 + 0.38 * fx) // an eye gets shorter as well as thinner on its way round
        // in a tight spot the eyes get smaller, so they never touch each other or the edge
        val room = clamp(B.fitAt(y, tall) / (E.g * full), 0.3, 1.0)
        val r = full * room; val hy = tall * room; val fit = B.fitAt(y, hy)
        return EyeNow(500 + x1 * sqrt(max(fit * fit - r * r, 0.0)), y, r * fx, hy, r)
    }

    /** An eye is an oval that closes by flattening into a soft bar, and the bar can bow. As x0, y0, x1, y1 ... */
    private fun eyeOutline(hx: Double, hy: Double, bar: Double, bend: Double, ox: Double, oy: Double): DoubleArray {
        val out = DoubleArray(EYE_POINTS * 2)
        val h = max(hy, min(bar, hx * 0.9)); val e = 2 / (2 + 3 * clamp(1 - h / (0.55 * hx), 0.0, 1.0))
        for (i in 0 until EYE_POINTS) {
            val a = (i.toDouble() / EYE_POINTS) * TAU; val cc = cos(a); val sn = sin(a)
            val x = hx * cc.sign * abs(cc).pow(e)
            out[2 * i] = ox + x
            out[2 * i + 1] = oy + h * sn.sign * abs(sn).pow(e) - bend * (1 - (x * x) / (hx * hx))
        }
        return out
    }

    private fun boostFor(px: Double) = if (px < 26) 1.36 else if (px < 44) 1.16 else 1.0 // small pictures get larger eyes

    private fun eyeNow(B: Bot, S: Life, side: Int, boost: Double): EyeNow? {
        val p = eyeOf(B, S, side, boost) ?: return null
        if (p.hx < 0.5) return null
        val sm = S.smile; val bow = ease(clamp((sm - 0.3) / 0.7, 0.0, 1.0)); val down = if (sm > 0.05) 0.0 else 0.1 * clamp(S.pitch / PITCH, 0.0, 1.0)
        val shut = clamp(S.close - (if (side > 0) S.peekAmt else 0.0), 0.0, 1.0)
        // a smile first narrows the eye to a bar, then bows the bar upward
        p.h = p.hy * (1 - clamp(S.lid + down + 0.07 * S.skew * side, 0.0, 0.6)) * (1 - shut) * (1 - clamp(sm * 2.4, 0.0, 1.0))
        p.bar = p.r * 0.2 * (1 + 0.2 * bow)
        p.bend = p.hx * (0.55 * bow - 0.26 * S.dim * shut)
        return p
    }

    private fun rgbOf(hex: String) = intArrayOf(1, 3, 5).map { hex.substring(it, it + 2).toInt(16) }
    private fun toward(from: List<Int>, to: List<Int>, t: Double) =
        "rgb(" + from.indices.joinToString(",") { i -> floor(from[i] + (to[i] - from[i]) * t + 0.5).toInt().toString() } + ")"

    /** One frame of a bot as plain numbers in a 1000 by 1000 square (the kit's `poseOf`). */
    class Pose(val fill: String, val outline: List<DoubleArray>, val foot: Double, val x: Double, val y: Double, val roll: Double,
               val sx: Double, val sy: Double, val eyes: List<DoubleArray>)

    fun poseOf(B: Bot, S: Life, px: Double = 96.0, dark: Boolean = false, surface: String? = null): Pose {
        val Y = S.yaw + S.spin; val slow = S.dim > 0.5
        val breath = (if (slow) 0.024 else 0.012) * sin((S.t * TAU) / (B.breathSeconds * (if (slow) 1.6 else 1.0)))
        val sq = S.squash - 0.07 * S.slump + 0.035 * S.perk
        val surf = rgbOf(if (surface != null && HEX.matches(surface)) surface else if (dark) "#20254A" else "#FFFFFF")
        val fill = if (S.dim > 0.01) toward(rgbOf(B.color), surf, S.dim * (if (dark) 0.28 else 0.4)) else B.color
        val eyes = ArrayList<DoubleArray>()
        if (px >= 12) for (side in intArrayOf(-1, 1)) {
            val p = eyeNow(B, S, side, boostFor(px)) ?: continue
            eyes.add(eyeOutline(p.hx, p.h, p.bar, p.bend, p.x, p.y))
        }
        return Pose(fill, B.outline, B.foot, 500 + B.ax * 0.05 * sin(S.yaw), B.foot - S.hop * HOP, S.roll,
            (1 - sq * 0.72) * (1 - 0.05 * abs(sin(Y))), (1 + sq) * (1 + breath), eyes)
    }
}
