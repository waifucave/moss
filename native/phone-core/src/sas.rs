//! The pairing ceremony's crypto, as the engine's `identity/sas.ts` and the statements in `links/handshake.ts` and
//! `devices/registry.ts` have it. Every domain string keeps the old spelling the engine keeps on the wire.

use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::{
    bytes,
    cbor::{encode, Cbor},
    keys::sha256,
};

pub const PAIR_PROOF_JOINER: &str = "clover/pair-proof/joiner/1";
pub const PAIR_PROOF_HOST: &str = "clover/pair-proof/host/1";
pub const PAIR_SAS: &str = "clover/pair-sas/1";
const PAIR_SECRET_INFO: &str = "clover/pair-secret/1";
const PAIR_ID_INFO: &str = "clover/pair-id/1";
const HANDSHAKE_PREFIX: &str = "clover-handshake-v1";
pub const PAIR_NONCE_BYTES: usize = 32;

static WORDS: std::sync::LazyLock<Vec<&'static str>> =
    std::sync::LazyLock::new(|| include_str!("eff_short_wordlist.txt").lines().collect());

/// One side's part of the transcript (`PairSide`).
pub struct PairSide<'a> {
    pub key: &'a [u8],
    /// Its device record, canonical (`canonical_record`).
    pub record: &'a [u8],
    pub pair_key: &'a [u8],
    pub group_key: &'a [u8],
    pub group: Option<&'a str>,
}

fn side_array(s: &PairSide) -> Cbor {
    Cbor::Array(vec![Cbor::bytes(s.key), Cbor::bytes(s.record), Cbor::bytes(s.pair_key), Cbor::bytes(s.group_key), Cbor::opt_text(s.group)])
}

/// The joiner's commitment to its nonce.
pub fn nonce_commitment(nonce: &[u8]) -> [u8; 32] {
    let mut v = b"clover/pair-commit/1".to_vec();
    v.extend_from_slice(nonce);
    sha256(&v)
}

pub fn joiner_transcript(pairing_id: &str, host_key: &[u8], joiner: &PairSide, commit: &[u8]) -> Vec<u8> {
    encode(&Cbor::Array(vec![
        Cbor::text("clover/pair-transcript/joiner/3"),
        Cbor::text(pairing_id),
        Cbor::bytes(host_key),
        side_array(joiner),
        Cbor::bytes(commit),
    ]))
}

/// `t` as the welcome carried it (a number; the engine floors it, so an integer).
pub fn full_transcript(joiner_part: &[u8], host: &PairSide, t: &Cbor, group: &str, host_nonce: &[u8]) -> Vec<u8> {
    encode(&Cbor::Array(vec![
        Cbor::text("clover/pair-transcript/3"),
        Cbor::bytes(joiner_part),
        side_array(host),
        t.clone(),
        Cbor::text(group),
        Cbor::bytes(host_nonce),
    ]))
}

pub fn final_transcript(full: &[u8], joiner_nonce: &[u8]) -> Vec<u8> {
    encode(&Cbor::Array(vec![Cbor::text("clover/pair-transcript/final/1"), Cbor::bytes(full), Cbor::bytes(joiner_nonce)]))
}

pub fn pair_proof(secret: &[u8], domain: &str, transcript: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(domain.as_bytes());
    mac.update(transcript);
    mac.finalize().into_bytes().into()
}

pub fn verify_pair_proof(secret: &[u8], domain: &str, transcript: &[u8], proof: &[u8]) -> bool {
    bytes::ct_eq(&pair_proof(secret, domain, transcript), proof)
}

/// The four words both devices show.
pub fn sas_words(secret: &[u8], transcript: &[u8]) -> Vec<String> {
    let mac = pair_proof(secret, PAIR_SAS, transcript);
    let mut value: u64 = 0;
    for b in &mac[..5] {
        value = (value << 8) | *b as u64;
    }
    (0..4)
        .map(|_| {
            let w = WORDS[(value % 1296) as usize].to_string();
            value /= 1296;
            w
        })
        .collect()
}

fn hkdf32(ikm: &[u8], salt: &[u8], info: &str, out: &mut [u8]) {
    Hkdf::<Sha256>::new(Some(salt), ikm).expand(info.as_bytes(), out).expect("a short HKDF output");
}

/// The pair secret S for the handshake service's boxes.
pub fn derive_pair_secret(secret: &[u8], transcript: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    hkdf32(secret, &sha256(transcript), PAIR_SECRET_INFO, &mut out);
    out
}

/// The pair's id at the handshake service.
pub fn derive_pair_id(pair_secret: &[u8]) -> [u8; 16] {
    let mut out = [0u8; 16];
    hkdf32(pair_secret, &[], PAIR_ID_INFO, &mut out);
    out
}

/// A device record as the transcript has it (`canonicalRecord`).
#[derive(Clone, Debug, PartialEq)]
pub struct RecordFields {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub os: Option<String>,
    pub runs_core: bool,
    pub computer: Option<String>,
    pub has_display: Option<bool>,
    pub public_key: String,
    /// (publicKey, held, alg) — alg "ed25519" unless it says otherwise.
    pub answer_key: Option<(String, String, Option<String>)>,
}

pub fn canonical_record(r: &RecordFields) -> Vec<u8> {
    let ak = match &r.answer_key {
        Some((pk, held, alg)) => Cbor::Array(vec![Cbor::text(pk), Cbor::text(held), Cbor::text(alg.as_deref().unwrap_or("ed25519"))]),
        None => Cbor::Null,
    };
    encode(&Cbor::Array(vec![
        Cbor::text(&r.id),
        Cbor::text(&r.name),
        Cbor::text(&r.kind),
        Cbor::opt_text(r.os.as_deref()),
        Cbor::Bool(r.runs_core),
        Cbor::opt_text(r.computer.as_deref()),
        r.has_display.map(Cbor::Bool).unwrap_or(Cbor::Null),
        Cbor::text(&r.public_key),
        ak,
    ]))
}

/// A JS number as `String(t)` writes it, for an integer `t` (what the engine's statements carry).
pub fn js_number(t: f64) -> String {
    let mut buf = ryu_js::Buffer::new();
    buf.format(t).to_string()
}

pub fn pair_statement(pair: &str, keys: &[String; 2], t: f64) -> Vec<u8> {
    [format!("{HANDSHAKE_PREFIX} pair"), pair.into(), keys[0].clone(), keys[1].clone(), js_number(t)].join("\n").into_bytes()
}

pub fn admit_statement(group: &str, key: &str, t: f64) -> Vec<u8> {
    [format!("{HANDSHAKE_PREFIX} admit"), group.into(), key.into(), js_number(t)].join("\n").into_bytes()
}

/// What an answer key's registration signs (`answerKeyStatement`).
pub fn answer_key_statement(device_id: &str, public_key: &str, held: &str, alg: &str) -> Vec<u8> {
    if alg == "ed25519" {
        format!("clover/answer-key/1\n{device_id}\n{public_key}\n{held}").into_bytes()
    } else {
        format!("clover/answer-key/2\n{device_id}\n{public_key}\n{held}\n{alg}").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordlist() {
        assert_eq!(WORDS.len(), 1296);
        assert_eq!(WORDS[0], "acid");
        assert_eq!(WORDS[1295], "zoom");
    }

    #[test]
    fn numbers_print_as_js() {
        assert_eq!(js_number(1781270000000.0), "1781270000000");
        assert_eq!(js_number(0.0), "0");
        assert_eq!(js_number(1e21), "1e+21");
    }
}
