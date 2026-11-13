//! `theme.setSource` and `theme.changed`: the OS colour scheme with Electron's `themeSource` override on top. The override
//! is a browser-wide colour scheme: `RequestContext::set_chrome_color_scheme` on the global context and every
//! partition's, in force before any page loads (a page's `<head>` script reads `prefers-color-scheme` synchronously), and
//! also CDP media emulation of `prefers-color-scheme` on each page as a second hold.

use std::cell::RefCell;

use cef::{ColorVariant, ImplRequestContext, RequestContext, request_context_get_global_context};
use serde_json::{Value, json};
use shell_core::desk_state::{ThemeSource, effective_theme};

use crate::host::{self, Call};
use crate::system;

#[derive(Default)]
struct State {
    source: ThemeSource,
    last: Option<Value>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// `{dark, highContrast, inverted, reducedMotion}` for `source`.
fn snapshot(source: ThemeSource) -> Value {
    let mut value = effective_theme(&system::theme(), source);
    value["reducedMotion"] = json!(system::reduced_motion());
    value
}

/// Whether the app's scheme is dark now (`nativeTheme.shouldUseDarkColors`). UI thread.
pub fn dark() -> bool {
    STATE.with(|s| {
        snapshot(s.borrow().source)["dark"]
            .as_bool()
            .unwrap_or(false)
    })
}

/// UI thread.
pub fn init() {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.last = Some(snapshot(s.source));
    });
}

/// Pushes `theme.changed` when the effective values moved. UI thread.
pub fn refresh() {
    let changed = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let now = snapshot(s.source);
        (s.last.as_ref() != Some(&now)).then(|| {
            s.last = Some(now.clone());
            now
        })
    });
    if let Some(now) = changed {
        apply_chrome_all();
        host::event("theme.changed", now);
    }
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "theme.setSource" => {
            let Some(source) = call.str("source").as_deref().and_then(ThemeSource::parse) else {
                return call.err(
                    "invalid",
                    "theme.setSource: source must be system, light or dark",
                );
            };
            crate::ui::run(move || {
                STATE.with(|s| s.borrow_mut().source = source);
                apply_scheme_all();
                refresh();
                apply_all();
                apply_chrome_all();
                let now = snapshot(source);
                call.ok(json!({ "dark": now["dark"], "highContrast": now["highContrast"], "inverted": now["inverted"] }));
            });
        }
        _ => call.unsupported(),
    }
}

/// CEF's colour variant for a theme source (`system` hands the choice back to the OS).
fn variant(source: ThemeSource) -> ColorVariant {
    match source {
        ThemeSource::System => ColorVariant::SYSTEM,
        ThemeSource::Light => ColorVariant::LIGHT,
        ThemeSource::Dark => ColorVariant::DARK,
    }
}

/// Puts the current theme source on one request context (UI thread). A context made while the source is `system` is
/// left alone: that is its default.
pub fn apply_scheme_to_new_context(context: &RequestContext) {
    let source = STATE.with(|s| s.borrow().source);
    if source != ThemeSource::System {
        context.set_chrome_color_scheme(variant(source), 0);
    }
}

/// The theme source on the global context and every partition's context (UI thread).
fn apply_scheme_all() {
    let source = STATE.with(|s| s.borrow().source);
    let contexts: Vec<RequestContext> =
        crate::state::ui_state(|u| u.contexts.values().cloned().collect());
    for context in request_context_get_global_context()
        .into_iter()
        .chain(contexts)
    {
        context.set_chrome_color_scheme(variant(source), 0);
    }
}

/// The `prefers-color-scheme` a page should see: the override, or the OS's own when the source is `system`.
fn media_value() -> &'static str {
    STATE.with(|s| match s.borrow().source {
        ThemeSource::System => "",
        ThemeSource::Light => "light",
        ThemeSource::Dark => "dark",
    })
}

/// Pushes the theme source into one page (UI thread). A page that exists before the first `setSource` is left alone.
pub fn apply_to(wc_id: u64) {
    let value = media_value();
    if value.is_empty() && STATE.with(|s| s.borrow().last.is_none()) {
        return;
    }
    let params = json!({ "features": [{ "name": "prefers-color-scheme", "value": value }] });
    crate::cdp::send(
        wc_id,
        "Emulation.setEmulatedMedia",
        Some(params),
        None,
        |_| {},
    );
}

fn apply_all() {
    let ids: Vec<u64> = crate::state::ui_state(|u| u.wcs.keys().copied().collect());
    for id in ids {
        apply_to(id);
    }
}

/// Whether native window chrome is dark now: the `themeSource` override, or the OS's own scheme. UI thread.
#[cfg(windows)]
fn chrome_dark() -> bool {
    let source = STATE.with(|s| s.borrow().source);
    shell_core::native_ui::chrome_dark(source, system::theme()["dark"].as_bool().unwrap_or(false))
}

/// Gives one window's frame the current colour scheme (Windows: immersive dark mode). UI thread.
#[cfg(windows)]
pub fn apply_chrome(hwnd: isize) {
    if hwnd != 0 {
        shell_core::sys::winops::set_dark_chrome(hwnd, chrome_dark());
    }
}

/// Windows: every top-level window's frame; macOS: `NSApp.appearance` (`nil` for `system`). UI thread.
fn apply_chrome_all() {
    #[cfg(windows)]
    {
        let windows: Vec<_> = crate::state::ui_state(|u| u.windows.values().cloned().collect());
        for entry in windows {
            let window = entry.borrow().window.clone();
            if let Some(window) = window {
                apply_chrome(crate::state::native_handle(&window));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let source = STATE.with(|s| s.borrow().source);
        let dark = match source {
            ThemeSource::System => None,
            other => Some(shell_core::native_ui::chrome_dark(other, false)),
        };
        shell_core::sys_mac::window::set_app_appearance(dark);
    }
}
