//! cef-stream: the shell is the CDP client of the Preview; frames go to the page's canvas, clicks come back.
use crate::cdp::{Cdp, WsCdp, page_ws_url};
use serde_json::{Value, json};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Default)]
pub struct Frame {
    pub seq: u64,
    pub data: Vec<u8>,
}

pub struct Stream {
    pub frame: Arc<(Mutex<Frame>, Condvar)>,
    tx: Mutex<Sender<(String, Value)>>,
}

impl Stream {
    pub fn cdp(&self, method: &str, params: Value) {
        let _ = self.tx.lock().unwrap().send((method.to_string(), params));
    }

    /// Block until a frame newer than `after` exists (max 5 s).
    pub fn wait_frame(&self, after: u64) -> Option<(u64, Vec<u8>)> {
        let (m, cv) = &*self.frame;
        let g = cv.wait_timeout_while(m.lock().unwrap(), Duration::from_secs(5), |f| f.seq <= after).unwrap().0;
        (g.seq > after).then(|| (g.seq, g.data.clone()))
    }
}

pub fn start(port: u16, size: (u32, u32)) -> Stream {
    let frame = Arc::new((Mutex::new(Frame::default()), Condvar::new()));
    let (tx, rx) = channel();
    let f2 = frame.clone();
    std::thread::spawn(move || {
        loop {
            if let Err(e) = feed(port, size, &f2, &rx) {
                crate::log("preview.stream_error", json!({"error": e}));
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    });
    Stream { frame, tx: Mutex::new(tx) }
}

fn feed(port: u16, size: (u32, u32), frame: &Arc<(Mutex<Frame>, Condvar)>, rx: &Receiver<(String, Value)>) -> Result<(), String> {
    use base64::Engine;
    let url = page_ws_url(port, None, Duration::from_secs(60))?;
    let mut c = WsCdp::connect(&url)?;
    c.call("Page.enable", json!({}))?;
    c.call("Emulation.setDeviceMetricsOverride", json!({"width": size.0, "height": size.1, "deviceScaleFactor": 1, "mobile": false}))?;
    c.call("Page.startScreencast", json!({"format":"jpeg","quality":70,"everyNthFrame":1}))?;
    crate::log("preview.stream_started", json!({"w": size.0, "h": size.1}));
    loop {
        while let Ok((m, p)) = rx.try_recv() {
            c.send(&m, p)?;
        }
        let Some(v) = c.recv(Duration::from_millis(2))? else { continue };
        if v["method"] == "Page.screencastFrame" {
            c.send("Page.screencastFrameAck", json!({"sessionId": v["params"]["sessionId"]}))?;
            if let Some(d) = v["params"]["data"].as_str() {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(d) {
                    let (m, cv) = &**frame;
                    let mut g = m.lock().unwrap();
                    g.seq += 1;
                    g.data = bytes;
                    cv.notify_all();
                }
            }
        }
    }
}
