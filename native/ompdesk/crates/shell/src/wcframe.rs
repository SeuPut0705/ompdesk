//! `wc.frame` (PROTOCOL.md §4): the latest painted frame of an offscreen page, encoded when asked for.

use serde_json::json;
use shell_core::frame::{Format, encode};

use crate::host::Call;
use crate::state::wc;

pub fn request(call: Call, wc_id: u64) {
    let Some(entry) = wc(wc_id) else {
        return call.err("gone", format!("no page {wc_id}"));
    };
    let Some((bgra, width, height)) = entry
        .borrow()
        .painted
        .as_ref()
        .map(|p| (p.bgra.clone(), p.width, p.height))
    else {
        return call.err("failed", "the page has not painted yet");
    };
    let format = if call.str("format").as_deref() == Some("png") {
        Format::Png
    } else {
        Format::Jpeg
    };
    let quality = call
        .params
        .get("quality")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(80) as u8;
    let target = call
        .params
        .get("width")
        .and_then(serde_json::Value::as_f64)
        .filter(|w| *w >= 1.0)
        .map(|w| w as u32);
    // Encoding is work for a thread of its own: the UI thread keeps painting.
    std::thread::spawn(move || {
        match encode(&bgra, width as u32, height as u32, format, quality, target) {
            Ok((bytes, w, h)) => call.ok_bin(json!({ "width": w, "height": h }), &bytes),
            Err(error) => call.err("failed", error),
        }
    });
}
