use serde_json::{Value, json};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub struct Cfg {
    pub renderer: PathBuf,
    pub assets: PathBuf,
    pub webview_dir: PathBuf,
    pub mode: String,
}

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn new(status: u16) -> Self {
        Reply { status, headers: vec![("Accept-Ranges".into(), "bytes".into())], body: vec![] }
    }
    pub fn header(mut self, k: &str, v: impl Into<String>) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
}

fn mime(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "wasm" => "application/wasm",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 0 && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// (start, end inclusive) for a Range header value against a file of `size` bytes.
fn parse_range(h: &str, size: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?;
    let spec = spec.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if size == 0 {
        return None;
    }
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((size.saturating_sub(n), size - 1));
    }
    let start: u64 = a.parse().ok()?;
    let end: u64 = if b.is_empty() { size - 1 } else { b.parse::<u64>().ok()?.min(size - 1) };
    if start > end || start >= size {
        return None;
    }
    Some((start, end))
}

const UI_JS: &str = include_str!("shell-ui.js");

fn inject_index(cfg: &Cfg, html: String) -> Vec<u8> {
    let tags = "<script src=\"/__shell/stand-in.js\"></script><script src=\"/__shell/shell-ui.js\"></script>";
    let mut h = if let Some(i) = html.find("<head>") {
        format!("{}<head>{}{}", &html[..i], tags, &html[i + 6..])
    } else {
        format!("{tags}{html}")
    };
    let _ = cfg;
    if !h.contains("data-platform") {
        if let Some(i) = h.find("<html") {
            h.insert_str(i + 5, " data-platform=\"win32\"");
        }
    }
    h.into_bytes()
}

pub fn serve(cfg: &Cfg, method: &str, target: &str, range: Option<&str>, body: &[u8]) -> Reply {
    let (path, _query) = target.split_once('?').unwrap_or((target, ""));
    let path = pct_decode(path);
    if path.contains("..") {
        return Reply::new(400);
    }
    if path == "/__shell/report" && method == "POST" {
        let mut f = match serde_json::from_slice::<Value>(body) {
            Ok(Value::Object(m)) => Value::Object(m),
            Ok(v) => json!({ "body": v }),
            Err(_) => json!({ "raw": String::from_utf8_lossy(body) }),
        };
        crate::log("page.report", std::mem::take(&mut f));
        return Reply::new(204);
    }
    if path == "/__shell/shell-ui.js" {
        let js = format!("window.__SHELL={{mode:{:?},platform:\"win32\"}};\n{UI_JS}", cfg.mode);
        let mut r = Reply::new(200).header("Content-Type", "text/javascript; charset=utf-8");
        r.body = js.into_bytes();
        return r;
    }
    let (file, is_index): (PathBuf, bool) = if path == "/__shell/local-storage.json" {
        (cfg.webview_dir.join("local-storage-import.json"), false)
    } else if let Some(rest) = path.strip_prefix("/__shell/") {
        (cfg.assets.join(rest), false)
    } else {
        let rel = path.trim_start_matches('/');
        let rel = if rel.is_empty() { "index.html" } else { rel };
        (cfg.renderer.join(rel), rel == "index.html")
    };
    let Ok(mut f) = File::open(&file) else { return Reply::new(404) };
    let Ok(meta) = f.metadata() else { return Reply::new(404) };
    if !meta.is_file() {
        return Reply::new(404);
    }
    let size = meta.len();
    let ct = mime(&file);
    if is_index {
        let mut s = String::new();
        let _ = f.read_to_string(&mut s);
        let mut r = Reply::new(200).header("Content-Type", ct).header("Cache-Control", "no-store");
        r.body = inject_index(cfg, s);
        return r;
    }
    if let Some(rh) = range {
        match parse_range(rh, size) {
            Some((a, b)) => {
                let len = (b - a + 1) as usize;
                let mut buf = vec![0u8; len];
                let _ = f.seek(SeekFrom::Start(a));
                let _ = f.read_exact(&mut buf);
                crate::log("scheme.range", json!({"path": path, "range": rh, "status": 206}));
                let mut r = Reply::new(206)
                    .header("Content-Type", ct)
                    .header("Content-Range", format!("bytes {a}-{b}/{size}"));
                if method != "HEAD" {
                    r.body = buf;
                }
                return r;
            }
            None => {
                crate::log("scheme.range", json!({"path": path, "range": rh, "status": 416}));
                return Reply::new(416).header("Content-Range", format!("bytes */{size}"));
            }
        }
    }
    let mut buf = Vec::with_capacity(size as usize);
    let _ = f.read_to_end(&mut buf);
    let mut r = Reply::new(200).header("Content-Type", ct);
    r.body = buf;
    r
}
