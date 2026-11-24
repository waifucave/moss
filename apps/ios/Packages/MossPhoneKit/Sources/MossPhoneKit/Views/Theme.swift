import SwiftUI

/// The plain theme of the desktop, on Apple's own components: neutral greys, no blue accent.
public enum Theme {
    /// The person's bubble: black with white text (white with black text in dark mode), as the desktop draws it.
    public static let userBubble = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.93, alpha: 1) : UIColor(white: 0.07, alpha: 1) })
    public static let userBubbleText = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.07, alpha: 1) : .white })
    public static let botBubble = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.17, alpha: 1) : UIColor(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF0 / 255, alpha: 1) })
    /// Buttons and marks: the text colour itself (ink on light, paper on dark).
    public static let accent = Color.primary
    /// The two blues the owner allowed: the unread dot and a link.
    public static let unreadDot = Color(uiColor: .systemBlue)
    public static let link = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.30, green: 0.75, blue: 0.85, alpha: 1) : UIColor(red: 0.05, green: 0.52, blue: 0.64, alpha: 1) })
    /// "Needs you".
    public static let waiting = Color(uiColor: .systemOrange)
    /// A soft round button's fill.
    public static let softButton = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.17, alpha: 1) : UIColor(white: 0.955, alpha: 1) })
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
    /// The list's stamp: the time today ("8:41 AM"), "Yesterday", the weekday, then the date.
    public static func stamp(at: Int64, now: Int64, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: Double(at) / 1000), today = Date(timeIntervalSince1970: Double(now) / 1000)
        if calendar.isDate(date, inSameDayAs: today) { return date.formatted(.dateTime.hour().minute()) }
        if let y = calendar.date(byAdding: .day, value: -1, to: today), calendar.isDate(date, inSameDayAs: y) { return "Yesterday" }
        if now - at < 6 * 86_400_000 { return date.formatted(.dateTime.weekday(.wide)) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
    /// The centred time above a run of messages: the time, with "Yesterday" or the date before it when not today.
    public static func divider(at: Int64, now: Int64, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: Double(at) / 1000), today = Date(timeIntervalSince1970: Double(now) / 1000)
        let t = date.formatted(.dateTime.hour().minute())
        if calendar.isDate(date, inSameDayAs: today) { return t }
        return stamp(at: at, now: now, calendar: calendar) + " " + t
    }
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
