import SwiftUI

/// The plain theme of the desktop, on Apple's own components: neutral greys, no blue accent.
public enum Theme {
    /// The user's bubble: dark grey on the right (light grey in dark mode, so it still stands out).
    public static let userBubble = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.30, alpha: 1) : UIColor(white: 0.17, alpha: 1) })
    public static let userBubbleText = Color.white
    public static let botBubble = Color(uiColor: .secondarySystemFill)
    /// The one accent: the text colour itself (ink on light, paper on dark).
    public static let accent = Color.primary
    public static let ink = Color(red: 0x1B / 255, green: 0x1D / 255, blue: 0x2B / 255)
    public static let paper = Color(red: 0xF6 / 255, green: 0xF4 / 255, blue: 0xEE / 255)

    public static func color(hex: String) -> Color {
        var s = hex; if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return .gray }
        return Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

// MARK: Time

private struct NowKey: EnvironmentKey { static let defaultValue: Int64? = nil }
public extension EnvironmentValues {
    /// Epoch milliseconds to count times from; `nil` means the real clock. The fake sets it so pictures stay still.
    var nowMs: Int64? {
        get { self[NowKey.self] }
        set { self[NowKey.self] = newValue }
    }
}

public enum TimeText {
    /// "now", "4 min", "3 h", "Yesterday", then the weekday, then the date.
    public static func short(at: Int64, now: Int64, calendar: Calendar = .current) -> String {
        let seconds = max(0, (now - at) / 1000)
        if seconds < 60 { return "Now" }
        if seconds < 3600 { return "\(seconds / 60) min" }
        let date = Date(timeIntervalSince1970: Double(at) / 1000), today = Date(timeIntervalSince1970: Double(now) / 1000)
        if calendar.isDate(date, inSameDayAs: today) { return "\(seconds / 3600) h" }
        if let y = calendar.date(byAdding: .day, value: -1, to: today), calendar.isDate(date, inSameDayAs: y) { return "Yesterday" }
        if seconds < 6 * 86400 { return date.formatted(.dateTime.weekday(.wide)) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}
