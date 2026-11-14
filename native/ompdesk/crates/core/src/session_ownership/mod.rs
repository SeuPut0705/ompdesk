//! Per-execution tags and the scratch folders they own. Base alone admits/revokes `Owner`; this service retains
//! ownership metadata, never authority. `closing` precedes pool disposal, and `released` follows the exact
//! `Released.exited` receipt. Until that receipt, a Closing tag remains held and cannot be swept or taken over.

mod journal;
mod model;
mod scratch;

pub use model::{Config, Facts, Lease, ScratchRecord, ScratchSweep, TagOwner, TagRecord};
pub use model::{SESSION_TAG_ENV, STOCK_WORKER_ARG};

use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use ompdesk_app_contract::Owner;
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::server::{Fault, Scope};
use model::{Entry, Phase, RETRY_REMAINING_MS, fresh_tag, now_ms, session_key};

/// Native application facts, not calls back to Electron. The implementation reads Base's hosted-tab snapshot.
/// Do not call this service while holding the snapshot's lock.
pub trait Host: Send + Sync + 'static {
    fn hosted_held(&self, session_path: &str) -> bool;
    fn log(&self, message: &str, details: Value);
}

struct State {
    entries: Vec<Entry>,
    scratch: Vec<ScratchRecord>,
    closed: HashSet<Owner>,
    cleaning: BTreeSet<String>,
    frozen: bool,
    ending: usize,
}

pub struct SessionOwnership {
    config: Config,
    host: Arc<dyn Host>,
    state: Mutex<State>,
    changed: Notify,
    #[cfg(test)]
    scratch_gate: Mutex<Option<scratch::Gate>>,
}

impl SessionOwnership {
    pub fn new(config: Config, host: Arc<dyn Host>) -> Arc<Self> {
        let mut entries: Vec<Entry> = Vec::new();
        for record in journal::tags(&config.process_file) {
            let entry = Entry {
                record,
                phase: Phase::Left,
                pid: None,
                retried: false,
            };
            if let Some(known) = entries
                .iter_mut()
                .find(|known| known.record.tag == entry.record.tag)
            {
                *known = entry;
            } else {
                entries.push(entry);
            }
        }
        let mut scratch: Vec<ScratchRecord> = Vec::new();
        for record in journal::scratch(&config.scratch_file) {
            if let Some(known) = scratch.iter_mut().find(|known| known.tag == record.tag) {
                *known = record;
            } else {
                scratch.push(record);
            }
        }
        Arc::new(Self {
            state: Mutex::new(State {
                entries,
                scratch,
                closed: HashSet::new(),
                cleaning: BTreeSet::new(),
                frozen: false,
                ending: 0,
            }),
            config,
            host,
            changed: Notify::new(),
            #[cfg(test)]
            scratch_gate: Mutex::new(None),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Called only by Base's actual pool acquisition with authenticated execution facts. No page dispatcher exists here.
    pub fn acquire(&self, owner: &Owner, facts: Facts) -> Result<Lease, Fault> {
        let mut state = self.lock();
        if state.frozen || state.closed.contains(owner) {
            return Err(Fault::new("owner_closed", "The execution owner is closed"));
        }
        let existing = state
            .entries
            .iter()
            .position(|entry| entry.phase == Phase::Live(owner.clone()));
        let inherited = facts.session_path.as_deref().and_then(|path| {
            let key = session_key(path);
            state.entries.iter().position(|entry| {
                entry.phase == Phase::Left
                    && entry.record.facts.device.is_some() == facts.device.is_some()
                    && entry
                        .record
                        .facts
                        .session_path
                        .as_deref()
                        .is_some_and(|known| session_key(known) == key)
            })
        });
        let session_path = facts.session_path.clone();
        let index = if let Some(index) = existing.or(inherited) {
            state.entries[index].phase = Phase::Live(owner.clone());
            state.entries[index].record.facts = facts;
            index
        } else {
            let tag = loop {
                let candidate = fresh_tag()?;
                if !state
                    .entries
                    .iter()
                    .any(|entry| entry.record.tag == candidate)
                    && !state.scratch.iter().any(|record| record.tag == candidate)
                    && !state.cleaning.contains(&candidate)
                {
                    break candidate;
                }
            };
            state.entries.push(Entry {
                record: TagRecord {
                    tag,
                    facts,
                    since: now_ms(),
                },
                phase: Phase::Live(owner.clone()),
                pid: None,
                retried: false,
            });
            state.entries.len() - 1
        };
        let tag = state.entries[index].record.tag.clone();
        journal::save_tags(&state, &self.config.process_file, self.host.as_ref());
        let scratch = self.open_scratch(&mut state, &tag, session_path.as_deref());
        Ok(Lease { tag, scratch })
    }

    pub fn update(&self, owner: &Owner, facts: Facts) -> Result<(), Fault> {
        let mut state = self.lock();
        let entry = state
            .entries
            .iter_mut()
            .find(|entry| entry.phase == Phase::Live(owner.clone()))
            .ok_or_else(|| Fault::new("owner_closed", "The execution owner holds no live tag"))?;
        if entry.record.facts == facts {
            return Ok(());
        }
        let session_path = facts.session_path.clone();
        entry.record.facts = facts;
        let tag = entry.record.tag.clone();
        journal::save_tags(&state, &self.config.process_file, self.host.as_ref());
        if let Some(path) = session_path {
            self.note_session(&mut state, &tag, &path);
        }
        Ok(())
    }

    /// The native Sidecar Sink's current pid. A stale event after closing cannot revive an owner.
    pub fn pid(&self, owner: &Owner, pid: Option<u32>) {
        let mut state = self.lock();
        if let Some(entry) = state
            .entries
            .iter_mut()
            .find(|entry| entry.phase == Phase::Live(owner.clone()))
        {
            entry.pid = pid;
        }
    }

    /// Linearizes close before any awaited pool/sidecar work, including close winning before acquisition.
    pub fn closing(&self, owner: &Owner) {
        let mut state = self.lock();
        state.closed.insert(owner.clone());
        if let Some(entry) = state
            .entries
            .iter_mut()
            .find(|entry| entry.phase == Phase::Live(owner.clone()))
        {
            entry.phase = Phase::Closing(owner.clone());
            entry.pid = None;
        }
    }

    /// Base calls this only after joining the exact pool exit receipt. Dropping its caller does not drop the end.
    pub fn released(self: &Arc<Self>, owner: &Owner) {
        self.closing(owner);
        let tag = {
            let mut state = self.lock();
            if state.frozen {
                return;
            }
            let Some(entry) = state
                .entries
                .iter_mut()
                .find(|entry| entry.phase == Phase::Closing(owner.clone()))
            else {
                return;
            };
            entry.phase = Phase::Ending;
            let tag = entry.record.tag.clone();
            state.ending += 1;
            tag
        };
        self.spawn_end(tag, "closed");
    }

    /// Latches before quit tears down sources. A frozen close keeps the persisted tag for the next launch.
    pub fn freeze(&self) {
        self.lock().frozen = true;
    }

    /// The native restored-layout and interrupted-work keep set is captured by Base before this call.
    pub fn sweep(self: &Arc<Self>, keep: &BTreeSet<String>, hosted_grace_ms: u64) {
        let keep: BTreeSet<String> = keep.iter().map(|path| session_key(path)).collect();
        let (tags, hosted) = {
            let mut state = self.lock();
            if state.frozen {
                return;
            }
            let mut tags = Vec::new();
            let mut hosted = false;
            for entry in &mut state.entries {
                if entry.phase != Phase::Left {
                    continue;
                }
                if entry.record.facts.device.is_some() {
                    hosted = true;
                    continue;
                }
                if entry
                    .record
                    .facts
                    .session_path
                    .as_deref()
                    .is_some_and(|path| keep.contains(&session_key(path)))
                {
                    continue;
                }
                entry.phase = Phase::Ending;
                tags.push(entry.record.tag.clone());
            }
            state.ending += tags.len();
            (tags, hosted)
        };
        for tag in tags {
            self.spawn_end(tag, "relaunch");
        }
        if hosted {
            let weak = Arc::downgrade(self);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(hosted_grace_ms)).await;
                if let Some(service) = weak.upgrade() {
                    service.sweep_hosted();
                }
            });
        }
    }

    fn sweep_hosted(self: &Arc<Self>) {
        let tags = {
            let mut state = self.lock();
            if state.frozen {
                return;
            }
            let mut tags = Vec::new();
            for entry in &mut state.entries {
                if entry.phase != Phase::Left || entry.record.facts.device.is_none() {
                    continue;
                }
                if entry
                    .record
                    .facts
                    .session_path
                    .as_deref()
                    .is_some_and(|path| self.host.hosted_held(path))
                {
                    continue;
                }
                entry.phase = Phase::Ending;
                tags.push(entry.record.tag.clone());
            }
            state.ending += tags.len();
            tags
        };
        for tag in tags {
            self.spawn_end(tag, "relaunch");
        }
    }

    /// A restored tab closed without ever spawning, or a prior end failed for that session.
    pub fn session_released(self: &Arc<Self>, session_path: &str, device: Option<&str>) {
        let key = session_key(session_path);
        let tags = {
            let mut state = self.lock();
            if state.frozen {
                return;
            }
            let mut tags = Vec::new();
            for entry in &mut state.entries {
                if entry.phase == Phase::Left
                    && entry.record.facts.device.is_some() == device.is_some()
                    && entry
                        .record
                        .facts
                        .session_path
                        .as_deref()
                        .is_some_and(|path| session_key(path) == key)
                {
                    entry.phase = Phase::Ending;
                    tags.push(entry.record.tag.clone());
                }
            }
            state.ending += tags.len();
            tags
        };
        for tag in tags {
            self.spawn_end(tag, "closed");
        }
    }

    fn spawn_end(self: &Arc<Self>, tag: String, reason: &'static str) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let result = crate::procs::end(
                crate::procs::EndParams {
                    env: SESSION_TAG_ENV.to_owned(),
                    tags: vec![tag.clone()],
                    keep_arg: Some(STOCK_WORKER_ARG.to_owned()),
                    grace_ms: 5_000,
                    timeout_ms: 20_000,
                },
                Scope::detached(),
            )
            .await;
            service.finish_end(&tag, reason, result);
        });
    }

    fn finish_end(
        self: &Arc<Self>,
        tag: &str,
        reason: &'static str,
        result: Result<crate::procs::Report, Fault>,
    ) {
        let mut state = self.lock();
        let index = state
            .entries
            .iter()
            .position(|entry| entry.record.tag == tag && entry.phase == Phase::Ending);
        let mut retry = false;
        if let Some(index) = index {
            match result {
                Err(error) => {
                    state.entries[index].phase = Phase::Left;
                    let mut details = whose(&state.entries[index].record, reason);
                    details["level"] = json!("warn");
                    details["error"] = json!(error.message);
                    self.host.log("not ended", details);
                }
                Ok(report) => {
                    self.log_end(&state.entries[index].record, reason, &report);
                    // An own-tag refusal also leaves running processes, so its ownership must remain recoverable.
                    if report.left.is_empty() && report.kept.is_empty() && report.own.is_empty() {
                        state.entries.remove(index);
                        journal::save_tags(&state, &self.config.process_file, self.host.as_ref());
                    } else {
                        let entry = &mut state.entries[index];
                        entry.phase = Phase::Left;
                        retry =
                            !entry.retried && (!report.left.is_empty() || !report.kept.is_empty());
                        entry.retried |= retry;
                    }
                }
            }
        }
        state.ending -= 1;
        self.changed.notify_waiters();
        drop(state);
        if retry {
            let weak = Arc::downgrade(self);
            let tag = tag.to_owned();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(RETRY_REMAINING_MS)).await;
                if let Some(service) = weak.upgrade() {
                    service.retry(tag, reason);
                }
            });
        }
    }

    fn retry(self: &Arc<Self>, tag: String, reason: &'static str) {
        let mut state = self.lock();
        if state.frozen {
            return;
        }
        let Some(entry) = state
            .entries
            .iter_mut()
            .find(|entry| entry.record.tag == tag && entry.phase == Phase::Left)
        else {
            return;
        };
        entry.phase = Phase::Ending;
        state.ending += 1;
        drop(state);
        self.spawn_end(tag, reason);
    }

    fn log_end(&self, record: &TagRecord, reason: &str, report: &crate::procs::Report) {
        if !report.own.is_empty() {
            let mut details = whose(record, reason);
            details["level"] = json!("warn");
            self.host.log(
                "refused: OMPdesk itself runs under this session's tag",
                details,
            );
        } else if !report.ended.is_empty() || !report.left.is_empty() {
            let mut details = whose(record, reason);
            details["level"] = json!(if report.left.is_empty() {
                "info"
            } else {
                "warn"
            });
            details["processes"] = json!(report.ended.len());
            details["forced"] = json!(report.ended.iter().filter(|process| process.forced).count());
            details["mb"] = json!(
                (report
                    .ended
                    .iter()
                    .map(|process| process.bytes as f64)
                    .sum::<f64>()
                    / 1_048_576.0)
                    .round()
            );
            details["names"] = json!(name_counts(
                report.ended.iter().map(|process| process.name.as_str())
            ));
            if !report.left.is_empty() {
                details["left"] = json!(report.left.len());
                details["leftNames"] = json!(name_counts(
                    report.left.iter().map(|process| process.name.as_str())
                ));
            }
            if !report.kept.is_empty() {
                details["kept"] = json!(report.kept.len());
            }
            self.host.log("ended", details);
        }
    }

    fn holds(&self, tag: &str) -> bool {
        self.lock()
            .entries
            .iter()
            .any(|entry| entry.record.tag == tag)
    }

    pub fn held(&self) -> BTreeSet<String> {
        self.lock()
            .entries
            .iter()
            .filter(|entry| entry.phase != Phase::Ending)
            .map(|entry| entry.record.tag.clone())
            .collect()
    }

    pub fn owners(&self) -> Vec<TagOwner> {
        self.lock()
            .entries
            .iter()
            .map(|entry| TagOwner {
                tag: entry.record.tag.clone(),
                facts: entry.record.facts.clone(),
                pid: entry.pid,
            })
            .collect()
    }

    pub fn scratch_records(&self) -> Vec<ScratchRecord> {
        self.lock().scratch.clone()
    }

    pub async fn settled(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = self.lock();
                if state.ending == 0 && state.cleaning.is_empty() {
                    return;
                }
            }
            changed.await;
        }
    }
}

fn whose(record: &TagRecord, reason: &str) -> Value {
    let mut details = json!({"reason":reason, "folder":record.facts.cwd});
    if let Some(path) = &record.facts.session_path {
        details["session"] = json!(
            std::path::Path::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        );
    }
    if let Some(device) = &record.facts.device {
        details["device"] = json!(device);
    }
    details
}

fn name_counts<'a>(names: impl Iterator<Item = &'a str>) -> String {
    use std::fmt::Write as _;
    let mut counts = std::collections::HashMap::new();
    for (order, name) in names.enumerate() {
        let (count, _) = counts.entry(name).or_insert((0usize, order));
        *count += 1;
    }
    let mut counts: Vec<_> = counts.into_iter().collect();
    counts.sort_unstable_by(|a, b| b.1.0.cmp(&a.1.0).then_with(|| a.1.1.cmp(&b.1.1)));
    let mut text = String::new();
    for (name, (count, _)) in counts.into_iter().take(6) {
        if !text.is_empty() {
            text.push_str(", ");
        }
        let _ = write!(text, "{name}×{count}");
    }
    text
}

#[cfg(test)]
mod tests;
