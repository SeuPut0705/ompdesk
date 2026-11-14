use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;

use super::model::{ARTIFACT_IDLE_MS, Phase, now_ms, session_key, valid_tag};
use super::{ScratchRecord, ScratchSweep, SessionOwnership, State, journal};
use crate::server::{Fault, Scope};

#[cfg(test)]
pub(super) struct Gate {
    pub reserved: tokio::sync::oneshot::Sender<()>,
    pub proceed: tokio::sync::oneshot::Receiver<()>,
}

impl SessionOwnership {
    pub(super) fn open_scratch(
        &self,
        state: &mut State,
        tag: &str,
        session: Option<&str>,
    ) -> Option<PathBuf> {
        if !state.scratch.iter().any(|record| record.tag == tag) {
            state.scratch.push(ScratchRecord {
                tag: tag.to_owned(),
                since: now_ms(),
                sessions: Vec::new(),
            });
            journal::save_scratch(state, &self.config.scratch_file, self.host.as_ref());
        }
        let dir = self.config.scratch_root.join(tag);
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        if let Err(error) = builder.create(&dir) {
            self.host.log(
                "scratch folder not made",
                json!({"error":error.to_string()}),
            );
            return None;
        }
        if let Some(session) = session {
            self.note_session(state, tag, session);
        }
        Some(dir)
    }

    pub(super) fn note_session(&self, state: &mut State, tag: &str, path: &str) {
        let key = session_key(path);
        let Some(record) = state.scratch.iter_mut().find(|record| record.tag == tag) else {
            return;
        };
        if record
            .sessions
            .iter()
            .any(|known| session_key(known) == key)
        {
            return;
        }
        record.sessions.push(path.to_owned());
        journal::save_scratch(state, &self.config.scratch_file, self.host.as_ref());
    }

    /// The native delete path has removed the session and tombstoned it before invoking this hook.
    /// Files used by a different session or by a still-held tag remain.
    pub async fn session_deleted(self: &Arc<Self>, session_path: &str) {
        let key = session_key(session_path);
        let tags = {
            let mut state = self.lock();
            let mut tags = Vec::new();
            let mut changed = false;
            for record in &mut state.scratch {
                let before = record.sessions.len();
                record.sessions.retain(|known| session_key(known) != key);
                if record.sessions.len() != before {
                    changed = true;
                    if record.sessions.is_empty() {
                        tags.push(record.tag.clone());
                    }
                }
            }
            if changed {
                journal::save_scratch(&state, &self.config.scratch_file, self.host.as_ref());
            }
            tags
        };
        for tag in tags {
            if let Err(error) = self.remove_scratch(&tag, Vec::new()).await {
                self.host
                    .log("scratch kept", json!({"tag":tag,"reason":error.message}));
            }
        }
    }

    /// A native disk-care pass supplies its session index snapshot, including moved session filenames.
    /// Process lookup and file removal are the existing Rust services, never caller-provided kill/delete effects.
    pub async fn sweep_scratch(self: &Arc<Self>, stored: &[String]) -> Result<ScratchSweep, Fault> {
        let root = self.config.scratch_root.clone();
        let names = tokio::task::spawn_blocking(move || -> Result<BTreeSet<String>, Fault> {
            match fs::read_dir(&root) {
                Ok(entries) => entries
                    .map(|entry| {
                        entry.map(|entry| entry.file_name().to_string_lossy().into_owned())
                    })
                    .collect::<Result<_, _>>()
                    .map_err(|error| Fault::new("scratch_read", error.to_string())),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeSet::new()),
                Err(error) => Err(Fault::new("scratch_read", error.to_string())),
            }
        })
        .await
        .map_err(|error| Fault::new("scratch_read", error.to_string()))??;
        {
            let mut state = self.lock();
            let held: BTreeSet<String> = state
                .entries
                .iter()
                .filter(|entry| entry.phase != Phase::Ending)
                .map(|entry| entry.record.tag.clone())
                .collect();
            let before = state.scratch.len();
            state
                .scratch
                .retain(|record| names.contains(&record.tag) || held.contains(&record.tag));
            if before != state.scratch.len() {
                journal::save_scratch(&state, &self.config.scratch_file, self.host.as_ref());
            }
        }
        let stored: Arc<[String]> = stored.into();
        let mut result = ScratchSweep::default();
        for tag in names {
            if !valid_tag(&tag) || self.holds(&tag) {
                continue;
            }
            let service = Arc::clone(self);
            let stored = Arc::clone(&stored);
            let candidate = tag.clone();
            let read =
                tokio::task::spawn_blocking(move || service.scratch_candidate(&candidate, &stored))
                    .await
                    .map_err(|error| Fault::new("scratch_read", error.to_string()))?;
            let sessions = match read {
                Ok(Some(sessions)) => sessions,
                Ok(None) => continue,
                Err(error) => {
                    if error.code == "scratch_kept" {
                        result.kept += 1;
                    } else {
                        result.failed += 1;
                    }
                    self.host
                        .log("scratch kept", json!({"tag":tag,"reason":error.message}));
                    continue;
                }
            };
            match self.remove_scratch(&tag, sessions).await {
                Ok(Some(bytes)) => result.removed.push(bytes),
                Ok(None) => {}
                Err(error) => {
                    if error.code == "scratch_kept" {
                        result.kept += 1;
                    } else {
                        result.failed += 1;
                    }
                    self.host
                        .log("scratch kept", json!({"tag":tag,"reason":error.message}));
                }
            }
        }
        Ok(result)
    }

    fn scratch_candidate(
        &self,
        tag: &str,
        stored: &[String],
    ) -> Result<Option<Vec<String>>, Fault> {
        let dir = self.config.scratch_root.join(tag);
        let facts = crate::disk::scratch::facts(&dir.to_string_lossy(), &Scope::detached())?;
        let record = self
            .lock()
            .scratch
            .iter()
            .find(|record| record.tag == tag)
            .cloned();
        if record.is_none() && facts.entries > 0 {
            return Err(Fault::new("scratch_kept", "its sessions are not known"));
        }
        let sessions = record.map_or_else(Vec::new, |record| {
            record
                .sessions
                .into_iter()
                .filter_map(|session| {
                    if fs::metadata(&session).is_ok() {
                        return Some(session);
                    }
                    let filename = Path::new(&session).file_name()?;
                    stored
                        .iter()
                        .find(|known| Path::new(known).file_name() == Some(filename))
                        .cloned()
                })
                .collect()
        });
        if !sessions.is_empty() && now_ms() - facts.newest_ms < ARTIFACT_IDLE_MS {
            return Ok(None);
        }
        Ok(Some(sessions))
    }

    async fn remove_scratch(
        self: &Arc<Self>,
        tag: &str,
        sessions: Vec<String>,
    ) -> Result<Option<u64>, Fault> {
        if self.holds(tag) {
            return Ok(None);
        }
        let processes = crate::procs::list(
            crate::procs::ListParams {
                env: super::SESSION_TAG_ENV.to_owned(),
                timeout_ms: 10_000,
            },
            Scope::detached(),
        )
        .await
        .map_err(|_| Fault::new("scratch_kept", "process check unavailable"))?;
        if processes
            .iter()
            .any(|process| process.tag.as_deref() == Some(tag))
        {
            return Err(Fault::new("scratch_kept", "a process of its session runs"));
        }
        {
            let mut state = self.lock();
            if state.frozen
                || state.entries.iter().any(|entry| entry.record.tag == tag)
                || !state.cleaning.insert(tag.to_owned())
            {
                return Ok(None);
            }
        }
        let service = Arc::clone(self);
        let tag = tag.to_owned();
        // The reservation remains until the actual blocking deletion completes, even if its caller is dropped.
        tokio::spawn(async move {
            #[cfg(test)]
            {
                let gate = service.scratch_gate.lock().unwrap().take();
                if let Some(gate) = gate {
                    let _ = gate.reserved.send(());
                    let _ = gate.proceed.await;
                }
            }
            let dir = service.config.scratch_root.join(&tag);
            let result = tokio::task::spawn_blocking(move || {
                crate::disk::scratch::sweep(&dir.to_string_lossy(), &sessions, &Scope::detached())
            })
            .await
            .map_err(|error| Fault::new("scratch_remove", error.to_string()))
            .and_then(|result| result);
            let mut state = service.lock();
            state.cleaning.remove(&tag);
            if let Ok(swept) = &result
                && swept.kept == 0
                && swept.left == 0
            {
                state.scratch.retain(|record| record.tag != tag);
                journal::save_scratch(&state, &service.config.scratch_file, service.host.as_ref());
            }
            service.changed.notify_waiters();
            result.map(|swept| (swept.removed > 0).then_some(swept.bytes))
        })
        .await
        .map_err(|error| Fault::new("scratch_remove", error.to_string()))?
    }
}
