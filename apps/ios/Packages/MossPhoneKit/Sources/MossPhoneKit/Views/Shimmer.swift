import SwiftUI

/// The turn's one plain status line ("Alpha is working"): a line of text with a shimmer, still when Reduce Motion is on.
public struct StatusLineView: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(_ text: String) { self.text = text }
    public var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { tl in
            let phase = reduceMotion ? 0.5 : (tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6)) / 1.6
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .overlay {
                    GeometryReader { g in
                        LinearGradient(colors: [.clear, Color.primary.opacity(0.9), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: g.size.width * 0.5)
                            .offset(x: -g.size.width * 0.5 + phase * g.size.width * 1.5)
                            .blendMode(.sourceAtop)
                    }
                    .mask(Text(text).font(.subheadline))
                }
        }
        .accessibilityLabel(text)
        .accessibilityAddTraits(.updatesFrequently)
    }
}
