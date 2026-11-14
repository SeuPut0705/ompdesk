//! The receiving hop owns payloads and blobs independently of both producer outboxes.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::agentctl::inbox::{InboxFiles, InboxReceiver};
use crate::agentctl::journal::Clock;
use crate::agentctl::journal::attachments::{AttachmentPin, AttachmentStore};
use crate::agentctl::journal::inbox_ledger::{Address, InboxLedger};
use crate::web::uploads::{UploadStore, open};

use super::lock;

pub(crate) struct ReceivingInbox {
    pub ledger: InboxLedger,
    pub uploads: Arc<UploadStore>,
    pub store: Arc<AttachmentStore>,
    pub clock: Clock,
    lanes: Mutex<HashMap<Address, Arc<tokio::sync::Mutex<()>>>>,
    retained: Mutex<Option<AttachmentPin>>,
}

impl ReceivingInbox {
    pub fn new(files: &InboxFiles, store: Arc<AttachmentStore>, clock: Clock) -> Self {
        let inbox = Self {
            ledger: InboxLedger::with_clock(Some(files.ledger.clone()), clock.clone()),
            uploads: open(&files.upload_user_data),
            store,
            clock,
            lanes: Mutex::new(HashMap::new()),
            retained: Mutex::new(None),
        };
        if let Err(error) = inbox.refresh_retention() {
            // The ledger fails closed too. A collection pass must propagate this error and sweep nothing.
            eprintln!("[agent-inbox] receiver attachment retention unavailable: {error}");
        }
        inbox
    }

    pub async fn lane(&self, receiver: &InboxReceiver) -> tokio::sync::OwnedMutexGuard<()> {
        let lane = {
            let mut lanes = lock(&self.lanes);
            lanes.entry(Address::from(receiver)).or_default().clone()
        };
        lane.lock_owned().await
    }

    /// Promote imports to stable ledger references before dropping the import pin. Holding this mutex across
    /// snapshot and pin replacement prevents an older concurrent snapshot from replacing a newer retention set.
    pub fn refresh_retention(&self) -> Result<HashSet<String>, String> {
        let mut retained = lock(&self.retained);
        let shas = self.ledger.attachment_shas()?;
        let pin = if shas.is_empty() {
            None
        } else {
            Some(self.store.pin(shas.iter().map(String::as_str))?)
        };
        *retained = pin;
        Ok(shas)
    }
}
