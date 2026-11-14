//! Page payloads at the native application boundary. Bytes belong to the authenticated device's
//! upload/blob stores; image conversion stays stock omp's `image.toModel`, not a Rust copy.

use std::sync::Arc;

use base64::Engine as _;
use base64::prelude::BASE64_STANDARD;
use hyper::body::Bytes;
use serde_json::Value;

use super::blobs::{BlobStore, NewBlob, Source, URL_PREFIX};
use super::deps::BoxFuture;
use super::uploads::UploadStore;
use crate::server::Fault;

pub const INLINE_BINARY_MAX_BYTES: usize = 512 * 1024;
const BLOCK_SEARCH_DEPTH: usize = 8;

/// The application's existing stock helper, shared with every other caller.
pub trait ModelImages: Send + Sync {
    fn to_model(&self, image: Value) -> BoxFuture<'_, Result<Value, Fault>>;
}

pub struct Payloads {
    pub uploads: Arc<UploadStore>,
    pub blobs: Arc<BlobStore>,
    pub images: Arc<dyn ModelImages>,
}

pub fn converts_for_model(mime: &str) -> bool {
    let mime = mime.trim().to_ascii_lowercase();
    mime.starts_with("image/")
        && !matches!(
            mime.as_str(),
            "image/jpg" | "image/jpeg" | "image/png" | "image/gif" | "image/webp"
        )
}

fn uploaded_image(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("image")
        && value.get("mimeType").and_then(Value::as_str).is_some()
        && value.get("upload").and_then(Value::as_str).is_some()
        && value.get("data").is_none()
}

fn has_image(value: &Value, depth: usize) -> bool {
    if uploaded_image(value) {
        return true;
    }
    if depth >= BLOCK_SEARCH_DEPTH {
        return false;
    }
    match value {
        Value::Array(values) => values.iter().any(|v| has_image(v, depth + 1)),
        Value::Object(values) => values.values().any(|v| has_image(v, depth + 1)),
        _ => false,
    }
}

impl Payloads {
    pub fn needs_landing(&self, args: &Value) -> bool {
        has_image(args, 0)
    }

    /// Only calls with uploaded pictures yield here. Plain calls preserve their original timing.
    pub fn land_images<'a>(
        &'a self,
        device: &'a str,
        args: &'a mut Value,
    ) -> BoxFuture<'a, Result<(), Fault>> {
        self.land_at(device, args, 0)
    }

    fn land_at<'a>(
        &'a self,
        device: &'a str,
        value: &'a mut Value,
        depth: usize,
    ) -> BoxFuture<'a, Result<(), Fault>> {
        Box::pin(async move {
            if uploaded_image(value) {
                let file = value["upload"]
                    .as_str()
                    .ok_or_else(|| Fault::new("invalid_path", "No uploaded picture named"))?;
                let bytes = self.uploads.take(device, file).await.map_err(|_| Fault::new(
                    "file_not_found", "A picture this message names is no longer on the computer; attach it again"))?;
                let convert = converts_for_model(value["mimeType"].as_str().unwrap_or_default());
                if let Some(block) = value.as_object_mut() {
                    block.remove("upload");
                    block.insert("data".into(), BASE64_STANDARD.encode(bytes).into());
                }
                if convert {
                    let image = std::mem::take(value);
                    *value = self.images.to_model(image).await.map_err(|_| {
                        Fault::new(
                            "unsupported_image",
                            "This picture could not be converted for the model",
                        )
                    })?;
                }
                return Ok(());
            }
            if depth >= BLOCK_SEARCH_DEPTH {
                return Ok(());
            }
            // Every replacement is joined even after a sibling fails, as Promise.all starts all of
            // them before rejecting. No upload read keeps running after the call has answered.
            let results = match value {
                Value::Array(values) => {
                    futures_util::future::join_all(
                        values
                            .iter_mut()
                            .map(|v| self.land_at(device, v, depth + 1)),
                    )
                    .await
                }
                Value::Object(values) => {
                    futures_util::future::join_all(
                        values
                            .values_mut()
                            .map(|v| self.land_at(device, v, depth + 1)),
                    )
                    .await
                }
                _ => Vec::new(),
            };
            results.into_iter().collect()
        })
    }

    /// A file uploaded here is being forwarded to a tab on another paired host. Its bytes stay out
    /// of JSON and travel in the native invoke's binary argument.
    pub async fn land_host_upload(
        &self,
        device: &str,
        args: &mut [Value],
    ) -> Result<Option<Vec<u8>>, Fault> {
        let Some(request) = args.first_mut().and_then(Value::as_object_mut) else {
            return Ok(None);
        };
        let file = request
            .get("upload")
            .and_then(Value::as_str)
            .ok_or_else(|| Fault::new("invalid_path", "No uploaded file named"))?;
        let bytes = self.uploads.take(device, file).await.map_err(|_| {
            Fault::new(
                "file_not_found",
                "The file is no longer on the computer; attach it again",
            )
        })?;
        request.remove("upload");
        Ok(Some(bytes))
    }

    pub fn translate_media_release(&self, now: i64, device: &str, args: &mut [Value]) {
        let Some(url) = args.first().and_then(Value::as_str) else {
            return;
        };
        let media = self.blobs.media_url(now, device, url);
        self.blobs.release(device, url);
        if let Some(media) = media {
            args[0] = media.into();
        }
    }

    /// Native byte results become page JSON once, after the application has inspected the result.
    pub fn shape_result(
        &self,
        now: i64,
        device: &str,
        channel: &str,
        keyed_prefs: bool,
        mut result: Value,
        bin: Option<Vec<u8>>,
    ) -> Result<Value, Fault> {
        match channel {
            "prefs:get" if !keyed_prefs => {
                if let Some(store) = result.as_object_mut() {
                    store.retain(|key, _| !secret_key(key));
                }
            }
            "fs:read-binary" | "fs:save-copy" => {
                if let (Some(bytes), Some(metadata)) = (bin, result.as_object_mut()) {
                    metadata.remove("data");
                    if bytes.len() <= INLINE_BINARY_MAX_BYTES {
                        metadata.insert("dataBase64".into(), BASE64_STANDARD.encode(bytes).into());
                    } else {
                        let mime = metadata
                            .get("mime")
                            .and_then(Value::as_str)
                            .unwrap_or("application/octet-stream");
                        let url =
                            self.add_blob(now, device, Source::Bytes(Bytes::from(bytes)), mime)?;
                        metadata.insert("blobUrl".into(), url.into());
                    }
                }
            }
            "fs:media-stream" if result.get("ok") == Some(&Value::Bool(true)) => {
                if let (Some(url), Some(mime)) = (
                    result.get("url").and_then(Value::as_str),
                    result.get("mime").and_then(Value::as_str),
                ) {
                    let url = self.add_blob(now, device, Source::Media(url.to_owned()), mime)?;
                    result["url"] = url.into();
                }
            }
            _ => {
                if bin.is_some() {
                    return Err(Fault::new(
                        "web_binary",
                        "The computer's binary answer has no page encoding",
                    ));
                }
            }
        }
        Ok(result)
    }

    fn add_blob(
        &self,
        now: i64,
        device: &str,
        source: Source,
        mime: &str,
    ) -> Result<String, Fault> {
        let token = super::blobs::mint_token()?;
        self.blobs.add(
            now,
            &token,
            NewBlob {
                device,
                source,
                mime,
                name: "file",
                download: false,
            },
        );
        Ok(format!("{URL_PREFIX}{token}"))
    }
}

pub(crate) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|v| v != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passphrase",
        "credential",
        "apikey",
        "api-key",
        "api_key",
    ]
    .iter()
    .any(|s| key.contains(s))
}

pub fn refused(result: &Value) -> bool {
    result.get("success") == Some(&Value::Bool(false))
}

#[cfg(test)]
mod tests {
    use super::super::uploads::Limits;
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "ompdesk-web-effects-{}",
                super::super::router::uuid()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct Images(Mutex<Vec<Value>>);
    impl ModelImages for Images {
        fn to_model(&self, image: Value) -> BoxFuture<'_, Result<Value, Fault>> {
            self.0.lock().unwrap().push(image);
            Box::pin(async {
                Ok(json!({ "type":"image", "data":"converted", "mimeType":"image/jpeg" }))
            })
        }
    }

    fn rig(root: &std::path::Path) -> Payloads {
        Payloads {
            uploads: super::super::uploads::open(root),
            blobs: Arc::new(BlobStore::new(String::new(), 30_000)),
            images: Arc::new(Images(Mutex::default())),
        }
    }

    #[tokio::test]
    async fn uploaded_image_is_consumed_once_and_cannot_cross_devices() {
        let dir = Scratch::new();
        let effects = rig(&dir.0);
        let upload = effects
            .uploads
            .store(0, Limits::default(), "phone", "photo.heic", vec![1, 2, 3])
            .await
            .map_err(|e| e.message)
            .unwrap();
        let original = json!([{ "command":{ "images":[{ "type":"image", "upload": upload.path, "mimeType":"image/heic" }] } }]);
        let mut wrong = original.clone();
        assert_eq!(
            effects
                .land_images("other", &mut wrong)
                .await
                .unwrap_err()
                .code,
            "file_not_found"
        );
        let mut args = original.clone();
        effects.land_images("phone", &mut args).await.unwrap();
        assert_eq!(
            args[0]["command"]["images"][0],
            json!({"type":"image", "data":"converted", "mimeType":"image/jpeg"})
        );
        let mut replay = original;
        assert_eq!(
            effects
                .land_images("phone", &mut replay)
                .await
                .unwrap_err()
                .code,
            "file_not_found"
        );
    }

    #[test]
    fn binary_threshold_privacy_and_media_release_keep_page_contract() {
        let dir = Scratch::new();
        let effects = rig(&dir.0);
        for (len, inline) in [
            (INLINE_BINARY_MAX_BYTES, true),
            (INLINE_BINARY_MAX_BYTES + 1, false),
        ] {
            let result = effects
                .shape_result(
                    0,
                    "phone",
                    "fs:read-binary",
                    false,
                    json!({"ok":true,"mime":"video/mp4"}),
                    Some(vec![7; len]),
                )
                .unwrap();
            assert_eq!(result.get("dataBase64").is_some(), inline);
            assert_eq!(result.get("blobUrl").is_some(), !inline);
            assert!(result.get("data").is_none());
        }
        let result = effects
            .shape_result(
                0,
                "phone",
                "prefs:get",
                false,
                json!({"theme":"dark","api_key":"private","updateToken":"private"}),
                None,
            )
            .unwrap();
        assert_eq!(result, json!({"theme":"dark"}));
        let result = effects
            .shape_result(
                0,
                "phone",
                "fs:media-stream",
                false,
                json!({"ok":true,"url":"omp-media://a","mime":"audio/mpeg"}),
                None,
            )
            .unwrap();
        let url = result["url"].as_str().unwrap();
        assert!(url.starts_with("/blob/"));
        assert_eq!(effects.blobs.media_url(0, "other", url), None);
        let mut args = vec![result["url"].clone()];
        effects.translate_media_release(0, "phone", &mut args);
        assert_eq!(args, [json!("omp-media://a")]);
        assert_eq!(effects.blobs.media_url(0, "phone", url), None);
    }
}
