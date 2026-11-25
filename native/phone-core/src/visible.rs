//! What shows, character by character: a port of the protocol's `visible-text.ts` (`UNSHOWN_CHAR`,
//! `joinerBetweenVisible`, `joinerInName`, `sealedEscape`), the one rule the engine's name check and both apps' sealed
//! card pages read. The core uses it for a device's name (`names.rs`), for every text a computer wrote that reaches the
//! app (`names::computers_words`), and offers it to the apps (`visible_text`) for a card's own strings.
//! `tests/vectors.rs` holds it to the protocol's own function, byte for byte.
//!
//! The character tables are `unicode-properties` 0.1.5 (Unicode 18); the engine's are its Bun's (Unicode 17), so the
//! two can differ only on characters Unicode 18 added.

use unicode_properties::general_category::{GeneralCategory as G, UnicodeGeneralCategory};

const ZWNJ: char = '\u{200C}';
const ZWJ: char = '\u{200D}';

/// `UNSHOWN_CHAR`: controls, every format character (the joiners among them), lone surrogates, the line and paragraph
/// separators, the fillers that draw as blanks, the combining grapheme joiner U+034F and the whole tag block.
pub fn unshown(c: char) -> bool {
    matches!(c.general_category(), G::Control | G::Format | G::Surrogate | G::LineSeparator | G::ParagraphSeparator)
        || matches!(c, '\u{115F}' | '\u{1160}' | '\u{3164}' | '\u{FFA0}' | '\u{17B4}' | '\u{17B5}' | '\u{2800}' | '\u{034F}')
        || ('\u{E0000}'..='\u{E007F}').contains(&c)
}

pub fn is_mark(c: char) -> bool {
    matches!(c.general_category(), G::NonspacingMark | G::SpacingMark | G::EnclosingMark)
}

/// `\p{White_Space}`.
pub fn is_blank(c: char) -> bool {
    c.is_whitespace()
}

pub fn is_joiner(c: char) -> bool {
    c == ZWJ || c == ZWNJ
}

pub fn is_tone_modifier(c: char) -> bool {
    ('\u{1F3FB}'..='\u{1F3FF}').contains(&c)
}

pub fn is_visible(c: char) -> bool {
    !unshown(c) && !is_mark(c) && !is_blank(c)
}

/// The visible character a joiner at `i` follows, looking past marks and skin-tone modifiers.
fn before(chars: &[char], i: usize) -> Option<char> {
    chars[..i].iter().rev().copied().find(|&c| !(is_mark(c) || is_tone_modifier(c)))
}

/// `joinerBetweenVisible`.
pub fn joiner_between_visible(chars: &[char], i: usize) -> bool {
    before(chars, i).is_some_and(is_visible) && chars.get(i + 1).is_some_and(|&n| is_visible(n))
}

/// `joinerInName`: between two visible characters, neither of them ASCII.
pub fn joiner_in_name(chars: &[char], i: usize) -> bool {
    joiner_between_visible(chars, i) && before(chars, i).is_some_and(|c| !c.is_ascii()) && chars.get(i + 1).is_some_and(|c| !c.is_ascii())
}

/// `sealedEscape`: every unshown character drawn as its escape (`U+00AD`), tab, line feed and carriage return kept, a
/// joiner kept as written only in a name where `joiner_in_name` says it is real. Nothing else is touched.
pub fn sealed_escape(text: &str, name: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        if name && is_joiner(c) && joiner_in_name(&chars, i) {
            out.push(c);
        } else if c != '\t' && c != '\n' && c != '\r' && unshown(c) {
            out.push_str(&format!("U+{:04X}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// A text as a card draws it (`sealedEscape`): for the apps, on every string of a card's `card_json` they draw (its
/// fields' texts, code, list items, row labels and values, option labels), with `name` for a value that is a human name.
#[uniffi::export]
pub fn visible_text(text: String, name: bool) -> String {
    sealed_escape(&text, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes() {
        assert_eq!(sealed_escape("a\u{202E}b\tc\n", false), "aU+202Eb\tc\n");
        assert_eq!(sealed_escape("Stu\u{200C}dio", true), "StuU+200Cdio");
        assert_eq!(sealed_escape("\u{645}\u{6CC}\u{200C}\u{62E}", true), "\u{645}\u{6CC}\u{200C}\u{62E}");
        assert_eq!(sealed_escape("x\u{034F}\u{E0001}\u{E007F}", false), "xU+034FU+E0001U+E007F");
    }
}
