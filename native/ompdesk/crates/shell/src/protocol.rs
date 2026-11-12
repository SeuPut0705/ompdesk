//! `protocol.*` (PROTOCOL.md §6): a scheme a session handles in Node (`omp-media://` range streams, `omp-visual://`)
//! is served here as a CEF scheme handler that forwards each request to Node: `protocol.request` answers with the
//! head, then the body arrives as `protocol.chunk` events and a final `protocol.end`, streamed as they come, with the
//! page's `Range` header passed on (Node answers 206 itself).
#![allow(unsafe_code)]

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use cef::*;
use serde_json::{Value, json};
use shell_core::chunks::fill;

use crate::host;

/// A CEF callback used from the reader thread (documented callable from any thread).
struct AnyThread<T>(T);
// SAFETY: only `cont` is called through it.
unsafe impl<T> Send for AnyThread<T> {}

#[derive(Default)]
struct Body {
    queue: VecDeque<Vec<u8>>,
    ended: bool,
    error: Option<String>,
    /// A parked read: where to write and how to tell CEF.
    parked: Option<(usize, usize, AnyThread<ResourceReadCallback>)>,
}

static BODIES: Mutex<Option<HashMap<u64, Arc<Mutex<Body>>>>> = Mutex::new(None);

fn body_of(stream_id: u64) -> Option<Arc<Mutex<Body>>> {
    BODIES
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(&stream_id).cloned())
}

fn register(stream_id: u64) -> Arc<Mutex<Body>> {
    let body = Arc::new(Mutex::new(Body::default()));
    BODIES
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(stream_id, body.clone());
    body
}

fn forget(stream_id: u64) {
    if let Some(map) = BODIES.lock().unwrap().as_mut() {
        map.remove(&stream_id);
    }
}

/// Completes a parked read with what is queued (or the end of the body).
fn wake(body: &Arc<Mutex<Body>>) {
    let mut b = body.lock().unwrap();
    let Some((ptr, max, callback)) = b.parked.take() else {
        return;
    };
    if b.queue.is_empty() && !b.ended {
        b.parked = Some((ptr, max, callback));
        return;
    }
    // SAFETY: the buffer CEF handed to `read` stays ours until `cont` is called; `cancel` clears `parked` under this
    // same lock first.
    let out = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u8, max) };
    let n = fill(&mut b.queue, out);
    callback.0.cont(n as i32);
}

/// `protocol.chunk {streamId}` + bin.
pub fn on_chunk(stream_id: u64, bytes: Vec<u8>) {
    if let Some(body) = body_of(stream_id) {
        body.lock().unwrap().queue.push_back(bytes);
        wake(&body);
    }
}

/// `protocol.end {streamId, error?}`.
pub fn on_end(stream_id: u64, error: Option<String>) {
    if let Some(body) = body_of(stream_id) {
        {
            let mut b = body.lock().unwrap();
            b.ended = true;
            b.error = error;
        }
        wake(&body);
    }
}

#[derive(Default)]
struct Head {
    status: i32,
    status_text: String,
    headers: Vec<(String, String)>,
    stream_id: u64,
    failed: Option<String>,
    ready: bool,
}

wrap_resource_handler! {
    struct ProtocolResource {
        scheme: String,
        partition: String,
        head: Arc<Mutex<Head>>,
        body: Arc<Mutex<Option<Arc<Mutex<Body>>>>>,
    }
    impl ResourceHandler {
        fn open(&self, request: Option<&mut cef::Request>, handle_request: Option<&mut i32>, callback: Option<&mut Callback>) -> i32 {
            let (Some(request), Some(callback)) = (request, callback.cloned()) else { return 0 };
            let url = CefString::from(&request.url()).to_string();
            let method = CefString::from(&request.method()).to_string();
            let mut map = CefStringMultimap::new();
            request.header_map(Some(&mut map));
            let headers: Vec<Value> = map.into_iter().flat_map(|(k, values)| values.into_iter().map(move |v| json!([k.clone(), v]))).collect();
            let mut body = Vec::new();
            if let Some(pd) = request.post_data() {
                let mut elements: Vec<Option<PostDataElement>> = (0..pd.element_count()).map(|_| None).collect();
                pd.elements(Some(&mut elements));
                for e in elements.into_iter().flatten() {
                    let n = e.bytes_count();
                    let mut buf = vec![0u8; n];
                    e.bytes(n, buf.as_mut_ptr());
                    body.extend_from_slice(&buf);
                }
            }
            let has_body = !body.is_empty();
            let params = json!({
                "scheme": self.scheme, "partition": self.partition, "url": url, "method": method,
                "headers": headers, "hasBody": has_body,
            });
            let (head, slot, callback) = (self.head.clone(), self.body.clone(), AnyThread(callback));
            host::request("protocol.request", params, has_body.then_some(body.as_slice()), move |result, _| {
                {
                    let mut h = head.lock().unwrap();
                    match result {
                        Ok(v) => {
                            h.status = v.get("status").and_then(Value::as_i64).unwrap_or(200) as i32;
                            h.status_text = v.get("statusText").and_then(Value::as_str).unwrap_or("").to_string();
                            h.headers = v
                                .get("headers")
                                .and_then(Value::as_array)
                                .map(|a| a.iter().filter_map(|p| Some((p.get(0)?.as_str()?.to_string(), p.get(1)?.as_str()?.to_string()))).collect())
                                .unwrap_or_default();
                            h.stream_id = v.get("streamId").and_then(Value::as_u64).unwrap_or(0);
                            *slot.lock().unwrap() = Some(register(h.stream_id));
                        }
                        Err(error) => h.failed = Some(error.message),
                    }
                    h.ready = true;
                }
                callback.0.cont();
            });
            if let Some(h) = handle_request {
                *h = 0;
            }
            1
        }

        /// See `scheme.rs`: a ranged request whose first byte is > 0 is already answered at that byte by Node's 206.
        fn skip(&self, bytes_to_skip: i64, bytes_skipped: Option<&mut i64>, _callback: Option<&mut ResourceSkipCallback>) -> i32 {
            if let Some(b) = bytes_skipped {
                *b = bytes_to_skip;
            }
            1
        }

        fn response_headers(&self, response: Option<&mut Response>, response_length: Option<&mut i64>, _redirect_url: Option<&mut CefString>) {
            let h = self.head.lock().unwrap();
            let Some(resp) = response else { return };
            if h.failed.is_some() {
                resp.set_error(Errorcode::from(sys::cef_errorcode_t::ERR_FAILED));
                return;
            }
            resp.set_status(h.status);
            resp.set_status_text(Some(&CefString::from(h.status_text.as_str())));
            let mut length = -1i64;
            for (k, v) in &h.headers {
                if k.eq_ignore_ascii_case("content-type") {
                    resp.set_mime_type(Some(&CefString::from(v.split(';').next().unwrap_or(v).trim())));
                }
                if k.eq_ignore_ascii_case("content-length") {
                    length = v.parse().unwrap_or(-1);
                }
                resp.set_header_by_name(Some(&CefString::from(k.as_str())), Some(&CefString::from(v.as_str())), 1);
            }
            if let Some(l) = response_length {
                *l = length;
            }
        }

        fn read(&self, data_out: *mut u8, bytes_to_read: i32, bytes_read: Option<&mut i32>, callback: Option<&mut ResourceReadCallback>) -> i32 {
            let Some(body) = self.body.lock().unwrap().clone() else {
                if let Some(b) = bytes_read {
                    *b = 0;
                }
                return 0;
            };
            let mut b = body.lock().unwrap();
            let want = bytes_to_read.max(0) as usize;
            if b.queue.is_empty() {
                if b.ended {
                    if let Some(n) = bytes_read {
                        *n = 0;
                    }
                    return 0;
                }
                let Some(callback) = callback.cloned() else { return 0 };
                b.parked = Some((data_out as usize, want, AnyThread(callback)));
                if let Some(n) = bytes_read {
                    *n = 0;
                }
                return 1;
            }
            // SAFETY: CEF gives a buffer of `bytes_to_read` bytes, valid for this call.
            let out = unsafe { std::slice::from_raw_parts_mut(data_out, want) };
            let n = fill(&mut b.queue, out);
            if let Some(r) = bytes_read {
                *r = n as i32;
            }
            1
        }

        fn cancel(&self) {
            let stream_id = self.head.lock().unwrap().stream_id;
            if let Some(body) = self.body.lock().unwrap().take() {
                body.lock().unwrap().parked = None;
            }
            if stream_id != 0 {
                forget(stream_id);
                host::event("protocol.cancel", json!({ "streamId": stream_id }));
            }
        }
    }
}

wrap_scheme_handler_factory! {
    pub struct ProtocolFactory {
        scheme: String,
        partition: String,
    }
    impl SchemeHandlerFactory {
        fn create(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            _request: Option<&mut cef::Request>,
        ) -> Option<ResourceHandler> {
            Some(ProtocolResource::new(
                self.scheme.clone(),
                self.partition.clone(),
                Arc::new(Mutex::new(Head::default())),
                Arc::new(Mutex::new(None)),
            ))
        }
    }
}
