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
                            .background(Theme.waiting, in: Capsule())
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
            RoundButton(symbol: "person.fill", label: "Settings", action: onSettings)
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
            Text("Needs you").fontWeight(.medium).foregroundStyle(Theme.waiting)
        }
        .accessibilityHidden(true)
    }
}

/// What the plus does in MOSS: a bot is made on the computer for now, and the sheet says so.
struct NewBotSheet: View {
    let computer: String?
    let onDone: () -> Void
    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("A new bot", systemImage: "face.smiling")
            } description: {
                Text("Making a bot needs \(computer ?? "your computer") for now. Make it there and it shows here.")
            }
            .navigationTitle("New bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) } }
        }
        .presentationDetents([.medium])
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
