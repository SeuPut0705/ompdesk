//! `view.*` (PROTOCOL.md §5): Electron's `WebContentsView`, a CEF Views `BrowserView` placed inside a window's
//! content, with the Preview's session partition as its request context.

use std::cell::RefCell;
use std::rc::Rc;

use cef::*;
use serde_json::{Value, json};
use shell_core::color;

use crate::host::Call;
use crate::state::{self, Role, ViewEntry, ui_state, view as view_entry, win};
use crate::wc;

pub fn create(call: Call) {
    let view_id = call
        .params
        .get("viewId")
        .and_then(Value::as_u64)
        .unwrap_or_else(state::next_view_id);
    let wc_id = call
        .params
        .get("wcId")
        .and_then(Value::as_u64)
        .unwrap_or_else(state::next_wc_id);
    let partition = call
        .params
        .get("webPreferences")
        .and_then(|p| p.get("session"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    crate::ui::run(move || {
        let Some(page) = wc::create_view(wc_id, Role::View, &partition) else {
            return call.err("failed", "CEF could not create the view");
        };
        // Hidden until Node shows it, so a page loading before its first layout is never seen at a stray size.
        page.set_visible(0);
        let entry = ViewEntry {
            view_id,
            wc_id,
            win_id: None,
            bounds: (0, 0, 0, 0),
            visible: false,
        };
        ui_state(|u| u.views.insert(view_id, Rc::new(RefCell::new(entry))));
        call.ok(json!({ "viewId": view_id, "wcId": wc_id }));
    });
}

fn browser_view(wc_id: u64) -> Option<BrowserView> {
    state::wc(wc_id).and_then(|e| e.borrow().view.clone())
}

/// Puts the view where Node asked, in its window's content coordinates.
pub fn apply_bounds(view_id: u64) {
    let Some(entry) = view_entry(view_id) else {
        return;
    };
    let (wc_id, (x, y, w, h), visible) = {
        let e = entry.borrow();
        (e.wc_id, e.bounds, e.visible)
    };
    if let Some(v) = browser_view(wc_id) {
        v.set_bounds(Some(&Rect {
            x,
            y,
            width: w,
            height: h,
        }));
        v.set_visible(i32::from(visible && w > 0 && h > 0));
    }
}

fn container_of(win_id: u64) -> Option<Panel> {
    win(win_id).and_then(|w| w.borrow().container.clone())
}

pub fn op(call: Call) {
    let Some(view_id) = call.params.get("viewId").and_then(Value::as_u64) else {
        return call.err("invalid", "viewId is missing");
    };
    let name = call.str("op").unwrap_or_default();
    let args = call.params.get("args").cloned().unwrap_or(Value::Null);
    crate::ui::run(move || run_op(call, view_id, &name, &args));
}

fn run_op(call: Call, view_id: u64, name: &str, args: &Value) {
    let Some(entry) = view_entry(view_id) else {
        return call.err("gone", format!("no view {view_id}"));
    };
    let wc_id = entry.borrow().wc_id;
    match name {
        "attach" => {
            let Some(win_id) = args.get("winId").and_then(Value::as_u64) else {
                return call.err("invalid", "winId is missing");
            };
            let (Some(page), Some(window)) = (browser_view(wc_id), win(win_id)) else {
                return call.err("gone", "the view or its window is gone");
            };
            // The window's panel may not exist yet (it is made on the OS window's creation): attach when it does.
            match container_of(win_id) {
                Some(container) => {
                    container.add_child_view(Some(&mut View::from(&page)));
                    entry.borrow_mut().win_id = Some(win_id);
                    if !window.borrow().views.contains(&view_id) {
                        window.borrow_mut().views.push(view_id);
                    }
                    if let Some(w) = state::wc(wc_id) {
                        w.borrow_mut().win_id = Some(win_id);
                    }
                    apply_bounds(view_id);
                }
                None => {
                    return crate::ui::post_delayed(30, move || {
                        retry_attach(call, view_id, win_id, 1)
                    });
                }
            }
        }
        "detach" => detach(view_id),
        "setBounds" => {
            if let Some(b) = args.get("bounds") {
                let n = |k: &str| b.get(k).and_then(Value::as_f64).unwrap_or(0.0).round() as i32;
                entry.borrow_mut().bounds = (n("x"), n("y"), n("width"), n("height"));
                apply_bounds(view_id);
            }
        }
        "setVisible" => {
            entry.borrow_mut().visible = args
                .get("visible")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            apply_bounds(view_id);
        }
        "setBackgroundColor" => {
            if let (Some(c), Some(v)) = (
                args.get("color")
                    .and_then(Value::as_str)
                    .and_then(color::parse_css),
                browser_view(wc_id),
            ) {
                v.set_background_color(c.argb());
            }
        }
        "destroy" => {
            detach(view_id);
            wc::close(wc_id);
        }
        other => {
            return call.err(
                "unsupported",
                format!("view.op {other} is not implemented by this shell"),
            );
        }
    }
    call.ok(json!({}));
}

fn retry_attach(call: Call, view_id: u64, win_id: u64, attempt: u32) {
    if container_of(win_id).is_some() || attempt >= 40 {
        let args = call.params.get("args").cloned().unwrap_or(Value::Null);
        return run_op(call, view_id, "attach", &args);
    }
    crate::ui::post_delayed(30, move || retry_attach(call, view_id, win_id, attempt + 1));
}

fn detach(view_id: u64) {
    let Some(entry) = view_entry(view_id) else {
        return;
    };
    let (wc_id, win_id) = {
        let e = entry.borrow();
        (e.wc_id, e.win_id)
    };
    if let (Some(win_id), Some(page)) = (win_id, browser_view(wc_id)) {
        if let Some(container) = container_of(win_id) {
            container.remove_child_view(Some(&mut View::from(&page)));
        }
        if let Some(w) = win(win_id) {
            w.borrow_mut().views.retain(|v| *v != view_id);
        }
    }
    entry.borrow_mut().win_id = None;
}

/// A page that is about to close: its view leaves the window first.
pub fn detach_for_close(view_id: u64) {
    detach(view_id);
    ui_state(|u| u.views.remove(&view_id));
}
