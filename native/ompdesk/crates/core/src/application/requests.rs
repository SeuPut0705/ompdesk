use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::Arc;

use futures_util::FutureExt;
use ompdesk_app_contract::{NativeCaller, RequestId};
use tokio::sync::oneshot;

use crate::hub;
use crate::server::{Fault, Scope};

use super::callers::{Admitted, Callers};

pub type Task<T> = Pin<Box<dyn Future<Output = Result<T, Fault>> + Send>>;

/// Uses the existing hub executor: revocation cannot interleave with one synchronous segment of a handler.
/// Domain executors must retain the supplied Scope while reaping the effects they started.
pub struct Requests {
    callers: Arc<Callers>,
}

impl Requests {
    pub fn new(callers: Arc<Callers>) -> Self {
        Self { callers }
    }

    pub fn admit(&self, caller: NativeCaller) -> Task<Admitted> {
        let callers = Arc::clone(&self.callers);
        let (reply, answer) = oneshot::channel();
        hub::post(move || {
            if !reply.is_closed() {
                let _ = reply.send(callers.admit_page(caller));
            }
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err(stopped())) })
    }

    pub fn invoke<T, F>(
        &self,
        caller: NativeCaller,
        id: RequestId,
        prepare: impl FnOnce(Admitted, Scope) -> F + Send + 'static,
    ) -> Task<T>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, Fault>> + 'static,
    {
        let callers = Arc::clone(&self.callers);
        let (mut reply, answer) = oneshot::channel();
        hub::post(move || {
            if reply.is_closed() {
                return;
            }
            let admitted = match callers.page(&caller) {
                Ok(admitted) => admitted,
                Err(error) => {
                    let _ = reply.send(Err(error));
                    return;
                }
            };
            let (scope, gone) = match callers.begin(&admitted.owner, id) {
                Ok(work) => work,
                Err(error) => {
                    let _ = reply.send(Err(error));
                    return;
                }
            };
            let owner = admitted.owner.clone();
            let work =
                std::panic::catch_unwind(AssertUnwindSafe(|| prepare(admitted, scope.clone())));
            hub::spawn(async move {
                let result = match work {
                    Ok(work) => {
                        let work = AssertUnwindSafe(work).catch_unwind();
                        tokio::pin!(work);
                        tokio::select! {
                            biased;
                            _ = reply.closed() => { scope.cancel(); Err(Fault::cancelled()) },
                            () = scope.on_cancel() => Err(Fault::cancelled()),
                            result = &mut work => match result {
                                Ok(result) => result,
                                Err(_) => { scope.cancel(); Err(panicked()) },
                            },
                        }
                    }
                    Err(_) => {
                        scope.cancel();
                        Err(panicked())
                    }
                };
                drop(scope);
                gone.wait().await;
                callers.finish(&owner, id);
                let _ = reply.send(result);
            });
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err(stopped())) })
    }

    pub fn close<F>(
        &self,
        caller: NativeCaller,
        cleanup: impl FnOnce(Admitted) -> F + Send + 'static,
    ) -> Task<()>
    where
        F: Future<Output = Result<(), Fault>> + 'static,
    {
        let callers = Arc::clone(&self.callers);
        let (reply, answer) = oneshot::channel();
        hub::post(move || {
            let Some(admitted) = callers.close_page(&caller) else {
                let _ = reply.send(Ok(()));
                return;
            };
            let owner = admitted.owner.clone();
            let work = std::panic::catch_unwind(AssertUnwindSafe(|| cleanup(admitted)));
            hub::spawn(async move {
                let result = match work {
                    Ok(work) => AssertUnwindSafe(work)
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| Err(panicked())),
                    Err(_) => Err(panicked()),
                };
                callers.joined(Some(&owner)).await;
                let _ = reply.send(result);
            });
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err(stopped())) })
    }

    pub fn stop_admission(&self) -> Task<Vec<Admitted>> {
        let callers = Arc::clone(&self.callers);
        let (reply, answer) = oneshot::channel();
        hub::post(move || {
            let _ = reply.send(Ok(callers.stop()));
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err(stopped())) })
    }

    pub fn join(&self) -> Task<()> {
        let callers = Arc::clone(&self.callers);
        let (reply, answer) = oneshot::channel();
        hub::post(move || {
            hub::spawn(async move {
                callers.joined(None).await;
                let _ = reply.send(Ok(()));
            });
        });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err(stopped())) })
    }

    pub fn stop(&self) -> Task<Vec<Admitted>> {
        let admitted = self.stop_admission();
        let joined = self.join();
        Box::pin(async move {
            let admitted = admitted.await?;
            joined.await?;
            Ok(admitted)
        })
    }
}

fn stopped() -> Fault {
    Fault::new("app_closed", "The native application executor ended")
}
fn panicked() -> Fault {
    Fault::new("internal", "The native request handler panicked")
}

#[cfg(test)]
#[path = "requests_tests.rs"]
mod tests;
