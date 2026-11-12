use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket, stream::MaybeTlsStream};

pub trait Cdp {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String>;
}

pub struct WsCdp {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    next: u64,
    pub events: VecDeque<Value>,
}

impl WsCdp {
    pub fn connect(url: &str) -> Result<Self, String> {
        let (ws, _) = tungstenite::connect(url).map_err(|e| format!("ws connect {url}: {e}"))?;
        Ok(Self { ws, next: 1, events: VecDeque::new() })
    }

    pub fn send(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next;
        self.next += 1;
        let msg = json!({"id": id, "method": method, "params": params}).to_string();
        self.ws.send(Message::text(msg)).map_err(|e| e.to_string())?;
        Ok(id)
    }

    /// Next raw message (response or event) within `timeout`.
    pub fn recv(&mut self, timeout: Duration) -> Result<Option<Value>, String> {
        if let MaybeTlsStream::Plain(s) = self.ws.get_mut() {
            let _ = s.set_read_timeout(Some(timeout.max(Duration::from_millis(1))));
        }
        match self.ws.read() {
            Ok(Message::Text(t)) => Ok(serde_json::from_str(t.as_str()).ok()),
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
            {
                Ok(None)
            }
            Err(e) => Err(e.to_string()),
        }
    }

    /// Next queued or incoming event.
    pub fn next_event(&mut self, timeout: Duration) -> Result<Option<Value>, String> {
        if let Some(e) = self.events.pop_front() {
            return Ok(Some(e));
        }
        match self.recv(timeout)? {
            Some(v) if v.get("method").is_some() => Ok(Some(v)),
            _ => Ok(None),
        }
    }
}

impl Cdp for WsCdp {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.send(method, params)?;
        let end = Instant::now() + Duration::from_secs(20);
        while Instant::now() < end {
            if let Some(v) = self.recv(Duration::from_millis(200))? {
                if v.get("id").and_then(Value::as_u64) == Some(id) {
                    if let Some(e) = v.get("error") {
                        return Err(format!("{method}: {e}"));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                } else if v.get("method").is_some() {
                    self.events.push_back(v);
                }
            }
        }
        Err(format!("{method}: timeout"))
    }
}

pub fn http_get(port: u16, path: &str) -> Result<String, String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok();
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        let n = s.read(&mut tmp).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
            let clen = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok());
            if clen.is_some_and(|c| buf.len() >= i + 4 + c) {
                break;
            }
        }
    }
    match buf.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(i) => Ok(String::from_utf8_lossy(&buf[i + 4..]).to_string()),
        None => Err("no http body".into()),
    }
}

pub fn targets(port: u16) -> Result<Vec<Value>, String> {
    let body = http_get(port, "/json/list")?;
    match serde_json::from_str::<Value>(&body) {
        Ok(Value::Array(a)) => Ok(a),
        _ => Err(format!("bad /json/list: {}", body.chars().take(120).collect::<String>())),
    }
}

/// WebSocket URL of the first page target (optionally whose url contains `filter`), polled up to `wait`.
pub fn page_ws_url(port: u16, filter: Option<&str>, wait: Duration) -> Result<String, String> {
    let end = Instant::now() + wait;
    loop {
        if let Ok(ts) = targets(port) {
            for t in ts {
                let ty = t.get("type").and_then(Value::as_str).unwrap_or("");
                let url = t.get("url").and_then(Value::as_str).unwrap_or("");
                if ty == "page" && !url.starts_with("devtools://") && filter.is_none_or(|f| url.contains(f)) {
                    if let Some(w) = t.get("webSocketDebuggerUrl").and_then(Value::as_str) {
                        return Ok(w.to_string());
                    }
                }
            }
        }
        if Instant::now() > end {
            return Err(format!("no page target on port {port}"));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}
