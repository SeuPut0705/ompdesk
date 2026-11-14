//! Process-wide serialization of mutations against the same real repository.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::server::{Cancellation, Fault, Scope};

static LOCKS: LazyLock<Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const HOLD_LIMIT: Duration = Duration::from_secs(20 * 60);

struct CancelOnDrop(Option<Cancellation>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            cancel.cancel();
        }
    }
}

/// Run one complete mutation under the canonical real-primary gate. The operation must await
/// its own effects and use the supplied scope for every supervised git it starts.
pub async fn run<T, F, Fut>(primary: &str, parent: Scope, operation: F) -> Result<T, Fault>
where
    T: Send + 'static,
    F: FnOnce(Scope) -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, Fault>> + Send + 'static,
{
    let primary = primary.to_owned();
    let key = tokio::task::spawn_blocking(move || std::fs::canonicalize(primary))
        .await
        .map_err(|_| Fault::new("internal", "Repository path resolution failed"))?
        .map_err(|error| Fault::new("repo_lock", error.to_string()))?;
    let gate = {
        let mut locks = LOCKS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks.retain(|_, gate| gate.strong_count() != 0);
        if let Some(gate) = locks.get(&key).and_then(Weak::upgrade) {
            gate
        } else {
            let gate = Arc::new(AsyncMutex::new(()));
            locks.insert(key, Arc::downgrade(&gate));
            gate
        }
    };
    let (scope, gone) = Scope::watched();
    let cancel = scope.cancellation();
    let mut drop_guard = CancelOnDrop(Some(cancel.clone()));
    let (send, receive) = oneshot::channel();
    tokio::spawn(async move {
        let permit = tokio::select! {
            biased;
            _ = parent.on_cancel() => { let _ = send.send(Err(Fault::cancelled())); return; }
            _ = scope.on_cancel() => { let _ = send.send(Err(Fault::cancelled())); return; }
            permit = gate.lock() => permit,
        };
        if parent.cancelled() || scope.cancelled() {
            let _ = send.send(Err(Fault::cancelled()));
            return;
        }
        let work_scope = scope.clone();
        let mut task = tokio::spawn(async move { operation(work_scope).await });
        let (result, stopped) = tokio::select! {
            result = &mut task => (result, None),
            _ = parent.on_cancel() => { cancel.cancel(); (task.await, Some(Fault::cancelled())) },
            _ = scope.on_cancel() => (task.await, Some(Fault::cancelled())),
            _ = tokio::time::sleep(HOLD_LIMIT) => {
                cancel.cancel();
                (task.await, Some(Fault::new("repo_timeout", "Repository operation exceeded its time limit")))
            },
        };
        drop(scope);
        gone.wait().await;
        drop(permit);
        let result = stopped.map_or_else(
            || {
                result
                    .unwrap_or_else(|_| Err(Fault::new("internal", "Repository operation failed")))
            },
            Err,
        );
        let _ = send.send(result);
    });
    let result = receive
        .await
        .unwrap_or_else(|_| Err(Fault::new("internal", "Repository lock owner failed")));
    drop_guard.0 = None;
    result
}

#[cfg(test)]
#[path = "repo_lock_tests.rs"]
mod tests;
