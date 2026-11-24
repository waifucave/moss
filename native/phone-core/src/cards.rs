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

/// A card's state as the core last heard it, shared by every view of that card from one connection: None while it
/// waits for an answer, its outcome once resolved.
pub type CardState = std::sync::Arc<std::sync::Mutex<Option<String>>>;

/// A card the core issued for display: only the core makes one (no constructor crosses the FFI), from a card a
/// computer sent and the core checked. The app draws `card_json` and hands this same object back to answer it; the
/// core signs only for a card it issued on that connection, recomputing the hash from the content the person saw,
/// with no fetch between the tap and the signature, and refuses one no longer pending.
#[derive(Debug, uniffi::Object)]
pub struct CardView {
    pub(crate) id: String,
    pub(crate) hash: String,
    pub(crate) card_json: String,
    pub(crate) options: Vec<String>,
    pub(crate) bot: Option<String>,
    pub(crate) session: Option<String>,
    pub(crate) state: CardState,
    /// The connection that issued it.
    pub(crate) issuer: u64,
}

#[uniffi::export]
impl CardView {
    pub fn id(&self) -> String {
        self.id.clone()
    }
    /// Its hash, recomputed by the core from the content and equal to the card's own.
    pub fn hash(&self) -> String {
        self.hash.clone()
    }
    /// The card, JSON: what the app draws.
    pub fn card_json(&self) -> String {
        self.card_json.clone()
    }
    /// The option ids it offers, in order.
    pub fn options(&self) -> Vec<String> {
        self.options.clone()
    }
    /// The bot whose conversation raised it, when one did (`bot`, checked as a bot id): the app draws the card there
    /// and in the gathered "Needs you" list.
    pub fn bot(&self) -> Option<String> {
        self.bot.clone()
    }
    /// The session that raised it, when one did (`session`, checked as a session id): drawn there and in "Needs you".
    pub fn session(&self) -> Option<String> {
        self.session.clone()
    }
    /// Still waiting for an answer, as far as the core has heard.
    pub fn pending(&self) -> bool {
        self.state.lock().unwrap().is_none()
    }
    /// Its outcome once resolved (`approved`, `denied`, `expired`, `withdrawn`, `cancelled`, `answered`).
    pub fn outcome(&self) -> Option<String> {
        self.state.lock().unwrap().clone()
    }
}

/// A checked card's parts, before the connection that got it makes it a `CardView`.
pub struct Checked {
    pub id: String,
    pub hash: String,
    pub card_json: String,
    pub options: Vec<String>,
    pub bot: Option<String>,
    pub session: Option<String>,
}

pub fn is_card_id(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("card_") else { return false };
    (6..=64).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `CARD_OPTION_ID_RE`: `^[a-z0-9_-]{1,64}$`.
pub fn is_option_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// One part of a plugin id (`PLUGIN_ID_PATTERN`, 2 to 40 characters).
fn is_plugin_part(s: &str) -> bool {
    let b = s.as_bytes();
    (2..=40).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && !s.ends_with('-')
        && !s.contains("--")
}

/// `BotId` (`AnyPluginId`): a plugin id, `a` or `a/b`.
pub fn is_bot_id(s: &str) -> bool {
    let mut parts = s.split('/');
    let first = parts.next().unwrap_or("");
    let second = parts.next();
    parts.next().is_none() && is_plugin_part(first) && second.map_or(true, is_plugin_part)
}

/// `SessionId`: 1 to 128 of `A-Za-z0-9._:-`.
pub fn is_session_id(s: &str) -> bool {
    (1..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// `OkCheckboxId`: a plugin id (`a` or `a/b`), or a plugin's app parts (`<id>#app`).
pub fn is_checkbox_id(s: &str) -> bool {
    let id = s.strip_suffix("#app").unwrap_or(s);
    let mut parts = id.split('/');
    let first = parts.next().unwrap_or("");
    let second = parts.next();
    parts.next().is_none() && is_plugin_part(first) && second.map_or(true, is_plugin_part)
}

/// A card the engine sent, checked for display: an object with a well-formed id, a hash that matches its content, and
/// options with well-formed ids.
pub fn check(card: &Value) -> Result<Checked, CoreError> {
    let tampered = |r: &str| CoreError::TamperedCard { reason: r.to_string() };
    let id = card.get("id").and_then(Value::as_str).filter(|i| is_card_id(i)).ok_or_else(|| tampered("the card's id isn't a card id"))?;
    let hash = verify_card(card)?;
    let options: Vec<String> = card
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| tampered("the card has no options"))?
        .iter()
        .map(|o| o.get("id").and_then(Value::as_str).filter(|i| is_option_id(i)).map(str::to_string))
        .collect::<Option<_>>()
        .ok_or_else(|| tampered("an option's id isn't one"))?;
    // Its owner, inside the hash: a bot id (`BotId`) and a session id (`SessionId`), or the card is refused whole.
    let owner = |k: &str, ok: fn(&str) -> bool| -> Result<Option<String>, CoreError> {
        match card.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(v)) if ok(v) => Ok(Some(v.clone())),
            Some(_) => Err(tampered(&format!("the card's {k} isn't one"))),
        }
    };
    let bot = owner("bot", is_bot_id)?;
    let session = owner("session", is_session_id)?;
    Ok(Checked { id: id.to_string(), hash, card_json: card.to_string(), options, bot, session })
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

/// A message's attachments as `UserMessageInput` numbers them: `{n, path}`, from 1, in the order given.
pub fn numbered(paths: &[String]) -> Value {
    Value::Array(paths.iter().enumerate().map(|(i, p)| serde_json::json!({ "n": i + 1, "path": p })).collect())
}

/// What a user message's hash covers (`userMessageHashInput`): its text and its attachments, canonical.
pub fn user_message_hash(text: &str, images: &[String], files: &[String]) -> String {
    let input = canonical_json(&serde_json::json!({ "text": text, "images": numbered(images), "files": numbered(files) }));
    bytes::hex(&sha256(input.as_bytes()))
}

/// What the sending device signs for a message another computer may relay (`userMessageSigningInput`, review N3).
pub fn user_message_signing_input(session: &str, client_message_id: &str, hash: &str, sent_at: i64) -> String {
    format!("clover/user-message/1\n{session}\n{client_message_id}\n{hash}\n{sent_at}")
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
