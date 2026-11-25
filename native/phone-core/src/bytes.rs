//! Byte helpers the engine's `identity/bytes.ts` has: base64 in both alphabets (strict, as the engine parses them),
//! a constant-time comparison and random bytes from the OS.

use base64::{
    alphabet,
    engine::{general_purpose::STANDARD, DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
    Engine,
};

/// Unpadded base64url that refuses padding, like the engine's `fromBase64Url`.
const URL: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_encode_padding(false).with_decode_padding_mode(DecodePaddingMode::RequireNone),
);

/// Standard base64 with padding (`toBase64`).
pub fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Strict standard base64 with padding; None for anything else (`fromBase64`).
pub fn from_b64(text: &str) -> Option<Vec<u8>> {
    STANDARD.decode(text).ok()
}

/// Unpadded base64url (`toBase64Url`).
pub fn b64url(bytes: &[u8]) -> String {
    URL.encode(bytes)
}

/// Strict unpadded base64url (`fromBase64Url`).
pub fn from_b64url(text: &str) -> Option<Vec<u8>> {
    URL.decode(text).ok()
}

/// Equal length and equal bytes, in time that depends only on the length.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// `n` bytes from the OS's generator.
pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the OS random generator failed");
    out
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_alphabets() {
        assert_eq!(b64(&[0xfb, 0xff]), "+/8=");
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(from_b64url("-_8"), Some(vec![0xfb, 0xff]));
        assert_eq!(from_b64url("-_8="), None);
        assert_eq!(from_b64("+/8"), None);
        assert_eq!(from_b64("+/8="), Some(vec![0xfb, 0xff]));
    }
}
