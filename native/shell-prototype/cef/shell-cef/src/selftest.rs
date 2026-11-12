//! Host-side CDP against the Preview browser (`SendDevToolsMessage`) and the contract's selftest.* events.
use crate::{cfg, log, post_ui_delayed, ui};
use base64::Engine;
use cef::*;
use serde_json::{Value, json};
use std::{io::{Read, Write}, net::TcpStream, time::{Duration, Instant}};

wrap_dev_tools_message_observer! {
    struct CdpObserver;
    impl DevToolsMessageObserver {
        fn on_dev_tools_message(&self, _browser: Option<&mut Browser>, message: Option<&[u8]>) -> i32 {
            let Some(m) = message else { return 0 };
            let Ok(v) = serde_json::from_slice::<Value>(m) else { return 0 };
            if let Some(id) = v.get("id").and_then(|x| x.as_i64()) {
                let cb = ui(|u| u.pending.remove(&id));
                if let Some(cb) = cb {
                    cb(v);
                    return 1;
                }
            }
            0
        }
    }
}

pub fn attach_observer(browser: &Browser) {
    let Some(host) = browser.host() else { return };
    let mut obs = CdpObserver::new();
    let reg = host.add_dev_tools_message_observer(Some(&mut obs));
    ui(|u| {
        u.preview_browser = Some(browser.clone());
        u.reg = reg;
    });
}

fn cdp(method: &str, params: Value, cb: impl FnOnce(Value) + 'static) {
    let id = ui(|u| {
        u.next_id += 1;
        u.next_id
    });
    let msg = json!({ "id": id, "method": method, "params": params }).to_string();
    let host = ui(|u| u.preview_browser.as_ref().and_then(|b| b.host()));
    ui(|u| u.pending.insert(id, Box::new(cb)));
    match host {
        Some(h) => {
            if h.send_dev_tools_message(Some(msg.as_bytes())) == 0 {
                log("cdp.send_failed", json!({ "method": method }));
            }
        }
        None => log("cdp.no_host", json!({ "method": method })),
    }
}

fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

fn eval_value(v: &Value) -> Value {
    v["result"]["result"]["value"].clone()
}

pub fn maybe_start() {
    let c = cfg();
    if !c.selftest {
        return;
    }
    let go = ui(|u| {
        if u.selftest_started || !u.page_loaded || (c.preview.is_some() && !u.preview_loaded) {
            return false;
        }
        u.selftest_started = true;
        true
    });
    if !go {
        return;
    }
    if c.preview.is_none() {
        log("selftest.skipped", json!({ "reason": "no --preview" }));
        return;
    }
    // give the Preview a beat to paint and attach its DevTools agent
    post_ui_delayed(500, step_evaluate);
}

fn step_evaluate() {
    let t = Instant::now();
    cdp("Runtime.evaluate", json!({ "expression": "document.title", "returnByValue": true }), move |v| {
        let title = eval_value(&v).as_str().unwrap_or("").to_string();
        log("selftest.cdp_evaluate", json!({ "ok": !title.is_empty(), "title": title, "ms": ms(t) }));
        step_capture();
    });
}

fn out_path(name: &str) -> std::path::PathBuf {
    cfg().web_dir.join(name)
}

fn step_capture() {
    let t = Instant::now();
    cdp("Page.captureScreenshot", json!({ "format": "png" }), move |v| {
        let data = v["result"]["data"].as_str().unwrap_or("");
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_default();
        let path = out_path("preview-capture.png");
        let _ = std::fs::write(&path, &bytes);
        let ok = bytes.starts_with(&[0x89, b'P', b'N', b'G']);
        log(
            "selftest.capture",
            json!({ "ok": ok, "bytes": bytes.len(), "path": path.display().to_string(), "ms": ms(t) }),
        );
        step_input();
    });
}

fn mouse_ev(kind: &str, x: f64, y: f64) -> Value {
    json!({ "type": kind, "x": x, "y": y, "button": "left", "buttons": if kind == "mousePressed" { 1 } else { 0 }, "clickCount": 1 })
}

fn step_input() {
    let t = Instant::now();
    let expr = "(()=>{const r=document.querySelector('#target').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()";
    cdp("Runtime.evaluate", json!({ "expression": expr, "returnByValue": true }), move |v| {
        let pt: Value = eval_value(&v).as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null);
        let (x, y) = (pt["x"].as_f64().unwrap_or(-1.0), pt["y"].as_f64().unwrap_or(-1.0));
        if x < 0.0 {
            log("selftest.input", json!({ "ok": false, "error": "no #target", "ms": ms(t) }));
            step_pdf();
            return;
        }
        cdp("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y }), move |_| {
            cdp("Input.dispatchMouseEvent", mouse_ev("mousePressed", x, y), move |_| {
                cdp("Input.dispatchMouseEvent", mouse_ev("mouseReleased", x, y), move |_| {
                    post_ui_delayed(150, move || {
                        cdp("Runtime.evaluate", json!({ "expression": "window.__clicks", "returnByValue": true }), move |v| {
                            let clicks = eval_value(&v).as_i64().unwrap_or(-1);
                            log(
                                "selftest.input",
                                json!({ "ok": clicks == 1, "clicks": clicks, "x": x, "y": y, "ms": ms(t) }),
                            );
                            step_pdf();
                        });
                    });
                });
            });
        });
    });
}

fn step_pdf() {
    let t = Instant::now();
    cdp("Page.printToPDF", json!({}), move |v| {
        let data = v["result"]["data"].as_str().unwrap_or("");
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_default();
        let path = out_path("preview-print.pdf");
        let _ = std::fs::write(&path, &bytes);
        log(
            "selftest.pdf",
            json!({
                "ok": bytes.starts_with(b"%PDF"),
                "bytes": bytes.len(),
                "path": path.display().to_string(),
                "error": v.get("error").cloned().unwrap_or(Value::Null),
                "ms": ms(t),
            }),
        );
        step_external();
    });
}

fn http_get(port: u16, path: &str) -> Result<String, String> {
    let mut s = TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
    // the DevTools server keeps the connection open: read headers, then exactly Content-Length bytes
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = s.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
            let len: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse().ok()))
                .unwrap_or(0);
            if buf.len() >= i + 4 + len {
                return Ok(String::from_utf8_lossy(&buf[i + 4..i + 4 + len]).into_owned());
            }
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok(text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or(text))
}

fn step_external() {
    let t = Instant::now();
    let Some(port) = cfg().debug_port else {
        log("selftest.cdp_external", json!({ "ok": false, "error": "no --debug-port", "ms": ms(t) }));
        done();
        return;
    };
    // The DevTools HTTP handler answers via the UI thread: never block it, ask from a thread.
    std::thread::spawn(move || {
        let list = http_get(port, "/json/list");
        let version = http_get(port, "/json/version");
        match list {
            Ok(body) => {
                let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let targets: Vec<Value> = v
                    .as_array()
                    .map(|a| a.iter().map(|x| json!({ "type": x["type"], "url": x["url"], "title": x["title"] })).collect())
                    .unwrap_or_default();
                let preview = cfg().preview.clone().unwrap_or_default();
                let has_preview = targets.iter().any(|x| x["url"].as_str() == Some(preview.as_str()));
                let has_page = targets.iter().any(|x| x["url"].as_str().map(|u| u.starts_with("app://ompdesk/index.html")).unwrap_or(false));
                log(
                    "selftest.cdp_external",
                    json!({
                        "ok": has_preview && has_page,
                        "port": port,
                        "targets": targets,
                        "version": version.ok().and_then(|b| serde_json::from_str::<Value>(&b).ok()).map(|v| v["Browser"].clone()),
                        "ms": ms(t),
                    }),
                );
            }
            Err(e) => log("selftest.cdp_external", json!({ "ok": false, "port": port, "error": e, "ms": ms(t) })),
        }
        crate::post_ui(done);
    });
}

fn done() {
    log("selftest.done", json!({}));
}
