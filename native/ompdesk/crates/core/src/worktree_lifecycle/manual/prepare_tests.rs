use super::*;
use super::super::test_support::{repo, runner, sh};

#[tokio::test]
async fn seed_copies_ignored_files_and_keeps_existing_checkout_content() {
    let root = repo("manual-seed");
    std::fs::write(root.join(".gitignore"), "secret.env\n").unwrap();
    std::fs::write(root.join(".worktreeinclude"), "secret.env\n").unwrap();
    std::fs::write(root.join("secret.env"), "copied\n").unwrap();
    let target = root.join("worktree");
    sh(&root, &["worktree", "add", "-b", "seed-test", target.to_str().unwrap()]);
    let config = Config { env: std::env::vars().collect(), supervisor: "unused".into() };
    let report = prepare(&runner(), &config, Scope::detached(), root.to_str().unwrap(), target.to_str().unwrap()).await.unwrap();
    assert_eq!(std::fs::read_to_string(target.join("secret.env")).unwrap(), "copied\n");
    assert_eq!(serde_json::to_value(report).unwrap()["seed"]["copied"], 1);
    sh(&root, &["worktree", "remove", "--force", target.to_str().unwrap()]);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn setup_spawn_failure_is_reported_without_failing_preparation() {
    let root = repo("manual-setup-failure");
    std::fs::create_dir_all(root.join(".ompdesk")).unwrap();
    let hook = if cfg!(windows) { ".ompdesk/worktree-setup.cmd" } else { ".ompdesk/worktree-setup" };
    std::fs::write(root.join(hook), "echo hello\n").unwrap();
    let target = root.join("worktree");
    sh(&root, &["worktree", "add", "-b", "setup-test", target.to_str().unwrap()]);
    let config = Config { env: std::env::vars().collect(), supervisor: root.join("missing").to_string_lossy().into_owned() };
    let report = prepare(&runner(), &config, Scope::detached(), root.to_str().unwrap(), target.to_str().unwrap()).await.unwrap();
    let report = serde_json::to_value(report).unwrap();
    assert_eq!(report["setup"]["ok"], false);
    assert_eq!(report["setup"]["exitCode"], serde_json::Value::Null);
    assert!(std::path::Path::new(report["setup"]["logPath"].as_str().unwrap()).is_file());
    sh(&root, &["worktree", "remove", "--force", target.to_str().unwrap()]);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn setup_runs_real_supervisor_and_reports_script_output() {
    let root = repo("manual-setup-success");
    std::fs::create_dir_all(root.join(".ompdesk")).unwrap();
    std::fs::write(root.join(".ompdesk/worktree-setup"), "printf 'setup output\\n'\nexit 3\n").unwrap();
    let target = root.join("worktree");
    sh(&root, &["worktree", "add", "-b", "setup-run", target.to_str().unwrap()]);
    let exe = std::env::current_exe().unwrap();
    use std::os::unix::fs::PermissionsExt;
    let supervisor = root.join("supervisor");
    let script = format!("#!/bin/sh\nexport OMPDESK_MANUAL_SUPERVISOR_CHILD=1\nexec '{}' --exact worktree_lifecycle::manual::prepare::tests::supervisor_child --nocapture\n", exe.to_string_lossy().replace('\'', "'\\''"));
    std::fs::write(&supervisor, script).unwrap();
    std::fs::set_permissions(&supervisor, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = Config { env: std::env::vars().collect(), supervisor: supervisor.to_string_lossy().into_owned() };
    let report = prepare(&runner(), &config, Scope::detached(), root.to_str().unwrap(), target.to_str().unwrap()).await.unwrap();
    let report = serde_json::to_value(report).unwrap();
    assert_eq!(report["setup"]["exitCode"], 3);
    assert!(report["setup"]["outputTail"].as_str().unwrap().contains("setup output\n"));
    sh(&root, &["worktree", "remove", "--force", target.to_str().unwrap()]);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn supervisor_child() {
    if std::env::var_os("OMPDESK_MANUAL_SUPERVISOR_CHILD").is_some() {
        std::process::exit(crate::supervise::run());
    }
}
