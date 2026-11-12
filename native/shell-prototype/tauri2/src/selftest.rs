use crate::cdp::{Cdp, WsCdp};
use crate::log;
use base64::Engine;
use serde_json::{Value, json};
use std::path::Path;
use std::time::{Duration, Instant};

fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

fn eval(cdp: &mut dyn Cdp, expr: &str) -> Result<Value, String> {
    let r = cdp.call("Runtime.evaluate", json!({"expression": expr, "returnByValue": true}))?;
    if let Some(ex) = r.get("exceptionDetails") {
        return Err(format!("exception: {ex}"));
    }
    Ok(r.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

fn b64(r: &Value) -> Result<Vec<u8>, String> {
    let d = r.get("data").and_then(Value::as_str).ok_or("no data")?;
    base64::engine::general_purpose::STANDARD.decode(d).map_err(|e| e.to_string())
}

fn target_centre(cdp: &mut dyn Cdp) -> Result<(f64, f64), String> {
    let v = eval(
        cdp,
        "(()=>{const r=document.querySelector('#target').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()",
    )?;
    let a = v.as_array().ok_or("no #target")?;
    Ok((a[0].as_f64().unwrap_or(0.0), a[1].as_f64().unwrap_or(0.0)))
}

fn click(cdp: &mut dyn Cdp, x: f64, y: f64) -> Result<(), String> {
    cdp.call("Input.dispatchMouseEvent", json!({"type":"mouseMoved","x":x,"y":y}))?;
    cdp.call("Input.dispatchMouseEvent", json!({"type":"mousePressed","x":x,"y":y,"button":"left","buttons":1,"clickCount":1}))?;
    cdp.call("Input.dispatchMouseEvent", json!({"type":"mouseReleased","x":x,"y":y,"button":"left","buttons":0,"clickCount":1}))?;
    Ok(())
}

fn done(name: &str, t: Instant, r: Result<Value, String>) {
    match r {
        Ok(mut f) => {
            if f.get("ms").is_none() {
                f["ms"] = json!(ms(t));
            }
            if f.get("ok").is_none() {
                f["ok"] = json!(true);
            }
            log(&format!("selftest.{name}"), f);
        }
        Err(e) => log(&format!("selftest.{name}"), json!({"ok": false, "ms": ms(t), "error": e})),
    }
}

/// Host-side tests against the Preview through any CDP transport.
pub fn run(cdp: &mut dyn Cdp, out_dir: &Path) {
    let t = Instant::now();
    done("cdp_evaluate", t, eval(cdp, "document.title").map(|v| json!({"ok": v.is_string(), "title": v})));

    let t = Instant::now();
    let r = cdp.call("Page.captureScreenshot", json!({"format": "png"})).and_then(|r| {
        let b = b64(&r)?;
        let p = out_dir.join("selftest-capture.png");
        std::fs::write(&p, &b).map_err(|e| e.to_string())?;
        Ok(json!({"ok": b.starts_with(b"\x89PNG"), "bytes": b.len(), "path": p.display().to_string()}))
    });
    done("capture", t, r);

    let t = Instant::now();
    let r = (|| {
        let before = eval(cdp, "window.__clicks||0")?;
        let (x, y) = target_centre(cdp)?;
        click(cdp, x, y)?;
        std::thread::sleep(Duration::from_millis(150));
        let clicks = eval(cdp, "window.__clicks||0")?;
        Ok(json!({"ok": clicks == json!(before.as_i64().unwrap_or(0) + 1), "clicks": clicks, "x": x, "y": y}))
    })();
    done("input", t, r);

    let t = Instant::now();
    let r = cdp.call("Page.printToPDF", json!({})).and_then(|r| {
        let b = b64(&r)?;
        let p = out_dir.join("selftest-preview.pdf");
        std::fs::write(&p, &b).map_err(|e| e.to_string())?;
        Ok(json!({"ok": b.starts_with(b"%PDF"), "bytes": b.len(), "path": p.display().to_string()}))
    });
    done("pdf", t, r);
}

/// An external client reads `/json/list` of `port` and finds a target whose url contains `filter`.
pub fn external(port: Option<u16>, filter: &str) {
    let t = Instant::now();
    let Some(port) = port else {
        return done("cdp_external", t, Err("no debug port".into()));
    };
    let r = crate::cdp::targets(port).map(|ts| {
        let urls: Vec<String> = ts
            .iter()
            .map(|x| format!("{} {}", x["type"].as_str().unwrap_or(""), x["url"].as_str().unwrap_or("")))
            .collect();
        let found = ts.iter().any(|x| x["url"].as_str().is_some_and(|u| u.contains(filter)));
        json!({"ok": found, "port": port, "targets": urls})
    });
    done("cdp_external", t, r);
}

fn colour(jpeg: &[u8]) -> Result<[i32; 3], String> {
    let mut d = jpeg_decoder::Decoder::new(jpeg);
    let px = d.decode().map_err(|e| e.to_string())?;
    let i = d.info().ok_or("no info")?;
    let (w, h) = (i.width as usize, i.height as usize);
    let n = match i.pixel_format {
        jpeg_decoder::PixelFormat::L8 => 1,
        jpeg_decoder::PixelFormat::RGB24 => 3,
        _ => return Err("pixel format".into()),
    };
    let o = ((h.saturating_sub(8)) * w + w.saturating_sub(8)) * n;
    Ok(if n == 1 { [px[o] as i32; 3] } else { [px[o] as i32, px[o + 1] as i32, px[o + 2] as i32] })
}

fn dist(a: [i32; 3], b: [i32; 3]) -> i32 {
    (0..3).map(|i| (a[i] - b[i]).abs()).sum()
}

/// Click `#target`, time until the first screencast frame whose corner colour differs from the one before the click.
pub fn stream_latency(ws_url: &str, mode: &str, runs: usize) {
    let t = Instant::now();
    let r = (|| -> Result<Value, String> {
        let mut c = WsCdp::connect(ws_url)?;
        c.call("Page.enable", json!({}))?;
        c.call("Page.startScreencast", json!({"format":"jpeg","quality":80,"everyNthFrame":1}))?;
        let (x, y) = target_centre(&mut c)?;
        let mut all = vec![];
        for _ in 0..runs {
            // quiet period: ack stale frames
            let end = Instant::now() + Duration::from_millis(400);
            while Instant::now() < end {
                if let Some(e) = c.next_event(Duration::from_millis(20))? {
                    ack(&mut c, &e);
                }
            }
            let shot = c.call("Page.captureScreenshot", json!({"format":"jpeg","quality":80}))?;
            let base = colour(&b64(&shot)?)?;
            let t0 = Instant::now();
            click(&mut c, x, y)?;
            let mut got = None;
            while t0.elapsed() < Duration::from_secs(5) {
                let Some(e) = c.next_event(Duration::from_millis(2))? else { continue };
                if e["method"] == "Page.screencastFrame" {
                    ack(&mut c, &e);
                    let d = e["params"]["data"].as_str().unwrap_or("");
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(d) {
                        if colour(&bytes).is_ok_and(|n| dist(n, base) > 120) {
                            got = Some(t0.elapsed().as_secs_f64() * 1000.0);
                            break;
                        }
                    }
                }
            }
            all.push(got.map(|v| (v * 10.0).round() / 10.0));
        }
        let _ = c.call("Page.stopScreencast", json!({}));
        let ok = all.iter().all(Option::is_some);
        Ok(json!({"ok": ok, "mode": mode, "ms": all}))
    })();
    done("stream_latency", t, r);
}

fn ack(c: &mut WsCdp, e: &Value) {
    if e["method"] == "Page.screencastFrame" {
        let _ = c.send("Page.screencastFrameAck", json!({"sessionId": e["params"]["sessionId"]}));
    }
}
