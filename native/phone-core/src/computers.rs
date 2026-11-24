//! The computers this phone is paired with: public records (a key, a name, dial hints), kept through the host's
//! storage as one JSON item. The pair's own secrets (its signing key and pair secret) are separate items.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::{error::CoreError, identity::SecretStorage};

const COMPUTERS: &str = "computers";

/// Which phone app a pairing is for (the owner's decision 2026-11-24: MOSS and MOSS Code pair on their own).
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum PhoneApp {
    /// MOSS, for the bots.
    Moss,
    /// MOSS Code, for coding sessions.
    Code,
}

impl PhoneApp {
    pub fn wire(self) -> &'static str {
        match self {
            PhoneApp::Moss => "moss",
            PhoneApp::Code => "code",
        }
    }
    fn from_wire(s: &str) -> Option<Self> {
        match s {
            "moss" => Some(PhoneApp::Moss),
            "code" => Some(PhoneApp::Code),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PairedComputer {
    pub id: String,
    pub name: String,
    /// Its link key, base64.
    pub public_key: String,
    pub relay: Option<String>,
    /// `ip:port` dial hints from the pairing.
    pub addrs: Vec<String>,
    /// The pair's id (base64url), when the pairing made a pair credential.
    pub pair_id: Option<String>,
    /// The group this phone joined, when the pairing formed or joined one.
    pub group: Option<String>,
    pub app: PhoneApp,
    pub paired_at: i64,
}

fn to_json(c: &PairedComputer) -> Value {
    json!({
        "id": c.id, "name": c.name, "publicKey": c.public_key, "relay": c.relay, "addrs": c.addrs, "pairId": c.pair_id,
        "group": c.group, "app": c.app.wire(), "pairedAt": c.paired_at,
    })
}

fn from_json(v: &Value) -> Option<PairedComputer> {
    Some(PairedComputer {
        id: v["id"].as_str()?.into(),
        name: v["name"].as_str()?.into(),
        public_key: v["publicKey"].as_str()?.into(),
        relay: v["relay"].as_str().map(Into::into),
        addrs: v["addrs"].as_array()?.iter().filter_map(|a| a.as_str().map(Into::into)).collect(),
        pair_id: v["pairId"].as_str().map(Into::into),
        group: v["group"].as_str().map(Into::into),
        app: PhoneApp::from_wire(v["app"].as_str()?)?,
        paired_at: v["pairedAt"].as_i64()?,
    })
}

pub fn list(storage: &Arc<dyn SecretStorage>) -> Result<Vec<PairedComputer>, CoreError> {
    let Some(raw) = storage.load(COMPUTERS.into())? else { return Ok(vec![]) };
    let v: Value = serde_json::from_slice(&raw).map_err(|_| CoreError::storage("the computers item isn't JSON"))?;
    Ok(v.as_array().map(|a| a.iter().filter_map(from_json).collect()).unwrap_or_default())
}

pub fn put(storage: &Arc<dyn SecretStorage>, c: PairedComputer) -> Result<(), CoreError> {
    let mut all = list(storage)?;
    all.retain(|x| x.id != c.id);
    all.push(c);
    save(storage, &all)
}

pub fn remove(storage: &Arc<dyn SecretStorage>, id: &str) -> Result<Option<PairedComputer>, CoreError> {
    let mut all = list(storage)?;
    let gone = all.iter().position(|x| x.id == id).map(|i| all.remove(i));
    save(storage, &all)?;
    Ok(gone)
}

fn save(storage: &Arc<dyn SecretStorage>, all: &[PairedComputer]) -> Result<(), CoreError> {
    let v = Value::Array(all.iter().map(to_json).collect());
    storage.save(COMPUTERS.into(), serde_json::to_vec(&v).expect("JSON"))?;
    Ok(())
}
