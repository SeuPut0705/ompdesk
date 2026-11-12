//! `ompdesk_app` against what the TypeScript said before it moved: tables captured from `app-catalog.ts`,
//! `app-channels.ts`, `app-settings.ts`, `app-guard.ts`, `app-schema.ts` and `app-control.ts` (`captured/*.json`:
//! every action's metadata and describers, the settings and channel tables, `list` over many filters, `validateArgs`
//! over many shapes, the guard's tiers), replayed here, and the control's decisions over a stand-in for the app.
//! The actions' own texts are held by `app-control.test.ts`, which runs against the real core.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};

use super::catalog::{PANEL_TABS, SETTINGS_SECTIONS, VIEW_SHEETS, shipped};
use super::channels::{CHANNELS, Risk};
use super::control::{AppControl, Registry, is_refusal};
use super::guard::{
    Tier, omp_setting_tier, pref_tier, rpc_tier, setting_tier, setting_value_problem,
};
use super::ports::{AppPorts, PortPorts, RpcResponse, SidebarView};
use super::schema::validate_args;
use super::settings::{
    Decision, Kind, Manage, ROW_NOT_WRITTEN, SETTINGS, host_pref, setting_action_id,
};
use crate::ports::PortError;

fn captured(text: &str) -> Value {
    expand(serde_json::from_str(text).expect("captured table"))
}

/// A long run of one character is stored as `{"$rep": [char, count]}`.
fn expand(value: Value) -> Value {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("$rep") => {
            let parts = map["$rep"].as_array().expect("rep");
            Value::String(
                parts[0]
                    .as_str()
                    .unwrap()
                    .repeat(parts[1].as_u64().unwrap() as usize),
            )
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, expand(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(expand).collect()),
        other => other,
    }
}

fn is_undefined(value: &Value) -> bool {
    value.get("$undefined") == Some(&Value::Bool(true))
}

/// `undefined` is stored as `{"$undefined": true}`.
fn optional(value: &Value) -> Option<&Value> {
    (!is_undefined(value)).then_some(value)
}

fn meta() -> Value {
    captured(include_str!("captured/meta.json"))
}

fn tier_name(text: &str) -> Tier {
    match text {
        "read" => Tier::Read,
        "change" => Tier::Change,
        "sensitive" => Tier::Sensitive,
        _ => Tier::Never,
    }
}

#[test]
fn every_action_is_what_the_typescript_listed() {
    let expected = meta();
    let registry = shipped::<PortPorts>();
    let listed = expected["actions"].as_array().unwrap();
    assert_eq!(registry.actions().len(), listed.len());
    let when_samples = [
        json!({}),
        json!({"enabled": true}),
        json!({"enabled": false}),
        json!({"enabled": "yes"}),
    ];
    for (action, want) in registry.actions().iter().zip(listed) {
        let id = want["id"].as_str().unwrap();
        assert_eq!(action.id, id);
        assert_eq!(action.area, want["area"].as_str().unwrap(), "{id}");
        assert_eq!(
            action.description,
            want["description"].as_str().unwrap(),
            "{id}"
        );
        assert_eq!(
            serde_json::to_string(&action.args).unwrap(),
            serde_json::to_string(&want["args"]).unwrap(),
            "{id}"
        );
        assert_eq!(action.tier.as_str(), want["tier"].as_str().unwrap(), "{id}");
        assert_eq!(action.never_reason, want["neverReason"].as_str(), "{id}");
        assert_eq!(action.full_only, want["fullOnly"].as_str(), "{id}");
        assert_eq!(
            action.run.is_some(),
            want["hasRun"].as_bool().unwrap(),
            "{id}"
        );
        match (action.manage, want.get("manage")) {
            (None, None) => {}
            (Some(Manage::Lifts(reason)), Some(rule)) => {
                assert_eq!(Some(reason), rule["lifts"].as_str(), "{id}")
            }
            (Some(Manage::Always { reason, when }), Some(rule)) => {
                assert_eq!(Some(reason), rule["always"].as_str(), "{id}");
                match (when, rule.get("when")) {
                    (None, None) => {}
                    (Some(when), Some(samples)) => {
                        for (sample, want) in when_samples.iter().zip(samples.as_array().unwrap()) {
                            assert_eq!(
                                &Value::Bool(when(sample.as_object().unwrap())),
                                want,
                                "{id} {sample}"
                            );
                        }
                    }
                    _ => panic!("{id}: the `when` of its manage rule differs"),
                }
            }
            _ => panic!("{id}: manage rule differs"),
        }
        match (action.describe, want.get("describe")) {
            (None, None) => {}
            (Some(describe), Some(samples)) => {
                for sample in samples.as_array().unwrap() {
                    let args = sample["args"].as_object().unwrap();
                    assert_eq!(
                        describe(args),
                        sample["text"].as_str().unwrap(),
                        "{id} {}",
                        sample["args"]
                    );
                }
            }
            _ => panic!("{id}: describer differs"),
        }
    }
}

#[test]
fn the_settings_rows_and_the_rows_not_written_are_the_typescript_tables() {
    let expected = meta();
    let rows = expected["settings"].as_array().unwrap();
    assert_eq!(SETTINGS.len(), rows.len());
    for (row, want) in SETTINGS.iter().zip(rows) {
        let id = want["id"].as_str().unwrap();
        assert_eq!(row.id, id);
        assert_eq!(row.area, want["area"].as_str().unwrap(), "{id}");
        assert_eq!(row.en, want["en"].as_str().unwrap(), "{id}");
        assert_eq!(row.ko, want["ko"].as_str().unwrap(), "{id}");
        assert_eq!(row.tier.as_str(), want["tier"].as_str().unwrap(), "{id}");
        assert_eq!(
            serde_json::to_string(&row.schema).unwrap(),
            serde_json::to_string(&want["schema"]).unwrap(),
            "{id}"
        );
        match row.kind {
            Kind::Pref {
                key,
                redact,
                mirror_theme,
            } => {
                assert_eq!(want["kind"], "pref");
                assert_eq!(Some(key), want["key"].as_str(), "{id}");
                assert_eq!(redact, want["redact"].as_bool().unwrap_or(false), "{id}");
                assert_eq!(mirror_theme, want.get("mirror").is_some(), "{id}");
            }
            Kind::Stock { path } => {
                assert_eq!(want["kind"], "stock");
                assert_eq!(Some(path), want["path"].as_str(), "{id}");
            }
        }
        let rule = want.get("manage");
        match row.manage {
            None => assert!(rule.is_none(), "{id}"),
            Some(Manage::Always { reason, .. }) => {
                assert_eq!(Some(reason), rule.unwrap()["always"].as_str(), "{id}")
            }
            Some(Manage::Lifts(reason)) => {
                assert_eq!(Some(reason), rule.unwrap()["lifts"].as_str(), "{id}")
            }
        }
    }
    // The mirrored key of a theme, over the names the TypeScript was asked.
    let theme = SETTINGS.iter().find(|row| row.id == "theme").unwrap();
    for (name, want) in expected["themeMirror"][0]["mirror"]["theme"]
        .as_object()
        .unwrap()
    {
        assert_eq!(&theme.mirrored(&json!(name)), want, "{name}");
    }
    let skipped = expected["rowNotWritten"].as_object().unwrap();
    assert_eq!(ROW_NOT_WRITTEN.len(), skipped.len());
    for ((id, decision), (want_id, want)) in ROW_NOT_WRITTEN.iter().zip(skipped) {
        assert_eq!(id, want_id);
        match decision {
            Decision::Covered(action) => {
                assert_eq!(Some(*action), want["covered"].as_str(), "{id}")
            }
            Decision::Never(reason) => assert_eq!(Some(*reason), want["never"].as_str(), "{id}"),
        }
    }
    for (key, want) in expected["hostPrefs"].as_object().unwrap() {
        let host = host_pref(key).expect(key);
        assert_eq!(Some(host.get), want["get"].as_str());
        assert_eq!(Some(host.set), want["set"].as_str());
        assert_eq!(
            Some(host.field),
            match key.as_str() {
                "accountRotation" => Some("mode"),
                _ => Some("enabled"),
            }
        );
    }
    assert!(host_pref("themeName").is_none());
}

#[test]
fn the_lists_and_the_channel_table_are_the_typescript_tables() {
    let expected = meta();
    let names = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(PANEL_TABS.to_vec(), names(&expected["panelTabs"]));
    assert_eq!(VIEW_SHEETS.to_vec(), names(&expected["viewSheets"]));
    assert_eq!(
        SETTINGS_SECTIONS.to_vec(),
        names(&expected["settingsSections"])
    );
    let channels = expected["channels"].as_object().unwrap();
    assert_eq!(CHANNELS.len(), channels.len());
    let write: Vec<String> = SETTINGS
        .iter()
        .map(|row| setting_action_id(row.id))
        .collect();
    for ((name, risk), (want_name, want)) in CHANNELS.iter().zip(channels) {
        assert_eq!(name, want_name);
        match risk {
            Risk::Never(reason) => assert_eq!(Some(*reason), want["never"].as_str(), "{name}"),
            Risk::Tier(tier, actions) => {
                assert_eq!(tier.as_str(), want["tier"].as_str().unwrap(), "{name}");
                assert_eq!(
                    serde_json::to_value(actions).unwrap(),
                    want["actions"],
                    "{name}"
                );
            }
            Risk::SettingsWrite => {
                assert_eq!("change", want["tier"].as_str().unwrap());
                assert_eq!(
                    serde_json::to_value(&write).unwrap(),
                    want["actions"],
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn the_guard_decides_as_the_typescript_did() {
    let guard = captured(include_str!("captured/guard.json"));
    for row in guard["prefTier"].as_array().unwrap() {
        let key = row["key"].as_str().unwrap();
        let full = row["full"].as_bool().unwrap();
        assert_eq!(
            pref_tier(key, full).as_str(),
            row["tier"].as_str().unwrap(),
            "pref {key:?} full={full}"
        );
    }
    for row in guard["settingTier"].as_array().unwrap() {
        let path = row["path"].as_str().unwrap();
        let full = row["full"].as_bool().unwrap();
        assert_eq!(
            setting_tier(path, full).as_str(),
            row["tier"].as_str().unwrap(),
            "setting {path:?} full={full}"
        );
    }
    let mut commands = 0;
    for row in guard["rpcTier"].as_array().unwrap() {
        // A command whose nested `type` was `undefined` has no spelling on the wire.
        if row["hasUndefined"] == true {
            continue;
        }
        commands += 1;
        let full = row["full"].as_bool().unwrap();
        assert_eq!(
            rpc_tier(&row["command"], full).as_str(),
            row["tier"].as_str().unwrap(),
            "{} full={full}",
            row["command"]
        );
    }
    assert!(commands > 80);
    for row in guard["ompSettingTier"].as_array().unwrap() {
        let path = row["path"].as_str().unwrap();
        let write = row["access"] == "write";
        let full = row["full"].as_bool().unwrap();
        assert_eq!(
            omp_setting_tier(path, optional(&row["entry"]), write, full).as_str(),
            row["tier"].as_str().unwrap(),
            "{path:?} {} {write} {full}",
            row["entry"]
        );
    }
    for row in guard["settingValueProblem"].as_array().unwrap() {
        assert_eq!(
            setting_value_problem(&row["entry"], &row["value"]).as_deref(),
            row["problem"].as_str(),
            "{} {}",
            row["entry"],
            row["value"]
        );
    }
}

#[test]
fn arguments_validate_as_the_typescript_validated_them() {
    let table = captured(include_str!("captured/validate.json"));
    let mut cases = 0;
    for group in table.as_array().unwrap() {
        for case in group["cases"].as_array().unwrap() {
            cases += 1;
            let got = validate_args(&group["schema"], optional(&case["raw"]));
            let want = &case["result"];
            match got {
                Ok(value) => {
                    assert_eq!(want["ok"], true, "{} on {}", group["schema"], case["raw"]);
                    assert_eq!(Value::Object(value), want["value"], "{}", group["schema"]);
                }
                Err(error) => {
                    assert_eq!(
                        want["ok"], false,
                        "{} on {}: {error}",
                        group["schema"], case["raw"]
                    );
                    assert_eq!(
                        Some(error.as_str()),
                        want["error"].as_str(),
                        "{} on {}",
                        group["schema"],
                        case["raw"]
                    );
                }
            }
        }
    }
    assert!(cases > 1000);
}

// ---- the control over a stand-in for the app -------------------------------------------------------------------

#[derive(Default)]
struct World {
    full: bool,
    manage: bool,
    approve: bool,
    prefs: Map<String, Value>,
    cards: Vec<String>,
    writes: Vec<(String, Value)>,
    invoked: Vec<(String, Vec<Value>)>,
    rpcs: Vec<Value>,
    events: Vec<Value>,
    notes: Vec<String>,
}

#[derive(Clone)]
struct Fake(Arc<Mutex<World>>);

impl Fake {
    fn new() -> Fake {
        let world = World {
            approve: true,
            prefs: serde_json::from_value(json!({"themeName": "dark", "theme": "dark"})).unwrap(),
            ..World::default()
        };
        Fake(Arc::new(Mutex::new(world)))
    }

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.0.lock().unwrap()
    }
}

impl AppPorts for Fake {
    async fn refresh(&self) -> Result<(), PortError> {
        Ok(())
    }
    fn manage_enabled(&self) -> bool {
        self.world().manage
    }
    fn full_enabled(&self) -> bool {
        self.world().full
    }
    fn localize(&self, en: &str, _ko: &str) -> String {
        en.to_string()
    }
    fn sidebar_view(&self) -> SidebarView {
        SidebarView::default()
    }
    async fn get_pref(&self, key: &str) -> Result<Option<Value>, PortError> {
        Ok(self.world().prefs.get(key).cloned())
    }
    async fn device(&self, _caller: &str) -> Result<Option<String>, PortError> {
        Ok(None)
    }
    async fn set_pref(&self, _caller: &str, key: &str, value: &Value) -> Result<(), PortError> {
        let mut world = self.world();
        world.prefs.insert(key.to_string(), value.clone());
        world.writes.push((key.to_string(), value.clone()));
        Ok(())
    }
    async fn rpc(&self, _caller: &str, command: &Value) -> Result<RpcResponse, PortError> {
        self.world().rpcs.push(command.clone());
        Ok(RpcResponse {
            success: true,
            data: Some(json!({})),
            error: None,
        })
    }
    async fn rpc_on(
        &self,
        caller: &str,
        _device: &str,
        command: &Value,
    ) -> Result<RpcResponse, PortError> {
        self.rpc(caller, command).await
    }
    async fn invoke(
        &self,
        _caller: &str,
        channel: &str,
        args: &[Value],
    ) -> Result<Value, PortError> {
        self.world()
            .invoked
            .push((channel.to_string(), args.to_vec()));
        Ok(json!([]))
    }
    fn fire(&self, _caller: &str, channel: &str, args: &[Value]) {
        self.world()
            .invoked
            .push((channel.to_string(), args.to_vec()));
    }
    fn send(&self, _caller: &str, event: &Value) {
        self.world().events.push(event.clone());
    }
    async fn confirm(&self, _caller: &str, _title: &str, message: &str) -> Result<bool, PortError> {
        let mut world = self.world();
        world.cards.push(message.to_string());
        Ok(world.approve)
    }
    async fn note(&self, _caller: &str, text: &str) -> Result<(), PortError> {
        self.world().notes.push(text.to_string());
        Ok(())
    }
    async fn text(&self, key: &str, params: &[(&str, &str)]) -> Result<String, PortError> {
        Ok(match (key, params) {
            ("appChanged", [("what", what), ("value", value)]) => {
                format!("Agent changed: {what} → {value}")
            }
            _ => format!("{key} {params:?}"),
        })
    }
    async fn open_privacy_pane(&self, _pane: &str) -> Result<(), PortError> {
        Ok(())
    }
    async fn caller_title(&self, _caller: &str) -> Result<String, PortError> {
        Ok("Main".into())
    }
    async fn autopilot(&self, _caller: &str, _args: &Value) -> Result<String, PortError> {
        Ok("autopilot reply".into())
    }
}

fn control(fake: &Fake) -> AppControl<Fake> {
    AppControl::new(fake.clone(), shipped())
}

async fn refused(control: &AppControl<Fake>, action: &str, args: Value) -> String {
    let fault = control
        .run("tab", Some(&json!(action)), Some(&args))
        .await
        .expect_err("a refusal");
    assert!(is_refusal(&fault), "{fault:?}");
    fault.message
}

#[tokio::test]
async fn a_change_is_journaled_toasted_and_undone() {
    let fake = Fake::new();
    let control = control(&fake);
    let said = control
        .run(
            "tab",
            Some(&json!("settings.theme")),
            Some(&json!({"value": "nord"})),
        )
        .await
        .unwrap();
    assert_eq!(said, "Theme is now nord.");
    {
        let world = fake.world();
        assert_eq!(world.prefs["themeName"], "nord");
        assert_eq!(world.prefs["theme"], "dark");
        assert_eq!(world.notes, ["Agent changed: Theme → nord"]);
        assert!(world.cards.is_empty());
        assert!(
            world
                .events
                .contains(&json!({"kind": "pref", "key": "themeName", "value": "nord"}))
        );
        assert!(world.events.contains(&json!({
            "kind": "toast",
            "message": "Agent changed: Theme → nord",
            "undo": {"kind": "pref", "key": "themeName", "value": "dark"}
        })));
    }
    let said = control
        .run("tab", Some(&json!("app.undo")), Some(&json!({})))
        .await
        .unwrap();
    assert_eq!(said, "Restored Theme to dark.");
    assert_eq!(fake.world().prefs["themeName"], "dark");
    assert_eq!(
        refused(&control, "app.undo", json!({})).await,
        "Nothing to undo: your last change had no previous value, or you made none."
    );
}

#[tokio::test]
async fn a_sensitive_action_asks_and_a_decline_changes_nothing() {
    let fake = Fake::new();
    fake.world().approve = false;
    let control = control(&fake);
    let message = refused(
        &control,
        "settings.proxy",
        json!({"value": "http://user:pw@proxy.example:8080"}),
    )
    .await;
    assert!(message.contains("declined"), "{message}");
    let world = fake.world();
    assert_eq!(world.cards.len(), 1);
    assert!(!world.cards[0].contains("pw@"), "{}", world.cards[0]);
    assert!(world.writes.is_empty());
}

#[tokio::test]
async fn the_manage_switch_lifts_a_card_unless_the_action_always_asks() {
    let fake = Fake::new();
    {
        let mut world = fake.world();
        world.manage = true;
        world.approve = false;
    }
    let control = control(&fake);
    control
        .run(
            "tab",
            Some(&json!("settings.toolsAutoUpdate")),
            Some(&json!({"value": true})),
        )
        .await
        .unwrap();
    assert!(fake.world().cards.is_empty());
    assert!(
        refused(
            &control,
            "sessions.delete",
            json!({"sessionPath": "/s/a.jsonl"})
        )
        .await
        .contains("declined")
    );
    assert_eq!(fake.world().cards.len(), 1);
    assert!(fake.world().invoked.is_empty());
    // Full control asks nothing.
    fake.world().full = true;
    control
        .run(
            "tab",
            Some(&json!("sessions.delete")),
            Some(&json!({"sessionPath": "/s/a.jsonl"})),
        )
        .await
        .unwrap();
    assert_eq!(fake.world().cards.len(), 1);
}

#[tokio::test]
async fn an_unknown_never_or_ill_formed_call_is_refused_before_anything_runs() {
    let fake = Fake::new();
    let control = control(&fake);
    assert_eq!(
        refused(&control, "nothing.here", json!({})).await,
        "Unknown action \"nothing.here\". Call ompdesk_app_list to see the actions."
    );
    let said = control.run("tab", None, None).await.unwrap_err();
    assert_eq!(
        said.message,
        "Unknown action undefined. Call ompdesk_app_list to see the actions."
    );
    assert!(
        refused(&control, "cards.answer", json!({}))
            .await
            .contains("never available")
    );
    assert!(
        refused(
            &control,
            "agent_power.set",
            json!({"switch": "agentControlFull", "on": true})
        )
        .await
        .contains("never available")
    );
    assert_eq!(
        refused(&control, "settings.theme", json!({"value": "neon"})).await,
        format!(
            "Invalid args for settings.theme: value must be one of: {}",
            [
                "system",
                "light",
                "github-light",
                "solarized-light",
                "sepia",
                "hc-light",
                "dark",
                "nord",
                "tokyo-night",
                "gruvbox-dark",
                "hc-dark"
            ]
            .join(", ")
        )
    );
    let world = fake.world();
    assert!(world.writes.is_empty() && world.invoked.is_empty() && world.rpcs.is_empty());
}

/// An action that does one primitive and what the context answers: a refusal that sent nothing, or the call.
async fn scripted(steps: Value, tier: &str) -> (Result<String, String>, Fake) {
    let fake = Fake::new();
    fake.world().manage = true;
    let script: Vec<super::control::Step> = serde_json::from_value(steps).unwrap();
    let tier = tier_name(tier);
    let registry = Registry::new(vec![super::control::Action {
        id: "test.attempt".into(),
        area: "test".into(),
        description: "A test attempt.".into(),
        args: super::schema::no_args(),
        tier,
        never_reason: None,
        manage: None,
        full_only: None,
        describe: None,
        run: Some(super::control::Run::Script(script)),
    }]);
    let control = AppControl::new(fake.clone(), registry);
    let answer = control
        .run("tab", Some(&json!("test.attempt")), Some(&json!({})))
        .await
        .map_err(|fault| fault.message);
    (answer, fake)
}

#[tokio::test]
async fn a_context_refuses_the_routes_to_the_agents_own_power() {
    for (steps, needle) in [
        (
            json!([{"op": "setPref", "key": "agentControlManage", "value": true}]),
            "Writing the preference \"agentControlManage\" is never available",
        ),
        (
            json!([{"op": "setPref", "key": "toolsAutoUpdate", "value": true}]),
            "needs the sensitive level",
        ),
        (
            json!([{"op": "rpc", "command": {"type": "set_setting", "path": "tools.approvalMode", "value": "yolo"}}]),
            "The command \"set_setting\" is never available",
        ),
        (
            json!([{"op": "rpc", "command": {"type": "set_setting", "path": "advisor.enabled", "value": {"type": "set_setting", "path": "tools.approvalMode", "value": "yolo"}}, "device": "Studio"}]),
            "never available",
        ),
        (
            json!([{"op": "invoke", "channel": "extension-ui:respond", "args": [{"id": "c1"}]}]),
            "The channel \"extension-ui:respond\" is never available",
        ),
        (
            json!([{"op": "invoke", "channel": "sessions:delete", "args": [{"sessionPath": "x.jsonl"}]}]),
            "The channel \"sessions:delete\" for test.attempt is never available",
        ),
    ] {
        let (answer, fake) = scripted(steps.clone(), "change").await;
        let message = answer.expect_err(&steps.to_string());
        assert!(message.contains(needle), "{steps}: {message}");
        let world = fake.world();
        assert!(
            world.writes.is_empty() && world.rpcs.is_empty() && world.invoked.is_empty(),
            "{steps}"
        );
    }
}

#[tokio::test]
async fn list_names_every_action_and_shows_schemas_once_narrowed() {
    let fake = Fake::new();
    let control = control(&fake);
    let all = control.list(&Value::Null).await.unwrap();
    assert!(
        all.ends_with("(110 actions; narrow with area or query to see argument schemas.)")
            || all.contains(" actions; narrow with area or query")
    );
    let narrow = control.list(&json!({"area": "usage"})).await.unwrap();
    assert!(
        narrow.contains("usage.read [read]") && narrow.contains("\"refresh\""),
        "{narrow}"
    );
    let table = captured(include_str!("captured/list.json"));
    for row in table.as_array().unwrap() {
        fake.world().full = row["full"] == true;
        let raw = optional(&row["raw"]).unwrap_or(&Value::Null);
        assert_eq!(
            control.list(raw).await.unwrap(),
            row["text"].as_str().unwrap(),
            "{raw} full={}",
            row["full"]
        );
    }
}

#[test]
fn the_snapshot_of_main_reads_as_main_writes_it() {
    let state: super::ports::AppState = serde_json::from_value(json!({
        "manage": true, "full": false, "korean": true,
        "sidebar": {"pinnedProjects": ["/a"], "pinnedSessions": [], "aliases": {"/a": "A"}, "projectOrder": []}
    }))
    .unwrap();
    assert!(state.manage && !state.full && state.korean);
    assert_eq!(state.sidebar.aliases["/a"], "A");
    let empty: HashMap<String, String> = HashMap::new();
    assert_eq!(super::ports::AppState::default().sidebar.aliases, empty);
}
