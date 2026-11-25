package com.waifucave.moss.phone

import com.waifucave.moss.phone.face.LivingBots
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.math.abs

/**
 * The Kotlin port of the faces kit against the JavaScript itself: `living-bots-golden.json` was written by running
 * `packages/plugin-sdk/src/ui/faces/living-bots.js` (make each sample bot, wake it in five moods, take its pose, step it 90
 * frames of 1/30 s, take its pose again). Same name, same bot; same life, same motion.
 *
 * To write the file again after the kit changes: run the generator kept beside it in the comment at the end of this file.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LivingBotsTest {
    private fun near(what: String, want: Double, got: Double, tol: Double = 1e-3) {
        if (abs(want - got) > tol) throw AssertionError("$what: the kit says $want, the port $got")
    }
    private fun nums(a: JSONArray) = (0 until a.length()).map { a.getDouble(it) }

    @Test fun matchesTheKit() {
        val text = javaClass.classLoader!!.getResourceAsStream("living-bots-golden.json")!!.bufferedReader().readText()
        val cases = JSONArray(text)
        assertEquals(12, cases.length())
        for (i in 0 until cases.length()) {
            val g = cases.getJSONObject(i)
            val name = g.getString("name")
            val o = g.getJSONObject("options")
            val b = LivingBots.makeBot(name, o.optString("shape").ifEmpty { null }, o.optString("color").ifEmpty { null },
                o.optString("eyes").ifEmpty { null }, o.optString("temper").ifEmpty { null })
            assertEquals("$name shape", g.getString("shape"), b.shape)
            assertEquals("$name colour", g.getString("colorName"), b.colorName)
            assertEquals("$name colour value", g.getString("color"), b.color)
            assertEquals("$name eyes", g.getString("eyes"), b.eye.kind)
            assertEquals("$name temper", g.getString("temper"), b.temper)
            assertEquals("$name outline points", g.getInt("outlineCount"), b.outline.size)
            nums(g.getJSONArray("outline0")).forEachIndexed { k, v -> near("$name outline0[$k]", v, b.outline[0][k]) }
            nums(g.getJSONArray("outlineMid")).forEachIndexed { k, v -> near("$name outlineMid[$k]", v, b.outline[b.outline.size shr 1][k]) }
            near("$name top", g.getDouble("top"), b.top); near("$name foot", g.getDouble("foot"), b.foot)
            near("$name face y", g.getDouble("faceY"), b.face.y); near("$name face lo", g.getDouble("faceLo"), b.face.lo)
            near("$name face hi", g.getDouble("faceHi"), b.face.hi); near("$name eye r", g.getDouble("eyeR"), b.eye.r)
            val poses = g.getJSONArray("poses")
            for (p in 0 until poses.length()) {
                val pose = poses.getJSONObject(p)
                val mood = pose.getString("mood")
                val life = LivingBots.wake(b, mood)
                check("$name $mood start", pose.getJSONObject("start"), LivingBots.poseOf(b, life, 48.0, dark = false))
                repeat(90) { LivingBots.step(b, life, 1.0 / 30) }
                check("$name $mood after", pose.getJSONObject("after"), LivingBots.poseOf(b, life, 48.0, dark = mood == "asleep"))
            }
        }
    }

    private fun check(what: String, want: JSONObject, got: LivingBots.Pose) {
        assertEquals("$what fill", want.getString("fill"), got.fill)
        near("$what x", want.getDouble("x"), got.x); near("$what y", want.getDouble("y"), got.y)
        near("$what roll", want.getDouble("roll"), got.roll, 1e-5)
        near("$what sx", want.getDouble("sx"), got.sx, 1e-5); near("$what sy", want.getDouble("sy"), got.sy, 1e-5)
        assertEquals("$what eyes", want.getInt("eyes"), got.eyes.size)
        nums(want.getJSONArray("eye0")).forEachIndexed { k, v -> near("$what eye0[$k]", v, got.eyes[0][k]) }
    }
}

/*
The generator (run with the repo's pinned Bun: scripts/pinned-bun gen.mjs <repo>/packages/plugin-sdk/src/ui/faces/living-bots.js > living-bots-golden.json):

const k = await import(process.argv[2]);
const cases = [
  ['Alpha', { color: 'coral' }], ['Luna', {}], ['Juniper', {}], ['Pip', { shape: 'drop', color: 'sky' }], ['Marlow', {}],
  ['Sorrel', {}], ['Tansy', {}], ['Ember', {}], ['Wren', {}], ['Fig', {}], ['Briar', {}], ['  BOT  ', { eyes: 'dot', temper: 'slow', color: '#12ab34' }],
];
const r = (v) => Math.round(v * 1e6) / 1e6;
const out = [];
for (const [name, opts] of cases) {
  const B = k.makeBot(name, opts);
  const poses = [];
  for (const mood of ['idle', 'thinking', 'working', 'asking', 'asleep']) {
    const S = k.wake(B, mood);
    const p0 = k.poseOf(B, S, 48, { dark: false });
    for (let i = 0; i < 90; i++) k.step(B, S, 1 / 30, false);
    const p1 = k.poseOf(B, S, 48, { dark: mood === 'asleep' });
    const pick = (p) => ({ fill: p.fill, x: r(p.x), y: r(p.y), roll: r(p.roll), sx: r(p.sx), sy: r(p.sy), eyes: p.eyes.length, eye0: p.eyes.length ? p.eyes[0].slice(0, 6).map(r) : [] });
    poses.push({ mood, start: pick(p0), after: pick(p1) });
  }
  const n = B.outline.length;
  out.push({ name, options: opts, shape: B.shape, colorName: B.colorName, color: B.color, eyes: B.eye.kind, temper: B.temper,
    outlineCount: n, outline0: B.outline[0].map(r), outlineMid: B.outline[n >> 1].map(r), top: r(B.top), foot: r(B.foot),
    faceY: r(B.face.y), faceLo: r(B.face.lo), faceHi: r(B.face.hi), eyeR: r(B.eye.r), poses });
}
console.log(JSON.stringify(out, null, 1));
*/
