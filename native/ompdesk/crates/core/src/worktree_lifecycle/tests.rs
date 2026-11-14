use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::{Semaphore, mpsc};

const WIN: Window = Window { id: 1, incarnation: 1 };
const OTHER: Window = Window { id: 2, incarnation: 1 };

struct Rig {
    source: Arc<()>,
    settings: Mutex<Value>,
    prefix: Mutex<Option<String>>,
    live: AtomicBool,
    authorized: AtomicBool,
    bind_error: AtomicBool,
    window_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    windows: Mutex<Vec<Window>>,
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
    events: mpsc::UnboundedSender<(Window, UiEvent)>,
    entered: mpsc::UnboundedSender<String>,
}

impl Host for Rig {
    type Source = ();
    fn windows(&self) -> Vec<Window> {
        let windows = lock(&self.windows).clone();
        let hook = lock(&self.window_hook).take();
        if let Some(hook) = hook { hook(); }
        windows
    }
    fn send(&self, window: Window, event: UiEvent) { let _ = self.events.send((window, event)); }
    fn connected(&self, _: &Arc<()>) -> bool { self.live.load(Ordering::SeqCst) }
    fn settings(&self, _: &Arc<()>) -> Work<Value> {
        lock(&self.calls).push(("worktree_lifecycle_settings".into(), None));
        let gate = self.settings_gate.clone();
        let value = lock(&self.settings).clone();
        let _ = self.entered.send("worktree_lifecycle_settings".into());
        Box::pin(async move { let _permit = gate.acquire().await.unwrap(); Ok(value) })
    }
    fn create(&self, _: &Spawn, _: &Arc<()>, params: Option<Value>) -> Work<Value> {
        if !self.authorized.load(Ordering::SeqCst) { return Box::pin(async { Err(Fault::new("owner_revoked", "owner revoked")) }); }
        lock(&self.calls).push(("worktree_lifecycle_create".into(), params));
        let gate = self.create_gate.clone();
        let _ = self.entered.send("worktree_lifecycle_create".into());
        Box::pin(async move {
            let _permit = gate.acquire().await.unwrap();
            Ok(json!({"path":"/wt/new", "branch":"wt/new", "sourceCwd":"/repo", "baseCommit":"base", "root":"/wt"}))
        })
    }
    fn branch_prefix(&self) -> Option<String> { lock(&self.prefix).clone() }
    fn bind(&self, _: &Spawn, _: &Arc<()>, binding: Value) -> Work<bool> {
        if self.bind_error.load(Ordering::SeqCst) { return Box::pin(async { Err(Fault::new("bind_failed", "bind failed")) }); }
        let live = self.live.load(Ordering::SeqCst);
        if live { *lock(&self.binding) = Some(binding); }
        let gate = self.bind_gate.clone();
        let _ = self.entered.send("bind".into());
        Box::pin(async move { let _permit = gate.acquire().await.unwrap(); Ok(live) })
    }
    fn inspect<'a>(&'a self, _: &'a Worktree) -> Effect<'a, Snapshot> {
        let snapshot = lock(&self.snapshot).clone();
        Box::pin(async move { Ok(snapshot) })
    }
    fn remove<'a>(&'a self, _: &'a Worktree, moved: bool) -> Effect<'a, ()> {
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
    Spawn { owner: issuer.admit_authenticated().unwrap(), tab: "tab".into(), window: WIN, cwd: "/repo".into(), agent: true,
        fresh: true, session_path: None, device: None, explicit_worktree: false, placeholder: false, defer_start: false }
}

fn rig(start: &str, exit: &str) -> (Arc<Rig>, Arc<Lifecycle<Rig>>, mpsc::UnboundedReceiver<(Window, UiEvent)>, mpsc::UnboundedReceiver<String>) {
    let (events, ui) = mpsc::unbounded_channel();
    let (entered, steps) = mpsc::unbounded_channel();
    let host = Arc::new(Rig {
        source: Arc::new(()),
        authorized: AtomicBool::new(true), bind_error: AtomicBool::new(false), window_hook: Mutex::new(None),
        bind_gate: Arc::new(Semaphore::new(1)),
        settings: Mutex::new(json!({"onStart": start, "onExit": exit, "eligible": true})),
        prefix: Mutex::new(None), live: AtomicBool::new(true), windows: Mutex::new(vec![WIN]),
        calls: Mutex::default(), binding: Mutex::default(),
        snapshot: Mutex::new(Snapshot { state: Risk { dirty: false, moved: false, off_branch: false }, fingerprint: "a".into(), present: true }),
        removed: AtomicUsize::new(0), moved: AtomicBool::new(false), released: AtomicUsize::new(0),
        create_gate: Arc::new(Semaphore::new(1)), settings_gate: Arc::new(Semaphore::new(1)),
        stop_gate: Arc::new(Semaphore::new(1)), events, entered,
    });
    let lifecycle = Lifecycle::new(host.clone(), Config::default());
    (host, lifecycle, ui, steps)
}

async fn prompt(ui: &mut mpsc::UnboundedReceiver<(Window, UiEvent)>) -> (Window, Prompt) {
    loop {
        if let Some((window, UiEvent::Prompts(mut prompts))) = ui.recv().await
            && !prompts.is_empty() { return (window, prompts.remove(0)); }
    }
}

async fn notice(ui: &mut mpsc::UnboundedReceiver<(Window, UiEvent)>) -> Notice {
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
    assert!(!lifecycle.answer(OTHER, &question.id, true));
    host.live.store(false, Ordering::SeqCst);
    lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(async { Ok(()) }));
    assert_eq!(gate.await.unwrap(), None);
    assert!(lifecycle.prompts(WIN).is_empty());
    assert_eq!(lock(&host.calls).len(), 1);
}

#[tokio::test]
async fn accepting_start_uses_stock_create_but_declining_does_not() {
    for accepted in [false, true] {
        let (host, lifecycle, mut ui, _) = rig("ask", "keep");
        let gate = lifecycle.start(spawn(), host.source.clone());
        let (_, question) = prompt(&mut ui).await;
        assert!(lifecycle.answer(WIN, &question.id, accepted));
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
        lifecycle.answer(WIN, &question.id, true);
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
    lifecycle.answer(WIN, &question.id, true);
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
    lifecycle.window_closed(WIN);
    assert_eq!(gate.await.unwrap(), None);
    assert!(!lifecycle.answer(WIN, &question.id, true));
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


#[tokio::test]
async fn revoked_owner_cannot_create_while_its_source_remains_connected() {
    for ask in [false, true] {
        let (host, lifecycle, mut ui, mut steps) = rig(if ask { "ask" } else { "create" }, "remove");
        let held = if ask { None } else { Some(host.settings_gate.clone().acquire_owned().await.unwrap()) };
        let gate = lifecycle.start(spawn(), host.source.clone());
        if ask {
            let (_, question) = prompt(&mut ui).await;
            host.authorized.store(false, Ordering::SeqCst);
            lifecycle.answer(WIN, &question.id, true);
        } else {
            assert_eq!(steps.recv().await.as_deref(), Some("worktree_lifecycle_settings"));
            host.authorized.store(false, Ordering::SeqCst);
            drop(held);
        }
        assert!(host.live.load(Ordering::SeqCst));
        assert_eq!(gate.await.unwrap(), None);
        assert_eq!(lock(&host.calls).as_slice(), &[("worktree_lifecycle_settings".into(), None)]);
        assert!(lock(&host.binding).is_none());
    }
}

#[tokio::test(start_paused = true)]
async fn window_closed_after_selection_cannot_register_an_unanswerable_question() {
    let (host, lifecycle, _, _) = rig("ask", "remove");
    let weak = Arc::downgrade(&lifecycle);
    *lock(&host.window_hook) = Some(Box::new(move || weak.upgrade().unwrap().window_closed(WIN)));
    let gate = lifecycle.start(spawn(), host.source.clone());
    assert_eq!(tokio::time::timeout(Duration::from_secs(1), gate).await.unwrap().unwrap(), None);
    lifecycle.settle().await;
    assert!(lifecycle.prompts(WIN).is_empty());
    assert_eq!(lock(&host.calls).len(), 1);
}

#[tokio::test]
async fn a_reused_window_id_cannot_answer_the_other_incarnation() {
    let (host, lifecycle, mut ui, _) = rig("ask", "keep");
    lifecycle.window_closed(WIN);
    let replacement = Window { id: WIN.id, incarnation: WIN.incarnation + 1 };
    *lock(&host.windows) = vec![replacement];
    let gate = lifecycle.start(spawn(), host.source.clone());
    let (window, question) = prompt(&mut ui).await;
    assert_eq!(window, replacement);
    assert!(!lifecycle.answer(WIN, &question.id, true));
    assert!(lifecycle.answer(replacement, &question.id, false));
    assert_eq!(gate.await.unwrap(), None);
}

#[tokio::test]
async fn quit_during_create_or_bind_refreshes_late_worktree_policy_before_removal() {
    for hold_bind in [false, true] {
        let (host, lifecycle, _, mut steps) = rig("create", "remove");
        let held = if hold_bind { host.bind_gate.clone() } else { host.create_gate.clone() }.acquire_owned().await.unwrap();
        let gate = lifecycle.start(spawn(), host.source.clone());
        let stage = if hold_bind { "bind" } else { "worktree_lifecycle_create" };
        while steps.recv().await.as_deref() != Some(stage) {}
        lock(&host.settings)["onExit"] = json!("keep");
        let mut quitting = Box::pin(lifecycle.finalize());
        std::future::poll_fn(|cx| {
            assert!(quitting.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        }).await;
        drop(held);
        assert_eq!(gate.await.unwrap(), None);
        quitting.await;
        assert_eq!(host.removed.load(Ordering::SeqCst), 0);
        assert_eq!(host.released.load(Ordering::SeqCst), 0);
        assert!(!lifecycle.owns("tab"));
    }
}

#[tokio::test]
async fn failed_binding_keeps_cleanup_ownership_until_the_actual_release_receipt() {
    let (host, lifecycle, _, _) = rig("create", "remove");
    host.bind_error.store(true, Ordering::SeqCst);
    assert_eq!(lifecycle.start(spawn(), host.source.clone()).await.unwrap(), None);
    lifecycle.settle().await;
    assert!(lifecycle.owns("tab"));
    assert_eq!(host.removed.load(Ordering::SeqCst), 0);
    lifecycle.released(&spawn().owner, "tab", &host.source, Box::pin(async { Ok(()) }));
    lifecycle.settle().await;
    assert_eq!(host.removed.load(Ordering::SeqCst), 1);
    assert!(!lifecycle.owns("tab"));
}
