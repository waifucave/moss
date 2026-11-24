//! The phone's link to one paired computer (spec §8.2, §10) and its client connection over it, the other half of the
//! engine's `links/transport.ts` and `links/remote-clients.ts`:
//! * One connection on `clover/link/1`. Messages travel on lanes, one stream per priority class per direction, each
//!   starting with the frame `["L"]`; the phone's first message is `["q", 0, "peer.hello", {...}]` on its control lane,
//!   and the computer answers on a lane it opens (`["r", 0, 1, {...}]`). Either side pings (`["p"]`) when it has sent
//!   nothing for 5 s, and drops a connection it has heard nothing on for 20 s.
//! * The client protocol is a stream of its own: the header frame `["S", "clover/rpc/1", "control", null]`, then one
//!   JSON-RPC message per frame each way. The first call is `protocol.hello` with role `remote`; the link proved the
//!   device, so the engine mints the role's token itself. What the phone may call and which events it gets is the
//!   engine's fixed list for `remote` (`allowlists.json`).
//! * The phone dials; the computer never dials a phone back. So the phone re-dials with backoff after a loss, at once
//!   on `network_changed`, and stops for good only when the computer says it revoked this phone.
//! * On every connect: the link's hello, then `protocol.hello`, `events.subscribe` and `card.list`, in that order, so a
//!   card raised during the connect is heard as an event and one already waiting comes in the list.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};

use iroh::endpoint::{Connection as QuicConn, RecvStream, SendStream, VarInt};
use serde_json::{json, Value};
use tokio::sync::{oneshot, watch, Mutex, Notify};

use crate::{
    bytes,
    cards,
    cbor::{decode, encode, Cbor},
    computers::PairedComputer,
    error::CoreError,
    identity::Identity,
    net::{self, Target, ALPN_LINK, CLOSE_PROTOCOL, CLOSE_REVOKED, CLOSE_SHUTDOWN, CLOSE_SUPERSEDED, CLOSE_UNPAIRED, MAX_FRAME, RESET_NOT_FOUND},
    pairing::now_ms,
};

pub const REMOTE_RPC_LABEL: &str = "clover/rpc/1";
const PROTOCOL_VERSION: u64 = 1;
const MOSS_PROTOCOL_VERSION: u64 = 1;
const DIAL_TIMEOUT: Duration = Duration::from_secs(5);
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const KEEPALIVE: Duration = Duration::from_secs(5);
const IDLE: Duration = Duration::from_secs(20);
/// The engine's redial backoff (`redialBackoffMs`).
const BACKOFF_MS: [u64; 7] = [0, 250, 1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_SEQ_JUMP: u64 = 1_000_000;
const MAX_EVENTS: usize = 4096;

#[derive(Clone, Debug, uniffi::Record)]
pub struct ConnectOptions {
    /// What the engine shows as this client's name.
    pub client_name: String,
    /// The event areas to subscribe to on every connect (`approvals`, `bots`, `sessions`, `devices`, ...).
    pub areas: Vec<String>,
    /// How long a call waits for its answer, in ms (0: no limit).
    pub call_timeout_ms: u64,
}

/// What the UI hears from a connection, in order.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum ConnEvent {
    /// Dialling (again); `attempt` counts from 0 since the link was last up.
    Connecting { attempt: u32 },
    /// The link and the client connection are up: hello'd and subscribed.
    Up,
    /// The cards pending when the connection came up (`card.list`'s `cards`, JSON).
    PendingCards { cards_json: String },
    /// A notification from the engine: `core.event` (params is the event) or a session's `event`.
    Notification { method: String, params_json: String },
    /// The link dropped; the core re-dials by itself.
    Down { reason: String },
    /// The computer doesn't know this phone (yet): it keeps trying, as just after a pairing.
    Unpaired,
    /// The computer revoked this phone: nothing is dialled again. Pair again.
    Revoked,
    /// Events were dropped because nobody read them.
    Lagged { dropped: u32 },
    /// `close` was called: the last event.
    Closed,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct CardView {
    /// The card as the engine sent it, JSON.
    pub card_json: String,
    /// Its hash, rebuilt here and matching the card's own.
    pub hash: String,
    /// Still waiting for an answer (no outcome yet).
    pub pending: bool,
    /// The outcome, once resolved (`approved`, `denied`, `expired`, ...).
    pub outcome: Option<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AnswerOutcome {
    pub accepted: bool,
    pub reason: Option<String>,
}

struct Events {
    q: StdMutex<(VecDeque<ConnEvent>, u32, bool)>,
    notify: Notify,
}

impl Events {
    fn push(&self, e: ConnEvent) {
        let mut g = self.q.lock().unwrap();
        if g.2 {
            return;
        }
        if g.0.len() >= MAX_EVENTS {
            g.0.pop_front();
            g.1 += 1;
        }
        if matches!(e, ConnEvent::Closed) {
            g.2 = true;
        }
        g.0.push_back(e);
        drop(g);
        self.notify.notify_one();
    }
    async fn next(&self) -> Option<ConnEvent> {
        loop {
            let notified = self.notify.notified();
            {
                let mut g = self.q.lock().unwrap();
                if g.1 > 0 {
                    let dropped = std::mem::take(&mut g.1);
                    return Some(ConnEvent::Lagged { dropped });
                }
                if let Some(e) = g.0.pop_front() {
                    return Some(e);
                }
                if g.2 {
                    return None;
                }
            }
            notified.await;
        }
    }
}

type Pending = StdMutex<HashMap<u64, oneshot::Sender<Result<Value, CoreError>>>>;

/// One live connection's link protocol and its client stream.
struct Session {
    conn: QuicConn,
    control: Mutex<SendStream>,
    /// The control lane's receive half, held so QUIC doesn't stop it (the computer answers on its own lanes).
    _control_recv: RecvStream,
    rpc: Mutex<SendStream>,
    pending: Pending,
    next_id: AtomicU64,
    started: Instant,
    last_in: AtomicU64,
    last_out: AtomicU64,
}

impl Session {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
    fn heard(&self) {
        self.last_in.store(self.now(), Ordering::Relaxed);
    }
    async fn lane_send(&self, m: &Cbor) -> Result<(), CoreError> {
        self.last_out.store(self.now(), Ordering::Relaxed);
        net::write_frame(&mut *self.control.lock().await, &encode(m)).await
    }
    async fn rpc_send(&self, v: &Value) -> Result<(), CoreError> {
        self.last_out.store(self.now(), Ordering::Relaxed);
        net::write_frame(&mut *self.rpc.lock().await, &serde_json::to_vec(v).expect("JSON")).await
    }
    fn fail_all(&self, why: &str) {
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(CoreError::offline(why.to_string())));
        }
    }
    async fn request(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, CoreError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.rpc_send(&msg).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        let answer = async { rx.await.unwrap_or_else(|_| Err(CoreError::offline("the link dropped"))) };
        match timeout {
            Some(t) => match tokio::time::timeout(t, answer).await {
                Ok(r) => r,
                Err(_) => {
                    self.pending.lock().unwrap().remove(&id);
                    Err(CoreError::Timeout { reason: format!("`{method}` got no answer in time") })
                }
            },
            None => answer.await,
        }
    }
}

struct Inner {
    computer: PairedComputer,
    target: Target,
    ep: iroh::Endpoint,
    identity: Arc<Identity>,
    options: ConnectOptions,
    session: watch::Sender<Option<Arc<Session>>>,
    events: Events,
    closed: AtomicBool,
    wake: Notify,
    last_seq: AtomicU64,
}

/// A paired computer's link and client connection, kept up by the core until `close`.
#[derive(uniffi::Object)]
pub struct Connection {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Connection({})", self.inner.computer.id)
    }
}

/// How a session ended.
enum End {
    Revoked,
    Unpaired,
    Shutdown,
    Lost(String),
}

pub fn start(ep: iroh::Endpoint, identity: Arc<Identity>, computer: PairedComputer, options: ConnectOptions) -> Result<Arc<Connection>, CoreError> {
    let key: [u8; 32] = bytes::from_b64(&computer.public_key).and_then(|k| k.try_into().ok()).ok_or_else(|| CoreError::storage("the computer's key isn't 32 bytes"))?;
    let inner = Arc::new(Inner {
        target: Target { key, relay: computer.relay.clone(), addrs: computer.addrs.clone() },
        computer,
        ep,
        identity,
        options,
        session: watch::channel(None).0,
        events: Events { q: StdMutex::new((VecDeque::new(), 0, false)), notify: Notify::new() },
        closed: AtomicBool::new(false),
        wake: Notify::new(),
        last_seq: AtomicU64::new(0),
    });
    let me = inner.clone();
    crate::runtime::handle().spawn(async move { me.run().await });
    Ok(Arc::new(Connection { inner }))
}

impl Inner {
    async fn run(self: Arc<Self>) {
        let mut attempt: u32 = 0;
        loop {
            if self.closed.load(Ordering::Acquire) {
                break;
            }
            self.events.push(ConnEvent::Connecting { attempt });
            let began = Instant::now();
            let end = self.clone().session_once().await;
            let _ = self.session.send(None);
            match end {
                End::Revoked => {
                    self.events.push(ConnEvent::Revoked);
                    break;
                }
                End::Shutdown => break,
                End::Unpaired => self.events.push(ConnEvent::Unpaired),
                End::Lost(why) => self.events.push(ConnEvent::Down { reason: why }),
            }
            // A link that was up a while starts its backoff again.
            if began.elapsed() > IDLE {
                attempt = 0;
            }
            let ms = BACKOFF_MS[(attempt as usize).min(BACKOFF_MS.len() - 1)];
            attempt = attempt.saturating_add(1);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                _ = self.wake.notified() => { attempt = 0; }
            }
        }
        self.events.push(ConnEvent::Closed);
    }

    fn end_of(&self, conn: &QuicConn, fallback: String) -> End {
        if self.closed.load(Ordering::Acquire) {
            return End::Shutdown;
        }
        match conn.close_reason().map(|c| net::close_of(&c)) {
            Some((CLOSE_REVOKED, _)) => End::Revoked,
            Some((CLOSE_UNPAIRED, _)) => End::Unpaired,
            Some((code, reason)) => End::Lost(format!("closed ({code}): {}", reason.chars().take(200).collect::<String>())),
            None => End::Lost(fallback),
        }
    }

    async fn session_once(self: Arc<Self>) -> End {
        let conn = match net::dial(&self.ep, &self.target, ALPN_LINK, DIAL_TIMEOUT).await {
            Ok(c) => c,
            Err(e) => return End::Lost(e.to_string()),
        };
        match self.clone().hello(&conn).await {
            Ok(s) => self.serve(s).await,
            Err(e) => {
                // The computer's door closes an unknown or revoked key at once: that close is the answer.
                let _ = tokio::time::timeout(Duration::from_millis(500), conn.closed()).await;
                let end = self.end_of(&conn, e.to_string());
                conn.close(VarInt::from_u32(CLOSE_PROTOCOL), b"hello failed");
                end
            }
        }
    }

    /// The link's hello, the client stream and its hello, the subscription and the pending cards.
    async fn hello(self: Arc<Self>, conn: &QuicConn) -> Result<Arc<Session>, CoreError> {
        let (control, control_recv) = conn.open_bi().await.map_err(|e| CoreError::offline(format!("no lane: {e}")))?;
        let _ = control.set_priority(3);
        let (rpc, rpc_recv) = conn.open_bi().await.map_err(|e| CoreError::offline(format!("no client stream: {e}")))?;
        let _ = rpc.set_priority(3);
        let s = Arc::new(Session {
            conn: conn.clone(),
            control: Mutex::new(control),
            _control_recv: control_recv,
            rpc: Mutex::new(rpc),
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            started: Instant::now(),
            last_in: AtomicU64::new(0),
            last_out: AtomicU64::new(0),
        });
        let (hello_tx, hello_rx) = oneshot::channel::<Cbor>();
        let hello_tx = Arc::new(StdMutex::new(Some(hello_tx)));
        // The computer's streams: its lanes (its answers and requests), and any stream it opens (refused: a phone
        // serves no streams).
        {
            let s = s.clone();
            let me = self.clone();
            tokio::spawn(async move {
                while let Ok((send, recv)) = s.conn.accept_bi().await {
                    tokio::spawn(me.clone().incoming(s.clone(), send, recv, hello_tx.clone()));
                }
            });
        }
        let proposed = self.last_seq.load(Ordering::Acquire) + 1;
        s.lane_send(&Cbor::Array(vec![Cbor::text("L")])).await?;
        let hello = Cbor::map(vec![
            ("protocolVersion", Cbor::Uint(PROTOCOL_VERSION)),
            ("device", Cbor::text(&self.identity.id)),
            ("epoch", Cbor::Uint(0)),
            ("features", Cbor::Array(vec![])),
            ("connSeq", Cbor::Uint(proposed)),
        ]);
        s.lane_send(&Cbor::Array(vec![Cbor::text("q"), Cbor::Uint(0), Cbor::text("peer.hello"), hello])).await?;
        let answer = tokio::time::timeout(HELLO_TIMEOUT, hello_rx).await.map_err(|_| CoreError::Timeout { reason: "no hello answer".into() })?.map_err(|_| CoreError::offline("the link dropped in its hello"))?;
        let a = answer.as_array().unwrap_or(&[]);
        let ok = a.get(2).and_then(Cbor::as_f64) == Some(1.0);
        let v = a.get(3).cloned().unwrap_or(Cbor::Null);
        let seq = v.get("connSeq").and_then(Cbor::as_f64);
        let version = v.get("protocolVersion").and_then(Cbor::as_f64);
        let seq_ok = seq.is_some_and(|q| q.fract() == 0.0 && q >= 0.0 && q <= (proposed - 1 + MAX_SEQ_JUMP) as f64);
        if !ok || v.get("device").and_then(Cbor::as_str) != Some(self.computer.id.as_str()) || !seq_ok || !version.is_some_and(|x| x.fract() == 0.0 && x >= 1.0) {
            conn.close(VarInt::from_u32(CLOSE_PROTOCOL), b"a bad hello answer");
            return Err(CoreError::protocol("a bad hello answer"));
        }
        self.last_seq.fetch_max(seq.unwrap() as u64, Ordering::AcqRel);
        // The client stream: its header, then JSON-RPC.
        s.rpc_send_header().await?;
        tokio::spawn(self.clone().rpc_reader(s.clone(), rpc_recv));
        tokio::spawn(keepalive(s.clone()));
        let timeout = Some(Duration::from_secs(30));
        s.request(
            "protocol.hello",
            json!({ "protocolVersion": MOSS_PROTOCOL_VERSION, "role": "remote", "clientName": self.options.client_name, "features": [] }),
            timeout,
        )
        .await?;
        if !self.options.areas.is_empty() {
            s.request("events.subscribe", json!({ "areas": self.options.areas }), timeout).await?;
        }
        if self.options.areas.iter().any(|a| a == "approvals") {
            let cards = s.request("card.list", json!({}), timeout).await?;
            self.events.push(ConnEvent::PendingCards { cards_json: cards.get("cards").cloned().unwrap_or(json!([])).to_string() });
        }
        Ok(s)
    }

    async fn serve(self: Arc<Self>, s: Arc<Session>) -> End {
        let _ = self.session.send(Some(s.clone()));
        self.events.push(ConnEvent::Up);
        let why = s.conn.closed().await;
        s.fail_all("the link dropped");
        let (code, reason) = net::close_of(&why);
        self.end_of(&s.conn, format!("closed ({code}): {}", reason.chars().take(200).collect::<String>()))
    }

    /// One stream the computer opened: a lane (its answers, requests, notifications and pings), or a stream it wants
    /// this phone to serve, which is refused.
    async fn incoming(self: Arc<Self>, s: Arc<Session>, mut send: SendStream, mut recv: RecvStream, hello: Arc<StdMutex<Option<oneshot::Sender<Cbor>>>>) {
        let protocol = |s: &Session, why: &'static str| s.conn.close(VarInt::from_u32(CLOSE_PROTOCOL), why.as_bytes());
        let first = match net::read_frame(&mut recv, MAX_FRAME).await {
            Ok(Some(f)) => f,
            _ => return,
        };
        s.heard();
        match decode(&first).ok().as_ref().and_then(Cbor::as_array).and_then(|a| a.first()).and_then(Cbor::as_str) {
            Some("L") => {}
            Some("S") => {
                let _ = send.reset(VarInt::from_u32(RESET_NOT_FOUND));
                let _ = recv.stop(VarInt::from_u32(RESET_NOT_FOUND));
                return;
            }
            _ => return protocol(&s, "a stream of an unknown kind"),
        }
        loop {
            let f = match net::read_frame(&mut recv, MAX_FRAME).await {
                Ok(Some(f)) => f,
                Ok(None) | Err(_) => return,
            };
            s.heard();
            let Ok(Cbor::Array(m)) = decode(&f) else { return protocol(&s, "a malformed message") };
            match m.first().and_then(Cbor::as_str) {
                Some("p") | Some("n") => {}
                Some("r") => {
                    if m.get(1).and_then(Cbor::as_f64) == Some(0.0) {
                        if let Some(tx) = hello.lock().unwrap().take() {
                            let _ = tx.send(Cbor::Array(m));
                        }
                    }
                }
                Some("q") => {
                    // A phone serves no link methods; the answer goes back on this side's control lane.
                    let Some(id) = m.get(1).cloned() else { return protocol(&s, "a malformed request") };
                    let err = Cbor::map(vec![("code", Cbor::text("not_found")), ("message", Cbor::text("a phone serves no link methods"))]);
                    let _ = s.lane_send(&Cbor::Array(vec![Cbor::text("r"), id, Cbor::Uint(0), err])).await;
                }
                _ => return protocol(&s, "an unknown message"),
            }
        }
    }

    async fn rpc_reader(self: Arc<Self>, s: Arc<Session>, mut recv: RecvStream) {
        loop {
            let f = match net::read_frame(&mut recv, MAX_FRAME).await {
                Ok(Some(f)) => f,
                _ => break,
            };
            s.heard();
            let Ok(msg) = serde_json::from_slice::<Value>(&f) else { continue };
            let method = msg.get("method").and_then(Value::as_str);
            let id = msg.get("id").and_then(Value::as_u64);
            match (method, id) {
                (None, Some(id)) => {
                    let Some(tx) = s.pending.lock().unwrap().remove(&id) else { continue };
                    let r = match msg.get("error") {
                        Some(e) => Err(CoreError::Rpc {
                            code: e.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                            text: e.get("message").and_then(Value::as_str).unwrap_or("failed").chars().take(500).collect(),
                            data_json: e.get("data").map(Value::to_string),
                        }),
                        None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(r);
                }
                (Some(m), None) => self.events.push(ConnEvent::Notification {
                    method: m.into(),
                    params_json: msg.get("params").cloned().unwrap_or(Value::Null).to_string(),
                }),
                (Some(_), Some(_)) => {
                    // The daemon sends a `remote` client no requests of its own; answered so it isn't left waiting.
                    let reply = json!({ "jsonrpc": "2.0", "id": msg["id"], "error": { "code": -32601, "message": "not handled by this phone" } });
                    let _ = s.rpc_send(&reply).await;
                }
                (None, None) => {}
            }
        }
        // The client stream ended: the engine closed this client connection, so the link goes too and is re-dialled.
        s.conn.close(VarInt::from_u32(CLOSE_SUPERSEDED), b"the client stream ended");
    }

    async fn session(&self, wait: Duration) -> Result<Arc<Session>, CoreError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(CoreError::Closed { reason: "the connection was closed".into() });
        }
        let mut rx = self.session.subscribe();
        let got = tokio::time::timeout(wait, rx.wait_for(|s| s.is_some())).await;
        match got {
            Ok(Ok(s)) => Ok(s.clone().unwrap()),
            _ => Err(CoreError::offline(format!("{} can't be reached", self.computer.name))),
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, CoreError> {
        let s = self.session(DIAL_TIMEOUT + HELLO_TIMEOUT).await?;
        let t = self.options.call_timeout_ms;
        s.request(method, params, (t > 0).then(|| Duration::from_millis(t))).await
    }

    async fn fetch_card(&self, id: &str) -> Result<CardView, CoreError> {
        let r = self.call("card.get", json!({ "id": id })).await?;
        let card = r.get("card").cloned().ok_or_else(|| CoreError::protocol("card.get answered no card"))?;
        let hash = cards::verify_card(&card)?;
        let outcome = r.get("outcome").and_then(Value::as_str).map(str::to_string);
        Ok(CardView { card_json: card.to_string(), hash, pending: outcome.is_none(), outcome })
    }

    /// Checks the card it was given (its hash, the option, the children) and signs and sends the answer.
    async fn answer(&self, card: &Value, option: &str, children: Vec<String>) -> Result<AnswerOutcome, CoreError> {
        let hash = cards::verify_card(card)?;
        let id = card.get("id").and_then(Value::as_str).ok_or_else(|| CoreError::TamperedCard { reason: "the card has no id".into() })?;
        let has_option = card.get("options").and_then(Value::as_array).is_some_and(|o| o.iter().any(|x| x.get("id").and_then(Value::as_str) == Some(option)));
        if !has_option {
            return Err(CoreError::refused("the card has no such option"));
        }
        let known: Vec<&str> = card.get("children").and_then(Value::as_array).map(|c| c.iter().filter_map(|x| x.get("id").and_then(Value::as_str)).collect()).unwrap_or_default();
        if children.iter().any(|c| !known.contains(&c.as_str())) {
            return Err(CoreError::refused("the card has no such checkbox"));
        }
        let at = now_ms() as i64;
        let input = cards::card_answer_signing_input(id, &hash, option, at, &children);
        let signature = bytes::b64(&self.identity.answer.sign(input.as_bytes()));
        let mut params = json!({
            "id": id, "hash": hash, "option": option,
            "proof": { "via": "device", "device": self.identity.id, "at": at, "signature": signature },
        });
        if !children.is_empty() {
            params["children"] = json!(children);
        }
        let r = self.call("card.answer", params).await?;
        Ok(AnswerOutcome {
            accepted: r.get("accepted").and_then(Value::as_bool).unwrap_or(false),
            reason: r.get("reason").and_then(Value::as_str).map(|s| s.chars().take(500).collect()),
        })
    }

    fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(s) = self.session.borrow().clone() {
            s.conn.close(VarInt::from_u32(CLOSE_SHUTDOWN), b"the phone closed the link");
        }
        self.wake.notify_one();
    }
}

impl Session {
    async fn rpc_send_header(&self) -> Result<(), CoreError> {
        let header = Cbor::Array(vec![Cbor::text("S"), Cbor::text(REMOTE_RPC_LABEL), Cbor::text("control"), Cbor::Null]);
        net::write_frame(&mut *self.rpc.lock().await, &encode(&header)).await
    }
}

async fn keepalive(s: Arc<Session>) {
    let mut tick = tokio::time::interval(Duration::from_millis(1_000));
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = s.conn.closed() => return,
        }
        let now = s.now();
        if now.saturating_sub(s.last_in.load(Ordering::Relaxed)) > IDLE.as_millis() as u64 {
            s.conn.close(VarInt::from_u32(CLOSE_SUPERSEDED), b"nothing heard from the peer");
            return;
        }
        if now.saturating_sub(s.last_out.load(Ordering::Relaxed)) >= KEEPALIVE.as_millis() as u64 {
            let _ = s.lane_send(&Cbor::Array(vec![Cbor::text("p")])).await;
        }
    }
}

#[uniffi::export]
impl Connection {
    pub fn computer(&self) -> PairedComputer {
        self.inner.computer.clone()
    }

    /// Calls a method the engine lets a `remote` client call; `params_json` and the answer are JSON.
    pub async fn call(&self, method: String, params_json: String) -> Result<String, CoreError> {
        let params: Value = serde_json::from_str(&params_json).map_err(|_| CoreError::invalid("params aren't JSON"))?;
        let inner = self.inner.clone();
        crate::runtime::spawn(async move { inner.call(&method, params).await.map(|v| v.to_string()) }).await
    }

    /// The next event, waiting for one; None once the connection is closed and every event was read.
    pub async fn next_event(&self) -> Option<ConnEvent> {
        let inner = self.inner.clone();
        crate::runtime::spawn(async move { inner.events.next().await }).await
    }

    /// Fetches a card and checks its hash against what it says (`TamperedCard` when they differ).
    pub async fn fetch_card(&self, id: String) -> Result<CardView, CoreError> {
        let inner = self.inner.clone();
        crate::runtime::spawn(async move { inner.fetch_card(&id).await }).await
    }

    /// Fetches the card, checks it, and answers it with this phone's answer key.
    pub async fn answer_card(&self, id: String, option: String, children: Vec<String>) -> Result<AnswerOutcome, CoreError> {
        let inner = self.inner.clone();
        crate::runtime::spawn(async move {
            let view = inner.fetch_card(&id).await?;
            if !view.pending {
                return Err(CoreError::refused("the card was already answered"));
            }
            let card: Value = serde_json::from_str(&view.card_json).expect("JSON");
            inner.answer(&card, &option, children).await
        })
        .await
    }

    /// Answers a card the app already holds (from `card_requested` or `PendingCards`): checked here first, exactly as
    /// `answer_card` checks a fetched one.
    pub async fn answer_card_json(&self, card_json: String, option: String, children: Vec<String>) -> Result<AnswerOutcome, CoreError> {
        let card: Value = serde_json::from_str(&card_json).map_err(|_| CoreError::TamperedCard { reason: "the card isn't JSON".into() })?;
        let inner = self.inner.clone();
        crate::runtime::spawn(async move { inner.answer(&card, &option, children).await }).await
    }

    /// The OS reported a network change or a wake: re-dial now instead of waiting out the backoff.
    pub fn network_changed(&self) {
        if let Some(s) = self.inner.session.borrow().clone() {
            if s.now().saturating_sub(s.last_in.load(Ordering::Relaxed)) > 2 * KEEPALIVE.as_millis() as u64 {
                s.conn.close(VarInt::from_u32(CLOSE_SUPERSEDED), b"stale after a network change");
            }
        }
        self.inner.wake.notify_one();
    }

    /// Ends the link for good; `next_event` then ends with `Closed`.
    pub fn disconnect(&self) {
        self.inner.close();
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.inner.close();
    }
}
