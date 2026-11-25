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
    func whenSeen(_ seen: @escaping () -> Void) -> some View { modifier(SeenInViewport(seen: seen)) }
}


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
    let seen: () -> Void
    @Environment(\.cardViewport) private var viewport
    @State private var frame: CGRect = .zero
    /// The viewport as last delivered, kept in state so the dwell's later look reads the current one, not a copy.
    @State private var shown: CGRect = .zero
    @State private var dwell: Task<Void, Never>?
    /// How long a part must stay inside the visible part to count: a layout pass (the scroll view placed at its top for a
    /// moment before it moves to where it opens) is not the person seeing it.
    static let dwellTime: Duration = .milliseconds(300)
    func body(content: Content) -> some View {
        content.background {
            GeometryReader { g in
                let f = g.frame(in: .named(cardContentSpace))
                Color.clear
                    .onAppear { frame = f; shown = viewport; check() }
                    .onChange(of: f) { _, new in frame = new; check() }
                    .onChange(of: viewport) { _, new in shown = new; check() }
            }
        }
        .onDisappear { dwell?.cancel(); dwell = nil }
    }
    private var inside: Bool {
        shown.height > 1 && frame.height > 0 && shown.insetBy(dx: -1, dy: -1).contains(frame)
    }
    private func check() {
        guard inside else { dwell?.cancel(); dwell = nil; return }
        guard dwell == nil else { return }
        dwell = Task { @MainActor in
            try? await Task.sleep(for: Self.dwellTime)
            guard !Task.isCancelled else { return }
            dwell = nil
            if inside { seen() }
        }
    }
}
