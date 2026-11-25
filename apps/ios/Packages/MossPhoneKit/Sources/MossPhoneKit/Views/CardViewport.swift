import SwiftUI

/// The part of a scroll view a person can actually see: its bounds less the bars over it (the navigation bar, the
/// composer), in the scroll view's own coordinates. A card reports a part of itself as seen only when that part sits
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
            .onScrollGeometryChange(for: CGRect.self) { g in
                // `contentInsets` holds what the bars cover (the safe area the scroll view adjusts for).
                CGRect(x: 0, y: g.contentInsets.top, width: g.containerSize.width,
                       height: max(0, g.containerSize.height - g.contentInsets.top - g.contentInsets.bottom))
            } action: { _, new in viewport = new }
    }
}

private struct SeenInViewport: ViewModifier {
    let seen: () -> Void
    @Environment(\.cardViewport) private var viewport
    @State private var frame: CGRect = .null
    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .scrollView) } action: { f in frame = f; check() }
            .onChange(of: viewport) { _, _ in check() }
    }
    private func check() {
        guard viewport.height > 1, !frame.isNull, frame.height > 0 else { return }
        if viewport.insetBy(dx: -1, dy: -1).contains(frame) { seen() }
    }
}
