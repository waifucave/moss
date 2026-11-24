//! The one rule for a device's name, ported from the engine's `packages/core/src/devices/names.ts` (`nameProblem`,
//! `safeDeviceName`); `tests/vectors.rs` holds both to the engine's own verdicts. A name is 1 to 63 UTF-16 units,
//! something visible, with no control, format (bar the joiners between two visible characters), separator or
//! blank-drawing filler, no combining mark with nothing to sit on and no more than four after one character.
//!
//! The character tables are `unicode-properties` 0.1.5 (Unicode 18); the engine's are its Bun's (Unicode 17), so the
//! two can differ only on characters Unicode 18 added.


pub const NAME_MAX: usize = 63;
pub const MARKS_MAX: usize = 4;
use crate::visible::{is_blank, is_joiner, is_mark, joiner_in_name, sealed_escape, unshown as unsafe_char};

/// Why `name` can't be a device's name; None when it can (`nameProblem`, the same verdicts; the words are the core's).
pub fn name_problem(name: &str) -> Option<&'static str> {
    let units = name.encode_utf16().count();
    if units < 1 {
        return Some("a device's name can't be empty");
    }
    if units > NAME_MAX {
        return Some("a device's name is at most 63 characters");
    }
    let chars: Vec<char> = name.chars().collect();
    let (mut visible, mut marks) = (false, 0usize);
    #[derive(PartialEq)]
    enum Prev {
        Start,
        Blank,
        Visible,
        Mark,
        Joiner,
    }
    let mut prev = Prev::Start;
    for (i, &c) in chars.iter().enumerate() {
        if is_joiner(c) {
            if !joiner_in_name(&chars, i) {
                return Some("a device's name can't hold a joiner that isn't between two visible, non-ASCII characters");
            }
            prev = Prev::Joiner;
            marks = 0;
        } else if unsafe_char(c) {
            return Some("a device's name can't hold control, invisible or direction-changing characters");
        } else if is_mark(c) {
            if prev == Prev::Start || prev == Prev::Blank {
                return Some("a device's name can't start with an accent or hold one with no letter to sit on");
            }
            marks += 1;
            if marks > MARKS_MAX {
                return Some("a device's name can't stack more than 4 accents on one character");
            }
            prev = Prev::Mark;
        } else if is_blank(c) {
            prev = Prev::Blank;
            marks = 0;
        } else {
            visible = true;
            prev = Prev::Visible;
            marks = 0;
        }
    }
    if visible {
        None
    } else {
        Some("a device's name needs something that shows")
    }
}

pub fn clean_name(name: &str) -> bool {
    name_problem(name).is_none()
}

/// A name made safe (`safeDeviceName`): what is refused is left out, runs of blanks become one, cut to 63 units at a
/// character's edge; `fallback` when nothing visible is left. For the name the phone's OS gives it.
pub fn safe_device_name(raw: &str, fallback: &str) -> String {
    let mut out = String::new();
    let (mut marks, mut on_base) = (0usize, false);
    for c in raw.chars() {
        if unsafe_char(c) {
            continue;
        }
        if is_mark(c) {
            if on_base {
                marks += 1;
                if marks <= MARKS_MAX {
                    out.push(c);
                }
            }
        } else if is_blank(c) {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
            on_base = false;
            marks = 0;
        } else {
            out.push(c);
            on_base = true;
            marks = 0;
        }
    }
    let mut cut = String::new();
    let mut units = 0;
    for c in out.chars() {
        if units + c.len_utf16() > NAME_MAX {
            break;
        }
        units += c.len_utf16();
        cut.push(c);
    }
    // JS `trim` strips White_Space and the line terminators, as `char::is_whitespace` does (plus U+FEFF, a format
    // character already left out above).
    let clean = cut.trim().to_string();
    if clean_name(&clean) {
        clean
    } else {
        fallback.to_string()
    }
}

/// Text a computer wrote, as the app may show it as the computer's words: the one visible-text rule
/// (`visible::sealed_escape`: a hidden character drawn as its escape, never deleted), at most `max` characters. What
/// crosses the FFI from a computer's own text goes through this, in a field named as the computer's. Never for a
/// protocol value the phone names or signs (a path, an id): those are refused when unclean, not rewritten.
pub fn computers_words(raw: &str, max: usize) -> String {
    sealed_escape(raw, false).chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rule() {
        assert!(clean_name("Studio"));
        assert!(clean_name("👩🏽\u{200D}💻 Lab"));
        assert!(!clean_name(""));
        assert!(!clean_name("a\u{202E}b"));
        assert!(!clean_name("\u{301}a"));
        assert!(!clean_name(&"x".repeat(64)));
        assert!(!clean_name("   "));
        assert_eq!(safe_device_name("  My\u{0007}  Phone  ", "Phone"), "My Phone");
        assert_eq!(safe_device_name("\u{202E}", "Phone"), "Phone");
        assert_eq!(computers_words("Bad\u{202E} news\u{7}", 200), "BadU+202E newsU+0007");
        assert!(!clean_name("Stu\u{200C}dio"));
        assert_eq!(computers_words(&"x".repeat(500), 200).len(), 200);
    }
}
