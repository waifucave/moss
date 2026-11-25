//! The typed engine calls' decoders (`src/engine.rs`) over the protocol's own examples: the event fixtures the protocol
//! package generates (`packages/protocol/generated/moss/fixtures`), then what a hostile computer may send instead. The
//! method results with no fixture are checked against samples the protocol's own schemas accept in `tests/vectors.rs`
//! (`typed` in `tests/harness/vectors.ts`), and against the real engine in `tests/engine.rs`.

use std::path::PathBuf;

use moss_phone_core::engine::{self, BotState, ItemKind, MessageFrom, SessionKind, SessionStatus};
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/generated/moss/fixtures").join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap()
}

#[test]
fn the_protocols_fixtures_decode() {
    let b = engine::bot(&fixture("bot_changed")["bot"]).expect("bot_changed's bot");
    assert_eq!((b.id.as_str(), b.name.as_str(), b.main_session.as_str()), ("alpha", "Alpha", "s_alpha"));
    assert_eq!(b.model.as_deref(), Some("fireworks/kimi-k3"));
    assert_eq!(b.effort.as_deref(), Some("medium"));
    assert_eq!(b.state, Some(BotState::Idle));
    assert_eq!(b.computer.as_deref(), Some("Studio"));

    let s = engine::summary(&fixture("bot_summary_changed")["summary"]).expect("the summary");
    assert_eq!(s.id, "alpha");
    assert!(s.unread);
    let last = s.last.unwrap();
    assert_eq!((last.text.as_str(), last.from, last.at), ("Done: the report is in your folder.", MessageFrom::Bot, 1781270000000));

    let r = engine::session_row(&fixture("session_changed")["session"]).expect("the session");
    assert_eq!((r.id.as_str(), r.kind, r.status), ("s_agent_1", SessionKind::Agent, SessionStatus::Prompting));
    assert_eq!((r.bot.as_deref(), r.parent.as_deref(), r.computer.as_str()), (Some("alpha"), Some("s_alpha"), "Desktop1"));
    assert_eq!((r.started_at, r.updated_at), (1781269990000, 1781270000000));
    assert_eq!((r.backend.as_deref(), r.root.as_deref()), (Some("claude-code"), Some("home/Desktop1/project1")));

    let item = |n: &str| engine::session_item(&fixture(n)).unwrap_or_else(|| panic!("{n} decodes"));
    let m = item("bot_message");
    assert_eq!((m.id.as_str(), m.session.as_str(), m.seq, m.at), ("s_alpha#12", "s_alpha", 12, 1781270000000));
    assert_eq!(m.kind, ItemKind::FromBot { bot: Some("pack/luna".into()), text: "The deploy finished.".into() });
    assert_eq!(item("note").kind, ItemKind::Note { label: Some("Forecast".into()), text: "Rain after 4 pm.".into() });
    assert_eq!(item("agent_message").kind, ItemKind::Agent { text: "Tests pass; opening the PR next.".into() });
    assert_eq!(item("agent_finished").kind, ItemKind::Agent { text: "Fixed the login bug; PR #12.".into() });
    assert_eq!(item("routine_result").kind, ItemKind::Routine { name: Some("Morning brief".into()), text: "3 new issues, no failed deploys.".into() });
    assert_eq!(item("session_message").kind, ItemKind::FromSession { text: "The API moved to v2; update the client.".into() });
    assert_eq!(item("plugin_message").kind, ItemKind::FromPlugin { text: "Render the next frame.".into() });
}

#[test]
fn what_a_hostile_computer_sends_is_read_safely() {
    // Unknown fields are ignored; unknown kinds and states are `Other`, shown plainly.
    let b = engine::bot(&json!({ "id": "alpha", "name": { "fr": "Alpha" }, "mainSession": "s_alpha", "state": "dreaming\u{202E}", "extra": [1, 2] })).unwrap();
    assert_eq!(b.name, "Alpha");
    assert_eq!(b.state, Some(BotState::Other { value: "dreamingU+202E".into() }));
    let r = engine::session_row(&json!({ "id": "s1", "kind": "space-station", "status": "orbiting", "computer": "Mac", "startedAt": 1, "updatedAt": 2 })).unwrap();
    assert_eq!(r.kind, SessionKind::Other { value: "space-station".into() });
    assert_eq!(r.status, SessionStatus::Other { value: "orbiting".into() });
    let unknown = engine::session_item(&json!({ "type": "tool_call_started", "seq": 3, "sessionId": "s1", "ts": 5 })).unwrap();
    assert_eq!(unknown.kind, ItemKind::Other { kind: "tool_call_started".into() });

    // What identifies an item is never rewritten: an id that isn't one drops the item.
    assert!(engine::bot(&json!({ "id": "../etc", "name": "x", "mainSession": "s1" })).is_none());
    assert!(engine::bot(&json!({ "id": "alpha", "name": "x", "mainSession": "s 1" })).is_none());
    assert!(engine::session_row(&json!({ "id": "s\u{202E}1", "kind": "bot" })).is_none());
    assert!(engine::session_item(&json!({ "type": "note", "seq": -1, "sessionId": "s1" })).is_none());
    assert!(engine::summary(&json!({ "id": 7 })).is_none());

    // Values handed back to the engine are given as they came or not at all; text is drawn with its escapes.
    let r = engine::session_row(&json!({ "id": "s1", "kind": "coding", "status": "idle", "computer": "Mac\u{200B}", "title": "fix\u{202E}it\nnow",
        "model": "gpt\u{200B}5", "root": "home/a\tb", "startedAt": 1.5, "updatedAt": "2" })).unwrap();
    assert_eq!(r.computer, "MacU+200B");
    assert_eq!(r.title.as_deref(), Some("fixU+202Eit\nnow"));
    assert_eq!((r.model, r.root), (None, None));
    assert_eq!((r.started_at, r.updated_at), (0, 0));

    // A page that isn't one fails plainly; items in it that aren't events are left out.
    let rows = engine::models(&json!({ "models": [{ "id": "m1", "name": "M1", "efforts": ["low", 3, "hi\u{202E}"] }, { "name": "no id" }, 5], "default": "m2" }));
    assert_eq!(rows.models.len(), 1);
    assert_eq!(rows.models[0].efforts, ["low"]);
    assert_eq!(rows.default_model, None, "a default that isn't on the list isn't one");

    // A question: kept exactly where its text keys the answer, refused when that text hides a character.
    let q = |text: &str| json!({ "type": "question_asked", "seq": 9, "sessionId": "s1", "ts": 1, "callId": "c1",
        "questions": [{ "question": text, "header": "Pick", "options": [{ "label": "A" }, { "label": "B", "description": "the other" }], "multiSelect": false }] });
    // A question in several lines (a model's often is) is kept exactly: line breaks and tabs are prose.
    let multi = engine::session_item(&q("Which one?\n\nA\tfirst\r\nB\tsecond")).unwrap();
    let ItemKind::QuestionAsked { question: m } = &multi.kind else { panic!("{multi:?}") };
    assert_eq!(m.questions[0].question, "Which one?\n\nA\tfirst\r\nB\tsecond");
    let open = engine::open_questions(&json!({ "open": [{ "callId": "c9", "seq": 1, "askedAt": 2, "questions": [{ "question": "Line one\nline two", "options": [{ "label": "Yes", "description": "first\nsecond" }, { "label": "No" }], "multiSelect": false }] }] })).unwrap();
    assert_eq!(open[0].questions[0].question, "Line one\nline two");
    assert_eq!(open[0].questions[0].options[0].description.as_deref(), Some("first\nsecond"));
    let asked = engine::session_item(&q("Which one?")).unwrap();
    let ItemKind::QuestionAsked { question } = &asked.kind else { panic!("{asked:?}") };
    assert_eq!(question.questions[0].question, "Which one?");
    assert_eq!(question.questions[0].options.len(), 2);
    assert!(engine::session_item(&q("Which\u{202E} one?")).is_none());
    let resolved = engine::session_item(&json!({ "type": "question_resolved", "seq": 10, "sessionId": "s1", "ts": 2, "callId": "c1", "answers": {}, "by": "user" })).unwrap();
    assert!(engine::open_question(std::slice::from_ref(&asked)).is_some());
    let ItemKind::QuestionResolved { by, skipped, to_bot, cause, .. } = &resolved.kind else { panic!("{resolved:?}") };
    assert_eq!((by.as_deref(), *skipped, *to_bot, cause.as_deref()), (Some("user"), false, false, None), "an older-shaped resolution: answered, not skipped");
    assert!(engine::open_question(&[asked, resolved]).is_none());

    // A bot's open question skipped on another device (its skip sent to the bot), and one the engine's stop ended.
    let skipped = engine::session_item(&json!({ "type": "question_resolved", "seq": 11, "sessionId": "s1", "ts": 3, "callId": "c2", "answers": {}, "by": "user", "skipped": true, "toBot": true })).unwrap();
    let ItemKind::QuestionResolved { call_id, skipped: s, to_bot, .. } = &skipped.kind else { panic!("{skipped:?}") };
    assert_eq!((call_id.as_str(), *s, *to_bot), ("c2", true, true));
    let stopped = engine::session_item(&json!({ "type": "question_resolved", "seq": 12, "sessionId": "s1", "ts": 4, "callId": "c3", "answers": {}, "by": "aborted", "cause": "engine-stopped" })).unwrap();
    let ItemKind::QuestionResolved { by, cause, skipped: s, .. } = &stopped.kind else { panic!("{stopped:?}") };
    assert_eq!((by.as_deref(), cause.as_deref(), *s), (Some("aborted"), Some("engine-stopped"), false));
    assert!(engine::session_item(&json!({ "type": "question_resolved", "seq": 13, "sessionId": "s1", "ts": 4, "callId": "c\u{202E}4" })).is_none(), "a hidden character in a call id: not an item");
    // The person's answer as their message names the question it answers; a plain message names none.
    let answer = engine::session_item(&json!({ "type": "user_message", "seq": 14, "sessionId": "s1", "ts": 5, "text": "Green", "answersQuestion": "c2" })).unwrap();
    let ItemKind::User { answers_question, .. } = &answer.kind else { panic!("{answer:?}") };
    assert_eq!(answers_question.as_deref(), Some("c2"));
    let plain = engine::session_item(&json!({ "type": "user_message", "seq": 15, "sessionId": "s1", "ts": 5, "text": "hi" })).unwrap();
    let ItemKind::User { answers_question, .. } = &plain.kind else { panic!("{plain:?}") };
    assert!(answers_question.is_none());

    // Composer offers: limits only when whole.
    let c = engine::composer_offers(&json!({ "kind": "coding", "pictures": true, "files": { "maxBytes": 10 }, "pictureChunks": { "maxBytes": 6, "chunkBytes": 2 },
        "commands": [{ "name": "deploy", "description": { "en": "Ship it" } }], "models": [], "efforts": [] })).unwrap();
    assert!(c.files.is_none());
    assert_eq!(c.picture_chunks.map(|p| p.chunk_bytes), Some(2));
    assert_eq!(c.commands[0].description, "Ship it");
    assert!(engine::composer_offers(&json!([1])).is_err());
}
