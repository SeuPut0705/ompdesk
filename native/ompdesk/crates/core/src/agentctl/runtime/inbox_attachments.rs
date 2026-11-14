//! Receiving-native attachment custody. Upload namespaces come from authenticated routing, never message text.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::agentctl::inbox::{NativeInboxKey, NativeInboxTransfer};
use crate::agentctl::journal::attachments::{
    ATTACHMENT_MAX_BYTES, AttachmentPin, AttachmentRef, AttachmentStore, LandedFile, sha256_hex,
};
use crate::agentctl::journal::inbox_ledger::Ownership;
use crate::agentctl::journal::{Clock, Persistence};
use crate::web::uploads::UploadStore;

pub(super) struct Imported {
    pub transfer: NativeInboxTransfer,
    pub pin: AttachmentPin,
    pub persistence: Option<Persistence>,
}

/// `owned` is computed by the receiving ledger's exact logical identity check, never supplied on the wire.
/// Only an already-owned delivery may reuse local bytes without a fresh authorized upload reference.
pub(super) async fn import(
    mut transfer: NativeInboxTransfer,
    owned: &HashMap<NativeInboxKey, Ownership>,
    store: &Arc<AttachmentStore>,
    uploads: &UploadStore,
    upload_device: &str,
    now: &Clock,
    fence: &(impl Fn() -> Result<(), String> + Sync),
) -> Result<Imported, String> {
    fence()?;
    let mut expected: HashMap<&str, &AttachmentRef> = HashMap::new();
    let mut all_hashes = HashSet::new();
    let mut needs_upload = HashSet::new();
    let file_reference: for<'a> fn(&'a LandedFile) -> &'a AttachmentRef = |file| &file.file;
    for item in &transfer.entries {
        let ownership = owned.get(&item.entry.key());
        let already_owned = ownership.is_some();
        let Some(set) = &item.attachments else {
            continue;
        };
        for reference in set
            .images
            .iter()
            .chain(set.files.iter().map(file_reference))
        {
            if reference.size > ATTACHMENT_MAX_BYTES as u64 {
                return Err(format!(
                    "Invalid native inbox attachment size: {}",
                    reference.name
                ));
            }
            all_hashes.insert(reference.sha256.as_str());
            if ownership == Some(&Ownership::ContextObserved) {
                continue;
            }
            if let Some(previous) = expected.insert(&reference.sha256, reference)
                && previous.size != reference.size
            {
                return Err("Conflicting native inbox attachment sizes".into());
            }
            if !already_owned {
                needs_upload.insert(reference.sha256.as_str());
            }
        }
    }
    let mut paths = HashMap::with_capacity(transfer.uploads.len());
    for upload in &transfer.uploads {
        if upload.path.is_empty()
            || !all_hashes.contains(upload.sha256.as_str())
            || paths
                .insert(upload.sha256.as_str(), (upload.path.as_str(), false))
                .is_some()
        {
            return Err("Invalid, unrelated or duplicate native inbox upload reference".into());
        }
    }
    let has_attachments = !expected.is_empty();
    let pin = store.pin(expected.keys().copied())?;
    for (sha, reference) in expected {
        fence()?;
        if !needs_upload.contains(sha) {
            let held = store.get(sha).await;
            fence()?;
            if let Some(bytes) = held {
                if bytes.len() as u64 != reference.size {
                    return Err(
                        "Stored native inbox attachment size differs from its identity".into(),
                    );
                }
                continue;
            }
        }
        let (path, verified) = paths
            .get_mut(sha)
            .ok_or_else(|| format!("No authorized upload for {}", reference.name))?;
        let bytes = uploads.read(upload_device, path).await.map_err(|failure| {
            format!(
                "Cannot accept inbox attachment {}: {}",
                reference.name, failure.message
            )
        })?;
        fence()?;
        if bytes.len() as u64 != reference.size || sha256_hex(&bytes) != sha {
            return Err(format!(
                "Native inbox attachment bytes do not match {}",
                reference.name
            ));
        }
        store.put(Arc::new(bytes)).await?;
        fence()?;
        *verified = true;
    }
    let at = now();
    for item in &mut transfer.entries {
        if let Some(set) = &mut item.attachments {
            for file in &mut set.files {
                if let Some((path, true)) = paths.get(file.file.sha256.as_str()) {
                    file.path = (*path).to_owned();
                    file.landed_at = at;
                }
            }
        }
    }
    let persistence = has_attachments.then(|| store.persistence());
    Ok(Imported {
        transfer,
        pin,
        persistence,
    })
}

#[cfg(test)]
mod tests;
