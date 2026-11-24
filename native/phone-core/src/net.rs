//! The phone's iroh endpoint (the same iroh as the desktop's sidecar, `native/link`) and length-prefixed frames on its
//! streams: a 4-byte big-endian length, then that many bytes (`links/frames.ts`).

use std::{net::SocketAddr, str::FromStr, time::Duration};

use iroh::endpoint::{Connection, RecvStream, SendStream, VarInt};

use crate::error::CoreError;

pub const ALPN_LINK: &str = "clover/link/1";
pub const ALPN_PAIR: &str = "clover/pair/1";

/// The largest frame the link takes (`MAX_FRAME`).
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

pub const CLOSE_NORMAL: u32 = 0;
pub const CLOSE_SUPERSEDED: u32 = 1;
pub const CLOSE_UNPAIRED: u32 = 2;
pub const CLOSE_REVOKED: u32 = 3;
pub const CLOSE_PROTOCOL: u32 = 4;
pub const CLOSE_SHUTDOWN: u32 = 6;
pub const RESET_NOT_FOUND: u32 = 2;

/// Which relays the endpoint uses: n0's public ones (the desktop's default), none (tests on one machine), or one URL.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum RelayChoice {
    Default,
    Disabled,
    Custom { url: String },
}

/// Where a computer is dialled: its key, and the hints the pairing gave.
#[derive(Clone, Debug)]
pub struct Target {
    pub key: [u8; 32],
    pub relay: Option<String>,
    pub addrs: Vec<String>,
}

pub async fn bind(seed: &[u8], relay: &RelayChoice, bind_addr: Option<&str>) -> Result<iroh::Endpoint, CoreError> {
    let seed: zeroize::Zeroizing<[u8; 32]> = zeroize::Zeroizing::new(seed.try_into().map_err(|_| CoreError::storage("the device key isn't 32 bytes"))?);
    let secret = iroh::SecretKey::from_bytes(&seed);
    let mut b = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
        .secret_key(secret)
        .alpns(vec![])
        // No UPnP, NAT-PMP or PCP, as on the desktop (S1).
        .portmapper_config(iroh::endpoint::PortmapperConfig::Disabled);
    b = match relay {
        RelayChoice::Default => b.relay_mode(iroh::RelayMode::Default),
        RelayChoice::Disabled => b.relay_mode(iroh::RelayMode::Disabled),
        RelayChoice::Custom { url } => {
            let url: iroh::RelayUrl = url.parse().map_err(|_| CoreError::invalid("the relay isn't a URL"))?;
            b.relay_mode(iroh::RelayMode::Custom(iroh::RelayMap::from(iroh::RelayConfig::new(url, None))))
        }
    };
    if let Some(addr) = bind_addr {
        let addr: SocketAddr = addr.parse().map_err(|_| CoreError::invalid("the bind address isn't ip:port"))?;
        b = b.clear_ip_transports().bind_addr(addr).map_err(|e| CoreError::invalid(format!("bind address: {e}")))?;
    }
    b.bind().await.map_err(|e| CoreError::offline(format!("the endpoint didn't bind: {e}")))
}

pub async fn dial(ep: &iroh::Endpoint, t: &Target, alpn: &str, timeout: Duration) -> Result<Connection, CoreError> {
    let key = iroh::PublicKey::from_bytes(&t.key).map_err(|_| CoreError::invalid("not a computer's key"))?;
    let mut addrs: Vec<iroh::TransportAddr> = t.addrs.iter().filter_map(|a| SocketAddr::from_str(a).ok()).map(iroh::TransportAddr::Ip).collect();
    if let Some(url) = &t.relay {
        if let Ok(url) = url.parse() {
            addrs.push(iroh::TransportAddr::Relay(url));
        }
    }
    match tokio::time::timeout(timeout, ep.connect(iroh::EndpointAddr::from_parts(key, addrs), alpn.as_bytes())).await {
        Err(_) => Err(CoreError::offline("no path answered in time")),
        Ok(Err(e)) => Err(CoreError::offline(format!("the computer can't be reached: {e}"))),
        Ok(Ok(c)) => {
            // iroh authenticated the key the dial named; checked again, since everything after trusts it.
            if c.remote_id().as_bytes() != &t.key {
                c.close(VarInt::from_u32(CLOSE_PROTOCOL), b"the wrong device answered");
                return Err(CoreError::protocol("the wrong device answered"));
            }
            Ok(c)
        }
    }
}

pub async fn write_frame(send: &mut SendStream, payload: &[u8]) -> Result<(), CoreError> {
    if payload.len() > MAX_FRAME {
        return Err(CoreError::refused("a frame is at most 16 MiB"));
    }
    let mut buf = Vec::with_capacity(4 + payload.len());
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(payload);
    send.write_all(&buf).await.map_err(|e| CoreError::offline(format!("the stream ended: {e}")))
}

/// The next frame, or None when the peer finished the stream cleanly between frames.
pub async fn read_frame(recv: &mut RecvStream, max: usize) -> Result<Option<Vec<u8>>, CoreError> {
    let mut head = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match recv.read(&mut head[got..]).await {
            Ok(Some(n)) => got += n,
            Ok(None) if got == 0 => return Ok(None),
            Ok(None) => return Err(CoreError::protocol("a frame cut short")),
            Err(e) => return Err(CoreError::offline(format!("the stream ended: {e}"))),
        }
    }
    let len = u32::from_be_bytes(head) as usize;
    if len > max {
        return Err(CoreError::protocol("a frame is longer than the link allows"));
    }
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body).await.map_err(|e| CoreError::offline(format!("the stream ended: {e}")))?;
    Ok(Some(body))
}

/// One frame read with a keep limit: kept whole up to `keep`, or, up to `skip`, read and dropped with its first bytes
/// kept (enough to say what it answered), so one oversize message costs one call, not the link.
pub enum Read {
    Frame(Vec<u8>),
    Skipped { len: usize, head: Vec<u8> },
    End,
}

pub async fn read_frame_or_skip(recv: &mut RecvStream, keep: usize, skip: usize) -> Result<Read, CoreError> {
    let mut head = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match recv.read(&mut head[got..]).await {
            Ok(Some(n)) => got += n,
            Ok(None) if got == 0 => return Ok(Read::End),
            Ok(None) => return Err(CoreError::protocol("a frame cut short")),
            Err(e) => return Err(CoreError::offline(format!("the stream ended: {e}"))),
        }
    }
    let len = u32::from_be_bytes(head) as usize;
    if len <= keep {
        let mut body = vec![0u8; len];
        recv.read_exact(&mut body).await.map_err(|e| CoreError::offline(format!("the stream ended: {e}")))?;
        return Ok(Read::Frame(body));
    }
    if len > skip {
        return Err(CoreError::protocol("a frame is longer than the link allows"));
    }
    let mut first = vec![0u8; 512.min(len)];
    recv.read_exact(&mut first).await.map_err(|e| CoreError::offline(format!("the stream ended: {e}")))?;
    let mut left = len - first.len();
    let mut buf = vec![0u8; 64 * 1024];
    while left > 0 {
        let n = left.min(buf.len());
        recv.read_exact(&mut buf[..n]).await.map_err(|e| CoreError::offline(format!("the stream ended: {e}")))?;
        left -= n;
    }
    Ok(Read::Skipped { len, head: first })
}

/// The code and reason a connection closed with, as the peer gave them (or a lost path's).
pub fn close_of(e: &iroh::endpoint::ConnectionError) -> (u32, String) {
    match e {
        iroh::endpoint::ConnectionError::ApplicationClosed(c) => {
            (u32::try_from(c.error_code.into_inner()).unwrap_or(5), String::from_utf8_lossy(&c.reason).into_owned())
        }
        iroh::endpoint::ConnectionError::LocallyClosed => (CLOSE_NORMAL, "closed here".into()),
        other => (5, other.to_string()),
    }
}
