import Foundation
import CoreGraphics
import Observation

/// Why a card on the screen can no longer be answered.
public enum CardNote: Equatable, Sendable {
    case expired
    case answeredElsewhere
    case failed
    /// The computer turned the answer away, and said why (its words, cleaned).
    case refused(String)
    public var text: String {
        switch self {
        case .expired: return "This card expired before it was answered."
        case .answeredElsewhere: return "Already answered on another device."
        case .failed: return "That didn't work. The card is still waiting."
        case .refused(let why): return "Your computer didn't take that answer: \(why)"
        }
    }
}

/// The cards waiting for the person. Which of them this app shows is the client's answer (`shows(_:in:)`).
@MainActor @Observable
public final class CardsModel {
    public private(set) var cards: [Card] = []
    public private(set) var answering: Set<String> = []
    public private(set) var notes: [String: CardNote] = [:]
    public private(set) var loadFailed = false
    public private(set) var loaded = false
    @ObservationIgnored private let client: EngineClient
    @ObservationIgnored private let app: PhoneApp
    @ObservationIgnored private let now: @Sendable () -> Int64
    @ObservationIgnored private var listener: Task<Void, Never>?
    @ObservationIgnored private var answeredHere: Set<String> = []
    /// Cards whose buttons wait: just arrived, changed, or moved because one above them left. A press can't land on a
    /// card that slid under the finger; the model refuses an answer inside the wait, whatever the view shows.
    public private(set) var settling: Set<String> = []
    @ObservationIgnored private var settleTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private let settleWait: Duration
    /// The cut fields the person has opened, per card: a card is answered only once every cut field was on screen.
    public private(set) var opened: [String: Set<String>] = [:]

    /// The cards the view reported on screen whole, by id and hash: its heading has been on screen. A card is one column
    /// with its buttons last, so a person at the buttons who has seen the heading has had every field in between on screen
    /// (a tall card opened at its bottom has not). An approve is refused until this report, by default: never before it.
    public private(set) var sighted: Set<String> = []
    private static func key(_ c: Card) -> String { c.id + "#" + c.hash }

    public init(client: EngineClient, app: PhoneApp, now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                settleWait: Duration = .milliseconds(1200)) {
        self.client = client; self.app = app; self.now = now; self.settleWait = settleWait
    }
    // MARK: What counts as on screen
    //
    // A report counts only if it was made on a surface (one screen holding cards) the person is looking at in its
    // settled place, and the surface stayed so until a frame was presented after it:
    //  (a) a surface is settled only once its content size AND its visible rect have held unchanged through a presented
    //      frame (so the conversation placed at its bottom, rows measured, nothing moving it);
    //  (b) nothing counts while the app is not active, or while the surface is covered or not in front;
    //  (c) a change of the content's size, or a move of the offset the person didn't make (an anchor, a scroll-to, a
    //      re-placing), unsettles the surface and drops what was reported in that pass. While the person scrolls (a drag
    //      or its deceleration) the offset moves under their eyes: those moves don't unsettle it.

    /// What the scroll view showed: its content's size and the visible rect (in content coordinates, less the bars).
    public struct SurfaceLayout: Equatable, Sendable {
        public var contentSize: CGSize
        public var visible: CGRect
        public init(contentSize: CGSize, visible: CGRect) { self.contentSize = contentSize; self.visible = visible }
    }
    private struct Surface {
        var layout: SurfaceLayout?
        /// The layout the surface must still show at the next presented frame to settle.
        var candidate: SurfaceLayout?
        var settled = false
        var inFront = false
        var generation = 0
        var pending: [(Int, Report)] = []
    }
    private enum Report { case sighted(Card), readEnd(String, Card) }
    @ObservationIgnored private var surfaces: [String: Surface] = [:]
    @ObservationIgnored private var ticketGeneration: [Int: Int] = [:]
    @ObservationIgnored private var nextTicket = 0
    public private(set) var appActive = true
    /// The surfaces presented now: settled, in front, the app active. Only their viewport is handed to the cards.
    public private(set) var presentedSurfaces: Set<String> = []
    /// Per surface, the frame it waits for: the view presents a frame and answers `framePresented(_:ticket:)`.
    public private(set) var frameRequest: [String: Int] = [:]

    public func isPresented(_ surface: String) -> Bool { presentedSurfaces.contains(surface) }

    /// The view's word: the surface is in front (its screen showing, nothing over it) or not.
    public func surface(_ id: String, inFront: Bool) {
        var s = surfaces[id] ?? Surface()
        s.inFront = inFront
        surfaces[id] = s
        unsettle(id)
    }
    /// The scroll view's latest layout. A size change, or a move the person didn't make, unsettles the surface.
    public func layout(_ id: String, _ layout: SurfaceLayout, userScrolling: Bool) {
        var s = surfaces[id] ?? Surface()
        let old = s.layout
        s.layout = layout
        surfaces[id] = s
        if old == nil || old?.contentSize != layout.contentSize || (old?.visible != layout.visible && !userScrolling) {
            unsettle(id)
        } else if userScrolling, !s.settled {
            // Scrolled by the person before it settled: settle on where they are.
            surfaces[id]?.candidate = layout
        }
    }
    /// The surface left the screen (or its conversation is reloaded): nothing from it counts.
    public func surfaceGone(_ id: String) {
        surfaces[id] = nil; presentedSurfaces.remove(id); frameRequest[id] = nil
    }
    /// The app's scene phase: only an active app's surfaces count.
    public func setAppActive(_ active: Bool) {
        guard active != appActive else { return }
        appActive = active
        for id in surfaces.keys { unsettle(id) }
    }
    private func unsettle(_ id: String) {
        guard var s = surfaces[id] else { return }
        s.generation += 1
        s.settled = false
        s.pending = []
        s.candidate = s.layout
        surfaces[id] = s
        presentedSurfaces.remove(id)
        if s.inFront && appActive { requestFrame(id) } else { frameRequest[id] = nil }
    }
    private func requestFrame(_ id: String) {
        nextTicket += 1
        ticketGeneration[nextTicket] = surfaces[id]?.generation
        frameRequest[id] = nextTicket
    }

    /// The view's report: this card, as it is now (id and hash), has been on screen from its heading, on `surface`. It
    /// counts at the next presented frame, if the surface is still settled and unchanged then.
    public func sighted(_ card: Card, on surface: String) { hold(.sighted(card), on: surface) }
    /// The view's report: the end of an opened field of this card (as it is now) has been on screen, on `surface`.
    public func readEnd(_ field: String, of card: Card, on surface: String) { hold(.readEnd(field, card), on: surface) }
    private func hold(_ report: Report, on id: String) {
        guard appActive, presentedSurfaces.contains(id), var s = surfaces[id] else { return }
        s.pending.append((s.generation, report))
        surfaces[id] = s
        requestFrame(id)
    }
    /// The view's word that a frame was presented after the request `ticket`. A request made before the surface last
    /// changed is stale and ignored. An unsettled surface whose layout held settles; a settled one counts its reports.
    public func framePresented(_ id: String, ticket: Int) {
        let gen = ticketGeneration.removeValue(forKey: ticket)
        guard var s = surfaces[id], gen == s.generation else { return }
        if frameRequest[id] == ticket { frameRequest[id] = nil }
        guard appActive, s.inFront else { return }
        if !s.settled {
            guard let l = s.layout, l == s.candidate, l.contentSize.height > 0 else { return }
            s.settled = true
            surfaces[id] = s
            presentedSurfaces.insert(id)
            return
        }
        let held = s.pending; s.pending = []
        surfaces[id] = s
        for (g, report) in held where g == s.generation {
            switch report {
            case .sighted(let card): if cards.contains(card) { sighted.insert(Self.key(card)) }
            case .readEnd(let field, let card):
                // A box of a cut checkbox list counts once that list is opened; any other field once it is.
                let owner = field.hasPrefix(Card.childrenField + "/") ? Card.childrenField : field
                if cards.contains(card), opened[card.id]?.contains(owner) == true { readToEnd.insert(Self.key(card, field)) }
            }
        }
    }

    /// Why its approve buttons don't answer now, in one line for the card, or nil when they do. (Deny waits only out the
    /// moment after a card shows or changes: refusing is always possible.)
    public func waitReason(_ card: Card) -> String? {
        if !card.drawnWhole || note(for: card) != nil { return nil }
        if settling.contains(card.id) { return "Wait a moment: this card just arrived or changed." }
        if !sighted.contains(Self.key(card)) { return "Scroll up to the top of this card first: answer only what you have seen." }
        let n = card.cutFields.subtracting(opened[card.id] ?? []).count
        if n > 0 { return n == 1 ? "Open the part cut short above first." : "Open the \(n) parts cut short above first." }
        if !seenWhole(card) { return "Scroll through what you opened, to its end, first." }
        return nil
    }

    /// The cut fields whose LAST line has been on screen after they were opened, by card id, hash and field (the view's
    /// report). Opening is not enough: what grows out of sight was not read.
    public private(set) var readToEnd: Set<String> = []
    private static func key(_ c: Card, _ field: String) -> String { c.id + "#" + c.hash + "#" + field }

    /// Every cut field of the card was opened and read to its end (or it has none).
    /// A cut field counts once its end has been on screen; a cut list of checkboxes only once EVERY box has been, each in
    /// a settled frame (a fast scroll to its end could skip the middle boxes, ticked by default on a group card).
    public func seenWhole(_ card: Card) -> Bool {
        card.cutFields.allSatisfy { field in
            guard field == Card.childrenField else { return readToEnd.contains(Self.key(card, field)) }
            return (card.children ?? []).allSatisfy { readToEnd.contains(Self.key(card, Self.boxField($0.id))) }
        }
    }
    /// The read mark of one checkbox of a cut list.
    private static func boxField(_ child: String) -> String { Card.childrenField + "/" + child }
    /// The person opened a cut field: it counts only once its end has been on screen, so an approve waits again. Opening
    /// the checkboxes forgets which boxes were seen: each is seen again in the opened list.
    public func open(_ field: String, of card: Card) {
        opened[card.id, default: []].insert(field)
        readToEnd.remove(Self.key(card, field))
        if field == Card.childrenField { for c in card.children ?? [] { readToEnd.remove(Self.key(card, Self.boxField(c.id))) } }
    }
    /// The view's report: this checkbox of an opened cut list (of the card as it is now) has been on screen, on `surface`.
    public func boxSeen(_ child: String, of card: Card, on surface: String) {
        guard (card.children ?? []).contains(where: { $0.id == child }) else { return }
        hold(.readEnd(Self.boxField(child), card), on: surface)
    }
    /// Whether this option answers now. Every option: drawn whole, not inside the moment after it showed or changed, not
    /// busy, nothing noted. An approve also: on screen from its heading (the view's report) and every cut part opened.
    public func mayAnswer(_ card: Card, with option: CardOption) -> Bool {
        guard card.drawnWhole, !settling.contains(card.id), !answering.contains(card.id), note(for: card) == nil else { return false }
        return option.kind == .deny || (sighted.contains(Self.key(card)) && seenWhole(card))
    }
    /// Whether its approve options answer now (the strictest of its buttons).
    public func mayAnswer(_ card: Card) -> Bool {
        mayAnswer(card, with: CardOption(id: "approve", kind: .approve, label: ""))
    }

    private func settle(_ ids: some Sequence<String>) {
        for id in ids {
            settleTasks[id]?.cancel()
            settling.insert(id)
            let wait = settleWait
            settleTasks[id] = Task { [weak self] in
                try? await Task.sleep(for: wait)
                guard !Task.isCancelled else { return }
                self?.settling.remove(id); self?.settleTasks[id] = nil
            }
        }
    }
    /// The list became `new`: cards that arrived, changed, or now sit somewhere else wait a moment.
    private func replace(with new: [Card]) {
        let old = cards
        var moved: [String] = []
        for (i, c) in new.enumerated() {
            if let j = old.firstIndex(where: { $0.id == c.id }) {
                if old[j] != c { moved.append(c.id); opened[c.id] = nil; sighted.remove(Self.key(old[j])) }
                else if j != i { moved.append(c.id) }
            } else if loaded { moved.append(c.id) }
        }
        cards = new
        for gone in old where !new.contains(where: { $0.id == gone.id }) { sighted.remove(Self.key(gone)) }
        for id in Set(old.map(\.id)).subtracting(new.map(\.id)) { opened[id] = nil; settleTasks[id]?.cancel(); settleTasks[id] = nil; settling.remove(id) }
        settle(moved)
    }

    /// Cards still waiting for an answer (not expired, not answered elsewhere).
    public var waitingCount: Int { cards.filter { note(for: $0) == nil }.count }

    /// The state a card is in: a note when it can't be answered.
    public func note(for card: Card) -> CardNote? {
        if let n = notes[card.id] { return n }
        if card.expiresAt <= now() { return .expired }
        return nil
    }

    public func load() async {
        do {
            let all = try await client.cards()
            var mine: [Card] = []
            for c in all where await client.shows(c, in: app) { mine.append(c) }
            replace(with: mine)
            // A card we hold but the engine no longer lists was settled elsewhere.
            loadFailed = false
        } catch { loadFailed = true }
        loaded = true
    }

    public func start() {
        guard listener == nil else { return }
        listener = Task { [weak self] in
            guard let self else { return }
            let stream = await client.events()
            await self.load()
            for await event in stream {
                await self.apply(event)
                if case .connection(.connected) = event { await self.load() }
            }
        }
    }
    public func stopListening() { listener?.cancel(); listener = nil }

    public func apply(_ event: EngineEvent) async {
        switch event {
        case .cardRequested(let c):
            guard await client.shows(c, in: app) else { break }
            // The same card again with new content replaces the one on screen, in its place (never stale text whose press fails).
            var next = cards
            if let i = next.firstIndex(where: { $0.id == c.id }) { if next[i] != c { next[i] = c; notes[c.id] = nil } }
            else { next.append(c) }
            replace(with: next)
        case .cardResolved(let id):
            if answeredHere.contains(id) { replace(with: cards.filter { $0.id != id }) }
            else if cards.contains(where: { $0.id == id }) { notes[id] = .answeredElsewhere }
        default: break
        }
    }

    /// A plugin OK's checkboxes as the person has them now, per card as it is now (id and hash): new content starts again
    /// from the engine's own defaults.
    public private(set) var ticked: [String: Set<String>] = [:]
    /// Whether this checkbox of the card is ticked now.
    public func isTicked(_ child: String, of card: Card) -> Bool { (ticked[Self.key(card)] ?? card.checkedByDefault).contains(child) }
    /// Ticks or unticks one of the card's checkboxes (only one it has).
    public func toggle(_ child: String, of card: Card) {
        guard cards.contains(card), (card.children ?? []).contains(where: { $0.id == child }), !answering.contains(card.id) else { return }
        var set = ticked[Self.key(card)] ?? card.checkedByDefault
        if set.contains(child) { set.remove(child) } else { set.insert(child) }
        ticked[Self.key(card)] = set
    }
    /// What an answer carries: an approve, the ticked checkboxes; anything else, none.
    func children(for card: Card, with option: CardOption) -> [String] {
        guard option.kind == .approve, let kids = card.children, !kids.isEmpty else { return [] }
        return kids.map(\.id).filter { isTicked($0, of: card) }
    }

    public func answer(_ card: Card, with option: CardOption) async {
        // Only the card as it is on screen now, whole, every cut field opened, and not inside its wait.
        guard cards.contains(card), mayAnswer(card, with: option) else { return }
        answering.insert(card.id)
        defer { answering.remove(card.id) }
        do {
            answeredHere.insert(card.id)
            try await client.answer(card: card, option: option, children: children(for: card, with: option))
            replace(with: cards.filter { $0.id != card.id })
            notes[card.id] = nil
        } catch let e as CardAnswerError {
            answeredHere.remove(card.id)
            switch e {
            case .expired: notes[card.id] = .expired
            case .answeredElsewhere: notes[card.id] = .answeredElsewhere
            case .refused(let why): notes[card.id] = .refused(why)
            // The new card is drawn in its place (its event comes with it); nothing is noted on it.
            case .changed, .notShownWhole: break
            }
        } catch {
            answeredHere.remove(card.id)
            notes[card.id] = .failed
        }
    }

    /// Takes a settled card off the screen.
    public func dismiss(_ card: Card) {
        replace(with: cards.filter { $0.id != card.id })
        notes[card.id] = nil
    }
    /// Lets a failed answer be tried again.
    public func clearFailure(_ card: Card) { if notes[card.id] == .failed { notes[card.id] = nil } }
}
