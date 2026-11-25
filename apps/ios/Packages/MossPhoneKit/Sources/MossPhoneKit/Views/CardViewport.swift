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
    func whenSeen(probe: String? = nil, _ seen: @escaping () -> Void) -> some View { modifier(SeenInViewport(probe: probe, seen: seen)) }
}

#if DEBUG
/// Debug builds only: the last measurement of a probed marker, drawn as an invisible element UI tests can read.
@MainActor @Observable final class SeenProbe {
    static let shared = SeenProbe()
    var last: [String: String] = [:]
}
#endif

private struct CardViewportReader: ViewModifier {
    @State private var viewport: CGRect = .zero
    func body(content: Content) -> some View {
        content
            .environment(\.cardViewport, viewport)
            // In window coordinates, from the first layout on (`onAppear`; a change only reports changes): the scroll
            // view's frame less the bars it runs under (its safe area there). The cards measure themselves the same way.
            .background {
                GeometryReader { g in
                    let r = Self.rect(g)
                    Color.clear
                        .onAppear { viewport = r }
                        .onChange(of: r) { _, new in viewport = new }
                }
            }
    }
    static func rect(_ g: GeometryProxy) -> CGRect {
        let f = g.frame(in: .global)
        return CGRect(x: f.minX, y: f.minY + g.safeAreaInsets.top, width: f.width,
                      height: max(0, f.height - g.safeAreaInsets.top - g.safeAreaInsets.bottom))
    }
}

private struct SeenInViewport: ViewModifier {
    let probe: String?
    let seen: () -> Void
    @Environment(\.cardViewport) private var viewport
    func body(content: Content) -> some View {
        content.background {
            GeometryReader { g in
                let f = g.frame(in: .global)
                Color.clear
                    .onAppear { check(f, viewport) }
                    .onChange(of: f) { _, new in check(new, viewport) }
                    .onChange(of: viewport) { _, new in check(f, new) }
            }
        }
    }
    private func check(_ frame: CGRect, _ viewport: CGRect) {
        #if DEBUG
        if let probe { SeenProbe.shared.last[probe] = "f=\(Int(frame.minY))..\(Int(frame.maxY)) x\(Int(frame.minX))..\(Int(frame.maxX)) v=\(Int(viewport.minY))..\(Int(viewport.maxY)) x\(Int(viewport.minX))..\(Int(viewport.maxX))" }
        #endif
        guard viewport.height > 1, frame.height > 0 else { return }
        if viewport.insetBy(dx: -1, dy: -1).contains(frame) { seen() }
    }
}
