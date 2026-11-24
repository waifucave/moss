import Foundation
import Observation

/// One conversation: a bot's single one, or a coding session's. A turn shows as ONE plain status line, never its tool calls.
@MainActor @Observable
public final class ConversationModel {
    public enum Source: Hashable, Sendable {
        case bot(Bot)
        case session(SessionRow)
    }

    public let source: Source
    public private(set) var messages: [ChatMessage] = []
    public private(set) var statusLine: String?
    public private(set) var hasEarlier = false
    public private(set) var errorText: String?
    public var draft = ""

    @ObservationIgnored private let client: EngineClient
    @ObservationIgnored private var sessionID: String
    @ObservationIgnored private var listener: Task<Void, Never>?
    @ObservationIgnored private let makeID: () -> String

    public init(source: Source, client: EngineClient, makeID: @escaping () -> String = { UUID().uuidString }) {
        self.source = source; self.client = client; self.makeID = makeID
        switch source {
        case .bot(let b): sessionID = b.mainSession
        case .session(let s): sessionID = s.id
        }
    }

    public var title: String {
        switch source {
        case .bot(let b): return b.name
        case .session(let s): return s.title ?? "Session"
        }
    }
    public var isRunning: Bool { statusLine != nil }
    public var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    public var placeholder: String {
        switch source {
        case .bot(let b): return "Message \(b.name)"
        case .session: return "Message"
        }
    }

    public func load() async {
        do {
            let page: MessagePage
            switch source {
            case .bot(let b): page = try await client.conversation(bot: b.id, before: nil, limit: 60)
            case .session(let s): page = try await client.history(session: s.id, before: nil, limit: 60)
            }
            sessionID = page.session
            messages = page.messages
            hasEarlier = page.hasMore
            errorText = nil
            if case .bot(let b) = source { try? await client.markRead(bot: b.id) }
        } catch {
            errorText = "Can't reach your computer."
        }
    }

    public func loadEarlier() async {
        guard let first = messages.first, hasEarlier else { return }
        do {
            let page: MessagePage
            switch source {
            case .bot(let b): page = try await client.conversation(bot: b.id, before: first.at, limit: 60)
            case .session(let s): page = try await client.history(session: s.id, before: first.at, limit: 60)
            }
            messages = page.messages + messages
            hasEarlier = page.hasMore
        } catch { errorText = "Can't reach your computer." }
    }

    public func start() {
        guard listener == nil else { return }
        listener = Task { [weak self] in
            guard let self else { return }
            let stream = await client.events()
            await self.load()
            for await event in stream { self.apply(event) }
        }
    }
    public func stopListening() { listener?.cancel(); listener = nil }

    public func apply(_ event: EngineEvent) {
        switch event {
        case .message(let subject, let m) where subject == sessionID:
            if !messages.contains(where: { $0.id == m.id }) { messages.append(m) }
        case .statusLine(let subject, let line) where subject == sessionID:
            statusLine = line
        default: break
        }
    }

    public func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let id = makeID()
        do {
            try await client.send(session: sessionID, text: text, clientMessageId: id)
            draft = ""
            errorText = nil
        } catch {
            // The words stay in the composer so nothing is lost.
            errorText = "Your message wasn't sent. It is still here."
        }
    }

    public func stop() async {
        do { try await client.stop(session: sessionID) } catch { errorText = "That didn't work." }
    }
}
