//! What the Preview does to one of its pages through CEF: make it (a view in an app window, or an offscreen browser
//! for a paired viewer), load, step through history, zoom, size, run OMPdesk's page tools in an isolated world, and
//! take its pixels or its PDF. The page's handlers are `wc.rs`'s, as for every page of the shell.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use base64::Engine;
use cef::*;
use serde_json::{Value, json};

use crate::state::{self, Role, ViewEntry, ui_state, wc};
use crate::{cdp, view, wc as page_handlers};

fn cs(text: &str) -> CefString {
    CefString::from(text)
}

/// A new page of `partition`: a hidden view attached to app window `win_id`, or, without one, an offscreen browser
/// `width` × `height` DIPs. `None` when CEF refused it. The page's events come to the module from the start.
pub fn create(
    partition: &str,
    win_id: Option<u64>,
    width: i32,
    height: i32,
) -> Option<(u64, Option<u64>)> {
    let wc_id = state::next_wc_id();
    let view_id = match win_id {
        Some(win_id) => {
            let browser_view = page_handlers::create_view(wc_id, Role::View, partition)?;
            browser_view.set_visible(0);
            let view_id = state::next_view_id();
            let entry = ViewEntry {
                view_id,
                wc_id,
                win_id: None,
                bounds: (0, 0, 0, 0),
                visible: false,
            };
            ui_state(|u| u.views.insert(view_id, Rc::new(RefCell::new(entry))));
            view::attach(view_id, win_id);
            Some(view_id)
        }
        None => {
            if !page_handlers::create_offscreen(wc_id, partition, width, height) {
                return None;
            }
            None
        }
    };
    if let Some(entry) = wc(wc_id) {
        entry.borrow_mut().module_owned = true;
    }
    // `input-event` (the C143 gate) is armed on every Preview page.
    cdp::watch_input(wc_id);
    Some((wc_id, view_id))
}

/// The page's view inside its window, as `layout::place_view` decided.
pub fn place_view(view_id: u64, rect: Option<(i32, i32, i32, i32)>, visible: bool) {
    view::place(view_id, rect, visible);
}

pub fn set_view_visible(view_id: u64, visible: bool) {
    view::set_visible(view_id, visible);
}

/// An offscreen page's size in DIPs (its window's content size in Electron).
pub fn offscreen_size(wc_id: u64) -> (i32, i32) {
    wc(wc_id).map(|e| e.borrow().view_size).unwrap_or((1, 1))
}

/// An app window's content size in DIPs (its Preview views are placed inside it).
pub fn window_content_size(win_id: u64) -> (f64, f64) {
    state::win(win_id)
        .and_then(|w| {
            w.borrow()
                .window
                .as_ref()
                .map(|window| window.client_area_bounds_in_screen())
        })
        .map_or((0.0, 0.0), |bounds| {
            (f64::from(bounds.width), f64::from(bounds.height))
        })
}

/// Keys reach an offscreen browser only while it holds the focus.
pub fn focus(wc_id: u64) {
    page_handlers::with_browser(wc_id, |b| {
        if let Some(h) = b.host() {
            h.set_focus(1);
        }
    });
}

pub fn set_offscreen_size(wc_id: u64, width: i32, height: i32) {
    let Some(page) = wc(wc_id) else { return };
    page.borrow_mut().view_size = (width, height);
    if let Some(host) = page.borrow().browser.as_ref().and_then(|b| b.host()) {
        host.was_resized();
    }
}

/// Main's own load: never asked about as the page's own move (`programmatic`).
pub fn load(wc_id: u64, url: &str) {
    let url = url.to_owned();
    page_handlers::with_browser(wc_id, move |browser| {
        if let Some(e) = wc(wc_id) {
            e.borrow_mut().programmatic = true;
        }
        if let Some(frame) = browser.main_frame() {
            frame.load_url(Some(&cs(&url)));
        }
    });
}

#[derive(Clone, Copy)]
pub enum Step {
    Back,
    Forward,
    Reload,
    Stop,
}

/// A history step, a reload or a stop. A step is never asked about (its transition says so, `transition::asks_node`), so
/// nothing is marked `programmatic`: a mark on a navigation that never starts would let the page's next own move through.
pub fn step(wc_id: u64, step: Step) {
    page_handlers::with_browser(wc_id, move |browser| match step {
        Step::Back => browser.go_back(),
        Step::Forward => browser.go_forward(),
        Step::Reload => browser.reload(),
        Step::Stop => browser.stop_load(),
    });
}

pub fn zoom_factor(wc_id: u64) -> f64 {
    wc(wc_id)
        .map(|e| e.borrow().state.zoom_factor)
        .unwrap_or(1.0)
}

pub fn set_zoom_factor(wc_id: u64, factor: f64) {
    page_handlers::set_zoom_factor(wc_id, factor);
}

/// WebRTC only through the session's proxy (a visual's page: its proxy is a dead end).
pub fn disable_non_proxied_udp(wc_id: u64) {
    page_handlers::set_webrtc_policy(wc_id, "disable_non_proxied_udp");
}

/// An offscreen page's frame rate, a fresh paint, and whether it paints at all.
pub fn set_frame_rate(wc_id: u64, fps: i32) {
    if let Some(e) = wc(wc_id) {
        e.borrow_mut().frame_rate = fps;
    }
    page_handlers::with_browser(wc_id, move |b| {
        if let Some(h) = b.host() {
            h.set_windowless_frame_rate(fps);
        }
    });
}

pub fn invalidate(wc_id: u64) {
    page_handlers::with_browser(wc_id, |b| {
        if let Some(h) = b.host() {
            h.invalidate(PaintElementType::VIEW);
        }
    });
}

pub fn set_painting(wc_id: u64, painting: bool) {
    page_handlers::with_browser(wc_id, move |b| {
        if let Some(h) = b.host() {
            h.was_hidden(i32::from(!painting));
        }
    });
}

/// Destroys the page (its view leaves the window first).
pub fn close(wc_id: u64) {
    page_handlers::close(wc_id);
}

pub fn exists(wc_id: u64) -> bool {
    wc(wc_id).is_some_and(|e| !e.borrow().closing)
}

/// Whether a debugger other than the module's own work holds the page (DevTools opened on it, or the agent).
pub fn debugger_attached(wc_id: u64) -> bool {
    wc(wc_id).is_some_and(|e| {
        let e = e.borrow();
        e.cdp_attached || e.state.devtools_opened
    })
}

// ------------------------------------------------------------------ page tools in OMPdesk's isolated world

thread_local! {
    /// Runs waiting on a page, by page: they answer `null` once its main frame starts another document.
    static RUNS: RefCell<HashMap<u64, Vec<Rc<RefCell<Option<Box<dyn FnOnce(Value)>>>>>>> = RefCell::new(HashMap::new());
}

/// The page left its document (or closed): every run on it answers `null`.
pub fn end_runs(wc_id: u64) {
    let runs = RUNS
        .with(|r| r.borrow_mut().remove(&wc_id))
        .unwrap_or_default();
    for run in runs {
        if let Some(done) = run.borrow_mut().take() {
            done(Value::Null);
        }
    }
}

/// Runs `code` in the main frame's isolated world `world` (`executeJavaScriptInIsolatedWorld`): its value, or `null`
/// when it threw, the page closed or its main frame started another document first.
pub fn run_in_world(wc_id: u64, world: u32, code: &str, done: impl FnOnce(Value) + 'static) {
    if !exists(wc_id) {
        return done(Value::Null);
    }
    let slot: Rc<RefCell<Option<Box<dyn FnOnce(Value)>>>> =
        Rc::new(RefCell::new(Some(Box::new(done))));
    RUNS.with(|r| r.borrow_mut().entry(wc_id).or_default().push(slot.clone()));
    let finish = move |value: Value| {
        RUNS.with(|r| {
            if let Some(list) = r.borrow_mut().get_mut(&wc_id) {
                list.retain(|other| !Rc::ptr_eq(other, &slot));
            }
        });
        if let Some(done) = slot.borrow_mut().take() {
            done(value);
        }
    };
    let code = code.to_owned();
    cdp::send(wc_id, "Page.getFrameTree", None, None, move |tree| {
        let Some(frame) = tree.ok().and_then(|t| {
            t.pointer("/frameTree/frame/id")
                .and_then(Value::as_str)
                .map(String::from)
        }) else {
            return finish(Value::Null);
        };
        let params = json!({ "frameId": frame, "worldName": format!("ompdesk-world-{world}") });
        cdp::send(
            wc_id,
            "Page.createIsolatedWorld",
            Some(params),
            None,
            move |made| {
                let Some(context) = made
                    .ok()
                    .and_then(|m| m.get("executionContextId").and_then(Value::as_i64))
                else {
                    return finish(Value::Null);
                };
                let params = json!({
                    "expression": code, "contextId": context, "awaitPromise": true, "returnByValue": true, "userGesture": false,
                });
                cdp::send(
                    wc_id,
                    "Runtime.evaluate",
                    Some(params),
                    None,
                    move |evaluated| {
                        let value = evaluated
                            .ok()
                            .filter(|e| e.get("exceptionDetails").is_none())
                            .and_then(|e| e.pointer("/result/value").cloned())
                            .unwrap_or(Value::Null);
                        finish(value);
                    },
                );
            },
        );
    });
}

// ------------------------------------------------------------------ pixels and PDF

/// The page's pixels as PNG (`Page.captureScreenshot`): of `clip` (CSS px of the page) when given, else the visible
/// viewport, at `scale` (below 1 shrinks the picture). `None` when the page could not be captured or had nothing.
pub fn capture(
    wc_id: u64,
    clip: Option<(f64, f64, f64, f64)>,
    scale: f64,
    done: impl FnOnce(Option<Vec<u8>>) + 'static,
) {
    let shoot = move |clip: Option<(f64, f64, f64, f64)>| {
        let mut params = json!({ "format": "png", "fromSurface": true });
        if let Some((x, y, width, height)) = clip {
            params["clip"] =
                json!({ "x": x, "y": y, "width": width, "height": height, "scale": scale });
        }
        cdp::send(
            wc_id,
            "Page.captureScreenshot",
            Some(params),
            None,
            move |shot| {
                let png = shot
                    .ok()
                    .and_then(|s| s.get("data").and_then(Value::as_str).map(String::from))
                    .and_then(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
                    .filter(|bytes| !bytes.is_empty());
                done(png);
            },
        );
    };
    match clip {
        Some(clip) => shoot(Some(clip)),
        None if scale == 1.0 => shoot(None),
        None => cdp::send(wc_id, "Page.getLayoutMetrics", None, None, move |metrics| {
            let viewport = metrics.ok().and_then(|m| {
                let v = m.get("cssVisualViewport")?;
                Some((
                    v.get("pageX")?.as_f64()?,
                    v.get("pageY")?.as_f64()?,
                    v.get("clientWidth")?.as_f64()?,
                    v.get("clientHeight")?.as_f64()?,
                ))
            });
            shoot(viewport);
        }),
    }
}

/// The visible viewport's size in CSS px (`Page.getLayoutMetrics`), for a capture scaled to a bound.
pub fn viewport_size(wc_id: u64, done: impl FnOnce(Option<(f64, f64)>) + 'static) {
    cdp::send(wc_id, "Page.getLayoutMetrics", None, None, move |metrics| {
        done(metrics.ok().and_then(|m| {
            let v = m.get("cssVisualViewport")?;
            Some((
                v.get("clientWidth")?.as_f64()?,
                v.get("clientHeight")?.as_f64()?,
            ))
        }));
    });
}

/// The page printed to PDF with its backgrounds (`printToPDF({printBackground: true})`).
pub fn pdf(wc_id: u64, done: impl FnOnce(Result<Vec<u8>, String>) + 'static) {
    let params =
        json!({ "printBackground": true, "landscape": false, "transferMode": "ReturnAsBase64" });
    cdp::send(
        wc_id,
        "Page.printToPDF",
        Some(params),
        None,
        move |answer| {
            done(match answer {
                Ok(value) => value
                    .get("data")
                    .and_then(Value::as_str)
                    .and_then(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
                    .ok_or_else(|| "the page could not be printed".to_owned()),
                Err((_, message)) => Err(message),
            });
        },
    );
}
