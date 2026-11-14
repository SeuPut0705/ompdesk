//! Global hotkeys on the hidden message window: registered by `boot.registerShortcut`, reported as `boot.shortcut`
//! (PROTOCOL.md §15.9).

use std::cell::RefCell;
use std::collections::HashMap;

use shell_core::hotkey;

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
        crate::modules::boot::shortcut(&accelerator);
    }
}

/// Registers `text` (an Electron accelerator) system-wide; false when it does not parse or another application holds
/// it. Registering one already held is true. UI thread.
pub fn register(text: &str) -> bool {
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

/// Releases only this registry's OS hotkeys. UI thread, before the native message source shuts down.
pub fn unregister_all() {
    let held = REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        registry.by_accelerator.clear();
        std::mem::take(&mut registry.by_id)
    });
    for id in held.into_keys() {
        system::unregister_hotkey(id);
    }
}
