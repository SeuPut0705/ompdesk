//! Receiving-hop responsibility only. Producer outboxes remain separate; a bridge receipt is not a disk ACK.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::attachments::{AttachedSet, UPLOAD_TTL_MS, sha256_hex};
#[cfg(test)]
use super::system_clock;
use super::{Clock, Persistence, persist_text};
use crate::agentctl::inbox::{
    InboxAcceptedDelivery, InboxContextReceipt, InboxEvidence, InboxIntent, InboxReceiver,
    NativeInboxAcceptance, NativeInboxKey, NativeInboxLookupEntry, NativeInboxLookupResult,
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
        entry: Box<NativeInboxTransferEntry>,
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

type Index = HashMap<Address, HashMap<NativeInboxKey, usize>>;

struct Loaded {
    entries: Vec<Record>,
    index: Index,
}

fn load(file: Option<&Path>) -> Result<Loaded, String> {
    let entries = match file {
        None => Vec::new(),
        Some(path) => match std::fs::read(path) {
            Ok(bytes) => {
                let file: File = serde_json::from_slice(&bytes).map_err(|error| {
                    format!("Unreadable inbox ledger {}: {error}", path.display())
                })?;
                if file.version != 1 {
                    return Err(format!("Unsupported inbox ledger version {}", file.version));
                }
                file.entries
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(format!(
                    "Cannot read inbox ledger {}: {error}",
                    path.display()
                ));
            }
        },
    };
    let mut index: Index = HashMap::new();
    for (position, record) in entries.iter().enumerate() {
        if index
            .entry(record.receiver.clone())
            .or_default()
            .insert(record.key.clone(), position)
            .is_some()
        {
            return Err("Duplicate identity in inbox ledger; original file retained".into());
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
            return Err("Damaged identity/proof in inbox ledger; original file retained".into());
        }
        if let Delivery::Pending { entry } = &record.delivery {
            match fingerprint(entry) {
                Ok(hash)
                    if entry.logical.validate(&entry.entry).is_ok()
                        && entry.entry.key() == record.key
                        && hash == record.fingerprint
                        && entry.dispatch == record.dispatch => {}
                _ => {
                    return Err("Damaged payload in inbox ledger; original file retained".into());
                }
            }
        }
    }
    Ok(Loaded { entries, index })
}

fn existing<'a>(
    entries: &'a [Record],
    index: &Index,
    receiver: &Address,
    key: &NativeInboxKey,
    fingerprint: &str,
) -> Result<Option<&'a Record>, String> {
    let Some(position) = index.get(receiver).and_then(|keys| keys.get(key)) else {
        return Ok(None);
    };
    let record = &entries[*position];
    if record.fingerprint != fingerprint {
        return Err("Native inbox identity conflicts with an existing delivery".into());
    }
    Ok(Some(record))
}

struct State {
    file: Option<PathBuf>,
    entries: Vec<Record>,
    index: Index,
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
    Pending { intent: InboxIntent },
    ContextObserved,
}

/// Ordered pending payloads plus compact, permanent consumed identities. No TTL, size or idle trim.
/// A damaged/unreadable file fails closed and is never overwritten with an empty replacement.
pub(crate) struct InboxLedger {
    state: Mutex<State>,
}

fn fingerprint(entry: &NativeInboxTransferEntry) -> Result<String, String> {
    fingerprint_payload(entry.logical_payload().map_err(|error| error.to_string())?)
}

fn fingerprint_payload(mut value: serde_json::Value) -> Result<String, String> {
    value.sort_all_objects();
    let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    Ok(sha256_hex(&bytes))
}

pub(crate) fn visit_current_receipts(
    receiver: &InboxReceiver,
    reply: &NativeInboxReply,
    mut visit: impl FnMut(NativeInboxKey, &InboxContextReceipt),
) -> Result<(), String> {
    if reply.receiver != *receiver {
        return Err("Native inbox receiver changed before receipt reconciliation".into());
    }
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
            if receipt.instance == receiver.instance {
                visit(NativeInboxKey { kind, delivery_id }, receipt);
            }
        }
    }
    Ok(())
}

impl InboxLedger {
    #[cfg(test)]
    pub fn new(file: Option<PathBuf>) -> Self {
        Self::with_clock(file, system_clock())
    }

    pub fn with_clock(file: Option<PathBuf>, now: Clock) -> Self {
        let (entries, index, load_error) = match load(file.as_deref()) {
            Ok(loaded) => (loaded.entries, loaded.index, None),
            Err(error) => (Vec::new(), HashMap::new(), Some(error)),
        };
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
            let (dispatch, prior) = if let Some(record) =
                existing(&state.entries, &state.index, &address, &key, &hash)?
            {
                (record.dispatch, true)
            } else {
                prepared.push(Record {
                    receiver: address.clone(),
                    key: key.clone(),
                    fingerprint: hash,
                    dispatch: entry.dispatch,
                    delivery: Delivery::Pending {
                        entry: Box::new(entry.clone()),
                    },
                });
                (entry.dispatch, false)
            };
            deliveries.push(InboxAcceptedDelivery {
                key,
                dispatch,
                existing: prior,
            });
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
                    Delivery::Pending { entry } => Some(entry.as_ref().clone()),
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
        visit_current_receipts(receiver, reply, |key, receipt| {
            if let Some(position) = state.index.get(&address).and_then(|keys| keys.get(&key)) {
                observed.entry(*position).or_insert_with(|| Proof {
                    request_id: receipt.request_id.clone(),
                    instance: receipt.instance.clone(),
                    evidence: receipt.evidence,
                });
            }
        })?;
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
            if let Some(record) = existing(
                &state.entries,
                &state.index,
                &address,
                &key,
                &fingerprint(entry)?,
            )? {
                let ownership = match &record.delivery {
                    Delivery::Pending { entry } => Ownership::Pending {
                        intent: entry.entry.intent,
                    },
                    Delivery::ContextObserved { .. } => Ownership::ContextObserved,
                };
                known.insert(key, ownership);
            }
        }
        Ok(known)
    }

    /// Read the actual canonical disk inventory without admitting, saving, waking or importing anything.
    pub fn lookup(
        &self,
        receiver: &InboxReceiver,
        entries: &[NativeInboxLookupEntry],
    ) -> Result<Vec<NativeInboxLookupResult>, String> {
        let state = self.lock();
        state.readable()?;
        let disk = load(state.file.as_deref())?;
        let address = Address::from(receiver);
        let mut seen = HashSet::with_capacity(entries.len());
        let mut result = Vec::with_capacity(entries.len());
        for entry in entries {
            entry
                .logical
                .validate_identity(entry.key.kind, &entry.key.delivery_id)?;
            if entry.logical.target.session_path != receiver.session_path {
                return Err(
                    "The logical native recipient differs from the receiving session".into(),
                );
            }
            let key = entry.key.clone();
            if !seen.insert(key.clone()) {
                return Err("Duplicate identity in native inbox lookup".into());
            }
            let hash =
                fingerprint_payload(entry.logical_payload().map_err(|error| error.to_string())?)?;
            let memory = existing(&state.entries, &state.index, &address, &key, &hash)?;
            let stored = existing(&disk.entries, &disk.index, &address, &key, &hash)?;
            let Some(record) = stored else {
                if memory.is_some() {
                    return Err(
                        "Native inbox disk ownership is unconfirmed; original remains pending"
                            .into(),
                    );
                }
                result.push(NativeInboxLookupResult::Missing { key });
                continue;
            };
            result.push(match &record.delivery {
                Delivery::Pending { entry } => NativeInboxLookupResult::ExistingPending {
                    key,
                    dispatch: record.dispatch,
                    intent: entry.entry.intent,
                },
                Delivery::ContextObserved { proof, .. } => {
                    NativeInboxLookupResult::ExistingContextObserved {
                        context_receipt: InboxContextReceipt {
                            request_id: proof.request_id.clone(),
                            session_path: record.receiver.session_path.clone(),
                            instance: proof.instance.clone(),
                            ids: vec![key.provider_id()],
                            evidence: proof.evidence,
                        },
                        key,
                        dispatch: record.dispatch,
                    }
                }
            });
        }
        Ok(result)
    }

    pub fn receivers(&self) -> Result<Vec<Address>, String> {
        let state = self.lock();
        state.readable()?;
        let mut seen = HashSet::new();
        Ok(state
            .entries
            .iter()
            .filter(|record| {
                matches!(record.delivery, Delivery::Pending { .. })
                    && seen.insert(record.receiver.clone())
            })
            .map(|record| record.receiver.clone())
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
        let record = &mut state.entries[position];
        if let Delivery::Pending { entry } = &mut record.delivery
            && entry.attachments.as_ref() != Some(attachments)
        {
            let mut updated = entry.as_ref().clone();
            updated.attachments = Some(attachments.clone());
            if fingerprint(&updated)? != record.fingerprint {
                return Err("Native inbox materialization changed logical attachments".into());
            }
            **entry = updated;
            state.dirty = true;
        }
        state.save()
    }
}

#[cfg(test)]
mod identity_tests;
#[cfg(test)]
mod lookup_tests;
#[cfg(test)]
mod tests;
