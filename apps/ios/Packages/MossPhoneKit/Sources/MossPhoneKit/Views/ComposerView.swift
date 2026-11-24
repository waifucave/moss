import SwiftUI
import UIKit
import PhotosUI

/// What a launch asked the composer to start with (for pictures; real runs pass none).
public struct ComposerPreset: Equatable, Sendable {
    public var draft: String?
    public var focus = false
    public var picker = false
    /// Stage a sample file at the start.
    public var file = false
    public init(draft: String? = nil, focus: Bool = false, picker: Bool = false, file: Bool = false) { self.draft = draft; self.focus = focus; self.picker = picker; self.file = file }
}
private struct ComposerPresetKey: EnvironmentKey { static let defaultValue = ComposerPreset() }
extension EnvironmentValues {
    var composerPreset: ComposerPreset { get { self[ComposerPresetKey.self] } set { self[ComposerPresetKey.self] = newValue } }
}

/// The composer of both apps, ported from the earlier phone app's: neutral Liquid Glass that rests as a compact pill, then
/// grows into a rounded rectangle while its field is focused or the keyboard is up. The plus opens its own picker; a row is
/// shown only when the conversation or session in front offers it (`ComposerOffers`), and the microphone and the voice orb are
/// visual only and hidden from VoiceOver until there is voice.
///
/// The send contract: the field clears only when the send was accepted (`ConversationModel.send`); a refused prompt stays in it.
struct ComposerView: View {
    /// The idle waveform control is a touch smaller than the functional send/stop slot; its hit frame stays 44 pt.
    private static let waveformButtonDiameter: CGFloat = 34
    /// The resting pill's height.
    static let restingHeight: CGFloat = 48

    @Bindable var model: ConversationModel
    let placeholder: String

    private enum Page { case rows, effort, model, plugins }

    @State private var isPickerPresented = false
    @State private var page: Page = .rows
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var photoItem: PhotosPickerItem?
    @FocusState private var focused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.composerPreset) private var preset
    /// Drives the widen choreography off the keyboard's own notifications too: focus alone proved unreliable inside the
    /// keyboard-tracking safe-area bar.
    @State private var keyboardUp = false

    private var isExpanded: Bool { focused || keyboardUp }
    private var isStreaming: Bool { model.isRunning }
    private var offers: ComposerOffers { model.offers ?? ComposerOffers() }
    private var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
    /// The rows this conversation offers, in the old picker's order.
    private var hasRows: Bool {
        offers.pictures || offers.files || !offers.commands.isEmpty || !offers.efforts.isEmpty || !offers.models.isEmpty
    }
    private var text: String { model.draft }
    private var canSend: Bool { model.canSend }

    var body: some View {
        VStack(spacing: 8) {
            if !model.staged.isEmpty || !model.stagedFiles.isEmpty { stagedStrip }
            composerBody
        }
        .task {
            if let d = preset.draft { model.draft = d }
            if preset.file { try? await Task.sleep(for: .milliseconds(700)); await model.stageFile(name: "Quarterly report.pdf", size: 1_240_000, data: Data(count: 1_240_000)) }
            if preset.focus { try? await Task.sleep(for: .milliseconds(600)); focused = true }
            if preset.picker { try? await Task.sleep(for: .milliseconds(900)); withAnimation(.snappy(duration: 0.25)) { isPickerPresented = true } }
        }
        .photosPicker(isPresented: $showPhotos, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task { await addPhoto(item) }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { Task { await addFile(url) } }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { data in if let data { Task { await add(data) } } }.ignoresSafeArea()
        }
    }

    private var composerBody: some View {
        VStack(alignment: .leading, spacing: isExpanded ? 10 : 0) {
            HStack(spacing: 8) {
                if !isExpanded, hasRows { attachmentMenu }
                composerField
                if !isExpanded { trailingControls }
            }
            .padding(.top, isExpanded ? 18 : 0)
            .padding(.leading, isExpanded ? 16 : (hasRows ? 6 : 18))
            .padding(.trailing, isExpanded ? 16 : 2)

            if isExpanded {
                HStack(spacing: 8) {
                    if hasRows { attachmentMenu }
                    Spacer(minLength: 8)
                    trailingControls
                }
                .padding(.leading, 8)
                .padding(.trailing, 4)
                .padding(.bottom, 4)
            }
        }
        .frame(height: isExpanded ? nil : Self.restingHeight)
        .modifier(ComposerChrome(horizontal: isExpanded ? 12 : 36, bottom: isExpanded ? 12 : 6, radius: isExpanded ? 28 : 999))
        .animation(.snappy(duration: 0.25), value: isExpanded)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboardUp = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboardUp = false }
        .onChange(of: scenePhase) { _, phase in if phase != .active { isPickerPresented = false } }
        .onChange(of: isPickerPresented) { _, open in if !open { page = .rows } }
    }

    // MARK: Controls

    private var composerField: some View {
        TextField(placeholder, text: $model.draft, prompt: Text(placeholder).foregroundStyle(.secondary), axis: .vertical)
            .textFieldStyle(.plain)
            .font(.body)
            .lineLimit(1...5)
            .focused($focused)
            .submitLabel(.send)
            .accessibilityLabel(placeholder)
    }

    private func composerIcon(_ symbol: String, font: Font) -> some View {
        Image(systemName: symbol).font(font).imageScale(.large).foregroundStyle(.primary)
            .frame(width: 36, height: 36).contentShape(.circle)
    }

    /// A bare 36 pt decorative glyph slot (the microphone): hidden from VoiceOver so it never presents as a dead control.
    private func mockIcon(_ symbol: String, font: Font) -> some View {
        composerIcon(symbol, font: font).accessibilityHidden(true)
    }

    private var attachmentMenu: some View {
        Button {
            withAnimation(.snappy(duration: 0.25)) { isPickerPresented.toggle() }
        } label: {
            composerIcon("plus", font: Font.callout.weight(.medium)).opacity(isPickerPresented ? 0 : 1)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add to message")
        .background {
            ComposerAttachmentPresentation(isPresented: $isPickerPresented, isExpanded: isExpanded) { picker }
        }
    }

    // MARK: The picker

    private var picker: some View {
        ViewThatFits(in: .vertical) {
            pickerRows
            ScrollView(.vertical) { pickerRows }.scrollBounceBehavior(.basedOnSize)
        }
        .padding(12)
        .glassEffect(.regular, in: .rect(cornerRadius: 48, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var pickerRows: some View {
        VStack(spacing: 0) {
            switch page {
            case .rows:
                if offers.pictures, cameraAvailable { action("Camera", "camera") { close(); showCamera = true } }
                if offers.pictures { action("Photos", "photo") { close(); showPhotos = true } }
                if offers.files { action("Files", "paperclip") { close(); showFiles = true } }
                if !offers.commands.isEmpty { action("Plugins", "puzzlepiece", chevron: true) { go(.plugins) } }
                if !offers.efforts.isEmpty { action("Effort", "gauge", value: offers.effort, selected: true, chevron: true) { go(.effort) } }
                if !offers.models.isEmpty { action("Model", "cpu", value: offers.models.first { $0.id == offers.model }?.name, chevron: true) { go(.model) } }
            case .effort:
                back("Effort")
                ForEach(offers.efforts, id: \.self) { level in
                    action(level.capitalized, "gauge", selected: level == offers.effort) { Task { await model.setEffort(level) }; close() }
                }
            case .model:
                back("Model")
                ForEach(offers.models) { choice in
                    action(choice.name, "cpu", selected: choice.id == offers.model) { Task { await model.setModel(choice) }; close() }
                }
            case .plugins:
                back("Plugins")
                ForEach(offers.commands) { command in
                    action(command.title, "puzzlepiece") { Task { await model.run(command) }; close() }
                }
            }
        }
    }

    private func go(_ p: Page) { withAnimation(.snappy(duration: 0.2)) { page = p } }
    private func close() { withAnimation(.snappy(duration: 0.2)) { isPickerPresented = false } }

    private func back(_ title: String) -> some View {
        Button { go(.rows) } label: {
            HStack(spacing: 8) {
                Image(systemName: "chevron.left").font(.body.weight(.semibold))
                Text(title).font(.body)
                Spacer()
            }
            .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back from \(title)")
    }

    private func action(_ title: String, _ symbol: String, value: String? = nil, selected: Bool = false, chevron: Bool = false, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            HStack(spacing: 16) {
                Circle().fill(.primary.opacity(0.10)).frame(width: 44, height: 44)
                    .overlay(Image(systemName: symbol).font(Font.body.weight(.semibold)).foregroundStyle(selected ? Theme.accent : .primary))
                Text(title).font(.body).foregroundStyle(selected ? Theme.accent : .primary)
                Spacer(minLength: 8)
                                if selected { Image(systemName: "checkmark").font(Font.body.weight(.semibold)).foregroundStyle(Theme.accent) }
                else if chevron { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 68, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityValue(selected ? "Selected" : "")
    }

    // MARK: Trailing controls

    private var trailingControls: some View {
        HStack(spacing: 4) {
            if text.isEmpty && !isStreaming { mockIcon("mic", font: Font.callout.weight(.medium)) }
            primarySlot
        }
    }

    /// Stop while a turn streams, Send while there is text, otherwise the voice orb. Send and Stop are a 36 pt inverse circle,
    /// the orb 34 pt; every variant keeps the same 44 pt hit slot.
    @ViewBuilder
    private var primarySlot: some View {
        if isStreaming {
            Button { Task { await model.stop() } } label: {
                darkCircle {
                    if model.isInterrupting { ProgressView().tint(Color(uiColor: .systemBackground)) }
                    else { Image(systemName: "stop.fill").font(Font.body.weight(.semibold)).foregroundStyle(Color(uiColor: .systemBackground)) }
                }
                .frame(width: 44, height: 44).contentShape(.circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop")
        } else if !text.isEmpty {
            Button(action: send) {
                darkCircle { Image(systemName: "arrow.up").font(Font.body.weight(.semibold)).foregroundStyle(Color(uiColor: .systemBackground)) }
                    .frame(width: 44, height: 44).contentShape(.circle)
            }
            .buttonStyle(.plain)
            .disabled(!canSend).opacity(canSend ? 1 : 0.5)
            .accessibilityLabel("Send")
        } else {
            darkCircle(diameter: Self.waveformButtonDiameter) {
                Image(systemName: "waveform").font(Font.body.weight(.bold)).foregroundStyle(Color(uiColor: .systemBackground))
            }
            .frame(width: 44, height: 44)
            .accessibilityHidden(true)   // the voice orb is visual only
        }
    }

    private func darkCircle<Content: View>(diameter: CGFloat = 36, @ViewBuilder content: () -> Content) -> some View {
        Circle().fill(Theme.inverse).frame(width: diameter, height: diameter).overlay(content())
    }

    private func send() {
        guard canSend else { return }
        Task {
            if await model.send() {
                focused = false
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }
        }
    }

    // MARK: Pictures

    private var stagedStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(model.stagedFiles) { file in fileChip(file) }
                ForEach(model.staged) { image in
                    ZStack(alignment: .topTrailing) {
                        if let ui = UIImage(data: image.thumbnail) {
                            Image(uiImage: ui).resizable().scaledToFill().frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        Button { model.unstage(image) } label: {
                            Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette)
                                .foregroundStyle(Color(uiColor: .systemBackground), Theme.inverse).font(.title3)
                        }
                        .buttonStyle(.plain).offset(x: 6, y: -6)
                        .accessibilityLabel("Remove picture")
                    }
                    .padding(.top, 6).padding(.trailing, 6)
                }
            }
            .padding(.horizontal, 40)
        }
        .scrollIndicators(.hidden)
    }

    private func fileChip(_ file: StagedFile) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "doc").font(.body).foregroundStyle(.secondary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(file.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: file.size, countStyle: .file)).font(.caption).foregroundStyle(.secondary)
            }
            Button { model.unstageFile(file) } label: {
                Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(Color(uiColor: .systemBackground), Theme.inverse).font(.title3)
                    .frame(minWidth: 44, minHeight: 44).contentShape(.rect)
            }
            .buttonStyle(.plain).accessibilityLabel("Remove \(file.name)")
        }
        .padding(.leading, 12).padding(.vertical, 2)
        .glassEffect(.regular, in: .rect(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func addFile(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        await model.stageFile(name: url.lastPathComponent, size: size, data: try? Data(contentsOf: url))
    }

    private func addPhoto(_ item: PhotosPickerItem) async {
        defer { photoItem = nil }
        if let data = try? await item.loadTransferable(type: Data.self) { await add(data) }
    }
    private func add(_ data: Data) async {
        guard let ui = UIImage(data: data) else { return }
        let thumb = ui.preparingThumbnail(of: CGSize(width: 168, height: 168))?.pngData() ?? data
        await model.stage(data, thumbnail: thumb)
    }
}

/// The camera, for the Camera row where the phone has one.
struct CameraPicker: UIViewControllerRepresentable {
    let done: (Data?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(done) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController(); p.sourceType = .camera; p.delegate = context.coordinator; return p
    }
    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (Data?) -> Void
        init(_ done: @escaping (Data?) -> Void) { self.done = done }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.85)); picker.dismiss(animated: true)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil); picker.dismiss(animated: true) }
    }
}

/// The question box: while a question waits, the composer's place becomes this box, in the composer's own material.
struct QuestionComposerView: View {
    let question: AskQuestion
    let onSubmit: ([String: String]) async -> Bool
    @State private var selected = Set<Int>()
    @State private var other = ""
    @State private var submitting = false

    private var answer: String {
        var parts = selected.sorted().map { question.options[$0].label }
        let o = other.trimmingCharacters(in: .whitespacesAndNewlines)
        if !o.isEmpty { parts.append(o) }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let h = question.header { Text(h).font(.footnote.weight(.semibold)).foregroundStyle(.secondary) }
            Text(question.text).font(.body).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(question.options.indices, id: \.self) { i in
                    if i > 0 { Divider() }
                    Button {
                        if question.multiSelect { if selected.contains(i) { selected.remove(i) } else { selected.insert(i) } }
                        else { selected = [i] }
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(question.options[i].label).font(.body)
                                if let d = question.options[i].detail { Text(d).font(.footnote).foregroundStyle(.secondary) }
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Theme.accent)
                                .opacity(selected.contains(i) ? 1 : 0).frame(width: 32).accessibilityHidden(true)
                        }
                        .padding(.vertical, 10).frame(minHeight: 44).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected.contains(i) ? .isSelected : [])
                }
                Divider()
                TextField("Something else", text: $other).padding(.vertical, 12).accessibilityLabel("Something else")
            }
            HStack {
                Spacer()
                Button {
                    submitting = true
                    Task { _ = await onSubmit([question.header ?? question.text: answer]); submitting = false }
                } label: {
                    Text("Submit").font(.body.weight(.semibold)).foregroundStyle(Color(uiColor: .systemBackground))
                        .padding(.horizontal, 20).frame(height: 44).background(Color.primary, in: Capsule())
                }
                .buttonStyle(.plain).disabled(answer.isEmpty || submitting).opacity(answer.isEmpty ? 0.4 : 1)
            }
        }
        .padding(16)
        .modifier(ComposerChrome(horizontal: 12, bottom: 12, radius: 28))
    }
}
