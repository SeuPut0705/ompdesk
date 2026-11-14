// UNVERIFIED on macOS: written on Windows without a compiler for this target.
//! The macOS halves of `appops` (the `app.*` ops that only mean something on a Mac) and `window` (the `win.op`s Views
//! does not give, the traffic lights). The AppKit calls are `shell_core::sys_mac::{app, window}`; this file maps
//! protocol parameters onto them and answers.

use cef::ImplWindow;
use serde_json::{Value, json};
use shell_core::sys_mac::app::{self as mac_app, AboutPanel};
use shell_core::sys_mac::window as mac_window;

use crate::host::Call;
use crate::log::log;

/// `app.init`'s macOS parameters: the `aboutPanel` options and the `activationPolicy`. Main thread, once CEF started
/// (`app::INIT` does not carry them, so `lifecycle::answer_init` is called with `init_call.params` still at hand).
pub fn apply_init(params: &Value) {
    let text = |value: Option<&Value>, key: &str| {
        value
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .map(String::from)
    };
    let about = params.get("aboutPanel");
    mac_app::set_about_panel(AboutPanel {
        application_name: text(about, "applicationName"),
        icon_path: text(about, "iconPath"),
    });
    if let Some(policy) = params.get("activationPolicy").and_then(Value::as_str)
        && !mac_app::set_activation_policy(policy)
    {
        log("app.activation_policy_failed", json!({ "policy": policy }));
    }
}

/// `app.hide`, `app.show`, `app.setBadge`, `app.setDockIcon`, `app.showAboutPanel`: AppKit's on the main thread.
pub fn app_op(mut call: Call) {
    let bin = call.bin.take();
    crate::ui::run(move || {
        let result = match call.method.as_str() {
            "app.hide" => {
                mac_app::hide();
                Ok(())
            }
            "app.show" => {
                mac_app::unhide();
                Ok(())
            }
            "app.setBadge" => {
                mac_app::set_badge(&call.str("text").unwrap_or_default());
                Ok(())
            }
            "app.setDockIcon" => mac_app::set_dock_icon(bin.as_deref().unwrap_or_default()),
            "app.showAboutPanel" => {
                mac_app::show_about_panel();
                Ok(())
            }
            other => Err(format!("{other} is not a macOS app op")),
        };
        match result {
            Ok(()) => call.ok(json!({})),
            Err(message) => call.err("failed", message),
        }
    });
}

/// `app.setAsDefaultProtocolClient`: Launch Services, for the app bundle this shell runs from.
pub fn register_protocol(protocol: &str) -> bool {
    mac_app::register_default_protocol(protocol)
}

fn nsview(window: &cef::Window) -> isize {
    window.window_handle() as isize
}

/// `setOpacity`, `setIgnoreMouseEvents`, `setSkipTaskbar`, `setFocusable`, `setIcon` on the window's `NSWindow`.
/// UI thread.
pub fn window_op(window: &cef::Window, name: &str, args: &Value) {
    let view = nsview(window);
    let flag = |key: &str, default: bool| args.get(key).and_then(Value::as_bool).unwrap_or(default);
    match name {
        "setOpacity" => {
            if !mac_window::set_opacity(
                view,
                args.get("value").and_then(Value::as_f64).unwrap_or(1.0),
            ) {
                log(
                    "win.op_not_applied",
                    json!({ "op": name, "reason": "the window has no NSWindow yet" }),
                );
            }
        }
        "setIgnoreMouseEvents" => {
            if !mac_window::set_ignore_mouse_events(view, flag("ignore", false)) {
                log(
                    "win.op_not_applied",
                    json!({ "op": name, "reason": "the window has no NSWindow yet" }),
                );
            }
        }
        // macOS has no per-window taskbar entry, and the bundle owns the icon: nothing to do, by design.
        "setSkipTaskbar" | "setIcon" => {}
        // Whether a window can become key is a method of the class Views owns; AppKit and CEF have no setter.
        "setFocusable" => log(
            "win.op_not_applied",
            json!({ "op": name, "reason": "AppKit has no API to make a window unable to become key" }),
        ),
        other => log(
            "win.op_not_applied",
            json!({ "op": other, "reason": "not a macOS window op" }),
        ),
    }
}

/// Puts the traffic lights at the window option `trafficLightPosition {x, y}` when the window has one (otherwise
/// CEF's `titlebar_height` centring stands). AppKit lays the buttons out again on resize and on leaving full screen:
/// call this at creation, from `on_window_bounds_changed` and after `on_window_fullscreen_transition`.
pub fn traffic_lights(window: &cef::Window, options: &Value) {
    let Some(position) = options.get("trafficLightPosition") else {
        return;
    };
    let coordinate = |key: &str| {
        position
            .get(key)
            .and_then(Value::as_f64)
            .map(|v| v.round() as i32)
    };
    let (Some(x), Some(y)) = (coordinate("x"), coordinate("y")) else {
        return;
    };
    // An unplaced window (not on screen yet, or full screen) is not an error: the next call places it.
    mac_window::apply_traffic_lights(nsview(window), x, y);
}
