//! A message one session sends another (`ompdesk_session_send`) is a stock `prompt`; a busy receiver queues it in its
//! omp's memory and journals it only when its loop takes it, so an omp that ends first loses it (`send-outbox.ts`).
//! Main keeps each message, per receiver session file (and paired device), until the receiver's journal holds its
//! marker. It remembers which omp process it handed the message to: that omp still holds it, so it is never sent there
//! again; a different omp (a relaunch's) gets it once, in the order sent. An omp that holds it no more while idle with
//! nothing queued lets it go.
//!
//! Kept in `<userData>/send-outbox.json` (mode 0o600, written when a message is handed over, never in a quit hook),
//! newest `SEND_OUTBOX_MAX`, none older than `SEND_OUTBOX_TTL_MS`.
//!
//! Seams: the clock, and `OwedDeps` for what `deliver_owed` asks of the tab pool and the receiver's omp: its methods
//! answer `None`/`Refused`/`false` where the TypeScript promise rejected (the TypeScript caught every rejection as
//! those). The outbox is internally locked (`&self` methods) so a delivery may hold it across its awaits; `lane` runs
//! work for one receiver at a time (a `tokio` mutex per key, first come first served).

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use super::{
    Clock, THREE_DAYS_MS, js_number, number, object, read_array, string, stringify, system_clock,
    write_text,
};

pub const SEND_OUTBOX_MAX: usize = 200;
pub const SEND_OUTBOX_TTL_MS: f64 = THREE_DAYS_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamingBehavior {
    Steer,
    FollowUp,
}

impl StreamingBehavior {
    pub fn as_str(self) -> &'static str {
        match self {
            StreamingBehavior::Steer => "steer",
            StreamingBehavior::FollowUp => "followUp",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutboxSend {
    /// The marker the message carries: what the receiver's journal is asked for.
    pub mark: String,
    /// The dispatch number of an opener's message to its child (`dN`).
    pub dispatch: Option<i64>,
    /// The receiver's session file (a paired device's own path when `device` is set).
    pub session_path: String,
    pub device: Option<String>,
    /// The sender's session file (its tab id when it has none).
    pub from: String,
    /// What the sender wrote.
    pub body: String,
    /// The prompt as sent: wrapped, with its markers.
    pub message: String,
    pub streaming_behavior: StreamingBehavior,
    /// The receiver omp it was handed to, or `tab:<tab id>`; absent: not handed to any omp yet.
    pub instance: Option<String>,
    pub at: f64,
    /// `instance` set after the entry was made lands after `at` in the file, as an assignment to an object did.
    instance_last: bool,
}

impl OutboxSend {
    /// An entry as the service makes one (no instance yet).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        mark: String,
        dispatch: Option<i64>,
        session_path: String,
        device: Option<String>,
        from: String,
        body: String,
        message: String,
        streaming_behavior: StreamingBehavior,
        at: f64,
    ) -> OutboxSend {
        OutboxSend {
            mark,
            dispatch,
            session_path,
            device: device.filter(|device| !device.is_empty()),
            from,
            body,
            message,
            streaming_behavior,
            instance: None,
            at,
            instance_last: false,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("mark".into(), self.mark.clone().into());
        if let Some(dispatch) = self.dispatch {
            map.insert("dispatch".into(), dispatch.into());
        }
        map.insert("sessionPath".into(), self.session_path.clone().into());
        if let Some(device) = &self.device {
            map.insert("device".into(), device.clone().into());
        }
        map.insert("from".into(), self.from.clone().into());
        map.insert("body".into(), self.body.clone().into());
        map.insert("message".into(), self.message.clone().into());
        map.insert(
            "streamingBehavior".into(),
            self.streaming_behavior.as_str().into(),
        );
        if let Some(instance) = self.instance.as_ref().filter(|_| !self.instance_last) {
            map.insert("instance".into(), instance.clone().into());
        }
        map.insert("at".into(), js_number(self.at));
        if let Some(instance) = self.instance.as_ref().filter(|_| self.instance_last) {
            map.insert("instance".into(), instance.clone().into());
        }
        Value::Object(map)
    }
}

/// What the receiver's bridge answers about markers (`agent_control_sent`).
#[derive(Debug, Clone, PartialEq)]
pub struct SentAnswer {
    pub instance: String,
    pub journaled: Vec<String>,
}

/// A receiver session: its file on the computer it is saved on.
pub fn receiver_key(session_path: &str, device: Option<&str>) -> String {
    format!("{}\n{session_path}", device.unwrap_or(""))
}

fn entry_key(session_path: &str, device: Option<&str>, mark: &str) -> String {
    format!("{}\n{mark}", receiver_key(session_path, device))
}

fn key_of(entry: &OutboxSend) -> String {
    entry_key(&entry.session_path, entry.device.as_deref(), &entry.mark)
}

pub(crate) fn parse_entry(value: &Value) -> Option<OutboxSend> {
    let fields = object(value)?;
    let mark = string(fields, "mark").filter(|mark| !mark.is_empty())?;
    let session_path = string(fields, "sessionPath").filter(|path| !path.is_empty())?;
    let from = string(fields, "from")?;
    let body = string(fields, "body")?;
    let message = string(fields, "message").filter(|message| !message.is_empty())?;
    let streaming_behavior = match string(fields, "streamingBehavior")? {
        "steer" => StreamingBehavior::Steer,
        "followUp" => StreamingBehavior::FollowUp,
        _ => return None,
    };
    let at = number(fields, "at")?;
    let dispatch = number(fields, "dispatch")
        .filter(|n| n.fract() == 0.0)
        .map(|n| n as i64);
    Some(OutboxSend {
        mark: mark.to_owned(),
        dispatch,
        session_path: session_path.to_owned(),
        device: string(fields, "device")
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        from: from.to_owned(),
        body: body.to_owned(),
        message: message.to_owned(),
        streaming_behavior,
        instance: string(fields, "instance")
            .filter(|i| !i.is_empty())
            .map(str::to_owned),
        at,
        instance_last: false,
    })
}

struct State {
    file: Option<PathBuf>,
    now: Clock,
    /// Oldest first.
    entries: Vec<(String, OutboxSend)>,
}

pub struct SendOutbox {
    state: Mutex<State>,
    /// One delivery at a time per receiver session.
    lanes: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl State {
    fn position(&self, key: &str) -> Option<usize> {
        self.entries.iter().position(|(held, _)| held == key)
    }

    fn trim(&mut self) {
        let oldest = (self.now)() - SEND_OUTBOX_TTL_MS;
        let before = self.entries.len();
        self.entries.retain(|(_, entry)| entry.at >= oldest);
        let mut changed = self.entries.len() != before;
        while self.entries.len() > SEND_OUTBOX_MAX {
            self.entries.remove(0);
            changed = true;
        }
        if changed {
            self.save();
        }
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        let text = stringify(
            self.entries
                .iter()
                .map(|(_, entry)| entry.to_json())
                .collect(),
        );
        if let Err(error) = write_text(file, &text, Some(0o600)) {
            eprintln!("[send-outbox] not saved: {error}");
        }
    }

    fn pending(&mut self) -> Vec<OutboxSend> {
        self.trim();
        self.entries
            .iter()
            .map(|(_, entry)| entry.clone())
            .collect()
    }
}

impl SendOutbox {
    pub fn new(file: Option<PathBuf>) -> SendOutbox {
        SendOutbox::with_clock(file, system_clock())
    }

    pub fn with_clock(file: Option<PathBuf>, now: Clock) -> SendOutbox {
        let mut state = State {
            file,
            now,
            entries: Vec::new(),
        };
        if let Some(file) = state.file.clone() {
            for item in read_array(&file) {
                if let Some(entry) = parse_entry(&item) {
                    let key = key_of(&entry);
                    match state.position(&key) {
                        Some(at) => state.entries[at].1 = entry,
                        None => state.entries.push((key, entry)),
                    }
                }
            }
        }
        SendOutbox {
            state: Mutex::new(state),
            lanes: Mutex::new(HashMap::new()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Keep a message about to be handed over (the same marker to the same receiver replaces its entry).
    pub fn keep(&self, entry: OutboxSend) {
        let mut state = self.state();
        let key = key_of(&entry);
        if let Some(at) = state.position(&key) {
            state.entries.remove(at);
        }
        state.entries.push((key, entry));
        state.trim();
        state.save();
    }

    /// The message is in the hands of the omp `instance` (it queues or runs it).
    pub fn handed(&self, entry: &OutboxSend, instance: &str) {
        let mut state = self.state();
        let Some(at) = state.position(&key_of(entry)) else {
            return;
        };
        let kept = &mut state.entries[at].1;
        if kept.instance.as_deref() == Some(instance) {
            return;
        }
        if kept.instance.is_none() {
            kept.instance_last = true;
        }
        kept.instance = Some(instance.to_owned());
        state.save();
    }

    /// The receiver's journal holds it (or it will never be owed again): nothing more to do.
    pub fn settle(&self, session_path: &str, device: Option<&str>, mark: &str) {
        let mut state = self.state();
        if let Some(at) = state.position(&entry_key(session_path, device, mark)) {
            state.entries.remove(at);
            state.save();
        }
    }

    /// Every message still owed, oldest first.
    pub fn pending(&self) -> Vec<OutboxSend> {
        self.state().pending()
    }

    /// The messages still owed to one receiver session, oldest first.
    pub fn owed_to(&self, session_path: &str, device: Option<&str>) -> Vec<OutboxSend> {
        let key = receiver_key(session_path, device);
        self.pending()
            .into_iter()
            .filter(|entry| receiver_key(&entry.session_path, entry.device.as_deref()) == key)
            .collect()
    }

    /// The highest dispatch number still owed to a receiver (0: none), above which a new dispatch is numbered.
    pub fn last_dispatch(&self, session_path: &str, device: Option<&str>) -> i64 {
        self.owed_to(session_path, device)
            .iter()
            .map(|entry| entry.dispatch.unwrap_or(0))
            .fold(0, i64::max)
    }

    /// The same message from the same sender, still owed to the receiver: a resend joins it.
    pub fn waiting(
        &self,
        from: &str,
        session_path: &str,
        device: Option<&str>,
        body: &str,
    ) -> Option<OutboxSend> {
        self.owed_to(session_path, device)
            .into_iter()
            .find(|entry| entry.from == from && entry.body == body)
    }

    /// Run `work` alone for one receiver session (deliveries to it never overlap).
    pub async fn lane<T>(&self, key: &str, work: impl Future<Output = T>) -> T {
        let lane = {
            let mut lanes = self
                .lanes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            lanes.entry(key.to_owned()).or_default().clone()
        };
        let result = {
            let _alone = lane.lock().await;
            work.await
        };
        let mut lanes = self
            .lanes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Ours and the map's are the only handles left: nobody waits on it.
        if Arc::strong_count(&lane) == 2 {
            lanes.remove(key);
        }
        result
    }
}

/// How handing a prompt over went: taken (or queued behind a command still running there), or refused or unsent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandOver {
    Handed,
    Refused,
}

/// What `deliver_owed` asks of main (`OwedDeps`).
pub trait OwedDeps: Sync {
    /// The live tab holding the receiver's session now (a new id after a relaunch); none while it is not open or
    /// starting.
    fn tab_of(&self, session_path: &str, device: Option<&str>) -> Option<String>;
    /// The receiver's bridge about the markers; `None` when it cannot be asked (starting, going away).
    fn sent(
        &self,
        tab_id: &str,
        marks: &[String],
    ) -> impl Future<Output = Option<SentAnswer>> + Send;
    /// Hand the prompt to the receiver's omp.
    fn prompt(&self, tab_id: &str, entry: &OutboxSend) -> impl Future<Output = HandOver> + Send;
    /// The receiver's omp is idle with nothing queued: a message it held and did not journal was withdrawn.
    fn drained(&self, tab_id: &str) -> impl Future<Output = bool> + Send;
}

/// Hand one receiver session what is still owed to it, in order: settle what its journal holds; leave what its
/// current omp already holds; send the rest to it once. Stops at the first message it cannot hand over. Resolves true
/// when nothing owed is left unhanded. Run inside the receiver's lane.
pub async fn deliver_owed<D: OwedDeps>(
    outbox: &SendOutbox,
    deps: &D,
    session_path: &str,
    device: Option<&str>,
) -> bool {
    let owed = outbox.owed_to(session_path, device);
    if owed.is_empty() {
        return true;
    }
    let Some(tab_id) = deps.tab_of(session_path, device) else {
        return false;
    };
    let marks: Vec<String> = owed.iter().map(|entry| entry.mark.clone()).collect();
    let Some(answer) = deps.sent(&tab_id, &marks).await else {
        return false;
    };
    let mut drained: Option<bool> = None;
    for entry in &owed {
        if answer.journaled.contains(&entry.mark) {
            outbox.settle(&entry.session_path, entry.device.as_deref(), &entry.mark);
            continue;
        }
        let same_tab = format!("tab:{tab_id}");
        if entry.instance.as_deref() == Some(answer.instance.as_str())
            || entry.instance.as_deref() == Some(same_tab.as_str())
        {
            outbox.handed(entry, &answer.instance);
            // Its omp holds it no more and never journaled it: withdrawn from the queue.
            let gone = match drained {
                Some(known) => known,
                None => {
                    let asked = deps.drained(&tab_id).await;
                    drained = Some(asked);
                    asked
                }
            };
            if gone {
                outbox.settle(&entry.session_path, entry.device.as_deref(), &entry.mark);
            }
            continue;
        }
        if deps.prompt(&tab_id, entry).await == HandOver::Refused {
            return false;
        }
        outbox.handed(entry, &answer.instance);
    }
    true
}

/// One pass over every receiver owed a message (the runtime's sweep).
pub async fn redeliver_sends<D: OwedDeps>(outbox: &SendOutbox, deps: &D) {
    let mut receivers: Vec<(String, String, Option<String>)> = Vec::new();
    for entry in outbox.pending() {
        let key = receiver_key(&entry.session_path, entry.device.as_deref());
        match receivers.iter_mut().find(|(held, ..)| *held == key) {
            Some(held) => *held = (key, entry.session_path, entry.device),
            None => receivers.push((key, entry.session_path, entry.device)),
        }
    }
    for (key, session_path, device) in receivers {
        outbox
            .lane(
                &key,
                deliver_owed(outbox, deps, &session_path, device.as_deref()),
            )
            .await;
    }
}
