import SwiftUI

/// MOSS Code's new session: the agent, its model and effort, and the folder.
public struct NewSessionScreen: View {
    @Bindable var model: NewSessionModel
    let onStarted: (String) -> Void
    let onCancel: () -> Void

    public init(model: NewSessionModel, onStarted: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.model = model; self.onStarted = onStarted; self.onCancel = onCancel
    }

    public var body: some View {
        NavigationStack {
            Form {
                if model.loadFailed {
                    Section { UnreachableNotice(onRetry: { Task { await model.load() } }) }
                } else if model.loading {
                    Section { HStack { ProgressView(); Text("Loading").foregroundStyle(.secondary) } }
                } else {
                    Section {
                        Picker("Agent", selection: $model.backend) {
                            ForEach(model.backends) { b in
                                Label { Text(b.name) } icon: { AgentMarkView(backend: b.id, size: 22) }.tag(b.id)
                            }
                        }
                        .pickerStyle(.navigationLink)
                        if let o = model.options, !o.known {
                            Text("This agent shows its models once the session starts.").font(.footnote).foregroundStyle(.secondary)
                        }
                        if !model.modelChoices.isEmpty {
                            Picker("Model", selection: $model.model) {
                                ForEach(model.modelChoices) { m in Text(m.name).tag(Optional(m.id)) }
                            }
                            if !model.efforts.isEmpty {
                                Picker("Effort", selection: $model.effort) {
                                    ForEach(model.efforts, id: \.self) { e in Text(e.capitalized).tag(Optional(e)) }
                                }
                                .pickerStyle(.segmented)
                            }
                        }
                    } header: { FormHeader("Agent") }
                    Section {
                        ForEach(model.folders, id: \.self) { f in
                            Button {
                                model.pickedFolder = f; model.typedFolder = ""
                            } label: {
                                HStack {
                                    Label(f, systemImage: "folder").foregroundStyle(.primary).lineLimit(2)
                                    Spacer()
                                    if model.typedFolder.isEmpty, model.pickedFolder == f { Image(systemName: "checkmark").foregroundStyle(.primary) }
                                }
                            }
                            .accessibilityAddTraits(model.typedFolder.isEmpty && model.pickedFolder == f ? [.isSelected] : [])
                        }
                        // The prompt in the readable grey (the system's placeholder grey is fainter).
                        TextField("Another folder: type or paste a path", text: $model.typedFolder,
                                  prompt: Text("Another folder: type or paste a path").foregroundStyle(Theme.subtle), axis: .vertical)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .font(.system(.body, design: .monospaced))
                    } header: { FormHeader("Folder") } footer: { Text("Folders of your existing sessions come first. A path is the folder's place on your computer.").foregroundStyle(Theme.subtle) }
                    if let e = model.errorText { Section { Label(e, systemImage: "exclamationmark.circle").foregroundStyle(.secondary) } }
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { Task { if let id = await model.start() { onStarted(id) } } }.disabled(!model.canStart)
                }
            }
            .task { await model.load() }
        }
    }
}
