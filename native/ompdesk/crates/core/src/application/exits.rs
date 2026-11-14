use tokio::sync::watch;

use crate::server::Fault;
use crate::sidecar::application::EffectFuture;

#[derive(Clone)]
pub struct Receipt(watch::Receiver<Option<Result<(), Fault>>>);

impl Receipt {
    pub fn join(exited: EffectFuture<'static, Result<(), Fault>>) -> Self {
        let (result, receipt) = watch::channel(None);
        tokio::spawn(async move {
            let _ = result.send_replace(Some(exited.await));
        });
        Self(receipt)
    }

    pub fn wait(&self) -> EffectFuture<'static, Result<(), Fault>> {
        let mut receipt = self.0.clone();
        Box::pin(async move {
            loop {
                if let Some(result) = receipt.borrow_and_update().clone() {
                    return result;
                }
                receipt.changed().await.map_err(|_| {
                    Fault::new(
                        "exit_unconfirmed",
                        "The captured exit receipt ended without a result",
                    )
                })?;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn dropping_one_consumer_keeps_the_original_exit_and_failure_for_other_consumers() {
        let (release, exit) = oneshot::channel();
        let receipt = Receipt::join(Box::pin(async move {
            exit.await
                .map_err(|_| Fault::new("exit_lost", "Exit sender closed"))?
        }));
        drop(receipt.wait());
        let first = receipt.wait();
        let second = receipt.wait();
        let failure = Fault::new("exit_failed", "The captured child exit failed");
        release.send(Err(failure.clone())).unwrap();
        assert_eq!(first.await, Err(failure.clone()));
        assert_eq!(second.await, Err(failure.clone()));
        assert_eq!(receipt.wait().await, Err(failure));
    }
}
