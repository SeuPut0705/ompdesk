#![cfg(unix)]

use std::future::ready;

use super::*;
use crate::application::proxy::ShellProxy;
use crate::models::test_rig::Fixture;
use crate::server::Events;

fn environment(prefs: &Value) -> machine::Environment {
    settings(prefs, Some("German"), Path::new("roles.json"), Path::new("rotation.json")).environment(false)
}

#[test]
fn stored_preferences_reach_spawn_environment_and_live_updates_without_stock_config_writes() {
    let fixture = Fixture::new("launch-settings");
    let prefs = Prefs::open(&fixture.dir).unwrap();
    prefs.set("replyLanguage", json!("off")).unwrap();
    prefs.set("userProfile", json!({"name":"  Ada  ","experience":"expert"})).unwrap();
    prefs.set("delegationMode", json!("swarm")).unwrap();
    prefs.set("accountRotation", json!("even")).unwrap();
    prefs.set("nextPromptSuggestions", json!(false)).unwrap();
    prefs.set("nextPromptInline", json!(true)).unwrap();
    prefs.set("autoTitleEvolve", json!(false)).unwrap();
    prefs.set("judgeAssist", json!(false)).unwrap();
    prefs.set("creditSpend", json!(true)).unwrap();
    let stored = Prefs::open(&fixture.dir).unwrap().snapshot();
    let selected = settings(&stored, Some("German"), Path::new("roles.json"), Path::new("rotation.json"));
    let env = selected.environment(false);
    assert!(!env.contains_key("OMP_GUI_REPLY_LANGUAGE"));
    assert_eq!(serde_json::from_str::<Value>(&env["OMP_GUI_USER_PROFILE"]).unwrap(), json!({"name":"Ada","experience":"expert"}));
    assert_eq!(env["OMP_GUI_DELEGATION"], "swarm");
    assert_eq!(env["OMP_GUI_ACCOUNT_ROTATION"], "even");
    assert_eq!(env["OMP_GUI_ACCOUNT_ROTATION_STATE"], "rotation.json");
    assert_eq!(env["OMP_GUI_OMPDESK_ROLES"], "roles.json");
    assert_eq!(env["OMP_GUI_JUDGE_ASSIST"], "0");
    assert_eq!(env["OMP_GUI_CREDIT_SPEND"], "1");
    assert_eq!(serde_json::from_str::<Value>(&env["OMP_GUI_NEXT_PROMPT"]).unwrap(), json!({"suggestions":false,"inline":true}));
    assert_eq!(serde_json::from_str::<Value>(&env["OMP_GUI_AUTO_TITLE"]).unwrap(), json!({"enabled":true,"evolve":false,"suppressed":false}));
    let updates = selected.updates(true);
    assert!(updates.contains(&("reply_language_set", json!({"language":null}))));
    assert!(updates.contains(&("user_profile_set", json!({"name":"Ada","experience":"expert"}))));
    assert!(updates.contains(&("next_prompt_set", json!({"suggestions":false,"inline":true}))));
    assert!(updates.contains(&("auto_title_set", json!({"enabled":true,"evolve":false,"suppressed":true}))));
    assert!(updates.contains(&("credit_spend_set", json!({"enabled":true}))));
}

#[test]
fn malformed_preferences_follow_device_language_and_never_enable_paid_credit() {
    let env = environment(&json!({
        "replyLanguage":"not-a-supported-choice", "userProfile":{"name":"bad\nname","experience":"invalid"},
        "delegationMode":"invented", "accountRotation":"invented", "creditSpend":"true",
        "judgeAssist":"false", "nextPromptSuggestions":0, "autoTitle":null,
    }));
    assert_eq!(env["OMP_GUI_REPLY_LANGUAGE"], "German");
    assert!(!env.contains_key("OMP_GUI_USER_PROFILE"));
    assert!(!env.contains_key("OMP_GUI_DELEGATION"));
    assert_eq!(env["OMP_GUI_ACCOUNT_ROTATION"], "quota");
    assert_eq!(env["OMP_GUI_CREDIT_SPEND"], "0");
    assert_eq!(env["OMP_GUI_JUDGE_ASSIST"], "1");
    assert_eq!(serde_json::from_str::<Value>(&env["OMP_GUI_NEXT_PROMPT"]).unwrap(), json!({"suggestions":true,"inline":true}));
    assert_eq!(environment(&json!({"replyLanguage":"Japanese"}))["OMP_GUI_REPLY_LANGUAGE"], "Japanese");
}

#[test]
fn profile_name_limit_counts_trimmed_utf16_units_and_keeps_valid_experience() {
    let accepted = "😀".repeat(32);
    let env = environment(&json!({"userProfile":{"name":format!(" \u{feff}{accepted} "),"experience":"junior"}}));
    assert_eq!(serde_json::from_str::<Value>(&env["OMP_GUI_USER_PROFILE"]).unwrap(), json!({"name":accepted,"experience":"junior"}));
    for name in ["😀".repeat(33), "safe\u{0085}name".to_owned()] {
        let env = environment(&json!({"userProfile":{"name":name,"experience":"junior"}}));
        assert_eq!(serde_json::from_str::<Value>(&env["OMP_GUI_USER_PROFILE"]).unwrap(), json!({"name":"","experience":"junior"}));
    }
}

fn browser_environment(browser: Browser) -> String {
    Settings { browser: Some(browser), ..Settings::default() }.environment(false)["OMP_GUI_BROWSER"].clone()
}

#[test]
fn browser_resolution_uses_generated_catalog_and_never_launches_an_unloaded_relay() {
    let catalog = browsers::bundled_catalog().unwrap();
    let first = &catalog[0];
    let status = BrowserStatus { ego_installed: true, browsers: vec![Installed {
        id: first.id, name: first.name.clone(), relay_installed: true, relay_connected: false,
    }] };
    assert_eq!(browser_environment(select_browser(&json!("auto"), &status, &catalog)), "ego");
    let named = format!("chromium:{}", first.id.name());
    assert_eq!(browser_environment(select_browser(&json!(named), &status, &catalog)), format!("relay:{}@http://127.0.0.1:{}", first.name, first.port));
    assert_eq!(browser_environment(select_browser(&json!("invalid"), &status, &catalog)), "ego");
    let status = BrowserStatus { ego_installed: false, ..status };
    assert_eq!(browser_environment(select_browser(&json!("ego"), &status, &catalog)), "builtin");
    assert!(matches!(select_browser(&json!("auto"), &status, &catalog), Browser::Relay { .. }));
    let status = BrowserStatus { ego_installed: false, browsers: vec![Installed {
        id: first.id, name: first.name.clone(), relay_installed: false, relay_connected: true,
    }] };
    assert_eq!(browser_environment(select_browser(&json!(format!("chromium:{}", first.id.name())), &status, &catalog)), "builtin");
}

#[tokio::test]
async fn machine_wide_browser_snapshot_changes_only_after_an_explicit_successful_reprobe() {
    let fixture = Fixture::new("launch-browser-cache");
    let bin = fixture.dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let shell = fixture.script("shell", &format!("printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH={}' '__OMP_ENV_END__'", bin.display()));
    let (events, _transport, _frames) = Events::capture();
    let machine = Machine::new(machine::Config {
        platform: machine::Platform::Other, home: fixture.dir.clone(), user_data: fixture.dir.clone(),
        tools_dir: fixture.dir.join("tools"), agent_desktop_bundle: None,
        core_bin: fixture.dir.join("core"), agent_dir: fixture.dir.join("agent"),
        inherited_env: machine::Environment::from([
            ("HOME".into(), fixture.dir.to_string_lossy().into_owned()),
            ("USERPROFILE".into(), fixture.dir.to_string_lossy().into_owned()),
            ("PATH".into(), bin.to_string_lossy().into_owned()),
            ("SHELL".into(), shell.to_string_lossy().into_owned()),
        ]),
    }, Arc::new(ShellProxy::new(Prefs::open(&fixture.dir).unwrap(), events)));
    let state = BrowserState::new(machine, browsers::Places {
        platform: "other".into(), home: fixture.dir.to_string_lossy().into_owned(),
        app_dirs: Vec::new(), program_dirs: Vec::new(), local_app_data: String::new(),
    }).unwrap();
    let (first, joined) = tokio::join!(state.read(), state.read());
    let first = first.unwrap();
    assert!(Arc::ptr_eq(&first, &joined.unwrap()));
    assert!(!first.ego_installed);
    let ego = fixture.script("ego-browser", "exit 0");
    std::fs::rename(ego, bin.join("ego-browser")).unwrap();
    assert!(!state.read().await.unwrap().ego_installed);
    let (fresh, changed) = state.reprobe().await.unwrap();
    assert!(changed);
    assert!(fresh.ego_installed);
    assert!(Arc::ptr_eq(&fresh, &state.read().await.unwrap()));
    assert!(!state.reprobe().await.unwrap().1);
}

#[test]
fn a_relay_connection_change_alone_does_not_retarget_live_sessions() {
    let catalog = browsers::bundled_catalog().unwrap();
    let first = &catalog[0];
    let before = BrowserStatus { ego_installed: false, browsers: vec![Installed {
        id: first.id, name: first.name.clone(), relay_installed: true, relay_connected: false,
    }] };
    let mut after = BrowserStatus { ego_installed: false, browsers: vec![Installed {
        id: first.id, name: first.name.clone(), relay_installed: true, relay_connected: true,
    }] };
    assert!(same_browser_target(&before, &after));
    after.browsers[0].relay_installed = false;
    assert!(!same_browser_target(&before, &after));
}

#[tokio::test(start_paused = true)]
async fn a_closing_stock_owner_is_rechecked_until_free_without_opening_a_second_session() {
    let started = Instant::now();
    let mut asked = Vec::new();
    let answer = when_session_free(|| {
        let elapsed = started.elapsed();
        asked.push(elapsed);
        ready(Ok(elapsed < Duration::from_secs(1)))
    }).await;
    assert_eq!(answer, SessionFree::Free);
    assert_eq!(asked, [0, 250, 500, 750, 1000].map(Duration::from_millis));
}

#[tokio::test(start_paused = true)]
async fn a_still_owned_session_is_refused_after_the_same_fast_then_slow_wait_as_stock_ui() {
    let started = Instant::now();
    let mut asked = Vec::new();
    let answer = when_session_free(|| { asked.push(started.elapsed()); ready(Ok(true)) }).await;
    assert_eq!(answer, SessionFree::Owned);
    assert!(started.elapsed() >= Duration::from_secs(60));
    assert!(started.elapsed() <= Duration::from_secs(62));
    assert!(asked.windows(2).take(20).all(|pair| pair[1] - pair[0] == Duration::from_millis(250)));
    assert_eq!(*asked.last().unwrap() - asked[asked.len() - 2], Duration::from_secs(2));
}

#[tokio::test(start_paused = true)]
async fn unavailable_stock_ownership_probe_does_not_block_launch() {
    let started = Instant::now();
    assert_eq!(when_session_free(|| ready(Err(Fault::new("stock_unavailable", "test probe unavailable")))).await, SessionFree::Free);
    assert_eq!(started.elapsed(), Duration::ZERO);
}
