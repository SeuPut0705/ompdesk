//! preview-host process (candidate c) and the tiny loopback HTTP server that serves the same files to it.
use crate::scheme::{Cfg, serve};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct Host {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
}

impl Host {
    pub fn spawn(
        exe: &Path,
        url: &str,
        cdp_port: u16,
        mode: Mode,
        host_log: &Path,
        on_loaded: impl Fn(String, u64) + Send + 'static,
    ) -> Result<Host, String> {
        let mut cmd = Command::new(exe);
        cmd.current_dir(exe.parent().unwrap_or(Path::new(".")));
        cmd.args(["--url", url, "--cdp-port", &cdp_port.to_string()]);
        match mode {
            Mode::Child { hwnd, bounds: (x, y, w, h) } => {
                cmd.args(["--parent-hwnd", &hwnd.to_string(), "--bounds", &format!("{x},{y},{w},{h}")]);
            }
            Mode::Offscreen { w, h } => {
                cmd.args(["--offscreen", "--size", &format!("{w},{h}")]);
            }
        }
        cmd.arg("--log").arg(host_log);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("spawn {}: {e}", exe.display()))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let t0 = Instant::now();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let v: Value = serde_json::from_str(&line).unwrap_or_else(|_| json!({"raw": line}));
                crate::log("preview.host", v.clone());
                if v["event"] == "loaded" {
                    on_loaded(v["url"].as_str().unwrap_or("").to_string(), t0.elapsed().as_millis() as u64);
                }
            }
        });
        Ok(Host { child: Mutex::new(child), stdin: Mutex::new(stdin) })
    }

    pub fn pid(&self) -> u32 {
        self.child.lock().unwrap().id()
    }

    pub fn send(&self, line: &str) {
        if let Some(s) = self.stdin.lock().unwrap().as_mut() {
            let _ = writeln!(s, "{line}");
            let _ = s.flush();
        }
    }

    pub fn shutdown(&self) {
        self.send("quit");
        drop(self.stdin.lock().unwrap().take());
        let mut c = self.child.lock().unwrap();
        let end = Instant::now() + Duration::from_secs(3);
        while Instant::now() < end {
            if matches!(c.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = c.kill();
    }
}

pub enum Mode {
    Child { hwnd: isize, bounds: (i32, i32, i32, i32) },
    Offscreen { w: u32, h: u32 },
}

/// Serves the renderer and assets on 127.0.0.1 (the Preview process cannot see the `app` scheme).
pub fn http_server(cfg: Arc<Cfg>) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let cfg = cfg.clone();
            std::thread::spawn(move || conn(&cfg, s));
        }
    });
    port
}

fn conn(cfg: &Cfg, mut s: TcpStream) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        let Ok(n) = s.read(&mut tmp) else { return };
        if n == 0 {
            return;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or("GET"), first.next().unwrap_or("/"));
    let mut range = None;
    let mut clen = 0usize;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "range" => range = Some(v.trim().to_string()),
                "content-length" => clen = v.trim().parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < clen {
        let Ok(n) = s.read(&mut tmp) else { break };
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    let r = serve(cfg, method, target, range.as_deref(), &body);
    let mut out = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", r.status, r.body.len());
    for (k, v) in &r.headers {
        out += &format!("{k}: {v}\r\n");
    }
    out += "\r\n";
    let _ = s.write_all(out.as_bytes());
    let _ = s.write_all(&r.body);
}
