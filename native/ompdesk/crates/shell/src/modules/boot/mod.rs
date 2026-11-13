//! `boot.*` (PROTOCOL.md §15.9, batch SX5): what main's `index.ts` wired to Electron at start. `omp-media://` served
//! from disk, keep-awake's blockers with the lid policy that keeps a charging laptop awake while work runs, the power
//! and network events main reacts to, the app's theme over the OS's, the global shortcut, the resolver main's
//! reachability probe asks, and main's text: the UI language and the table Node's `mainT` reads.

mod lid;
mod media;

use serde_json::{Value, json};
use shell_core::boot_core::text::{self, Lang};
use shell_core::desk_state::ThemeSource;
use shell_core::labels;

use super::{Ctx, Module};
use crate::host::Call;

pub struct Boot;

const CTX: Ctx = Ctx { namespace: "boot" };

/// `power.rs`: a power event (`suspend`, `resume`, `lock-screen`, `unlock-screen`, `on-ac`, `on-battery`,
/// `shutdown`). UI thread.
pub fn power(name: &str) {
    CTX.emit("power", json!({ "name": name }));
    match name {
        "on-ac" => lid::on_ac(true),
        "on-battery" => lid::on_ac(false),
        _ => {}
    }
}

/// `system.rs`'s network poll: Chromium's link state changed.
pub fn online(online: bool) {
    CTX.emit("online", json!({ "online": online }));
}

/// `shortcut.rs`: a registered global shortcut fired. UI thread.
pub fn shortcut(accelerator: &str) {
    CTX.emit("shortcut", json!({ "accelerator": accelerator }));
}

/// Node's blocker id as the key `power.rs` and the lid policy hold it under.
fn blocker_id(data: &Value) -> Option<String> {
    data.get("id")
        .and_then(Value::as_u64)
        .map(|id| id.to_string())
}

/// Chooses the UI language (`stored`: the person's `language` pref, else the app locale), for the shell's labels and
/// Node's copy of the table (`boot.labels`, which carries both languages, as `mainT` may ask for either, and the locale
/// facts Node's `deviceLanguage` reads).
fn choose_language(stored: Option<&str>) {
    let locale = crate::state::FACTS
        .get()
        .map(|facts| facts["locale"].clone())
        .unwrap_or(Value::Null);
    let app_locale = locale["appLocale"].as_str().unwrap_or("en-US");
    let lang = Lang::chosen(stored, app_locale);
    labels::set_language(lang);
    CTX.emit(
        "labels",
        json!({
            "language": lang.as_str(),
            "text": &*text::TABLE_JSON,
            "appLocale": app_locale,
            "preferredLanguages": locale["preferredLanguages"].as_array().cloned().unwrap_or_default(),
        }),
    );
}

/// The `language` pref as electron-store keeps it (`<userData>/prefs.json`).
fn stored_language() -> Option<String> {
    let user_data = crate::state::FACTS.get()?["paths"]["userData"].as_str()?;
    text::stored_language(
        &std::fs::read_to_string(std::path::Path::new(user_data).join("prefs.json")).ok()?,
    )
}

impl Module for Boot {
    fn namespace(&self) -> &'static str {
        "boot"
    }

    fn ready(&self, ctx: Ctx) {
        // Node's mirrors of the text and of `online` start here: these arrive before `app.ready`.
        choose_language(stored_language().as_deref());
        media::register();
        lid::start(ctx);
        online(crate::system::online());
    }

    fn shutdown(&self, _ctx: Ctx) {
        lid::stop();
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
                    let registered = crate::shortcut::register(&accelerator);
                    call.ok(json!({ "registered": registered }));
                });
            }
            "awakeState" => crate::ui::run(move || {
                let held = crate::power::held();
                lid::query(move |lid_held| call.ok(json!({ "held": held, "lidHeld": lid_held })));
            }),
            "themeSource" => {
                let Some(source) = call.str("source").as_deref().and_then(ThemeSource::parse)
                else {
                    return call.err(
                        "invalid",
                        "boot.themeSource: source must be system, light or dark",
                    );
                };
                // `theme.changed` goes out before the answer, so Node's `nativeTheme` mirror agrees when it resumes.
                crate::ui::run(move || {
                    crate::theme::set_source(source);
                    call.ok(json!({}));
                });
            }
            // The person changed the UI language (or cleared it: `null` follows the locale). `boot.labels` goes out
            // before the answer, so Node's `mainT` already speaks it when the call resolves.
            "language" => {
                choose_language(call.params.get("language").and_then(Value::as_str));
                call.ok(json!({}));
            }
            _ => call.unsupported(),
        }
    }

    fn event(&self, ctx: Ctx, name: &str, data: Value, _bin: Option<Vec<u8>>) {
        match name.strip_prefix("boot.").unwrap_or_default() {
            "mediaRelease" => media::release(&data),
            "mediaReleaseOwner" => media::release_owner(&data),
            "awakeStart" => {
                let Some(id) = blocker_id(&data) else { return };
                lid::blocker(&id, true);
                crate::ui::run(move || {
                    if let Err(error) = crate::power::hold(id) {
                        log_blocker_failure(ctx, "start", &error);
                    }
                });
            }
            "awakeStop" => {
                let Some(id) = blocker_id(&data) else { return };
                lid::blocker(&id, false);
                crate::ui::run(move || {
                    if let Err(error) = crate::power::release(&id) {
                        log_blocker_failure(ctx, "stop", &error);
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

fn log_blocker_failure(ctx: Ctx, step: &str, error: &str) {
    ctx.runtime_log(
        json!({ "source": "keep-awake", "message": "failed", "details": { "step": step, "error": error } }),
        None,
    );
}
