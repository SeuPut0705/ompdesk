use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::{Semaphore, mpsc};

struct Rig {
    source: Arc<()>,
    settings: Mutex<Value>,
    prefix: Mutex<Option<String>>,
    live: AtomicBool,
    windows: Mutex<Vec<u64>>,
    calls: Mutex<Vec<(String, Option<Value>)>>,
    binding: Mutex<Option<Value>>,
    snapshot: Mutex<Snapshot>,
    removed: AtomicUsize,
    moved: AtomicBool,
    released: AtomicUsize,
    create_gate: Arc<Semaphore>,
    settings_gate: Arc<Semaphore>,
    stop_gate: Arc<Semaphore>,
    bind_gate: Arc<Semaphore>,
    events: mpsc::UnboundedSender<(u64, UiEvent)>,
    entered: mpsc::UnboundedSender<String>,
}

impl Host for Rig {
    type Source = ();
    fn windows(&self) -> Vec<u64> { lock(&self.windows).clone() }
    fn send(&self, window: u64, event: UiEvent) { let _ = self.events.send((window, event)); }
    fn connected(&self, _: &Arc<()>) -> bool { self.live.load(Ordering::SeqCst) }
    fn bridge(&self, _: &Arc<()>, method: &str, params: Option<Value>) -> Work<Value> {
        lock(&self.calls).push((method.into(), params));
        let gate = if method == "worktree_lifecycle_settings" { self.settings_gate.clone() } else { self.create_gate.clone() };
        let value = if method == "worktree_lifecycle_settings" { lock(&self.settings).clone() } else {
            json!({"path":"/wt/new", "branch":"wt/new", "sourceCwd":"/repo", "baseCommit":"base", "root":"/wt"})
        };
        let _ = self.entered.send(method.into());
        Box::pin(async move { let _permit = gate.acquire().await.unwrap(); Ok(value) })
    }
    fn branch_prefix(&self) -> Option<String> { lock(&self.prefix).clone() }
    fn bind(&self, _: &Spawn, _: &Arc<()>, binding: Value) -> Work<bool> {
        let live = self.live.load(Ordering::SeqCst);
        if live { *lock(&self.binding) = Some(binding); }
        let gate = self.bind_gate.clone();
        let _ = self.entered.send("bind".into());
        Box::pin(async move { let _permit = gate.acquire().await.unwrap(); Ok(live) })
    }
    fn inspect(&self, _: &Worktree) -> Work<Snapshot> {
        let snapshot = lock(&self.snapshot).clone();
        Box::pin(async move { Ok(snapshot) })
    }
    fn remove(&self, _: &Worktree, moved: bool) -> Work<()> {
        self.removed.fetch_add(1, Ordering::SeqCst); self.moved.store(moved, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
    fn stop_turn(&self, _: &Arc<()>) -> Work<()> {
        let _ = self.entered.send("stop".into());
        let gate = self.stop_gate.clone();
        Box::pin(async move { let _permit = gate.acquire().await.unwrap(); Ok(()) })
    }
    fn release(&self, _: &Spawn, _: &Arc<()>) -> Work<()> {
        self.released.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

fn spawn() -> Spawn {
    // A test's issuer models Base admission; production lifecycle code never creates authority.
    let issuer = ompdesk_app_contract::OwnerIssuer::new(41);
    Spawn { owner: issuer.admit_authenticated().unwrap(), tab: "tab".into(), window: 1, cwd: "/repo".into(), agent: true,
        fresh: true, session_path: None, device: None, explicit_worktree: false, placeholder: false, defer_start: false }
}

fn rig(start: &str, exit: &str) -> (Arc<Rig>, Arc<Lifecycle<Rig>>, mpsc::UnboundedReceiver<(u64, UiEvent)>, mpsc::UnboundedReceiver<String>) {
    let (events, ui) = mpsc::unbounded_channel();
    let (entered, steps) = mpsc::unbounded_channel();
    let host = Arc::new(Rig {
        source: Arc::new(()),
        bind_gate: Arc::new(Semaphore::new(1)),
        settings: Mutex::new(json!({"onStart": start, "onExit": exit, "eligible": true})),
        prefix: Mutex::new(None), live: AtomicBool::new(true), windows: Mutex::new(vec![1]),
        calls: Mutex::default(), binding: Mutex::default(),
        snapshot: Mutex::new(Snapshot { state: Risk { dirty: false, moved: false, off_branch: false }, fingerprint: "a".into(), present: true }),
        removed: AtomicUsize::new(0), moved: AtomicBool::new(false), released: AtomicUsize::new(0),
        create_gate: Arc::new(Semaphore::new(1)), settings_gate: Arc::new(Semaphore::new(1)),
        stop_gate: Arc::new(Semaphore::new(1)), events, entered,
    });
    let lifecycle = Lifecycle::new(host.clone(), Config::default());
    (host, lifecycle, ui, steps)
}

async fn prompt(ui: &mut mpsc::UnboundedReceiver<(u64, UiEvent)>) -> (u64, Prompt) {
    loop {
        if let Some((window, UiEvent::Prompts(mut prompts))) = ui.recv().await
            && !prompts.is_empty() { return (window, prompts.remove(0)); }
    }
}

async fn notice(ui: &mut mpsc::UnboundedReceiver<(u64, UiEvent)>) -> Notice {
    loop { if let Some((_, UiEvent::Notice(notice))) = ui.recv().await { return notice; } }
}

#[test]
fn excludes_every_non_candidate_pool_spawn() {
    let fresh = spawn();
    assert!(fresh.candidate());
    let patches: [fn(&mut Spawn); 7] = [
        |s| s.agent = false, |s| s.fresh = false, |s| s.session_path = Some("/session".into()),
        |s| s.device = Some("device".into()), |s| s.explicit_worktree = true,
        |s| s.placeholder = true, |s| s.defer_start = true,
    ];
    for patch in patches { let mut s = fresh.clone(); patch(&mut s); assert!(!s.candidate()); }
}

#[tokio::test]
async fn starts_at_stock_path_and_binds_exact_chip_shape() {
    let (host, lifecycle, _, _) = rig("create", "keep");
    *lock(&host.prefix) = Some("alice/".into());
    assert_eq!(lifecycle.start(spawn(), host.source.clone()).await.unwrap().as_deref(), Some("/wt/new"));
    assert_eq!(*lock(&host.binding), Some(json!({"name":"wt/new", "branch":"wt/new", "baseCwd":"/repo", "path":"/wt/new", "lifecycle":true})));
    assert!(lifecycle.owns("tab"));
    assert_eq!(lock(&host.calls)[1], ("worktree_lifecycle_create".into(), Some(json!({"branchPrefix":"alice/"}))));
}

#[tokio::test]
async fn missing_malformed_off_or_ineligible_settings_do_not_create() {
    for settings in [Value::Null, json!({"onStart":"other","onExit":"remove","eligible":true}),
        json!({"onStart":"off","onExit":"remove","eligible":true}),
        json!({"onStart":"ask","onExit":"remove","eligible":false})] {
        let (host, lifecycle, _, _) = rig("create", "keep");
        *lock(&host.settings) = settings;
        assert_eq!(lifecycle.start(spawn(), host.source.clone()).await.unwrap(), None);
        assert_eq!(lock(&host.calls).as_slice(), &[("worktree_lifecycle_settings".into(), None)]);
    }
}

#[tokio::test(start_paused = true)]
async fn settings_timeout_is_ten_seconds_and_late_reply_cannot_create() {
    let (host, lifecycle, _, mut steps) = rig("create", "keep");
    let hold = host.settings_gate.clone().acquire_owned().await.unwrap();
    let gate = lifecycle.start(spawn(), host.source.clone());
    assert_eq!(steps.recv().await.as_deref(), Some("worktree_lifecycle_settings"));
    tokio::time::advance(Duration::from_secs(9)).await;
    assert!(lock(&lifecycle.state).starts.contains_key("tab"));
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(gate.await.unwrap(), None);
    drop(hold);
    assert_eq!(lock(&host.calls).len(), 1);
}

#[tokio::test]
async fn wrong_window_cannot_answer_and_close_withdraws_start_without_create() {
    let (host, lifecycle, mut ui, _) = rig("ask", "remove");
    let gate = lifecycle.start(spawn(), host.source.clone());
    let (_, question) = prompt(&mut ui).await;
    assert!(!lifecycle.answer(2, &question.id, true));
    host.live.store(false, Ordering::SeqCst);
    lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(async { Ok(()) }));
    assert_eq!(gate.await.unwrap(), None);
    assert!(lifecycle.prompts(1).is_empty());
    assert_eq!(lock(&host.calls).len(), 1);
}

#[tokio::test]
async fn accepting_start_uses_stock_create_but_declining_does_not() {
    for accepted in [false, true] {
        let (host, lifecycle, mut ui, _) = rig("ask", "keep");
        let gate = lifecycle.start(spawn(), host.source.clone());
        let (_, question) = prompt(&mut ui).await;
        assert!(lifecycle.answer(1, &question.id, accepted));
        assert_eq!(gate.await.unwrap().is_some(), accepted);
        assert_eq!(lock(&host.calls).len(), if accepted { 2 } else { 1 });
    }
}

#[tokio::test]
async fn close_during_creation_retains_effect_and_waits_for_exact_exit() {
    let (host, lifecycle, _, mut steps) = rig("create", "remove");
    let hold = host.create_gate.clone().acquire_owned().await.unwrap();
    let gate = lifecycle.start(spawn(), host.source.clone());
    assert_eq!(steps.recv().await.as_deref(), Some("worktree_lifecycle_settings"));
    assert_eq!(steps.recv().await.as_deref(), Some("worktree_lifecycle_create"));
    let (exited, exit) = oneshot::channel();
    host.live.store(false, Ordering::SeqCst);
    lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(async { exit.await.unwrap(); Ok(()) }));
    drop(gate); // Caller cancellation must not cancel stock creation or its cleanup.
    drop(hold);
    assert_eq!(host.removed.load(Ordering::SeqCst), 0);
    exited.send(()).unwrap();
    lifecycle.settle().await;
    assert_eq!(host.removed.load(Ordering::SeqCst), 1);
    assert!(lock(&host.binding).is_none());
}

#[tokio::test]
async fn dirty_moved_or_off_branch_always_asks_and_moved_branch_is_kept() {
    for risk in [Risk { dirty: true, moved: false, off_branch: false }, Risk { dirty: false, moved: true, off_branch: false }, Risk { dirty: false, moved: false, off_branch: true }] {
        let (host, lifecycle, mut ui, _) = rig("create", "remove");
        lifecycle.start(spawn(), host.source.clone()).await.unwrap();
        lock(&host.snapshot).state = risk;
        lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(async { Ok(()) }));
        let (_, question) = prompt(&mut ui).await;
        assert!(matches!(question.body, PromptBody::Exit { .. }));
        assert_eq!(host.removed.load(Ordering::SeqCst), 0);
        lifecycle.answer(1, &question.id, true);
        lifecycle.settle().await;
        assert_eq!(host.removed.load(Ordering::SeqCst), 1);
        assert_eq!(host.moved.load(Ordering::SeqCst), risk.moved);
    }
}

#[tokio::test]
async fn approval_does_not_remove_a_worktree_changed_while_asked() {
    let (host, lifecycle, mut ui, _) = rig("create", "ask");
    lifecycle.start(spawn(), host.source.clone()).await.unwrap();
    lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(async { Ok(()) }));
    let (_, question) = prompt(&mut ui).await;
    lock(&host.snapshot).fingerprint = "edited-again".into();
    lifecycle.answer(1, &question.id, true);
    lifecycle.settle().await;
    assert_eq!(host.removed.load(Ordering::SeqCst), 0);
    assert!(matches!(notice(&mut ui).await, Notice::KeptChanged { .. }));
}

#[tokio::test]
async fn close_and_quit_share_one_cleanup_owner() {
    let (host, lifecycle, _, mut steps) = rig("create", "remove");
    lifecycle.start(spawn(), host.source.clone()).await.unwrap();
    let hold = host.stop_gate.clone().acquire_owned().await.unwrap();
    let quitting = { let lifecycle = lifecycle.clone(); tokio::spawn(async move { lifecycle.finalize().await }) };
    while steps.recv().await.as_deref() != Some("stop") {}
    lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(async { Ok(()) }));
    drop(hold);
    quitting.await.unwrap();
    assert_eq!(host.removed.load(Ordering::SeqCst), 1);
    assert_eq!(host.released.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn quit_refreshes_policy_before_planning_and_releases_only_selected_removals() {
    for policy in ["keep", "remove"] {
        let (host, lifecycle, _, _) = rig("create", "ask");
        lifecycle.start(spawn(), host.source.clone()).await.unwrap();
        lock(&host.settings)["onExit"] = json!(policy);
        lifecycle.finalize().await;
        assert_eq!(host.removed.load(Ordering::SeqCst), usize::from(policy == "remove"));
        assert_eq!(host.released.load(Ordering::SeqCst), usize::from(policy == "remove"));
        assert!(!lifecycle.owns("tab"));
    }
}

#[tokio::test(start_paused = true)]
async fn failed_or_hung_exact_exit_keeps_worktree_without_asking() {
    let (host, lifecycle, mut ui, _) = rig("create", "remove");
    lifecycle.start(spawn(), host.source.clone()).await.unwrap();
    lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(std::future::pending()));
    lifecycle.settle().await;
    assert_eq!(host.removed.load(Ordering::SeqCst), 0);
    assert!(matches!(notice(&mut ui).await, Notice::KeptRunning { .. }));
}

#[tokio::test]
async fn no_window_keeps_risky_worktree_and_closed_window_declines_start() {
    let (host, lifecycle, mut ui, _) = rig("ask", "remove");
    let gate = lifecycle.start(spawn(), host.source.clone());
    let (_, question) = prompt(&mut ui).await;
    lock(&host.windows).clear();
    lifecycle.window_closed(1);
    assert_eq!(gate.await.unwrap(), None);
    assert!(!lifecycle.answer(1, &question.id, true));
    assert_eq!(lock(&host.calls).len(), 1);
}

#[tokio::test]
async fn close_during_hub_bind_does_not_publish_an_orphaned_owner() {
    let (host, lifecycle, _, mut steps) = rig("create", "remove");
    let hold = host.bind_gate.clone().acquire_owned().await.unwrap();
    let gate = lifecycle.start(spawn(), host.source.clone());
    while steps.recv().await.as_deref() != Some("bind") {}
    lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(async { Ok(()) }));
    drop(hold);
    assert_eq!(gate.await.unwrap(), None);
    lifecycle.settle().await;
    assert!(!lifecycle.owns("tab"));
    assert_eq!(host.removed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn old_source_or_owner_release_cannot_take_a_current_worktree() {
    let (host, lifecycle, _, _) = rig("create", "remove");
    lifecycle.start(spawn(), host.source.clone()).await.unwrap();
    lifecycle.released(&spawn().owner, "tab", &Arc::new(()), Box::pin(async { Ok(()) }));
    let other = ompdesk_app_contract::OwnerIssuer::new(99).admit_authenticated().unwrap();
    lifecycle.released(&other, "tab", &host.source, Box::pin(async { Ok(()) }));
    lifecycle.settle().await;
    assert!(lifecycle.owns("tab"));
    assert_eq!(host.removed.load(Ordering::SeqCst), 0);
    lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(async { Ok(()) }));
    lifecycle.settle().await;
    assert_eq!(host.removed.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn exit_settings_timeout_keeps_last_policy() {
    let (host, lifecycle, _, _) = rig("create", "keep");
    lifecycle.start(spawn(), host.source.clone()).await.unwrap();
    let hold = host.settings_gate.clone().acquire_owned().await.unwrap();
    lock(&host.settings)["onExit"] = json!("remove");
    lifecycle.refresh_exit_policy("tab").await;
    drop(hold);
    lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(async { Ok(()) }));
    lifecycle.settle().await;
    assert_eq!(host.removed.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn failed_exact_exit_does_not_remove_even_after_remove_policy() {
    let (host, lifecycle, mut ui, _) = rig("create", "remove");
    lifecycle.start(spawn(), host.source.clone()).await.unwrap();
    lifecycle.released(&spawn().owner, "tab", &host.source,
        Box::pin(async { Err(Fault::new("exit_failed", "owned child still running")) }));
    lifecycle.settle().await;
    assert_eq!(host.removed.load(Ordering::SeqCst), 0);
    assert!(matches!(notice(&mut ui).await, Notice::KeptRunning { .. }));
}
