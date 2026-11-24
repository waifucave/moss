//! Keys, as the engine's `identity/keys.ts`, `identity/ed25519-strict.ts` and `deviceIdFor` have them: an Ed25519 key
//! is its 32-byte seed (RFC 8032 signing, deterministic, so both sides' signatures over one input are the same bytes);
//! a peer's key or signature is taken only when strict (a canonical encoding of a point outside the small-order
//! subgroup, S below the group order); an answer key may also be P-256 (ECDSA over SHA-256, raw r‖s).

use curve25519_dalek::edwards::CompressedEdwardsY;
use ed25519_dalek::{Signature, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::bytes;

/// An Ed25519 key held in memory. Its seed leaves only for the host's storage; Debug never shows it.
pub struct Ed25519Key {
    seed: Zeroizing<[u8; 32]>,
    signing: SigningKey,
}

impl std::fmt::Debug for Ed25519Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Ed25519Key({})", bytes::b64(&self.public()))
    }
}

impl Ed25519Key {
    pub fn generate() -> Self {
        Self::from_seed(&Zeroizing::new(bytes::random::<32>()))
    }
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let seed = Zeroizing::new(*seed);
        let signing = SigningKey::from_bytes(&seed);
        Ed25519Key { seed, signing }
    }
    pub fn from_seed_slice(seed: &[u8]) -> Option<Self> {
        let arr: [u8; 32] = seed.try_into().ok()?;
        let k = Self::from_seed(&arr);
        let mut arr = arr;
        zeroize::Zeroize::zeroize(&mut arr);
        Some(k)
    }
    pub fn public(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }
    pub fn sign(&self, data: &[u8]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        self.signing.sign(data).to_bytes()
    }
    /// The seed, for the host's storage only.
    pub fn seed(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.seed.to_vec())
    }
}

const P: [u8; 32] = {
    // 2^255 - 19, little-endian.
    let mut p = [0xffu8; 32];
    p[0] = 0xed;
    p[31] = 0x7f;
    p
};

/// Little-endian `a < b` for 32-byte numbers.
fn lt_le(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    false
}

/// Whether 32 bytes are a canonical encoding of a curve point outside the small-order subgroup (`isStrictEd25519Point`).
pub fn is_strict_point(bytes: &[u8]) -> bool {
    let Ok(arr) = <[u8; 32]>::try_from(bytes) else { return false };
    let mut y = arr;
    y[31] &= 0x7f;
    // y must be below p (a non-canonical y is refused); x = 0 with the sign bit set is non-canonical too, and every
    // x = 0 point (y = ±1) is of small order anyway, so the small-order check below refuses it.
    if !lt_le(&y, &P) {
        return false;
    }
    match CompressedEdwardsY(arr).decompress() {
        Some(pt) => !pt.is_small_order(),
        None => false,
    }
}

/// The group order L, little-endian.
const L: [u8; 32] = [
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0x10,
];

/// Whether a signature's R is a strict point and its S is below the group order (`isStrictEd25519Signature`).
pub fn is_strict_signature(sig: &[u8]) -> bool {
    if sig.len() != 64 {
        return false;
    }
    let s: [u8; 32] = sig[32..].try_into().unwrap();
    lt_le(&s, &L) && is_strict_point(&sig[..32])
}

/// Strict Ed25519 verification (`verifyEd25519`): false for any malformed input.
pub fn verify_ed25519(public: &[u8], data: &[u8], sig: &[u8]) -> bool {
    if !is_strict_point(public) || !is_strict_signature(sig) {
        return false;
    }
    let Ok(vk) = VerifyingKey::from_bytes(public.try_into().unwrap()) else { return false };
    let sig = Signature::from_bytes(sig.try_into().unwrap());
    vk.verify_strict(data, &sig).is_ok()
}

/// An answer key's algorithm (`AnswerKeyAlg`; absent means ed25519).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnswerKeyAlg {
    Ed25519,
    P256,
}

impl AnswerKeyAlg {
    pub fn name(self) -> &'static str {
        match self {
            AnswerKeyAlg::Ed25519 => "ed25519",
            AnswerKeyAlg::P256 => "p256",
        }
    }
}

/// An answer key's raw public key from its base64 (`answerKeyBytes`): 32 strict bytes, or a 65-byte uncompressed point.
pub fn answer_key_bytes(alg: AnswerKeyAlg, text: &str) -> Option<Vec<u8>> {
    let raw = bytes::from_b64(text)?;
    match alg {
        AnswerKeyAlg::P256 => (raw.len() == 65 && raw[0] == 0x04).then_some(raw),
        AnswerKeyAlg::Ed25519 => (raw.len() == 32 && is_strict_point(&raw)).then_some(raw),
    }
}

/// A signature with the key's own algorithm (`verifyKeySignature`).
pub fn verify_key_signature(alg: AnswerKeyAlg, public: &[u8], data: &[u8], sig: &[u8]) -> bool {
    match alg {
        AnswerKeyAlg::Ed25519 => verify_ed25519(public, data, sig),
        AnswerKeyAlg::P256 => {
            use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
            if public.len() != 65 || public[0] != 0x04 || sig.len() != 64 {
                return false;
            }
            let Ok(vk) = VerifyingKey::from_sec1_bytes(public) else { return false };
            let Ok(sig) = Signature::from_slice(sig) else { return false };
            vk.verify(data, &sig).is_ok()
        }
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// A device id: lowercase base32 of the first 20 bytes of SHA-256 over its public key (`deviceIdFor`).
pub fn device_id_for(public: &[u8]) -> String {
    const A: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let digest = sha256(public);
    let mut out = String::with_capacity(32);
    let (mut bits, mut value) = (0u32, 0u32);
    for &b in &digest[..20] {
        value = (value << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(A[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(A[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc8032_vector_and_strictness() {
        // RFC 8032 §7.1, test 1.
        let seed: [u8; 32] = core::array::from_fn(|i| {
            u8::from_str_radix(&"9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"[i * 2..i * 2 + 2], 16).unwrap()
        });
        let k = Ed25519Key::from_seed(&seed);
        assert_eq!(bytes::hex(&k.public()), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        let sig = k.sign(b"");
        assert!(verify_ed25519(&k.public(), b"", &sig));
        assert!(!verify_ed25519(&k.public(), b"x", &sig));
        // The identity point and a non-canonical y are refused.
        let mut ident = [0u8; 32];
        ident[0] = 1;
        assert!(!is_strict_point(&ident));
        assert!(!is_strict_point(&P));
        // S at or past L is refused.
        let mut high = sig;
        high[32..].copy_from_slice(&L);
        assert!(!is_strict_signature(&high));
        assert!(format!("{k:?}").starts_with("Ed25519Key("));
    }
}
