//! Sessions tell each other things (the mailbox): an opened session reports to the session that opened it
//! (`ompdesk_report`), and siblings of one opener can write to each other (`mail.ts`). A report lands in the receiver's
//! session as one `ompdesk.mail` custom message, delivered as stock's `aside`; progress from one sender is coalesced,
//! the latest wins; a report from a superseded dispatch is dropped; each report id is delivered once.
//!
//! Seams: `Mailbox::new(deliver)` takes the delivery into the receiver's session as one async closure (`Deliver`), and
//! the coalescing wait runs on `tokio::time` (the TypeScript's injected `setTimer`/`clearTimer`): a test pauses tokio's
//! clock, and `Mailbox::with_coalesce` shortens the 2 s window. The TypeScript's unused `now` dependency is gone.
//! `post` and the timers need a tokio runtime. A timer is a task that sleeps, then flushes if it is still the current
//! one for its sender and receiver (a generation number, so a replaced timer wakes and does nothing; a flush already
//! delivering is never cancelled, as in the TypeScript).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value};

use self::MailKind::{Blocked, Done, Note, Progress, Question, Review};

use crate::agentctl::journal::attachments::AttachedSet;
use crate::agentctl::journal::js_number;

/// The custom message type stock journals a report under (`agent-control-contracts.ts`).
pub const MAIL_CUSTOM_TYPE: &str = "ompdesk.mail";

/// Progress from one sender to one receiver within this window is delivered once, the latest text.
pub const MAIL_COALESCE_MS: u64 = 2_000;
/// A coalesced progress report whose delivery failed is tried this many more times.
pub const MAIL_PROGRESS_RETRIES: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MailKind {
    Progress,
    Done,
    Blocked,
    Question,
    Review,
    Note,
}

/// `MAIL_KINDS`, in the TypeScript's order.
pub const MAIL_KINDS: [MailKind; 6] = [Progress, Done, Blocked, Question, Review, Note];

impl MailKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Progress => "progress",
            Done => "done",
            Blocked => "blocked",
            Question => "question",
            Review => "review",
            Note => "note",
        }
    }

    pub fn parse(text: &str) -> Option<MailKind> {
        MAIL_KINDS.into_iter().find(|kind| kind.as_str() == text)
    }

    fn label(self) -> &'static str {
        match self {
            Review => "needs review",
            other => other.as_str(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailCheck {
    pub command: String,
    pub passed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mail {
    /// Unique per report (idempotency of a retried tool call).
    pub id: String,
    pub from: String,
    pub from_title: String,
    pub to: String,
    pub kind: MailKind,
    pub text: String,
    pub files: Option<Vec<String>>,
    pub checks: Option<Vec<MailCheck>>,
    /// The dispatch the sender worked on (the opener's message it answers).
    pub dispatch: Option<String>,
    /// Progress reports this one stands for (coalesced).
    pub merged: Option<u64>,
    /// The child's own question card (an extension UI request id) this mail announces.
    pub card: Option<String>,
    /// What the receiver is asked to do with it, in place of the kind's own line (a wake's prompt).
    pub instruction: Option<String>,
    /// What it carries besides text: pictures sent inline (by reference, bytes in the attachment store), files landed.
    pub attachments: Option<AttachedSet>,
    /// Captured from authenticated caller/target facts before generated presentation/custody text is added.
    pub(crate) native_source: Option<crate::agentctl::inbox::InboxAdmission>,
    /// Ephemeral original bytes for the one coalescer-selected native delivery; never board/JSON state.
    pub(crate) native_attachment_plan: Option<Arc<NativeAttachmentPlan>>,
    pub at: f64,
}

pub(crate) struct NativeAttachmentPlan {
    pub images: Vec<crate::agentctl::journal::attachments::Resolved>,
    pub files: Vec<crate::agentctl::journal::attachments::Resolved>,
    materialized: Mutex<Option<AttachedSet>>,
}

impl std::fmt::Debug for NativeAttachmentPlan {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeAttachmentPlan")
            .field("images", &self.images.len())
            .field("files", &self.files.len())
            .finish()
    }
}

impl PartialEq for NativeAttachmentPlan {
    fn eq(&self, other: &Self) -> bool {
        self.images
            .iter()
            .map(|image| &image.file)
            .eq(other.images.iter().map(|image| &image.file))
            && self
                .files
                .iter()
                .map(|file| &file.file)
                .eq(other.files.iter().map(|file| &file.file))
    }
}

impl NativeAttachmentPlan {
    pub fn new(
        images: Vec<crate::agentctl::journal::attachments::Resolved>,
        files: Vec<crate::agentctl::journal::attachments::Resolved>,
    ) -> Self {
        Self {
            images,
            files,
            materialized: Mutex::new(None),
        }
    }

    pub fn record_materialized(&self, set: &AttachedSet) {
        *self
            .materialized
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(set.clone());
    }

    pub fn summary(&self) -> Option<String> {
        self.materialized
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(AttachedSet::summary)
    }
}

impl Mail {
    /// A report with only what every report has; the rest is set by field.
    pub fn new(
        id: &str,
        from: &str,
        from_title: &str,
        to: &str,
        kind: MailKind,
        text: &str,
        at: f64,
    ) -> Mail {
        Mail {
            id: id.to_owned(),
            from: from.to_owned(),
            from_title: from_title.to_owned(),
            to: to.to_owned(),
            kind,
            text: text.to_owned(),
            files: None,
            checks: None,
            dispatch: None,
            merged: None,
            card: None,
            instruction: None,
            attachments: None,
            native_source: None,
            native_attachment_plan: None,
            at,
        }
    }
}

/// How stock delivers a report: `aside` is `deliverAs: "aside"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MailDelivery {
    pub trigger_turn: bool,
    pub aside: bool,
}

impl MailDelivery {
    /// `{ triggerTurn, deliverAs? }`, keys in that order.
    pub fn to_json(self) -> Value {
        let mut map = Map::new();
        map.insert("triggerTurn".into(), self.trigger_turn.into());
        if self.aside {
            map.insert("deliverAs".into(), "aside".into());
        }
        Value::Object(map)
    }
}

/// How stock delivers a report of this kind (a no-turn one becomes an `aside` in the receiver's bridge while a turn
/// runs).
pub fn delivery_for(kind: MailKind) -> MailDelivery {
    match kind {
        Question | Blocked | Done | Review => MailDelivery {
            trigger_turn: true,
            aside: true,
        },
        Progress | Note => MailDelivery {
            trigger_turn: false,
            aside: false,
        },
    }
}

/// A report's own text never opens or closes its wrapper (a forged sender, or words read as outside the report).
fn in_mail(value: &str) -> String {
    value
        .replace("<ompdesk-mail", "<\u{200b}ompdesk-mail")
        .replace("</ompdesk-mail", "</\u{200b}ompdesk-mail")
}

/// What the receiving model reads (the transcript draws `mail_details` instead).
pub fn mail_text(mail: &Mail) -> String {
    render_mail_text(mail, true)
}

/// The same report before destination-only attachment paths are materialized.
pub fn mail_logical_text(mail: &Mail) -> String {
    render_mail_text(mail, false)
}

fn render_mail_text(mail: &Mail, include_attachment_paths: bool) -> String {
    let title = mail
        .from_title
        .replace('"', "'")
        .replace('<', "‹")
        .replace('>', "›");
    let dispatch = match mail.dispatch.as_deref() {
        Some(dispatch) if !dispatch.is_empty() => format!(" dispatch=\"{dispatch}\""),
        _ => String::new(),
    };
    let mut lines = vec![
        format!(
            "<ompdesk-mail from=\"{}\" title=\"{title}\" kind=\"{}\"{dispatch}>",
            mail.from,
            mail.kind.as_str()
        ),
        in_mail(&mail.text),
    ];
    if let Some(files) = mail.files.as_ref().filter(|files| !files.is_empty()) {
        lines.push(in_mail(&format!("changed files: {}", files.join(", "))));
    }
    if include_attachment_paths {
        for line in mail
            .attachments
            .iter()
            .flat_map(AttachedSet::attached_lines)
        {
            lines.push(in_mail(&line));
        }
    }
    if let Some(checks) = mail.checks.as_ref().filter(|checks| !checks.is_empty()) {
        let listed: Vec<String> = checks
            .iter()
            .map(|check| {
                format!(
                    "{} {}",
                    check.command,
                    if check.passed { "passed" } else { "FAILED" }
                )
            })
            .collect();
        lines.push(in_mail(&format!("checks: {}", listed.join("; "))));
    }
    if let Some(merged) = mail.merged.filter(|merged| *merged != 0) {
        lines.push(format!("(latest of {} progress reports)", merged + 1));
    }
    lines.push("</ompdesk-mail>".to_owned());
    let from = &mail.from;
    if let Some(instruction) = mail.instruction.as_deref().filter(|text| !text.is_empty()) {
        lines.push(instruction.to_owned());
    } else if let Some(card) = mail.card.as_deref().filter(|card| !card.is_empty()) {
        lines.push(format!("Session {from} shows this question card and waits (request {card}). When the answer is yours to give within its task, answer it with ompdesk_session_answer (the field named above); when only the user can decide, tell the user. Never guess an approval."));
    } else if matches!(mail.kind, Question | Blocked) {
        lines.push(format!("Session {from} waits on you. Answer it with ompdesk_session_send, or ask the user when only they can decide; never guess an approval."));
    } else if matches!(mail.kind, Done | Review) {
        lines.push("Judge it against the acceptance you gave (ompdesk_compare, ompdesk_session_read), then merge or reply.".to_owned());
    }
    lines.join("\n")
}

/// The quiet transcript line's data.
pub fn mail_details(mail: &Mail) -> Value {
    let mut map = Map::new();
    map.insert("id".into(), mail.id.clone().into());
    map.insert("from".into(), mail.from.clone().into());
    map.insert("fromTitle".into(), mail.from_title.clone().into());
    map.insert("kind".into(), mail.kind.as_str().into());
    map.insert("label".into(), mail.kind.label().into());
    map.insert("text".into(), mail.text.clone().into());
    if let Some(files) = mail.files.as_ref().filter(|files| !files.is_empty()) {
        map.insert("files".into(), files.clone().into());
    }
    if let Some(checks) = mail.checks.as_ref().filter(|checks| !checks.is_empty()) {
        let listed = checks
            .iter()
            .map(|check| {
                let mut one = Map::new();
                one.insert("command".into(), check.command.clone().into());
                one.insert("passed".into(), check.passed.into());
                Value::Object(one)
            })
            .collect();
        map.insert("checks".into(), Value::Array(listed));
    }
    if let Some(dispatch) = mail
        .dispatch
        .as_ref()
        .filter(|dispatch| !dispatch.is_empty())
    {
        map.insert("dispatch".into(), dispatch.clone().into());
    }
    if let Some(merged) = mail.merged.filter(|merged| *merged != 0) {
        map.insert("merged".into(), js_number(merged as f64));
    }
    if let Some(attached) = &mail.attachments {
        let mut listed = Vec::new();
        for image in &attached.images {
            let mut one = Map::new();
            one.insert("name".into(), image.name.clone().into());
            one.insert("kind".into(), "image".into());
            listed.push(Value::Object(one));
        }
        for file in &attached.files {
            let mut one = Map::new();
            one.insert("name".into(), file.file.name.clone().into());
            one.insert("kind".into(), "file".into());
            one.insert("path".into(), file.path.clone().into());
            listed.push(Value::Object(one));
        }
        map.insert("attachments".into(), Value::Array(listed));
    }
    Value::Object(map)
}

/// Receiver responsibility only; neither variant claims provider consumption.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryReceipt {
    New,
    Existing,
}

/// A delivery into the receiver's session: resolves when it was taken, or says why not.
pub type DeliverFuture = Pin<Box<dyn Future<Output = Result<DeliveryReceipt, String>> + Send>>;
/// Deliver one mail into its receiver's session.
pub type Deliver = Arc<dyn Fn(Mail) -> DeliverFuture + Send + Sync>;

/// A sender's last report to one receiver, and whether its question still waits on that receiver.
#[derive(Debug, Clone, PartialEq)]
pub struct MailState {
    pub last: Mail,
    /// A question or blocked report this receiver has not answered (sent the sender new work) since.
    pub waiting: bool,
}

/// What a post answers the sender.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Posted {
    Delivered,
    Queued,
    Duplicate,
    Stale,
}

impl Posted {
    pub fn as_str(self) -> &'static str {
        match self {
            Posted::Delivered => "delivered",
            Posted::Queued => "queued",
            Posted::Duplicate => "duplicate",
            Posted::Stale => "stale",
        }
    }
}

struct Waiting {
    mail: Mail,
    generation: u64,
    native: Option<Arc<NativeCompletion>>,
    attempted: bool,
}

#[derive(Default)]
struct Tables {
    /// Per sender: the number of the dispatch it currently works on (`dN`).
    dispatch: HashMap<String, u64>,
    /// Keyed `from>to`: a question to a sibling waits on the sibling, never on the opener's board.
    state: HashMap<String, MailState>,
    seen: HashSet<String>,
    pending: HashMap<String, Waiting>,
    /// Completion ownership for already-started native deliveries, not a second message queue.
    in_flight: HashMap<Arc<String>, ActiveDelivery>,
    generations: u64,
}

fn activate_dispatch(tables: &mut Tables, child: &str, n: u64) {
    if n <= tables.dispatch.get(child).copied().unwrap_or(0) {
        return;
    }
    tables.dispatch.insert(child.to_owned(), n);
    let prefix = format!("{child}>");
    for (key, state) in &mut tables.state {
        if key.starts_with(&prefix) {
            state.waiting = false;
        }
    }
}

struct Inner {
    deliver: Deliver,
    coalesce: Duration,
    tables: Mutex<Tables>,
}

struct NativeCompletion {
    identity: Arc<String>,
    fingerprint: String,
    pair: String,
    result: tokio::sync::watch::Sender<Option<Result<Posted, String>>>,
}

impl NativeCompletion {
    fn finish(&self, result: impl FnOnce() -> Result<Posted, String>) {
        self.result.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(result());
            true
        });
    }

    fn finished(&self) -> bool {
        self.result.borrow().is_some()
    }

    async fn wait(&self) -> Result<Posted, String> {
        let mut result = self.result.subscribe();
        loop {
            let observed = result.borrow_and_update().clone();
            if let Some(observed) = observed {
                return observed;
            }
            result
                .changed()
                .await
                .map_err(|_| unknown_outcome("the completion channel closed"))?;
        }
    }
}

struct ActiveDelivery {
    generation: u64,
    completion: Arc<NativeCompletion>,
    attempted: bool,
}

fn remove_active(tables: &mut Tables, progress: &Arc<NativeCompletion>, generation: u64) {
    if tables
        .in_flight
        .get(progress.identity.as_ref())
        .is_some_and(|active| {
            active.generation == generation && Arc::ptr_eq(&active.completion, progress)
        })
    {
        tables.in_flight.remove(progress.identity.as_ref());
    }
}

/// A panicked/dropped delivery task must not leave its native caller waiting forever.
struct ActiveGuard {
    inner: Arc<Inner>,
    progress: Option<Arc<NativeCompletion>>,
    generation: u64,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Some(progress) = &self.progress {
            remove_active(&mut self.inner.tables(), progress, self.generation);
            progress.finish(|| {
                Err(unknown_outcome(
                    "the selected delivery task ended before a conclusive result",
                ))
            });
        }
    }
}

fn native_identity(mail: &Mail) -> Result<Option<(String, String)>, String> {
    let Some(source) = &mail.native_source else {
        return Ok(None);
    };
    let payload = if let Some(plan) = &mail.native_attachment_plan {
        crate::agentctl::inbox::logical_payload(
            &source.logical,
            Some((
                plan.images.iter().map(|image| &image.file),
                plan.files.iter().map(|file| &file.file),
            )),
        )
    } else {
        crate::agentctl::inbox::logical_payload(
            &source.logical,
            mail.attachments.as_ref().map(|set| {
                (
                    set.images.iter(),
                    set.files.iter().map(|landed| &landed.file),
                )
            }),
        )
    }
    .map_err(|error| error.to_string())?;
    Ok(Some((
        source.logical.delivery_id()?,
        crate::agentctl::journal::inbox_ledger::fingerprint_payload(payload)?,
    )))
}

fn supersede(waiting: Waiting) {
    if let Some(progress) = waiting.native {
        progress.finish(|| Err(superseded_error(waiting.attempted)));
    }
}

fn superseded_error(attempted: bool) -> String {
    if attempted {
        unknown_outcome("the report was superseded after a delivery attempt")
    } else {
        "This progress attempt was superseded before delivery; no receiver acceptance was confirmed"
            .into()
    }
}

fn unknown_outcome(reason: &str) -> String {
    format!(
        "Native report receiver outcome is unconfirmed; query or retry the same identity: {reason}"
    )
}
impl Inner {
    fn tables(&self) -> std::sync::MutexGuard<'_, Tables> {
        self.tables
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Per sender: the dispatch it currently works on, and per receiver its last report and whether a question waits on
/// that receiver. Coalesces progress, drops a report from a superseded dispatch, delivers each report id once.
#[derive(Clone)]
pub struct Mailbox {
    inner: Arc<Inner>,
}

enum PostAdmission {
    Ready(Posted),
    Joined(Arc<NativeCompletion>),
    Queued {
        generation: u64,
        completion: Option<Arc<NativeCompletion>>,
    },
    Deliver {
        generation: u64,
        completion: Option<Arc<NativeCompletion>>,
    },
}

/// Wait out the coalescing window, then deliver the pending report if it is still this timer's.
fn arm(inner: Arc<Inner>, key: String, generation: u64, attempt: u32) {
    tokio::spawn(async move {
        tokio::time::sleep(inner.coalesce).await;
        let next = {
            let mut tables = inner.tables();
            match tables.pending.get(&key) {
                Some(waiting) if waiting.generation == generation => {}
                _ => return,
            }
            let next = tables.pending.remove(&key);
            if let Some(progress) = next.as_ref().and_then(|next| next.native.as_ref()) {
                tables.in_flight.insert(
                    progress.identity.clone(),
                    ActiveDelivery {
                        generation,
                        completion: progress.clone(),
                        attempted: next.as_ref().is_some_and(|waiting| waiting.attempted),
                    },
                );
            }
            next
        };
        if let Some(next) = next {
            deliver_claimed(inner, key, next, Some(attempt)).await;
        }
    });
}

async fn deliver_claimed(inner: Arc<Inner>, key: String, mut next: Waiting, attempt: Option<u32>) {
    let generation = next.generation;
    let mut guard = next.native.as_ref().map(|progress| ActiveGuard {
        inner: inner.clone(),
        progress: Some(progress.clone()),
        generation,
    });
    if let Some(progress) = &next.native {
        let mut tables = inner.tables();
        let Some(active) = tables
            .in_flight
            .get_mut(progress.identity.as_ref())
            .filter(|active| {
                active.generation == generation && Arc::ptr_eq(&active.completion, progress)
            })
        else {
            return;
        };
        if progress.finished() {
            return;
        }
        active.attempted = true;
    }
    next.attempted = true;
    let delivered = (inner.deliver)(next.mail.clone()).await;
    let mut tables = inner.tables();
    match delivered {
        Ok(receipt) => {
            tables.seen.insert(next.mail.id);
            if let Some(progress) = &next.native {
                progress.finish(|| {
                    Ok(match receipt {
                        DeliveryReceipt::New => Posted::Delivered,
                        DeliveryReceipt::Existing => Posted::Duplicate,
                    })
                });
            }
        }
        Err(error) => {
            let Some(attempt) = attempt.filter(|attempt| *attempt < MAIL_PROGRESS_RETRIES) else {
                if let Some(progress) = &next.native
                    && !progress.finished()
                {
                    progress.finish(|| Err(unknown_outcome(&error)));
                }
                return;
            };
            if tables.pending.contains_key(&key)
                || next
                    .native
                    .as_ref()
                    .is_some_and(|progress| progress.finished())
            {
                if let Some(progress) = &next.native
                    && !progress.finished()
                {
                    progress.finish(|| Err(unknown_outcome(&error)));
                }
                return;
            }
            if let Some(progress) = &next.native {
                remove_active(&mut tables, progress, generation);
            }
            if let Some(guard) = &mut guard {
                guard.progress = None;
            }
            tables.generations += 1;
            let generation = tables.generations;
            next.generation = generation;
            tables.pending.insert(key.clone(), next);
            drop(tables);
            arm(inner, key, generation, attempt + 1);
        }
    }
}

impl Mailbox {
    pub fn new(deliver: Deliver) -> Mailbox {
        Mailbox::with_coalesce(deliver, Duration::from_millis(MAIL_COALESCE_MS))
    }

    pub fn with_coalesce(deliver: Deliver, coalesce: Duration) -> Mailbox {
        Mailbox {
            inner: Arc::new(Inner {
                deliver,
                coalesce,
                tables: Mutex::new(Tables::default()),
            }),
        }
    }

    /// The opener gave `child` new work: a new dispatch id, and its waiting question counts as answered.
    pub fn dispatch(&self, child: &str) -> String {
        let mut tables = self.inner.tables();
        let n = tables.dispatch.get(child).copied().unwrap_or(0) + 1;
        activate_dispatch(&mut tables, child, n);
        format!("d{n}")
    }

    pub fn candidate_dispatch(&self, child: &str, pending_floor: u64) -> u64 {
        self.inner
            .tables()
            .dispatch
            .get(child)
            .copied()
            .unwrap_or(0)
            .max(pending_floor)
            + 1
    }

    /// A retry activates the receiver's FIRST dispatch, never the discarded newly derived number.
    pub fn accept_dispatch(&self, child: &str, n: u64) {
        activate_dispatch(&mut self.inner.tables(), child, n);
    }

    pub fn current(&self, child: &str) -> Option<String> {
        self.inner
            .tables()
            .dispatch
            .get(child)
            .map(|n| format!("d{n}"))
    }

    /// Whether this launch knows `child`'s dispatch (else main reads it back from the child's journal).
    pub fn knows(&self, child: &str) -> bool {
        self.inner.tables().dispatch.contains_key(child)
    }

    /// The dispatch number the child's own journal names, so a relaunch keeps fencing stale reports and numbers the
    /// next dispatch after it. Never lowers a known one.
    pub fn seed(&self, child: &str, n: u64) {
        let mut tables = self.inner.tables();
        if n > tables.dispatch.get(child).copied().unwrap_or(0) {
            tables.dispatch.insert(child.to_owned(), n);
        }
    }

    /// `child`'s last report to `receiver`.
    pub fn state(&self, child: &str, receiver: &str) -> Option<MailState> {
        self.inner
            .tables()
            .state
            .get(&format!("{child}>{receiver}"))
            .cloned()
    }

    fn prepare_post(&self, pending_mail: &mut Option<Mail>) -> Result<PostAdmission, String> {
        let mail = pending_mail
            .as_mut()
            .ok_or("Missing mailbox admission payload")?;
        let native = native_identity(mail)?;
        let key = format!("{}>{}", mail.from, mail.to);
        let mut tables = self.inner.tables();
        if native.is_none() && tables.seen.contains(&mail.id) {
            return Ok(PostAdmission::Ready(Posted::Duplicate));
        }
        if let Some((identity, fingerprint)) = &native {
            let completion = tables
                .in_flight
                .get(identity)
                .map(|active| &active.completion)
                .or_else(|| {
                    tables
                        .pending
                        .get(&key)
                        .and_then(|pending| pending.native.as_ref())
                        .filter(|pending| pending.identity.as_ref() == identity)
                });
            if let Some(completion) = completion {
                if completion.fingerprint != *fingerprint {
                    return Err("A pending report identity conflicts with its logical payload; original retained".into());
                }
                return Ok(PostAdmission::Joined(completion.clone()));
            }
        } else if let Some(pending) = tables.pending.get(&key)
            && pending.mail.id == mail.id
            && pending.native.is_some()
        {
            return Err(
                "A pending native report cannot be replaced by ambiguous legacy data".into(),
            );
        }
        let current = tables.dispatch.get(&mail.from).map(|n| format!("d{n}"));
        if let (Some(sent), Some(current)) = (mail.dispatch.as_deref(), current.as_deref())
            && !sent.is_empty()
            && sent != current
        {
            return Ok(PostAdmission::Ready(Posted::Stale));
        }
        if let Some(current) = current {
            mail.dispatch = Some(current);
        }
        let plan = mail.native_attachment_plan.take();
        tables.state.insert(
            key.clone(),
            MailState {
                last: mail.clone(),
                waiting: matches!(mail.kind, Question | Blocked),
            },
        );
        mail.native_attachment_plan = plan;
        let completion = native.map(|(identity, fingerprint)| {
            Arc::new(NativeCompletion {
                identity: Arc::new(identity),
                fingerprint,
                pair: key.clone(),
                result: tokio::sync::watch::channel(None).0,
            })
        });
        if mail.kind == Progress {
            let merged = tables
                .pending
                .get(&key)
                .map_or(0, |pending| pending.mail.merged.unwrap_or(0) + 1);
            if merged != 0 {
                mail.merged = Some(merged);
            }
            tables.generations += 1;
            let generation = tables.generations;
            let mail = pending_mail
                .take()
                .ok_or("Missing queued mailbox payload")?;
            if let Some(previous) = tables.pending.insert(
                key,
                Waiting {
                    mail,
                    generation,
                    native: completion.clone(),
                    attempted: false,
                },
            ) {
                supersede(previous);
            }
            return Ok(PostAdmission::Queued {
                generation,
                completion,
            });
        }
        if let Some(previous) = tables.pending.remove(&key) {
            supersede(previous);
        }
        let generation = if let Some(completion) = &completion {
            tables.generations += 1;
            let generation = tables.generations;
            tables.in_flight.insert(
                completion.identity.clone(),
                ActiveDelivery {
                    generation,
                    completion: completion.clone(),
                    attempted: false,
                },
            );
            generation
        } else {
            0
        };
        Ok(PostAdmission::Deliver {
            generation,
            completion,
        })
    }

    /// Coalesces legacy progress immediately; native posts finish only at actual receiver acceptance or explicit failure.
    pub async fn post(&self, mail: Mail) -> Result<Posted, String> {
        let key = format!("{}>{}", mail.from, mail.to);
        let mut mail = Some(mail);
        match self.prepare_post(&mut mail)? {
            PostAdmission::Ready(result) => Ok(result),
            PostAdmission::Joined(completion) => completion.wait().await,
            PostAdmission::Queued {
                generation,
                completion,
            } => {
                arm(self.inner.clone(), key, generation, 0);
                match completion {
                    Some(completion) => completion.wait().await,
                    None => Ok(Posted::Queued),
                }
            }
            PostAdmission::Deliver {
                generation,
                completion,
            } => {
                let mail = mail.ok_or("Missing selected mailbox payload")?;
                if let Some(completion) = completion {
                    let inner = self.inner.clone();
                    let native = completion.clone();
                    tokio::spawn(deliver_claimed(
                        inner,
                        key,
                        Waiting {
                            mail,
                            generation,
                            native: Some(native),
                            attempted: false,
                        },
                        None,
                    ));
                    completion.wait().await
                } else {
                    let id = mail.id.clone();
                    let delivered = (self.inner.deliver)(mail).await?;
                    self.inner.tables().seen.insert(id);
                    Ok(match delivered {
                        DeliveryReceipt::New => Posted::Delivered,
                        DeliveryReceipt::Existing => Posted::Duplicate,
                    })
                }
            }
        }
    }

    /// A closed session leaves nothing behind.
    pub fn forget(&self, tab: &str) {
        let mut tables = self.inner.tables();
        tables.dispatch.remove(tab);
        let from = format!("{tab}>");
        let to = format!(">{tab}");
        let names = |key: &String| key.starts_with(&from) || key.ends_with(&to);
        tables.state.retain(|key, _| !names(key));
        tables.pending.retain(|key, pending| {
            if !names(key) {
                return true;
            }
            if let Some(progress) = &pending.native {
                progress.finish(|| Err(superseded_error(pending.attempted)));
            }
            false
        });
        tables.in_flight.retain(|_, active| {
            if !names(&active.completion.pair) {
                return true;
            }
            active
                .completion
                .finish(|| Err(superseded_error(active.attempted)));
            active.attempted
        });
    }
}
