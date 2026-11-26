import SwiftUI

/// A light round button, as in the owner's reference: glass, 40 pt, with a 44 pt touch area.
struct RoundButton: View {
    let symbol: String
    let label: String
    var badge: Int = 0
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.primary)
                .frame(width: 40, height: 40)
                .glassEffect(.regular.interactive(), in: .circle)
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        Text("\(badge)").font(.caption2.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
                            .background(Theme.waitingFill, in: Capsule())
                            .offset(x: 6, y: -4)
                            .accessibilityHidden(true)
                    }
                }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// The top row of both apps: the person's avatar (Settings) at the left; the bell (only while something waits), search and plus at the right.
struct TopBar: View {
    let waiting: Int
    let plusLabel: String
    let onSettings: () -> Void
    let onBell: () -> Void
    let onSearch: () -> Void
    let onPlus: () -> Void
    var body: some View {
        HStack(spacing: 6) {
            Button(action: onSettings) {
                Text("Y").font(.system(size: 18, weight: .semibold)).foregroundStyle(Color(uiColor: .systemBackground))
                    .frame(width: 40, height: 40).background(Color.primary, in: Circle())
                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel("Settings")
            Spacer(minLength: 8)
            if waiting > 0 { RoundButton(symbol: "bell", label: waiting == 1 ? "1 thing needs you" : "\(waiting) things need you", badge: waiting, action: onBell) }
            RoundButton(symbol: "magnifyingglass", label: "Search", action: onSearch)
            RoundButton(symbol: "plus", label: plusLabel, action: onPlus)
        }
        .padding(.top, 2)
    }
}

struct SearchField: View {
    @Binding var text: String
    let prompt: String
    let onCancel: () -> Void
    @FocusState private var focused: Bool
    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
                TextField(prompt, text: $text).focused($focused).submitLabel(.search).autocorrectionDisabled()
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.softButton, in: Capsule())
            Button("Cancel", action: onCancel).foregroundStyle(.primary)
        }
        .onAppear { focused = true }
    }
}

/// The dot at a face's lower right: blue for unread.
struct UnreadDot: View {
    let size: CGFloat
    var body: some View {
        Circle().fill(Theme.unreadDot).frame(width: size, height: size)
            .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
            .accessibilityHidden(true)
    }
}

/// "Needs you", before a row's last line.
struct NeedsYouTag: View {
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Theme.waiting).frame(width: 7, height: 7)
            Text("Needs you").fontWeight(.medium).foregroundStyle(Theme.waitingText)
        }
        .accessibilityHidden(true)
    }
}

/// What the plus does in MOSS: make a bot. A name, and a model with the computer's default preselected.
struct NewBotSheet: View {
    @Bindable var model: NewBotModel
    let computer: String?
    let onCreated: (Bot) -> Void
    let onCancel: () -> Void
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $model.name).focused($nameFocused).textInputAutocapitalization(.words).submitLabel(.done)
                } footer: { Text("The bot is made on \(computer ?? "your computer") and its conversation opens here.") }
                Section("Model") {
                    if model.loading { ProgressView() }
                    else if let o = model.options, !o.models.isEmpty {
                        Picker("Model", selection: Binding(get: { model.model ?? o.defaultModel ?? "" }, set: { model.model = $0 })) {
                            ForEach(o.models) { m in Text(m.name).tag(m.id) }
                        }
                        .pickerStyle(.menu)
                    }
                }
                if let e = model.errorText {
                    Section { Label(e, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("New bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { if let b = await model.create() { onCreated(b) } } }.disabled(!model.canCreate)
                }
            }
            .task { await model.load(); nameFocused = true }
        }
        .presentationDetents([.medium, .large])
    }
}

/// The gathered list of cards, behind the bell.
struct NeedsYouSheet: View {
    let cards: CardsModel
    let who: (Card) -> String
    let onDone: () -> Void
    var body: some View {
        NavigationStack {
            CardsScreen(model: cards, who: who)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) } }
        }
    }
}
