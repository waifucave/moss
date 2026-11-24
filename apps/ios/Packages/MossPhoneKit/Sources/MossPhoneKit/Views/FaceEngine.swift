import Foundation
import JavaScriptCore

/// One frame of a bot, as the kit's `poseOf` gives it: plain numbers in a 1000 by 1000 square.
struct FacePose: Decodable {
    var fill: String
    var outline: [[Double]]
    var foot: Double
    var x: Double, y: Double, roll: Double, sx: Double, sy: Double
    var eyes: [[Double]]
}

/// Runs the living-bots kit itself (`packages/plugin-sdk/src/ui/faces/living-bots.js`, the same file the desktop draws
/// with, kept byte for byte in `Resources/`) in JavaScriptCore, so a bot's face is exactly the desktop's.
@MainActor
final class FaceEngine {
    static let shared = FaceEngine()
    private let context = JSContext()!
    private(set) var ready = false

    private init() {
        guard let url = Bundle.module.url(forResource: "living-bots", withExtension: "js"),
              var source = try? String(contentsOf: url, encoding: .utf8) else { return }
        source = source.replacingOccurrences(of: "\nexport ", with: "\n")
        if source.hasPrefix("export ") { source.removeFirst("export ".count) }
        context.evaluateScript(source)
        context.evaluateScript("""
        var __bots = {}, __lives = {};
        function __make(key, name, shape, color, eyes, temper, mood) {
          var o = {}; if (shape) o.shape = shape; if (color) o.color = color; if (eyes) o.eyes = eyes; if (temper) o.temper = temper;
          __bots[key] = makeBot(name, o); __lives[key] = wake(__bots[key], mood);
        }
        function __mood(key, mood) { setMood(__lives[key], mood); }
        function __pose(key, dt, px, dark) {
          var B = __bots[key], S = __lives[key]; if (!B) return '';
          step(B, S, dt, false);
          return JSON.stringify(poseOf(B, S, px, { dark: dark }));
        }
        function __drop(key) { delete __bots[key]; delete __lives[key]; }
        """)
        ready = context.exception == nil
    }

    func make(key: String, name: String, face: BotFaceSpec?, mood: String) {
        guard ready else { return }
        context.objectForKeyedSubscript("__make").call(withArguments: [key, name, face?.shape ?? "", face?.color ?? "", face?.eyes ?? "", face?.temper ?? "", mood])
    }
    func setMood(key: String, mood: String) {
        guard ready else { return }
        context.objectForKeyedSubscript("__mood").call(withArguments: [key, mood])
    }
    func pose(key: String, dt: Double, px: Double, dark: Bool) -> FacePose? {
        guard ready, let s = context.objectForKeyedSubscript("__pose").call(withArguments: [key, dt, px, dark])?.toString(), !s.isEmpty,
              let d = s.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(FacePose.self, from: d)
    }
    func drop(key: String) {
        guard ready else { return }
        context.objectForKeyedSubscript("__drop").call(withArguments: [key])
    }
}
