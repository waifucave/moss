//! Proof A: the core against a REAL engine started from source on a temp home (tests/harness/engine.ts), over the
//! real link sidecar on loopback: no relay, nothing leaves the machine. Needs `bun` (MOSS_PC_BUN, default the repo's
//! scripts/pinned-bun) with the workspace installed, and the built sidecar (MOSS_LINK_BIN); skipped without
//! MOSS_PC_ENGINE_TESTS=1, which CI's phone-core job sets.

use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use moss_phone_core::{
    bytes, cards, keys::Ed25519Key, AnswerKeyHolder, ConnEvent, ConnectOptions, Connection, CoreConfig, CoreError, PhoneApp, PhoneCore, PhoneOs, RelayChoice,
    SecretStorage, StorageError,
};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout},
};

#[derive(Default)]
struct MemStorage(Mutex<HashMap<String, Vec<u8>>>);

impl SecretStorage for MemStorage {
    fn load(&self, name: String) -> Result<Option<Vec<u8>>, StorageError> {
        Ok(self.0.lock().unwrap().get(&name).cloned())
    }
    fn save(&self, name: String, value: Vec<u8>) -> Result<(), StorageError> {
        self.0.lock().unwrap().insert(name, value);
        Ok(())
    }
    fn delete(&self, name: String) -> Result<(), StorageError> {
        self.0.lock().unwrap().remove(&name);
        Ok(())
    }
}

fn enabled() -> bool {
    std::env::var("MOSS_PC_ENGINE_TESTS").as_deref() == Ok("1")
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

struct Engine {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next: u64,
}

impl Engine {
    async fn start() -> Engine {
        Self::start_with(&[]).await
    }

    async fn start_with(args: &[String]) -> Engine {
        let bun = std::env::var("MOSS_PC_BUN").map(PathBuf::from).unwrap_or_else(|_| repo().join("scripts/pinned-bun"));
        // The core tests' own preload: a per-process temp root, the throwaway keychain service, no login shell.
        let mut child = tokio::process::Command::new(bun)
            .arg("--preload")
            .arg(repo().join("packages/core/test/preload.ts"))
            .arg(repo().join("native/phone-core/tests/harness/engine.ts"))
            .args(args)
            .current_dir(repo())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("the engine harness");
        let stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        // The engine writes its own lines to stdout too: wait for the harness's.
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                let line = lines.next_line().await.unwrap().expect("the engine harness exited before it was ready");
                if line.starts_with("{\"ready\":true") {
                    break;
                }
            }
        })
        .await
        .expect("the engine started in time");
        Engine { child, stdin, lines, next: 1 }
    }

    async fn cmd(&mut self, mut c: Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        c["id"] = json!(id);
        self.stdin.write_all(format!("{c}\n").as_bytes()).await.unwrap();
        loop {
            let line = tokio::time::timeout(Duration::from_secs(90), self.lines.next_line()).await.expect("the engine answered in time").unwrap().expect("the engine is running");
            let v: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v["id"] == json!(id) {
                return if v["ok"] == json!(true) { Ok(v["result"].clone()) } else { Err(v["error"].as_str().unwrap_or("").to_string()) };
            }
        }
    }

    async fn ok(&mut self, c: Value) -> Value {
        let what = c["cmd"].clone();
        self.cmd(c).await.unwrap_or_else(|e| panic!("engine {what}: {e}"))
    }

    async fn stop(mut self) {
        let _ = self.cmd(json!({ "cmd": "stop" })).await;
        let _ = tokio::time::timeout(Duration::from_secs(20), self.child.wait()).await;
    }
}

fn phone(storage: Arc<MemStorage>) -> Arc<PhoneCore> {
    PhoneCore::new(
        storage,
        CoreConfig { device_name: "Test phone".into(), holder: AnswerKeyHolder::Keychain, os: PhoneOs::Ios, relay: RelayChoice::Disabled, bind_addr: Some("127.0.0.1:0".into()) },
    )
    .unwrap()
}

/// Pairs a fresh phone with the engine, the engine's person confirming `words` (the right ones when None) and
/// approving (or denying) the card.
async fn pair(engine: &mut Engine, core: &Arc<PhoneCore>, words: Option<Vec<String>>, approve: bool) -> (Result<moss_phone_core::PairedComputer, CoreError>, Vec<String>) {
    let begun = engine.ok(json!({ "cmd": "begin" })).await;
    let pairing_id = begun["pairingId"].as_str().unwrap().to_string();
    let pairing = core.clone().begin_pairing(begun["qr"].as_str().unwrap().into(), PhoneApp::Moss).await.expect("the phone reached the words");
    let shown: Vec<String> = serde_json::from_value(engine.ok(json!({ "cmd": "words", "pairingId": pairing_id })).await).unwrap();
    // Both show the same four words: the phone's are built from the same transcript as the engine's.
    assert_eq!(pairing.words(), shown);
    let typed = words.unwrap_or_else(|| shown.clone());
    let phone_side = tokio::spawn(async move { pairing.confirm().await });
    engine.ok(json!({ "cmd": "confirm", "pairingId": pairing_id, "words": typed, "approve": approve })).await;
    (phone_side.await.unwrap(), shown)
}

async fn until_event(conn: &Connection, what: &str, mut f: impl FnMut(&ConnEvent) -> bool) -> ConnEvent {
    let end = tokio::time::Instant::now() + Duration::from_secs(45);
    loop {
        let e = tokio::time::timeout_at(end, conn.next_event()).await.unwrap_or_else(|_| panic!("timed out waiting for {what}")).expect("the connection is open");
        if f(&e) {
            return e;
        }
        assert!(!matches!(e, ConnEvent::Closed), "closed while waiting for {what}");
    }
}

fn card_event(e: &ConnEvent, card: &str) -> Option<Arc<moss_phone_core::CardView>> {
    let ConnEvent::CardRequested { card: v } = e else { return None };
    (v.id() == card).then(|| v.clone())
}

#[tokio::test(flavor = "multi_thread")]
async fn pairs_calls_hears_and_answers_cards_then_is_revoked() {
    if !enabled() {
        return;
    }
    // A fixed loopback port, so the engine's sidecar comes back where the phone paired with it after `bounce`.
    let port = std::net::UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let mut engine = Engine::start_with(&["--bind".into(), format!("127.0.0.1:{port}")]).await;
    let storage = Arc::new(MemStorage::default());
    let core = phone(storage.clone());
    let (paired, _) = pair(&mut engine, &core, None, true).await;
    let computer = paired.expect("the pairing completed");
    assert_eq!(computer.name, "Studio");
    assert_eq!(computer.app, PhoneApp::Moss);
    // The engine lists the phone, with the same id the phone derives from its own key.
    let me = core.identity();
    engine.ok(json!({ "cmd": "waitDevice", "device": me.device_id })).await;
    let devices = engine.ok(json!({ "cmd": "devices" })).await;
    let listed = devices["devices"].as_array().unwrap().iter().find(|d| d["id"] == json!(me.device_id)).expect("the phone is listed").clone();
    assert_eq!(listed["kind"], "phone");
    // The app the phone paired as is the engine's record of it (lane PH), fixed by the transcript the words covered.
    assert_eq!(listed["app"], "moss");
    // The pair credential is kept through the host's storage, never anywhere else.
    let pair_id = computer.pair_id.clone().unwrap();
    assert!(storage.0.lock().unwrap().contains_key(&format!("pair-key:{pair_id}")));
    assert!(storage.0.lock().unwrap().contains_key(&format!("pair-secret:{pair_id}")));

    // A card already waiting at connect comes in the pending list.
    let waiting = engine.ok(json!({ "cmd": "raiseCard", "title": "waiting at connect" })).await["cardId"].as_str().unwrap().to_string();
    let conn = core
        .clone()
        .connect(computer.id.clone(), ConnectOptions { client_name: "phone-core test".into(), areas: vec!["approvals".into(), "bots".into(), "devices".into()], call_timeout_ms: 30_000 })
        .await
        .unwrap();
    let pending = until_event(&conn, "the pending cards", |e| matches!(e, ConnEvent::PendingCards { .. })).await;
    let ConnEvent::PendingCards { cards: listed_cards } = pending else { unreachable!() };
    let waiting_view = listed_cards.iter().find(|c| c.id() == waiting).expect("the waiting card is in the pending list").clone();
    until_event(&conn, "up", |e| matches!(e, ConnEvent::Up)).await;
    assert_eq!(conn.state(), moss_phone_core::LinkState::Up);

    // Calls on the remote role's list work; one off it is refused by the engine.
    let bots: Value = serde_json::from_str(&conn.call("bot.list".into(), "{}".into()).await.expect("bot.list")).unwrap();
    assert!(bots.is_object());
    match conn.call("plugin.install".into(), "{}".into()).await {
        Err(CoreError::Rpc { .. }) => {}
        other => panic!("a call off the remote list should be refused: {other:?}"),
    }

    // A card raised now arrives as an event; the phone answers it and the engine takes the signature.
    let card_id = engine.ok(json!({ "cmd": "raiseCard" })).await["cardId"].as_str().unwrap().to_string();
    let heard = until_event(&conn, "the card_requested event", |e| card_event(e, &card_id).is_some()).await;
    let card_view = card_event(&heard, &card_id).unwrap();
    let card: Value = serde_json::from_str(&card_view.card_json()).unwrap();
    assert_eq!(cards::card_hash(&card).unwrap(), card["hash"].as_str().unwrap(), "the phone rebuilds the engine's hash");
    // The person answers the card as it was displayed: no fetch between the tap and the signature.
    let answered = conn.answer_card(card_view.clone(), "approve".into(), vec![]).await.unwrap();
    assert_eq!(answered, moss_phone_core::AnswerOutcome { accepted: true, computers_reason: None });
    let decision = engine.ok(json!({ "cmd": "decision", "cardId": card_id })).await;
    assert_eq!(decision["allowed"], true);
    assert_eq!(decision["by"], "card");

    // Refusals. Answered, the card is no longer pending: the core refuses a second answer itself.
    assert!(!card_view.pending());
    assert!(matches!(conn.answer_card(card_view.clone(), "approve".into(), vec![]).await, Err(CoreError::Refused { .. })));
    // Resolved, the card reads as such when fetched again.
    let resolved = conn.fetch_card(card_id.clone()).await.unwrap();
    assert!(!resolved.pending());
    // (A CardView is the core's own object: app code can't make one with other content, so a changed or swapped card
    // can't be handed back; tests/hostile.rs holds what a hostile computer can do.)

    let answer_key = {
        let seed = storage.0.lock().unwrap().get("answer-key").unwrap().clone();
        Ed25519Key::from_seed_slice(&seed).unwrap()
    };
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let forged_for = |id: &str, sig: &str, hash: &str| {
        json!({ "id": id, "hash": hash, "option": "approve", "proof": { "via": "device", "device": me.device_id, "at": at, "signature": sig } }).to_string()
    };
    // A replayed answer, signed properly and sent anyway: the engine refuses it too.
    let replay_sig = bytes::b64(&answer_key.sign(cards::card_answer_signing_input(&card_id, &card_view.hash(), "approve", at, &[]).as_bytes()));
    let r: Value = serde_json::from_str(&conn.call("card.answer".into(), forged_for(&card_id, &replay_sig, &card_view.hash())).await.unwrap()).unwrap();
    assert_eq!(r["accepted"], false, "the engine refuses a replay: {r}");

    // The waiting card: an answer signed for one card is no proof for another, nor for another hash.
    let view = conn.fetch_card(waiting.clone()).await.unwrap();
    assert!(view.pending());
    assert_eq!(view, waiting_view);
    let signed_for_other = bytes::b64(&answer_key.sign(cards::card_answer_signing_input(&card_id, &view.hash(), "approve", at, &[]).as_bytes()));
    let forged = |sig: &str, hash: &str| forged_for(&waiting, sig, hash);
    let r: Value = serde_json::from_str(&conn.call("card.answer".into(), forged(&signed_for_other, &view.hash())).await.unwrap()).unwrap();
    assert_eq!(r["accepted"], false, "another card's signature is refused: {r}");
    let wrong_hash = "0".repeat(64);
    let signed_wrong = bytes::b64(&answer_key.sign(cards::card_answer_signing_input(&waiting, &wrong_hash, "approve", at, &[]).as_bytes()));
    let r: Value = serde_json::from_str(&conn.call("card.answer".into(), forged(&signed_wrong, &wrong_hash)).await.unwrap()).unwrap();
    assert_eq!(r["accepted"], false, "an answer for a changed card is refused: {r}");
    // And the honest deny is taken.
    assert!(conn.answer_card(waiting_view.clone(), "deny".into(), vec![]).await.unwrap().accepted);
    assert_eq!(engine.ok(json!({ "cmd": "decision", "cardId": waiting })).await["allowed"], false);

    // The link is lost (the engine's sidecar dies and comes back): the phone sees it go down, dials back by itself, and
    // after the hello, the subscription and the pending list again, calls work.
    engine.ok(json!({ "cmd": "bounce" })).await;
    until_event(&conn, "the link down", |e| matches!(e, ConnEvent::Down { .. })).await;
    until_event(&conn, "the pending cards again", |e| matches!(e, ConnEvent::PendingCards { .. })).await;
    until_event(&conn, "up again", |e| matches!(e, ConnEvent::Up)).await;
    assert_eq!(conn.state(), moss_phone_core::LinkState::Up);
    conn.call("bot.list".into(), "{}".into()).await.expect("a call after the reconnect");

    // Revoked on the computer: the link is cut and the phone stops dialling.
    engine.ok(json!({ "cmd": "revoke", "device": me.device_id })).await;
    until_event(&conn, "revoked", |e| matches!(e, ConnEvent::Revoked)).await;
    assert_eq!(conn.state(), moss_phone_core::LinkState::Revoked);
    assert!(matches!(conn.call("bot.list".into(), "{}".into()).await, Err(_)));
    conn.disconnect();
    // Forgetting the computer deletes every item its pairing kept (the group key's item named by a hash of the id).
    assert!(storage.0.lock().unwrap().keys().any(|k| k.starts_with("group-key:") && k.len() == "group-key:".len() + 32));
    core.forget_computer(computer.id.clone()).unwrap();
    let left: Vec<String> = storage.0.lock().unwrap().keys().cloned().collect();
    assert!(left.iter().all(|k| k == "device-key" || k == "answer-key" || k == "computers"), "left behind: {left:?}");
    core.shutdown().await;
    engine.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn refusals_at_pairing() {
    if !enabled() {
        return;
    }
    let mut engine = Engine::start().await;

    // The computer's person reads different words: both refuse, and nothing is added or kept.
    let storage = Arc::new(MemStorage::default());
    let core = phone(storage.clone());
    let (r, shown) = pair(&mut engine, &core, Some(vec!["acid".into(), "acid".into(), "acid".into(), "acid".into()]), true).await;
    assert_ne!(shown, vec!["acid"; 4]);
    assert!(matches!(r, Err(CoreError::Refused { .. })), "wrong words: {r:?}");
    assert!(core.paired_computers().unwrap().is_empty());
    assert!(!storage.0.lock().unwrap().keys().any(|k| k.starts_with("pair-")));
    // Whether the engine withdrew that pairing's add card (an engine finding when it didn't; not the phone's to judge).
    tokio::time::sleep(Duration::from_millis(500)).await;
    eprintln!("[phone-core test] add cards pending after a wrong-words pairing: {}", engine.ok(json!({ "cmd": "addCards" })).await);

    // The computer's person denies the sealed card.
    let core = phone(Arc::new(MemStorage::default()));
    let (r, _) = pair(&mut engine, &core, None, false).await;
    assert!(matches!(r, Err(CoreError::Refused { .. })), "denied card: {r:?}");
    assert!(core.paired_computers().unwrap().is_empty());

    // The phone's person says the words differ: the computer's pairing fails and adds nothing.
    let core = phone(Arc::new(MemStorage::default()));
    let begun = engine.ok(json!({ "cmd": "begin" })).await;
    let pairing = core.clone().begin_pairing(begun["qr"].as_str().unwrap().into(), PhoneApp::Code).await.unwrap();
    pairing.reject().await;
    let confirmed = engine.ok(json!({ "cmd": "confirm", "pairingId": begun["pairingId"], "words": pairing.words(), "approve": true })).await;
    let devices = engine.ok(json!({ "cmd": "devices" })).await;
    assert!(!devices.to_string().contains(&core.identity().device_id), "after the phone's no, nothing is added ({confirmed})");

    // A QR that isn't one, and one with its secret changed: refused before or at the computer's door.
    assert!(matches!(core.clone().begin_pairing("clover-pair:1:AAAA".into(), PhoneApp::Moss).await, Err(CoreError::Invalid { .. })));
    let begun = engine.ok(json!({ "cmd": "begin" })).await;
    let qr = begun["qr"].as_str().unwrap();
    let body = bytes::from_b64url(&qr["clover-pair:1:".len()..]).unwrap();
    let mut v = moss_phone_core::cbor::decode(&body).unwrap();
    if let moss_phone_core::cbor::Cbor::Array(a) = &mut v {
        a[1] = moss_phone_core::cbor::Cbor::Bytes(vec![7u8; 32]);
    }
    let bad = format!("clover-pair:1:{}", bytes::b64url(&moss_phone_core::cbor::encode(&v)));
    assert!(matches!(core.clone().begin_pairing(bad, PhoneApp::Moss).await, Err(CoreError::Refused { .. })));
    engine.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unpaired_the_phone_pairs_the_same_computer_again_as_a_new_device() {
    if !enabled() {
        return;
    }
    let mut engine = Engine::start().await;
    let storage = Arc::new(MemStorage::default());
    let core = phone(storage.clone());
    let first = pair(&mut engine, &core, None, true).await.0.expect("the first pairing");
    let old = core.identity();
    engine.ok(json!({ "cmd": "waitDevice", "device": old.device_id })).await;
    let old_seeds: Vec<Vec<u8>> = ["device-key", "answer-key"].iter().map(|k| storage.0.lock().unwrap()[*k].clone()).collect();
    // Unpaired on the phone: nothing of that pairing stays, its identity included.
    core.forget_computer(first.id.clone()).unwrap();
    assert!(storage.0.lock().unwrap().iter().all(|(_, v)| !old_seeds.contains(v)), "an old seed is still in the store");
    // Pairing the same computer again succeeds, as a new device.
    let again = pair(&mut engine, &core, None, true).await.0.expect("the pairing after an unpair");
    assert_eq!(again.id, first.id);
    let new = core.identity();
    assert_ne!(new.device_id, old.device_id);
    engine.ok(json!({ "cmd": "waitDevice", "device": new.device_id })).await;
    // And the new pairing works: it connects and calls.
    let conn = core.clone().connect(again.id.clone(), ConnectOptions { client_name: "re-paired".into(), areas: vec![], call_timeout_ms: 30_000 }).await.unwrap();
    until_event(&conn, "up", |e| matches!(e, ConnEvent::Up)).await;
    conn.call("bot.list".into(), "{}".into()).await.expect("bot.list after re-pairing");
    conn.disconnect();
    engine.stop().await;
}
