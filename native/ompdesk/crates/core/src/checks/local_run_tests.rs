//! The local runner: `ompdesk check`'s run line, the answer of a journal, and the real runner over a real git remote
//! with a stand-in `ompdesk` that writes a journal as the real one does.

use super::*;

fn journal(state: &str, failed: Vec<String>, flaky: Vec<String>) -> LocalResult {
    let details = failed
        .iter()
        .map(|name| LocalFailure {
            name: name.clone(),
            first_error: None,
            known_flaky: false,
        })
        .collect();
    let run = LocalRun {
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
    };
    LocalResult {
        run,
        failed: Some(details),
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
    assert!(red.failed[0].record.is_none());
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

#[cfg(unix)]
#[test]
fn a_real_journal_preserves_first_error_and_existing_quarantine() {
    let root = Gone(crate::fs::disk::make_temp_dir("ompdesk-local-detail-").unwrap());
    let run_dir = root.path().join("runs/journal");
    std::fs::create_dir_all(&run_dir).unwrap();
    std::fs::write(run_dir.join("run.json"), r#"{"id":"journal","cwd":"/x","argv":["test"],"state":"failed","started":1,"ended":2,"head":null,"inputs":"d","failed":0,"flaky":[],"saved_ms":0}"#).unwrap();
    std::fs::write(run_dir.join("verdict.json"), r#"[{"key":"test","name":"known flaky","status":"failed","quarantined":true,"first_error":"\u001b[31massertion failed\u001b[0m\nstack","origin":null},{"key":"old","name":"old result","status":"failed","quarantined":false,"origin":null},{"key":"empty","name":"empty error","status":"failed","quarantined":false,"first_error":" \n ","origin":null}]"#).unwrap();
    let result = Journals {
        root: root.path().to_path_buf(),
    }
    .result_blocking("journal")
    .unwrap();
    let answer = answer_of(
        "chk-1",
        &result,
        &"local".into(),
        &["test".into()],
        Os::Linux,
        3,
    );
    assert_eq!(
        answer.failed[0].first_error.as_deref(),
        Some("assertion failed")
    );
    assert!(answer.failed[0].known_flaky);
    assert!(answer.failed[0].record.is_none());
    assert_eq!(answer.failed[1].first_error, None);
    assert_eq!(answer.failed[2].first_error, None);
    assert!(result.run.flaky.is_empty());
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
if [ "$2" = "--checkout-setup" ]; then shift 2; exec "$@"; fi
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
    assert_eq!(run.run.id, "20261114-010203-ab12");
    assert_eq!(run.run.state, "passed");
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

#[cfg(unix)]
#[tokio::test]
async fn a_reopened_runner_waits_for_the_old_checkout_and_its_live_journal() {
    use crate::git::run::tests::{git, runner};
    use std::os::unix::fs::PermissionsExt;

    let root = Gone(crate::fs::disk::make_temp_dir("ompdesk-local-reopen-").unwrap());
    let work = root.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    sh(
        root.path(),
        "git init -q --bare remote.git && cd work && git init -q && git config user.email t@t && git config user.name t && echo a > a.txt && git add -A && git commit -qm one && git push -q ../remote.git HEAD:refs/heads/main",
    );
    let sha = git()
        .text(work.to_str().unwrap(), &["rev-parse", "HEAD"])
        .await
        .unwrap()
        .trim()
        .to_owned();
    let store = root.path().join("store");
    let checkout = root.path().join("hub/checkouts/o_app");
    std::fs::create_dir_all(&checkout).unwrap();
    let journal = store.join("runs/old");
    std::fs::create_dir_all(&journal).unwrap();
    std::fs::write(
        journal.join("run.json"),
        serde_json::json!({
            "id": "old", "cwd": checkout, "argv": ["check"], "state": "running",
            "started": 1, "ended": null, "head": null, "inputs": null,
            "failed": 0, "flaky": [], "saved_ms": 0
        })
        .to_string(),
    )
    .unwrap();
    let alive = std::fs::File::create(journal.join("alive")).unwrap();
    alive.lock().unwrap();
    let bin = root.path().join("ompdesk");
    std::fs::write(&bin, FAKE_OMPDESK).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut environment = runner();
    environment.env.insert(
        "OMPDESK_CHECKS_DIR".into(),
        store.to_string_lossy().into_owned(),
    );
    let hub_dir = root.path().join("hub");
    let remote = root
        .path()
        .join("remote.git")
        .to_string_lossy()
        .into_owned();
    let make_runner = || CheckRunner {
        runner: Box::new({
            let environment = environment.clone();
            move || Some(environment.clone())
        }),
        dir: Box::new({
            let hub_dir = hub_dir.clone();
            move || hub_dir.clone()
        }),
        url: Box::new({
            let remote = remote.clone();
            move |_| remote.clone()
        }),
        bin: bin.clone(),
        journals: Arc::new(Journals {
            root: store.clone(),
        }),
        busy: Mutex::default(),
    };
    let old = make_runner();
    let old_lock = old
        .checkout_lock(&checkout, &Scope::detached())
        .await
        .unwrap();
    let reopened = make_runner();
    let ask = LocalRunAsk {
        repo: "o/app".into(),
        sha,
        argv: vec!["bun".into(), "run".into(), "check".into()],
        release: false,
    };
    let task = tokio::spawn(async move {
        reopened
            .run(&ask, Box::new(|_| {}), Scope::detached())
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(!checkout.join(".git").exists());
    drop(old_lock);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(
        !checkout.join(".git").exists(),
        "the old detached runner still owns the checkout"
    );
    drop(alive);
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result.run.state, "passed");
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_before_the_run_id_waits_for_the_id_and_cancels_the_runner() {
    use crate::git::run::tests::{git, runner};
    use std::os::unix::fs::PermissionsExt;

    let root = Gone(crate::fs::disk::make_temp_dir("ompdesk-local-cancel-").unwrap());
    let work = root.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    sh(
        root.path(),
        "git init -q --bare remote.git && cd work && git init -q && git config user.email t@t && git config user.name t && echo a > a.txt && git add -A && git commit -qm one && git push -q ../remote.git HEAD:refs/heads/main",
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
    std::fs::write(&bin, r#"#!/bin/sh
if [ "$2" = "--checkout-setup" ]; then shift 2; exec "$@"; fi
store="$OMPDESK_CHECKS_DIR"
if [ "$2" = cancel ]; then touch "$store/cancelled"; exit 0; fi
touch "$store/started"
while [ ! -f "$store/name" ]; do sleep 0.02; done
id=20261114-010203-ab12
mkdir -p "$store/runs/$id"
printf '{"id":"%s","cwd":"%s","argv":["test"],"state":"cancelled","started":1,"ended":2,"head":null,"inputs":null,"failed":0,"saved_ms":0}' "$id" "$(pwd)" > "$store/runs/$id/run.json"
echo "ompdesk check: run $id (test); it keeps running" >&2
while [ ! -f "$store/cancelled" ]; do sleep 0.02; done
"#).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut environment = runner();
    environment.env.insert(
        "OMPDESK_CHECKS_DIR".into(),
        store.to_string_lossy().into_owned(),
    );
    let hub = root.path().join("hub");
    let remote = root
        .path()
        .join("remote.git")
        .to_string_lossy()
        .into_owned();
    let check = CheckRunner {
        runner: Box::new(move || Some(environment.clone())),
        dir: Box::new(move || hub.clone()),
        url: Box::new(move |_| remote.clone()),
        bin,
        journals: Arc::new(Journals {
            root: store.clone(),
        }),
        busy: Mutex::default(),
    };
    let scope = Scope::detached();
    let cancel = scope.clone();
    let task = tokio::spawn(async move {
        let ask = LocalRunAsk {
            repo: "o/app".into(),
            sha,
            argv: vec!["test".into()],
            release: false,
        };
        check.run(&ask, Box::new(|_| {}), scope).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !store.join("started").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    std::fs::write(store.join("name"), "").unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(store.join("cancelled").exists());
}

#[cfg(unix)]
#[test]
fn an_abandoned_starting_journal_does_not_claim_a_live_runner() {
    let root = Gone(crate::fs::disk::make_temp_dir("ompdesk-local-stale-").unwrap());
    let checkout = root.path().join("checkout");
    let journal = root.path().join("runs/old");
    std::fs::create_dir_all(&checkout).unwrap();
    std::fs::create_dir_all(&journal).unwrap();
    std::fs::write(
        journal.join("run.json"),
        serde_json::json!({
            "id": "old", "cwd": checkout, "argv": ["test"], "state": "starting",
            "started": 1, "ended": null, "head": null, "inputs": null,
            "failed": 0, "saved_ms": 0
        })
        .to_string(),
    )
    .unwrap();
    let journals = Journals {
        root: root.path().to_path_buf(),
    };
    assert!(journals.active_in_checkout(&checkout).unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn setup_crash_process() {
    let Ok(mode) = std::env::var("CHECKS_CRASH_MODE") else {
        return;
    };
    if mode == "supervisor" {
        // A dead core also closes stderr's reader; keep the cleanup barrier independent of SIGPIPE.
        let script = "exec 2>/dev/null; echo $$ > child; trap 'touch cleanup; while [ ! -f release ]; do sleep .02; done; exit 0' TERM; touch started; while :; do sleep .02; done";
        assert_eq!(
            ompdesk_checks::check::guarded_setup(&["sh".into(), "-c".into(), script.into()]),
            130
        );
        return;
    }
    let dir = std::env::current_dir().unwrap();
    let check = CheckRunner {
        runner: Box::new(|| None),
        dir: Box::new(PathBuf::new),
        url: Box::new(str::to_owned),
        bin: dir.join("supervisor"),
        journals: Arc::new(Journals { root: dir.clone() }),
        busy: Mutex::default(),
    };
    let mut runner = crate::git::run::tests::runner();
    runner
        .env
        .insert("CHECKS_CRASH_MODE".into(), "supervisor".into());
    check
        .guarded_command(
            &dir,
            &runner,
            &Scope::detached(),
            &CheckoutGuard {
                lock: dir.join("checkout.lock"),
                generation: "1".into(),
            },
            None,
            &[],
            30_000,
        )
        .await
        .unwrap();
}

#[cfg(unix)]
#[test]
fn core_group_death_keeps_checkout_reserved_until_setup_cleanup() {
    use std::os::unix::{fs::PermissionsExt, process::CommandExt};
    use std::time::{Duration, Instant};
    let root = Gone(crate::fs::disk::make_temp_dir("ompdesk-setup-crash-").unwrap());
    let exe = std::env::current_exe().unwrap();
    let helper = "checks::local_run::tests::setup_crash_process";
    let wrapper = root.path().join("supervisor");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec '{}' --exact {helper} --nocapture\n",
            exe.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(root.path().join("checkout.lock.generation"), "1").unwrap();
    let mut core = std::process::Command::new(exe)
        .args(["--exact", helper, "--nocapture"])
        .env("CHECKS_CRASH_MODE", "core")
        .current_dir(root.path())
        .process_group(0)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    struct Cleanup<'a>(&'a Path, u32);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _ = std::fs::write(self.0.join("release"), "");
            crate::sys::signal_group(self.1, true);
            if let Ok(pid) = std::fs::read_to_string(self.0.join("child")) {
                if let Ok(pid) = pid.trim().parse::<u32>() {
                    crate::sys::signal_group(pid, true);
                }
            }
        }
    }
    let _cleanup = Cleanup(root.path(), core.id());
    let wait = |name: &str| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.path().join(name).exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(root.path().join(name).exists(), "missing event {name}");
    };
    wait("started");
    crate::sys::signal_group(core.id(), true);
    core.wait().unwrap();
    wait("cleanup");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join("checkout.lock"))
        .unwrap();
    assert!(
        matches!(lock.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
        "a reopened core must not change the checkout during old setup cleanup"
    );
    std::fs::write(root.path().join("release"), "").unwrap();
    lock.lock().unwrap();
}
