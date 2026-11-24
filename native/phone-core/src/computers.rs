//! The computers this phone is paired with: public records (a key, a name, dial hints), kept through the host's
//! storage as one JSON item. The pair's own secrets (its signing key and pair secret) are separate items.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::{error::CoreError, identity::SecretStorage};

pub const COMPUTERS: &str = "computers";

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

/// The storage items a pairing keeps for one computer. The group's id comes from the computer, so its item is named
/// by a hash of it, never by the text itself.
pub fn pair_key_item(pair_id: &str) -> String {
    format!("pair-key:{pair_id}")
}
pub fn pair_secret_item(pair_id: &str) -> String {
    format!("pair-secret:{pair_id}")
}
pub fn group_key_item(group: &str) -> String {
    format!("group-key:{}", &crate::bytes::hex(&crate::keys::sha256(group.as_bytes()))[..32])
}

/// Removes a computer and every item its pairing kept (its pair key and pair secret, and its group's key unless
/// another kept computer is in that group). Returns the record removed.
pub fn forget(storage: &Arc<dyn SecretStorage>, id: &str) -> Result<Option<PairedComputer>, CoreError> {
    let Some(c) = remove(storage, id)? else { return Ok(None) };
    if let Some(p) = &c.pair_id {
        storage.delete(pair_key_item(p))?;
        storage.delete(pair_secret_item(p))?;
    }
    if let Some(g) = &c.group {
        if !list(storage)?.iter().any(|x| x.group.as_deref() == Some(g.as_str())) {
            storage.delete(group_key_item(g))?;
        }
    }
    Ok(Some(c))
}

/// Keeps a completed pairing: its items first, then its record, and only then the items an earlier pairing of the same
/// computer kept and this one doesn't use. A save that fails leaves the earlier pairing whole (never neither); the new
/// items already saved are then deleted again.
pub fn store_pairing(storage: &Arc<dyn SecretStorage>, computer: &PairedComputer, items: Vec<(String, zeroize::Zeroizing<Vec<u8>>)>) -> Result<(), CoreError> {
    let old = list(storage)?.into_iter().find(|c| c.id == computer.id);
    let in_use: Vec<String> = old.iter().flat_map(items_of).collect();
    let mut saved: Vec<String> = vec![];
    let undo = |saved: &[String]| {
        for n in saved.iter().filter(|n| !in_use.contains(n)) {
            let _ = storage.delete(n.clone());
        }
    };
    for (name, mut value) in items {
        if let Err(e) = storage.save(name.clone(), std::mem::take(&mut *value)) {
            undo(&saved);
            return Err(e.into());
        }
        saved.push(name);
    }
    if let Err(e) = put(storage, computer.clone()) {
        undo(&saved);
        return Err(e);
    }
    if let Some(old) = old {
        drop_items(storage, &old, computer)?;
    }
    Ok(())
}

/// The storage items a computer's pairing kept.
fn items_of(c: &PairedComputer) -> Vec<String> {
    let mut v = vec![];
    if let Some(p) = &c.pair_id {
        v.push(pair_key_item(p));
        v.push(pair_secret_item(p));
    }
    if let Some(g) = &c.group {
        v.push(group_key_item(g));
    }
    v
}

/// After `new` replaced `old` (the same computer paired again), deletes the items `old` kept that `new` doesn't use.
pub fn drop_items(storage: &Arc<dyn SecretStorage>, old: &PairedComputer, new: &PairedComputer) -> Result<(), CoreError> {
    if let Some(p) = old.pair_id.as_ref().filter(|p| new.pair_id.as_ref() != Some(*p)) {
        storage.delete(pair_key_item(p))?;
        storage.delete(pair_secret_item(p))?;
    }
    if let Some(g) = old.group.as_ref().filter(|g| new.group.as_ref() != Some(*g)) {
        if !list(storage)?.iter().any(|x| x.group.as_deref() == Some(g.as_str())) {
            storage.delete(group_key_item(g))?;
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::StorageError;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct Store {
        items: Mutex<HashMap<String, Vec<u8>>>,
        fail_on: Mutex<Option<String>>,
    }
    impl SecretStorage for Store {
        fn load(&self, name: String) -> Result<Option<Vec<u8>>, StorageError> {
            Ok(self.items.lock().unwrap().get(&name).cloned())
        }
        fn save(&self, name: String, value: Vec<u8>) -> Result<(), StorageError> {
            if self.fail_on.lock().unwrap().as_deref().is_some_and(|f| name.starts_with(f)) {
                return Err(StorageError::Failed { reason: "full".into() });
            }
            self.items.lock().unwrap().insert(name, value);
            Ok(())
        }
        fn delete(&self, name: String) -> Result<(), StorageError> {
            self.items.lock().unwrap().remove(&name);
            Ok(())
        }
    }

    fn computer(pair: &str, group: &str) -> PairedComputer {
        PairedComputer {
            id: "studio".into(), name: "Studio".into(), public_key: "k".into(), relay: None, addrs: vec![], pair_id: Some(pair.into()),
            group: Some(group.into()), app: PhoneApp::Moss, paired_at: 0,
        }
    }

    fn items(c: &PairedComputer) -> Vec<(String, zeroize::Zeroizing<Vec<u8>>)> {
        items_of(c).into_iter().map(|n| (n, zeroize::Zeroizing::new(vec![1]))).collect()
    }

    #[test]
    fn re_pairing_keeps_the_old_pairing_until_the_new_one_is_whole() {
        let s = Arc::new(Store::default());
        let st: Arc<dyn SecretStorage> = s.clone();
        let first = computer("p1", "g1");
        store_pairing(&st, &first, items(&first)).unwrap();
        // The second pairing's secret can't be saved: the first stays whole, and nothing of the second is left.
        let second = computer("p2", "g2");
        *s.fail_on.lock().unwrap() = Some("pair-secret:p2".into());
        assert!(store_pairing(&st, &second, items(&second)).is_err());
        assert_eq!(list(&st).unwrap(), vec![first.clone()]);
        let mut names: Vec<String> = s.items.lock().unwrap().keys().filter(|k| *k != COMPUTERS).cloned().collect();
        names.sort();
        let mut want = items_of(&first);
        want.sort();
        assert_eq!(names, want);
        // Saved whole, the second replaces the first, and the first's items go.
        *s.fail_on.lock().unwrap() = None;
        store_pairing(&st, &second, items(&second)).unwrap();
        assert_eq!(list(&st).unwrap(), vec![second.clone()]);
        let mut names: Vec<String> = s.items.lock().unwrap().keys().filter(|k| *k != COMPUTERS).cloned().collect();
        names.sort();
        let mut want = items_of(&second);
        want.sort();
        assert_eq!(names, want);
    }
}
