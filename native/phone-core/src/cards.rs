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

impl CardView {
    /// What it costs the event queue: its strings, not its state (which may change while it waits).
    pub(crate) fn size(&self) -> usize {
        self.id.len() + self.hash.len() + self.card_json.len() + self.options.iter().map(|o| o.len() + 8).sum::<usize>() + self.bot.as_ref().map_or(0, String::len) + self.session.as_ref().map_or(0, String::len) + 64
    }
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
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_none()
    }
    /// Its outcome once resolved (`approved`, `denied`, `expired`, `withdrawn`, `cancelled`, `answered`).
    pub fn outcome(&self) -> Option<String> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
    /// What the app draws, typed: every string through the visible-text rule, each `Text` in one language. A field
    /// whose value isn't one the protocol has, or an option or checkbox the phone can't read, is named in `unreadable`:
    /// the app then draws no buttons and sends the person to the computer (it fails closed).
    pub fn content(&self) -> CardContent {
        content_of(&serde_json::from_str(&self.card_json).unwrap_or(Value::Null))
    }
}

/// One value of a card's sealed field, as the protocol's `SealedValue` has it.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum SealedField {
    Text { text: String },
    Code { code: String, language: Option<String> },
    /// A list (`list`): named `Items` so no binding's own `List` type is shadowed (Kotlin's is).
    Items { items: Vec<String> },
    Rows { rows: Vec<SealedRow> },
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SealedRow {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct CardField {
    pub name: String,
    pub value: SealedField,
}

/// A card's button: its id, `approve` or `deny`, its label, and whether it saves MOSS's "always" rule.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct CardButton {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub remember_always: bool,
}

/// A plugin OK's checkbox: its id, label and the engine's own tick.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct CardCheckbox {
    pub id: String,
    pub label: String,
    pub checked: bool,
}

/// A card as the app draws it.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct CardContent {
    pub kind: String,
    pub computer: Option<String>,
    pub origin: Option<String>,
    pub issued_at: i64,
    /// None: no expiry (the person's own turn), it waits until answered.
    pub expires_at: Option<i64>,
    /// In the card's own order of names (the app draws them in the protocol's order).
    pub fields: Vec<CardField>,
    pub options: Vec<CardButton>,
    pub children: Vec<CardCheckbox>,
    /// What the phone couldn't read (a field's name, `option`, `checkbox`): when not empty, no buttons.
    pub unreadable: Vec<String>,
}

/// A `Text`: a string, or one per language (English first, else the first by name).
fn text_value(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Object(m) => m.get("en").and_then(Value::as_str).or_else(|| {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            keys.into_iter().find_map(|k| m[k].as_str())
        }).map(str::to_string),
        _ => None,
    }
}

fn shown(s: &str) -> String {
    crate::visible::sealed_escape(s, false)
}

fn sealed_field(v: &Value) -> Option<SealedField> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(shown);
    match v.get("type").and_then(Value::as_str)? {
        "text" => Some(SealedField::Text { text: s("text")? }),
        "code" => Some(SealedField::Code { code: s("code")?, language: v.get("language").and_then(Value::as_str).map(str::to_string) }),
        "list" => {
            let a = v.get("items")?.as_array()?;
            let items: Vec<String> = a.iter().filter_map(|x| x.as_str().map(shown)).collect();
            (items.len() == a.len()).then_some(SealedField::Items { items })
        }
        "rows" => {
            let a = v.get("rows")?.as_array()?;
            let rows: Vec<SealedRow> = a.iter().filter_map(|r| Some(SealedRow { label: shown(r.get("label")?.as_str()?), value: shown(r.get("value")?.as_str()?) })).collect();
            (rows.len() == a.len()).then_some(SealedField::Rows { rows })
        }
        _ => None,
    }
}

pub fn content_of(card: &Value) -> CardContent {
    let mut unreadable = Vec::new();
    let mut fields = Vec::new();
    if let Some(m) = card.get("fields").and_then(Value::as_object) {
        for (name, v) in m {
            match sealed_field(v) {
                Some(value) => fields.push(CardField { name: name.clone(), value }),
                None => unreadable.push(name.clone()),
            }
        }
    }
    let mut options = Vec::new();
    for o in card.get("options").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let id = o.get("id").and_then(Value::as_str);
        let kind = o.get("kind").and_then(Value::as_str).filter(|k| *k == "approve" || *k == "deny");
        match (id, kind, text_value(o.get("label"))) {
            (Some(id), Some(kind), Some(label)) => options.push(CardButton {
                id: id.to_string(), kind: kind.to_string(), label: shown(&label),
                remember_always: o.get("remember").and_then(Value::as_str) == Some("always"),
            }),
            _ => unreadable.push("option".into()),
        }
    }
    let mut children = Vec::new();
    for c in card.get("children").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        match (c.get("id").and_then(Value::as_str).filter(|i| is_checkbox_id(i)), text_value(c.get("label")), c.get("checked").and_then(Value::as_bool)) {
            (Some(id), Some(label), Some(checked)) => children.push(CardCheckbox { id: id.to_string(), label: shown(&label), checked }),
            _ => unreadable.push("checkbox".into()),
        }
    }
    let int = |k: &str| card.get(k).and_then(Value::as_i64);
    CardContent {
        kind: card.get("kind").and_then(Value::as_str).unwrap_or("").to_string(),
        computer: card.get("computer").and_then(Value::as_str).map(|c| crate::visible::sealed_escape(c, true)),
        origin: card.get("origin").and_then(Value::as_str).map(str::to_string),
        issued_at: int("issuedAt").unwrap_or(0),
        expires_at: int("expiresAt"),
        fields, options, children, unreadable,
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
