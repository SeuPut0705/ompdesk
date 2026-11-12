//! `net.*` (PROTOCOL.md §10): Electron's `net` over Chromium's network stack through `CefURLRequest` (the system
//! proxy, PAC and certificate store apply). `net.fetch` answers with the head as soon as the response started, then
//! streams the body as `net.chunk` events (each chunk CEF hands over is forwarded at once and split at 1 MiB, never
//! collected) and a final `net.end {reqId, error?}`; `net.resolveHost` asks the request context's resolver.
//!
//! Differences from Electron's `net` that CEF's URL request API does not allow to avoid:
//! - `credentials: "same-origin"` (Fetch's default, so every `net.request`) sends and keeps cookies like `include`:
//!   a request from the main process has no origin to compare. `omit` sends and keeps none.
//! - `redirected` is "the final URL differs from the requested one (ignoring the fragment)": CEF does not report the
//!   redirect hops. `redirect: "manual"` and `"error"` stop at the first 3xx that has a `Location`
//!   (`UR_FLAG_STOP_ON_REDIRECT`); a 3xx without `Location` is an ordinary response.
//! - The head goes out with the first body bytes (or at completion for an empty body), not before: CEF tells the
//!   client nothing earlier. A response that stays silent after its headers shows no head until then.
//! - `statusText` of an HTTP/2 response (which carries none) is the standard reason phrase.
//! - Chunks are not paced: a Node side that reads slower than the network lets them queue in the writer.
//! - `net.resolveHost`'s `cacheUsage` is ignored (CEF's resolver has no such option); `bypassCustomProtocolHandlers`
//!   fails a custom-scheme URL with `net::ERR_UNKNOWN_URL_SCHEME`, which is what Chromium would answer without handlers.
//! - The request headers `Content-Length`, `Host`, `Connection` and `Transfer-Encoding` are Chromium's to compute and
//!   are not forwarded.
//! - HTTP authentication prompts are not answered (a 401 with a challenge is returned as the response).
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use cef::*;
use serde_json::{Value, json};
use shell_core::netmap::{self, FetchParams, Redirect};

use crate::host::{self, Call};
use crate::log::log;
use crate::{session, ui};

/// The most bytes one `net.chunk` carries; a larger piece from CEF goes out as several.
const MAX_CHUNK: usize = 1 << 20;

fn cs(text: &str) -> CefString {
    CefString::from(text)
}

fn error_code(error: Errorcode) -> i32 {
    let raw: sys::cef_errorcode_t = error.into();
    raw as i32
}

/// One fetch, from the UI thread only (CEF calls the client on the thread that created the request).
struct Fetch {
    req_id: u64,
    /// The `net.fetch` call, until the head (or a failure before it) answers it.
    call: Option<Call>,
    url: String,
    redirect: Redirect,
    head_sent: bool,
    /// Manual redirect: the request was halted at a 3xx on purpose, so the halt is not an error.
    stopped_at_redirect: bool,
    finished: bool,
    /// Node cancelled it (`{cancel}` or `net.cancel`): it hears nothing more about it.
    aborted: bool,
}

type Shared = Rc<RefCell<Fetch>>;

thread_local! {
    /// The requests in flight, so a cancel finds its `CefURLRequest`. UI thread.
    static ACTIVE: RefCell<HashMap<u64, (Urlrequest, Shared)>> = RefCell::new(HashMap::new());
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "net.fetch" => fetch(call),
        "net.resolveHost" => resolve_host(call),
        _ => call.unsupported(),
    }
}

/// `net.cancel {reqId}`: the page dropped the response body (or aborted the fetch).
pub fn cancel(data: Value) {
    if let Some(req_id) = data.get("reqId").and_then(Value::as_u64) {
        ui::post(move || abort(req_id));
    }
}

fn abort(req_id: u64) {
    let entry = ACTIVE.with(|active| {
        active
            .borrow()
            .get(&req_id)
            .map(|(request, fetch)| (request.clone(), fetch.clone()))
    });
    let Some((request, fetch)) = entry else {
        return;
    };
    let finished = {
        let mut f = fetch.borrow_mut();
        f.aborted = true;
        f.finished
    };
    if !finished {
        // No borrow is held: CEF may report the cancellation from inside this call.
        request.cancel();
    }
}

fn fetch(mut call: Call) {
    let params = match netmap::parse_fetch(&call.params) {
        Ok(params) => params,
        Err(message) => return call.err("invalid", message),
    };
    if let Some(text) = netmap::refuse_url(&params.url, params.bypass_custom_protocol_handlers) {
        return call.err("failed", text);
    }
    let body = if params.has_body {
        Some(call.bin.take().unwrap_or_default())
    } else {
        None
    };
    let req_id = params.req_id;
    host::on_cancel(call.id(), move || ui::post(move || abort(req_id)));
    ui::run(move || start(call, &params, body));
}

/// Answers a `net.fetch` that failed before its head.
fn refuse(call: Call, message: &str) {
    host::forget_cancel(call.id());
    call.err("failed", message);
}

fn start(call: Call, params: &FetchParams, body: Option<Vec<u8>>) {
    let Some(mut request) = request_create() else {
        return refuse(call, &netmap::error_text(-2));
    };
    request.set_url(Some(&cs(&params.url)));
    request.set_method(Some(&cs(&params.method)));
    if !params.headers.is_empty() {
        let mut map = CefStringMultimap::new();
        for (name, value) in &params.headers {
            map.append(name, value);
        }
        request.set_header_map(Some(&mut map));
    }
    if let Some(body) = body.filter(|b| !b.is_empty()) {
        let (Some(mut post), Some(mut element)) = (post_data_create(), post_data_element_create())
        else {
            return refuse(call, &netmap::error_text(-2));
        };
        // `set_to_bytes` copies the bytes.
        element.set_to_bytes(body.len(), body.as_ptr());
        post.add_element(Some(&mut element));
        request.set_post_data(Some(&mut post));
    }
    let wanted = params.url_flags();
    let mut flags = sys::cef_urlrequest_flags_t::UR_FLAG_NO_RETRY_ON_5XX.0;
    for (set, flag) in [
        (
            wanted.skip_cache,
            sys::cef_urlrequest_flags_t::UR_FLAG_SKIP_CACHE,
        ),
        (
            wanted.only_from_cache,
            sys::cef_urlrequest_flags_t::UR_FLAG_ONLY_FROM_CACHE,
        ),
        (
            wanted.disable_cache,
            sys::cef_urlrequest_flags_t::UR_FLAG_DISABLE_CACHE,
        ),
        (
            wanted.allow_stored_credentials,
            sys::cef_urlrequest_flags_t::UR_FLAG_ALLOW_STORED_CREDENTIALS,
        ),
        (
            wanted.stop_on_redirect,
            sys::cef_urlrequest_flags_t::UR_FLAG_STOP_ON_REDIRECT,
        ),
    ] {
        if set {
            flags |= flag.0;
        }
    }
    request.set_flags(flags);
    if wanted.allow_stored_credentials {
        // A first-party request: SameSite cookies go with it, as with Electron's `useSessionCookies`.
        request.set_first_party_for_cookies(Some(&cs(&params.url)));
    }

    let state: Shared = Rc::new(RefCell::new(Fetch {
        req_id: params.req_id,
        call: Some(call),
        url: params.url.clone(),
        redirect: params.redirect,
        head_sent: false,
        stopped_at_redirect: false,
        finished: false,
        aborted: false,
    }));
    let mut client = FetchClient::new(state.clone());
    let mut context = session::context_for(&params.partition);
    match urlrequest_create(Some(&mut request), Some(&mut client), context.as_mut()) {
        Some(urlrequest) => ACTIVE.with(|active| {
            active
                .borrow_mut()
                .insert(params.req_id, (urlrequest, state));
        }),
        None => {
            let call = state.borrow_mut().call.take();
            if let Some(call) = call {
                refuse(call, &netmap::error_text(-2));
            }
        }
    }
}

/// Answers the call with the head of the response (once).
fn send_head(fetch: &Shared, head: Value) {
    let call = {
        let mut f = fetch.borrow_mut();
        f.head_sent = true;
        f.call.take()
    };
    if let Some(call) = call {
        host::forget_cancel(call.id());
        call.ok(head);
    }
}

/// Sends the head when the response has started and it has not gone yet. A redirect the fetch must not follow ends
/// here: `error` fails the call, `manual` hands the 3xx itself over.
fn deliver_head(request: &Urlrequest, fetch: &Shared) {
    {
        let f = fetch.borrow();
        if f.head_sent || f.finished || f.aborted {
            return;
        }
    }
    let Some(response) = request.response() else {
        return;
    };
    let status = response.status();
    if status <= 0 {
        return;
    }
    let mut map = CefStringMultimap::new();
    response.header_map(Some(&mut map));
    let headers = netmap::header_pairs(map.into_iter().collect());
    let has_location = headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("location"));
    let (redirect, requested) = {
        let f = fetch.borrow();
        (f.redirect, f.url.clone())
    };
    if netmap::is_redirect(status, has_location) {
        match redirect {
            Redirect::Error => {
                let call = {
                    let mut f = fetch.borrow_mut();
                    f.finished = true;
                    f.call.take()
                };
                if let Some(call) = call {
                    refuse(call, &netmap::error_text(-2));
                }
                request.cancel();
                return;
            }
            Redirect::Manual => fetch.borrow_mut().stopped_at_redirect = true,
            Redirect::Follow => {}
        }
    }
    let status_text = CefString::from(&response.status_text()).to_string();
    let final_url = CefString::from(&response.url()).to_string();
    send_head(
        fetch,
        netmap::head_json(status, &status_text, &requested, &final_url, &headers),
    );
}

fn forward(request: &Urlrequest, fetch: &Shared, data: *const u8, length: usize) {
    deliver_head(request, fetch);
    let (req_id, head_sent, over) = {
        let f = fetch.borrow();
        (f.req_id, f.head_sent, f.finished || f.aborted)
    };
    if over || data.is_null() || length == 0 {
        return;
    }
    if !head_sent {
        log(
            "net.data_before_head",
            json!({ "reqId": req_id, "bytes": length }),
        );
        return;
    }
    // SAFETY: CEF passes `length` readable bytes at `data`, valid until this callback returns; they are copied into
    // the frame before that.
    let bytes = unsafe { std::slice::from_raw_parts(data, length) };
    for part in bytes.chunks(MAX_CHUNK) {
        host::event_bin("net.chunk", json!({ "reqId": req_id }), part);
    }
}

/// The request is over (exactly once per request): the body's end, or the failure.
fn complete(request: &Urlrequest, fetch: &Shared) {
    deliver_head(request, fetch);
    let (req_id, head_sent, finished, aborted, stopped) = {
        let f = fetch.borrow();
        (
            f.req_id,
            f.head_sent,
            f.finished,
            f.aborted,
            f.stopped_at_redirect,
        )
    };
    if !finished {
        let error = request.request_error();
        let ok = (request.request_status() == UrlrequestStatus::SUCCESS
            && error == Errorcode::NONE)
            || stopped;
        let code = match error_code(error) {
            0 => -2,
            code => code,
        };
        if head_sent {
            if !aborted {
                let mut end = json!({ "reqId": req_id });
                if !ok {
                    end["error"] = json!(netmap::error_text(code));
                }
                host::event("net.end", end);
            }
        } else {
            let message = if aborted {
                netmap::error_text(-3)
            } else {
                netmap::error_text(code)
            };
            let call = fetch.borrow_mut().call.take();
            if let Some(call) = call {
                refuse(call, &message);
            }
        }
        fetch.borrow_mut().finished = true;
    }
    // The request object is still inside this callback: let go of it afterwards.
    ui::post(move || {
        ACTIVE.with(|active| {
            active.borrow_mut().remove(&req_id);
        });
    });
}

wrap_urlrequest_client! {
    struct FetchClient {
        fetch: Shared,
    }
    impl UrlrequestClient {
        fn on_request_complete(&self, request: Option<&mut Urlrequest>) {
            if let Some(request) = request {
                complete(request, &self.fetch);
            }
        }

        fn on_download_progress(&self, request: Option<&mut Urlrequest>, _current: i64, _total: i64) {
            if let Some(request) = request {
                deliver_head(request, &self.fetch);
            }
        }

        fn on_download_data(&self, request: Option<&mut Urlrequest>, data: *const u8, data_length: usize) {
            if let Some(request) = request {
                forward(request, &self.fetch, data, data_length);
            }
        }
    }
}

fn resolve_host(call: Call) {
    let Some(host_name) = call.str("host").filter(|h| !h.trim().is_empty()) else {
        return call.err("invalid", "net.resolveHost needs a host");
    };
    let partition = call.str("partition").unwrap_or_default();
    ui::run(move || {
        let slot = Rc::new(RefCell::new(Some(call)));
        let context = session::context_for(&partition).or_else(request_context_get_global_context);
        let Some(context) = context else {
            let call = slot.borrow_mut().take();
            if let Some(call) = call {
                call.err("failed", "no request context to resolve with");
            }
            return;
        };
        let mut callback = HostResolved::new(slot);
        context.resolve_host(
            Some(&cs(&netmap::resolve_origin(&host_name))),
            Some(&mut callback),
        );
    });
}

wrap_resolve_callback! {
    struct HostResolved {
        call: Rc<RefCell<Option<Call>>>,
    }
    impl ResolveCallback {
        fn on_resolve_completed(&self, result: Errorcode, resolved_ips: Option<&mut CefStringList>) {
            let Some(call) = self.call.borrow_mut().take() else { return };
            let code = error_code(result);
            if code != 0 {
                return call.err("failed", netmap::error_text(code));
            }
            let addresses: Vec<String> = resolved_ips.map(|list| std::mem::take(list).into_iter().collect()).unwrap_or_default();
            let answer = netmap::endpoints_json(&addresses);
            if answer["endpoints"].as_array().is_some_and(Vec::is_empty) {
                return call.err("failed", netmap::error_text(-105));
            }
            call.ok(answer);
        }
    }
}
