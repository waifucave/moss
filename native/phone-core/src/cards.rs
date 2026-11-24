//! Cards (spec §5.5), as `packages/protocol/src/approvals.ts` has them: a card's hash is SHA-256 (hex) over the
//! canonical JSON of everything but `hash` (`cardHashInput`), and a device answers with its answer key's signature over
//! `cardAnswerSigningInput`. The phone rebuilds the hash from the card it was sent and signs nothing for a card whose
//! hash doesn't match what it shows.

use serde_json::Value;

use crate::{bytes, error::CoreError, keys::sha256};

/// How far a device's clock may stray from the shared clock when it signs (`CARD_ANSWER_SKEW_MS`).
pub const CARD_ANSWER_SKEW_MS: i64 = 60_000;

/// `JSON.stringify` of a string: `"` `\` and the C0 controls escaped (the short forms where JSON has one, `\u00xx`
/// lowercase otherwise), everything else as is. Rust strings are always well formed, as `toWellFormed` makes JS's.
fn js_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.stringify` of a number: integers in JS's range as decimals, everything else as JS's shortest round trip.
fn js_number(n: &serde_json::Number, out: &mut String) {
    const SAFE: u64 = 9_007_199_254_740_991;
    if let Some(u) = n.as_u64().filter(|u| *u <= SAFE) {
        out.push_str(&u.to_string());
    } else if let Some(i) = n.as_i64().filter(|i| i.unsigned_abs() <= SAFE) {
        out.push_str(&i.to_string());
    } else {
        let f = n.as_f64().unwrap_or(f64::NAN);
        if !f.is_finite() {
            out.push_str("null");
        } else if f == 0.0 {
            out.push('0');
        } else {
            out.push_str(ryu_js::Buffer::new().format_finite(f));
        }
    }
}

/// Canonical JSON (`canonicalJson`): keys sorted at every depth as JS sorts strings (by UTF-16 code units), no spaces.
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write(v, &mut out);
    out
}

fn write(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => js_number(n, out),
        Value::String(s) => js_string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_string(k, out);
                out.push(':');
                write(&m[k.as_str()], out);
            }
            out.push('}');
        }
    }
}

/// A card's hash as the engine computes it: SHA-256 hex over `cardHashInput` (the card without `hash`).
pub fn card_hash(card: &Value) -> Result<String, CoreError> {
    let Value::Object(m) = card else { return Err(CoreError::TamperedCard { reason: "a card is an object".into() }) };
    let mut rest = m.clone();
    rest.remove("hash");
    Ok(bytes::hex(&sha256(canonical_json(&Value::Object(rest)).as_bytes())))
}

/// The card's own `hash` matches its content.
pub fn verify_card(card: &Value) -> Result<String, CoreError> {
    let claimed = card.get("hash").and_then(Value::as_str).ok_or_else(|| CoreError::TamperedCard { reason: "the card has no hash".into() })?;
    let ours = card_hash(card)?;
    if !bytes::ct_eq(ours.as_bytes(), claimed.as_bytes()) {
        return Err(CoreError::TamperedCard { reason: "the card's hash doesn't match what it says".into() });
    }
    Ok(ours)
}

/// What a paired device signs to answer a card (`cardAnswerSigningInput`).
pub fn card_answer_signing_input(id: &str, hash: &str, option: &str, at: i64, children: &[String]) -> String {
    let mut c: Vec<&String> = children.iter().collect();
    c.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let c: Vec<&str> = c.into_iter().map(String::as_str).collect();
    format!("clover/card-answer/2\n{id}\n{hash}\n{option}\n{at}\n{}", c.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical() {
        let v = json!({"b": [1, 2.5, -0.0, "x\n\u{1}"], "a": {"z": null, "y": true}, "\u{e000}": 1, "\u{10000}": 2});
        // U+10000 is a surrogate pair (D800 DC00), which sorts before U+E000 in UTF-16 order.
        assert_eq!(canonical_json(&v), "{\"a\":{\"y\":true,\"z\":null},\"b\":[1,2.5,0,\"x\\n\\u0001\"],\"\u{10000}\":2,\"\u{e000}\":1}");
    }

    #[test]
    fn signing_input_sorts_children() {
        let s = card_answer_signing_input("card_1", "ab", "approve", 5, &["b".into(), "a".into()]);
        assert_eq!(s, "clover/card-answer/2\ncard_1\nab\napprove\n5\na,b");
    }
}
