//! `freshness.test.ts`: the check over real temp repositories (the core's git in process) and a stand-in server.

use std::process::Command;
use std::sync::LazyLock;

use serde_json::{Map, Value, json};

use super::*;

struct Repo {
    /// The root that holds the main checkout (the temp folder, as the OS spells it).
    root: PathBuf,
    main: PathBuf,
    worktree: PathBuf,
}

fn git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&status.stderr)
    );
}

fn put(main: &Path, path: &str, text: &str) {
    let file = joined(main, path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

/// The repository of `freshness.test.ts`: names that were deleted, one renamed, some that stay; a worktree of it.
fn repo() -> &'static Repo {
    static REPO: LazyLock<Repo> = LazyLock::new(|| {
        // The OS's own spelling, not the `\\?\` form `canonicalize` gives on Windows (git cannot make a worktree there).
        let root = temp("fresh").canonicalize().unwrap();
        let root = PathBuf::from(path_text(&root).trim_start_matches(r"\\?\"));
        let (main, worktree) = (root.join("main"), root.join("wt"));
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        put(
            &main,
            "src/main/old-feature.ts",
            "export function legacyWidgetBuild() {}\n",
        );
        put(
            &main,
            "src/main/old-twin.ts",
            "export const legacyTwinValue = 1;\n",
        );
        put(
            &main,
            "src/main/keep.ts",
            "export function keepAlive() {}\n",
        );
        put(
            &main,
            "src/main/moved-old.ts",
            &"export const movedThing = 1;\n".repeat(5),
        );
        put(&main, "scripts/gone.sh", "echo gone\n");
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-qm", "one"]);
        git(
            &main,
            &[
                "rm",
                "-q",
                "src/main/old-feature.ts",
                "src/main/old-twin.ts",
                "scripts/gone.sh",
            ],
        );
        std::fs::create_dir(main.join("src/lib")).unwrap();
        git(
            &main,
            &["mv", "src/main/moved-old.ts", "src/lib/moved-new.ts"],
        );
        git(&main, &["commit", "-qm", "two"]);
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                worktree.to_str().unwrap(),
                "-b",
                "feature",
            ],
        );
        Repo {
            root,
            main,
            worktree,
        }
    });
    &REPO
}

/// Main's git rules, as `gitRunner` hands them.
fn runner() -> Value {
    let runner = crate::git::run::tests::runner();
    json!({
        "bin": runner.bin, "args": runner.args, "env": runner.env, "timeoutMs": runner.timeout_ms,
        "maxBytes": runner.max_bytes,
    })
}

struct Page {
    kind: &'static str,
    markdown: &'static str,
    pinned: bool,
}

fn page(kind: &'static str, markdown: &'static str) -> Page {
    Page {
        kind,
        markdown,
        pinned: false,
    }
}

/// The `client` of the test: the project's pages, its sessions' folders and what was changed.
struct Fake {
    pages: Vec<(&'static str, Page)>,
    cwds: Vec<String>,
    retired: Vec<Value>,
    flagged_paths: Vec<String>,
    fail_feedback: bool,
}

fn fake(pages: Vec<(&'static str, Page)>) -> Fake {
    Fake {
        pages,
        cwds: vec![path_text(&repo().worktree)],
        retired: Vec::new(),
        flagged_paths: Vec::new(),
        fail_feedback: false,
    }
}

impl Fake {
    fn answer(&mut self, op: &str, args: &[Value]) -> Said {
        match op {
            "pages" => Said::Value(json!(self
                .pages
                .iter()
                .map(|(path, page)| json!({
                    "workspace": "default", "project": "demo", "path": path, "title": path,
                    "kind": page.kind, "tier": null, "updatedAt": null,
                }))
                .collect::<Vec<_>>())),
            "page" => {
                let path = args[0]["path"].as_str().unwrap();
                match self.pages.iter().find(|(known, _)| *known == path) {
                    None => Said::Error("no page"),
                    Some((_, page)) => Said::Value(json!({
                        "workspace": "default", "project": "demo", "path": path, "title": path,
                        "updatedAt": null, "kind": page.kind, "markdown": page.markdown,
                        "id": format!("id-{path}"), "pinned": page.pinned, "createdAt": null, "tags": [],
                    })),
                }
            }
            "sessions" => Said::Value(json!(self
                .cwds
                .iter()
                .enumerate()
                .map(|(index, cwd)| json!({
                    "id": format!("s{index}"), "cwd": cwd, "agent": "omp", "startedAt": null, "endedAt": null,
                    "observations": 1, "consolidation": null,
                }))
                .collect::<Vec<_>>())),
            "retirePage" => {
                self.retired.push(json!({
                    "path": args[0]["path"], "reason": args[0]["reason"], "expectedPageId": args[0]["expectedPageId"],
                }));
                Said::Value(json!("retired"))
            }
            "feedback" => {
                if self.fail_feedback {
                    return Said::Error("server down");
                }
                self.flagged_paths.push(args[0]["path"].as_str().unwrap().to_owned());
                Said::Value(Value::Null)
            }
            other => panic!("{other}"),
        }
    }
}

struct Check {
    response: Value,
    logs: Vec<Value>,
}

impl Check {
    fn report(&self) -> &Value {
        assert_eq!(self.response["ok"], true, "{}", self.response);
        &self.response["result"]["report"]
    }

    fn flagged(&self) -> Map<String, Value> {
        map(self.response["result"]["flagged"].clone())
    }
}

async fn check(
    driver: &mut Driver,
    client: &mut Fake,
    flagged: &Map<String, Value>,
    extra: Value,
) -> Check {
    let mut said = |asked: &Value| {
        let (op, args) = client_op(asked).unwrap();
        client.answer(op, args)
    };
    let params = with(
        with(
            common(&["client"], Some(ms("2026-10-20T00:00:00Z"))),
            json!({ "project": { "workspace": "default", "project": "demo" }, "git": runner(), "flagged": flagged }),
        ),
        extra,
    );
    let before = driver.events.len();
    let response = driver.call("care.freshness", params, &mut said).await;
    let logs = driver.events[before..]
        .iter()
        .filter(|event| event["data"]["message"] == "care-fresh")
        .map(|event| event["data"]["details"].clone())
        .collect();
    Check { response, logs }
}

fn same_folder(left: &str, right: &Path) -> bool {
    Path::new(left)
        .canonicalize()
        .map(|left| left == right.canonicalize().unwrap())
        .unwrap_or(false)
}

#[tokio::test]
async fn retires_a_page_whose_names_are_all_deleted_with_the_reason_the_page_version_and_one_log_line()
 {
    let mut client = fake(vec![(
        "decisions/0001.md",
        page(
            "decision",
            "Build widgets in `src/main/old-feature.ts` through `legacyWidgetBuild()`.",
        ),
    )]);
    let mut driver = Driver::start().await;
    let run = check(&mut driver, &mut client, &Map::new(), json!({})).await;
    // git names the checkout with forward slashes on Windows.
    assert!(
        same_folder(run.report()["checkout"].as_str().unwrap(), &repo().main),
        "{}",
        run.report()
    );
    assert_eq!(run.report()["ref"], "main");
    assert_eq!(
        client.retired,
        [json!({
            "path": "decisions/0001.md",
            "reason": "names src/main/old-feature.ts, legacyWidgetBuild which no longer exist",
            "expectedPageId": "id-decisions/0001.md",
        })]
    );
    assert_eq!(run.report()["retired"][0]["path"], "decisions/0001.md");
    assert_eq!(run.logs.len(), 1);
    assert_eq!(run.logs[0]["action"], "retire");
    assert_eq!(run.logs[0]["path"], "decisions/0001.md");
    assert_eq!(
        run.logs[0],
        json!({
            "action": "retire", "kind": "decision", "workspace": "default", "project": "demo",
            "path": "decisions/0001.md", "names": "src/main/old-feature.ts, legacyWidgetBuild", "pinned": false,
        })
    );
    let _ = &repo().root;
}

#[tokio::test]
async fn flags_a_page_with_some_names_gone_once_per_page_version_and_retires_nothing() {
    let mut client = fake(vec![(
        "gotchas/a.md",
        page(
            "gotcha",
            "`src/main/keep.ts` and `src/main/old-twin.ts` too.",
        ),
    )]);
    let mut driver = Driver::start().await;
    let first = check(&mut driver, &mut client, &Map::new(), json!({})).await;
    let second = check(&mut driver, &mut client, &first.flagged(), json!({})).await;
    assert_eq!(client.flagged_paths, ["gotchas/a.md"]);
    assert_eq!(client.retired, Vec::<Value>::new());
    assert_eq!(first.report()["flagged"].as_array().unwrap().len(), 1);
    assert_eq!(second.report()["flagged"].as_array().unwrap().len(), 0);
    assert_eq!(
        first.flagged()["default/demo/gotchas/a.md"],
        "id-gotchas/a.md"
    );
    assert_eq!(first.logs.len() + second.logs.len(), 1);
}

#[tokio::test]
async fn leaves_pages_that_name_existing_files_nothing_or_only_traps() {
    let mut client = fake(vec![
        (
            "decisions/keep.md",
            page("decision", "See `src/main/keep.ts`, `keepAlive`."),
        ),
        ("decisions/none.md", page("decision", "Prefer small diffs.")),
        (
            "gotchas/trap.md",
            page(
                "gotcha",
                "Docs at https://example.com/blob/main/src/main/old-feature.ts and ~/x/src/main/old-twin.ts.\nWe removed `src/main/old-feature.ts` in favour of keep.ts.\n```sh\nrm src/main/old-twin.ts\n```",
            ),
        ),
        (
            "notes/other.md",
            page("note", "`src/main/old-feature.ts` gone"),
        ),
    ]);
    let mut driver = Driver::start().await;
    let run = check(&mut driver, &mut client, &Map::new(), json!({})).await;
    assert_eq!(client.retired, Vec::<Value>::new());
    assert_eq!(client.flagged_paths, Vec::<String>::new());
    assert_eq!(run.report()["checked"], 3);
    assert_eq!(run.report()["pages"], 3);
    assert_eq!(run.logs, Vec::<Value>::new());
}

#[tokio::test]
async fn flags_a_renamed_file_rather_than_retiring_the_page() {
    let mut client = fake(vec![(
        "gotchas/moved.md",
        page("gotcha", "The code lives in `src/main/moved-old.ts`."),
    )]);
    let mut driver = Driver::start().await;
    check(&mut driver, &mut client, &Map::new(), json!({})).await;
    assert_eq!(client.retired, Vec::<Value>::new());
    assert_eq!(client.flagged_paths, ["gotchas/moved.md"]);
}

#[tokio::test]
async fn does_not_retire_when_a_named_path_never_existed_nor_when_another_name_still_exists() {
    let mut client = fake(vec![
        (
            "decisions/unseen.md",
            page(
                "decision",
                "`src/main/old-feature.ts` and `src/main/never-was.ts`.",
            ),
        ),
        (
            "decisions/mixed.md",
            page("decision", "`src/main/old-twin.ts` and `keepAlive`."),
        ),
    ]);
    let mut driver = Driver::start().await;
    check(&mut driver, &mut client, &Map::new(), json!({})).await;
    assert_eq!(client.retired, Vec::<Value>::new());
    client.flagged_paths.sort();
    assert_eq!(
        client.flagged_paths,
        ["decisions/mixed.md", "decisions/unseen.md"]
    );
}

#[tokio::test]
async fn only_flags_a_pinned_page_that_would_be_retired() {
    let mut pinned = page("decision", "`src/main/old-feature.ts`");
    pinned.pinned = true;
    let mut client = fake(vec![("decisions/pinned.md", pinned)]);
    let mut driver = Driver::start().await;
    let run = check(&mut driver, &mut client, &Map::new(), json!({})).await;
    assert_eq!(client.retired, Vec::<Value>::new());
    assert_eq!(client.flagged_paths, ["decisions/pinned.md"]);
    assert_eq!(run.report()["flagged"][0]["pinned"], true);
    assert_eq!(run.report()["flagged"][0]["action"], "flag");
}

#[tokio::test]
async fn dry_run_reports_and_changes_nothing() {
    let mut client = fake(vec![
        (
            "decisions/a.md",
            page("decision", "`src/main/old-feature.ts`"),
        ),
        (
            "gotchas/b.md",
            page("gotcha", "`src/main/old-twin.ts` `src/main/keep.ts`"),
        ),
    ]);
    let mut driver = Driver::start().await;
    let run = check(
        &mut driver,
        &mut client,
        &Map::new(),
        json!({ "dryRun": true }),
    )
    .await;
    assert_eq!(run.report()["retired"].as_array().unwrap().len(), 1);
    assert_eq!(run.report()["flagged"].as_array().unwrap().len(), 1);
    assert_eq!(client.retired, Vec::<Value>::new());
    assert_eq!(client.flagged_paths, Vec::<String>::new());
    assert_eq!(run.flagged(), Map::new());
    assert_eq!(run.logs, Vec::<Value>::new());
}

#[tokio::test]
async fn stops_at_max_changes() {
    let mut client = fake(vec![
        (
            "decisions/a.md",
            page("decision", "`src/main/old-feature.ts`"),
        ),
        ("decisions/b.md", page("decision", "`src/main/old-twin.ts`")),
    ]);
    let mut driver = Driver::start().await;
    let run = check(
        &mut driver,
        &mut client,
        &Map::new(),
        json!({ "maxChanges": 1 }),
    )
    .await;
    assert_eq!(run.report()["retired"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn does_nothing_when_no_session_folder_is_a_live_checkout() {
    let mut client = fake(vec![(
        "decisions/a.md",
        page("decision", "`src/main/old-feature.ts`"),
    )]);
    client.cwds = vec![path_text(&repo().root.join("missing"))];
    let mut driver = Driver::start().await;
    let run = check(&mut driver, &mut client, &Map::new(), json!({})).await;
    assert_eq!(run.report()["checkout"], Value::Null);
    assert_eq!(run.report()["ref"], Value::Null);
    assert_eq!(run.report()["pages"], 0);
    assert_eq!(client.retired, Vec::<Value>::new());
}

#[tokio::test]
async fn checks_nothing_when_git_is_not_installed() {
    let mut client = fake(vec![(
        "decisions/a.md",
        page("decision", "`src/main/old-feature.ts`"),
    )]);
    let mut driver = Driver::start().await;
    let run = check(
        &mut driver,
        &mut client,
        &Map::new(),
        json!({ "git": null }),
    )
    .await;
    assert_eq!(run.report()["checkout"], Value::Null);
    assert_eq!(client.retired, Vec::<Value>::new());
}

#[tokio::test]
async fn counts_a_refused_flag_as_an_error_and_goes_on_without_remembering_it() {
    let mut client = fake(vec![
        (
            "gotchas/a.md",
            page(
                "gotcha",
                "`src/main/keep.ts` and `src/main/old-twin.ts` too.",
            ),
        ),
        (
            "decisions/b.md",
            page("decision", "`src/main/old-feature.ts`"),
        ),
    ]);
    client.fail_feedback = true;
    let mut driver = Driver::start().await;
    let run = check(&mut driver, &mut client, &Map::new(), json!({})).await;
    assert_eq!(run.report()["errors"], 1);
    // The refused flag was counted before the write; the next page was still checked and retired.
    assert_eq!(run.report()["flagged"].as_array().unwrap().len(), 1);
    assert_eq!(run.report()["retired"].as_array().unwrap().len(), 1);
    assert_eq!(run.flagged(), Map::new());
}
