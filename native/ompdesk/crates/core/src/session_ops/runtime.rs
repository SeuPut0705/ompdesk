use std::sync::Arc;

use ompdesk_app_contract::Owner;
use serde_json::json;

use crate::local_dispatch::protocol::stock_data;
use crate::pool::application::native::{Host as PoolHost, Service as Pool, SessionRelease, SessionTarget};
use crate::remote::application_host::{Host as HostedHost, HostServices, SessionTicket};
use crate::server::Fault;

use super::{Effect, Release};

/// Actual captured capabilities. No tab-id lookup or owner reconstruction occurs after capture.
pub enum Runtime<P: PoolHost, R: HostedHost> {
    Local {
        pool: Arc<Pool<P>>,
        owner: Owner,
        target: SessionTarget<P::Sidecar>,
    },
    Hosted {
        service: Arc<HostServices<R>>,
        ticket: Arc<SessionTicket<R::Target>>,
    },
}

impl<P: PoolHost, R: HostedHost> Runtime<P, R> {
    pub fn release(&self) -> Effect<Release> {
        match self {
            Self::Local { pool, owner, target } => {
                let closed = pool.close_session_tab(owner, target);
                Box::pin(async move {
                    match closed.await? {
                        SessionRelease::Busy => Err(Fault::new("session_running", "Session is running")),
                        SessionRelease::Released(result) => {
                            // The primitive already joined the exact captured exit, including on observer failure.
                            Ok(Release { exits: Vec::new(), failure: result.err() })
                        }
                    }
                })
            }
            Self::Hosted { service, ticket } => {
                let service = Arc::clone(service);
                let ticket = Arc::clone(ticket);
                Box::pin(async move {
                    // HostServices closes only this captured serial and joins its required native exit receipt.
                    service.close_session_ticket(&ticket).await?;
                    Ok(Release { exits: Vec::new(), failure: None })
                })
            }
        }
    }

    pub fn stop(&self) -> Effect<()> {
        match self {
            Self::Local { pool, owner, target } => pool.stop_session(owner, target),
            Self::Hosted { service, ticket } => {
                let service = Arc::clone(service);
                let ticket = Arc::clone(ticket);
                Box::pin(async move { service.stop_session_ticket(&ticket).await })
            }
        }
    }

    pub fn rename(&self, name: &str) -> Effect<()> {
        let command = json!({"type":"set_session_name", "name":name});
        let response = match self {
            Self::Local { pool, owner, target } => pool.command_for_session(owner, target, command),
            Self::Hosted { service, ticket } => {
                let service = Arc::clone(service);
                let ticket = Arc::clone(ticket);
                Box::pin(async move { service.command_session_ticket(&ticket, command).await })
            }
        };
        Box::pin(async move {
            stock_data(response.await?).map_err(|error| Fault::new("session_rename", error.to_string()))?;
            Ok(())
        })
    }

    pub fn note_name(&self, name: &str) -> Effect<()> {
        match self {
            Self::Local { pool, owner, target } => pool.note_name_for_session(owner, target, name),
            Self::Hosted { service, ticket } => {
                let service = Arc::clone(service);
                let ticket = Arc::clone(ticket);
                let name = name.to_owned();
                Box::pin(async move { service.note_session_name_ticket(&ticket, &name).await })
            }
        }
    }
}
