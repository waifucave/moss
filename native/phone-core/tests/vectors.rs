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

    // The typed calls' decoders over results the protocol's own schemas accept (`typed`).
    let t = &v["typed"];
    use moss_phone_core::engine;
    let bots: Vec<_> = t["bot.list"]["bots"].as_array().unwrap().iter().filter_map(engine::bot).collect();
    assert_eq!(bots.len(), 1);
    assert_eq!((bots[0].name.as_str(), bots[0].state.clone()), ("Alpha", Some(engine::BotState::Thinking)));
    let rec = engine::bot(&t["bot.records"]["bots"][0]).unwrap();
    assert_eq!(rec.face.unwrap().shape.as_deref(), Some("drop"));
    let made = engine::bot(&t["bot.create"]["bot"]).unwrap();
    assert_eq!((made.id.as_str(), made.main_session.as_str(), made.state.clone()), ("beta", "s_beta", None));
    let sum = engine::summary(&t["bot.summaries"]["summaries"][0]).unwrap();
    assert_eq!(sum.last.unwrap().from, engine::MessageFrom::User);
    let row = engine::session_row(&t["session.list"]["sessions"][0]).unwrap();
    assert_eq!((row.kind.clone(), row.title.as_deref(), row.changes, row.needs_you.clone().unwrap().cards), (engine::SessionKind::Coding, Some("Fix login"), Some(3), 1));
    let be = engine::backend(&t["agent.backends"]["backends"][0]).unwrap();
    assert_eq!((be.id.as_str(), be.user_startable, be.computers[0].marks.clone()), ("claude-code", true, vec!["unsandboxed".to_string()]));
    let opts = engine::backend_options(&t["agent.options"], "claude-code");
    assert_eq!((opts.models[0].default_effort.as_deref(), opts.default_model.as_deref()), (Some("high"), Some("m1")));
    let rec = engine::recent(&t["agent.recent"]);
    assert_eq!(rec.roots.iter().map(|r| r.root.as_str()).collect::<Vec<_>>(), ["home/Studio/b", "home/Studio/a"]);
    assert_eq!(rec.by_backend[0].backend, "codex");
    let ml = engine::models(&t["models.list"]);
    assert_eq!((ml.models[0].signed_in, ml.default_model.as_deref()), (true, Some("m1")));
    if t["session.composerOffers"].is_object() {
        let c = engine::composer_offers(&t["session.composerOffers"]).unwrap();
        assert_eq!(c.files.unwrap().chunk_bytes, 524288);
    } else {
        eprintln!("this tree has no session.composerOffers yet: checked in tests/typed.rs only");
    }

    // The visible-text rule, from the engine's own function when this tree has it (protocol `visible-text.ts`).
    match v["visible"].as_array() {
        Some(cases) => {
            for c in cases {
                let t = c["text"].as_str().unwrap();
                assert_eq!(moss_phone_core::visible::sealed_escape(t, false), c["plain"].as_str().unwrap(), "escape of {t:?}");
                assert_eq!(moss_phone_core::visible::sealed_escape(t, true), c["name"].as_str().unwrap(), "name escape of {t:?}");
                assert_eq!(moss_phone_core::names::clean_name(t), c["nameOk"].as_bool().unwrap(), "name verdict on {t:?}");
            }
        }
        None => eprintln!("the engine's tree has no visible-text.ts yet: checked against tests/visible_vectors.json only"),
    }

    // The device-name rule (devices/names.ts): the same verdict on every edge case, and the same cleaned name.
    for n in v["names"].as_array().unwrap() {
        let name = n["name"].as_str().unwrap();
        assert_eq!(moss_phone_core::names::clean_name(name), n["ok"].as_bool().unwrap(), "name {name:?}");
    }
    for n in v["safeNames"].as_array().unwrap() {
        assert_eq!(moss_phone_core::names::safe_device_name(n["raw"].as_str().unwrap(), "Phone"), n["safe"].as_str().unwrap(), "safe name of {:?}", n["raw"]);
    }

    // Strict points: the same verdict on each.
    for (name, p) in v["points"].as_object().unwrap() {
        assert_eq!(is_strict_point(&unhex(p["hex"].as_str().unwrap())), p["strict"].as_bool().unwrap(), "point {name}");
    }
}

/// The visible-text rule against vectors the protocol's own `visible-text.ts` produced (`tests/visible_vectors.json`,
/// from `lane/bk-2-cards` at d3b2cb20f over `tests/harness/visible-cases.json`): runs without the engine.
#[test]
fn the_visible_text_rule_matches_the_protocols() {
    let v: Value = serde_json::from_str(include_str!("visible_vectors.json")).unwrap();
    for c in v.as_array().unwrap() {
        let t = c["text"].as_str().unwrap();
        assert_eq!(moss_phone_core::visible::sealed_escape(t, false), c["plain"].as_str().unwrap(), "escape of {t:?}");
        assert_eq!(moss_phone_core::visible::sealed_escape(t, true), c["name"].as_str().unwrap(), "name escape of {t:?}");
    }
}
