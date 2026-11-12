//! The one queue every omp start of this app goes through (was `src/main/omp-start-queue.ts`): at most `limit` omps
//! starting at once, the next one starting when one answered its first RPC, ended, or held its place `cap`. A relaunch
//! restored ten tabs and started ten omps at once (8 Nov 2026, and 2 Nov 2026 on another Mac); every one of them
//! stalled. `hold` keeps every start back until the launch's reap of leftover omps is over.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

/// How many omps may be starting at once.
pub const STARTS_AT_ONCE: usize = 2;
/// Longest one start holds its place: a start that has not answered by then lets the next one go anyway.
pub const SLOT_CAP: Duration = Duration::from_millis(15_000);

struct State {
    limit: usize,
    cap: Duration,
    running: usize,
    waiting: VecDeque<oneshot::Sender<()>>,
}

pub struct StartQueue {
    state: Mutex<State>,
    /// How many `hold`s have not been lifted: starts wait for it to reach 0.
    holds: watch::Sender<usize>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The app's queue.
pub fn queue() -> &'static Arc<StartQueue> {
    static QUEUE: LazyLock<Arc<StartQueue>> =
        LazyLock::new(|| Arc::new(StartQueue::new(STARTS_AT_ONCE, SLOT_CAP)));
    &QUEUE
}

/// A place in the queue, given back by `release` (a second call does nothing), at the latest after the cap, or when
/// the last handle is dropped.
pub struct SlotInner {
    queue: Arc<StartQueue>,
    released: AtomicBool,
    timer: Mutex<Option<JoinHandle<()>>>,
}

pub type Slot = Arc<SlotInner>;

impl SlotInner {
    pub fn release(&self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(timer) = locked(&self.timer).take() {
            timer.abort();
        }
        self.queue.pass_on();
    }
}

impl Drop for SlotInner {
    fn drop(&mut self) {
        self.release();
    }
}

impl StartQueue {
    pub fn new(limit: usize, cap: Duration) -> StartQueue {
        StartQueue {
            state: Mutex::new(State {
                limit,
                cap,
                running: 0,
                waiting: VecDeque::new(),
            }),
            holds: watch::channel(0).0,
        }
    }

    /// Sets the limit and the cap for the starts that ask from now on (a test's seam).
    pub fn configure(&self, limit: Option<usize>, cap: Option<Duration>) {
        let mut state = locked(&self.state);
        if let Some(limit) = limit {
            state.limit = limit.max(1);
        }
        if let Some(cap) = cap {
            state.cap = cap;
        }
    }

    /// No start goes until the matching `release_hold`.
    pub fn hold(&self) {
        self.holds.send_modify(|holds| *holds += 1);
    }

    pub fn release_hold(&self) {
        self.holds
            .send_modify(|holds| *holds = holds.saturating_sub(1));
    }

    fn pass_on(&self) {
        let mut state = locked(&self.state);
        // The place passes on: the count of starts under way stays the same.
        while let Some(next) = state.waiting.pop_front() {
            if next.send(()).is_ok() {
                return;
            }
        }
        state.running = state.running.saturating_sub(1);
    }

    /// Resolves with the place once a start may go, first come first served; `on_wait` runs first when it must wait.
    pub async fn acquire(self: &Arc<Self>, on_wait: impl FnOnce()) -> Slot {
        let busy = {
            let state = locked(&self.state);
            state.running >= state.limit
        };
        if busy || *self.holds.borrow() > 0 {
            on_wait();
        }
        let mut holds = self.holds.subscribe();
        let _ = holds.wait_for(|holds| *holds == 0).await;
        let handoff = {
            let mut state = locked(&self.state);
            if state.running < state.limit {
                state.running += 1;
                None
            } else {
                let (give, take) = oneshot::channel();
                state.waiting.push_back(give);
                Some(take)
            }
        };
        if let Some(take) = handoff {
            let _ = take.await;
        }
        let cap = locked(&self.state).cap;
        let slot = Arc::new(SlotInner {
            queue: Arc::clone(self),
            released: AtomicBool::new(false),
            timer: Mutex::new(None),
        });
        let timed = Arc::downgrade(&slot);
        *locked(&slot.timer) = Some(tokio::spawn(async move {
            tokio::time::sleep(cap).await;
            if let Some(slot) = timed.upgrade() {
                slot.release();
            }
        }));
        slot
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    fn queue_of(limit: usize, cap_ms: u64) -> Arc<StartQueue> {
        Arc::new(StartQueue::new(limit, Duration::from_millis(cap_ms)))
    }

    #[tokio::test]
    async fn lets_the_limit_start_at_once_and_the_rest_wait_their_turn_in_order() {
        let queue = queue_of(2, 60_000);
        let waited = Arc::new(AtomicUsize::new(0));
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut slots = Vec::new();
        for n in 0..2 {
            let slot = queue
                .acquire(|| panic!("a free place makes nobody wait"))
                .await;
            order.lock().unwrap().push(n);
            slots.push(slot);
        }
        let mut tasks = Vec::new();
        for n in 2..5 {
            let (queue, waited, order) =
                (Arc::clone(&queue), Arc::clone(&waited), Arc::clone(&order));
            tasks.push(tokio::spawn(async move {
                let slot = queue
                    .acquire(|| {
                        waited.fetch_add(1, Ordering::SeqCst);
                    })
                    .await;
                order.lock().unwrap().push(n);
                slot
            }));
            settle().await;
        }
        assert_eq!(waited.load(Ordering::SeqCst), 3);
        assert_eq!(*order.lock().unwrap(), [0, 1]);
        slots[0].release();
        // A second release gives nothing back.
        slots[0].release();
        settle().await;
        assert_eq!(*order.lock().unwrap(), [0, 1, 2]);
        slots[1].release();
        settle().await;
        assert_eq!(*order.lock().unwrap(), [0, 1, 2, 3]);
        let third = tasks.remove(0).await.unwrap();
        third.release();
        settle().await;
        assert_eq!(*order.lock().unwrap(), [0, 1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn a_place_held_past_its_cap_goes_to_the_next_start_anyway() {
        let queue = queue_of(1, 50);
        let _first = queue.acquire(|| {}).await;
        let started = std::time::Instant::now();
        let second = queue.acquire(|| {}).await;
        assert!(started.elapsed() >= Duration::from_millis(40));
        drop(second);
    }

    #[tokio::test]
    async fn a_dropped_place_is_given_back() {
        let queue = queue_of(1, 60_000);
        drop(queue.acquire(|| {}).await);
        tokio::time::timeout(Duration::from_secs(2), queue.acquire(|| {}))
            .await
            .expect("the place was not given back");
    }

    #[tokio::test]
    async fn no_start_goes_while_the_launch_holds_it_back() {
        let queue = queue_of(2, 60_000);
        queue.hold();
        let told = Arc::new(AtomicBool::new(false));
        let waiting = {
            let (queue, told) = (Arc::clone(&queue), Arc::clone(&told));
            tokio::spawn(async move { queue.acquire(|| told.store(true, Ordering::SeqCst)).await })
        };
        settle().await;
        assert!(told.load(Ordering::SeqCst), "a held start is told it waits");
        assert!(!waiting.is_finished());
        // Two holds, one lifted: still held.
        queue.hold();
        queue.release_hold();
        settle().await;
        assert!(!waiting.is_finished());
        queue.release_hold();
        waiting.await.unwrap();
    }
}
