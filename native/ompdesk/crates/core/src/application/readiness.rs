use std::time::Duration;

use tokio::sync::watch;

use crate::server::Fault;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Pending,
    Ready,
    Closed,
}

pub struct FirstTab {
    state: watch::Sender<State>,
}

impl Default for FirstTab {
    fn default() -> Self {
        Self {
            state: watch::channel(State::Pending).0,
        }
    }
}

impl FirstTab {
    pub fn ready(&self) {
        self.state.send_if_modified(|state| {
            if *state == State::Pending {
                *state = State::Ready;
                true
            } else {
                false
            }
        });
    }

    pub fn close(&self) {
        self.state.send_replace(State::Closed);
    }

    pub async fn wait(&self) -> Result<(), Fault> {
        let mut state = self.state.subscribe();
        tokio::select! {
            biased;
            ready = state.wait_for(|state| *state != State::Pending) => {
                match ready.as_deref() {
                    Ok(State::Ready) => Ok(()),
                    _ => Err(Fault::new("app_closed", "The application generation ended")),
                }
            }
            () = tokio::time::sleep(Duration::from_secs(30)) => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn all_waiters_observe_the_first_tab_and_later_waiters_are_ready() {
        let first = FirstTab::default();
        let a = first.wait();
        let b = first.wait();
        first.ready();
        assert!(a.await.is_ok());
        assert!(b.await.is_ok());
        assert!(first.wait().await.is_ok());
    }

    #[tokio::test]
    async fn shutdown_revokes_readiness_and_late_open_cannot_revive_it() {
        let first = FirstTab::default();
        first.ready();
        first.close();
        first.ready();
        assert_eq!(first.wait().await.unwrap_err().code, "app_closed");
        let pending = FirstTab::default();
        let waiter = pending.wait();
        pending.close();
        assert_eq!(waiter.await.unwrap_err().code, "app_closed");
    }

    #[tokio::test(start_paused = true)]
    async fn missing_local_tab_releases_each_waiter_after_the_original_grace() {
        let first = FirstTab::default();
        let waiting = first.wait();
        tokio::pin!(waiting);
        tokio::select! {
            biased;
            _ = &mut waiting => panic!("released before the first-tab grace"),
            () = tokio::time::sleep(Duration::from_secs(29)) => {}
        }
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(waiting.await.is_ok());
        first.close();
        assert_eq!(first.wait().await.unwrap_err().code, "app_closed");
    }
}
