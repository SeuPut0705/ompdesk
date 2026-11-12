//! The CEF application object: command line, custom schemes, the browser-process handler, and the renderer-process
//! handler (the one extra thing a helper process does: run a Preview partition's preload before page scripts).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::OnceLock;

use cef::*;
use serde_json::{Value, json};

use crate::host;
use crate::log::log;

/// One privileged scheme of `app.init` (Electron's `CustomScheme`), as CEF's registrar flags.
#[derive(Clone)]
pub struct SchemeSpec {
    pub name: String,
    pub options: i32,
}

pub struct AppInit {
    pub switches: Vec<(String, Option<String>)>,
    pub schemes: Vec<SchemeSpec>,
    pub disable_gpu: bool,
}

pub static INIT: OnceLock<AppInit> = OnceLock::new();

/// The shell's own scheme: standard, secure, with fetch and CORS (what the page needs of an origin).
fn app_scheme_options() -> i32 {
    use sys::cef_scheme_options_t as O;
    O::CEF_SCHEME_OPTION_STANDARD as i32
        | O::CEF_SCHEME_OPTION_SECURE as i32
        | O::CEF_SCHEME_OPTION_CORS_ENABLED as i32
        | O::CEF_SCHEME_OPTION_FETCH_ENABLED as i32
}

fn scheme_options(privileges: &Value) -> i32 {
    use sys::cef_scheme_options_t as O;
    let flag = |key: &str| {
        privileges
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let mut options = 0;
    if flag("standard") {
        options |= O::CEF_SCHEME_OPTION_STANDARD as i32;
    }
    if flag("secure") {
        options |= O::CEF_SCHEME_OPTION_SECURE as i32;
    }
    if flag("corsEnabled") {
        options |= O::CEF_SCHEME_OPTION_CORS_ENABLED as i32;
    }
    if flag("supportFetchAPI") {
        options |= O::CEF_SCHEME_OPTION_FETCH_ENABLED as i32;
    }
    if flag("bypassCSP") {
        options |= O::CEF_SCHEME_OPTION_CSP_BYPASSING as i32;
    }
    options
}

/// Reads `app.init`'s params.
pub fn parse_init(params: &Value) -> AppInit {
    let switches = params
        .get("switches")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|pair| {
                    Some((
                        pair.get(0)?.as_str()?.to_string(),
                        pair.get(1).and_then(Value::as_str).map(String::from),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let schemes = params
        .get("schemes")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|s| {
                    Some(SchemeSpec {
                        name: s.get("scheme")?.as_str()?.to_string(),
                        options: scheme_options(s.get("privileges").unwrap_or(&Value::Null)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    AppInit {
        switches,
        schemes,
        disable_gpu: params
            .get("disableHardwareAcceleration")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// `--ompdesk-schemes=[["name", options], …]`: how the browser process tells helpers which schemes to register
/// (CEF needs the same registration in every process).
const SCHEMES_SWITCH: &str = "ompdesk-schemes";

fn schemes_from_argv() -> Vec<SchemeSpec> {
    let Some(raw) = std::env::args().find_map(|a| {
        a.strip_prefix(&format!("--{SCHEMES_SWITCH}="))
            .map(String::from)
    }) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<(String, i32)>>(&raw)
        .unwrap_or_default()
        .into_iter()
        .map(|(name, options)| SchemeSpec { name, options })
        .collect()
}

wrap_browser_process_handler! {
    struct ShellBrowserProcess;
    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            crate::scheme::register();
            crate::system::init();
            log("cef.ready", json!({ "version": shell_core::facts::CEF_VERSION }));
            host::event("app.ready", json!({}));
            #[cfg(target_os = "macos")]
            crate::macos::flush_pending();
        }

        fn on_before_child_process_launch(&self, command_line: Option<&mut CommandLine>) {
            let Some(command_line) = command_line else { return };
            #[cfg(target_os = "macos")]
            command_line.append_switch(Some(&CefString::from("use-mock-keychain")));
            if let Some(init) = INIT.get() {
                let list: Vec<(String, i32)> = init.schemes.iter().map(|s| (s.name.clone(), s.options)).collect();
                command_line.append_switch_with_value(Some(&CefString::from(SCHEMES_SWITCH)), Some(&CefString::from(json!(list).to_string().as_str())));
            }
        }

        fn on_already_running_app_relaunch(&self, command_line: Option<&mut CommandLine>, current_directory: Option<&CefString>) -> i32 {
            // CEF's own profile singleton saw a second process: ours handles launches before CEF starts, so this only
            // fires for a CEF process started outside it. Passed on like any second instance.
            let mut argv = CefStringList::new();
            if let Some(c) = command_line {
                c.argv(Some(&mut argv));
            }
            host::event(
                "app.secondInstance",
                json!({ "argv": argv.into_iter().collect::<Vec<String>>(), "cwd": current_directory.map(|d| d.to_string()).unwrap_or_default() }),
            );
            1
        }
    }
}

thread_local! {
    /// In a renderer process: the preload each browser was created with.
    static PRELOADS: RefCell<HashMap<i32, String>> = RefCell::new(HashMap::new());
}

wrap_render_process_handler! {
    struct ShellRenderProcess;
    impl RenderProcessHandler {
        fn on_browser_created(&self, browser: Option<&mut Browser>, extra_info: Option<&mut DictionaryValue>) {
            let (Some(browser), Some(info)) = (browser, extra_info) else { return };
            let source = CefString::from(&info.string(Some(&CefString::from("preload")))).to_string();
            if !source.is_empty() {
                PRELOADS.with(|p| p.borrow_mut().insert(browser.identifier(), source));
            }
        }

        fn on_browser_destroyed(&self, browser: Option<&mut Browser>) {
            if let Some(browser) = browser {
                PRELOADS.with(|p| p.borrow_mut().remove(&browser.identifier()));
            }
        }

        fn on_context_created(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, _context: Option<&mut V8Context>) {
            let (Some(browser), Some(frame)) = (browser, frame) else { return };
            let source = PRELOADS.with(|p| p.borrow().get(&browser.identifier()).cloned());
            if let Some(source) = source {
                // Runs in the page's main world before any page script: the V8 context was just created.
                frame.execute_java_script(Some(&CefString::from(source.as_str())), Some(&CefString::from("ompdesk-preload")), 0);
            }
        }
    }
}

wrap_app! {
    pub struct ShellApp {
        browser: bool,
    }
    impl App {
        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            let is_browser = process_type.map(|p| p.to_string().is_empty()).unwrap_or(true);
            let Some(command_line) = command_line else { return };
            if !is_browser {
                return;
            }
            // Electron's switch would re-point Chromium's profile at the bare folder: the profile is root_cache_path.
            command_line.remove_switch(Some(&CefString::from("user-data-dir")));
            // Playwright attaches over the debugging port from another origin.
            command_line.append_switch_with_value(Some(&CefString::from("remote-allow-origins")), Some(&CefString::from("*")));
            // The shell never uses Chromium's own OSCrypt keychain item (safeStorage is Node's, read on demand through
            // `--keychain-key`): without this, CEF would create "<name> Safe Storage" in the login keychain.
            #[cfg(target_os = "macos")]
            command_line.append_switch(Some(&CefString::from("use-mock-keychain")));
            if let Some(init) = INIT.get() {
                for (name, value) in &init.switches {
                    match value {
                        Some(v) => command_line.append_switch_with_value(Some(&CefString::from(name.as_str())), Some(&CefString::from(v.as_str()))),
                        None => command_line.append_switch(Some(&CefString::from(name.as_str()))),
                    }
                }
                if init.disable_gpu {
                    command_line.append_switch(Some(&CefString::from("disable-gpu")));
                    command_line.append_switch(Some(&CefString::from("disable-gpu-compositing")));
                }
            }
        }

        fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) {
            let Some(registrar) = registrar else { return };
            registrar.add_custom_scheme(Some(&CefString::from("app")), app_scheme_options());
            let schemes = match INIT.get() {
                Some(init) if self.browser => init.schemes.clone(),
                _ => schemes_from_argv(),
            };
            for scheme in schemes {
                registrar.add_custom_scheme(Some(&CefString::from(scheme.name.as_str())), scheme.options);
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            self.browser.then(ShellBrowserProcess::new)
        }

        fn render_process_handler(&self) -> Option<RenderProcessHandler> {
            (!self.browser).then(ShellRenderProcess::new)
        }
    }
}
