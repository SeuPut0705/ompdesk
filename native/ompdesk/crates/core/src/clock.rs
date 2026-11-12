//! The core's clock for timers that tests drive (native-rust ledger R5): computer sharing's reconnect backoff, its
//! tailnet poll and scan, the host's slow-rebind line and keep-awake's quiet period. It is the wall clock and tokio's
//! timers, unless a test turned it manual (`clock.manual`): then `now_ms` is the test's time and a `sleep` ends only
//! when `clock.advance` moves past it, in due order, so a vitest that fakes main's timers moves the core's with them
//! (`src/main/core/test-clock.ts`). A sleep begun before the switch keeps running on real time; `clock.real` ends every
//! manual sleep at once. The link's ping and dead timers are not on it (R2: those tests run on real time).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tokio::sync::oneshot;
use tokio::task::AbortHandle;

use crate::server::{Call, Fault, Registry, Reply};

/// What a due timer does: wake a `sleep`, or run an `after` callback (in the advancing task, before it returns).
enum Fire {
    Wake(oneshot::Sender<()>),
    Call(Box<dyn FnOnce() + Send>, Arc<AtomicBool>),
}

#[derive(Default)]
struct Manual {
    now: u64,
    seq: u64,
    timers: BTreeMap<(u64, u64), Fire>,
}

static MANUAL: LazyLock<Mutex<Option<Manual>>> = LazyLock::new(Mutex::default);

fn manual() -> MutexGuard<'static, Option<Manual>> {
    MANUAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Milliseconds since the epoch, as `Date.now()` reads them.
pub fn now_ms() -> u64 {
    if let Some(clock) = manual().as_ref() {
        return clock.now;
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// Waits `duration` on this clock.
pub async fn sleep(duration: Duration) {
    let due = {
        let mut guard = manual();
        guard.as_mut().map(|clock| {
            let (fire, fired) = oneshot::channel();
            clock.seq += 1;
            let at = clock.now.saturating_add(duration.as_millis() as u64);
            clock.timers.insert((at, clock.seq), Fire::Wake(fire));
            fired
        })
    };
    match due {
        // A dropped timer (the clock went back to real) ends the wait as its firing would.
        Some(fired) => {
            let _ = fired.await;
        }
        None => tokio::time::sleep(duration).await,
    }
}

/// A callback `after` set up; `cancel` keeps it from running.
pub struct Timer {
    cancelled: Arc<AtomicBool>,
    task: Option<AbortHandle>,
}

impl Timer {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

/// Runs `call` once `duration` passed on this clock. On a manual clock it runs inside `advance`, so what it does (a
/// state it tells main) is done before the advance answers, as a fake timer's callback runs inside
/// `advanceTimersByTime`.
pub fn after(duration: Duration, call: impl FnOnce() + Send + 'static) -> Timer {
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut guard = manual();
    if let Some(clock) = guard.as_mut() {
        clock.seq += 1;
        let at = clock.now.saturating_add(duration.as_millis() as u64);
        clock.timers.insert(
            (at, clock.seq),
            Fire::Call(Box::new(call), Arc::clone(&cancelled)),
        );
        return Timer {
            cancelled,
            task: None,
        };
    }
    drop(guard);
    let flag = Arc::clone(&cancelled);
    let task = tokio::spawn(async move {
        tokio::time::sleep(duration).await;
        if !flag.load(Ordering::SeqCst) {
            call();
        }
    });
    Timer {
        cancelled,
        task: Some(task.abort_handle()),
    }
}

/// Turns the clock manual at `now` (ms since the epoch).
pub fn set_manual(now: u64) {
    let mut guard = manual();
    match guard.as_mut() {
        Some(clock) => clock.now = now,
        None => {
            *guard = Some(Manual {
                now,
                ..Manual::default()
            })
        }
    }
}

/// Back to the wall clock; every manual sleep ends now and every manual callback is dropped unrun.
pub fn set_real() {
    let dropped = manual().take();
    drop(dropped);
}

/// Moves a manual clock `ms` on, firing each timer due by then in order and letting what it woke run before the next.
pub async fn advance(ms: u64) {
    let Some(target) = manual().as_ref().map(|clock| clock.now.saturating_add(ms)) else {
        return;
    };
    loop {
        let fire = {
            let mut guard = manual();
            let Some(clock) = guard.as_mut() else {
                return;
            };
            match clock.timers.first_key_value() {
                Some((&(at, _), _)) if at <= target => {
                    let (_, fire) = clock.timers.pop_first().expect("a first timer");
                    clock.now = clock.now.max(at);
                    fire
                }
                _ => {
                    clock.now = clock.now.max(target);
                    return;
                }
            }
        };
        match fire {
            Fire::Wake(wake) => {
                let _ = wake.send(());
            }
            Fire::Call(call, cancelled) => {
                if !cancelled.load(Ordering::SeqCst) {
                    call();
                }
            }
        }
        settle().await;
    }
}

/// Lets the tasks a timer woke run until they wait again (a microtask flush, as `advanceTimersByTimeAsync` does).
async fn settle() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManualParams {
    now_ms: u64,
}

#[derive(Deserialize)]
struct AdvanceParams {
    ms: u64,
}

pub fn register(registry: &mut Registry) {
    registry.add("clock.manual", |call| Box::pin(manual_call(call)));
    registry.add("clock.advance", |call| Box::pin(advance_call(call)));
    registry.add("clock.real", |_call| {
        Box::pin(async {
            set_real();
            Reply::json(&())
        })
    });
}

async fn manual_call(call: Call) -> Result<Reply, Fault> {
    let params: ManualParams = call.params()?;
    set_manual(params.now_ms);
    Reply::json(&())
}

async fn advance_call(call: Call) -> Result<Reply, Fault> {
    let params: AdvanceParams = call.params()?;
    advance(params.ms).await;
    Reply::json(&now_ms())
}

/// Rust tests that turn the process-wide clock manual, or run code on it, take this first.
#[cfg(test)]
pub(crate) static TEST_CLOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_manual_sleep_ends_only_when_advanced_past_in_due_order() {
        let _serial = TEST_CLOCK.lock().await;
        set_manual(1_000);
        let order = std::sync::Arc::new(Mutex::new(Vec::new()));
        for (name, ms) in [("late", 300u64), ("early", 100)] {
            let order = std::sync::Arc::clone(&order);
            tokio::spawn(async move {
                sleep(Duration::from_millis(ms)).await;
                order.lock().unwrap().push((name, now_ms()));
            });
        }
        settle().await;
        advance(99).await;
        assert!(order.lock().unwrap().is_empty());
        advance(1).await;
        assert_eq!(*order.lock().unwrap(), vec![("early", 1_100)]);
        advance(500).await;
        assert_eq!(
            *order.lock().unwrap(),
            vec![("early", 1_100), ("late", 1_300)]
        );
        assert_eq!(now_ms(), 1_600);
        set_real();
    }

    #[tokio::test]
    async fn going_back_to_real_time_ends_every_manual_sleep() {
        let _serial = TEST_CLOCK.lock().await;
        set_manual(0);
        let slept = tokio::spawn(sleep(Duration::from_secs(3_600)));
        settle().await;
        set_real();
        tokio::time::timeout(Duration::from_secs(1), slept)
            .await
            .expect("ended")
            .expect("joined");
        assert!(now_ms() > 1_000_000_000_000);
    }
}
