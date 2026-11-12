//! The engine over a scripted `Store::Main`: what `upkeep.test.ts` does not reach. The TypeScript cases run against
//! this core through the real process; these pin the state file's exact text, the log lines' exact bytes, a failing
//! facts ask, a cancelled tick and a tick that finds another one running.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde_json::{Value, json};

use super::asks::rig::{Rig, Run, Said};
use super::engine::Memory;
use super::register_requests;
use crate::aimemory::value::iso;
use crate::fs::disk::make_temp_dir;

/// `Date.parse("2026-10-19T12:00:00Z")`.
const T0: u64 = 1_792_411_200_000;
const IDLE: u64 = 600_000;
const T0_ISO: &str = "2026-10-19T12:00:00.000Z";
const RULE_PATH: &str = "_rules/동시-세션-수-제한을-두지-않는다.md";

fn temp(name: &str) -> PathBuf {
    make_temp_dir(&format!("ompdesk-core-upkeep-{name}-")).unwrap()
}

/// What the scripted main answers.
struct World {
    /// How many prompts the one session holds.
    prompts: u64,
    /// The facts ask refuses.
    facts_down: bool,
    /// The model's answer; none withdraws the request instead.
    model: Option<Value>,
    /// Every ask in order, as `kind` or `client:op`.
    seen: Vec<String>,
}

fn rule_answer() -> Value {
    let pages = json!({ "pages": [{
        "kind": "rule",
        "title": "동시 세션 수 제한을 두지 않는다",
        "body": "동시 세션 개수에 어떤 제한도 두지 않는다.\n소유자가 여러 번 제거하라고 요구했다.",
        "confidence": 0.85,
        "evidence": [2, 3],
    }] });
    json!({
        "text": pages.to_string(),
        "model": "claude-sonnet-5-5",
        "inputTokens": 3500.0,
        "outputTokens": 300.0,
        "costUsd": 0.0162,
    })
}

impl World {
    fn new(prompts: u64) -> World {
        World {
            prompts,
            facts_down: false,
            model: Some(rule_answer()),
            seen: Vec::new(),
        }
    }

    fn session(&self) -> Value {
        json!({
            "id": "main-1", "cwd": "/work", "agent": "omp",
            "startedAt": "2026-10-19T09:00:00Z", "endedAt": null,
            "observations": self.prompts * 3, "consolidation": null,
        })
    }

    fn answer(&mut self, ask: &Value) -> Said {
        let params = &ask["params"];
        let kind = ask["kind"].as_str().unwrap();
        if kind == "client" {
            self.seen
                .push(format!("client:{}", params["op"].as_str().unwrap()));
        } else {
            self.seen.push(kind.to_owned());
        }
        match kind {
            "facts" => {
                if self.facts_down {
                    return Said::Error("facts down");
                }
                let items = params["items"].as_array().unwrap();
                Said::Value(Value::Array(
                    items
                        .iter()
                        .map(|item| {
                            json!({
                                "agent": false, "junk": item["text"] == "junk",
                                "title": null, "explicit": null,
                                "body": item["text"], "firstLine": null,
                            })
                        })
                        .collect(),
                ))
            }
            "model" => match &self.model {
                Some(result) => Said::Value(result.clone()),
                None => Said::Cancel,
            },
            "rules" => Said::Value(json!("")),
            "client" => Said::Value(match params["op"].as_str().unwrap() {
                "projects" => json!([
                    { "workspace": "default", "project": "ompdesk", "pages": 0, "lastUpdated": null },
                    { "workspace": "default", "project": "_global", "pages": 0, "lastUpdated": null },
                ]),
                "sessions" => json!([self.session()]),
                "observations" => json!({
                    "session": self.session(),
                    "observations": (1..=self.prompts).map(|n| json!({
                        "id": format!("o{n}"), "kind": "user-prompt", "title": format!("t{n}"),
                        "body": format!("사용자 메시지 {n}"),
                        "createdAt": iso(T0 - IDLE - 60_000 - (self.prompts - n) * 60_000),
                    })).collect::<Vec<_>>(),
                    "total": self.prompts, "offset": 0,
                }),
                "pages" if params["args"][0]["project"] == "ompdesk" => json!([
                    { "workspace": "default", "project": "ompdesk", "path": "sessions/junk.md",
                      "title": "junk", "tier": "episodic", "updatedAt": null },
                ]),
                "pages" => json!([]),
                "handoffs" => json!([]),
                "createPage" => json!(true),
                other => panic!("unscripted client op {other}"),
            }),
            other => panic!("unscripted ask {other}"),
        }
    }
}

async fn rig() -> Rig {
    Rig::start(register_requests).await
}

fn params(service: &str, dir: &Path) -> Value {
    json!({
        "service": service,
        "asks": ["client", "facts", "model", "rules"],
        "locale": "en-US",
        "stateFile": dir.join("ai-memory").join("upkeep.json"),
        "modelCwd": dir.join("work"),
        "now": T0,
    })
}

async fn run(rig: &mut Rig, method: &str, params: Value, world: &mut World) -> Run {
    rig.run(method, params, |ask| world.answer(ask)).await
}

fn state_text(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join("ai-memory").join("upkeep.json")).ok()
}

#[tokio::test]
async fn a_learning_tick_writes_the_state_and_the_log_as_javascript_did() {
    let dir = temp("state");
    let mut rig = rig().await;
    let mut world = World::new(8);
    let run = run(&mut rig, "upkeep.tick", params("state-1", &dir), &mut world).await;
    // `JSON.stringify(outcome)`: the TypeScript's key order, numbers as they came.
    assert_eq!(
        run.response["result"].to_string(),
        format!(
            r#"{{"ran":true,"session":"main-1","project":"default/ompdesk","prompts":8,"created":["{RULE_PATH}"],"duplicates":0,"inRules":0,"superseded":[],"refused":[],"model":"claude-sonnet-5-5","inputTokens":3500.0,"outputTokens":300.0,"costUsd":0.0162}}"#
        )
    );
    // `JSON.stringify(state)`, once with the run and the session together.
    assert_eq!(
        state_text(&dir).unwrap(),
        format!(r#"{{"sessions":{{"main-1":{{"done":8,"at":"{T0_ISO}"}}}},"runs":["{T0_ISO}"]}}"#)
    );
    // One log line, sent before the answer, with the details in the TypeScript's order and the cost as `toFixed(4)`.
    assert_eq!(run.events.len(), 1);
    let line = &run.events[0];
    assert_eq!(line["event"], "upkeep.log");
    assert_eq!(line["data"]["service"], "state-1");
    assert_eq!(line["data"]["message"], "learn");
    assert_eq!(
        line["data"]["details"].to_string(),
        r#"{"session":"main-1","project":"default/ompdesk","prompts":8,"created":1,"duplicates":0,"inRules":0,"superseded":0,"refused":0,"model":"claude-sonnet-5-5","inputTokens":3500.0,"outputTokens":300.0,"costUsd":0.0162}"#
    );
    // The order of the asks: names, the scan, the window, the page lists, the rules, the model, the write.
    assert_eq!(
        world.seen,
        [
            "client:projects",
            "client:projects",
            "client:sessions",
            "client:observations",
            "facts",
            "client:pages",
            "client:pages",
            "client:sessions",
            "rules",
            "model",
            "client:createPage",
        ]
    );
    let write = &run.asks[10]["params"]["args"][0];
    assert_eq!(write["path"], RULE_PATH);
    assert_eq!(write["sessionId"], "main-1");
    assert_eq!(write["tier"], "semantic");
    assert_eq!(write["kind"], "rule");
    assert_eq!(
        rig.run("upkeep.close", json!({ "service": "state-1" }), |_| {
            Said::Nothing
        })
        .await
        .response["result"],
        Value::Null
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_failing_model_leaves_the_attempt_in_the_state_and_no_session() {
    let dir = temp("failed");
    let mut rig = rig().await;
    let mut world = World::new(8);
    world.model = Some(json!("not a result"));
    let run = run(
        &mut rig,
        "upkeep.tick",
        params("failed-1", &dir),
        &mut world,
    )
    .await;
    // A model that answers another shape is main's refusal, which the tick reports as `failed` and logs.
    assert_eq!(run.response["result"]["ran"], true);
    assert!(
        run.response["result"]["failed"]
            .as_str()
            .unwrap()
            .starts_with("model answered another shape than a result"),
        "{}",
        run.response
    );
    assert_eq!(run.events[0]["data"]["message"], "failed");
    assert_eq!(run.events[0]["data"]["details"]["step"], "learn-model");
    assert_eq!(run.events[0]["data"]["details"]["session"], "main-1");
    assert_eq!(
        state_text(&dir).unwrap(),
        format!(r#"{{"sessions":{{}},"runs":["{T0_ISO}"]}}"#)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_facts_ask_that_fails_fails_the_tick_before_anything_is_written() {
    let dir = temp("facts");
    let mut rig = rig().await;
    let mut world = World::new(8);
    world.facts_down = true;
    let run = run(&mut rig, "upkeep.tick", params("facts-1", &dir), &mut world).await;
    assert_eq!(run.response["ok"], false);
    assert_eq!(run.response["error"]["message"], "facts down");
    assert_eq!(state_text(&dir), None);
    // The tick that failed is over: the next one is not busy.
    assert!(!Memory::of("facts-1").running.load(Ordering::SeqCst));
    // The retitle repair says it per project, as it said a project it could not read.
    let run = run_retitle(&mut rig, &dir, &mut world).await;
    assert_eq!(
        run.response["result"].to_string(),
        r#"{"dryRun":false,"projects":2,"sessionPages":1,"junk":0,"retitled":[],"unresolved":[],"changed":[],"openHandoffs":0,"childHandoffs":0,"failed":["default/ompdesk: facts down"]}"#
    );
    let _ = std::fs::remove_dir_all(&dir);
}

async fn run_retitle(rig: &mut Rig, dir: &Path, world: &mut World) -> Run {
    let mut asked = params("facts-1", dir);
    asked["dryRun"] = json!(false);
    run(rig, "upkeep.retitle", asked, world).await
}

#[tokio::test]
async fn a_cancelled_tick_stops_at_its_ask_and_frees_the_service() {
    let dir = temp("cancel");
    let mut rig = rig().await;
    let mut world = World::new(8);
    world.model = None;
    let run = run(
        &mut rig,
        "upkeep.tick",
        params("cancel-1", &dir),
        &mut world,
    )
    .await;
    assert_eq!(run.response["ok"], false);
    assert_eq!(run.response["error"]["code"], "cancelled");
    // Stopped at the model: nothing after it was asked, the attempt is on the schedule and no session is settled.
    assert_eq!(world.seen.last().map(String::as_str), Some("model"));
    assert_eq!(
        state_text(&dir).unwrap(),
        format!(r#"{{"sessions":{{}},"runs":["{T0_ISO}"]}}"#)
    );
    assert!(!Memory::of("cancel-1").running.load(Ordering::SeqCst));
    // The next tick finds the gap, not a tick still running.
    let mut next = World::new(8);
    let run = run_again(&mut rig, "cancel-1", &dir, &mut next).await;
    assert_eq!(
        run.response["result"],
        json!({ "ran": false, "reason": "gap" })
    );
    let _ = std::fs::remove_dir_all(&dir);
}

async fn run_again(rig: &mut Rig, service: &str, dir: &Path, world: &mut World) -> Run {
    run(rig, "upkeep.tick", params(service, dir), world).await
}

#[tokio::test]
async fn a_tick_beside_a_running_one_is_busy_and_leaves_it_running() {
    let dir = temp("busy");
    let mut rig = rig().await;
    let memory = Memory::of("busy-1");
    memory.running.store(true, Ordering::SeqCst);
    let mut world = World::new(8);
    let run = run_again(&mut rig, "busy-1", &dir, &mut world).await;
    assert_eq!(
        run.response["result"],
        json!({ "ran": false, "reason": "busy" })
    );
    assert!(memory.running.load(Ordering::SeqCst));
    assert_eq!(state_text(&dir), None);
    memory.running.store(false, Ordering::SeqCst);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_session_nobody_wrote_to_is_not_read_again_until_the_service_is_closed() {
    let dir = temp("seen");
    let mut rig = rig().await;
    let mut world = World::new(3);
    let observations = |world: &World| {
        world
            .seen
            .iter()
            .filter(|ask| *ask == "client:observations")
            .count()
    };
    run_again(&mut rig, "seen-1", &dir, &mut world).await;
    assert_eq!(observations(&world), 1);
    run_again(&mut rig, "seen-1", &dir, &mut world).await;
    assert_eq!(observations(&world), 1);
    rig.run("upkeep.close", json!({ "service": "seen-1" }), |_| {
        Said::Nothing
    })
    .await;
    run_again(&mut rig, "seen-1", &dir, &mut world).await;
    assert_eq!(observations(&world), 2);
    let _ = std::fs::remove_dir_all(&dir);
}
