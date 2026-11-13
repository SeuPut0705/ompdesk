//! `omp-media://` served from disk (`boot_core::media`): the page's players through CEF's scheme handler on the app
//! session, a paired device's page through `boot.mediaHead`/`boot.mediaRead`, which Node streams on. The bytes never
//! cross the host socket for a window's player.
#![allow(unsafe_code)]

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cef::*;
use serde_json::{Value, json};
use shell_core::boot_core::media::{self, Head, Streams};

use crate::host::Call;

static STREAMS: LazyLock<Mutex<Streams>> = LazyLock::new(|| Mutex::new(Streams::default()));

/// The most one `boot.mediaRead` answers.
const READ_MAX: u64 = 1 << 20;

fn cs(text: &str) -> CefString {
    CefString::from(text)
}

/// Registers the scheme's handler on the app session (UI thread, `ready`). The scheme itself is one of the shell's
/// own (`app.rs`), so it exists in every process before any page loads; a Preview partition has no handler for it.
pub fn register() {
    let Some(context) = request_context_get_global_context() else {
        crate::log::log("boot.media_no_context", json!({}));
        return;
    };
    let mut factory = MediaFactory::new();
    if context.register_scheme_handler_factory(
        Some(&cs(media::SCHEME)),
        Some(&cs("")),
        Some(&mut factory),
    ) == 0
    {
        crate::log::log("boot.media_register_failed", json!({}));
    }
}

/// `boot.mediaOpen {path, mime, owner}` → `{url}`.
pub fn open(call: Call) {
    let (Some(path), Some(mime), Some(owner)) = (
        call.str("path"),
        call.str("mime"),
        call.params.get("owner").and_then(Value::as_u64),
    ) else {
        return call.err("invalid", "boot.mediaOpen needs path, mime and owner");
    };
    let mut bytes = [0u8; 24];
    if let Err(error) = getrandom::fill(&mut bytes) {
        return call.err("failed", format!("no random token: {error}"));
    }
    let url = STREAMS
        .lock()
        .unwrap()
        .open(path.into(), mime, owner, URL_SAFE_NO_PAD.encode(bytes));
    call.ok(json!({ "url": url }));
}

/// `boot.mediaRelease {url, owner}`.
pub fn release(data: &Value) {
    if let (Some(url), Some(owner)) = (
        data.get("url").and_then(Value::as_str),
        data.get("owner").and_then(Value::as_u64),
    ) {
        STREAMS.lock().unwrap().release(url, owner);
    }
}

/// `boot.mediaReleaseOwner {owner}`.
pub fn release_owner(data: &Value) {
    if let Some(owner) = data.get("owner").and_then(Value::as_u64) {
        STREAMS.lock().unwrap().release_owner(owner);
    }
}

fn head_of(url: &str, method: &str, range: Option<&str>) -> Head {
    let entry = STREAMS.lock().unwrap().entry(url).cloned();
    media::answer(entry.as_ref(), method, range)
}

/// `boot.mediaHead {url, method?, range?}` → `{status, headers, start, length}`: what the scheme would answer.
pub fn head(call: Call) {
    let Some(url) = call.str("url") else {
        return call.err("invalid", "boot.mediaHead needs a url");
    };
    let method = call.str("method").unwrap_or_else(|| "GET".into());
    let range = call.str("range");
    std::thread::spawn(move || {
        let head = head_of(&url, &method, range.as_deref());
        let headers: Vec<Value> = head.headers.iter().map(|(k, v)| json!([k, v])).collect();
        call.ok(json!({ "status": head.status, "headers": headers, "start": head.start, "length": head.length }));
    });
}

/// `boot.mediaRead {url, offset, length}` → `{}` + up to 1 MiB of the file from `offset` (fewer at its end). A token
/// released meanwhile answers `gone`.
pub fn read(call: Call) {
    let (Some(url), Some(offset), Some(length)) = (
        call.str("url"),
        call.params.get("offset").and_then(Value::as_u64),
        call.params.get("length").and_then(Value::as_u64),
    ) else {
        return call.err("invalid", "boot.mediaRead needs url, offset and length");
    };
    let Some(path) = STREAMS.lock().unwrap().entry(&url).map(|e| e.path.clone()) else {
        return call.err("gone", "the media stream was released");
    };
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let read = File::open(&path).and_then(|mut file| {
            file.seek(SeekFrom::Start(offset))?;
            file.take(length.min(READ_MAX)).read_to_end(&mut buffer)
        });
        match read {
            Ok(_) => call.ok_bin(json!({}), &buffer),
            Err(error) => call.err("failed", error.to_string()),
        }
    });
}

struct Answer {
    head: Head,
    file: Option<File>,
    /// Bytes still to hand out.
    left: u64,
}

wrap_resource_handler! {
    struct MediaResource {
        answer: Arc<Mutex<Option<Answer>>>,
    }
    impl ResourceHandler {
        fn open(&self, request: Option<&mut cef::Request>, handle_request: Option<&mut i32>, _callback: Option<&mut Callback>) -> i32 {
            let Some(request) = request else { return 0 };
            let url = CefString::from(&request.url()).to_string();
            let method = CefString::from(&request.method()).to_string();
            let range = CefString::from(&request.header_by_name(Some(&cs("Range")))).to_string();
            let head = head_of(&url, &method, (!range.is_empty()).then_some(range.as_str()));
            let file = (head.length > 0)
                .then(|| File::open(&STREAMS.lock().unwrap().entry(&url)?.path).ok())
                .flatten()
                .and_then(|mut file| file.seek(SeekFrom::Start(head.start)).ok().map(|_| file));
            let left = if file.is_some() { head.length } else { 0 };
            *self.answer.lock().unwrap() = Some(Answer { head, file, left });
            if let Some(handle) = handle_request {
                *handle = 1;
            }
            1
        }

        /// CEF asks to skip for a `Range` whose first byte is > 0 although `open` already positioned the file there
        /// (as `scheme.rs` answers for `app://`): claim the skip, discard nothing.
        fn skip(&self, bytes_to_skip: i64, bytes_skipped: Option<&mut i64>, _callback: Option<&mut ResourceSkipCallback>) -> i32 {
            if let Some(skipped) = bytes_skipped {
                *skipped = bytes_to_skip;
            }
            1
        }

        fn response_headers(&self, response: Option<&mut Response>, response_length: Option<&mut i64>, _redirect_url: Option<&mut CefString>) {
            let answer = self.answer.lock().unwrap();
            let Some(answer) = answer.as_ref() else { return };
            if let Some(response) = response {
                response.set_status(i32::from(answer.head.status));
                response.set_status_text(Some(&cs(media::status_text(answer.head.status))));
                if let Some((_, mime)) = answer.head.headers.iter().find(|(k, _)| *k == "Content-Type") {
                    response.set_mime_type(Some(&cs(mime)));
                }
                for (name, value) in &answer.head.headers {
                    response.set_header_by_name(Some(&cs(name)), Some(&cs(value)), 1);
                }
            }
            if let Some(length) = response_length {
                *length = answer.left as i64;
            }
        }

        fn read(&self, data_out: *mut u8, bytes_to_read: i32, bytes_read: Option<&mut i32>, _callback: Option<&mut ResourceReadCallback>) -> i32 {
            let mut answer = self.answer.lock().unwrap();
            let Some(answer) = answer.as_mut() else { return 0 };
            let want = (bytes_to_read.max(0) as u64).min(answer.left) as usize;
            let Some(file) = answer.file.as_mut().filter(|_| want > 0) else {
                if let Some(read) = bytes_read {
                    *read = 0;
                }
                return 0;
            };
            // SAFETY: CEF gives a buffer of `bytes_to_read` bytes; `want` never exceeds it.
            let out = unsafe { std::slice::from_raw_parts_mut(data_out, want) };
            let n = file.read(out).unwrap_or(0);
            answer.left -= n as u64;
            if let Some(read) = bytes_read {
                *read = n as i32;
            }
            i32::from(n > 0)
        }

        fn cancel(&self) {
            self.answer.lock().unwrap().take();
        }
    }
}

wrap_scheme_handler_factory! {
    struct MediaFactory;
    impl SchemeHandlerFactory {
        fn create(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            _request: Option<&mut cef::Request>,
        ) -> Option<ResourceHandler> {
            Some(MediaResource::new(Arc::new(Mutex::new(None))))
        }
    }
}
