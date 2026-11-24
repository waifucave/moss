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
    /// A message that did not go: its words stay in the composer, and Retry sends it again under the same id (never twice).
    public private(set) var failedSend: (text: String, id: String)?
    public var draft = ""
    /// What the composer's picker may offer here; `nil` until read.
    public private(set) var offers: ComposerOffers?
    /// The question waiting in this conversation: the composer's place is taken by it.
    public private(set) var question: AskQuestion?
    public private(set) var staged: [StagedImage] = []
    public private(set) var stagedFiles: [StagedFile] = []
    public private(set) var isInterrupting = false
    public var kind: ConversationKind { if case .bot = source { return .bot } else { return .codingSession } }

    @ObservationIgnored private let client: EngineClient
    @ObservationIgnored private var sessionID: String
    @ObservationIgnored private var listener: Task<Void, Never>?
    @ObservationIgnored private let makeID: () -> String
    @ObservationIgnored private let autoSend: String?

    public init(source: Source, client: EngineClient, makeID: @escaping () -> String = { UUID().uuidString }, autoSend: String? = nil) {
        self.autoSend = autoSend
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
            await self.loadComposer()
            if let t = self.autoSend { self.draft = t; await self.send() }
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

    /// Sends the draft. The field clears only when the send was accepted: a refused prompt stays in it (and so does a picture).
    @discardableResult
    public func send() async -> Bool {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        let id = failedSend?.text == text ? failedSend!.id : makeID()
        do {
            try await client.send(session: sessionID, text: text, clientMessageId: id, images: staged.map(\.path), files: stagedFiles.map(\.path))
            draft = ""
            staged = []; stagedFiles = []
            errorText = nil
            failedSend = nil
            return true
        } catch {
            // The words stay in the composer so nothing is lost.
            failedSend = (text, id)
            errorText = "Your message wasn't sent. It is still here."
            return false
        }
    }

    // MARK: Composer

    public func loadComposer() async {
        offers = try? await client.composerOffers(session: sessionID, kind: kind)
        question = try? await client.pendingQuestion(session: sessionID)
    }
    public func setEffort(_ effort: String) async {
        do { try await client.setModel(session: sessionID, model: nil, effort: effort); offers?.effort = effort }
        catch { errorText = "That didn't work." }
    }
    public func setModel(_ choice: ModelChoice) async {
        do {
            let effort = choice.efforts.contains(offers?.effort ?? "") ? offers?.effort : choice.efforts.first
            try await client.setModel(session: sessionID, model: choice.id, effort: effort)
            offers?.model = choice.id; offers?.efforts = choice.efforts; offers?.effort = effort
        } catch { errorText = "That didn't work." }
    }
    public func run(_ command: PluginCommand) async {
        do { try await client.runCommand(session: sessionID, command: command.id) } catch { errorText = "That didn't work." }
    }
    public func stage(_ data: Data, thumbnail: Data) async {
        do { staged.append(StagedImage(path: try await client.stageImage(session: sessionID, data: data), thumbnail: thumbnail)) }
        catch { errorText = "That picture couldn't be added." }
    }
    /// A picked file: refused with a plain line when it is over the limit, before any of it is read or sent.
    public func stageFile(name: String, size: Int64, data: @autoclosure () -> Data?) async {
        if let limit = offers?.fileLimit, size > limit {
            errorText = "That file is too big. The limit is \(ByteCountFormatter.string(fromByteCount: limit, countStyle: .file))."
            return
        }
        guard let d = data() else { errorText = "That file couldn't be read."; return }
        do { stagedFiles.append(try await client.stageFile(session: sessionID, name: name, data: d)); errorText = nil }
        catch let e as FileTooLarge { errorText = "That file is too big. The limit is \(ByteCountFormatter.string(fromByteCount: e.limit, countStyle: .file))." }
        catch { errorText = "That file couldn't be added." }
    }
    public func unstageFile(_ file: StagedFile) { stagedFiles.removeAll { $0 == file } }
    public func unstage(_ image: StagedImage) { staged.removeAll { $0 == image } }
    public func answerQuestion(_ answers: [String: String]) async -> Bool {
        guard let q = question else { return false }
        do { try await client.answerQuestion(session: sessionID, question: q, answers: answers); question = nil; return true }
        catch { errorText = "That didn't work. The question is still waiting."; return false }
    }

    /// Sends the message that failed again.
    public func retry() async { await send() }

    public func stop() async {
        isInterrupting = true
        defer { isInterrupting = false }
        do { try await client.stop(session: sessionID) } catch { errorText = "That didn't work." }
    }
}
