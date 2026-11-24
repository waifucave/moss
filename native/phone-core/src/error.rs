//! The core's one error type. Every message is fixed text or names a public thing (a method, a device id, a state):
//! never a key, a seed, a pairing secret, the QR's text or a signature.

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CoreError {
    /// The host app's storage failed or holds something that isn't what the core wrote.
    #[error("storage: {reason}")]
    Storage { reason: String },
    /// Not a pairing code, or one this core can't take.
    #[error("invalid: {reason}")]
    Invalid { reason: String },
    /// The other side refused, or this side refused what the other sent (a proof, a signature, a card).
    #[error("refused: {reason}")]
    Refused { reason: String },
    /// The other side sent something that isn't the protocol.
    #[error("protocol: {reason}")]
    Protocol { reason: String },
    /// No path reached the computer, or the link dropped while a call was in flight.
    #[error("offline: {reason}")]
    Offline { reason: String },
    #[error("timeout: {reason}")]
    Timeout { reason: String },
    /// The engine answered a call with a JSON-RPC error.
    #[error("rpc error {code}: {text}")]
    Rpc { code: i64, text: String, data_json: Option<String> },
    /// This computer revoked this phone: pair again.
    #[error("revoked: {reason}")]
    Revoked { reason: String },
    #[error("closed: {reason}")]
    Closed { reason: String },
    /// A card's hash doesn't match its content: the core signs nothing for it.
    #[error("tampered card: {reason}")]
    TamperedCard { reason: String },
}

impl CoreError {
    pub fn refused(r: impl Into<String>) -> Self {
        CoreError::Refused { reason: r.into() }
    }
    pub fn protocol(r: impl Into<String>) -> Self {
        CoreError::Protocol { reason: r.into() }
    }
    pub fn invalid(r: impl Into<String>) -> Self {
        CoreError::Invalid { reason: r.into() }
    }
    pub fn offline(r: impl Into<String>) -> Self {
        CoreError::Offline { reason: r.into() }
    }
    pub fn storage(r: impl Into<String>) -> Self {
        CoreError::Storage { reason: r.into() }
    }
}

/// What the host app's storage reports when it can't answer. "No such item" is not an error: `load` answers `None`
/// for it. Anything else that keeps an item from being read is an error, so the core never takes "can't read" for
/// "isn't there" (and never makes new keys over keys it couldn't read).
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum StorageError {
    /// The store can't be read right now (the Keychain before the first unlock, the Keystore while the user is locked
    /// out): try again later.
    #[error("not available now: {reason}")]
    NotAvailable { reason: String },
    #[error("{reason}")]
    Failed { reason: String },
}

impl From<StorageError> for CoreError {
    fn from(e: StorageError) -> Self {
        CoreError::Storage { reason: e.to_string() }
    }
}

impl From<uniffi::UnexpectedUniFFICallbackError> for StorageError {
    fn from(e: uniffi::UnexpectedUniFFICallbackError) -> Self {
        StorageError::Failed { reason: e.reason }
    }
}
