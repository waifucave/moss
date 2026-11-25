import SwiftUI
import QuartzCore

/// The part of a scroll view a person can actually see: its visible rect less the bars over it (the navigation bar, the
/// composer), in the scroll content's coordinates, and only while the surface is presented (settled in its place, the app
/// active, nothing over it). A card reports a part of itself as seen only when that part sits inside this rect; with none
/// (`.zero`) nothing is reported, so an approve stays refused. The model then counts a report only at the next presented
/// frame, and only while the surface stays settled (see `CardsModel.layout(_:_:userScrolling:)`).
struct CardViewportKey: EnvironmentKey { static let defaultValue: CGRect = .zero }
struct CardSurfaceKey: EnvironmentKey { static let defaultValue: String = "" }
/// Something is over the screen (a sheet, the camera, a picker): its cards are not being looked at.
struct CardsCoveredKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var cardViewport: CGRect { get { self[CardViewportKey.self] } set { self[CardViewportKey.self] = newValue } }
    var cardSurface: String { get { self[CardSurfaceKey.self] } set { self[CardSurfaceKey.self] = newValue } }
    var cardsCovered: Bool { get { self[CardsCoveredKey.self] } set { self[CardsCoveredKey.self] = newValue } }
}

extension View {
    /// Applied to the scroll view that holds cards: measures what of it is unobstructed, tells the model when the surface
    /// is presented, and hands the viewport to the cards only then.
    func cardViewport(_ model: CardsModel, covered: Bool = false) -> some View { modifier(CardViewportReader(model: model, coveredHere: covered)) }
    /// Calls `seen` with the surface's id each time this view sits wholly inside the presented viewport.
    func whenSeen(_ seen: @escaping (String) -> Void) -> some View { modifier(SeenInViewport(seen: seen)) }
    /// Applied to the outermost content view inside a card-holding scroll view (after its padding): names the space the
    /// scroll view's visible rect is measured in.
    func cardContent() -> some View { coordinateSpace(.named(cardContentSpace)) }
}

/// The scroll content's own coordinate space: what a card measures itself in, the same space the scroll view's visible
/// rect is given in, so neither a sheet's offset in the window nor how the bars are counted can put the two apart.
let cardContentSpace = "moss.cardContent"

/// Waits until the display has presented the next frame (two refreshes: the one in flight, then one drawn after it).
@MainActor enum FrameClock {
    static func presented() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in FrameTick(c).start() }
    }
}
@MainActor private final class FrameTick: NSObject {
    private var continuation: CheckedContinuation<Void, Never>?
    private var link: CADisplayLink?
    private var ticks = 0
    init(_ c: CheckedContinuation<Void, Never>) { continuation = c }
    func start() {
        let l = CADisplayLink(target: self, selector: #selector(tick))
        l.add(to: .main, forMode: .common)
        link = l
    }
    @objc private func tick() {
        ticks += 1
        guard ticks >= 2 else { return }
        link?.invalidate(); link = nil
        continuation?.resume(); continuation = nil
    }
}

private struct CardViewportReader: ViewModifier {
    let model: CardsModel
    let coveredHere: Bool
    @Environment(\.scenePhase) private var phase
    @Environment(\.cardsCovered) private var coveredAbove
    @State private var surface = UUID().uuidString
    @State private var visible: CGRect = .zero
    /// A drag or its deceleration is in progress: the person is moving it, and looking.
    @State private var userScrolling = false
    @State private var framing: Task<Void, Never>?

    private var inFront: Bool { phase == .active && !coveredAbove && !coveredHere }

    func body(content: Content) -> some View {
        content
            .environment(\.cardViewport, model.isPresented(surface) ? visible : .zero)
            .environment(\.cardSurface, surface)
            // The scroll view's visible rect, in content coordinates, less its content insets: the parts of its bounds the
            // system itself counts as covered (the navigation bar, the composer bar, the home indicator).
            .onScrollGeometryChange(for: CardsModel.SurfaceLayout.self) { g in
                let v = g.visibleRect, i = g.contentInsets
                return CardsModel.SurfaceLayout(contentSize: g.contentSize,
                                                visible: CGRect(x: v.minX + i.leading, y: v.minY + i.top,
                                                                width: max(0, v.width - i.leading - i.trailing), height: max(0, v.height - i.top - i.bottom)))
            } action: { _, new in
                visible = new.visible
                model.layout(surface, new, userScrolling: userScrolling)
            }
            .onScrollPhaseChange { _, p in
                switch p {
                case .tracking, .interacting, .decelerating: userScrolling = true
                case .idle, .animating: userScrolling = false
                @unknown default: userScrolling = false
                }
            }
            .onChange(of: inFront, initial: true) { _, front in model.surface(surface, inFront: front) }
            .onChange(of: phase, initial: true) { _, p in model.setAppActive(p == .active) }
            // The model asks for a presented frame (to settle, or to count what was reported); answer with its ticket.
            .onChange(of: model.frameRequest[surface], initial: true) { _, ticket in
                guard let ticket else { return }
                framing?.cancel()
                framing = Task { @MainActor in
                    await FrameClock.presented()
                    guard !Task.isCancelled else { return }
                    model.framePresented(surface, ticket: ticket)
                }
            }
            .onAppear { model.surface(surface, inFront: inFront) }
            .onDisappear { framing?.cancel(); model.surfaceGone(surface) }
    }
}

private struct SeenInViewport: ViewModifier {
    let seen: (String) -> Void
    @Environment(\.cardViewport) private var viewport
    @Environment(\.cardSurface) private var surface
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
        guard !surface.isEmpty, viewport.height > 1, frame.height > 0 else { return }
        if viewport.insetBy(dx: -1, dy: -1).contains(frame) { seen(surface) }
    }
}
