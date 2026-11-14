//! The Preview's views: a CEF Views `BrowserView` placed inside an app window's content (Electron's
//! `WebContentsView`), with the Preview's session partition as its request context. The Preview module makes and places
//! them (PROTOCOL.md §15.6); the window keeps a list of them so closing it closes their pages.

use cef::*;

use crate::state::{self, view as view_entry, win};

fn browser_view(wc_id: u64) -> Option<BrowserView> {
    state::wc(wc_id).and_then(|e| e.borrow().view.clone())
}

/// Puts the view where it was placed, in its window's content coordinates.
pub fn apply_bounds(view_id: u64) {
    let Some(entry) = view_entry(view_id) else {
        return;
    };
    let (wc_id, (x, y, w, h), visible) = {
        let e = entry.borrow();
        (e.wc_id, e.bounds, e.visible)
    };
    if let Some(v) = browser_view(wc_id) {
        // An empty rectangle is never given to Views (a zero-sized browser view is a fatal check in Chromium): the view
        // is only hidden, and takes its bounds when it has some.
        let usable = w > 0 && h > 0;
        if usable {
            v.set_bounds(Some(&Rect {
                x,
                y,
                width: w,
                height: h,
            }));
        }
        v.set_visible(i32::from(visible && usable));
    }
}

fn container_of(win_id: u64) -> Option<Panel> {
    win(win_id).and_then(|w| w.borrow().container.clone())
}

/// Adds the view to window `win_id` (once; again only re-applies its bounds). The window's panel may not exist yet
/// (it is made on the OS window's creation): the view is attached when it does, for at most 1.2 s.
pub fn attach(view_id: u64, win_id: u64) {
    attach_after(view_id, win_id, 0);
}

fn attach_after(view_id: u64, win_id: u64, attempt: u32) {
    let Some(entry) = view_entry(view_id) else {
        return;
    };
    let wc_id = entry.borrow().wc_id;
    let (Some(page), Some(window)) = (browser_view(wc_id), win(win_id)) else {
        return;
    };
    let Some(container) = container_of(win_id) else {
        if attempt < 40 {
            crate::ui::post_delayed(30, move || attach_after(view_id, win_id, attempt + 1));
        }
        return;
    };
    // Adding a child that is already in the widget makes Views observe it twice (a fatal NOTREACHED in Chromium).
    if entry.borrow().win_id != Some(win_id) {
        container.add_child_view(Some(&mut View::from(&page)));
    }
    entry.borrow_mut().win_id = Some(win_id);
    if !window.borrow().views.contains(&view_id) {
        window.borrow_mut().views.push(view_id);
    }
    if let Some(w) = state::wc(wc_id) {
        w.borrow_mut().win_id = Some(win_id);
    }
    apply_bounds(view_id);
}

/// The view's place (whole DIPs of its window's content) and whether it shows; `None` keeps its last place and only
/// changes whether it shows.
pub fn place(view_id: u64, rect: Option<(i32, i32, i32, i32)>, visible: bool) {
    let Some(entry) = view_entry(view_id) else {
        return;
    };
    {
        let mut e = entry.borrow_mut();
        if let Some(rect) = rect {
            e.bounds = rect;
        }
        e.visible = visible;
    }
    apply_bounds(view_id);
}

pub fn set_visible(view_id: u64, visible: bool) {
    place(view_id, None, visible);
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
    state::ui_state(|u| u.views.remove(&view_id));
}
