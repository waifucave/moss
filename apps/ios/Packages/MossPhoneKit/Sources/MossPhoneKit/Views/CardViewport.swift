import SwiftUI

/// The part of a scroll view a person can actually see: its frame less the bars over it (the navigation bar, the
/// composer), in window coordinates. A card reports a part of itself as seen only when that part sits
/// inside this rect; without one (no scroll view set it) nothing is ever reported seen, so an approve stays refused.
struct CardViewportKey: EnvironmentKey { static let defaultValue: CGRect = .zero }
extension EnvironmentValues {
    var cardViewport: CGRect { get { self[CardViewportKey.self] } set { self[CardViewportKey.self] = newValue } }
}

extension View {
    /// Applied to the scroll view that holds cards: measures what of it is unobstructed and hands that to the cards.
    func cardViewport() -> some View { modifier(CardViewportReader()) }
    /// Calls `seen` once this view has been wholly inside the unobstructed part of the scroll view.
    func whenSeen(_ seen: @escaping () -> Void) -> some View { modifier(SeenInViewport(seen: seen)) }
}

private struct CardViewportReader: ViewModifier {
    @State private var viewport: CGRect = .zero
    func body(content: Content) -> some View {
        content
            .environment(\.cardViewport, viewport)
            // In window coordinates, from the first layout on: the scroll view's frame less the bars it runs under (its
            // safe area there). The cards measure themselves in the same coordinates, so scrolling moves only them.
            .onGeometryChange(for: CGRect.self) { g in
                let f = g.frame(in: .global)
                return CGRect(x: f.minX, y: f.minY + g.safeAreaInsets.top, width: f.width,
                              height: max(0, f.height - g.safeAreaInsets.top - g.safeAreaInsets.bottom))
            } action: { new in viewport = new }
    }
}

private struct SeenInViewport: ViewModifier {
    let seen: () -> Void
    @Environment(\.cardViewport) private var viewport
    @State private var frame: CGRect = .null
    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { f in frame = f; check() }
            .onChange(of: viewport) { _, _ in check() }
    }
    private func check() {
        guard viewport.height > 1, !frame.isNull, frame.height > 0 else { return }
        if viewport.insetBy(dx: -1, dy: -1).contains(frame) { seen() }
    }
}
