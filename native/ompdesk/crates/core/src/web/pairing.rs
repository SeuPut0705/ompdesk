//! Desktop approval shared by phone pairing and computer sharing. Only the authenticated desktop
//! dispatcher calls `respond`; a page cannot construct that authority from a pairing response.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::oneshot;

use super::deps::{Clock, PairingOutcome};
use super::devices::{DEFAULT_GRANTS, sanitize_grants};

pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    pub name: String,
    pub user_agent: String,
    pub tailscale_login: Option<String>,
    pub ip: Option<String>,
}

impl From<super::deps::PairingDetails> for Details {
    fn from(details: super::deps::PairingDetails) -> Self {
        Self {
            kind: None,
            name: details.name,
            user_agent: details.user_agent,
            tailscale_login: Some(details.tailscale_login),
            ip: Some(details.ip),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    #[serde(flatten)]
    pub details: Details,
    pub grants: Vec<String>,
    pub expires_at: i64,
}

struct Pending {
    request: Request,
    answer: oneshot::Sender<PairingOutcome>,
}

pub struct Confirmations {
    pending: Mutex<Vec<Pending>>,
    notify: Arc<dyn Fn(&Request) + Send + Sync>,
    now: Clock,
    timeout: Duration,
}

impl Confirmations {
    pub fn new(now: Clock, notify: Arc<dyn Fn(&Request) + Send + Sync>) -> Self {
        Self {
            pending: Mutex::default(),
            notify,
            now,
            timeout: CONFIRM_TIMEOUT,
        }
    }

    fn locked(&self) -> MutexGuard<'_, Vec<Pending>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub async fn request(&self, details: Details) -> PairingOutcome {
        let request = Request {
            id: super::router::uuid(),
            details,
            grants: DEFAULT_GRANTS.iter().map(|s| (*s).to_owned()).collect(),
            expires_at: (self.now)().saturating_add(self.timeout.as_millis() as i64),
        };
        let (answer, mut receiver) = oneshot::channel();
        self.locked().push(Pending {
            request: request.clone(),
            answer,
        });
        let waiting = Waiting {
            owner: self,
            id: &request.id,
        };
        // No lock across notification: a desktop may answer synchronously.
        (self.notify)(&request);
        let deadline = tokio::time::sleep(self.timeout);
        tokio::pin!(deadline);
        let outcome = tokio::select! {
            answer = &mut receiver => answer.unwrap_or(PairingOutcome::Refused("declined")),
            () = &mut deadline => {
                if let Some(pending) = self.remove(&request.id) {
                    let _ = pending.answer.send(PairingOutcome::Refused("timeout"));
                }
                receiver.await.unwrap_or(PairingOutcome::Refused("timeout"))
            }
        };
        drop(waiting);
        outcome
    }

    pub fn respond(&self, id: &str, approve: bool, grants: Option<&[String]>) -> bool {
        let Some(pending) = self.remove(id) else {
            return false;
        };
        let outcome = if approve {
            PairingOutcome::Approved {
                grants: sanitize_grants(grants.unwrap_or(&pending.request.grants)),
            }
        } else {
            PairingOutcome::Refused("declined")
        };
        let _ = pending.answer.send(outcome);
        true
    }

    pub fn pending(&self) -> Vec<Request> {
        self.locked().iter().map(|p| p.request.clone()).collect()
    }

    pub fn decline_all(&self) {
        let pending = std::mem::take(&mut *self.locked());
        for entry in pending {
            let _ = entry.answer.send(PairingOutcome::Refused("declined"));
        }
    }

    fn remove(&self, id: &str) -> Option<Pending> {
        let mut pending = self.locked();
        let index = pending.iter().position(|p| p.request.id == id)?;
        Some(pending.remove(index))
    }
}

struct Waiting<'a> {
    owner: &'a Confirmations,
    id: &'a str,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.owner.remove(self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn details() -> Details {
        Details {
            kind: None,
            name: "Phone".into(),
            user_agent: "Browser".into(),
            tailscale_login: None,
            ip: None,
        }
    }

    fn service() -> (
        Arc<Confirmations>,
        tokio::sync::mpsc::UnboundedReceiver<Request>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (
            Arc::new(Confirmations::new(
                Arc::new(|| 100),
                Arc::new(move |r| {
                    let _ = tx.send(r.clone());
                }),
            )),
            rx,
        )
    }

    #[tokio::test(start_paused = true)]
    async fn approval_settles_once_and_never_grants_pairing_admin() {
        let (service, mut requests) = service();
        let owner = service.clone();
        let waiting = tokio::spawn(async move { owner.request(details()).await });
        let request = requests.recv().await.unwrap();
        assert_eq!(request.expires_at, 60_100);
        assert!(service.respond(
            &request.id,
            true,
            Some(&["workspace".into(), "pairing-admin".into()])
        ));
        assert!(!service.respond(&request.id, false, None));
        assert!(
            matches!(waiting.await.unwrap(), PairingOutcome::Approved { grants } if grants == ["workspace"])
        );
        assert!(service.pending().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_and_stop_decline_every_waiter() {
        let (service, mut requests) = service();
        let owner = service.clone();
        let waiting = tokio::spawn(async move { owner.request(details()).await });
        let request = requests.recv().await.unwrap();
        tokio::time::advance(CONFIRM_TIMEOUT).await;
        assert!(matches!(
            waiting.await.unwrap(),
            PairingOutcome::Refused("timeout")
        ));
        assert!(!service.respond(&request.id, true, None));
        let owner = service.clone();
        let waiting = tokio::spawn(async move { owner.request(details()).await });
        requests.recv().await.unwrap();
        service.decline_all();
        assert!(matches!(
            waiting.await.unwrap(),
            PairingOutcome::Refused("declined")
        ));
        assert!(service.pending().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn abandoned_request_leaves_no_approval_card() {
        let (service, mut requests) = service();
        let owner = service.clone();
        let waiting = tokio::spawn(async move { owner.request(details()).await });
        requests.recv().await.unwrap();
        waiting.abort();
        let _ = waiting.await;
        assert!(service.pending().is_empty());
    }
}
