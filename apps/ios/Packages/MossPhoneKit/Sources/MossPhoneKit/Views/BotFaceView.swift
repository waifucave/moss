import SwiftUI

final class TickBox { var last: Date?; var made = false }

/// A bot's own living face, drawn by the kit (`FaceEngine`). Still when Reduce Motion is on.
public struct BotFaceView: View {
    public enum Mood: String, Sendable { case idle, thinking, working, asking, asleep }
    let name: String
    let face: BotFaceSpec?
    let mood: Mood
    let size: CGFloat
    @State private var key = UUID().uuidString
    @State private var clock = TickBox()
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(name: String, face: BotFaceSpec?, mood: Mood = .idle, size: CGFloat) {
        self.name = name; self.face = face; self.mood = mood; self.size = size
    }

    public var body: some View {
        TimelineView(.animation(minimumInterval: size > 80 ? 1.0 / 30 : 1.0 / 15, paused: reduceMotion)) { timeline in
            Canvas { ctx, canvasSize in
                let dt: Double = {
                    guard let last = clock.last else { return 0 }
                    return min(max(timeline.date.timeIntervalSince(last), 0), 0.1)
                }()
                clock.last = timeline.date
                let engine = FaceEngine.shared
                if !clock.made { engine.make(key: key, name: name, face: face, mood: mood.rawValue); clock.made = true }
                guard let pose = engine.pose(key: key, dt: reduceMotion ? 0 : dt, px: Double(size), dark: scheme == .dark) else { return }
                let s = min(canvasSize.width, canvasSize.height) / 1000
                var c = ctx
                c.translateBy(x: (canvasSize.width - 1000 * s) / 2, y: (canvasSize.height - 1000 * s) / 2)
                c.scaleBy(x: s, y: s)
                c.translateBy(x: 50, y: 50)
                c.scaleBy(x: 0.9, y: 0.9)
                c.translateBy(x: pose.x, y: pose.y)
                c.rotate(by: .radians(pose.roll))
                c.scaleBy(x: pose.sx, y: pose.sy)
                c.translateBy(x: -500, y: -pose.foot)
                c.fill(path(pose.outline), with: .color(Self.parse(pose.fill)))
                for eye in pose.eyes { c.fill(path(flat: eye), with: .color(Theme.ink)) }
            }
        }
        .frame(width: size, height: size)
        .onDisappear { FaceEngine.shared.drop(key: key); clock.made = false }
        .onChange(of: mood) { _, m in if clock.made { FaceEngine.shared.setMood(key: key, mood: m.rawValue) } }
        .accessibilityHidden(true)
    }

    private func path(_ pts: [[Double]]) -> Path {
        var p = Path()
        for (i, q) in pts.enumerated() where q.count == 2 {
            let pt = CGPoint(x: q[0], y: q[1]); i == 0 ? p.move(to: pt) : p.addLine(to: pt)
        }
        p.closeSubpath(); return p
    }
    private func path(flat: [Double]) -> Path {
        var p = Path()
        var i = 0
        while i + 1 < flat.count {
            let pt = CGPoint(x: flat[i], y: flat[i + 1]); i == 0 ? p.move(to: pt) : p.addLine(to: pt); i += 2
        }
        p.closeSubpath(); return p
    }

    /// The kit gives a `#rrggbb` or an `rgb(r,g,b)` fill.
    static func parse(_ s: String) -> Color {
        if s.hasPrefix("#") { return Theme.color(hex: s) }
        let nums = s.filter { "0123456789,.".contains($0) }.split(separator: ",").compactMap { Double($0) }
        guard nums.count >= 3 else { return .gray }
        return Color(red: nums[0] / 255, green: nums[1] / 255, blue: nums[2] / 255)
    }
}

public extension BotState {
    var faceMood: BotFaceView.Mood {
        switch self { case .idle: return .idle; case .thinking: return .thinking; case .asleep, .paused: return .asleep }
    }
}
