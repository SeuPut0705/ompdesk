#![cfg(unix)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;

use ompdesk_app_contract::NativeCaller;
use serde_json::json;
use tokio::sync::{mpsc, watch};

use super::*;
use crate::application::callers::Callers;
use crate::sidecar::LaneEvent;
use crate::sidecar::application::{Answer, Ask};
use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Held, Sink};

struct ChildEvents {
    events: mpsc::UnboundedSender<LaneEvent>,
    launches: Mutex<Vec<(u64, u64)>>,
}

impl Sink for ChildEvents {
    fn event(&self, event: LaneEvent) {
        if event.name == "sidecar.launch" {
            self.launches.lock().unwrap().push((
                event.data["ask"].as_u64().unwrap(),
                event.data["cmd"].as_u64().unwrap(),
            ));
        }
        let _ = self.events.send(event);
    }
    fn before_response(&self) {}
    fn remove_listeners(&self) {}
    fn sync_settings(&self) -> crate::pool::EffectFuture<'_, ()> { Box::pin(async {}) }
}

struct NativeChild {
    source: Arc<NativeSidecar>,
    held: Held,
    events: mpsc::UnboundedReceiver<LaneEvent>,
    observed: Arc<ChildEvents>,
}

impl NativeChild {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let tab = format!("desktop-slot-{label}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let (events, _output, _frames) = crate::server::Events::capture();
        let (send, incoming) = mpsc::unbounded_channel();
        let observed = Arc::new(ChildEvents { events: send, launches: Mutex::new(Vec::new()) });
        let (source, held) = NativeSidecar::new(
            SidecarConfig {
                tab,
                seq: 0,
                cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(),
                fresh: true,
                event_filter: Vec::new(),
                bridge: false,
                ledger_file: None,
                start_slow_ms: None,
                entry_id_timeout_ms: None,
                tuning: None,
                session_path: None,
                is_new: Some(true),
            },
            events,
            observed.clone(),
            Arc::new(DirectSpawn),
        ).unwrap();
        Self { source, held, events: incoming, observed }
    }
}

async fn state_where(states: &mut watch::Receiver<State>, predicate: impl Fn(&State) -> bool) -> State {
    states.wait_for(predicate).await.unwrap().clone()
}

fn is_holder(state: &State, capture: &Capture) -> bool {
    state.holder.as_ref().is_some_and(|holder| holder.session.tab_id == capture.tab())
}

#[tokio::test]
async fn real_children_preserve_failed_grant_fifo_and_exact_generation_cleanup() {
    let a = NativeChild::new("a");
    let b = NativeChild::new("b");
    let callers = Callers::new(71);
    let owner_a = callers.admit_page(NativeCaller::Desktop { win_id: 1, wc_id: 71 }).unwrap().owner;
    let owner_b = callers.admit_page(NativeCaller::Desktop { win_id: 2, wc_id: 72 }).unwrap().owner;
    let slot = Arc::new(Service::new(Config::default()));
    let source_a = Arc::clone(&a.source);
    let source_b = Arc::clone(&b.source);
    let slot_work = Arc::clone(&slot);
    let observed_a = Arc::clone(&a.observed);
    let mut a_events = a.events;
    let mut b_events = b.events;
    // Only the scenario may panic. The outer owner always closes Slot and disposes/joins both actual children.
    let outcome = tokio::spawn(async move {
        let slot = slot_work;
        source_a.start();
        source_b.start();
        crate::sidecar::native::tests::ready(&source_a, &mut a_events).await;
        crate::sidecar::native::tests::ready(&source_b, &mut b_events).await;
        let a_capture = slot.capture(Acquired {
            owner: owner_a,
            tab: source_a.tab().to_owned(),
            title: "Source A".into(),
            source: Arc::clone(&source_a),
            generation: source_a.generation(),
            exited: source_a.when_exited(),
        });
        let b_capture = slot.capture(Acquired {
            owner: owner_b,
            tab: source_b.tab().to_owned(),
            title: "Source B".into(),
            source: Arc::clone(&source_b),
            generation: source_b.generation(),
            exited: source_b.when_exited(),
        });
        let mut states = slot.subscribe();
        let old_a_generation = a_capture.generation();
        let old_a_pid = source_a.facts()["pid"].as_u64().unwrap();
        let b_generation = b_capture.generation();
        let b_pid = source_b.facts()["pid"].as_u64().unwrap();
        let old_launch = observed_a.launches.lock().unwrap()[0];
        assert!(!source_a.bridge_connected());
        slot.frame(&a_capture, Frame::Acquire { request_id: "request-a".into() }).unwrap();
        state_where(&mut states, |state| is_holder(state, &a_capture)).await;
        assert_eq!(slot.holder().await.unwrap().unwrap().tab(), a_capture.tab());
        source_a.barrier().await.unwrap();
        assert!(source_a.bridge_for_generation(old_a_generation, "desktop_slot.grant".into(), None, None).await.is_err());
        assert_eq!(source_a.stock_for_generation(old_a_generation, json!({"type":"get_state"}), None).await.unwrap()["success"], true);
        assert!(is_holder(&slot.state(), &a_capture), "a refused bridge grant is not a child exit");

        slot.frame(&b_capture, Frame::Acquire { request_id: "request-b".into() }).unwrap();
        state_where(&mut states, |state| state.queue.first().is_some_and(|session| session.tab_id == b_capture.tab())).await;
        assert!(is_holder(&slot.state(), &a_capture));
        slot.released(&a_capture).await.unwrap();
        state_where(&mut states, |state| is_holder(state, &a_capture) && state.holder.as_ref().unwrap().revoke_failed).await;
        assert_eq!(slot.state().queue[0].tab_id, b_capture.tab());
        assert_eq!(source_a.facts()["processAlive"], true);
        assert_eq!(source_b.facts()["pid"].as_u64(), Some(b_pid));

        let mut old_exit = source_a.when_exited();
        assert!(std::future::poll_fn(|cx| Poll::Ready(old_exit.as_mut().poll(cx).is_pending())).await);
        let kill_slot = Arc::clone(&slot);
        let kill_capture = a_capture.clone();
        let killed = tokio::spawn(async move { kill_slot.kill(&kill_capture).await });
        crate::sidecar::native::tests::ready(&source_a, &mut a_events).await;
        assert!(killed.await.unwrap().unwrap());
        old_exit.await.unwrap();
        state_where(&mut states, |state| is_holder(state, &b_capture) && state.queue.is_empty()).await;
        let replacement_generation = source_a.generation();
        let replacement_pid = source_a.facts()["pid"].as_u64().unwrap();
        assert_ne!(replacement_generation, old_a_generation);
        assert_ne!(replacement_pid, old_a_pid);

        assert_eq!(slot.frame(&a_capture, Frame::Acquire { request_id: "late-old-a".into() }).unwrap_err().code, "desktop_slot_stale");
        slot.frame(&a_capture, Frame::Release).unwrap();
        slot.released(&a_capture).await.unwrap();
        assert!(!slot.kill(&a_capture).await.unwrap());
        assert!(source_a.restart_for_generation(old_a_generation).await.is_err());
        assert!(source_a.send_for_generation(old_a_generation, json!({"type":"exit0"})).await.is_err());
        source_a.answer(Ask { ask: old_launch.0, cmd: old_launch.1 }, Answer::LaunchFailed("late old A launch answer".into()));
        source_a.barrier().await.unwrap();
        assert_eq!(source_a.stock_for_generation(replacement_generation, json!({"type":"get_state"}), None).await.unwrap()["success"], true);
        assert_eq!(source_a.facts()["pid"].as_u64(), Some(replacement_pid));
        assert_eq!(source_b.stock_for_generation(b_generation, json!({"type":"get_state"}), None).await.unwrap()["success"], true);
        assert_eq!(source_b.facts()["pid"].as_u64(), Some(b_pid));
        assert!(is_holder(&slot.state(), &b_capture));

        let b_exit = source_b.when_exited();
        assert_eq!(source_b.stock_for_generation(b_generation, json!({"type":"exit0"}), None).await.unwrap()["success"], true);
        b_exit.await.unwrap();
        state_where(&mut states, |state| state.holder.is_none() && state.queue.is_empty()).await;
    }).await;
    let closed = slot.close().await;
    let a_exit = a.source.when_exited();
    let b_exit = b.source.when_exited();
    a.source.dispose(Duration::ZERO);
    b.source.dispose(Duration::ZERO);
    let (a_exit, b_exit, a_held, b_held) = tokio::join!(a_exit, b_exit, a.held, b.held);
    closed.unwrap();
    a_exit.unwrap();
    b_exit.unwrap();
    a_held.unwrap();
    b_held.unwrap();
    outcome.unwrap();
}
