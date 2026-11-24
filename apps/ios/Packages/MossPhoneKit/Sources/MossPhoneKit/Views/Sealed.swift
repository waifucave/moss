import Foundation

/// What a card draws: the sealed text with control characters and bidirectional marks made visible as escapes
/// (`\u{202E}`), so what the person approves is what runs; and a field too long for its space is cut openly, never silently.
public enum Sealed {
    public static func visible(_ s: String) -> String {
        var out = ""
        for scalar in s.unicodeScalars {
            let v = scalar.value
            let isBidi = (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v) || v == 0x200E || v == 0x200F || v == 0x061C
            let isControl = (v < 0x20 && v != 0x0A && v != 0x09) || (0x7F...0x9F).contains(v) || v == 0x200B || v == 0xFEFF
            if isBidi || isControl { out += "\\u{" + String(v, radix: 16, uppercase: true) + "}" } else { out.unicodeScalars.append(scalar) }
        }
        return out
    }

    public struct Cut: Equatable, Sendable {
        public var shown: String
        public var hiddenCount: Int
    }
    /// The first `limit` characters (escaped), and how many were left out.
    public static func cut(_ s: String, limit: Int) -> Cut {
        let v = visible(s)
        guard v.count > limit else { return Cut(shown: v, hiddenCount: 0) }
        return Cut(shown: String(v.prefix(limit)), hiddenCount: v.count - limit)
    }
}
