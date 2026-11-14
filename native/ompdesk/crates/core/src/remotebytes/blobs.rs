//! The pictures of a paired host's subagent transcripts, kept on this device by their content address (was
//! `src/main/remote/image-blob-cache.ts`; main's `ImageBlobCache` finds the references in a transcript and puts back
//! what this answers).
//!
//! Stock keeps every image of a subagent journal in its blob store as `blob:sha256:<hex>`. A blob on disk is read
//! from disk; one it lacks is read from the host once (`blob` ask: main's `read_image_blob` over the link) and kept,
//! so each picture crosses the link once for this device, across tabs, hosts, store resets and relaunches. The bytes
//! are checked against their address before they are kept or shown, so a host can never put another picture under
//! a reference. Files: `<64 hex>`, the picture's bytes. Concurrent reads of one blob share one request.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::folder::{self, Folder};
use super::{ask, blocking};
use crate::server::{Call, Events, Fault, Reply, Scope};

const BLOB_REF_PREFIX: &str = "blob:sha256:";

fn is_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// `Buffer.from(text, "base64")` as node decodes it: both alphabets, any other character skipped, the first `=` the
/// end, a last group of two or three characters giving one or two bytes.
pub(crate) fn node_base64(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() / 4 * 3 + 2);
    let (mut bits, mut count) = (0u32, 0);
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = bits << 6 | u32::from(value);
        count += 1;
        if count == 4 {
            bytes.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            (bits, count) = (0, 0);
        }
    }
    match count {
        2 => bytes.push((bits >> 4) as u8),
        3 => bytes.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => {}
    }
    bytes
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A kept blob's bytes as base64, read again so the oldest-read blobs leave first; None when not kept (or unreadable).
pub(super) fn kept(folder: &Folder, hash: &str) -> Option<String> {
    let file = folder.dir.join(hash);
    let bytes = std::fs::read(&file).ok()?;
    folder::touch(&file);
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// One blob: from the folder (a caller that just found it `unkept` there looks only whether it came since), else from the host (as `fetch` answers
/// it: the host's base64, None when it has none), kept only when its bytes match its address. None leaves the reference as it is: the renderer shows that picture
/// as unavailable.
pub(super) async fn load<F, R>(
    folder: &Arc<Folder>,
    reference: &str,
    limit: u64,
    unkept: bool,
    fetch: F,
) -> Option<String>
where
    F: FnOnce() -> R,
    R: Future<Output = Option<String>>,
{
    let hash = reference.strip_prefix(BLOB_REF_PREFIX)?.to_owned();
    if !is_hash(&hash) {
        return None;
    }
    // A caller that already found the folder without it checks again only that the file exists, at once: another read
    // may have kept it meanwhile, and the check never waits, so the host is still asked in the caller's order.
    if !unkept || folder.dir.join(&hash).exists() {
        let reading = folder.clone();
        let wanted = hash.clone();
        if let Some(kept) = blocking(move || kept(&reading, &wanted)).await.ok()? {
            return Some(kept);
        }
    }
    let data = fetch().await.filter(|data| !data.is_empty())?;
    let bytes = node_base64(&data);
    if hex(&Sha256::digest(&bytes)) != hash {
        return None;
    }
    let folder = folder.clone();
    // A full or read-only disk: the picture still shows, and is read from the host again next time.
    let _ = blocking(move || folder.write(&folder.dir.join(&hash), &bytes, limit)).await;
    Some(data)
}

/// The read of one reference that others wait on: whatever ends it (an answer, or the request dropped), they hear it.
struct Loading<'a> {
    folder: &'a Folder,
    reference: &'a str,
    data: Option<String>,
}

impl Drop for Loading<'_> {
    fn drop(&mut self) {
        let waiters = self
            .folder
            .loading
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(self.reference)
            .unwrap_or_default();
        for waiter in waiters {
            let _ = waiter.send(self.data.clone());
        }
    }
}

/// `load`, shared by every read of the same reference at the same time.
pub(super) async fn shared_with<F, R>(
    folder: &Arc<Folder>,
    reference: String,
    limit: u64,
    fetch: F,
) -> Option<String>
where
    F: FnOnce() -> R,
    R: Future<Output = Option<String>>,
{
    let waiting = {
        let mut loading = folder.loading.lock().unwrap_or_else(|p| p.into_inner());
        match loading.get_mut(&reference) {
            Some(waiters) => {
                let (sender, receiver) = tokio::sync::oneshot::channel();
                waiters.push(sender);
                Some(receiver)
            }
            None => {
                loading.insert(reference.clone(), Vec::new());
                None
            }
        }
    };
    if let Some(receiver) = waiting {
        return receiver.await.ok().flatten();
    }
    let mut loading = Loading {
        folder,
        reference: &reference,
        data: None,
    };
    loading.data = load(folder, &reference, limit, true, fetch).await;
    loading.data.clone()
}

async fn shared(
    folder: &Arc<Folder>,
    reference: String,
    limit: u64,
    events: &Events,
    scope: &Scope,
    asker: u64,
) -> Option<String> {
    shared_with(folder, reference.clone(), limit, || async {
        let mut data = Map::new();
        data.insert("ref".into(), Value::String(reference));
        let answer = ask(events, Some(scope), asker, "blob", data).await.ok()?;
        serde_json::from_str::<Option<String>>(answer.get())
            .ok()
            .flatten()
    })
    .await
}

#[derive(Deserialize)]
struct ResolveParams {
    dir: PathBuf,
    limit: u64,
    refs: Vec<String>,
    asker: u64,
}

/// `remotebytes.resolveBlobs {dir, limit, refs, asker}` → each reference's base64 bytes, or null where the host has
/// none or sent other bytes (in the order of `refs`).
pub async fn resolve(call: Call) -> Result<Reply, Fault> {
    let params: ResolveParams = call.params()?;
    let folder = folder::folder(&params.dir);
    // The folder first, every reference in one read, so the host is asked for what it lacks in the order of `refs`, as
    // the TypeScript asked it: each `shared` below sends its ask on its first poll, and `join_all` polls in order.
    let reading = folder.clone();
    let wanted = params.refs.clone();
    let on_disk: Vec<Option<String>> = blocking(move || {
        wanted
            .iter()
            .map(|reference| {
                let hash = reference.strip_prefix(BLOB_REF_PREFIX)?;
                if is_hash(hash) {
                    kept(&reading, hash)
                } else {
                    None
                }
            })
            .collect()
    })
    .await?;
    let reads = params
        .refs
        .into_iter()
        .zip(on_disk)
        .map(|(reference, on_disk)| {
            let folder = &folder;
            let events = &call.events;
            let scope = &call.scope;
            async move {
                match on_disk {
                    Some(data) => Some(data),
                    None => {
                        shared(folder, reference, params.limit, events, scope, params.asker).await
                    }
                }
            }
        });
    let found = futures_util::future::join_all(reads).await;
    Reply::json(&found)
}
