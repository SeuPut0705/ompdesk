//! `app://ompdesk/`: the renderer's files (with `Range` answers), the shell's own endpoints under `/__shell/` and
//! the page ⇄ Node relay under `/__ipc/` (`ipc.rs`). Served by CEF's scheme handler on its IO thread.
#![allow(unsafe_code)]

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex};

use cef::*;
use serde_json::{Value, json};
use shell_core::migrate::local_storage::{DONE_FILE, IMPORT_FILE};
use shell_core::range::{ParsedRange, parse_range};
use shell_core::startup::is_plain_relative;

use crate::state::paths;
use crate::{host, ipc, log::log, wc};

/// A CEF callback handed to another thread: CEF documents `Callback::cont` and `ResourceReadCallback::cont` as
/// callable from any thread, which is what the wrapper asserts.
struct AnyThread<T>(T);
// SAFETY: see above; the wrapped callbacks are only ever used through `cont`.
unsafe impl<T> Send for AnyThread<T> {}

enum Source {
    Empty,
    Mem(Vec<u8>),
    File(File),
    /// The page's `wc.send` stream (never ends).
    Events(u64),
}

struct Resp {
    status: i32,
    status_text: &'static str,
    mime: &'static str,
    headers: Vec<(&'static str, String)>,
    source: Source,
    /// Offset of the next byte to hand out, one past the last byte of this response, the advertised length.
    pos: u64,
    end: u64,
    length: i64,
    /// An answer that is not there yet (an `ipc.invoke`): filled by the reply thread.
    waiting: bool,
}

impl Resp {
    fn empty() -> Resp {
        Resp {
            status: 200,
            status_text: "OK",
            mime: "",
            headers: Vec::new(),
            source: Source::Empty,
            pos: 0,
            end: 0,
            length: 0,
            waiting: false,
        }
    }

    fn mem(status: i32, text: &'static str, mime: &'static str, body: Vec<u8>) -> Resp {
        let n = body.len() as u64;
        Resp {
            status,
            status_text: text,
            mime,
            headers: vec![("Accept-Ranges", "bytes".into())],
            source: Source::Mem(body),
            pos: 0,
            end: n,
            length: n as i64,
            waiting: false,
        }
    }

    fn json(value: &Value) -> Resp {
        let mut r = Resp::mem(
            200,
            "OK",
            "application/json",
            value.to_string().into_bytes(),
        );
        r.headers.push(("Cache-Control", "no-store".into()));
        r
    }

    fn no_content() -> Resp {
        Resp::mem(204, "No Content", "", Vec::new())
    }

    fn not_found() -> Resp {
        Resp::mem(404, "Not Found", "text/plain", b"not found".to_vec())
    }

    fn refused(text: &'static str) -> Resp {
        Resp::mem(403, "Forbidden", "text/plain", text.as_bytes().to_vec())
    }
}

pub fn mime_of(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "webmanifest" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "wasm" => "application/wasm",
        "ico" => "image/x-icon",
        "txt" => "text/plain",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(windows)]
const PLATFORM: &str = "win32";
#[cfg(not(windows))]
const PLATFORM: &str = "darwin";

/// Windows has no CSS `env(titlebar-area-*)` outside Electron: the page's caption variables are set here, the way
/// the dev harness does (`dev-harness/boot.ts`). macOS keeps the page's own `--sc-traffic-lights`.
#[cfg(windows)]
const CAPTION_STYLE: &str = "<style>html[data-platform='win32']:root{--sc-caption-buttons:138px;--sc-caption-band:48px}</style>";
#[cfg(not(windows))]
const CAPTION_STYLE: &str = "";

/// `index.html` with the preload first in `<head>` (a classic script, so it defines `window.omp` before the app's
/// module scripts run) and the platform marker Electron's preload path gave.
pub fn inject_index(html: &[u8]) -> Vec<u8> {
    let mut s = String::from_utf8_lossy(html).into_owned();
    if let Some(i) = s.find("<head")
        && let Some(j) = s[i..].find('>')
    {
        s.insert_str(
            i + j + 1,
            &format!("<script src=\"/__shell/preload.js\"></script>{CAPTION_STYLE}"),
        );
    }
    if !s.contains("data-platform")
        && let Some(i) = s.find("<html")
    {
        s.insert_str(i + 5, &format!(" data-platform=\"{PLATFORM}\""));
    }
    s.into_bytes()
}

struct Request {
    method: String,
    path: String,
    range: Option<String>,
    origin: Option<String>,
    body: Vec<u8>,
}

fn read_request(req: &mut cef::Request) -> Request {
    let url = CefString::from(&req.url()).to_string();
    let method = CefString::from(&req.method()).to_string();
    let header = |name: &str| {
        let v = CefString::from(&req.header_by_name(Some(&CefString::from(name)))).to_string();
        (!v.is_empty()).then_some(v)
    };
    let after = url.strip_prefix("app://ompdesk").unwrap_or(&url);
    let after = after.split('#').next().unwrap_or("");
    let path = pct_decode(after.split('?').next().unwrap_or(""));
    let path = if path.is_empty() || path == "/" {
        "/index.html".to_string()
    } else {
        path
    };
    let mut body = Vec::new();
    if let Some(pd) = req.post_data() {
        let mut elements: Vec<Option<PostDataElement>> =
            (0..pd.element_count()).map(|_| None).collect();
        pd.elements(Some(&mut elements));
        for e in elements.into_iter().flatten() {
            let n = e.bytes_count();
            let mut buf = vec![0u8; n];
            e.bytes(n, buf.as_mut_ptr());
            body.extend_from_slice(&buf);
        }
    }
    Request {
        method,
        path,
        range: header("Range"),
        origin: header("Origin"),
        body,
    }
}

fn file_response(root: &std::path::Path, rel: &str, req: &Request, inject: bool) -> Resp {
    if !is_plain_relative(rel) {
        return Resp::not_found();
    }
    let file = root.join(rel);
    let Ok(mut f) = File::open(&file) else {
        return Resp::not_found();
    };
    let Ok(meta) = f.metadata() else {
        return Resp::not_found();
    };
    if !meta.is_file() {
        return Resp::not_found();
    }
    let (source, size) = if inject {
        let mut raw = Vec::new();
        let _ = f.read_to_end(&mut raw);
        let body = inject_index(&raw);
        let n = body.len() as u64;
        (Source::Mem(body), n)
    } else {
        (Source::File(f), meta.len())
    };
    let mut r = Resp {
        source,
        mime: mime_of(rel),
        end: size,
        length: size as i64,
        ..Resp::empty()
    };
    r.headers.push(("Accept-Ranges", "bytes".into()));
    r.headers.push(("Cache-Control", "no-cache".into()));
    if req.method == "HEAD" {
        r.end = 0;
    }
    let Some(range) = &req.range else { return r };
    match parse_range(range, size) {
        ParsedRange::None => {}
        ParsedRange::Unsatisfiable => {
            r.status = 416;
            r.status_text = "Range Not Satisfiable";
            r.headers.push(("Content-Range", format!("bytes */{size}")));
            r.pos = 0;
            r.end = 0;
            r.length = 0;
        }
        ParsedRange::Range(a, b) => {
            r.status = 206;
            r.status_text = "Partial Content";
            r.headers
                .push(("Content-Range", format!("bytes {a}-{b}/{size}")));
            r.pos = a;
            r.end = b + 1;
            r.length = (b + 1 - a) as i64;
            log(
                "scheme.range",
                json!({ "path": req.path, "range": range, "status": 206 }),
            );
        }
    }
    r
}

type Shared = Arc<Mutex<Resp>>;

/// Routes one request. `done` is the callback of an answer that is not ready (invoke).
fn route(
    req: Request,
    wc_id: Option<u64>,
    frame_url: String,
    shared: &Shared,
    callback: Option<AnyThread<Callback>>,
) -> Resp {
    let p = paths();
    let same_origin = req.origin.as_deref().is_none_or(|o| o == "app://ompdesk");
    if let Some(rel) = req.path.strip_prefix("/__ipc/") {
        if !same_origin {
            return Resp::refused("cross-origin");
        }
        let Some(wc_id) = wc_id else {
            return Resp::refused("no page");
        };
        let call: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
        let params = json!({
            "wcId": wc_id, "frameUrl": frame_url,
            "channel": call.get("channel").cloned().unwrap_or(Value::Null),
            "args": call.get("args").cloned().unwrap_or_else(|| json!([])),
        });
        return match (req.method.as_str(), rel) {
            ("POST", "invoke") => {
                let Some(callback) = callback else {
                    return Resp::refused("no callback");
                };
                let shared = shared.clone();
                host::request("ipc.invoke", params, None, move |result, _| {
                    let body = ipc::invoke_body(result);
                    {
                        let mut r = shared.lock().unwrap();
                        let n = body.len() as u64;
                        *r = Resp {
                            source: Source::Mem(body),
                            mime: "application/json",
                            end: n,
                            length: n as i64,
                            ..Resp::empty()
                        };
                        r.headers.push(("Cache-Control", "no-store".into()));
                        r.waiting = false;
                    }
                    callback.0.cont();
                });
                let mut r = Resp::empty();
                r.waiting = true;
                r
            }
            ("POST", "send") => {
                host::event("ipc.send", params);
                Resp::no_content()
            }
            ("GET", "events") => {
                let mut r = Resp::empty();
                r.source = Source::Events(wc_id);
                r.mime = "application/x-ndjson";
                r.length = -1;
                r.end = u64::MAX;
                r.headers.push(("Cache-Control", "no-store".into()));
                r
            }
            _ => Resp::not_found(),
        };
    }
    if let Some(rel) = req.path.strip_prefix("/__shell/") {
        if !same_origin {
            return Resp::refused("cross-origin");
        }
        return match (req.method.as_str(), rel) {
            ("GET" | "HEAD", "preload.js") => {
                let rel = p
                    .preload_file
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let dir = p
                    .preload_file
                    .parent()
                    .map(|d| d.to_path_buf())
                    .unwrap_or_default();
                file_response(&dir, &rel, &req, false)
            }
            ("GET", "local-storage") => {
                let file = p.web_dir.join(IMPORT_FILE);
                match std::fs::read(&file) {
                    Ok(bytes) if !p.web_dir.join(DONE_FILE).exists() => {
                        let mut r = Resp::mem(200, "OK", "application/json", bytes);
                        r.headers.push(("X-Ompdesk-Import", "pending".into()));
                        r
                    }
                    _ => Resp::json(&json!({})),
                }
            }
            ("POST", "local-storage-done") => {
                let _ = std::fs::write(p.web_dir.join(DONE_FILE), "");
                let _ = std::fs::remove_file(p.web_dir.join(IMPORT_FILE));
                log("migrate.localStorage.applied", json!({}));
                Resp::no_content()
            }
            // A link to a `file:` URL never reaches the browser process (Blink refuses it for a non-local origin), so the
            // page's click handler reports it here and Node's `will-navigate` listeners decide, as for Electron's page.
            ("POST", "will-navigate") => {
                let call: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
                if let (Some(wc_id), Some(url)) = (wc_id, call.get("url").and_then(Value::as_str)) {
                    host::request(
                        "wc.navigate",
                        json!({ "wcId": wc_id, "kind": "will-navigate", "url": url, "isMainFrame": true, "isSameDocument": false, "isRedirect": false }),
                        None,
                        |_, _| {},
                    );
                }
                Resp::no_content()
            }
            ("GET", "drag-files") => {
                let list: Vec<Value> = wc::DROPPED
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(name, path)| json!({ "name": name, "path": path }))
                    .collect();
                Resp::json(&json!(list))
            }
            _ => Resp::not_found(),
        };
    }
    if req.method != "GET" && req.method != "HEAD" {
        return Resp::mem(
            405,
            "Method Not Allowed",
            "text/plain",
            b"method not allowed".to_vec(),
        );
    }
    let rel = req.path.trim_start_matches('/').to_string();
    let inject = rel == "index.html";
    file_response(&p.renderer_dir, &rel, &req, inject)
}

wrap_resource_handler! {
    struct ShellResource {
        shared: Shared,
        wc_id: Option<u64>,
        frame_url: String,
        stop: Arc<Mutex<bool>>,
    }
    impl ResourceHandler {
        fn open(&self, request: Option<&mut cef::Request>, handle_request: Option<&mut i32>, callback: Option<&mut Callback>) -> i32 {
            let Some(request) = request else { return 0 };
            let req = read_request(request);
            let resp = route(req, self.wc_id, self.frame_url.clone(), &self.shared, callback.cloned().map(AnyThread));
            let waiting = resp.waiting;
            *self.shared.lock().unwrap() = resp;
            if let Some(h) = handle_request {
                *h = i32::from(!waiting);
            }
            1
        }

        /// CEF calls this for a `Range` whose first byte is > 0 and fails the request when it answers "unsupported",
        /// even though `open` already positioned the response at that byte (206). Claim the skip, discard nothing.
        fn skip(&self, bytes_to_skip: i64, bytes_skipped: Option<&mut i64>, _callback: Option<&mut ResourceSkipCallback>) -> i32 {
            if let Some(b) = bytes_skipped {
                *b = bytes_to_skip;
            }
            1
        }

        fn response_headers(&self, response: Option<&mut Response>, response_length: Option<&mut i64>, _redirect_url: Option<&mut CefString>) {
            let r = self.shared.lock().unwrap();
            if let Some(resp) = response {
                resp.set_status(r.status);
                resp.set_status_text(Some(&CefString::from(r.status_text)));
                if !r.mime.is_empty() {
                    resp.set_mime_type(Some(&CefString::from(r.mime)));
                }
                for (k, v) in &r.headers {
                    resp.set_header_by_name(Some(&CefString::from(*k)), Some(&CefString::from(v.as_str())), 1);
                }
            }
            if let Some(l) = response_length {
                *l = r.length;
            }
        }

        fn read(&self, data_out: *mut u8, bytes_to_read: i32, bytes_read: Option<&mut i32>, callback: Option<&mut ResourceReadCallback>) -> i32 {
            let mut r = self.shared.lock().unwrap();
            let want = bytes_to_read.max(0) as usize;
            if let Source::Events(wc_id) = r.source {
                drop(r);
                // SAFETY: CEF gives a buffer of `bytes_to_read` bytes, valid until the read completes.
                let out = unsafe { std::slice::from_raw_parts_mut(data_out, want) };
                let Some(callback) = callback.cloned().map(AnyThread) else { return 0 };
                let (buffer, stop) = (data_out as usize, self.stop.clone());
                let waker = Box::new(move || {
                    // Held across the write and `cont`: `cancel` cannot slip in between and free the buffer.
                    let cancelled = stop.lock().unwrap();
                    if *cancelled {
                        return;
                    }
                    // SAFETY: the same buffer, still ours until `cont` is called below; `stop` is set (under CEF's
                    // `cancel`) before the buffer is reused, and checked first.
                    let out = unsafe { std::slice::from_raw_parts_mut(buffer as *mut u8, want) };
                    let n = ipc::pull(wc_id, out);
                    callback.0.cont(n as i32);
                    drop(cancelled);
                });
                return match ipc::read_or_park(wc_id, out, waker) {
                    Some(n) => {
                        if let Some(b) = bytes_read {
                            *b = n as i32;
                        }
                        1
                    }
                    None => {
                        if let Some(b) = bytes_read {
                            *b = 0;
                        }
                        1
                    }
                };
            }
            let remaining = r.end.saturating_sub(r.pos).min(want as u64) as usize;
            // SAFETY: CEF gives a buffer of `bytes_to_read` bytes; `remaining` never exceeds it.
            let out = unsafe { std::slice::from_raw_parts_mut(data_out, remaining) };
            let pos = r.pos;
            let n = match &mut r.source {
                Source::Mem(v) => {
                    out.copy_from_slice(&v[pos as usize..pos as usize + remaining]);
                    remaining
                }
                Source::File(f) => {
                    let _ = f.seek(SeekFrom::Start(pos));
                    f.read(out).unwrap_or(0)
                }
                Source::Empty | Source::Events(_) => 0,
            };
            r.pos += n as u64;
            if let Some(b) = bytes_read {
                *b = n as i32;
            }
            i32::from(n > 0)
        }

        fn cancel(&self) {
            *self.stop.lock().unwrap() = true;
            let r = self.shared.lock().unwrap();
            if let Source::Events(wc_id) = r.source {
                ipc::reader_gone(wc_id);
            }
        }
    }
}

wrap_scheme_handler_factory! {
    pub struct AppSchemeFactory;
    impl SchemeHandlerFactory {
        fn create(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            _request: Option<&mut cef::Request>,
        ) -> Option<ResourceHandler> {
            let wc_id = browser.and_then(|b| crate::state::wc_of_browser(b.identifier()));
            let frame_url = frame.map(|f| CefString::from(&f.url()).to_string()).unwrap_or_default();
            Some(ShellResource::new(Arc::new(Mutex::new(Resp::empty())), wc_id, frame_url, Arc::new(Mutex::new(false))))
        }
    }
}

/// Registers `app://ompdesk/` on the global request context.
pub fn register() {
    let mut factory = AppSchemeFactory::new();
    register_scheme_handler_factory(
        Some(&CefString::from("app")),
        Some(&CefString::from("ompdesk")),
        Some(&mut factory),
    );
}
