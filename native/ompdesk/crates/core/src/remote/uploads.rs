//! Ordered, bounded remote file parts. The native upload store still owns names, disk persistence and daily limits.
use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::server::Fault;

pub const IDLE: Duration = Duration::from_secs(2 * 60);
const MAX_BYTES: usize = 25 * 1024 * 1024;
const PER_DEVICE: usize = 2;

pub struct Upload {
    pub name: String,
    pub bytes: Vec<u8>,
}
pub enum PartResult {
    Waiting {
        received: usize,
        upload: String,
        generation: u64,
    },
    Complete(Upload),
}
struct Part {
    chunks: Vec<Vec<u8>>,
    bytes: usize,
    next: u64,
    generation: u64,
}
#[derive(Default)]
pub struct UploadParts {
    generation: u64,
    parts: HashMap<(String, String), Part>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    upload: String,
    index: u64,
    last: bool,
    name: String,
    data_base64: String,
}
fn decode(text: &str) -> Result<Vec<u8>, Fault> {
    Ok(crate::remotebytes::node_base64(text))
}
pub fn whole(params: Value) -> Result<Upload, Fault> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Whole {
        name: String,
        data_base64: String,
    }
    let params: Whole = serde_json::from_value(params)
        .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
    let bytes = decode(&params.data_base64)?;
    if bytes.len() > MAX_BYTES {
        return Err(Fault::new("file_too_large", "file too large"));
    }
    Ok(Upload {
        name: params.name,
        bytes,
    })
}
impl UploadParts {
    pub fn push(&mut self, peer: &str, params: Value) -> Result<PartResult, Fault> {
        let params: Params = serde_json::from_value(params)
            .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
        if params.upload.is_empty() || params.upload.encode_utf16().count() > 128 {
            return Err(Fault::new("invalid_params", "Invalid upload id"));
        }
        let key = (peer.to_owned(), params.upload.clone());
        if self.parts.get(&key).map_or(0, |part| part.next) != params.index {
            self.parts.remove(&key);
            return Err(Fault::new(
                "invalid_path",
                "A part of this file arrived out of order; attach it again",
            ));
        }
        if !self.parts.contains_key(&key)
            && !params.last
            && self.parts.keys().filter(|(id, _)| id == peer).count() >= PER_DEVICE
        {
            return Err(Fault::new(
                "upload_refused",
                "Too many files are on their way from this device; try again later",
            ));
        }
        let chunk = decode(&params.data_base64)?;
        let previous = self.parts.get(&key).map_or(0, |part| part.bytes);
        if previous.saturating_add(chunk.len()) > MAX_BYTES {
            self.parts.remove(&key);
            return Err(Fault::new("file_too_large", "file too large"));
        }
        self.generation += 1;
        let generation = self.generation;
        let part = self.parts.entry(key.clone()).or_insert_with(|| Part {
            chunks: Vec::new(),
            bytes: 0,
            next: 0,
            generation,
        });
        part.bytes += chunk.len();
        part.next += 1;
        part.generation = generation;
        part.chunks.push(chunk);
        if !params.last {
            return Ok(PartResult::Waiting {
                received: part.bytes,
                upload: params.upload,
                generation,
            });
        }
        let Some(part) = self.parts.remove(&key) else {
            return Err(Fault::new("invalid_path", "Upload was withdrawn"));
        };
        let mut bytes = Vec::with_capacity(part.bytes);
        for chunk in part.chunks {
            bytes.extend_from_slice(&chunk);
        }
        Ok(PartResult::Complete(Upload {
            name: params.name,
            bytes,
        }))
    }
    pub fn expire(&mut self, peer: &str, upload: &str, generation: u64) {
        let key = (peer.to_owned(), upload.to_owned());
        if self
            .parts
            .get(&key)
            .is_some_and(|part| part.generation == generation)
        {
            self.parts.remove(&key);
        }
    }
    pub fn drop_peer(&mut self, peer: &str) {
        self.parts.retain(|(id, _), _| id != peer);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;
    fn part(upload: &str, index: u64, last: bool, bytes: &[u8]) -> Value {
        json!({"upload":upload,"index":index,"last":last,"name":"document.bin","dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes)})
    }
    #[test]
    fn whole_upload_preserves_node_base64_alphabets_and_ignored_characters() {
        let upload = whole(json!({"name":"bytes","dataBase64":" -_8 \n=ignored"})).unwrap();
        assert_eq!(upload.bytes, [251, 255]);
    }
    #[test]
    fn parts_preserve_order_and_a_stale_idle_timer_cannot_drop_new_bytes() {
        let mut parts = UploadParts::default();
        let PartResult::Waiting { generation, .. } = parts
            .push("peer", part("file", 0, false, b"first"))
            .unwrap()
        else {
            panic!()
        };
        parts
            .push("peer", part("file", 1, false, b"second"))
            .unwrap();
        parts.expire("peer", "file", generation);
        let PartResult::Complete(upload) =
            parts.push("peer", part("file", 2, true, b"third")).unwrap()
        else {
            panic!()
        };
        assert_eq!(upload.bytes, b"firstsecondthird");
        assert!(parts.push("peer", part("file", 2, true, b"bad")).is_err());
    }
    #[test]
    fn devices_are_isolated_and_unfinished_files_are_bounded() {
        let mut parts = UploadParts::default();
        parts.push("a", part("one", 0, false, b"a")).unwrap();
        parts.push("a", part("two", 0, false, b"b")).unwrap();
        assert!(parts.push("a", part("three", 0, false, b"c")).is_err());
        assert!(parts.push("b", part("three", 0, false, b"c")).is_ok());
        parts.drop_peer("a");
        assert!(parts.push("a", part("three", 0, false, b"c")).is_ok());
    }
}
