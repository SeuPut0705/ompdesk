//! `care.test.ts`: the schedule, the recording client, the line and its undo. A test's own units are asked of main
//! (`unit`) and make their client calls back as `care.unitCall`.

use serde_json::{Value, json};

use super::curate_tests::{Memory, NEW_TAILSCALE, OLD_CODE, of, says};
use super::*;

const START: &str = "2026-10-20T00:00:00Z";

/// The client of `care.test.ts`'s `fakeClient`: its calls, in order, and a checkpoint that moves with every retire.
#[derive(Default)]
struct Client {
    calls: Vec<String>,
    checkpoint: u64,
}

impl Client {
    fn answer(&mut self, op: &str, args: &[Value]) -> Said {
        let path = args
            .first()
            .and_then(|at| at["path"].as_str())
            .unwrap_or_default()
            .to_owned();
        match op {
            "headCheckpoint" => Said::Value(json!(format!("cp{}", self.checkpoint))),
            "page" => Said::Value(page_json("app", &path, &format!("Title of {path}"), "pg")),
            "retirePage" => {
                self.checkpoint += 1;
                self.calls.push(format!("retire {path}"));
                Said::Value(json!("retired"))
            }
            "feedback" => {
                self.calls
                    .push(format!("{} {path}", args[1].as_str().unwrap()));
                Said::Value(Value::Null)
            }
            "restorePage" => {
                self.calls
                    .push(format!("restore {path}@{}", args[1].as_str().unwrap()));
                Said::Value(Value::Null)
            }
            other => panic!("{other}"),
        }
    }
}

fn tick_params(state_file: &str, version: &str, now: f64, units: Value) -> Value {
    with(
        common(&["client", "unit"], Some(now)),
        json!({ "stateFile": state_file, "version": version, "units": units }),
    )
}

fn state_params(state_file: &str, now: f64) -> Value {
    with(
        common(&["client"], Some(now)),
        json!({ "stateFile": state_file }),
    )
}

fn unit_name(asked: &Value) -> &str {
    asked["params"]["name"].as_str().unwrap()
}

#[tokio::test]
async fn runs_one_unit_per_tick_goes_on_with_an_unfinished_one_and_repeats_a_finished_one_after_its_interval()
 {
    let dir = temp("schedule");
    let file = path_text(&dir.join("care.json"));
    let mut driver = Driver::start().await;
    let units = json!([
        { "name": "backfill", "everyMs": null },
        { "name": "curate", "everyMs": DAY },
    ]);
    let mut now = ms(START);
    let mut ran: Vec<String> = Vec::new();
    let mut backfill_steps = 0;
    let mut client = Client::default();
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            client.answer(op, args)
        }
        "unit" => {
            ran.push(unit_name(asked).to_owned());
            if unit_name(asked) == "backfill" {
                backfill_steps += 1;
                Said::Unit {
                    calls: vec![],
                    answer: json!({ "done": backfill_steps >= 2, "written": 10, "memo": {} }),
                }
            } else {
                Said::Unit {
                    calls: vec![],
                    answer: json!({ "done": true, "memo": {} }),
                }
            }
        }
        other => panic!("{other}"),
    };
    for _ in 0..4 {
        driver
            .call(
                "care.tick",
                tick_params(&file, "1.0.0", now, units.clone()),
                &mut said,
            )
            .await;
    }
    now += DAY;
    for _ in 0..2 {
        driver
            .call(
                "care.tick",
                tick_params(&file, "1.0.0", now, units.clone()),
                &mut said,
            )
            .await;
    }
    assert_eq!(ran, ["backfill", "backfill", "curate", "curate"]);
}

#[tokio::test]
async fn a_tick_answers_the_unit_it_ran_or_null() {
    let dir = temp("answers");
    let file = path_text(&dir.join("care.json"));
    let mut driver = Driver::start().await;
    let units = json!([{ "name": "curate", "everyMs": DAY }]);
    let mut said = |_: &Value| Said::Unit {
        calls: vec![],
        answer: json!({ "done": true, "memo": {} }),
    };
    let now = ms(START);
    let first = driver
        .call(
            "care.tick",
            tick_params(&file, "1.0.0", now, units.clone()),
            &mut said,
        )
        .await;
    assert_eq!(first["result"], "curate");
    let second = driver
        .call(
            "care.tick",
            tick_params(&file, "1.0.0", now, units),
            &mut said,
        )
        .await;
    assert_eq!(second["ok"], true);
    assert_eq!(second["result"], Value::Null);
}

#[tokio::test]
async fn runs_every_unit_again_after_an_update() {
    let dir = temp("update");
    let file = path_text(&dir.join("care.json"));
    let units = json!([{ "name": "backfill", "everyMs": null }]);
    let now = ms(START);
    let mut ran = 0;
    let mut said = |asked: &Value| {
        assert_eq!(unit_name(asked), "backfill");
        ran += 1;
        Said::Unit {
            calls: vec![],
            answer: json!({ "done": true, "memo": {} }),
        }
    };
    // Each launch is a core of its own over the same file.
    for version in ["1.0.0", "1.0.0", "1.1.0"] {
        let mut driver = Driver::start().await;
        driver
            .call(
                "care.tick",
                tick_params(&file, version, now, units.clone()),
                &mut said,
            )
            .await;
    }
    assert_eq!(ran, 2);
}

#[tokio::test]
async fn tries_a_failed_unit_again_after_an_hour_not_every_tick() {
    let dir = temp("failed");
    let file = path_text(&dir.join("care.json"));
    let units = json!([{ "name": "curate", "everyMs": DAY }]);
    let mut driver = Driver::start().await;
    let mut now = ms(START);
    let mut attempts = 0;
    let mut said = |_: &Value| {
        attempts += 1;
        Said::Error("server busy")
    };
    for _ in 0..2 {
        let answer = driver
            .call(
                "care.tick",
                tick_params(&file, "1.0.0", now, units.clone()),
                &mut said,
            )
            .await;
        assert_eq!(answer["ok"], true);
    }
    now += HOUR;
    driver
        .call(
            "care.tick",
            tick_params(&file, "1.0.0", now, units),
            &mut said,
        )
        .await;
    assert_eq!(attempts, 2);
    let logs = driver.logs("care-failed");
    assert_eq!(logs.len(), 2);
    assert_eq!(
        logs[0],
        json!({ "unit": "curate", "detail": "server busy" })
    );
}

#[tokio::test]
async fn shows_what_changed_undoes_it_through_the_pages_restore_and_leaves_restored_pages_to_the_person()
 {
    let dir = temp("undo");
    let file = path_text(&dir.join("care.json"));
    let units = json!([
        { "name": "curate", "everyMs": DAY },
        { "name": "backfill", "everyMs": null },
    ]);
    let mut driver = Driver::start().await;
    let mut now = ms(START);
    let mut client = Client::default();
    let project = json!({ "workspace": "default", "project": "app" });
    let retire = with(
        project.clone(),
        json!({
            "op": "retirePage",
            "args": [{ "workspace": "default", "project": "app", "path": "decisions/old.md",
                       "successor": "decisions/new.md", "at": iso(now) }],
        }),
    );
    let flag = json!({
        "op": "feedback",
        "args": [{ "workspace": "default", "project": "app", "path": "gotchas/maybe.md" }, "stale"],
    });
    let mut calls_for_curate = vec![retire.clone(), flag.clone()];
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            client.answer(op, args)
        }
        "unit" if unit_name(asked) == "curate" => Said::Unit {
            calls: std::mem::take(&mut calls_for_curate),
            answer: json!({ "done": true, "memo": {} }),
        },
        "unit" => Said::Unit {
            calls: vec![],
            answer: json!({ "done": true, "written": 42, "memo": {} }),
        },
        other => panic!("{other}"),
    };
    let none = driver
        .call("care.summary", state_params(&file, now), &mut said)
        .await;
    assert_eq!(none["result"], Value::Null);
    for _ in 0..2 {
        driver
            .call(
                "care.tick",
                tick_params(&file, "1.0.0", now, units.clone()),
                &mut said,
            )
            .await;
    }
    assert_eq!(
        driver
            .unit_results
            .iter()
            .map(|r| r["result"].clone())
            .collect::<Vec<_>>(),
        [json!("retired"), Value::Null]
    );
    let line = driver
        .call("care.summary", state_params(&file, now), &mut said)
        .await["result"]
        .clone();
    assert_eq!(line["retired"], 1);
    assert_eq!(line["flagged"], 1);
    assert_eq!(line["backfilled"], 42.0);
    assert_eq!(line["at"], iso(now));
    assert_eq!(
        line["pages"],
        json!([
            { "workspace": "default", "project": "app", "path": "decisions/old.md", "title": "Title of decisions/old.md" },
            { "workspace": "default", "project": "app", "path": "gotchas/maybe.md", "title": "Title of gotchas/maybe.md" },
        ])
    );

    let restored = driver
        .call("care.undo", state_params(&file, now), &mut said)
        .await;
    assert_eq!(restored["result"], 2);
    let restores: Vec<&String> = client
        .calls
        .iter()
        .filter(|call| call.starts_with("restore"))
        .collect();
    assert_eq!(
        restores,
        [
            "restore decisions/old.md@cp0",
            "restore gotchas/maybe.md@cp1"
        ]
    );
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            client.answer(op, args)
        }
        _ => unreachable!(),
    };
    let after = driver
        .call("care.summary", state_params(&file, now), &mut said)
        .await["result"]
        .clone();
    assert_eq!(after["retired"], 0);
    assert_eq!(after["flagged"], 0);
    assert_eq!(after["pages"], json!([]));
    assert_eq!(driver.logs("care-undo").len(), 2);
    assert_eq!(
        driver.logs("care-undo")[0],
        json!({ "project": "default/app", "path": "decisions/old.md", "action": "retired" })
    );

    // A day on, the curate unit is due again; the pages the person restored are not touched: the recording client
    // answers `pinned` and refuses the flag without any call to the client.
    client.calls.clear();
    now += DAY;
    let mut again = vec![retire, flag];
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            client.answer(op, args)
        }
        "unit" => Said::Unit {
            calls: std::mem::take(&mut again),
            answer: json!({ "done": true, "memo": {} }),
        },
        other => panic!("{other}"),
    };
    let before = driver.unit_results.len();
    driver
        .call(
            "care.tick",
            tick_params(&file, "1.0.0", now, units),
            &mut said,
        )
        .await;
    let results = &driver.unit_results[before..];
    assert_eq!(results[0]["result"], "pinned");
    assert_eq!(results[1]["ok"], false);
    assert_eq!(
        results[1]["error"]["message"],
        "the person put this page back; it stays as it is"
    );
    assert_eq!(client.calls, Vec::<String>::new());
}

#[tokio::test]
async fn keeps_each_units_memo_across_launches() {
    let dir = temp("memo");
    let file = path_text(&dir.join("care.json"));
    let units = json!([{ "name": "fresh", "everyMs": null }]);
    let now = ms(START);
    let mut seen: Vec<Value> = Vec::new();
    let mut said = |asked: &Value| {
        seen.push(asked["params"]["memo"].clone());
        Said::Unit {
            calls: vec![],
            answer: json!({ "done": false, "memo": { "flagged": { "default/app/gotchas/a.md": "pg-1" } } }),
        }
    };
    for _ in 0..2 {
        let mut driver = Driver::start().await;
        driver
            .call(
                "care.tick",
                tick_params(&file, "1.0.0", now, units.clone()),
                &mut said,
            )
            .await;
    }
    assert_eq!(
        seen,
        [
            json!({}),
            json!({ "flagged": { "default/app/gotchas/a.md": "pg-1" } })
        ]
    );
}

#[tokio::test]
async fn drops_changes_from_the_line_after_a_week() {
    let dir = temp("week");
    let file = path_text(&dir.join("care.json"));
    let units = json!([{ "name": "fresh", "everyMs": null }]);
    let mut driver = Driver::start().await;
    let mut now = ms(START);
    let mut client = Client::default();
    let mut calls = vec![json!({
        "op": "retirePage",
        "args": [{ "workspace": "default", "project": "app", "path": "gotchas/gone.md",
                   "reason": "names files that are gone", "at": iso(now) }],
    })];
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            client.answer(op, args)
        }
        "unit" => Said::Unit {
            calls: std::mem::take(&mut calls),
            answer: json!({ "done": true, "memo": {} }),
        },
        other => panic!("{other}"),
    };
    driver
        .call(
            "care.tick",
            tick_params(&file, "1.0.0", now, units),
            &mut said,
        )
        .await;
    let line = driver
        .call("care.summary", state_params(&file, now), &mut said)
        .await["result"]
        .clone();
    assert_eq!(line["retired"], 1);
    now += 8.0 * DAY;
    let gone = driver
        .call("care.summary", state_params(&file, now), &mut said)
        .await;
    assert_eq!(gone["result"], Value::Null);
}

#[tokio::test]
async fn a_tick_asked_while_one_runs_does_nothing_and_an_undo_waits_for_it() {
    let dir = temp("single");
    let file = path_text(&dir.join("care.json"));
    let units = json!([{ "name": "curate", "everyMs": DAY }]);
    let now = ms(START);
    let mut first = Driver::start().await;
    let mut second = Driver::start().await;
    second.service = first.service.clone();
    let mut hold = |_: &Value| Said::Nothing;
    let running = first
        .send("care.tick", tick_params(&file, "1.0.0", now, units.clone()))
        .await;
    // The unit's ask is the sign the tick runs; main has not answered it.
    let ask = loop {
        let frame = first.try_next(Duration::from_secs(60)).await.unwrap();
        if frame["event"] == "upkeep.ask" {
            break frame;
        }
    };
    let mut nothing = |_: &Value| Said::Nothing;
    let skipped = second
        .call(
            "care.tick",
            tick_params(&file, "1.0.0", now, units),
            &mut nothing,
        )
        .await;
    assert_eq!(skipped["ok"], true);
    assert_eq!(skipped["result"], Value::Null);

    let waiting = second.send("care.undo", state_params(&file, now)).await;
    assert!(
        second.try_next(Duration::from_millis(300)).await.is_none(),
        "an undo answered while a tick ran"
    );
    // Main answers the unit: the tick ends and the undo goes on.
    first
        .answer(&ask["data"], true, json!({ "done": true, "memo": {} }), "")
        .await;
    let ended = first.pump(running, &mut hold).await;
    assert_eq!(ended["result"], "curate");
    let undone = second.pump(waiting, &mut nothing).await;
    assert_eq!(undone["result"], 0);
}

#[tokio::test]
async fn a_tick_asked_while_an_undo_runs_does_nothing_so_the_undo_is_not_written_over() {
    let dir = temp("undo-then-tick");
    let file = path_text(&dir.join("care.json"));
    let units = json!([
        { "name": "curate", "everyMs": DAY },
        { "name": "backfill", "everyMs": null },
    ]);
    let now = ms(START);
    let mut first = Driver::start().await;
    let mut second = Driver::start().await;
    second.service = first.service.clone();
    let mut client = Client::default();
    let retire = json!({
        "op": "retirePage",
        "args": [{ "workspace": "default", "project": "app", "path": "decisions/old.md",
                   "successor": "decisions/new.md", "at": iso(now) }],
    });
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            client.answer(op, args)
        }
        "unit" => Said::Unit {
            calls: vec![retire.clone()],
            answer: json!({ "done": true, "memo": {} }),
        },
        other => panic!("{other}"),
    };
    let ran = first
        .call(
            "care.tick",
            tick_params(&file, "1.0.0", now, units.clone()),
            &mut said,
        )
        .await;
    assert_eq!(ran["result"], "curate");

    let undoing = first.send("care.undo", state_params(&file, now)).await;
    // The restore's ask is the sign the undo runs; main has not answered it.
    let restore = loop {
        let frame = first.try_next(Duration::from_secs(60)).await.unwrap();
        if frame["event"] == "upkeep.ask" && frame["data"]["params"]["op"] == "restorePage" {
            break frame;
        }
    };
    // Due: the backfill. Were it run now, its state would be written over the undo's (or the undo's over it).
    let mut run_any = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "unit" => Said::Unit {
            calls: vec![],
            answer: json!({ "done": true, "memo": {} }),
        },
        other => panic!("{other}"),
    };
    let skipped = second
        .call(
            "care.tick",
            tick_params(&file, "1.0.0", now, units.clone()),
            &mut run_any,
        )
        .await;
    assert_eq!(skipped["ok"], true);
    assert_eq!(skipped["result"], Value::Null);

    first.answer(&restore["data"], true, Value::Null, "").await;
    let mut nothing = |_: &Value| Said::Nothing;
    let undone = first.pump(undoing, &mut nothing).await;
    assert_eq!(undone["result"], 1);
    let line = second
        .call("care.summary", state_params(&file, now), &mut nothing)
        .await;
    assert_eq!(line["result"], Value::Null, "the undo stands");
    let next = second
        .call(
            "care.tick",
            tick_params(&file, "1.0.0", now, units),
            &mut run_any,
        )
        .await;
    assert_eq!(next["result"], "backfill");
}

/// `JSON.stringify(new Date(ms))`.
fn iso(ms: f64) -> String {
    crate::care::iso_of(ms)
}

#[tokio::test]
async fn the_three_units_run_in_order_over_the_real_client_and_curate_changes_go_through_the_recording_one()
 {
    let dir = temp("production");
    let file = path_text(&dir.join("care.json"));
    let mut driver = Driver::start().await;
    let now = ms(START);
    let mut memory = Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]);
    let judge = says("a_outdated", "jev");
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            memory.answer(op, args)
        }
        "judge" => Said::Value(judge(asked)),
        other => panic!("{other}"),
    };
    let params = with(
        common(&["client", "judge"], Some(now)),
        json!({
            "stateFile": file, "version": "1.0.0", "sessionsDir": path_text(&dir.join("sessions")),
            "origin": "device-mac", "git": null,
        }),
    );
    let mut ran = Vec::new();
    for _ in 0..4 {
        ran.push(driver.call("care.tick", params.clone(), &mut said).await["result"].clone());
    }
    assert_eq!(
        ran,
        [
            json!("backfill"),
            json!("curate"),
            json!("fresh"),
            Value::Null
        ]
    );
    assert_eq!(memory.retired.len(), 1);
    let state: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        state
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["version", "units", "kept", "changes", "backfills", "memo"]
    );
    assert_eq!(state["version"], "1.0.0");
    assert_eq!(
        state["units"]["backfill"],
        json!({ "at": iso(now), "done": true })
    );
    assert_eq!(state["memo"]["curate"], json!({ "unrelated": [] }));
    assert_eq!(state["memo"]["fresh"], json!({ "flagged": {} }));
    assert_eq!(
        state["changes"],
        json!([{
            "workspace": "default", "project": "demo", "path": OLD_CODE.0,
            "title": OLD_CODE.1, "action": "retired", "rev": "cp0", "at": iso(now),
        }])
    );
    let mut summary_said = |_: &Value| Said::Nothing;
    let line = driver
        .call("care.summary", state_params(&file, now), &mut summary_said)
        .await["result"]
        .clone();
    assert_eq!(line["retired"], 1);
    assert_eq!(line["backfilled"], 0.0);
}

#[tokio::test]
async fn a_unit_that_fails_is_marked_failed_and_logged_with_the_reason() {
    let dir = temp("failing");
    let file = path_text(&dir.join("care.json"));
    let mut driver = Driver::start().await;
    let now = ms(START);
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        // The server cannot be asked at all: the backfill pass fails before it has anything.
        "client" => Said::Error("server down"),
        other => panic!("{other}"),
    };
    let params = with(
        common(&["client"], Some(now)),
        json!({ "stateFile": file, "version": "1.0.0", "sessionsDir": path_text(&dir), "origin": "o", "git": null }),
    );
    let ran = driver.call("care.tick", params, &mut said).await;
    assert_eq!(ran["result"], "backfill");
    assert_eq!(
        driver.logs("care-failed"),
        [json!({ "unit": "backfill", "detail": "server down" })]
    );
    let state: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        state["units"]["backfill"],
        json!({ "at": iso(now), "done": false, "failed": true })
    );
}
