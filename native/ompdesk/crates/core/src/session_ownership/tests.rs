use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ompdesk_app_contract::OwnerIssuer;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::*;

#[derive(Default)]
struct NativeFacts {
    hosted: Mutex<BTreeSet<String>>,
    logs: Mutex<Vec<String>>,
}

impl Host for NativeFacts {
    fn hosted_held(&self, path: &str) -> bool {
        self.hosted.lock().unwrap().contains(path)
    }
    fn log(&self, message: &str, _: Value) {
        self.logs.lock().unwrap().push(message.to_owned());
    }
}

struct World {
    root: PathBuf,
    config: Config,
    host: Arc<NativeFacts>,
    issuer: OwnerIssuer,
}

impl World {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ownership-{}", fresh_tag().unwrap()));
        fs::create_dir_all(&root).unwrap();
        let config = Config::new(&root, root.join("scratch"));
        Self {
            root,
            config,
            host: Arc::new(NativeFacts::default()),
            issuer: OwnerIssuer::new(1),
        }
    }
    fn service(&self) -> Arc<SessionOwnership> {
        SessionOwnership::new(self.config.clone(), self.host.clone())
    }
    fn owner(&self) -> Owner {
        self.issuer.admit_authenticated().unwrap()
    }
    fn facts(&self, name: &str) -> Facts {
        Facts {
            cwd: self.root.to_string_lossy().into_owned(),
            session_path: Some(self.root.join(name).to_string_lossy().into_owned()),
            device: None,
        }
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn quota_recovery_restores_tags_and_scratch_sessions_without_another_save() {
    let world = World::new();
    let service = world.service();
    let existing = service
        .acquire(&world.owner(), world.facts("existing.jsonl"))
        .unwrap();
    let previous_tags = fs::read(&world.config.process_file).unwrap();
    let previous_scratch = fs::read(&world.config.scratch_file).unwrap();
    let tag_quota = crate::disk::saves::test_support::Quota::new(&world.config.process_file);
    let scratch_quota = crate::disk::saves::test_support::Quota::new(&world.config.scratch_file);
    let owner = world.owner();
    let first = world.facts("first.jsonl");
    let latest = world.facts("latest.jsonl");
    let lease = service.acquire(&owner, first.clone()).unwrap();
    let artifact = lease.scratch.as_ref().unwrap().join("picture.png");
    fs::write(&artifact, b"retained picture").unwrap();
    service.update(&owner, latest.clone()).unwrap();
    assert_eq!(
        service
            .owners()
            .iter()
            .find(|record| record.tag == lease.tag)
            .unwrap()
            .facts,
        latest
    );
    assert_eq!(fs::read(&world.config.process_file).unwrap(), previous_tags);
    assert_eq!(
        fs::read(&world.config.scratch_file).unwrap(),
        previous_scratch
    );
    service.freeze();
    drop(service);
    let before_recovery = world.service();
    assert_eq!(before_recovery.owners().len(), 1);
    assert_eq!(before_recovery.owners()[0].tag, existing.tag);
    drop(before_recovery);

    tag_quota.recover();
    scratch_quota.recover();

    let reopened = world.service();
    let owners = reopened.owners();
    assert_eq!(owners.len(), 2);
    assert_eq!(
        owners
            .iter()
            .find(|record| record.tag == lease.tag)
            .unwrap()
            .facts,
        latest
    );
    let records = reopened.scratch_records();
    let restored = records
        .iter()
        .find(|record| record.tag == lease.tag)
        .unwrap();
    assert_eq!(
        restored.sessions,
        vec![first.session_path.unwrap(), latest.session_path.unwrap()]
    );
    assert_eq!(fs::read(artifact).unwrap(), b"retained picture");
}

#[test]
fn owns_one_random_16_byte_tag_across_restart_and_session_changes() {
    let world = World::new();
    let service = world.service();
    let owner = world.owner();
    let first = service.acquire(&owner, world.facts("a.jsonl")).unwrap();
    assert!(model::valid_tag(&first.tag));
    assert!(first.scratch.as_ref().unwrap().is_dir());
    assert_eq!(
        service.acquire(&owner, world.facts("a.jsonl")).unwrap(),
        first
    );
    service.pid(&owner, Some(17));
    service.update(&owner, world.facts("b.jsonl")).unwrap();
    service.pid(&owner, None);
    assert_eq!(service.owners()[0].pid, None);
    let records = service.scratch_records();
    assert_eq!(
        records[0].sessions,
        vec![
            world.facts("a.jsonl").session_path.unwrap(),
            world.facts("b.jsonl").session_path.unwrap()
        ]
    );
    service.freeze();
    service.closing(&owner);
    let next = world.service();
    let inherited = next
        .acquire(&world.owner(), world.facts("b.jsonl"))
        .unwrap();
    assert_eq!(inherited, first);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&world.config.process_file)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(first.scratch.unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[tokio::test]
async fn closing_fences_late_acquisition_and_keeps_scratch_until_exact_exit_receipt() {
    let world = World::new();
    let service = world.service();
    let never_started = world.owner();
    service.closing(&never_started);
    assert_eq!(
        service
            .acquire(&never_started, world.facts("a.jsonl"))
            .unwrap_err()
            .code,
        "owner_closed"
    );
    let owner = world.owner();
    let lease = service.acquire(&owner, world.facts("a.jsonl")).unwrap();
    let file = lease.scratch.as_ref().unwrap().join("output");
    fs::write(&file, "held").unwrap();
    service.closing(&owner);
    service.pid(&owner, Some(98));
    assert!(service.update(&owner, world.facts("b.jsonl")).is_err());
    assert!(service.acquire(&owner, world.facts("a.jsonl")).is_err());
    service.sweep(&BTreeSet::new(), 0);
    service
        .session_deleted(&world.facts("a.jsonl").session_path.unwrap())
        .await;
    service.sweep_scratch(&[]).await.unwrap();
    assert!(file.exists());
    assert!(service.held().contains(&lease.tag));
    let replacement = service
        .acquire(&world.owner(), world.facts("a.jsonl"))
        .unwrap();
    assert_ne!(replacement.tag, lease.tag);
    service.released(&owner);
    service.released(&owner);
    service.settled().await;
    assert_eq!(service.owners().len(), 1);
    assert_eq!(service.owners()[0].tag, replacement.tag);
}

#[tokio::test]
async fn in_flight_end_cannot_supply_a_reopened_session_tag() {
    let world = World::new();
    let service = world.service();
    let owner = world.owner();
    let old = service.acquire(&owner, world.facts("a.jsonl")).unwrap();
    service.closing(&owner);
    service.released(&owner);
    let new = service
        .acquire(&world.owner(), world.facts("a.jsonl"))
        .unwrap();
    assert_ne!(old.tag, new.tag);
    service.settled().await;
    assert_eq!(service.held(), BTreeSet::from([new.tag]));
}

#[tokio::test]
async fn quit_keeps_tags_and_restored_unstarted_release_cleans_every_matching_left_tag() {
    let world = World::new();
    let before = world.service();
    let facts = world.facts("a.jsonl");
    let one = world.owner();
    let two = world.owner();
    let first = before.acquire(&one, facts.clone()).unwrap();
    let second = before.acquire(&two, facts.clone()).unwrap();
    before.freeze();
    before.released(&one);
    before.released(&two);
    before.sweep(&BTreeSet::new(), 0);
    before.settled().await;
    assert_eq!(
        before.held(),
        BTreeSet::from([first.tag.clone(), second.tag.clone()])
    );
    let next = world.service();
    next.sweep(&BTreeSet::from([facts.session_path.clone().unwrap()]), 0);
    next.settled().await;
    assert_eq!(next.held().len(), 2);
    next.session_released(facts.session_path.as_deref().unwrap(), None);
    next.settled().await;
    assert!(next.owners().is_empty());
    assert!(journal::tags(&world.config.process_file).is_empty());
}

#[tokio::test]
async fn deferred_hosted_tab_closed_after_grace_releases_only_its_hosted_leftovers() {
    let world = World::new();
    let before = world.service();
    let local_facts = world.facts("a.jsonl");
    let mut hosted_facts = local_facts.clone();
    hosted_facts.device = Some("fixture-device".to_owned());
    let local = before.acquire(&world.owner(), local_facts.clone()).unwrap();
    let hosted = before
        .acquire(&world.owner(), hosted_facts.clone())
        .unwrap();
    let path = hosted_facts.session_path.as_deref().unwrap();
    world.host.hosted.lock().unwrap().insert(path.to_owned());
    let next = world.service();
    next.sweep_hosted();
    next.settled().await;
    assert!(next.held().contains(&hosted.tag));
    world.host.hosted.lock().unwrap().clear();
    next.session_released(path, hosted_facts.device.as_deref());
    next.settled().await;
    assert_eq!(next.held(), BTreeSet::from([local.tag]));
    assert!(!next.owners().iter().any(|owner| owner.tag == hosted.tag));
}

#[tokio::test(start_paused = true)]
async fn hosted_grace_rechecks_deferred_native_tabs_and_frozen_quit() {
    let world = World::new();
    let before = world.service();
    let mut back = world.facts("back.jsonl");
    back.device = Some("fixture-device".to_owned());
    let mut away = world.facts("away.jsonl");
    away.device = back.device.clone();
    let kept = before.acquire(&world.owner(), back.clone()).unwrap();
    let removed = before.acquire(&world.owner(), away).unwrap();
    let next = world.service();
    next.sweep(&BTreeSet::new(), 600_000);
    assert!(next.held().contains(&removed.tag));
    world
        .host
        .hosted
        .lock()
        .unwrap()
        .insert(back.session_path.unwrap());
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(600_000)).await;
    tokio::task::yield_now().await;
    tokio::time::resume();
    next.settled().await;
    assert_eq!(next.held(), BTreeSet::from([kept.tag]));
    let frozen = world.service();
    frozen.sweep(&BTreeSet::new(), 600_000);
    tokio::time::pause();
    frozen.freeze();
    world.host.hosted.lock().unwrap().clear();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(600_000)).await;
    tokio::task::yield_now().await;
    assert_eq!(frozen.owners().len(), 1);
}

#[test]
fn inherits_local_and_hosted_tags_separately_and_drops_damaged_journal_records() {
    let world = World::new();
    let facts = world.facts("a.jsonl");
    let before = world.service();
    let local = before.acquire(&world.owner(), facts.clone()).unwrap();
    let mut hosted = facts.clone();
    hosted.device = Some("one".to_owned());
    let remote = before.acquire(&world.owner(), hosted.clone()).unwrap();
    let next = world.service();
    hosted.device = Some("two".to_owned());
    assert_eq!(
        next.acquire(&world.owner(), hosted).unwrap().tag,
        remote.tag
    );
    assert_eq!(next.acquire(&world.owner(), facts).unwrap().tag, local.tag);
    fs::write(
        &world.config.process_file,
        serde_json::to_vec(
            &json!({"tags":[{"tag":"not-a-tag","cwd":"/w","since":1},7,{"cwd":"/w"}]}),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(world.service().owners().is_empty());
}

#[tokio::test]
async fn scratch_files_survive_tab_close_until_the_last_referring_session_is_deleted() {
    let world = World::new();
    let service = world.service();
    let owner = world.owner();
    let a = world.facts("a.jsonl");
    let b = world.facts("b.jsonl");
    let lease = service.acquire(&owner, a.clone()).unwrap();
    service.update(&owner, b.clone()).unwrap();
    let dir = lease.scratch.unwrap();
    fs::write(dir.join("picture.png"), "picture bytes").unwrap();
    service.released(&owner);
    service.settled().await;
    assert!(dir.join("picture.png").exists());
    service
        .session_deleted(a.session_path.as_deref().unwrap())
        .await;
    assert!(dir.exists());
    service
        .session_deleted(b.session_path.as_deref().unwrap())
        .await;
    assert!(!dir.exists());
    assert!(service.scratch_records().is_empty());
}

#[tokio::test]
async fn shutdown_joins_actual_scratch_deletion_after_its_caller_is_cancelled() {
    let world = World::new();
    let service = world.service();
    let owner = world.owner();
    let facts = world.facts("a.jsonl");
    let lease = service.acquire(&owner, facts.clone()).unwrap();
    let dir = lease.scratch.unwrap();
    fs::write(dir.join("output"), "remove").unwrap();
    service.released(&owner);
    service.settled().await;
    let (reserved, reached) = tokio::sync::oneshot::channel();
    let (proceed, blocked) = tokio::sync::oneshot::channel();
    *service.scratch_gate.lock().unwrap() = Some(scratch::Gate {
        reserved,
        proceed: blocked,
    });
    let caller = {
        let service = Arc::clone(&service);
        tokio::spawn(async move {
            service
                .session_deleted(facts.session_path.as_deref().unwrap())
                .await
        })
    };
    reached.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    service.freeze();
    let mut settled = std::pin::pin!(service.settled());
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(settled.as_mut().poll(&mut context).is_pending());
    assert!(dir.exists());
    proceed.send(()).unwrap();
    settled.await;
    assert!(!dir.exists());
    assert!(service.scratch_records().is_empty());
    assert!(journal::scratch(&world.config.scratch_file).is_empty());
}

fn make_idle(path: &std::path::Path) {
    if path.is_dir() {
        for entry in fs::read_dir(path).unwrap() {
            make_idle(&entry.unwrap().path());
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.access_mode(0x0180).custom_flags(0x0200_0000);
    }
    options
        .open(path)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(86_400))
        .unwrap();
}

#[tokio::test]
async fn idle_scratch_preserves_named_files_in_a_moved_session_and_unreadable_sessions() {
    let world = World::new();
    let service = world.service();
    let owner = world.owner();
    let facts = world.facts("a.jsonl");
    let lease = service.acquire(&owner, facts.clone()).unwrap();
    let dir = lease.scratch.unwrap();
    let picture = dir.join("picture.png");
    fs::write(&picture, "shown").unwrap();
    fs::write(dir.join("throwaway.log"), "remove").unwrap();
    let moved = world.root.join("moved");
    fs::create_dir_all(&moved).unwrap();
    let session = moved.join("a.jsonl");
    fs::write(&session, format!("{{\"type\":\"session\"}}\n{}\n", json!({
        "type":"message", "message":{"role":"assistant","content":[{"type":"text","text":format!("![picture]({})",picture.display())}]}
    }))).unwrap();
    service.released(&owner);
    service.settled().await;
    make_idle(&dir);
    let sweep = service
        .sweep_scratch(&[session.to_string_lossy().into_owned()])
        .await
        .unwrap();
    assert_eq!(sweep.failed, 0);
    assert!(picture.exists());
    assert!(!dir.join("throwaway.log").exists());
    assert_eq!(service.scratch_records().len(), 1);
    fs::write(&session, b"not stock JSON\n").unwrap();
    fs::write(dir.join("must-stay"), "keep").unwrap();
    make_idle(&dir);
    let sweep = service
        .sweep_scratch(&[session.to_string_lossy().into_owned()])
        .await
        .unwrap();
    assert_eq!(sweep.kept, 1);
    assert!(dir.join("must-stay").exists() && picture.exists());
}

#[tokio::test]
async fn recent_referenced_scratch_is_kept_but_gone_sessions_need_no_idle_days() {
    let world = World::new();
    let service = world.service();
    let owner = world.owner();
    let facts = world.facts("recent.jsonl");
    let session = PathBuf::from(facts.session_path.as_ref().unwrap());
    fs::write(&session, b"{\"type\":\"session\"}\n").unwrap();
    let lease = service.acquire(&owner, facts).unwrap();
    let dir = lease.scratch.unwrap();
    fs::write(dir.join("output"), "keep for three days").unwrap();
    service.released(&owner);
    service.settled().await;
    service.sweep_scratch(&[]).await.unwrap();
    assert!(dir.join("output").exists());
    fs::remove_file(session).unwrap();
    service.sweep_scratch(&[]).await.unwrap();
    assert!(!dir.exists());
    assert!(service.scratch_records().is_empty());
}

#[tokio::test]
async fn unknown_nonempty_scratch_and_live_processes_are_kept() {
    let world = World::new();
    let service = world.service();
    let unknown = world.config.scratch_root.join(fresh_tag().unwrap());
    fs::create_dir_all(&unknown).unwrap();
    fs::write(unknown.join("not-ours"), "keep").unwrap();
    let owner = world.owner();
    let lease = service.acquire(&owner, world.facts("gone.jsonl")).unwrap();
    let dir = lease.scratch.as_ref().unwrap();
    fs::write(dir.join("busy"), "keep").unwrap();
    let mut child = running(Some(&lease.tag)).await;
    fs::write(&world.config.process_file, b"{\"tags\":[]}\n").unwrap();
    let candidate = SessionOwnership::new(world.config.clone(), world.host.clone());
    let sweep = candidate.sweep_scratch(&[]).await.unwrap();
    assert_eq!(sweep.kept, 2);
    assert!(unknown.join("not-ours").exists() && dir.join("busy").exists());
    child.kill().await.unwrap();
}

#[test]
fn owned_child() {
    if std::env::var_os("OMPDESK_OWNERSHIP_CHILD").is_some() {
        println!("ownership-child-ready");
        std::io::stdout().flush().unwrap();
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
    }
}

async fn running(tag: Option<&str>) -> Child {
    running_with_worker(tag, false).await
}

async fn running_with_worker(tag: Option<&str>, worker: bool) -> Child {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "session_ownership::tests::owned_child",
            "--nocapture",
        ])
        .env("OMPDESK_OWNERSHIP_CHILD", "1")
        .env_remove(SESSION_TAG_ENV)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if worker {
        command.args(["--skip", "__omp_worker_ownership_fixture"]);
    }
    if let Some(tag) = tag {
        command.env(SESSION_TAG_ENV, tag);
    }
    let mut child = command.spawn().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    loop {
        if lines
            .next_line()
            .await
            .unwrap()
            .expect("owned child exited before readiness")
            .contains("ownership-child-ready")
        {
            break;
        }
    }
    child
}

#[tokio::test]
async fn real_stock_worker_survives_close_and_old_retry_cannot_end_its_new_owner() {
    let world = World::new();
    let service = world.service();
    let owner = world.owner();
    let facts = world.facts("a.jsonl");
    let lease = service.acquire(&owner, facts.clone()).unwrap();
    let mut worker = running_with_worker(Some(&lease.tag), true).await;
    service.released(&owner);
    service.settled().await;
    assert!(worker.try_wait().unwrap().is_none());
    assert_eq!(journal::tags(&world.config.process_file)[0].tag, lease.tag);
    let next = service.acquire(&world.owner(), facts).unwrap();
    assert_eq!(next.tag, lease.tag);
    tokio::time::pause();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(RETRY_REMAINING_MS)).await;
    tokio::task::yield_now().await;
    tokio::time::resume();
    service.settled().await;
    assert!(worker.try_wait().unwrap().is_none());
    assert_eq!(service.held(), BTreeSet::from([next.tag]));
    worker.kill().await.unwrap();
}

#[tokio::test]
async fn actual_native_end_joins_only_its_tagged_child_and_preserves_other_tabs_and_untagged_children()
 {
    let world = World::new();
    let service = world.service();
    let owner = world.owner();
    let mine = service.acquire(&owner, world.facts("mine.jsonl")).unwrap();
    let other = service
        .acquire(&world.owner(), world.facts("other.jsonl"))
        .unwrap();
    let mut mine_child = running(Some(&mine.tag)).await;
    let mut other_child = running(Some(&other.tag)).await;
    let mut untagged = running(None).await;
    service.pid(&owner, mine_child.id());
    service.closing(&owner);
    assert!(mine_child.try_wait().unwrap().is_none());
    service.released(&owner);
    service.settled().await;
    // wait reaps the exact owned child, never a potentially reused PID.
    let exit = mine_child.wait().await.unwrap();
    assert!(!exit.success());
    assert!(other_child.try_wait().unwrap().is_none());
    assert!(untagged.try_wait().unwrap().is_none());
    assert_eq!(service.held(), BTreeSet::from([other.tag]));
    other_child.kill().await.unwrap();
    untagged.kill().await.unwrap();
}
