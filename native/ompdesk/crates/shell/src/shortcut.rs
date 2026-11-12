//! `shortcut.register` / `shortcut.unregister` and `shortcut.fired`: global hotkeys on the hidden message window.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::json;
use shell_core::hotkey;

use crate::host::{self, Call};
use crate::system;

#[derive(Default)]
struct Registry {
    next_id: i32,
    by_accelerator: HashMap<String, i32>,
    by_id: HashMap<i32, String>,
}

thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default());
}

/// A hotkey fired. UI thread.
pub fn fired(id: i32) {
    if let Some(accelerator) = REGISTRY.with(|r| r.borrow().by_id.get(&id).cloned()) {
        host::event("shortcut.fired", json!({ "accelerator": accelerator }));
    }
}

fn register(text: &str) -> bool {
    let Some(parsed) = hotkey::parse(text, cfg!(target_os = "macos")) else {
        return false;
    };
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        if r.by_accelerator.contains_key(text) {
            return true;
        }
        r.next_id += 1;
        let id = r.next_id;
        if !system::register_hotkey(id, &parsed) {
            return false;
        }
        r.by_accelerator.insert(text.to_string(), id);
        r.by_id.insert(id, text.to_string());
        true
    })
}

fn unregister(text: &str) {
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        if let Some(id) = r.by_accelerator.remove(text) {
            r.by_id.remove(&id);
            system::unregister_hotkey(id);
        }
    });
}

pub fn handle(call: Call) {
    let Some(text) = call.str("accelerator") else {
        return call.err("invalid", "shortcut calls need an accelerator");
    };
    match call.method.as_str() {
        "shortcut.register" => crate::ui::run(move || {
            let registered = register(&text);
            call.ok(json!({ "registered": registered }));
        }),
        "shortcut.unregister" => crate::ui::run(move || {
            unregister(&text);
            call.ok(json!({}));
        }),
        _ => call.unsupported(),
    }
}
