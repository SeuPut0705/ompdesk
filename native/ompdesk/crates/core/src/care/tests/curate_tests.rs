//! `curate.test.ts`: curation over an in-memory ai-memory (answered as the `client` ask) and a judge answered as the
//! `judge` ask, then production's chain (Jev on a stand-in omp).

use serde_json::{Value, json};

use super::*;

const PROJECT: &str = "demo";

#[derive(Clone)]
pub(super) struct Seed {
    project: &'static str,
    path: &'static str,
    title: &'static str,
    body: String,
    at: &'static str,
    pinned: bool,
}

fn seed(
    project: &'static str,
    path: &'static str,
    title: &'static str,
    body: &str,
    at: &'static str,
) -> Seed {
    Seed {
        project,
        path,
        title,
        body: body.to_owned(),
        at,
        pinned: false,
    }
}

pub(super) struct Stored {
    seed: Seed,
    id: String,
    gone: bool,
}

/// An in-memory ai-memory: a retired page leaves `pages`, as the real list hides an expired page.
#[derive(Default)]
pub(super) struct Memory {
    pub(super) pages: Vec<Stored>,
    pub(super) retired: Vec<Value>,
    reads: Vec<String>,
    /// What the next retire answers instead of retiring (a page that changed or is pinned meanwhile).
    retire_answer: Option<&'static str>,
    /// A project whose page list fails.
    unlistable: Option<&'static str>,
    sessions: Vec<Value>,
}

impl Memory {
    pub(super) fn new(seeds: &[Seed]) -> Memory {
        Memory {
            pages: seeds
                .iter()
                .enumerate()
                .map(|(index, seed)| Stored {
                    seed: seed.clone(),
                    id: format!("id-{index}"),
                    gone: false,
                })
                .collect(),
            ..Memory::default()
        }
    }

    fn find(&mut self, project: &str, path: &str) -> Option<&mut Stored> {
        self.pages
            .iter_mut()
            .find(|page| page.seed.project == project && page.seed.path == path)
    }

    pub(super) fn answer(&mut self, op: &str, args: &[Value]) -> Said {
        match op {
            "headCheckpoint" => Said::Value(json!(format!("cp{}", self.retired.len()))),
            "conclusions" => Said::Value(
                json!({ "rows": [], "next": 0, "more": false, "store": "s", "last": 0 }),
            ),
            "projects" => {
                let mut names: Vec<&str> = Vec::new();
                for page in &self.pages {
                    if !names.contains(&page.seed.project) {
                        names.push(page.seed.project);
                    }
                }
                let mut projects: Vec<Value> = Vec::new();
                if let Some(name) = self.unlistable {
                    projects.push(json!({ "workspace": "default", "project": name, "pages": 6, "lastUpdated": null }));
                }
                projects.extend(names.into_iter().map(|name| {
                    json!({ "workspace": "default", "project": name, "pages": 0, "lastUpdated": null })
                }));
                Said::Value(json!(projects))
            }
            "pages" => {
                let project = args[0]["project"].as_str().unwrap();
                if self.unlistable == Some(project) {
                    return Said::Error("project 'seuput0705-ompdesk' is ambiguous");
                }
                let refs: Vec<Value> = self
                    .pages
                    .iter()
                    .filter(|page| page.seed.project == project && !page.gone)
                    .map(|page| {
                        json!({
                            "workspace": "default", "project": project, "path": page.seed.path,
                            "title": page.seed.title, "tier": "semantic", "updatedAt": page.seed.at,
                        })
                    })
                    .collect();
                Said::Value(json!(refs))
            }
            "page" => {
                let (project, path) = (
                    args[0]["project"].as_str().unwrap(),
                    args[0]["path"].as_str().unwrap(),
                );
                self.reads.push(format!("{project}/{path}"));
                match self.find(project, path) {
                    None => Said::Error("not found"),
                    Some(page) => Said::Value(json!({
                        "workspace": "default", "project": page.seed.project, "path": page.seed.path,
                        "title": page.seed.title, "tier": "semantic", "updatedAt": page.seed.at,
                        "markdown": format!("# {}\n\n{}\n", page.seed.title, page.seed.body),
                        "id": page.id, "pinned": page.seed.pinned, "createdAt": page.seed.at, "tags": [],
                    })),
                }
            }
            "retirePage" => {
                let input = &args[0];
                let (project, path) = (
                    input["project"].as_str().unwrap(),
                    input["path"].as_str().unwrap(),
                );
                let answer = self.retire_answer;
                let Some(page) = self.find(project, path) else {
                    return Said::Error("not found");
                };
                if let Some(answer) = answer {
                    return Said::Value(json!(answer));
                }
                if page.seed.pinned {
                    return Said::Value(json!("pinned"));
                }
                if input["expectedPageId"]
                    .as_str()
                    .is_some_and(|id| id != page.id)
                {
                    return Said::Value(json!("changed"));
                }
                page.gone = true;
                self.retired.push(json!({
                    "project": project, "path": path, "successor": input.get("successor"),
                    "reason": input.get("reason"), "expectedPageId": input.get("expectedPageId"),
                }));
                Said::Value(json!("retired"))
            }
            "sessions" => Said::Value(json!(self.sessions)),
            other => panic!("{other}"),
        }
    }
}

pub(super) const OLD_CODE: (&str, &str, &str, &str) = (
    "decisions/pairing-code.md",
    "Phones pair with an eight digit pairing code",
    "A phone connects by typing the eight digit pairing code the computer shows. The code expires after one use.",
    "2026-10-18T09:00:00Z",
);
pub(super) const NEW_TAILSCALE: (&str, &str, &str, &str) = (
    "decisions/tailscale-identity.md",
    "Phones connect by Tailscale identity, no pairing code",
    "Pairing code removed: a phone signed in to the same Tailscale account connects with no pairing code step at all.",
    "2026-10-19T09:00:00Z",
);
const PUSH: (&str, &str, &str, &str) = (
    "procedures/check-before-push.md",
    "Run the changed-file checks before pushing",
    "Before you push, run bun run check:changed and make sure lint, types and tests pass.",
    "2026-10-19T05:00:00Z",
);
const MERGE: (&str, &str, &str, &str) = (
    "procedures/ci-before-merge.md",
    "Check that CI is green before merging",
    "Before you merge a pull request, make sure every CI job is green; fix the cause of any failure first.",
    "2026-10-19T05:10:00Z",
);

pub(super) fn of(page: (&'static str, &'static str, &'static str, &'static str)) -> Seed {
    seed(PROJECT, page.0, page.1, page.2, page.3)
}

/// A judge that says `relation` of every pair, by `by`.
pub(super) fn says(relation: &'static str, by: &'static str) -> impl Fn(&Value) -> Value {
    move |asked| {
        let count = asked["params"]["pairs"].as_array().unwrap().len();
        json!({
            "by": by,
            "verdicts": vec![json!({ "relation": relation, "confidence": 0.9 }); count],
            "model": "fake", "costUsd": 0.001, "ms": 5,
        })
    }
}

struct Run {
    memory: Memory,
    logs: Vec<Value>,
    response: Value,
    asked_judge: Vec<usize>,
}

fn curate_params(extra: Value) -> Value {
    with(
        common(&["client", "judge"], Some(ms("2026-10-20T00:00:00Z"))),
        extra,
    )
}

/// One run over `memory`, the judge answering as `judge` says (`None`: the answer null).
async fn run_over(
    driver: &mut Driver,
    memory: Memory,
    extra: Value,
    judge: Option<&dyn Fn(&Value) -> Value>,
) -> Run {
    let mut memory = memory;
    let mut asked_judge = Vec::new();
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            memory.answer(op, args)
        }
        "judge" => {
            asked_judge.push(asked["params"]["pairs"].as_array().unwrap().len());
            Said::Value(judge.map_or(Value::Null, |judge| judge(asked)))
        }
        "rules" => Said::Value(json!("## Tailscale\n- **No pairing code**: identity only")),
        other => panic!("{other}"),
    };
    let before = driver.events.len();
    let response = driver
        .call("care.curate", curate_params(extra), &mut said)
        .await;
    let logs = driver.events[before..]
        .iter()
        .filter(|event| event["data"]["message"] == "care-curate")
        .map(|event| event["data"]["details"].clone())
        .collect();
    Run {
        memory,
        logs,
        response,
        asked_judge,
    }
}

fn report(run: &Run) -> &Value {
    assert_eq!(run.response["ok"], true, "{}", run.response);
    &run.response["result"]
}

fn results(run: &Run) -> Vec<Value> {
    report(run)["retirements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| json!([item["path"], item["result"], item["by"]]))
        .collect()
}

fn retired_paths(memory: &Memory) -> Vec<String> {
    memory
        .retired
        .iter()
        .map(|item| item["path"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn retires_the_older_page_the_newer_one_contradicts_naming_its_successor_and_keeps_the_newer()
{
    let mut driver = Driver::start().await;
    let judge = says("a_outdated", "jev");
    let run = run_over(
        &mut driver,
        Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]),
        json!({}),
        Some(&judge),
    )
    .await;
    assert_eq!(
        run.memory.retired,
        [json!({
            "project": PROJECT, "path": OLD_CODE.0, "successor": NEW_TAILSCALE.0, "reason": null,
            "expectedPageId": "id-0",
        })]
    );
    assert_eq!(results(&run), [json!([OLD_CODE.0, "retired", "jev"])]);
    assert!((report(&run)["costUsd"].as_f64().unwrap() - 0.001).abs() < 1e-12);
    assert_eq!(report(&run)["retirements"][0]["relation"], "a_outdated");
    assert_eq!(report(&run)["retirements"][0]["confidence"], 0.9);
}

#[tokio::test]
async fn a_project_the_server_cannot_list_is_left_out_and_the_others_are_still_curated() {
    let mut driver = Driver::start().await;
    let mut memory = Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]);
    memory.unlistable = Some("seuput0705-ompdesk");
    let judge = says("a_outdated", "jev");
    let run = run_over(&mut driver, memory, json!({}), Some(&judge)).await;
    assert_eq!(retired_paths(&run.memory), [OLD_CODE.0]);
}

#[tokio::test]
async fn retires_the_newer_page_when_the_judge_says_the_older_one_is_the_current_truth() {
    let mut driver = Driver::start().await;
    let judge = says("b_outdated", "jev");
    let run = run_over(
        &mut driver,
        Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]),
        json!({}),
        Some(&judge),
    )
    .await;
    assert_eq!(
        run.memory
            .retired
            .iter()
            .map(|item| json!([item["path"], item["successor"]]))
            .collect::<Vec<_>>(),
        [json!([NEW_TAILSCALE.0, OLD_CODE.0])]
    );
}

#[tokio::test]
async fn is_idempotent_a_retired_page_is_not_listed_judged_or_retired_again() {
    let mut driver = Driver::start().await;
    let judge = says("a_outdated", "jev");
    let first = run_over(
        &mut driver,
        Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]),
        json!({}),
        Some(&judge),
    )
    .await;
    let second = run_over(&mut driver, first.memory, json!({}), None).await;
    assert_eq!(second.asked_judge, Vec::<usize>::new());
    assert_eq!(report(&second)["retirements"], json!([]));
    assert_eq!(second.memory.retired.len(), 1);
}

#[tokio::test]
async fn retires_nothing_for_an_unrelated_verdict_and_reports_the_pair_so_a_caller_can_skip_it_next_time()
 {
    let mut driver = Driver::start().await;
    let judge = says("unrelated", "jev");
    let first = run_over(
        &mut driver,
        Memory::new(&[of(PUSH), of(MERGE)]),
        json!({}),
        Some(&judge),
    )
    .await;
    assert_eq!(first.memory.retired, Vec::<Value>::new());
    let unrelated = report(&first)["unrelated"].clone();
    assert_eq!(unrelated.as_array().unwrap().len(), 1);
    let second = run_over(
        &mut driver,
        first.memory,
        json!({ "skip": unrelated }),
        None,
    )
    .await;
    assert_eq!(second.asked_judge, Vec::<usize>::new());
}

#[tokio::test]
async fn without_a_judge_only_a_near_identical_copy_retires_and_a_look_alike_stays() {
    let mut driver = Driver::start().await;
    let copy = seed(
        PROJECT,
        "procedures/check-before-push-copy.md",
        PUSH.1,
        PUSH.2,
        "2026-10-18T05:00:00Z",
    );
    let memory = Memory::new(&[
        of(PUSH),
        copy.clone(),
        of(MERGE),
        of(OLD_CODE),
        of(NEW_TAILSCALE),
    ]);
    // No `judge` ask and no production judge: the code rule alone.
    let params = with(
        common(&["client"], Some(ms("2026-10-20T00:00:00Z"))),
        json!({}),
    );
    let mut memory = memory;
    let mut said = |asked: &Value| {
        let (op, args) = client_op(asked).unwrap();
        memory.answer(op, args)
    };
    let response = driver.call("care.curate", params, &mut said).await;
    assert_eq!(retired_paths(&memory), [copy.path]);
    assert_eq!(
        response["result"]["by"],
        json!({ "jev": 0, "smol": 0, "code": 1 })
    );
    assert!(response["result"]["undecided"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn falls_back_to_the_code_rule_when_the_judge_answers_nothing() {
    let mut driver = Driver::start().await;
    let copy = seed(
        PROJECT,
        "procedures/check-before-push-copy.md",
        PUSH.1,
        PUSH.2,
        "2026-10-18T05:00:00Z",
    );
    let run = run_over(
        &mut driver,
        Memory::new(&[of(PUSH), copy.clone()]),
        json!({}),
        None,
    )
    .await;
    assert_eq!(retired_paths(&run.memory), [copy.path]);
}

#[tokio::test]
async fn never_calls_two_long_pages_one_because_their_first_600_characters_match() {
    let opening = "Release steps for the desktop app, checked every time before a tag. ".repeat(10);
    let mac = seed(
        PROJECT,
        "procedures/release-mac.md",
        "Release steps",
        &format!(
            "{opening}Then sign the DMG with the pinned certificate and verify the designated requirement."
        ),
        "2026-10-18T05:00:00Z",
    );
    let windows = seed(
        PROJECT,
        "procedures/release-windows.md",
        "Release steps",
        &format!(
            "{opening}Then build the NSIS setup on the Windows runner and never sign with the Mac certificate."
        ),
        "2026-10-19T05:00:00Z",
    );
    let mut driver = Driver::start().await;
    let code = run_over(
        &mut driver,
        Memory::new(&[mac.clone(), windows.clone()]),
        json!({}),
        None,
    )
    .await;
    assert_eq!(code.memory.retired, Vec::<Value>::new());
    let judge = says("duplicate", "jev");
    let judged = run_over(
        &mut driver,
        Memory::new(&[mac, windows]),
        json!({}),
        Some(&judge),
    )
    .await;
    assert_eq!(judged.memory.retired, Vec::<Value>::new());
    assert_eq!(report(&judged)["undecided"], 1);
}

#[tokio::test]
async fn still_lets_a_judge_retire_when_both_pages_fit_in_what_it_read() {
    let mut driver = Driver::start().await;
    let judge = says("duplicate", "jev");
    let run = run_over(
        &mut driver,
        Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]),
        json!({}),
        Some(&judge),
    )
    .await;
    assert_eq!(retired_paths(&run.memory), [OLD_CODE.0]);
}

#[tokio::test]
async fn never_retires_a_pinned_page_whether_the_list_says_so_or_the_server_answers_pinned() {
    let mut driver = Driver::start().await;
    let judge = says("a_outdated", "jev");
    let mut pinned = of(OLD_CODE);
    pinned.pinned = true;
    let first = run_over(
        &mut driver,
        Memory::new(&[pinned, of(NEW_TAILSCALE)]),
        json!({}),
        Some(&judge),
    )
    .await;
    assert_eq!(first.memory.retired, Vec::<Value>::new());
    assert_eq!(report(&first)["retirements"], json!([]));

    let mut raced = Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]);
    raced.retire_answer = Some("pinned");
    let second = run_over(&mut driver, raced, json!({}), Some(&judge)).await;
    assert_eq!(results(&second), [json!([OLD_CODE.0, "pinned", "jev"])]);
    assert!(second.logs.iter().all(|log| log["event"] != "retire"));
}

#[tokio::test]
async fn leaves_a_page_that_changed_after_it_was_judged() {
    let mut driver = Driver::start().await;
    let judge = says("a_outdated", "jev");
    let mut memory = Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]);
    memory.retire_answer = Some("changed");
    let run = run_over(&mut driver, memory, json!({}), Some(&judge)).await;
    assert_eq!(results(&run), [json!([OLD_CODE.0, "changed", "jev"])]);
    assert_eq!(run.memory.retired, Vec::<Value>::new());
}

#[tokio::test]
async fn keeps_a_projects_page_that_differs_from_a_general_preference_but_drops_a_project_copy_of_one()
 {
    let general = seed(
        "_global",
        "preferences/indent.md",
        "Indent code with two spaces",
        "Where a project sets no rule, indent code with two spaces.",
        "2026-10-19T06:00:00Z",
    );
    let over = seed(
        PROJECT,
        "decisions/tabs.md",
        "This project indents with tabs",
        "Source files in this repository are indented with tabs, as the formatter configuration says.",
        "2026-10-19T07:00:00Z",
    );
    let mut driver = Driver::start().await;
    let outdated = says("a_outdated", "jev");
    let a = run_over(
        &mut driver,
        Memory::new(&[general.clone(), over.clone()]),
        json!({}),
        Some(&outdated),
    )
    .await;
    assert_eq!(a.memory.retired, Vec::<Value>::new());
    let duplicate = says("duplicate", "jev");
    let b = run_over(
        &mut driver,
        Memory::new(&[general.clone(), over.clone()]),
        json!({}),
        Some(&duplicate),
    )
    .await;
    assert_eq!(
        b.memory
            .retired
            .iter()
            .map(|item| json!([item["project"], item["path"], item["successor"]]))
            .collect::<Vec<_>>(),
        [json!([PROJECT, over.path, general.path])]
    );
}

#[tokio::test]
async fn does_not_compare_pages_of_two_projects_and_never_reads_a_session_page() {
    let other = seed(
        "elsewhere",
        NEW_TAILSCALE.0,
        NEW_TAILSCALE.1,
        NEW_TAILSCALE.2,
        NEW_TAILSCALE.3,
    );
    let session = seed(
        PROJECT,
        "sessions/abc.md",
        NEW_TAILSCALE.1,
        NEW_TAILSCALE.2,
        NEW_TAILSCALE.3,
    );
    let mut driver = Driver::start().await;
    let judge = says("a_outdated", "jev");
    let run = run_over(
        &mut driver,
        Memory::new(&[of(OLD_CODE), other, session]),
        json!({}),
        Some(&judge),
    )
    .await;
    assert_eq!(report(&run)["candidates"], 0);
    assert_eq!(run.memory.retired, Vec::<Value>::new());
    assert!(
        !run.memory
            .reads
            .contains(&format!("{PROJECT}/sessions/abc.md"))
    );
}

#[tokio::test]
async fn dry_run_reports_the_plan_and_changes_and_logs_nothing() {
    let mut driver = Driver::start().await;
    let judge = says("a_outdated", "jev");
    let run = run_over(
        &mut driver,
        Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]),
        json!({ "dryRun": true }),
        Some(&judge),
    )
    .await;
    assert_eq!(report(&run)["retirements"][0]["result"], "planned");
    assert_eq!(run.memory.retired, Vec::<Value>::new());
    assert_eq!(run.logs, Vec::<Value>::new());
}

#[tokio::test]
async fn asks_about_at_most_max_pairs_pairs_and_says_how_many_were_found() {
    let seeds: Vec<Seed> = (0..6)
        .map(|index| {
            let at = ["2026-10-10T00:00:00Z", "2026-10-11T00:00:00Z", "2026-10-12T00:00:00Z",
                      "2026-10-13T00:00:00Z", "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"][index];
            let paths = ["decisions/theme-0.md", "decisions/theme-1.md", "decisions/theme-2.md",
                         "decisions/theme-3.md", "decisions/theme-4.md", "decisions/theme-5.md"];
            let titles = ["Theme palette rule 0", "Theme palette rule 1", "Theme palette rule 2",
                          "Theme palette rule 3", "Theme palette rule 4", "Theme palette rule 5"];
            seed(
                PROJECT,
                paths[index],
                titles[index],
                "Every theme palette keeps its accent colour apart from the other themes in the same scheme.",
                at,
            )
        })
        .collect();
    let mut driver = Driver::start().await;
    let run = run_over(
        &mut driver,
        Memory::new(&seeds),
        json!({ "maxPairs": 2 }),
        None,
    )
    .await;
    assert_eq!(run.asked_judge, [2]);
    assert_eq!(report(&run)["judged"], 2);
    assert!(report(&run)["candidates"].as_u64().unwrap() > 2);
}

#[tokio::test]
async fn logs_one_care_curate_line_per_retire_and_one_summary_line_for_the_run() {
    let mut driver = Driver::start().await;
    let judge = says("a_outdated", "jev");
    let run = run_over(
        &mut driver,
        Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]),
        json!({}),
        Some(&judge),
    )
    .await;
    assert_eq!(
        run.logs
            .iter()
            .map(|log| log["event"].clone())
            .collect::<Vec<_>>(),
        [json!("retire"), json!("run")]
    );
    assert_eq!(
        run.logs[0],
        json!({
            "event": "retire", "workspace": "default", "project": PROJECT, "path": OLD_CODE.0,
            "successor": format!("{PROJECT}/{}", NEW_TAILSCALE.0), "relation": "a_outdated", "by": "jev",
            "confidence": 0.9,
        })
    );
    let summary = &run.logs[1];
    assert_eq!(summary["retired"], 1);
    assert_eq!(summary["judged"], 1);
    assert_eq!(summary["jev"], 1);
    assert_eq!(summary["models"], "fake");
    assert_eq!(summary["costUsd"], 0.001);
    assert_eq!(summary["skipped"], 0);
}

#[tokio::test]
async fn never_retires_one_page_for_two_pairs_nor_a_page_another_retire_named_as_its_successor() {
    let mid = seed(
        PROJECT,
        "decisions/pairing-code-v2.md",
        OLD_CODE.1,
        OLD_CODE.2,
        "2026-10-18T20:00:00Z",
    );
    let mut driver = Driver::start().await;
    let judge = says("a_outdated", "jev");
    let run = run_over(
        &mut driver,
        Memory::new(&[of(OLD_CODE), mid, of(NEW_TAILSCALE)]),
        json!({}),
        Some(&judge),
    )
    .await;
    let retired = retired_paths(&run.memory);
    let successors: Vec<&str> = run
        .memory
        .retired
        .iter()
        .map(|item| item["successor"].as_str().unwrap())
        .collect();
    assert!(
        retired
            .iter()
            .all(|path| !successors.contains(&path.as_str()))
    );
    let unique: std::collections::HashSet<&String> = retired.iter().collect();
    assert_eq!(unique.len(), retired.len());
}

#[tokio::test]
async fn shows_the_judge_the_rules_outline_of_the_folder_the_projects_newest_session_ran_in() {
    let mut memory = Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]);
    let session = |id: &str, cwd: &str| {
        json!({ "id": id, "cwd": cwd, "agent": "omp", "startedAt": null, "endedAt": null,
                "observations": 0, "consolidation": null })
    };
    memory.sessions = vec![session("s2", ""), session("s1", "/work/demo")];
    let judge = says("a_outdated", "jev");
    let mut driver = Driver::start().await;
    let mut asked_rules: Vec<Value> = Vec::new();
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            memory.answer(op, args)
        }
        "judge" => Said::Value(judge(asked)),
        "rules" => {
            asked_rules.push(asked["params"].clone());
            Said::Value(json!("## Tailscale\n- **No pairing code**: identity only"))
        }
        other => panic!("{other}"),
    };
    let params = with(
        common(
            &["client", "judge", "rules"],
            Some(ms("2026-10-20T00:00:00Z")),
        ),
        json!({ "projectRules": true }),
    );
    let mut rules_in_judge: Vec<String> = Vec::new();
    let mut wrapped = |asked: &Value| {
        if asked["kind"] == "judge" {
            rules_in_judge.push(asked["params"]["rules"].as_str().unwrap().to_owned());
        }
        said(asked)
    };
    driver.call("care.curate", params, &mut wrapped).await;
    assert_eq!(asked_rules, [json!({ "cwd": "/work/demo" })]);
    assert!(
        rules_in_judge[0].contains("No pairing code"),
        "{rules_in_judge:?}"
    );
}

/// A stand-in omp: records its argv and the Jev input, and writes the host's answer.
mod production {
    use super::*;

    /// A folder with a stand-in omp that copies `answer` where the host writes its output.
    pub struct StandIn {
        pub dir: PathBuf,
        pub bin: String,
    }

    pub fn stand_in(answer: &Value, writes: bool) -> StandIn {
        let dir = temp("omp");
        let fixture = dir.join("answer.json");
        std::fs::write(&fixture, answer.to_string()).unwrap();
        let q = |name: &str| path_text(&dir.join(name));
        let (bin, script) = if cfg!(windows) {
            let copy = if writes {
                format!(
                    "copy /Y \"{}\" \"%OMP_GUI_MEMORY_JUDGE_OUT%\" >nul\r\n",
                    path_text(&fixture)
                )
            } else {
                String::new()
            };
            (
                path_text(&dir.join("omp.cmd")),
                format!(
                    "@echo off\r\necho %* > \"{}\"\r\ncopy /Y \"%OMP_GUI_MEMORY_JUDGE_IN%\" \"{}\" >nul\r\necho %OMP_GUI_MEMORY_JUDGE_IN%> \"{}\"\r\n{copy}",
                    q("argv"),
                    q("in.json"),
                    q("inpath"),
                ),
            )
        } else {
            let copy = if writes {
                format!(
                    "cp '{}' \"$OMP_GUI_MEMORY_JUDGE_OUT\"\n",
                    path_text(&fixture)
                )
            } else {
                String::new()
            };
            (
                path_text(&dir.join("omp")),
                format!(
                    "#!/bin/sh\necho \"$@\" > '{}'\ncp \"$OMP_GUI_MEMORY_JUDGE_IN\" '{}'\necho \"$OMP_GUI_MEMORY_JUDGE_IN\" > '{}'\n{copy}",
                    q("argv"),
                    q("in.json"),
                    q("inpath"),
                ),
            )
        };
        std::fs::write(&bin, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        StandIn { dir, bin }
    }

    /// The launch main answers `omp` with: the stand-in and this process's environment.
    pub fn launch(bin: &str) -> Value {
        let env: serde_json::Map<String, Value> = std::env::vars()
            .map(|(name, value)| (name, json!(value)))
            .collect();
        json!({ "bin": bin, "env": env })
    }

    pub fn answered(choice: &str, probability: f64) -> Value {
        json!({
            "available": true,
            "results": [{
                "id": "0", "ms": 5,
                "answers": { "relation": { "type": "choice", "choice": choice,
                                           "probabilities": { choice: probability }, "confidence": 0.9 } },
            }],
            "usage": [{ "model": "typesafe/jev-1.14", "usage": { "cost": { "total": 0.00002 } } }],
        })
    }
}

#[tokio::test]
async fn production_judges_with_jev_on_the_users_omp_and_curation_retires_what_it_says() {
    let omp = production::stand_in(&production::answered("A_outdated", 0.95), true);
    let cwd = temp("cwd");
    let mut driver = Driver::start().await;
    let mut memory = Memory::new(&[of(OLD_CODE), of(NEW_TAILSCALE)]);
    let mut omp_asks = 0;
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            memory.answer(op, args)
        }
        "omp" => {
            omp_asks += 1;
            Said::Value(production::launch(&omp.bin))
        }
        other => panic!("{other}"),
    };
    let params = with(
        common(&["client"], Some(ms("2026-10-20T00:00:00Z"))),
        json!({ "judge": { "enabled": true, "hostFile": "/x/memory-judge-host.ts", "cwd": path_text(&cwd.join("empty")) } }),
    );
    let response = driver.call("care.curate", params, &mut said).await;
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["by"]["jev"], 1);
    assert_eq!(response["result"]["models"], json!(["typesafe/jev-1.14"]));
    assert_eq!(retired_paths(&memory), [OLD_CODE.0]);
    // The user's omp is asked for once for the whole chain, and its empty folder was made.
    assert_eq!(omp_asks, 1);
    assert!(cwd.join("empty").is_dir());
    let argv = std::fs::read_to_string(omp.dir.join("argv")).unwrap();
    assert!(
        argv.contains("--mode rpc --no-session --no-extensions --no-skills --no-rules -e /x/memory-judge-host.ts"),
        "{argv}"
    );
}

#[tokio::test]
async fn production_with_no_omp_that_can_run_judges_with_the_code_rule_alone() {
    let mut driver = Driver::start().await;
    let copy = seed(
        PROJECT,
        "procedures/check-before-push-copy.md",
        PUSH.1,
        PUSH.2,
        "2026-10-18T05:00:00Z",
    );
    let mut memory = Memory::new(&[of(PUSH), copy.clone()]);
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            memory.answer(op, args)
        }
        "omp" => Said::Error("omp is not installed"),
        other => panic!("{other}"),
    };
    let params = with(
        common(&["client"], Some(ms("2026-10-20T00:00:00Z"))),
        json!({ "judge": { "enabled": true, "hostFile": "h", "cwd": path_text(&temp("none")) } }),
    );
    let response = driver.call("care.curate", params, &mut said).await;
    assert_eq!(
        response["result"]["by"],
        json!({ "jev": 0, "smol": 0, "code": 1 })
    );
    assert_eq!(retired_paths(&memory), [copy.path]);
}

/// Used by the judge tests: the stand-in omp.
pub use production::{answered, launch, stand_in};
