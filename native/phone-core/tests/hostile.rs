//! A HOSTILE computer: a fake peer that speaks the link (`clover/link/1`, lanes, the `clover/rpc/1` client stream) and
//! the pair door (`clover/pair/1`) and misbehaves, against which the core must hold. Every other proof used an honest
//! engine. Loopback only, no relay; no engine and no bun needed.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use iroh::endpoint::{Connection, RecvStream, SendStream};
use moss_phone_core::{
    bytes, cards,
    cbor::{decode_with, encode, Cbor, Limits},
    computers::{self, PairedComputer, PhoneApp},
    keys::{device_id_for, verify_ed25519, Ed25519Key},
    net::{read_frame, write_frame},
    AnswerKeyHolder, ConnEvent, ConnectOptions, CoreConfig, CoreError, PhoneCore, PhoneOs, RelayChoice, SecretStorage, StorageError,
};
use serde_json::{json, Value};

#[derive(Default)]
struct MemStorage {
    items: Mutex<HashMap<String, Vec<u8>>>,
    saves: AtomicUsize,
    locked: bool,
}

impl SecretStorage for MemStorage {
    fn load(&self, name: String) -> Result<Option<Vec<u8>>, StorageError> {
        if self.locked {
            return Err(StorageError::NotAvailable { reason: "locked before the first unlock".into() });
        }
        Ok(self.items.lock().unwrap().get(&name).cloned())
    }
    fn save(&self, name: String, value: Vec<u8>) -> Result<(), StorageError> {
        self.saves.fetch_add(1, Ordering::Relaxed);
        self.items.lock().unwrap().insert(name, value);
        Ok(())
    }
    fn delete(&self, name: String) -> Result<(), StorageError> {
        self.items.lock().unwrap().remove(&name);
        Ok(())
    }
}

fn config() -> CoreConfig {
    CoreConfig { device_name: "Test phone".into(), holder: AnswerKeyHolder::Keychain, os: PhoneOs::Ios, relay: RelayChoice::Disabled, bind_addr: Some("127.0.0.1:0".into()) }
}

const LOOSE: Limits = Limits { max_items: 1 << 20, max_depth: 64 };

/// What the fake computer answers a client call with.
enum Reply {
    Result(Value),
}

type Script = Arc<dyn Fn(&str, &Value) -> Reply + Send + Sync>;

#[derive(Clone)]
struct Behaviour {
    rpc: Script,
    /// Frames pushed on the client stream right after `protocol.hello` is answered.
    after_hello: Vec<Vec<u8>>,
    /// A frame sent on the computer's own lane right after its link hello answer.
    lane_after_hello: Option<Vec<u8>>,
}

struct Fake {
    _ep: iroh::Endpoint,
    id: String,
    public: [u8; 32],
    addr: String,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
}

async fn bind(key: &Ed25519Key) -> iroh::Endpoint {
    iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
        .secret_key(iroh::SecretKey::from_bytes(&key.seed().as_slice().try_into().unwrap()))
        .alpns(vec![b"clover/link/1".to_vec(), b"clover/pair/1".to_vec()])
        .relay_mode(iroh::RelayMode::Disabled)
        .clear_ip_transports()
        .bind_addr("127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap())
        .unwrap()
        .bind()
        .await
        .unwrap()
}

impl Fake {
    async fn link(b: Behaviour) -> Fake {
        let key = Ed25519Key::generate();
        let ep = bind(&key).await;
        let fake = Fake {
            id: device_id_for(&key.public()),
            public: key.public(),
            addr: ep.bound_sockets()[0].to_string(),
            calls: Arc::default(),
            _ep: ep.clone(),
        };
        let (id, calls) = (fake.id.clone(), fake.calls.clone());
        tokio::spawn(async move {
            while let Some(inc) = ep.accept().await {
                let Ok(conn) = inc.accept().unwrap().await else { continue };
                tokio::spawn(serve(conn, id.clone(), b.clone(), calls.clone()));
            }
        });
        fake
    }

    fn computer(&self) -> PairedComputer {
        PairedComputer {
            id: self.id.clone(),
            name: "Hostile".into(),
            public_key: bytes::b64(&self.public),
            relay: None,
            addrs: vec![self.addr.clone()],
            pair_id: None,
            group: None,
            app: PhoneApp::Moss,
            paired_at: 0,
        }
    }

    fn count(&self, method: &str) -> usize {
        self.calls.lock().unwrap().iter().filter(|(m, _)| m == method).count()
    }
}

async fn serve(conn: Connection, id: String, b: Behaviour, calls: Arc<Mutex<Vec<(String, Value)>>>) {
    let lanes: Arc<tokio::sync::Mutex<Vec<SendStream>>> = Arc::default();
    while let Ok((send, recv)) = conn.accept_bi().await {
        tokio::spawn(stream(conn.clone(), send, recv, id.clone(), b.clone(), calls.clone(), lanes.clone()));
    }
}

async fn stream(conn: Connection, mut send: SendStream, mut recv: RecvStream, id: String, b: Behaviour, calls: Arc<Mutex<Vec<(String, Value)>>>, lanes: Arc<tokio::sync::Mutex<Vec<SendStream>>>) {
    let Ok(Some(first)) = read_frame(&mut recv, 1 << 24).await else { return };
    let head = decode_with(&first, LOOSE).unwrap();
    match head.as_array().and_then(|a| a.first()).and_then(Cbor::as_str) {
        Some("L") => {
            while let Ok(Some(f)) = read_frame(&mut recv, 1 << 24).await {
                let m = decode_with(&f, LOOSE).unwrap();
                let a = m.as_array().unwrap().to_vec();
                if a.first().and_then(Cbor::as_str) == Some("q") && a.get(2).and_then(Cbor::as_str) == Some("peer.hello") {
                    let seq = a[3].get("connSeq").cloned().unwrap();
                    let (mut lane, _r) = conn.open_bi().await.unwrap();
                    write_frame(&mut lane, &encode(&Cbor::Array(vec![Cbor::text("L")]))).await.unwrap();
                    let answer = Cbor::map(vec![("protocolVersion", Cbor::Uint(1)), ("device", Cbor::text(&id)), ("features", Cbor::Array(vec![])), ("connSeq", seq)]);
                    write_frame(&mut lane, &encode(&Cbor::Array(vec![Cbor::text("r"), a[1].clone(), Cbor::Uint(1), answer]))).await.unwrap();
                    if let Some(raw) = &b.lane_after_hello {
                        let _ = write_frame(&mut lane, raw).await;
                    }
                    lanes.lock().await.push(lane);
                }
            }
        }
        Some("S") => {
            while let Ok(Some(f)) = read_frame(&mut recv, 1 << 24).await {
                let msg: Value = serde_json::from_slice(&f).unwrap();
                let method = msg["method"].as_str().unwrap_or("").to_string();
                calls.lock().unwrap().push((method.clone(), msg["params"].clone()));
                // `slow`: this computer stops reading for a while, so the phone's next large write stalls part way.
                if method == "slow" {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                }
                let Reply::Result(r) = (b.rpc)(&method, &msg["params"]);
                let frame = serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": msg["id"], "result": r })).unwrap();
                // Written raw (length, then body), so a hostile computer can send past the link's own cap.
                let mut raw = (frame.len() as u32).to_be_bytes().to_vec();
                raw.extend_from_slice(&frame);
                if send.write_all(&raw).await.is_err() {
                    return;
                }
                if method == "protocol.hello" {
                    for raw in &b.after_hello {
                        let _ = write_frame(&mut send, raw).await;
                    }
                }
            }
        }
        _ => {}
    }
}

/// A card as the engine makes one, its hash over its content.
fn card(id: &str, title: &str) -> Value {
    let mut c = json!({
        "id": id, "kind": "change", "computer": "Hostile", "issuedAt": 1, "expiresAt": 9_999_999_999_999u64,
        "fields": { "title": { "type": "text", "text": title } },
        "options": [{ "id": "approve", "kind": "approve", "label": "Allow" }, { "id": "deny", "kind": "deny", "label": "Deny" }],
    });
    c["hash"] = json!(cards::card_hash(&c).unwrap());
    c
}

fn honest(method: &str, _p: &Value) -> Reply {
    match method {
        "card.list" => Reply::Result(json!({ "cards": [] })),
        _ => Reply::Result(json!({ "ok": true })),
    }
}

async fn phone_for(fakes: &[&Fake]) -> (Arc<PhoneCore>, Arc<MemStorage>) {
    let storage = Arc::new(MemStorage::default());
    let core = PhoneCore::new(storage.clone(), config()).unwrap();
    let dyn_storage: Arc<dyn SecretStorage> = storage.clone();
    for f in fakes {
        computers::put(&dyn_storage, f.computer()).unwrap();
    }
    (core, storage)
}

fn opts() -> ConnectOptions {
    ConnectOptions { client_name: "hostile test".into(), areas: vec!["approvals".into()], call_timeout_ms: 10_000 }
}

async fn until(conn: &moss_phone_core::Connection, what: &str, mut f: impl FnMut(&ConnEvent) -> bool) -> ConnEvent {
    let end = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut seen = vec![];
    loop {
        let e = match tokio::time::timeout_at(end, conn.next_event()).await {
            Ok(e) => e.expect("open"),
            Err(_) => panic!("timed out waiting for {what}; heard {seen:?}; state {:?}", conn.state()),
        };
        if f(&e) {
            return e;
        }
        seen.push(format!("{e:?}").chars().take(120).collect::<String>());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_swapped_or_rehashed_card_is_never_what_gets_signed() {
    let a = card("card_aaaaaaaa", "Card A");
    let b = card("card_bbbbbbbb", "Card B: another computer's");
    let d = card("card_dddddddd", "Card D: resolved before it was listed");
    let a_changed = card("card_aaaaaaaa", "Card A, changed after it was shown");
    let bad = { let mut c = card("card_cccccccc", "tampered"); c["fields"]["title"]["text"] = json!("not what the hash covers"); c };
    let gets = Arc::new(AtomicUsize::new(0));
    let (a2, b2, ac2, bad2, d2, g2) = (a.clone(), b.clone(), a_changed.clone(), bad.clone(), d.clone(), gets.clone());
    let fake = Fake::link(Behaviour {
        rpc: Arc::new(move |m, _p| match m {
            "card.list" => Reply::Result(json!({ "cards": [a2, bad2, d2] })),
            // The first card.get for A answers with B (a swap), the next with a different card under A's id.
            "card.get" => Reply::Result(json!({ "card": if g2.fetch_add(1, Ordering::SeqCst) == 0 { b2.clone() } else { ac2.clone() } })),
            "card.answer" => Reply::Result(json!({ "accepted": true })),
            _ => Reply::Result(json!({})),
        }),
        // D's resolution comes before the pending list that brings D.
        after_hello: vec![br#"{"jsonrpc":"2.0","method":"core.event","params":{"type":"card_resolved","ts":1,"id":"card_dddddddd","outcome":"expired"}}"#.to_vec()],
        lane_after_hello: None,
    })
    .await;
    let other_computer = Fake::link(Behaviour { rpc: Arc::new(honest), after_hello: vec![], lane_after_hello: None }).await;
    let (core, storage) = phone_for(&[&fake, &other_computer]).await;
    let conn = core.clone().connect(fake.id.clone(), opts()).await.unwrap();
    let mut tampered_seen = false;
    let shown = loop {
        match until(&conn, "the pending cards", |e| matches!(e, ConnEvent::PendingCards { .. } | ConnEvent::TamperedCard { .. })).await {
            ConnEvent::TamperedCard { computers_id } => {
                assert_eq!(computers_id.as_deref(), Some("card_cccccccc"));
                tampered_seen = true;
            }
            ConnEvent::PendingCards { cards } => break cards,
            _ => unreachable!(),
        }
    };
    assert!(tampered_seen, "a card whose hash doesn't match is reported, not shown");
    assert_eq!(shown.iter().map(|c| c.id()).collect::<Vec<_>>(), ["card_aaaaaaaa", "card_dddddddd"]);
    let shown_a = shown[0].clone();
    // D was resolved before it was listed: it reads as resolved, and the core refuses to answer it.
    let shown_d = shown[1].clone();
    assert!(!shown_d.pending());
    assert!(matches!(conn.answer_card(shown_d, "approve".into(), vec![]).await, Err(CoreError::Refused { .. })));
    // A card issued by one computer's connection is never answered on another's.
    let elsewhere = core.clone().connect(other_computer.id.clone(), opts()).await.unwrap();
    until(&elsewhere, "the other link up", |e| matches!(e, ConnEvent::Up)).await;
    assert!(matches!(elsewhere.answer_card(shown_a.clone(), "approve".into(), vec![]).await, Err(CoreError::Refused { .. })));
    assert_eq!(other_computer.count("card.answer"), 0);
    elsewhere.disconnect();

    // Asked for A, the computer answers with B: refused.
    assert!(matches!(conn.fetch_card("card_aaaaaaaa".into()).await, Err(CoreError::TamperedCard { .. })));
    // Asked again, it answers with a different card under A's id (its hash recomputed): that is what would be shown.
    let other = conn.fetch_card("card_aaaaaaaa".into()).await.unwrap();
    assert_ne!(other.hash(), shown_a.hash());
    // An option or checkbox outside the card's (or the protocol's patterns) is refused before anything is signed.
    let answers = fake.count("card.answer");
    assert!(conn.answer_card(shown_a.clone(), "always".into(), vec![]).await.is_err());
    assert!(conn.answer_card(shown_a.clone(), "approve".into(), vec!["../x".into()]).await.is_err());
    assert_eq!(fake.count("card.answer"), answers);

    // The person taps Approve on A as displayed: nothing is fetched between the tap and the signature, and what is
    // signed is A's hash, from A's content.
    let before = fake.count("card.get");
    let r = conn.answer_card(shown_a.clone(), "approve".into(), vec![]).await.unwrap();
    assert!(r.accepted);
    assert_eq!(fake.count("card.get"), before, "no fetch at answer time");
    let (_, p) = fake.calls.lock().unwrap().iter().rev().find(|(m, _)| m == "card.answer").cloned().unwrap();
    assert_eq!(p["id"], "card_aaaaaaaa");
    assert_eq!(p["hash"], a["hash"]);
    let key = Ed25519Key::from_seed_slice(storage.items.lock().unwrap().get("answer-key").unwrap()).unwrap();
    let signed = cards::card_answer_signing_input("card_aaaaaaaa", a["hash"].as_str().unwrap(), "approve", p["proof"]["at"].as_i64().unwrap(), &[]);
    assert!(verify_ed25519(&key.public(), signed.as_bytes(), &bytes::from_b64(p["proof"]["signature"].as_str().unwrap()).unwrap()));

    // A is answered: neither A nor the changed card under A's id is answered again (app code can't make a CardView
    // with other content; the type holds that).
    assert!(!shown_a.pending());
    assert!(matches!(conn.answer_card(other, "approve".into(), vec![]).await, Err(CoreError::Refused { .. })));
    let _ = b;
    conn.disconnect();
}

/// A CBOR map of `n` distinct keys, each a 4-byte text and a null value.
fn huge_map(n: u32) -> Vec<u8> {
    let mut b = vec![0xba];
    b.extend_from_slice(&n.to_be_bytes());
    for i in 0..n {
        b.push(0x64);
        b.extend_from_slice(&i.to_be_bytes());
        b.push(0xf6);
    }
    b
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hostile_lane_frame_closes_only_that_link_and_fast() {
    // One computer sends a lane message of 150 000 map keys (900 KB, under the lane's frame cap: the item cap stops it);
    // another sends a 2 MiB lane frame (the frame cap stops it); a third is honest and keeps working throughout.
    let many = Fake::link(Behaviour { rpc: Arc::new(honest), after_hello: vec![], lane_after_hello: Some(huge_map(150_000)) }).await;
    let big = Fake::link(Behaviour { rpc: Arc::new(honest), after_hello: vec![], lane_after_hello: Some(vec![0x40; 2 * 1024 * 1024]) }).await;
    let good = Fake::link(Behaviour { rpc: Arc::new(honest), after_hello: vec![], lane_after_hello: None }).await;
    let (core, _) = phone_for(&[&many, &big, &good]).await;
    let c_good = core.clone().connect(good.id.clone(), opts()).await.unwrap();
    until(&c_good, "the honest link up", |e| matches!(e, ConnEvent::Up)).await;
    for (fake, why) in [(&many, "isn't one (or one too large)"), (&big, "larger than a lane takes")] {
        let c = core.clone().connect(fake.id.clone(), opts()).await.unwrap();
        let t = Instant::now();
        let ConnEvent::Down { reason } = until(&c, "the hostile link down", |e| matches!(e, ConnEvent::Down { .. })).await else { unreachable!() };
        assert!(reason.contains(why), "the reason: {reason}");
        assert!(t.elapsed() < Duration::from_secs(5), "refused in {:?}", t.elapsed());
        // The honest computer answers at once meanwhile.
        let t = Instant::now();
        c_good.call("bot.list".into(), "{}".into()).await.unwrap();
        assert!(t.elapsed() < Duration::from_secs(1));
        c.disconnect();
    }
    c_good.disconnect();
}

#[tokio::test(flavor = "multi_thread")]
async fn client_frames_lone_surrogates_are_read_and_junk_closes_with_a_reason() {
    let note = br#"{"jsonrpc":"2.0","method":"core.event","params":{"type":"note","text":"a\ud800b"}}"#.to_vec();
    let junk = b"{this isn't json".to_vec();
    let f = Fake::link(Behaviour { rpc: Arc::new(honest), after_hello: vec![note, junk], lane_after_hello: None }).await;
    let (core, _) = phone_for(&[&f]).await;
    let c = core.clone().connect(f.id.clone(), opts()).await.unwrap();
    let ConnEvent::Notification { params_json, .. } = until(&c, "the note", |e| matches!(e, ConnEvent::Notification { .. })).await else { unreachable!() };
    assert!(params_json.contains('\u{fffd}'), "a lone surrogate reads as U+FFFD: {params_json}");
    let ConnEvent::Down { reason } = until(&c, "down", |e| matches!(e, ConnEvent::Down { .. })).await else { unreachable!() };
    assert!(reason.contains("isn't JSON"), "{reason}");
    c.disconnect();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_oversize_answer_fails_only_its_call_and_the_link_stays() {
    // A 5 MiB answer (over the phone's 4 MiB, within the engine's own 16 MiB) to one call, while another call is in
    // flight; then a 17 MiB answer, past what the link allows at all.
    let f = Fake::link(Behaviour {
        rpc: Arc::new(|m, p| match m {
            "bot.list" => Reply::Result(json!("x".repeat(5 << 20))),
            "too.big" => Reply::Result(json!("x".repeat(17 << 20))),
            _ => honest(m, p),
        }),
        after_hello: vec![],
        lane_after_hello: None,
    })
    .await;
    let (core, _) = phone_for(&[&f]).await;
    let c = core.clone().connect(f.id.clone(), opts()).await.unwrap();
    until(&c, "up", |e| matches!(e, ConnEvent::Up)).await;
    let (big, small) = tokio::join!(c.call("bot.list".into(), "{}".into()), c.call("models.list".into(), "{}".into()));
    match big {
        Err(CoreError::Refused { reason }) => assert!(reason.contains("5.0 MiB"), "{reason}"),
        other => panic!("the oversize answer fails its call: {other:?}"),
    }
    small.expect("the other call completes");
    c.call("bot.get".into(), "{}".into()).await.expect("the link is still up for the next call");
    assert_eq!(c.state(), moss_phone_core::LinkState::Up);
    assert!(c.call("too.big".into(), "{}".into()).await.is_err());
    let ConnEvent::Down { reason } = until(&c, "down", |e| matches!(e, ConnEvent::Down { .. })).await else { unreachable!() };
    assert!(reason.contains("16 MiB"), "{reason}");
    c.disconnect();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_abandoned_mid_write_leaves_the_stream_whole_for_the_next_answer() {
    let a = card("card_aaaaaaaa", "Card A");
    let a2 = a.clone();
    let f = Fake::link(Behaviour {
        rpc: Arc::new(move |m, p| match m {
            "card.list" => Reply::Result(json!({ "cards": [a2.clone()] })),
            "card.answer" => Reply::Result(json!({ "accepted": true })),
            _ => honest(m, p),
        }),
        after_hello: vec![],
        lane_after_hello: None,
    })
    .await;
    let (core, _) = phone_for(&[&f]).await;
    let c = core.clone().connect(f.id.clone(), opts()).await.unwrap();
    let ConnEvent::PendingCards { cards } = until(&c, "the cards", |e| matches!(e, ConnEvent::PendingCards { .. })).await else { unreachable!() };
    until(&c, "up", |e| matches!(e, ConnEvent::Up)).await;
    // The computer stops reading; a 6 MiB call is abandoned while its frame is part written.
    let slow = tokio::spawn({
        let c = c.clone();
        async move { c.call("slow".into(), "{}".into()).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let big = json!({ "blob": "y".repeat(6 << 20) }).to_string();
    assert!(tokio::time::timeout(Duration::from_millis(300), c.call("big.call".into(), big)).await.is_err(), "the call was abandoned mid-write");
    // The person then answers a card: it reaches the computer whole and is taken.
    let r = c.answer_card(cards[0].clone(), "approve".into(), vec![]).await.expect("the answer after an abandoned write");
    assert!(r.accepted);
    slow.await.unwrap().unwrap();
    let methods: Vec<String> = f.calls.lock().unwrap().iter().map(|(m, _)| m.clone()).collect();
    assert!(methods.ends_with(&["slow".into(), "big.call".into(), "card.answer".into()]), "{methods:?}");
    c.disconnect();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_abandoned_next_event_loses_no_event() {
    let f = Fake::link(Behaviour { rpc: Arc::new(honest), after_hello: vec![], lane_after_hello: None }).await;
    let (core, _) = phone_for(&[&f]).await;
    let c = core.clone().connect(f.id.clone(), opts()).await.unwrap();
    // Abandon calls while events are coming in (as a cancelled Swift task or coroutine would), then read on: every
    // event still arrives, in order.
    // A call that did return an event before its deadline hands it over (kept here); one abandoned while waiting
    // must take nothing.
    let mut seen = vec![];
    for _ in 0..200 {
        if let Ok(Some(e)) = tokio::time::timeout(Duration::from_micros(50), c.next_event()).await {
            seen.push(e);
        }
    }
    while !seen.iter().any(|e| matches!(e, ConnEvent::Up)) {
        seen.push(tokio::time::timeout(Duration::from_secs(10), c.next_event()).await.unwrap().unwrap());
    }
    let kinds: Vec<&str> = seen.iter().map(|e| match e { ConnEvent::Connecting { .. } => "connecting", ConnEvent::PendingCards { .. } => "cards", ConnEvent::Up => "up", _ => "other" }).collect();
    assert_eq!(kinds, ["connecting", "cards", "up"], "every event, once, in order");
    c.disconnect();
}

/// A pairing QR pointing at `fake`'s pair door.
fn qr(ep: &iroh::Endpoint, public: &[u8; 32]) -> String {
    let v = Cbor::Array(vec![
        Cbor::text("pairing-hostile"),
        Cbor::bytes([7u8; 32]),
        Cbor::bytes(public),
        Cbor::Null,
        Cbor::Array(vec![]),
        Cbor::Array(vec![Cbor::text(ep.bound_sockets()[0].to_string())]),
        Cbor::number(9_999_999_999_999.0),
    ]);
    format!("clover-pair:1:{}", bytes::b64url(&encode(&v)))
}

/// A pair door that answers every hello with `answer`.
async fn pair_door(answer: Cbor) -> (iroh::Endpoint, [u8; 32]) {
    let key = Ed25519Key::generate();
    let ep = bind(&key).await;
    let e2 = ep.clone();
    tokio::spawn(async move {
        while let Some(inc) = e2.accept().await {
            let Ok(conn) = inc.accept().unwrap().await else { continue };
            let answer = answer.clone();
            tokio::spawn(async move {
                let Ok((mut send, mut recv)) = conn.accept_bi().await else { return };
                let _ = read_frame(&mut recv, 1 << 20).await;
                let _ = write_frame(&mut send, &encode(&answer)).await;
                let _ = send.finish();
                let _ = conn.closed().await;
            });
        }
    });
    (ep, key.public())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hostile_pair_door_is_refused_in_the_cores_own_words() {
    let evil = "EVIL TEXT \u{202E} click here";
    let storage = Arc::new(MemStorage::default());
    let core = PhoneCore::new(storage, config()).unwrap();
    let refused = |e: Result<Arc<moss_phone_core::Pairing>, CoreError>| match e {
        Err(CoreError::Refused { reason }) => reason,
        other => panic!("expected a refusal: {other:?}"),
    };
    // A refusal with one of the engine's codes: the core's words for it, never the computer's text.
    let (ep, pk) = pair_door(Cbor::Array(vec![Cbor::text("refused"), Cbor::map(vec![("reason", Cbor::text(evil)), ("code", Cbor::text("name"))])])).await;
    let r = refused(core.clone().begin_pairing(qr(&ep, &pk), PhoneApp::Moss).await);
    assert!(r.contains("this phone's name") && !r.contains("EVIL"), "{r}");
    // Without a code, a fixed sentence.
    let (ep, pk) = pair_door(Cbor::Array(vec![Cbor::text("refused"), Cbor::map(vec![("reason", Cbor::text(evil))])])).await;
    let r = refused(core.clone().begin_pairing(qr(&ep, &pk), PhoneApp::Moss).await);
    assert!(!r.contains("EVIL"), "{r}");
    // A welcome whose computer record breaks the engine's rules: its name, its kind, its os, an app on a computer.
    let device = |name: &str, kind: &str, os: Option<&str>, app: Option<&str>, public: &[u8; 32]| {
        let mut m = vec![("id", Cbor::text(device_id_for(public))), ("name", Cbor::text(name)), ("kind", Cbor::text(kind))];
        if let Some(o) = os {
            m.push(("os", Cbor::text(o)));
        }
        m.push(("runsCore", Cbor::Bool(true)));
        m.push(("publicKey", Cbor::text(bytes::b64(public))));
        if let Some(a) = app {
            m.push(("app", Cbor::text(a)));
        }
        Cbor::map(m)
    };
    for (name, kind, os, app, words) in [
        (evil, "desktop", None, None, "its name isn't one"),
        ("Studio", "phone", None, None, "isn't a computer"),
        ("Studio", "desktop", Some("plan9"), None, "system MOSS doesn't know"),
        ("Studio", "desktop", None, Some("moss"), "names a phone app"),
    ] {
        // The door's own key is the one the record must name: bind first, then answer with a record for that key.
        let key = Ed25519Key::generate();
        let ep = bind(&key).await;
        let welcome = Cbor::Array(vec![
            Cbor::text("welcome"),
            Cbor::map(vec![
                ("device", device(name, kind, os, app, &key.public())),
                ("pairKey", Cbor::bytes(Ed25519Key::generate().public())),
                ("groupKey", Cbor::bytes(Ed25519Key::generate().public())),
                ("group", Cbor::text("g")),
                ("fresh", Cbor::Bool(true)),
                ("t", Cbor::number(moss_phone_core::pairing::now_ms().floor())),
                ("account", Cbor::Null),
                ("nonce", Cbor::bytes([1u8; 32])),
                ("proof", Cbor::bytes([2u8; 32])),
            ]),
        ]);
        let e2 = ep.clone();
        tokio::spawn(async move {
            if let Some(inc) = e2.accept().await {
                let conn = inc.accept().unwrap().await.unwrap();
                let (mut send, mut recv) = conn.accept_bi().await.unwrap();
                let _ = read_frame(&mut recv, 1 << 20).await;
                let _ = write_frame(&mut send, &encode(&welcome)).await;
                let _ = conn.closed().await;
            }
        });
        let r = refused(core.clone().begin_pairing(qr(&ep, &key.public()), PhoneApp::Moss).await);
        assert!(r.contains(words) && !r.contains("EVIL"), "{name}/{kind}: {r}");
    }
    assert!(core.paired_computers().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_store_that_cant_answer_or_lost_a_key_never_gets_new_keys() {
    // Locked: the core fails and writes nothing.
    let locked = Arc::new(MemStorage { locked: true, ..Default::default() });
    assert!(matches!(PhoneCore::new(locked.clone(), config()), Err(CoreError::Storage { .. })));
    assert_eq!(locked.saves.load(Ordering::Relaxed), 0);
    // Computers are paired but the device key is gone: nothing is minted over it.
    let lost = Arc::new(MemStorage::default());
    let fake = Fake::link(Behaviour { rpc: Arc::new(honest), after_hello: vec![], lane_after_hello: None }).await;
    let dyn_lost: Arc<dyn SecretStorage> = lost.clone();
    computers::put(&dyn_lost, fake.computer()).unwrap();
    let saves = lost.saves.load(Ordering::Relaxed);
    assert!(matches!(PhoneCore::new(lost.clone(), config()), Err(CoreError::Storage { .. })));
    assert_eq!(lost.saves.load(Ordering::Relaxed), saves);
    // A phone's own name is made safe as the engine makes its own.
    let fresh = Arc::new(MemStorage::default());
    let core = PhoneCore::new(fresh, CoreConfig { device_name: "  Kim's\u{202E}  phone \u{0007}".into(), ..config() }).unwrap();
    assert_eq!(core.identity().name, "Kim's phone");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_is_staged_in_chunks_under_the_links_frame_limit() {
    // The fake keeps what each chunk brings, as the engine's door does, and answers with the next offset.
    let got: Arc<Mutex<Vec<u8>>> = Arc::default();
    let sizes: Arc<Mutex<Vec<usize>>> = Arc::default();
    let (g2, s2) = (got.clone(), sizes.clone());
    let f = Fake::link(Behaviour {
        rpc: Arc::new(move |m, p| {
            if m != "session.stageFile" {
                return honest(m, p);
            }
            let chunk = bytes::from_b64(p["dataBase64"].as_str().unwrap()).unwrap();
            s2.lock().unwrap().push(p["dataBase64"].as_str().unwrap().len());
            let mut g = g2.lock().unwrap();
            if p.get("name").is_some() {
                g.clear();
            } else {
                assert_eq!(p["offset"].as_u64().unwrap() as usize, g.len());
            }
            g.extend_from_slice(&chunk);
            let done = g.len() == 1_300_000;
            Reply::Result(json!({ "upload": "up1", "received": g.len(), "done": done, "name": "notes \u{202E}.txt", "path": "bots/alpha/files/notes.txt" }))
        }),
        after_hello: vec![],
        lane_after_hello: None,
    })
    .await;
    let (core, _) = phone_for(&[&f]).await;
    let c = core.clone().connect(f.id.clone(), opts()).await.unwrap();
    until(&c, "up", |e| matches!(e, ConnEvent::Up)).await;
    let data: Vec<u8> = (0..1_300_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let staged = c.stage_file("s_alpha".into(), "notes.txt".into(), data.clone()).await.unwrap();
    assert_eq!(staged.path, "bots/alpha/files/notes.txt");
    assert_eq!(staged.computers_name, "notes .txt", "the computer's name for it is cleaned");
    assert_eq!(*got.lock().unwrap(), data);
    let sizes = sizes.lock().unwrap().clone();
    assert_eq!(sizes.len(), 3);
    assert!(sizes.iter().all(|n| *n <= 699_052), "each chunk at most 512 KiB of bytes: {sizes:?}");
    c.disconnect();
}
