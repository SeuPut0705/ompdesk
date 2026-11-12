//! `app://ompdesk/` : renderer files, `/__shell/*` assets, range requests, index injection, report/window endpoints.
use crate::{cfg, log, window_action};
use cef::*;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    rc::Rc,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};

/// Where a response body comes from: memory (small / generated) or a file read lazily (video).
#[derive(Default)]
enum Source {
    #[default]
    Empty,
    Mem(Vec<u8>),
    File(File),
}

#[derive(Default)]
struct Resp {
    status: i32,
    status_text: &'static str,
    mime: &'static str,
    headers: Vec<(&'static str, String)>,
    source: Source,
    /// Offset of the next byte to hand out, and one past the last byte of this response (offsets into the source).
    pos: u64,
    end: u64,
    /// Bytes the response advertises as its length (`end - first`).
    length: u64,
}

impl Resp {
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
            length: n,
        }
    }
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "webmanifest" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "wasm" => "application/wasm",
        "ico" => "image/x-icon",
        "txt" => "text/plain",
        "br" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn simple(status: i32, text: &'static str, body: &str) -> Resp {
    Resp::mem(status, text, "text/plain", body.as_bytes().to_vec())
}

#[cfg(windows)]
const PLATFORM: &str = "win32";
#[cfg(not(windows))]
const PLATFORM: &str = "darwin";

/// Windows has no CSS `env(titlebar-area-*)` outside Electron; macOS keeps the page's own --sc-traffic-lights.
#[cfg(windows)]
const CAPTION_STYLE: &str = "<style>html[data-platform='win32']:root{--sc-caption-buttons:138px;--sc-caption-band:48px}</style>";
#[cfg(not(windows))]
const CAPTION_STYLE: &str = "";

fn inject_index(html: &[u8]) -> Vec<u8> {
    let s = String::from_utf8_lossy(html).into_owned();
    let mut s = s;
    if let Some(i) = s.find("<head") {
        if let Some(j) = s[i..].find('>') {
            s.insert_str(
                i + j + 1,
                &format!("<script src=\"/__shell/stand-in.js\"></script>{CAPTION_STYLE}"),
            );
        }
    }
    if !s.contains("data-platform") {
        if let Some(i) = s.find("<html") {
            s.insert_str(i + 5, &format!(" data-platform=\"{PLATFORM}\""));
        }
    }
    s.into_bytes()
}

enum ParsedRange {
    None,
    Unsatisfiable,
    Range(u64, u64),
}

/// `bytes=a-b` / `a-` / `-n` against `size`.
fn parse_range(h: &str, size: u64) -> ParsedRange {
    let Some(spec) = h.trim().strip_prefix("bytes=") else { return ParsedRange::None };
    let spec = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = spec.split_once('-') else { return ParsedRange::None };
    let (a, b) = (a.trim(), b.trim());
    if size == 0 {
        return ParsedRange::Unsatisfiable;
    }
    if a.is_empty() {
        return match b.parse::<u64>() {
            Ok(n) if n > 0 => {
                let n = n.min(size);
                ParsedRange::Range(size - n, size - 1)
            }
            Ok(_) => ParsedRange::Unsatisfiable,
            Err(_) => ParsedRange::None,
        };
    }
    let Ok(start) = a.parse::<u64>() else { return ParsedRange::None };
    let end = if b.is_empty() {
        size - 1
    } else {
        match b.parse::<u64>() {
            Ok(e) => e.min(size - 1),
            Err(_) => return ParsedRange::None,
        }
    };
    if start >= size || start > end {
        return ParsedRange::Unsatisfiable;
    }
    ParsedRange::Range(start, end)
}

fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(root.join(p))
}

fn handle(method: &str, url: &str, range: Option<String>, body: Vec<u8>) -> Resp {
    let c = cfg();
    let after = url.strip_prefix("app://ompdesk").unwrap_or(url);
    let path_q = after.split('#').next().unwrap_or("");
    let path = pct_decode(path_q.split('?').next().unwrap_or(""));
    let path = if path.is_empty() || path == "/" { "/index.html".to_string() } else { path };

    if let Some(rel) = path.strip_prefix("/__shell/") {
        match (method, rel) {
            ("POST", "report") => {
                let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                match v {
                    Value::Object(_) => log("page.report", v),
                    Value::Null => log("page.report", json!({ "raw": String::from_utf8_lossy(&body) })),
                    other => log("page.report", json!({ "body": other })),
                }
                return Resp::mem(204, "No Content", "", Vec::new());
            }
            ("POST", "window") => {
                let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                if let Some(a) = v.get("action").and_then(|a| a.as_str()) {
                    log("window.action", json!({ "action": a }));
                    window_action(a);
                }
                return Resp::mem(204, "No Content", "", Vec::new());
            }
            ("GET" | "HEAD", "local-storage.json") => {
                return match std::fs::read(c.web_dir.join("local-storage-import.json")) {
                    Ok(b) => Resp::mem(200, "OK", "application/json", b),
                    Err(_) => simple(404, "Not Found", "not found"),
                };
            }
            _ => {}
        }
    }
    if method != "GET" && method != "HEAD" {
        return simple(405, "Method Not Allowed", "method not allowed");
    }

    let (root, rel) = match path.strip_prefix("/__shell/") {
        Some(r) => (&c.assets, r.to_string()),
        None => (&c.renderer, path.trim_start_matches('/').to_string()),
    };
    let Some(file) = safe_join(root, &rel) else { return simple(404, "Not Found", "not found") };
    let mime = mime_of(&rel);
    let Ok(mut f) = File::open(&file) else { return simple(404, "Not Found", "not found") };
    let Ok(meta) = f.metadata() else { return simple(404, "Not Found", "not found") };
    if !meta.is_file() {
        return simple(404, "Not Found", "not found");
    }
    let is_index = rel == "index.html";
    let (source, size) = if is_index {
        let mut raw = Vec::new();
        let _ = f.read_to_end(&mut raw);
        let inj = inject_index(&raw);
        let n = inj.len() as u64;
        (Source::Mem(inj), n)
    } else {
        (Source::File(f), meta.len())
    };

    let mut r = Resp { status: 200, status_text: "OK", mime, source, pos: 0, end: size, length: size, ..Default::default() };
    r.headers.push(("Accept-Ranges", "bytes".into()));
    r.headers.push(("Cache-Control", "no-cache".into()));
    if method == "HEAD" {
        r.end = 0;
    }
    let Some(h) = range else { return r };
    // Every range is answered here as a 206 with exactly the requested bytes (see `skip` for CEF's own Range handling).
    let status = match parse_range(&h, size) {
        ParsedRange::None => r.status,
        ParsedRange::Unsatisfiable => {
            r.status = 416;
            r.status_text = "Range Not Satisfiable";
            r.headers.push(("Content-Range", format!("bytes */{size}")));
            r.pos = 0;
            r.end = 0;
            r.length = 0;
            416
        }
        ParsedRange::Range(a, b) => {
            r.status = 206;
            r.status_text = "Partial Content";
            r.headers.push(("Content-Range", format!("bytes {a}-{b}/{size}")));
            r.pos = a;
            r.end = b + 1;
            r.length = b + 1 - a;
            206
        }
    };
    log("scheme.range", json!({ "path": path, "range": h, "status": status }));
    r
}

wrap_resource_handler! {
    struct ShellResource {
        resp: Rc<RefCell<Resp>>,
    }
    impl ResourceHandler {
        fn open(
            &self,
            request: Option<&mut Request>,
            handle_request: Option<&mut i32>,
            _callback: Option<&mut Callback>,
        ) -> i32 {
            if let Some(h) = handle_request {
                *h = 1;
            }
            let Some(req) = request else { return 0 };
            let url = CefString::from(&req.url()).to_string();
            let method = CefString::from(&req.method()).to_string();
            let range = CefString::from(&req.header_by_name(Some(&CefString::from("Range")))).to_string();
            let range = if range.is_empty() { None } else { Some(range) };
            let mut body = Vec::new();
            if let Some(pd) = req.post_data() {
                let mut els: Vec<Option<PostDataElement>> = (0..pd.element_count()).map(|_| None).collect();
                pd.elements(Some(&mut els));
                for e in els.into_iter().flatten() {
                    let n = e.bytes_count();
                    let mut buf = vec![0u8; n];
                    e.bytes(n, buf.as_mut_ptr());
                    body.extend_from_slice(&buf);
                }
            }
            *self.resp.borrow_mut() = handle(&method, &url, range, body);
            1
        }

        /// CEF calls this for a `Range` whose first byte is > 0 and fails the request when it answers "unsupported", even
        /// though `open` already positioned the response at that byte (206). Claim the skip, discard nothing.
        fn skip(
            &self,
            bytes_to_skip: i64,
            bytes_skipped: Option<&mut i64>,
            _callback: Option<&mut ResourceSkipCallback>,
        ) -> i32 {
            if let Some(b) = bytes_skipped {
                *b = bytes_to_skip;
            }
            1
        }

        fn response_headers(
            &self,
            response: Option<&mut Response>,
            response_length: Option<&mut i64>,
            _redirect_url: Option<&mut CefString>,
        ) {
            let r = self.resp.borrow();
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
                *l = r.length as i64;
            }
        }

        fn read(
            &self,
            data_out: *mut u8,
            bytes_to_read: i32,
            bytes_read: Option<&mut i32>,
            _callback: Option<&mut ResourceReadCallback>,
        ) -> i32 {
            let mut r = self.resp.borrow_mut();
            let want = (bytes_to_read.max(0) as u64).min(r.end.saturating_sub(r.pos)) as usize;
            let pos = r.pos;
            let out = unsafe { std::slice::from_raw_parts_mut(data_out, want) };
            let n = match &mut r.source {
                Source::Empty => 0,
                Source::Mem(v) => {
                    out.copy_from_slice(&v[pos as usize..pos as usize + want]);
                    want
                }
                Source::File(f) => {
                    let _ = f.seek(SeekFrom::Start(pos));
                    f.read(out).unwrap_or(0)
                }
            };
            r.pos += n as u64;
            if let Some(b) = bytes_read {
                *b = n as i32;
            }
            (n > 0) as i32
        }

        fn cancel(&self) {}
    }
}

wrap_scheme_handler_factory! {
    pub struct ShellSchemeFactory;
    impl SchemeHandlerFactory {
        fn create(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            _request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            Some(ShellResource::new(Rc::new(RefCell::new(Resp::default()))))
        }
    }
}
