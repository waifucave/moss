//! The engine's calls both phone apps make, typed: the ONE place that reads the engine's JSON for them
//! (`packages/protocol/src`: `bots.ts`, `sessions.ts`, `agents.ts`, `events.ts`, `plugins.ts`).
//!
//! Decoding is defensive and never panics across the FFI: an unknown field is ignored; an unknown kind or state is an
//! `Other { value }` case; an item missing what identifies it (its id) or holding an id that isn't one is dropped;
//! a malformed answer as a whole is `CoreError::Protocol`. Text a person reads (names, titles, messages, labels) is
//! drawn by the one visible-text rule (`visible::sealed_escape`, hidden characters as escapes) and capped. A value the
//! phone hands back to the engine (an id, a model, an effort, a folder) is never rewritten: one that isn't clean is
//! dropped instead. `tests/vectors.rs` decodes the protocol's own fixtures and schema-checked samples with these.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::cards::{is_bot_id, is_session_id};
use crate::error::CoreError;
use crate::visible::{sealed_escape, unshown};

// ---------------------------------------------------------------------------------------------------------------
// Readers that never throw
// ---------------------------------------------------------------------------------------------------------------

fn get<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.get(k).filter(|x| !x.is_null())
}

fn raw_str<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    get(v, k).and_then(Value::as_str)
}

/// Display text: a string, or a `Text` map by language (`en`, else the first string), drawn by the visible-text rule.
fn text_of(v: Option<&Value>, max: usize) -> Option<String> {
    let s = match v? {
        Value::String(s) => s.as_str(),
        Value::Object(m) => m.get("en").and_then(Value::as_str).or_else(|| m.values().find_map(Value::as_str))?,
        _ => return None,
    };
    // Cut before escaping, so an escape is never cut in half.
    Some(sealed_escape(&s.chars().take(max).collect::<String>(), false))
}

/// A hidden character prose can't hold: the visible-text rule's set less tab, line feed and carriage return.
fn prose_unshown(c: char) -> bool {
    !matches!(c, '\t' | '\n' | '\r') && unshown(c)
}

fn text(v: &Value, k: &str, max: usize) -> Option<String> {
    text_of(get(v, k), max)
}

/// A protocol value the phone may hand back (a model, an effort, a backend, a folder): as it came, or None when it
/// holds a hidden character or is longer than the protocol allows.
fn value(v: &Value, k: &str, max_units: usize) -> Option<String> {
    let s = raw_str(v, k)?;
    (!s.is_empty() && s.encode_utf16().count() <= max_units && !s.chars().any(unshown)).then(|| s.to_string())
}

fn int(v: &Value, k: &str) -> Option<i64> {
    let n = get(v, k)?;
    n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15).map(|f| f as i64))
}

fn boolean(v: &Value, k: &str) -> Option<bool> {
    get(v, k).and_then(Value::as_bool)
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    get(v, k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn strings(v: &Value, k: &str, max_units: usize) -> Vec<String> {
    arr(v, k).iter().filter_map(|x| x.as_str()).filter(|s| !s.is_empty() && s.encode_utf16().count() <= max_units && !s.chars().any(unshown)).map(str::to_string).collect()
}

/// An enum value we don't know, kept for the app to show plainly.
fn other(s: &str) -> String {
    sealed_escape(&s.chars().take(64).collect::<String>(), false)
}

fn answer_of(r: &Value, what: &str) -> Result<(), CoreError> {
    if r.is_object() {
        Ok(())
    } else {
        Err(CoreError::protocol(format!("the computer's answer to {what} isn't one")))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum BotState {
    Idle,
    Thinking,
    Asleep,
    Paused,
    Other { value: String },
}

impl BotState {
    fn of(s: &str) -> Self {
        match s {
            "idle" => Self::Idle,
            "thinking" => Self::Thinking,
            "asleep" => Self::Asleep,
            "paused" => Self::Paused,
            x => Self::Other { value: other(x) },
        }
    }
}

/// A bot's face pins (`BotFace`), as plain values the app maps to its drawing (unknown ones it ignores).
#[derive(Clone, Debug, Default, PartialEq, uniffi::Record)]
pub struct BotFace {
    pub shape: Option<String>,
    pub color: Option<String>,
    pub eyes: Option<String>,
    pub temper: Option<String>,
}

fn face(v: Option<&Value>) -> Option<BotFace> {
    let v = v?;
    v.is_object().then(|| BotFace { shape: value(v, "shape", 32), color: value(v, "color", 64), eyes: value(v, "eyes", 32), temper: value(v, "temper", 32) })
}

/// A bot (`BotView` from `bot.list` and `bot_changed`; `BotRecordView` from `bot.create`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub face: Option<BotFace>,
    /// None for a record that says no state (a bot just made reads as idle to the app).
    pub state: Option<BotState>,
    pub computer: Option<String>,
    pub main_session: String,
}

pub fn bot(v: &Value) -> Option<Bot> {
    let id = raw_str(v, "id").filter(|i| is_bot_id(i))?.to_string();
    let main_session = raw_str(v, "mainSession").filter(|s| is_session_id(s))?.to_string();
    Some(Bot {
        name: text(v, "name", 200).unwrap_or_else(|| id.clone()),
        model: value(v, "model", 200),
        effort: value(v, "effort", 32),
        face: face(get(v, "face")),
        state: raw_str(v, "state").map(BotState::of),
        computer: text(v, "computer", 63),
        id,
        main_session,
    })
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum MessageFrom {
    User,
    Bot,
    Note,
    Other { value: String },
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct BotLast {
    pub text: String,
    pub from: MessageFrom,
    pub at: i64,
}

/// A bot's row in the list (`bot.summaries`, `bot_summary_changed`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct BotSummary {
    pub id: String,
    pub last: Option<BotLast>,
    pub unread: bool,
}

pub fn summary(v: &Value) -> Option<BotSummary> {
    let id = raw_str(v, "id").filter(|i| is_bot_id(i))?.to_string();
    let last = get(v, "last").and_then(|l| {
        Some(BotLast {
            text: text(l, "text", 400)?,
            from: match raw_str(l, "from").unwrap_or("note") {
                "user" => MessageFrom::User,
                "bot" => MessageFrom::Bot,
                "note" => MessageFrom::Note,
                x => MessageFrom::Other { value: other(x) },
            },
            at: int(l, "at")?,
        })
    });
    Some(BotSummary { id, last, unread: boolean(v, "unread").unwrap_or(false) })
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum SessionKind {
    Bot,
    SideThread,
    Agent,
    Coding,
    Other { value: String },
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum SessionStatus {
    Starting,
    Ready,
    Prompting,
    Cancelling,
    Idle,
    Stopped,
    Failed,
    Other { value: String },
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct NeedsYou {
    pub cards: i64,
    pub questions: i64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Waiting {
    pub tasks: i64,
    pub children: i64,
}

/// A session's row (`SessionView`, from `session.list`, `session.get` and `session_changed`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SessionRow {
    pub id: String,
    pub kind: SessionKind,
    pub bot: Option<String>,
    pub parent: Option<String>,
    pub computer: String,
    pub title: Option<String>,
    pub status: SessionStatus,
    /// `sign-in`, `crashed`, `stalled`, `error`, or another the app shows plainly.
    pub failure: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    pub backend: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Its folder (the computer's folder-tree path), as given.
    pub root: Option<String>,
    pub branch: Option<String>,
    pub changes: Option<i64>,
    pub needs_you: Option<NeedsYou>,
    pub waiting: Option<Waiting>,
    pub archived: bool,
}

pub fn session_row(v: &Value) -> Option<SessionRow> {
    let id = raw_str(v, "id").filter(|i| is_session_id(i))?.to_string();
    let kind = match raw_str(v, "kind").unwrap_or("") {
        "bot" => SessionKind::Bot,
        "side-thread" => SessionKind::SideThread,
        "agent" => SessionKind::Agent,
        "coding" => SessionKind::Coding,
        x => SessionKind::Other { value: other(x) },
    };
    let status = match raw_str(v, "status").unwrap_or("") {
        "starting" => SessionStatus::Starting,
        "ready" => SessionStatus::Ready,
        "prompting" => SessionStatus::Prompting,
        "cancelling" => SessionStatus::Cancelling,
        "idle" => SessionStatus::Idle,
        "stopped" => SessionStatus::Stopped,
        "failed" => SessionStatus::Failed,
        x => SessionStatus::Other { value: other(x) },
    };
    Some(SessionRow {
        kind,
        bot: raw_str(v, "bot").filter(|b| is_bot_id(b)).map(str::to_string),
        parent: raw_str(v, "parent").filter(|p| is_session_id(p)).map(str::to_string),
        computer: text(v, "computer", 63).unwrap_or_default(),
        title: text(v, "title", 200),
        status,
        failure: raw_str(v, "failure").map(other),
        started_at: int(v, "startedAt").unwrap_or(0),
        updated_at: int(v, "updatedAt").unwrap_or(0),
        backend: value(v, "backend", 128),
        model: value(v, "model", 200),
        effort: value(v, "effort", 32),
        root: value(v, "root", 4096),
        branch: text(v, "branch", 256),
        changes: int(v, "changes"),
        needs_you: get(v, "needsYou").map(|n| NeedsYou { cards: int(n, "cards").unwrap_or(0), questions: int(n, "questions").unwrap_or(0) }),
        waiting: get(v, "waiting").map(|w| Waiting { tasks: int(w, "tasks").unwrap_or(0), children: int(w, "children").unwrap_or(0) }),
        archived: boolean(v, "archived").unwrap_or(false),
        id,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// A session's log: what a conversation shows
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
    /// A preview drawn beside the option (a diff, a scheme), when it has one.
    pub preview: Option<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct Question {
    /// The question's text; `answer_question` keys each answer by it, exactly as the engine sent it.
    pub question: String,
    pub header: Option<String>,
    /// Empty: answered by typing alone; otherwise a menu, with a free-text box too.
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    pub placeholder: Option<String>,
}

/// A question waiting in a conversation (`question_asked`), answered by `answer_question`.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AskQuestion {
    pub call_id: String,
    pub questions: Vec<Question>,
    /// The log record that asked it, and when.
    pub seq: u64,
    pub asked_at: i64,
}

/// What one event of a session's log is, for a conversation. Kinds a conversation doesn't draw (tool calls, deltas,
/// status records) are `Other` with their type, never dropped silently.
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum ItemKind {
    /// The person's message (`user_message`); `device` names the device it came from, when the engine says.
    User { text: String, device: Option<String> },
    /// The bot's or the agent's reply (`assistant_message`).
    Assistant { text: String },
    /// A message from another bot (`bot_message`).
    FromBot { bot: Option<String>, text: String },
    /// A message from another session (`session_message`).
    FromSession { text: String },
    /// A plugin's message (`plugin_message`).
    FromPlugin { text: String },
    /// An agent's message or its last word (`agent_message`, `agent_finished`).
    Agent { text: String },
    /// A routine's result (`routine_result`).
    Routine { name: Option<String>, text: String },
    /// A note (`note`).
    Note { label: Option<String>, text: String },
    /// Something went wrong in the turn (`agent_error`).
    TurnError { text: String },
    /// A turn ended (`turn_completed`): `end_turn`, `aborted`, `error`.
    TurnEnded { reason: String },
    QuestionAsked { question: AskQuestion },
    QuestionResolved { call_id: String },
    Other { kind: String },
}

/// One event of a session's log.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct SessionItem {
    /// `<session>#<seq>`: the same in a page and live.
    pub id: String,
    pub session: String,
    pub seq: u64,
    pub at: i64,
    /// It reached the log late (`late`): it happened earlier than its place says.
    pub late: bool,
    pub kind: ItemKind,
}

const MESSAGE_MAX: usize = 1_000_000;

/// The questions of an `AskUserQuestion` (`question_asked`, or one of `session.openQuestions`' `open`).
fn ask(v: &Value, seq: u64, asked_at: i64) -> Option<AskQuestion> {
    let call_id = raw_str(v, "callId").filter(|c| !c.is_empty() && c.len() <= 128 && !c.chars().any(unshown))?.to_string();
    let questions: Vec<Question> = arr(v, "questions")
        .iter()
        .take(4)
        .filter_map(|q| {
            // The question's own text keys its answer: kept exactly. It is prose, so tab, line feed and carriage return
            // are its own (as the visible-text rule keeps them); any other hidden character refuses it.
            let question = raw_str(q, "question").filter(|t| !t.is_empty() && t.len() <= 10_000 && !t.chars().any(prose_unshown))?.to_string();
            Some(Question {
                question,
                header: text(q, "header", 12),
                options: arr(q, "options")
                    .iter()
                    .take(4)
                    .filter_map(|o| Some(QuestionOption { label: text(o, "label", 200)?, description: text(o, "description", 1000), preview: text(o, "preview", 4000) }))
                    .collect(),
                multi_select: boolean(q, "multiSelect").unwrap_or(false),
                placeholder: text(q, "placeholder", 80),
            })
        })
        .collect();
    (!questions.is_empty()).then_some(AskQuestion { call_id, questions, seq, asked_at })
}

/// `session.openQuestions`' answer: the open questions in the order asked (at most 4).
pub fn open_questions(r: &Value) -> Result<Vec<AskQuestion>, CoreError> {
    answer_of(r, "session.openQuestions")?;
    Ok(arr(r, "open").iter().take(4).filter_map(|o| ask(o, get(o, "seq").and_then(Value::as_u64)?, int(o, "askedAt").unwrap_or(0))).collect())
}

pub fn session_item(v: &Value) -> Option<SessionItem> {
    let kind_name = raw_str(v, "type")?;
    let session = raw_str(v, "sessionId").filter(|s| is_session_id(s))?.to_string();
    let seq = get(v, "seq").and_then(Value::as_u64)?;
    let msg = |k: &str| text(v, k, MESSAGE_MAX);
    let kind = match kind_name {
        "user_message" => ItemKind::User { text: msg("text")?, device: value(v, "device", 64) },
        "assistant_message" => ItemKind::Assistant { text: msg("text")? },
        "bot_message" => ItemKind::FromBot { bot: raw_str(v, "from").filter(|b| is_bot_id(b)).map(str::to_string), text: msg("text")? },
        "session_message" => ItemKind::FromSession { text: msg("text")? },
        "plugin_message" => ItemKind::FromPlugin { text: msg("text")? },
        "agent_message" | "agent_finished" => ItemKind::Agent { text: msg("text").unwrap_or_default() },
        "routine_result" => ItemKind::Routine { name: text(v, "name", 200), text: msg("text").unwrap_or_default() },
        "note" => ItemKind::Note { label: text(v, "label", 200).filter(|l| !l.trim().is_empty()), text: msg("text").unwrap_or_default() },
        "agent_error" => ItemKind::TurnError { text: text(v, "message", 2000).unwrap_or_default() },
        "turn_completed" => ItemKind::TurnEnded { reason: raw_str(v, "stopReason").map(other).unwrap_or_default() },
        "question_asked" => ItemKind::QuestionAsked { question: ask(v, seq, int(v, "ts").unwrap_or(0))? },
        "question_resolved" => ItemKind::QuestionResolved { call_id: raw_str(v, "callId").filter(|c| !c.is_empty() && c.len() <= 128 && !c.chars().any(unshown))?.to_string() },
        x => ItemKind::Other { kind: other(x) },
    };
    Some(SessionItem { id: format!("{session}#{seq}"), session, seq, at: int(v, "ts").unwrap_or(0), late: boolean(v, "late").unwrap_or(false), kind })
}

/// A page of a conversation's log, oldest first (`bot.conversation`, `session.history`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct MessagePage {
    pub session: String,
    pub items: Vec<SessionItem>,
    pub has_more: bool,
}

fn page(r: &Value, session: Option<String>) -> Result<MessagePage, CoreError> {
    answer_of(r, "the page")?;
    let session = session.or_else(|| raw_str(r, "session").filter(|s| is_session_id(s)).map(str::to_string)).ok_or_else(|| CoreError::protocol("the page names no session"))?;
    let items = arr(r, "events").iter().filter_map(session_item).collect();
    Ok(MessagePage { session, items, has_more: boolean(r, "hasMore").unwrap_or(false) })
}

/// The question still open in a page (`question_asked` with no `question_resolved` after it in the page).
pub fn open_question(items: &[SessionItem]) -> Option<AskQuestion> {
    let resolved: std::collections::HashSet<&str> =
        items.iter().filter_map(|i| if let ItemKind::QuestionResolved { call_id } = &i.kind { Some(call_id.as_str()) } else { None }).collect();
    items.iter().rev().find_map(|i| match &i.kind {
        ItemKind::QuestionAsked { question } if !resolved.contains(question.call_id.as_str()) => Some(question.clone()),
        _ => None,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Starting a coding session, models, the composer
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct BackendComputer {
    pub computer: String,
    pub installed: bool,
    pub version: Option<String>,
    pub sandboxed: Option<bool>,
    /// What to warn about (`stores-plain-text`, `unsandboxed`, ...), as given.
    pub marks: Vec<String>,
}

/// An agent backend (`agent.backends`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentBackend {
    pub id: String,
    pub name: String,
    pub plugin_id: Option<String>,
    /// `acp`, `cloud`, or another.
    pub protocol: String,
    /// `local`, `cloud`, or another.
    pub placement: String,
    pub user_startable: bool,
    pub computers: Vec<BackendComputer>,
}

pub fn backend(v: &Value) -> Option<AgentBackend> {
    let id = value(v, "id", 128)?;
    Some(AgentBackend {
        name: text(v, "name", 200).unwrap_or_else(|| id.clone()),
        plugin_id: raw_str(v, "pluginId").filter(|p| is_bot_id(p)).map(str::to_string),
        protocol: raw_str(v, "protocol").map(other).unwrap_or_default(),
        placement: raw_str(v, "placement").map(other).unwrap_or_default(),
        user_startable: boolean(v, "userStartable").unwrap_or(false),
        computers: arr(v, "computers")
            .iter()
            .filter_map(|c| {
                Some(BackendComputer {
                    computer: value(c, "computer", 63)?,
                    installed: boolean(c, "installed").unwrap_or(false),
                    version: text(c, "version", 64),
                    sandboxed: boolean(c, "sandboxed"),
                    marks: strings(c, "marks", 64),
                })
            })
            .collect(),
        id,
    })
}

/// A model on offer, with its effort levels.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ModelOption {
    pub id: String,
    pub name: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

fn model_option(m: &Value) -> Option<ModelOption> {
    let id = value(m, "id", 200)?;
    Some(ModelOption { name: text(m, "name", 200).unwrap_or_else(|| id.clone()), efforts: strings(m, "efforts", 32), default_effort: value(m, "defaultEffort", 32), id })
}

/// What a backend may be started with (`agent.options`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct BackendOptions {
    pub backend: String,
    pub known: bool,
    pub models: Vec<ModelOption>,
    pub efforts: Vec<String>,
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
}

pub fn backend_options(r: &Value, asked: &str) -> BackendOptions {
    let d = get(r, "default");
    BackendOptions {
        backend: value(r, "backend", 128).unwrap_or_else(|| asked.to_string()),
        known: boolean(r, "known").unwrap_or(false),
        models: arr(r, "models").iter().filter_map(model_option).collect(),
        efforts: strings(r, "efforts", 32),
        default_model: d.and_then(|d| value(d, "model", 200)),
        default_effort: d.and_then(|d| value(d, "effort", 32)),
    }
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct StartChoice {
    pub backend: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RecentRoot {
    pub root: String,
    pub at: i64,
}

/// The last starts (`agent.recent`): the last choice, each backend's, and the folders, newest first.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RecentStart {
    pub last: Option<StartChoice>,
    pub computer: Option<String>,
    pub by_backend: Vec<StartChoice>,
    pub roots: Vec<RecentRoot>,
}

fn choice(v: &Value) -> Option<StartChoice> {
    Some(StartChoice { backend: value(v, "backend", 128)?, model: value(v, "model", 200), effort: value(v, "effort", 32) })
}

pub fn recent(r: &Value) -> RecentStart {
    let mut roots: Vec<RecentRoot> = arr(r, "roots").iter().filter_map(|x| Some(RecentRoot { root: value(x, "root", 4096)?, at: int(x, "at").unwrap_or(0) })).collect();
    roots.sort_by_key(|r| std::cmp::Reverse(r.at));
    RecentStart { last: choice(r), computer: value(r, "computer", 63), by_backend: arr(r, "byBackend").iter().filter_map(choice).collect(), roots }
}

/// What starts a coding session (`agent.start`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct StartRequest {
    pub backend: String,
    pub computer: String,
    pub root: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub prompt: Option<String>,
}

/// A model of `models.list`.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub provider: Option<String>,
    pub provider_name: Option<String>,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub images: bool,
    pub signed_in: bool,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ModelsList {
    pub models: Vec<ModelEntry>,
    /// The user's default, when it is one of `models`.
    pub default_model: Option<String>,
}

pub fn models(r: &Value) -> ModelsList {
    let models: Vec<ModelEntry> = arr(r, "models")
        .iter()
        .filter_map(|m| {
            let id = value(m, "id", 200)?;
            Some(ModelEntry {
                name: text(m, "name", 200).unwrap_or_else(|| id.clone()),
                provider: value(m, "provider", 128),
                provider_name: text(m, "providerName", 200),
                efforts: strings(m, "efforts", 32),
                default_effort: value(m, "defaultEffort", 32),
                images: boolean(m, "images").unwrap_or(false),
                signed_in: boolean(m, "signedIn").unwrap_or(false),
                id,
            })
        })
        .collect();
    let default_model = value(r, "default", 200).filter(|d| models.iter().any(|m| &m.id == d));
    ModelsList { models, default_model }
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum ConversationKind {
    Bot,
    Coding,
    Other { value: String },
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PluginCommand {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FileLimits {
    pub max_bytes: i64,
    pub per_message: i64,
    pub chunk_bytes: i64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct PictureLimits {
    pub max_bytes: i64,
    pub chunk_bytes: i64,
}

/// What a conversation's composer offers (`session.composerOffers`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct ComposerOffers {
    pub kind: ConversationKind,
    pub pictures: bool,
    pub picture_chunks: Option<PictureLimits>,
    pub files: Option<FileLimits>,
    pub commands: Vec<PluginCommand>,
    pub models: Vec<ModelOption>,
    pub model: Option<String>,
    pub efforts: Vec<String>,
    pub effort: Option<String>,
}

fn commands_of(r: &Value) -> Vec<PluginCommand> {
    arr(r, "commands")
        .iter()
        .filter_map(|c| {
            let name = value(c, "name", 128)?;
            Some(PluginCommand { description: text(c, "description", 1000).unwrap_or_else(|| name.clone()), name })
        })
        .collect()
}

pub fn composer_offers(r: &Value) -> Result<ComposerOffers, CoreError> {
    answer_of(r, "session.composerOffers")?;
    Ok(ComposerOffers {
        kind: match raw_str(r, "kind").unwrap_or("") {
            "bot" => ConversationKind::Bot,
            "coding" => ConversationKind::Coding,
            x => ConversationKind::Other { value: other(x) },
        },
        pictures: boolean(r, "pictures").unwrap_or(false),
        picture_chunks: get(r, "pictureChunks").and_then(|p| Some(PictureLimits { max_bytes: int(p, "maxBytes")?, chunk_bytes: int(p, "chunkBytes")? })),
        files: get(r, "files").and_then(|f| Some(FileLimits { max_bytes: int(f, "maxBytes")?, per_message: int(f, "perMessage")?, chunk_bytes: int(f, "chunkBytes")? })),
        commands: commands_of(r),
        models: arr(r, "models").iter().filter_map(model_option).collect(),
        model: value(r, "model", 200),
        efforts: strings(r, "efforts", 32),
        effort: value(r, "effort", 32),
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------------------------------------------

/// What the typed calls need from a connection: one JSON-RPC call.
pub trait Caller {
    fn call_json(&self, method: &'static str, params: Value) -> impl std::future::Future<Output = Result<Value, CoreError>> + Send;
}

fn need_session(id: &str) -> Result<(), CoreError> {
    if is_session_id(id) {
        Ok(())
    } else {
        Err(CoreError::invalid("not a session id"))
    }
}

fn need_bot(id: &str) -> Result<(), CoreError> {
    if is_bot_id(id) {
        Ok(())
    } else {
        Err(CoreError::invalid("not a bot id"))
    }
}

fn limit(n: u32) -> u32 {
    n.clamp(1, 500)
}

/// `bot.list` with each bot's face from `bot.records`.
pub async fn bots(c: &impl Caller) -> Result<Vec<Bot>, CoreError> {
    let list = c.call_json("bot.list", json!({})).await?;
    answer_of(&list, "bot.list")?;
    // Faces are a nicety: a computer that won't list records still lists bots.
    let faces: HashMap<String, BotFace> = match c.call_json("bot.records", json!({})).await {
        Ok(r) => arr(&r, "bots").iter().filter_map(|b| Some((raw_str(b, "id")?.to_string(), face(get(b, "face"))?))).collect(),
        Err(_) => HashMap::new(),
    };
    Ok(arr(&list, "bots")
        .iter()
        .filter_map(bot)
        .map(|mut b| {
            if b.face.is_none() {
                b.face = faces.get(&b.id).cloned();
            }
            b
        })
        .collect())
}

pub async fn bot_summaries(c: &impl Caller) -> Result<Vec<BotSummary>, CoreError> {
    let r = c.call_json("bot.summaries", json!({})).await?;
    answer_of(&r, "bot.summaries")?;
    Ok(arr(&r, "summaries").iter().filter_map(summary).collect())
}

pub async fn conversation(c: &impl Caller, bot_id: &str, before: Option<i64>, n: u32) -> Result<MessagePage, CoreError> {
    need_bot(bot_id)?;
    let mut p = json!({ "id": bot_id, "limit": limit(n) });
    if let Some(b) = before {
        p["before"] = json!(b);
    }
    page(&c.call_json("bot.conversation", p).await?, None)
}

pub async fn mark_read(c: &impl Caller, bot_id: &str, at: i64) -> Result<(), CoreError> {
    need_bot(bot_id)?;
    c.call_json("bot.markRead", json!({ "id": bot_id, "at": at })).await.map(|_| ())
}

pub async fn sessions(c: &impl Caller) -> Result<Vec<SessionRow>, CoreError> {
    let r = c.call_json("session.list", json!({})).await?;
    answer_of(&r, "session.list")?;
    Ok(arr(&r, "sessions").iter().filter_map(session_row).collect())
}

pub async fn history(c: &impl Caller, session: &str, before: Option<i64>, n: u32) -> Result<MessagePage, CoreError> {
    need_session(session)?;
    let mut p = json!({ "id": session, "limit": limit(n) });
    if let Some(b) = before {
        p["before"] = json!(b);
    }
    page(&c.call_json("session.history", p).await?, Some(session.to_string()))
}

pub async fn stop(c: &impl Caller, session: &str) -> Result<(), CoreError> {
    need_session(session)?;
    c.call_json("session.interrupt", json!({ "id": session })).await.map(|_| ())
}

pub async fn set_model(c: &impl Caller, session: &str, model: &str, effort: Option<String>) -> Result<(), CoreError> {
    need_session(session)?;
    let mut p = json!({ "id": session, "model": model });
    if let Some(e) = effort {
        p["effort"] = json!(e);
    }
    c.call_json("session.setModel", p).await.map(|_| ())
}

pub async fn composer(c: &impl Caller, session: &str) -> Result<ComposerOffers, CoreError> {
    need_session(session)?;
    composer_offers(&c.call_json("session.composerOffers", json!({ "id": session })).await?)
}

/// The questions open in a session, in the order asked (`session.openQuestions`). An engine without that door is
/// read from the newest page of the log (200 events), which misses a question asked before it.
pub async fn open_questions_of(c: &impl Caller, session: &str) -> Result<Vec<AskQuestion>, CoreError> {
    need_session(session)?;
    match c.call_json("session.openQuestions", json!({ "id": session })).await {
        Ok(r) => open_questions(&r),
        Err(CoreError::Rpc { code: -32601 | -32010, .. }) => Ok(open_question(&history(c, session, None, 200).await?.items).into_iter().collect()),
        Err(e) => Err(e),
    }
}

/// The question waiting in a session: the newest open one.
pub async fn pending_question(c: &impl Caller, session: &str) -> Result<Option<AskQuestion>, CoreError> {
    Ok(open_questions_of(c, session).await?.pop())
}

pub async fn answer_question(c: &impl Caller, session: &str, call_id: &str, answers: HashMap<String, String>) -> Result<(), CoreError> {
    need_session(session)?;
    c.call_json("session.answer", json!({ "id": session, "callId": call_id, "answers": answers })).await.map(|_| ())
}

pub async fn backends(c: &impl Caller) -> Result<Vec<AgentBackend>, CoreError> {
    let r = c.call_json("agent.backends", json!({})).await?;
    answer_of(&r, "agent.backends")?;
    Ok(arr(&r, "backends").iter().filter_map(backend).collect())
}

pub async fn start_options(c: &impl Caller, backend_id: &str, computer: Option<String>) -> Result<BackendOptions, CoreError> {
    let mut p = json!({ "backend": backend_id });
    if let Some(cm) = computer {
        p["computer"] = json!(cm);
    }
    let r = c.call_json("agent.options", p).await?;
    answer_of(&r, "agent.options")?;
    Ok(backend_options(&r, backend_id))
}

pub async fn recent_start(c: &impl Caller) -> Result<RecentStart, CoreError> {
    let r = c.call_json("agent.recent", json!({})).await?;
    answer_of(&r, "agent.recent")?;
    Ok(recent(&r))
}

pub async fn start_session(c: &impl Caller, s: StartRequest) -> Result<String, CoreError> {
    let mut p = json!({ "backend": s.backend, "computer": s.computer, "root": s.root });
    for (k, v) in [("model", s.model), ("effort", s.effort), ("prompt", s.prompt)] {
        if let Some(v) = v {
            p[k] = json!(v);
        }
    }
    let r = c.call_json("agent.start", p).await?;
    raw_str(&r, "session").filter(|x| is_session_id(x)).map(str::to_string).ok_or_else(|| CoreError::protocol("agent.start answered no session"))
}

pub async fn models_list(c: &impl Caller, session: Option<String>) -> Result<ModelsList, CoreError> {
    let p = match session {
        Some(s) => json!({ "session": s }),
        None => json!({}),
    };
    let r = c.call_json("models.list", p).await?;
    answer_of(&r, "models.list")?;
    Ok(models(&r))
}

/// `bot.create` from a phone: a name and a model only.
pub async fn create_bot(c: &impl Caller, name: &str, model: Option<String>) -> Result<Bot, CoreError> {
    let mut p = json!({ "name": name });
    if let Some(m) = model {
        p["model"] = json!(m);
    }
    let r = c.call_json("bot.create", p).await?;
    get(&r, "bot").and_then(bot).ok_or_else(|| CoreError::protocol("bot.create answered no bot"))
}

pub async fn commands(c: &impl Caller) -> Result<Vec<PluginCommand>, CoreError> {
    let r = c.call_json("command.list", json!({})).await?;
    answer_of(&r, "command.list")?;
    Ok(commands_of(&r))
}

pub async fn run_command(c: &impl Caller, name: &str) -> Result<(), CoreError> {
    c.call_json("command.run", json!({ "name": name })).await.map(|_| ())
}

// ---------------------------------------------------------------------------------------------------------------
// Sizes, for the event queue's byte cap: every string a record holds, plus a little for the rest. Written out, so a
// new field is counted where it is added.
// ---------------------------------------------------------------------------------------------------------------

const FIELD: usize = 8;

fn opt(s: &Option<String>) -> usize {
    s.as_ref().map_or(0, String::len) + FIELD
}

impl Bot {
    pub fn size(&self) -> usize {
        let face = self.face.as_ref().map_or(0, |f| opt(&f.shape) + opt(&f.color) + opt(&f.eyes) + opt(&f.temper));
        self.id.len() + self.name.len() + opt(&self.model) + opt(&self.effort) + face + 64 + opt(&self.computer) + self.main_session.len()
    }
}

impl BotSummary {
    pub fn size(&self) -> usize {
        self.id.len() + self.last.as_ref().map_or(0, |l| l.text.len() + 64) + FIELD
    }
}

impl SessionRow {
    pub fn size(&self) -> usize {
        self.id.len()
            + 64
            + opt(&self.bot)
            + opt(&self.parent)
            + self.computer.len()
            + opt(&self.title)
            + opt(&self.failure)
            + opt(&self.backend)
            + opt(&self.model)
            + opt(&self.effort)
            + opt(&self.root)
            + opt(&self.branch)
            + 64
    }
}

impl AskQuestion {
    pub fn size(&self) -> usize {
        self.call_id.len()
            + 16
            + self
                .questions
                .iter()
                .map(|q| {
                    q.question.len() + opt(&q.header) + opt(&q.placeholder) + FIELD + q.options.iter().map(|o| o.label.len() + opt(&o.description) + opt(&o.preview)).sum::<usize>()
                })
                .sum::<usize>()
    }
}

impl SessionItem {
    pub fn size(&self) -> usize {
        let kind = match &self.kind {
            ItemKind::User { text, device } => text.len() + opt(device),
            ItemKind::Assistant { text } | ItemKind::FromSession { text } | ItemKind::FromPlugin { text } | ItemKind::Agent { text } | ItemKind::TurnError { text } => text.len(),
            ItemKind::FromBot { bot, text } => opt(bot) + text.len(),
            ItemKind::Routine { name, text } => opt(name) + text.len(),
            ItemKind::Note { label, text } => opt(label) + text.len(),
            ItemKind::TurnEnded { reason } => reason.len(),
            ItemKind::QuestionAsked { question } => question.size(),
            ItemKind::QuestionResolved { call_id } => call_id.len(),
            ItemKind::Other { kind } => kind.len(),
        };
        self.id.len() + self.session.len() + 32 + kind
    }
}
