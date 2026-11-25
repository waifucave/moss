import SwiftUI

/// The part of a scroll view a person can actually see: its visible rect less the bars over it (the navigation bar, the
/// composer), in the scroll content's coordinates. A card reports a part of itself as seen only when that part sits
/// inside this rect; without one (no scroll view set it) nothing is ever reported seen, so an approve stays refused.
struct CardViewportKey: EnvironmentKey { static let defaultValue: CGRect = .zero }
extension EnvironmentValues {
    var cardViewport: CGRect { get { self[CardViewportKey.self] } set { self[CardViewportKey.self] = newValue } }
}

extension View {
    /// Applied to the scroll view that holds cards: measures what of it is unobstructed and hands that to the cards.
    func cardViewport() -> some View { modifier(CardViewportReader()) }
    /// Calls `seen` once this view has been wholly inside the unobstructed part of the scroll view.
    func whenSeen(_ tag: String = "", _ seen: @escaping () -> Void) -> some View { modifier(SeenInViewport(tag: tag, seen: seen)) }
}

#if DEBUG
/// Debug builds with `-seenLog` only: each report a marker made, with its frame and the viewport then, drawn as one
/// accessibility element (`seen-log`) so a failed UI test's view hierarchy carries why something counted as seen.
@MainActor @Observable final class SeenLog {
    static let shared = SeenLog()
    static let on = ProcessInfo.processInfo.arguments.contains("-seenLog")
    var entries: [String] = []
}
struct SeenLogView: View {
    var body: some View {
        if SeenLog.on {
            Text(SeenLog.shared.entries.suffix(12).joined(separator: " | ")).font(.system(size: 2)).opacity(0.02)
                .accessibilityIdentifier("seen-log").allowsHitTesting(false)
        }
    }
}
#endif


/// The scroll content's own coordinate space: what a card measures itself in, the same space the scroll view's visible
/// rect is given in, so neither a sheet's offset in the window nor how the bars are counted can put the two apart.
let cardContentSpace = "moss.cardContent"

private struct CardViewportReader: ViewModifier {
    @State private var viewport: CGRect = .zero
    func body(content: Content) -> some View {
        content
            .environment(\.cardViewport, viewport)
            // The scroll view's visible rect, in content coordinates, less its content insets: the parts of its bounds the
            // system itself counts as covered (the navigation bar, the composer bar, the home indicator).
            .onScrollGeometryChange(for: CGRect.self) { g in
                let v = g.visibleRect, i = g.contentInsets
                return CGRect(x: v.minX + i.leading, y: v.minY + i.top,
                              width: max(0, v.width - i.leading - i.trailing), height: max(0, v.height - i.top - i.bottom))
            } action: { _, new in viewport = new }
    }
}

extension View {
    /// Applied to the outermost content view inside a card-holding scroll view (after its padding): names the space the
    /// scroll view's visible rect is measured in.
    func cardContent() -> some View { coordinateSpace(.named(cardContentSpace)) }
}

private struct SeenInViewport: ViewModifier {
    let tag: String
    let seen: () -> Void
    @Environment(\.cardViewport) private var viewport
    func body(content: Content) -> some View {
        content.background {
            GeometryReader { g in
                let f = g.frame(in: .named(cardContentSpace))
                Color.clear
                    .onAppear { check(f, viewport) }
                    .onChange(of: f) { _, new in check(new, viewport) }
                    .onChange(of: viewport) { _, new in check(f, new) }
            }
        }
    }
    private func check(_ frame: CGRect, _ viewport: CGRect) {
        guard viewport.height > 1, frame.height > 0 else { return }
        if viewport.insetBy(dx: -1, dy: -1).contains(frame) {
            #if DEBUG
            if SeenLog.on, !tag.isEmpty {
                SeenLog.shared.entries.append("\(tag) f=\(Int(frame.minY))..\(Int(frame.maxY)) v=\(Int(viewport.minY))..\(Int(viewport.maxY))")
            }
            #endif
            seen()
        }
    }
}
