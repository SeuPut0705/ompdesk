//! The local runner: `ompdesk check`'s run line, the answer of a journal, and the real runner over a real git remote
//! with a stand-in `ompdesk` that writes a journal as the real one does.

use super::*;

fn journal(state: &str, failed: Vec<String>, flaky: Vec<String>) -> LocalRun {
    LocalRun {
        id: "20261114-010203-ab12".into(),
        device: "local".into(),
        cwd: "/x".into(),
        argv: vec!["bun".into(), "run".into(), "check".into()],
        state: state.into(),
        started: 1,
        ended: Some(2),
        head: None,
        digest: "d".into(),
        failed,
        flaky,
        saved_ms: 0,
        session_tag: None,
    }
}

#[test]
fn the_run_is_the_one_ompdesk_check_starts_or_follows_never_one_it_passes_over() {
    assert_eq!(
        run_id_of("ompdesk check: run 20261114-010203-ab12 (vitest); it keeps running if …"),
        Some("20261114-010203-ab12")
    );
    assert_eq!(
        run_id_of(
            "ompdesk check: run 20261114-000000-0000 of this check is already under way on the same inputs (started x); following it instead of starting another."
        ),
        Some("20261114-000000-0000")
    );
    assert_eq!(
        run_id_of(
            "ompdesk check: run 20261114-000000-0000 of this check is under way, but on other inputs; starting another"
        ),
        None
    );
    assert_eq!(run_id_of("failed: src/a.test.ts › adds"), None);
}

#[test]
fn a_journal_answers_with_its_verdict_its_failed_tests_and_where_it_ran() {
    let argv = vec!["bun".to_owned(), "run".to_owned(), "check".to_owned()];
    let red = answer_of(
        "chk-1",
        &journal(
            "failed",
            vec!["src/a.test.ts › adds".into()],
            vec!["src/b.test.ts › x".into()],
        ),
        &"local".to_owned(),
        &argv,
        Os::Macos,
        9,
    );
    assert_eq!((red.verdict, red.next), (AnswerVerdict::Red, Next::Fix));
    assert_eq!(red.counts.failed, 1);
    assert_eq!(red.failed[0].test, "src/a.test.ts › adds");
    assert_eq!(red.failed[0].record.os, Os::Macos);
    assert_eq!(red.said[0].code, NoteCode::RanOn);
    assert_eq!(red.said[0].job.as_deref(), Some("bun run check"));
    assert_eq!(red.said[1].code, NoteCode::QuarantineEntered);
    assert_eq!(
        red.notes[0],
        "ran `bun run check` on local with ompdesk check"
    );

    let green = answer_of(
        "chk-1",
        &journal("passed", vec![], vec![]),
        &"local".into(),
        &argv,
        Os::Linux,
        9,
    );
    assert_eq!(
        (green.verdict, green.next),
        (AnswerVerdict::Green, Next::Land)
    );

    let killed = answer_of(
        "chk-1",
        &journal("killed", vec![], vec![]),
        &"local".into(),
        &argv,
        Os::Linux,
        9,
    );
    assert_eq!(killed.verdict, AnswerVerdict::Unknown);
    assert!(
        killed
            .notes
            .iter()
            .any(|note| note.contains("ended killed")),
        "{:?}",
        killed.notes
    );
}

/// A test folder that goes with the test.
#[cfg(unix)]
struct Gone(PathBuf);

#[cfg(unix)]
impl Gone {
    fn path(&self) -> &Path {
        &self.0
    }
}

#[cfg(unix)]
impl Drop for Gone {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
fn sh(dir: &Path, script: &str) {
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(script)
        .current_dir(dir)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .status()
        .unwrap();
    assert!(status.success(), "{script}");
}

/// A stand-in for `ompdesk check`: records its arguments and folder, writes a passed journal and names its run on
/// stderr as the real one does.
#[cfg(unix)]
const FAKE_OMPDESK: &str = r#"#!/bin/sh
store="$OMPDESK_CHECKS_DIR"
printf '%s\n' "$*" > "$store/args"
pwd > "$store/cwd"
id=20261114-010203-ab12
mkdir -p "$store/runs/$id"
cat > "$store/runs/$id/run.json" <<EOF
{"id":"$id","cwd":"$(pwd)","argv":["bun","run","check"],"state":"passed","started":1,"ended":2,"head":null,"inputs":"sha256:1","failed":0,"flaky":[],"saved_ms":0}
EOF
echo "ompdesk check: run $id (vitest); it keeps running if this terminal or OMPdesk goes away" >&2
"#;

#[cfg(unix)]
#[tokio::test]
async fn the_runner_checks_out_the_commit_runs_the_repos_setup_and_reads_the_journal_of_its_run() {
    use std::os::unix::fs::PermissionsExt;

    use crate::git::run::tests::{git, runner};

    let made = crate::fs::disk::make_temp_dir("ompdesk-local-run-").unwrap();
    let root = Gone(made);
    let work = root.path().join("work");
    let remote = root.path().join("remote.git");
    std::fs::create_dir_all(&work).unwrap();
    sh(
        root.path(),
        "git init -q --bare remote.git && cd work && git init -q && git config user.email t@t && git config user.name t \
         && mkdir .ompdesk && printf '#!/bin/sh\\ntouch set-up\\n' > .ompdesk/worktree-setup && echo a > a.txt \
         && git add -A && git commit -qm one && git push -q ../remote.git HEAD:refs/heads/main",
    );
    let sha = git()
        .text(work.to_str().unwrap(), &["rev-parse", "HEAD"])
        .await
        .unwrap()
        .trim()
        .to_owned();
    let store = root.path().join("store");
    std::fs::create_dir_all(&store).unwrap();
    let bin = root.path().join("ompdesk");
    std::fs::write(&bin, FAKE_OMPDESK).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut with_store = runner();
    with_store.env.insert(
        "OMPDESK_CHECKS_DIR".into(),
        store.to_string_lossy().into_owned(),
    );
    let hub_dir = root.path().join("hub");
    let remote_url = remote.to_string_lossy().into_owned();
    let check = CheckRunner {
        runner: Box::new(move || Some(with_store.clone())),
        dir: Box::new(move || hub_dir.clone()),
        url: Box::new(move |_| remote_url.clone()),
        bin,
        journals: Arc::new(Journals {
            root: store.clone(),
        }),
        busy: Mutex::default(),
    };
    let ask = LocalRunAsk {
        repo: "o/app".into(),
        sha: sha.clone(),
        argv: vec!["bun".into(), "run".into(), "check".into()],
        release: true,
    };
    let heard = Arc::new(Mutex::new(None));
    let to = Arc::clone(&heard);
    let run = check
        .run(
            &ask,
            Box::new(move |id| *to.lock().unwrap() = Some(id.to_owned())),
            Scope::detached(),
        )
        .await
        .unwrap();
    assert_eq!(run.id, "20261114-010203-ab12");
    assert_eq!(run.state, "passed");
    assert_eq!(
        heard.lock().unwrap().as_deref(),
        Some("20261114-010203-ab12")
    );
    let checkout = root.path().join("hub/checkouts/o_app");
    assert_eq!(
        std::fs::read_to_string(store.join("args")).unwrap().trim(),
        "check --release -- bun run check"
    );
    assert_eq!(
        std::fs::canonicalize(std::fs::read_to_string(store.join("cwd")).unwrap().trim()).unwrap(),
        std::fs::canonicalize(&checkout).unwrap()
    );
    assert!(checkout.join("set-up").is_file(), "the repo's setup ran");
    let head = git()
        .text(checkout.to_str().unwrap(), &["rev-parse", "HEAD"])
        .await
        .unwrap();
    assert_eq!(head.trim(), sha);

    // A commit the remote does not have never runs: the hub runs the check on GitHub instead.
    let missing = LocalRunAsk {
        sha: "0".repeat(40),
        ..ask
    };
    let error = check
        .run(&missing, Box::new(|_| {}), Scope::detached())
        .await
        .unwrap_err();
    assert!(error.contains("fetching"), "{error}");
}
