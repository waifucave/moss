//! Pairing as the joiner (spec §8.1), the other half of the engine's `links/pairing.ts`: the phone scans the QR, dials
//! the computer on the pair door (`clover/pair/1`) and they exchange, one framed CBOR message each way per step:
//!   phone → computer  ["hello", {pairingId, device, pairKey, groupKey, group, account, answerKeyProof, commit, proof}]
//!   computer → phone  ["welcome", {device, pairKey, groupKey, group, fresh, t, account, answerKeyProof?, nonce, proof}]
//!   phone → computer  ["reveal", {nonce}]; both show the four words
//!   both, once their person confirms: ["confirm", {pairSig, admit?}] (or ["cancel"])
//! A phone has no account, so each pairing makes a pair credential (a fresh signing key and the pair secret) and the
//! phone joins the computer's group as a newcomer (it checks the computer's admit; it signs none).
//!
//! The QR's text carries the pairing's secret: it is never logged or put in an error.

use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use iroh::endpoint::{Connection, RecvStream, SendStream, VarInt};
use tokio::sync::{oneshot, Mutex};
use zeroize::Zeroizing;

use crate::{
    bytes::{self, b64, b64url},
    cbor::{decode, encode, Cbor},
    computers::{self, PairedComputer, PhoneApp},
    error::CoreError,
    identity::{Identity, SecretStorage},
    keys::{answer_key_bytes, device_id_for, is_strict_point, verify_ed25519, verify_key_signature, AnswerKeyAlg, Ed25519Key},
    net::{self, Target, ALPN_PAIR, CLOSE_NORMAL, CLOSE_PROTOCOL},
    sas::{self, canonical_record, PairSide, RecordFields, PAIR_NONCE_BYTES, PAIR_PROOF_HOST, PAIR_PROOF_JOINER},
};

pub const QR_PREFIX: &str = "clover-pair:1:";
const STEP: Duration = Duration::from_secs(30);
/// How far the computer's `t` may be from this phone's clock (`STATEMENT_FRESH_MS`).
const STATEMENT_FRESH_MS: f64 = 9.0 * 60_000.0;
/// A pairing frame's limit, as the engine reads them.
const PAIR_FRAME_MAX: usize = 64 * 1024;
const HOLDERS: [&str; 8] = ["secure-enclave", "keystore", "keychain", "app-keychain", "tpm", "dpapi", "secret-service", "none"];

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// A scanned pairing offer. Debug shows no secret.
pub struct Offer {
    pub id: String,
    pub secret: Zeroizing<Vec<u8>>,
    pub host_key: [u8; 32],
    pub relay: Option<String>,
    pub direct: Vec<String>,
    pub lan: Vec<String>,
    pub expires_at: f64,
}

impl std::fmt::Debug for Offer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Offer({})", self.id)
    }
}

/// The QR's text (`clover-pair:1:` and base64url CBOR of [id, secret, hostKey, relay, direct, lan, expiresAt]). A short
/// code needs the handshake service's rendezvous, which this core doesn't reach yet: the QR is the phone's way in.
pub fn parse_qr(input: &str) -> Result<Offer, CoreError> {
    let not = || CoreError::invalid("not a pairing code");
    let input = input.trim();
    let Some(body) = input.strip_prefix(QR_PREFIX) else {
        return Err(CoreError::invalid("not a pairing QR (a typed code needs the handshake service: scan the QR)"));
    };
    let v = decode(&bytes::from_b64url(body).ok_or_else(not)?).map_err(|_| not())?;
    let a = v.as_array().filter(|a| a.len() == 7).ok_or_else(not)?;
    let id = a[0].as_str().ok_or_else(not)?.to_string();
    let secret = a[1].as_bytes().filter(|s| s.len() == 32).ok_or_else(not)?.to_vec();
    let host_key: [u8; 32] = a[2].as_bytes().and_then(|k| k.try_into().ok()).ok_or_else(not)?;
    if !is_strict_point(&host_key) {
        return Err(not());
    }
    let strings = |c: &Cbor| c.as_array().map(|x| x.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let expires_at = a[6].as_f64().ok_or_else(not)?;
    Ok(Offer { id, secret: Zeroizing::new(secret), host_key, relay: a[3].as_str().map(str::to_string), direct: strings(&a[4]), lan: strings(&a[5]), expires_at })
}

/// The computer's side as its welcome sent it.
struct HostSide {
    record: RecordFields,
    pair_key: [u8; 32],
    group_key: [u8; 32],
    account: Option<String>,
}

/// Why a computer's record is turned away: the engine's closed set (`PairRefusal`), so what is shown is always the
/// core's own words, never text the other device wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Name,
    Kind,
    Os,
    App,
    Record,
}

impl Refusal {
    fn from_code(code: &str) -> Option<Self> {
        Some(match code {
            "name" => Refusal::Name,
            "kind" => Refusal::Kind,
            "os" => Refusal::Os,
            "app" => Refusal::App,
            "record" => Refusal::Record,
            _ => return None,
        })
    }
    /// The words when the computer turned this phone away for this reason.
    fn joiner_words(self) -> &'static str {
        match self {
            Refusal::Name => "the computer turned this phone away: this phone's name isn't one MOSS takes (1 to 63 characters with something that shows, no hidden or direction-changing characters). Rename it and try again",
            Refusal::Kind => "the computer turned this phone away: it doesn't know this kind of device",
            Refusal::Os => "the computer turned this phone away: it doesn't know this phone's system",
            Refusal::App => "the computer turned this phone away: it doesn't know this phone app",
            Refusal::Record => "the computer turned this phone away: what this phone sent about itself doesn't match its key",
        }
    }
    /// The words when this phone turned the computer away.
    fn host_words(self) -> &'static str {
        match self {
            Refusal::Name => "this phone turned the computer away: its name isn't one MOSS takes",
            Refusal::Kind => "this phone turned the computer away: it isn't a computer MOSS pairs a phone with",
            Refusal::Os => "this phone turned the computer away: it says it runs on a system MOSS doesn't know",
            Refusal::App => "this phone turned the computer away: it names a phone app, and it isn't a phone",
            Refusal::Record => "this phone turned the computer away: what it sent about itself doesn't match its key",
        }
    }
}

/// The engine's `DeviceKind` values a phone pairs with (a computer that runs MOSS's core), and `DeviceOs`.
const COMPUTER_KINDS: [&str; 3] = ["desktop", "server", "cloud"];
const DEVICE_OS: [&str; 4] = ["macos", "windows", "linux", "ios"];

/// The computer's record as its welcome sent it, checked as the engine checks a peer's (`#readSide`).
fn read_host_side(m: &Cbor, key: &[u8; 32]) -> Result<HostSide, Refusal> {
    use Refusal::*;
    let d = m.get("device").ok_or(Record)?;
    let (Some(id), Some(name), Some(kind), Some(runs_core), Some(public_key)) = (
        d.get("id").and_then(Cbor::as_str),
        d.get("name").and_then(Cbor::as_str),
        d.get("kind").and_then(Cbor::as_str),
        d.get("runsCore").and_then(Cbor::as_bool),
        d.get("publicKey").and_then(Cbor::as_str),
    ) else {
        return Err(Record);
    };
    if crate::names::name_problem(name).is_some() {
        return Err(Name);
    }
    if !COMPUTER_KINDS.contains(&kind) || !runs_core {
        return Err(Kind);
    }
    let os = match d.get("os") {
        None | Some(Cbor::Undefined) => None,
        Some(Cbor::Text(o)) if DEVICE_OS.contains(&o.as_str()) => Some(o.clone()),
        _ => return Err(Os),
    };
    let computer = match d.get("computer") {
        None | Some(Cbor::Undefined) => None,
        Some(Cbor::Text(c)) if crate::names::clean_name(c) => Some(c.clone()),
        _ => return Err(Name),
    };
    if public_key != b64(key) {
        return Err(Record);
    }
    let record_inner = || -> Option<HostSide> {
    let pair_key: [u8; 32] = m.get("pairKey")?.as_bytes()?.try_into().ok()?;
    let group_key: [u8; 32] = m.get("groupKey")?.as_bytes()?.try_into().ok()?;
    if !is_strict_point(&pair_key) || !is_strict_point(&group_key) {
        return None;
    }
    let group = m.get("group")?;
    if !group.is_null() && group.as_str().is_none() {
        return None;
    }
    let account = m.get("account")?;
    if !account.is_null() && account.as_str().is_none() {
        return None;
    }
    let mut answer_key = None;
    if let Some(ak) = d.get("answerKey").filter(|v| !matches!(v, Cbor::Undefined)) {
        let alg = match ak.get("alg") {
            None | Some(Cbor::Undefined) => AnswerKeyAlg::Ed25519,
            Some(Cbor::Text(s)) if s == "ed25519" => AnswerKeyAlg::Ed25519,
            Some(Cbor::Text(s)) if s == "p256" => AnswerKeyAlg::P256,
            _ => return None,
        };
        let pk = ak.get("publicKey")?.as_str()?;
        let held = ak.get("held")?.as_str()?;
        let proof = bytes::from_b64(m.get("answerKeyProof")?.as_str()?)?;
        let raw = answer_key_bytes(alg, pk)?;
        if !HOLDERS.contains(&held) || !verify_key_signature(alg, &raw, &sas::answer_key_statement(id, pk, held, alg.name()), &proof) {
            return None;
        }
        answer_key = Some((pk.to_string(), held.to_string(), (alg == AnswerKeyAlg::P256).then(|| "p256".to_string())));
    }
    // A group id is the computer's text: bounded here (its storage item is named by a hash of it).
    if group.as_str().is_some_and(|g| g.is_empty() || g.len() > 128) {
        return None;
    }
    Some(HostSide {
        record: RecordFields {
            id: id.into(),
            name: name.into(),
            kind: kind.into(),
            os: os.clone(),
            runs_core,
            computer: computer.clone(),
            has_display: d.get("hasDisplay").and_then(Cbor::as_bool),
            public_key: public_key.into(),
            answer_key,
            app: None,
        },
        pair_key,
        group_key,
        account: account.as_str().map(str::to_string),
    })
    };
    // A computer is never a phone, so any app on its record is refused (the engine refuses an app on a non-phone).
    if !matches!(d.get("app"), None | Some(Cbor::Undefined)) {
        return Err(App);
    }
    record_inner().ok_or(Record)
}

fn device_map(r: &RecordFields) -> Cbor {
    let mut m = vec![("id", Cbor::text(&r.id)), ("name", Cbor::text(&r.name)), ("kind", Cbor::text(&r.kind))];
    if let Some(os) = &r.os {
        m.push(("os", Cbor::text(os)));
    }
    m.push(("runsCore", Cbor::Bool(r.runs_core)));
    m.push(("publicKey", Cbor::text(&r.public_key)));
    if let Some((pk, held, _)) = &r.answer_key {
        m.push(("answerKey", Cbor::map(vec![("publicKey", Cbor::text(pk)), ("held", Cbor::text(held))])));
    }
    if let Some(app) = &r.app {
        m.push(("app", Cbor::text(app)));
    }
    Cbor::map(m)
}

/// What a pairing holds once both showed the words.
struct Agreed {
    conn: Connection,
    send: SendStream,
    peer_msg: oneshot::Receiver<Result<Cbor, CoreError>>,
    offer: Offer,
    host: HostSide,
    transcript: Vec<u8>,
    t: f64,
    group: String,
    pair_key: Ed25519Key,
    group_key: Ed25519Key,
}

/// A pairing in progress, showing its four words until the person confirms or rejects them.
#[derive(uniffi::Object)]
pub struct Pairing {
    words: Vec<String>,
    computer_id: String,
    computer_name: String,
    app: PhoneApp,
    state: Mutex<Option<Agreed>>,
    storage: Arc<dyn SecretStorage>,
    identity: Arc<Identity>,
}

impl std::fmt::Debug for Pairing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Pairing({})", self.computer_id)
    }
}

async fn send_msg(send: &mut SendStream, m: &Cbor) -> Result<(), CoreError> {
    tokio::time::timeout(STEP, net::write_frame(send, &encode(m))).await.map_err(|_| CoreError::Timeout { reason: "the computer stopped reading".into() })?
}

async fn next_msg(recv: &mut RecvStream, timeout: Duration) -> Result<Cbor, CoreError> {
    match tokio::time::timeout(timeout, net::read_frame(recv, PAIR_FRAME_MAX)).await {
        Err(_) => Err(CoreError::Timeout { reason: "the computer didn't answer".into() }),
        Ok(Err(e)) => Err(e),
        Ok(Ok(None)) => Err(CoreError::refused("the computer ended the pairing")),
        Ok(Ok(Some(f))) => decode(&f),
    }
}

/// The core's own words for a computer's refusal: its code when it is one of the engine's closed set, otherwise a fixed
/// sentence. The computer's own `reason` text is never shown.
fn reason_of(m: &Cbor) -> String {
    let code = m.as_array().and_then(|a| a.get(1)).and_then(|x| x.get("code")).and_then(Cbor::as_str);
    match code.and_then(Refusal::from_code) {
        Some(r) => r.joiner_words().to_string(),
        None => "the computer refused the pairing (it isn't showing this pairing any more, or this phone is paired or was removed there already)".to_string(),
    }
}

/// Dials the computer the QR names and runs the exchange up to the words.
pub async fn begin(ep: &iroh::Endpoint, identity: Arc<Identity>, storage: Arc<dyn SecretStorage>, qr: &str, app: PhoneApp) -> Result<Pairing, CoreError> {
    let offer = parse_qr(qr)?;
    if !(offer.expires_at > now_ms()) {
        return Err(CoreError::refused("the pairing has expired"));
    }
    if offer.host_key == identity.device.public() {
        return Err(CoreError::invalid("this is this device's own pairing"));
    }
    let target = Target { key: offer.host_key, relay: offer.relay.clone(), addrs: offer.lan.iter().chain(&offer.direct).cloned().collect() };
    let conn = net::dial(ep, &target, ALPN_PAIR, STEP).await?;
    let fail = |conn: &Connection, code: u32, why: &'static str| {
        conn.close(VarInt::from_u32(code), why.as_bytes());
    };
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| CoreError::offline(format!("no pairing stream: {e}")))?;
    let _ = send.set_priority(3);

    let own = identity.record(app.wire());
    let own_canonical = canonical_record(&own);
    let pair_key = Ed25519Key::generate();
    let group_key = Ed25519Key::generate();
    let nonce = Zeroizing::new(bytes::random::<PAIR_NONCE_BYTES>());
    let commit = sas::nonce_commitment(&*nonce);
    let device_pub = identity.device.public();
    let own_side = PairSide { key: &device_pub, record: &own_canonical, pair_key: &pair_key.public(), group_key: &group_key.public(), group: None };
    let joiner_part = sas::joiner_transcript(&offer.id, &offer.host_key, &own_side, &commit);
    let hello = Cbor::Array(vec![
        Cbor::text("hello"),
        Cbor::map(vec![
            ("v", Cbor::Uint(1)),
            ("pairingId", Cbor::text(&offer.id)),
            ("device", device_map(&own)),
            ("pairKey", Cbor::bytes(pair_key.public())),
            ("groupKey", Cbor::bytes(group_key.public())),
            ("group", Cbor::Null),
            ("account", Cbor::Null),
            ("answerKeyProof", Cbor::text(identity.answer_key_proof())),
            ("commit", Cbor::bytes(commit)),
            ("proof", Cbor::bytes(sas::pair_proof(&offer.secret, PAIR_PROOF_JOINER, &joiner_part))),
        ]),
    ]);
    // The computer's door turns a connection away when it shows no pairing: a refusal, not a lost network.
    let turned_away = |e: CoreError| match e {
        CoreError::Timeout { .. } => e,
        _ => CoreError::refused("the computer isn't showing this pairing"),
    };
    send_msg(&mut send, &hello).await.map_err(turned_away)?;
    let reply = next_msg(&mut recv, STEP).await.map_err(turned_away)?;
    let kind = reply.as_array().and_then(|a| a.first()).and_then(Cbor::as_str);
    if kind == Some("refused") {
        return Err(CoreError::refused(reason_of(&reply)));
    }
    let protocol = |conn: &Connection| {
        fail(conn, CLOSE_PROTOCOL, "protocol");
        CoreError::protocol("the computer answered something that isn't a pairing")
    };
    let Some(w) = reply.as_array().filter(|a| kind == Some("welcome") && a.len() >= 2).map(|a| &a[1]) else { return Err(protocol(&conn)) };
    let host = match read_host_side(w, &offer.host_key) {
        Ok(h) => h,
        Err(r) => {
            fail(&conn, CLOSE_PROTOCOL, "record");
            return Err(CoreError::refused(r.host_words()));
        }
    };
    if device_id_for(&offer.host_key) != host.record.id {
        return Err(protocol(&conn));
    }
    let (Some(t), Some(group), Some(_fresh)) = (w.get("t").and_then(Cbor::as_f64), w.get("group").and_then(Cbor::as_str), w.get("fresh").and_then(Cbor::as_bool)) else {
        return Err(protocol(&conn));
    };
    // The computer's `t` dates the statements both sign, its admit of this phone among them: an old one is refused.
    if !((t - now_ms()).abs() <= STATEMENT_FRESH_MS) {
        fail(&conn, CLOSE_PROTOCOL, "stale t");
        return Err(CoreError::refused("the computer's clock is too far off (or it replayed an old pairing)"));
    }
    let Some(host_nonce) = w.get("nonce").and_then(Cbor::as_bytes).filter(|n| n.len() == PAIR_NONCE_BYTES) else { return Err(protocol(&conn)) };
    let host_canonical = canonical_record(&host.record);
    let host_side = PairSide { key: &offer.host_key, record: &host_canonical, pair_key: &host.pair_key, group_key: &host.group_key, group: None };
    let full = sas::full_transcript(&joiner_part, &host_side, w.get("t").unwrap(), group, host_nonce);
    let proof_ok = w.get("proof").and_then(Cbor::as_bytes).is_some_and(|p| sas::verify_pair_proof(&offer.secret, PAIR_PROOF_HOST, &full, p));
    if !proof_ok {
        fail(&conn, CLOSE_PROTOCOL, "bad proof");
        return Err(CoreError::refused("the computer doesn't hold the pairing's secret"));
    }
    // The computer's side is fixed now: reveal the nonce it couldn't see; then both show the words.
    send_msg(&mut send, &Cbor::Array(vec![Cbor::text("reveal"), Cbor::map(vec![("nonce", Cbor::bytes(*nonce))])])).await?;
    let transcript = sas::final_transcript(&full, &*nonce);
    let words = sas::sas_words(&offer.secret, &transcript);
    let group = group.to_string();
    // What the computer sends after the words (its confirm, or a cancel) is read as soon as it comes.
    let (tx, peer_msg) = oneshot::channel();
    let wait = Duration::from_millis((offer.expires_at - now_ms()).max(0.0) as u64) + STEP;
    tokio::spawn(async move {
        let _ = tx.send(next_msg(&mut recv, wait).await);
    });
    Ok(Pairing {
        words,
        computer_id: host.record.id.clone(),
        computer_name: host.record.name.clone(),
        app,
        storage,
        identity,
        state: Mutex::new(Some(Agreed { conn, send, peer_msg, offer, host, transcript, t, group, pair_key, group_key })),
    })
}

#[uniffi::export]
impl Pairing {
    /// The four words to show; the person checks the computer shows the same.
    pub fn words(&self) -> Vec<String> {
        self.words.clone()
    }

    pub fn computer_id(&self) -> String {
        self.computer_id.clone()
    }

    pub fn computer_name(&self) -> String {
        self.computer_name.clone()
    }

    /// The person saw the same words on both: this phone confirms, and the pairing completes once the computer has
    /// confirmed too (its person, and its sealed card). Returns the computer, now kept.
    pub async fn confirm(&self) -> Result<PairedComputer, CoreError> {
        let state = self.state.lock().await.take().ok_or_else(|| CoreError::Closed { reason: "the pairing ended".into() })?;
        let storage = self.storage.clone();
        let identity = self.identity.clone();
        let app = self.app;
        crate::runtime::spawn(async move { confirm(state, storage, identity, app).await }).await
    }

    /// The words differ, or the person changed their mind: the computer is told and nothing is kept.
    pub async fn reject(&self) {
        let Some(mut s) = self.state.lock().await.take() else { return };
        crate::runtime::spawn(async move {
            let _ = send_msg(&mut s.send, &Cbor::Array(vec![Cbor::text("cancel")])).await;
            let _ = s.send.finish();
            tokio::time::sleep(Duration::from_millis(100)).await;
            s.conn.close(VarInt::from_u32(CLOSE_NORMAL), b"cancelled");
        })
        .await
    }
}

async fn confirm(mut s: Agreed, storage: Arc<dyn SecretStorage>, identity: Arc<Identity>, app: PhoneApp) -> Result<PairedComputer, CoreError> {
    let pair_secret = Zeroizing::new(sas::derive_pair_secret(&s.offer.secret, &s.transcript));
    let pair_id = b64url(&sas::derive_pair_id(&*pair_secret));
    // The phone is the joiner: the computer's pair key first.
    let ordered = [b64url(&s.host.pair_key), b64url(&s.pair_key.public())];
    let stmt = sas::pair_statement(&pair_id, &ordered, s.t);
    // A phone has no account, so every pairing makes a pair credential; a group forms only when the computer has none
    // either, and the phone joins it as the newcomer (it signs no admit).
    let group_exchange = s.host.account.is_none();
    send_msg(&mut s.send, &Cbor::Array(vec![Cbor::text("confirm"), Cbor::map(vec![("pairSig", Cbor::bytes(s.pair_key.sign(&stmt)))])])).await?;
    let m = match s.peer_msg.await {
        Ok(Ok(m)) => m,
        // The computer closed the pairing (its words differed, its card was denied): say why, in its own short words.
        Ok(Err(e)) => {
            return Err(match s.conn.close_reason() {
                Some(_) => CoreError::refused("the computer ended the pairing (its person said the words differ, or said no)"),
                None => e,
            })
        }
        Err(_) => return Err(CoreError::refused("the computer went away")),
    };
    let a = m.as_array().unwrap_or(&[]);
    match a.first().and_then(Cbor::as_str) {
        Some("cancel") => return Err(CoreError::refused("the computer cancelled the pairing (its person said no, or the words differed)")),
        Some("confirm") if a.len() >= 2 => {}
        _ => {
            s.conn.close(VarInt::from_u32(CLOSE_PROTOCOL), b"protocol");
            return Err(CoreError::protocol("the computer sent something other than its confirm"));
        }
    }
    let c = &a[1];
    let sig_ok = c.get("pairSig").and_then(Cbor::as_bytes).is_some_and(|sig| verify_ed25519(&s.host.pair_key, &stmt, sig));
    if !sig_ok {
        s.conn.close(VarInt::from_u32(CLOSE_PROTOCOL), b"bad pair signature");
        return Err(CoreError::refused("the computer's pair signature is wrong"));
    }
    if group_exchange {
        let admit = sas::admit_statement(&s.group, &b64url(&s.group_key.public()), s.t);
        if !c.get("admit").and_then(Cbor::as_bytes).is_some_and(|sig| verify_ed25519(&s.host.group_key, &admit, sig)) {
            s.conn.close(VarInt::from_u32(CLOSE_PROTOCOL), b"bad admit");
            return Err(CoreError::refused("the computer's group admission is wrong"));
        }
    }
    // Pairing the same computer again replaces what the last pairing kept, leaving nothing of it behind.
    computers::forget(&storage, &s.host.record.id)?;
    storage.save(computers::pair_key_item(&pair_id), s.pair_key.seed().to_vec())?;
    storage.save(computers::pair_secret_item(&pair_id), pair_secret.to_vec())?;
    if group_exchange {
        storage.save(computers::group_key_item(&s.group), s.group_key.seed().to_vec())?;
    }
    let computer = PairedComputer {
        id: s.host.record.id.clone(),
        name: s.host.record.name.clone(),
        public_key: b64(&s.offer.host_key),
        relay: s.offer.relay.clone(),
        addrs: s.offer.lan.iter().chain(&s.offer.direct).cloned().collect(),
        pair_id: Some(pair_id),
        group: group_exchange.then(|| s.group.clone()),
        app,
        paired_at: now_ms() as i64,
    };
    computers::put(&storage, computer.clone())?;
    let _ = identity;
    // The computer adds this phone once both confirms crossed, and closes the connection a moment after; closing it
    // here first could drop this phone's confirm before it is read.
    let _ = s.send.finish();
    let _ = tokio::time::timeout(Duration::from_secs(3), s.conn.closed()).await;
    Ok(computer)
}
