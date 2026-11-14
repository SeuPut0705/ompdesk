//! Events issued by the router's authenticated connection registry, not deserialized from a page.

use std::sync::Weak;

use serde_json::value::RawValue;

use super::router::Host;

pub struct Invocation {
    pub(super) host: Weak<Host>,
    pub(super) call: u64,
    pub(super) conn: u64,
    pub(super) device: String,
    pub(super) conn_id: String,
    pub(super) channel: String,
    pub(super) args: Box<RawValue>,
    pub(super) invoke: bool,
    pub(super) answered: bool,
}

impl Invocation {
    pub fn device(&self) -> &str {
        &self.device
    }
    pub fn connection(&self) -> &str {
        &self.conn_id
    }
    pub fn channel(&self) -> &str {
        &self.channel
    }
    pub fn args(&self) -> &RawValue {
        &self.args
    }
    pub fn is_invoke(&self) -> bool {
        self.invoke
    }
}

#[derive(Debug)]
pub struct ConnectionInfo {
    pub id: String,
    pub visible: bool,
}

pub enum NativeEvent {
    Call(Invocation),
    Resync {
        conn: u64,
        device: String,
    },
    Connections {
        device: String,
        connections: Vec<ConnectionInfo>,
        change: &'static str,
        connection: String,
    },
}
