//! Byte-for-byte agreement with the engine: tests/harness/vectors.ts prints what the engine's own functions make of
//! fixed inputs, and each is rebuilt here with the phone core. Needs `bun` with the workspace installed (MOSS_PC_BUN,
//! default the repo's scripts/pinned-bun); skipped without MOSS_PC_ENGINE_TESTS=1.

use std::path::PathBuf;

use moss_phone_core::{
    bytes::hex,
    cards,
    cbor::{encode, Cbor},
    keys::{device_id_for, is_strict_point, Ed25519Key},
    sas::{self, PairSide, RecordFields},
};
use serde_json::Value;

fn seq(n: usize, start: usize) -> Vec<u8> {
    (0..n).map(|i| ((start + i * 7) & 0xff) as u8).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn engine_vectors() -> Option<Value> {
    if std::env::var("MOSS_PC_ENGINE_TESTS").as_deref() != Ok("1") {
        return None;
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
    let bun = std::env::var("MOSS_PC_BUN").map(PathBuf::from).unwrap_or_else(|_| repo.join("scripts/pinned-bun"));
    let out = std::process::Command::new(bun).arg(repo.join("native/phone-core/tests/harness/vectors.ts")).current_dir(&repo).output().expect("bun");
    assert!(out.status.success(), "vectors.ts: {}", String::from_utf8_lossy(&out.stderr));
    Some(serde_json::from_slice(&out.stdout).unwrap())
}

#[test]
fn the_phone_core_builds_the_engines_bytes() {
    let Some(v) = engine_vectors() else { return };
    let s = |k: &str| v[k].as_str().unwrap().to_string();

    // CBOR: integers at every head size, JS's float cases, maps in the order written.
    let n = Cbor::number;
    let sample = Cbor::Array(vec![
        Cbor::text("x"), n(0.0), n(23.0), n(24.0), n(255.0), n(256.0), n(65535.0), n(65536.0), n(4294967295.0), n(4294967296.0),
        n(1781270000123.0), n(-1.0), n(-24.0), n(-25.0), n(-4294967297.0), n(1.5), n(-0.0), n(9007199254740992.0), Cbor::Null,
        Cbor::Undefined, Cbor::Bool(true), Cbor::Bool(false), Cbor::bytes([1, 2]),
        Cbor::map(vec![("b", n(1.0)), ("a", Cbor::Array(vec![]))]), Cbor::text("é😀"),
    ]);
    assert_eq!(hex(&encode(&sample)), s("cbor"));

    // Keys: the same public key, device id and (deterministic) signature from one seed.
    let key = Ed25519Key::from_seed_slice(&unhex(&s("seed"))).unwrap();
    assert_eq!(hex(&key.public()), s("publicKey"));
    assert_eq!(device_id_for(&key.public()), s("deviceId"));
    assert_eq!(hex(&key.sign(&unhex(&s("message")))), s("signature"));

    // The pairing's transcripts, proofs, words and pair credential.
    let commit = sas::nonce_commitment(&[9u8; 32]);
    assert_eq!(hex(&commit), s("commit"));
    let phone = RecordFields {
        id: "phoneid".into(), name: "Phone ü".into(), kind: "phone".into(), os: Some("ios".into()), runs_core: false, computer: None, has_display: None,
        public_key: "cGhvbmU=".into(), answer_key: Some(("YWs=".into(), "keychain".into(), None)), app: None,
    };
    let host = RecordFields {
        id: "hostid".into(), name: "Studio".into(), kind: "desktop".into(), os: Some("macos".into()), runs_core: true, computer: Some("Studio".into()),
        has_display: Some(true), public_key: "aG9zdA==".into(), answer_key: Some(("cDI1Ng==".into(), "app-keychain".into(), Some("p256".into()))), app: None,
    };
    let bare = RecordFields {
        id: "x".into(), name: "y".into(), kind: "phone".into(), os: None, runs_core: false, computer: None, has_display: None, public_key: "eg==".into(), answer_key: None,
        app: None,
    };
    // A phone's app, the record's tenth item (both values); without it the record encodes as before (`phone`, `bare`).
    for app in ["moss", "code"] {
        let with = RecordFields { app: Some(app.into()), ..phone.clone() };
        assert_eq!(hex(&sas::canonical_record(&with)), v["records"][app].as_str().unwrap(), "record with app {app}");
    }
    let (rp, rh) = (sas::canonical_record(&phone), sas::canonical_record(&host));
    assert_eq!(hex(&rp), v["records"]["phone"].as_str().unwrap());
    assert_eq!(hex(&rh), v["records"]["host"].as_str().unwrap());
    assert_eq!(hex(&sas::canonical_record(&bare)), v["records"]["bare"].as_str().unwrap());
    let host_key = Ed25519Key::from_seed_slice(&seq(32, 101)).unwrap();
    assert_eq!(hex(&host_key.public()), s("hostPublicKey"));
    let (pk, gk, hpk, hgk) = (seq(32, 11), seq(32, 13), seq(32, 17), seq(32, 19));
    let joiner_side = PairSide { key: &key.public(), record: &rp, pair_key: &pk, group_key: &gk, group: None };
    let host_side = PairSide { key: &host_key.public(), record: &rh, pair_key: &hpk, group_key: &hgk, group: None };
    let joiner = sas::joiner_transcript("pairing-id_1", &host_key.public(), &joiner_side, &commit);
    assert_eq!(hex(&joiner), s("joiner"));
    let full = sas::full_transcript(&joiner, &host_side, &Cbor::number(1781270000123.0), "group-1", &[21u8; 32]);
    assert_eq!(hex(&full), s("full"));
    let fin = sas::final_transcript(&full, &[9u8; 32]);
    assert_eq!(hex(&fin), s("final"));
    let secret = unhex(&s("secret"));
    assert_eq!(hex(&sas::pair_proof(&secret, sas::PAIR_PROOF_JOINER, &joiner)), s("proofJoiner"));
    assert_eq!(hex(&sas::pair_proof(&secret, sas::PAIR_PROOF_HOST, &full)), s("proofHost"));
    assert_eq!(serde_json::to_value(sas::sas_words(&secret, &fin)).unwrap(), v["words"]);
    let pair_secret = sas::derive_pair_secret(&secret, &fin);
    assert_eq!(hex(&pair_secret), s("pairSecret"));
    assert_eq!(hex(&sas::derive_pair_id(&pair_secret)), s("pairId"));
    assert_eq!(hex(&sas::pair_statement("pairid", &["k1".into(), "k2".into()], 1781270000123.0)), s("pairStatement"));
    assert_eq!(hex(&sas::admit_statement("group-1", "gk", 1781270000123.0)), s("admitStatement"));
    assert_eq!(hex(&sas::answer_key_statement("dev", "pk", "keychain", "ed25519")), s("answerKeyEd"));
    assert_eq!(hex(&sas::answer_key_statement("dev", "pk", "secure-enclave", "p256")), s("answerKeyP256"));

    // Cards: canonical JSON (UTF-16 key order, JS numbers and escapes), the hash, the signing input.
    let card: Value = serde_json::from_str(&s("card")).unwrap();
    assert_eq!(cards::canonical_json(&card), s("canonical"));
    assert_eq!(cards::card_hash(&card).unwrap(), s("cardHash"));
    let children: Vec<String> = ["zeta", "Alpha", "beta", "\u{e000}", "😀"].iter().map(|x| x.to_string()).collect();
    assert_eq!(cards::card_answer_signing_input("card_x", "ab", "approve", 1781270000000, &children), s("signingInput"));

    // A user message: its hash and what the phone signs for it.
    assert_eq!(cards::user_message_hash("Hi \"there\"\n😀", &["bots/a/staged/1.png".into()], &["home/notes.md".into(), "bots/a/x.txt".into()]), s("userMessageHash"));
    assert_eq!(cards::user_message_signing_input("s_alpha", "m-1", "ab", 1781270000123), s("userMessageInput"));

    // Strict points: the same verdict on each.
    for (name, p) in v["points"].as_object().unwrap() {
        assert_eq!(is_strict_point(&unhex(p["hex"].as_str().unwrap())), p["strict"].as_bool().unwrap(), "point {name}");
    }
}
