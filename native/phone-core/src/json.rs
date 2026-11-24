//! JSON from the computer, read as JS reads it. JS strings may hold a lone surrogate, and the engine's `JSON.stringify`
//! writes one as a `\udXXX` escape, which serde_json refuses. Each lone surrogate escape becomes U+FFFD first, as
//! `toWellFormed` makes it (what the engine's own `canonicalJson` hashes), so such a frame is read, not dropped.

use serde_json::Value;

/// Parses JSON, a lone surrogate escape taken as U+FFFD; Err for anything that still isn't JSON.
pub fn parse(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    match serde_json::from_slice(bytes) {
        Ok(v) => Ok(v),
        Err(e) => match std::str::from_utf8(bytes).ok().and_then(well_formed) {
            Some(fixed) => serde_json::from_str(&fixed),
            None => Err(e),
        },
    }
}

fn hex4(s: &[u8]) -> Option<u16> {
    if s.len() < 4 {
        return None;
    }
    u16::from_str_radix(std::str::from_utf8(&s[..4]).ok()?, 16).ok()
}

/// The text with every lone surrogate escape inside a string replaced by `�`; None when there was none.
fn well_formed(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut in_string, mut changed) = (0usize, false, false);
    let mut last = 0usize;
    while i < b.len() {
        match b[i] {
            b'"' => {
                in_string = !in_string;
                i += 1;
            }
            b'\\' if in_string => {
                if b.get(i + 1) == Some(&b'u') {
                    if let Some(u) = hex4(&b[i + 2..]) {
                        let paired = (0xD800..0xDC00).contains(&u)
                            && b.get(i + 6) == Some(&b'\\')
                            && b.get(i + 7) == Some(&b'u')
                            && hex4(&b[i + 8..]).is_some_and(|l| (0xDC00..0xE000).contains(&l));
                        if paired {
                            i += 12;
                            continue;
                        }
                        if (0xD800..0xE000).contains(&u) {
                            out.push_str(&text[last..i]);
                            out.push_str("\\ufffd");
                            i += 6;
                            last = i;
                            changed = true;
                            continue;
                        }
                    }
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    if !changed {
        return None;
    }
    out.push_str(&text[last..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lone_surrogates_become_replacement_characters() {
        assert_eq!(parse(br#"{"t":"a\ud800b"}"#).unwrap()["t"], "a\u{fffd}b");
        assert_eq!(parse(br#"{"t":"\udc00"}"#).unwrap()["t"], "\u{fffd}");
        // A pair stays a pair; an escaped backslash before `ud800` is text, not an escape.
        let text = ["{\"t\":\"", "BS", "ud83d", "BS", "ude00 ", "BS", "BS", "ud800 ", "BS", "ud800\"}"].concat().replace("BS", "\\");
        assert_eq!(parse(text.as_bytes()).unwrap()["t"], "\u{1F600} \\ud800 \u{fffd}");
        assert!(parse(b"{not json").is_err());
    }
}
