import SwiftUI

/// What a real link needs to say: the computer can't be reached, and what the person can do about it.
public struct UnreachableNotice: View {
    let computer: String?
    let since: Int64?
    let onRetry: () -> Void
    @Environment(\.nowMs) private var nowOverride

    public init(computer: String? = nil, since: Int64? = nil, onRetry: @escaping () -> Void) { self.computer = computer; self.since = since; self.onRetry = onRetry }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Can't reach \(computer ?? "your computer")", systemImage: "wifi.exclamationmark").font(.headline).fixedSize(horizontal: false, vertical: true)
            Text("Check that it is on and awake, and that it has a network connection. This phone and your computer don't need to be on the same network.")
                .font(.subheadline).foregroundStyle(.secondary)
            // A No to the Local Network question keeps the phone off the computer's own network: it says how to undo it.
            Text("If you answered No when the app asked to find devices on your local network, turn Local Network on for this app in Settings > Privacy & Security > Local Network.")
                .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let since {
                Text("Last connected \(relative(since)).").font(.footnote).foregroundStyle(.secondary)
            }
            Button(action: onRetry) { Text("Try again").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).tint(Theme.accent)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }

    private func relative(_ at: Int64) -> String {
        let now = nowOverride ?? Int64(Date().timeIntervalSince1970 * 1000)
        let f = RelativeDateTimeFormatter(); f.unitsStyle = .full
        return f.localizedString(for: Date(timeIntervalSince1970: Double(at) / 1000), relativeTo: Date(timeIntervalSince1970: Double(now) / 1000))
    }
}
