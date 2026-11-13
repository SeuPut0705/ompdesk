//! Chromium's network stack through `CefURLRequest` (the system proxy, PAC and certificate store apply), for the
//! shell's own modules (`fetch_in_shell`: the updater, PROTOCOL.md §15.8), and `net.resolveHost` for Node
//! (PROTOCOL.md §10). A fetch hears its head as soon as the response started, then the body chunk by chunk as CEF
//! hands it over (never collected) and its end.
//!
//! What CEF's URL request API makes of a fetch:
//! - `credentials: "same-origin"` sends and keeps cookies like `include`: a request from the browser process has no
//!   origin to compare. `omit` sends and keeps none.
//! - `redirected` is "the final URL differs from the requested one (ignoring the fragment)": CEF does not report the
//!   redirect hops. `redirect: "manual"` and `"error"` stop at the first 3xx that has a `Location`
//!   (`UR_FLAG_STOP_ON_REDIRECT`); a 3xx without `Location` is an ordinary response.
//! - The head comes with the first body bytes (or at completion for an empty body), not before: CEF tells the client
//!   nothing earlier.
//! - `statusText` of an HTTP/2 response (which carries none) is the standard reason phrase.
//! - `net.resolveHost`'s `cacheUsage: "disallowed"` (or `"disabled"`) skips Chromium's host cache by asking the OS
//!   resolver (`getaddrinfo`, on a worker thread, answered after at most 15 s as `ERR_NAME_NOT_RESOLVED`) instead of
//!   CEF's: that lookup ignores Chromium's own DNS configuration (secure DNS, custom servers) and the OS resolver's own
//!   cache still applies. `staleAllowed` behaves as `allowed`.
//! - The request headers `Content-Length`, `Host`, `Connection` and `Transfer-Encoding` are Chromium's to compute and
//!   are not forwarded.
//! - HTTP authentication (server 401 or proxy 407) is never answered: the challenge is cancelled and the 401/407 is
//!   the response (the updater's requests carry their token as a header).
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use cef::*;
use serde_json::{Value, json};
use shell_core::netmap::{self, CacheUsage, FetchParams, Redirect};

use crate::host::Call;
use crate::log::log;
use crate::{session, ui};

fn cs(text: &str) -> CefString {
    CefString::from(text)
}

fn error_code(error: Errorcode) -> i32 {
    let raw: sys::cef_errorcode_t = error.into();
    raw as i32
}

/// What a fetch made in the shell itself hears (`fetch_in_shell`), in order: the head or a failure, then chunks and
/// the end.
pub enum Got {
    /// `net.fetch`'s answer: `{status, statusText, url, redirected, headers}`.
    Head(Value),
    Chunk(Vec<u8>),
    /// The body is over; `Some` names Chromium's error when it ended early.
    End(Option<String>),
    /// No head came: Chromium's `net::ERR_…`.
    Failed(String),
}

static REQ_IDS: AtomicU64 = AtomicU64::new(1);

/// One fetch, from the UI thread only (CEF calls the client on the thread that created the request).
struct Fetch {
    req_id: u64,
    to: Sender<Got>,
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
        "net.resolveHost" => resolve_host(call),
        _ => call.unsupported(),
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

/// A GET or HEAD a module of the shell makes (`netmap::parse_fetch`'s params without `reqId`, no body). Returns the
/// fetch's id (for `cancel_in_shell`) and what it hears. Wait on it from any thread but the UI thread.
pub fn fetch_in_shell(mut params: Value) -> Result<(u64, Receiver<Got>), String> {
    let req_id = REQ_IDS.fetch_add(1, Ordering::Relaxed);
    params["reqId"] = json!(req_id);
    params["hasBody"] = json!(false);
    let params = netmap::parse_fetch(&params)?;
    if let Some(text) = netmap::refuse_url(&params.url, params.bypass_custom_protocol_handlers) {
        return Err(text);
    }
    let (tx, rx) = mpsc::channel();
    ui::post(move || start(tx, &params, None));
    Ok((req_id, rx))
}

/// Stops a fetch `fetch_in_shell` started; it hears nothing more but a `Failed` when no head came yet.
pub fn cancel_in_shell(req_id: u64) {
    ui::post(move || abort(req_id));
}

/// A fetch that failed before its head.
fn refuse(to: &Sender<Got>, message: &str) {
    let _ = to.send(Got::Failed(message.to_string()));
}

fn start(to: Sender<Got>, params: &FetchParams, body: Option<Vec<u8>>) {
    let Some(mut request) = request_create() else {
        return refuse(&to, &netmap::error_text(-2));
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
            return refuse(&to, &netmap::error_text(-2));
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
    request.set_flags(flags as _);
    if wanted.allow_stored_credentials {
        // A first-party request: SameSite cookies go with it, as with Electron's `useSessionCookies`.
        request.set_first_party_for_cookies(Some(&cs(&params.url)));
    }

    let state: Shared = Rc::new(RefCell::new(Fetch {
        req_id: params.req_id,
        to,
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
        None => refuse(&state.borrow().to, &netmap::error_text(-2)),
    }
}

/// Hands the head of the response over (once).
fn send_head(fetch: &Shared, head: Value) {
    let mut f = fetch.borrow_mut();
    f.head_sent = true;
    let _ = f.to.send(Got::Head(head));
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
                fetch.borrow_mut().finished = true;
                refuse(&fetch.borrow().to, &netmap::error_text(-2));
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
    let _ = fetch.borrow().to.send(Got::Chunk(bytes.to_vec()));
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
                let error = (!ok).then(|| netmap::error_text(code));
                let _ = fetch.borrow().to.send(Got::End(error));
            }
        } else {
            let message = if aborted {
                netmap::error_text(-3)
            } else {
                netmap::error_text(code)
            };
            refuse(&fetch.borrow().to, &message);
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
    let usage = match netmap::cache_usage(call.params.get("cacheUsage").and_then(Value::as_str)) {
        Ok(usage) => usage,
        Err(message) => return call.err("invalid", message),
    };
    if usage == CacheUsage::Disallowed {
        return resolve_fresh(call, host_name);
    }
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

/// How long a fresh OS lookup may take before the call is answered as unresolved (the worker thread then finishes on
/// its own and its answer is dropped).
const FRESH_RESOLVE_DEADLINE_MS: i64 = 15_000;

type FreshSlot = Arc<Mutex<Option<Call>>>;

/// `cacheUsage: "disallowed"`: the OS resolver on a worker thread (it blocks), never the UI thread.
fn resolve_fresh(call: Call, host_name: String) {
    let slot: FreshSlot = Arc::new(Mutex::new(Some(call)));
    let late = slot.clone();
    ui::post_delayed(FRESH_RESOLVE_DEADLINE_MS, move || {
        answer_fresh(&late, Err(-105));
    });
    let worker = slot.clone();
    let spawned = std::thread::Builder::new()
        .name("net-resolve".into())
        .spawn(move || answer_fresh(&worker, netmap::resolve_system(&host_name)));
    if let Err(error) = spawned {
        let call = slot.lock().unwrap().take();
        if let Some(call) = call {
            call.err("failed", format!("could not start a lookup: {error}"));
        }
    }
}

/// Answers the call if nobody has yet (the lookup and the deadline race for it).
fn answer_fresh(slot: &FreshSlot, result: Result<Vec<String>, i32>) {
    let call = slot.lock().unwrap().take();
    let Some(call) = call else { return };
    match result {
        Ok(addresses) => call.ok(netmap::endpoints_json(&addresses)),
        Err(code) => call.err("failed", netmap::error_text(code)),
    }
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
