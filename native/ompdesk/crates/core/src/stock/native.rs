//! Direct access to the stock lanes without the wire launch handshake.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::json::whole_surrogates;
use crate::server::{Events, Fault, Scope};

use super::{
    CLOSE_WAIT, LANES, LaunchSource, NEXT_ID, STOP_WAIT, Tuning, Withdraw, end_lanes, locked,
    place_request, stopped, wait_stopping,
};

pub use super::WorkerKind;

pub struct Config {
    pub host: String,
    pub events: Events,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCommand {
    pub bin: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub stamp_file: Option<PathBuf>,
}

pub trait Launcher: Send + Sync {
    fn launch(
        &self,
        kind: WorkerKind,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchCommand, Fault>> + Send + '_>>;
}

/// One app generation's stock workers. Call `close` before dropping the generation.
pub struct Service {
    config: Config,
    source: LaunchSource,
    closed: Arc<AtomicBool>,
    stopping: tokio::sync::Mutex<()>,
}

impl Service {
    pub fn new(config: Config, launcher: Arc<dyn Launcher>) -> Self {
        let closed = Arc::new(AtomicBool::new(false));
        let source = LaunchSource::Native {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            launcher,
            closed: Arc::clone(&closed),
        };
        Self {
            config,
            source,
            closed,
            stopping: tokio::sync::Mutex::new(()),
        }
    }

    /// Admits the request before returning the future. Dropping even an unpolled future withdraws it.
    pub fn request(
        &self,
        method: &str,
        params: &Value,
        timeout: Duration,
        scope: Scope,
    ) -> impl Future<Output = Result<Value, Fault>> + Send + 'static + use<> {
        let deadline = tokio::time::Instant::now() + timeout;
        let placed = if scope.cancelled() {
            Err(Fault::cancelled())
        } else {
            serde_json::to_vec(params)
                .map_err(|error| Fault::new("internal", error.to_string()))
                .and_then(|text| {
                    place_request(
                        &self.config.host,
                        method,
                        Some(&text),
                        timeout,
                        Tuning::default(),
                        &self.config.events,
                        self.source.clone(),
                    )
                })
        };
        let placed = placed.map(|placed| {
            let withdraw = Withdraw {
                inbox: placed.inbox,
                id: placed.id,
                armed: true,
            };
            (placed.answer, withdraw)
        });
        async move {
            let (answer, mut withdraw) = placed?;
            tokio::select! {
                biased;
                answer = answer => {
                    withdraw.armed = false;
                    match answer {
                        Ok(Ok(Some(result))) => serde_json::from_str(&whole_surrogates(&String::from_utf8_lossy(&result)))
                            .map_err(|error| Fault::new("stock_json", error.to_string())),
                        Ok(Ok(None)) => Ok(Value::Null),
                        Ok(Err(fault)) => Err(fault),
                        Err(_) => Err(stopped()),
                    }
                }
                () = tokio::time::sleep_until(deadline) => Err(Fault::new("stock_timeout", "omp stock helper request timed out")),
                () = scope.on_cancel() => Err(Fault::cancelled()),
            }
        }
    }

    /// Stop this service's current workers. Later requests may start fresh workers.
    pub async fn stop(&self) {
        let _stopping = self.stopping.lock().await;
        let deadline = tokio::time::Instant::now() + STOP_WAIT;
        end_lanes(|_, entry| entry.source.same_owner(&self.source), STOP_WAIT).await;
        wait_stopping(&self.source, deadline).await;
    }

    /// End the generation and refuse new requests, waiting for its workers as on core close.
    pub async fn close(&self) {
        {
            let _lanes = locked(&LANES);
            self.closed.store(true, Ordering::Release);
        }
        let _stopping = self.stopping.lock().await;
        let deadline = tokio::time::Instant::now() + CLOSE_WAIT;
        end_lanes(|_, entry| entry.source.same_owner(&self.source), CLOSE_WAIT).await;
        wait_stopping(&self.source, deadline).await;
    }
}

#[cfg(all(test, unix))]
#[path = "native_tests.rs"]
mod tests;
