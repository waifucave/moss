import SwiftUI

/// Settings: the paired computer, Unpair behind a confirmation, and the app's version.
public struct SettingsScreen: View {
    @Bindable var model: SettingsModel
    let appName: String
    let onUnpaired: () -> Void
    let onDone: () -> Void
    @Environment(\.nowMs) private var nowOverride

    public init(model: SettingsModel, appName: String, onUnpaired: @escaping () -> Void, onDone: @escaping () -> Void) {
        self.model = model; self.appName = appName; self.onUnpaired = onUnpaired; self.onDone = onDone
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    if let c = model.computer {
                        LabeledContent("Name", value: c.name)
                        LabeledContent("This phone", value: c.deviceName)
                        LabeledContent("Status", value: model.lastSeenText(now: nowOverride ?? Int64(Date().timeIntervalSince1970 * 1000)))
                    } else {
                        Text("Not paired").foregroundStyle(Theme.subtle)
                    }
                } header: { FormHeader("Paired computer") }
                Section {
                    Button("Unpair \(model.computer?.name ?? "computer")", role: .destructive) { model.confirmingUnpair = true }
                        .disabled(model.computer == nil)
                } footer: { Text("This phone forgets the computer. To use \(appName) again, pair it once more. To cut off a lost phone, remove it in the computer's Settings; unpairing here only affects this phone.").foregroundStyle(Theme.subtle) }
                Section {
                    LabeledContent("Version", value: model.version)
                } header: { FormHeader("About") }
            }
            // A hard top edge: the first section's header sits right under the bar, and the soft edge's fade reached it
            // (the contrast audit failed "Paired computer" there, while "About" in the same grey passed).
            .scrollEdgeEffectStyle(.hard, for: .top)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) } }
            .confirmationDialog("Unpair from \(model.computer?.name ?? "this computer")?", isPresented: $model.confirmingUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { Task { await model.unpair(); onUnpaired() } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("You will have to scan the code on your computer again.") }
            .task { await model.load() }
        }
    }
}
