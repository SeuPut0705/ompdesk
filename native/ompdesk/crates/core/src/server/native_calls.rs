use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::{Answer, Events, Fault, Reply, Scope, at_once};
use crate::wire::{Frame, Response};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const MAX_ID: u64 = (1 << 53) - 1;

type Delivery = oneshot::Sender<Result<Reply, Fault>>;

#[derive(Default)]
pub(super) struct Pending {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    closed: bool,
    calls: HashMap<u64, Delivery>,
}

fn disconnected() -> Fault {
    Fault::new("unavailable", "The native connection closed")
}

impl Pending {
    pub(super) fn deliver(&self, response: Response) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(sender) = state.calls.remove(&response.id) {
            let answer = response
                .result
                .map(|(result, bin)| Reply { result, bin })
                .map_err(|(code, message)| Fault::new(code, message));
            let _ = sender.send(answer);
        }
    }

    pub(super) fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.closed = true;
        for (_, sender) in state.calls.drain() {
            let _ = sender.send(Err(disconnected()));
        }
    }
}

struct Withdrawal {
    id: u64,
    pending: Arc<Pending>,
    frames: mpsc::WeakUnboundedSender<Frame>,
}

impl Drop for Withdrawal {
    fn drop(&mut self) {
        let mut state = self
            .pending
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.calls.remove(&self.id).is_some()
            && let Some(frames) = self.frames.upgrade()
        {
            let _ = frames.send(Frame::cancel(self.id));
        }
    }
}

impl Events {
    /// Starts a native request before returning its answer future.
    pub fn call(
        &self,
        method: &str,
        params: Value,
        bin: Option<Vec<u8>>,
        timeout: Duration,
        scope: Scope,
    ) -> Answer {
        if scope.cancelled() {
            return at_once(Err(Fault::cancelled()));
        }
        let Ok(id) = NEXT_ID.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| {
            (id <= MAX_ID).then_some(id + 1)
        }) else {
            return at_once(Err(Fault::new(
                "unavailable",
                "Native request IDs exhausted",
            )));
        };
        let Some(frames) = self.frames.upgrade() else {
            return at_once(Err(disconnected()));
        };
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = self
                .pending
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state.closed {
                return at_once(Err(disconnected()));
            }
            state.calls.insert(id, sender);
            if frames
                .send(Frame::request(id, method, &params, bin))
                .is_err()
            {
                state.calls.remove(&id);
                return at_once(Err(disconnected()));
            }
        }
        let withdrawal = Withdrawal {
            id,
            pending: Arc::clone(&self.pending),
            frames: self.frames.clone(),
        };
        let deadline = Instant::now() + timeout;
        Box::pin(async move {
            let _withdrawal = withdrawal;
            tokio::select! {
                biased;
                answer = receiver => answer.unwrap_or_else(|_| Err(disconnected())),
                _ = scope.on_cancel() => Err(Fault::cancelled()),
                _ = tokio::time::sleep_until(deadline) => Err(Fault::new("timeout", "The native request timed out")),
            }
        })
    }
}
