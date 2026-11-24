//! MOSS's phone core: the one library the iPhone apps (Swift) and the Android apps (Kotlin) share to pair with a
//! person's computer, hold the link, talk to the engine and sign card answers (spec §8, §5.5, §10). The engine's
//! TypeScript is the reference; every byte both sides hash or sign is built as it builds it (`tests/vectors.rs`).
//!
//! The surface, through UniFFI:
//! * `PhoneCore::new(storage, config)`: loads or makes the device key and the answer key through the host's
//!   `SecretStorage` (the Keychain, the Keystore); the core keeps no file of its own.
//! * `begin_pairing(qr, app)` → `Pairing`: `words()` to show, then `confirm()` (→ the `PairedComputer`) or `reject()`.
//! * `connect(computer_id, options)` → `Connection`: `call(method, params_json)`, `next_event()`, `fetch_card`,
//!   `answer_card(card_view, option, children)` (signs only the card as displayed), `send_message` (signed), `state`,
//!   `network_changed`, `disconnect`. Events bring cards as checked `CardView`s. It re-dials by itself until closed or revoked.
//! * `card_hash(card_json)`: a card's hash as the engine computes it.

uniffi::setup_scaffolding!();

pub mod bytes;
pub mod cards;
pub mod cbor;
pub mod computers;
pub mod error;
pub mod identity;
pub mod json;
pub mod keys;
pub mod link;
pub mod names;
pub mod net;
pub mod pairing;
pub mod runtime;
pub mod sas;

use std::sync::Arc;

pub use computers::{PairedComputer, PhoneApp};
pub use error::{CoreError, StorageError};
pub use identity::{AnswerKeyHolder, PhoneIdentity, PhoneOs, SecretStorage};
pub use cards::CardView;
pub use link::{AnswerOutcome, ConnEvent, ConnectOptions, Connection, LinkState, StagedFile};
pub use net::RelayChoice;
pub use pairing::Pairing;
use tokio::sync::OnceCell;

#[derive(Clone, Debug, uniffi::Record)]
pub struct CoreConfig {
    /// The phone's name, as computers list it.
    pub device_name: String,
    pub holder: AnswerKeyHolder,
    pub os: PhoneOs,
    pub relay: RelayChoice,
    /// `ip:port` to bind instead of every interface (tests bind loopback); None for a phone.
    pub bind_addr: Option<String>,
}

#[derive(uniffi::Object)]
pub struct PhoneCore {
    storage: Arc<dyn SecretStorage>,
    identity: Arc<identity::Identity>,
    config: CoreConfig,
    endpoint: OnceCell<iroh::Endpoint>,
}

impl std::fmt::Debug for PhoneCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PhoneCore({})", self.identity.id)
    }
}

impl PhoneCore {
    /// The endpoint, bound on first use (inside the core's runtime).
    async fn endpoint(&self) -> Result<iroh::Endpoint, CoreError> {
        self.endpoint
            .get_or_try_init(|| async {
                let seed = self.identity.device.seed();
                net::bind(&seed, &self.config.relay, self.config.bind_addr.as_deref()).await
            })
            .await
            .cloned()
    }
}

#[uniffi::export]
impl PhoneCore {
    /// Loads this phone's keys, or makes them and saves them through `storage` first.
    #[uniffi::constructor]
    pub fn new(storage: Arc<dyn SecretStorage>, config: CoreConfig) -> Result<Arc<Self>, CoreError> {
        let identity = identity::Identity::load_or_create(&storage, config.device_name.clone(), config.holder, config.os)?;
        Ok(Arc::new(PhoneCore { storage, identity: Arc::new(identity), config, endpoint: OnceCell::new() }))
    }

    pub fn identity(&self) -> PhoneIdentity {
        self.identity.public()
    }

    /// Binds the endpoint now (otherwise the first pairing or connection does), and says where it is bound.
    pub async fn start(self: Arc<Self>) -> Result<Vec<String>, CoreError> {
        runtime::spawn(async move { Ok(self.endpoint().await?.bound_sockets().iter().map(|a| a.to_string()).collect()) }).await
    }

    pub fn paired_computers(&self) -> Result<Vec<PairedComputer>, CoreError> {
        computers::list(&self.storage)
    }

    /// Forgets a computer here with every item its pairing kept (the computer keeps its own record until it revokes
    /// this phone).
    pub fn forget_computer(&self, id: String) -> Result<(), CoreError> {
        computers::forget(&self.storage, &id).map(|_| ())
    }

    /// Starts pairing with the computer whose QR was scanned, for one of the two phone apps. Returns once both sides
    /// show the four words.
    pub async fn begin_pairing(self: Arc<Self>, qr: String, app: PhoneApp) -> Result<Arc<Pairing>, CoreError> {
        runtime::spawn(async move {
            let ep = self.endpoint().await?;
            pairing::begin(&ep, self.identity.clone(), self.storage.clone(), &qr, app).await.map(Arc::new)
        })
        .await
    }

    /// Keeps a link to a paired computer and a client connection over it, from now until `close`.
    pub async fn connect(self: Arc<Self>, computer_id: String, options: ConnectOptions) -> Result<Arc<Connection>, CoreError> {
        runtime::spawn(async move {
            let c = computers::list(&self.storage)?.into_iter().find(|c| c.id == computer_id).ok_or_else(|| CoreError::invalid("not a paired computer"))?;
            let ep = self.endpoint().await?;
            link::start(ep, self.identity.clone(), c, options)
        })
        .await
    }

    /// Closes the endpoint (every connection on it ends).
    pub async fn shutdown(self: Arc<Self>) {
        runtime::spawn(async move {
            if let Some(ep) = self.endpoint.get() {
                ep.close().await;
            }
        })
        .await
    }
}

/// A card's hash as the engine computes it (SHA-256 hex of its canonical JSON without `hash`).
#[uniffi::export]
pub fn card_hash(card_json: String) -> Result<String, CoreError> {
    let v: serde_json::Value = serde_json::from_str(&card_json).map_err(|_| CoreError::TamperedCard { reason: "the card isn't JSON".into() })?;
    cards::card_hash(&v)
}

/// A self-test the platform tests run first: binds two endpoints on loopback, dials one from the other on a test
/// ALPN and echoes a frame both ways. It proves the async calls complete on the platform (each step has its own
/// timeout, so a hang fails at a named step). Returns the steps it passed.
#[uniffi::export]
pub async fn loopback_self_test() -> Result<Vec<String>, CoreError> {
    runtime::spawn(selftest::run()).await
}

mod selftest {
    use std::time::Duration;

    use super::*;

    const ALPN: &[u8] = b"moss/phone-core-selftest/1";

    async fn step<T>(steps: &mut Vec<String>, name: &str, fut: impl std::future::Future<Output = Result<T, CoreError>>) -> Result<T, CoreError> {
        match tokio::time::timeout(Duration::from_secs(20), fut).await {
            Ok(Ok(v)) => {
                steps.push(name.to_string());
                Ok(v)
            }
            Ok(Err(e)) => Err(CoreError::Offline { reason: format!("{name} failed after [{}]: {e}", steps.join(", ")) }),
            Err(_) => Err(CoreError::Timeout { reason: format!("{name} hung after [{}]", steps.join(", ")) }),
        }
    }

    pub async fn run() -> Result<Vec<String>, CoreError> {
        let mut steps = vec![];
        let bind = |alpns: Vec<Vec<u8>>| async move {
            iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .alpns(alpns)
                .relay_mode(iroh::RelayMode::Disabled)
                .portmapper_config(iroh::endpoint::PortmapperConfig::Disabled)
                .clear_ip_transports()
                .bind_addr("127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap())
                .map_err(|e| CoreError::invalid(e.to_string()))?
                .bind()
                .await
                .map_err(|e| CoreError::offline(e.to_string()))
        };
        let server = step(&mut steps, "bind server", bind(vec![ALPN.to_vec()])).await?;
        let client = step(&mut steps, "bind client", bind(vec![])).await?;
        let addr = server.bound_sockets().into_iter().next().ok_or_else(|| CoreError::offline("no bound socket"))?;
        let srv = server.clone();
        let echo = tokio::spawn(async move {
            let conn = srv.accept().await?.accept().ok()?.await.ok()?;
            let (mut send, mut recv) = conn.accept_bi().await.ok()?;
            let f = net::read_frame(&mut recv, 1024).await.ok()??;
            net::write_frame(&mut send, &f).await.ok()?;
            let _ = send.finish();
            let _ = conn.closed().await;
            Some(())
        });
        let target = iroh::EndpointAddr::from_parts(server.id(), [iroh::TransportAddr::Ip(addr)]);
        let conn = step(&mut steps, "dial", async { client.connect(target, ALPN).await.map_err(|e| CoreError::offline(e.to_string())) }).await?;
        let (mut send, mut recv) = step(&mut steps, "open stream", async { conn.open_bi().await.map_err(|e| CoreError::offline(e.to_string())) }).await?;
        step(&mut steps, "write", net::write_frame(&mut send, b"ping")).await?;
        let back = step(&mut steps, "read echo", net::read_frame(&mut recv, 1024)).await?;
        if back.as_deref() != Some(b"ping".as_slice()) {
            return Err(CoreError::protocol("the echo differs"));
        }
        conn.close(iroh::endpoint::VarInt::from_u32(0), b"done");
        let _ = tokio::time::timeout(Duration::from_secs(5), echo).await;
        step(&mut steps, "close", async {
            client.close().await;
            server.close().await;
            Ok(())
        })
        .await?;
        Ok(steps)
    }
}
