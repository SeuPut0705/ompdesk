//! Native boot, power and media coordinators. The temporary Module/Call boundary delegates here; neither a Node
//! connection nor a label mirror owns the state. Base initializes this on the CEF UI thread before other domains.

mod lid;
pub mod media;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use shell_core::boot_core::text::{self, Lang};
use shell_core::desk_state::ThemeSource;
use shell_core::labels;

use super::{Ctx, Module};
use crate::host::Call;

pub struct Boot;

#[derive(Clone)]
pub struct Hooks {
    pub log: Arc<dyn Fn(Value) + Send + Sync>,
    pub emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
}

pub struct Config {
    pub user_data: PathBuf,
    pub app_locale: String,
    pub preferred_languages: Vec<String>,
    pub language: Option<String>,
    pub on_ac: bool,
}

struct Runtime {
    config: Config,
    hooks: Hooks,
}

enum State {
    New,
    Running(Runtime),
    Stopped,
}

static STATE: Mutex<State> = Mutex::new(State::New);
static BLOCKERS: Mutex<BTreeSet<u64>> = Mutex::new(BTreeSet::new());

/// Once on the UI thread, after Base sets native paths/facts and before app pages are made.
pub fn start(config: Config, hooks: Hooks) -> Result<(), String> {
    {
        let mut state = STATE.lock().unwrap();
        if !matches!(*state, State::New) {
            return Err("boot is already started or stopped".into());
        }
        *state = State::Running(Runtime {
            config,
            hooks: hooks.clone(),
        });
    }
    let result = (|| {
        media::register()?;
        let state = STATE.lock().unwrap();
        let State::Running(runtime) = &*state else {
            return Err("boot is stopped".into());
        };
        let user_data = runtime.config.user_data.clone();
        let on_ac = runtime.config.on_ac;
        let language = runtime.config.language.clone();
        drop(state);
        lid::start_with(
            &user_data,
            on_ac,
            Box::new(move |message, details| {
                (hooks.log)(
                    json!({ "source": "keep-awake", "message": message, "details": details }),
                );
            }),
        )
        .map_err(|error| error.to_string())?;
        set_language(language.as_deref());
        online(crate::system::online());
        Ok(())
    })();
    if result.is_err() {
        stop();
    }
    result
}

/// UI thread, before core drain and CEF shutdown. Stops new events/capabilities, releases open media bodies and
/// every boot-owned blocker, then lets the platform lid backend settle.
pub fn stop() {
    let previous = std::mem::replace(&mut *STATE.lock().unwrap(), State::Stopped);
    media::stop();
    lid::stop();
    crate::shortcut::unregister_all();
    let ids = std::mem::take(&mut *BLOCKERS.lock().unwrap());
    for id in ids {
        if let Err(error) = crate::power::release(&id.to_string())
            && let State::Running(runtime) = &previous
        {
            (runtime.hooks.log)(failure("stop", &error));
        }
    }
}

fn hooks() -> Option<Hooks> {
    match &*STATE.lock().unwrap() {
        State::Running(runtime) => Some(runtime.hooks.clone()),
        State::New | State::Stopped => None,
    }
}

fn emit(name: &str, data: Value) {
    if let Some(hooks) = hooks() {
        (hooks.emit)(name, data);
    }
}

/// Native power notifications enter here even when no page or Node receiver exists.
pub fn power(name: &str) {
    match name {
        "on-ac" => lid::on_ac(true),
        "on-battery" => lid::on_ac(false),
        _ => {}
    }
    emit("boot.power", json!({ "name": name }));
}

pub fn online(online: bool) {
    emit("boot.online", json!({ "online": online }));
}

pub fn shortcut(accelerator: &str) {
    emit("boot.shortcut", json!({ "accelerator": accelerator }));
}

/// UI thread. Base resolves the theme preference before any window is made.
pub fn theme_source(source: ThemeSource) {
    crate::theme::set_source(source);
}

pub fn register_shortcut(accelerator: &str) -> bool {
    crate::shortcut::register(accelerator)
}

/// Native callers use the same resolver as the temporary wire adapter. CEF lookups are asynchronous; disallowed
/// cache usage keeps the OS worker and its deadline. The callback may run off the UI thread.
pub fn resolve_host(
    host: String,
    usage: shell_core::netmap::CacheUsage,
    answer: crate::net::ResolveAnswer,
) {
    crate::net::resolve_host_native(host, usage, answer);
}

/// The native language is authoritative; emitting boot.labels only updates consumers.
pub fn set_language(stored: Option<&str>) {
    let (app_locale, preferred_languages, hooks) = {
        let state = STATE.lock().unwrap();
        let State::Running(runtime) = &*state else {
            return;
        };
        (
            runtime.config.app_locale.clone(),
            runtime.config.preferred_languages.clone(),
            runtime.hooks.clone(),
        )
    };
    let language = Lang::chosen(stored, &app_locale);
    labels::set_language(language);
    (hooks.emit)(
        "boot.labels",
        json!({
            "language": language.as_str(),
            "text": &*text::TABLE_JSON,
            "appLocale": app_locale,
            "preferredLanguages": preferred_languages,
        }),
    );
}

/// UI thread. The same ids aggregate local and hosted work; repeated starts/stops are idempotent.
pub fn awake_start(id: u64) -> Result<(), String> {
    if hooks().is_none() {
        return Err("boot is not running".into());
    }
    BLOCKERS.lock().unwrap().insert(id);
    crate::power::hold(id.to_string())?;
    lid::blocker(&id.to_string(), true);
    Ok(())
}

pub fn awake_stop(id: u64) -> Result<(), String> {
    if hooks().is_none() {
        return Err("boot is not running".into());
    }
    crate::power::release(&id.to_string())?;
    BLOCKERS.lock().unwrap().remove(&id);
    lid::blocker(&id.to_string(), false);
    Ok(())
}

pub fn awake_state(answer: impl FnOnce(bool, bool) + Send + 'static) {
    let held = crate::power::held();
    lid::query(move |lid_held| answer(held, lid_held));
}

fn failure(step: &str, error: &str) -> Value {
    json!({ "source": "keep-awake", "message": "failed", "details": { "step": step, "error": error } })
}

impl Module for Boot {
    fn namespace(&self) -> &'static str {
        "boot"
    }

    fn ready(&self, ctx: Ctx) {
        let Some(facts) = crate::state::FACTS.get() else {
            return crate::log::log(
                "boot.start_failed",
                json!({ "error": "native facts unavailable" }),
            );
        };
        let Some(user_data) = facts["paths"]["userData"].as_str() else {
            return crate::log::log(
                "boot.start_failed",
                json!({ "error": "userData unavailable" }),
            );
        };
        let language = std::fs::read_to_string(PathBuf::from(user_data).join("prefs.json"))
            .ok()
            .and_then(|prefs| text::stored_language(&prefs));
        let config = Config {
            user_data: user_data.into(),
            app_locale: facts["locale"]["appLocale"]
                .as_str()
                .unwrap_or("en-US")
                .into(),
            preferred_languages: facts["locale"]["preferredLanguages"]
                .as_array()
                .map(|languages| {
                    languages
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            language,
            on_ac: !crate::system::on_battery(),
        };
        let hooks = Hooks {
            log: Arc::new(move |line| ctx.runtime_log(line, None)),
            emit: Arc::new(move |name, data| {
                ctx.emit(name.strip_prefix("boot.").unwrap_or(name), data)
            }),
        };
        if let Err(error) = start(config, hooks) {
            crate::log::log("boot.start_failed", json!({ "error": error }));
        }
    }

    fn shutdown(&self, _ctx: Ctx) {
        stop();
    }

    fn request(&self, _ctx: Ctx, call: Call) {
        match call.method.strip_prefix("boot.").unwrap_or_default() {
            "mediaOpen" => media::open(call),
            "mediaHead" => media::head(call),
            "mediaRead" => media::read(call),
            "resolveHost" => crate::net::resolve_host(call),
            "registerShortcut" => {
                let Some(accelerator) = call.str("accelerator") else {
                    return call.err("invalid", "boot.registerShortcut needs an accelerator");
                };
                crate::ui::run(move || {
                    call.ok(json!({ "registered": register_shortcut(&accelerator) }))
                });
            }
            "awakeState" => crate::ui::run(move || {
                awake_state(move |held, lid_held| {
                    call.ok(json!({ "held": held, "lidHeld": lid_held }))
                });
            }),
            "themeSource" => {
                let Some(source) = call.str("source").as_deref().and_then(ThemeSource::parse)
                else {
                    return call.err(
                        "invalid",
                        "boot.themeSource: source must be system, light or dark",
                    );
                };
                crate::ui::run(move || {
                    theme_source(source);
                    call.ok(json!({}));
                });
            }
            "language" => {
                set_language(call.params.get("language").and_then(Value::as_str));
                call.ok(json!({}));
            }
            _ => call.unsupported(),
        }
    }

    fn event(&self, _ctx: Ctx, name: &str, data: Value, _bin: Option<Vec<u8>>) {
        match name.strip_prefix("boot.").unwrap_or_default() {
            "mediaRelease" => media::release(&data),
            "mediaReleaseOwner" => media::release_owner(&data),
            "awakeStart" | "awakeStop" => {
                let Some(id) = data.get("id").and_then(Value::as_u64) else {
                    return;
                };
                let starting = name.ends_with("awakeStart");
                crate::ui::run(move || {
                    let result = if starting {
                        awake_start(id)
                    } else {
                        awake_stop(id)
                    };
                    if let Err(error) = result
                        && let Some(hooks) = hooks()
                    {
                        (hooks.log)(failure(if starting { "start" } else { "stop" }, &error));
                    }
                });
            }
            other => crate::log::log(
                "host.event_ignored",
                json!({ "event": format!("boot.{other}") }),
            ),
        }
    }
}
