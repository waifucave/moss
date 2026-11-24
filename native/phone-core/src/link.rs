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
use crate::cards::{CardState, Checked};
use crate::names::computers_words;
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
/// The largest message the phone sends: the engine's link drops a frame over `IROH_MAX_FRAME_BYTES` (1 MiB) without an
/// error, so a call that big is refused here in plain words instead.
pub const SEND_FRAME_MAX: usize = 1 << 20;
/// What may wait to be written at once, in bytes; a call that would overfill it fails at once.
pub const SEND_QUEUE_BYTES: usize = 4 << 20;
/// Cards still waiting that a connection tracks, and the resolutions it keeps for cards it hasn't issued (yet).
const CARDS_LIVE_MAX: usize = 512;
const CARDS_RESOLVED_MAX: usize = 512;
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
    /// The cards pending when the connection came up (`card.list`), each checked and issued for display.
    PendingCards { cards: Vec<Arc<CardView>> },
    /// A card raised now (`card_requested`), checked and issued for display.
    CardRequested { card: Arc<CardView> },
    /// A card was resolved (`card_resolved`): its `CardView`s read it, and an answer to it is refused.
    CardResolved { id: String, outcome: String },
    /// A card the computer sent whose hash doesn't match what it says, or that isn't a card: not shown, never signed.
    /// `computers_id` is the id it claimed, cleaned: the computer's words.
    TamperedCard { computers_id: Option<String> },
    /// A message from the engine larger than the phone takes was read and dropped (`bytes` long); the link stays.
    MessageDropped { bytes: u64 },
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
            ConnEvent::TamperedCard { computers_id } => computers_id.as_ref().map_or(0, String::len),
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

impl PartialEq for CardView {
    fn eq(&self, o: &Self) -> bool {
        self.id == o.id && self.hash == o.hash && self.issuer == o.issuer
    }
}

/// A file staged for a session's next message (`session.stageFile`): name it in `send_message`'s `files` by `path`.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct StagedFile {
    /// The name the computer gave it (a safe one, not necessarily the one asked for), cleaned: the computer's words.
    pub computers_name: String,
    pub path: String,
}

/// One chunk of a staged file (`STAGE_FILE_CHUNK_BYTES`).
pub const STAGE_FILE_CHUNK_BYTES: usize = 512 * 1024;
/// One file at most (`STAGE_FILE_MAX_BYTES`).
pub const STAGE_FILE_MAX_BYTES: usize = 50 * 1024 * 1024;
/// One picture at most (`STAGE_IMAGE_MAX_BYTES`: the desktop's line cap less its headroom, as bytes).
pub const STAGE_PICTURE_MAX_BYTES: usize = 6_094_848;

/// A path the computer gave that the phone will name, and sign, as it came: never rewritten. One the phone couldn't
/// name exactly (a hidden character, too long) is refused.
fn protocol_path(v: Option<&Value>) -> Result<String, CoreError> {
    let p = v.and_then(Value::as_str).ok_or_else(|| CoreError::protocol("the computer gave no path for it"))?;
    if p.is_empty() || p.encode_utf16().count() > 4096 || p.chars().any(crate::visible::unshown) {
        return Err(CoreError::protocol("the computer gave a path the phone can't name exactly"));
    }
    Ok(p.to_string())
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AnswerOutcome {
    pub accepted: bool,
    /// The engine's reason when it didn't take the answer (`already-answered`, `bad-time`, ...), cleaned: the
    /// computer's words.
    pub computers_reason: Option<String>,
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
    /// Frames for `rpc`, written in order by one writer task (`writer`), never aborted once begun.
    queue: tokio::sync::mpsc::UnboundedSender<Job>,
    queue_rx: StdMutex<Option<tokio::sync::mpsc::UnboundedReceiver<Job>>>,
    /// The queue's bytes, in KiB permits.
    queue_room: Arc<tokio::sync::Semaphore>,
    pending: Pending,
    next_id: AtomicU64,
    started: Instant,
    last_in: AtomicU64,
    last_out: AtomicU64,
    /// Why this side closed it, in the core's own words, for `Down`.
    failure: StdMutex<Option<&'static str>>,
}

/// One frame waiting for the writer, holding its room in the queue until written or dropped.
struct Job {
    frame: Vec<u8>,
    done: Option<oneshot::Sender<Result<(), CoreError>>>,
    _room: tokio::sync::OwnedSemaphorePermit,
}

/// The one writer of a session's client stream: frames in order, each written whole once begun (no caller's
/// cancellation reaches it), and a frame whose caller has gone before its turn dropped unsent.
async fn writer(s: std::sync::Weak<Session>, mut rx: tokio::sync::mpsc::UnboundedReceiver<Job>) {
    while let Some(job) = rx.recv().await {
        if job.done.as_ref().is_some_and(|d| d.is_closed()) {
            continue;
        }
        let Some(s) = s.upgrade() else { return };
        let r = s.rpc_send_bytes(&job.frame).await;
        let failed = r.is_err();
        if let Some(d) = job.done {
            let _ = d.send(r);
        }
        if failed {
            return;
        }
    }
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
        // Calls under way end now (the hello's among them), not at their timeouts.
        self.fail_all(why);
    }
    async fn lane_send(&self, m: &Cbor) -> Result<(), CoreError> {
        self.last_out.store(self.now(), Ordering::Relaxed);
        net::write_frame(&mut *self.control.lock().await, &encode(m)).await
    }
    async fn rpc_send_bytes(&self, frame: &[u8]) -> Result<(), CoreError> {
        self.last_out.store(self.now(), Ordering::Relaxed);
        net::write_frame(&mut *self.rpc.lock().await, frame).await
    }
    /// Puts a frame in the writer's queue. `done` hears how its write went; a job whose `done` is gone before the
    /// writer reaches it (its caller stopped waiting) is dropped unsent. Refused when the queue has no room for it.
    fn enqueue(&self, frame: Vec<u8>, done: Option<oneshot::Sender<Result<(), CoreError>>>) -> Result<(), CoreError> {
        if frame.len() > SEND_FRAME_MAX {
            return Err(CoreError::refused("that is more than the link carries in one message (1 MiB)"));
        }
        let permits = frame.len().div_ceil(1024).max(1) as u32;
        let permit = self.queue_room.clone().try_acquire_many_owned(permits).map_err(|_| CoreError::refused("too much is waiting to be sent to the computer; try again in a moment"))?;
        self.queue.send(Job { frame, done, _room: permit }).map_err(|_| CoreError::offline("the link is closed"))
    }
    fn fail_all(&self, why: &str) {
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(CoreError::offline(why.to_string())));
        }
    }
    async fn request(self: &Arc<Self>, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, CoreError> {
        // The timeout covers the whole call: its wait in the queue, its write and the answer.
        match timeout {
            Some(t) => tokio::time::timeout(t, self.request_untimed(method, params))
                .await
                .unwrap_or_else(|_| Err(CoreError::Timeout { reason: format!("`{method}` got no answer in time") })),
            None => self.request_untimed(method, params).await,
        }
    }

    async fn request_untimed(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, CoreError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        // Whatever ends this call (an answer, an error, a caller that stops waiting), its entry goes with it.
        struct Unregister<'a>(&'a Session, u64);
        impl Drop for Unregister<'_> {
            fn drop(&mut self) {
                self.0.pending.lock().unwrap().remove(&self.1);
            }
        }
        let _unregister = Unregister(self, id);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let (done_tx, done_rx) = oneshot::channel();
        self.enqueue(serde_json::to_vec(&msg).expect("JSON"), Some(done_tx))?;
        done_rx.await.unwrap_or_else(|_| Err(CoreError::offline("the link dropped")))?;
        rx.await.unwrap_or_else(|_| Err(CoreError::offline("the link dropped")))
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
    /// This connection's own number: a `CardView` it issued names it, and only its own are answered here.
    serial: u64,
    /// The cards issued here and still waiting, and the resolutions heard: both bounded.
    cards: StdMutex<CardTable>,
}

/// A paired computer's link and client connection, kept up by the core until `disconnect`.
#[derive(uniffi::Object)]
pub struct Connection {
    inner: Arc<Inner>,
}

/// For the core's own tests, never exported.
impl Connection {
    #[doc(hidden)]
    pub fn tracked_cards(&self) -> usize {
        self.inner.tracked_cards()
    }
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

static SERIAL: AtomicU64 = AtomicU64::new(1);

/// A connection's cards: those it issued that still wait (their state shared with every view of them), and the ids
/// resolved lately, so a resolution heard before its card is listed still counts. Both capped, oldest dropped first: a
/// computer streaming ids costs a fixed amount, and a card dropped from it only stops hearing its resolution (its
/// answer is then refused by the computer, never wrongly signed).
#[derive(Default)]
struct CardTable {
    live: HashMap<String, CardState>,
    live_order: std::collections::VecDeque<String>,
    resolved: HashMap<String, String>,
    resolved_order: std::collections::VecDeque<String>,
}

impl CardTable {
    fn len(&self) -> usize {
        self.live.len() + self.resolved.len()
    }
    /// The state a view of card `id` shares.
    fn state_for(&mut self, id: &str) -> CardState {
        if let Some(outcome) = self.resolved.get(id) {
            return Arc::new(StdMutex::new(Some(outcome.clone())));
        }
        if let Some(s) = self.live.get(id) {
            return s.clone();
        }
        let s: CardState = Arc::default();
        self.live.insert(id.to_string(), s.clone());
        self.live_order.push_back(id.to_string());
        while self.live.len() > CARDS_LIVE_MAX {
            let Some(old) = self.live_order.pop_front() else { break };
            self.live.remove(&old);
        }
        s
    }
    fn resolve(&mut self, id: &str, outcome: &str) {
        if let Some(s) = self.live.remove(id) {
            *s.lock().unwrap() = Some(outcome.to_string());
            self.live_order.retain(|x| x != id);
        }
        if self.resolved.insert(id.to_string(), outcome.to_string()).is_none() {
            self.resolved_order.push_back(id.to_string());
        }
        while self.resolved.len() > CARDS_RESOLVED_MAX {
            let Some(old) = self.resolved_order.pop_front() else { break };
            self.resolved.remove(&old);
        }
    }
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
        serial: SERIAL.fetch_add(1, Ordering::Relaxed),
        cards: StdMutex::new(CardTable::default()),
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
    fn tracked_cards(&self) -> usize {
        self.cards.lock().unwrap().len()
    }

    /// A checked card, issued for display from this connection.
    fn issue(&self, c: Checked, outcome: Option<String>) -> Arc<CardView> {
        let state = {
            let mut t = self.cards.lock().unwrap();
            if let Some(o) = &outcome {
                t.resolve(&c.id, o);
            }
            t.state_for(&c.id)
        };
        Arc::new(CardView { id: c.id, hash: c.hash, card_json: c.card_json, options: c.options, state, issuer: self.serial })
    }

    fn tampered(&self, card: &Value) {
        let id = card.get("id").and_then(Value::as_str).map(|s| computers_words(s, 80));
        self.emit(ConnEvent::TamperedCard { computers_id: id });
    }

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
        let (queue, queue_rx) = tokio::sync::mpsc::unbounded_channel();
        let s = Arc::new(Session {
            conn: conn.clone(),
            control: Mutex::new(control),
            _control_recv: control_recv,
            rpc: Mutex::new(rpc),
            queue,
            queue_rx: StdMutex::new(Some(queue_rx)),
            queue_room: Arc::new(tokio::sync::Semaphore::new(SEND_QUEUE_BYTES / 1024)),
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
            let rx = s.queue_rx.lock().unwrap().take().expect("one writer");
            tokio::spawn(writer(Arc::downgrade(&s), rx));
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
                    match cards::check(&c) {
                        Ok(v) => shown.push(self.issue(v, None)),
                        Err(_) => self.tampered(&c),
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
            let f = match net::read_frame_or_skip(&mut recv, RPC_FRAME_MAX, net::MAX_FRAME).await {
                Ok(net::Read::Frame(f)) => f,
                Ok(net::Read::Skipped { len, head }) => {
                    // Over the phone's cap but within the engine's own: read to its end and dropped. An answer fails
                    // only its own call; any other message is reported as dropped. The link stays.
                    s.heard();
                    match answered_id(&head).and_then(|id| s.pending.lock().unwrap().remove(&id)) {
                        Some(tx) => {
                            let _ = tx.send(Err(CoreError::refused(format!("the computer's answer was {:.1} MiB, more than the phone takes (4 MiB)", len as f64 / (1u64 << 20) as f64))));
                        }
                        None => self.emit(ConnEvent::MessageDropped { bytes: len as u64 }),
                    }
                    continue;
                }
                Ok(net::Read::End) => break,
                Err(CoreError::Protocol { .. }) => return s.fail("the computer sent a message larger than the link allows (16 MiB)"),
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
                            computers_words: computers_words(e.get("message").and_then(Value::as_str).unwrap_or("failed"), 300),
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
                    let _ = s.enqueue(serde_json::to_vec(&reply).expect("JSON"), None);
                }
                (None, None) => {}
            }
        }
        // The client stream ended: the engine closed this client connection, so the link goes too and is re-dialled.
        s.conn.close(VarInt::from_u32(CLOSE_SUPERSEDED), b"the client stream ended");
        s.fail_all("the link dropped");
    }

    /// A card raised now arrives checked for display; every other notification as it came.
    fn notification(&self, method: &str, params: Value) {
        let kind = if method == "core.event" { params.get("type").and_then(Value::as_str) } else { None };
        if kind == Some("card_requested") {
            let card = params.get("card").cloned().unwrap_or(Value::Null);
            match cards::check(&card) {
                Ok(v) => {
                    let v = self.issue(v, None);
                    self.emit(ConnEvent::CardRequested { card: v });
                }
                Err(_) => self.tampered(&card),
            }
            return;
        }
        if kind == Some("card_resolved") {
            let id = params.get("id").and_then(Value::as_str).filter(|i| cards::is_card_id(i));
            let outcome = params.get("outcome").and_then(Value::as_str).map(|o| computers_words(o, 32));
            if let (Some(id), Some(outcome)) = (id, outcome) {
                // Kept for a card not issued yet too (its event can come before the list that brings it), within bounds.
                self.cards.lock().unwrap().resolve(id, &outcome);
                self.emit(ConnEvent::CardResolved { id: id.to_string(), outcome });
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
    async fn fetch_card(&self, id: &str) -> Result<Arc<CardView>, CoreError> {
        let r = self.call("card.get", json!({ "id": id })).await?;
        let card = r.get("card").cloned().ok_or_else(|| CoreError::protocol("card.get answered no card"))?;
        let outcome = r.get("outcome").and_then(Value::as_str).map(|s| computers_words(s, 32));
        let checked = cards::check(&card)?;
        if checked.id != id {
            return Err(CoreError::TamperedCard { reason: "the computer answered with another card than the one asked for".into() });
        }
        Ok(self.issue(checked, outcome))
    }

    /// Signs and sends the person's answer to the card exactly as the app displayed it: the hash is recomputed from
    /// the content the app holds, the id is that content's, and nothing is fetched between the tap and the signature.
    async fn answer(&self, shown: &CardView, option: &str, children: Vec<String>) -> Result<AnswerOutcome, CoreError> {
        if shown.issuer != self.serial {
            return Err(CoreError::refused("this card was issued by another connection: answer it there"));
        }
        if !shown.pending() {
            return Err(CoreError::refused("the card is no longer waiting for an answer"));
        }
        // The core's own copy, checked again: what is signed is the hash of exactly this content.
        let card: Value = serde_json::from_str(&shown.card_json).map_err(|_| CoreError::TamperedCard { reason: "the card isn't JSON".into() })?;
        let view = cards::check(&card)?;
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
        let accepted = r.get("accepted").and_then(Value::as_bool).unwrap_or(false);
        if accepted {
            *shown.state.lock().unwrap() = Some("answered".into());
            self.cards.lock().unwrap().resolve(&shown.id, "answered");
        }
        Ok(AnswerOutcome { accepted, computers_reason: r.get("reason").and_then(Value::as_str).map(|s| computers_words(s, 200)) })
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

    /// Sends `data` in chunks through `method` (`session.stageFile` or `session.stagePicture`): `first` holds the first
    /// request's own fields (a file's name, a picture's type). Each answer must hold strictly more bytes than the last
    /// and no more than were sent, in no more rounds than there are chunks; otherwise, or when the caller stops waiting,
    /// the upload is dropped at the computer.
    async fn upload(self: &Arc<Self>, method: &'static str, session: &str, mut first: serde_json::Map<String, Value>, data: &[u8], max: usize) -> Result<Value, CoreError> {
        use base64::Engine;
        if data.is_empty() || data.len() > max {
            return Err(CoreError::refused(format!("that is more than the computer takes ({} MiB at most)", max >> 20)));
        }
        let b64 = |c: &[u8]| base64::engine::general_purpose::STANDARD.encode(c);
        // Dropped unless disarmed: tells the computer to drop the upload, whatever ended this call.
        struct Drop_ {
            inner: Arc<Inner>,
            method: &'static str,
            session: String,
            upload: Option<String>,
        }
        impl Drop for Drop_ {
            fn drop(&mut self) {
                if let Some(upload) = self.upload.take() {
                    let (inner, method, session) = (self.inner.clone(), self.method, self.session.clone());
                    crate::runtime::handle().spawn(async move {
                        let _ = inner.call(method, json!({ "id": session, "upload": upload, "cancel": true })).await;
                    });
                }
            }
        }
        let mut guard = Drop_ { inner: self.clone(), method, session: session.to_string(), upload: None };
        let chunk_of = |at: usize| &data[at..data.len().min(at + STAGE_FILE_CHUNK_BYTES)];
        first.insert("id".into(), json!(session));
        first.insert("size".into(), json!(data.len()));
        first.insert("dataBase64".into(), json!(b64(chunk_of(0))));
        let mut r = self.call(method, Value::Object(first)).await?;
        let upload = r.get("upload").and_then(Value::as_str).filter(|u| !u.is_empty() && u.len() <= 64).ok_or_else(|| CoreError::protocol("the computer's upload has no id"))?.to_string();
        guard.upload = Some(upload.clone());
        let mut sent = chunk_of(0).len();
        let mut held = 0usize;
        let rounds = data.len().div_ceil(STAGE_FILE_CHUNK_BYTES);
        for _ in 0..rounds {
            let got = r.get("received").and_then(Value::as_u64).map(|n| n as usize);
            if !got.is_some_and(|g| g > held && g <= sent) {
                return Err(CoreError::protocol("the computer's upload didn't move forward"));
            }
            held = got.unwrap();
            if r.get("done").and_then(Value::as_bool) == Some(true) {
                if held != data.len() {
                    return Err(CoreError::protocol("the computer says the upload is done before it has every byte"));
                }
                guard.upload = None;
                return Ok(r);
            }
            if held == data.len() {
                return Err(CoreError::protocol("the computer holds every byte but doesn't say the upload is done"));
            }
            let chunk = chunk_of(held);
            sent = held + chunk.len();
            r = self.call(method, json!({ "id": session, "upload": upload, "offset": held, "dataBase64": b64(chunk) })).await?;
        }
        Err(CoreError::protocol("the computer's upload took more rounds than it has chunks"))
    }

    /// Sends a file for a session's next message in chunks (`session.stageFile`).
    async fn stage_file(self: &Arc<Self>, session: &str, name: &str, data: &[u8]) -> Result<StagedFile, CoreError> {
        let mut first = serde_json::Map::new();
        first.insert("name".into(), json!(name));
        let r = self.upload("session.stageFile", session, first, data, STAGE_FILE_MAX_BYTES).await?;
        let path = protocol_path(r.get("path"))?;
        let given = r.get("name").and_then(Value::as_str).unwrap_or(name);
        Ok(StagedFile { computers_name: computers_words(given, 256), path })
    }

    /// Sends a picture for a session's next message in chunks (`session.stagePicture`).
    async fn stage_picture(self: &Arc<Self>, session: &str, media_type: &str, data: &[u8]) -> Result<String, CoreError> {
        let mut first = serde_json::Map::new();
        first.insert("mediaType".into(), json!(media_type));
        let r = self.upload("session.stagePicture", session, first, data, STAGE_PICTURE_MAX_BYTES).await?;
        protocol_path(r.get("path"))
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

/// The id a JSON-RPC answer names, from its first bytes (`{"jsonrpc":"2.0","id":N,...`, as the engine writes it).
fn answered_id(head: &[u8]) -> Option<u64> {
    let text = String::from_utf8_lossy(head);
    let at = text.find("\"id\":")? + 5;
    let digits: String = text[at..].trim_start().chars().take_while(char::is_ascii_digit).collect();
    // Only an answer: a message naming a method is a notification or a request.
    if text[..at].contains("\"method\"") {
        return None;
    }
    digits.parse().ok()
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
    pub async fn fetch_card(&self, id: String) -> Result<Arc<CardView>, CoreError> {
        let inner = self.inner.clone();
        crate::runtime::spawn(async move { inner.fetch_card(&id).await }).await
    }

    /// The person's answer to the card the app displayed, as the core handed it over (`CardView`): signed with this
    /// phone's answer key over the hash of that content. `option` is one of its `options`; `children` the plugin
    /// checkboxes the person left checked (a plugin OK's), empty otherwise.
    pub async fn answer_card(&self, card: Arc<CardView>, option: String, children: Vec<String>) -> Result<AnswerOutcome, CoreError> {
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

    /// Sends a file for the session's next message (`session.stageFile`, in 512 KiB chunks); name it in
    /// `send_message`'s `files` by the returned `path`. A call stopped part way drops the upload at the computer.
    pub async fn stage_file(&self, session: String, name: String, data: Vec<u8>) -> Result<StagedFile, CoreError> {
        let inner = self.inner.clone();
        crate::runtime::spawn(async move { inner.stage_file(&session, &name, &data).await }).await
    }

    /// Sends a picture for the session's next message (`session.stagePicture`, in 512 KiB chunks; `media_type` as
    /// `image/png`); name it in `send_message`'s `images` by the returned path.
    pub async fn stage_image(&self, session: String, media_type: String, data: Vec<u8>) -> Result<String, CoreError> {
        let inner = self.inner.clone();
        crate::runtime::spawn(async move { inner.stage_picture(&session, &media_type, &data).await }).await
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
