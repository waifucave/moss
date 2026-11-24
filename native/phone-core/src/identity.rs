//! This phone's keys (spec §8.1, item 91): the device's link key (iroh's endpoint id; the device id is derived from it)
//! and its answer key, apart from it, which alone signs card answers. Both are Ed25519 seeds the core makes and keeps
//! only through the host app's `SecretStorage` (the iOS Keychain, the Android Keystore); the core writes no file of its
//! own. Nothing here asks for a biometric or a passcode: the key is protected by where the host keeps it.

use std::sync::Arc;

use crate::{
    bytes,
    error::{CoreError, StorageError},
    keys::{device_id_for, Ed25519Key},
    sas::{answer_key_statement, RecordFields},
};

/// Where the host app keeps the core's items. Values are opaque bytes; the core names each item. Seeds pass through
/// here and nowhere else. A host keeps them in its OS's secret store, as device-only items that never sync.
#[uniffi::export(with_foreign)]
pub trait SecretStorage: Send + Sync {
    fn load(&self, name: String) -> Result<Option<Vec<u8>>, StorageError>;
    fn save(&self, name: String, value: Vec<u8>) -> Result<(), StorageError>;
    fn delete(&self, name: String) -> Result<(), StorageError>;
}

pub const DEVICE_KEY: &str = "device-key";
pub const ANSWER_KEY: &str = "answer-key";

/// Where the host keeps the answer key (`AnswerKeyHolder`). The core holds an Ed25519 seed in memory, so only the OS
/// secret stores that keep such a seed are offered: never `secure-enclave` (that names a P-256 key the enclave signs
/// with, which this core does not hold).
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AnswerKeyHolder {
    /// The iOS Keychain (a device-only item).
    Keychain,
    /// The Android Keystore (the seed wrapped by a Keystore key).
    Keystore,
}

impl AnswerKeyHolder {
    pub fn wire(self) -> &'static str {
        match self {
            AnswerKeyHolder::Keychain => "keychain",
            AnswerKeyHolder::Keystore => "keystore",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum PhoneOs {
    Ios,
    /// The engine's `DeviceOs` has no Android value yet: an Android phone's record leaves `os` out.
    Android,
}

impl PhoneOs {
    pub fn wire(self) -> Option<&'static str> {
        match self {
            PhoneOs::Ios => Some("ios"),
            PhoneOs::Android => None,
        }
    }
}

/// What the app shows about this phone.
#[derive(Clone, Debug, uniffi::Record)]
pub struct PhoneIdentity {
    pub device_id: String,
    /// The link key, base64.
    pub public_key: String,
    /// The answer key, base64.
    pub answer_key: String,
    pub name: String,
}

pub struct Identity {
    pub device: Ed25519Key,
    pub answer: Ed25519Key,
    pub id: String,
    pub name: String,
    pub holder: AnswerKeyHolder,
    pub os: PhoneOs,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Identity({})", self.id)
    }
}

fn load_or_create(storage: &Arc<dyn SecretStorage>, name: &str) -> Result<Ed25519Key, CoreError> {
    if let Some(seed) = storage.load(name.into())? {
        let seed = zeroize::Zeroizing::new(seed);
        return Ed25519Key::from_seed_slice(&seed).ok_or_else(|| CoreError::storage(format!("the stored {name} isn't an Ed25519 seed")));
    }
    let key = Ed25519Key::generate();
    storage.save(name.into(), key.seed().to_vec())?;
    Ok(key)
}

impl Identity {
    pub fn load_or_create(storage: &Arc<dyn SecretStorage>, name: String, holder: AnswerKeyHolder, os: PhoneOs) -> Result<Self, CoreError> {
        let device = load_or_create(storage, DEVICE_KEY)?;
        let answer = load_or_create(storage, ANSWER_KEY)?;
        let id = device_id_for(&device.public());
        Ok(Identity { device, answer, id, name, holder, os })
    }

    pub fn public(&self) -> PhoneIdentity {
        PhoneIdentity {
            device_id: self.id.clone(),
            public_key: bytes::b64(&self.device.public()),
            answer_key: bytes::b64(&self.answer.public()),
            name: self.name.clone(),
        }
    }

    /// This phone's device record, as the pairing hello carries it and the transcript hashes it.
    pub fn record(&self, app: &str) -> RecordFields {
        RecordFields {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: "phone".into(),
            os: self.os.wire().map(str::to_string),
            runs_core: false,
            computer: None,
            has_display: None,
            public_key: bytes::b64(&self.device.public()),
            answer_key: Some((bytes::b64(&self.answer.public()), self.holder.wire().into(), None)),
            app: Some(app.to_string()),
        }
    }

    /// The answer key's registration: its signature over `answerKeyStatement`, base64.
    pub fn answer_key_proof(&self) -> String {
        let stmt = answer_key_statement(&self.id, &bytes::b64(&self.answer.public()), self.holder.wire(), "ed25519");
        bytes::b64(&self.answer.sign(&stmt))
    }
}
