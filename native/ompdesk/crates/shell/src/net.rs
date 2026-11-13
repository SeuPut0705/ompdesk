//! `net.*` (PROTOCOL.md §10): Electron's `net` over Chromium's network stack through `CefURLRequest` (the system
//! proxy, PAC and certificate store apply). `net.fetch` answers with the head as soon as the response started, then
//! streams the body as `net.chunk` events (each chunk CEF hands over is forwarded at once and split at 1 MiB, never
//! collected) and a final `net.end {reqId, error?}`; `net.resolveHost` asks the request context's resolver. A module of
//! the shell fetches the same way through `fetch_in_shell` (the updater, PROTOCOL.md §15.8) and hears its head, chunks
//! and end on a channel; a challenge of such a fetch is cancelled (the 401/407 is the response).
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
//! - `net.resolveHost`'s `cacheUsage: "disallowed"` (or `"disabled"`) skips Chromium's host cache by asking the OS
//!   resolver (`getaddrinfo`, on a worker thread, answered after at most 15 s as `ERR_NAME_NOT_RESOLVED`) instead of
//!   CEF's: that lookup ignores Chromium's own DNS configuration (secure DNS, custom servers) and the OS resolver's own
//!   cache still applies. `staleAllowed` behaves as `allowed`. `bypassCustomProtocolHandlers`
//!   fails a custom-scheme URL with `net::ERR_UNKNOWN_URL_SCHEME`, which is what Chromium would answer without handlers.
//! - The request headers `Content-Length`, `Host`, `Connection` and `Transfer-Encoding` are Chromium's to compute and
//!   are not forwarded.
//! - HTTP authentication (server 401 or proxy 407) is asked of Node as a `net.login` request; credentials from Node go
//!   back to CEF, `{cancel: true}`, an error, Node's absence or an aborted fetch cancel the challenge and the 401/407 is
//!   the response. CEF asks again after wrong credentials, so Node sees each retry; there is no timeout on the shell's
//!   side beyond the request's own end.
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

/// Who a fetch answers: Node's `net.fetch` call (until the head goes) or a module of the shell.
enum To {
    Node(Option<Call>),
    Shell(Sender<Got>),
}

/// Ids of fetches the shell makes itself, far past any `reqId` Node counts from 1.
static SHELL_REQ_IDS: AtomicU64 = AtomicU64::new(1 << 62);

/// One fetch, from the UI thread only (CEF calls the client on the thread that created the request).
struct Fetch {
    req_id: u64,
    /// Who hears it: Node's `net.fetch` call until the head (or a failure before it) answers it, or a shell module.
    to: To,
    url: String,
    redirect: Redirect,
    head_sent: bool,
    /// Manual redirect: the request was halted at a 3xx on purpose, so the halt is not an error.
    stopped_at_redirect: bool,
    finished: bool,
    /// Node cancelled it (`{cancel}` or `net.cancel`): it hears nothing more about it.
    aborted: bool,
    /// The challenge CEF waits on (answered by Node's `net.login`), with the number of the question it belongs to: an
    /// answer to an earlier question is ignored.
    login: Option<(u64, AuthCallback)>,
    login_seq: u64,
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
    let (finished, login) = {
        let mut f = fetch.borrow_mut();
        f.aborted = true;
        (f.finished, f.login.take())
    };
    if let Some((_, callback)) = login {
        callback.cancel();
    }
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
    ui::run(move || start(To::Node(Some(call)), &params, body));
}

/// A GET or HEAD a module of the shell makes (`netmap::parse_fetch`'s params without `reqId`, no body). Returns the
/// fetch's id (for `cancel_in_shell`) and what it hears. Wait on it from any thread but the UI thread.
pub fn fetch_in_shell(mut params: Value) -> Result<(u64, Receiver<Got>), String> {
    let req_id = SHELL_REQ_IDS.fetch_add(1, Ordering::Relaxed);
    params["reqId"] = json!(req_id);
    params["hasBody"] = json!(false);
    let params = netmap::parse_fetch(&params)?;
    if let Some(text) = netmap::refuse_url(&params.url, params.bypass_custom_protocol_handlers) {
        return Err(text);
    }
    let (tx, rx) = mpsc::channel();
    ui::post(move || start(To::Shell(tx), &params, None));
    Ok((req_id, rx))
}

/// Stops a fetch `fetch_in_shell` started; it hears nothing more but a `Failed` when no head came yet.
pub fn cancel_in_shell(req_id: u64) {
    ui::post(move || abort(req_id));
}

/// Answers a fetch that failed before its head.
fn refuse(to: To, message: &str) {
    match to {
        To::Node(Some(call)) => {
            host::forget_cancel(call.id());
            call.err("failed", message);
        }
        To::Node(None) => {}
        To::Shell(tx) => {
            let _ = tx.send(Got::Failed(message.to_string()));
        }
    }
}

/// The fetch's answer before its head, taken out of it (`None` once Node's call went).
fn take_to(fetch: &Shared) -> Option<To> {
    let mut f = fetch.borrow_mut();
    match &mut f.to {
        To::Node(call) => call.take().map(|call| To::Node(Some(call))),
        To::Shell(tx) => Some(To::Shell(tx.clone())),
    }
}

fn start(to: To, params: &FetchParams, body: Option<Vec<u8>>) {
    let Some(mut request) = request_create() else {
        return refuse(to, &netmap::error_text(-2));
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
            return refuse(to, &netmap::error_text(-2));
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
        login: None,
        login_seq: 0,
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
            if let Some(to) = take_to(&state) {
                refuse(to, &netmap::error_text(-2));
            }
        }
    }
}

/// Answers the call with the head of the response (once).
fn send_head(fetch: &Shared, head: Value) {
    fetch.borrow_mut().head_sent = true;
    match take_to(fetch) {
        Some(To::Node(Some(call))) => {
            host::forget_cancel(call.id());
            call.ok(head);
        }
        Some(To::Shell(tx)) => {
            let _ = tx.send(Got::Head(head));
        }
        _ => {}
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
                fetch.borrow_mut().finished = true;
                if let Some(to) = take_to(fetch) {
                    refuse(to, &netmap::error_text(-2));
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
    if let To::Shell(tx) = &fetch.borrow().to {
        let _ = tx.send(Got::Chunk(bytes.to_vec()));
        return;
    }
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
                let error = (!ok).then(|| netmap::error_text(code));
                if let To::Shell(tx) = &fetch.borrow().to {
                    let _ = tx.send(Got::End(error));
                } else {
                    let mut end = json!({ "reqId": req_id });
                    if let Some(error) = error {
                        end["error"] = json!(error);
                    }
                    host::event("net.end", end);
                }
            }
        } else {
            let message = if aborted {
                netmap::error_text(-3)
            } else {
                netmap::error_text(code)
            };
            if let Some(to) = take_to(fetch) {
                refuse(to, &message);
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

        fn auth_credentials(
            &self,
            is_proxy: ::std::os::raw::c_int,
            host: Option<&CefString>,
            port: ::std::os::raw::c_int,
            realm: Option<&CefString>,
            scheme: Option<&CefString>,
            callback: Option<&mut AuthCallback>,
        ) -> ::std::os::raw::c_int {
            let Some(callback) = callback else { return 0 };
            let text = |value: Option<&CefString>| value.map(CefString::to_string).unwrap_or_default();
            let challenge = netmap::Challenge {
                is_proxy: is_proxy != 0,
                scheme: text(scheme),
                host: text(host),
                port,
                realm: text(realm),
            };
            ask_login(&self.fetch, challenge, callback.clone());
            1
        }
    }
}

/// Hands a challenge to Node (`net.login`); the answer comes back on the reader thread and is applied on the UI thread.
fn ask_login(fetch: &Shared, challenge: netmap::Challenge, callback: AuthCallback) {
    let (req_id, seq, stale) = {
        let mut f = fetch.borrow_mut();
        // A fetch of the shell's own has nobody to ask: the challenge's 401/407 is its response.
        if f.aborted || f.finished || matches!(f.to, To::Shell(_)) {
            drop(f);
            return callback.cancel();
        }
        f.login_seq += 1;
        let seq = f.login_seq;
        (f.req_id, seq, f.login.replace((seq, callback)))
    };
    if let Some((_, callback)) = stale {
        callback.cancel();
    }
    host::request(
        "net.login",
        netmap::login_params(req_id, &challenge),
        None,
        move |result, _| {
            let answer = netmap::login_answer(result.as_ref().ok());
            ui::post(move || answer_login(req_id, seq, answer));
        },
    );
}

/// Applies Node's answer to the challenge `seq` of fetch `req_id` (UI thread). A fetch that is gone or has moved on to
/// a later challenge has nothing waiting any more.
fn answer_login(req_id: u64, seq: u64, answer: netmap::LoginAnswer) {
    let fetch = ACTIVE.with(|active| active.borrow().get(&req_id).map(|(_, fetch)| fetch.clone()));
    let Some(fetch) = fetch else { return };
    let callback = {
        let mut f = fetch.borrow_mut();
        match f.login.take() {
            Some((waiting, callback)) if waiting == seq => Some(callback),
            other => {
                f.login = other;
                None
            }
        }
    };
    let Some(callback) = callback else { return };
    match answer {
        netmap::LoginAnswer::Credentials { username, password } => {
            callback.cont(Some(&cs(&username)), Some(&cs(&password)));
        }
        netmap::LoginAnswer::Cancel => callback.cancel(),
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
