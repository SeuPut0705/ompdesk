//! `omp-media://` served from disk (`boot_core::media`): the page's players through CEF's scheme handler on the app
//! session, a paired device's page through `boot.mediaHead`/`boot.mediaRead`, which Node streams on. The bytes never
//! cross the host socket for a window's player.
#![allow(unsafe_code)]

use std::io::Read;
use std::sync::{Arc, LazyLock, Mutex};

use cef::*;
use serde_json::{Value, json};
use shell_core::boot_core::media::{self, Owner, Prepared, Service};

use crate::host::Call;

static SERVICE: LazyLock<Service> = LazyLock::new(Service::default);

/// Native workspace handlers use this service with the owner derived from their authenticated caller.
pub fn service() -> &'static Service {
    &SERVICE
}

pub fn stop() {
    SERVICE.stop();
}

/// Only the internal Node adapter has numeric owners. Native callers use the authenticated Owner variants directly.
fn node_owner(wc_id: u64) -> Owner {
    Owner::Desktop { win_id: 0, wc_id }
}

fn cs(text: &str) -> CefString {
    CefString::from(text)
}

/// Registers the scheme's handler on the app session (UI thread, `ready`). The scheme itself is one of the shell's
/// own (`app.rs`), so it exists in every process before any page loads; a Preview partition has no handler for it.
pub fn register() -> Result<(), String> {
    let Some(context) = request_context_get_global_context() else {
        return Err("boot media: app request context unavailable".into());
    };
    let mut factory = MediaFactory::new();
    if context.register_scheme_handler_factory(
        Some(&cs(media::SCHEME)),
        Some(&cs("")),
        Some(&mut factory),
    ) == 0
    {
        return Err("boot media: scheme registration failed".into());
    }
    Ok(())
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
    match service().open(path.into(), mime, node_owner(owner)) {
        Ok(url) => call.ok(json!({ "url": url })),
        Err(error) => call.err("failed", error.to_string()),
    }
}

/// `boot.mediaRelease {url, owner}`.
pub fn release(data: &Value) {
    if let (Some(url), Some(owner)) = (
        data.get("url").and_then(Value::as_str),
        data.get("owner").and_then(Value::as_u64),
    ) {
        SERVICE.release(url, &node_owner(owner));
    }
}

/// `boot.mediaReleaseOwner {owner}`.
pub fn release_owner(data: &Value) {
    if let Some(owner) = data.get("owner").and_then(Value::as_u64) {
        SERVICE.release_owner(&node_owner(owner));
    }
}

/// `boot.mediaHead {url, method?, range?}` → `{status, headers, start, length}`: what the scheme would answer.
pub fn head(call: Call) {
    let Some(url) = call.str("url") else {
        return call.err("invalid", "boot.mediaHead needs a url");
    };
    let method = call.str("method").unwrap_or_else(|| "GET".into());
    let range = call.str("range");
    std::thread::spawn(move || {
        let head = SERVICE.prepare(&url, &method, range.as_deref()).head;
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
    std::thread::spawn(move || match SERVICE.read(&url, offset, length) {
        Ok(bytes) => call.ok_bin(json!({}), &bytes),
        Err(error) => {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                "gone"
            } else {
                "failed"
            };
            call.err(code, error.to_string());
        }
    });
}

wrap_resource_handler! {
    struct MediaResource {
        answer: Arc<Mutex<Option<Prepared>>>,
    }
    impl ResourceHandler {
        fn open(&self, request: Option<&mut cef::Request>, handle_request: Option<&mut i32>, _callback: Option<&mut Callback>) -> i32 {
            let Some(request) = request else { return 0 };
            let url = CefString::from(&request.url()).to_string();
            let method = CefString::from(&request.method()).to_string();
            let range = CefString::from(&request.header_by_name(Some(&cs("Range")))).to_string();
            let answer = SERVICE.prepare(&url, &method, (!range.is_empty()).then_some(range.as_str()));
            *self.answer.lock().unwrap() = Some(answer);
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
                *length = answer.head.length as i64;
            }
        }

        fn read(&self, data_out: *mut u8, bytes_to_read: i32, bytes_read: Option<&mut i32>, _callback: Option<&mut ResourceReadCallback>) -> i32 {
            let mut answer = self.answer.lock().unwrap();
            let Some(answer) = answer.as_mut() else { return 0 };
            let want = bytes_to_read.max(0) as usize;
            if want == 0 {
                if let Some(read) = bytes_read { *read = 0; }
                return 0;
            }
            // SAFETY: CEF gives a buffer of `bytes_to_read` bytes; `want` never exceeds it.
            let out = unsafe { std::slice::from_raw_parts_mut(data_out, want) };
            let n = answer.read(out).unwrap_or(0);
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
