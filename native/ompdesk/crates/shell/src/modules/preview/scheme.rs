//! `omp-visual:`, the scheme the agent's visuals load from (panels-sidebar › Preview, C135): the shell's own handler on
//! each visual partition's request context answers from the visual store, so no file path or network is reachable from
//! a visual's page. The store is read once from `<userData>/visuals`; every page rule on it is `preview_core::visuals`'.
#![allow(unsafe_code)]

use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};

use cef::*;
use shell_core::preview_core::urls::VISUAL_SCHEME;
use shell_core::preview_core::visuals::{Served, VisualStore};

use crate::state;

static STORE: LazyLock<Mutex<VisualStore>> =
    LazyLock::new(|| Mutex::new(VisualStore::new(state::paths().user_data.join("visuals"))));

/// The visuals of this computer: the UI thread, the tool's worker threads and CEF's IO thread (serving) all share it.
pub(super) fn store() -> MutexGuard<'static, VisualStore> {
    STORE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Reads `history.json` now (once), so the IO thread never has to when it first serves.
pub(super) fn load() {
    drop(store());
}

/// What a request is answered with, and how much of it CEF has taken.
struct Answer {
    served: Served,
    pos: usize,
}

type Shared = Arc<Mutex<Option<Answer>>>;

fn status_text(status: u16) -> &'static str {
    if status == 200 { "OK" } else { "Not Found" }
}

wrap_resource_handler! {
    struct VisualResource {
        answer: Shared,
    }
    impl ResourceHandler {
        fn open(&self, request: Option<&mut Request>, handle_request: Option<&mut i32>, _callback: Option<&mut Callback>) -> i32 {
            let Some(request) = request else { return 0 };
            let url = CefString::from(&request.url()).to_string();
            let served = store().serve(&url);
            *self.answer.lock().unwrap_or_else(PoisonError::into_inner) = Some(Answer { served, pos: 0 });
            if let Some(handle) = handle_request {
                *handle = 1;
            }
            1
        }

        fn response_headers(&self, response: Option<&mut Response>, response_length: Option<&mut i64>, _redirect_url: Option<&mut CefString>) {
            let guard = self.answer.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(answer) = guard.as_ref() else { return };
            if let Some(response) = response {
                response.set_status(i32::from(answer.served.status));
                response.set_status_text(Some(&CefString::from(status_text(answer.served.status))));
                for (name, value) in &answer.served.headers {
                    if name == "Content-Type" {
                        let (mime, rest) = value.split_once(';').unwrap_or((value.as_str(), ""));
                        response.set_mime_type(Some(&CefString::from(mime.trim())));
                        if let Some(charset) = rest.trim().strip_prefix("charset=") {
                            response.set_charset(Some(&CefString::from(charset)));
                        }
                    } else {
                        response.set_header_by_name(Some(&CefString::from(name.as_str())), Some(&CefString::from(value.as_str())), 1);
                    }
                }
            }
            if let Some(length) = response_length {
                *length = answer.served.body.len() as i64;
            }
        }

        fn read(&self, data_out: *mut u8, bytes_to_read: i32, bytes_read: Option<&mut i32>, _callback: Option<&mut ResourceReadCallback>) -> i32 {
            let mut guard = self.answer.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(answer) = guard.as_mut() else { return 0 };
            let remaining = answer.served.body.len() - answer.pos;
            let count = remaining.min(bytes_to_read.max(0) as usize);
            // SAFETY: CEF hands a buffer of `bytes_to_read` bytes, valid until this call returns; `count` never exceeds it.
            let out = unsafe { std::slice::from_raw_parts_mut(data_out, count) };
            out.copy_from_slice(&answer.served.body[answer.pos..answer.pos + count]);
            answer.pos += count;
            if let Some(read) = bytes_read {
                *read = count as i32;
            }
            i32::from(count > 0)
        }

        fn cancel(&self) {
            *self.answer.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
    }
}

wrap_scheme_handler_factory! {
    struct VisualFactory;
    impl SchemeHandlerFactory {
        fn create(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            _request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            Some(VisualResource::new(Arc::new(Mutex::new(None))))
        }
    }
}

/// The visual partition's request context serves `omp-visual:` from the store (no other partition does).
pub(super) fn register(context: &RequestContext) -> Result<(), String> {
    let mut factory = VisualFactory::new();
    let done = context.register_scheme_handler_factory(
        Some(&CefString::from(VISUAL_SCHEME)),
        Some(&CefString::from("")),
        Some(&mut factory),
    );
    if done == 0 {
        return Err(format!("could not handle {VISUAL_SCHEME}"));
    }
    Ok(())
}
