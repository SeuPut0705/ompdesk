//! Receiving-hop responsibility only. Producer outboxes remain separate; a bridge receipt is not a disk ACK.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::attachments::{AttachedSet, UPLOAD_TTL_MS, sha256_hex};
use super::{Clock, Persistence, persist_text, system_clock};
use crate::agentctl::inbox::{
    InboxAcceptedDelivery, InboxEvidence, InboxReceiver, NativeInboxAcceptance, NativeInboxKey,
    NativeInboxReply, NativeInboxTransferEntry,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Address {
    pub session_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

impl From<&InboxReceiver> for Address {
    fn from(receiver: &InboxReceiver) -> Self {
        Self {
            session_path: receiver.session_path.clone(),
            device: receiver.device.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Proof {
    request_id: String,
    instance: String,
    evidence: InboxEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Delivery {
    Pending {
        entry: NativeInboxTransferEntry,
    },
    ContextObserved {
        proof: Proof,
        attachment_shas: Vec<String>,
        #[serde(deserialize_with = "deserialize_retention_time")]
        retain_until: f64,
    },
}

// The workspace enables serde_json/arbitrary_precision. Serde's flattened enum buffers a JSON number as a map;
// Number decodes that representation without weakening this field to an arbitrary value or changing its wire form.
fn deserialize_retention_time<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<f64, D::Error> {
    serde_json::Number::deserialize(deserializer)?
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| {
            serde::de::Error::custom("Inbox retention time must be a finite JSON number")
        })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    receiver: Address,
    key: NativeInboxKey,
    fingerprint: String,
    dispatch: Option<i64>,
    #[serde(flatten)]
    delivery: Delivery,
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    entries: Vec<Record>,
}

struct State {
    file: Option<PathBuf>,
    entries: Vec<Record>,
    index: HashMap<Address, HashMap<NativeInboxKey, usize>>,
    load_error: Option<String>,
    dirty: bool,
    now: Clock,
}

impl State {
    fn readable(&self) -> Result<(), String> {
        self.load_error
            .as_ref()
            .map_or(Ok(()), |error| Err(error.clone()))
    }

    fn existing(
        &self,
        receiver: &Address,
        key: &NativeInboxKey,
        fingerprint: &str,
    ) -> Result<Option<&Record>, String> {
        let Some(position) = self.index.get(receiver).and_then(|keys| keys.get(key)) else {
            return Ok(None);
        };
        let record = &self.entries[*position];
        if record.fingerprint != fingerprint {
            return Err("Native inbox identity conflicts with an existing delivery".into());
        }
        Ok(Some(record))
    }

    fn save(&mut self) -> Result<Persistence, String> {
        self.readable()?;
        if self.file.is_none() {
            self.dirty = false;
            return Ok(Persistence::Memory);
        }
        if !self.dirty {
            return Ok(Persistence::Disk);
        }
        #[derive(Serialize)]
        struct BorrowedFile<'a> {
            version: u32,
            entries: &'a [Record],
        }
        let text = serde_json::to_string(&BorrowedFile {
            version: 1,
            entries: &self.entries,
        })
        .map_err(|error| error.to_string())?;
        let result = persist_text(self.file.as_deref(), &text, Some(0o600));
        self.dirty = result.is_err();
        result
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ownership {
    Pending,
    ContextObserved,
}

/// Ordered pending payloads plus compact, permanent consumed identities. No TTL, size or idle trim.
/// A damaged/unreadable file fails closed and is never overwritten with an empty replacement.
pub(crate) struct InboxLedger {
    state: Mutex<State>,
}

fn fingerprint(entry: &NativeInboxTransferEntry) -> Result<String, String> {
    let mut value = entry.logical_payload().map_err(|error| error.to_string())?;
    value.sort_all_objects();
    let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    Ok(sha256_hex(&bytes))
}

impl InboxLedger {
    pub fn new(file: Option<PathBuf>) -> Self {
        Self::with_clock(file, system_clock())
    }

    pub fn with_clock(file: Option<PathBuf>, now: Clock) -> Self {
        let loaded = file.as_ref().map_or_else(
            || Ok(Vec::new()),
            |path| match std::fs::read(path) {
                Ok(bytes) => serde_json::from_slice::<File>(&bytes)
                    .map_err(|error| format!("Unreadable inbox ledger {}: {error}", path.display()))
                    .and_then(|file| {
                        if file.version == 1 {
                            Ok(file.entries)
                        } else {
                            Err(format!("Unsupported inbox ledger version {}", file.version))
                        }
                    }),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
                Err(error) => Err(format!(
                    "Cannot read inbox ledger {}: {error}",
                    path.display()
                )),
            },
        );
        let (entries, mut load_error) = match loaded {
            Ok(entries) => (entries, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        let mut index: HashMap<Address, HashMap<NativeInboxKey, usize>> = HashMap::new();
        for (position, record) in entries.iter().enumerate() {
            if index
                .entry(record.receiver.clone())
                .or_default()
                .insert(record.key.clone(), position)
                .is_some()
            {
                load_error =
                    Some("Duplicate identity in inbox ledger; original file retained".into());
                break;
            }
            if record.receiver.session_path.is_empty()
                || record.key.delivery_id.is_empty()
                || record.fingerprint.len() != 64
                || !record
                    .fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || matches!(&record.delivery, Delivery::ContextObserved { proof, attachment_shas, retain_until }
                    if proof.request_id.is_empty() || proof.instance.is_empty() || !retain_until.is_finite()
                        || attachment_shas.iter().any(|sha| sha.len() != 64
                            || !sha.bytes().all(|byte| byte.is_ascii_hexdigit())))
            {
                load_error =
                    Some("Damaged identity/proof in inbox ledger; original file retained".into());
                break;
            }
            if let Delivery::Pending { entry } = &record.delivery {
                match fingerprint(entry) {
                    Ok(hash)
                        if entry.logical.validate(&entry.entry).is_ok()
                            && entry.entry.key() == record.key
                            && hash == record.fingerprint
                            && entry.dispatch == record.dispatch => {}
                    _ => {
                        load_error =
                            Some("Damaged payload in inbox ledger; original file retained".into());
                        break;
                    }
                }
            }
        }
        Self {
            state: Mutex::new(State {
                file,
                entries,
                index,
                load_error,
                dirty: true,
                now,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Validate the entire batch before inserting anything. Same identity with changed data is a conflict,
    /// including after consumption. A failed save retains memory and write_kept's full-disk retry, not an ACK.
    pub fn keep(
        &self,
        receiver: &InboxReceiver,
        entries: &[NativeInboxTransferEntry],
    ) -> Result<NativeInboxAcceptance, String> {
        let mut state = self.lock();
        state.readable()?;
        if receiver.session_path.is_empty() || receiver.instance.is_empty() {
            return Err("Inbox receiver path and instance are required".into());
        }
        let address = Address::from(receiver);
        let mut seen = HashSet::with_capacity(entries.len());
        let mut prepared = Vec::with_capacity(entries.len());
        let mut deliveries = Vec::with_capacity(entries.len());
        for entry in entries {
            if entry.entry.delivery_id.is_empty() || entry.entry.sender.session.is_empty() {
                return Err("Inbox delivery identity and sender are required".into());
            }
            entry.logical.validate(&entry.entry)?;
            if entry.logical.target.session_path != receiver.session_path {
                return Err(
                    "The logical native recipient differs from the receiving session".into(),
                );
            }
            let key = entry.entry.key();
            if !seen.insert(key.clone()) {
                return Err("Duplicate identity in native inbox batch".into());
            }
            let hash = fingerprint(entry)?;
            let dispatch = if let Some(record) = state.existing(&address, &key, &hash)? {
                record.dispatch
            } else {
                prepared.push(Record {
                    receiver: address.clone(),
                    key: key.clone(),
                    fingerprint: hash,
                    dispatch: entry.dispatch,
                    delivery: Delivery::Pending {
                        entry: entry.clone(),
                    },
                });
                entry.dispatch
            };
            deliveries.push(InboxAcceptedDelivery { key, dispatch });
        }
        for record in prepared {
            let position = state.entries.len();
            state
                .index
                .entry(record.receiver.clone())
                .or_default()
                .insert(record.key.clone(), position);
            state.entries.push(record);
            state.dirty = true;
        }
        let persistence = state.save()?;
        Ok(NativeInboxAcceptance {
            persistence,
            receiver: receiver.clone(),
            deliveries,
        })
    }

    /// Delivery starts only after a successful disk save, including a retry after a failed keep/receipt save.
    /// Memory-only ledgers expose their records for tests, but never grant disk responsibility.
    pub fn pending(
        &self,
        receiver: &InboxReceiver,
    ) -> Result<(Persistence, Vec<NativeInboxTransferEntry>), String> {
        let mut state = self.lock();
        let persistence = state.save()?;
        let address = Address::from(receiver);
        let entries = state
            .entries
            .iter()
            .filter_map(|record| {
                if record.receiver != address {
                    return None;
                }
                match &record.delivery {
                    Delivery::Pending { entry } => Some(entry.clone()),
                    Delivery::ContextObserved { .. } => None,
                }
            })
            .collect();
        Ok((persistence, entries))
    }

    /// Only the authenticated current bridge's real provider-context receipts settle a payload. Status words
    /// alone (accepted/journaled/context_observed) do not. Persist compact identity/proof before forgetting bytes.
    pub fn reconcile(
        &self,
        receiver: &InboxReceiver,
        reply: &NativeInboxReply,
    ) -> Result<Persistence, String> {
        if reply.receiver != *receiver {
            return Err("Native inbox receiver changed before receipt reconciliation".into());
        }
        let mut state = self.lock();
        state.readable()?;
        let address = Address::from(receiver);
        let mut observed = HashMap::new();
        for receipt in &reply.receipts {
            if receipt.session_path != receiver.session_path
                || receipt.request_id.is_empty()
                || receipt.instance.is_empty()
            {
                return Err("Invalid native inbox provider-context receipt".into());
            }
            for id in &receipt.ids {
                let (kind, delivery_id) = serde_json::from_str(id)
                    .map_err(|error| format!("Invalid native inbox context identity: {error}"))?;
                let key = NativeInboxKey { kind, delivery_id };
                if let Some(position) = state.index.get(&address).and_then(|keys| keys.get(&key)) {
                    observed.entry(*position).or_insert_with(|| Proof {
                        request_id: receipt.request_id.clone(),
                        instance: receipt.instance.clone(),
                        evidence: receipt.evidence,
                    });
                }
            }
        }
        let retain_until = (state.now)() + UPLOAD_TTL_MS;
        for (position, proof) in observed {
            if let Delivery::Pending { entry } = &state.entries[position].delivery {
                let attachment_shas = entry
                    .attachments
                    .iter()
                    .flat_map(|set| set.shas())
                    .map(str::to_owned)
                    .collect();
                state.entries[position].delivery = Delivery::ContextObserved {
                    proof,
                    attachment_shas,
                    retain_until,
                };
                state.dirty = true;
            }
        }
        state.save()
    }

    /// Classify only against this receiver's own durable/native inventory, never caller-supplied attribution.
    pub fn known(
        &self,
        receiver: &InboxReceiver,
        entries: &[NativeInboxTransferEntry],
    ) -> Result<HashMap<NativeInboxKey, Ownership>, String> {
        let state = self.lock();
        state.readable()?;
        let address = Address::from(receiver);
        let mut known = HashMap::new();
        for entry in entries {
            let key = entry.entry.key();
            if let Some(record) = state.existing(&address, &key, &fingerprint(entry)?)? {
                let ownership = match &record.delivery {
                    Delivery::Pending { .. } => Ownership::Pending,
                    Delivery::ContextObserved { .. } => Ownership::ContextObserved,
                };
                known.insert(key, ownership);
            }
        }
        Ok(known)
    }

    pub fn receivers(&self) -> Result<Vec<Address>, String> {
        let state = self.lock();
        state.readable()?;
        let mut seen = HashSet::new();
        Ok(state
            .entries
            .iter()
            .filter_map(|record| {
                (matches!(record.delivery, Delivery::Pending { .. })
                    && seen.insert(record.receiver.clone()))
                .then(|| record.receiver.clone())
            })
            .collect())
    }

    /// Include these in the existing AttachmentStore sweep references. A corrupt ledger refuses collection.
    /// Observed input retains blobs for the ordinary upload lifetime, not merely until the first output.
    pub fn attachment_shas(&self) -> Result<HashSet<String>, String> {
        let state = self.lock();
        state.readable()?;
        let now = (state.now)();
        let mut keep = HashSet::new();
        for record in &state.entries {
            match &record.delivery {
                Delivery::Pending { entry } => keep.extend(
                    entry
                        .attachments
                        .iter()
                        .flat_map(|set| set.shas())
                        .map(str::to_owned),
                ),
                Delivery::ContextObserved {
                    attachment_shas,
                    retain_until,
                    ..
                } if *retain_until > now => keep.extend(attachment_shas.iter().cloned()),
                Delivery::ContextObserved { .. } => {}
            }
        }
        Ok(keep)
    }

    /// A destination-native rehome may update only derived landing data; logical identity is immutable.
    pub fn materialized(
        &self,
        receiver: &InboxReceiver,
        key: &NativeInboxKey,
        attachments: &AttachedSet,
    ) -> Result<Persistence, String> {
        let mut state = self.lock();
        state.readable()?;
        let address = Address::from(receiver);
        let position = state
            .index
            .get(&address)
            .and_then(|keys| keys.get(key))
            .copied()
            .ok_or("Unknown native inbox materialization identity")?;
        if let Delivery::Pending { entry } = &state.entries[position].delivery {
            if entry.attachments.as_ref() != Some(attachments) {
                let mut updated = entry.clone();
                updated.attachments = Some(attachments.clone());
                if fingerprint(&updated)? != state.entries[position].fingerprint {
                    return Err("Native inbox materialization changed logical attachments".into());
                }
                state.entries[position].delivery = Delivery::Pending { entry: updated };
                state.dirty = true;
            }
        }
        state.save()
    }
}

#[cfg(test)]
mod identity_tests;
#[cfg(test)]
mod tests;
