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
        "app.getGPUInfo" => call.ok(gpu_info()),
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

/// Makes this executable the handler of `protocol://` (the deep-link area registers `omp` when Node's windows exist).
pub fn register_protocol(protocol: &str) -> bool {
    #[cfg(windows)]
    return shell_core::sys::system::register_protocol(
        protocol,
        &std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    );
    #[cfg(target_os = "macos")]
    return crate::platform::register_protocol(protocol);
}

/// The adapters the OS lists (`getGPUInfo("basic").gpuDevice`): the GPU fallback's marker names the one in use. Empty
/// on macOS, where the shell does not read them.
pub fn gpu_devices() -> Vec<Value> {
    #[cfg(windows)]
    return shell_core::sys::system::gpu_adapters();
    #[cfg(not(windows))]
    Vec::new()
}

/// `app.getGPUInfo`'s answer; whether compositing is software is the GPU fallback's (`gpu::software_now`: the launch's
/// own decision, or the mode Chromium started its GPU process in).
fn gpu_info() -> Value {
    let compositing = if crate::modules::chrome::gpu::software_now() {
        "disabled_software"
    } else {
        "enabled"
    };
    json!({
        "info": { "gpuDevice": gpu_devices() },
        "features": { "gpu_compositing": compositing, "webgl": compositing, "rasterization": compositing },
    })
}
