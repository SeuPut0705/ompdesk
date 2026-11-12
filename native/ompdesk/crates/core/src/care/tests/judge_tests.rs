//! `memory-judge.test.ts`: the cheap model's judge, Jev on a stand-in omp, and the chain.

use serde_json::{Value, json};

use super::curate_tests::{answered, launch, stand_in};
use super::*;
use crate::care::judge::{JudgedBy, PairJudgment, Step, chain_judges};
use crate::server::Fault;

fn digest(title: &str, saved: &str) -> Value {
    json!({
        "path": format!("decisions/{title}.md"), "title": title, "kind": "decision", "saved": saved,
        "scope": "project", "text": "body",
    })
}

fn pair(a: &str, b: &str) -> Value {
    json!({ "a": digest(a, "2026-10-18"), "b": digest(b, "2026-10-19") })
}

fn model_result(text: &str) -> Value {
    json!({ "text": text, "model": "pi/smol", "inputTokens": 10, "outputTokens": 5, "costUsd": 0.002 })
}

#[tokio::test]
async fn the_cheap_model_makes_one_call_for_all_pairs_and_reports_its_cost() {
    let mut driver = Driver::start().await;
    let mut messages: Vec<String> = Vec::new();
    let mut said = |asked: &Value| {
        assert_eq!(asked["kind"], "model");
        messages.push(
            asked["params"]["message"]["user"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
        Said::Value(model_result(
            &json!({ "pairs": [{ "id": "p1", "relation": "duplicate" }, { "id": "p2", "relation": "unrelated" }] })
                .to_string(),
        ))
    };
    let params = with(
        common(&["model"], None),
        json!({ "pairs": [pair("a1", "b1"), pair("a2", "b2")], "rules": "", "cwd": path_text(&temp("smol")) }),
    );
    let response = driver.call("care.judgeSmol", params, &mut said).await;
    assert_eq!(messages.len(), 1);
    let judgment = &response["result"];
    assert_eq!(judgment["by"], "smol");
    assert_eq!(judgment["verdicts"][0]["relation"], "duplicate");
    assert_eq!(judgment["verdicts"][1]["relation"], "unrelated");
    assert_eq!(judgment["costUsd"], 0.002);
    assert_eq!(judgment["model"], "pi/smol");
    assert!(judgment["ms"].as_f64().unwrap() >= 0.0);
}

#[tokio::test]
async fn the_cheap_model_did_not_decide_when_omp_fails_or_answers_prose() {
    let mut driver = Driver::start().await;
    let params = || {
        with(
            common(&["model"], None),
            json!({ "pairs": [pair("old", "new")], "rules": "", "cwd": path_text(&temp("smol")) }),
        )
    };
    let mut failing = |_: &Value| Said::Error("omp exited 1");
    let failed = driver.call("care.judgeSmol", params(), &mut failing).await;
    assert_eq!(failed["ok"], true);
    assert_eq!(failed["result"], Value::Null);
    let mut prose = |_: &Value| Said::Value(model_result("I think they differ"));
    let answered = driver.call("care.judgeSmol", params(), &mut prose).await;
    assert_eq!(answered["result"], Value::Null);
}

#[tokio::test]
async fn the_cheap_model_asks_nothing_for_no_pairs() {
    let mut driver = Driver::start().await;
    let mut said = |_: &Value| panic!("asked");
    let params = with(
        common(&["model"], None),
        json!({ "pairs": [], "rules": "", "cwd": path_text(&temp("smol")) }),
    );
    let response = driver.call("care.judgeSmol", params, &mut said).await;
    assert_eq!(response["result"], Value::Null);
    assert!(driver.asks.is_empty());
}

fn jev_params(bin_dir: &Path, enabled: bool) -> Value {
    with(
        common(&[], None),
        json!({
            "pairs": [pair("old", "new")], "enabled": enabled, "hostFile": "/x/memory-judge-host.ts",
            "cwd": path_text(bin_dir),
        }),
    )
}

#[tokio::test]
async fn jev_runs_the_host_omp_with_the_bridge_file_and_returns_its_verdicts_and_cost() {
    let omp = stand_in(&answered("A_outdated", 0.95), true);
    let mut driver = Driver::start().await;
    let bin = omp.bin.clone();
    let mut said = |asked: &Value| {
        assert_eq!(asked["kind"], "omp");
        Said::Value(launch(&bin))
    };
    let response = driver
        .call("care.judgeJev", jev_params(&omp.dir, true), &mut said)
        .await;
    assert_eq!(response["ok"], true, "{response}");
    let judgment = &response["result"];
    assert_eq!(judgment["by"], "jev");
    assert_eq!(judgment["model"], "typesafe/jev-1.14");
    assert_eq!(judgment["costUsd"], 0.00002);
    assert_eq!(
        judgment["verdicts"][0],
        json!({ "relation": "a_outdated", "confidence": 0.95 })
    );
    let argv = std::fs::read_to_string(omp.dir.join("argv")).unwrap();
    assert!(
        argv.contains("--mode rpc --no-session --no-extensions --no-skills --no-rules -e /x/memory-judge-host.ts"),
        "{argv}"
    );
    let input: Value =
        serde_json::from_str(&std::fs::read_to_string(omp.dir.join("in.json")).unwrap()).unwrap();
    assert_eq!(input["requests"].as_array().unwrap().len(), 1);
    assert_eq!(input["requests"][0]["id"], "0");
    assert_eq!(
        input["requests"][0]["request"]["state"]["noteA"]["title"],
        "old"
    );
    assert_eq!(input["timeoutMs"], 25_000);
    assert_eq!(input["concurrency"], 4);
    assert_eq!(
        input
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["requests", "timeoutMs", "concurrency"]
    );
    // The scratch folder the run made is gone.
    let scratch = std::fs::read_to_string(omp.dir.join("inpath")).unwrap();
    let scratch = Path::new(scratch.trim()).parent().unwrap().to_owned();
    assert!(!scratch.exists(), "{}", scratch.display());
}

#[tokio::test]
async fn jev_did_not_decide_with_no_native_judge() {
    let omp = stand_in(&json!({ "available": false }), true);
    let mut driver = Driver::start().await;
    let bin = omp.bin.clone();
    let mut said = |_: &Value| Said::Value(launch(&bin));
    let response = driver
        .call("care.judgeJev", jev_params(&omp.dir, true), &mut said)
        .await;
    assert_eq!(response["result"], Value::Null);
}

#[tokio::test]
async fn jev_never_starts_omp_while_the_judge_switch_is_off() {
    let omp = stand_in(&answered("duplicate", 0.99), true);
    let mut driver = Driver::start().await;
    let mut said = |_: &Value| panic!("asked");
    let response = driver
        .call("care.judgeJev", jev_params(&omp.dir, false), &mut said)
        .await;
    assert_eq!(response["result"], Value::Null);
    assert!(!omp.dir.join("argv").exists());
    assert!(driver.asks.is_empty());
}

#[tokio::test]
async fn jev_did_not_decide_when_every_answer_is_under_the_bar() {
    let omp = stand_in(&answered("duplicate", 0.4), true);
    let mut driver = Driver::start().await;
    let bin = omp.bin.clone();
    let mut said = |_: &Value| Said::Value(launch(&bin));
    let response = driver
        .call("care.judgeJev", jev_params(&omp.dir, true), &mut said)
        .await;
    assert_eq!(response["result"], Value::Null);
}

#[tokio::test]
async fn jev_reads_a_probability_on_the_bar_as_a_verdict() {
    let omp = stand_in(&answered("duplicate", 0.6), true);
    let mut driver = Driver::start().await;
    let bin = omp.bin.clone();
    let mut said = |_: &Value| Said::Value(launch(&bin));
    let response = driver
        .call("care.judgeJev", jev_params(&omp.dir, true), &mut said)
        .await;
    assert_eq!(response["result"]["verdicts"][0]["relation"], "duplicate");
}

#[tokio::test]
async fn jev_did_not_decide_when_the_host_wrote_nothing_or_omp_cannot_start() {
    let silent = stand_in(&answered("duplicate", 0.9), false);
    let mut driver = Driver::start().await;
    let bin = silent.bin.clone();
    let mut said = |_: &Value| Said::Value(launch(&bin));
    let response = driver
        .call("care.judgeJev", jev_params(&silent.dir, true), &mut said)
        .await;
    assert_eq!(response["result"], Value::Null);
    // No omp at the path: the run is over at once, with no file.
    let mut missing = |_: &Value| Said::Value(launch(&path_text(&silent.dir.join("no-such-omp"))));
    let response = driver
        .call("care.judgeJev", jev_params(&silent.dir, true), &mut missing)
        .await;
    assert_eq!(response["result"], Value::Null);
    // main could not find an omp.
    let mut refused = |_: &Value| Said::Error("omp is not installed");
    let response = driver
        .call("care.judgeJev", jev_params(&silent.dir, true), &mut refused)
        .await;
    assert_eq!(response["result"], Value::Null);
}

fn judgment(by: JudgedBy, decided: &[bool]) -> PairJudgment {
    PairJudgment {
        by,
        verdicts: decided
            .iter()
            .map(|yes| {
                yes.then_some(crate::care::judge::PairVerdict {
                    relation: crate::care::judge::Relation::Duplicate,
                    confidence: 0.9,
                })
            })
            .collect(),
        model: "m".to_owned(),
        cost_usd: 1.0,
        ms: 1.0,
    }
}

type Seen = std::sync::Arc<std::sync::Mutex<Vec<usize>>>;

/// A step that answers `answer` and notes it was asked.
fn answering<'a>(answer: Option<PairJudgment>, seen: &Seen, count: usize) -> Step<'a> {
    let seen = std::sync::Arc::clone(seen);
    Box::new(move || {
        Box::pin(async move {
            seen.lock().unwrap().push(count);
            Ok::<_, Fault>(answer)
        })
    })
}

#[tokio::test]
async fn the_chain_uses_the_first_judge_that_answers_for_the_whole_batch_and_does_not_ask_a_later_one()
 {
    let (jev_seen, smol_seen): (Seen, Seen) = Default::default();
    let answer = chain_judges(vec![
        answering(
            Some(judgment(JudgedBy::Jev, &[true, false, true])),
            &jev_seen,
            3,
        ),
        answering(
            Some(judgment(JudgedBy::Smol, &[true, true, true])),
            &smol_seen,
            3,
        ),
    ])
    .await
    .unwrap()
    .unwrap();
    assert_eq!(*jev_seen.lock().unwrap(), [3]);
    assert!(smol_seen.lock().unwrap().is_empty());
    assert_eq!(answer.by, JudgedBy::Jev);
    assert_eq!(
        answer
            .verdicts
            .iter()
            .map(|verdict| verdict.is_some())
            .collect::<Vec<_>>(),
        [true, false, true]
    );
    assert_eq!(answer.cost_usd, 1.0);
}

#[tokio::test]
async fn the_chain_goes_on_to_the_next_judge_when_one_did_not_answer_at_all() {
    let (first, smol_seen): (Seen, Seen) = Default::default();
    let answer = chain_judges(vec![
        answering(None, &first, 1),
        answering(Some(judgment(JudgedBy::Smol, &[true])), &smol_seen, 1),
    ])
    .await
    .unwrap()
    .unwrap();
    assert_eq!(answer.by, JudgedBy::Smol);
    assert_eq!(*smol_seen.lock().unwrap(), [1]);
}

#[tokio::test]
async fn the_chain_did_not_decide_when_no_judge_decided_and_a_failing_judge_fails_it() {
    let seen: Seen = Default::default();
    assert!(
        chain_judges(vec![answering(None, &seen, 1), answering(None, &seen, 1)])
            .await
            .unwrap()
            .is_none()
    );
    let failing: Step<'_> = Box::new(|| Box::pin(async { Err(Fault::new("x", "boom")) }));
    let fault = chain_judges(vec![
        failing,
        answering(Some(judgment(JudgedBy::Smol, &[true])), &seen, 1),
    ])
    .await
    .unwrap_err();
    assert_eq!(fault.message, "boom");
}
