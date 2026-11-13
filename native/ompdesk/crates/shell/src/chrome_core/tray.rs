//! The tray's rules (were `src/main/tray.ts` and the menu functions of `tray-labels.ts`): the menu (Open/Hide, one
//! update item that follows the updater, Quit: the user's decision of 29 Oct 2026), its signature, the hover text and
//! when the installed menu is replaced. `modules/chrome/tray.rs` owns the icon and carries the effects out;
//! `captured/tray.json` holds the TypeScript's own answers. `TRAY_LABELS` stays in Node (PROTOCOL.md §15.4 rule 2) and
//! arrives as `tray.<key>` through `labels`.

use serde_json::Value;

use super::menu::Text;
use crate::menu_model::{Item, Kind};

/// How long a finished check that found nothing keeps saying "up to date" before the item offers a check again.
pub const UP_TO_DATE_MS: u64 = 30_000;

/// What the update item does when chosen; none when it only reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateAction {
    Check,
    Download,
    Install,
}

impl UpdateAction {
    /// The name `tray-labels.ts` gave it (its signature and tests use it).
    pub fn name(self) -> &'static str {
        match self {
            UpdateAction::Check => "check",
            UpdateAction::Download => "download",
            UpdateAction::Install => "install",
        }
    }

    /// `chrome.updateAction`'s name for it: the client runs `checkForUpdate`, `downloadUpdate` or `applyUpdate`.
    pub fn wire(self) -> &'static str {
        match self {
            UpdateAction::Install => "apply",
            other => other.name(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateItem {
    pub label: String,
    pub action: Option<UpdateAction>,
}

/// What the renderer reports for the hover text (`TrayState`): the status shown is the aggregate over all windows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayState {
    pub status: String,
    pub project_name: String,
}

impl TrayState {
    pub fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            status: value.get("status")?.as_str()?.to_string(),
            project_name: value.get("projectName")?.as_str()?.to_string(),
        })
    }
}

/// The text key of a run status; a status this build does not know reads as idle (the TypeScript threw: main only
/// pushes an aggregate it knows).
fn status_key(status: &str) -> &'static str {
    match status {
        "streaming" => "tray.statusStreaming",
        "question" => "tray.statusQuestion",
        "approval" => "tray.statusApproval",
        "childWaiting" => "tray.statusChildWaiting",
        "error" => "tray.statusError",
        _ => "tray.statusIdle",
    }
}

/// Which run state to show; the aggregate across windows, never per window.
pub fn status_label(text: Text, status: &str) -> String {
    text(status_key(status), &[])
}

/// Hover text: the icon itself stays a static template mark by design.
pub fn tooltip(text: Text, state: Option<&TrayState>) -> String {
    match state {
        None => "OMPdesk".to_string(),
        Some(state) => format!(
            "OMPdesk — {} · {}",
            state.project_name,
            status_label(text, &state.status)
        ),
    }
}

fn number(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// The update item for the updater's state (`UpdateStatus`). `up_to_date_shown` is whether a finished "no update"
/// check is still announced; after that the item offers a check again.
pub fn update_item(text: Text, status: &Value, up_to_date_shown: bool) -> UpdateItem {
    let state = status.get("state").and_then(Value::as_str).unwrap_or("");
    let version = status
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let flag = |key: &str| status.get(key).and_then(Value::as_bool).unwrap_or(false);
    let manual = status.get("mode").and_then(Value::as_str) == Some("manual");
    let with = |key: &str, action| UpdateItem {
        label: text(key, &[("version", version)]),
        action,
    };
    let check = || UpdateItem {
        label: text("tray.updateCheck", &[]),
        action: Some(UpdateAction::Check),
    };
    match state {
        "checking" => UpdateItem {
            label: text("tray.updateChecking", &[]),
            action: None,
        },
        "available" if manual => with("tray.updateDownload", Some(UpdateAction::Download)),
        "available" => with("tray.updateDownloading", None),
        "downloading" => UpdateItem {
            label: text(
                "tray.updateDownloadingPercent",
                &[
                    ("version", version),
                    ("percent", &number(status.get("percent"))),
                ],
            ),
            action: None,
        },
        "downloaded" if flag("installing") => with("tray.updateInstalling", None),
        "downloaded" if manual => with("tray.updateOpenInstaller", Some(UpdateAction::Install)),
        "downloaded" => with("tray.updateRestart", Some(UpdateAction::Install)),
        "not-available" if up_to_date_shown => UpdateItem {
            label: text("tray.updateUpToDate", &[]),
            action: None,
        },
        "not-available" => check(),
        "error" => UpdateItem {
            label: text("tray.updateFailed", &[]),
            action: Some(UpdateAction::Check),
        },
        _ => check(),
    }
}

/// Everything the menu is built from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuInput {
    pub lang: String,
    pub window_visible: bool,
    pub update: UpdateItem,
}

pub const ITEM_TOGGLE: &str = "tray:toggle";
pub const ITEM_UPDATE: &str = "tray:update";
pub const ITEM_QUIT: &str = "tray:quit";

fn plain(id: &str, label: String) -> Item {
    Item {
        id: id.to_string(),
        label,
        kind: Kind::Normal,
        enabled: true,
        visible: true,
        checked: false,
        accelerator: None,
        sublabel: None,
        tool_tip: None,
        role: None,
        submenu: Vec::new(),
    }
}

/// The whole tray menu: show/hide, the update item, Quit.
pub fn menu_template(input: &MenuInput, text: Text) -> Vec<Item> {
    let toggle = if input.window_visible {
        "tray.hide"
    } else {
        "tray.open"
    };
    vec![
        plain(ITEM_TOGGLE, text(toggle, &[])),
        Item {
            enabled: input.update.action.is_some(),
            ..plain(ITEM_UPDATE, input.update.label.clone())
        },
        Item {
            kind: Kind::Separator,
            ..plain("", String::new())
        },
        plain(ITEM_QUIT, text("tray.quit", &[])),
    ]
}

/// Everything a rebuilt menu can differ in, as one string: a push that changes none of it must not swap the menu.
pub fn menu_signature(input: &MenuInput) -> String {
    [
        input.lang.as_str(),
        if input.window_visible {
            "true"
        } else {
            "false"
        },
        input.update.label.as_str(),
        input.update.action.map_or("—", UpdateAction::name),
    ]
    .join("\u{2}")
}

/// What the toggle item (and a click on the icon) does to the target window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Toggle {
    Hide,
    Show,
    /// There is no window: open one.
    Spawn,
}

/// Targets the focused window, not the first-created one, so the toggle acts on the window the user is looking at.
pub fn toggle(target: Option<bool>) -> Toggle {
    match target {
        None => Toggle::Spawn,
        Some(true) => Toggle::Hide,
        Some(false) => Toggle::Show,
    }
}

/// A click on the icon always brings the window back.
pub fn click(has_target: bool) -> Toggle {
    if has_target {
        Toggle::Show
    } else {
        Toggle::Spawn
    }
}

/// What the module reads from the world each time the model decides something.
pub struct Env<'a> {
    pub lang: &'a str,
    pub text: Text<'a>,
    pub window_visible: bool,
    /// A monotonic clock in milliseconds.
    pub now_ms: u64,
}

/// What the module must do after the model moved.
#[derive(Debug, Default, PartialEq)]
pub struct Effects {
    pub tooltip: Option<String>,
    pub menu: Option<Vec<Item>>,
    /// Call `timer_fired(generation)` after this many milliseconds.
    pub timer: Option<(u64, u64)>,
}

/// The tray's state machine: the renderer's snapshot, the updater's status, and what the installed menu shows. The
/// menu is installed again only when a label a user can read changed, and never while it is open.
#[derive(Debug)]
pub struct Model {
    state: Option<TrayState>,
    update: Value,
    /// The label set the installed menu renders, and what its update item does (the menu a person is looking at, not
    /// the one a later status would build).
    installed: Option<String>,
    installed_action: Option<UpdateAction>,
    menu_open: bool,
    tooltip: String,
    up_to_date_since: Option<u64>,
    timer: u64,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            state: None,
            update: serde_json::json!({ "state": "idle" }),
            installed: None,
            installed_action: None,
            menu_open: false,
            tooltip: "OMPdesk".to_string(),
            up_to_date_since: None,
            timer: 0,
        }
    }
}

impl Model {
    fn up_to_date_shown(&self, now_ms: u64) -> bool {
        self.up_to_date_since
            .is_some_and(|since| now_ms.saturating_sub(since) < UP_TO_DATE_MS)
    }

    fn input(&self, env: &Env) -> MenuInput {
        MenuInput {
            lang: env.lang.to_string(),
            window_visible: env.window_visible,
            update: update_item(env.text, &self.update, self.up_to_date_shown(env.now_ms)),
        }
    }

    /// The menu as it would be built now.
    pub fn menu(&self, env: &Env) -> Vec<Item> {
        menu_template(&self.input(env), env.text)
    }

    fn install(&mut self, env: &Env) -> Vec<Item> {
        let input = self.input(env);
        self.installed = Some(menu_signature(&input));
        self.installed_action = input.update.action;
        menu_template(&input, env.text)
    }

    /// What choosing the installed menu's update item runs.
    pub fn installed_action(&self) -> Option<UpdateAction> {
        self.installed_action
    }

    /// The tray was made: the hover text and the first menu (a snapshot may have come before the words did).
    pub fn create(&mut self, env: &Env) -> Effects {
        self.tooltip = tooltip(env.text, self.state.as_ref());
        Effects {
            tooltip: Some(self.tooltip.clone()),
            menu: Some(self.install(env)),
            timer: None,
        }
    }

    /// The menu replaced by a fresh one when what a person can read changed (and it is not open).
    pub fn refresh(&mut self, env: &Env) -> Effects {
        if self.menu_open {
            return Effects::default();
        }
        let signature = menu_signature(&self.input(env));
        if self.installed.as_deref() == Some(signature.as_str()) {
            return Effects::default();
        }
        Effects {
            menu: Some(self.install(env)),
            ..Effects::default()
        }
    }

    /// The renderer pushed a fresh snapshot. Hover text tracks the status; the menu is rebuilt only when a label a
    /// user can read changed, so the per-append session refresh stops swapping menus.
    pub fn set_state(&mut self, state: Option<TrayState>, env: &Env) -> Effects {
        self.state = state;
        let next = tooltip(env.text, self.state.as_ref());
        let mut effects = self.refresh(env);
        if next != self.tooltip {
            self.tooltip = next.clone();
            effects.tooltip = Some(next);
        }
        effects
    }

    /// The UI language changed: the hover text and the menu are worded again.
    pub fn relabel(&mut self, env: &Env) -> Effects {
        let state = self.state.clone();
        self.set_state(state, env)
    }

    /// The updater's status changed.
    pub fn set_update(&mut self, status: Value, env: &Env) -> Effects {
        self.timer += 1;
        let mut timer = None;
        if status.get("state").and_then(Value::as_str) == Some("not-available") {
            self.up_to_date_since = Some(env.now_ms);
            // A little after the notice ran out, so the item offers a check again.
            timer = Some((self.timer, UP_TO_DATE_MS + 50));
        } else {
            self.up_to_date_since = None;
        }
        self.update = status;
        Effects {
            timer,
            ..self.refresh(env)
        }
    }

    /// The timer `set_update` asked for ran out; a later status made it stale.
    pub fn timer_fired(&mut self, generation: u64, env: &Env) -> Effects {
        if generation != self.timer {
            return Effects::default();
        }
        self.refresh(env)
    }

    pub fn menu_opened(&mut self) {
        self.menu_open = true;
    }

    /// The menu closed: whatever changed meanwhile is installed now.
    pub fn menu_closed(&mut self, env: &Env) -> Effects {
        self.menu_open = false;
        self.refresh(env)
    }

    /// Drops what the menu shows (the tray went away).
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;
    use crate::chrome_core::captured::of;

    fn tables() -> HashMap<String, HashMap<String, String>> {
        let step = &of("tray", "src/main/tray-labels.ts#labels")[0];
        serde_json::from_value(step.output.clone()).expect("a table per language")
    }

    fn text_for<'a>(
        tables: &'a HashMap<String, HashMap<String, String>>,
        lang: &str,
    ) -> impl Fn(&str, &[(&str, &str)]) -> String + 'a {
        let table = &tables[lang];
        move |key, params| {
            crate::labels::fill(
                table.get(key).unwrap_or_else(|| panic!("no label {key}")),
                params,
            )
        }
    }

    fn action_of(value: &Value) -> Option<UpdateAction> {
        match value.as_str()? {
            "check" => Some(UpdateAction::Check),
            "download" => Some(UpdateAction::Download),
            "install" => Some(UpdateAction::Install),
            other => panic!("unknown action {other}"),
        }
    }

    #[test]
    fn the_status_names_are_the_typescripts() {
        let tables = tables();
        for step in of("tray", "src/main/tray-labels.ts#statusLabel") {
            let text = text_for(&tables, step.input["lang"].as_str().unwrap());
            assert_eq!(
                status_label(&text, step.input["status"].as_str().unwrap()),
                step.output.as_str().unwrap(),
                "{}",
                step.input
            );
        }
    }

    #[test]
    fn the_update_item_is_the_typescripts_for_every_updater_state() {
        let tables = tables();
        let steps = of("tray", "src/main/tray-labels.ts#trayUpdateItem");
        assert_eq!(steps.len(), 72);
        for step in steps {
            let text = text_for(&tables, step.input["lang"].as_str().unwrap());
            let item = update_item(
                &text,
                &step.input["status"],
                step.input["upToDateShown"].as_bool().unwrap(),
            );
            assert_eq!(
                item.label,
                step.output["label"].as_str().unwrap(),
                "{}",
                step.input
            );
            assert_eq!(
                item.action,
                action_of(&step.output["action"]),
                "{}",
                step.input
            );
        }
    }

    fn menu_input(input: &Value) -> MenuInput {
        let update = &input["update"];
        MenuInput {
            lang: input["lang"].as_str().unwrap().to_string(),
            window_visible: input["windowVisible"].as_bool().unwrap(),
            update: UpdateItem {
                label: update["label"].as_str().unwrap().to_string(),
                action: action_of(&update["action"]),
            },
        }
    }

    #[test]
    fn the_menu_is_open_hide_the_update_item_a_separator_and_quit() {
        let tables = tables();
        let steps = of("tray", "src/main/tray-labels.ts#trayMenuTemplate");
        assert_eq!(steps.len(), 72);
        for step in steps {
            let text = text_for(&tables, step.input["lang"].as_str().unwrap());
            let input = menu_input(&step.input);
            let items = menu_template(&input, &text);
            let seen: Vec<Value> = items
                .iter()
                .map(|item| {
                    let separator = item.kind == Kind::Separator;
                    // A separator has no label in the TypeScript's template.
                    json!({
                        "label": if separator { Value::Null } else { json!(item.label) },
                        "type": if separator { "separator" } else { "normal" },
                        "enabled": item.enabled,
                    })
                })
                .collect();
            assert_eq!(Value::Array(seen), step.output["items"], "{}", step.input);
            // What pressing each item runs: the toggle, the update item's action (none when it only reports), quit.
            let pressed: Vec<Vec<String>> = items
                .iter()
                .map(|item| match item.id.as_str() {
                    ITEM_TOGGLE => vec!["toggleWindow".into()],
                    ITEM_UPDATE if item.enabled => {
                        vec![format!("update:{}", input.update.action.unwrap().name())]
                    }
                    ITEM_QUIT => vec!["quit".into()],
                    _ => vec![],
                })
                .collect();
            assert_eq!(json!(pressed), step.output["pressed"], "{}", step.input);
        }
    }

    #[test]
    fn the_signature_is_the_typescripts() {
        let steps = of("tray", "src/main/tray-labels.ts#menuSignature");
        assert_eq!(steps.len(), 72);
        for step in steps {
            assert_eq!(
                menu_signature(&menu_input(&step.input)),
                step.output.as_str().unwrap(),
                "{}",
                step.input
            );
        }
    }

    #[test]
    fn the_signature_holds_still_for_an_unchanged_state_and_changes_with_what_a_user_can_read() {
        let base = MenuInput {
            lang: "en".into(),
            window_visible: true,
            update: UpdateItem {
                label: "Check for updates".into(),
                action: Some(UpdateAction::Check),
            },
        };
        let signature = menu_signature(&base);
        assert_eq!(menu_signature(&base.clone()), signature);
        let hidden = MenuInput {
            window_visible: false,
            ..base.clone()
        };
        assert_ne!(menu_signature(&hidden), signature);
        let korean = MenuInput {
            lang: "ko".into(),
            ..base.clone()
        };
        assert_ne!(menu_signature(&korean), signature);
        let percent = |p: &str| MenuInput {
            update: UpdateItem {
                label: format!("Downloading v1.2.3… {p}%"),
                action: None,
            },
            ..base.clone()
        };
        assert_ne!(menu_signature(&percent("1")), menu_signature(&percent("2")));
        assert_ne!(menu_signature(&percent("1")), signature);
    }

    #[test]
    fn the_hover_text_is_the_typescripts() {
        let tables = tables();
        let steps = of("tray", "src/main/tray-labels.ts#trayTooltip");
        assert_eq!(steps.len(), 61);
        for step in steps {
            if step.input.is_null() {
                let text = text_for(&tables, "en");
                assert_eq!(tooltip(&text, None), step.output.as_str().unwrap());
                continue;
            }
            let text = text_for(&tables, step.input["language"].as_str().unwrap());
            let state = TrayState::from_value(&step.input).unwrap();
            assert_eq!(
                tooltip(&text, Some(&state)),
                step.output.as_str().unwrap(),
                "{}",
                step.input
            );
        }
    }

    // ---- the state machine against `createTray` driven over the fake shell

    /// What a replay saw, in the capture's own words: `{tooltip}`, `{menu: [{label, type, enabled}]}`.
    fn seen(effects: Effects) -> Vec<Value> {
        let mut out = Vec::new();
        if let Some(tip) = effects.tooltip {
            out.push(json!({ "tooltip": tip }));
        }
        if let Some(items) = effects.menu {
            let menu: Vec<Value> = items
                .iter()
                .map(|item| {
                    json!({
                        "label": item.label,
                        "type": if item.kind == Kind::Separator { "separator" } else { "normal" },
                        "enabled": item.enabled,
                    })
                })
                .collect();
            out.push(json!({ "menu": menu }));
        }
        out
    }

    /// Each script's events in order, as the captured steps list them.
    #[test]
    fn the_tray_follows_the_renderer_the_windows_and_the_open_menu_as_it_did() {
        let tables = tables();
        let created = of("tray", "src/main/tray.ts#createTray");
        assert_eq!(created.len(), 4);
        let events = of("tray", "src/main/tray.ts#event");
        assert_eq!(events.len(), 27);
        for start in created {
            let script = start.input["script"].as_str().unwrap();
            let mut model = Model::default();
            let mut lang = "en".to_string();
            // Every script's window starts hidden.
            let mut visible = false;
            let text = text_for(&tables, &lang);
            let e = Env {
                lang: &lang,
                text: &text,
                window_visible: visible,
                now_ms: 0,
            };
            let first = seen(model.create(&e));
            let mut expected: Vec<Value> = start.output["seen"].as_array().unwrap().clone();
            // The capture also saw the icon being made.
            expected.retain(|s| s.get("create").is_none());
            assert_eq!(first, expected, "{script}: create");
            for step in events.iter().filter(|s| s.input["script"] == script) {
                let event = &step.input["event"];
                let mut spawned = false;
                let mut windows: Vec<&str> = Vec::new();
                let effects = match event["kind"].as_str().unwrap() {
                    "state" => {
                        lang = event["state"]["language"].as_str().unwrap().to_string();
                        let text = text_for(&tables, &lang);
                        let e = Env {
                            lang: &lang,
                            text: &text,
                            window_visible: visible,
                            now_ms: 0,
                        };
                        let state = TrayState::from_value(&event["state"]).unwrap();
                        seen(model.set_state(Some(state), &e))
                    }
                    "visible" => {
                        visible = event["visible"].as_bool().unwrap();
                        let text = text_for(&tables, &lang);
                        let e = Env {
                            lang: &lang,
                            text: &text,
                            window_visible: visible,
                            now_ms: 0,
                        };
                        seen(model.refresh(&e))
                    }
                    "menuOpen" => {
                        model.menu_opened();
                        vec![]
                    }
                    "menuClose" => {
                        let text = text_for(&tables, &lang);
                        let e = Env {
                            lang: &lang,
                            text: &text,
                            window_visible: visible,
                            now_ms: 0,
                        };
                        seen(model.menu_closed(&e))
                    }
                    "click" | "press" => {
                        let has_window = script != "noWindow";
                        let what = if event["kind"] == "click" {
                            click(has_window)
                        } else {
                            toggle(has_window.then_some(visible))
                        };
                        match what {
                            Toggle::Spawn => spawned = true,
                            Toggle::Show => windows = vec!["show", "focus"],
                            Toggle::Hide => windows = vec!["hide"],
                        }
                        vec![]
                    }
                    other => panic!("unknown event {other}"),
                };
                // A press or a click shows as window ops and a spawn, a model event as tooltip and menu.
                let mut got: Vec<Value> = effects;
                got.extend(windows.iter().map(|w| json!({ "window": w })));
                assert_eq!(Value::Array(got), step.output["seen"], "{script}: {event}");
                assert_eq!(
                    spawned,
                    !step.output["spawned"].as_array().unwrap().is_empty(),
                    "{script}: {event}"
                );
            }
        }
    }

    fn en() -> impl Fn(&str, &[(&str, &str)]) -> String {
        let tables = tables();
        let table = tables["en"].clone();
        move |key, params| crate::labels::fill(&table[key], params)
    }

    fn env<'a>(text: Text<'a>, visible: bool, now_ms: u64) -> Env<'a> {
        Env {
            lang: "en",
            text,
            window_visible: visible,
            now_ms,
        }
    }

    fn labels_of(effects: &Effects) -> Vec<String> {
        effects
            .menu
            .iter()
            .flatten()
            .map(|item| item.label.clone())
            .collect()
    }

    #[test]
    fn a_finished_check_says_up_to_date_for_thirty_seconds_and_then_offers_a_check() {
        let text = en();
        let mut model = Model::default();
        model.create(&env(&text, true, 0));
        let effects = model.set_update(
            json!({ "state": "not-available", "version": "1.0.0" }),
            &env(&text, true, 1_000),
        );
        assert_eq!(labels_of(&effects)[1], "OMPdesk is up to date");
        let (generation, delay) = effects.timer.expect("a timer to offer the check again");
        assert_eq!(delay, UP_TO_DATE_MS + 50);
        // Too early: nothing changed.
        assert_eq!(
            model.timer_fired(generation, &env(&text, true, 20_000)),
            Effects::default()
        );
        let after = model.timer_fired(generation, &env(&text, true, 1_000 + delay));
        assert_eq!(labels_of(&after)[1], "Check for updates");
    }

    #[test]
    fn a_later_status_makes_the_timer_stale_and_ends_the_notice() {
        let text = en();
        let mut model = Model::default();
        model.create(&env(&text, true, 0));
        let first = model.set_update(
            json!({ "state": "not-available", "version": "1.0.0" }),
            &env(&text, true, 0),
        );
        let (generation, _) = first.timer.unwrap();
        let checking = model.set_update(json!({ "state": "checking" }), &env(&text, true, 10));
        assert_eq!(labels_of(&checking)[1], "Checking for updates…");
        assert_eq!(checking.timer, None);
        assert_eq!(
            model.timer_fired(generation, &env(&text, true, 40_000)),
            Effects::default()
        );
    }

    #[test]
    fn a_menu_that_is_open_is_never_replaced_and_catches_up_when_it_closes() {
        let text = en();
        let mut model = Model::default();
        model.create(&env(&text, true, 0));
        model.menu_opened();
        let during = model.set_update(
            json!({ "state": "available", "version": "1.2.3", "mode": "manual" }),
            &env(&text, true, 0),
        );
        assert_eq!(during.menu, None);
        let closed = model.menu_closed(&env(&text, true, 0));
        assert_eq!(labels_of(&closed)[1], "Download v1.2.3");
        assert_eq!(model.menu_closed(&env(&text, true, 0)), Effects::default());
    }

    #[test]
    fn the_tooltip_follows_the_status_and_the_menu_stays_put() {
        let text = en();
        let mut model = Model::default();
        model.create(&env(&text, true, 0));
        let state = |status: &str| {
            Some(TrayState {
                status: status.into(),
                project_name: "alpha".into(),
            })
        };
        let first = model.set_state(state("streaming"), &env(&text, true, 0));
        assert_eq!(first.tooltip.as_deref(), Some("OMPdesk — alpha · Working"));
        assert_eq!(first.menu, None);
        assert_eq!(
            model.set_state(state("streaming"), &env(&text, true, 0)),
            Effects::default()
        );
    }

    #[test]
    fn the_update_action_goes_to_node_by_the_clients_names() {
        assert_eq!(UpdateAction::Check.wire(), "check");
        assert_eq!(UpdateAction::Download.wire(), "download");
        assert_eq!(UpdateAction::Install.wire(), "apply");
    }
}
