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
//!
//! What the computer sends is bounded and never trusted: a lane frame is at most `LANE_FRAME_MAX` and its CBOR within
//! `cbor::LANE_LIMITS`; a client frame at most `RPC_FRAME_MAX`; queued events at most `MAX_EVENTS` and
//! `MAX_EVENT_BYTES`. Anything malformed closes that connection with a reason in the core's own words (never the
//! computer's text), and the core dials again. A card is signed only as the app displayed it (`answer_card`).

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

pub use crate::cards::CardView;
use crate::{
    bytes, cards,
    cbor::{decode_with, encode, Cbor, LANE_LIMITS},
    computers::PairedComputer,
    error::CoreError,
    identity::Identity,
    net::{self, Target, ALPN_LINK, CLOSE_PROTOCOL, CLOSE_REVOKED, CLOSE_SHUTDOWN, CLOSE_SUPERSEDED, CLOSE_UNPAIRED, RESET_NOT_FOUND},
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
/// A lane carries the link's own small messages (hellos, pings, the computer's link requests): 1 MiB is far above any.
pub const LANE_FRAME_MAX: usize = 1024 * 1024;
/// One JSON-RPC message from the engine (a history page, a card list): 4 MiB. Larger answers are refused.
pub const RPC_FRAME_MAX: usize = 4 * 1024 * 1024;
/// Events queued and not yet read: at most this many, and this many bytes of their JSON; the oldest go first.
const MAX_EVENTS: usize = 4096;
const MAX_EVENT_BYTES: usize = 32 * 1024 * 1024;

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
    /// The cards pending when the connection came up (`card.list`), each checked for display.
    PendingCards { cards: Vec<CardView> },
    /// A card raised now (`card_requested`), checked for display.
    CardRequested { card: CardView },
    /// A card the computer sent whose hash doesn't match what it says, or that isn't a card: not shown, never signed.
    TamperedCard { id: Option<String> },
    /// Any other notification from the engine: `core.event` (params is the event) or a session's `event`.
    Notification { method: String, params_json: String },
    /// The link dropped (`reason` in the core's own words); the core re-dials by itself.
    Down { reason: String },
    /// The computer doesn't know this phone (yet): it keeps trying, as just after a pairing.
    Unpaired,
    /// The computer revoked this phone: nothing is dialled again. Pair again.
    Revoked,
    /// Events were dropped because nobody read them.
    Lagged { dropped: u32 },
    /// `disconnect` was called: the last event.
    Closed,
}

impl ConnEvent {
    fn weight(&self) -> usize {
        match self {
            ConnEvent::Notification { params_json, .. } => params_json.len(),
            ConnEvent::CardRequested { card } => card.card_json.len(),
            ConnEvent::PendingCards { cards } => cards.iter().map(|c| c.card_json.len()).sum(),
            _ => 0,
        }
    }
}

/// The link's state now, for a screen that asks rather than listens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum LinkState {
    Connecting,
    Up,
    /// Lost; the core is dialling again with backoff.
    Down,
    /// The computer doesn't know this phone (yet).
    Unpaired,
    /// The computer revoked this phone: pair again.
    Revoked,
    Closed,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AnswerOutcome {
    pub accepted: bool,
    /// The engine's reason when it didn't take the answer (`already-answered`, `bad-time`, ...).
    pub reason: Option<String>,
}

struct Queue {
    q: VecDeque<ConnEvent>,
    bytes: usize,
    dropped: u32,
    closed: bool,
}

struct Events {
    q: StdMutex<Queue>,
    notify: Notify,
}

impl Events {
    fn push(&self, e: ConnEvent) {
        let mut g = self.q.lock().unwrap();
        if g.closed {
            return;
        }
        let w = e.weight();
        while !g.q.is_empty() && (g.q.len() >= MAX_EVENTS || g.bytes + w > MAX_EVENT_BYTES) {
            let old = g.q.pop_front().unwrap();
            g.bytes -= old.weight();
            g.dropped += 1;
        }
        if matches!(e, ConnEvent::Closed) {
            g.closed = true;
        }
        g.bytes += w;
        g.q.push_back(e);
        drop(g);
        self.notify.notify_one();
    }

    /// The next event. An event is taken off the queue only in the same step that returns it, so a call the app
    /// abandons (a cancelled task) never loses one.
    async fn next(&self) -> Option<ConnEvent> {
        loop {
            let notified = self.notify.notified();
            {
                let mut g = self.q.lock().unwrap();
                if g.dropped > 0 {
                    let dropped = std::mem::take(&mut g.dropped);
                    return Some(ConnEvent::Lagged { dropped });
                }
                if let Some(e) = g.q.pop_front() {
                    g.bytes -= e.weight();
                    return Some(e);
                }
                if g.closed {
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
    /// Why this side closed it, in the core's own words, for `Down`.
    failure: StdMutex<Option<&'static str>>,
}

impl Session {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
    fn heard(&self) {
        self.last_in.store(self.now(), Ordering::Relaxed);
    }
    /// Closes the connection because of what the computer sent; the reason is shown as `Down`'s.
    fn fail(&self, why: &'static str) {
        self.failure.lock().unwrap().get_or_insert(why);
        self.conn.close(VarInt::from_u32(CLOSE_PROTOCOL), why.as_bytes());
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
    async fn rpc_send_header(&self) -> Result<(), CoreError> {
        let header = Cbor::Array(vec![Cbor::text("S"), Cbor::text(REMOTE_RPC_LABEL), Cbor::text("control"), Cbor::Null]);
        net::write_frame(&mut *self.rpc.lock().await, &encode(&header)).await
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
    state: StdMutex<LinkState>,
}

/// A paired computer's link and client connection, kept up by the core until `disconnect`.
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
        events: Events { q: StdMutex::new(Queue { q: VecDeque::new(), bytes: 0, dropped: 0, closed: false }), notify: Notify::new() },
        closed: AtomicBool::new(false),
        wake: Notify::new(),
        last_seq: AtomicU64::new(0),
        state: StdMutex::new(LinkState::Connecting),
    });
    let me = inner.clone();
    crate::runtime::handle().spawn(async move { me.run().await });
    Ok(Arc::new(Connection { inner }))
}

/// A close code in the core's own words (the computer's reason text is never shown).
fn close_words(code: u32) -> &'static str {
    match code {
        0 => "the computer closed the link",
        1 => "the computer replaced the link with a newer one",
        4 => "the computer saw a protocol error",
        6 => "the computer is shutting down",
        _ => "the link was lost",
    }
}

impl Inner {
    /// An event for the UI, and the state it implies.
    fn emit(&self, e: ConnEvent) {
        let s = match &e {
            ConnEvent::Connecting { .. } => Some(LinkState::Connecting),
            ConnEvent::Up => Some(LinkState::Up),
            ConnEvent::Down { .. } => Some(LinkState::Down),
            ConnEvent::Unpaired => Some(LinkState::Unpaired),
            ConnEvent::Revoked => Some(LinkState::Revoked),
            ConnEvent::Closed => Some(LinkState::Closed),
            _ => None,
        };
        if let Some(s) = s {
            let mut g = self.state.lock().unwrap();
            // Revoked and Closed are final: a revoked link stays Revoked when it closes after it.
            if !matches!(*g, LinkState::Revoked | LinkState::Closed) {
                *g = s;
            }
        }
        self.events.push(e);
    }

    async fn run(self: Arc<Self>) {
        let mut attempt: u32 = 0;
        loop {
            if self.closed.load(Ordering::Acquire) {
                break;
            }
            self.emit(ConnEvent::Connecting { attempt });
            let began = Instant::now();
            let end = self.clone().session_once().await;
            let _ = self.session.send_replace(None);
            match end {
                End::Revoked => {
                    self.emit(ConnEvent::Revoked);
                    break;
                }
                End::Shutdown => break,
                End::Unpaired => self.emit(ConnEvent::Unpaired),
                End::Lost(why) => self.emit(ConnEvent::Down { reason: why }),
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
        self.emit(ConnEvent::Closed);
    }

    fn end_of(&self, conn: &QuicConn, failure: Option<&'static str>, fallback: String) -> End {
        if self.closed.load(Ordering::Acquire) {
            return End::Shutdown;
        }
        if let Some(why) = failure {
            return End::Lost(why.to_string());
        }
        match conn.close_reason().map(|c| net::close_of(&c).0) {
            Some(CLOSE_REVOKED) => End::Revoked,
            Some(CLOSE_UNPAIRED) => End::Unpaired,
            Some(code) => End::Lost(close_words(code).to_string()),
            None => End::Lost(fallback),
        }
    }

    async fn session_once(self: Arc<Self>) -> End {
        let conn = match net::dial(&self.ep, &self.target, ALPN_LINK, DIAL_TIMEOUT).await {
            Ok(c) => c,
            Err(_) => return End::Lost("the computer can't be reached".into()),
        };
        let failure: Arc<StdMutex<Option<&'static str>>> = Arc::default();
        match self.clone().hello(&conn, failure.clone()).await {
            Ok(s) => self.serve(s).await,
            Err(e) => {
                // The computer's door closes an unknown or revoked key at once: that close is the answer.
                let _ = tokio::time::timeout(Duration::from_millis(500), conn.closed()).await;
                let why = *failure.lock().unwrap();
                let end = self.end_of(&conn, why, match e {
                    CoreError::Timeout { .. } => "the computer didn't answer the link's hello".into(),
                    _ => "the link's hello failed".into(),
                });
                conn.close(VarInt::from_u32(CLOSE_PROTOCOL), b"hello failed");
                end
            }
        }
    }

    /// The link's hello, the client stream and its hello, the subscription and the pending cards.
    async fn hello(self: Arc<Self>, conn: &QuicConn, failure: Arc<StdMutex<Option<&'static str>>>) -> Result<Arc<Session>, CoreError> {
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
            failure: StdMutex::new(None),
        });
        // A failure seen before the session is handed out is reported through this too.
        let report = {
            let s = s.clone();
            move || *s.failure.lock().unwrap()
        };
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
        let result: Result<(), CoreError> = async {
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
                s.fail("the computer's link hello isn't one");
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
                let r = s.request("card.list", json!({}), timeout).await?;
                let mut shown = vec![];
                for c in r.get("cards").and_then(Value::as_array).cloned().unwrap_or_default() {
                    match cards::view(&c, None) {
                        Ok(v) => shown.push(v),
                        Err(_) => self.emit(ConnEvent::TamperedCard { id: c.get("id").and_then(Value::as_str).map(|s| s.chars().take(80).collect()) }),
                    }
                }
                self.emit(ConnEvent::PendingCards { cards: shown });
            }
            Ok(())
        }
        .await;
        if let Some(why) = report() {
            *failure.lock().unwrap() = Some(why);
        }
        result.map(|_| s)
    }

    async fn serve(self: Arc<Self>, s: Arc<Session>) -> End {
        let _ = self.session.send_replace(Some(s.clone()));
        self.emit(ConnEvent::Up);
        let why = s.conn.closed().await;
        s.fail_all("the link dropped");
        let failure = *s.failure.lock().unwrap();
        self.end_of(&s.conn, failure, close_words(net::close_of(&why).0).to_string())
    }

    /// One stream the computer opened: a lane (its answers, requests, notifications and pings), or a stream it wants
    /// this phone to serve, which is refused.
    async fn incoming(self: Arc<Self>, s: Arc<Session>, mut send: SendStream, mut recv: RecvStream, hello: Arc<StdMutex<Option<oneshot::Sender<Cbor>>>>) {
        let first = match net::read_frame(&mut recv, LANE_FRAME_MAX).await {
            Ok(Some(f)) => f,
            Ok(None) => return,
            Err(_) => return s.fail("the computer sent a frame larger than a lane takes"),
        };
        s.heard();
        match decode_with(&first, LANE_LIMITS).ok().as_ref().and_then(Cbor::as_array).and_then(|a| a.first()).and_then(Cbor::as_str) {
            Some("L") => {}
            Some("S") => {
                let _ = send.reset(VarInt::from_u32(RESET_NOT_FOUND));
                let _ = recv.stop(VarInt::from_u32(RESET_NOT_FOUND));
                return;
            }
            _ => return s.fail("the computer opened a stream of an unknown kind"),
        }
        loop {
            let f = match net::read_frame(&mut recv, LANE_FRAME_MAX).await {
                Ok(Some(f)) => f,
                Ok(None) => return,
                Err(CoreError::Protocol { .. }) => return s.fail("the computer sent a frame larger than a lane takes"),
                Err(_) => return,
            };
            s.heard();
            let Ok(Cbor::Array(m)) = decode_with(&f, LANE_LIMITS) else { return s.fail("the computer sent a link message that isn't one (or one too large)") };
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
                    let Some(id) = m.get(1).cloned().filter(|i| i.as_f64().is_some()) else { return s.fail("the computer sent a malformed link request") };
                    let err = Cbor::map(vec![("code", Cbor::text("not_found")), ("message", Cbor::text("a phone serves no link methods"))]);
                    let _ = s.lane_send(&Cbor::Array(vec![Cbor::text("r"), id, Cbor::Uint(0), err])).await;
                }
                _ => return s.fail("the computer sent an unknown link message"),
            }
        }
    }

    async fn rpc_reader(self: Arc<Self>, s: Arc<Session>, mut recv: RecvStream) {
        loop {
            let f = match net::read_frame(&mut recv, RPC_FRAME_MAX).await {
                Ok(Some(f)) => f,
                Ok(None) => break,
                Err(CoreError::Protocol { .. }) => return s.fail("the computer sent a message larger than the phone takes (4 MiB)"),
                Err(_) => break,
            };
            s.heard();
            // A message that can't be read ends the connection with a reason the app can show: never a silent drop.
            let Ok(msg) = crate::json::parse(&f) else { return s.fail("the computer sent a message that isn't JSON") };
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
                (Some(m), None) => self.notification(m, msg.get("params").cloned().unwrap_or(Value::Null)),
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

    /// A card raised now arrives checked for display; every other notification as it came.
    fn notification(&self, method: &str, params: Value) {
        if method == "core.event" && params.get("type").and_then(Value::as_str) == Some("card_requested") {
            let card = params.get("card").cloned().unwrap_or(Value::Null);
            match cards::view(&card, None) {
                Ok(v) => self.emit(ConnEvent::CardRequested { card: v }),
                Err(_) => self.emit(ConnEvent::TamperedCard { id: card.get("id").and_then(Value::as_str).map(|s| s.chars().take(80).collect()) }),
            }
            return;
        }
        self.emit(ConnEvent::Notification { method: method.into(), params_json: params.to_string() });
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

    /// A card for display, by its id: the engine's answer must be that card (the same id), with a hash that matches it.
    async fn fetch_card(&self, id: &str) -> Result<CardView, CoreError> {
        let r = self.call("card.get", json!({ "id": id })).await?;
        let card = r.get("card").cloned().ok_or_else(|| CoreError::protocol("card.get answered no card"))?;
        let outcome = r.get("outcome").and_then(Value::as_str).map(|s| s.chars().take(32).collect());
        let view = cards::view(&card, outcome)?;
        if view.id != id {
            return Err(CoreError::TamperedCard { reason: "the computer answered with another card than the one asked for".into() });
        }
        Ok(view)
    }

    /// Signs and sends the person's answer to the card exactly as the app displayed it: the hash is recomputed from
    /// the content the app holds, the id is that content's, and nothing is fetched between the tap and the signature.
    async fn answer(&self, shown: &CardView, option: &str, children: Vec<String>) -> Result<AnswerOutcome, CoreError> {
        let card: Value = serde_json::from_str(&shown.card_json).map_err(|_| CoreError::TamperedCard { reason: "the card isn't JSON".into() })?;
        let view = cards::view(&card, None)?;
        if view.id != shown.id || view.hash != shown.hash {
            return Err(CoreError::TamperedCard { reason: "the card answered isn't the one displayed".into() });
        }
        if !cards::is_option_id(option) || !view.options.iter().any(|o| o == option) {
            return Err(CoreError::refused("the card has no such option"));
        }
        let known: Vec<&str> = card.get("children").and_then(Value::as_array).map(|c| c.iter().filter_map(|x| x.get("id").and_then(Value::as_str)).collect()).unwrap_or_default();
        if children.iter().any(|c| !cards::is_checkbox_id(c) || !known.contains(&c.as_str())) {
            return Err(CoreError::refused("the card has no such checkbox"));
        }
        let at = now_ms() as i64;
        let input = cards::card_answer_signing_input(&view.id, &view.hash, option, at, &children);
        let signature = bytes::b64(&self.identity.answer.sign(input.as_bytes()));
        let mut params = json!({
            "id": view.id, "hash": view.hash, "option": option,
            "proof": { "via": "device", "device": self.identity.id, "at": at, "signature": signature },
        });
        if !children.is_empty() {
            params["children"] = json!(children);
        }
        let r = self.call("card.answer", params).await?;
        Ok(AnswerOutcome {
            accepted: r.get("accepted").and_then(Value::as_bool).unwrap_or(false),
            reason: r.get("reason").and_then(Value::as_str).map(|s| s.chars().take(200).collect()),
        })
    }

    /// The person's message to a session: stamped with this phone's clock and signed with its answer key, as the
    /// desktop app signs (`AnswerKey.signUserMessage`), so a computer that relays it can show the turn is the user's.
    async fn send_message(&self, session: &str, text: &str, client_message_id: &str, images: &[String], files: &[String]) -> Result<u64, CoreError> {
        let sent_at = now_ms() as i64;
        let hash = cards::user_message_hash(text, images, files);
        let input = cards::user_message_signing_input(session, client_message_id, &hash, sent_at);
        let signature = bytes::b64(&self.identity.answer.sign(input.as_bytes()));
        let r = self
            .call("session.send", json!({ "id": session, "message": {
                "text": text, "clientMessageId": client_message_id, "sentAt": sent_at, "signature": signature,
                "images": cards::numbered(images), "files": cards::numbered(files),
            } }))
            .await?;
        r.get("seq").and_then(Value::as_u64).ok_or_else(|| CoreError::protocol("session.send answered no seq"))
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

async fn keepalive(s: Arc<Session>) {
    let mut tick = tokio::time::interval(Duration::from_millis(1_000));
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = s.conn.closed() => return,
        }
        let now = s.now();
        if now.saturating_sub(s.last_in.load(Ordering::Relaxed)) > IDLE.as_millis() as u64 {
            s.failure.lock().unwrap().get_or_insert("nothing heard from the computer for 20 s");
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

    /// The next event, waiting for one; None once the connection is closed and every event was read. Safe to
    /// abandon: an event leaves the queue only when this call returns it.
    pub async fn next_event(&self) -> Option<ConnEvent> {
        self.inner.events.next().await
    }

    /// A card to display, by its id (from `card_requested`'s id, a list, a notification): refused when the computer
    /// answers with another card or one whose hash doesn't match it.
    pub async fn fetch_card(&self, id: String) -> Result<CardView, CoreError> {
        let inner = self.inner.clone();
        crate::runtime::spawn(async move { inner.fetch_card(&id).await }).await
    }

    /// The person's answer to the card the app displayed, as the core handed it over (`CardView`): signed with this
    /// phone's answer key over the hash of that content. `option` is one of its `options`; `children` the plugin
    /// checkboxes the person left checked (a plugin OK's), empty otherwise.
    pub async fn answer_card(&self, card: CardView, option: String, children: Vec<String>) -> Result<AnswerOutcome, CoreError> {
        let inner = self.inner.clone();
        crate::runtime::spawn(async move { inner.answer(&card, &option, children).await }).await
    }

    /// Sends the person's message to a session (a bot's conversation or a coding session), signed by this phone.
    /// `images` are paths `session.stageImage` gave; `files` are folder-tree paths (`home/...`, `bots/...`); both are
    /// numbered from 1 in the order given and covered by the signature. `client_message_id` makes a resend the same
    /// message. Returns the message's place in the session.
    pub async fn send_message(&self, session: String, text: String, client_message_id: String, images: Vec<String>, files: Vec<String>) -> Result<u64, CoreError> {
        let inner = self.inner.clone();
        crate::runtime::spawn(async move { inner.send_message(&session, &text, &client_message_id, &images, &files).await }).await
    }

    /// The link's state now (`next_event` tells each change).
    pub fn state(&self) -> LinkState {
        *self.inner.state.lock().unwrap()
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
