//! Sessions (PROTOCOL.md §6): a partition is a CEF request context. `""` and `app` are the global context (it
//! shares `<userData>/shell-webview` with the app's page), a name is in memory, `persist:<name>` lives in
//! `<userData>/shell-webview/Partitions/<name>`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
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
    /// What `setSpellCheckerLanguages` set, by partition (normalised).
    spell: HashMap<String, Vec<String>>,
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

/// The profile folder of a `persist:<name>` partition (`None` for any other partition).
fn persist_dir(partition: &str) -> Option<PathBuf> {
    let name = partition.strip_prefix("persist:")?;
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
    Some(state::paths().web_dir.join("Partitions").join(safe))
}

/// Where Chromium keeps `partition`'s HTTP cache: the app's profile is `<root_cache_path>/Default`, a `persist:`
/// partition's is its own folder; an in-memory partition has none.
fn cache_path(partition: &str) -> Option<String> {
    let profile = if is_app(partition) {
        state::paths().web_dir.join("Default")
    } else {
        persist_dir(partition)?
    };
    Some(profile.join("Cache").display().to_string())
}

/// The request context of `partition` (UI thread); `None` is the global context.
pub fn context_for(partition: &str) -> Option<RequestContext> {
    if is_app(partition) {
        return None;
    }
    if let Some(existing) = ui_state(|u| u.contexts.get(partition).cloned()) {
        return Some(existing);
    }
    let cache_path = persist_dir(partition)
        .map(|dir| dir.display().to_string())
        .unwrap_or_default();
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

/// A page of `partition` that has its browser (UI thread): for `app`, the first window's page.
fn page_of(partition: &str) -> Option<(u64, Browser)> {
    ui_state(|u| {
        u.wcs
            .iter()
            .filter_map(|(id, entry)| {
                let e = entry.borrow();
                let same = if is_app(partition) {
                    is_app(&e.partition)
                } else {
                    e.partition == partition
                };
                if !same || e.closing {
                    return None;
                }
                e.browser.clone().map(|b| (*id, b))
            })
            .min_by_key(|(id, _)| *id)
    })
}

fn set_pref(context: &RequestContext, name: &str, mut value: Value2) -> Result<(), String> {
    let mut error = CefString::default();
    if context.set_preference(Some(&cs(name)), Some(&mut value), Some(&mut error)) == 0 {
        return Err(format!("{name} was refused: {error}"));
    }
    Ok(())
}

fn string_list_value(items: &[String]) -> Option<Value2> {
    let mut list = list_value_create()?;
    for (index, item) in items.iter().enumerate() {
        list.set_string(index, Some(&cs(item)));
    }
    let value = value_create()?;
    value.set_list(Some(&mut list));
    Some(value)
}

/// The spellchecker languages of `partition`: what was set, else (the app's profile) what Chromium's preference
/// holds, else none.
fn spell_languages(partition: &str) -> Vec<String> {
    if let Some(set) = with(|s| s.spell.get(partition).cloned()) {
        return set;
    }
    if !is_app(partition) {
        return Vec::new();
    }
    let Some(list) = request_context_get_global_context()
        .and_then(|c| c.preference(Some(&cs("spellcheck.dictionaries"))))
        .and_then(|v| v.list())
    else {
        return Vec::new();
    };
    (0..list.size())
        .map(|i| CefString::from(&list.string(i)).to_string())
        .filter(|code| !code.is_empty())
        .collect()
}

/// Chromium's `spellcheck.dictionaries` (and the switch that turns checking on) for the requested languages.
fn set_spell_languages(partition: &str, requested: &[String]) -> Result<(), String> {
    let languages = shell_core::spell::normalize(requested);
    let context = context_or_global(partition).ok_or("no request context")?;
    let list = string_list_value(&languages).ok_or("could not build the language list")?;
    set_pref(&context, "spellcheck.dictionaries", list)?;
    if let Some(on) = value_create() {
        on.set_bool(i32::from(!languages.is_empty()));
        // Not every profile registers it (a Chrome-style in-memory one may not): the dictionaries are what count.
        let _ = set_pref(&context, "browser.enable_spellchecking", on);
    }
    with(|s| s.spell.insert(partition.to_string(), languages));
    Ok(())
}

/// `clearCache` (and with `cookies`, `clearStorageData`) of the app's profile. Chromium keeps the profile's HTTP cache
/// and cookies behind the app page's DevTools `Network` domain, so that is asked first; with no page yet the global
/// context (which IS the app profile, unlike the Preview's custom contexts) is cleared directly. Local Storage is
/// never touched: the app keeps its state in it.
fn clear_app(call: Call, cookies: bool) {
    let Some((wc_id, _)) = page_of("app") else {
        if let Some(context) = request_context_get_global_context() {
            if cookies && let Some(manager) = context.cookie_manager(None) {
                manager.delete_cookies(None, None, None);
            }
            context.clear_http_cache(None);
        }
        return call.ok(json!({}));
    };
    crate::cdp::send(wc_id, "Network.clearBrowserCache", None, None, move |r| {
        if let Err((_, message)) = r {
            return call.err(
                "failed",
                format!("clearing the HTTP cache failed: {message}"),
            );
        }
        if !cookies {
            return call.ok(json!({}));
        }
        crate::cdp::send(
            wc_id,
            "Network.clearBrowserCookies",
            None,
            None,
            move |r| match r {
                Ok(_) => call.ok(json!({})),
                Err((_, message)) => {
                    call.err("failed", format!("clearing cookies failed: {message}"))
                }
            },
        );
    });
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
            "spellCheckerLanguages": spell_languages(&partition),
            "availableSpellCheckerLanguages": shell_core::spell::AVAILABLE,
            "cachePath": cache_path(&partition),
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
        "clearCache" | "clearStorageData" if is_app(partition) => {
            return clear_app(call, name == "clearStorageData");
        }
        "clearCache" | "clearStorageData" if !partition.starts_with("persist:") => {
            // An in-memory partition keeps nothing past its pages (clearing a Chrome-style in-memory context ends the
            // process).
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
        "setSpellCheckerLanguages" => {
            let requested: Vec<String> = args
                .get("languages")
                .and_then(Value::as_array)
                .map(|l| {
                    l.iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            if let Err(message) = set_spell_languages(partition, &requested) {
                return call.err("failed", format!("the spellchecker languages: {message}"));
            }
        }
        "addWordToSpellCheckerDictionary" => {
            let word = args
                .get("word")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if word.is_empty() {
                return call.err("invalid", "no word to add");
            }
            let Some(host) = page_of(partition).and_then(|(_, b)| b.host()) else {
                return call.err("failed", "no page of this session to add the word through");
            };
            host.add_word_to_dictionary(Some(&cs(word)));
        }
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
