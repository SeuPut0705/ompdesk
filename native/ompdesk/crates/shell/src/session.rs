//! Sessions (PROTOCOL.md §6): a partition is a CEF request context. `""` and `app` are the global context (it
//! shares `<userData>/shell-webview` with the app's page), a name is in memory, `persist:<name>` lives in
//! `<userData>/shell-webview/Partitions/<name>`.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use cef::*;
use serde_json::{Value, json};

use crate::host::Call;
use crate::log::log;
use crate::state::{self, ui_state};

fn cs(text: &str) -> CefString {
    CefString::from(text)
}

#[derive(Default)]
struct Sessions {
    preloads: HashMap<String, Vec<(String, String)>>,
    deny_permissions: HashSet<String>,
    deny_downloads: HashSet<String>,
    user_agents: HashMap<String, (String, Option<String>)>,
}

static SESSIONS: Mutex<Option<Sessions>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut Sessions) -> R) -> R {
    f(SESSIONS
        .lock()
        .unwrap()
        .get_or_insert_with(Sessions::default))
}

fn is_app(partition: &str) -> bool {
    partition.is_empty() || partition == "app"
}

pub fn permissions_denied(partition: &str) -> bool {
    with(|s| s.deny_permissions.contains(partition))
}

pub fn downloads_denied(partition: &str) -> bool {
    with(|s| s.deny_downloads.contains(partition))
}

/// The scripts `registerPreload` handed over for `partition`, as one script for the renderer to run first.
pub fn preload_for(partition: &str) -> Option<String> {
    with(|s| {
        let list = s.preloads.get(partition)?;
        Some(
            list.iter()
                .map(|(_, source)| format!("(function(){{{source}\n}})();"))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    })
}

/// The request context of `partition` (UI thread); `None` is the global context.
pub fn context_for(partition: &str) -> Option<RequestContext> {
    if is_app(partition) {
        return None;
    }
    if let Some(existing) = ui_state(|u| u.contexts.get(partition).cloned()) {
        return Some(existing);
    }
    let cache_path = match partition.strip_prefix("persist:") {
        Some(name) => {
            let safe: String = name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            state::paths()
                .web_dir
                .join("Partitions")
                .join(safe)
                .display()
                .to_string()
        }
        None => String::new(),
    };
    let settings = RequestContextSettings {
        cache_path: cs(&cache_path),
        persist_session_cookies: i32::from(!cache_path.is_empty()),
        ..Default::default()
    };
    let context = request_context_create_context(Some(&settings), None)?;
    ui_state(|u| u.contexts.insert(partition.to_string(), context.clone()));
    log(
        "session.created",
        json!({ "partition": partition, "persist": !cache_path.is_empty() }),
    );
    Some(context)
}

fn context_or_global(partition: &str) -> Option<RequestContext> {
    context_for(partition).or_else(request_context_get_global_context)
}

/// Chromium's own user agent as Electron reported it, without the `Electron/…` token.
fn default_user_agent() -> String {
    let os = if cfg!(target_os = "macos") {
        "Macintosh; Intel Mac OS X 10_15_7"
    } else {
        "Windows NT 10.0; Win64; x64"
    };
    format!(
        "Mozilla/5.0 ({os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.0.0.0 Safari/537.36",
        shell_core::facts::CHROME_VERSION
            .split('.')
            .next()
            .unwrap_or("156")
    )
}

pub fn create(call: Call) {
    let partition = call.str("partition").unwrap_or_default();
    crate::ui::run(move || {
        let _ = context_for(&partition);
        let (ua, languages) = with(|s| s.user_agents.get(&partition).cloned())
            .unwrap_or_else(|| (default_user_agent(), None));
        call.ok(json!({
            "userAgent": ua,
            "acceptLanguages": languages.unwrap_or_else(|| "en-US,en".into()),
            "spellCheckerLanguages": [],
            "availableSpellCheckerLanguages": [],
        }));
    });
}

pub fn op(call: Call) {
    let partition = call.str("partition").unwrap_or_default();
    let name = call.str("op").unwrap_or_default();
    let args = call.params.get("args").cloned().unwrap_or(Value::Null);
    crate::ui::run(move || run_op(call, &partition, &name, &args));
}

fn proxy_value(args: &Value) -> Option<Value2> {
    let mode = args.get("mode").and_then(Value::as_str).unwrap_or("system");
    let dict = dictionary_value_create()?;
    dict.set_string(Some(&cs("mode")), Some(&cs(mode)));
    if let Some(rules) = args.get("proxyRules").and_then(Value::as_str) {
        dict.set_string(Some(&cs("server")), Some(&cs(rules)));
    }
    if let Some(pac) = args.get("pacScript").and_then(Value::as_str) {
        dict.set_string(Some(&cs("pac_url")), Some(&cs(pac)));
    }
    if let Some(bypass) = args.get("proxyBypassRules").and_then(Value::as_str) {
        dict.set_string(Some(&cs("bypass_list")), Some(&cs(bypass)));
    }
    let value = value_create()?;
    let mut dict = dict;
    value.set_dictionary(Some(&mut dict));
    Some(value)
}

type Value2 = cef::Value;

fn run_op(call: Call, partition: &str, name: &str, args: &Value) {
    match name {
        "setPermissions" => {
            with(|s| {
                if args.get("mode").and_then(Value::as_str) == Some("deny-all") {
                    s.deny_permissions.insert(partition.to_string());
                } else {
                    s.deny_permissions.remove(partition);
                }
            });
        }
        "setDownloads" => {
            with(|s| {
                if args.get("mode").and_then(Value::as_str) == Some("deny") {
                    s.deny_downloads.insert(partition.to_string());
                } else {
                    s.deny_downloads.remove(partition);
                }
            });
        }
        "registerPreload" => {
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let source = args
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            with(|s| {
                let list = s.preloads.entry(partition.to_string()).or_default();
                list.retain(|(existing, _)| *existing != id);
                list.push((id, source));
            });
        }
        "setUserAgent" => {
            let ua = args
                .get("userAgent")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let languages = args
                .get("acceptLanguages")
                .and_then(Value::as_str)
                .map(String::from);
            with(|s| s.user_agents.insert(partition.to_string(), (ua, languages)));
        }
        "setProxy" => {
            if let (Some(context), Some(mut value)) =
                (context_or_global(partition), proxy_value(args))
            {
                let mut error = CefString::default();
                if context.set_preference(Some(&cs("proxy")), Some(&mut value), Some(&mut error))
                    == 0
                {
                    return call.err("failed", format!("the proxy setting was refused: {error}"));
                }
            }
        }
        "clearCache" | "clearStorageData" if !partition.starts_with("persist:") => {
            // An in-memory partition keeps nothing past its pages.
        }
        "clearCache" => {
            if let Some(context) = context_or_global(partition) {
                context.clear_http_cache(None);
            }
        }
        "clearStorageData" => {
            if let Some(context) = context_or_global(partition) {
                if let Some(cookies) = context.cookie_manager(None) {
                    cookies.delete_cookies(None, None, None);
                }
                context.clear_http_cache(None);
            }
        }
        "handleScheme" | "unhandleScheme" => {
            let scheme = args
                .get("scheme")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let Some(context) = context_or_global(partition) else {
                return call.err("failed", "no request context");
            };
            if name == "handleScheme" {
                let mut factory =
                    crate::protocol::ProtocolFactory::new(scheme.clone(), partition.to_string());
                if context.register_scheme_handler_factory(
                    Some(&cs(&scheme)),
                    Some(&cs("")),
                    Some(&mut factory),
                ) == 0
                {
                    return call.err("failed", format!("could not handle {scheme}"));
                }
            } else {
                context.register_scheme_handler_factory(Some(&cs(&scheme)), Some(&cs("")), None);
            }
        }
        "setSpellCheckerLanguages" | "addWordToSpellCheckerDictionary" => {}
        "resolveProxy" => {
            let url = args
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            return call.ok(json!({ "result": crate::proxy::resolve(&url) }));
        }
        other => {
            return call.err(
                "unsupported",
                format!("session.op {other} is not implemented by this shell"),
            );
        }
    }
    call.ok(json!({}));
}

/// A page of a partition whose user agent was set (`session.setUserAgent`) gets it as soon as its browser exists.
pub fn apply_user_agent(wc_id: u64) {
    let Some(entry) = state::wc(wc_id) else {
        return;
    };
    let partition = entry.borrow().partition.clone();
    let Some((ua, languages)) = with(|s| s.user_agents.get(&partition).cloned()) else {
        return;
    };
    let mut params = json!({ "userAgent": ua });
    if let Some(l) = languages {
        params["acceptLanguage"] = json!(l);
    }
    crate::cdp::send(
        wc_id,
        "Emulation.setUserAgentOverride",
        Some(params),
        None,
        move |result| {
            if let Err((code, message)) = result {
                log(
                    "session.user_agent_failed",
                    json!({ "wcId": wc_id, "code": code, "message": message }),
                );
            }
        },
    );
    entry.borrow_mut().state.user_agent = ua;
    crate::wc::push_state(wc_id);
}
