//! `app.*` requests besides `app.init` (PROTOCOL.md §2).

use cef::ImplWindow;
use serde_json::{Value, json};

use crate::host::Call;
use crate::state::{ui_state, win};

pub fn handle(call: Call) {
    match call.method.as_str() {
        "app.focus" => crate::ui::run(move || {
            focus_any();
            call.ok(json!({}));
        }),
        "app.hide" | "app.show" | "app.setBadge" | "app.setDockIcon" | "app.showAboutPanel" => {
            #[cfg(target_os = "macos")]
            return crate::platform::app_op(call);
            #[cfg(not(target_os = "macos"))]
            call.ok(json!({}))
        }
        "app.setAppUserModelId" => {
            #[cfg(windows)]
            if let Some(id) = call.str("id") {
                set_app_user_model_id(&id);
            }
            call.ok(json!({}))
        }
        "app.setAsDefaultProtocolClient" => {
            let protocol = call.str("protocol").unwrap_or_default();
            let ok = register_protocol(&protocol);
            call.ok(json!({ "ok": ok }))
        }
        "app.getGPUInfo" => {
            let disabled = crate::app::INIT.get().is_some_and(|i| i.disable_gpu);
            call.ok(gpu_info(disabled))
        }
        _ => call.unsupported(),
    }
}

/// The first window brought to the front (the app's own focus request; Node picks which window matters).
fn focus_any() {
    let first = ui_state(|u| u.windows.keys().min().copied());
    if let Some(window) = first.and_then(win).and_then(|w| w.borrow().window.clone()) {
        if window.is_minimized() != 0 {
            window.restore();
        }
        window.show();
        window.activate();
        window.bring_to_top();
    }
}

#[cfg(windows)]
pub fn set_app_user_model_id(id: &str) {
    shell_core::sys::system::set_app_user_model_id(id);
}

fn register_protocol(protocol: &str) -> bool {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    #[cfg(windows)]
    return shell_core::sys::system::register_protocol(protocol, &exe);
    #[cfg(target_os = "macos")]
    return crate::platform::register_protocol(protocol);
}

fn gpu_info(disabled: bool) -> Value {
    #[cfg(windows)]
    let devices = shell_core::sys::system::gpu_adapters();
    #[cfg(not(windows))]
    let devices: Vec<Value> = Vec::new();
    let compositing = if disabled {
        "disabled_software"
    } else {
        "enabled"
    };
    json!({
        "info": { "gpuDevice": devices },
        "features": { "gpu_compositing": compositing, "webgl": compositing, "rasterization": compositing },
    })
}
