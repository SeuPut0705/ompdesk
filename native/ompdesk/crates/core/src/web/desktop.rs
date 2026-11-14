//! The desktop's pairing policy and notifications, injected by the native application. Callbacks
//! target desktop windows only; phone sockets never receive new-device approval or block controls.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::deps::{BoxFuture, Desktop, PairingDetails, PairingOutcome};
use super::devices::Device;
use super::pairing::Confirmations;

pub struct NativeDesktop {
    pub confirmations: Arc<Confirmations>,
    confirm_new: AtomicBool,
    connected: Arc<dyn Fn(&Device) + Send + Sync>,
    unpaired: Arc<dyn Fn(&str) + Send + Sync>,
}

impl NativeDesktop {
    pub fn new(
        confirmations: Arc<Confirmations>,
        confirm_new: bool,
        connected: Arc<dyn Fn(&Device) + Send + Sync>,
        unpaired: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self {
            confirmations,
            confirm_new: AtomicBool::new(confirm_new),
            connected,
            unpaired,
        }
    }

    pub fn set_confirm_new(&self, confirm: bool) {
        self.confirm_new.store(confirm, Ordering::Release);
    }
}

impl Desktop for NativeDesktop {
    fn confirm_new_devices(&self) -> BoxFuture<'_, bool> {
        let enabled = self.confirm_new.load(Ordering::Acquire);
        Box::pin(async move { enabled })
    }
    fn confirm(&self, details: PairingDetails) -> BoxFuture<'_, PairingOutcome> {
        Box::pin(self.confirmations.request(details.into()))
    }
    fn device_connected(&self, device: &Device) {
        (self.connected)(device);
    }
    fn unpaired_auth(&self, address: &str) {
        (self.unpaired)(address);
    }
    fn decline_all(&self) {
        self.confirmations.decline_all();
    }
}
